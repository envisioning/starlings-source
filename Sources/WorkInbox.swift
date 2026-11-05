import Foundation

/// INBOX — one per-user feed ( decision 4, slice 2b). Mirrors
/// `packages/contracts/src/inbox.ts`: `items` have a resolution and leave
/// when resolved; `recent` is the capped tail of what happened on listed
/// subjects, never counted. Each item carries the same row the source block
/// already draws, so INBOX adds no second vocabulary for a note or a touch.
struct WorkInboxResponse: Decodable, Sendable {
    let items: [WorkInboxItem]
    let recent: [WorkInboxRecentEntry]
    /// Sources the Worker could not read this time (`talk`, `task`, …).
    let partial: [String]
    /// Subjects whose history could not be read, by title.
    let recentPartial: [String]
    /// Subjects whose proposed tasks could not be read, by title: which of
    /// them `partial` means by `task`.
    let taskPartial: [String]
    /// Sources read up to their ceiling (`comment`): what shows is right,
    /// and more is past the cap. Not a failure, so not in `partial`.
    let capped: [String]

    /// The generated `InboxResponse`, read as the app holds it. A row whose
    /// source this build does not know is dropped, never a reason to empty
    /// the inbox: the union keeps it as `.other` and the map lets it go.
    init(wire: InboxResponse) {
        self.init(
            items: wire.items.compactMap(WorkInboxItem.init(wire:)),
            recent: wire.recent,
            partial: wire.partial.map(\.rawValue),
            recentPartial: wire.recentPartial,
            taskPartial: wire.taskPartial ?? [],
            capped: (wire.capped ?? []).map(\.rawValue)
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try InboxResponse(from: decoder))
    }

    static let empty = WorkInboxResponse(items: [], recent: [], partial: [], recentPartial: [])

    /// The same answer without one item: a row answered here leaves at once,
    /// before the re-read confirms it.
    func removing(key: String) -> WorkInboxResponse {
        WorkInboxResponse(
            items: items.filter { $0.id != key }, recent: recent, partial: partial,
            recentPartial: recentPartial, taskPartial: taskPartial, capped: capped
        )
    }

    init(items: [WorkInboxItem], recent: [WorkInboxRecentEntry], partial: [String], recentPartial: [String], taskPartial: [String] = [], capped: [String] = []) {
        self.items = items
        self.recent = recent
        self.partial = partial
        self.recentPartial = recentPartial
        self.taskPartial = taskPartial
        self.capped = capped
    }

    /// "Couldn't read proposed tasks on Acme, Globex" — the sources named
    /// as a person says them, and for tasks which subjects. One line for
    /// the Mac, the phone and the web. The nouns are `InboxSourceSpec.partial`.
    var partialLine: String? {
        guard !partial.isEmpty else { return nil }
        let names = partial.map { source -> String in
            let noun = InboxSourceSpec.spec(for: source)?.partial ?? source
            guard source == "task", !taskPartial.isEmpty else { return noun }
            let more = taskPartial.count > 3 ? String(localized: " and \(taskPartial.count - 3) more") : ""
            return String(localized: "\(noun) on \(taskPartial.prefix(3).joined(separator: ", "))\(more)")
        }
        return String(localized: "Couldn’t read \(names.joined(separator: ", ")).")
    }

    /// A capped read, said as what shows, not as a failure. Same line as
    /// the web's `inboxCappedLine`.
    var cappedLine: String? {
        capped.contains("comment") ? String(localized: "Showing comments on the newest documents only.") : nil
    }
}

/// Skips an item whose `source` this build does not draw.
/// One INBOX source a person can turn off — Settings › Work › Inbox on the
/// Mac and the phone. The list (`all`) is generated from `INBOX_SOURCE_SPECS`
/// in `packages/contracts/src/inbox-values.ts` into
/// `Generated/InboxSourcesRegistry.swift`. `talk` covers `mention` too.
struct InboxSourceSpec: Identifiable, Sendable {
    let source: String
    let title: String
    /// One sentence: what arrives, and what makes it leave.
    let detail: String
    let defaultOn: Bool
    /// The source as a noun in "Couldn't read …".
    let partial: String

