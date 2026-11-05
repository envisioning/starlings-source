package work.starlings.android.api

import work.starlings.contracts.Acknowledgement
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.MessageEditResponse
import work.starlings.contracts.MessageReactionsResponse
import work.starlings.contracts.MessageWithdrawResponse
import work.starlings.contracts.Patch
import work.starlings.contracts.PeerDoNotDisturbRequest
import work.starlings.contracts.PeerDoNotDisturbResponse
import work.starlings.contracts.PeerHeartbeatRequest
import work.starlings.contracts.PeerIntent
import work.starlings.contracts.PeerIntentRequest
import work.starlings.contracts.PeerIntentResponse
import work.starlings.contracts.PeersResponse
import work.starlings.contracts.SentMessageResponse
import work.starlings.contracts.ThreadArchiveRequest
import work.starlings.contracts.ThreadChannelOpenRequest
import work.starlings.contracts.ThreadEditRequest
import work.starlings.contracts.ThreadGroupOpenRequest
import work.starlings.contracts.ThreadHandoff
import work.starlings.contracts.ThreadMessagesQuery
import work.starlings.contracts.ThreadMessagesResponse
import work.starlings.contracts.ThreadMuteRequest
import work.starlings.contracts.ThreadOpenRequest
import work.starlings.contracts.ThreadReactionRequest
import work.starlings.contracts.ThreadReadRequest
import work.starlings.contracts.ThreadResponse
import work.starlings.contracts.ThreadSendRef
import work.starlings.contracts.ThreadSendRequest
import work.starlings.contracts.ThreadSubjectOpenRequest
import work.starlings.contracts.ThreadsResponse
import java.time.Instant

/**
 * Team: the roster and presence of `Sources/StarlingsPeerRoutes.swift`, and
 * the conversations of `Sources/StarlingsThreadRoutes.swift`.
 */
object TeamRoutes {
    // Roster and presence

    /**
     * Who else is around. Members only. A client that keeps the snapshot
     * paints the roster's identity from it, never who is around
     * (docs/CACHING.md, "Never cached").
     */
    val peers = Route(
        "GET", listOf("peers"), answer = Answer.Wire(PeersResponse.serializer()),
        operation = "Couldn’t load your team", snapshotKey = SnapshotKey.PEERS,
    )

    /**
     * "This device has Starlings open", with the device's time zone.
     * `client` stays out: the contract names mac, ios and web only, and the
     * Worker reads Android from `x-meet-client`.
     */
    fun heartbeat(timeZone: String): Route<Acknowledgement> = Route(
        "POST", listOf("owner", "heartbeat"), body = json(PeerHeartbeatRequest.serializer(), PeerHeartbeatRequest(timezone = timeZone)),
        answer = Answer.Wire(Acknowledgement.serializer()), operation = "Couldn’t check in",
    )

    /** Unavailable until [until], absolute; null turns it off. */
    fun doNotDisturb(until: Instant?): Route<PeerDoNotDisturbResponse> = Route(
        "POST", listOf("peers", "dnd"), body = json(PeerDoNotDisturbRequest.serializer(), PeerDoNotDisturbRequest(until?.toEpochMilli())),
        answer = Answer.Wire(PeerDoNotDisturbResponse.serializer()), operation = "Couldn’t change your status",
    )

    /** What the person says about themselves. Focused requires [until]; nothing else takes one. */
    fun intent(intent: PeerIntent?, until: Instant?): Route<PeerIntentResponse> = Route(
        "POST", listOf("peers", "intent"),
        body = json(PeerIntentRequest.serializer(), PeerIntentRequest(intent, Patch.ifSome(until?.toEpochMilli()))),
        answer = Answer.Wire(PeerIntentResponse.serializer()), operation = "Couldn’t change your status",
    )

    // Conversations

    val threads = Route(
        "GET", listOf("threads"), answer = Answer.Wire(ThreadsResponse.serializer()),
        operation = "Couldn’t load your conversations", snapshotKey = SnapshotKey.THREADS,
    )

    /** Find-or-create the DM with one peer. Idempotent at the Worker. */
    fun open(peerEmail: String) = opening(json(ThreadOpenRequest.serializer(), ThreadOpenRequest(peerEmail)))

    /** Find-or-create the private conversation with these people. */
    fun open(peerEmails: List<String>) = opening(json(ThreadGroupOpenRequest.serializer(), ThreadGroupOpenRequest(peerEmails)))

