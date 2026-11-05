// Quick add on the Worker: the grammar first, the notes engine
// only when the grammar read no date or two times. The sentence is the only
// thing sent to the model (docs/PRIVACY.md), through the same tool call
// `calendar@` uses for a forwarded mail. What comes back is one draft in
// the caller's local wall time, the same shape the grammar answers with.

import type { CalendarQuickAddResponse } from '@starlings/contracts';
import { parseQuickAdd, QUICK_ADD_EMPTY_TITLE } from '@starlings/contracts/quick-add';
import { extractCalendarEvents } from './calendar-extract';

export async function quickAddDraft(
  env: Env,
  input: { sentence: string; now: string; timeZone: string; defaultDurationMinutes: number; allowModel: boolean },
): Promise<CalendarQuickAddResponse> {
  const draft = parseQuickAdd(input.sentence, { now: input.now, defaultDurationMinutes: input.defaultDurationMinutes });
  const grammar: CalendarQuickAddResponse = { draft: wire(draft), source: 'grammar' };
  if (draft.confidence > 0 || !input.allowModel) return grammar;

  const events = await extractCalendarEvents(env, {
    from: null,
    subject: null,
    date: null,
    body: input.sentence,
    instructions: null,
    forwardedAt: `${input.now} (${input.timeZone})`,
  });
  const first = events?.[0];
  if (!first) return grammar;
  const start = first.all_day ? first.start : localWallTime(first.start, input.timeZone);
  const end = first.all_day ? first.end : localWallTime(first.end, input.timeZone);
  if (!start || !end) return grammar;
  return {
    draft: {
      title: first.title || QUICK_ADD_EMPTY_TITLE,
      start,
      end,
      all_day: first.all_day,
      location: first.location,
      invitees: first.attendees,
      confidence: first.confidence,
    },
    source: 'model',
  };
}

function wire(draft: ReturnType<typeof parseQuickAdd>): CalendarQuickAddResponse['draft'] {
  return {
    title: draft.title,
    start: draft.start,
    end: draft.end,
    all_day: draft.allDay,
    location: draft.location,
    invitees: draft.invitees,
    confidence: draft.confidence,
  };
}

/** An instant as `YYYY-MM-DDTHH:MM` on the wall clock of `timeZone`; null when it does not parse. */
export function localWallTime(instant: string, timeZone: string): string | null {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  } catch {
    return null;
  }
}
