import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceDefaultsSchema } from '@starlings/contracts/workspace-defaults';
import worker from '../src/index';
import { readWorkspaceDefaults, writeWorkspaceDefaults, resetWorkspaceDefaultsCache } from '../src/workspace-defaults';
import { workspaceDescriptor } from '../src/workspace-descriptor';
import { kindQuestion } from '../src/granola-suggest';
import { readBookingSettings } from '../src/booking-settings';
import { filterBookingSlots, routePublicEventsProxy } from '../src/schedule-proxy';
import { sendMail } from '../src/mail';
import type { OwnerSession } from '../src/contracts';

const actor = { sub: 'defaults-owner', email: 'rosa@example.com', name: 'Rosa' } as OwnerSession;
const hq = { ...env, WORK_STORE: 'd1', WORKSPACE_NAME: 'HQ', WEB_ORIGIN: 'https://hq.starlings.example', IDENTITY_DOMAINS: 'hq.example.com' } as unknown as Env;
const custom = () => workspaceDefaultsSchema.parse({
  time_zones: ['saoPaulo', 'london'], default_language: 'en', languages_offered: ['en'],
  contact_email: 'hello@hq.example.com', privacy_email: 'privacy@hq.example.com',
  project_group_name: 'HQ Lab', ai_filing_persona: 'File meetings for HQ Lab, matching the actual people and work.',
  public_events_feed: null, booking_slot_minutes: 15,
});
async function hit(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`http://local${path}`, init), env, context);
  await waitOnExecutionContext(context);
  return response;
}
async function session(email = 'rosa@example.com') {
  const response = await hit('/api/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Defaults tester' }) });
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, origin: env.WEB_ORIGIN, 'content-type': 'application/json' };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare("DELETE FROM workspace_settings WHERE key = 'defaults'").run();
  await env.USAGE.prepare("DELETE FROM booking_settings WHERE sub = 'defaults-owner'").run();
  resetWorkspaceDefaultsCache();
});

