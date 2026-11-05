import { describe, expect, it } from 'vitest';
import docsSlug from '../../fixtures/docs-slug.json';
import mentionMatching from '../../fixtures/mention-matching.json';
import participantInitialsFixture from '../../fixtures/participant-initials.json';
import subjectQuery from '../../fixtures/subject-query.json';
import contactQuery from '../../fixtures/contact-query.json';
import surfaceVisibility from '../../fixtures/surface-visibility.json';
import threadMarkdown from '../../fixtures/thread-markdown.json';
import transcriptExport from '../../fixtures/transcript-export.json';
import {
  formatTranscript,
  transcriptClock,
  transcriptExportAttendees,
  transcriptFileName,
  transcriptPermalink,
  type TranscriptExportInput,
} from '@starlings/contracts/transcript-export';
import { visibleSurfaces } from '@starlings/contracts/surface-visibility';
import { subjectsSearchParams, type OrganizationListFilter, type SubjectKind } from './crm-work';
import { contactListSearchParams, type ContactListFilter } from './contacts';
import { slugify, subjectFolderPath } from './docs';
import { parseMarkdown, type Block } from './markdown-parse';
import { participantInitials } from './MeetParticipantTile';
import { mentionsIn } from './mentions';

/*
 * Small rules the Mac, iOS and web each write for themselves, and the
 * cases that make them one rule (meet#596, #1065). `Tests/RuleFixtureTests.swift` runs
 * the same files. A failure here is a question about the fixture first: the
 * cases are the rule, and both implementations answer to them.
 * `docs/agents/areas/registries.md`, "Rules with cases".
 */

describe('Docs folder slug', () => {
  it('has cases', () => {
    expect(docsSlug.version).toBe(1);
    expect(docsSlug.cases.length).toBeGreaterThan(10);
  });

  it.each(docsSlug.cases)('$name', ({ title, slug }) => {
    expect(slugify(title)).toBe(slug);
  });

  it.each(docsSlug.folders)('folder: $name', ({ kind, title, path }) => {
    expect(subjectFolderPath(kind, title)).toBe(path);
  });
});

describe('Participant initials', () => {
  it('has cases', () => {
    expect(participantInitialsFixture.version).toBe(1);
    expect(participantInitialsFixture.cases.length).toBeGreaterThan(10);
  });

  it.each(participantInitialsFixture.cases)('$name', ({ in: name, out }) => {
    expect(participantInitials(name)).toBe(out);
  });
});

/** A block the way the fixture writes it: the marks that are on, the level / number / text only where the kind has one. */
function written(block: Block) {
  if (block.kind === 'code') return { kind: 'code', text: block.text };
  const spans = block.spans.map((span) => ({
    text: span.text,
    ...(span.bold ? { bold: true } : {}),
    ...(span.italic ? { italic: true } : {}),
    ...(span.strike ? { strike: true } : {}),
    ...(span.code ? { code: true } : {}),
    ...(span.link ? { link: span.link } : {}),
    // A message has no images, wikilinks or footnotes: those belong to the document grammar.
    ...(span.image || span.wikilink || span.footnote || span.internal ? { unexpected: true } : {}),
  }));
  if (block.kind === 'heading' || block.kind === 'bullet') return { kind: block.kind, level: block.level, spans };
  if (block.kind === 'ordered') return { kind: 'ordered', level: block.level, number: block.index, spans };
  return { kind: block.kind, spans };
}

describe('Thread markdown', () => {
  it('has cases', () => {
    expect(threadMarkdown.version).toBe(1);
    expect(threadMarkdown.cases.length).toBeGreaterThan(40);
  });

  it.each(threadMarkdown.cases)('$name', ({ in: text, out }) => {
    expect(parseMarkdown(text).map(written)).toEqual(out);
  });
});

describe('Subject page query', () => {
  it('has cases', () => {
    expect(subjectQuery.version).toBe(1);
    expect(subjectQuery.cases.length).toBeGreaterThan(10);
  });

  it.each(subjectQuery.cases)('$name', (row) => {
    const { kind, query, status, today, out } = row;
    const organizations = 'organizations' in row ? row.organizations as OrganizationListFilter : undefined;
    const search = subjectsSearchParams(kind as SubjectKind, query, status, today, organizations);
    expect([...search.entries()]).toEqual(out);
  });
});

describe('Contact list query (meet#1213)', () => {
  it('has shared cases', () => {
    expect(contactQuery.version).toBe(1);
    expect(contactQuery.cases.length).toBeGreaterThan(3);
  });

  it.each(contactQuery.cases)('$name', ({ query, filter, out }) => {
    expect([...contactListSearchParams(query, filter as ContactListFilter).entries()]).toEqual(out);
  });
});

describe('Mention recipients', () => {
  it('has shared boundary and address cases', () => {
    expect(mentionMatching.version).toBe(1);
    expect(mentionMatching.cases.length).toBeGreaterThan(5);
  });

  it.each(mentionMatching.cases)('$name', ({ text, candidates, mentions }) => {
    expect(mentionsIn(text, candidates.map((email) => ({ email })))).toEqual(mentions);
  });
});

/*
 * A transcript as a file and as a link (meet#692): struck lines out, renamed
 * speakers in, the same header on every client. `Tests/RuleFixtureTests.swift`
 * holds `TranscriptExport` to the same cases.
 */
describe('Transcript export', () => {
  it('has cases', () => {
    expect(transcriptExport.version).toBe(1);
    expect(transcriptExport.cases.length).toBeGreaterThan(10);
  });

  it.each(transcriptExport.permalinks)('link: $name', ({ origin, room, meeting_id, out }) => {
    expect(transcriptPermalink(origin, room, meeting_id)).toBe(out);
  });

  it.each(transcriptExport.clocks)('clock: $ms', ({ ms, out }) => {
    expect(transcriptClock(ms)).toBe(out);
  });

  it.each(transcriptExport.file_names)('file name: $name', ({ title, started_at, time_zone, format, out }) => {
    expect(transcriptFileName(title, started_at, time_zone, format as 'md' | 'txt')).toBe(out);
  });

  it.each(transcriptExport.cases)('$name', ({ input, attendees, md, txt }) => {
    const value = input as unknown as TranscriptExportInput;
    expect(transcriptExportAttendees(value)).toEqual(attendees);
    expect(formatTranscript(value, 'md')).toBe(md);
    expect(formatTranscript(value, 'txt')).toBe(txt);
  });
});

describe('Member surface visibility', () => {
  it('has cases', () => {
    expect(surfaceVisibility.version).toBe(1);
    expect(surfaceVisibility.cases.length).toBeGreaterThan(5);
  });

  it.each(surfaceVisibility.cases)('$name', ({ calendarSources, docs, visible }) => {
    expect(visibleSurfaces({ calendarSources, docs })).toEqual(visible);
  });
});
