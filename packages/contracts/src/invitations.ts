import { z } from 'zod';

/**
 * Invitations on the wire (docs/ONBOARDING.md §Invitations). An
 * admin invites one or more addresses with a role from Admin › People; each
 * gets a mail (E4) with the sign-in link. Signing in with an open invitation
 * writes the `people` row with that role and the person's room, and spends
 * the invitation. An invitation lasts 14 days; Resend mails it again and
 * starts a new 14 days.
 */

/** How long an invitation stays open (decision 8). */
export const INVITATION_TTL_MILLISECONDS = 14 * 24 * 60 * 60 * 1000;
/** Addresses in one Invite. */
export const INVITATION_BATCH_MAX = 20;

/** The roles an admin can invite with. `community` is not offered (ENROLLMENT.md). */
export const invitationRoleSchema = z.enum(['member', 'admin']);
export type InvitationRole = z.infer<typeof invitationRoleSchema>;

const address = z.string().trim().toLowerCase().email().max(254);

/** `POST /api/admin/invitations`. */
export const adminInviteRequestSchema = z.object({
  emails: z.array(address).min(1).max(INVITATION_BATCH_MAX),
  role: invitationRoleSchema,
}).strict();
export type AdminInviteRequest = z.infer<typeof adminInviteRequestSchema>;

/** `POST /api/admin/invitations/resend` and `/revoke`. */
export const adminInvitationActionSchema = z.object({
  id: z.string().trim().regex(/^inv_[A-Za-z0-9_-]{8,64}$/u),
}).strict();
export type AdminInvitationAction = z.infer<typeof adminInvitationActionSchema>;

/** One open invitation, as Admin › People lists it. `lapsed` is past `expires_at`. */
export const adminInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: invitationRoleSchema,
  invited_by: z.string(),
  created_at: z.number().int(),
  expires_at: z.number().int(),
  /** When the last mail went out; null when it could not be sent. */
  mailed_at: z.number().int().nullable(),
  state: z.enum(['pending', 'lapsed']),
});
export type AdminInvitation = z.infer<typeof adminInvitationSchema>;

/** `GET /api/admin/invitations`: the open invitations, newest first. */
export const adminInvitationsResponseSchema = z.object({
  invitations: z.array(adminInvitationSchema),
});
export type AdminInvitationsResponse = z.infer<typeof adminInvitationsResponseSchema>;

/** Why one address in an Invite was not invited. */
export const invitationRefusalSchema = z.enum(['member', 'revoked', 'agent']);
export type InvitationRefusal = z.infer<typeof invitationRefusalSchema>;

/** `POST /api/admin/invitations`: what was invited, and what was not. */
export const adminInviteResponseSchema = z.object({
  invitations: z.array(adminInvitationSchema),
  refused: z.array(z.object({ email: z.string(), reason: invitationRefusalSchema })),
});
export type AdminInviteResponse = z.infer<typeof adminInviteResponseSchema>;

/** `POST /api/admin/invitations/resend` and `/revoke`. Revoke answers the row it ended. */
export const adminInvitationActionResponseSchema = z.object({
  invitation: adminInvitationSchema,
});
export type AdminInvitationActionResponse = z.infer<typeof adminInvitationActionResponseSchema>;
