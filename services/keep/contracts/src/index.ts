// Keep — wire contract.
//
// Everything the Worker, the SPA and any future client agree on. The rule
// that shapes every schema here: **the server stores ciphertext it can never
// open.** A field is plaintext only when the server needs it to list, route
// or audit. Anything a person would call "the secret" arrives sealed.
//
// Binary values travel as base64url strings. Keys are raw bytes, never PEM.

import { KEEP_PRF_SALT_LABEL } from '../../../../packages/contracts/src/deployment-values';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** One sealed item body. Generous for notes; small enough that D1 rows stay cheap. */
export const ITEM_CIPHERTEXT_MAX_CHARS = 64 * 1024;
export const ROTATE_BODY_MAX_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Crypto constants — shared so both ends derive the same bytes
// ---------------------------------------------------------------------------

/** The suite every blob in Keep is sealed with. Bumped only by a migration. */
export const CRYPTO_SUITE = 'keep-v1' as const;
/** Fixed PRF salt: the passkey returns the same 32 bytes on every unlock. */
export const PRF_SALT_LABEL = KEEP_PRF_SALT_LABEL;
/** PBKDF2 rounds for the passphrase path. OWASP's 2023 floor for SHA-256. */
export const PBKDF2_ITERATIONS = 600_000;

export const staffKeyWrapMethods = ['prf', 'passphrase'] as const;
export type StaffKeyWrapMethod = (typeof staffKeyWrapMethods)[number];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/u, 'base64url expected');
/**
 * A normalized address. Which domains a deployment admits is per deployment
 * (`IDENTITY_DOMAINS`), so the Worker checks it at the boundary, not here.
 */
export const emailSchema = z.string().trim().toLowerCase().email();

/** AES-256-GCM output: a 12-byte IV and ciphertext with the 16-byte tag appended. */
export const sealedSchema = z.object({
  iv: base64url.min(16).max(16),
  ciphertext: base64url.max(ITEM_CIPHERTEXT_MAX_CHARS),
});
export type Sealed = z.infer<typeof sealedSchema>;

/**
 * A symmetric key wrapped to a P-256 public key (ECIES): an ephemeral public
 * key, then AES-GCM under HKDF(ECDH shared secret).
 */
export const wrappedToPublicKeySchema = z.object({
  ephemeral_public_key: base64url,
  iv: base64url.min(16).max(16),
  ciphertext: base64url.max(256),
});
export type WrappedToPublicKey = z.infer<typeof wrappedToPublicKeySchema>;

// ---------------------------------------------------------------------------
// Staff keys — one keypair per person, private half wrapped client-side
// ---------------------------------------------------------------------------

export const prfWrapParamsSchema = z.object({
  method: z.literal('prf'),
  /** WebAuthn credential id, so unlock can ask for exactly this passkey. */
  credential_id: base64url,
  /** HKDF salt applied to the PRF output. Random per enrolment. */
  hkdf_salt: base64url,
});

export const passphraseWrapParamsSchema = z.object({
  method: z.literal('passphrase'),
  pbkdf2_salt: base64url,
  pbkdf2_iterations: z.number().int().min(PBKDF2_ITERATIONS),
});

export const wrapParamsSchema = z.discriminatedUnion('method', [prfWrapParamsSchema, passphraseWrapParamsSchema]);
export type WrapParams = z.infer<typeof wrapParamsSchema>;

export const enrolSchema = z.object({
  suite: z.literal(CRYPTO_SUITE),
  /** Raw P-256 public key (65 bytes, uncompressed point). */
  public_key: base64url,
  /** PKCS#8 private key, AES-GCM under the wrapping key. */
  wrapped_private_key: sealedSchema,
  wrap: wrapParamsSchema,
});
export type EnrolInput = z.infer<typeof enrolSchema>;

/** One way to unwrap the private key. A person may hold several. */
export interface KeyWrap {
  wrapped_private_key: Sealed;
  wrap: WrapParams;
}

/** Add a way to unwrap: the same private key, sealed under another method. */
export const addWrapSchema = z.object({
  wrapped_private_key: sealedSchema,
  wrap: wrapParamsSchema,
});
export type AddWrapInput = z.infer<typeof addWrapSchema>;

