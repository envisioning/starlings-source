import { z } from 'zod';
import { acceptingKindAliases, crmIssueSchema, crmLicenseSchema, crmMyTaskSchema, crmOfferSchema, crmSubjectKindSchema, crmTaskSchema } from './crm';
// index.ts re-exports this module, so these three are reached lazily: at
// load time index.ts is still initialising, and a direct read would be a
// use before definition. z.lazy resolves them when a schema is first used.
import { docsAnnotationSchema, meetingFollowUpDraftSchema, pendingCalendarEventSchema, threadSummarySchema, untriagedTouchSchema } from './index';
import { quickNoteSchema } from './quick-notes';
import type { SubjectGroup } from './subject-state';
import { SUBJECT_GROUPS } from './subject-state-values';
import { INBOX_SOURCES } from './inbox-values';
import { attentionRequestSchema } from './attention';
import { decisionAskSchema } from './decision-asks';
import { calendarEventSummarySchema } from './calendar';

export * from './inbox-values';

/**
 * INBOX — one per-user feed ( decision 4, slice 2b).
 *
 * Two halves, deliberately. `items` are things with a resolution — read it,
 * decide it, file it, triage it — and each leaves when resolved, so the list
 * empties. `recent` is what happened on your listed subjects: it never
 * resolves, so it is a capped tail under the items, not among them, and
 * never counted. Hidden when both are empty.
 */

export const inboxSourceSchema = z.enum(INBOX_SOURCES);

const inboxItemBaseSchema = z.object({
  /** Stable across polls, so a row keeps its place and a dismissal names it. */
  key: z.string(),
  /** When the thing behind the row happened, epoch milliseconds. Newest first. */
  at: z.number().int(),
});

/** The subject a row is about, enough to open it. */
export const inboxSubjectRefSchema = z.object({
  kind: acceptingKindAliases(z.enum(['lead', 'project', 'organization'])),
  id: z.string(),
  title: z.string(),
});
export type InboxSubjectRef = z.infer<typeof inboxSubjectRefSchema>;

export const inboxTalkItemSchema = inboxItemBaseSchema.extend({
  /** `mention` is a talk row somebody named you in; it outranks unread. */
  source: z.enum(['talk', 'mention']),
  thread: z.lazy(() => threadSummarySchema),
});
export type InboxTalkItem = z.infer<typeof inboxTalkItemSchema>;

export const inboxTaskItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('task'),
  task: crmTaskSchema,
  subject: inboxSubjectRefSchema,
});
export type InboxTaskItem = z.infer<typeof inboxTaskItemSchema>;

export const inboxNoteItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('note'),
  note: quickNoteSchema,
});
export type InboxNoteItem = z.infer<typeof inboxNoteItemSchema>;

export const inboxSalesItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('sales'),
  touch: z.lazy(() => untriagedTouchSchema),
});
export type InboxSalesItem = z.infer<typeof inboxSalesItemSchema>;

export const inboxCommentDocumentSchema = z.object({ id: z.string(), title: z.string(), path: z.string() });
export type InboxCommentDocument = z.infer<typeof inboxCommentDocumentSchema>;

export const inboxCommentItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('comment'),
  document: inboxCommentDocumentSchema,
  subject: inboxSubjectRefSchema.nullable(),
  /** The thread's opening comment. */
  thread: z.lazy(() => docsAnnotationSchema),
  /** The newest comment in it, the opening one when nobody has replied. */
  latest: z.lazy(() => docsAnnotationSchema),
  replies: z.number().int(),
});
export type InboxCommentItem = z.infer<typeof inboxCommentItemSchema>;

export const inboxBookingChangeSchema = z.enum(['booked', 'rescheduled', 'cancelled']);
export type InboxBookingChange = z.infer<typeof inboxBookingChangeSchema>;

