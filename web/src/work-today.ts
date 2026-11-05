import type { CalendarEventSubject } from '@starlings/contracts';
import { fetchUpcoming, type WebCalendarEvent } from './owner-agenda';
import { formatTime } from './meeting-time';
import { t } from './i18n';

/**
 * Today's meetings about a subject, for Work's Overview: the
 * calendar events on today's civil day that are filed to a project or a
 * lead, in start order. All-day rows are not meetings; an event with no
 * subject belongs to Home, not here. The Mac's and the phone's
 * `WorkTodayMeetings` is the same rule.
 */
export interface TodayMeeting {
  id: string;
  title: string;
  start: Date;
  subject: CalendarEventSubject;
  /** "10:00 · Acme rollout" — the time, then the subject the row opens. */
  detail: string;
}

export function todayMeetings(events: WebCalendarEvent[], now = new Date()): TodayMeeting[] {
  const seen = new Set<string>();
  const rows: TodayMeeting[] = [];
  for (const event of events) {
    if (event.allDay || !event.subject) continue;
    const start = new Date(event.start);
    if (Number.isNaN(start.valueOf()) || !sameDay(start, now)) continue;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const title = event.title.trim() || t('Meeting');
    rows.push({
      id: event.id,
      title,
      start,
      subject: event.subject,
      detail: `${formatTime(start)} · ${event.subject.title}`,
    });
  }
  return rows.sort((a, b) => a.start.valueOf() - b.start.valueOf());
}

/** The same upcoming read Home makes; it covers all of today. */
export async function fetchTodayMeetings(): Promise<TodayMeeting[]> {
  return todayMeetings(await fetchUpcoming());
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
