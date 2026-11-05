import CoreGraphics
import Foundation
import StarlingsContracts

/// The conversation routes, each named once for the Mac and the
/// phone: the thread list, opening a DM, a group, the channel or a subject's
/// conversation, the messages and what is done to them, files, link previews
/// and an agent's cancel. `MeetingControlAPI` and `StarlingsAPI` send them.
enum StarlingsThreadRoutes {
    static let threads = StarlingsRoute<ThreadListResponse>(
        method: "GET", path: ["threads"],
        operation: String(localized: "Couldn’t load your conversations"),
        snapshotKey: StarlingsSnapshotKey.threads
    )

    // MARK: Opening

    /// Find-or-create the DM with one peer. Idempotent at the Worker: the id
    /// is derived from both people, so asking twice is the same conversation.
    static func open(peerEmail: String) -> StarlingsRoute<ThreadEnvelope> {
        open(ThreadOpenRequest(peerEmail: peerEmail))
    }

    /// Find-or-create the private conversation with these people. Two
    /// addresses derive exactly what one peer derives, which is why a group
    /// is not a different kind of thing.
    static func open(peerEmails: [String]) -> StarlingsRoute<ThreadEnvelope> {
        open(ThreadGroupOpenRequest(peerEmails: peerEmails))
    }

    /// Find-or-create the channel. The id is fixed, so the first person to
    /// ask is the one who creates it.
    static let openChannel = open(ThreadChannelOpenRequest())

    /// Find-or-create the conversation on one CRM subject. Core decides
    /// whether the subject exists and what it is called; this sends an id.
    static func openSubject(kind: String, subjectID: String) -> StarlingsRoute<ThreadEnvelope> {
        open(ThreadSubjectOpenRequest(kind: .init(rawValue: kind), subjectID: subjectID))
    }

    private static func open(_ body: some Encodable & Sendable) -> StarlingsRoute<ThreadEnvelope> {
        StarlingsRoute(
            method: "POST", path: ["threads"], body: body,
            operation: String(localized: "Couldn’t open that conversation"),
            writes: [.threadOpen]
        )
    }

    // MARK: Messages

    static func messages(threadID: String, before: String?, limit: Int?) -> StarlingsRoute<ThreadMessagesPage> {
        StarlingsRoute(
            method: "GET", path: ["threads", threadID, "messages"],
            query: ThreadMessagesQuery(before: before, limit: limit).queryItems,
            operation: String(localized: "Couldn’t load this conversation")
        )
    }

