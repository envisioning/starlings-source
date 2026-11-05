import Foundation

// Direct messages, shared by the Mac app and the iOS app. Wire types only —
// the conversation is drawn very differently in a window and on a phone, but
// what a thread *is* must not diverge between them.
//
// A thread's parent is polymorphic from the first schema: a DM has none, and a
// thread on a meeting or a calendar event carries one. That is the shape that
// cannot be retrofitted cheaply, so both clients decode it now even though only
// `dm` exists. See docs/WORK_SURFACE.md.
/// The values are the contract's (`THREAD_KINDS`, generated); what each one
/// means to a surface lives here. `partner` is a partner's channel on its
/// organization (PARTNERS (HQ Docs)), `event` an event's on its CMS id
/// (docs/EVENTS.md): the same door as a project's. A kind this client has
/// never seen decodes as itself and reads as a conversation.
extension ThreadKind {
    /// What to call this kind of channel in a sentence.
    var channelNoun: String {
        switch self {
        case .project: String(localized: "project")
        case .lead: String(localized: "lead")
        case .organization: String(localized: "partner")
        case .event: String(localized: "event")
        case .team: String(localized: "team")
        default: String(localized: "conversation")
        }
    }

    /// A conversation nobody owns. Channels are drawn in their own section, and
    /// they are never named after a person.
    var isChannel: Bool {
        switch self {
        case .project, .lead, .organization, .event, .team: true
        default: false
        }
    }

    /// A channel on a CRM subject: the conversations that live in Work, beside
    /// the tasks on the same project or lead. `team` is a channel too, but it
    /// is about everybody rather than about anything, so it stays with the
    /// people in Team. Every surface that routes an unread message splits on
    /// this, so a dot can never point at a door the conversation is not behind.
    var isSubjectChannel: Bool {
        switch self {
        case .project, .lead, .organization, .event: true
        default: false
        }
    }
}

/// Who a thread is addressed to. `members` is a DM — the membership row is the
/// authorization. `everyone` is a channel, readable by any Envisioning member.
/// See docs/CHANNELS.md.
enum TeamThread {
    static let id = "team"
    static let title = String(localized: "Everyone")
    static var subtitle: String { String(localized: "Everybody at \(StarlingsWorkspace.active.name)") }
    static let prompt = "Message everyone"
    static let emptyLine = "Nothing here yet."
}

/// `text` is somebody typing. `event` is the work graph reporting itself — a
/// meeting filed here, a meeting ended, notes filed, a task the meeting
/// produced. One transcript, two voices; a client draws an event as a quiet
/// line, never as a bubble. Unknown decodes as text: a client too old to know
/// a type still shows the words.
/// What an event line is about — a meeting, a task, an issue — so a client
/// can open the thing rather than parse the prose. Generated; a kind this
/// client does not know is still a ref, read here by its raw value.
extension ThreadMessageRef {
    init(kind: String, id: String) {
        self.init(kind: ThreadMessageRefKind(rawValue: kind), id: id)
    }

    /// The github.com page a GitHub ref names — mirror of the
    /// contracts' `githubURLForRef`, so every client opens the same page for
    /// the same chip. Nil for a meeting or a task, or an id that does not parse.
    var githubURL: URL? {
        let separator: Character? = switch kind.rawValue {
        case "issue", "pull": "#"
        case "run": "!"
        case "commit", "release": "@"
        default: nil
        }
        guard let separator, let at = id.lastIndex(of: separator), at != id.startIndex else { return nil }
        let slug = id[..<at].split(separator: "/")
        let rest = String(id[id.index(after: at)...])
        guard slug.count == 2, !rest.isEmpty else { return nil }
        let base = "https://github.com/\(slug[0])/\(slug[1])"
        let path: String? = switch kind.rawValue {
        case "issue": "issues/\(rest)"
        case "pull": "pull/\(rest)"
        case "commit": "commit/\(rest)"
        case "run": "actions/runs/\(rest)"
        case "release": "releases/tag/\(rest.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? rest)"
        default: nil
        }
        return path.flatMap { URL(string: "\(base)/\($0)") }
    }

