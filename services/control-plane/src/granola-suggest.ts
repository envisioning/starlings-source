// Suggested filing for an imported Granola note (docs/GRANOLA_BRIDGE.md
// §Suggested filing; JEV (HQ Docs) recommended order 1).
//
// A decision model, not a language model: it answers "which kind, which
// subject" with a probability and generates nothing. The answer is stored in
// D1 and drawn on the Connectors page as a pre-filled control. It is never a
// Core write — filing stays a human act, and the person's choice is recorded
// against the suggestion so the threshold comes from our own hit rate rather
// than the vendor's claims.
//
// Invariants:
//   - Never the sole decider on a Core write. Nothing here calls Core with a kind.
//   - A failure here never fails an import. Every entry point catches and logs.
//   - Off means off: `GRANOLA_SUGGEST_MODE` other than `ai` runs nothing.
//   - The option list is the accuracy lever. The organization's own leads and
//     projects when Core knows the organization; the wide list only otherwise.

import { cachedRead } from './core-cache';
import { fetchCrmSubjects, type CrmLedgerRow } from './crm';
import { meetingKindSchema, type CrmSubject, type GranolaFilingSuggestion, type MeetingKind } from './contracts';
import { domainOf } from './identity';
import { identityDomains } from './workspace-identity';
import { workspaceDefaults } from './workspace-defaults';
import { workspaceDisplayName } from './workspace-profile';
import { estimateTokens, recordModelUsage } from './model-usage';

/** Jev's ceiling on one choice question, less the `none` option. */
const CHOICE_CEILING = 254;
const NOTE_CHARS = 8_000;
const TRANSCRIPT_PREVIEW_CHARS = 2_000;
/** Core's ceiling on one subjects read; the list has no paging. */
const SUBJECT_PAGE = 100;
/** How long the two subject lists serve a whole backlog of suggestions. */
const SUBJECTS_TTL_SECONDS = 300;
/**
 * Below this the suggestion is stored (for calibration) but not drawn. Set
 * from the vendor's own "act above 0.7, ask below" idiom until the
 * `granola_suggestions` table says otherwise.
 */
export const SUGGEST_KIND_THRESHOLD = 0.7;
export const SUGGEST_SUBJECT_THRESHOLD = 0.5;

const KINDS = ['status', 'lead', 'project', 'internal', 'partner', 'event', 'personal'] as const;

/** The kinds, described the way MEETING_LOG.md §Meeting categorization does. */
const KIND_CRITERIA: Record<(typeof KINDS)[number] | 'uncategorized', string> = {
  status: 'A company-wide or general status meeting, usually recurring, about how the team and the business are doing overall',
  lead: 'An external sales or discovery conversation with a prospective client about work Envisioning might do for them',
  project: 'A delivery or working session on a client project that is already under way',
  internal: 'Envisioning-only work on its own product, design, operations, hiring or tooling, with no client in the room',
  partner: 'A relationship meeting with a partner organisation Envisioning works alongside (a network, a school, an agency), not a client buying work',
  event: 'Preparing, running or debriefing a talk, panel, workshop or public event Envisioning takes part in',
  personal: 'Not company business: a personal call, a favour, a conversation with no bearing on Envisioning',
  uncategorized: 'None of the above fits',
};
/** How far from the meeting date an event still counts as a candidate. */
const EVENT_WINDOW_DAYS = 60;

export function granolaSuggestEnabled(env: Env): boolean {
  return String(env.GRANOLA_SUGGEST_MODE) === 'ai'
    && (Boolean(env.AI_GATEWAY_API_KEY?.trim()) || Boolean(env.AI))
    && Boolean(String(env.GRANOLA_SUGGEST_MODEL ?? '').trim());
}

// ------------------------------------------------------------------ the call

interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}
interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence?: number;
}
interface JevOutput {
  model?: string;
  answers?: Record<string, ChoiceAnswer>;
  usage?: { input_tokens?: number };
}

/** Vercel AI Gateway's evaluation door, the shape `@ai-sdk/gateway` speaks (v4 spec). */
const GATEWAY_EVALUATE_URL = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
/** The same model under the two catalogues' names. */
const GATEWAY_MODEL_IDS: Record<string, string> = { 'typesafe/jev': 'typesafe-ai/jev' };
const GATEWAY_TIMEOUT_MS = 20_000;

