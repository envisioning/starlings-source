// Per-user subject state — star / mute per owner per subject, and the SALES
// opt-in ( decision 5, slice 2; follow removed
// 2026-09-15). Reader state, kept here rather than in Core: Core says what a
// subject is, this says what one person wants from it. Subject rows are
// overrides only; a subject with no row is plain. Work preferences resolve
// their shared defaults before the response leaves the Worker.

import {
  isDefaultOverride,
  resolveWorkList,
  type SubjectStateResponse,
  type SubjectStateRow,
  type SubjectStateUpdate,
  type WorkListPreferences,
  type WorkPreferencesUpdate,
} from '@starlings/contracts/subject-state';
import { WORK_STAGES, type WorkStage } from '@starlings/contracts/work-items';
import {
  INBOX_SOURCES,
  normalizeInboxSourceOverrides,
  normalizeInboxSourcePreferences,
  resolveInboxSources,
  type InboxSource,
  type InboxSourcePreferences,
} from '@starlings/contracts/inbox';
import type { PersonRole } from './capabilities';
import { favoriteKindForSubject, favoriteSyncStatements } from './favorite-sync';
import { ensurePersonId } from './person-ids';
import { d1FavoriteStatement } from './work-d1';
import { usesCoreFor } from './work-store';
import { assertGroupWritable } from './work-freeze';
import { workModulesOn } from './work-modules';
import { SUBJECT_KINDS } from '@starlings/contracts/subject-kinds';

type SubjectKind = SubjectStateRow['kind'];

interface StateRow {
  kind: SubjectKind;
  subject_id: string;
  starred: number;
  muted: number;
  updated_at: number;
}

function toRow(row: StateRow): SubjectStateRow {
  return {
    kind: row.kind,
    id: row.subject_id,
    starred: row.starred === 1,
    muted: row.muted === 1,
    updated_at: row.updated_at,
  };
}

/**
 * The SALES opt-in and the SUBJECTS list preferences. `work_list` is
 * stored JSON and resolved field by field on every read: a row an older
 * build wrote, or one that names an option this build dropped, reads as the
 * default for that field alone (`resolveWorkList`).
 */
