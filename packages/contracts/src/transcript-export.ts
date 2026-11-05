// A meeting transcript as a file: the `.md` a person downloads,
// the `.txt` they copy, and the link they share. One rule for every client:
// the web formats with this module and the Mac and iOS with its Swift twin
// (`Sources/TranscriptExport.swift`), both pinned to
// `fixtures/transcript-export.json`. Change the fixture first.
//
// Zod-free, so the web's transcript page pays nothing for it.

export const TRANSCRIPT_EXPORT_FORMATS = ['md', 'txt'] as const;
export type TranscriptExportFormat = (typeof TRANSCRIPT_EXPORT_FORMATS)[number];

/** A transcript line as the record carries it (`TranscriptSegment`'s fields). */
export interface TranscriptExportLine {
  id: string;
  speaker_id: string;
  speaker_name: string;
  starts_at_ms: number;
  text: string;
}

export interface TranscriptExportInput {
  /** The meeting's title; a client passes its own word for an untitled one. */
  title: string;
  /** When the meeting started, epoch milliseconds. */
  started_at: number;
  /** IANA zone the date is written in. Absent or unknown: UTC. */
  time_zone?: string | null;
  /** The project, lead or partner the meeting is filed on. */
  subject?: string | null;
  /** Who was there. Empty: the people who spoke, in the order they first spoke. */
  attendees?: readonly string[];
  /** The meeting's page in Meet (`transcriptPermalink`). */
  link?: string | null;
  lines: readonly TranscriptExportLine[];
  /** Lines struck from the record: left out. */
  struck?: readonly string[];
  /** Renamed speakers, by speaker id: the new name wins. */
  renames?: Readonly<Record<string, string>>;
}

/** The word a line falls back to when its speaker has no name. */
const UNNAMED_SPEAKER = 'Speaker';

/** `/meetings/<room>/<meeting id>`: the meeting's page, the one a share link opens. */
export function transcriptPermalinkPath(roomSlug: string, meetingId: string): string {
  return `/meetings/${encodeURIComponent(roomSlug)}/${encodeURIComponent(meetingId)}`;
}

/**
 * The link a share carries. Always the workspace's public origin, never the
 * host the page happens to be served from (invariant 13). It grants nothing:
 * a reader who cannot already read the meeting is refused at the page.
 */
export function transcriptPermalink(origin: string, roomSlug: string, meetingId: string): string {
  return `${origin.replace(/\/+$/u, '')}${transcriptPermalinkPath(roomSlug, meetingId)}`;
}

/** An offset into the meeting, `hh:mm:ss` — the Docs transcript's own spelling. */
export function transcriptClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/** Whitespace runs, newlines included, are one space: a line stays one line. */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** The lines that go out: struck ones left out, renames applied, empty text dropped. */
export function transcriptExportLines(input: Pick<TranscriptExportInput, 'lines' | 'struck' | 'renames'>): TranscriptExportLine[] {
  const struck = new Set(input.struck ?? []);
  const out: TranscriptExportLine[] = [];
  for (const line of input.lines) {
    if (struck.has(line.id)) continue;
    const text = oneLine(line.text);
    if (!text) continue;
    const renamed = oneLine(input.renames?.[line.speaker_id] ?? '');
    const speaker = renamed || oneLine(line.speaker_name) || UNNAMED_SPEAKER;
    out.push({ ...line, speaker_name: speaker, text });
  }
  return out;
}

/** Who the header names: the attendees given, else everyone who spoke. Each once. */
export function transcriptExportAttendees(input: Pick<TranscriptExportInput, 'attendees' | 'lines' | 'struck' | 'renames'>): string[] {
  const given = (input.attendees ?? []).map(oneLine).filter(Boolean);
  const names = given.length ? given : transcriptExportLines(input).map((line) => line.speaker_name);
  return [...new Set(names)];
}

function zoneOrUTC(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** The meeting's start in `zone`: `YYYY-MM-DD` and `HH:mm`, a 24-hour clock. */
function wallClock(startedAt: number, zone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(startedAt));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

/** `2026-09-30 09:00 (UTC)`: the header's date line, zone named so it cannot be misread. */
export function transcriptExportDate(startedAt: number, timeZone?: string | null): string {
  const zone = zoneOrUTC(timeZone);
  const { day, time } = wallClock(startedAt, zone);
  return `${day} ${time} (${zone})`;
}

/** The header's facts, in order, each present only when it has a value. */
function headerFacts(input: TranscriptExportInput): Array<[string, string]> {
  const facts: Array<[string, string]> = [['Date', transcriptExportDate(input.started_at, input.time_zone)]];
  const attendees = transcriptExportAttendees(input);
  if (attendees.length) facts.push(['Attendees', attendees.join(', ')]);
  const subject = oneLine(input.subject ?? '');
  if (subject) facts.push(['Subject', subject]);
  const link = oneLine(input.link ?? '');
  if (link) facts.push(['Link', link]);
  return facts;
}

/**
 * The whole transcript as a file. `md` is the Docs transcript's format —
 * `**Speaker** (hh:mm:ss): text`, one block a line — under a header of the
 * title, date, attendees, subject and link. `txt` is the same facts, one
 * `[hh:mm:ss] Speaker: text` line each, for a clipboard or a plain reader.
 */
export function formatTranscript(input: TranscriptExportInput, format: TranscriptExportFormat): string {
  const title = oneLine(input.title) || 'Meeting';
  const facts = headerFacts(input);
  const lines = transcriptExportLines(input);
  if (format === 'md') {
    const body = lines.length
      ? lines.map((line) => `**${line.speaker_name}** (${transcriptClock(line.starts_at_ms)}): ${line.text}`).join('\n\n')
      : 'No transcript.';
    return `# ${title}\n\n${facts.map(([label, value]) => `- ${label}: ${value}`).join('\n')}\n\n## Transcript\n\n${body}\n`;
  }
  const body = lines.length
    ? lines.map((line) => `[${transcriptClock(line.starts_at_ms)}] ${line.speaker_name}: ${line.text}`).join('\n')
    : 'No transcript.';
  return `${title}\n${facts.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${body}\n`;
}

/** `pilot-kickoff-2026-09-30.md`: the title's slug, the meeting's day, the format. */
export function transcriptFileName(title: string, startedAt: number, timeZone: string | null | undefined, format: TranscriptExportFormat): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '') || 'transcript';
  return `${slug}-${wallClock(startedAt, zoneOrUTC(timeZone)).day}.${format}`;
}
