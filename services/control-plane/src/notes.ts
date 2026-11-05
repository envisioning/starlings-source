// The notes engine: the one model call that turns a transcript into the note
// a person reads instead of the transcript ( claim 2, slice 3 of
// docs/AMBIENT_CAPTURE.md).
//
// Two engines behind one function. Claude, when `ANTHROPIC_API_KEY` is set,
// writes the note in the shape Granola and Blaise proved: action items first
// and named, decisions in their own section, then the summary, in the
// meeting's own language. Workers AI is the fallback — the small model that
// wrote every note before this, kept so a missing key or a Claude outage
// still leaves a note rather than none.
//
// What crosses: transcript text, the roster's names, the date. Never audio,
// never an email address (docs/PRIVACY.md). The transcript already leaves the
// device to this Worker for every meeting, so this is the same boundary.

import Anthropic from '@anthropic-ai/sdk';
import { anthropicInputTokens, recordModelUsage } from './model-usage';
import { z } from 'zod';
import { meetingFollowUpDraftSchema, type MeetingActionItem, type MeetingDecisionCandidate, type MeetingFollowUpDraft } from '@starlings/contracts';

export type NotesEngine = 'claude' | 'workers-ai' | 'off';

/** What the account is configured to write notes with, for Admin › Configured. */
export interface NotesEngineState {
  engine: NotesEngine;
  model: string;
}

const DEFAULT_NOTES_MODEL = 'claude-sonnet-5';
/** Characters of transcript, not tokens: ~80k chars is ~20k tokens, well inside the window. */
const TRANSCRIPT_MAX_CHARS = 200_000;
const MAX_OUTPUT_TOKENS = 4_000;
const REQUEST_TIMEOUT_MS = 90_000;

export function notesEngineState(
  env: Pick<Env, 'SUMMARY_MODE' | 'SUMMARY_MODEL'> & Partial<Pick<Env, 'NOTES_MODEL' | 'ANTHROPIC_API_KEY'>>,
): NotesEngineState {
  if (String(env.SUMMARY_MODE) !== 'ai') return { engine: 'off', model: '' };
  if (env.ANTHROPIC_API_KEY?.trim()) return { engine: 'claude', model: notesModel(env) };
  return { engine: 'workers-ai', model: String(env.SUMMARY_MODEL ?? '') };
}

function notesModel(env: Partial<Pick<Env, 'NOTES_MODEL'>>): string {
  return env.NOTES_MODEL?.trim() || DEFAULT_NOTES_MODEL;
}

/**
 * The note's shape, stated once. The first line is the title the artifact
 * pipeline already parses (`titledSummary`); the sections are the ones
 * `SECTION_NAMES` knows, action items first because that is what a person
 * opens the note for.
 */
const NOTES_SYSTEM_PROMPT = `You write the notes for a meeting from its transcript. The person reading them was in the meeting and will not re-read the transcript, so the notes must carry everything that matters and nothing that does not.

Output, in this order and nothing else:

Title: <what the meeting was about, in a few words — not "Meeting summary", not a section name, no markdown>

## Action items
- One line each: **who** — what, by when if said. Only commitments that were actually made, with the owner named as the transcript names them. If nobody was named, write "unassigned". If there are none, write "None."

## Decisions
- One line each: what was decided, and the reason if one was given. If none, write "None."

## Summary
Three to eight short paragraphs or bullets: what was discussed, the positions people took, the numbers and names that came up, where it landed. Specific over general. Quote a phrase when the wording itself matters, in its original language.

## Open questions
- Anything raised and not resolved. If none, write "None."

Rules:
- Write in the meeting's dominant language (English, Portuguese, or German). Keep quoted phrases in the language they were said in.
- Never invent a fact, a number, a name, an owner, or a deadline. If the transcript is unclear, say what is unclear rather than guessing.
- Speaker labels in the transcript are names or, when unknown, "Speaker". Never turn "Speaker" into a name.
- No preamble, no sign-off, no commentary about the transcript's quality.

Answer through the write_notes tool: the whole note as notes_markdown, the same action items once more as action_items, one entry per line of the Action items section, in the same order, with the line of the transcript each one comes from, and the same decisions once more as decisions, one entry per line of the Decisions section, with the line each was settled in. A decision is something the group settled, stated as a fact; a question, an option still open, or a hedge is not one.

When the context lists outside attendees, also write follow_up: the short email the host sends them after the call. In the meeting's language, in the host's voice, addressed to the outside attendees by first name. Say what was agreed, who does what by when, and the next step, in under 1,200 characters. A summary only: never quote the transcript, never mention that the call was transcribed, no internal remarks, no sign-off name. A subject line under 100 characters. When the context lists no outside attendees, follow_up is null.`;