    var id: String { source }

    /// The spec a wire source is read under: `mention` is read as `talk`.
    static func spec(for source: String) -> InboxSourceSpec? {
        let filter = source == "mention" ? "talk" : source
        return all.first { $0.source == filter }
    }

    /// Stored overrides on top of the defaults, source by source.
    static func resolve(_ stored: [String: Bool]) -> [String: Bool] {
        var out: [String: Bool] = [:]
        for spec in all { out[spec.source] = stored[spec.source] ?? spec.defaultOn }
        return out
    }
}

/// The contextual INBOX menu. The cases are generated from
/// `INBOX_FILTER_SOURCES` into `Generated/InboxSourcesRegistry.swift`; a
/// source's title is its `InboxSourceSpec` title.
extension InboxFilterSource {
    var isDefault: Bool { self == .all }

    var title: String {
        if self == .all { return String(localized: "All items") }
        return InboxSourceSpec.spec(for: rawValue)?.title ?? rawValue
    }
}

enum WorkInboxItem: Sendable, Identifiable {
    /// A question an agent put to you, with options and a recommendation.
    /// Always first; leaves when answered, defaulted or withdrawn.
    case decision(DecisionAsk, key: String, at: Int)
    case question(AttentionRequest, key: String, at: Int)
    /// A subject conversation with something unread; `mention` when it names you.
    case talk(ThreadSummary, mention: Bool, key: String, at: Int)
    /// A Core-proposed task waiting on accept / decline.
    case task(CrmTask, subject: CrmSubject, key: String, at: Int)
    /// A card you handed to an agent, now in Review or Blocked
    /// (docs/OWNERSHIP.md decision 12). Leaves when the card moves on.
    case card(WorkInboxCard, key: String, at: Int)
    /// After a call with people outside: the drafted follow-up and
    /// the call's proposed tasks, for the host. Leaves when approved or dismissed.
    case followUp(InboxFollowUpItem, key: String, at: Int)
    /// An unfiled Quick Note.
    case note(QuickNote, key: String, at: Int)
    /// A CRM touch with no lead yet — only when Sales is on for you.
    case sales(UntriagedTouch, key: String, at: Int)
    /// An open comment thread on a document about a subject you follow.
    case comment(WorkInboxComment, key: String, at: Int)
    /// A guest booked, moved or cancelled a time on your page — the one
    /// item an outsider makes.
    case booking(WorkInboxBooking, key: String, at: Int)
    /// A calendar invitation waiting on Accept, Maybe or Decline. Leaves when
    /// answered or when the event ends.
    case invitation(CalendarEventSummary, key: String, at: Int)
    /// An event read from mail forwarded to calendar@, waiting on
    /// Add or Discard.
    case forwarded(ProposedCalendarEvent, key: String, at: Int)
    /// A company filled in /interest — admins only. Leaves when dismissed.
    case interest(WorkInboxInterest, key: String, at: Int)
    /// Someone filled in one of the workspace's public forms (docs/FORMS.md).
    /// For the people the form names. Leaves when dismissed.
    case submission(WorkInboxSubmission, key: String, at: Int)
    /// An offer that expires soon or a license that renews soon, on a lead
    /// or organization. Leaves when decided,
    /// renewed or dismissed.
    case commercial(WorkInboxCommercial, key: String, at: Int)
    /// A guest thread whose last line came from outside and nobody here has
    /// answered (docs/SUPPORT.md): a guest, an organization, or an app user on
    /// `intake`. Leaves when a member replies or dismisses it.
    case guest(InboxGuestItem, key: String, at: Int)

    var id: String {
        switch self {
        case .talk(_, _, let key, _), .task(_, _, let key, _), .card(_, let key, _), .followUp(_, let key, _), .note(_, let key, _), .sales(_, let key, _),
             .comment(_, let key, _), .booking(_, let key, _), .invitation(_, let key, _), .forwarded(_, let key, _),
             .interest(_, let key, _), .submission(_, let key, _), .commercial(_, let key, _), .decision(_, let key, _), .question(_, let key, _), .guest(_, let key, _): key
        }
    }

