import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export type FieldNote = {
  title: string;
  description: string;
  slug: string;
  status: 'draft' | 'published';
  locale: 'en';
  published: string;
  updated: string;
  author: string;
  related: string[];
  body: string;
};

type SourceFile = { fileName: string; text: string };

const CONTENT_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'content', 'field-notes');
const FIELD_NOTE_FIELDS = new Set(['title', 'description', 'slug', 'status', 'locale', 'published', 'updated', 'author', 'related']);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function parseScalar(raw: string, field: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
    } catch {
      const items = inner.split(',').map((item) => item.trim());
      if (items.every(Boolean)) return items.map((item) => {
        if (!item.startsWith('"')) return item;
        const parsed: unknown = JSON.parse(item);
        if (typeof parsed !== 'string') throw new Error(`${field} must be a list of strings`);
        return parsed;
      });
    }
    throw new Error(`${field} must be a list of strings`);
  }
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // The error below names the field and source file.
    }
    throw new Error(`${field} must be a quoted string`);
  }
  return value;
}

function readFieldNote(file: SourceFile): FieldNote {
  const fail = (message: string): never => { throw new Error(`${file.fileName}: ${message}`); };
  if (!file.fileName.endsWith('.md') || path.basename(file.fileName) !== file.fileName) fail('content files must be Markdown files directly inside field-notes/');
  if (!file.text.startsWith('---\n')) fail('frontmatter must start with ---');
  const close = file.text.indexOf('\n---\n', 4);
  if (close < 0) fail('frontmatter never closes');

  const fields: Record<string, string | string[]> = {};
  const lines = file.text.slice(4, close).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const match = /^([a-z][a-z0-9_-]*):(?:\s*(.*))?$/u.exec(line);
    if (!match) fail(`cannot read frontmatter line: ${line}`);
    const key = match![1]!;
    if (!FIELD_NOTE_FIELDS.has(key)) fail(`unknown frontmatter field ${key}`);
    if (Object.hasOwn(fields, key)) fail(`frontmatter field ${key} appears more than once`);
    const raw = match![2] ?? '';
    if (raw === '') {
      const values: string[] = [];
      while (index + 1 < lines.length && /^\s+-\s+/u.test(lines[index + 1]!)) {
        index += 1;
        values.push(String(parseScalar(lines[index]!.replace(/^\s+-\s+/u, ''), key)));
      }
      fields[key] = values;
    } else {
      try {
        fields[key] = parseScalar(raw, key);
      } catch (error) {
        fail(error instanceof Error ? error.message : `cannot read ${key}`);
      }
    }
  }

  for (const key of FIELD_NOTE_FIELDS) if (!Object.hasOwn(fields, key)) fail(`missing required field ${key}`);
  for (const key of ['title', 'description', 'slug', 'status', 'locale', 'published', 'updated', 'author']) {
    if (typeof fields[key] !== 'string' || !fields[key]!.trim()) fail(`${key} must be a non-empty string`);
  }
  if (!Array.isArray(fields.related)) fail('related must be a JSON list or a YAML list (use [] when there are no related notes)');
  const title = fields.title as string;
  const description = fields.description as string;
  const slug = fields.slug as string;
  const status = fields.status as string;
  const locale = fields.locale as string;
  const published = fields.published as string;
  const updated = fields.updated as string;
  const author = fields.author as string;
  const related = fields.related as string[];
  const body = file.text.slice(close + 5).trim();

  if (!SLUG.test(slug)) fail('slug must use lowercase words separated by hyphens');
  if (path.basename(file.fileName, '.md') !== slug) fail(`slug ${slug} must match the filename`);
  if (status !== 'draft' && status !== 'published') fail('status must be draft or published');
  if (locale !== 'en') fail('field notes are English-only while site localization is paused (locale must be en)');
  for (const [name, date] of [['published', published], ['updated', updated]] as const) {
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail(`${name} must be a real YYYY-MM-DD date`);
  }
  if (updated < published) fail('updated cannot be earlier than published');
  if (related.some((item) => typeof item !== 'string' || !SLUG.test(item))) fail('related entries must be field-note slugs');
  if (new Set(related).size !== related.length) fail('related cannot list a note more than once');
  if (related.includes(slug)) fail('a note cannot link to itself as related');
  if (!body) fail('Markdown body is required');

  return { title, description, slug, status: status as FieldNote['status'], locale: 'en', published, updated, author, related, body };
}

/** Parse and validate all sources together so cross-links and duplicate slugs fail at build time. */
export function parseFieldNoteFiles(files: SourceFile[]): FieldNote[] {
  const notes = files.map(readFieldNote);
  const bySlug = new Map<string, FieldNote>();
  for (const note of notes) {
    if (bySlug.has(note.slug)) throw new Error(`Duplicate field-note slug: ${note.slug}`);
    bySlug.set(note.slug, note);
  }
  for (const note of notes) for (const slug of note.related) {
    const related = bySlug.get(slug);
    if (!related) throw new Error(`${note.slug}: related field note ${slug} does not exist`);
    if (note.status === 'published' && related.status !== 'published') throw new Error(`${note.slug}: published notes cannot link to draft ${slug}`);
  }
  return notes.sort((left, right) => right.published.localeCompare(left.published) || left.title.localeCompare(right.title));
}

/**
 * The body of a note's markdown twin. An agent can hold the .md without the
 * page, so root-relative links become absolute, and the byline, dates and
 * related notes the page draws come along as text.
 */
export function fieldNoteMarkdown(note: FieldNote, notes: FieldNote[], origin: string): string {
  const body = note.body.replace(/\]\(\/(?!\/)/gu, `](${origin}/`);
  const byline = `By ${note.author}. Published ${note.published}${note.updated === note.published ? '' : `, updated ${note.updated}`}.`;
  const related = note.related.map((slug) => notes.find((entry) => entry.slug === slug)!)
    .map((entry) => `- [${entry.title}](${origin}/field-notes/${entry.slug}): ${entry.description}`);
  return [byline, '', body, ...(related.length ? ['', '## Related field notes', '', ...related] : [])].join('\n');
}

export function loadFieldNotes(directory = CONTENT_DIRECTORY): FieldNote[] {
  const files = readdirSync(directory).filter((name) => name.endsWith('.md')).sort()
    .map((fileName) => ({ fileName, text: readFileSync(path.join(directory, fileName), 'utf8') }));
  return parseFieldNoteFiles(files);
}

export const fieldNotes = loadFieldNotes();
export const publishedFieldNotes = fieldNotes.filter((note) => note.status === 'published');

const VIRTUAL_ID = 'virtual:meet-field-notes';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** Expose published articles to the browser bundle; draft source never enters public assets. */
export function fieldNotesPlugin(): Plugin {
  return {
    name: 'meet-field-notes',
    resolveId(id) { if (id === VIRTUAL_ID) return RESOLVED_ID; },
    load(id) {
      if (id !== RESOLVED_ID) return;
      const published = loadFieldNotes().filter((note) => note.status === 'published');
      return `export const fieldNotes = ${JSON.stringify(published)};\n`;
    },
  };
}
