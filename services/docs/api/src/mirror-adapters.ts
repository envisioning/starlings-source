import { ORG_WWW_ORIGIN, SIGNALS_ORIGIN } from '../../../../packages/contracts/src/deployment-values';
// Core's markdown surfaces, and how each becomes a Docs document.
//
// Core keeps finished writing in a dozen tables with a dozen different column
// names: `newsletter_issue.body`, `report.content`, `signals_briefs
// .description_markdown`, `faq.answer` (an array), `research` spread over five
// prose columns. None of that shape should leak into Docs — so the whole
// mapping lives in ADAPTERS, and adding a new surface is one entry. Core's
// `notes` are not here: they are adopted as native documents rather than
// mirrored (`src/adopt-notes.ts`), because once a note is in Docs it is Docs'
// own and no sweep may overwrite it.
//
// Dependency-free on purpose: the Worker's hourly sweep and the by-hand
// script (`scripts/mirror-core.ts`) both import this, and only this.

/**
 * Envisioning runs two Supabase projects. The published writing lives in CMS;
 * CRM holds notes and the sales record. Getting this wrong is a 404 on the
 * table, not a silent mismatch, but it still has to be declared per surface.
 */
export type Project = 'cms' | 'crm';

export interface Adapter {
  project: Project;
  /** Core table, read through PostgREST. */
  table: string;
  /** Columns to select — narrow, because some of these rows are large. */
  select: string;
  /** Only mirror rows matching this PostgREST filter. */
  filter?: string;
  /** Public URL for the row, so Docs can link back to the source of truth. */
  url?: (row: Row) => string | undefined;
  title: (row: Row) => string;
  body: (row: Row) => string;
  slug?: (row: Row) => string | undefined;
  tags?: (row: Row) => string[];
  updatedAt?: (row: Row) => string | undefined;
}

export type Row = Record<string, any>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Join the prose columns that make up one conceptual document. */
function sections(...parts: Array<[string, unknown]>): string {
  return parts
    .filter(([, value]) => text(value).trim())
    .map(([heading, value]) => (heading ? `## ${heading}\n\n${text(value).trim()}` : text(value).trim()))
    .join('\n\n');
}

