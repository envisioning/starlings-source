import { z } from 'zod';
import { acceptingKindAliases, crmSubjectKindSchema } from './crm';
import { INBOX_FILTER_SOURCES, INBOX_SOURCES } from './inbox-values';
import { SUBJECT_GROUPS, WORK_LIST_GROUPS, WORK_LIST_SORTS } from './subject-state-values';
import { WORK_MODULES } from './work-modules';
import { SUBJECT_KINDS, type SubjectKind } from './subject-kinds';
import { WORK_STAGES } from './work-items';

export * from './subject-state-values';

/**
 * Per-user subject state: star and mute ( decision 5,
 * slice 2; follow removed 2026-09-15). Pinned by `fixtures/subject-state.json`;
 * the Swift port (`Sources/SubjectState.swift`) reads the same file.
 *
 * The Worker stores overrides only. A subject nobody has said anything about
 * is plain: not starred, not muted. Every open subject is on the rail; the
 * only gate that is not a per-subject opinion is the SALES opt-in, which
 * hides leads for a person who has not turned Sales on.
 */

export type SubjectGroup = (typeof SUBJECT_GROUPS)[number];
export const subjectGroupSchema = z.enum(SUBJECT_GROUPS);

/** What a subject row has to say to be placed in a group. */
export interface SubjectGroupShape {
  kind: 'lead' | 'project' | 'organization' | 'event';
  title: string;
  /** Core's `projects.is_internal`; absent on a row from a Core that predates it. */
  internal?: boolean | null | undefined;
}

/** Preferences that are not about one subject. */
export interface SubjectStatePrefs {
  sales_enabled: boolean;
  /**
   * The subject kinds this person hides for themselves (docs/WORK_MODEL.md
   * rule 3). When present it decides, `lead` included; absent (an
   * older Worker), a lead is hidden while `sales_enabled` is off.
   */
  hidden_kinds?: readonly SubjectKind[] | undefined;
}

/** One stored override. */
export interface SubjectStateOverride {
  starred: boolean;
  muted: boolean;
}

/** One subject's stored state for one member. */
export const subjectStateRowSchema = z.object({
  kind: crmSubjectKindSchema,
  id: z.string(),
  starred: z.boolean(),
  muted: z.boolean(),
  updated_at: z.number().int(),
});
export type SubjectStateRow = z.infer<typeof subjectStateRowSchema>;

/** What a client draws for one subject. */
export interface ResolvedSubjectState {
  /** On the rail and read by INBOX: not muted, and not a lead while Sales is off. */
  listed: boolean;
  starred: boolean;
  muted: boolean;
}

/**
 * How the SUBJECTS list is ordered and cut — one answer for the Mac rail,
 * the iOS list and the web rail, stored per person behind
 * `PATCH /api/crm/subject-state` and pinned by the `work_list` table in
 * `fixtures/subject-state.json`.
 *
 * Starred rows always lead; `sort` orders within starred and within the
 * rest. `group` splits the list by relationship (ENVISIONING, CLIENTS,
 * PARTNERS, SALES) or not at all. `starred_only` narrows the list to what
 * is starred. Mute and the SALES opt-in are membership, decided by
 * `resolveSubjectState` before any of this applies.
 */
export type WorkListSort = (typeof WORK_LIST_SORTS)[number];
export type WorkListGroup = (typeof WORK_LIST_GROUPS)[number];

export const workListPreferencesSchema = z.object({
  sort: z.enum(WORK_LIST_SORTS),
  group: z.enum(WORK_LIST_GROUPS),
  starred_only: z.boolean(),
}).strict();
export type WorkListPreferences = z.infer<typeof workListPreferencesSchema>;

/** The little a row has to expose to be ordered. Every client's subject shape fits. */
export interface WorkListRowShape {
  id: string;
  kind: 'lead' | 'project' | 'organization' | 'event';
  title: string;
  open_tasks?: number | null;
  overdue_tasks?: number | null;
  /** ISO, or null when nothing has moved. */
  last_activity_at?: string | null;
  /** Events only: the CMS `YYYY-MM-DD`. */
  event_date?: string | null;
}

/**
 * `inbox_sources` on the wire: a map of source to on/off, keys limited to
 * the sources this build knows (`INBOX_SOURCE_SPECS`).
 */
export const inboxSourcePreferencesSchema = z.partialRecord(
  z.enum(INBOX_FILTER_SOURCES),
  z.boolean(),
);

/** `GET /api/crm/subject-state`. */
export const subjectStateResponseSchema = z.object({
  role: z.string(),
  /** Leads shown: `lead` not in `hidden_kinds`. Kept for apps older than `hidden_kinds`. */
  sales_enabled: z.boolean(),
  /** The subject kinds this person hides for themselves. */
  hidden_kinds: z.array(acceptingKindAliases(z.enum(SUBJECT_KINDS))).optional(),
  work_list: workListPreferencesSchema,
  /** Resolved on/off values, including defaults, for client Settings parity. */
  inbox_sources: inboxSourcePreferencesSchema,
  /** The sources this member may turn on; `interest` only for admins. */
  inbox_available_sources: z.array(z.enum(INBOX_SOURCES)),
  /**
   * The work modules this workspace has on (docs/WORK_MODEL.md). Every client
   * hides what is off. Absent from an older Worker: read it as every work
   * module on, as before.
   */
  work_modules: z.array(z.enum(WORK_MODULES)).optional(),
  /**
   * The Board columns this person hides, on every project and every device
   *. A view setting only. Absent from an older Worker: hide none.
   */
  board_hidden_stages: z.array(z.enum(WORK_STAGES)).optional(),
  states: z.array(subjectStateRowSchema),
});
export type SubjectStateResponse = z.infer<typeof subjectStateResponseSchema>;

/** `PUT /api/crm/subject-state/{kind}/{id}` — only the keys sent change. */
export const subjectStateUpdateSchema = z.object({
  starred: z.boolean().optional(),
  muted: z.boolean().optional(),
}).strict();
export type SubjectStateUpdate = z.infer<typeof subjectStateUpdateSchema>;

/** `PUT /api/crm/subject-state/{kind}/{id}` response: the row as stored, or null when it says nothing. */
export const subjectStateUpdateResponseSchema = z.object({
  state: subjectStateRowSchema.nullable(),
});
export type SubjectStateUpdateResponse = z.infer<typeof subjectStateUpdateResponseSchema>;

/**
 * `PATCH /api/crm/subject-state` — preferences that are not about one
 * subject. Only the keys sent change; a body naming neither is refused.
 */
export const workPreferencesUpdateSchema = z.object({
  sales_enabled: z.boolean().optional(),
  /** Sent whole: every kind this person hides; `lead` sets `sales_enabled` with it. */
  hidden_kinds: z.array(z.enum(SUBJECT_KINDS)).max(8).optional(),
  work_list: workListPreferencesSchema.optional(),
  /** Sent whole: the Worker stores values that differ from the shared defaults. */
  inbox_sources: inboxSourcePreferencesSchema.optional(),
  /** Sent whole: every Board column this person hides. */
  board_hidden_stages: z.array(z.enum(WORK_STAGES)).max(6).optional(),
}).strict().refine(
  (body) => body.sales_enabled !== undefined || body.hidden_kinds !== undefined || body.work_list !== undefined || body.inbox_sources !== undefined || body.board_hidden_stages !== undefined,
  { message: 'Nothing to change.' },
);
export type WorkPreferencesUpdate = z.infer<typeof workPreferencesUpdateSchema>;
