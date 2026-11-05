import { describe, expect, it } from 'vitest';
import { parseFieldNoteFiles } from '../field-notes';

function source(slug: string, overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    title: 'A practical field note',
    description: 'A focused description of a practical question.',
    slug,
    status: 'published',
    locale: 'en',
    published: '2026-10-09',
    updated: '2026-10-09',
    author: 'Envisioning',
    related: '[]',
    ...overrides,
  };
  return {
    fileName: `${slug}.md`,
    text: `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n## A useful section\n\nA short body with a concrete point.\n`,
  };
}

describe('field-note content', () => {
  it('accepts authored metadata and keeps unpublished drafts separate', () => {
    const notes = parseFieldNoteFiles([
      source('published-note'),
      source('working-draft', { status: 'draft' }),
    ]);

    expect(notes.map((note) => note.status)).toEqual(['published', 'draft']);
    expect(notes.filter((note) => note.status === 'published').map((note) => note.slug)).toEqual(['published-note']);
  });

  it('rejects links to missing notes and to drafts from a published note', () => {
    expect(() => parseFieldNoteFiles([source('published-note', { related: '["missing-note"]' })]))
      .toThrow('related field note missing-note does not exist');
    expect(() => parseFieldNoteFiles([
      source('published-note', { related: '["working-draft"]' }),
      source('working-draft', { status: 'draft' }),
    ])).toThrow('published notes cannot link to draft working-draft');
  });

  it('rejects duplicate slugs, locale mismatches and invalid dates', () => {
    const duplicate = source('same-note');
    expect(() => parseFieldNoteFiles([duplicate, duplicate])).toThrow('Duplicate field-note slug: same-note');
    expect(() => parseFieldNoteFiles([source('locale-note', { locale: 'pt-BR' })])).toThrow('locale must be en');
    expect(() => parseFieldNoteFiles([source('date-note', { published: '2026-02-30' })])).toThrow('published must be a real YYYY-MM-DD date');
  });

  it('rejects missing metadata, filename mismatches and malformed related lists', () => {
    const missing = source('missing-description');
    missing.text = missing.text.replace('description: A focused description of a practical question.\n', '');
    expect(() => parseFieldNoteFiles([missing])).toThrow('missing required field description');

    const wrongFile = source('wrong-slug');
    wrongFile.fileName = 'other-slug.md';
    expect(() => parseFieldNoteFiles([wrongFile])).toThrow('slug wrong-slug must match the filename');

    expect(() => parseFieldNoteFiles([source('bad-related', { related: '[unfinished' })]))
      .toThrow('related must be a JSON list or a YAML list');
  });
});
