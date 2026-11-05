// The platform operator console (docs/OPS_CONSOLE.md, meet#850).
//
// The workspace side runs as the `meet` Worker does: `/api/health` and the
// `OpsService` entrypoint. The `starlings-ops` side runs its fetch handler
// with local Access keys, so no test reaches a Cloudflare host.
import { env, exports } from 'cloudflare:workers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { OPS_FEATURES, OPS_METADATA_FIELDS, OPS_MILESTONES, opsBindingName, opsBindingSlug, opsFleetSchema, opsProductSchema, opsServiceBindingName } from '@starlings/contracts/ops';
import { healthResponseSchema } from '../src/contracts';
import { readActivation, readOpsHistory, recordOpsDaily } from '../src/ops-history';
import { workspaceProduct } from '../src/ops-product';
import { workspaceOpsMetadata, workspaceSlug } from '../src/ops-service';
import { parseOperators, verifyOperator } from '../src/ops-worker/access';
import type { OpsEnv } from '../src/ops-worker/env';
import { boundServices, type FleetWorkspace } from '../src/ops-worker/fleet';
import { handleOpsFetch } from '../src/ops-worker/index';
import { formatUTC } from '../src/ops-worker/page';

const TEAM = 'starlings.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const OPERATOR = 'rosa@example.com';

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let keysFor: () => ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  otherKey = other.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'ops-test', alg: 'RS256' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  keysFor = () => keys;
});

function opsEnv(overrides: Partial<OpsEnv> = {}): OpsEnv {
  return {
    ENVIRONMENT: 'production',
    OPS_ACCESS_TEAM_DOMAIN: TEAM,
    OPS_ACCESS_AUD: AUD,
    OPS_OPERATORS: `${OPERATOR}, second@example.com`,
    ...overrides,
  };
}

async function accessToken(claims: { email?: string; aud?: string; iss?: string; key?: CryptoKey; expiresIn?: string } = {}) {
  const token = new SignJWT(claims.email === undefined ? {} : { email: claims.email })
    .setProtectedHeader({ alg: 'RS256', kid: 'ops-test' })
    .setIssuer(claims.iss ?? `https://${TEAM}`)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '5m');
  return token.sign(claims.key ?? signingKey);
}

function request(token?: string, path = '/') {
  return new Request(`https://ops.starlings.example${path}`, {
    headers: token === undefined ? {} : { 'cf-access-jwt-assertion': token },
  });
}

describe('/api/health', () => {
  it('reports the build commit and the newest applied migration', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/health'));
    const body = healthResponseSchema.parse(await response.json());
    expect(body.build).toMatch(/^([0-9a-f]{7,40}|unknown)$/u);
    const newest = await env.USAGE.prepare('SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1').first<{ name: string }>();
    expect(newest?.name).toBeTruthy();
    expect(body.migration).toBe(newest?.name);
  });

  it('names the highest-numbered migration when two were applied out of order', async () => {
    // hq applied 0112 before 0111; the newest row named 0111 and every deploy rolled back.
    await env.USAGE.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES ('9998_later_number.sql', '2026-10-10 10:00:00')").run();
    await env.USAGE.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES ('9997_earlier_number.sql', '2026-10-10 10:01:00')").run();
    try {
      const body = healthResponseSchema.parse(await (await exports.default.fetch(new Request('http://local/api/health'))).json());
      expect(body.migration).toBe('9998_later_number.sql');
    } finally {
      await env.USAGE.prepare("DELETE FROM d1_migrations WHERE name IN ('9998_later_number.sql', '9997_earlier_number.sql')").run();
    }
  });
});

