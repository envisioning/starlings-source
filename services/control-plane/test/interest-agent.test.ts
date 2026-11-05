import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { interestAgentSubmissionSchema } from '@starlings/contracts/interest';
import { interestAgentJsonSchema, interestGuideMarkdown } from '@starlings/contracts/interest-agent';
import { confirmAgentInterest, holdAgentInterest, interestLeadNotes } from '../src/interest';
import { interestInputFromStored } from '../src/interest';
import type { OutboundMail } from '../src/mail';

const WEB_ORIGIN = 'http://127.0.0.1:5173';

const agentAnswers = {
  agent_name: 'Claude Code',
  name: 'Ada',
  email: 'Ada@Agent.example',
  company: 'Apparel Example',
  role: 'founder',
  org_kind: 'research',
  work_unit: 'product',
  company_size: '2-10',
  team_size: '2-10',
  agents: '2-5',
  agent_use: 'recurring',
  relationship: 'client',
  agent_inventory: [
    { name: 'sku-extractor', does: 'Pulls SKUs and prices from retailer sites.', runtime: 'repo', trigger: 'nightly cron', operated_by: 'Claude Code', touches: ['retailer sites', 'Postgres'] },
    { name: 'trend-posts', does: 'Drafts trend posts.', runtime: 'chat-app', operated_by: 'Grok' },
  ],
  identity: 'google',
  deployment: 'hosted',
  reason: 'agents',
  timeline: 'now',
  call: true,
};

function agentRequest(body: unknown): Request {
  return new Request('http://local/api/interest/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The Worker's env with a sender address, which the test env lacks. */
const mailEnv = { ...env, MAIL_FROM: 'Starlings <contact@org.example>' } as Env;

/** A mailer that keeps what it was asked to send. */
function mailbox() {
  const sent: OutboundMail[] = [];
  return { sent, send: async (_env: unknown, mail: OutboundMail) => { sent.push(mail); return true; } };
}

function tokenOf(mail: OutboundMail): string {
  const token = /\/interest\/confirm#([A-Za-z0-9_-]+)/u.exec(mail.text)?.[1];
  if (!token) throw new Error('No confirm link in the mail');
  return token;
}

describe('Interest form, agent path', () => {
  it('answers a bad request with every issue, by path', async () => {
    const response = await exports.default.fetch(agentRequest({ ...agentAnswers, role: 'wizard', agent_name: '', agent_inventory: [] , agent_example: undefined }));
    expect(response.status).toBe(400);
    const body = await response.json<{ code: string; issues: Array<{ path: string; message: string }> }>();
    expect(body.code).toBe('invalid_request');
    expect(body.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['role', 'agent_name']));
  });

  it('asks for the inventory or one task once agents are in use', () => {
    const { agent_inventory: _inventory, ...rest } = agentAnswers;
    const parsed = interestAgentSubmissionSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
    expect(interestAgentSubmissionSchema.safeParse({ ...rest, agent_example: 'Drafts posts.' }).success).toBe(true);
    expect(interestAgentSubmissionSchema.safeParse({ ...rest, agent_use: 'none' }).success).toBe(true);
  });

  it('fails closed when no confirm mail goes out, and keeps nothing', async () => {
    const response = await exports.default.fetch(agentRequest({ ...agentAnswers, email: 'nomail@agent.example' }));
    expect(response.status).toBe(503);
    const row = await env.USAGE.prepare('SELECT 1 FROM interest_pending WHERE email = ?1').bind('nomail@agent.example').first();
    expect(row).toBeNull();
  });

  it('holds the answers until the person confirms, then files them once', async () => {
    const box = mailbox();
    const submission = interestAgentSubmissionSchema.parse(agentAnswers);
    const held = await holdAgentInterest(mailEnv, submission, { send: box.send });
    expect(held.email).toBe('ada@agent.example');
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.subject).toBe('Confirm your Starlings request for Apparel Example');
    expect(box.sent[0]!.text).toContain('Claude Code filled in Starlings\' early access form for Apparel Example');
    expect(box.sent[0]!.text).toContain('sku-extractor: Pulls SKUs and prices from retailer sites. (As code in our repo, run by a coding agent like Claude Code or Codex; nightly cron; Claude Code; touches retailer sites, Postgres)');
    const before = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM interest_submissions WHERE email = ?1').bind('ada@agent.example').first<{ n: number }>();
    expect(before?.n).toBe(0);

    await expect(holdAgentInterest(mailEnv, submission, { send: box.send })).rejects.toMatchObject({ status: 429 });

    const token = tokenOf(box.sent[0]!);
    expect(await confirmAgentInterest(env, token)).toEqual({ ok: true, company: 'Apparel Example', call: true });
    const row = await env.USAGE.prepare('SELECT body FROM interest_submissions WHERE email = ?1').bind('ada@agent.example').first<{ body: string }>();
    const saved = interestInputFromStored(JSON.parse(row!.body));
    expect(saved.filled_by).toBe('agent');
    expect(saved.agent_name).toBe('Claude Code');
    expect(saved.agent_runtimes).toEqual(['chat-app', 'repo']);
    expect(saved.agent_inventory).toHaveLength(2);
    expect(interestLeadNotes('int_x', saved)).toContain('Filled in by Claude Code, confirmed by mail.');

    await expect(confirmAgentInterest(env, token)).rejects.toMatchObject({ status: 410, code: 'link_expired' });
  });

  it('refuses an expired link', async () => {
    const box = mailbox();
    const now = Date.now();
    await holdAgentInterest(mailEnv, interestAgentSubmissionSchema.parse({ ...agentAnswers, email: 'late@agent.example' }), { send: box.send, now });
    await expect(confirmAgentInterest(env, tokenOf(box.sent[0]!), { now: now + 4 * 24 * 60 * 60 * 1000 }))
      .rejects.toMatchObject({ status: 410 });
  });

  it('takes a confirm only from the web origin', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/interest/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ token: 'x'.repeat(43) }),
    }));
    expect(response.status).toBe(403);
    const unknown = await exports.default.fetch(new Request('http://local/api/interest/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: WEB_ORIGIN }, body: JSON.stringify({ token: 'x'.repeat(43) }),
    }));
    expect(unknown.status).toBe(410);
  });

  it('a browser submission cannot claim an agent filled it in', async () => {
    const { agent_name: _name, agent_inventory: _inventory, ...form } = agentAnswers;
    const response = await exports.default.fetch(new Request('http://local/api/interest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ ...form, email: 'form@agent.example', filled_by: 'agent', agent_name: 'Mallory' }),
    }));
    expect(response.status).toBe(202);
    const row = await env.USAGE.prepare('SELECT body FROM interest_submissions WHERE email = ?1').bind('form@agent.example').first<{ body: string }>();
    const saved = interestInputFromStored(JSON.parse(row!.body));
    expect(saved.filled_by).toBe('form');
    expect(saved.agent_name).toBeUndefined();
  });

  it('describes every field in the schema and the guide', () => {
    const schema = interestAgentJsonSchema('https://site.example') as { required: string[]; properties: Record<string, { description?: string }> };
    expect(schema.required).toContain('agent_name');
    expect(schema.properties.role?.description).toContain('founder (Founder or CEO)');
    expect(schema.properties.turnstile_token).toBeUndefined();
    expect(interestGuideMarkdown('https://site.example')).toContain('POST the answers as JSON to https://site.example/api/interest/agent');
  });
});
