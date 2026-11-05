// A person in outreach makes their organization a prospect (decided by MZ,
// 2026-11-05). A prospect is a lead: `source = 'signals'`, the one filter. A
// Signals customer is a licence, so an organization with an active Signals
// licence gets no lead. Outreach state stays on the contact.
//
// The D1 contact write (`work-d1.ts`) calls this under the condition Core's
// `trg_contacts_ensure_signals_account` had.
import { SIGNALS_LEAD_SOURCE } from '@starlings/contracts/licenses';
import { recordFailure } from './ops';
import { recordWorkActivity } from './work-activity';
import { usesCore, usesCoreFor } from './work-store';

const OUTREACH_WRITER = 'outreach@starlings.invalid';

/**
 * A `WORK_STORE=d1` workspace has no Signals outreach and does nothing. The
 * contact write stands whatever happens here: a failure counts under
 * `signals_lead_ensure` (docs/OPERATIONS.md), and the insert finds a lead it
 * made, so the contact's next write of these columns tries again.
 */
export async function ensureSignalsLeadForContact(
  env: Env,
  contact: { id: string; organization_id: string | null; signals_outreach_status?: string | null | undefined },
): Promise<void> {
  if (!usesCore(env) || usesCoreFor(env, 'subjects')) return;
  const status = contact.signals_outreach_status;
  if (!contact.organization_id || !status || status === 'not_interested') return;
  try {
    // While Core holds the commercial group its licences are not here, and a lead for a customer is harmless.
    if (!usesCoreFor(env, 'commercial')) {
      const customer = await env.USAGE.prepare(`SELECT 1 AS one FROM licenses WHERE organization_id = ?1 AND product = 'signals' AND is_active = 1 LIMIT 1`)
        .bind(contact.organization_id).first('one');
      if (customer) return;
    }
    const name = await env.USAGE.prepare('SELECT name FROM organizations WHERE id = ?1').bind(contact.organization_id).first<string>('name');
    if (!name) return;
    const id = crypto.randomUUID();
    const now = Date.now();
    const title = `${name} · Signals`;
    const inserted = await env.USAGE.prepare(
      `INSERT INTO leads (id, organization_id, contact_id, title, status, start_date, source, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'Conversations', ?5, ?6, ?7, ?7
        WHERE NOT EXISTS (SELECT 1 FROM leads WHERE organization_id = ?2 AND source = ?6)`,
    ).bind(id, contact.organization_id, contact.id, title, new Date(now).toISOString().slice(0, 10), SIGNALS_LEAD_SOURCE, now).run();
    if (inserted.meta.changes) {
      await recordWorkActivity(env, { actor: OUTREACH_WRITER, table: 'leads', id, action: 'insert', label: title, fields: ['contact_id', 'organization_id', 'source', 'status', 'title'] });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: 'error', message: 'signals.lead_ensure.failed', contact_id: contact.id, organization_id: contact.organization_id, error: message }));
    await recordFailure(env, 'signals_lead_ensure', `contact ${contact.id}: ${message}`);
  }
}