describe('OpsService', () => {
  it('returns the metadata fields and nothing else', async () => {
    const now = Date.now();
    await env.USAGE.prepare(
      `INSERT OR REPLACE INTO people (sub, email, name, first_seen_at, last_seen_at, kind)
       VALUES ('ops-human', 'ops-human@example.com', 'Ops Human', ?1, ?1, 'human'),
              ('ops-agent', 'ops-agent@example.com', 'Ops Agent', ?1, ?1, 'agent')`,
    ).bind(now).run();

    const service = (exports as unknown as { OpsService: { metadata(): Promise<Record<string, unknown>> } }).OpsService;
    const metadata = await service.metadata();
    expect(Object.keys(metadata).sort()).toEqual([...OPS_METADATA_FIELDS].sort());
    expect(metadata.name).toBe('Envisioning');
    expect(metadata.work_store).toBe('core');
    expect(metadata.members).toBeGreaterThanOrEqual(1);
    expect(metadata.agents).toBeGreaterThanOrEqual(1);
    expect(metadata.last_activity_at).toBeGreaterThanOrEqual(now);
    // No value is an address, a name of a person, or a row.
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('Ops Human');
    // `counts`, `usage` and `product` are the structured fields: fixed labels, quantities, flags, nothing else.
    for (const [key, value] of Object.entries(metadata)) {
      if (key === 'counts' || key === 'usage' || key === 'product') continue;
      expect(typeof value === 'object' && value !== null).toBe(false);
    }
    const counts = metadata.counts as { label: string; value: number }[];
    expect(counts.map((count) => count.label)).toContain('Threads');
    expect(counts.map((count) => count.label)).not.toContain('Projects');
    for (const count of counts) expect(Object.keys(count).sort()).toEqual(['label', 'value']);
    const product = opsProductSchema.parse(metadata.product);
    expect(product.active.month).toBeGreaterThanOrEqual(1);
    expect(product.daily).toHaveLength(30);
    expect(product.features.map((feature) => feature.key)).toEqual(OPS_FEATURES.map((feature) => feature.key));
  });

  it('counts sign-ins, devices and agent grants in the product block', async () => {
    const now = Date.now();
    await env.USAGE.batch([
      env.USAGE.prepare("INSERT INTO usage_events (ts, kind, actor_kind, client_app) VALUES (?1, 'signin', 'owner', 'mac'), (?1, 'signin', 'owner', 'web')").bind(now),
      env.USAGE.prepare(
        `INSERT OR REPLACE INTO owner_devices (device_id, sub, client, refresh_jti, issued_at, renewed_at, platform, app_version)
         VALUES ('ops-device-new', 'ops-human', 'mac', 'jti-1', ?1, ?1, 'macos', '9.0.0'),
                ('ops-device-old', 'ops-human', 'mac', 'jti-2', ?1, ?1, 'macos', '0.0.1')`,
      ).bind(now),
    ]);
    const product = await workspaceProduct({ ...env, MIN_RECOMMENDED_VERSION_MACOS: '6.8.2' } as Env, now);
    expect(product.signins.day).toBeGreaterThanOrEqual(2);
    expect(product.signin_clients.map((tally) => tally.key)).toEqual(expect.arrayContaining(['mac', 'web']));
    expect(product.devices.active_30d).toBeGreaterThanOrEqual(2);
    expect(product.devices.outdated).toBeGreaterThanOrEqual(1);
    expect(product.app_versions.map((tally) => tally.key)).toContain('macos 9.0.0');
    expect(product.daily.at(-1)?.day).toBe(new Date(now).toISOString().slice(0, 10));
    expect(product.daily.at(-1)?.signins).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(product)).not.toContain('@');
  });

  it('names the workspace from its own starlings.example origin', async () => {
    expect(workspaceSlug({ WEB_ORIGIN: 'https://hq.starlings.example', WORKSPACE_ORIGIN_ALIASES: '' })).toBe('hq');
    expect(workspaceSlug({ WEB_ORIGIN: 'https://legacy.org.example', WORKSPACE_ORIGIN_ALIASES: 'https://envisioning.starlings.example' })).toBe('envisioning');
    expect(workspaceSlug({ WEB_ORIGIN: 'http://127.0.0.1:5173', WORKSPACE_ORIGIN_ALIASES: '' })).toBeNull();
    const hq = await workspaceOpsMetadata({ ...env, WEB_ORIGIN: 'https://hq.starlings.example', WORKSPACE_NAME: 'HQ', WORK_STORE: 'd1' });
    expect(hq).toMatchObject({ slug: 'hq', name: 'HQ', work_store: 'd1' });
  });

  it('maps a slug to its binding and back', () => {
    expect(opsBindingName('envisioning')).toBe('WORKSPACE_ENVISIONING');
    expect(opsBindingName('acme-labs')).toBe('WORKSPACE_ACME_LABS');
    expect(opsBindingSlug('WORKSPACE_ACME_LABS')).toBe('acme-labs');
    expect(opsBindingSlug('WORKSPACE_NAME')).toBe('name');
    expect(opsBindingSlug('OPS_OPERATORS')).toBeNull();
  });
});

