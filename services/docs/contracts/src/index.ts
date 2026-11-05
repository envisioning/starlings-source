// The wire contract between the Worker, the browser SPA, `docsctl`, and any
// agent. Everything crossing the network is described here once: the Worker
// parses with these schemas, the clients type against these interfaces.
//
// Rule of thumb borrowed from Meet: `code` is the contract clients branch on;
// `error` is prose for people and may be reworded freely.

import { IDENTITY_DOMAINS, ORG_WWW_ORIGIN } from '../../../../packages/contracts/src/deployment-values';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const DOCS_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'gone',
  'rate_limited',
  'not_configured',
  'oauth_failed',
  'read_only',
  'hash_mismatch',
  'internal',
] as const;

export type DocsErrorCode = (typeof DOCS_ERROR_CODES)[number];

export interface DocsErrorBody {
  error: string;
  code: DocsErrorCode;
  request_id?: string;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const JSON_BODY_MAX_BYTES = 4 * 1024 * 1024;
/** A single markdown document. Generous: research notes run long. */
export const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
/** One uploaded PDF. Larger files should be linked, not stored inline. */
export const PDF_MAX_BYTES = 32 * 1024 * 1024;
/** A link save's cover image, copied from the page's og:image into R2. */
export const LINK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * One image a person attaches (a screenshot). Clients shrink and convert
 * before upload — HEIC to JPEG, the long edge to 2560 px — since the Worker
 * has no image service to do it.
 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGES_PER_DOCUMENT_MAX = 40;
export const ANNOTATION_MAX_BYTES = 16 * 1024;
/** Documents accepted in one `POST /api/sync/push` batch. */
export const SYNC_BATCH_MAX = 100;
/** Total document and folder targets accepted in one favorite resolution request. */
export const FAVORITE_RESOLVE_BATCH_MAX = 100;

// ---------------------------------------------------------------------------
// Path grammar
// ---------------------------------------------------------------------------

/**
 * A slug segment: lowercase, url-safe, no leading/trailing dash.
 * Obsidian titles get normalized into this on import; the original stays in
 * `title` and in frontmatter, so nothing is lost.
 */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** '/', or '/a', '/a/b' — leading slash, no trailing slash, max depth 12. */
export const PATH_RE = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$/;

export const MAX_PATH_DEPTH = 12;

export const slugSchema = z.string().min(1).max(120).regex(SLUG_RE, 'Not a valid slug.');

export const pathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(PATH_RE, 'Not a valid path.')
  .refine((value) => segments(value).length <= MAX_PATH_DEPTH, 'Path is nested too deeply.');

export function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function joinPath(parent: string, slug: string): string {
  return parent === '/' ? `/${slug}` : `${parent}/${slug}`;
}

export function parentPath(path: string): string {
  const parts = segments(path);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '/';
}

/**
 * Turn arbitrary human text into a slug segment. Deterministic, so re-running
 * an import maps the same note onto the same path instead of duplicating it.
 */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120)
    .replace(/-+$/u, '');
  return slug || 'untitled';
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const documentKindSchema = z.enum(['markdown', 'pdf']);
export const visibilitySchema = z.enum(['internal', 'link', 'public']);
export const documentStatusSchema = z.enum(['active', 'archived', 'deleted']);
export const sourceSystemSchema = z.enum(['native', 'core', 'obsidian']);
/**
 * `?source=core,obsidian` — one system, or a comma list meaning any of them.
 * A rail's LIBRARY half is every system that is not `native`, in one request.
 */
export const sourceListSchema = z
  .string()
  .transform((raw) => raw.split(',').map((part) => part.trim()).filter(Boolean))
  .pipe(z.array(sourceSystemSchema).min(1).max(3));
export const actorKindSchema = z.enum(['staff', 'guest', 'agent', 'system']);
export const grantRoleSchema = z.enum(['viewer', 'commenter', 'signer']);

export type DocumentKind = z.infer<typeof documentKindSchema>;
export type Visibility = z.infer<typeof visibilitySchema>;

/**
 * The email-gated reader on the public site. www resolves the id through
 * Docs' internal route, so this is the Docs id, and it answers only while the
 * document is `link` or `public`. One place for the URL shape; the Swift
 * mirror is `DocsShareLink.www` in core-kit.
 */
export function wwwShareURL(documentId: string): string {
  return `${ORG_WWW_ORIGIN}/private/docs/${documentId}`;
}

