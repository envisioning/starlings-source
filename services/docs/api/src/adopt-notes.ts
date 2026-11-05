// Core's `notes`, turned into native Docs documents — on every sweep.
//
// Notes are not a mirror surface and never will be. A mirrored row is
// overwritten from Core each hour; a note becomes *ours* the moment it lands
// — editable here, filed under the subject it is about, with the subject link
// as a real relation. `adopt()` enforces that: a row that is already editable
// comes back `unchanged` and is not touched, so nothing written in Docs can
// ever be flattened by Core's older body.
//
// It used to run once, by hand (`scripts/adopt-core-notes.ts`), which left
// Docs holding whatever existed on the day it ran. The drift was small when
// it was found — three notes — but the size is luck, not design: a one-shot
// import reports success forever, so nothing would have said otherwise at
// three hundred. Adoption belongs on the same hourly clock as everything
// else: new notes arrive, adopted ones are left alone.
//
// The mapping is here rather than in the script so the two cannot drift; the
// script now imports it. Dependency-free for the same reason
// `mirror-adapters.ts` is: a Node script and a Worker both read this file, so
// nothing Worker-typed may be reached from it. The sweep half lives in
// `mirror.ts`, next to `adopt()`.

export type Row = Record<string, any>;

/** The five link columns on `notes`, and what each one names. */
export const NOTE_LINKS: ReadonlyArray<{ column: string; kind: string; table: string; label: string }> = [
  { column: 'linked_org_id', kind: 'organization', table: 'organizations', label: 'name' },
  { column: 'linked_contact_id', kind: 'contact', table: 'contacts', label: 'name' },
  { column: 'linked_offer_id', kind: 'offer', table: 'offers', label: 'title' },
  { column: 'linked_lead_id', kind: 'lead', table: 'leads', label: 'title' },
  { column: 'linked_project_id', kind: 'project', table: 'projects', label: 'title' },
];

export const NOTE_SELECT = `id,title,content_md,created_at,updated_at,${NOTE_LINKS.map((link) => link.column).join(',')}`;

export interface AdoptableNote {
  source_kind: 'note';
  source_id: string;
  title: string;
  body_md: string;
  folder_path: string;
  subjects: Array<{ kind: string; subject_id: string }>;
  tags: string[];
  created_at?: string;
  updated_at?: string;
}

/**
 * Notes → adoptable documents. Pure, so the shape can be tested without a
 * Supabase. `labels` maps `<kind>:<id>` to the linked row's name, which is
 * only used to pick the folder — the subjects carry the relation.
 */
export function noteDocuments(notes: Row[], labels: Map<string, string>): AdoptableNote[] {
  return notes
    .filter((note) => String(note.content_md ?? '').trim().length > 0)
    .map((note) => {
      const subjects = NOTE_LINKS.flatMap((link) =>
        note[link.column] ? [{ kind: link.kind, subject_id: String(note[link.column]) }] : [],
      );
      // Filed under the first subject that has a name. The relation carries
      // the rest; the folder is only where the file sits.
      const home = subjects.find((subject) => labels.get(`${subject.kind}:${subject.subject_id}`)?.trim());
      const folder_path = home
        ? `/work/${home.kind}/${slugify(labels.get(`${home.kind}:${home.subject_id}`)!)}`
        : '/notes';
      return {
        source_kind: 'note' as const,
        source_id: String(note.id),
        title: String(note.title ?? '').trim().slice(0, 500) || 'Untitled note',
        body_md: String(note.content_md),
        folder_path,
        subjects,
        tags: ['crm-note'],
        ...(note.created_at ? { created_at: String(note.created_at) } : {}),
        ...(note.updated_at ? { updated_at: String(note.updated_at) } : {}),
      };
    });
}

/** Same rule as the Worker's own `slugify`, kept in step deliberately. */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120);
  return slug || 'untitled';
}

/** One PostgREST table, every page of it. */
export async function readTable(baseURL: string, key: string, table: string, select: string): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`${baseURL.replace(/\/$/u, '')}/rest/v1/${table}`);
    url.searchParams.set('select', select);
    const response = await fetch(url, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        range: `${offset}-${offset + pageSize - 1}`,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Supabase read failed for ${table}: ${response.status} ${await response.text()}`);
    }
    const page = (await response.json()) as Row[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

/** Every linked row's name, for the folder each note is filed under. */
export async function readLabels(baseURL: string, key: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const link of NOTE_LINKS) {
    const rows = await readTable(baseURL, key, link.table, `id,${link.label}`);
    for (const row of rows) labels.set(`${link.kind}:${row.id}`, String(row[link.label] ?? ''));
  }
  return labels;
}
