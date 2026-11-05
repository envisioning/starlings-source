// Sign in by email link (meet#901): opening the link spends nothing, so a
// mail scanner cannot burn it; the POST spends it once, and only in the
// browser that asked; a replay, another browser, a lapsed link or an address
// the workspace does not admit gets no session.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/crypto';
import { OWNER_SESSION_COOKIE } from '../src/auth';
import {
  EMAIL_LINK_BROWSER_COOKIE,
  EMAIL_LINK_MS,
  EMAIL_LINK_REDEEM_PATH,
  EMAIL_LINK_REQUEST_PATH,
  EMAIL_LINK_SENT_PATH,
  confirmEmailSignInLink,
  redeemEmailSignInLink,
  requestEmailSignInLink,
} from '../src/email-sign-in';

const hq = 'https://hq.starlings.example';
const auth = 'https://auth.starlings.example';
const hqEnv = { ...env, AUTH_ORIGIN: auth, WEB_ORIGIN: hq, PUBLIC_API_ORIGIN: hq, WORKSPACE_NAME: 'HQ' } as unknown as Env;
const db = (env as Env).USAGE;
const token = 'T'.repeat(43);
const browser = 'B'.repeat(43);
const member = 'ana@example.com';

function setCookies(response: Response): Map<string, string> {
  return new Map(response.headers.getSetCookie().map((value) => {
    const [pair] = value.split(';');
    const [name, ...rest] = pair!.split('=');
    return [name!, rest.join('=')];
  }));
}

async function seed(email = member, options: { browser?: string | null; expiresAt?: number } = {}) {
  const now = Date.now();
  const held = options.browser === undefined ? browser : options.browser;
  await db.prepare(`INSERT INTO email_sign_in_links (token_hash, email, return_path, created_at, expires_at, browser_hash)
    VALUES (?1, ?2, '/work', ?3, ?4, ?5)`)
    .bind(await sha256(token), email, now, options.expiresAt ?? now + EMAIL_LINK_MS, held === null ? null : await sha256(held))
    .run();
}

function ask(email: string, cookie?: string) {
  return new Request(`${hq}${EMAIL_LINK_REQUEST_PATH}`, {
    method: 'POST',
    headers: { origin: auth, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ email, return_to: '/work' }),
  });
}

async function redeem(options: { cookie?: string; origin?: string } = {}) {
  const ctx = createExecutionContext();
  try {
    return await redeemEmailSignInLink(new Request(`${hq}${EMAIL_LINK_REDEEM_PATH}`, {
      method: 'POST',
      headers: {
        origin: options.origin ?? hq,
        'content-type': 'application/x-www-form-urlencoded',
        ...(options.cookie === undefined ? { cookie: `${EMAIL_LINK_BROWSER_COOKIE}=${browser}` } : options.cookie ? { cookie: options.cookie } : {}),
      },
      body: new URLSearchParams({ t: token }),
    }), hqEnv, ctx);
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

async function usedAt(): Promise<number | null> {
  const row = await db.prepare('SELECT used_at FROM email_sign_in_links WHERE token_hash = ?1').bind(await sha256(token)).first<{ used_at: number | null }>();
  return row?.used_at ?? null;
}

afterEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM email_sign_in_links'),
    db.prepare(`DELETE FROM people WHERE email = ?1`).bind(member),
  ]);
});

describe('asking for a link', () => {
  it('ties the link to a cookie of the browser that asked, and keeps that cookie on a second ask', async () => {
    const first = await requestEmailSignInLink(ask(member), hqEnv);
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe(`${hq}${EMAIL_LINK_SENT_PATH}`);
    const value = decodeURIComponent(setCookies(first).get(EMAIL_LINK_BROWSER_COOKIE)!);
    expect(value).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    const row = await db.prepare('SELECT browser_hash FROM email_sign_in_links WHERE email = ?1').bind(member).first<{ browser_hash: string }>();
    expect(row?.browser_hash).toBe(await sha256(value));

    const second = await requestEmailSignInLink(ask(member, `${EMAIL_LINK_BROWSER_COOKIE}=${value}`), hqEnv);
    expect(decodeURIComponent(setCookies(second).get(EMAIL_LINK_BROWSER_COOKIE)!)).toBe(value);
  });

  it('answers an address the workspace does not admit the same way, cookie included', async () => {
    const response = await requestEmailSignInLink(ask('stranger@example.net'), hqEnv);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${hq}${EMAIL_LINK_SENT_PATH}`);
    expect(setCookies(response).has(EMAIL_LINK_BROWSER_COOKIE)).toBe(true);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM email_sign_in_links').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('opening the link', () => {
  it('shows one button and spends nothing, however often it is fetched', async () => {
    await seed();
    for (let fetch = 0; fetch < 3; fetch += 1) {
      const page = await confirmEmailSignInLink(new Request(`${hq}${EMAIL_LINK_REDEEM_PATH}?t=${token}`), hqEnv);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(`<form method="post" action="${EMAIL_LINK_REDEEM_PATH}">`);
      expect(html).toContain(member);
    }
    expect(await usedAt()).toBeNull();
  });

  it('says a lapsed link has expired', async () => {
    await seed(member, { expiresAt: Date.now() - 1 });
    await expect(confirmEmailSignInLink(new Request(`${hq}${EMAIL_LINK_REDEEM_PATH}?t=${token}`), hqEnv)).rejects.toThrow('expired or was used');
  });
});

describe('spending the link', () => {
  it('signs the person in once, in the browser that asked', async () => {
    await seed();
    const response = await redeem();
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${hq}/work`);
    const cookies = setCookies(response);
    expect(cookies.get(OWNER_SESSION_COOKIE)).toBeTruthy();
    expect(cookies.get(EMAIL_LINK_BROWSER_COOKIE)).toBe('');
    expect(await usedAt()).not.toBeNull();

    await expect(redeem()).rejects.toThrow('expired or was used');
  });

  it('refuses another browser and leaves the link unspent', async () => {
    await seed();
    await expect(redeem({ cookie: `${EMAIL_LINK_BROWSER_COOKIE}=${'C'.repeat(43)}` })).rejects.toThrow('browser where you asked');
    await expect(redeem({ cookie: '' })).rejects.toThrow('browser where you asked');
    expect(await usedAt()).toBeNull();
  });

  it('refuses a link from before the browser cookie existed', async () => {
    await seed(member, { browser: null });
    await expect(redeem()).rejects.toThrow('browser where you asked');
    expect(await usedAt()).toBeNull();
  });

  it('refuses a lapsed link', async () => {
    await seed(member, { expiresAt: Date.now() - 1 });
    await expect(redeem()).rejects.toThrow('expired or was used');
  });

  it('refuses a post from another origin', async () => {
    await seed();
    await expect(redeem({ origin: 'https://evil.example' })).rejects.toThrow('Not allowed');
    expect(await usedAt()).toBeNull();
  });

  it('gives no session to an address the workspace does not admit', async () => {
    await seed('stranger@example.net');
    await expect(redeem()).rejects.toThrow('cannot sign in');
  });
});
