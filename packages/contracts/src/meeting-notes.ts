import { z } from 'zod';

/** GET /api/rooms/:slug/meetings/:id/transcript — the owner's view of one meeting's record. */
export const meetingActionItemSchema = z.object({
  /** Stable identity supplied by the meeting agent; absent on historical records. */
  proposal_id: z.string().min(1).max(128).optional(),
  source_segment_ids: z.array(z.string().min(1).max(200)).max(20).optional(),
  what: z.string(),
  who: z.string().nullable(),
  by_when: z.string().nullable(),
  quote: z.string().nullable(),
  at_ms: z.number().int().nullable(),
  /** The Core task it became, once filed. */
  task_id: z.string().nullable(),
});
export type MeetingActionItem = z.infer<typeof meetingActionItemSchema>;

/**
 * One decision the notes engine wrote down: the same judgment
 * that wrote the note's Decisions section, as data. It stays on the meeting
 * until the owner records it (`decision_id` is Core's id then) or dismisses
 * it; nothing reaches Core on its own.
 */
export const meetingDecisionCandidateSchema = z.object({
  /** Stable identity supplied by the meeting agent; absent on historical records. */
  proposal_id: z.string().min(1).max(128).optional(),
  source_segment_ids: z.array(z.string().min(1).max(200)).max(20).optional(),
  what: z.string(),
  quote: z.string().nullable(),
  at_ms: z.number().int().nullable(),
  decision_id: z.string().nullable(),
  dismissed: z.boolean(),
});
export type MeetingDecisionCandidate = z.infer<typeof meetingDecisionCandidateSchema>;

/**
 * After the call: the follow-up the notes engine drafted for the
 * people outside the workspace, in the call's language and the host's voice.
 * A summary of what was agreed and who does what, never the transcript.
 * `revision` counts drafts: an approval names the one it approves.
 */
export const MEETING_FOLLOW_UP_SUBJECT_MAX = 120;
/** Under the ~2,000 characters a mail link carries, with recipients and subject. */
export const MEETING_FOLLOW_UP_BODY_MAX = 1_500;
export const meetingFollowUpDraftSchema = z.object({
  subject: z.string().trim().min(1).max(MEETING_FOLLOW_UP_SUBJECT_MAX),
  body: z.string().trim().min(1).max(MEETING_FOLLOW_UP_BODY_MAX),
});
export type MeetingFollowUpDraft = z.infer<typeof meetingFollowUpDraftSchema>;
