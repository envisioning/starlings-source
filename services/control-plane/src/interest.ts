// The interest form: one row in D1 (`interest_submissions`) per
// submission, a lead with its organization and contact, and a copy of their
// answers mailed back to them. The row is the record; `lead_id` links it to
// the lead, which an admin's INBOX row opens (docs/FORMS.md). Anything
// structured reads the table directly. The product site forwards the form
// to the hq workspace (`services/marketing`), so the rows are in hq's D1:
//
//   wrangler d1 execute starlings-hq-usage --env hq --remote --json \
//     --command "SELECT created_at, email, company, body FROM interest_submissions ORDER BY created_at DESC"
//
// `body` is the answers as the schema accepted them, ids not labels, so a
// query can group on `json_extract(body, '$.timeline')` and the like.
import { INBOX_INTEREST_WINDOW_MS, type InboxItem, type InboxInterestSubmission } from '@starlings/contracts/inbox';
import { CONTACT_EMAIL } from '@starlings/contracts/deployment';
import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import {
  INTEREST_BOOKING_URL,
  INTEREST_COMMUNITY_GROUP_URL,
  INTEREST_CONFIRM_DAYS,
  INTEREST_CONFIRM_PATH,
  interestRuntimesOf,
  interestShowsCommunityGroup,
  interestReadinessAnswersSchema,
  type InterestAgentEntry,
  type InterestAgentSubmission,
  type InterestConfirmResponse,
} from '@starlings/contracts/interest';
import {
  INTEREST_AGENTS,
  INTEREST_AGENT_USES,
  INTEREST_AGENT_RUNTIMES,
  INTEREST_AGENT_USE_CASES,
  INTEREST_AGENT_REVIEWS,
  INTEREST_AGENT_ACCESS,
  INTEREST_BUDGETS,
  INTEREST_DEPLOYMENTS,
  INTEREST_DEVICES,
  INTEREST_IDENTITIES,
  INTEREST_LANES,
  INTEREST_LIVE,
  INTEREST_ORG_KINDS,
  INTEREST_OUTSIDE_WORK,
  INTEREST_PAINS,
  INTEREST_PARTS,
  INTEREST_QUESTIONS as Q,
  INTEREST_RELATIONSHIPS,
  INTEREST_REASONS,
  INTEREST_ROLES,
  INTEREST_SECTIONS,
  INTEREST_SIZES,
  INTEREST_SOURCES,
  INTEREST_PLANS,
  INTEREST_TIMELINES,
  INTEREST_TOOLS,
  INTEREST_TOOL_GROUPS,
  INTEREST_WORK_UNITS,
  interestLane,
  scoreAgentReadiness,
  type InterestInput,
  type InterestOption,
  type InterestOtherKey,
  interestSchema,
} from '@starlings/contracts/interest';
import type { FormAnswer, FormSubmission } from '@starlings/contracts/forms';
import { signupPrefillOf, type SignupInterest } from '@starlings/contracts/signup';
import { randomToken, sha256 } from './crypto';
import { ControlError } from './errors';
import { createCrmOrganization, createCrmSubject, workModelEnabled } from './crm';
import { usesCore } from './work-store';
import { d1CreateContact } from './work-d1';
import { sendMail, withSenderName } from './mail';

export { INTEREST_BOOKING_URL } from '@starlings/contracts/interest';

/**
 * One submission: the row first, then their copy by mail, on its own try. A
 * mail that does not go out logs one line (kind only, never the answers) and
 * costs nothing else; the row is already there.
 */