export interface StaffKey {
  email: string;
  name: string;
  suite: typeof CRYPTO_SUITE;
  public_key: string;
  /** The enrolment wrap. Kept for older clients; `wraps[0]` is the same. */
  wrapped_private_key: Sealed;
  wrap: WrapParams;
  /** Every way this key can be unwrapped, enrolment first. One per method. */
  wraps: KeyWrap[];
  created_at: string;
  updated_at: string;
}

/** What the directory lists: enough to wrap a vault key to a colleague. */
export interface DirectoryEntry {
  email: string;
  name: string;
  public_key: string;
  enrolled_at: string;
}

// ---------------------------------------------------------------------------
// Org recovery key — public half on the server, private half split offline
// ---------------------------------------------------------------------------

export const setRecoveryKeySchema = z.object({
  suite: z.literal(CRYPTO_SUITE),
  public_key: base64url,
  /** Who holds the two shares. Names, not secrets. */
  holders: z.array(emailSchema).min(2).max(2),
});

export interface RecoveryKey {
  public_key: string;
  holders: string[];
  created_by: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

export const vaultNameSchema = z.string().trim().min(1).max(120);
/** An SF Symbol name the clients agree on; the client keeps the short list. */
export const vaultIconSchema = z.string().trim().min(1).max(60).regex(/^[a-z0-9.]+$/u).nullable();
/** A Core project id, or nothing. Keep never resolves it; it is a link out. */
export const projectIDSchema = z.string().uuid().nullable();

export const memberWrapSchema = z.object({
  email: emailSchema,
  wrapped_key: wrappedToPublicKeySchema,
});

export const createVaultSchema = z.object({
  name: vaultNameSchema,
  icon: vaultIconSchema.optional(),
  project_id: projectIDSchema.optional(),
  /** Must include the caller; may include others already enrolled. */
  members: z.array(memberWrapSchema).min(1).max(50),
  /** Required once a recovery key exists; refused when none does. */
  recovery_wrapped_key: wrappedToPublicKeySchema.nullable(),
});
export type CreateVaultInput = z.infer<typeof createVaultSchema>;

export const updateVaultSchema = z.object({
  name: vaultNameSchema.optional(),
  icon: vaultIconSchema.optional(),
  project_id: projectIDSchema.optional(),
});

export const grantSchema = memberWrapSchema;

/**
 * Revocation is a rotation: the client re-seals every item under a fresh
 * vault key and wraps that key to everyone who stays. The server applies it
 * atomically or not at all, and refuses a payload that misses an item.
 */
export const rotateVaultSchema = z.object({
  /** Must be exactly current + 1. */
  key_version: z.number().int().min(2),
  members: z.array(memberWrapSchema).min(1).max(50),
  recovery_wrapped_key: wrappedToPublicKeySchema.nullable(),
  items: z.array(
    z.object({
      id: z.string().uuid(),
      sealed: sealedSchema,
    }),
  ),
});
export type RotateVaultInput = z.infer<typeof rotateVaultSchema>;

export interface VaultSummary {
  id: string;
  name: string;
  icon: string | null;
  project_id: string | null;
  key_version: number;
  /** This caller's wrapped copy of the current vault key. */
  wrapped_key: WrappedToPublicKey;
  /** Whether the current vault key is also wrapped to the recovery key. */
  recovery_wrapped: boolean;
  member_count: number;
  item_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface VaultMember {
  email: string;
  name: string;
  granted_by: string;
  created_at: string;
}

export interface VaultDetail extends VaultSummary {
  members: VaultMember[];
  items: ItemSummary[];
}

// ---------------------------------------------------------------------------
// Recovery — covering a vault, and opening one with the shares
// ---------------------------------------------------------------------------

/** A member adds the recovery wrap a vault is missing (made before the key existed). */
export const coverVaultSchema = z.object({
  recovery_wrapped_key: wrappedToPublicKeySchema,
});

/** What a recovering person sees: every vault with a recovery copy, sealed to the recovery key. */
export interface RecoveryVaultEntry {
  id: string;
  name: string;
  icon: string | null;
  project_id: string | null;
  key_version: number;
  member_count: number;
  members: string[];
  recovery_wrapped_key: WrappedToPublicKey;
}

/**
 * Join a vault through recovery: the caller opened the vault key with the
 * two shares and wraps it to their own public key. The server cannot check
 * that; it records who did it, loudly.
 */
export const recoveryJoinSchema = z.object({
  wrapped_key: wrappedToPublicKeySchema,
});

// ---------------------------------------------------------------------------
// Items — name in the clear, everything else sealed under the vault key
// ---------------------------------------------------------------------------

export const itemKinds = ['login', 'api_key', 'note', 'database', 'ssh_key', 'credit_card', 'other'] as const;
export type ItemKind = (typeof itemKinds)[number];

export const itemNameSchema = z.string().trim().min(1).max(200);

export const createItemSchema = z.object({
  name: itemNameSchema,
  kind: z.enum(itemKinds),
  /** Sealed `ItemBody`, AAD = `${vault_id}:${item_id}:${key_version}`. */
  sealed: sealedSchema,
  /** The client generates the id so it can go into the AAD before sealing. */
  id: z.string().uuid(),
  key_version: z.number().int().min(1),
});
export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = z.object({
  name: itemNameSchema.optional(),
  kind: z.enum(itemKinds).optional(),
  sealed: sealedSchema.optional(),
  key_version: z.number().int().min(1).optional(),
});

/**
 * The plaintext shape inside `sealed`. Never sent to the server as such;
 * defined here so every client agrees on the field names.
 */
export const itemBodySchema = z.object({
  username: z.string().max(500).default(''),
  password: z.string().max(4000).default(''),
  url: z.string().max(2000).default(''),
  notes: z.string().max(20_000).default(''),
  /** otpauth:// URI, when the login has a second factor. */
  totp: z.string().max(1000).default(''),
});
export type ItemBody = z.infer<typeof itemBodySchema>;

export interface ItemSummary {
  id: string;
  vault_id: string;
  name: string;
  kind: ItemKind;
  key_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
}

export interface ItemDetail extends ItemSummary {
  sealed: Sealed;
}

// ---------------------------------------------------------------------------
// Agents and machine vaults (ADR 0007 in envisioning/meet)
// ---------------------------------------------------------------------------
//
// An agent is a member that is not a person. Its name is its Meet roster
// address. Its key pair is P-256, like a person's, and its private half
// lives in the broker Worker, never in keep-api and never in the
// agent's sandbox.
//
// A machine vault has exactly one member: its agent. People add and rotate
// items in it, and nobody reads them through keep-api. A person never holds
// a machine vault's key. So a person seals each item under a fresh item key
// and wraps that item key to the agent's public key (`wrapKeyToPublicKey`).
// The item body AAD is the same as everywhere: `${vault_id}:${item_id}:${key_version}`.

/**
 * The broker's seam: register the agent's public key. The broker
 * calls `PUT /api/agent/key` with the agent's own `evk_` token (scope
 * `agent`). Set once: a second, different key is 409. A person's Revoke
 * clears it, and the broker then registers a new one.
 */
export const registerAgentKeySchema = z.object({
  suite: z.literal(CRYPTO_SUITE),
  /** Raw P-256 public key (65 bytes, uncompressed point). */
  public_key: base64url,
});
export type RegisterAgentKeyInput = z.infer<typeof registerAgentKeySchema>;

/** What Keep knows about an agent. People read this to wrap to it. */
export interface AgentSummary {
  /** The Meet roster address. */
  address: string;
  name: string;
  /** Null until the broker registers one, and again after a Revoke. */
  public_key: string | null;
  key_registered_at: string | null;
  /** Its machine vault, if a person made one. One per agent. */
  vault_id: string | null;
}

/** `GET /api/agent/me`: what an agent token sees. Never a ciphertext. */
export interface AgentSelf {
  address: string;
  name: string;
  public_key: string | null;
  key_registered_at: string | null;
  vaults: Array<{ id: string; name: string; key_version: number; member: boolean; item_count: number }>;
}

/** Create a machine vault: a fresh vault key, wrapped to the agent only. */
export const createMachineVaultSchema = z.object({
  name: vaultNameSchema,
  icon: vaultIconSchema.optional(),
  /** The agent's roster address. Its key must be registered. */
  agent: emailSchema,
  /** The new vault key, wrapped to the agent's public key. Nobody else gets a copy. */
  wrapped_key: wrappedToPublicKeySchema,
});
export type CreateMachineVaultInput = z.infer<typeof createMachineVaultSchema>;

/** Give the agent its membership again after a Revoke: a new vault key at the current version. */
export const grantAgentSchema = z.object({
  wrapped_key: wrappedToPublicKeySchema,
});

/** An item in a machine vault: the body under an item key, and the item key wrapped to the agent. */
export const createMachineItemSchema = createItemSchema.extend({
  wrapped_key: wrappedToPublicKeySchema,
});
export type CreateMachineItemInput = z.infer<typeof createMachineItemSchema>;

/** Rotate or rename. A new body travels with its new item key wrap and the current version. */
export const updateMachineItemSchema = updateItemSchema.extend({
  wrapped_key: wrappedToPublicKeySchema.optional(),
});
export type UpdateMachineItemInput = z.infer<typeof updateMachineItemSchema>;

export interface MachineVaultSummary {
  id: string;
  name: string;
  icon: string | null;
  machine: true;
  agent: { address: string; name: string; public_key: string | null };
  key_version: number;
  /** False after a Revoke, until a person grants the agent again. */
  agent_member: boolean;
  item_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MachineVaultDetail extends MachineVaultSummary {
  /** Names and who added them. Never a ciphertext, never a wrap. */
  items: ItemSummary[];
}

// ---------------------------------------------------------------------------
// Who can use it (ADR 0007 decision 7)
// ---------------------------------------------------------------------------
//
// `GET /api/vaults/:id/access[?item=]` and `/api/machine-vaults/:id/access[?item=]`.
// "Can use", not "has": with the broker, no agent holds a value.

/** One principal with standing access: a member of the vault. */
export interface AccessEntry {
  kind: 'person' | 'agent';
  /** A person's email, or an agent's Meet roster address. */
  address: string;
  name: string;
  granted_by: string;
  since: string;
  /** The last `item.reveal` or `item.use` by this principal, in the vault or on the item. */
  last_used_at: string | null;
}

/** An agent's attended release of one item (ADR 0007 decision 5): live, not ended. */
export interface ReleaseEntry {
  id: string;
  agent: { address: string; name: string };
  item_id: string;
  item_name: string;
  /** The person who approved it on their device. */
  approver: string;
  task: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

export interface VaultAccess {
  vault_id: string;
  /** Set when the list is for one item. */
  item_id: string | null;
  /** Members who are people. A machine vault has none. */
  people: AccessEntry[];
  /** Agents with standing access: a machine vault's agent, while it is a member. */
  agents: AccessEntry[];
  /** Live releases: not ended and not expired. A client draws the section only when present and not empty. */
  releases?: ReleaseEntry[];
}

// ---------------------------------------------------------------------------
// Attended releases (ADR 0007 decisions 5 and 10 to 12)
// ---------------------------------------------------------------------------
//
// An agent asks for one item in a Meet thread, with a P-256 public key it
// made for that one request (the session key). A member of the item's vault
// approves on their own device. That device opens the item, seals its body
// under a fresh release key, and wraps the release key to the session key.
// Keep stores only that sealed body and that wrap, and hands them to the
// named agent once, before the expiry. Keep never sees the value.
//
//   release key   32 random bytes, AES-256-GCM, used once.
//   body          the item's `ItemBody` JSON, AAD = `release:${release_id}:${vault_id}:${item_id}`.
//   wrap          `wrapKeyToPublicKey(release key, session public key)`, as for a person.
//
// Why the body and not a key: a person's vault seals every item under the
// vault key, and that key opens every item in the vault. Wrapping it would
// release the whole vault. A one-time key over one body releases one item.

/** The fewest and most seconds a release may live. 15 minutes is the client's default. */
export const RELEASE_MIN_SECONDS = 60;
export const RELEASE_MAX_SECONDS = 24 * 60 * 60;
export const RELEASE_DEFAULT_SECONDS = 15 * 60;

export const releaseTaskSchema = z.string().trim().min(1).max(500);

/**
 * `POST /api/vaults/:id/releases`, from the approving member's device. The
 * id is the request id the agent chose in its card, so the agent knows what
 * to fetch, and it is in the body's AAD before sealing.
 */
const lowerUUID = z.string().trim().toLowerCase().uuid();

export const createReleaseSchema = z.object({
  id: lowerUUID,
  item_id: lowerUUID,
  /** The agent's Meet roster address. Keep must know the agent. */
  agent: emailSchema,
  task: releaseTaskSchema,
  reason: z.string().trim().max(1000).optional(),
  /** Raw P-256 public key the agent made for this one request. */
  session_public_key: base64url,
  expires_in_seconds: z.number().int().min(RELEASE_MIN_SECONDS).max(RELEASE_MAX_SECONDS),
  /** The item body under the release key, AAD = `release:${id}:${vault_id}:${item_id}`. */
  sealed: sealedSchema,
  /** The release key, wrapped to `session_public_key`. */
  wrapped_key: wrappedToPublicKeySchema,
});
export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;

export const releaseStatuses = ['live', 'used', 'ended', 'expired'] as const;
export type ReleaseStatus = (typeof releaseStatuses)[number];

/** One release as people see it. Never the sealed body, never the wrap. */
export interface ReleaseSummary {
  id: string;
  vault_id: string;
  item_id: string;
  item_name: string;
  agent: { address: string; name: string };
  approver: string;
  task: string;
  reason: string | null;
  status: ReleaseStatus;
  created_at: string;
  expires_at: string;
  fetched_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
}

/**
 * `POST /api/agent/releases/:id/fetch`, with the named agent's token: the
 * payload, once, before the expiry. The agent checks `vault_id`, `item_id`
 * and `session_public_key` against its own request before it opens anything.
 */
export interface ReleasePayload {
  release: ReleaseSummary;
  session_public_key: string;
  sealed: Sealed;
  wrapped_key: WrappedToPublicKey;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditKinds = [
  'enrol',
  'vault.create',
  'vault.update',
  'vault.grant',
  'vault.rotate',
  'vault.delete',
  'item.create',
  'item.reveal',
  'item.update',
  'item.delete',
  'recovery.set',
  'vault.cover',
  'recovery.list',
  'recovery.join',
  // Agents (ADR 0007). `agent.key`: the broker registered the
  // agent's public key. `agent.revoke`: a person ended the agent's standing
  // access. `item.use`: one row per use (the broker, or a release fetch).
  'agent.key',
  'agent.revoke',
  'item.use',
  // Releases. `release.approve`: a member released one item to one
  // agent. The agent's fetch is `item.use`. `release.end`: ended early.
  'release.approve',
  'release.end',
] as const;
export type AuditKind = (typeof auditKinds)[number];

export interface AuditEvent {
  id: string;
  vault_id: string | null;
  item_id: string | null;
  /** Snapshot: survives the item's deletion. */
  item_name: string | null;
  actor: string;
  kind: AuditKind;
  ip: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Sessions and errors
// ---------------------------------------------------------------------------

export interface StaffSession {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export type KeepErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_request'
  | 'rate_limited'
  | 'not_configured'
  | 'oauth_failed'
  | 'not_enrolled'
  | 'stale_rotation'
  /** A release that was fetched, ended or expired (410). */
  | 'release_closed'
  | 'internal';

export interface KeepErrorBody {
  error: string;
  code: KeepErrorCode;
  request_id?: string;
}

// ---------------------------------------------------------------------------
// Device tokens — the native client's credential
// ---------------------------------------------------------------------------

/** Recognisable on sight and greppable in logs. */
export const DEVICE_TOKEN_PREFIX = 'evk_';
export const DEVICE_TOKEN_DAYS = 90;

/**
 * What a device token reaches. `person`: everything its owner reaches.
 * `agent`: only that agent's own routes (`/api/agent/*`) and, through them,
 * only that agent's machine vault. An agent token never reaches a person's
 * vault, the directory, the audit trail or any other agent.
 */
export const deviceTokenScopes = ['person', 'agent'] as const;
export type DeviceTokenScope = (typeof deviceTokenScopes)[number];

/**
 * What the Meet Worker sends, HMAC-signed with KEEP_INTERNAL_SECRET. For an
 * agent, `email` is its Meet roster address (`AGENT_ROSTER`) and `scope` is
 * `agent`. Meet's signature is the proof that the address is on its roster.
 */
export const meetExchangeSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(200),
  device_name: z.string().trim().min(1).max(120),
  scope: z.enum(deviceTokenScopes).default('person'),
});

export interface MeetExchangeResponse {
  token: string;
  expires_at: string;
  email: string;
  scope: DeviceTokenScope;
}

export interface DeviceTokenSummary {
  id: string;
  name: string;
  device_name: string;
  scope: DeviceTokenScope;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

// Central sign-in through the auth host, as the workspace's Keep (a copy of Meet's contract).
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
