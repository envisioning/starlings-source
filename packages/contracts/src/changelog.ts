import { z } from 'zod';
import { CHANGELOG_AREA_IDS, CHANGELOG_KINDS } from './changelog-values';

export * from './changelog-values';

/**
 * An update file and a release on the wire (changelog/README.md). The area
 * and kind tables are in `changelog-values.ts`.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const version = z.string().regex(/^\d+\.\d+\.\d+$/u);

export const changelogUpdateSchema = z.object({
  /** `6.8.4-03` for an update released before 2026-10-06; `YYYY-MM-DD-slug` after. */
  id: z.string().regex(/^[0-9a-z][0-9a-z.-]*$/u),
  date: isoDate,
  /** Empty until a release takes the update. */
  version: version.optional(),
  area: z.enum(CHANGELOG_AREA_IDS),
  kind: z.enum(CHANGELOG_KINDS),
  /** Issues and pull requests, as ``. */
  refs: z.array(z.string().regex(/^[a-z0-9-]+#\d+$/u)).default([]),
  /** The update's Markdown, without the list marker. */
  body: z.string().min(1),
}).strict();
export type ChangelogUpdate = z.infer<typeof changelogUpdateSchema>;

export const changelogReleaseSchema = z.object({
  version,
  date: isoDate,
  summary: z.string().min(1).optional(),
}).strict();
export type ChangelogRelease = z.infer<typeof changelogReleaseSchema>;

export const changelogReleasesSchema = z.array(changelogReleaseSchema);
