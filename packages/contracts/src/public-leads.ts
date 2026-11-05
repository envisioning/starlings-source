import { z } from 'zod';

/*
 * The public lead form on the Worker (docs/SECURITY.md, "The public lead
 * route"; MZ, 2026-11-05: Core's `/api/public/leads` moves here). The same
 * path and the same body as Core's route, so a site changes its origin and
 * nothing else. A field this schema does not name is ignored, as Core ignores
 * it: the sites send form fields that mean nothing to the record.
 */

export const PUBLIC_LEAD_PATH = '/api/public/leads';
export const PUBLIC_LEAD_BODY_MAX_BYTES = 32 * 1024;
/** Longest message. Core has no limit; a form that needs more than this is not a contact form. */
export const PUBLIC_LEAD_MESSAGE_MAX_CHARS = 8000;

const line = (max: number) => z.string().trim().max(max);

export const publicLeadSubmissionSchema = z.object({
  name: line(160).min(1),
  email: z.string().trim().toLowerCase().email().max(320),
  /** The person's job title. A site that has none sends "Not provided". */
  title: line(200).optional(),
  organization: line(200).min(1),
  /** ISO 3166-1 alpha-2 from the sites' picker. Core's old callers send a name. */
  country: line(80).optional(),
  message: z.string().trim().max(PUBLIC_LEAD_MESSAGE_MAX_CHARS).optional(),
  partner: line(200).optional(),
  requestOffer: z.boolean().default(true),
  /** A submission makes a contact, and a lead only when it asks for one. */
  createLead: z.boolean().default(false),
  budgetRange: line(40).optional(),
  fundsAllocated: line(20).optional(),
  sourcePage: line(1024).optional(),
  /** A caller that does not sign sends an unredeemed token. A signed caller already redeemed its own. */
  turnstileToken: z.string().min(1).max(2048).optional(),
}).refine((body) => !(body.createLead && body.requestOffer && !body.message), {
  message: 'A message is required when requesting an offer.',
  path: ['message'],
});
export type PublicLeadSubmission = z.infer<typeof publicLeadSubmissionSchema>;

export const publicLeadResponseSchema = z.object({
  message: z.string(),
  lead_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  contact_id: z.string(),
  requestOffer: z.boolean(),
  /** The same submission arrived before, today or yesterday: this answers with what that one made. */
  duplicate: z.boolean(),
});
export type PublicLeadResponse = z.infer<typeof publicLeadResponseSchema>;
