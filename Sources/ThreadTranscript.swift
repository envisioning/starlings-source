import Foundation

/// What a transcript is made of, once messages have been arranged for reading.
///
/// Built apart from any view so the rules that actually make a conversation
/// legible — where a day starts, where you left off, which lines belong to one
/// person speaking once — are testable without an `NSView` in sight.
enum ThreadTranscriptRow: Equatable {
    /// A day boundary. Sticky in the view; a heading in the reading order.
    case day(Date)
    /// Where the reader left off. Drawn once, above the first thing they have
    /// not seen, and only when there is something to point at.
    case unreadMark
    /// Somebody talking. `grouped` means the line above is the same person,
    /// close enough in time to be the same breath — so this row drops the
    /// avatar, the name and the timestamp and becomes another paragraph.
    case message(ThreadMessage, grouped: Bool)
    /// The work graph reporting itself. Never grouped and never attributed:
    /// it belongs to nobody in the conversation.
    case event(ThreadMessage)
    /// An agent narrating its own turn: the run of event lines it posted on
    /// its way to an answer — "Reading the board", "Searching for Acme" —
    /// folded into one row, oldest first. Drawn collapsed once the answer is
    /// in, and as the working row's own second line while the turn is still
    /// open. A transcript that kept every step at full height would be a log
    /// with a conversation buried in it.
    case trail([ThreadMessage])

    var message: ThreadMessage? {
        switch self {
        case let .message(message, _), let .event(message): message
        case .day, .unreadMark, .trail: nil
        }
    }

    /// The steps of a trail, or nil for anything else.
    var steps: [ThreadMessage]? {
        if case let .trail(steps) = self { return steps }
        return nil
    }
}

enum ThreadTranscript {
    /// How close two lines from one person have to be to read as one turn.
    ///
    /// Slack's rule, and it is the single biggest density win available here:
    /// three sentences typed in a row become one block instead of three
    /// separately stamped and separately attributed rows.
    static let groupingWindow = TimeInterval(ContractConstants.threadGroupingWindowMs) / 1000

    /// A finalized text message is a reply target. Events describe work, and
    /// a withdrawn or still-streaming row does not yet have stable words.
    static func isReplyable(_ message: ThreadMessage) -> Bool {
        message.type == .text && !message.isWithdrawn && !message.isPartial
    }

    /// Arrange messages for reading.
    ///
    /// `unreadBoundary` is captured when the conversation opens and held still
    /// afterwards — deliberately not re-derived from the newest page. A marker
    /// that moves every poll is a marker that has never once been where you
    /// stopped reading.
    /// `agentEmails` are the roster's agents. An event one of them signed is
    /// a step of its turn and folds into a trail; an event from Meet itself —
    /// a meeting filed, an issue closed — stays its own line. Without the
    /// roster nothing folds, which is exactly what a pane with no agent
    /// should draw.
    static func rows(
        for messages: [ThreadMessage],
        unreadBoundary: Date?,
        agentEmails: Set<String> = [],
        calendar: Calendar = .current
    ) -> [ThreadTranscriptRow] {
        var rows: [ThreadTranscriptRow] = []
        // Two pieces of state, deliberately separate. `lastDay` is the last
        // date drawn; `previous` is the last thing that could be grouped with.
        // One variable for both emitted a second day heading after every event
        // line, because "nothing to group with" and "no day drawn yet" are not
        // the same absence.
        var lastDay: Date?
        var previous: ThreadMessage?
        var markPlaced = false

        for message in messages {
            if lastDay.map({ !calendar.isDate($0, inSameDayAs: message.sentAt) }) ?? true {
                rows.append(.day(message.sentAt))
                lastDay = message.sentAt
                // A day heading is already a break in the page; grouping across
                // it would put yesterday and today in one block.
                previous = nil
            }
            // Your own message is never something you came back to read, so it
            // can never be the thing the marker points at.
            if !markPlaced, let unreadBoundary, message.sentAt > unreadBoundary, !message.isMine {
                rows.append(.unreadMark)
                markPlaced = true
                previous = nil
            }
            if message.isEvent {
                previous = nil
                if agentEmails.contains(message.senderEmail) {
                    // Consecutive steps from the same agent are one trail. A
                    // day heading or the unread mark between two steps starts
                    // a second one, because both are already breaks in the page.
                    if case let .trail(steps)? = rows.last, steps.first?.senderEmail == message.senderEmail {
                        rows[rows.count - 1] = .trail(steps + [message])
                    } else {
                        rows.append(.trail([message]))
                    }
                    continue
                }
                rows.append(.event(message))
                continue
            }
            rows.append(.message(message, grouped: isGrouped(message, after: previous)))
            previous = message
        }
        return rows
    }