    /// What the chip says: the number for an issue or PR, a short sha, the
    /// tag, "CI" — what somebody scanning a channel is looking for.
    var chipTitle: String {
        switch kind.rawValue {
        case "task": String(localized: "Task")
        case "meeting": String(localized: "Meeting")
        case "issue", "pull": id.split(separator: "#").last.map { "#\($0)" } ?? String(localized: "Issue")
        case "commit": id.split(separator: "@").last.map { String($0.prefix(7)) } ?? String(localized: "Commit")
        case "run": "CI"
        case "release": id.split(separator: "@").last.map(String.init) ?? String(localized: "Release")
        default: kind.rawValue.capitalized
        }
    }

    /// Whether a chip for this ref leads anywhere: Work opens a task, an issue,
    /// a decision or a goal in place, and a GitHub ref with a page opens
    /// github.com. A meeting has no door from a channel yet, so its chip stays
    /// a quiet label rather than a link that does nothing.
    var isOpenable: Bool {
        switch kind.rawValue {
        case "task", "issue", "decision", "goal": true
        default: githubURL != nil
        }
    }

    /// The chip's tooltip and accessibility label: what pressing it does.
    var openLabel: String {
        let title = chipTitle
        return switch kind.rawValue {
        case "task": String(localized: "Open task")
        case "issue": String(localized: "Open issue \(title)")
        case "pull": String(localized: "Open pull request \(title) on GitHub")
        case "commit": String(localized: "Open commit \(title) on GitHub")
        case "run": String(localized: "Open CI run on GitHub")
        case "release": String(localized: "Open release \(title) on GitHub")
        case "decision": String(localized: "Show decisions")
        case "goal": String(localized: "Show goals")
        default: title
        }
    }
}

/// One emoji and everybody who chose it, already aggregated by the Worker.
///
/// A count and a list of names rather than a row per reactor: the common
/// message is six people and one emoji, and shipping six rows for it would be
/// six times the payload for the same pill.
extension ThreadMessageReaction {
    var presentationReaction: MeetingReaction? { MeetingReaction(rawValue: emoji) }
    var systemSymbolName: String { MeetingReaction.systemSymbolName(for: emoji) }
    var accessibilityName: String { presentationReaction?.accessibilityName ?? String(localized: "Custom reaction") }

    var tooltip: String {
        let people = reactors.isEmpty ? String(localized: "Somebody") : reactors.formatted(.list(type: .and))
        return String(localized: "\(people) reacted with \(accessibilityName)")
    }
}

/// A file on a message. The bytes are a separate authenticated read, exactly
/// like an avatar — a transcript poll must never carry them.
extension ThreadMessageAttachment {
    var sizeDescription: String {
        ByteCountFormatStyle(style: .file).format(Int64(bytes))
    }
}