export function isShared(visibility: Visibility): boolean {
  return visibility === 'link' || visibility === 'public';
}
export type SourceSystem = z.infer<typeof sourceSystemSchema>;
export type GrantRole = z.infer<typeof grantRoleSchema>;

/**
 * Every markdown-bearing surface we mirror. Adding a new one is a line here,
 * an adapter entry in the Worker, and nothing else — that is the whole point
 * of keeping mirrored documents in the same table as native ones.
 */
export const SOURCE_KINDS = [
  'note',
  'newsletter_issue',
  'report',
  'research',
  'methodology',
  'work',
  'signals_brief',
  'faq',
  'vault',
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * `source_kind` values on native rows. Not a mirror surface, so not in
 * `SOURCE_KINDS`: ingest must never write one, and there is no mirror folder.
 * `link` is a link save — a row a person made by
 * dropping a URL. It is the marker, not a category.
 */
export const NATIVE_SOURCE_KINDS = ['link'] as const;
export type NativeSourceKind = (typeof NATIVE_SOURCE_KINDS)[number];
export const LINK_SOURCE_KIND: NativeSourceKind = 'link';
/** Where a save lands when the person names no folder. */
export const LINK_FOLDER = '/work/links';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * What a document *is* — the axis the sidebar's smart views are made of.
 * Data, not code (migration 0008): a workspace starts with none, and its
 * people add, rename, reorder and delete their own. A category is picked,
 * never typed into a document, so "Proposals" stays one row. Free-form tags
 * remain for everything else. `kind` is the format (markdown | pdf); this is
 * not.
 *
 * `id` is a slug fixed at creation; a rename changes `label` only, so
 * `?category=<id>` survives it. Deleting one leaves its documents
 * uncategorized.
 */
export const categoryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/u, 'A category id is a lower-case slug.');
export type DocumentCategory = string;
/** @deprecated The name 0003 gave it; the id of a `categories` row. */
export const categorySchema = categoryIdSchema;

export interface Category {
  id: string;
  label: string;
  position: number;
  /** Active documents in it that the reader can see. */
  count: number;
}

/** `POST /api/categories`. `id` defaults to the slug of `label`. */
export const categoryCreateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  id: categoryIdSchema.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

/** `PATCH /api/categories/:id`: rename or move. The id never changes. */
export const categoryUpdateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});

/** `PUT /api/categories/order`: every id, in the order the rail shows them. */
export const categoryOrderSchema = z.object({
  ids: z.array(categoryIdSchema).max(500),
});

/**
 * The marker that keeps a document staff-only (AGENTS.md, "A transcript is
 * never shared"). Not a category: it lives in `documents.category`, which
 * 0003's CHECK still guards, and a person cannot rename or delete it.
 * Sending `category: 'transcript'` on a write still sets it, so an older
 * caller keeps filing transcripts as internal.
 */
export const TRANSCRIPT_MARKER = 'transcript';

/**
 * Where a mirrored Core surface goes, *if* the workspace has a category with
 * that id. Only Envisioning's deployment mirrors Core; a missing category
 * means the mirror files the document without one.
 */
export const MIRROR_CATEGORIES: Partial<Record<SourceKind, string>> = {
  newsletter_issue: 'newsletter',
  report: 'report',
  research: 'research',
  methodology: 'methodology',
  signals_brief: 'brief',
  faq: 'faq',
  note: 'note',
};

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/**
 * What a document is *about*, as opposed to where it lives. A proposal sits at
 * `/work/organization/acme/proposal` because that is a sensible shelf, but the
 * thing every surface asks is "all documents about Acme" — and that survives
 * the document being moved. Kinds are the CRM registry's entity kinds; the
 * `system` column exists so a second registry can join later without a
 * migration.
 */
