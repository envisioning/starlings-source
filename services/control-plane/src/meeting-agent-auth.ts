import { builtInAgentInstallationSchema, type BuiltInAgentInstallation, type MeetingAgentPolicyFacts } from '@starlings/contracts/built-in-agent';
import { constantTimeEqualSync, hmacSHA256Hex, openSecret } from './crypto';
import { AuthError, ControlError } from './errors';
import { assertUnderRateLimit, readBoundedText } from './http';
import { INTERNAL_SIGNATURE_SKEW_MILLISECONDS } from './contracts';
import { subjectAccessFor, type SubjectKey } from './subject-access';
import type { RoleSession } from './capabilities';

/** Persisted once by the installer, not inferred from a mutable name or runtime request. */
export const MEETING_AGENT_WORKSPACE_KEY = 'meeting_agent_workspace_id';
export async function meetingAgentWorkspaceId(env: Env): Promise<string> {
  const row = await env.USAGE.prepare('SELECT value FROM workspace_settings WHERE key = ?1')
    .bind(MEETING_AGENT_WORKSPACE_KEY).first<{ value: string }>();
  if (!row?.value) throw new ControlError('Meeting assistance is not installed.', 404, 'room_not_found');
  return row.value;
}

/** Fresh D1 reads only: the roster's cached availability fallback is not an authorization fact. */
export async function meetingAgentInstallation(env: Env, installationId: string): Promise<BuiltInAgentInstallation> {
  const row = await env.USAGE.prepare(`
    SELECT i.id, i.workspace_id, i.role, i.state, a.sub AS agent_sub, a.email AS agent_email,
           a.name AS display_name, p.kind, p.revoked_at AS agent_revoked, a.removed_at AS roster_removed, i.removed_at,
           EXISTS (SELECT 1 FROM agent_freezes f WHERE f.agent_sub = a.sub) AS frozen
    FROM built_in_agent_installations i JOIN agents a ON a.sub = i.agent_sub
    JOIN people p ON p.sub = a.sub AND p.kind = 'agent'
    WHERE i.id = ?1 AND a.source = 'enrolled'`).bind(installationId).first<{
      id: string; workspace_id: string; role: string; state: string; agent_sub: string;
      agent_email: string; display_name: string; kind: string; roster_removed: number | null;
      removed_at: number | null; agent_revoked: number | null; frozen: number;
    }>();
  if (!row) throw new AuthError('No managed meeting agent.', 403, 'capability_denied');
  return builtInAgentInstallationSchema.parse({
    id: row.id, workspace_id: row.workspace_id, role: row.role, kind: row.kind,
    source: 'starlings_managed', agent_sub: row.agent_sub, agent_email: row.agent_email,
    display_name: row.display_name,
    state: row.roster_removed !== null || row.removed_at !== null || row.agent_revoked !== null ? 'removed' : row.frozen ? 'frozen' : row.state,
  });
}

export async function meetingAgentHumanFacts(env: Env, actorSub: string, agentSub: string, subject: SubjectKey | null): Promise<{
  human: MeetingAgentPolicyFacts['human']; subject_access: MeetingAgentPolicyFacts['subject_access'];
}> {
  const human = await env.USAGE.prepare('SELECT sub, email, name, kind, role, revoked_at FROM people WHERE sub = ?1')
    .bind(actorSub).first<{ sub: string; email: string; name: string | null; kind: string; role: string; revoked_at: number | null }>();
  if (!human) throw new AuthError('The authorizing person is unavailable.', 403, 'capability_denied');
  // Supply the fresh role so the access view cannot consult the general session role cache.
  const session: RoleSession = { sub: human.sub, email: human.email, name: human.name ?? '', agentSub,
    role: human.role === 'admin' ? 'admin' : human.role === 'member' ? 'member' : 'community' };
  // A new session object per check prevents request-memo reuse at commit time.
  const access = subject ? await subjectAccessFor(env, session) : null;
  const level = subject && access ? access.levelOf(subject.kind, subject.id) : null;
  return {
    human: { sub: human.sub, kind: human.kind, role: human.role, revoked: human.revoked_at !== null },
    subject_access: level ? { human: level, agent: level } : null,
  };
}

/** This narrow door reuses enrolled keys, with purpose/path bound into the signature. */
export async function signedMeetingAgentBody(request: Request, env: Env): Promise<{ agent_sub: string; raw_body: string }> {
  if (request.headers.has('authorization')) throw new AuthError('An agent does not carry a session.', 403, 'owner_auth_required');
  const keyId = (request.headers.get('x-internal-key-id') ?? '').trim().toLowerCase();
  if (!keyId) throw new ControlError('Not found.', 404, 'room_not_found');
  await assertUnderRateLimit(env.AGENT_LIMIT, request, 'meeting-agent', keyId);
  const row = await env.USAGE.prepare(`SELECT a.sub, a.inbound_key_iv AS iv, a.inbound_key_sealed AS ciphertext
    FROM agents a JOIN built_in_agent_installations i ON i.agent_sub = a.sub
    JOIN people p ON p.sub = a.sub AND p.kind = 'agent'
    WHERE a.email = ?1 AND a.source = 'enrolled' AND a.removed_at IS NULL AND p.revoked_at IS NULL
      AND i.removed_at IS NULL AND i.workspace_id = (SELECT value FROM workspace_settings WHERE key = ?2)`)
    .bind(keyId, MEETING_AGENT_WORKSPACE_KEY).first<{ sub: string; iv: string | null; ciphertext: string | null }>();
  if (!row?.iv || !row.ciphertext || !env.GOOGLE_TOKEN_ENCRYPTION_KEY) throw new AuthError('Unknown key.', 403, 'owner_auth_required');
  const secret = await openSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, { iv: row.iv, ciphertext: row.ciphertext });
  if (secret.length < 32) throw new AuthError('Unknown key.', 403, 'owner_auth_required');
  const timestamp = request.headers.get('x-internal-timestamp') ?? '';
  const signature = request.headers.get('x-internal-signature') ?? '';
  if (!timestamp || !signature || !Number.isFinite(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp)) > INTERNAL_SIGNATURE_SKEW_MILLISECONDS) {
    throw new AuthError('Request is not signed or has expired.', 403, 'owner_auth_required');
  }
  const raw_body = await readBoundedText(request, 200_000);
  const path = new URL(request.url).pathname;
  const expected = await hmacSHA256Hex(secret, `${timestamp}.meeting-agent.${request.method}.${path}.${raw_body}`);
  if (!constantTimeEqualSync(expected, signature.trim().toLowerCase())) throw new AuthError('Signature does not match.', 403, 'owner_auth_required');
  return { agent_sub: row.sub, raw_body };
}