struct ThreadMessage: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let threadID: String
    let sentAt: Date
    let senderEmail: String
    let senderName: String?
    let text: String
    let isMine: Bool
    let type: ThreadMessageType
    /// Parent text message inside this same conversation, if this is a reply.
    let replyToMessageID: String?
    /// What this line points at. Written by the work graph on an event, and by
    /// a composer on a message sent from a task — which is what lets a
    /// conversation and the work beside it point at each other.
    let refs: [ThreadMessageRef]
    /// Members this message names. Addresses, because a name is not an identity.
    let mentions: [String]
    let attachments: [ThreadMessageAttachment]
    let reactions: [ThreadMessageReaction]
    let question: ThreadQuestion?
    let questionAnswer: ThreadQuestionAnswer?
    /// An agent's request for one Keep item, and what a member did
    /// about it. The item is named, never valued.
    let releaseRequest: ThreadReleaseRequest?
    let releaseState: ThreadReleaseState?
    /// When the author last rewrote it. Nil on a message said once.
    let editedAt: Date?
    /// When the author withdrew it. The row survives so replies still make
    /// sense; the text and every file are gone.
    let deletedAt: Date?
    /// Still being written. An agent streams its answer as one row rewritten
    /// in place, and this is true until the final rewrite lands — so the
    /// bubble grows under the working row with no actions, no reactions and
    /// no "edited" on it. Never true on anything a person typed.
    let isPartial: Bool
    /// The MCP client a member's Claude sent this through ("claude.ai"). Set
    /// by the server from the session token; nil on anything a person typed.
    let via: String?

    var isEvent: Bool { type == .event }
    var isWithdrawn: Bool { deletedAt != nil }

    var senderShortName: String {
        let name = senderName?.trimmingCharacters(in: .whitespaces) ?? ""
        if !name.isEmpty { return name.split(separator: " ").first.map(String.init) ?? name }
        return String(senderEmail.prefix(while: { $0 != "@" }))
    }

    init(wire: ThreadMessageWire) {
        self.init(
            id: wire.id,
            threadID: wire.threadID,
            sentAt: Date(timeIntervalSince1970: TimeInterval(wire.sentAt) / 1000),
            senderEmail: wire.senderEmail,
            senderName: wire.senderName,
            text: wire.text,
            isMine: wire.isMine,
            type: wire.type,
            replyToMessageID: wire.replyToMessageID,
            refs: wire.refs ?? [],
            mentions: wire.mentions ?? [],
            attachments: wire.attachments ?? [],
            reactions: wire.reactions ?? [],
            question: wire.question,
            questionAnswer: wire.questionAnswer,
            releaseRequest: wire.releaseRequest,
            releaseState: wire.releaseState,
            editedAt: wire.editedAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) },
            deletedAt: wire.deletedAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) },
            isPartial: wire.partial ?? false,
            via: wire.via
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try ThreadMessageWire(from: decoder))
    }

    init(
        id: String,
        threadID: String,
        sentAt: Date,
        senderEmail: String,
        senderName: String?,
        text: String,
        isMine: Bool,
        type: ThreadMessageType = .text,
        replyToMessageID: String? = nil,
        refs: [ThreadMessageRef] = [],
        mentions: [String] = [],
        attachments: [ThreadMessageAttachment] = [],
        reactions: [ThreadMessageReaction] = [],
        question: ThreadQuestion? = nil,
        questionAnswer: ThreadQuestionAnswer? = nil,
        releaseRequest: ThreadReleaseRequest? = nil,
        releaseState: ThreadReleaseState? = nil,
        editedAt: Date? = nil,
        deletedAt: Date? = nil,
        isPartial: Bool = false,
        via: String? = nil
    ) {
        self.mentions = mentions
        self.attachments = attachments
        self.reactions = reactions
        self.question = question
        self.questionAnswer = questionAnswer
        self.releaseRequest = releaseRequest
        self.releaseState = releaseState
        self.editedAt = editedAt
        self.deletedAt = deletedAt
        self.isPartial = isPartial
        self.via = via
        self.id = id
        self.threadID = threadID
        self.sentAt = sentAt
        self.senderEmail = senderEmail
        self.senderName = senderName
        self.text = text
        self.isMine = isMine
        self.type = type
        self.replyToMessageID = replyToMessageID
        self.refs = refs
    }
}

extension ThreadMessage {
    /// The same message with other words: what a streamed answer's next post
    /// is, and how a client tells that from any other change to a row.
    func withText(_ text: String) -> ThreadMessage {
        ThreadMessage(
            id: id,
            threadID: threadID,
            sentAt: sentAt,
            senderEmail: senderEmail,
            senderName: senderName,
            text: text,
            isMine: isMine,
            type: type,
            replyToMessageID: replyToMessageID,
            refs: refs,
            mentions: mentions,
            attachments: attachments,
            reactions: reactions,
            question: question,
            questionAnswer: questionAnswer,
            releaseRequest: releaseRequest,
            releaseState: releaseState,
            editedAt: editedAt,
            deletedAt: deletedAt,
            isPartial: isPartial,
            via: via
        )
    }