    /// When it happened, in Unix milliseconds — what the Inbox card orders by.
    var at: Int {
        switch self {
        case .talk(_, _, _, let at), .task(_, _, _, let at), .card(_, _, let at), .followUp(_, _, let at), .note(_, _, let at), .sales(_, _, let at),
             .comment(_, _, let at), .booking(_, _, let at), .invitation(_, _, let at), .forwarded(_, _, let at),
             .interest(_, _, let at), .submission(_, _, let at), .commercial(_, _, let at), .decision(_, _, let at), .question(_, _, let at), .guest(_, _, let at): at
        }
    }

    /// The source vocabulary used by the contextual filter. Mentions fold
    /// into talk, matching `InboxSourceSpec` and the Worker setting.
    var filterSource: InboxFilterSource {
        switch self {
        case .talk: .talk
        case .task: .task
        case .card: .card
        case .followUp: .followup
        case .note: .note
        case .sales: .sales
        case .comment: .comment
        case .booking: .booking
        case .invitation: .invitation
        case .forwarded: .forwarded
        case .interest: .interest
        case .submission: .submission
        case .commercial: .commercial
        case .decision: .decision
        case .question: .question
        case .guest: .guest
        }
    }

    func matches(_ filter: InboxFilterSource) -> Bool {
        filter == .all || filter == filterSource
    }

    /// One row off the wire, or nil for a source this build does not draw.
    init?(wire: InboxItem) {
        switch wire {
        case .talk(let item):
            self = .talk(ThreadSummary(wire: item.thread), mention: item.source == .mention, key: item.key, at: item.at)
        case .task(let item):
            self = .task(CrmTask(wire: item.task), subject: CrmSubject(wire: item.subject), key: item.key, at: item.at)
        case .card(let item):
            self = .card(
                WorkInboxCard(
                    stage: item.stage == .blocked ? .blocked : .review,
                    agentName: item.agent.name,
                    subject: CrmSubject(wire: item.subject),
                    task: item.task.map(CrmTask.init(wire:)),
                    issue: item.issue.map(CrmIssue.init(wire:))
                ),
                key: item.key,
                at: item.at
            )
        case .followUp(let item):
            self = .followUp(item, key: item.key, at: item.at)
        case .note(let item):
            self = .note(item.note, key: item.key, at: item.at)
        case .sales(let item):
            self = .sales(UntriagedTouch(wire: item.touch), key: item.key, at: item.at)
        case .comment(let item):
            self = .comment(
                WorkInboxComment(
                    document: item.document,
                    subject: item.subject.map(CrmSubject.init(wire:)),
                    thread: item.thread,
                    latest: item.latest,
                    replies: item.replies
                ),
                key: item.key,
                at: item.at
            )
        case .booking(let item):
            self = .booking(
                WorkInboxBooking(
                    booking: item.booking,
                    change: WorkInboxBooking.Change(rawValue: item.change.rawValue) ?? .booked,
                    eventKey: item.eventKey
                ),
                key: item.key,
                at: item.at
            )
        case .invitation(let item):
            self = .invitation(CalendarEventSummary(wire: item.event), key: item.key, at: item.at)
        case .forwarded(let item):
            self = .forwarded(item.event, key: item.key, at: item.at)
        case .interest(let item):
            self = .interest(item.submission, key: item.key, at: item.at)
        case .submission(let item):
            self = .submission(item.submission, key: item.key, at: item.at)
        case .commercial(let item):
            self = .commercial(item, key: item.key, at: item.at)
        case .decision(let item):
            self = .decision(item.ask, key: item.key, at: item.at)
        case .question(let item):
            self = .question(item.request, key: item.key, at: item.at)
        case .other:
            return nil
        case .support:
            // Starlings support replied: Help is on the web first.
            return nil
        case .guest(let item):
            self = .guest(item, key: item.key, at: item.at)
        }
    }
}

/// A card an agent handed back for a person: in Review to accept, or
/// Blocked to unstick. Exactly one of `task` and `issue` is set.
struct WorkInboxCard: Sendable {
    enum Stage: Sendable {
        case review, blocked
    }