    /// One turn, or a new one. A withdrawn message breaks the group on either
    /// side: a tombstone folded silently into somebody's paragraph reads as a
    /// blank line they typed. So does a change of hand: the "via" tag lives in
    /// the header, and a line their Claude sent must not fold under one the
    /// person typed.
    private static func isGrouped(_ message: ThreadMessage, after previous: ThreadMessage?) -> Bool {
        guard let previous else { return false }
        guard !previous.isWithdrawn, !message.isWithdrawn else { return false }
        guard previous.senderEmail == message.senderEmail else { return false }
        guard previous.via == message.via else { return false }
        return message.sentAt.timeIntervalSince(previous.sentAt) <= groupingWindow
    }

    /// m:ss since a moment, for the working row's clock. Minutes are not
    /// padded — "0:07", "1:42", "12:05" — the way a stopwatch reads, and never
    /// hours: a turn that long has already been reset by the watchdog.
    static func elapsedLabel(since: Date, now: Date = Date()) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(since)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// The emoji offered on the hover menu.
    ///
    /// Short and opinionated rather than a picker: the point of a reaction is
    /// that it costs one click, and a grid of a thousand faces costs a
    /// decision. Anything else can still arrive from another client — the wire
    /// takes any emoji, and a pill this list does not contain still draws.
    /// Same four as the meeting palette (`MeetingReaction`). A
    /// stored reaction outside it still renders through
    /// `MeetingReaction.systemSymbolName(for:)`; it is only no longer offered.
    static let quickReactions = MeetingReaction.allCases.map(\.rawValue)

    /// The emoji offered on an agent's line: thumbs up alone. A member reads
    /// an agent's answer to accept it or not; a heart or a laugh at a runtime
    /// is noise the agent cannot use, and one button is one less choice.
    static let agentReactions = [MeetingReaction.thumbsUp.rawValue]

    /// The palette for one message: the full row for a person, one button
    /// for an agent.
    static func quickReactions(fromAgent: Bool) -> [String] {
        fromAgent ? agentReactions : quickReactions
    }
}

/// Draft state shared by the Mac and phone composers. A reply is a relation on
/// the next message, not a second conversation or a new transcript section.
struct ThreadReplyDraft: Equatable, Sendable {
    private(set) var parentMessageID: String?

    @discardableResult
    mutating func select(_ message: ThreadMessage) -> Bool {
        guard ThreadTranscript.isReplyable(message) else { return false }
        parentMessageID = message.id
        return true
    }

    mutating func cancel() {
        parentMessageID = nil
    }
}

/// A small, privacy-safe projection for both the in-transcript parent link
/// and the composer context. Attachment names and bytes are never previewed.
struct ThreadReplyPreviewContent: Equatable, Sendable {
    let author: String
    let text: String

    static func resolve(_ parent: ThreadMessage?) -> ThreadReplyPreviewContent {
        guard let parent else {
            return ThreadReplyPreviewContent(author: String(localized: "Earlier message"), text: "")
        }
        guard !parent.isWithdrawn else {
            return ThreadReplyPreviewContent(author: parent.senderShortName, text: String(localized: "Message withdrawn"))
        }

        let oneLine = parent.text
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        let preview: String
        if oneLine.isEmpty {
            preview = parent.attachments.isEmpty
                ? String(localized: "Message")
                : String(localized: "Attachment")
        } else if oneLine.count > 120 {
            preview = String(oneLine.prefix(119)) + "…"
        } else {
            preview = oneLine
        }
        return ThreadReplyPreviewContent(author: parent.senderShortName, text: preview)
    }
}