    /// The same message with a new reaction rail.
    ///
    /// A reaction is the one thing about a message that changes without the
    /// message changing, and the Worker answers a toggle with the whole rail —
    /// so this replaces that one field rather than making a client re-read the
    /// page to see its own press land.
    func withReactions(_ reactions: [ThreadMessageReaction]) -> ThreadMessage {
        ThreadMessage(
            id: id,
            threadID: threadID,
            sentAt: sentAt,
            senderEmail: senderEmail,
            senderName: senderName,
            text: text,
            isMine: isMine,
            type: type,
            replyToMessageID: replyToMessageID,
            refs: refs,
            mentions: mentions,
            attachments: attachments,
            reactions: reactions,
            question: question,
            questionAnswer: questionAnswer,
            releaseRequest: releaseRequest,
            releaseState: releaseState,
            editedAt: editedAt,
            deletedAt: deletedAt,
            isPartial: isPartial,
            via: via
        )
    }
}

/// One other person in a conversation, as much of them as a list row needs.
extension ThreadPeer: Identifiable {
    public var id: String { email }

    var shortName: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty {
            return name.split(separator: " ").first.map(String.init) ?? name
        }
        return String(email.prefix(while: { $0 != "@" }))
    }
}

struct ThreadSummary: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let kind: ThreadKind
    let parentID: String?
    let peerEmail: String?
    let peerName: String?
    /// Everybody in a private conversation except you.
    ///
    /// A private conversation has no title, so the roster is the title: one
    /// name for a DM, everybody's for a group. Ordered by the server, so every
    /// member reads the same name for the same conversation. Empty for a
    /// channel, which has a title of its own.
    let peers: [ThreadPeer]
    /// What a channel is called, from the server. Null for a DM, which is named
    /// after the other person instead.
    let subjectTitle: String?
    let audience: ThreadAudience
    let lastMessageAt: Date?
    let lastMessagePreview: String?
    let lastSenderEmail: String?
    /// Anything new since this member last read. A flag, not a count — the
    /// index stores one timestamp per member, and an exact count would cost a
    /// round-trip per row just to draw a list.
    let unread: Bool
    /// When this member last read here. `unread` is the badge; this is what
    /// draws the line you left off at — a flag cannot say *where*.
    let lastReadAt: Date?
    /// Whether anything unread names you. Loud, where `unread` is quiet.
    let hasMention: Bool
    /// When a mute lapses, or nil when this conversation is not muted.
    let mutedUntil: Date?
    /// When you put this conversation away, or nil while it is in your list.
    /// A row can carry a date and still be listed: anything said after it
    /// brings the conversation back, which is what makes archiving safe.
    let archivedAt: Date?
    /// Where a member forwards an email so it lands here as their message
    ///. Only on a subject channel, and only once the deployment
    /// has Email Routing; nil means draw nothing.
    let inboundAddress: String?

    var isMuted: Bool { (mutedUntil ?? .distantPast) > Date() }

    var title: String {
        if let subjectTitle, !subjectTitle.trimmingCharacters(in: .whitespaces).isEmpty { return subjectTitle }
        // Several people means the roster is the name. First names only: the
        // whole address turns a three-person group into a line of ellipsis.
        if peers.count > 1 { return peers.map(\.shortName).joined(separator: ", ") }
        if let peerName, !peerName.trimmingCharacters(in: .whitespaces).isEmpty { return peerName }
        if let peerEmail { return String(peerEmail.prefix(while: { $0 != "@" })) }
        return String(localized: "Conversation")
    }

    /// Whether this is a private conversation with more than one other person.
    /// Not a different kind — the same DM with more people in it — but worth
    /// naming where a surface draws a roster instead of a face.
    var isGroup: Bool { peers.count > 1 }

    /// Who wrote the last line, by first name, when the title does not say:
    /// a channel's or a group's title is the place, not the person
    ///. Nil for a DM, whose title is the person, and for a sender
    /// neither the roster nor the thread knows. The web asks the same with
    /// `threadLastSenderName`.
    func lastSenderShortName(roster: [Peer]) -> String? {
        guard let email = lastSenderEmail?.lowercased(), !email.isEmpty else { return nil }
        if kind == .dm && !isGroup { return nil }
        if let peer = roster.first(where: { $0.email.lowercased() == email }) { return peer.shortName }
        guard let peer = peers.first(where: { $0.email.lowercased() == email }) else { return nil }
        let name = peer.name?.trimmingCharacters(in: .whitespaces) ?? ""
        let display = name.isEmpty ? String(peer.email.prefix(while: { $0 != "@" })) : name
        return display.split(separator: " ").first.map(String.init) ?? display
    }

    /// The preview a list row draws: the sender's first name before the line
    /// where the title does not name them (`lastSenderShortName`).
    func previewWithSender(roster: [Peer]) -> String? {
        guard let preview = lastMessagePreview, !preview.isEmpty else { return nil }
        guard let sender = lastSenderShortName(roster: roster) else { return preview }
        return sender + ": " + preview
    }

    /// Whether this thread's newest unread message should raise a local
    /// notification, given the per-device "every channel message" preference
    /// (`MessageNotificationPreferences`). A direct message or group
    /// conversation is addressed to you by construction and always notifies;
    /// a channel — which the whole company, or a whole project, can write
    /// into — only does when it names you, unless the preference widens it.
    /// One rule, so the Mac and the phone agree on when a message is loud.
    func shouldNotifyLocally(notifyOnAllChannelMessages: Bool) -> Bool {
        guard unread else { return false }
        guard kind.isChannel else { return true }
        return hasMention || notifyOnAllChannelMessages
    }

    init(
        id: String,
        kind: ThreadKind,
        parentID: String?,
        peerEmail: String?,
        peerName: String?,
        peers: [ThreadPeer] = [],
        lastMessageAt: Date?,
        lastMessagePreview: String?,
        lastSenderEmail: String?,
        unread: Bool,
        subjectTitle: String? = nil,
        audience: ThreadAudience = .members,
        lastReadAt: Date? = nil,
        hasMention: Bool = false,
        mutedUntil: Date? = nil,
        archivedAt: Date? = nil,
        inboundAddress: String? = nil
    ) {
        self.lastReadAt = lastReadAt
        self.hasMention = hasMention
        self.mutedUntil = mutedUntil
        self.archivedAt = archivedAt
        self.inboundAddress = inboundAddress
        self.subjectTitle = subjectTitle
        self.audience = audience
        self.id = id
        self.kind = kind
        self.parentID = parentID
        self.peerEmail = peerEmail
        self.peerName = peerName
        self.peers = peers
        self.lastMessageAt = lastMessageAt
        self.lastMessagePreview = lastMessagePreview
        self.lastSenderEmail = lastSenderEmail
        self.unread = unread
    }

    init(wire: ThreadSummaryWire) {
        let date: (Int?) -> Date? = { $0.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) } }
        self.init(
            id: wire.id,
            kind: wire.kind,
            parentID: wire.parentID,
            peerEmail: wire.peerEmail,
            peerName: wire.peerName,
            peers: wire.peers ?? [],
            lastMessageAt: date(wire.lastMessageAt),
            // Agents answer in Markdown; a banner or a row cannot draw it.
            lastMessagePreview: wire.lastMessagePreview.map(ThreadMarkdown.plainPreview),
            lastSenderEmail: wire.lastSenderEmail,
            unread: wire.unread,
            subjectTitle: wire.title,
            audience: wire.audience,
            // Zero means never read, which is an absence rather than 1970.
            lastReadAt: wire.lastReadAt > 0 ? date(wire.lastReadAt) : nil,
            hasMention: wire.hasMention,
            mutedUntil: date(wire.mutedUntil),
            archivedAt: date(wire.archivedAt),
            inboundAddress: wire.inboundAddress
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try ThreadSummaryWire(from: decoder))
    }
}

