import { z } from 'zod';

/**
 * The Mac and iPhone read Docs through the Worker: the Worker
 * mounts Docs' own paths under `DOCS_SERVICE_PREFIX`, checks the member's
 * session and subject access, and relays Docs' answer. DocsKit (core-kit)
 * builds the requests and decodes the answers, so Docs owns every body
 * shape. These schemas check only what the Worker reads before it relays a
 * request: the query keys it forwards, the subjects a write files onto, and
 * that a JSON body is an object. Docs checks the rest of the body itself.
 */
export const DOCS_SERVICE_PREFIX = '/api/docs-service';

const queryValue = z.string().trim().min(1).max(400);

/** `GET …/api/docs`: the keys DocsKit sends. Any other key is dropped, never forwarded. */
export const docsServiceListQuerySchema = z.object({
  category: queryValue.optional(),
  source: queryValue.optional(),
  prefix: queryValue.optional(),
  folder: queryValue.optional(),
  subject: queryValue.optional(),
  source_kind: queryValue.optional(),
  open_annotations: z.enum(['0', '1', 'true', 'false']).optional(),
  unfiled: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.string().regex(/^\d{1,4}$/u).optional(),
  offset: z.string().regex(/^\d{1,6}$/u).optional(),
});
export type DocsServiceListQuery = z.infer<typeof docsServiceListQuerySchema>;

/** `GET …/api/search`. */
export const docsServiceSearchQuerySchema = z.object({
  q: queryValue,
  limit: z.string().regex(/^\d{1,3}$/u).optional(),
});
export type DocsServiceSearchQuery = z.infer<typeof docsServiceSearchQuerySchema>;

/** `POST …/api/docs/:id/images?caption=`. */
export const docsServiceImageQuerySchema = z.object({
  caption: z.string().max(500).optional(),
});

/** A subject link as Docs names it (`{ kind, subject_id }`), the part the access check reads. */
const docsServiceSubjectLinkSchema = z.looseObject({
  kind: z.string().trim().min(1).max(40),
  subject_id: z.string().trim().min(1).max(200),
});

/** Any JSON write: an object. `subjects`, when present, is what the write files the document onto. */
export const docsServiceWriteBodySchema = z.looseObject({
  subjects: z.array(docsServiceSubjectLinkSchema).max(64).optional(),
});
export type DocsServiceWriteBody = z.infer<typeof docsServiceWriteBodySchema>;

/**
 * `POST …/api/docs`: a new document. A link save goes through
 * `POST /api/docs/documents`, where the Worker reads the page with its own
 * guarded reader, so a body with `url` is refused here.
 */
export const docsServiceCreateBodySchema = docsServiceWriteBodySchema.refine(
  (body) => !('url' in body),
  { message: 'Save a link through /api/docs/documents.', path: ['url'] },
);

/** `PUT …/api/docs/:id/subjects`: replace-all, so the list is required. */
export const docsServiceSetSubjectsBodySchema = z.looseObject({
  subjects: z.array(docsServiceSubjectLinkSchema).max(64),
});

/** Docs addresses comments, share links, signature requests and images by uuid. */
export const docsServiceRowIdSchema = z.string().regex(/^[0-9a-f-]{36}$/u, 'Not a Docs id.');

/** A document reference in a path: its id. */
export const docsServiceDocumentIdSchema = z.string().trim().min(1).max(400);