/**
 * One call, two doors. With `AI_GATEWAY_API_KEY` the questions go to Vercel
 * AI Gateway over plain HTTP — no SDK in the bundle — and are billed there.
 * Without it, the Workers AI binding, whose typed catalogue does not list
 * third-party models, hence the narrow untyped door rather than a blanket
 * cast. Both answer `{ model?, answers, usage? }`.
 */
export async function runJev(env: Env, state: Record<string, unknown>, questions: Record<string, ChoiceQuestion>): Promise<JevOutput> {
  const model = String(env.GRANOLA_SUGGEST_MODEL);
  const gatewayKey = env.AI_GATEWAY_API_KEY?.trim();
  if (gatewayKey) {
    const gatewayModel = GATEWAY_MODEL_IDS[model] ?? model;
    const response = await fetch(GATEWAY_EVALUATE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gatewayKey}`,
        'ai-gateway-protocol-version': '0.0.1',
        'ai-gateway-auth-method': 'api-key',
        'ai-evaluation-model-specification-version': '4',
        'ai-model-id': gatewayModel,
      },
      body: JSON.stringify({ state, questions }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`AI Gateway answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = await response.json() as { answers?: Record<string, ChoiceAnswer>; usage?: { inputTokens?: number } };
    await recordModelUsage(env, {
      provider: 'ai-gateway', model: gatewayModel, purpose: 'granola-suggest',
      input: body.usage?.inputTokens ?? estimateTokens(JSON.stringify({ state, questions })),
      output: estimateTokens(JSON.stringify(body.answers ?? {})),
    });
    return { model: gatewayModel, answers: body.answers ?? {}, ...(body.usage?.inputTokens !== undefined ? { usage: { input_tokens: body.usage.inputTokens } } : {}) };
  }
  const ai = env.AI as unknown as { run: (model: string, input: unknown) => Promise<unknown> };
  const output = await ai.run(model, { state, questions });
  // Workers AI: tokens are an estimate of characters / 4 unless the model reports its input.
  const reported = (output as JevOutput | null)?.usage?.input_tokens;
  await recordModelUsage(env, {
    provider: 'workers-ai', model, purpose: 'granola-suggest',
    input: reported ?? estimateTokens(JSON.stringify({ state, questions })),
    output: estimateTokens(JSON.stringify((output as JevOutput | null)?.answers ?? {})),
  });
  return (output && typeof output === 'object' ? output : {}) as JevOutput;
}

/** One meeting as the model reads it, built from a fresh import or from Core's row alike. */
export interface SuggestState {
  meeting_id: string;
  title: string | null;
  started_at: string;
  participants: Array<{ name: string; email: string | null }>;
  summary_markdown: string | null;
  transcript_text: string;
}

/** What the model reads: title, date, who (name and domain, never an address), notes, the start of the transcript. */
function buildState(payload: SuggestState): Record<string, unknown> {
  return {
    title: payload.title,
    date: payload.started_at.slice(0, 10),
    participants: payload.participants.map((person) => ({ name: person.name, domain: (person.email ? domainOf(person.email) : null) ?? 'unknown' })),
    notes: (payload.summary_markdown ?? '').slice(0, NOTE_CHARS),
    transcript_start: payload.transcript_text.slice(0, TRANSCRIPT_PREVIEW_CHARS),
  };
}

export async function kindQuestion(env: Env): Promise<ChoiceQuestion> {
  const [defaults, name] = await Promise.all([workspaceDefaults(env), workspaceDisplayName(env)]);
  const domains = identityDomains(env);
  return {
    type: 'choice',
    instructions: defaults.ai_filing_persona ?? `Which kind of meeting is this, the way ${name} files it? Judge from who is in the room and what is discussed.${domains.length ? ` ${domains.join(', ')} is ${name} itself.` : ''}`,
    criteria: Object.fromEntries(Object.entries(KIND_CRITERIA).map(([kind, description]) => [kind, description.replaceAll('Envisioning', () => name)])),
  };
}

type SubjectKind = 'lead' | 'project' | 'organization' | 'event';