/**
 * The note and its action items in one answer: the commitments
 * become `proposed` tasks on the subject, from the same judgment that wrote
 * them into the note, not a second reading.
 */
const NOTES_TOOL: Anthropic.Tool = {
  name: 'write_notes',
  description: 'The notes for the meeting, and the action items as data.',
  input_schema: {
    type: 'object',
    properties: {
      notes_markdown: { type: 'string', description: 'The whole note, exactly as specified: the Title line, then the four sections.' },
      action_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            what: { type: 'string', description: 'The commitment as a task title: imperative, specific, under 120 characters, in the meeting\'s language.' },
            who: { type: ['string', 'null'], description: 'The owner as the transcript names them, or null when nobody was named. Never "Speaker".' },
            by_when: { type: ['string', 'null'], description: 'The deadline as said ("Friday", "before the board meeting"), or null.' },
            quote: { type: ['string', 'null'], description: 'The transcript line the commitment was made in, verbatim, one line only.' },
            at_ms: { type: ['integer', 'null'], description: 'That line\'s offset in milliseconds, from the [mm:ss] mark on it, or null.' },
          },
          required: ['what', 'who', 'by_when', 'quote', 'at_ms'],
        },
      },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            what: { type: 'string', description: 'The decision as a statement, under 200 characters, in the meeting\'s language, with the reason if one was given.' },
            quote: { type: ['string', 'null'], description: 'The transcript line it was settled in, verbatim, one line only.' },
            at_ms: { type: ['integer', 'null'], description: 'That line\'s offset in milliseconds, from the [mm:ss] mark on it, or null.' },
          },
          required: ['what', 'quote', 'at_ms'],
        },
      },
      follow_up: {
        type: ['object', 'null'],
        description: 'The email to the outside attendees, or null when the context lists none.',
        properties: {
          subject: { type: 'string', description: 'The subject line, under 100 characters.' },
          body: { type: 'string', description: 'The body: what was agreed, who does what by when, the next step. Under 1,200 characters.' },
        },
        required: ['subject', 'body'],
      },
    },
    required: ['notes_markdown', 'action_items', 'decisions', 'follow_up'],
  },
};

const actionItemSchema = z.object({
  what: z.string().trim().min(1).max(200),
  who: z.string().trim().min(1).max(120).nullable(),
  by_when: z.string().trim().min(1).max(120).nullable(),
  quote: z.string().trim().min(1).max(1000).nullable(),
  at_ms: z.number().int().min(0).nullable(),
});
const decisionCandidateSchema = z.object({
  what: z.string().trim().min(1).max(400),
  quote: z.string().trim().min(1).max(1000).nullable(),
  at_ms: z.number().int().min(0).nullable(),
});
const notesAnswerSchema = z.object({
  notes_markdown: z.string().trim().min(1),
  action_items: z.array(z.unknown()).max(60),
  /** Absent from a model answer that predates: no candidates, not no answer. */
  decisions: z.array(z.unknown()).max(40).optional(),
  /** The follow-up; null or absent when there was nobody outside. */
  follow_up: z.unknown().optional(),
});

export interface NotesAnswer {
  text: string;
  actionItems: MeetingActionItem[];
  decisionCandidates: MeetingDecisionCandidate[];
  /** Null when nobody outside attended, or the draft did not hold its shape. */
  followUp: MeetingFollowUpDraft | null;
}

/** The tool input as a note and rows; malformed rows drop, a malformed envelope is no answer. */
export function readNotesAnswer(input: unknown): NotesAnswer | null {
  const answer = notesAnswerSchema.safeParse(input);
  if (!answer.success) return null;
  const actionItems = answer.data.action_items
    .map((row) => actionItemSchema.safeParse(row))
    .filter((row) => row.success)
    .map((row) => ({ ...row.data, who: row.data.who && /^speaker$/iu.test(row.data.who) ? null : row.data.who, task_id: null }));
  const decisionCandidates = (answer.data.decisions ?? [])
    .map((row) => decisionCandidateSchema.safeParse(row))
    .filter((row) => row.success)
    .map((row) => ({ ...row.data, decision_id: null, dismissed: false }));
  // A draft past its caps or missing a part is no draft: the host writes their own.
  const followUp = meetingFollowUpDraftSchema.safeParse(answer.data.follow_up ?? null);
  return { text: answer.data.notes_markdown, actionItems, decisionCandidates, followUp: followUp.success ? followUp.data : null };
}

/**
 * One meeting's note from Claude, or null when Claude is not configured or
 * did not answer — the caller falls back. Throws nothing: a notes failure
 * must never hold the artifact.
 */