extension ThreadSummary {
    /// The project or lead this channel hangs off, shaped as the subject Work
    /// opens. The thread knows the id and the title and nothing else — the
    /// counts belong to the CRM list — so a row built from this must say what
    /// the thread knows, never a standing it has not counted.
    var subject: CrmSubject? {
        guard kind.isSubjectChannel, let parentID else { return nil }
        return CrmSubject(id: parentID, kind: kind.rawValue, title: title, subtitle: nil)
    }
}

struct ThreadListResponse: Decodable, Sendable {
    let threads: [ThreadSummary]
}

struct ThreadEnvelope: Decodable, Sendable {
    let thread: ThreadSummary
}

struct ThreadMessagesPage: Decodable, Sendable {
    let thread: ThreadSummary
    let messages: [ThreadMessage]
    let olderCursor: String?

    init(from decoder: Decoder) throws {
        let wire = try ThreadMessagesResponse(from: decoder)
        thread = ThreadSummary(wire: wire.thread)
        messages = wire.messages.map(ThreadMessage.init(wire:))
        olderCursor = wire.olderCursor
    }
}

struct SentMessageEnvelope: Decodable, Sendable {
    let message: ThreadMessage
}

enum DirectMessageCadence {
    /// There is no socket and no push yet, so polling *is* delivery. Brisk
    /// while a conversation is open, and stopped the moment it is not.
    static let openThreadPoll: TimeInterval = 4
    /// The pane is open but the app is behind something else. An occluded
    /// window does not poll at all. `THREAD_BACKGROUND_POLL_SECONDS`.
    static let backgroundThreadPoll = TimeInterval(ContractConstants.threadBackgroundPollSeconds)
    /// While a turn with an agent is open — from the member's line to the
    /// agent's final answer — the runtime narrates its steps and streams the
    /// answer as a row rewritten in place, and at four seconds a short turn is
    /// over before it is seen to start. `AGENT_TURN_POLL_SECONDS`.
    static let agentTurnPoll = TimeInterval(ContractConstants.agentTurnPollSeconds)
    /// How long after sending to an agent the working row shows on trust
    /// alone, before only the roster's `busy` flag keeps it. Mirrors
    /// `AGENT_ACCEPT_GRACE_SECONDS` in the contracts package.
    static let agentAcceptGrace: TimeInterval = 20
    /// The conversation list moves far less than an open thread does.
    static let threadListPoll: TimeInterval = 60
    static let maxCharacters = 4_000
}