describe('ops history and activation', () => {
  it('writes one row a day, and a later tick overwrites it', async () => {
    const now = Date.now();
    await env.USAGE.prepare(
      `INSERT OR REPLACE INTO people (sub, email, name, first_seen_at, last_seen_at, kind, last_seen_web)
       VALUES ('history-human', 'history-human@example.com', 'History Human', ?1, ?1, 'human', ?1)`,
    ).bind(now).run();
    await recordOpsDaily(env, now);
    await recordOpsDaily(env, now + 1_000);
    const today = new Date(now).toISOString().slice(0, 10);
    const rows = await env.USAGE.prepare('SELECT * FROM ops_daily WHERE day = ?1').bind(today).all<Record<string, number>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.active_day).toBeGreaterThanOrEqual(1);
    expect(rows.results[0]!.active_web).toBeGreaterThanOrEqual(1);
    expect(rows.results[0]!.updated_at).toBe(now + 1_000);
    const history = await readOpsHistory(env.USAGE, now);
    expect(history.at(-1)?.day).toBe(today);
    expect(JSON.stringify(history)).not.toContain('@');
  });

  it('reads each milestone and the day-14 signal from the first rows', async () => {
    const now = Date.now();
    const start = now - 40 * 86_400_000;
    await env.USAGE.prepare(
      `INSERT OR REPLACE INTO people (sub, email, name, first_seen_at, last_seen_at, kind)
       VALUES ('first-human', 'first-human@example.com', 'First Human', ?1, ?1, 'human')`,
    ).bind(start).run();
    const startDay = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate());
    const dayFourteen = new Date(startDay + 13 * 86_400_000).toISOString().slice(0, 10);
    await env.USAGE.prepare(
      `INSERT OR REPLACE INTO ops_daily (day, members, active_day, active_week, active_month, active_web, active_mac, active_ios, devices_active, agents_active, updated_at)
       VALUES (?1, 4, 2, 3, 4, 2, 1, 0, 1, 0, ?2)`,
    ).bind(dayFourteen, now).run();
    const activation = await readActivation(env, [], now);
    expect(activation.milestones.map((entry) => entry.key)).toEqual(OPS_MILESTONES.map((entry) => entry.key));
    expect(activation.milestones[0]).toEqual({ key: 'first_signin', at: start });
    // Envisioning keeps its projects in Core: unknown here.
    expect(activation.milestones.find((entry) => entry.key === 'first_project')?.at).toBeNull();
    expect(activation.alive_day14).toBe(true);
  });
});