export const ADAPTERS: Record<string, Adapter> = {
  newsletter_issue: {
    project: 'cms',
    table: 'newsletter_issue',
    select: 'id,title,subtitle,slug,body,edition_number,status,published_at,updated_at,meta_description',
    title: (row) => `${row.title}${row.edition_number ? ` (#${row.edition_number})` : ''}`,
    body: (row) => sections(['', row.subtitle ? `*${row.subtitle}*` : ''], ['', row.body]),
    slug: (row) => row.slug ?? undefined,
    url: (row) => (row.slug ? `${ORG_WWW_ORIGIN}/newsletter/${row.slug}` : undefined),
    tags: (row) => ['newsletter', row.status].filter(Boolean),
    updatedAt: (row) => row.updated_at ?? row.published_at ?? undefined,
  },

  report: {
    project: 'cms',
    table: 'report',
    select: 'id,title,slug,summary,author,content,category,published_at,publish',
    title: (row) => row.title,
    body: (row) => sections(['', row.summary], ['', row.content]),
    slug: (row) => row.slug ?? undefined,
    url: (row) => (row.slug ? `${ORG_WWW_ORIGIN}/reports/${row.slug}` : undefined),
    tags: (row) => ['report', row.category].filter(Boolean),
    updatedAt: (row) => row.published_at ?? undefined,
  },

  research: {
    project: 'cms',
    table: 'research',
    select:
      'id,title,slug,subtitle,summary,welcome,about,content_before_image,content_after_image,collection,published,launched',
    filter: 'published=eq.true',
    title: (row) => row.title,
    // Five prose columns become one readable document with headings.
    body: (row) =>
      sections(
        ['', row.subtitle ? `*${row.subtitle}*` : ''],
        ['Summary', row.summary],
        ['Welcome', row.welcome],
        ['About', row.about],
        ['', row.content_before_image],
        ['', row.content_after_image],
      ),
    slug: (row) => row.slug ?? undefined,
    url: (row) => (row.slug ? `${ORG_WWW_ORIGIN}/research/${row.slug}` : undefined),
    tags: (row) => ['research', row.collection].filter(Boolean),
  },

  methodology: {
    project: 'cms',
    table: 'methodology',
    select: 'id,slug,title,chapter_order,content,published',
    filter: 'published=eq.true',
    title: (row) => row.title,
    body: (row) => text(row.content),
    slug: (row) => row.slug ?? undefined,
    url: (row) => (row.slug ? `${ORG_WWW_ORIGIN}/methodology/${row.slug}` : undefined),
    tags: () => ['methodology'],
  },

  work: {
    project: 'cms',
    table: 'work',
    select: 'id,title,slug,headline,subtitle,summary,content,bullets,year,published,published_at',
    filter: 'published=eq.true',
    title: (row) => row.title,
    body: (row) =>
      sections(
        ['', row.headline],
        ['', row.subtitle ? `*${row.subtitle}*` : ''],
        ['Summary', row.summary],
        ['', row.content],
        ['Deliverables', row.bullets],
      ),
    slug: (row) => row.slug ?? undefined,
    url: (row) => (row.slug ? `${ORG_WWW_ORIGIN}/work/${row.slug}` : undefined),
    tags: (row) => ['work', row.year].filter(Boolean),
    updatedAt: (row) => row.published_at ?? undefined,
  },

  signals_brief: {
    project: 'cms',
    table: 'signals_briefs',
    select: 'id,title,slug,summary,description_markdown,status,published_at,topic_tags,primary_scan_type',
    title: (row) => row.title,
    body: (row) => sections(['', row.summary], ['', row.description_markdown]),
    slug: (row) => row.slug ?? undefined,
    url: (row) => (row.slug ? `${SIGNALS_ORIGIN}/briefs/${row.slug}` : undefined),
    tags: (row) => ['signals-brief', row.primary_scan_type, ...(row.topic_tags ?? [])].filter(Boolean),
    updatedAt: (row) => row.published_at ?? undefined,
  },

  faq: {
    project: 'cms',
    table: 'faq',
    select: 'id,category,question,answer,tags',
    title: (row) => row.question,
    // `answer` is a text[] of paragraphs.
    body: (row) => (Array.isArray(row.answer) ? row.answer.filter(Boolean).join('\n\n') : text(row.answer)),
    tags: (row) => ['faq', row.category, ...(row.tags ?? [])].filter(Boolean),
  },

};


/** PostgREST pages at 1000 rows by default; walk with Range headers. */
export async function readAll(baseURL: string, key: string, adapter: Adapter): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 500;

  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`${baseURL.replace(/\/$/u, '')}/rest/v1/${adapter.table}`);
    url.searchParams.set('select', adapter.select);
    if (adapter.filter) {
      const [column, value] = adapter.filter.split('=');
      if (column && value) url.searchParams.set(column, value);
    }

    const response = await fetch(url, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        range: `${offset}-${offset + pageSize - 1}`,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Supabase read failed for ${adapter.table}: ${response.status} ${await response.text()}`);
    }
    const page = (await response.json()) as Row[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return rows;
}

/** The ingest documents for one surface's rows. Empty bodies are not documents. */
export function mirrorDocuments(surface: string, adapter: Adapter, rows: Row[]) {
  return rows
    .map((row) => ({
      source_kind: surface,
      source_id: String(row.id),
      title: adapter.title(row).slice(0, 500) || 'Untitled',
      body_md: adapter.body(row),
      ...(adapter.slug?.(row) ? { slug: adapter.slug(row) } : {}),
      ...(adapter.url?.(row) ? { source_url: adapter.url(row) } : {}),
      tags: (adapter.tags?.(row) ?? []).map((tag) => String(tag).toLowerCase()).slice(0, 64),
      ...(adapter.updatedAt?.(row) ? { updated_at: adapter.updatedAt(row) } : {}),
      frontmatter: { source: `core/${adapter.table}`, source_id: String(row.id) },
    }))
    .filter((document) => document.body_md.trim().length > 0);
}