    let stage: Stage
    let agentName: String
    let subject: CrmSubject
    let task: CrmTask?
    let issue: CrmIssue?

    var title: String { task?.title ?? issue?.title ?? "" }

    /// "Review · Vocab · Acme rollout": what waits, who stopped, where.
    var detail: String {
        switch stage {
        case .review: String(localized: "Review · \(agentName) · \(subject.title)")
        case .blocked: String(localized: "Blocked · \(agentName) · \(subject.title)")
        }
    }

    /// The card itself: the issue in Work's own issue view, or the task on
    /// its subject's Tasks pane.
    var destination: WorkDestination {
        if let issue, let door = WorkDestination.issue(reference: issue.id) { return door }
        return WorkDestination(subject: subject, pane: .tasks)
    }
}

/// A guest's booking as INBOX carries it: who, when, and what they wrote.
/// The calendar owns the event; `eventReference` is the door to it.
struct WorkInboxBooking: Sendable {
    enum Change: String, Sendable {
        case booked, rescheduled, cancelled
    }

    typealias Booking = InboxBooking

    let booking: Booking
    let change: Change
    /// `event:g:<id>` — the calendar's own key, or nil with no Google event.
    let eventKey: String?

    var start: Date? { ISODate.parse(booking.startTime) }

    /// `<calendarId>:<eventId>` as the search palette spells an event door.
    /// Nil once cancelled: the event is gone.
    var eventReference: String? {
        guard change != .cancelled else { return nil }
        return booking.googleEventID.map { "primary:\($0)" }
    }

    /// "Booked · Tomorrow 14:00 · Acme" — when, then who they are from.
    /// "Rescheduled · was Tue 10:00 · Tomorrow 14:00", "Cancelled · was Tue 10:00".
    var detailLabel: String {
        let when = { (wire: String?) -> String? in
            wire.flatMap(ISODate.parse).map { StarlingsDateFormatting.dayTime($0) }
        }
        var parts: [String]
        switch change {
        case .booked:
            parts = ["Booked", when(booking.startTime)].compactMap { $0 }
        case .rescheduled:
            parts = ["Rescheduled", when(booking.previousStartTime).map { "was " + $0 }, when(booking.startTime)].compactMap { $0 }
        case .cancelled:
            parts = ["Cancelled", when(booking.startTime).map { "was " + $0 }].compactMap { $0 }
        }
        if let organization = booking.guestOrganization, !organization.isEmpty { parts.append(organization) }
        return parts.joined(separator: " · ")
    }
}

extension CalendarEventSummary {
    /// An invitation's second line: "Invitation · Tue 7 Oct · 14:00 · Work";
    /// an all-day event has no time.
    var invitationDetail: String {
        let start = CalendarDateParsing.parse(self.start)
        return [
            String(localized: "Invitation"),
            start.map { StarlingsDateFormatting.cardDate($0) },
            isAllDay ? nil : start.map { StarlingsDateFormatting.time($0) },
            calendarSummary.isEmpty ? nil : calendarSummary,
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }

    /// The door a search row spells for this event (`<calendarId>:<eventId>`).
    var eventReference: String { "\(calendarId):\(rawEventID)" }
}

/// A decision waiting on you, as INBOX carries it. The row says the
/// question, the recommendation and the default-by day; opening it shows
/// the context and links (docs/help/howto/answer-a-decision.md).
extension DecisionAsk: Identifiable {}

extension DecisionAsk {
    /// The recommended option's label, or its key when the list lacks it.
    var recommendedLabel: String {
        options.first { $0.key == recommendation }?.label ?? recommendation
    }

    /// "Default by 3 Oct" — the civil day, read as the day it names.
    var defaultByLabel: String {
        String(localized: "Default by \(Self.dayLabel(defaultBy))")
    }

    /// "Decision · Recommended: Behind a flag · Default by 3 Oct", or
    /// "Overdue · …" once the day has passed. Web: `decisionDetail`.
    var detailLabel: String {
        [
            overdue ? String(localized: "Overdue") : String(localized: "Decision"),
            String(localized: "Asked by \(askedBy)"),
            String(localized: "Recommended: \(recommendedLabel)"),
            defaultByLabel,
        ].joined(separator: " · ")
    }

