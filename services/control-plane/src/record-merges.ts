// Merging duplicate organizations, contacts and leads on D1 (,
// docs/CORE_FOLD_PLAN.md Phase 4). `mergeCoreRecords` (crm.ts) sends a merge
// here once the `subjects` group answers from D1; before that, Core merges.
//
// As Core does: the oldest record survives, every link from the others moves
// onto it, a merged contact's addresses become the survivor's, and the others
// are deleted. The survivor's own fields stand, but a survivor with no Signals
// outreach status or notified date takes the oldest merged contact's. One D1
// batch holds the whole merge, so it lands whole or not at all. On a Core
// workspace, Core's kept tables follow (`core-merge-repoint.ts`).
//
// Each merge is recorded in `record_merges` (migration 0129). A group that has
// not moved yet still holds Core rows that name a merged id; its copy maps
// them to the survivor (`mergedInto`, read by work-group-moves.ts).

import type { CoreMergeEntity } from '@starlings/contracts/core-fields';
import { refuseCoreMergeConflict, repointCoreMerge } from './core-merge-repoint';
import { ControlError } from './errors';
import { personIdForEmail } from './person-ids';
import { ensureSignalsLeadForContact } from './signals-outreach';

/** Plain columns that name a row of the entity. One UPDATE each. */
export const MERGE_COLUMNS: Record<CoreMergeEntity, ReadonlyArray<readonly [table: string, column: string]>> = {
  organizations: [
    ['contacts', 'organization_id'],
    ['leads', 'organization_id'],
    ['projects', 'organization_id'],
    ['tasks', 'organization_id'],
    ['events', 'organization_id'],
    ['granola_suggestions', 'organization_id'],
    ['support_lines', 'organization_id'],
    ['interactions', 'organization_id'],
    ['offers', 'organization_id'],
    ['licenses', 'organization_id'],
    ['policies', 'organization_id'],
  ],
  contacts: [
    ['leads', 'contact_id'],
    ['tasks', 'contact_id'],
    ['contact_emails', 'contact_id'],
    ['form_submissions', 'contact_id'],
    ['interactions', 'contact_id'],
    ['interaction_subjects', 'via_contact_id'],
  ],
  leads: [
    ['projects', 'lead_id'],
    ['tasks', 'lead_id'],
    ['interest_submissions', 'lead_id'],
    ['form_submissions', 'lead_id'],
    ['offers', 'lead_id'],
    ['licenses', 'lead_id'],
  ],
};

/** Junction tables keyed on the pair: a pair the survivor has already is dropped, not doubled. */
export const MERGE_PAIRS: Record<CoreMergeEntity, ReadonlyArray<readonly [table: string, column: string]>> = {
  organizations: [],
  contacts: [['project_contacts', 'contact_id'], ['interaction_contacts', 'contact_id'], ['partner_agreement_signatures', 'contact_id']],
  leads: [],
};

/**
 * Tables that name a subject by kind and id. `unique` tables have the pair in
 * their key: a row the survivor has already wins. On `subject_visibility`
 * that keeps a restriction either record had, never widens one.
 */
export const SUBJECT_REFERENCES: ReadonlyArray<{ table: string; kind: string; id: string; unique: boolean }> = [
  { table: 'interaction_subjects', kind: 'subject_kind', id: 'subject_id', unique: true },
  { table: 'subject_state', kind: 'kind', id: 'subject_id', unique: true },
  { table: 'subject_visibility', kind: 'kind', id: 'subject_id', unique: true },
  { table: 'decisions', kind: 'subject_kind', id: 'subject_id', unique: false },
  { table: 'decision_asks', kind: 'subject_kind', id: 'subject_id', unique: false },
  { table: 'support_requests', kind: 'subject_kind', id: 'subject_id', unique: false },
  { table: 'meeting_follow_ups', kind: 'subject_kind', id: 'subject_id', unique: false },
  { table: 'card_holds', kind: 'subject_kind', id: 'subject_id', unique: false },
  { table: 'granola_suggestions', kind: 'subject_kind', id: 'subject_id', unique: false },
  { table: 'import_mappings', kind: 'subject_kind', id: 'subject_id', unique: false },
];

/** The subject kind of each entity; a contact is not a subject. */
const SUBJECT_KIND: Record<CoreMergeEntity, string | null> = { organizations: 'organization', leads: 'lead', contacts: null };
/** The favorite kind that pins the entity by its bare id (favorites.ts). */
const FAVORITE_KIND: Record<CoreMergeEntity, string | null> = { organizations: 'crm.partner', leads: 'crm.lead', contacts: null };

export interface D1MergeResult {
  entity: CoreMergeEntity;
  kept: string;
  merged: string[];
}