export const inboxBookingSchema = z.object({
  id: z.string(),
  title: z.string(),
  guest_name: z.string(),
  guest_email: z.string(),
  guest_title: z.string().nullable(),
  guest_organization: z.string().nullable(),
  guest_notes: z.string().nullable(),
  start_time: z.string(),
  end_time: z.string(),
  google_event_id: z.string().nullable(),
  nda_required: z.boolean(),
  created_at: z.string(),
  cancelled_at: z.string().nullable(),
  rescheduled_at: z.string().nullable(),
  previous_start_time: z.string().nullable(),
  previous_end_time: z.string().nullable(),
});
export type InboxBooking = z.infer<typeof inboxBookingSchema>;

export const inboxBookingItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('booking'),
  change: inboxBookingChangeSchema,
  booking: inboxBookingSchema,
  /** The calendar event the booking became, as a demotion key, when it exists. */
  event_key: z.string().nullable(),
});
export type InboxBookingItem = z.infer<typeof inboxBookingItemSchema>;

/**
 * A Google Calendar invitation waiting on your answer, from any connected
 * account. Leaves when you answer it (Accept, Maybe, Decline) or the event
 * ends. Opt-in during rollout, like `question`.
 */
export const inboxInvitationItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('invitation'),
  event: calendarEventSummarySchema,
});
export type InboxInvitationItem = z.infer<typeof inboxInvitationItemSchema>;

/**
 * An event read from mail forwarded to calendar@. Leaves when
 * added or discarded, or when the week-long row expires. Opt-in during
 * rollout, like `invitation`.
 */
export const inboxForwardedItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('forwarded'),
  event: z.lazy(() => pendingCalendarEventSchema),
});
export type InboxForwardedItem = z.infer<typeof inboxForwardedItemSchema>;

export const inboxInterestSubmissionSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  name: z.string(),
  email: z.string(),
  company: z.string(),
  role: z.string(),
  company_size: z.string(),
  team_size: z.string(),
  agents: z.string(),
  deployment: z.string(),
  reason: z.string(),
  timeline: z.string(),
  parts: z.array(z.string()),
  missing: z.string().nullable(),
  /** The kind of organization, as its label. Absent from a server before the question. */
  org_kind: z.string().optional(),
  /** The ICP lane `interestLane` derived, as its label (GROWTH (HQ Docs)). */
  lane: z.string().optional(),
  /**
   * The lead the submission filed, which the row opens (docs/FORMS.md).
   * Null when none was filed or it was deleted; absent from an older server.
   */
  lead: inboxSubjectRefSchema.nullable().optional(),
});
export type InboxInterestSubmission = z.infer<typeof inboxInterestSubmissionSchema>;

/**
 * A guest thread whose last line came from outside, a guest, a peer
 * organization or an app user (`app`), and nobody here has answered (docs/SUPPORT.md). Leaves when
 * a member replies or dismisses it; a newer outside line brings it back.
 */
export const inboxGuestItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('guest'),
  thread_id: z.string(),
  subject: z.object({ kind: crmSubjectKindSchema, id: z.string(), title: z.string() }),
  /** Who wrote the last line, as the thread index holds it. */
  sender_email: z.string().nullable(),
  /** The clipped last line, never the whole body. */
  preview: z.string().nullable(),
  origin: z.enum(['guest', 'peer', 'app']),
});
export type InboxGuestItem = z.infer<typeof inboxGuestItemSchema>;

/**
 * Starlings support answered a conversation this member started in Help
 *. Leaves when the member opens the conversation; a newer reply
 * brings it back.
 */
export const inboxSupportItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('support'),
  conversation_id: z.string(),
  /** The first words of the reply. */
  preview: z.string(),
});
export type InboxSupportItem = z.infer<typeof inboxSupportItemSchema>;

/**
 * One person's answers to a workspace's public form (docs/FORMS.md §Step 2).
 * `summary` is the answers that sort it, already in words; `lead` is what it
 * filed, which the row opens.
 */
