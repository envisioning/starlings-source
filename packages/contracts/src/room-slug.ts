import { z } from 'zod';

/** Permanent room slug, shared by request and meeting-grant schemas. */
export const roomSlugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);