/** Every statement of one merge of `from` into `into`, in order: links first, the delete last. */
export function mergeStatements(
  env: Env,
  entity: CoreMergeEntity,
  into: string,
  from: readonly string[],
  mergedBy: string | null,
  now: number,
): D1PreparedStatement[] {
  const ids = JSON.stringify(from);
  const inFrom = 'IN (SELECT value FROM json_each(?2))';
  const run = (sql: string, ...more: unknown[]) => env.USAGE.prepare(sql).bind(into, ids, ...more);
  const statements: D1PreparedStatement[] = [];

  // A merged contact's addresses become the survivor's (Core keeps them as aliases).
  if (entity === 'contacts') {
    statements.push(run(
      `INSERT OR IGNORE INTO contact_emails (email, contact_id, created_at)
       SELECT lower(trim(email)), ?1, ?3 FROM contacts WHERE id ${inFrom} AND email IS NOT NULL AND trim(email) <> ''`,
      now,
    ));
    // Every source fact moves onto the survivor and stays. A fact whose dedupe
    // key the survivor (or an older moved row) holds already gets the moved
    // row's id appended, as Core's repoint trigger does.
    statements.push(run(
      `UPDATE contact_source_events SET dedupe_key = substr(dedupe_key, 1, 240) || ':merged:' || id
        WHERE contact_id ${inFrom} AND EXISTS (
          SELECT 1 FROM contact_source_events other
           WHERE other.dedupe_key = contact_source_events.dedupe_key AND other.id <> contact_source_events.id
             AND (other.contact_id = ?1 OR (other.contact_id ${inFrom} AND other.id < contact_source_events.id)))`,
    ));
    statements.push(run(`UPDATE contact_source_events SET contact_id = ?1 WHERE contact_id ${inFrom}`));
    // Signals outreach follows Core's merge_contacts: the survivor's stands, else the oldest merged contact's.
    statements.push(run(
      `UPDATE contacts SET
         signals_outreach_status = coalesce(nullif(signals_outreach_status, ''),
           (SELECT c.signals_outreach_status FROM contacts c WHERE c.id ${inFrom} AND nullif(c.signals_outreach_status, '') IS NOT NULL ORDER BY c.created_at, c.id LIMIT 1),
           signals_outreach_status),
         signals_notified_at = coalesce(signals_notified_at,
           (SELECT c.signals_notified_at FROM contacts c WHERE c.id ${inFrom} AND c.signals_notified_at IS NOT NULL ORDER BY c.created_at, c.id LIMIT 1))
       WHERE id = ?1`,
    ));
  }
  // A merged partner keeps the survivor a partner, so its own tasks stay on the board.
  if (entity === 'organizations') {
    statements.push(run(`UPDATE organizations SET is_partner = 1 WHERE id = ?1 AND EXISTS (SELECT 1 FROM organizations WHERE id ${inFrom} AND is_partner = 1)`));
  }
  for (const [table, column] of MERGE_COLUMNS[entity]) {
    statements.push(run(`UPDATE "${table}" SET "${column}" = ?1 WHERE "${column}" ${inFrom}`));
  }
  for (const [table, column] of MERGE_PAIRS[entity]) {
    statements.push(run(`UPDATE OR IGNORE "${table}" SET "${column}" = ?1 WHERE "${column}" ${inFrom}`));
    statements.push(run(`DELETE FROM "${table}" WHERE "${column}" ${inFrom}`));
  }
  const kind = SUBJECT_KIND[entity];
  if (kind) {
    for (const ref of SUBJECT_REFERENCES) {
      const where = `"${ref.kind}" = ?3 AND "${ref.id}" ${inFrom}`;
      statements.push(run(`UPDATE ${ref.unique ? 'OR IGNORE ' : ''}"${ref.table}" SET "${ref.id}" = ?1 WHERE ${where}`, kind));
      if (ref.unique) statements.push(run(`DELETE FROM "${ref.table}" WHERE ${where}`, kind));
    }
    // A live grant the survivor holds for the same principal already: the
    // merged one is revoked, so the trail stays and the live index holds.
    statements.push(run(
      `UPDATE subject_grants SET revoked_at = ?4
        WHERE kind = ?3 AND subject_id ${inFrom} AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM subject_grants s WHERE s.kind = ?3 AND s.subject_id = ?1 AND s.revoked_at IS NULL
                        AND s.principal_kind = subject_grants.principal_kind AND s.principal_id = subject_grants.principal_id)`,
      kind, now,
    ));
    // Two merged records can grant the same principal: the first one moves, the rest are revoked.
    statements.push(run(
      `UPDATE subject_grants SET revoked_at = ?4
        WHERE kind = ?3 AND subject_id ${inFrom} AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM subject_grants s WHERE s.kind = ?3 AND s.subject_id ${inFrom} AND s.revoked_at IS NULL
                        AND s.principal_kind = subject_grants.principal_kind AND s.principal_id = subject_grants.principal_id
                        AND s.id < subject_grants.id)`,
      kind, now,
    ));
    statements.push(run(`UPDATE subject_grants SET subject_id = ?1 WHERE kind = ?3 AND subject_id ${inFrom}`, kind));
  }
  const favoriteKind = FAVORITE_KIND[entity];
  if (favoriteKind) {
    statements.push(run(`UPDATE OR IGNORE favorites SET target_ref = ?1 WHERE kind = ?3 AND target_ref ${inFrom}`, favoriteKind));
    statements.push(run(`DELETE FROM favorites WHERE kind = ?3 AND target_ref ${inFrom}`, favoriteKind));
  }
  // A pinned record (`core.record`, `<entity>:<id>`).
  statements.push(run(
    `UPDATE OR IGNORE favorites SET target_ref = ?3 || ':' || ?1
      WHERE kind = 'core.record' AND target_ref IN (SELECT ?3 || ':' || value FROM json_each(?2))`,
    entity,
  ));
  statements.push(run(`DELETE FROM favorites WHERE kind = 'core.record' AND target_ref IN (SELECT ?3 || ':' || value FROM json_each(?2))`, entity));

  // The record of the merge, and a chain: what pointed at a merged id points at the survivor.
  statements.push(run(`UPDATE record_merges SET into_id = ?1 WHERE entity = ?3 AND into_id ${inFrom}`, entity));
  statements.push(run(
    `INSERT INTO record_merges (entity, from_id, into_id, merged_by, merged_at)
     SELECT ?3, value, ?1, ?4, ?5 FROM json_each(?2) WHERE true
     ON CONFLICT (entity, from_id) DO UPDATE SET into_id = excluded.into_id, merged_by = excluded.merged_by, merged_at = excluded.merged_at`,
    entity, mergedBy, now,
  ));
  statements.push(run(`DELETE FROM "${entity}" WHERE id ${inFrom}`));
  return statements;
}