export async function claudeNotes(
  env: Partial<Pick<Env, 'ANTHROPIC_API_KEY' | 'NOTES_MODEL' | 'USAGE'>>,
  input: {
    meetingId: string;
    startedAt: number;
    title: string | null;
    participants: string[];
    /** People from outside the workspace, by name: when any, the answer carries a follow-up. */
    outsideAttendees?: string[];
    transcript: Array<{ speaker_name: string; text: string; starts_at_ms: number }>;
  },
): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number; actionItems: MeetingActionItem[]; decisionCandidates: MeetingDecisionCandidate[]; followUp: MeetingFollowUpDraft | null } | null> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || input.transcript.length === 0) return null;
  const model = notesModel(env);

  // Each line carries its offset, so an action item can point back at it.
  const lines = input.transcript.map((segment) => `[${clock(segment.starts_at_ms)}] ${segment.speaker_name.trim() || 'Speaker'}: ${segment.text.trim()}`);
  let transcript = lines.join('\n');
  // A transcript past the ceiling keeps its head and tail: the opening says
  // what the meeting is for and the close is where the commitments are.
  if (transcript.length > TRANSCRIPT_MAX_CHARS) {
    const half = Math.floor(TRANSCRIPT_MAX_CHARS / 2);
    transcript = `${transcript.slice(0, half)}\n\n[… ${transcript.length - TRANSCRIPT_MAX_CHARS} characters omitted …]\n\n${transcript.slice(-half)}`;
  }

  const context = [
    `Date: ${new Date(input.startedAt).toISOString().slice(0, 10)}`,
    input.title ? `Calendar title: ${input.title}` : null,
    input.participants.length ? `Participants: ${input.participants.join(', ')}` : null,
    input.outsideAttendees?.length ? `Outside attendees: ${input.outsideAttendees.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  try {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // The prompt is the stable prefix; the transcript varies every call.
      system: [{ type: 'text', text: NOTES_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [NOTES_TOOL],
      tool_choice: { type: 'tool', name: NOTES_TOOL.name },
      messages: [{ role: 'user', content: `${context}\n\nTranscript:\n${transcript}` }],
      output_config: { effort: 'medium' },
    });
    if (response.stop_reason === 'refusal') {
      console.warn(JSON.stringify({ level: 'warn', message: 'notes.claude.refused', meetingId: input.meetingId, category: response.stop_details?.category ?? null }));
      return null;
    }
    await recordModelUsage(env, { provider: 'anthropic', model: response.model, purpose: 'notes', input: anthropicInputTokens(response.usage), output: response.usage.output_tokens });
    const call = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    const answer = readNotesAnswer(call?.input);
    if (!answer) return null;
    const { text, actionItems, decisionCandidates } = answer;
    // Nobody outside, no follow-up, whatever the model wrote.
    const followUp = input.outsideAttendees?.length ? answer.followUp : null;
    console.log(JSON.stringify({
      level: 'info',
      message: 'notes.claude.written',
      meetingId: input.meetingId,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      cachedTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason,
    }));
    return { text, model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, actionItems, decisionCandidates, followUp };
  } catch (error) {
    // Most specific first; the fallback is the same either way, the log says why.
    const reason = error instanceof Anthropic.AuthenticationError
      ? 'bad key'
      : error instanceof Anthropic.RateLimitError
        ? 'rate limited'
        : error instanceof Anthropic.APIError
          ? `api ${error.status}`
          : error instanceof Error ? error.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', message: 'notes.claude.failed', meetingId: input.meetingId, model, reason }));
    return null;
  }
}

/** `[mm:ss]` or `[h:mm:ss]`, the mark the prompt tells the model to read `at_ms` from. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The Workers AI fallback writes the same sections without a tool: its
 * Action items lines become rows the same way, without quotes or offsets.
 * "- **who** — what, by when" as the prompt asks; anything else on a line
 * is the whole line as the title.
 */
export function parseActionItems(markdown: string): MeetingActionItem[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s*(action items|ações|aktionspunkte|próximos passos)\s*$/iu.test(line.trim()));
  if (start === -1) return [];
  const items: MeetingActionItem[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^#{1,6}\s/u.test(line)) break;
    if (!/^[-*]\s+/u.test(line)) continue;
    const body = line.replace(/^[-*]\s+/u, '').trim();
    if (/^(none|nenhum|nenhuma|keine)\.?$/iu.test(body)) continue;
    const owned = /^\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/u.exec(body);
    const who = owned ? owned[1]!.trim() : null;
    const rest = (owned ? owned[2]! : body).trim();
    const when = /^(.*?),\s*(by|until|before|até|bis)\s+(.+)$/iu.exec(rest);
    items.push({
      what: (when ? when[1]! : rest).replace(/\.$/u, '').slice(0, 200),
      who: who && !/^(unassigned|speaker)$/iu.test(who) ? who : null,
      by_when: when ? `${when[2]} ${when[3]}`.slice(0, 120) : null,
      quote: null,
      at_ms: null,
      task_id: null,
    });
  }
  return items;
}
