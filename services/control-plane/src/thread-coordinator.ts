// One conversation's ordered truth. Same split as rooms: the Durable Object
// owns the messages, D1 owns the cross-thread index that draws the list.
//
// Membership is checked here as well as at the Worker. The Worker is the only
// caller today, but a thread holds the one thing in this product that is
// neither a meeting nor metadata — what two people said to each other — and
// that deserves a second lock rather than a comment saying the first is enough.

import { DurableObject } from 'cloudflare:workers';
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  MESSAGE_EDIT_WINDOW_MILLISECONDS,
  MESSAGE_PAGE_MAX,
  MESSAGE_REACTION_MAX_PER_MESSAGE,
  THREAD_MESSAGE_REF_KINDS,
  type ThreadAudience,
  type ThreadKind,
  threadQuestionAnswerSchema,
  threadQuestionSchema,
  threadReleaseRequestSchema,
  threadReleaseStateSchema,
  threadHandoffSchema,
  type ThreadMessage,
  type ThreadMessageAttachment,
  type ThreadMessageRef,
  type ThreadMessageReaction,
  type ThreadMessageType,
  type ThreadQuestion,
  type ThreadHandoff,
  type ThreadQuestionAnswer,
  type ThreadReleaseRequest,
  type ThreadReleaseState,
} from './contracts';
import { ControlError, ThreadError } from './errors';
import { attentionFromOpenQuestion, attentionRequestID, selectAttentionOptions, type AttentionRequest } from '@starlings/contracts/attention';
import { importAttentionRequest, readAttentionRequest, resolveAttentionRequest, retractQuestionAnswer } from './attention-requests';
import { normalizeSearchText } from '@starlings/contracts/search';
import { MCP_CHANGES_PAGE_SIZE, type McpChangeCursor } from '@starlings/contracts/mcp';
import { exportSqlState, importSqlState, type ObjectSnapshot } from './object-snapshot';

interface MessageRow extends Record<string, SqlStorageValue> {
  id: string;
  sent_at: number;
  changed_at: number;
  sender_sub: string;
  sender_email: string;
  sender_name: string | null;
  text: string;
  type: string | null;
  refs: string | null;
  reply_to_message_id: string | null;
  mentions: string | null;
  edited_at: number | null;
  deleted_at: number | null;
  partial: number | null;
  origin: string | null;
  via: string | null;
  handoff: string | null;
  question: string | null;
  question_answer_question_id: string | null;
  question_answer_option_ids: string | null;
  question_answer_option_labels: string | null;
  release_request: string | null;
  release_state: string | null;
}

interface ReactionRow extends Record<string, SqlStorageValue> {
  message_id: string;
  emoji: string;
  sub: string;
  email: string;
  name: string | null;
}

interface AttachmentRow extends Record<string, SqlStorageValue> {
  id: string;
  message_id: string | null;
  owner_sub: string;
  name: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

/** How far back a conversation is read for a search hit: the newest text rows. */
const MESSAGE_SEARCH_SCAN = 2_000;
const MESSAGE_COLUMNS = `id, sent_at, changed_at, sender_sub, sender_email, sender_name, text, type, refs, reply_to_message_id,
            mentions, edited_at, deleted_at, partial, origin, via, handoff, question, question_answer_question_id,
            question_answer_option_ids, question_answer_option_labels, release_request, release_state`;

/** A `?,?,?` list for a variable IN clause. Ids are bound, never interpolated. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/** Mentions are stored as JSON and read back defensively, exactly like refs. */
function parseMentions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * Refs are stored as JSON and read back defensively: a row written by a newer
 * Worker with a kind this one does not know is dropped from the list rather
 * than failing the page.
 */
function parseRefs(raw: string | null): ThreadMessageRef[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { kind, id } = entry as { kind?: unknown; id?: unknown };
      if (typeof id !== 'string' || typeof kind !== 'string') return [];
      if (!(THREAD_MESSAGE_REF_KINDS as readonly string[]).includes(kind)) return [];
      return [{ kind: kind as ThreadMessageRef['kind'], id }];
    });
  } catch {
    return [];
  }
}