const SUBJECT_ASK: Record<SubjectKind, { instructions: string; none: string }> = {
  lead: {
    instructions: 'Which prospective client (lead) is this meeting about, if any? Match on the organisation and people in the room, not on similar-sounding names.',
    none: 'This meeting is not about any of the listed leads',
  },
  project: {
    instructions: 'Which client project is this meeting about, if any? Match on the organisation and people in the room, not on similar-sounding names.',
    none: 'This meeting is not about any of the listed projects',
  },
  organization: {
    instructions: 'Which partner organisation is this meeting with, if any? Match on the organisation and people in the room.',
    none: 'This meeting is not with any of the listed partners',
  },
  event: {
    instructions: 'Which event is this meeting about, if any? Match on the event name, its date and the people in the room.',
    none: 'This meeting is not about any of the listed events',
  },
};

function subjectQuestion(kind: SubjectKind, subjects: CrmSubject[]): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const subject of subjects) {
    criteria[subject.id] = subject.subtitle ? `${subject.title} (${subject.subtitle})` : subject.title;
  }
  criteria.none = SUBJECT_ASK[kind].none;
  return { type: 'choice', instructions: SUBJECT_ASK[kind].instructions, criteria };
}

/** The best listed option, unless `none` outranks it. */
function best(answer: ChoiceAnswer | undefined): { id: string; probability: number } | null {
  if (!answer) return null;
  let id = 'none';
  let probability = 0;
  for (const [option, p] of Object.entries(answer.probabilities)) {
    if (option === 'none') continue;
    if (p > probability) { id = option; probability = p; }
  }
  const none = answer.probabilities.none ?? 0;
  return id !== 'none' && probability >= none ? { id, probability } : null;
}

/**
 * The subjects to offer. Scoped to the organization Core linked the note to
 * when it has any; the newest hundred of every status otherwise, which is
 * what a person sees in the picker too.
 */
interface SubjectOptions {
  leads: CrmSubject[];
  projects: CrmSubject[];
  partners: CrmSubject[];
  events: CrmSubject[];
  scoped: boolean;
}

async function subjectOptions(env: Env, organizationId: string | null, meetingDate: string): Promise<SubjectOptions> {
  // A few Core reads a minute across the whole queue, not four per note: a
  // backlog of hundreds asked for the same lists hundreds of times.
  const [leads, projects, partners, events] = await Promise.all([
    cachedRead('subjects/all/lead', () => fetchCrmSubjects(env, 'lead', '', 'all', SUBJECT_PAGE), { ttlSeconds: SUBJECTS_TTL_SECONDS }),
    cachedRead('subjects/all/project', () => fetchCrmSubjects(env, 'project', '', 'all', SUBJECT_PAGE), { ttlSeconds: SUBJECTS_TTL_SECONDS }),
    cachedRead('subjects/all/partner', () => fetchCrmSubjects(env, 'organization', '', undefined, SUBJECT_PAGE), { ttlSeconds: SUBJECTS_TTL_SECONDS }),
    cachedRead('subjects/all/event', () => fetchCrmSubjects(env, 'event', '', 'all', SUBJECT_PAGE), { ttlSeconds: SUBJECTS_TTL_SECONDS }),
  ]);
  // An event is a candidate only near the meeting's date: a talk two years
  // away is noise, and the ceiling is better spent on the ones that fit.
  const at = Date.parse(meetingDate);
  const nearEvents = events.subjects.filter((event) => {
    const date = eventDate(event);
    return date === null || Math.abs(date - at) <= EVENT_WINDOW_DAYS * 86_400_000;
  });
  if (organizationId) {
    const ownLeads = leads.subjects.filter((subject) => subject.organization_id === organizationId);
    const ownProjects = projects.subjects.filter((subject) => subject.organization_id === organizationId);
    const ownPartner = partners.subjects.filter((subject) => subject.id === organizationId);
    if (ownLeads.length || ownProjects.length || ownPartner.length) {
      return { leads: ownLeads, projects: ownProjects, partners: ownPartner, events: nearEvents.slice(0, CHOICE_CEILING), scoped: true };
    }
  }
  return {
    leads: leads.subjects.slice(0, CHOICE_CEILING),
    projects: projects.subjects.slice(0, CHOICE_CEILING),
    partners: partners.subjects.slice(0, CHOICE_CEILING),
    events: nearEvents.slice(0, CHOICE_CEILING),
    scoped: false,
  };
}