/// How a client names a conversation *before* it exists.
///
/// A DM is created on first open, so there is no `ThreadSummary` to key a
/// screen on until the round trip returns. Every conversation surface therefore
/// takes an address rather than a `Peer`: when a channel on a project, on a
/// lead, or on the whole team lands, it is one case here plus one request body,
/// and the pane, the phone screen, and the window title do not change at all.
/// See docs/CHANNELS.md.
///
/// The display strings are resolved once, at the call site that knows what it
/// is addressing. A view that derived them itself would have to learn every
/// kind of conversation, which is the coupling this type removes.
/// Where a conversation opens when it is reached by a permalink rather than
/// by hand: Home's Messages row, a banner, a search result. The
/// thread scrolls to the line and flashes it once. `.newest` is the line the
/// row previewed, so the route needs no message id from a list that has none.
enum MessageFocus: Equatable, Sendable {
    case newest
    case message(String)
}

struct ThreadAddress: Equatable, Hashable, Identifiable, Sendable {
    enum Target: Equatable, Hashable, Sendable {
        case peer(email: String)
        /// A private conversation with several people. Not a channel and not a
        /// different kind — the same DM with more people in it, addressed the
        /// same way it is created: by naming them. Sorted, so two people who
        /// pick the same group in a different order address one conversation.
        case group(emails: [String])
        case team
        /// A CRM project or lead. `kind` is `.project` or `.lead` — the other
        /// kinds name conversations nobody addresses this way.
        case subject(kind: ThreadKind, id: String)
        /// A conversation already made, by its id: a guest thread on `intake`
        /// that no list carries. Opened by reading its messages, which also
        /// returns its summary.
        case thread(id: String)
    }