export const inboxFormSubmissionSchema = z.object({
  id: z.string(),
  /** The form's registry id. */
  form: z.string(),
  /** What one submission of the form is called: "Organisation request". */
  title: z.string(),
  created_at: z.string(),
  name: z.string(),
  email: z.string(),
  organization: z.string(),
  summary: z.string(),
  lead: inboxSubjectRefSchema.nullable(),
});
export type InboxFormSubmission = z.infer<typeof inboxFormSubmissionSchema>;

export const inboxSubmissionItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('submission'),
  submission: inboxFormSubmissionSchema,
});
export type InboxSubmissionItem = z.infer<typeof inboxSubmissionItemSchema>;

export const inboxInterestItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('interest'),
  submission: inboxInterestSubmissionSchema,
});
export type InboxInterestItem = z.infer<typeof inboxInterestItemSchema>;

/**
 * An offer about to expire, or a license due for renewal, on a lead or an
 * organization you can see. Read from Core on each poll; it
 * leaves when the offer is decided or the license renewed, or when
 * dismissed. The key carries the date, so a moved date is news again.
 */
export const INBOX_COMMERCIAL_EVENTS = ['offer_expiring', 'license_renewal'] as const;
export type InboxCommercialEvent = (typeof INBOX_COMMERCIAL_EVENTS)[number];
export const inboxCommercialItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('commercial'),
  event: z.enum(INBOX_COMMERCIAL_EVENTS),
  /** The lead or organization the row opens. */
  subject: z.object({ kind: z.enum(['lead', 'organization']), id: z.string(), title: z.string() }),
  /** The day it expires or renews (YYYY-MM-DD). */
  due: z.string(),
  offer: crmOfferSchema.optional(),
  license: crmLicenseSchema.optional(),
});
export type InboxCommercialItem = z.infer<typeof inboxCommercialItemSchema>;

/**
 * A decision waiting on you (docs/help/howto/answer-a-decision.md). Always
 * first in the list: the Worker orders these before every other source,
 * overdue first. Leaves when answered, defaulted or withdrawn.
 */
export const inboxDecisionItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('decision'),
  ask: decisionAskSchema,
});
export type InboxDecisionItem = z.infer<typeof inboxDecisionItemSchema>;

/**
 * A card an agent moved to Review or Blocked, shown to the person who handed
 * it off (docs/OWNERSHIP.md decision 12). The stage is read live from the
 * card, so the row leaves when the card moves on. Exactly one of `task` and
 * `issue` is set. Opt-in during rollout, like `question`.
 */
export const inboxCardItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('card'),
  stage: z.enum(['review', 'blocked']),
  agent: z.object({ email: z.string(), name: z.string() }),
  subject: inboxSubjectRefSchema,
  task: crmTaskSchema.nullable(),
  issue: crmIssueSchema.nullable(),
});
export type InboxCardItem = z.infer<typeof inboxCardItemSchema>;

/**
 * After the call: the follow-up drafted for the people outside the
 * workspace, with the tasks the same call proposed. Only the host sees it.
 * Leaves when approved or dismissed, or after a week. Opt-in, like `question`.
 */
export const inboxFollowUpItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('followup'),
  meeting: z.object({ room_slug: z.string(), id: z.string(), title: z.string() }),
  subject: inboxSubjectRefSchema,
  /** Outside attendees who joined with an address. */
  recipients: z.array(z.object({ name: z.string(), email: z.string() })),
  draft: z.lazy(() => meetingFollowUpDraftSchema),
  revision: z.number().int().min(1),
  /** The tasks this call proposed and nobody answered yet. */
  tasks: z.array(z.object({ id: z.string(), title: z.string() })),
  /** When it leaves INBOX unanswered, epoch ms. */
  expires_at: z.number().int(),
});
export type InboxFollowUpItem = z.infer<typeof inboxFollowUpItemSchema>;