export async function recordInterest(env: Env, input: InterestInput, options: { receipt?: boolean } = {}): Promise<{ id: string }> {
  if (input.readiness_assessment === 'v1' && !interestReadinessAnswersSchema.safeParse(input).success) {
    throw new ControlError('Answer all ten assessment questions before submitting this request.', 400, 'invalid_request');
  }
  const id = `int_${randomToken(16)}`;
  const { turnstile_token: _token, ...answers } = input;
  await env.USAGE.prepare(
    `INSERT INTO interest_submissions (id, created_at, email, company, body) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(id, Date.now(), input.email.toLowerCase(), input.company, JSON.stringify(answers)).run();
  await fileInterestLead(env, id, input);
  // An agent's request was confirmed from a mail that already listed every answer.
  if (options.receipt === false) return { id };
  try {
    // From Starlings, the product they asked about, on the same verified address.
    await sendMail(env, { to: input.email, from: withSenderName(env.MAIL_FROM, 'Starlings'), subject: interestReceiptSubject(input), text: interestReceipt(input) });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'interest.receipt.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  return { id };
}

/** Who files the lead: no member did, so the lead has no creator person. */
const INTEREST_ACTOR = 'interest-form';

/**
 * The request as a lead in the workspace's Sales, on its own try like the
 * receipt: the row is the record, and a lead that cannot be filed logs one
 * line and costs nothing else. The organization is the company they typed,
 * reused when one already has that name. Only on a D1 workspace (hq, where
 * the site sends the form): Envisioning's Core takes a lead only from a
 * member. The notes carry the lane and the answers that sort it, so the
 * pipeline reads in Work without opening the request (GROWTH (HQ Docs)).
 */
async function fileInterestLead(env: Env, id: string, input: InterestInput): Promise<void> {
  if (usesCore(env) || !workModelEnabled(env)) return;
  try {
    const organization = await createCrmOrganization(env, INTEREST_ACTOR, oneLine(input.company).slice(0, 200));
    // The person who wrote, on that organization, so the lead names who to
    // write to. The role is their words for it, as the lead notes have it.
    const contact = await d1CreateContact(env, {
      organization_id: organization.id,
      name: oneLine(input.name).slice(0, 200),
      email: input.email,
      title: labelOf(INTEREST_ROLES, input.role, input.other.role).slice(0, 200),
    }, {
      eventType: 'form_submitted', sourceKey: 'website_contact',
      sourceRecordType: 'interest_submissions', sourceRecordId: id, dedupeKey: `interest_submission:${id}`,
    }, INTEREST_ACTOR);
    const lead = await createCrmSubject(env, {
      kind: 'lead',
      title: oneLine(input.company).slice(0, 100),
      organization_id: organization.id,
      contact_id: contact.id,
      status: 'Conversations',
      start_date: new Date().toISOString().slice(0, 10),
      notes: interestLeadNotes(id, input),
    }, INTEREST_ACTOR);
    // The link INBOX opens (docs/FORMS.md step 1).
    await env.USAGE.prepare('UPDATE interest_submissions SET lead_id = ?1 WHERE id = ?2').bind(lead.id, id).run();
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'interest.lead.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** "Lane: Peer firm. Consultancy or strategy firm, 11 to 50, …" within the lead's 1000 characters. Exported for tests. */
export function interestLeadNotes(id: string, input: InterestInput): string {
  const lane = labelOf(INTEREST_LANES, interestLane(input));
  const facts = [
    input.org_kind ? labelOf(INTEREST_ORG_KINDS, input.org_kind, input.other.org_kind) : null,
    `${labelOf(INTEREST_SIZES, input.company_size)} people`,
    input.work_unit ? labelOf(INTEREST_WORK_UNITS, input.work_unit).toLowerCase() : null,
    input.outside_work.length ? `works with ${labelsOf(INTEREST_OUTSIDE_WORK, input.outside_work).toLowerCase()}` : null,
  ].filter(Boolean).join(', ');
  return [
    `Lane: ${lane}.`,
    input.filled_by === 'agent' ? `Filled in by ${oneLine(input.agent_name ?? 'an agent')}, confirmed by mail.` : null,
    `${facts}.`,
    `${oneLine(input.name)} <${oneLine(input.email)}>, ${labelOf(INTEREST_ROLES, input.role, input.other.role)}.`,
    ...(input.agent_review && input.agent_access ? (() => {
      const readiness = scoreAgentReadiness(input);
      return [`${input.readiness_assessment ? 'Readiness assessment' : 'Agent readiness'}: ${readiness.score}/100 (${readinessBandLabel(readiness.band)}).`];
    })() : []),
    `${Q.timeline.label}: ${labelOf(INTEREST_TIMELINES, input.timeline)}. ${Q.call.label}: ${input.call ? 'yes' : 'no'}.`,
    input.source ? `${Q.source.label}: ${labelOf(INTEREST_SOURCES, input.source, input.other.source)}.` : null,
    input.plan ? `${Q.plan.label}: ${labelOf(INTEREST_PLANS, input.plan)}.` : null,
    `Early-access request ${id}.`,
  ].filter(Boolean).join('\n').slice(0, 1000);
}

export function interestReceiptSubject(input: InterestInput): string {
  return `Your answers about Starlings at ${oneLine(input.company)}`;
}

/**
 * Every answer as the words they saw, section by section, in the form's
 * order. The receipt mail and the app's view of a submission both draw this,
 * so they cannot list different questions. `body` from an older row lacks
 * later fields; `interestInputFromStored` fills them before this runs.
 */
export function interestAnswerSections(input: InterestInput): InterestSection[] {
  const other = (key: InterestOtherKey) => input.other[key];
  const tools = INTEREST_TOOL_GROUPS.map((group) =>
    answer(INTEREST_TOOLS[group].label, labelsOf(INTEREST_TOOLS[group].options, input.tools[group] ?? [], other(`tools.${group}`))));
  return [
    { title: INTEREST_SECTIONS.who.title, answers: [
      answer(Q.name.label, oneLine(input.name)),
      answer(Q.email.label, oneLine(input.email)),
      answer(Q.company.label, oneLine(input.company)),
      answer(Q.country.label, input.country ? oneLine(input.country) : NOT_GIVEN),
      answer(Q.role.label, labelOf(INTEREST_ROLES, input.role, other('role'))),
      answer(Q.org_kind.label, input.org_kind ? labelOf(INTEREST_ORG_KINDS, input.org_kind, other('org_kind')) : NOT_GIVEN),
      answer(Q.outside_work.label, labelsOf(INTEREST_OUTSIDE_WORK, input.outside_work)),
      answer(Q.work_unit.label, input.work_unit ? labelOf(INTEREST_WORK_UNITS, input.work_unit) : NOT_GIVEN),
      answer(Q.company_size.label, labelOf(INTEREST_SIZES, input.company_size)),
      answer(Q.team_size.label, labelOf(INTEREST_SIZES, input.team_size)),
      answer(Q.agents.label, input.agents ? labelOf(INTEREST_AGENTS, input.agents) : NOT_GIVEN),
      answer(Q.agent_use.label, input.agent_use ? labelOf(INTEREST_AGENT_USES, input.agent_use) : NOT_GIVEN),
      answer(Q.relationship.label, input.relationship ? labelOf(INTEREST_RELATIONSHIPS, input.relationship) : NOT_GIVEN),
      ...(input.filled_by === 'agent' ? [answer(Q.agent_name.label, oneLine(input.agent_name ?? 'An agent'))] : []),
    ] },
    { title: INTEREST_SECTIONS.today.title, answers: [
      ...tools,
      answer(Q.agent_use_cases.label, labelsOf(INTEREST_AGENT_USE_CASES, input.agent_use_cases, other('agent_use_cases')), 'list'),
      answer(Q.agent_runtimes.label, labelsOf(INTEREST_AGENT_RUNTIMES, input.agent_runtimes, other('agent_runtimes')), 'list'),
      answer(Q.agent_review.label, input.agent_review ? labelOf(INTEREST_AGENT_REVIEWS, input.agent_review) : NOT_GIVEN),
      answer(Q.agent_access.label, input.agent_access ? labelOf(INTEREST_AGENT_ACCESS, input.agent_access) : NOT_GIVEN),
      ...words(Q.agent_inventory.label, input.agent_inventory?.length ? input.agent_inventory.map(inventoryLine).join('\n') : undefined),
      ...words(Q.agent_example.label, input.agent_example),
      answer(Q.identity.label, labelOf(INTEREST_IDENTITIES, input.identity, other('identity'))),
      answer(Q.devices.label, labelsOf(INTEREST_DEVICES, input.devices)),
    ] },
    { title: INTEREST_SECTIONS.pains.title, answers: [
      answer(Q.pains.label, labelsOf(INTEREST_PAINS, input.pains, other('pains'))),
      ...words(Q.pains_text.label, input.pains_text),
    ] },
    { title: INTEREST_SECTIONS.parts.title, answers: [
      answer(Q.parts.label, labelsOf(INTEREST_PARTS, input.parts)),
      ...words(Q.missing.label, input.missing),
    ] },
    { title: INTEREST_SECTIONS.wants.title, answers: [
      answer(INTEREST_LIVE.label, labelsOf(INTEREST_LIVE.options, input.live)),
      answer(Q.deployment.label, labelOf(INTEREST_DEPLOYMENTS, input.deployment)),
      answer(Q.reason.label, labelOf(INTEREST_REASONS, input.reason, other('reason'))),
      answer(Q.timeline.label, labelOf(INTEREST_TIMELINES, input.timeline)),
      answer(Q.budget.label, input.budget ? labelOf(INTEREST_BUDGETS, input.budget) : NOT_GIVEN),
      answer(Q.pilot.label, input.pilot ? 'Yes' : 'No'),
      answer(Q.call.label, input.call ? 'Yes' : 'No'),
      answer(Q.source.label, input.source
        ? labelOf(INTEREST_SOURCES, input.source, other('source'))
        : input.heard ? oneLine(input.heard) : NOT_GIVEN),
      answer(Q.plan.label, input.plan ? labelOf(INTEREST_PLANS, input.plan) : NOT_GIVEN),
    ] },
    ...(input.agent_review && input.agent_access ? (() => {
      const readiness = scoreAgentReadiness(input);
      return [{ title: input.readiness_assessment ? 'Readiness assessment' : 'Agent readiness', answers: [
        answer('Readiness score', `${readiness.score}/100 · ${readinessBandLabel(readiness.band)}`),
        ...readiness.dimensions.map((dimension) => answer(readinessDimensionLabel(dimension.id), `${dimension.score} / ${dimension.max}`)),
      ] }];
    })() : []),
  ];
}

function readinessBandLabel(band: ReturnType<typeof scoreAgentReadiness>['band']): string {
  return band === 'exploring' ? 'Exploring' : band === 'building' ? 'Building' : 'Ready to pilot';
}

function readinessDimensionLabel(id: ReturnType<typeof scoreAgentReadiness>['dimensions'][number]['id']): string {
  return id === 'agent-practice' ? 'Agent practice'
    : id === 'human-review' ? 'Human review'
      : id === 'access-boundaries' ? 'Access boundaries'
        : 'Pilot horizon';
}

/** One question and its answer. `list` and `text` set the answer apart in the mail. */
interface InterestAnswer extends FormAnswer {
  shape: 'line' | 'list' | 'text';
}

interface InterestSection {
  title: string;
  answers: InterestAnswer[];
}

function answer(question: string, value: string, shape: InterestAnswer['shape'] = 'line'): InterestAnswer {
  return { question, answer: value, shape };
}

/** Free text they wrote, or nothing when they left it blank. */
function words(question: string, value: string | undefined): InterestAnswer[] {
  return value ? [answer(question, value, 'text')] : [];
}

/**
 * Their copy: every answer as the words they saw, section by section, then
 * the booking link if they asked for a call. Plain text, so it reads the
 * same everywhere and nothing in it can be a link they did not expect.
 * Exported for tests.
 */
export function interestReceipt(input: InterestInput): string {
  const sections = [
    [
      `Hello ${oneLine(input.name)},`,
      '',
      'Thank you for telling us how your company would use Starlings. This is a copy of what you sent, for your records.',
      input.call
        ? `You asked for a call. Pick a time here, and we show you Starlings live: ${INTEREST_BOOKING_URL}\nYou join from your browser, with no account.`
        : 'We read every one of these. If Starlings fits your team, we set up a workspace for you.',
      ...(interestShowsCommunityGroup(input.source)
        ? ['', `You came from Artificial Insights, so there's a pilot group on WhatsApp for you. We post news there first and set up the first workspaces from it. We let people in once we've read their answers: ${INTEREST_COMMUNITY_GROUP_URL}`]
        : []),
    ],
    ...answerBlocks(input),
    [
      `Your answers stay in Envisioning's private records and nowhere else. Reply to this mail, or write to ${CONTACT_EMAIL}, if anything should change.`,
      '',
      'Envisioning',
    ],
  ];
  return sections.map((lines) => lines.join('\n')).join('\n\n');
}

