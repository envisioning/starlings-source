import { z } from 'zod';

/**
 * What a signed-out visitor sees at a workspace's root, set by an admin
 * (`/admin/people`). The member's own Home is `home-layout.ts`; this is the
 * door in front of it. Web only: no native client draws the visitor root.
 */

/** `PUT /api/admin/visitor-home` body. `booking_email: null` hides the booker. */
export const visitorHomeUpdateSchema = z.object({
  /** The room-code field. */
  join: z.boolean(),
  /** The member whose booking page the root offers, by their sign-in address. */
  booking_email: z.string().trim().toLowerCase().email().max(320).nullable(),
});
export type VisitorHomeUpdate = z.infer<typeof visitorHomeUpdateSchema>;

/**
 * `GET /api/visitor-home`, read before anyone signs in. `booking` is null
 * when no member is chosen, or the chosen member has no room or lost access:
 * the root never offers a booking page that does not open. It names the room
 * and the name the booking page shows already, never the member's address.
 */
export const visitorHomeResponseSchema = z.object({
  join: z.boolean(),
  booking: z.object({
    room: z.string(),
    name: z.string().nullable(),
  }).nullable(),
});
export type VisitorHomeResponse = z.infer<typeof visitorHomeResponseSchema>;

/**
 * `GET` and `PUT /api/admin/visitor-home`: the public shape, and what the
 * admin chose. Written out, not `.extend()`: a method call is not marked
 * pure, and it would keep the zod runtime in the web bundle.
 */
export const visitorHomeAdminResponseSchema = z.object({
  join: z.boolean(),
  booking: z.object({
    room: z.string(),
    name: z.string().nullable(),
  }).nullable(),
  /** The chosen member, even when `booking` is null because they have no room now. */
  booking_email: z.string().nullable(),
  /** Null until an admin has saved once. */
  updated_at: z.number().int().nullable(),
});
export type VisitorHomeAdminResponse = z.infer<typeof visitorHomeAdminResponseSchema>;

/** Before an admin saves: the room-code field, and no booker. */
export const VISITOR_HOME_DEFAULT: VisitorHomeUpdate = { join: true, booking_email: null };
