// The workspace's door for its own services (docs/CENTRAL_AUTH.md
// "Services"). Docs and Keep sign in through the auth host as this
// workspace; on every redeem they call `MemberService.check` over a service
// binding named `MEET`, so one person's access ends in every service when it
// ends here. The entrypoint has no URL and no route, so nothing on the
// internet reaches it.
//
// It answers allow or refuse, and why, and nothing else: no row, no role,
// no name leaves this file.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { memberCheckInputSchema, type MemberCheckResult } from '@starlings/contracts/browser-auth';
import { refuseBlockedPerson } from './auth';
import { AuthError } from './errors';
import { isWorkspaceMember } from './invitations';
import { isMemberEmail, isMemberHostedDomain } from './workspace-identity';

/**
 * The workspace's sign-in rules for an identity the auth Worker proved: the
 * same checks `completeCentralWebAuth` runs before it sets a session.
 */
export async function checkMember(env: Env, raw: unknown): Promise<MemberCheckResult> {
  const parsed = memberCheckInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_request' };
  const { sub, email, hd } = parsed.data;
  if (!isMemberHostedDomain(env, hd) || !isMemberEmail(env, email)) return { ok: false, reason: 'not_member' };
  // On an invite workspace the domain admits only a root admin or an invited address.
  if (!(await isWorkspaceMember(env, email.toLowerCase()))) return { ok: false, reason: 'not_member' };
  try {
    await refuseBlockedPerson(env, { sub, email: email.toLowerCase() });
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, reason: 'blocked' };
    throw error;
  }
  return { ok: true };
}

export class MemberService extends WorkerEntrypoint<Env> {
  /** May this proven identity sign in to one of this workspace's services? The input is validated here, not trusted. */
  async check(input: unknown): Promise<MemberCheckResult> {
    return checkMember(this.env, input);
  }
}