/** Every section of answers as plain-text lines, for a mail. */
function answerBlocks(input: InterestInput): string[][] {
  return interestAnswerSections(input).map((group) => [group.title.toUpperCase(), ...group.answers.flatMap(receiptLines)]);
}

/** One agent as one line: "sku-extractor: Pulls SKUs … (Code in a repo; nightly cron; Claude Code; touches Postgres)". */
function inventoryLine(entry: InterestAgentEntry): string {
  const facts = [
    entry.runtime ? labelOf(INTEREST_AGENT_RUNTIMES, entry.runtime) : null,
    entry.trigger ? oneLine(entry.trigger) : null,
    entry.operated_by ? oneLine(entry.operated_by) : null,
    entry.touches.length ? `touches ${entry.touches.map(oneLine).join(', ')}` : null,
  ].filter(Boolean);
  return `${oneLine(entry.name)}: ${oneLine(entry.does)}${facts.length ? ` (${facts.join('; ')})` : ''}`;
}

/*
 * The agent path (docs/FORMS.md §Agents). An agent's request waits in
 * `interest_pending` until the person opens the mailed link; only then does
 * it become a submission, a lead and an INBOX row. The mail is the proof a
 * person stands behind it, where the browser form has Turnstile.
 */

const CONFIRM_MS = INTEREST_CONFIRM_DAYS * 24 * 60 * 60 * 1000;
/** One confirm mail per address per day, so the route cannot be a way to mail someone repeatedly. */
const CONFIRM_SPACING_MS = 24 * 60 * 60 * 1000;