    /** Find-or-create the channel. */
    val openChannel = opening(json(ThreadChannelOpenRequest.serializer(), ThreadChannelOpenRequest()))

    /** Find-or-create the conversation on one CRM subject. */
    fun openSubject(kind: CrmSubjectKind, subjectId: String) =
        opening(json(ThreadSubjectOpenRequest.serializer(), ThreadSubjectOpenRequest(kind, subjectId)))

    private fun opening(body: String): Route<ThreadResponse> = Route(
        "POST", listOf("threads"), body = body, answer = Answer.Wire(ThreadResponse.serializer()),
        operation = "Couldn’t open that conversation", writes = listOf(SnapshotWrite.THREAD_OPEN),
    )

    fun messages(threadId: String, before: String? = null, limit: Long? = null): Route<ThreadMessagesResponse> = Route(
        "GET", listOf("threads", threadId, "messages"), query = ThreadMessagesQuery(before = before, limit = limit).queryItems(),
        answer = Answer.Wire(ThreadMessagesResponse.serializer()), operation = "Couldn’t load this conversation",
    )

    fun send(
        threadId: String,
        text: String,
        refs: List<ThreadSendRef> = emptyList(),
        mentions: List<String> = emptyList(),
        attachments: List<String> = emptyList(),
        replyToMessageId: String? = null,
        handoff: ThreadHandoff? = null,
    ): Route<SentMessageResponse> = Route(
        "POST", listOf("threads", threadId, "messages"),
        body = json(
            ThreadSendRequest.serializer(),
            ThreadSendRequest(
                text = text,
                refs = refs.ifEmpty { null },
                mentions = mentions.ifEmpty { null },
                attachments = attachments.ifEmpty { null },
                replyToMessageId = Patch.ifSome(replyToMessageId),
                handoff = handoff,
            ),
        ),
        answer = Answer.Wire(SentMessageResponse.serializer()), operation = "Couldn’t send that message",
        writes = listOf(SnapshotWrite.THREAD_MESSAGE),
    )

    /** Add or remove one emoji: the same call either way. */
    fun react(threadId: String, messageId: String, emoji: String): Route<MessageReactionsResponse> = Route(
        "POST", listOf("threads", threadId, "messages", messageId, "reactions"),
        body = json(ThreadReactionRequest.serializer(), ThreadReactionRequest(emoji)),
        answer = Answer.Wire(MessageReactionsResponse.serializer()), operation = "Couldn’t react to that message",
    )

    fun edit(threadId: String, messageId: String, text: String): Route<MessageEditResponse> = Route(
        "PATCH", listOf("threads", threadId, "messages", messageId), body = json(ThreadEditRequest.serializer(), ThreadEditRequest(text)),
        answer = Answer.Wire(MessageEditResponse.serializer()), operation = "Couldn’t edit that message",
    )

    fun withdraw(threadId: String, messageId: String): Route<MessageWithdrawResponse> = Route(
        "DELETE", listOf("threads", threadId, "messages", messageId),
        answer = Answer.Wire(MessageWithdrawResponse.serializer()), operation = "Couldn’t withdraw that message",
    )

    /** A null [until] is sent as null, which unmutes. */
    fun mute(threadId: String, until: Instant?): Route<Acknowledgement> = Route(
        "POST", listOf("threads", threadId, "mute"), body = json(ThreadMuteRequest.serializer(), ThreadMuteRequest(until?.toEpochMilli())),
        answer = Answer.Wire(Acknowledgement.serializer()), operation = "Couldn’t mute that conversation",
        writes = listOf(SnapshotWrite.THREAD_STATE),
    )

    fun archive(threadId: String, archived: Boolean): Route<Acknowledgement> = Route(
        "POST", listOf("threads", threadId, "archive"), body = json(ThreadArchiveRequest.serializer(), ThreadArchiveRequest(archived)),
        answer = Answer.Wire(Acknowledgement.serializer()), operation = "Couldn’t archive that conversation",
        writes = listOf(SnapshotWrite.THREAD_STATE),
    )

    /** Best effort: a missed read receipt costs one unread dot. */
    fun markRead(threadId: String): Route<Acknowledgement> = Route(
        "POST", listOf("threads", threadId, "read"), body = json(ThreadReadRequest.serializer(), ThreadReadRequest()),
        answer = Answer.Wire(Acknowledgement.serializer()), operation = "Couldn’t mark as read",
        writes = listOf(SnapshotWrite.THREAD_STATE),
    )
}
