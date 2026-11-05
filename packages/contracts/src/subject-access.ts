import { z } from 'zod';
import { SUBJECT_KINDS } from './subject-kinds';

/**
 * Who reaches which subject (docs/ACCESS.md). One primitive, the subject
 * grant, for members, agents, guests and peer workspaces. Visibility is
 * `workspace` unless a subject says `restricted`; the Worker stores the
 * override only.
 *
 * Slices 1, 2, 4 and 5 write `member`, `agent`, `guest` and
 * `peer_workspace` grants.
 */

export const SUBJECT_VISIBILITIES = ['workspace', 'restricted'] as const;
export type SubjectVisibility = (typeof SUBJECT_VISIBILITIES)[number];

export const GRANT_PRINCIPAL_KINDS = ['member', 'agent', 'guest', 'peer_workspace'] as const;
export type GrantPrincipalKind = (typeof GRANT_PRINCIPAL_KINDS)[number];

/** The principal kinds a grant write accepts today. */
export const WRITABLE_GRANT_PRINCIPAL_KINDS = ['member', 'agent', 'guest', 'peer_workspace'] as const satisfies readonly GrantPrincipalKind[];

export const GRANT_ROLES = ['read', 'write', 'manage'] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];

/** What one principal may do on one subject. `none` hides it. */
export type SubjectAccessLevel = 'none' | GrantRole;

const LEVEL_RANK: Record<SubjectAccessLevel, number> = { none: 0, read: 1, write: 2, manage: 3 };

export function accessAtLeast(level: SubjectAccessLevel, needed: SubjectAccessLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[needed];
}

/**
 * The rule, as data in and a level out. The Worker and every client that
 * draws a share sheet read this one function.
 *
 * - An admin manages every subject. Each read of a restricted subject by an
 *   admin without a grant is recorded by the caller, not here.
 * - A `workspace` subject: every member writes it; a `manage` grant adds the
 *   right to restrict it and to grant on it.
 * - A `restricted` subject: the grant alone.
 * - Any other role (`community`) reaches nothing through this rule.
 */
export function subjectAccessLevel(input: {
  role: 'admin' | 'member' | 'community';
  visibility: SubjectVisibility;
  grant: GrantRole | null;
}): SubjectAccessLevel {
  if (input.role === 'admin') return 'manage';
  if (input.role !== 'member') return 'none';
  const granted: SubjectAccessLevel = input.grant ?? 'none';
  if (input.visibility === 'workspace') return accessAtLeast(granted, 'write') ? granted : 'write';
  return granted;
}

/**
 * An agent's own level (docs/ACCESS.md slice 2, decided 2026-10-04): like a
 * member on a `workspace` subject, its grant alone on a `restricted` one. A
 * `manage` grant is never an agent's: an agent does not change who reaches a
 * subject, so it is capped at `write`.
 */
export function agentAccessLevel(input: { visibility: SubjectVisibility; grant: GrantRole | null }): SubjectAccessLevel {
  const granted: SubjectAccessLevel = input.grant === 'manage' ? 'write' : input.grant ?? 'none';
  if (input.visibility === 'workspace') return 'write';
  return granted;
}