    /// What was said about one task or issue, across the threads the member
    /// can read, oldest first.
    static func cardLines(kind: String, id: String) -> StarlingsRoute<CardLinesResponse> {
        StarlingsRoute(
            method: "GET", path: ["card-lines"],
            query: [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "id", value: id)],
            operation: String(localized: "Couldn’t load what was said about this")
        )
    }

    static func send(
        threadID: String,
        text: String,
        refs: [ThreadMessageRef],
        mentions: [String],
        attachments: [String],
        replyToMessageID: String?,
        handoff: ThreadHandoff?
    ) -> StarlingsRoute<SentMessageEnvelope> {
        StarlingsRoute(
            method: "POST", path: ["threads", threadID, "messages"],
            body: ThreadSendRequest(
                text: text,
                refs: refs.isEmpty ? nil : refs.map { ThreadSendRef(kind: $0.kind, id: $0.id) },
                mentions: mentions.isEmpty ? nil : mentions,
                attachments: attachments.isEmpty ? nil : attachments,
                replyToMessageID: replyToMessageID.map { Patch<String>.value($0) } ?? .omit,
                handoff: handoff
            ),
            operation: String(localized: "Couldn’t send that message"),
            writes: [.threadMessage]
        )
    }

    /// One explicit selection on an agent-authored question. The Worker
    /// answers the committed winner when another member answered first.
    static func answerQuestion(threadID: String, messageID: String, optionIDs: [String]) -> StarlingsRoute<ThreadQuestionAnswerResponse> {
        StarlingsRoute(
            method: "POST", path: ["threads", threadID, "questions", messageID, "answer"],
            body: ThreadQuestionAnswerRequest(optionIDs: optionIDs),
            operation: String(localized: "Couldn’t submit this answer")
        )
    }

    /// Record on an agent's Keep release card what this device did in Keep
    ///. Keep acted first.
    static func updateRelease(threadID: String, messageID: String, _ update: ThreadReleaseUpdateRequest) -> StarlingsRoute<ThreadReleaseUpdateResponse> {
        StarlingsRoute(
            method: "POST", path: ["threads", threadID, "releases", messageID], body: update,
            operation: String(localized: "Couldn’t update the card")
        )
    }

    /// Add or remove one emoji: the same call either way, because the surface
    /// is one pill you press.
    static func react(threadID: String, messageID: String, emoji: String) -> StarlingsRoute<MessageReactionsResponse> {
        StarlingsRoute(
            method: "POST", path: ["threads", threadID, "messages", messageID, "reactions"],
            body: ThreadReactionRequest(emoji: emoji),
            operation: String(localized: "Couldn’t react to that message")
        )
    }

    /// Rewrite your own message. The Worker refuses somebody else's with the
    /// 404 a missing one gets, and one past the window with
    /// `message_not_editable`.
    static func edit(threadID: String, messageID: String, text: String) -> StarlingsRoute<MessageEditResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["threads", threadID, "messages", messageID],
            body: ThreadEditRequest(text: text),
            operation: String(localized: "Couldn’t edit that message")
        )
    }

    /// Withdraw your own message. The row keeps its place; the text and any
    /// files on it are gone.
    static func withdraw(threadID: String, messageID: String) -> StarlingsRoute<MessageWithdrawResponse> {
        StarlingsRoute(
            method: "DELETE", path: ["threads", threadID, "messages", messageID],
            operation: String(localized: "Couldn’t withdraw that message")
        )
    }

    // MARK: Per member

    /// Silence one conversation, or let it speak again. A nil `until` is sent
    /// as null, which unmutes.
    static func mute(threadID: String, until: Date?) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoute(
            method: "POST", path: ["threads", threadID, "mute"],
            body: ThreadMuteRequest(until: until.map { Int($0.timeIntervalSince1970 * 1000) }),
            operation: String(localized: "Couldn’t mute that conversation"),
            writes: [.threadState]
        )
    }

    /// Put a conversation away, or take it back out. Anything said from now
    /// on brings the row back.
    static func archive(threadID: String, archived: Bool) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoute(
            method: "POST", path: ["threads", threadID, "archive"],
            body: ThreadArchiveRequest(archived: archived),
            operation: String(localized: "Couldn’t archive that conversation"),
            writes: [.threadState]
        )
    }

    /// Best-effort: a missed read receipt costs one unread dot.
    static func markRead(threadID: String) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoute(
            method: "POST", path: ["threads", threadID, "read"], body: ThreadReadRequest(),
            operation: String(localized: "Couldn’t mark as read"),
            writes: [.threadState]
        )
    }

    // MARK: Files

    /// Reserve somewhere to put one file. The bytes go to the path the answer
    /// names (`uploadAttachment`). A staged upload nobody sends is inert.
    static func stageAttachment(threadID: String, name: String, contentType: String, bytes: Int, pixelSize: CGSize?) -> StarlingsRoute<AttachmentStagedResponse> {
        StarlingsRoute(
            method: "POST", path: ["threads", threadID, "attachments"],
            body: AttachmentStageRequest(
                name: name,
                contentType: contentType,
                bytes: bytes,
                width: pixelSize.map { Int($0.width) },
                height: pixelSize.map { Int($0.height) }
            ),
            operation: String(localized: "Couldn’t prepare that file")
        )
    }

    /// The bytes, to the path the stage answered. The Worker hands back a
    /// path rather than a URL: each client knows its own origin. Generous on
    /// time: this carries megabytes.
    static func uploadAttachment(uploadPath: String, contentType: String, data: Data) -> StarlingsRoute<AttachmentUploadedResponse> {
        let trimmed = uploadPath.hasPrefix("/api/") ? String(uploadPath.dropFirst(5)) : uploadPath
        return StarlingsRoute(
            method: "PUT", path: trimmed.split(separator: "/").map(String.init),
            upload: StarlingsUpload(data: data, contentType: contentType),
            operation: String(localized: "Couldn’t upload that file"),
            timeout: 120,
            origin: true
        )
    }

    /// The bytes of one attachment, for drawing it. Authenticated like every
    /// other read: an object key is never a link somebody can pass on.
    static func attachment(threadID: String, attachmentID: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "GET", path: ["threads", threadID, "attachments", attachmentID],
            operation: String(localized: "Couldn’t open that file"),
            timeout: 30
        )
    }

    /// What a pasted link points at, read by the Worker rather than by the
    /// device: a client fetching its own links tells every site the address
    /// of everyone who was in the conversation.
    static func linkPreview(url link: String) -> StarlingsRoute<LinkPreviewEnvelope> {
        StarlingsRoute(
            method: "GET", path: ["link-preview"],
            query: LinkPreviewQuery(url: link).queryItems,
            operation: String(localized: "Couldn’t read that link")
        )
    }

    /// Tell an agent to stop working a card taken back on the board. The
    /// card moved anyway; the answer is what the runtime knows.
    static func cancelAgent(email: String, ref: ThreadMessageRef) -> StarlingsRoute<AgentCancelResponse> {
        StarlingsRoute(
            method: "POST", path: ["agents", "cancel"],
            body: AgentCancelRequest(agentEmail: email, ref: AgentCancelRef(kind: .init(rawValue: ref.kind.rawValue), id: ref.id)),
            operation: String(localized: "Couldn’t tell the agent to stop")
        )
    }
}

/// What an agent's runtime said to a cancel.
struct AgentCancelResponse: Decodable, Sendable {
    let told: Bool
    /// `accepted`, `failed`, or `no_runtime`. Absent from a Worker that
    /// predates it, in which case `told` decides.
    let delivery: String?
}