    /// A `YYYY-MM-DD` day as a short date, in UTC so the day never shifts.
    static func dayLabel(_ day: String) -> String {
        let parser = DateFormatter()
        parser.calendar = Calendar(identifier: .gregorian)
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: day) else { return day }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: TimeZone(identifier: "UTC") ?? .current))
    }
}

/// A company that filled in /interest, as INBOX carries it: the picks come
/// as the words they saw, and `lead` is the lead it filed, which the row opens.
typealias WorkInboxInterest = InboxInterestSubmission

extension InboxInterestSubmission {
    var detailLabel: String {
        [String(localized: "Interest"), name, teamSize, deployment].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// One person's answers to a public form, as INBOX carries it: the picks
/// that sort it come as words, and `lead` is the lead it filed, which the row opens.
typealias WorkInboxSubmission = InboxFormSubmission

extension InboxFormSubmission {
    var rowTitle: String { organization.isEmpty ? name : organization }

    var detailLabel: String {
        [title, name, summary].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// An offer about to expire or a license about to renew, as INBOX carries
/// it. The words are `SubjectCommercial`'s, the
/// ones the subject's Overview uses.
typealias WorkInboxCommercial = InboxCommercialItem

extension InboxCommercialItem {
    var crmSubject: CrmSubject {
        CrmSubject(id: subject.id, kind: subject.kind.rawValue, title: subject.title, subtitle: nil)
    }

    /// "Offer expires 3 Nov", in this client's short date style.
    var rowTitle: String { SubjectCommercial.inboxTitle(self, day: Self.day) }

    /// "Acme · Rollout offer · €12,000".
    var detailLabel: String { SubjectCommercial.inboxDetail(self) }

    /// The short date style the subject's Overview rows use on this client.
    private static func day(_ wire: String?) -> String? {
        #if os(iOS)
        MobileDayLabel.text(wire)
        #else
        CrmTaskDate.display(wire)
        #endif
    }
}

/// One open thread as INBOX carries it: enough to draw the row and open the
/// document. The full thread is read on the document (DocsKit annotations).
struct WorkInboxComment: Sendable {
    typealias Document = InboxCommentDocument
    typealias Annotation = DocsAnnotation

    let document: Document
    let subject: CrmSubject?
    let thread: Annotation
    let latest: Annotation
    let replies: Int
}

typealias WorkInboxRecentEntry = InboxRecentEntry

extension InboxRecentEntry: Identifiable {
    var activityDetail: String {
        let timestamp = CrmTaskDate.date(date).map { StarlingsDateFormatting.dateTime($0, dateStyle: .abbreviated) }
        return [subject.title, timestamp].compactMap { $0 }.joined(separator: " · ")
    }

    func matchesActivity(query: String) -> Bool {
        Search.matches(query: query, title: title, subtitle: subject.title)
    }
}

extension InboxRecentEntrySubject {
    var crmSubject: CrmSubject { CrmSubject(id: id, kind: kind.rawValue, title: title, subtitle: nil) }
}

extension DocsAnnotation {
    var who: String {
        if let authorName, !authorName.isEmpty { return authorName }
        return author.split(separator: "@").first.map(String.init) ?? author
    }
}

extension DocsAnnotationAnchor {
    /// The passage a comment is on, for either kind of anchor.
    var quote: String? {
        switch self {
        case .text(let anchor): anchor.quote
        case .pdf(let anchor): anchor.quote
        case .other: nil
        }
    }
}

// MARK: - INBOX, everywhere

/// INBOX is the one count of what needs you (: "inbox everywhere").
/// Every badge and every glance surface — Home's WORK card, the menu bar,
/// the launch card's Work button, the iOS tab, the web nav — reads the same
/// list the Work window draws, so a number on one is the number on all.
extension WorkInboxResponse {
    /// The Work Overview keeps captures in their own list below INBOX. They
    /// still arrive with the same feed so its source preference and polling
    /// semantics do not fork across surfaces.
    var itemsWithoutQuickNotes: [WorkInboxItem] {
        items.filter { if case .note = $0 { false } else { true } }
    }

    var quickNoteItems: [WorkInboxItem] {
        items.filter {
            if case .note(let note, _, _) = $0 { note.isOpen }
            else { false }
        }
    }

    /// Everything in the list except unread talk. Talk is counted live from
    /// the thread poll on every surface already; a badge adds these to it so
    /// the two polls' cadences never double-count a conversation.
    var itemsBesideTalk: [WorkInboxItem] {
        items.filter { if case .talk = $0 { false } else { true } }
    }

    /// The INBOX items Home's INBOX card lists beside the unread
    /// conversations: `itemsBesideTalk` minus unfiled Quick Notes (their own
    /// card). Badges keep counting them; only the card drops them. Web:
    /// `inboxItemsForHomeCard`.
    var itemsForHomeCard: [WorkInboxItem] {
        itemsBesideTalk.filter {
            switch $0 {
            case .note: false
            default: true
            }
        }
    }
}

extension WorkInboxItem {
    /// One line and a mark, for a surface with no room for the row: what it
    /// is, then where it is from. The Work window draws the real row.
    var glanceTitle: String {
        switch self {
        case .talk(let thread, let mention, _, _):
            (mention ? String(localized: "Mentions you · ") : "") + (thread.subject?.title ?? thread.subjectTitle ?? thread.kind.channelNoun.capitalized)
        case .task(let task, _, _, _): task.title
        case .card(let card, _, _): card.title
        case .followUp(let item, _, _): item.draft.subject
        case .note(let note, _, _): note.firstLine
        case .sales(let touch, _, _): touch.displayTitle
        case .comment(let comment, _, _): comment.document.title
        case .booking(let booking, _, _): booking.booking.guestName
        case .invitation(let event, _, _): event.title.isEmpty ? String(localized: "Calendar invitation") : event.title
        case .forwarded(let event, _, _): event.title
        case .interest(let interest, _, _): interest.company
        case .submission(let submission, _, _): submission.rowTitle
        case .commercial(let item, _, _): item.rowTitle
        case .decision(let ask, _, _): ask.question
        case .question(let request, _, _): request.prompt
        case .guest(let item, _, _): item.subject.title
        }
    }

    var glanceDetail: String {
        switch self {
        case .talk(let thread, _, _, _): thread.lastMessagePreview ?? String(localized: "Unread")
        case .task(_, let subject, _, _): subject.proposedTaskDetail
        case .card(let card, _, _): card.detail
        case .followUp(let item, _, _):
            String(localized: "Follow-up · \(item.recipients.map(\.name).joined(separator: ", ")) · \(item.subject.title)")
        case .note: String(localized: "Quick Note to file")
        case .sales(let touch, _, _): String(localized: "Sales · \(touch.source.label)")
        case .comment(let comment, _, _): String(localized: "Comment · \(comment.subject?.title ?? String(localized: "Docs"))")
        case .booking(let booking, _, _): booking.detailLabel
        case .invitation(let event, _, _): event.invitationDetail
        case .forwarded(let event, _, _): event.scheduleLine
        case .interest(let interest, _, _): interest.detailLabel
        case .submission(let submission, _, _): submission.detailLabel
        case .commercial(let item, _, _): item.detailLabel
        case .decision(let ask, _, _): ask.detailLabel
        case .question(let request, _, _): request.questionDetail
        case .guest(let item, _, _): item.detailLabel
        }
    }

    /// No INBOX row shows a bare checkmark in its square: that reads as a
    /// checkbox, and no INBOX row completes on a tap. A proposed task waits
    /// on Accept, so its mark is a task to add; a decision is a choice
    /// between options, so its mark is a fork. Web: `inboxItemMeta`.
    var glanceSymbolName: String {
        switch self {
        case .talk: "bubble.left.fill"
        case .task: "text.badge.plus"
        case .card(let card, _, _): card.stage == .blocked ? "exclamationmark.triangle" : "checkmark.circle"
        case .followUp: "envelope"
        case .note: "pencil"
        case .sales: "tray"
        case .comment: "text.bubble"
        case .booking: "calendar.badge.plus"
        case .invitation: "calendar.badge.clock"
        case .forwarded: "envelope.badge"
        case .interest, .submission: "building.2"
        case .commercial(let item, _, _): item.event == .offerExpiring ? "doc.plaintext" : "key"
        case .decision: "arrow.triangle.branch"
        case .question: "questionmark.bubble"
        case .guest: "person.2"
        }
    }

    /// Actionable work records use the square mark family; areas, people and
    /// calendar/provider entries keep the round family.
    var glanceUsesSquareMark: Bool {
        switch self {
        // An offer or a license is a record, square as on the subject's Overview.
        case .task, .card, .followUp, .note, .comment, .decision, .question, .commercial: true
        case .talk, .sales, .booking, .invitation, .forwarded, .interest, .submission, .guest: false
        }
    }

    /// Where a glance opens. Nil is Work itself: a note is filed from INBOX,
    /// and a touch becomes a lead from there.
    var glanceDestination: WorkDestination? {
        switch self {
        case .talk(let thread, _, _, _): thread.subject.map { WorkDestination(subject: $0, pane: .talk) }
        case .task(_, let subject, _, _): WorkDestination(subject: subject, pane: .tasks)
        case .card(let card, _, _): card.destination
        case .note, .sales, .booking, .invitation, .forwarded, .decision, .followUp, .question: nil
        case .comment(let comment, _, _): comment.subject.map { WorkDestination(subject: $0, pane: .talk) }
        // The lead the submission filed (docs/FORMS.md); nil on an older row.
        case .interest(let interest, _, _): interest.lead.map { WorkDestination(subject: CrmSubject(wire: $0)) }
        case .submission(let submission, _, _): submission.lead.map { WorkDestination(subject: CrmSubject(wire: $0)) }
        // The lead or organization the offer or license is on, at its Overview.
        case .commercial(let item, _, _): WorkDestination(subject: item.crmSubject)
        // An intake thread is a conversation, not a subject: `glanceThreadID`.
        case .guest(let item, _, _): item.opensConversation ? nil : WorkDestination(subject: item.crmSubject, pane: .talk)
        }
    }

    /// The conversation a glance opens in Team instead of Work: a guest row
    /// on `intake` (an app user or a public contact). Web: `inboxItemHref`.
    var glanceThreadID: String? {
        guard case .guest(let item, _, _) = self, item.opensConversation else { return nil }
        return item.threadID
    }
}

extension InboxGuestItem {
    /// `intake` is not a subject anyone opens: the row goes to its thread.
    var opensConversation: Bool { subject.id == "intake" }

    var crmSubject: CrmSubject { CrmSubject(id: subject.id, kind: subject.kind.rawValue, title: subject.title, subtitle: nil) }

    /// "App user · Can I export…" — who wrote, then the clipped line. Web:
    /// the `guest` case of `inboxItemMeta`.
    var detailLabel: String {
        let who: String = if origin == .app {
            String(localized: "App user")
        } else if opensConversation {
            String(localized: "Public contact")
        } else if origin == .peer {
            String(localized: "Organization")
        } else {
            String(localized: "Guest")
        }
        let line = preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return line.isEmpty ? who : "\(who) · \(line)"
    }
}

extension CrmSubject {
    /// The subline of a proposed task: which subject it would land on. A
    /// partner says so, because a bare organization name reads as a lead.
    var proposedTaskDetail: String {
        kind == "organization"
            ? String(localized: "Proposed · Partner · \(title)")
            : String(localized: "Proposed · \(title)")
    }
}

extension WorkInboxResponse {
    /// A failed question source is unknown, not an empty queue. Preserve source
    /// order from the last successful read until the server can read it again.
    func retainingQuestions(from previous: WorkInboxResponse) -> WorkInboxResponse {
        guard partial.contains("question") else { return self }
        let decisions = items.filter { if case .decision = $0 { true } else { false } }
        let questions = previous.items.filter { if case .question = $0 { true } else { false } }
        let rest = items.filter { switch $0 { case .decision, .question: false; default: true } }
        return WorkInboxResponse(items: decisions + questions + rest, recent: recent, partial: partial,
            recentPartial: recentPartial, taskPartial: taskPartial, capped: capped)
    }
}