/** The lower of two levels: an agent acting for a person reaches what both reach. */
export function accessMin(a: SubjectAccessLevel, b: SubjectAccessLevel): SubjectAccessLevel {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

export const subjectKindSchema = z.enum(SUBJECT_KINDS);

export const subjectGrantSchema = z.object({
  id: z.string(),
  principal_kind: z.enum(GRANT_PRINCIPAL_KINDS),
  principal_id: z.string(),
  /** The member's address, for a `member` grant; absent for other kinds. */
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: z.enum(GRANT_ROLES),
  granted_by: z.string(),
  granted_at: z.number().int(),
});
export type SubjectGrant = z.infer<typeof subjectGrantSchema>;

/** `GET /api/crm/subjects/:kind/:id/access`. */
export const subjectAccessResponseSchema = z.object({
  kind: subjectKindSchema,
  id: z.string(),
  visibility: z.enum(SUBJECT_VISIBILITIES),
  /** The caller's own level on this subject. */
  level: z.enum(['none', ...GRANT_ROLES]),
  grants: z.array(subjectGrantSchema),
  /** The subject's guest thread, once a guest or a peer organization was granted on it; null before (slice 4). */
  guest_thread_id: z.string().nullable(),
  /**
   * The guest's link, on the answer to the `PUT …/grants` that made or
   * renewed a `guest` grant, and nowhere else: only its hash is stored, and
   * a new one replaces the old (docs/ACCESS.md slice 4).
   */
  guest_link: z.string().optional(),
  /**
   * A peer organization's token and the `/mcp` address it is used at, on the
   * answer to the grant that made the organization, and nowhere else (slice
   * 5). Later grants to it reuse the token.
   */
  peer_token: z.string().optional(),
  peer_mcp_url: z.string().optional(),
});
export type SubjectAccessResponse = z.infer<typeof subjectAccessResponseSchema>;

/** `PUT /api/crm/subjects/:kind/:id/visibility`. */
export const subjectVisibilityUpdateSchema = z.object({
  visibility: z.enum(SUBJECT_VISIBILITIES),
}).strict();
export type SubjectVisibilityUpdate = z.infer<typeof subjectVisibilityUpdateSchema>;

/** `PUT /api/crm/subjects/:kind/:id/grants`: one grant, created or changed. */
export const subjectGrantUpdateSchema = z.discriminatedUnion('principal_kind', [
  z.object({
    principal_kind: z.enum(['member', 'agent', 'guest']),
    /** A member's address, an agent's roster address, or a guest's own address. */
    email: z.string().trim().toLowerCase().email().max(320),
    role: z.enum(GRANT_ROLES),
  }).strict(),
  z.object({
    principal_kind: z.literal('peer_workspace'),
    /**
     * The peer: a work-model organization by `organization_id`, or by `name`,
     * found or made in the `organizations` table (slice 5). Its first grant
     * mints its token, shown once.
     */
    peer: z.union([
      z.object({ organization_id: z.string().min(1).max(64) }).strict(),
      z.object({ name: z.string().trim().min(1).max(120) }).strict(),
    ]),
    role: z.enum(GRANT_ROLES),
  }).strict(),
]);
export type SubjectGrantUpdate = z.infer<typeof subjectGrantUpdateSchema>;

// ---------------------------------------------------------------------------
// Guests (docs/ACCESS.md slice 4): somebody outside the workspace, granted
// on a subject by a `manage` holder, reaching that subject's guest thread
// through a link. Read and post text only.
// ---------------------------------------------------------------------------

/** `POST /api/guest/session`: the secret from the guest's link. */
export const guestSessionRequestSchema = z.object({
  token: z.string().trim().min(20).max(200),
}).strict();
export type GuestSessionRequest = z.infer<typeof guestSessionRequestSchema>;

export const guestSubjectSchema = z.object({
  kind: subjectKindSchema,
  id: z.string(),
  title: z.string(),
  thread_id: z.string(),
  can_post: z.boolean(),
});
export type GuestSubject = z.infer<typeof guestSubjectSchema>;

/** `GET /api/guest/home`, and the answer to a session exchange. */
export const guestHomeResponseSchema = z.object({
  email: z.string(),
  workspace: z.string(),
  subjects: z.array(guestSubjectSchema),
});
export type GuestHomeResponse = z.infer<typeof guestHomeResponseSchema>;

export const guestMessageSchema = z.object({
  id: z.string(),
  sender_name: z.string(),
  /** True when the guest who is reading wrote it. */
  mine: z.boolean(),
  text: z.string(),
  sent_at: z.number().int(),
});
export type GuestMessage = z.infer<typeof guestMessageSchema>;

/** `GET /api/guest/threads/:threadId/messages`: oldest first. */
export const guestMessagesResponseSchema = z.object({
  messages: z.array(guestMessageSchema),
  older_cursor: z.string().nullable(),
});
export type GuestMessagesResponse = z.infer<typeof guestMessagesResponseSchema>;

/** `POST /api/guest/threads/:threadId/messages`. */
export const guestMessageCreateSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
}).strict();
export type GuestMessageCreate = z.infer<typeof guestMessageCreateSchema>;

// ---------------------------------------------------------------------------
// Peer organizations (docs/ACCESS.md slice 5): another company, as a row of
// the work model's `organizations` table (never a CRM row), with one token.
// The token reaches the `/mcp` door; its grants say which subjects' guest
// threads it reads and posts in.
// ---------------------------------------------------------------------------

export const peerWorkspaceSchema = z.object({
  organization_id: z.string(),
  name: z.string(),
  created_at: z.number().int(),
  revoked_at: z.number().int().nullable(),
  /** Live grants it holds. */
  subjects: z.number().int(),
});
export type PeerWorkspace = z.infer<typeof peerWorkspaceSchema>;

/** `GET /api/peer-workspaces`. */
export const peerWorkspacesResponseSchema = z.object({
  peers: z.array(peerWorkspaceSchema),
});
export type PeerWorkspacesResponse = z.infer<typeof peerWorkspacesResponseSchema>;

/** `POST /api/peer-workspaces/:organizationId/token`: a new token, shown once; the old one stops at once. */
export const peerWorkspaceTokenResponseSchema = z.object({
  peer: peerWorkspaceSchema,
  peer_token: z.string(),
  peer_mcp_url: z.string(),
});
export type PeerWorkspaceTokenResponse = z.infer<typeof peerWorkspaceTokenResponseSchema>;
