import { INBOX_SOURCES, type InboxSource } from '@starlings/contracts/inbox';
import { roleAllows, type RoleSession } from './capabilities';
import { isBootstrapAdminEmail } from './auth';
import { inboundMailbox } from './inbound-address';
import { formsFor } from '@starlings/contracts/forms';
import { workspaceSlug } from './workspace-origins';
import type { WorkModule } from '@starlings/contracts/work-modules';

/**
 * Source eligibility is account-aware, not a client-side convention. The
 * preference map answers "does this person want it?"; this answer is "may
 * this person ever receive it?" and is returned to Settings for parity.
 */
/** An org admin, or the bootstrap admin address: who reads admin-only sources. */
export function isInboxAdmin(env: Env, owner: RoleSession): boolean {
  return owner.role === 'admin' || isBootstrapAdminEmail(env, owner.email);
}

export function availableInboxSources(env: Env, owner: RoleSession, modules: readonly WorkModule[]): InboxSource[] {
  const isOrgAdmin = isInboxAdmin(env, owner);
  const hasCalendar = roleAllows(owner.role, 'calendar');
  return INBOX_SOURCES.filter((source) => {
    if (source === 'interest') return isOrgAdmin;
    // A form's submissions go to the people it names (docs/FORMS.md).
    if (source === 'submission') return formsFor(workspaceSlug(env)).some((form) => isOrgAdmin || form.audience === 'members');
    if (source === 'invitation') return hasCalendar;
    // Offers and licenses come due only where a work module holds them.
    if (source === 'commercial') return modules.includes('offers') || modules.includes('licenses');
    // Events from email need `<slug>.calendar@`, which exists only while this
    // workspace takes mail; until then Settings does not offer it.
    if (source === 'forwarded') return hasCalendar && inboundMailbox(env) !== null;
    return true;
  });
}