function parseQuestion(raw: string | null): ThreadQuestion | null {
  if (!raw) return null;
  try {
    const result = threadQuestionSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseHandoff(raw: string | null): ThreadHandoff | null {
  if (!raw) return null;
  try {
    const result = threadHandoffSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseReleaseRequest(raw: string | null): ThreadReleaseRequest | null {
  if (!raw) return null;
  try {
    const result = threadReleaseRequestSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseReleaseState(raw: string | null): ThreadReleaseState | null {
  if (!raw) return null;
  try {
    const result = threadReleaseStateSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** What a member or the Worker records on a release card. Keep is the authority; the card says what happened. */
export type ReleaseCardUpdate =
  | { action: 'approve'; vaultId: string; itemName: string; expiresAt: number }
  | { action: 'end'; endedBy: string }
  | { action: 'used' };

function parseQuestionAnswer(row: MessageRow): ThreadQuestionAnswer | null {
  if (!row.question_answer_question_id || !row.question_answer_option_ids || !row.question_answer_option_labels) return null;
  try {
    const result = threadQuestionAnswerSchema.safeParse({
      question_message_id: row.question_answer_question_id,
      option_ids: JSON.parse(row.question_answer_option_ids),
      option_labels: JSON.parse(row.question_answer_option_labels),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export interface ThreadInit {
  /**
   * The logical thread id the Worker and every client use. The Durable Object's
   * own `ctx.id` is a different string — and different again under a
   * jurisdiction — so reporting that one handed clients an id matching nothing
   * they could ask for.
   */
  id: string;
  kind: ThreadKind;
  parentId: string | null;
  /**
   * `members` for a DM, `everyone` for a channel. The DO enforces this itself
   * rather than trusting the Worker's check, for the same reason the membership
   * list is checked twice: a thread holds the one thing here that is neither a
   * meeting nor metadata.
   */
  audience: ThreadAudience;
  /** Empty for a channel — nobody is a member of it, everybody may read it. */
  members: Array<{ sub: string; email: string }>;
}

export interface AppendedMessage {
  id: string;
  sentAt: number;
  preview: string;
  /**
   * False when this id was already here. The message store is the only place
   * idempotency can be decided — `messages.id` is the primary key, so an
   * `INSERT OR IGNORE` is both the write and the duplicate check, and no
   * second table has to remember what has been said.
   */
  inserted: boolean;
  /**
   * True when this id was here as a row still being streamed and its text was
   * rewritten in place — the append that a streaming answer's every post but
   * the first is. Never true alongside `inserted`, and never true for a row
   * that had already been finalized: that one is a duplicate, whatever the
   * caller sent.
   */
  rewritten: boolean;
  /** Whether the row is still streaming after this write. */
  partial: boolean;
}

export class ThreadCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /** Every table this conversation owns, as JSON, for the daily backup. */
  async exportState(): Promise<ObjectSnapshot> {
    return exportSqlState(this.ctx.storage.sql);
  }

  /**
   * Replace every table with a snapshot's rows, in one transaction.
   * Writes after the snapshot are lost. Attachment bytes are in R2, not here;
   * the snapshot carries their metadata only.
   */
  async importState(snapshot: unknown): Promise<Record<string, number>> {
    return importSqlState(this.ctx.storage, snapshot);
  }

  /**
   * Idempotent: re-opening an existing conversation must not reset it.
   *
   * Used to return whether this call was the one that created the row, as a
   * proxy for "this subject's channel never had a message".
   * That proxy read backwards for the common case — a channel opened by a
   * person but never spoken in already has a row, so it read as "not new" —
   * and was one-shot besides, so a retry after a mid-request failure could
   * never see it again. Whether an event is this thread's first is decided
   * where it can be decided correctly: at the D1 index write, directly off
   * `threads.last_message_at IS NULL` (see `markThreadIndexedIfUnindexed` in
   * `threads.ts`). This method just makes the DO row exist.
   */
  async ensureThread(init: ThreadInit): Promise<void> {
    // Keyed on the thread row rather than on the member count, because a
    // channel has no members: counting those would re-run this on every open.
    const existing = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM thread WHERE row = 1').one().count;
    if (existing > 0) return;

    for (const member of init.members) {
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO members (sub, email) VALUES (?, ?)',
        member.sub,
        member.email,
      );
    }
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO thread (row, thread_id, kind, parent_id, audience) VALUES (1, ?, ?, ?, ?)',
      init.id,
      init.kind,
      init.parentId,
      init.audience,
    );
  }

  async append(
    sender: { sub: string; email: string; name: string },
    text: string,
    id: string,
    sentAt: number,
    type: ThreadMessageType = 'text',
    refs: ThreadMessageRef[] = [],
    options: {
      mentions?: string[];
      attachmentIds?: string[];
      partial?: boolean;
      /** An imported row: where it came from, and which container there (docs/SLACK_IMPORT.md). */
      origin?: { kind: 'slack' | 'guest' | 'peer' | 'app'; ref: string };
      /** The MCP client a member's Claude sent this through, from its token. */
      via?: string;
      /** A parent text message in this same conversation. */
      replyToMessageId?: string | null;
      /** Structured question data authored by an agent. */
      question?: ThreadQuestion;
      /** A Hand off's brief: what done looks like, what comes back. */
      handoff?: ThreadHandoff;
      /** Internal source assignment, persisted with the message before D1 registration. */
      questionRecipientEmail?: string;
      questionContext?: { subject?: AttentionRequest['subject']; title?: string | null };
      /** An agent's request for one Keep item. */
      releaseRequest?: ThreadReleaseRequest;
    } = {},
  ): Promise<AppendedMessage> {
    const storedAssignment = this.questionAssignment(id);
    if (storedAssignment && !options.questionRecipientEmail) {
      options = { ...options, questionRecipientEmail: storedAssignment.recipient, questionContext: storedAssignment.context };
    }
    if (options.questionRecipientEmail) {
      return this.withQuestionLock(async () => {
        const result = this.ctx.storage.transactionSync(() => {
          this.assertReader(sender.sub);
          const existing = this.questionAssignment(id);
          const recipient = options.questionRecipientEmail!.toLowerCase();
          const previous = this.ctx.storage.sql.exec<{ question: string | null }>('SELECT question FROM messages WHERE id = ? AND partial IS NOT 1', id).toArray()[0];
          const direct = this.ctx.storage.sql.exec<{ kind: string; count: number }>(
            'SELECT kind, (SELECT COUNT(*) FROM members) AS count FROM thread WHERE row = 1',
          ).one();
          if (previous?.question && !existing && !(direct.kind === 'dm' && direct.count === 2)) {
            throw new ThreadError('An existing unassigned shared question stays in chat.', 409, 'invalid_question_recipient');
          }
          if (existing && existing.recipient !== recipient) {
            throw new ThreadError('This question already has a recipient.', 409, 'invalid_question_recipient');
          }
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO question_assignments (message_id, recipient_email, context) VALUES (?, ?, ?)',
            id, recipient, JSON.stringify(options.questionContext ?? {}));
          return this.appendMessage(sender, text, id, sentAt, type, refs, options);
        });
        if (!result.partial) await this.registerQuestionUnlocked(sender.sub, id, options.questionRecipientEmail!, options.questionContext);
        return result;
      });
    }
    return this.appendMessage(sender, text, id, sentAt, type, refs, options);
  }

  private appendMessage(
    sender: { sub: string; email: string; name: string },
    text: string,
    id: string,
    sentAt: number,
    type: ThreadMessageType = 'text',
    refs: ThreadMessageRef[] = [],
    options: {
      mentions?: string[];
      attachmentIds?: string[];
      partial?: boolean;
      /** An imported row: where it came from, and which container there (docs/SLACK_IMPORT.md). */
      origin?: { kind: 'slack' | 'guest' | 'peer' | 'app'; ref: string };
      /** The MCP client a member's Claude sent this through, from its token. */
      via?: string;
      /** A parent text message in this same conversation. */
      replyToMessageId?: string | null;
      /** Structured question data authored by an agent. */
      question?: ThreadQuestion;
      /** A Hand off's brief: what done looks like, what comes back. */
      handoff?: ThreadHandoff;
      /** Internal source assignment, persisted with the message before D1 registration. */
      questionRecipientEmail?: string;
      questionContext?: { subject?: AttentionRequest['subject']; title?: string | null };
      /** An agent's request for one Keep item. */
      releaseRequest?: ThreadReleaseRequest;
    } = {},
  ): AppendedMessage {
    this.assertReader(sender.sub);
    const replyToMessageId = options.replyToMessageId ?? null;
    if (replyToMessageId !== null) this.assertReplyTarget(id, replyToMessageId);
    const mentions = options.mentions ?? [];
    const partial = options.partial === true;
    // `OR IGNORE` rather than a plain insert: a caller that derives the id from
    // an idempotency key gets a safe retry, and a caller that mints a random
    // one is unaffected because it never collides.
    const cursor = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO messages
         (id, sent_at, changed_at, sender_sub, sender_email, sender_name, text, type, refs, reply_to_message_id, mentions, partial, origin, origin_ref, via, question, release_request, handoff)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sentAt,
      sentAt,
      sender.sub,
      sender.email,
      sender.name,
      text,
      type,
      refs.length > 0 ? JSON.stringify(refs) : null,
      replyToMessageId,
      mentions.length > 0 ? JSON.stringify(mentions) : null,
      partial ? 1 : null,
      options.origin?.kind ?? null,
      options.origin?.ref ?? null,
      type === 'text' ? (options.via ?? null) : null,
      options.question ? JSON.stringify(options.question) : null,
      options.releaseRequest && type === 'text' && !partial ? JSON.stringify(options.releaseRequest) : null,
      type === 'text' && options.handoff ? JSON.stringify(options.handoff) : null,
    );
    const inserted = cursor.rowsWritten > 0;
    // Only on a real insert. A retry that lands on an existing id must not
    // re-bind files — the first attempt already claimed them, and doing it
    // twice would move an attachment off the message that is showing it.
    if (inserted) this.bindAttachments(sender.sub, id, options.attachmentIds ?? []);
    if (inserted) return { id, sentAt, preview: text, inserted, rewritten: false, partial };
    // The id is taken. A row still streaming is rewritten in place by its own
    // sender — that is what streaming *is* at the store: one row, many posts,
    // the same key. The final post may retype it: a preamble the model said on
    // its way to a tool is a trail line once the tool is called, not an
    // answer. A finalized row is never touched again, so a partial that
    // arrives late — a retry, a slow hop — is a duplicate, never a rollback.
    // `sent_at` keeps the first post's, so the row does not move as it grows.
    const rewrite = this.ctx.storage.sql.exec(
      `UPDATE messages SET text = ?, type = ?, partial = ?, changed_at = ?, question = ?, release_request = ?
        WHERE id = ? AND sender_sub = ? AND partial = 1 AND deleted_at IS NULL`,
      text,
      type,
      partial ? 1 : null,
      sentAt,
      options.question ? JSON.stringify(options.question) : null,
      options.releaseRequest && type === 'text' && !partial ? JSON.stringify(options.releaseRequest) : null,
      id,
      sender.sub,
    );
    const rewritten = rewrite.rowsWritten > 0;
    return { id, sentAt, preview: text, inserted: false, rewritten, partial: rewritten ? partial : false };
  }

  /** Reject invalid input outside the lock: throwing inside it resets the DO. */
  private async withQuestionLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try { return { ok: true as const, value: await operation() }; }
      catch (error) {
        if (!(error instanceof ControlError)) throw error;
        return { ok: false as const, error };
      }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  /** Stored-source registration and answer projection share this object's lock. */
  async registerQuestion(readerSub: string, messageId: string, recipientEmail: string, context: { subject?: AttentionRequest['subject']; title?: string | null } = {}): Promise<AttentionRequest | null> {
    return this.withQuestionLock(() => this.registerQuestionUnlocked(readerSub, messageId, recipientEmail, context));
  }

  private questionAssignment(messageId: string): { recipient: string; context: { subject?: AttentionRequest['subject']; title?: string | null } } | null {
    const row = this.ctx.storage.sql.exec<{ recipient_email: string; context: string }>(
      'SELECT recipient_email, context FROM question_assignments WHERE message_id = ?', messageId,
    ).toArray()[0];
    return row ? { recipient: row.recipient_email, context: JSON.parse(row.context) } : null;
  }

  private async registerQuestionUnlocked(readerSub: string, messageId: string, recipientEmail: string,
    context: { subject?: AttentionRequest['subject']; title?: string | null } = {}): Promise<AttentionRequest | null> {
    this.assertReader(readerSub);
    const parent = this.ctx.storage.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`, messageId,
    ).toArray()[0];
    const question = parent ? parseQuestion(parent.question) : null;
    if (!parent || parent.type !== 'text' || parent.partial === 1 || !question) return null;
    if (parent.sender_sub !== readerSub) throw new ThreadError('Only the author registers a question.', 403, 'capability_denied');
    const threadId = this.ctx.storage.sql.exec<{ thread_id: string }>('SELECT thread_id FROM thread WHERE row = 1').one().thread_id;
    const id = attentionRequestID({ type: 'thread_question', thread_id: threadId, message_id: messageId });
    const exists = await this.env.USAGE.prepare('SELECT id FROM attention_requests WHERE id = ?1').bind(id).first();
    // A stored request keeps its original prompt even if the message was edited.
    const stored = exists ? await readAttentionRequest(this.env.USAGE, id) : null;
    if (!stored && parent.deleted_at !== null) return null;
    const snapshot = stored ? { ...stored, revision: 0 }
      : attentionFromOpenQuestion({ id: parent.id, thread_id: threadId, sent_at: parent.sent_at,
        sender_email: parent.sender_email, sender_name: parent.sender_name, text: parent.text }, question, recipientEmail);
    if (!stored) { snapshot.subject = context.subject ?? null; snapshot.context = context.title ?? null; }
    if (snapshot.recipient_email !== recipientEmail.toLowerCase() || snapshot.asked_by_email !== parent.sender_email.toLowerCase()) {
      throw new ThreadError('This question already has a different recipient.', 409, 'invalid_question_answer');
    }
    if (stored && stored.state !== 'open') return stored;
    const reply = this.ctx.storage.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE question_answer_question_id = ?`, messageId,
    ).toArray()[0];
    const answer = reply ? parseQuestionAnswer(reply) : null;
    if (reply && answer?.option_ids.length) {
      snapshot.state = 'answered';
      snapshot.answer = { option_ids: answer.option_ids, option_labels: answer.option_labels,
        custom_text: null, note: null, answered_by_email: reply.sender_email, answered_at: new Date(reply.sent_at).toISOString() };
    } else if (parent.deleted_at !== null || reply) {
      // A legacy reply tombstone still closes the question, without inventing an answer.
      snapshot.state = 'withdrawn';
    }
    return importAttentionRequest(this.env.USAGE, snapshot);
  }

  /**
   * Persist one member's selection on an agent question. A unique index on
   * `question_answer_question_id` keeps one reply. Registered requests claim
   * their canonical winner first; retries project that stored answer. The
   * object lock prevents legacy replies crossing source registration.
   */
  async answerQuestion(
    sender: { sub: string; email: string; name: string },
    questionMessageId: string,
    answerMessageId: string,
    sentAt: number,
    selectedOptionIds: string[],
  ): Promise<{
    inserted: boolean;
    accepted: boolean;
    message: ThreadMessage;
    question: { id: string; text: string; senderEmail: string; senderName: string | null; definition: ThreadQuestion } | null;
  }> {
    return this.withQuestionLock(async () => {
      this.assertReader(sender.sub);
      const threadId = this.ctx.storage.sql.exec<{ thread_id: string }>('SELECT thread_id FROM thread WHERE row = 1').one().thread_id;
      const attentionId = attentionRequestID({ type: 'thread_question', thread_id: threadId, message_id: questionMessageId });
      // A crash after the local source transaction but before D1 registration
      // retains the designated recipient. Recover before any reply may claim it.
      const assignment = this.questionAssignment(questionMessageId);
      if (assignment) {
        const author = this.ctx.storage.sql.exec<{ sender_sub: string }>('SELECT sender_sub FROM messages WHERE id = ?', questionMessageId).toArray()[0];
        if (author) await this.registerQuestionUnlocked(author.sender_sub, questionMessageId, assignment.recipient, assignment.context);
      }
      const registered = await this.env.USAGE.prepare('SELECT id FROM attention_requests WHERE id = ?1').bind(attentionId).first();
      const canonical = registered ? await readAttentionRequest(this.env.USAGE, attentionId) : null;
      if (canonical && canonical.recipient_email !== sender.email.toLowerCase()) {
        throw new ThreadError('Only the recipient can answer this question.', 403, 'capability_denied');
      }
      const existing = this.ctx.storage.sql.exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE question_answer_question_id = ?`,
        questionMessageId,
      ).toArray()[0];
      if (existing) {
        return { inserted: false, accepted: false, message: this.questionAnswerAsMessage(existing, sender.sub), question: null };
      }

      if (canonical && canonical.state !== 'open' && canonical.state !== 'answered') {
        throw new ThreadError('That question is no longer open.', 409, 'question_not_open');
      }

      const parent = this.ctx.storage.sql.exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`,
        questionMessageId,
      ).toArray()[0];
      const definition = parent ? parseQuestion(parent.question) : null;
      if (!parent || parent.type !== 'text' || parent.deleted_at !== null || parent.partial === 1 || !definition) {
        throw new ThreadError('That question is no longer open.', 409, 'question_not_open');
      }

      const selected = selectAttentionOptions(definition.mode, definition.options, selectedOptionIds);
      if (!selected) {
        throw new ThreadError('Choose a valid answer.', 400, 'invalid_question_answer');
      }
      const resolution = canonical ? await resolveAttentionRequest(this.env.USAGE, attentionId, sender.email,
        { action: 'answer', option_ids: selectedOptionIds }, sentAt) : null;
      const answer = resolution?.request.answer;
      if (resolution && !answer) throw new ThreadError('That question is no longer open.', 409, 'question_not_open');
      const optionIds = answer?.option_ids ?? selected.map((option) => option.id);
      const optionLabels = answer?.option_labels ?? selected.map((option) => option.label);
      if (answer) {
        sentAt = Date.parse(answer.answered_at);
        answerMessageId = `answer_${questionMessageId}`;
      }
      const text = optionLabels.join(', ');
      const insert = this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO messages
           (id, sent_at, changed_at, sender_sub, sender_email, sender_name, text, type, refs, reply_to_message_id,
            mentions, partial, origin, origin_ref, question, question_answer_question_id,
            question_answer_option_ids, question_answer_option_labels)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'text', NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        answerMessageId,
        sentAt,
        sentAt,
        sender.sub,
        sender.email,
        sender.name,
        text,
        questionMessageId,
        questionMessageId,
        JSON.stringify(optionIds),
        JSON.stringify(optionLabels),
      );
      const winner = this.ctx.storage.sql.exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE question_answer_question_id = ?`,
        questionMessageId,
      ).toArray()[0];
      if (!winner) throw new Error('Question answer could not be stored.');
      return {
        inserted: insert.rowsWritten > 0,
        accepted: resolution ? resolution.accepted : insert.rowsWritten > 0,
        message: this.questionAnswerAsMessage(winner, sender.sub),
        question: insert.rowsWritten > 0 ? {
          id: parent.id,
          text: canonical?.prompt ?? parent.text,
          senderEmail: parent.sender_email,
          senderName: parent.sender_name,
          definition,
        } : null,
      };
    });
  }

  private questionAnswerAsMessage(row: MessageRow, readerSub: string): ThreadMessage {
    const threadId = this.ctx.storage.sql
      .exec<{ thread_id: string }>('SELECT thread_id FROM thread WHERE row = 1')
      .toArray()[0]?.thread_id ?? this.ctx.id.toString();
    const message: ThreadMessage = {
      id: row.id,
      thread_id: threadId,
      sent_at: row.sent_at,
      sender_email: row.sender_email,
      sender_name: row.sender_name,
      text: row.text,
      is_mine: row.sender_sub === readerSub,
      type: 'text',
      reply_to_message_id: row.reply_to_message_id,
    };
    const answer = parseQuestionAnswer(row);
    if (answer) message.question_answer = answer;
    if (row.edited_at !== null) message.edited_at = row.edited_at;
    if (row.deleted_at !== null) message.deleted_at = row.deleted_at;
    return message;
  }

  /** A parent must be a live, finalized text row in this object's conversation. */
  private assertReplyTarget(messageId: string, parentId: string): void {
    const parent = this.ctx.storage.sql.exec<{
      type: string | null;
      deleted_at: number | null;
      partial: number | null;
    }>('SELECT type, deleted_at, partial FROM messages WHERE id = ?', parentId).toArray()[0];
    if (
      parentId === messageId
      || !parent
      || (parent.type !== null && parent.type !== 'text')
      || parent.deleted_at !== null
      || parent.partial === 1
    ) {
      throw new ThreadError('That message cannot be replied to.', 409, 'message_not_replyable');
    }
  }

  /**
   * Claim staged uploads for the message now carrying them.
   *
   * Ownership is the whole check: an id belongs to whoever staged it and is
   * bound at most once, so naming somebody else's upload — or re-naming one
   * already visible in the transcript — matches no row and silently attaches
   * nothing, rather than moving a colleague's file into your message.
   */
  private bindAttachments(ownerSub: string, messageId: string, ids: string[]): void {
    for (const attachmentId of ids.slice(0, ATTACHMENT_MAX_PER_MESSAGE)) {
      this.ctx.storage.sql.exec(
        `UPDATE attachments SET message_id = ?
          WHERE id = ? AND owner_sub = ? AND message_id IS NULL AND deleted_at IS NULL`,
        messageId,
        attachmentId,
        ownerSub,
      );
    }
  }

  /**
   * Record one file's metadata before its message exists. Unbound rows are
   * inert: nothing reads them into a transcript, so a composer somebody
   * abandons costs a row and the bytes, and never appears to anybody.
   */
  async stageAttachment(
    ownerSub: string,
    attachment: {
      id: string;
      name: string;
      contentType: string;
      bytes: number;
      width?: number | undefined;
      height?: number | undefined;
    },
    now: number,
  ): Promise<void> {
    this.assertReader(ownerSub);
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO attachments
         (id, message_id, owner_sub, name, content_type, bytes, width, height, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      attachment.id,
      ownerSub,
      attachment.name,
      attachment.contentType,
      attachment.bytes,
      attachment.width ?? null,
      attachment.height ?? null,
      now,
    );
  }

  /**
   * One attachment, for serving its bytes. Membership is re-checked here for
   * the same reason it is on every read: an object key is guessable-adjacent,
   * and the only thing that should decide who sees a file in a private
   * conversation is whether they are in the conversation.
   *
   * A staged row is readable only by whoever staged it — an upload that has
   * not been sent is not yet part of anything.
   */
  async attachment(
    readerSub: string,
    attachmentId: string,
  ): Promise<(ThreadMessageAttachment & { message_id: string | null }) | null> {
    this.assertReader(readerSub);
    const row = this.ctx.storage.sql.exec<AttachmentRow & { owner_sub: string }>(
      `SELECT id, message_id, owner_sub, name, content_type, bytes, width, height
         FROM attachments WHERE id = ? AND deleted_at IS NULL`,
      attachmentId,
    ).toArray()[0];
    if (!row) return null;
    if (row.message_id === null && row.owner_sub !== readerSub) return null;
    return { ...toAttachment(row), message_id: row.message_id };
  }

  /**
   * Add or remove one emoji, whichever this person has not already done.
   *
   * A toggle rather than separate add and remove calls: the surface is one
   * pill you press, the state is one row, and two routes would only be two
   * ways to disagree about whether it is there. Returns the message's whole
   * reaction set so a client redraws from the truth instead of guessing what
   * its own press did.
   */
  async react(
    actor: { sub: string; email: string; name: string | null },
    messageId: string,
    emoji: string,
    now: number,
  ): Promise<{ reactions: ThreadMessageReaction[]; on: boolean }> {
    this.assertReader(actor.sub);
    const message = this.ctx.storage.sql.exec<{ deleted_at: number | null }>(
      'SELECT deleted_at FROM messages WHERE id = ?',
      messageId,
    ).toArray()[0];
    if (!message) throw new ThreadError('That message is gone.', 404, 'room_not_found');
    // Withdrawn messages keep their place in the transcript but stop being
    // something to have an opinion about.
    if (message.deleted_at !== null) {
      throw new ThreadError('That message was withdrawn.', 409, 'message_not_editable');
    }

    const removed = this.ctx.storage.sql.exec(
      'DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND sub = ?',
      messageId,
      emoji,
      actor.sub,
    ).rowsWritten;

    if (removed === 0) {
      // The cap is on distinct emoji, and only a *new* one can breach it —
      // joining a symbol already on the message is always allowed, however
      // many people have. Otherwise the last person to agree gets an error.
      const distinct = this.ctx.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(DISTINCT emoji) AS count FROM reactions WHERE message_id = ?',
        messageId,
      ).one().count;
      const exists = this.ctx.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM reactions WHERE message_id = ? AND emoji = ?',
        messageId,
        emoji,
      ).one().count > 0;
      if (!exists && distinct >= MESSAGE_REACTION_MAX_PER_MESSAGE) {
        throw new ThreadError('That message has enough reactions.', 409, 'capacity_reached');
      }
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO reactions (message_id, emoji, sub, email, name, at) VALUES (?, ?, ?, ?, ?, ?)',
        messageId,
        emoji,
        actor.sub,
        actor.email,
        actor.name,
        now,
      );
    }

    return {
      reactions: this.reactionsFor([messageId], actor.sub).get(messageId) ?? [],
      on: removed === 0,
    };
  }

  /**
   * Rewrite what you said, inside the window. Author-only and time-boxed: a
   * transcript anybody could rewrite, or one its author could rewrite a year
   * later, is not a record of a conversation.
   */
  async edit(
    actorSub: string,
    messageId: string,
    text: string,
    now: number,
  ): Promise<{ editedAt: number; sentAt: number; text: string }> {
    const row = this.authoredMessage(actorSub, messageId);
    if (now - row.sent_at > MESSAGE_EDIT_WINDOW_MILLISECONDS) {
      throw new ThreadError('That message is too old to edit.', 409, 'message_not_editable');
    }
    this.ctx.storage.sql.exec(
      'UPDATE messages SET text = ?, edited_at = ?, changed_at = ? WHERE id = ?',
      text,
      now,
      now,
      messageId,
    );
    return { editedAt: now, sentAt: row.sent_at, text };
  }

  /**
   * Withdraw a message. The row survives and keeps its timestamp — a reply to
   * something that vanished entirely is a conversation nobody can follow — but
   * the text is cleared and every file on it is marked gone.
   *
   * The attachment ids come back so the Worker can delete the objects behind
   * them: this owns the metadata, R2 owns the bytes, and neither can reach the
   * other. No edit window, unlike `edit`: taking back something you should not
   * have said is not a typo, and the reason to want it grows with time.
   */
  async withdraw(
    actorSub: string,
    messageId: string,
    now: number,
  ): Promise<{ deletedAt: number; attachmentIds: string[] }> {
    return this.withQuestionLock(async () => {
      this.authoredMessage(actorSub, messageId);
      const source = this.ctx.storage.sql.exec<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`, messageId).one();
      if (source.question_answer_question_id) {
        const threadId = this.ctx.storage.sql.exec<{ thread_id: string }>('SELECT thread_id FROM thread WHERE row = 1').one().thread_id;
        const id = attentionRequestID({ type: 'thread_question', thread_id: threadId, message_id: source.question_answer_question_id });
        if (await this.env.USAGE.prepare('SELECT id FROM attention_requests WHERE id = ?1').bind(id).first()) {
          await retractQuestionAnswer(this.env.USAGE, id, source.sender_email);
        }
      }
      this.ctx.storage.sql.exec(
        `UPDATE messages SET text = '', deleted_at = ?, changed_at = ?,
           question_answer_option_ids = CASE WHEN question_answer_question_id IS NULL THEN question_answer_option_ids ELSE '[]' END,
           question_answer_option_labels = CASE WHEN question_answer_question_id IS NULL THEN question_answer_option_labels ELSE '[]' END
         WHERE id = ?`,
        now,
        now,
        messageId,
      );
      // Opinions about a message that is gone are noise on an empty row.
      this.ctx.storage.sql.exec('DELETE FROM reactions WHERE message_id = ?', messageId);
      const attachments = this.ctx.storage.sql.exec<{ id: string }>(
        'SELECT id FROM attachments WHERE message_id = ? AND deleted_at IS NULL',
        messageId,
      ).toArray();
      this.ctx.storage.sql.exec(
        'UPDATE attachments SET deleted_at = ? WHERE message_id = ?',
        now,
        messageId,
      );
      return { deletedAt: now, attachmentIds: attachments.map((row) => row.id) };
    });
  }

  /**
   * The message, if this person wrote it and it is still standing. One helper
   * because edit and withdraw make exactly the same three checks, and a second
   * copy of them is a second place for one of the three to go missing.
   */
  private authoredMessage(actorSub: string, messageId: string): { sent_at: number } {
    this.assertReader(actorSub);
    const row = this.ctx.storage.sql.exec<{ sender_sub: string; sent_at: number; deleted_at: number | null; origin: string | null }>(
      'SELECT sender_sub, sent_at, deleted_at, origin FROM messages WHERE id = ?',
      messageId,
    ).toArray()[0];
    // Same 404 for missing and for somebody else's: which messages exist in a
    // conversation is not something to learn by probing ids.
    if (!row || row.sender_sub !== actorSub) {
      throw new ThreadError('That message is gone.', 404, 'room_not_found');
    }
    if (row.deleted_at !== null) {
      throw new ThreadError('That message was withdrawn.', 409, 'message_not_editable');
    }
    // An imported row is history from somewhere else. The person it is
    // attributed to did not say it here, and the import can be reversed as
    // a whole; one row is not theirs to rewrite.
    if (row.origin !== null) {
      throw new ThreadError('That message was imported and cannot be changed.', 409, 'message_not_editable');
    }
    return { sent_at: row.sent_at };
  }

  /**
   * Reverse one import: every row that came from `origin` / `ref` goes, with
   * its reactions. The Worker's ledger is reset by the caller; the D1 index
   * row keeps whatever preview it had, which the next message rewrites.
   */
  async removeImported(origin: 'slack', ref: string): Promise<{ removed: number }> {
    const ids = this.ctx.storage.sql.exec<{ id: string }>(
      'SELECT id FROM messages WHERE origin = ? AND origin_ref = ?',
      origin,
      ref,
    ).toArray().map((row) => row.id);
    for (let index = 0; index < ids.length; index += 200) {
      const slice = ids.slice(index, index + 200);
      this.ctx.storage.sql.exec(`DELETE FROM reactions WHERE message_id IN (${placeholders(slice.length)})`, ...slice);
      this.ctx.storage.sql.exec(`DELETE FROM messages WHERE id IN (${placeholders(slice.length)})`, ...slice);
    }
    return { removed: ids.length };
  }

  /**
   * Reactions for a whole page, in one query, aggregated by emoji. Per-message
   * queries would be one round-trip per row for the commonest case — a page
   * where nothing has been reacted to at all.
   */
  private reactionsFor(
    messageIds: string[],
    readerSub: string,
  ): Map<string, ThreadMessageReaction[]> {
    const byMessage = new Map<string, ThreadMessageReaction[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = this.ctx.storage.sql.exec<ReactionRow>(
      `SELECT message_id, emoji, sub, email, name FROM reactions
        WHERE message_id IN (${placeholders(messageIds.length)})
        ORDER BY at ASC`,
      ...messageIds,
    ).toArray();

    for (const row of rows) {
      const list = byMessage.get(row.message_id) ?? [];
      // Insertion order is reaction order, so the first emoji anybody chose
      // stays leftmost instead of the rail reshuffling as counts change.
      let entry = list.find((candidate) => candidate.emoji === row.emoji);
      if (!entry) {
        entry = { emoji: row.emoji, count: 0, is_mine: false, reactors: [] };
        list.push(entry);
      }
      entry.count += 1;
      if (row.sub === readerSub) entry.is_mine = true;
      entry.reactors.push(row.name ?? row.email);
      byMessage.set(row.message_id, list);
    }
    return byMessage;
  }

  /** Attachments for a whole page, in one query, for the same reason. */
  private attachmentsFor(messageIds: string[]): Map<string, ThreadMessageAttachment[]> {
    const byMessage = new Map<string, ThreadMessageAttachment[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = this.ctx.storage.sql.exec<AttachmentRow>(
      `SELECT id, message_id, owner_sub, name, content_type, bytes, width, height
         FROM attachments
        WHERE deleted_at IS NULL AND message_id IN (${placeholders(messageIds.length)})
        ORDER BY created_at ASC`,
      ...messageIds,
    ).toArray();
    for (const row of rows) {
      if (row.message_id === null) continue;
      const list = byMessage.get(row.message_id) ?? [];
      list.push(toAttachment(row));
      byMessage.set(row.message_id, list);
    }
    return byMessage;
  }

  /**
   * Newest-first page, oldest-first on the way out — a transcript reads
   * downward, and every client would otherwise reverse it itself.
   */
  /**
   * The newest lines that carry every token. Bodies never leave
   * this object except as the hits themselves: the Worker fans a query out
   * to the caller's conversations and each answers over its own table, so
   * there is no index of message text anywhere else — docs/PRIVACY.md holds.
   *
   * The match is the contract's own NORMALIZE (case- and diacritic-folded,
   * `@starlings/contracts/search`) over the last `MESSAGE_SEARCH_SCAN` text rows,
   * in JavaScript rather than SQL: SQLite's LIKE folds ASCII only, and a
   * "café" a person typed as "cafe" must still be found. Withdrawn rows and
   * event lines are skipped — one is gone, the other is the work graph's.
   */
  async search(
    readerSub: string,
    tokens: readonly string[],
    limit: number,
  ): Promise<Array<Pick<ThreadMessage, 'id' | 'sent_at' | 'sender_email' | 'sender_name' | 'text'>>> {
    this.assertReader(readerSub);
    if (tokens.length === 0) return [];
    const rows = this.ctx.storage.sql.exec<Pick<MessageRow, 'id' | 'sent_at' | 'sender_email' | 'sender_name' | 'text'>>(
      `SELECT id, sent_at, sender_email, sender_name, text
         FROM messages
        WHERE deleted_at IS NULL AND type = 'text'
        ORDER BY sent_at DESC LIMIT ?`,
      MESSAGE_SEARCH_SCAN,
    ).toArray();
    const hits: Array<Pick<ThreadMessage, 'id' | 'sent_at' | 'sender_email' | 'sender_name' | 'text'>> = [];
    for (const row of rows) {
      const text = normalizeSearchText(row.text);
      if (!tokens.every((token) => text.includes(token))) continue;
      hits.push({ id: row.id, sent_at: row.sent_at, sender_email: row.sender_email, sender_name: row.sender_name, text: row.text });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** A retry repairs the projection from the stored event, never the retry's text/time. */
  async activityEntry(id: string): Promise<{ id: string; text: string; sent_at: number } | null> {
    return this.ctx.storage.sql.exec<{ id: string; text: string; sent_at: number }>(
      `SELECT id, text, sent_at FROM messages WHERE id = ? AND type = 'event'
        AND deleted_at IS NULL AND partial IS NOT 1`, id,
    ).toArray()[0] ?? null;
  }

  /** Service-only reconstruction of the activity index. Never includes human text. */
  async activityIndex(since: number, limit: number): Promise<Array<{ id: string; text: string; sent_at: number }>> {
    return this.ctx.storage.sql.exec<{ id: string; text: string; sent_at: number }>(
      `SELECT id, text, sent_at FROM messages
        WHERE type = 'event' AND deleted_at IS NULL AND partial IS NOT 1 AND sent_at >= ?
        ORDER BY sent_at DESC, id LIMIT ?`, since, Math.min(Math.max(limit, 1), 100),
    ).toArray();
  }

  async messages(
    readerSub: string,
    options: { before?: string | undefined; limit?: number | undefined } = {},
  ): Promise<{ messages: ThreadMessage[]; olderCursor: string | null }> {
    this.assertReader(readerSub);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MESSAGE_PAGE_MAX);

    const rows = options.before
      ? this.ctx.storage.sql.exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
           FROM messages WHERE sent_at < (SELECT sent_at FROM messages WHERE id = ?)
          ORDER BY sent_at DESC LIMIT ?`,
        options.before,
        limit + 1,
      ).toArray()
      : this.ctx.storage.sql.exec<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS}
           FROM messages ORDER BY sent_at DESC LIMIT ?`,
        limit + 1,
      ).toArray();

    const hasOlder = rows.length > limit;
    const page = hasOlder ? rows.slice(0, limit) : rows;
    return {
      messages: this.toMessages(page.slice().reverse(), readerSub),
      olderCursor: hasOlder ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Named messages, oldest first, in the page's shape: the lines
   * a card's page lists out of `card_lines`. Ids this thread does not hold
   * are skipped. The reader is checked as for a page.
   */
  async messagesByIds(readerSub: string, ids: string[]): Promise<ThreadMessage[]> {
    this.assertReader(readerSub);
    const wanted = [...new Set(ids)].slice(0, MESSAGE_PAGE_MAX);
    if (wanted.length === 0) return [];
    const rows = this.ctx.storage.sql.exec<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id IN (${wanted.map(() => '?').join(', ')}) ORDER BY sent_at ASC`,
      ...wanted,
    ).toArray();
    return this.toMessages(rows, readerSub);
  }

  /** Stored rows as the wire's messages, for one reader. */
  private toMessages(rows: MessageRow[], readerSub: string): ThreadMessage[] {
    const threadId = this.ctx.storage.sql
      .exec<{ thread_id: string }>('SELECT thread_id FROM thread WHERE row = 1')
      .toArray()[0]?.thread_id ?? this.ctx.id.toString();

    const ids = rows.map((row) => row.id);
    const reactions = this.reactionsFor(ids, readerSub);
    const attachments = this.attachmentsFor(ids);

    return rows.map((row) => {
      // Rows written before the column existed are somebody typing.
      const type: ThreadMessageType = row.type === 'event' ? 'event' : 'text';
      const message: ThreadMessage = {
        id: row.id,
        thread_id: threadId,
        sent_at: row.sent_at,
        sender_email: row.sender_email,
        sender_name: row.sender_name,
        text: row.text,
        is_mine: row.sender_sub === readerSub,
        type,
        reply_to_message_id: row.reply_to_message_id,
      };
      // Refs are no longer an event-only field: a message composed from a
      // task carries the task it was composed from, which is what lets the
      // transcript and the work beside it point at each other.
      const refs = parseRefs(row.refs);
      if (refs.length > 0) message.refs = refs;
      const mentions = parseMentions(row.mentions);
      if (mentions.length > 0) message.mentions = mentions;
      const files = attachments.get(row.id);
      if (files?.length) message.attachments = files;
      const pills = reactions.get(row.id);
      if (pills?.length) message.reactions = pills;
      if (row.edited_at !== null) message.edited_at = row.edited_at;
      if (row.deleted_at !== null) message.deleted_at = row.deleted_at;
      if (row.partial === 1) message.partial = true;
      if (row.origin === 'slack' || row.origin === 'guest' || row.origin === 'peer' || row.origin === 'app') message.origin = row.origin;
      if (row.via !== null && type === 'text') message.via = row.via;
      const handoff = parseHandoff(row.handoff);
      if (handoff) message.handoff = handoff;
      const question = parseQuestion(row.question);
      if (question) message.question = question;
      const answer = parseQuestionAnswer(row);
      if (answer) message.question_answer = answer;
      const releaseRequest = parseReleaseRequest(row.release_request);
      if (releaseRequest && row.deleted_at === null) {
        message.release_request = releaseRequest;
        const releaseState = parseReleaseState(row.release_state);
        if (releaseState) message.release_state = releaseState;
      }
      return message;
    });
  }

  /** A compact, member-scoped feed of finalized message changes for MCP. */
  async changesSince(
    readerSub: string,
    cursor: McpChangeCursor,
    requestedLimit = MCP_CHANGES_PAGE_SIZE,
  ): Promise<{
    changes: Array<{
      id: string;
      changed_at: number;
      change: 'created' | 'updated' | 'deleted';
      summary: string;
      actor: { name: string | null; email: string };
    }>;
    hasMore: boolean;
  }> {
    this.assertReader(readerSub);
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), MCP_CHANGES_PAGE_SIZE);
    const select = `SELECT id, changed_at, sender_email, sender_name,
                           substr(text, 1, 79) AS summary, length(text) AS text_length,
                           edited_at, deleted_at
                      FROM messages
                     WHERE (partial IS NULL OR partial = 0)
                       AND `;
    const rows = cursor.id === null
      ? this.ctx.storage.sql.exec<{
        id: string; changed_at: number; sender_email: string; sender_name: string | null;
        summary: string; text_length: number; edited_at: number | null; deleted_at: number | null;
      }>(`${select}changed_at > ? ORDER BY changed_at ASC, id ASC LIMIT ?`, cursor.changed_at, limit + 1).toArray()
      : this.ctx.storage.sql.exec<{
        id: string; changed_at: number; sender_email: string; sender_name: string | null;
        summary: string; text_length: number; edited_at: number | null; deleted_at: number | null;
      }>(`${select}(changed_at > ? OR (changed_at = ? AND id > ?)) ORDER BY changed_at ASC, id ASC LIMIT ?`, cursor.changed_at, cursor.changed_at, cursor.id, limit + 1).toArray();
    const hasMore = rows.length > limit;
    return {
      changes: rows.slice(0, limit).map((row) => ({
        id: row.id,
        changed_at: row.changed_at,
        change: row.deleted_at !== null ? 'deleted' : row.edited_at !== null ? 'updated' : 'created',
        summary: row.deleted_at !== null
          ? 'Message withdrawn'
          : `${row.summary}${row.text_length > 79 ? '…' : ''}`,
        actor: { name: row.sender_name, email: row.sender_email },
      })),
      hasMore,
    };
  }

  /**
   * One message, by id, for the Worker to attribute something to.
   *
   * The inbound door uses this to find the **person** an agent's move is made
   * on behalf of: the hand-off named a message, and this says who sent it.
   * The reader is checked exactly as for a page, so an agent can only point
   * at messages in conversations it may read.
   */
  async message(
    readerSub: string,
    id: string,
  ): Promise<{
    id: string; senderSub: string; senderEmail: string; senderName: string | null; type: ThreadMessageType;
    text: string; origin: string | null; sentAt: number; withdrawn: boolean;
  } | null> {
    this.assertReader(readerSub);
    const row = this.ctx.storage.sql.exec<{
      id: string; sender_sub: string; sender_email: string; sender_name: string | null; type: string | null;
      text: string; origin: string | null; sent_at: number; deleted_at: number | null;
    }>('SELECT id, sender_sub, sender_email, sender_name, type, text, origin, sent_at, deleted_at FROM messages WHERE id = ?', id).toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      senderSub: row.sender_sub,
      senderEmail: row.sender_email,
      senderName: row.sender_name,
      type: row.type === 'event' ? 'event' : 'text',
      // Read by a support request: its title, and whether the line came from outside.
      text: row.text,
      origin: row.origin,
      sentAt: row.sent_at,
      withdrawn: row.deleted_at !== null,
    };
  }

  /**
   * Record what happened to an agent's release request. Approve
   * moves a waiting card to approved; end moves an approved or used card to
   * ended; used (the Worker, after the agent's fetch) moves an approved card
   * to used. A repeat of the act that already happened changes nothing.
   * Anything else is `release_request_closed`. Keep is the authority on the
   * release itself; this is the card.
   */
  async updateRelease(
    actor: { sub: string; email: string; name: string | null },
    messageId: string,
    update: ReleaseCardUpdate,
    at: number,
  ): Promise<{ message: ThreadMessage; changed: boolean; request: ThreadReleaseRequest; authorEmail: string; state: ThreadReleaseState }> {
    this.assertReader(actor.sub);
    const row = this.ctx.storage.sql.exec<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`, messageId).toArray()[0];
    const request = row ? parseReleaseRequest(row.release_request) : null;
    if (!row || !request || row.deleted_at !== null || row.partial === 1) {
      throw new ThreadError('That request is not open.', 409, 'release_request_closed');
    }
    const current = parseReleaseState(row.release_state);
    let next: ThreadReleaseState | null = null;
    if (update.action === 'approve') {
      if (current) {
        if (current.approver_email === actor.email) return this.releaseResult(row, actor.sub, request, current, false);
        throw new ThreadError('That request is not open.', 409, 'release_request_closed');
      }
      next = {
        status: 'approved',
        approver_email: actor.email,
        approver_name: actor.name,
        approved_at: at,
        expires_at: update.expiresAt,
        vault_id: update.vaultId,
        item_name: update.itemName,
      };
    } else if (update.action === 'end') {
      if (current?.status === 'ended') return this.releaseResult(row, actor.sub, request, current, false);
      if (!current) throw new ThreadError('That request is not open.', 409, 'release_request_closed');
      next = { ...current, status: 'ended', ended_at: at, ended_by_email: update.endedBy };
    } else {
      if (current?.status === 'used') return this.releaseResult(row, actor.sub, request, current, false);
      if (current?.status !== 'approved') throw new ThreadError('That request is not open.', 409, 'release_request_closed');
      next = { ...current, status: 'used', used_at: at };
    }
    this.ctx.storage.sql.exec('UPDATE messages SET release_state = ?, changed_at = ? WHERE id = ?', JSON.stringify(next), at, messageId);
    return this.releaseResult({ ...row, release_state: JSON.stringify(next), changed_at: at }, actor.sub, request, next, true);
  }

  /** A release card as stored, for the Worker's fetch on the agent's behalf. */
  async releaseCard(
    readerSub: string,
    messageId: string,
  ): Promise<{ authorSub: string; authorEmail: string; request: ThreadReleaseRequest; state: ThreadReleaseState | null } | null> {
    this.assertReader(readerSub);
    const row = this.ctx.storage.sql.exec<{ sender_sub: string; sender_email: string; release_request: string | null; release_state: string | null; deleted_at: number | null }>(
      'SELECT sender_sub, sender_email, release_request, release_state, deleted_at FROM messages WHERE id = ?', messageId,
    ).toArray()[0];
    const request = row && row.deleted_at === null ? parseReleaseRequest(row.release_request) : null;
    if (!row || !request) return null;
    return { authorSub: row.sender_sub, authorEmail: row.sender_email, request, state: parseReleaseState(row.release_state) };
  }

  private releaseResult(
    row: MessageRow,
    readerSub: string,
    request: ThreadReleaseRequest,
    state: ThreadReleaseState,
    changed: boolean,
  ): { message: ThreadMessage; changed: boolean; request: ThreadReleaseRequest; authorEmail: string; state: ThreadReleaseState } {
    const threadId = this.ctx.storage.sql
      .exec<{ thread_id: string }>('SELECT thread_id FROM thread WHERE row = 1')
      .toArray()[0]?.thread_id ?? this.ctx.id.toString();
    const message: ThreadMessage = {
      id: row.id,
      thread_id: threadId,
      sent_at: row.sent_at,
      sender_email: row.sender_email,
      sender_name: row.sender_name,
      text: row.text,
      is_mine: row.sender_sub === readerSub,
      type: 'text',
      reply_to_message_id: row.reply_to_message_id,
      release_request: request,
      release_state: state,
    };
    const refs = parseRefs(row.refs);
    if (refs.length > 0) message.refs = refs;
    const mentions = parseMentions(row.mentions);
    if (mentions.length > 0) message.mentions = mentions;
    const files = this.attachmentsFor([row.id]).get(row.id);
    if (files?.length) message.attachments = files;
    const pills = this.reactionsFor([row.id], readerSub).get(row.id);
    if (pills?.length) message.reactions = pills;
    if (row.edited_at !== null) message.edited_at = row.edited_at;
    return { message, changed, request, authorEmail: row.sender_email, state };
  }

  /**
   * Lines in the transcript, withdrawn ones excluded. For Admin's list of
   * channels without a subject; it reads no content and takes no
   * reader, so only an admin route may call it.
   */
  async messageCount(): Promise<number> {
    return this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NULL')
      .one().count;
  }

  async isMember(sub: string): Promise<boolean> {
    return this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM members WHERE sub = ?', sub)
      .one().count > 0;
  }

  /**
   * Who may read and write here. A DM needs a membership row. A channel needs
   * nothing further: the Worker has already proved the caller is an Envisioning
   * member, and that is the whole of a channel's audience.
   */
  private assertReader(sub: string): void {
    if (this.audience() === 'everyone') return;
    const rows = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM members WHERE sub = ?', sub)
      .one().count;
    // Same wording as a missing thread on purpose: whether a conversation
    // exists is itself something a non-member should not learn.
    if (rows === 0) throw new ThreadError('Conversation not found.', 404, 'room_not_found');
  }

  private audience(): ThreadAudience {
    const row = this.ctx.storage.sql
      .exec<{ audience: string | null }>('SELECT audience FROM thread WHERE row = 1')
      .toArray()[0];
    // A thread written before this column existed is a DM. Defaulting the other
    // way would open every one of them to the whole company.
    return row?.audience === 'everyone' ? 'everyone' : 'members';
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS thread (
        row       INTEGER PRIMARY KEY CHECK (row = 1),
        thread_id TEXT NOT NULL,
        kind      TEXT NOT NULL,
        parent_id TEXT,
        audience  TEXT NOT NULL DEFAULT 'members'
      );
      CREATE TABLE IF NOT EXISTS members (
        sub   TEXT PRIMARY KEY,
        email TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        sent_at      INTEGER NOT NULL,
        changed_at   INTEGER NOT NULL,
        sender_sub   TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        sender_name  TEXT,
        text         TEXT NOT NULL,
        type         TEXT NOT NULL DEFAULT 'text',
        refs         TEXT,
        reply_to_message_id TEXT,
        question TEXT,
        question_answer_question_id TEXT,
        question_answer_option_ids TEXT,
        question_answer_option_labels TEXT,
        release_request TEXT,
        release_state TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_sent_idx ON messages(sent_at);
      CREATE TABLE IF NOT EXISTS question_assignments (
        message_id TEXT PRIMARY KEY,
        recipient_email TEXT NOT NULL,
        context TEXT NOT NULL
      );
      -- One row per person per emoji per message; toggling twice is impossible.
      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL,
        emoji      TEXT NOT NULL,
        sub        TEXT NOT NULL,
        email      TEXT NOT NULL,
        name       TEXT,
        at         INTEGER NOT NULL,
        PRIMARY KEY (message_id, emoji, sub)
      );
      CREATE INDEX IF NOT EXISTS reactions_message_idx ON reactions(message_id);
      -- File metadata. The bytes are in R2 under this id; nothing here is ever
      -- the object key, so a row cannot be turned into a URL by reading it.
      --
      -- message_id is null while an upload is staged and set when the message
      -- carrying it is sent, which is what makes an abandoned composer inert:
      -- an unbound row is read by nothing except the person who staged it.
      CREATE TABLE IF NOT EXISTS attachments (
        id           TEXT PRIMARY KEY,
        message_id   TEXT,
        owner_sub    TEXT NOT NULL,
        name         TEXT NOT NULL,
        content_type TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        width        INTEGER,
        height       INTEGER,
        created_at   INTEGER NOT NULL,
        deleted_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id);
    `);
    // `CREATE TABLE IF NOT EXISTS` does nothing for a Durable Object that
    // already has these tables, so a new column is an explicit ALTER guarded by
    // the current shape — the same pattern `RoomCoordinator` uses.
    const threadColumns = this.ctx.storage.sql
      .exec<{ name: string }>('PRAGMA table_info(thread)').toArray();
    if (!threadColumns.some((column) => column.name === 'audience')) {
      this.ctx.storage.sql.exec("ALTER TABLE thread ADD COLUMN audience TEXT NOT NULL DEFAULT 'members'");
    }
    const messageColumns = this.ctx.storage.sql
      .exec<{ name: string }>('PRAGMA table_info(messages)').toArray();
    if (!messageColumns.some((column) => column.name === 'type')) {
      this.ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
    }
    if (!messageColumns.some((column) => column.name === 'reply_to_message_id')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT');
    }
    if (!messageColumns.some((column) => column.name === 'question')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN question TEXT');
    }
    if (!messageColumns.some((column) => column.name === 'question_answer_question_id')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN question_answer_question_id TEXT');
    }
    if (!messageColumns.some((column) => column.name === 'question_answer_option_ids')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN question_answer_option_ids TEXT');
    }
    if (!messageColumns.some((column) => column.name === 'question_answer_option_labels')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN question_answer_option_labels TEXT');
    }
    // An agent's request for one Keep item, and its card's state.
    if (!messageColumns.some((column) => column.name === 'release_request')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN release_request TEXT');
    }
    if (!messageColumns.some((column) => column.name === 'release_state')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN release_state TEXT');
    }
    this.ctx.storage.sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS messages_question_answer_idx ON messages(question_answer_question_id) WHERE question_answer_question_id IS NOT NULL',
    );
    // What a line points at, as JSON. Written by the work graph on an event and
    // by a composer on a message sent from a task.
    if (!messageColumns.some((column) => column.name === 'refs')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN refs TEXT');
    }
    // Where an imported row came from (`slack`) and which container there
    // (the channel id), so one import can be reversed without touching what
    // was said in Meet (docs/SLACK_IMPORT.md). Null on every native row.
    if (!messageColumns.some((column) => column.name === 'origin')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN origin TEXT');
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN origin_ref TEXT');
      this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS messages_origin_idx ON messages(origin, origin_ref)');
    }
    // The MCP client a member's own message was sent through ("claude.ai").
    // Taken from the session token, never a body, so the tag can be trusted.
    if (!messageColumns.some((column) => column.name === 'via')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN via TEXT');
    }
    // Who a message names, as JSON. Stored beside the text rather than parsed
    // out of it: the body is prose and may be edited, and whether somebody was
    // notified must not change when a word does.
    if (!messageColumns.some((column) => column.name === 'mentions')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN mentions TEXT');
    }
    // Both null on a message said once and never taken back, which is almost
    // all of them — the two columns cost nothing until somebody uses them.
    if (!messageColumns.some((column) => column.name === 'edited_at')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
    }
    if (!messageColumns.some((column) => column.name === 'deleted_at')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN deleted_at INTEGER');
    }
    if (!messageColumns.some((column) => column.name === 'changed_at')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN changed_at INTEGER');
      this.ctx.storage.sql.exec('UPDATE messages SET changed_at = COALESCE(deleted_at, edited_at, sent_at)');
    }
    this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS messages_changed_idx ON messages(changed_at, id)');
    // 1 while an agent is still streaming the row; null once it is final, and
    // on every row a person wrote. See `append`.
    if (!messageColumns.some((column) => column.name === 'partial')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN partial INTEGER');
    }
    // A Hand off's brief as JSON: what done looks like, what comes
    // back. Null on every message that hands nothing off.
    if (!messageColumns.some((column) => column.name === 'handoff')) {
      this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN handoff TEXT');
    }
  }
}

function toAttachment(row: AttachmentRow): ThreadMessageAttachment {
  const attachment: ThreadMessageAttachment = {
    id: row.id,
    name: row.name,
    content_type: row.content_type,
    bytes: row.bytes,
  };
  // Only for pictures whose uploader measured them. Present so a transcript
  // reserves the right box before the bytes land, instead of reflowing — and
  // throwing away somebody's scroll position — as each one arrives.
  if (row.width !== null) attachment.width = row.width;
  if (row.height !== null) attachment.height = row.height;
  return attachment;
}
