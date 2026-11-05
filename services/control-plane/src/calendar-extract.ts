// A forwarded mail read once for the events it describes: the
// one model call behind `calendar@`. The runner is the one `notes.ts` uses,
// through the same key; the model is `CALENDAR_EXTRACT_MODEL`, smaller than
// the notes model because a mail is short and the answer is a few fields.
//
// What crosses: the forwarded mail's sender line, subject, date and text
// body, and whatever the member wrote above it. Never the raw `.eml`, never
// an attachment (docs/PRIVACY.md). The text is not kept afterwards: only the
// rows the model returned and the caller accepted survive
// (`pending-calendar-events.ts`).
//
// The answer is a tool call with a schema, and Zod reads it back at the
// boundary. One malformed row drops that row; a malformed envelope drops the
// whole answer. No retry: a mail the model could not read is not an event.

import Anthropic from '@anthropic-ai/sdk';
import { anthropicInputTokens, recordModelUsage } from './model-usage';
import { z } from 'zod';
import { calendarDaySchema } from '@starlings/contracts';
import { PENDING_CALENDAR_EVENT_MIN_CONFIDENCE, PENDING_CALENDAR_EVENTS_PER_MAIL } from '@starlings/contracts/limits';

const DEFAULT_EXTRACT_MODEL = 'claude-sonnet-5';
/** A forwarded mail past this keeps its head: bookings put the itinerary first. */
const BODY_MAX_CHARS = 24_000;
const MAX_OUTPUT_TOKENS = 2_000;
const REQUEST_TIMEOUT_MS = 45_000;

const instantSchema = z.string().datetime({ offset: true });

/** One event as the model states it, before the caller's own checks. */
export const extractedEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  all_day: z.boolean(),
  /** A day for an all-day row, an instant with offset otherwise. */
  start: z.string().trim(),
  end: z.string().trim(),
  time_zone: z.string().trim().min(1).max(64).nullable(),
  location: z.string().trim().max(1024).nullable(),
  notes: z.string().trim().max(4000).nullable(),
  attendees: z.array(z.string().trim().min(1).max(200)).max(50),
  confidence: z.number().min(0).max(1),
}).refine((event) => {
  const isDay = (value: string) => calendarDaySchema.safeParse(value).success;
  if (event.all_day) return isDay(event.start) && isDay(event.end);
  return instantSchema.safeParse(event.start).success && instantSchema.safeParse(event.end).success;
}, { message: 'An all-day row takes days, a timed row takes instants.' }).refine(
  (event) => Date.parse(event.end) > Date.parse(event.start),
  { message: 'end must be after start.' },
);
export type ExtractedEvent = z.infer<typeof extractedEventSchema>;

const answerSchema = z.object({ events: z.array(z.unknown()).max(PENDING_CALENDAR_EVENTS_PER_MAIL * 2) });

/** The JSON Schema the model fills. Mirrors `extractedEventSchema`, stated once for the wire. */
const EVENTS_TOOL: Anthropic.Tool = {
  name: 'propose_events',
  description: 'Report every calendar event the mail describes. Report none when the mail describes no event.',
  input_schema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short, as a calendar shows it: "Flight LIS → AMS TP670", "Dinner with Ana", "Board meeting". Not the mail subject.' },
            all_day: { type: 'boolean', description: 'True when the mail gives a date and no time of day.' },
            start: { type: 'string', description: 'RFC 3339 with the UTC offset (2026-10-03T14:30:00+01:00) for a timed event; YYYY-MM-DD for an all-day one.' },
            end: { type: 'string', description: 'Same form as start. All-day end is the day after the last day. When no end is given: arrival time for travel, otherwise one hour after start.' },
            time_zone: { type: ['string', 'null'], description: 'IANA zone the event happens in, when the mail names a place or zone. Null otherwise.' },
            location: { type: ['string', 'null'], description: 'Venue, address, airport pair, or a video link. Null when none.' },
            notes: { type: ['string', 'null'], description: 'Booking references, seat, gate, dial-in, what to bring. Facts from the mail only.' },
            attendees: { type: 'array', items: { type: 'string' }, description: 'People the mail names as taking part, as written. Not the sender of a confirmation.' },
            confidence: { type: 'number', description: '0 to 1: how sure you are this is a real event with these times.' },
          },
          required: ['title', 'all_day', 'start', 'end', 'time_zone', 'location', 'notes', 'attendees', 'confidence'],
        },
      },
    },
    required: ['events'],
  },
};

