// A workspace's public forms (docs/FORMS.md §Step 2 and).
// One row in D1 (`form_submissions`) per submission, then the lead it files
// with its organization and contact, as `/interest` does on hq. The row is
// the record; `lead_id` links it to the lead, which the INBOX row opens and
// whose Overview shows the answers. The registry is
// `packages/contracts/src/forms.ts`:
//
//   wrangler d1 execute <workspace D1> --env <slug> --remote --json \
//     --command "SELECT created_at, form_id, organization, email, body FROM form_submissions ORDER BY created_at DESC"
import { INBOX_INTEREST_WINDOW_MS, type InboxFormSubmission, type InboxItem } from '@starlings/contracts/inbox';
import { formAnswers, formFor, formsFor, type FormDefinition, type FormSubmission } from '@starlings/contracts/forms';
import { randomToken } from './crypto';
import { ControlError } from './errors';
import { createCrmOrganization, createCrmSubject, workModelEnabled } from './crm';
import { usesCore } from './work-store';
import { d1CreateContact } from './work-d1';
import { workspaceSlug } from './workspace-origins';
import { submitIntakeMessage } from './support-intake';
import { withSenderName } from './mail';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The form with this id on this workspace, or a 404 that says nothing else. */
export function offeredForm(env: Env, id: string): FormDefinition {
  const form = formFor(workspaceSlug(env), id);
  if (!form) throw new ControlError('This workspace has no form by that name.', 404, 'request_not_found');
  return form;
}

/**
 * Whether `origin` may post this form from its own page: one of
 * the form's listed origins, matched exactly.
 */
export function formAllowsOrigin(form: FormDefinition, origin: string | null): boolean {
  return origin !== null && form.origins.includes(origin);
}

/**
 * One submission. A filled honeypot is accepted and dropped, so the answer
 * never tells a bot it was caught. Past the form's hourly total the route
 * answers 429; that total is the form's whole budget, so a flood from many
 * addresses costs at most one hour of rows.
 */