    let target: Target
    /// Window title, navigation bar, list row.
    let title: String
    /// Composer placeholder.
    let prompt: String
    /// Shown while the conversation holds nothing.
    let emptyLine: String
    /// One quiet line under the title, where the conversation has one to give.
    let subtitle: String?

    /// Message replies are a subject Talk affordance. DMs, Everyone, and
    /// meeting chat keep their existing composer and transcript behavior.
    var supportsMessageReplies: Bool {
        guard case let .subject(kind, _) = target else { return false }
        return kind.isSubjectChannel
    }

    /// Stable across a redraw, and distinct per conversation: what a screen is
    /// addressing, not what it is currently titled. Two searches that land on
    /// the same project are the same destination.
    var id: String {
        switch target {
        case let .peer(email): "peer:\(email)"
        case let .group(emails): "group:\(emails.joined(separator: ","))"
        case .team: "team"
        case let .subject(kind, id): "\(kind.rawValue):\(id)"
        case let .thread(id): "thread:\(id)"
        }
    }

    /// The other person, when there is exactly one. Presence and the unread
    /// list are still keyed by address, so this stays until they are not.
    var peerEmail: String? {
        switch target {
        case let .peer(email): email
        case .group, .team, .subject, .thread: nil
        }
    }

    /// The company-wide channel. Addressable before it exists, like a DM: the
    /// first person to open it is the one who creates it.
    static let team = ThreadAddress(
        target: .team,
        title: TeamThread.title,
        prompt: TeamThread.prompt,
        emptyLine: TeamThread.emptyLine,
        subtitle: TeamThread.subtitle
    )

    /// A channel on a CRM subject, addressed from the subject picker. The
    /// title shown here is Core's, and the Worker replaces it with Core's
    /// again on open — so a stale search result cannot name a conversation.
    static func subject(_ subject: CrmSubject) -> ThreadAddress {
        let kind: ThreadKind = switch subject.subjectKind {
        case .lead: .lead
        case .organization: .organization
        case .event: .event
        case .project: .project
        }
        return ThreadAddress(
            target: .subject(kind: kind, id: subject.id),
            title: subject.title,
            prompt: String(localized: "Message the \(kind.channelNoun) channel"),
            emptyLine: "Nothing here yet.",
            subtitle: subject.subtitle ?? kind.channelNoun.capitalized
        )
    }

    /// A conversation by its id, for a link that names a thread no list holds:
    /// an app user's or a public contact's conversation on `intake`.
    static func thread(id: String, title: String) -> ThreadAddress {
        ThreadAddress(
            target: .thread(id: id),
            title: title,
            prompt: String(localized: "Reply"),
            emptyLine: "Nothing here yet.",
            subtitle: String(localized: "Conversation")
        )
    }

    /// A channel already in the conversation list. `parentID` is the subject
    /// it hangs off, which is what the Worker needs to find it again.
    static func channel(_ summary: ThreadSummary) -> ThreadAddress? {
        switch summary.kind {
        case .team: return .team
        case .project, .lead, .organization, .event:
            guard let subjectID = summary.parentID else { return nil }
            return ThreadAddress(
                target: .subject(kind: summary.kind, id: subjectID),
                title: summary.title,
                prompt: String(localized: "Message the \(summary.kind.channelNoun) channel"),
                emptyLine: "Nothing here yet.",
                subtitle: summary.kind.channelNoun.capitalized
            )
        default: return nil
        }
    }

    /// How many other people one private conversation holds. Mirrors
    /// `THREAD_GROUP_MAX_MEMBERS` in the shared contract, less yourself: past
    /// this many people the thing being asked for is Everyone, which exists.
    static let groupMaximumOthers = 11

    /// A private conversation with several people, addressed by naming them.
    ///
    /// The title is their first names, which is what a conversation with no
    /// name is called — the Worker orders the roster the same way, so the name
    /// this shows before the round trip is the name it shows after.
    static func group(_ peers: [Peer]) -> ThreadAddress {
        let sorted = peers.sorted { $0.email < $1.email }
        let names = sorted.map(\.shortName).joined(separator: ", ")
        return ThreadAddress(
            target: .group(emails: sorted.map(\.email)),
            title: names,
            prompt: String(localized: "Message \(names)"),
            emptyLine: "Nothing here yet.",
            subtitle: String(localized: "\(sorted.count + 1) people")
        )
    }

