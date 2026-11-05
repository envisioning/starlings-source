import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ControlErrorBody } from '@starlings/contracts';
import { INTEREST_LONG_TEXT_MAX_CHARS, interestLane, interestSchema, interestSourceFromQuery } from '@starlings/contracts/interest';
import { INTEREST_BOOKING_URL, interestLeadNotes, interestReceipt, recordInterest } from '../src/interest';

const WEB_ORIGIN = 'http://127.0.0.1:5173';

const complete = {
  name: 'Ada',
  email: 'ada@example.net',
  company: 'Example | Co',
  role: 'ops',
  company_size: '11-50',
  team_size: '2-10',
  agents: '2-5',
  deployment: 'self-hosted',
  reason: 'own-data',
  timeline: 'quarter',
  identity: 'google',
  devices: ['mac', 'iphone'],
  tools: { video: ['zoom'], notes: ['granola'], booking: [], work: ['linear'], chat: ['slack'] },
  pains: ['recording', 'other'],
  other: { pains: 'Nobody reads the notes', 'tools.video': 'Whereby' },
  parts: ['meetings', 'transcript'],
  missing: 'Windows host.\n```\nfence\n```',
  pilot: true,
  call: true,
};

function interestRequest(body: unknown, origin = WEB_ORIGIN): Request {
  return new Request('http://local/api/interest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

describe('Interest form', () => {
  it('reads a known source from the address and ignores anything else', () => {
    expect(interestSourceFromQuery('?source=artificial-insights')).toBe('artificial-insights');
    expect(interestSourceFromQuery('?source=nonsense')).toBeUndefined();
    expect(interestSourceFromQuery('')).toBeUndefined();
  });

  it('refuses a submission that did not come from the web origin', async () => {
    const response = await exports.default.fetch(interestRequest(complete, 'https://evil.example'));
    expect(response.status).toBe(403);
    expect((await response.json<ControlErrorBody>()).code).toBe('untrusted_origin');
  });

  it('refuses an unknown pick, and an Other text for a list that has none', async () => {
    expect((await exports.default.fetch(interestRequest({ ...complete, role: 'wizard' }))).status).toBe(400);
    expect((await exports.default.fetch(interestRequest({ ...complete, other: { deployment: 'a barn' } }))).status).toBe(400);
    expect((await exports.default.fetch(interestRequest({ ...complete, agent_use_cases: ['wizardry'] }))).status).toBe(400);
    expect((await exports.default.fetch(interestRequest({ ...complete, agent_runtimes: ['cloud-magic'] }))).status).toBe(400);
    expect((await exports.default.fetch(interestRequest({ ...complete, agent_example: 'x'.repeat(INTEREST_LONG_TEXT_MAX_CHARS + 1) }))).status).toBe(400);
  });

  it('accepts submissions without the optional agent workflow questions', async () => {
    expect((await exports.default.fetch(interestRequest(complete))).status).toBe(202);
    const input = interestSchema.parse(complete);
    expect(input.agent_use_cases).toEqual([]);
    expect(input.agent_runtimes).toEqual([]);
    expect(input.agent_example).toBeUndefined();
    expect(interestReceipt(input)).toContain('What are you using AI agents for today?\n  Not given');
  });

  it('saves the answers as one row, ids not labels, email lowered', async () => {
    const response = await exports.default.fetch(interestRequest({ ...complete, email: 'Row@Example.net' }));
    expect(response.status).toBe(202);
    const row = await env.USAGE.prepare(
      'SELECT email, company, body FROM interest_submissions WHERE email = ?1',
    ).bind('row@example.net').first<{ email: string; company: string; body: string }>();
    expect(row?.company).toBe('Example | Co');
    expect(JSON.parse(row!.body).parts).toEqual(['meetings', 'transcript']);
    expect(JSON.parse(row!.body).turnstile_token).toBeUndefined();
    expect(JSON.parse(row!.body).deployment).toBe('self-hosted');
    expect(JSON.parse(row!.body).agents).toBe('2-5');
    expect(JSON.parse(row!.body).other).toEqual({ pains: 'Nobody reads the notes', 'tools.video': 'Whereby' });
  });

  it('their copy says what they picked, in words, with the booking link when they asked to talk', () => {
    const input = interestSchema.parse(complete);
    const text = interestReceipt(input);
    expect(text).toContain('Hello Ada,');
    expect(text).toContain(INTEREST_BOOKING_URL);
    expect(text).toContain('Your role: Operations');
    expect(text).toContain('Agents you would run: 2 to 5');
    expect(text).toContain('Live calls and presence: Zoom');
    expect(text).toContain('What hurts today: Calls get recorded and we do not want that, Something else: Nobody reads the notes');
    expect(text).toContain('How you would run it: On our own Cloudflare and Apple accounts');
    expect(text).toContain('What’s missing:\n  Windows host.');
    expect(text).not.toContain('turnstile');
    const quiet = interestReceipt(interestSchema.parse({ ...complete, call: false }));
    expect(quiet).not.toContain(INTEREST_BOOKING_URL);
  });

  it('saves multiple current agent uses, an Other answer and the example in their copy', async () => {
    const answers = {
      ...complete,
      email: 'workflows@example.net',
      agent_use_cases: ['coding', 'extraction', 'other'],
      agent_runtimes: ['repo', 'chat-app'],
      agent_example: '  Review pull requests.\nDraft release notes.  ',
      other: { agent_use_cases: 'Translation' },
    };
    expect((await exports.default.fetch(interestRequest(answers))).status).toBe(202);
    const row = await env.USAGE.prepare(
      'SELECT body FROM interest_submissions WHERE email = ?1',
    ).bind(answers.email).first<{ body: string }>();
    const saved = interestSchema.parse(JSON.parse(row!.body));
    expect(saved.agent_use_cases).toEqual(answers.agent_use_cases);
    expect(saved.agent_runtimes).toEqual(answers.agent_runtimes);
    expect(saved.agent_example).toBe('Review pull requests.\nDraft release notes.');
    expect(saved.other.agent_use_cases).toBe('Translation');
    const copy = interestReceipt(saved);
    expect(copy).toContain('What are you using AI agents for today?\n  Coding and software development, Pulling structured data from websites, Other: Translation');
    expect(copy).toContain('Where do your agents run?\n  As code in our repo, run by a coding agent like Claude Code or Codex, Inside a chat app, like custom GPTs, Grok or Claude Projects');
    expect(copy).toContain('Tell us about one task you use agents for.\n  Review pull requests.\n  Draft release notes.');
  });

  it('sorts a request into its ICP lane by kind of organization, whatever its size', () => {
    expect(interestLane({ org_kind: 'consultancy' })).toBe('peer-firm');
    expect(interestLane({ org_kind: 'research' })).toBe('peer-firm');
    expect(interestLane({ org_kind: 'collective' })).toBe('crew');
    expect(interestLane({ org_kind: 'student' })).toBe('crew');
    expect(interestLane({ org_kind: 'fund' })).toBe('fund');
    expect(interestLane({ org_kind: 'in-house' })).toBe('outside');
    expect(interestLane({})).toBe('outside');
  });

  it('says the kind of organization, the work and the source in their copy', () => {
    const text = interestReceipt(interestSchema.parse({
      ...complete,
      org_kind: 'other',
      outside_work: ['clients', 'partners'],
      work_unit: 'engagement',
      source: 'other',
      other: { org_kind: 'Cooperative', source: 'A podcast' },
    }));
    expect(text).toContain('What kind of organization: Other: Cooperative');
    expect(text).toContain('Who you work with outside your team: Clients, Partners and collaborators');
    expect(text).toContain('How your work is organized: By client engagement');
    expect(text).toContain('How you heard about Starlings: Other: A podcast');
    expect(interestReceipt(interestSchema.parse({ ...complete, heard: 'A friend' }))).toContain('How you heard about Starlings: A friend');
  });

  it('refuses an unknown kind of organization or source', async () => {
    expect((await exports.default.fetch(interestRequest({ ...complete, org_kind: 'cartel' }))).status).toBe(400);
    expect((await exports.default.fetch(interestRequest({ ...complete, source: 'tv' }))).status).toBe(400);
  });

  it('files the request as a lead with its lane on a workspace without Core, reusing the organization by name', async () => {
    const d1 = { ...env, WORK_STORE: 'd1', CRM_SYNC_MODE: 'off' } as Env;
    const answers = interestSchema.parse({
      ...complete,
      email: 'lead@example.net',
      company: 'Northwind Foresight',
      org_kind: 'research',
      outside_work: ['clients'],
      work_unit: 'engagement',
      source: 'linkedin',
    });
    const { id } = await recordInterest(d1, answers);
    await recordInterest(d1, { ...answers, email: 'second@example.net', company: 'northwind foresight' });
    const leads = await d1.USAGE.prepare(
      `SELECT leads.title, leads.status, leads.notes, organizations.name AS organization
       FROM leads JOIN organizations ON organizations.id = leads.organization_id
       WHERE lower(organizations.name) = 'northwind foresight' ORDER BY leads.created_at`,
    ).all<{ title: string; status: string; notes: string; organization: string }>();
    expect(leads.results).toHaveLength(2);
    expect(new Set(leads.results.map((lead) => lead.organization))).toEqual(new Set(['Northwind Foresight']));
    expect(leads.results[0]).toMatchObject({ title: 'Northwind Foresight', status: 'Conversations' });
    expect(leads.results[0]!.notes).toBe(interestLeadNotes(id, answers));
    expect(leads.results[0]!.notes).toContain('Lane: Peer firm.');
    expect(leads.results[0]!.notes).toContain('Research, foresight or think tank, 11 to 50 people, by client engagement, works with clients.');
    expect(leads.results[0]!.notes).toContain('How you heard about Starlings: LinkedIn.');
  });

  it('files no lead on a Core workspace, and keeps the request', async () => {
    const before = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>();
    const { id } = await recordInterest(env, interestSchema.parse({ ...complete, email: 'core@example.net' }));
    expect(await env.USAGE.prepare('SELECT id FROM interest_submissions WHERE id = ?1').bind(id).first()).not.toBeNull();
    expect(await env.USAGE.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>()).toEqual(before);
  });
});