/** Opt-in during rollout: old strict browser unions must never receive this member. */
export const inboxQuestionItemSchema = inboxItemBaseSchema.extend({
  source: z.literal('question'),
  request: attentionRequestSchema,
});
export type InboxQuestionItem = z.infer<typeof inboxQuestionItemSchema>;
export const inboxQuerySchema = z.object({
  questions: z.stringbool().default(false),
  cards: z.stringbool().default(false),
  followups: z.stringbool().default(false),
  /** Calendar invitations and events from email (`invitation`, `forwarded`). */
  calendar: z.stringbool().default(false),
});
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const inboxItemSchema = z.union([
  inboxQuestionItemSchema,
  inboxCardItemSchema,
  inboxFollowUpItemSchema,
  inboxDecisionItemSchema,
  inboxTalkItemSchema,
  inboxTaskItemSchema,
  inboxNoteItemSchema,
  inboxSalesItemSchema,
  inboxCommentItemSchema,
  inboxBookingItemSchema,
  inboxInvitationItemSchema,
  inboxForwardedItemSchema,
  inboxInterestItemSchema,
  inboxCommercialItemSchema,
  inboxSubmissionItemSchema,
  inboxGuestItemSchema,
  inboxSupportItemSchema,
]);
export type InboxItem = z.infer<typeof inboxItemSchema>;

/**
 * `POST` / `DELETE /api/crm/inbox/{key}/dismiss`: an item with no other
 * resolution leaves (or comes back) by hand. `booking:*`, `interest:*`,
 * `submission:*` and `guest:*` keys; the Worker refuses the rest.
 */
export const inboxDismissResponseSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
  dismissed: z.boolean(),
});
export type InboxDismissResponse = z.infer<typeof inboxDismissResponseSchema>;

/**
 * A recent entry's group on the wire. The workspace's own projects are
 * `internal` here; `envisioning` is the old name, kept one
 * release so a cached answer still parses.
 */
export type InboxRecentSubjectGroup = Exclude<SubjectGroup, 'envisioning'> | 'internal' | 'envisioning';
// Never empty: SUBJECT_GROUPS is a non-empty constant.
const INBOX_RECENT_SUBJECT_GROUPS = [
  ...SUBJECT_GROUPS.map((group) => (group === 'envisioning' ? 'internal' : group)),
  'envisioning',
] as unknown as [InboxRecentSubjectGroup, ...InboxRecentSubjectGroup[]];

/** The wire name of a subject's group in Recent. */
export function inboxRecentSubjectGroup(group: SubjectGroup): InboxRecentSubjectGroup {
  return group === 'envisioning' ? 'internal' : group;
}

export const inboxRecentSubjectSchema = z.object({
  kind: crmSubjectKindSchema,
  id: z.string(),
  title: z.string(),
  group: z.enum(INBOX_RECENT_SUBJECT_GROUPS),
});

/** Something that moved on one of your subjects in the last week. */
export const inboxRecentEntrySchema = z.object({
  subject: inboxRecentSubjectSchema,
  id: z.string(),
  title: z.string(),
  type: z.string(),
  date: z.string().nullable(),
  url: z.string().nullable(),
});
export type InboxRecentEntry = z.infer<typeof inboxRecentEntrySchema>;

export const inboxResponseSchema = z.object({
  items: z.array(inboxItemSchema),
  recent: z.array(inboxRecentEntrySchema),
  /** Sources that could not be read this time; their rows are simply absent. */
  partial: z.array(inboxSourceSchema),
  /** Subjects whose recent activity could not be read, by title. */
  recent_partial: z.array(z.string()),
  task_partial: z.array(z.string()).optional(),
  /**
   * Sources read up to their ceiling: what is shown is right, and more is
   * past the cap. Not a failure, so not in `partial`. Absent from an older
   * Worker.
   */
  capped: z.array(inboxSourceSchema).optional(),
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;