export async function recordFormSubmission(
  env: Env,
  form: FormDefinition,
  answers: Record<string, unknown>,
  { now = Date.now() }: { now?: number } = {},
): Promise<{ id: string } | null> {
  const { website, ...body } = answers;
  if (typeof website === 'string' && website.trim()) return null;
  const recent = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ?1 AND created_at > ?2')
    .bind(form.id, now - HOUR_MS).first<{ n: number }>();
  if ((recent?.n ?? 0) >= form.hourlyLimit) {
    throw new ControlError('This form takes no more answers right now. Try again in an hour.', 429, 'rate_limited');
  }
  const who = whoOf(form, body);
  const id = `sub_${randomToken(16)}`;
  await env.USAGE.prepare(
    'INSERT INTO form_submissions (id, form_id, created_at, email, name, organization, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  ).bind(id, form.id, now, who.email.toLowerCase(), who.name, who.organization, JSON.stringify(body)).run();
  if (form.files === 'thread') await fileFormThread(env, form, id, body);
  else await fileFormLead(env, form, id, body);
  return { id };
}

/**
 * The message as a private intake conversation, as `/support` files one
 * (docs/SUPPORT.md): the member answers there, and the mailed link lets the
 * sender continue it. A mail that does not go out logs one line; the message
 * is stored and the member still sees it, with the address to write to.
 */
async function fileFormThread(env: Env, form: FormDefinition, id: string, body: Record<string, unknown>): Promise<void> {
  const who = whoOf(form, body);
  const message = form.who.message && typeof body[form.who.message] === 'string' ? (body[form.who.message] as string).trim() : '';
  if (!form.thread || !message) return;
  const thread = form.thread;
  const lang = typeof body.lang === 'string' && thread.mail[body.lang] ? body.lang : Object.keys(thread.mail)[0]!;
  const copy = thread.mail[lang]!;
  const { mailed } = await submitIntakeMessage(env, {
    name: who.name,
    email: who.email,
    message,
    idempotencyKey: `form:${id}`,
    label: thread.label,
    mail: (name, link) => ({
      ...(env.MAIL_FROM ? { from: withSenderName(env.MAIL_FROM, thread.sender) } : {}),
      subject: copy.subject,
      text: copy.body.replaceAll('{name}', name).replaceAll('{link}', link),
    }),
  });
  if (!mailed) console.error(JSON.stringify({ level: 'error', message: 'form.thread.mail_failed', form: form.id }));
}

/** Who filed the lead: no member did. */
export const FORM_ACTOR = 'public-form';

/**
 * The lead, its organization and contact, on their own try: the row is the
 * record, and a lead that cannot be filed logs one line and costs nothing
 * else. Only on a D1 workspace: Core takes a lead only from a member.
 */
async function fileFormLead(env: Env, form: FormDefinition, id: string, body: Record<string, unknown>): Promise<void> {
  const who = whoOf(form, body);
  if (form.files === 'none' || form.files === 'thread' || !who.organization || usesCore(env) || !workModelEnabled(env)) return;
  try {
    const organization = await createCrmOrganization(env, FORM_ACTOR, who.organization.slice(0, 200));
    const contact = await d1CreateContact(env, {
      organization_id: organization.id,
      name: who.name.slice(0, 200),
      email: who.email,
      title: who.role?.slice(0, 200) ?? '',
    }, {
      eventType: 'form_submitted', sourceKey: 'website_contact',
      sourceRecordType: 'form_submissions', sourceRecordId: id, dedupeKey: `form_submission:${id}`,
    });
    let leadId: string | null = null;
    if (form.files === 'lead') {
      const lead = await createCrmSubject(env, {
        kind: 'lead',
        title: who.organization.slice(0, 100),
        organization_id: organization.id,
        contact_id: contact.id,
        status: 'Conversations',
        start_date: new Date().toISOString().slice(0, 10),
        notes: formLeadNotes(form, id, body),
      }, FORM_ACTOR);
      leadId = lead.id;
    }
    await env.USAGE.prepare('UPDATE form_submissions SET lead_id = ?1, contact_id = ?2 WHERE id = ?3').bind(leadId, contact.id, id).run();
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'form.lead.failed',
      form: form.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** Every answer as "Question: answer", then the submission id, within the lead's 1000 characters. Exported for tests. */
export function formLeadNotes(form: FormDefinition, id: string, body: Record<string, unknown>): string {
  const lines = formAnswers(form, body).map(({ question, answer }) => `${question}: ${oneLine(answer)}`);
  return [...lines, `${form.title} ${id}.`].join('\n').slice(0, 1000);
}

function whoOf(form: FormDefinition, body: Record<string, unknown>): { organization: string; name: string; email: string; role: string | undefined } {
  const text = (key: string | undefined) => (key && typeof body[key] === 'string' ? oneLine(body[key] as string) : '');
  return {
    organization: text(form.who.organization),
    name: text(form.who.name),
    email: text(form.who.email),
    role: text(form.who.role) || undefined,
  };
}

/** The answers that sort a submission, for its INBOX row: every pick, in the form's order. */
function formSummary(form: FormDefinition, body: Record<string, unknown>): string {
  const picks = new Set(form.questions.filter((question) => question.kind === 'pick' || question.kind === 'picks').map((question) => question.label));
  return formAnswers(form, body).filter(({ question }) => picks.has(question)).map(({ answer }) => answer).join(' · ');
}

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The answers that filed a lead, for the lead's Submission group in Work, or
 * null when no form on this workspace filed it.
 */
export async function formSubmissionForLead(env: Env, leadId: string): Promise<FormSubmission | null> {
  if (usesCore(env)) return null;
  const row = await env.USAGE.prepare(
    'SELECT id, form_id, created_at, body FROM form_submissions WHERE lead_id = ?1 ORDER BY created_at DESC LIMIT 1',
  ).bind(leadId).first<{ id: string; form_id: string; created_at: number; body: string }>();
  if (!row) return null;
  const form = formFor(workspaceSlug(env), row.form_id);
  const body = parseBody(row.body);
  if (!form || !body) return null;
  return {
    id: row.id,
    form: form.id,
    title: form.title,
    submitted_at: new Date(row.created_at).toISOString(),
    sections: [{ title: form.title, answers: formAnswers(form, body) }],
  };
}

/**
 * The last month of submissions as INBOX rows, for the people each form
 * names. A form that names admins shows nothing to a member.
 */
export async function formInboxItems(env: Env, dismissed: Set<string>, { isAdmin }: { isAdmin: boolean }): Promise<InboxItem[]> {
  // A form that files a thread shows as that thread's guest row instead.
  const forms = formsFor(workspaceSlug(env)).filter((form) => form.files !== 'thread' && (isAdmin || form.audience === 'members'));
  if (!forms.length) return [];
  const byId = new Map(forms.map((form) => [form.id, form]));
  const { results } = await env.USAGE.prepare(
    `SELECT s.id, s.form_id, s.created_at, s.name, s.email, s.organization, s.body, l.id AS lead_id, l.title AS lead_title
     FROM form_submissions s LEFT JOIN leads l ON l.id = s.lead_id
     WHERE s.created_at >= ?1 ORDER BY s.created_at DESC LIMIT 200`,
  ).bind(Date.now() - INBOX_INTEREST_WINDOW_MS).all<{
    id: string; form_id: string; created_at: number; name: string; email: string; organization: string; body: string; lead_id: string | null; lead_title: string | null;
  }>();
  const items: InboxItem[] = [];
  for (const row of results) {
    const form = byId.get(row.form_id);
    const key = `submission:${row.id}`;
    if (!form || dismissed.has(key)) continue;
    const body = parseBody(row.body) ?? {};
    const submission: InboxFormSubmission = {
      id: row.id,
      form: form.id,
      title: form.title,
      created_at: new Date(row.created_at).toISOString(),
      name: row.name,
      email: row.email,
      organization: row.organization,
      summary: formSummary(form, body),
      lead: row.lead_id ? { kind: 'lead', id: row.lead_id, title: row.lead_title ?? row.organization } : null,
    };
    items.push({ key, at: row.created_at, source: 'submission', submission });
  }
  return items;
}

/**
 * Each form keeps its submissions for `keepDays` (docs/FORMS.md §Retention).
 * Daily. The lead and contact a submission filed stay: they are the
 * workspace's own records now.
 */
export async function pruneFormSubmissions(env: Env, now: number): Promise<void> {
  for (const form of formsFor(workspaceSlug(env))) {
    await env.USAGE.prepare('DELETE FROM form_submissions WHERE form_id = ?1 AND created_at < ?2')
      .bind(form.id, now - form.keepDays * DAY_MS).run();
  }
}

/** Titles and lines: no newlines, so a value cannot add a row. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