async function workPreferences(env: Env, sub: string): Promise<{ sales: boolean; hiddenKinds: SubjectKind[]; workList: WorkListPreferences; inboxSources: InboxSourcePreferences; boardHiddenStages: WorkStage[] }> {
  const row = await env.USAGE.prepare('SELECT sales_enabled, hidden_kinds, work_list, inbox_sources, board_hidden_stages FROM work_preferences WHERE sub = ?1')
    .bind(sub)
    .first<{ sales_enabled: number; hidden_kinds: string | null; work_list: string | null; inbox_sources: string | null; board_hidden_stages: string | null }>();
  const parse = (text: string | null | undefined): unknown => {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  const sales = row?.sales_enabled === 1;
  // Leads live in `sales_enabled`; the other kinds in `hidden_kinds`.
  const stored = parse(row?.hidden_kinds);
  const others = Array.isArray(stored) ? SUBJECT_KINDS.filter((kind) => kind !== 'lead' && stored.includes(kind)) : [];
  // A stage this build no longer knows is dropped, not refused.
  const hiddenStages = parse(row?.board_hidden_stages);
  return {
    sales,
    hiddenKinds: sales ? others : ['lead', ...others],
    workList: resolveWorkList(parse(row?.work_list)),
    // Return resolved values so older clients, which carry their defaults in
    // the app, display the Worker's current defaults too. Normalize away the
    // `mention` alias because it follows `talk` and is not a stored setting.
    inboxSources: normalizeInboxSourcePreferences(resolveInboxSources(parse(row?.inbox_sources))),
    boardHiddenStages: Array.isArray(hiddenStages) ? WORK_STAGES.filter((stage) => hiddenStages.includes(stage)) : [],
  };
}

/** Everything one person has said about subjects, their SALES opt-in, and how their list reads. */
export async function readSubjectState(
  env: Env,
  sub: string,
  role: PersonRole,
  availableInboxSources: InboxSource[] = [...INBOX_SOURCES],
): Promise<SubjectStateResponse> {
  const [prefs, states, modules] = await Promise.all([
    workPreferences(env, sub),
    env.USAGE.prepare(
      'SELECT kind, subject_id, starred, muted, updated_at FROM subject_state WHERE sub = ?1 ORDER BY updated_at DESC',
    ).bind(sub).all<StateRow>(),
    workModulesOn(env),
  ]);
  return {
    role,
    sales_enabled: prefs.sales,
    hidden_kinds: prefs.hiddenKinds,
    work_list: prefs.workList,
    inbox_sources: prefs.inboxSources,
    inbox_available_sources: availableInboxSources,
    work_modules: modules,
    board_hidden_stages: prefs.boardHiddenStages,
    states: (states.results ?? []).map(toRow),
  };
}

/**
 * The subjects one person starred, newest star first — `kind:id` keys only.
 * Home's QUICK ACCESS list resolves them to rows (`starredSubjectRows`); the
 * SUBJECTS rail reads the whole state instead.
 */
export async function readStarredKeys(env: Env, sub: string): Promise<Array<{ kind: SubjectKind; id: string }>> {
  const rows = await env.USAGE.prepare(
    'SELECT kind, subject_id FROM subject_state WHERE sub = ?1 AND starred = 1 ORDER BY updated_at DESC',
  ).bind(sub).all<Pick<StateRow, 'kind' | 'subject_id'>>();
  return (rows.results ?? []).map((row) => ({ kind: row.kind, id: row.subject_id }));
}

/**
 * Change what one person says about one subject. Only the keys sent move;
 * a row that ends up saying nothing is deleted, so the table stays a list
 * of opinions.
 */
export async function writeSubjectState(
  env: Env,
  sub: string,
  kind: SubjectKind,
  subjectId: string,
  update: SubjectStateUpdate,
): Promise<SubjectStateRow | null> {
  const existing = await env.USAGE.prepare(
    'SELECT kind, subject_id, starred, muted, updated_at FROM subject_state WHERE sub = ?1 AND kind = ?2 AND subject_id = ?3',
  ).bind(sub, kind, subjectId).first<StateRow>();
  const current = existing ? toRow(existing) : null;
  const next = {
    starred: update.starred ?? current?.starred ?? false,
    muted: update.muted ?? current?.muted ?? false,
  };
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (isDefaultOverride(next)) {
    statements.push(
      env.USAGE.prepare('DELETE FROM subject_state WHERE sub = ?1 AND kind = ?2 AND subject_id = ?3')
        .bind(sub, kind, subjectId),
    );
  } else {
    statements.push(
      env.USAGE.prepare(
        `INSERT INTO subject_state (sub, kind, subject_id, starred, muted, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (sub, kind, subject_id) DO UPDATE SET
           starred = excluded.starred, muted = excluded.muted, updated_at = excluded.updated_at`,
      ).bind(
        sub,
        kind,
        subjectId,
        next.starred ? 1 : 0,
        next.muted ? 1 : 0,
        now,
      ),
    );
  }
  if (update.starred !== undefined && !usesCoreFor(env, 'goals')) {
    await assertGroupWritable(env, 'goals');
    // A D1 workspace keeps the favorite itself, in the same batch: no outbox, no Core.
    const personId = await ensurePersonId(env, sub);
    if (personId) {
      statements.push(d1FavoriteStatement(env, personId, favoriteKindForSubject(kind), subjectId.toLowerCase(), next.starred, now));
    }
  } else if (update.starred !== undefined) {
    statements.push(...favoriteSyncStatements(
      env,
      sub,
      favoriteKindForSubject(kind),
      subjectId.toLowerCase(),
      next.starred,
      now,
    ));
  }
  await env.USAGE.batch(statements);
  if (isDefaultOverride(next)) return null;
  return { kind, id: subjectId, starred: next.starred, muted: next.muted, updated_at: now };
}

/**
 * The SALES opt-in and the SUBJECTS list preferences. Only the keys sent
 * move: a NULL bind leaves that column as it was, so the phone changing
 * the sort never resets Sales the Mac turned on.
 */
export async function writeWorkPreferences(env: Env, sub: string, update: WorkPreferencesUpdate): Promise<void> {
  // `hidden_kinds` is sent whole and decides leads too; `sales_enabled` alone
  // (an older app) moves only leads.
  const hidden = update.hidden_kinds;
  const sales = hidden !== undefined
    ? (hidden.includes('lead') ? 0 : 1)
    : update.sales_enabled === undefined ? null : (update.sales_enabled ? 1 : 0);
  const hiddenKinds = hidden === undefined ? null : JSON.stringify(SUBJECT_KINDS.filter((kind) => kind !== 'lead' && hidden.includes(kind)));
  const workList = update.work_list === undefined ? null : JSON.stringify(update.work_list);
  const inboxSources = update.inbox_sources === undefined ? null : JSON.stringify(normalizeInboxSourceOverrides(update.inbox_sources));
  const hiddenStages = update.board_hidden_stages === undefined ? null : JSON.stringify(WORK_STAGES.filter((stage) => update.board_hidden_stages!.includes(stage)));
  await env.USAGE.prepare(
    `INSERT INTO work_preferences (sub, sales_enabled, work_list, inbox_sources, hidden_kinds, board_hidden_stages, updated_at) VALUES (?1, COALESCE(?2, 0), ?3, ?4, ?6, ?7, ?5)
     ON CONFLICT (sub) DO UPDATE SET
       sales_enabled = COALESCE(?2, sales_enabled),
       work_list = COALESCE(?3, work_list),
       inbox_sources = COALESCE(?4, inbox_sources),
       hidden_kinds = COALESCE(?6, hidden_kinds),
       board_hidden_stages = COALESCE(?7, board_hidden_stages),
       updated_at = excluded.updated_at`,
  ).bind(sub, sales, workList, inboxSources, Date.now(), hiddenKinds, hiddenStages).run();
}