    /// A private conversation already in the list, addressed by the people the
    /// server says are in it.
    static func group(_ summary: ThreadSummary) -> ThreadAddress? {
        guard summary.isGroup else { return nil }
        let names = summary.peers.map(\.shortName).joined(separator: ", ")
        return ThreadAddress(
            target: .group(emails: summary.peers.map(\.email).sorted()),
            title: names,
            prompt: String(localized: "Message \(names)"),
            emptyLine: "Nothing here yet.",
            subtitle: String(localized: "\(summary.peers.count + 1) people")
        )
    }

    /// A one-to-one conversation already in the list.
    ///
    /// Addressed from what the server says is in it rather than from a roster
    /// lookup, because the case this exists for is exactly the one the roster
    /// cannot answer: the other person is hidden in Admin, or has gone cold
    /// enough to fall off it, and the conversation still has to open.
    static func direct(_ summary: ThreadSummary) -> ThreadAddress? {
        guard summary.kind == .dm, !summary.isGroup else { return nil }
        let peer = summary.peers.first
            ?? summary.peerEmail.map { ThreadPeer(email: $0, name: summary.peerName) }
        guard let peer else { return nil }
        let name = peer.shortName
        let full = peer.name?.trimmingCharacters(in: .whitespaces) ?? ""
        return ThreadAddress(
            target: .peer(email: peer.email),
            title: full.isEmpty ? name : full,
            prompt: String(localized: "Message \(name)"),
            emptyLine: "Nothing here yet.",
            subtitle: summary.lastMessagePreview ?? String(localized: "Private conversation")
        )
    }

    static func peer(_ peer: Peer) -> ThreadAddress {
        ThreadAddress(
            target: .peer(email: peer.email),
            title: peer.conversationTitle,
            prompt: peer.conversationPrompt,
            emptyLine: peer.conversationEmptyLine,
            // Your own row has no presence to report — you are looking at it.
            // An idle agent has nothing to say under its name.
            subtitle: peer.isSelf
                ? String(localized: "Only you can read this")
                : (peer.conversationSubtitle.isEmpty ? nil : peer.conversationSubtitle)
        )
    }
}

// MARK: - The Team rail's order

/// One order for PEOPLE and AGENTS on the Mac, the phone and the web
/// (docs/SURFACES.md "Team's rail", 2026-09-15; the web's `orderTeamRail`
/// in `team-presence.ts`), the shape Work's SUBJECTS has: whoever you have
/// a conversation with, latest message first, then everybody else as the
/// server sorted them (present first, then alphabetical). Unread does not
/// jump the queue — the dot and the weight say it, as on a subject row.
/// There is no RECENT CONVERSATIONS block any more: it listed the same
/// people and agents again, ordered across kinds, and which agent stood
/// where changed with every message.
enum TeamRail {
    /// The order is one rule for every client (`TeamRailRules`, packages/contracts/src/team-rail.ts).
    static func order(_ peers: [Peer], directs: [ThreadSummary]) -> [Peer] {
        let emails = TeamRailRules.order(emails: peers.map(\.email), directs: directs.map(TeamRailDirect.init))
        let byEmail = Dictionary(peers.map { ($0.email, $0) }, uniquingKeysWith: { first, _ in first })
        return emails.compactMap { byEmail[$0] }
    }

    /// Conversations whose other side is not on the roster — hidden in
    /// Admin, or gone cold enough to fall off it. They trail PEOPLE, drawn
    /// from the thread, so a conversation outlives the row that started it.
    static func strays(_ directs: [ThreadSummary], roster: [Peer], selfEmail: String?) -> [ThreadSummary] {
        let known = Set(roster.map(\.email))
        return directs.filter { TeamRailRules.isStray(TeamRailDirect($0), rosterEmails: known, selfEmail: selfEmail) }
    }
}