describe('workspace defaults', () => {
  it('preserves unsaved values and never seeds another workspace with Core events', async () => {
    const legacy = await readWorkspaceDefaults(env);
    expect(legacy).toMatchObject({ source: 'default', updated_at: null, defaults: { project_group_name: 'Envisioning', booking_slot_minutes: 60, default_language: null, languages_offered: ['en', 'pt-BR'] } });
    expect(legacy.defaults.public_events_feed).toBe(`${env.CORE_API_ORIGIN}/api/public/meet-events`);
    expect((await readWorkspaceDefaults(hq)).defaults).toMatchObject({ project_group_name: 'HQ', public_events_feed: null, booking_slot_minutes: 30 });
    expect((await readBookingSettings(actor, env)).slot_step_minutes).toBe(30);
    const privacy = await hit('/privacy?from=room');
    expect(privacy.status).toBe(302);
    expect(privacy.headers.get('location')).toBe('https://site.example/privacy?from=room');
  });
  it('saves and audits the admin write, immediately publishing only presentation values', async () => {
    const response = await hit('/api/admin/workspace/defaults', { method: 'PUT', headers: await session(), body: JSON.stringify(custom()) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: 'settings', defaults: custom() });
    expect((await workspaceDescriptor(hq)).defaults).toEqual({ time_zones: ['saoPaulo', 'london'], default_language: 'en', languages_offered: ['en'], project_group_name: 'HQ Lab' });
    expect((await env.USAGE.prepare("SELECT action FROM admin_audit WHERE action = 'workspace.defaults'").first())?.action).toBe('workspace.defaults');
    const privacy = await hit('/privacy');
    expect(privacy.status).toBe(200);
    const html = await privacy.text();
    expect(html).toContain('mailto:privacy@hq.example.com');
    expect(html).toContain('mailto:hello@hq.example.com');
    expect(html).toContain('site.example/privacy');
    expect(await (await hit('/privacy', { method: 'HEAD' })).text()).toBe('');
  });
  it('refuses non-admins and invalid selections without altering the saved row', async () => {
    const member = await session('defaults-member@example.com');
    expect((await hit('/api/admin/workspace/defaults', { method: 'PUT', headers: member, body: JSON.stringify(custom()) })).status).toBe(403);
    const headers = await session();
    for (const patch of [{ time_zones: [] }, { time_zones: ['unknown'] }, { languages_offered: [] }, { default_language: 'pt-BR' }, { public_events_feed: 'https://127.0.0.1/feed' }, { public_events_feed: 'https://name:secret@feed.example.com/events' }, { public_events_feed: `${env.PUBLIC_API_ORIGIN}/api/public/events` }]) {
      expect((await hit('/api/admin/workspace/defaults', { method: 'PUT', headers, body: JSON.stringify({ ...custom(), ...patch }) })).status).toBe(400);
    }
    expect((await readWorkspaceDefaults(env)).source).toBe('default');
  });
  it('keeps a saved personal booking grid and applies the workspace fallback before the first save', async () => {
    await writeWorkspaceDefaults(hq, actor, custom());
    expect((await readBookingSettings(actor, hq)).slot_step_minutes).toBe(15);
    await env.USAGE.prepare(`INSERT INTO booking_settings (sub, active, duration_minutes, buffer_minutes, min_notice_hours, max_booking_days, slot_step_minutes, weekly_hours, updated_at)
      VALUES (?1, 1, 30, 0, 24, 60, 45, '{}', 1)`).bind(actor.sub).run();
    expect((await readBookingSettings(actor, hq)).slot_step_minutes).toBe(45);
    const slots = ['2026-10-14T09:00:00Z', '2026-10-14T09:15:00Z', '2026-10-14T09:30:00Z', '2026-10-14T09:31:00Z'].map(start => ({ start }));
    expect(filterBookingSlots(slots, 'Asia/Kolkata', 15)).toHaveLength(3);
    expect(filterBookingSlots(slots, 'Asia/Kolkata', 60)).toEqual([slots[2]]);
  });
  it('uses the configured persona and workspace identity, and sends replies to its contact', async () => {
    await writeWorkspaceDefaults(hq, actor, custom());
    const question = await kindQuestion(hq);
    expect(question.instructions).toBe(custom().ai_filing_persona);
    expect(JSON.stringify(question.criteria)).not.toContain('Envisioning');
    const sent = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ MessageID: 'test' }));
    vi.stubGlobal('fetch', sent);
    expect(await sendMail({ ...hq, POSTMARK_API_KEY: 'fake-test-mail-key', MAIL_FROM: 'sender@starlings.example' }, { to: 'member@hq.example.com', subject: 'Test', text: 'Test' })).toBe(true);
    expect(JSON.parse(sent.mock.calls[0]?.[1]?.body as string).ReplyTo).toBe('hello@hq.example.com');
  });
  it('reads only a configured public feed, without credentials or redirects, and fails closed on bad content', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ events: [] }));
    vi.stubGlobal('fetch', fetcher);
    const request = new Request('https://hq.starlings.example/api/public/events?startDate=2026-10-14&endDate=2026-10-15&token=private');
    expect((await routePublicEventsProxy(request, hq, '/api/public/events'))?.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    await writeWorkspaceDefaults(hq, actor, { ...custom(), public_events_feed: 'https://events.hq.example.com/feed' });
    expect((await routePublicEventsProxy(request, hq, '/api/public/events'))?.status).toBe(200);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://events.hq.example.com/feed?startDate=2026-10-14&endDate=2026-10-15');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', headers: { accept: 'application/json' } });
    await writeWorkspaceDefaults(hq, actor, custom());
    const off = await routePublicEventsProxy(request, hq, '/api/public/events');
    expect(off?.status).toBe(200);
    expect(await off?.json()).toEqual({ events: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await writeWorkspaceDefaults(hq, actor, { ...custom(), public_events_feed: 'https://events.hq.example.com/feed' });
    fetcher.mockResolvedValueOnce(new Response('<script>bad</script>', { headers: { 'content-type': 'text/html' } }));
    expect((await routePublicEventsProxy(request, hq, '/api/public/events'))?.status).toBe(502);
  });
  it('treats an unreadable row as unsaved and refuses a language outside the offered set', async () => {
    await env.USAGE.prepare("INSERT INTO workspace_settings (key, value, updated_at, updated_by) VALUES ('defaults', '{bad', 1, 'test')").run();
    resetWorkspaceDefaultsCache();
    expect((await readWorkspaceDefaults(hq)).source).toBe('default');
    await writeWorkspaceDefaults(hq, actor, custom());
    expect((await hit('/api/profile/language', { method: 'PUT', headers: await session(), body: JSON.stringify({ language: 'pt-BR' }) })).status).toBe(400);
  });
});