/**
 * Merge two to ten records of one entity on D1. The route already checked
 * the ids' shape and the member's write access to each.
 */
export async function d1MergeRecords(env: Env, actorEmail: string, entity: CoreMergeEntity, ids: readonly string[]): Promise<D1MergeResult> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
  const { results } = await env.USAGE.prepare(
    `SELECT id FROM "${entity}" WHERE lower(id) IN (SELECT value FROM json_each(?1)) ORDER BY created_at, id`,
  ).bind(JSON.stringify(wanted)).all<{ id: string }>();
  if (results.length !== wanted.length) throw new ControlError('One of those records does not exist on this workspace.', 404, 'request_not_found');
  if (results.length < 2) throw new ControlError('A merge takes at least two records.', 400, 'invalid_request');
  const [kept, ...merged] = results.map((row) => row.id);
  if (entity === 'organizations') {
    // A peer's credential is its own; merging it away would cut the peer off or hand it a second record.
    const peer = await env.USAGE.prepare('SELECT organization_id FROM peer_credentials WHERE organization_id IN (SELECT value FROM json_each(?1)) LIMIT 1')
      .bind(JSON.stringify(merged)).first<{ organization_id: string }>();
    if (peer) throw new ControlError('An organization that is a peer cannot be merged into another. Revoke its peer credential first, or keep it as the survivor.', 409, 'invalid_request');
  }
  const repoint = { entity, into_id: kept!, from_ids: merged };
  await refuseCoreMergeConflict(env, repoint);
  const mergedBy = await personIdForEmail(env, actorEmail);
  await env.USAGE.batch(mergeStatements(env, entity, kept!, merged, mergedBy, Date.now()));
  await repointCoreMerge(env, repoint);
  if (entity === 'contacts') {
    // A survivor that took an outreach status enters outreach, as Core's trigger saw on merge_contacts.
    const survivor = await env.USAGE.prepare('SELECT id, organization_id, signals_outreach_status FROM contacts WHERE id = ?1')
      .bind(kept).first<{ id: string; organization_id: string | null; signals_outreach_status: string | null }>();
    if (survivor) await ensureSignalsLeadForContact(env, survivor);
  }
  return { entity, kept: kept!, merged };
}

/** Every recorded merge, as `<entity>:<from id>` to the survivor's id. */
export async function mergedInto(env: Env): Promise<Map<string, string>> {
  const { results } = await env.USAGE.prepare('SELECT entity, from_id, into_id FROM record_merges')
    .all<{ entity: string; from_id: string; into_id: string }>();
  return new Map(results.map((row) => [`${row.entity}:${row.from_id}`, row.into_id]));
}

/**
 * The record a merged id became, or null when the id was never merged
 *. A merge flattens its chain, but a Core alias copied in may
 * still point at a record merged later; the walk follows that, a few hops.
 */
export async function survivorOf(env: Env, entity: CoreMergeEntity, id: string): Promise<string | null> {
  let current = id;
  for (let hop = 0; hop < 8; hop += 1) {
    const next = await env.USAGE.prepare('SELECT into_id FROM record_merges WHERE entity = ?1 AND from_id = ?2')
      .bind(entity, current).first<{ into_id: string }>();
    if (!next || next.into_id === current) break;
    current = next.into_id;
  }
  return current === id ? null : current;
}