export const SUBJECT_KINDS = ['organization', 'contact', 'offer', 'lead', 'project'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const subjectSchema = z.object({
  system: z.literal('core').default('core'),
  kind: z.enum(SUBJECT_KINDS),
  subject_id: z.string().min(1).max(200),
});
export type DocumentSubject = z.infer<typeof subjectSchema>;

export const subjectsSchema = z.array(subjectSchema).max(32);

/** `core:organization:<id>` — the one-string form used in query strings. */
export const subjectRefSchema = z
  .string()
  .regex(/^[a-z]+:[a-z]+:[^:]+$/u, 'Expected system:kind:id')
  .transform((value) => {
    const [system, kind, ...rest] = value.split(':');
    return subjectSchema.parse({ system, kind, subject_id: rest.join(':') });
  });

export function subjectRef(subject: DocumentSubject): string {
  return `${subject.system}:${subject.kind}:${subject.subject_id}`;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface StaffSession {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export interface GuestSession {
  grantId: string;
  email: string;
  name?: string;
  role: GrantRole;
  documentId: string | null;
  folderId: string | null;
  verified: boolean;
}

export interface AgentSession {
  tokenId: string;
  owner: string;
  agentName: string | null;
  scopes: string[];
  pathPrefix: string | null;
}

export type Principal =
  | { kind: 'staff'; staff: StaffSession }
  | { kind: 'guest'; guest: GuestSession }
  | { kind: 'agent'; agent: AgentSession };

export const AGENT_SCOPES = [
  'docs:read',
  'docs:write',
  'folders:write',
  'annotations:read',
  'annotations:write',
  'grants:write',
  'sign:manage',
  'sync:write',
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

/**
 * What each scope lets a token do, in the words a person choosing one needs.
 * A scope list is the only thing standing between "an agent that files
 * research notes" and "an agent that can rewrite the company", so the UI has
 * to say what it is handing over.
 */
export const AGENT_SCOPE_DESCRIPTIONS: Record<AgentScope, string> = {
  'docs:read': 'Read documents and search.',
  'docs:write': 'Create, edit and move documents.',
  'folders:write': 'Create and rename folders.',
  'annotations:read': 'Read comments and highlights.',
  'annotations:write': 'Leave comments and highlights.',
  'grants:write': 'Create and revoke share links.',
  'sign:manage': 'Send documents for signature.',
  'sync:write': 'Bulk import and mirror whole trees.',
};

/** A token as its owner sees it. The secret itself is returned once, on create. */
export interface TokenSummary {
  id: string;
  name: string;
  /** The first characters of the secret — enough to recognize, useless alone. */
  prefix: string;
  owner: string;
  scopes: AgentScope[];
  agent_name: string | null;
  path_prefix: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * How Meet gets a token for an owner's device. The Meet Worker has already
 * proven the owner (Google, an identity domain), so Docs only re-checks the
 * domain and mints — the same shape as Core's `meet-owner-exchange`.
 */
export const meetExchangeSchema = z.object({
  email: z.string().email().max(200),
  device_name: z.string().min(1).max(120),
});

export interface MeetExchangeResponse {
  token: string;
  scopes: AgentScope[];
  expires_at: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface FolderSummary {
  id: string;
  path: string;
  slug: string;
  title: string;
  parent_id: string | null;
  depth: number;
  icon: string | null;
  description: string | null;
  source_key: string | null;
  document_count?: number;
}

/** Resolve stable Core favorite refs to current Docs display rows and doors. */
export const favoriteResolveSchema = z
  .object({
    documents: z.array(z.string().uuid()).max(FAVORITE_RESOLVE_BATCH_MAX).default([]),
    folders: z.array(z.string().uuid()).max(FAVORITE_RESOLVE_BATCH_MAX).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.documents.length + value.folders.length > FAVORITE_RESOLVE_BATCH_MAX) {
      context.addIssue({
        code: 'custom',
        message: `At most ${FAVORITE_RESOLVE_BATCH_MAX} targets may be resolved at once.`,
      });
    }
  })
  .transform((value) => ({
    documents: [...new Set(value.documents.map((id) => id.toLowerCase()))],
    folders: [...new Set(value.folders.map((id) => id.toLowerCase()))],
  }));

export type FavoriteResolveInput = z.input<typeof favoriteResolveSchema>;

export interface ResolvedFavoriteDocument {
  kind: 'docs.document';
  target_ref: string;
  title: string;
  path: string;
  document_kind: DocumentKind;
  destination: string;
}

export interface ResolvedFavoriteFolder {
  kind: 'docs.folder';
  target_ref: string;
  title: string;
  path: string;
  parent_id: string | null;
  document_count: number;
  destination: string;
}

export interface FavoriteResolveResponse {
  documents: ResolvedFavoriteDocument[];
  folders: ResolvedFavoriteFolder[];
}

// ---------------------------------------------------------------------------
// Link saves
// ---------------------------------------------------------------------------

export const linkFetchStatusSchema = z.enum(['ok', 'failed', 'skipped']);
export type LinkFetchStatus = z.infer<typeof linkFetchStatusSchema>;

/**
 * What the page said about itself, on a document whose `source_kind` is
 * `link`. `has_image` means `GET /api/docs/:id/link-image` answers: the cover
 * the caller uploaded, a copy in R2, never the site's URL.
 */
export interface LinkSave {
  url: string;
  canonical_url: string;
  site_name: string | null;
  description: string | null;
  has_image: boolean;
  /** Images the person attached (`DocumentImage`), not the page's own. */
  image_count: number;
  /** The first of them: a card's cover when the page gave no image. */
  first_image_id: string | null;
  fetch_status: LinkFetchStatus;
  fetch_error: string | null;
  fetched_at: string | null;
}

export const linkURLSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => /^https?:\/\//iu.test(value), 'Only http and https links can be saved.');

/**
 * What the caller read about a page, sent with a save or with `PUT
 * /api/docs/:id/link`. Docs never fetches a URL (
 * decision 13): Meet's Worker reads the page (`link-preview.ts`) and says
 * what it found. `canonical_url` is the dedupe key; absent, the URL is.
 */
export const linkMetadataSchema = z.object({
  canonical_url: linkURLSchema.optional(),
  site_name: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  fetch_status: linkFetchStatusSchema.default('ok'),
  fetch_error: z.string().trim().max(500).nullable().optional(),
});
export type LinkMetadata = z.infer<typeof linkMetadataSchema>;

export interface DocumentSummary {
  id: string;
  path: string;
  slug: string;
  title: string;
  kind: DocumentKind;
  folder_id: string | null;
  visibility: Visibility;
  /**
   * Readable by its author only: a link save no subject files yet
   *. Filing it, a grant, or visibility `link` / `public` clears it.
   */
  private: boolean;
  status: z.infer<typeof documentStatusSchema>;
  source_system: SourceSystem;
  source_kind: SourceKind | NativeSourceKind | null;
  source_url: string | null;
  editable: boolean;
  version: number;
  byte_size: number;
  content_hash: string;
  tags: string[];
  /** The id of a `categories` row, or null. */
  category: DocumentCategory | null;
  /** Staff-only whatever else is true of it (AGENTS.md, "A transcript is never shared"). */
  transcript: boolean;
  subjects: DocumentSubject[];
  created_at: string;
  updated_at: string;
  /**
   * When the document was written: `frontmatter.date` when it holds a date,
   * else `created_at`. An import stamps `created_at` with the day it ran;
   * the frontmatter keeps the day the words are from.
   */
  written_at: string;
  updated_by: string | null;
  excerpt?: string;
  /** `frontmatter.source`, when the document records one. */
  source?: string;
  /** Present on a link save (`source_kind = 'link'`), absent on every other row. */
  link?: LinkSave;
}

/**
 * An image a person attached to a document. The bytes are at
 * `GET /api/docs/:id/images/:image_id`; `POST /api/docs/:id/images` takes
 * the raw bytes as the body, `?caption=` optional; `DELETE` on the image
 * removes it from the list.
 */
export interface DocumentImage {
  id: string;
  content_type: string;
  byte_size: number;
  caption: string | null;
  created_by: string;
  created_at: string;
}

export interface DocumentDetail extends DocumentSummary {
  body_md: string | null;
  frontmatter: Record<string, unknown>;
  /** Resolved outbound links plus unresolved wikilink targets. */
  links: Array<{ target: string; to_id: string | null; to_path: string | null }>;
  backlinks: Array<{ id: string; path: string; title: string }>;
  open_annotations: number;
  /** Attached images, oldest first. */
  images: DocumentImage[];
}

/**
 * `POST /api/docs`. With `url` it is a link save: the caller sends what it
 * read about the page in `link` (Docs fetches nothing), the title defaults to
 * the URL's host, the folder to `LINK_FOLDER`, and the body is the person's
 * notes. The cover goes up after, `PUT /api/docs/:id/link-image`. Saving a URL the same person already saved returns
 * that save (200, not 201). Without `url`, `title` is required.
 */
export const documentCreateSchema = z.object({
  path: pathSchema.optional(),
  folder_path: pathSchema.optional(),
  slug: slugSchema.optional(),
  title: z.string().min(1).max(500).optional(),
  url: linkURLSchema.optional(),
  /** With `url`: what the caller read about the page. */
  link: linkMetadataSchema.optional(),
  kind: documentKindSchema.default('markdown'),
  body_md: z.string().max(MARKDOWN_MAX_BYTES).optional(),
  frontmatter: z.record(z.unknown()).default({}),
  tags: z.array(z.string().min(1).max(80)).max(64).default([]),
  visibility: visibilitySchema.default('internal'),
  /** A category id that exists. `'transcript'` also sets the marker (`TRANSCRIPT_MARKER`). */
  category: categorySchema.optional(),
  /** Mark it a transcript: staff-only, for good. */
  transcript: z.boolean().optional(),
  subjects: subjectsSchema.default([]),
  message: z.string().max(500).optional(),
  /**
   * The document's own date, when it is not the moment of writing: a meeting
   * transcript filed months after the meeting, a vault file with its own
   * date. Stamps `created_at` and `updated_at` both, so a history imported in
   * one afternoon reads as history everywhere the two are sorted on.
   */
  created_at: z.string().datetime({ offset: true }).optional(),
}).superRefine((value, context) => {
  if (!value.url && !value.title) context.addIssue({ code: 'custom', path: ['title'], message: 'Required.' });
  if (value.url && value.kind !== 'markdown') context.addIssue({ code: 'custom', path: ['kind'], message: 'A link save is markdown.' });
  if (value.url && value.visibility !== 'internal') {
    context.addIssue({ code: 'custom', path: ['visibility'], message: 'A link save is internal.' });
  }
});
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

export const documentUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  category: categorySchema.nullable().optional(),
  body_md: z.string().max(MARKDOWN_MAX_BYTES).optional(),
  frontmatter: z.record(z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(80)).max(64).optional(),
  visibility: visibilitySchema.optional(),
  status: documentStatusSchema.optional(),
  message: z.string().max(500).optional(),
  /**
   * Optimistic concurrency. Agents write concurrently with people; a client
   * that sends the hash it read is told `hash_mismatch` instead of silently
   * clobbering an edit made in between.
   */
  if_content_hash: z.string().length(64).optional(),
  /** Re-date an existing document — see `documentCreateSchema.created_at`. */
  created_at: z.string().datetime({ offset: true }).optional(),
});

export const documentMoveSchema = z.object({
  folder_path: pathSchema.optional(),
  slug: slugSchema.optional(),
  title: z.string().min(1).max(500).optional(),
});

export const folderCreateSchema = z.object({
  path: pathSchema.optional(),
  parent_path: pathSchema.optional(),
  slug: slugSchema.optional(),
  title: z.string().min(1).max(300),
  icon: z.string().max(60).optional(),
  description: z.string().max(2000).optional(),
  sort_order: z.number().int().min(-10_000).max(10_000).default(0),
});

export const listQuerySchema = z.object({
  folder: z.string().optional(),
  prefix: z.string().optional(),
  tag: z.string().optional(),
  subject: subjectRefSchema.optional(),
  category: categorySchema.optional(),
  source: sourceListSchema.optional(),
  source_kind: z.string().optional(),
  kind: documentKindSchema.optional(),
  status: documentStatusSchema.default('active'),
  q: z.string().max(400).optional(),
  /**
   * Only documents with at least one open comment thread — the projection
   * Meet's INBOX pages instead of reading every document's annotations
   *. `1` or `true`.
   */
  open_annotations: z.enum(['1', 'true', '0', 'false']).optional().transform((value) => value === '1' || value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  updated_since: z.string().datetime().optional(),
  /**
   * Only documents that record where they were copied from
   * (`frontmatter.source`), and optionally only those whose source starts
   * with this value — `vault:` for everything staged out of the Obsidian
   * vault, `repo:` for the files mirrored from a checkout. What
   * `docsctl drift` asks for, so checking a thousand documents for drift
   * does not mean fetching a thousand bodies.
   */
  has_source: z.string().max(200).optional(),
  /**
   * Only documents nobody filed: native, not a link save, no
   * category, no subject, and directly in `/` or `/work`, the two default
   * folders. A document anywhere else was filed by its folder.
   */
  unfiled: z.enum(['1', 'true']).optional(),
});

/** GET /api/docs/summary — one request for a sidebar. */
export interface DocsSummary {
  /** Every category in rail order, an empty one too, with its active documents whatever wrote them. */
  categories: Array<{ category: DocumentCategory; label: string; count: number }>;
  /**
   * Per (source, category): what a rail's WORK half (`native`) and LIBRARY
   * half (everything else) count, since a category does not say who wrote
   * it — Core publishes briefs and a person writes briefs.
   */
  by_source: Array<{ source: SourceSystem; category: DocumentCategory; label: string; count: number }>;
  /** Top-level folders with the documents under them, including descendants. */
  folders: Array<{ path: string; title: string; count: number }>;
  /** Active link saves. They carry no category, so no row above counts them. */
  links: number;
  /** Active documents nobody filed; `unfiled=1` on the list lists them. */
  unfiled: number;
  total: number;
}

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(400),
  prefix: z.string().optional(),
  source: sourceListSchema.optional(),
  source_kind: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface SearchHit {
  id: string;
  path: string;
  title: string;
  kind: DocumentKind;
  source_system: SourceSystem;
  source_kind: SourceKind | NativeSourceKind | null;
  snippet: string;
  rank: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export const textAnchorSchema = z.object({
  type: z.literal('text'),
  quote: z.string().min(1).max(2000),
  prefix: z.string().max(200).optional(),
  suffix: z.string().max(200).optional(),
  /** Advisory only — `quote` is what re-anchors after an edit. */
  start: z.number().int().min(0).optional(),
});

export const pdfAnchorSchema = z.object({
  type: z.literal('pdf'),
  page: z.number().int().min(1).max(5000),
  rects: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).min(1).max(64),
  quote: z.string().max(2000).optional(),
});

export const anchorSchema = z.discriminatedUnion('type', [textAnchorSchema, pdfAnchorSchema]);

export type Anchor = z.infer<typeof anchorSchema>;

export const annotationCreateSchema = z.object({
  body_md: z.string().min(1).max(ANNOTATION_MAX_BYTES),
  anchor: anchorSchema.nullish(),
  parent_id: z.string().uuid().optional(),
  author_name: z.string().max(200).optional(),
});

export const annotationUpdateSchema = z.object({
  body_md: z.string().min(1).max(ANNOTATION_MAX_BYTES).optional(),
  status: z.enum(['open', 'resolved']).optional(),
});

export interface Annotation {
  id: string;
  document_id: string;
  document_version: number;
  thread_id: string;
  parent_id: string | null;
  author: string;
  author_name: string | null;
  author_kind: 'staff' | 'guest' | 'agent';
  body_md: string;
  anchor: Anchor | null;
  status: 'open' | 'resolved';
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  /** True when the anchor quote no longer appears in the current body. */
  orphaned?: boolean;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export const grantCreateSchema = z.object({
  email: z.string().email().max(320).optional(),
  role: grantRoleSchema.default('viewer'),
  label: z.string().max(200).optional(),
  require_verification: z.boolean().optional(),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
  folder: z.boolean().default(false),
});

export const claimSchema = z.object({
  token: z.string().min(16).max(200),
  email: z.string().email().max(320),
  name: z.string().max(200).optional(),
});

export const verifySchema = z.object({
  token: z.string().min(16).max(200),
  email: z.string().email().max(320),
  code: z.string().min(4).max(12),
});

export const visitSchema = z.object({
  referrer: z.string().max(2000).optional(),
  timezone: z.string().max(100).optional(),
  language: z.string().max(40).optional(),
});

/** A link a reader opened from inside a document body: http or https only. */
export const accessHrefSchema = z
  .string()
  .max(2000)
  .url()
  .refine((value) => /^https?:\/\//iu.test(value), 'must be an http or https URL');

/** ISO 3166-1 alpha-2, upper case. Anything else (Cloudflare's `T1`, `XX`) is no country. */
export const COUNTRY_CODE = /^[A-Z]{2}$/u;

/** `POST /api/docs/:id/click`: a guest opened a link inside the document. */
export const documentClickSchema = z.object({ href: accessHrefSchema });

/**
 * `POST /api/internal/documents/:id/access` (HMAC): www records a visit or a
 * link click on the share reader's `/private/docs/<id>` as a guest event.
 */
export const internalAccessSchema = z
  .object({
    kind: z.enum(['view', 'click']),
    email: z.string().email().max(320),
    href: accessHrefSchema.optional(),
    city: z.string().max(120).nullable().optional(),
    country: z.string().regex(COUNTRY_CODE).nullable().optional(),
    timezone: z.string().max(100).optional(),
    language: z.string().max(40).optional(),
    referrer: z.string().max(2000).optional(),
  })
  .refine((value) => value.kind !== 'click' || value.href !== undefined, {
    message: 'a click needs href',
    path: ['href'],
  });

/**
 * What Docs tells the workspace's Starlings Worker after a guest view or click
 * (`MemberService.documentAccessed`). Starlings
 * owns the parse; this is the shape Docs sends. `event_id` is the
 * `access_events` row, for idempotency.
 */
export interface DocumentAccessedInput {
  v: 1;
  event_id: string;
  document_id: string;
  title: string;
  owner: string | null;
  subjects: { kind: string; subject_id: string }[];
  kind: 'view' | 'click';
  actor: string | null;
  via: 'grant' | 'www';
  grant_id: string | null;
  city: string | null;
  country: string | null;
  href: string | null;
  at: string;
}

export interface GrantSummary {
  id: string;
  document_id: string | null;
  folder_id: string | null;
  url: string;
  email: string | null;
  role: GrantRole;
  label: string | null;
  require_verification: boolean;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

export const signatureRequestSchema = z.object({
  subject: z.string().max(300).optional(),
  message: z.string().max(4000).optional(),
  ordered: z.boolean().default(false),
  expires_in_days: z.number().int().min(1).max(365).default(30),
  parties: z
    .array(
      z.object({
        email: z.string().email().max(320),
        name: z.string().max(200).optional(),
        role: z.enum(['signer', 'approver', 'cc']).default('signer'),
        sequence: z.number().int().min(0).max(50).default(0),
      }),
    )
    .min(1)
    .max(25),
});

export const signSchema = z.object({
  /** Echo of the hash the signer was shown. Mismatch means the doc moved. */
  content_hash: z.string().length(64),
  method: z.enum(['typed', 'drawn']),
  typed_text: z.string().max(200).optional(),
  /** data:image/png;base64,… of the drawn signature. */
  signature_image: z.string().max(512 * 1024).optional(),
  name: z.string().min(1).max(200),
  consent: z.literal(true),
  timezone: z.string().max(100).optional(),
});

export const declineSchema = z.object({
  reason: z.string().max(2000).optional(),
});

/**
 * The exact sentence a signer must agree to. Stored verbatim on every
 * signature row — changing this constant does not rewrite past evidence.
 */
export const CONSENT_TEXT =
  'I agree that my typed or drawn signature is the electronic representation of my signature, ' +
  'and that applying it to this document is legally binding, the same as a handwritten signature.';

export interface SignatureRecord {
  id: string;
  request_id: string;
  document_id: string;
  document_version: number;
  content_hash: string;
  signer_email: string;
  signer_name: string;
  method: 'typed' | 'drawn';
  email_verified: boolean;
  sealed_at: string;
  seal: string;
}

export interface SignatureRequestDetail {
  id: string;
  document_id: string;
  document_path: string;
  document_title: string;
  document_version: number;
  content_hash: string;
  requested_by: string;
  subject: string | null;
  message: string | null;
  ordered: boolean;
  status: 'pending' | 'completed' | 'declined' | 'cancelled' | 'expired';
  created_at: string;
  expires_at: string | null;
  completed_at: string | null;
  parties: Array<{
    id: string;
    email: string;
    name: string | null;
    role: 'signer' | 'approver' | 'cc';
    sequence: number;
    status: 'pending' | 'viewed' | 'signed' | 'declined';
    signed_at: string | null;
    url?: string;
  }>;
  signatures: SignatureRecord[];
}

// ---------------------------------------------------------------------------
// Sync (CLI push/pull and mirror ingest)
// ---------------------------------------------------------------------------

export const syncDocumentSchema = z.object({
  path: pathSchema,
  title: z.string().min(1).max(500),
  body_md: z.string().max(MARKDOWN_MAX_BYTES),
  frontmatter: z.record(z.unknown()).default({}),
  tags: z.array(z.string().min(1).max(80)).max(64).default([]),
  /** SHA-256 the client believes is currently stored. Omit to force-write. */
  base_hash: z.string().length(64).optional(),
});

export const syncPushSchema = z.object({
  documents: z.array(syncDocumentSchema).min(1).max(SYNC_BATCH_MAX),
  message: z.string().max(500).optional(),
  /** Refuse the whole batch if any document fails its `base_hash` check. */
  atomic: z.boolean().default(false),
});

export interface SyncManifestEntry {
  path: string;
  content_hash: string;
  updated_at: string;
  version: number;
  kind: DocumentKind;
  editable: boolean;
}

export interface SyncPushResult {
  written: Array<{ path: string; id: string; version: number; content_hash: string }>;
  skipped: Array<{ path: string; reason: 'unchanged' | 'read_only' }>;
  conflicts: Array<{ path: string; expected: string; actual: string }>;
}

// ---------------------------------------------------------------------------
// Mirror ingest — Core pushes its markdown surfaces here.
// ---------------------------------------------------------------------------

export const ingestDocumentSchema = z.object({
  source_kind: z.enum(SOURCE_KINDS),
  source_id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  body_md: z.string().max(MARKDOWN_MAX_BYTES),
  slug: z.string().max(200).optional(),
  source_url: z.string().url().max(2000).optional(),
  frontmatter: z.record(z.unknown()).default({}),
  tags: z.array(z.string().min(1).max(80)).max(64).default([]),
  updated_at: z.string().optional(),
  /** Soft-delete the mirrored document when the upstream row disappears. */
  deleted: z.boolean().default(false),
});

export const ingestBatchSchema = z.object({
  source_system: z.enum(['core', 'meet', 'obsidian']).default('core'),
  /** May be empty on the trailing call that only records run completion. */
  documents: z.array(ingestDocumentSchema).max(SYNC_BATCH_MAX),
  /** Names the surface when `documents` is empty. */
  source_kind: z.enum(SOURCE_KINDS).optional(),
  /** Marks a full-sweep run so the Worker can record completion. */
  complete: z.boolean().default(false),
  /**
   * Run totals, sent on the completing batch. A sweep arrives as many
   * requests and the Worker keeps no state between them, so only the caller
   * knows what the whole run covered.
   */
  run_seen: z.number().int().min(0).optional(),
  run_written: z.number().int().min(0).optional(),
});

/**
 * Adoption: a mirrored row becomes a native document. Bodies stop being
 * Core's and start being ours; the `source_*` triple stays for provenance,
 * `editable` flips, the file moves to where it belongs and gains its subjects.
 * Idempotent on `source_id`: a row adopted twice is adopted once.
 */
export const adoptDocumentSchema = z.object({
  source_kind: z.enum(SOURCE_KINDS),
  source_id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  body_md: z.string().max(MARKDOWN_MAX_BYTES),
  folder_path: pathSchema,
  slug: z.string().max(200).optional(),
  subjects: subjectsSchema.default([]),
  tags: z.array(z.string().min(1).max(80)).max(64).default([]),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export const adoptBatchSchema = z.object({
  source_system: z.enum(['core', 'obsidian']).default('core'),
  documents: z.array(adoptDocumentSchema).max(SYNC_BATCH_MAX),
});

/**
 * Where each mirrored surface lands. The Worker creates these folders on
 * demand; `editable: false` keeps the body authoritative upstream.
 */
export const MIRROR_FOLDERS: Record<SourceKind, { path: string; title: string; editable: boolean }> = {
  note: { path: '/crm/notes', title: 'CRM notes', editable: false },
  newsletter_issue: { path: '/published/newsletter', title: 'Newsletter', editable: false },
  report: { path: '/published/reports', title: 'Reports', editable: false },
  research: { path: '/published/research', title: 'Research', editable: false },
  methodology: { path: '/published/methodology', title: 'Methodology', editable: false },
  work: { path: '/published/work', title: 'Work', editable: false },
  signals_brief: { path: '/published/signals-briefs', title: 'Signals briefs', editable: false },
  faq: { path: '/published/faq', title: 'FAQ', editable: false },
  vault: { path: '/vault', title: 'Vault', editable: true },
};

/**
 * The domains an Envisioning person signs in from. Two, as in Meet: the
 * Workspace is the organisation's domain, and its other domain accounts are the same
 * people. `hd` from Google and the address itself are both checked against
 * this list — a Google account with an envisioning-looking address and no
 * hosted domain does not pass.
 *
 * This is the default. A Docs deployment for another workspace names its own
 * list in `IDENTITY_DOMAINS`; the Worker reads it through `identityDomains`.
 */
export const ENVISIONING_IDENTITY_DOMAINS = IDENTITY_DOMAINS;

/** True for an address on one of `domains`. `domains` must be lower case. */
export function isIdentityEmailIn(value: string | null | undefined, domains: readonly string[]): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return domains.some((domain) => normalized.endsWith(`@${domain}`));
}

/** True for a hosted-domain (`hd`) claim naming one of `domains`. `domains` must be lower case. */
export function isHostedDomainIn(value: string | null | undefined, domains: readonly string[]): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return domains.some((domain) => normalized === domain);
}

// Central sign-in through the auth host, as the workspace's Docs (a copy of Meet's contract).
export * from './central-auth';

/**
 * What a deployment says about itself before anyone signs in
 * (`GET /api/deployment`): the name the SPA shows, and the domains its
 * sign-in admits. Public: none of it is a secret.
 */
export const deploymentInfoSchema = z.object({
  /** The workspace's name; `WORKSPACE_NAME`, or `Envisioning` when unset. */
  name: z.string().min(1).max(60),
  /** `true` on Envisioning's own deployment, which shows the Envisioning mark. */
  envisioning: z.boolean(),
  identity_domains: z.array(z.string()),
});
export type DeploymentInfo = z.infer<typeof deploymentInfoSchema>;