/** The event's day from its subtitle (`YYYY-MM-DD …`), the way Core spells it; null when undated. */
function eventDate(event: CrmSubject): number | null {
  const match = event.subtitle?.match(/\d{4}-\d{2}-\d{2}/u);
  if (!match) return null;
  const parsed = Date.parse(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

// --------------------------------------------------------------------- store

interface SuggestionRow {
  note_id: string;
  model: string;
  meeting_kind: string;
  kind_probability: number;
  subject_kind: string | null;
  subject_id: string | null;
  subject_title: string | null;
  subject_probability: number | null;
  outcome: string | null;
  organization_id: string | null;
}

/**
 * Ask once per unfiled note and keep the answer. Called from the ingest job
 * after Core has the row, so the organization edge Core drew is available.
 * Idempotent on the note: a second read (a `note.edited` webhook) does not
 * ask again unless the first answer is missing.
 */
export async function suggestGranolaFiling(env: Env, payload: SuggestState, ledger: CrmLedgerRow | undefined): Promise<void> {
  if (!granolaSuggestEnabled(env)) return;
  const noteId = payload.meeting_id;
  try {
    const kind = ledger?.meeting_kind ? meetingKindSchema.catch('uncategorized').parse(ledger.meeting_kind) : 'uncategorized';
    if (kind !== 'uncategorized') return;
    const existing = await env.USAGE.prepare('SELECT note_id FROM granola_suggestions WHERE note_id = ?1').bind(noteId).first();
    if (existing) return;

    const options = await subjectOptions(env, ledger?.organization_id ?? null, payload.started_at);
    const questions: Record<string, ChoiceQuestion> = { kind: await kindQuestion(env) };
    if (options.leads.length) questions.lead = subjectQuestion('lead', options.leads);
    if (options.projects.length) questions.project = subjectQuestion('project', options.projects);
    if (options.partners.length) questions.organization = subjectQuestion('organization', options.partners);
    if (options.events.length) questions.event = subjectQuestion('event', options.events);

    const output = await runJev(env, buildState(payload), questions);
    const answers = output.answers ?? {};
    const kindAnswer = answers.kind;
    if (!kindAnswer || typeof kindAnswer.choice !== 'string') throw new Error('no kind answer');
    const suggestedKind = meetingKindSchema.catch('uncategorized').parse(kindAnswer.choice);
    const kindProbability = kindAnswer.probabilities?.[kindAnswer.choice] ?? 0;

    // The meeting kind `partner` files on the organization subject (ADR 0006).
    const subjectKind: SubjectKind | null = suggestedKind === 'partner' ? 'organization'
      : suggestedKind === 'lead' || suggestedKind === 'project' || suggestedKind === 'event' ? suggestedKind
        : null;
    const pick = subjectKind ? best(answers[subjectKind]) : null;
    const listed = subjectKind === 'lead' ? options.leads
      : subjectKind === 'project' ? options.projects
        : subjectKind === 'organization' ? options.partners
          : options.events;
    const subject = pick ? listed.find((candidate) => candidate.id === pick.id) ?? null : null;

    await env.USAGE.prepare(
      `INSERT INTO granola_suggestions
         (note_id, model, meeting_kind, kind_probability, subject_kind, subject_id, subject_title, subject_probability, options, scoped, suggested_at, organization_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(note_id) DO NOTHING`,
    ).bind(
      noteId,
      output.model ?? String(env.GRANOLA_SUGGEST_MODEL),
      suggestedKind,
      kindProbability,
      subject ? subjectKind : null,
      subject?.id ?? null,
      subject?.title ?? null,
      subject ? pick!.probability : null,
      options.leads.length + options.projects.length + options.partners.length + options.events.length,
      options.scoped ? 1 : 0,
      Date.now(),
      ledger?.organization_id ?? null,
    ).run();

    console.log(JSON.stringify({
      level: 'info',
      message: 'granola.suggest.stored',
      noteId,
      model: output.model ?? null,
      kind: suggestedKind,
      kindProbability: Number(kindProbability.toFixed(3)),
      subject: subject ? subjectKind : null,
      options: options.leads.length + options.projects.length + options.partners.length + options.events.length,
      scoped: options.scoped,
      inputTokens: output.usage?.input_tokens ?? null,
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'granola.suggest.failed',
      noteId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** The suggestions the list draws, keyed by note. Only undecided rows above threshold. */
export async function readGranolaSuggestions(env: Env): Promise<Map<string, GranolaFilingSuggestion>> {
  const out = new Map<string, GranolaFilingSuggestion>();
  try {
    const { results } = await env.USAGE.prepare(
      `SELECT note_id, model, meeting_kind, kind_probability, subject_kind, subject_id, subject_title, subject_probability, outcome, organization_id
       FROM granola_suggestions WHERE outcome IS NULL AND kind_probability >= ?1`,
    ).bind(SUGGEST_KIND_THRESHOLD).all<SuggestionRow>();
    for (const row of results) {
      const kind: MeetingKind = meetingKindSchema.catch('uncategorized').parse(row.meeting_kind);
      if (kind === 'uncategorized') continue;
      const hasSubject = row.subject_id !== null && (row.subject_probability ?? 0) >= SUGGEST_SUBJECT_THRESHOLD;
      out.set(row.note_id, {
        meeting_kind: kind,
        probability: row.kind_probability,
        lead_id: hasSubject && row.subject_kind === 'lead' ? row.subject_id : null,
        project_id: hasSubject && row.subject_kind === 'project' ? row.subject_id : null,
        event_id: hasSubject && row.subject_kind === 'event' ? row.subject_id : null,
        partner_organization_id: hasSubject && row.subject_kind === 'organization' ? row.subject_id : null,
        subject_title: hasSubject ? row.subject_title : null,
        subject_probability: hasSubject ? row.subject_probability : null,
        organization_id: row.organization_id,
      });
    }
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'granola.suggest.read.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  return out;
}

/**
 * What the person did with it. Written on every filing, whether or not the
 * suggestion was drawn: a below-threshold answer that turns out right is
 * exactly the number that moves the threshold.
 */
export async function recordGranolaFilingOutcome(
  env: Env,
  noteId: string,
  filed: { meetingKind: MeetingKind; leadId: string | null; projectId: string | null; eventId?: string | null; partnerOrganizationId?: string | null },
): Promise<void> {
  try {
    const row = await env.USAGE.prepare(
      'SELECT meeting_kind, subject_id FROM granola_suggestions WHERE note_id = ?1',
    ).bind(noteId).first<{ meeting_kind: string; subject_id: string | null }>();
    if (!row) return;
    if (filed.meetingKind === 'uncategorized') return;
    const filedSubject = filed.meetingKind === 'lead' ? filed.leadId
      : filed.meetingKind === 'project' ? filed.projectId
        : filed.meetingKind === 'event' ? filed.eventId ?? null
          : filed.meetingKind === 'partner' ? filed.partnerOrganizationId ?? null
            : null;
    const accepted = row.meeting_kind === filed.meetingKind && (row.subject_id ?? null) === filedSubject;
    await env.USAGE.prepare(
      `UPDATE granola_suggestions SET outcome = ?2, filed_kind = ?3, filed_subject_id = ?4, decided_at = ?5 WHERE note_id = ?1`,
    ).bind(noteId, accepted ? 'accepted' : 'corrected', filed.meetingKind, filedSubject, Date.now()).run();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'granola.suggest.outcome.failed',
      noteId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** Every note that already has an answer, decided or not. */
export async function suggestedNoteIds(env: Env): Promise<Set<string>> {
  try {
    const { results } = await env.USAGE.prepare('SELECT note_id FROM granola_suggestions').all<{ note_id: string }>();
    return new Set(results.map((row) => row.note_id));
  } catch {
    return new Set();
  }
}

/** The calibration counts for the Connectors card. */
export async function granolaSuggestionCounts(env: Env): Promise<{ accepted: number; corrected: number }> {
  try {
    const { results } = await env.USAGE.prepare(
      `SELECT outcome, COUNT(*) AS n FROM granola_suggestions WHERE outcome IS NOT NULL GROUP BY outcome`,
    ).all<{ outcome: string; n: number }>();
    const counts = { accepted: 0, corrected: 0 };
    for (const row of results) {
      if (row.outcome === 'accepted') counts.accepted = row.n;
      else if (row.outcome === 'corrected') counts.corrected = row.n;
    }
    return counts;
  } catch {
    return { accepted: 0, corrected: 0 };
  }
}
