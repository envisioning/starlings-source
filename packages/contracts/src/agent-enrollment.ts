import { z } from 'zod';

/**
 * Agent enrollment on the wire (docs/AGENTS_SURFACE.md §Enrollment). Any agent
 * runtime joins a workspace's Team the way a TV joins an account: it asks, an
 * admin approves with a short code, and the runtime collects its own keys.
 *
 *   1. `POST /api/agents/enroll` (public): name, endpoint. Answers a
 *      `user_code`, an `approve_url` for an admin, and a `poll_token`.
 *   2. An admin opens `approve_url` (Admin › Agents) and approves. Starlings
 *      gives the agent its address and generates its two keys.
 *   3. `POST /api/agents/enroll/poll` with the `poll_token`: `pending` until
 *      then; `approved` exactly once, with the address and both keys.
 *
 * The runtime never chooses its address and never sees another agent's keys.
 */

/** How long a request waits for an admin before it expires. */
export const AGENT_ENROLLMENT_TTL_MILLISECONDS = 30 * 60 * 1000;
/** How often a runtime may poll. A faster poll is refused with `rate_limited`. */
export const AGENT_ENROLLMENT_POLL_SECONDS = 5;
/** `user_code` alphabet: no 0/O, 1/I/L, so a person reads it aloud without error. */
export const AGENT_ENROLLMENT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const agentEnrollRequestSchema = z.object({
  /** What the agent asks to be called. Starlings derives the address from it. */
  name: z.string().trim().min(1).max(60),
  /** Where Starlings posts hand-offs: absolute https. The manifest is read from `<origin>/manifest`. */
  endpoint: z.string().trim().url().max(2048),
  /** Optional: where the watchdog posts a reset for one stuck thread. */
  reset_endpoint: z.string().trim().url().max(2048).optional(),
  /** One or two sentences an admin reads before approving. */
  description: z.string().trim().max(500).optional(),
  /** The runtime's own name and version, e.g. `hermes 0.21.5`. Shown to the admin. */
  runtime: z.string().trim().max(80).optional(),
}).strict();
export type AgentEnrollRequest = z.infer<typeof agentEnrollRequestSchema>;

export const agentEnrollResponseSchema = z.object({
  enrollment_id: z.string(),
  /** Eight characters, shown as `ABCD-EFGH`. The admin confirms the runtime shows the same. */
  user_code: z.string(),
  /** Admin › Agents, opened on this request. Give it to a workspace admin. */
  approve_url: z.string(),
  /** Secret. Only the runtime holds it; Starlings keeps its hash. */
  poll_token: z.string(),
  poll_interval_seconds: z.number().int(),
  expires_at: z.number().int(),
});
export type AgentEnrollResponse = z.infer<typeof agentEnrollResponseSchema>;

export const agentEnrollPollRequestSchema = z.object({
  poll_token: z.string().trim().min(32).max(128),
}).strict();
export type AgentEnrollPollRequest = z.infer<typeof agentEnrollPollRequestSchema>;

export const agentEnrollPollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), expires_at: z.number().int() }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  /** Already collected: the keys went out once and are not sent again. Enroll again for new keys. */
  z.object({ status: z.literal('collected') }),
  z.object({
    status: z.literal('approved'),
    /** The agent's address: its identity in Team and the key id it signs with. */
    agent_email: z.string(),
    name: z.string(),
    /** The workspace origin: the reply route and `/mcp` live here. */
    workspace_origin: z.string(),
    /** Verifies what Starlings sends: hand-offs and resets. URL-safe base64, 43 characters. */
    webhook_secret: z.string(),
    /** Signs what the agent sends: `/api/internal/channel-events`, `/mcp`. URL-safe base64, 43 characters. */
    inbound_key: z.string(),
  }),
]);
export type AgentEnrollPollResponse = z.infer<typeof agentEnrollPollResponseSchema>;

/** One request in Admin › Agents. No secret ever appears here. */
export const adminAgentEnrollmentSchema = z.object({
  id: z.string(),
  user_code: z.string(),
  requested_name: z.string(),
  description: z.string().nullable(),
  runtime: z.string().nullable(),
  endpoint: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']),
  created_at: z.number().int(),
  expires_at: z.number().int(),
  /** Set once approved: the address Starlings gave it. */
  agent_email: z.string().nullable(),
});
export type AdminAgentEnrollment = z.infer<typeof adminAgentEnrollmentSchema>;

export const adminAgentEnrollmentsResponseSchema = z.object({
  enrollments: z.array(adminAgentEnrollmentSchema),
});
export type AdminAgentEnrollmentsResponse = z.infer<typeof adminAgentEnrollmentsResponseSchema>;

/** `POST /api/admin/agent-enrollments/:code/approve`. The admin may rename it before it joins. */
export const adminAgentEnrollmentApproveSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
}).strict();
export type AdminAgentEnrollmentApprove = z.infer<typeof adminAgentEnrollmentApproveSchema>;

export const adminAgentEnrollmentDecisionResponseSchema = z.object({
  enrollment: adminAgentEnrollmentSchema,
});
export type AdminAgentEnrollmentDecisionResponse = z.infer<typeof adminAgentEnrollmentDecisionResponseSchema>;

/** `POST /api/admin/agents/:id/remove`: the agent left the roster. */
export const adminAgentRemoveResponseSchema = z.object({
  agent_email: z.string(),
  removed: z.literal(true),
}).strict();
export type AdminAgentRemoveResponse = z.infer<typeof adminAgentRemoveResponseSchema>;

/** `user_code` as a person reads it: `ABCDEFGH` → `ABCD-EFGH`. */
export function formatAgentEnrollmentCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** What a person types back, normalized: case, spaces and the dash do not matter. */
export function normalizeAgentEnrollmentCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/gu, '');
}

/**
 * The local part Starlings gives an agent, from the name it asked for:
 * `Hermes` → `hermes`, `Research Bot` → `research-bot`. Never empty.
 */
export function agentLocalPart(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/gu, '');
  return slug || 'agent';
}

/**
 * Every enrolled agent's address sits under this label of the workspace host:
 * `hq.<suffix>` → `agents.hq.<suffix>`. A development Worker on an
 * IP address or a bare `localhost` gets `agents.localhost`, because an IP is
 * not a mail domain.
 */
export function agentAddressDomain(workspaceOrigin: string): string {
  const host = new URL(workspaceOrigin).hostname;
  const local = host === 'localhost' || !host.includes('.') || /^[\d.]+$/u.test(host) || host.startsWith('[');
  return local ? 'agents.localhost' : `agents.${host}`;
}