describe('starlings-ops Access check', () => {
  it('admits an operator with a valid token', async () => {
    const result = await verifyOperator(request(await accessToken({ email: 'ROSA@example.com' })), opsEnv(), keysFor);
    expect(result).toEqual({ ok: true, email: OPERATOR });
  });

  it('refuses everything while the team domain, the AUD or the operators are unset', async () => {
    const token = await accessToken({ email: OPERATOR });
    for (const overrides of [{ OPS_ACCESS_TEAM_DOMAIN: '' }, { OPS_ACCESS_AUD: '' }, { OPS_OPERATORS: '' }, { OPS_ACCESS_TEAM_DOMAIN: 'example.com' }, { OPS_ACCESS_AUD: 'short' }]) {
      expect(await verifyOperator(request(token), opsEnv(overrides), keysFor)).toEqual({ ok: false, reason: 'not_configured' });
    }
  });

  it('refuses a request with no token', async () => {
    expect(await verifyOperator(request(), opsEnv(), keysFor)).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('refuses a token that does not verify', async () => {
    const cases = [
      'not-a-jwt',
      await accessToken({ email: OPERATOR, key: otherKey }),
      await accessToken({ email: OPERATOR, aud: 'b'.repeat(64) }),
      await accessToken({ email: OPERATOR, iss: 'https://other.cloudflareaccess.com' }),
      await accessToken({ email: OPERATOR, expiresIn: '-1m' }),
    ];
    for (const token of cases) {
      expect(await verifyOperator(request(token), opsEnv(), keysFor)).toEqual({ ok: false, reason: 'invalid_token' });
    }
  });

  it('refuses a valid token for an address not on the list, and a token with no address', async () => {
    for (const token of [await accessToken({ email: 'admin@example.com' }), await accessToken({})]) {
      expect(await verifyOperator(request(token), opsEnv(), keysFor)).toEqual({ ok: false, reason: 'not_operator' });
    }
  });

  it('drops operator entries that are not addresses', () => {
    expect(parseOperators(' ROSA@example.com , nobody, ,a@b.co ')).toEqual([OPERATOR, 'a@b.co']);
  });

  it('answers 403 with no workspace data before it calls any workspace', async () => {
    let called = false;
    const registry = { workspaces: async (): Promise<FleetWorkspace[]> => { called = true; return []; } };
    for (const token of [undefined, await accessToken({ email: 'admin@example.com' })]) {
      const response = await handleOpsFetch(request(token), opsEnv(), { keysFor, registry });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('Not allowed.');
    }
    const unconfigured = await handleOpsFetch(request(await accessToken({ email: OPERATOR })), opsEnv({ OPS_ACCESS_AUD: '' }), { keysFor, registry });
    expect(unconfigured.status).toBe(403);
    expect(called).toBe(false);
  });
});

describe('starlings-ops dashboard', () => {
  it('reports every workspace in /api/fleet, and a failing one as an error row', async () => {
    const workspaces: FleetWorkspace[] = [
      { slug: 'envisioning', host: 'envisioning.starlings.example', service: { metadata: () => workspaceOpsMetadata({ ...env, WEB_ORIGIN: 'https://envisioning.starlings.example' }) } },
      { slug: 'hq', host: 'hq.starlings.example', service: { metadata: () => Promise.reject(new Error('binding failed')) } },
      { slug: 'slow', host: 'slow.starlings.example', service: { metadata: () => new Promise(() => {}) } },
      { slug: 'wrong', host: 'wrong.starlings.example', service: { metadata: () => workspaceOpsMetadata({ ...env, WEB_ORIGIN: 'https://hq.starlings.example' }) } },
    ];
    const response = await handleOpsFetch(request(await accessToken({ email: OPERATOR }), '/api/fleet'), opsEnv(), {
      keysFor,
      registry: { workspaces: async () => workspaces },
      services: [
        { slug: 'envisioning', kind: 'docs', service: { metadata: async () => ({ service: 'docs', migration: '0001_init.sql', counts: [{ label: 'Documents', value: 3 }], last_activity_at: null }) } },
        { slug: 'hq', kind: 'keep', service: { metadata: async () => ({ service: 'docs', migration: '0001_init.sql', counts: [], last_activity_at: null }) } },
      ],
      timeoutMs: 50,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    const fleet = opsFleetSchema.parse(await response.json());
    const bySlug = new Map(fleet.workspaces.map((row) => [row.slug, row]));
    expect(bySlug.get('envisioning')).toMatchObject({ ok: true, host: 'envisioning.starlings.example' });
    expect(bySlug.get('hq')).toMatchObject({ ok: false, error: 'binding failed' });
    expect(bySlug.get('slow')).toMatchObject({ ok: false, error: 'no answer in 0.05 s' });
    expect(bySlug.get('wrong')).toMatchObject({ ok: false, error: 'the binding reaches hq' });
    expect(fleet.costs.every((cost) => cost.slug === 'envisioning')).toBe(true);
    expect(fleet.pending_requests).toBeNull();
    expect(fleet.services).toEqual([
      expect.objectContaining({ slug: 'envisioning', kind: 'docs', ok: true }),
      { slug: 'hq', kind: 'keep', ok: false, error: 'the binding reaches docs' },
    ]);
  });

  it('finds each workspace\'s Docs and Keep from the DOCS_ and KEEP_ bindings', () => {
    const stub = { metadata: async () => ({ service: 'docs', migration: null, counts: [], last_activity_at: null }) };
    const found = boundServices(opsEnv({ KEEP_ACME_LABS: stub, DOCS_HQ: stub, WORKSPACE_HQ: stub }));
    expect(found.map(({ slug, kind }) => `${slug}/${kind}`)).toEqual(['acme-labs/keep', 'hq/docs']);
    expect(opsServiceBindingName('docs', 'acme-labs')).toBe('DOCS_ACME_LABS');
  });

  it('reads the workspaces from the WORKSPACE_ service bindings', async () => {
    const env2 = opsEnv({
      WORKSPACE_HQ: { metadata: () => workspaceOpsMetadata({ ...env, WEB_ORIGIN: 'https://hq.starlings.example' }) },
    });
    const response = await handleOpsFetch(request(await accessToken({ email: OPERATOR }), '/api/fleet'), env2, { keysFor, services: [] });
    const fleet = opsFleetSchema.parse(await response.json());
    expect(fleet.workspaces.map((row) => row.slug)).toEqual(['hq']);
  });

  it('serves the dashboard from the assets under its own CSP, after the Access check', async () => {
    const asked: string[] = [];
    const assets = {
      fetch: async (asset: Request) => {
        asked.push(new URL(asset.url).pathname);
        return new Response('<!doctype html><div id="root"></div>', { headers: { 'content-type': 'text/html' } });
      },
    };
    const response = await handleOpsFetch(request(await accessToken({ email: OPERATOR })), opsEnv({ ASSETS: assets }), { keysFor });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const refused = await handleOpsFetch(request(), opsEnv({ ASSETS: assets }), { keysFor });
    expect(refused.status).toBe(403);
    const unbuilt = await handleOpsFetch(request(await accessToken({ email: OPERATOR })), opsEnv(), { keysFor });
    expect(unbuilt.status).toBe(503);
    // Each dashboard page loads from its own URL: the Worker answers it with index.html.
    for (const path of ['/workspaces', '/workspaces/hq', '/records/']) {
      await handleOpsFetch(request(await accessToken({ email: OPERATOR }), path), opsEnv({ ASSETS: assets }), { keysFor });
    }
    await handleOpsFetch(request(await accessToken({ email: OPERATOR }), '/assets/index.js'), opsEnv({ ASSETS: assets }), { keysFor });
    expect(asked).toEqual(['/', '/', '/', '/', '/assets/index.js']);
  });

  it('answers 404 for any other API path, after the Access check', async () => {
    const response = await handleOpsFetch(request(await accessToken({ email: OPERATOR }), '/api/anything'), opsEnv(), { keysFor });
    expect(response.status).toBe(404);
  });

  it('writes times on the 24-hour clock in UTC', () => {
    expect(formatUTC(Date.UTC(2026, 9, 4, 15, 7))).toBe('2026-10-04 15:07 UTC');
    expect(formatUTC(null)).toBe('Never');
  });
});
