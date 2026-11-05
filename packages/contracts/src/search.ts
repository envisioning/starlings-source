import { z } from 'zod';
import { SEARCH_KINDS, parseSearchDoor } from './search-values';
import type { SearchRow } from './search-values';

export * from './search-values';

/** GET /api/search rows, and what a client stores for recents. */
export const searchRowSchema = z.object({
  kind: z.enum(SEARCH_KINDS),
  id: z.string().min(1).max(1024),
  title: z.string().max(1024),
  subtitle: z.string().max(1024),
  door: z.string().min(1).max(2048).refine((door) => parseSearchDoor(door) !== null, 'door does not parse'),
  image: z.string().url().max(2048).optional(),
}).strict();

/** GET /api/search?q=&tz= — tz is the device zone for event clocks. */
export const searchQuerySchema = z.object({
  q: z.string().max(256).default(''),
  tz: z.string().trim().min(1).max(64).default('UTC'),
}).strict();

/** GET /api/search and GET /api/crm/starred. */
export const searchResponseSchema = z.object({
  rows: z.array(searchRowSchema),
  partial: z.array(z.string()).optional(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