const EXTRACT_SYSTEM_PROMPT = `You read one email a person forwarded to their calendar and report the events it describes, so the person can add them with one tap.

Rules:
- One event per thing that happens at a time and place: each flight leg, each night of a stay as one event, each meeting. A return trip is two events.
- Report only what the mail states. Never invent a time, a place or a person. When the year is missing, use the first date on or after the mail's date.
- Times: when the mail gives a time zone or a place, use that zone's offset. Otherwise use the offset in the mail's own Date header. Do not convert times to another zone.
- A mail that describes no event (a newsletter, a receipt with no date, a reply) yields an empty list.
- The forwarder may have written instructions above the mail ("add 30 minutes before", "only the outbound leg", "call it Acme kickoff"). Follow them; they win over the mail.
- Titles in the mail's language. No markdown anywhere.`;

export interface CalendarExtractInput {
  /** The forwarded mail, as `inbound-email.ts` separated it from the forward. */
  from: string | null;
  subject: string | null;
  date: string | null;
  body: string;
  /** What the member wrote above the forwarded block, when anything. */
  instructions: string | null;
  /** The forwarding mail's Date header: the member's own offset, the fallback zone. */
  forwardedAt: string | null;
}

/**
 * The events the model found, or null when the runner is not configured or
 * did not answer. Throws nothing. Rows the schema rejects, rows under the
 * confidence floor and rows past the per-mail cap are dropped, in that order.
 */
export async function extractCalendarEvents(
  env: Partial<Pick<Env, 'ANTHROPIC_API_KEY' | 'CALENDAR_EXTRACT_MODEL' | 'USAGE'>>,
  input: CalendarExtractInput,
): Promise<ExtractedEvent[] | null> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || !input.body.trim()) return null;
  const model = env.CALENDAR_EXTRACT_MODEL?.trim() || DEFAULT_EXTRACT_MODEL;

  const body = input.body.length > BODY_MAX_CHARS
    ? `${input.body.slice(0, BODY_MAX_CHARS)}\n\n[… ${input.body.length - BODY_MAX_CHARS} characters omitted …]`
    : input.body;
  const mail = [
    input.from ? `From: ${input.from}` : null,
    input.subject ? `Subject: ${input.subject}` : null,
    input.date ? `Date: ${input.date}` : null,
    '',
    body,
  ].filter((line) => line !== null).join('\n');
  const content = [
    input.forwardedAt ? `Forwarded on: ${input.forwardedAt}` : null,
    input.instructions ? `Instructions from the person forwarding:\n${input.instructions}` : null,
    `Email:\n${mail}`,
  ].filter((part) => part !== null).join('\n\n');

  const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  try {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [{ type: 'text', text: EXTRACT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [EVENTS_TOOL],
      tool_choice: { type: 'tool', name: EVENTS_TOOL.name },
      messages: [{ role: 'user', content }],
    });
    await recordModelUsage(env, { provider: 'anthropic', model: response.model, purpose: 'calendar-extract', input: anthropicInputTokens(response.usage), output: response.usage.output_tokens });
    if (response.stop_reason === 'refusal') {
      console.warn(JSON.stringify({ level: 'warn', message: 'calendar-extract.refused', category: response.stop_details?.category ?? null }));
      return null;
    }
    const call = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    const events = readEvents(call?.input);
    console.log(JSON.stringify({
      level: 'info',
      message: 'calendar-extract.answered',
      model: response.model,
      inputTokens: response.usage.input_tokens,
      cachedTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
      events: events?.length ?? null,
    }));
    return events;
  } catch (error) {
    const reason = error instanceof Anthropic.AuthenticationError
      ? 'bad key'
      : error instanceof Anthropic.RateLimitError
        ? 'rate limited'
        : error instanceof Anthropic.APIError
          ? `api ${error.status}`
          : error instanceof Error ? error.message : 'unknown';
    console.error(JSON.stringify({ level: 'error', message: 'calendar-extract.failed', model, reason }));
    return null;
  }
}

/** The tool input as rows the store can keep: schema, then confidence floor, then the cap. Pure. */
export function readEvents(input: unknown): ExtractedEvent[] | null {
  const answer = answerSchema.safeParse(input);
  if (!answer.success) return null;
  return answer.data.events
    .map((row) => extractedEventSchema.safeParse(row))
    .filter((row) => row.success)
    .map((row) => row.data)
    .filter((event) => event.confidence >= PENDING_CALENDAR_EVENT_MIN_CONFIDENCE)
    .slice(0, PENDING_CALENDAR_EVENTS_PER_MAIL);
}