/**
 * Hold an agent's answers and mail the person a link to confirm them. A
 * mail that does not go out, or a Worker with no mail set up, removes the
 * row and fails the request, so the agent never reports a mail nobody sent.
 * `send` is the mailer; tests pass their own.
 */
export async function holdAgentInterest(
  env: Env,
  submission: InterestAgentSubmission,
  { now = Date.now(), send = sendMail }: { now?: number; send?: typeof sendMail } = {},
): Promise<{ email: string; expires_at: number }> {
  const input: InterestInput = {
    ...submission,
    agent_runtimes: submission.agent_runtimes.length ? submission.agent_runtimes : interestRuntimesOf(submission.agent_inventory),
    filled_by: 'agent',
  };
  const email = input.email.toLowerCase();
  await env.USAGE.prepare('DELETE FROM interest_pending WHERE expires_at <= ?1').bind(now).run();
  const recent = await env.USAGE.prepare('SELECT 1 FROM interest_pending WHERE email = ?1 AND created_at > ?2 LIMIT 1')
    .bind(email, now - CONFIRM_SPACING_MS).first();
  if (recent) {
    throw new ControlError('A confirm mail already went to this address today. Ask the person to open it.', 429, 'rate_limited');
  }
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const expiresAt = now + CONFIRM_MS;
  await env.USAGE.prepare('INSERT INTO interest_pending (token_hash, email, created_at, expires_at, body) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(tokenHash, email, now, expiresAt, JSON.stringify(input)).run();
  let sent = false;
  try {
    sent = await send(env, {
      to: input.email,
      from: withSenderName(env.MAIL_FROM, 'Starlings'),
      subject: interestConfirmSubject(input),
      text: interestConfirmMail(input, `${PRODUCT_SITE_ORIGIN}${INTEREST_CONFIRM_PATH}#${token}`),
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'interest.confirm_mail.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  if (!sent) {
    await env.USAGE.prepare('DELETE FROM interest_pending WHERE token_hash = ?1').bind(tokenHash).run();
    throw new ControlError('The confirm mail could not be sent. Try again later.', 503);
  }
  return { email, expires_at: expiresAt };
}

/**
 * The person opened the link: the held answers become a submission and a
 * lead. The row is deleted in the same statement that reads it, so a link
 * works once.
 */
export async function confirmAgentInterest(env: Env, token: string, { now = Date.now() }: { now?: number } = {}): Promise<InterestConfirmResponse> {
  const row = await env.USAGE.prepare('DELETE FROM interest_pending WHERE token_hash = ?1 AND expires_at > ?2 RETURNING body')
    .bind(await sha256(token), now).first<{ body: string }>();
  if (!row) throw new ControlError('This link has expired or was already used.', 410, 'link_expired');
  const input = interestInputFromStored(JSON.parse(row.body));
  await recordInterest(env, input, { receipt: false });
  return { ok: true, company: oneLine(input.company), call: input.call };
}

export function interestConfirmSubject(input: InterestInput): string {
  return `Confirm your Starlings request for ${oneLine(input.company)}`;
}

/** The confirm mail: who filled it in, the link, and every answer. Exported for tests. */
export function interestConfirmMail(input: InterestInput, link: string): string {
  return [
    [
      `Hello ${oneLine(input.name)},`,
      '',
      `${oneLine(input.agent_name ?? 'An agent')} filled in Starlings' early access form for ${oneLine(input.company)} and gave this address. Open this link and press Send to pass the answers to Envisioning:`,
      link,
      '',
      `The link works for ${INTEREST_CONFIRM_DAYS} days. If you did not ask for this, ignore this mail. Nothing is sent.`,
    ],
    ...answerBlocks(input),
    ['Envisioning'],
  ].map((lines) => lines.join('\n')).join('\n\n');
}

/** "Question: answer"; a list or their own words go below the question, set in. */
function receiptLines(item: InterestAnswer): string[] {
  switch (item.shape) {
    case 'line': return [`${item.question}: ${item.answer}`];
    case 'list': return [item.question, indent(item.answer)];
    case 'text': return ['', /[.?:]$/u.test(item.question) ? item.question : `${item.question}:`, indent(item.answer)];
  }
}

/**
 * A stored `body` as the input it was. A row the schema still accepts parses
 * as it; an older row, from before a question was added, keeps what it has
 * and reads every later list as empty, so it shows as "Not given".
 */
export function interestInputFromStored(body: unknown): InterestInput {
  const parsed = interestSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const stored = (body && typeof body === 'object' ? body : {}) as Partial<InterestInput>;
  return {
    outside_work: [], agent_use_cases: [], agent_runtimes: [], agent_inventory: [], devices: [], live: [], pains: [], parts: [],
    ...stored,
    other: stored.other ?? {},
    tools: { ...stored.tools } as InterestInput['tools'],
  } as InterestInput;
}

/**
 * The answers that filed a lead, for the lead's Submission group in Work
 * (docs/FORMS.md). Null when the lead did not come from the form. Only a D1
 * workspace files leads from the form, so a Core workspace has none.
 */
export async function interestSubmissionForLead(env: Env, leadId: string): Promise<FormSubmission | null> {
  if (usesCore(env)) return null;
  const row = await env.USAGE.prepare(
    'SELECT id, created_at, body FROM interest_submissions WHERE lead_id = ?1 ORDER BY created_at DESC LIMIT 1',
  ).bind(leadId).first<{ id: string; created_at: number; body: string }>();
  if (!row) return null;
  let body: unknown;
  try {
    body = JSON.parse(row.body);
  } catch {
    return null;
  }
  return {
    id: row.id,
    form: 'interest',
    title: INTEREST_FORM_TITLE,
    submitted_at: new Date(row.created_at).toISOString(),
    sections: interestAnswerSections(interestInputFromStored(body)).map((group) => ({
      title: group.title,
      answers: group.answers.map(({ question, answer: value }) => ({ question, answer: value })),
    })),
  };
}

/** What the app calls a submission of this form. */
const INTEREST_FORM_TITLE = 'Early-access request';

/** An answer they left blank. */
const NOT_GIVEN = 'Not given';

/** Free text they wrote, set in from the margin so it reads as a quote. */
function indent(text: string): string {
  return text.split(/\r?\n/u).map((row) => `  ${row}`).join('\n');
}

/** Table cells and titles: no newlines, so a value cannot add a row. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The last month of submissions as INBOX rows, for an admin. The picks are
 * resolved to their labels here, once, so no client carries the lists.
 * `body` is whatever the schema accepted at the time; an older row that
 * lacks a later field reads as a blank, never as a failed source.
 */
export async function interestInboxItems(env: Env, dismissed: Set<string>): Promise<InboxItem[]> {
  const since = Date.now() - INBOX_INTEREST_WINDOW_MS;
  // The lead it filed, when that lead still exists: a deleted lead leaves
  // the row as it was before the link, opening a mail.
  const { results } = await env.USAGE.prepare(
    `SELECT s.id, s.created_at, s.body, l.id AS lead_id, l.title AS lead_title
     FROM interest_submissions s LEFT JOIN leads l ON l.id = s.lead_id
     WHERE s.created_at >= ?1 ORDER BY s.created_at DESC`,
  ).bind(since).all<{ id: string; created_at: number; body: string; lead_id: string | null; lead_title: string | null }>();
  const items: InboxItem[] = [];
  for (const row of results) {
    const key = `interest:${row.id}`;
    if (dismissed.has(key)) continue;
    let body: Partial<InterestInput>;
    try {
      body = JSON.parse(row.body) as Partial<InterestInput>;
    } catch {
      continue;
    }
    const submission: InboxInterestSubmission = {
      id: row.id,
      created_at: new Date(row.created_at).toISOString(),
      name: body.name ?? '',
      email: body.email ?? '',
      company: body.company ?? '',
      role: body.role ? labelOf(INTEREST_ROLES, body.role, body.other?.role) : '',
      company_size: body.company_size ? labelOf(INTEREST_SIZES, body.company_size) : '',
      team_size: body.team_size ? labelOf(INTEREST_SIZES, body.team_size) : '',
      agents: body.agents ? labelOf(INTEREST_AGENTS, body.agents) : '',
      deployment: body.deployment ? labelOf(INTEREST_DEPLOYMENTS, body.deployment) : '',
      reason: body.reason ? labelOf(INTEREST_REASONS, body.reason, body.other?.reason) : '',
      timeline: body.timeline ? labelOf(INTEREST_TIMELINES, body.timeline) : '',
      parts: (body.parts ?? []).map((id) => labelOf(INTEREST_PARTS, id)),
      missing: body.missing ?? null,
      org_kind: body.org_kind ? labelOf(INTEREST_ORG_KINDS, body.org_kind, body.other?.org_kind) : '',
      lane: labelOf(INTEREST_LANES, interestLane(body)),
      lead: row.lead_id ? { kind: 'lead', id: row.lead_id, title: row.lead_title ?? body.company ?? '' } : null,
    };
    items.push({ key, at: row.created_at, source: 'interest', submission });
  }
  return items;
}

/** The label they saw; for an Other, the words they typed after it: "Other: CTO". */
function labelOf(options: readonly InterestOption[], id: string, otherText?: string): string {
  const option = options.find((candidate) => candidate.id === id);
  const label = option?.label ?? id;
  return option?.other && otherText ? `${label}: ${oneLine(otherText)}` : label;
}

function labelsOf(options: readonly InterestOption[], picked: readonly string[], otherText?: string): string {
  return picked.length ? picked.map((id) => labelOf(options, id, otherText)).join(', ') : NOT_GIVEN;
}

/** How many interest requests the operator's console lists, newest first. */
export const INTEREST_LIST_LIMIT = 50;

interface InterestRow { id: string; created_at: number; email: string; company: string; body: string }

function interestOf(row: InterestRow): SignupInterest {
  let answers: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (parsed && typeof parsed === 'object') answers = parsed as Record<string, unknown>;
  } catch {
    // A row whose body does not parse still lists, with nothing to fill in.
  }
  return {
    id: row.id,
    created_at: row.created_at,
    email: row.email,
    name: typeof answers.name === 'string' ? answers.name : '',
    company: row.company,
    team_size: typeof answers.team_size === 'string' ? answers.team_size : null,
    prefill: signupPrefillOf(answers),
  };
}

/**
 * The newest interest requests, for the operator's console. Read
 * over `OpsService`, which only starlings-ops binds; the console answers one
 * with a signup link.
 */
export async function listInterests(env: Pick<Env, 'USAGE'>, limit = INTEREST_LIST_LIMIT): Promise<SignupInterest[]> {
  const { results } = await env.USAGE.prepare(
    'SELECT id, created_at, email, company, body FROM interest_submissions ORDER BY created_at DESC LIMIT ?1',
  ).bind(limit).all<InterestRow>();
  return results.map(interestOf);
}

/** One interest request by id, or null. */
export async function interestByID(env: Pick<Env, 'USAGE'>, id: string): Promise<SignupInterest | null> {
  const row = await env.USAGE.prepare('SELECT id, created_at, email, company, body FROM interest_submissions WHERE id = ?1')
    .bind(id).first<InterestRow>();
  return row ? interestOf(row) : null;
}
