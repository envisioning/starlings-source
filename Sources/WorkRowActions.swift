import Foundation
import StarlingsContracts

/// Stable intent ids shared with contracts and the fixture. Labels, symbols,
/// and execution stay with each surface.
enum WorkRowActionID: String, CaseIterable, Sendable {
    case accept
    case decline
    case complete
    case cancel
    case markSeen = "mark-seen"
    case fileGithub = "file-github"
    case openSubject = "open-subject"
    case openMine = "open-mine"
    case openCore = "open-core"
    case closeIssue = "close-issue"
    case closeNotPlanned = "close-not-planned"
    case reopenIssue = "reopen-issue"
    case open
    case openGithub = "open-github"
    case copyLink = "copy-link"
    case star
    case markRead = "mark-read"
    case mute
    case archive
    case startLead = "start-lead"
    case dismiss
    case undoDismiss = "undo-dismiss"
    case copyEmail = "copy-email"
    case openDocument = "open-document"
    case resolve
    case openCalendar = "open-calendar"
    case edit
    case fileNote = "file-note"
    case moveWorkspace = "move-workspace"
    case delete
    case editDetails = "edit-details"
    case winLead = "win-lead"
    case rename
    case openTalk = "open-talk"
    case openHistory = "open-history"
    case openTasks = "open-tasks"
    case openIssues = "open-issues"
    case newTask = "new-task"
    case newIssue = "new-issue"
    case newDocument = "new-document"
    case startRoom = "start-room"
    case linkRepository = "link-repository"
    case keepVault = "keep-vault"
    case met
    case drop
    case reopen
    case openFloating = "open-floating"
    case openPage = "open-page"
    case copyPageLink = "copy-page-link"
    case fileDocument = "file-document"
    case openConversation = "open-conversation"
    case moveStage = "move-stage"
    case handOff = "hand-off"
    case react
    case saveNote = "save-note"
    case copy
    case reply
    case decide
    case makeCard = "make-card"
    case withdraw
    case copyForwardingAddress = "copy-forwarding-address"
    case message
    case wave
    case call
    case joinRoom = "join-room"
    case starPerson = "star-person"
    case starThread = "star-thread"
    case notesSelf = "notes-self"
    case setStatus = "set-status"
    case assign
    case makeResponsible = "make-responsible"
    case rsvp
}

/// One SF Symbol per menu verb, for every native menu: the Mac's context
/// menus and the phone's. The web draws the same verbs from Lucide
/// (`web/src/menu-icons.tsx`), matched to these names.
enum MenuSymbol: String, Sendable {
    case open = "arrow.right.circle"
    case openExternal = "arrow.up.right.square"
    case openCore = "safari"
    case openDocument = "doc.text"
    case calendar = "calendar"
    case talk = "bubble.left.and.bubble.right"
    case history = "clock.arrow.circlepath"
    case tasks = "checklist"
    case issues = "smallcircle.filled.circle"
    case floating = "macwindow.on.rectangle"
    case copy = "doc.on.doc"
    case copyLink = "link"
    case paste = "doc.on.clipboard"
    case star = "star"
    case unstar = "star.slash"
    case mute = "bell.slash"
    case unmute = "bell"
    case markRead = "envelope.open"
    case archive = "archivebox"
    case unarchive = "tray.and.arrow.up"
    case edit = "pencil"
    case rename = "character.cursor.ibeam"
    case move = "folder"
    case file = "tray.and.arrow.down"
    case delete = "trash"
    case accept = "checkmark.circle"
    case decline = "xmark.circle"
    case maybe = "questionmark.circle"
    case done = "checkmark.circle.fill"
    case cancel = "minus.circle"
    case notPlanned = "slash.circle"
    case reopen = "arrow.uturn.backward"
    case dismiss = "xmark"
    case seen = "eye"
    case hide = "eye.slash"
    case resolve = "checkmark.bubble"
    case decide = "checkmark"
    case startLead = "person.crop.circle.badge.plus"
    case fileOnGitHub = "arrow.up.forward.square"
    case newProject = "folder.badge.plus"
    case newTask = "text.badge.plus"
    case newIssue = "plus.circle"
    case newDocument = "doc.badge.plus"
    case newEvent = "calendar.badge.plus"
    case startRoom = "video.badge.plus"
    case linkRepository = "link.badge.plus"
    case vault = "books.vertical"
    case moveStage = "arrow.left.arrow.right"
    case handOff = "arrowshape.turn.up.right"
    case react = "face.smiling"
    case reply = "arrowshape.turn.up.left"
    case message = "message"
    case wave = "hand.wave"
    case video = "video"
    case duplicate = "plus.square.on.square"
    case notes = "square.and.pencil"
    case status = "person.crop.circle"
    case assign = "person.crop.circle.badge.checkmark"
    case reset = "arrow.counterclockwise"
    case winLead = "checkmark.seal"
}

extension WorkRowActionID {
    /// The verb's glyph. Exhaustive, so a new registry verb must name one.
    var menuSymbol: MenuSymbol {
        switch self {
        case .accept: .accept
        case .decline: .decline
        case .complete, .closeIssue, .met: .done
        case .cancel, .drop: .cancel
        case .markSeen: .seen
        case .fileGithub: .fileOnGitHub
        case .open, .openSubject, .openMine: .open
        case .openCore: .openCore
        case .closeNotPlanned: .notPlanned
        case .reopenIssue, .reopen, .undoDismiss: .reopen
        case .openGithub, .openPage: .openExternal
        case .copyLink, .copyPageLink: .copyLink
        case .star, .starPerson, .starThread: .star
        case .markRead: .markRead
        case .mute: .mute
        case .archive: .archive
        case .startLead: .startLead
        case .dismiss: .dismiss
        case .copyEmail, .copy, .copyForwardingAddress: .copy
        case .openDocument: .openDocument
        case .resolve: .resolve
        case .openCalendar: .calendar
        case .edit, .editDetails: .edit
        case .winLead: .winLead
        case .fileNote: .file
        case .moveWorkspace: .move
        case .delete, .withdraw: .delete
        case .rename: .rename
        case .openTalk, .openConversation: .talk
        case .openHistory: .history
        case .openTasks: .tasks
        case .openIssues: .issues
        case .newTask: .newTask
        case .newIssue: .newIssue
        case .newDocument: .newDocument
        case .startRoom: .startRoom
        case .linkRepository: .linkRepository
        case .keepVault: .vault
        case .openFloating: .floating
        case .fileDocument: .move
        case .moveStage: .moveStage
        case .handOff: .handOff
        case .react: .react
        case .saveNote: .notes
        case .reply: .reply
        case .decide: .decide
        case .makeCard: .newTask
        case .message: .message
        case .wave: .wave
        case .call: .video
        case .joinRoom: .video
        case .notesSelf: .notes
        case .setStatus: .status
        case .assign: .assign
        case .makeResponsible: .assign
        // One item per answer; each item wears its own answer's glyph.
        case .rsvp: .accept
        }
    }
}

enum WorkRowKind: String, CaseIterable, Sendable {
    case task
    case issue
    case inboxTalk = "inbox_talk"
    case inboxSales = "inbox_sales"
    case inboxComment = "inbox_comment"
    case inboxCard = "inbox_card"
    case inboxFollowup = "inbox_followup"
    case inboxBooking = "inbox_booking"
    case inboxInvitation = "inbox_invitation"
    case inboxForwarded = "inbox_forwarded"
    case inboxInterest = "inbox_interest"
    case inboxCommercial = "inbox_commercial"
    case inboxDecision = "inbox_decision"
    case inboxQuestion = "inbox_question"
    case quickNote = "quick_note"
    case subject
    case goal
    case doc
    case docRail = "doc_rail"
    case boardCard = "board_card"
    case message
    case conversation
    case person
}

protocol WorkRowActionMenuContext: RawRepresentable where RawValue == String {}

enum WorkTaskMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext {
    case inboxProposed = "inbox_proposed"
    case subjectProposed = "subject_proposed"
    case subjectOpen = "subject_open"
    case mine
    case assigned
    case unowned
}

enum WorkIssueMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext {
    case row
    case assigned
    case unowned
}

enum WorkInboxTalkMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxSalesMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxCommentMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxCardMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxFollowupMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxBookingMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxInvitationMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxForwardedMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxInterestMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxCommercialMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxQuestionMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkInboxDecisionMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkQuickNoteMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext {
    case home
    case inbox
}
enum WorkSubjectMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext {
    case row
    case organization
}
enum WorkGoalMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkDocMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkDocRailMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext {
    case folder
    case address
}
enum WorkBoardCardMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkMessageMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext { case row }
enum WorkConversationMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext {
    case row
    case home
}
enum WorkPersonMenuContext: String, CaseIterable, Sendable, WorkRowActionMenuContext {
    case peer
    case agent
    case selfContext = "self"
    case attendee
}

enum WorkActionClient: String, CaseIterable, Sendable {
    case mac
    case ios
    case web
}

struct WorkActionClientAvailability: Equatable, Sendable {
    let mac: Bool
    let ios: Bool
    let web: Bool

    func supports(_ client: WorkActionClient) -> Bool {
        switch client {
        case .mac: mac
        case .ios: ios
        case .web: web
        }
    }

    static let all = Self(mac: true, ios: true, web: true)
    static let native = Self(mac: true, ios: true, web: false)
    static let macOnly = Self(mac: true, ios: false, web: false)
    static let macAndWeb = Self(mac: true, ios: false, web: true)
    static let webOnly = Self(mac: false, ios: false, web: true)
    static let unavailable = Self(mac: false, ios: false, web: false)
}

struct WorkRowActionFacts: Sendable {
    private let values: [String: Bool]

    init(_ values: [String: Bool] = [:]) { self.values = values }

    fileprivate func isTrue(_ name: String) -> Bool { values[name] == true }
    fileprivate func isFalse(_ name: String) -> Bool { values[name] == false }
}

enum WorkRowActionRegistry {
    // The tables are generated from packages/contracts/src/work-actions.ts
    // (`groupTable`, `clientTable`, `destructiveActions`): Sources/Generated/WorkActionsRegistry.swift.
    // `fixtures/work-actions.json` is generated from the same module and pins them
    // (`WorkRowActionFixtureTests`). The facts that gate an action stay below.

    static func canonicalGroups(kind: WorkRowKind, context: String) -> [[WorkRowActionID]] {
        groupTable[kind]?[context] ?? []
    }

    static func clientAvailability(kind: WorkRowKind) -> [WorkRowActionID: WorkActionClientAvailability] {
        clientTable[kind] ?? [:]
    }

    static func isDestructive(_ action: WorkRowActionID) -> Bool {
        destructiveActions.contains(action)
    }

    static func groups<Context: WorkRowActionMenuContext>(
        kind: WorkRowKind, context: Context, client: WorkActionClient,
        facts: WorkRowActionFacts = .init()
    ) -> [[WorkRowActionID]] {
        groups(kind: kind, context: context.rawValue, client: client, facts: facts)
    }

    static func groups(
        kind: WorkRowKind, context: String, client: WorkActionClient,
        facts: WorkRowActionFacts = .init()
    ) -> [[WorkRowActionID]] {
        canonicalGroups(kind: kind, context: context).compactMap { group in
            let filtered = group.filter { action in
                clientTable[kind]?[action]?.supports(client) == true && matches(kind: kind, action: action, facts: facts)
            }
            return filtered.isEmpty ? nil : filtered
        }
    }

    private static func fact(_ facts: WorkRowActionFacts, _ name: String) -> Bool { facts.isTrue(name) }

    private static func matches(kind: WorkRowKind, action: WorkRowActionID, facts: WorkRowActionFacts) -> Bool {
        switch kind {
        case .task:
            if action == .openSubject { return fact(facts, "hasSubject") }
            if action == .openMine { return facts.isFalse("hasSubject") }
            if action == .openCore { return fact(facts, "hasCore") }
            if action == .fileGithub { return fact(facts, "canFileOnGitHub") }
            if action == .star { return fact(facts, "isStarable") }
            if action == .assign { return fact(facts, "canAssign") }
            if action == .handOff { return fact(facts, "canHandOff") }
            if action == .delete { return fact(facts, "canDelete") }
        case .issue:
            if action == .handOff { return fact(facts, "canHandOff") && fact(facts, "isOpen") }
            if action == .closeIssue || action == .closeNotPlanned { return fact(facts, "isOpen") }
            if action == .reopenIssue { return facts.isFalse("isOpen") }
            if action == .openGithub || action == .copyLink { return fact(facts, "hasRepo") }
            if action == .openCore { return fact(facts, "hasCore") }
            if action == .markSeen { return fact(facts, "canMarkSeen") }
            if action == .assign { return fact(facts, "canAssign") }
        case .inboxTalk:
            if action == .openSubject { return fact(facts, "hasSubject") }
            if action == .markRead { return fact(facts, "hasUnread") }
            if action == .openCore { return fact(facts, "hasCore") }
        case .inboxSales:
            if action == .dismiss { return facts.isFalse("isDismissed") }
            if action == .undoDismiss { return fact(facts, "isDismissed") }
            if action == .copyEmail { return fact(facts, "hasEmail") }
        case .inboxComment:
            if action == .openSubject { return fact(facts, "hasSubject") }
            if action == .openCore { return fact(facts, "hasCore") }
        case .inboxCard:
            if action == .openGithub { return fact(facts, "isIssue") }
        case .inboxFollowup:
            break
        case .inboxBooking:
            if action == .openCalendar { return fact(facts, "hasEvent") }
            if action == .copyEmail { return fact(facts, "hasEmail") }
        case .inboxInterest:
            if action == .copyEmail { return fact(facts, "hasEmail") }
        case .inboxCommercial:
            if action == .dismiss { return facts.isFalse("isDismissed") }
            if action == .undoDismiss { return fact(facts, "isDismissed") }
        case .inboxInvitation, .inboxForwarded, .inboxQuestion, .inboxDecision:
            break
        case .quickNote:
            // File… stays after the first filing: a note can be filed again.
            if action == .edit { return fact(facts, "isEditable") }
            if action == .moveWorkspace { return fact(facts, "hasOtherWorkspace") }
        case .subject:
            if action == .openTalk || action == .openHistory { return fact(facts, "isPartner") }
            if action == .editDetails || action == .rename { return !fact(facts, "isPartner") && !fact(facts, "isEvent") }
            if action == .winLead { return fact(facts, "isOpenLead") }
            if action == .openIssues || action == .newIssue { return fact(facts, "isProject") && fact(facts, "hasRepo") }
            if action == .startRoom { return !fact(facts, "isEvent") }
            if action == .linkRepository { return fact(facts, "isProject") && !fact(facts, "hasRepo") }
            if action == .keepVault { return fact(facts, "isProject") && !fact(facts, "hasVault") }
            if action == .openCore { return fact(facts, "hasCore") }
        case .goal:
            if action == .met || action == .drop { return fact(facts, "isOpen") }
            if action == .reopen { return facts.isFalse("isOpen") }
        case .doc:
            if action == .openPage || action == .copyPageLink { return fact(facts, "isSavedLink") }
            if action == .copyLink { return facts.isFalse("isSavedLink") }
            if action == .fileDocument || action == .rename || action == .archive { return fact(facts, "isEditable") }
        case .docRail:
            if action == .star { return fact(facts, "isFolder") }
        case .boardCard:
            if action == .openGithub { return fact(facts, "hasRepo") }
            if action == .openSubject { return fact(facts, "hasSubject") }
            if action == .openConversation { return fact(facts, "hasConversation") }
            if action == .moveStage { return fact(facts, "canMoveStage") }
            if action == .handOff { return fact(facts, "hasAgents") }
        case .message:
            if fact(facts, "isPartial") { return false }
            if action == .react { return facts.isFalse("isWithdrawn") }
            if action == .saveNote {
                return fact(facts, "isMine") && facts.isFalse("isWithdrawn") && facts.isFalse("isEvent") && fact(facts, "hasText")
            }
            if action == .copy { return fact(facts, "hasText") }
            if action == .reply { return fact(facts, "isReplyable") }
            if action == .decide { return fact(facts, "canDecide") }
            if action == .makeCard { return fact(facts, "canMakeCard") }
            if action == .edit || action == .withdraw {
                return fact(facts, "isMine") && facts.isFalse("isWithdrawn") && facts.isFalse("isEvent")
            }
        case .conversation:
            if action == .markRead { return fact(facts, "hasUnread") }
            if action == .copyForwardingAddress { return fact(facts, "hasInboundAddress") }
            if action == .archive { return !facts.isFalse("isDirect") }
            if action == .openCore { return fact(facts, "hasCore") }
        case .person:
            if action == .wave { return fact(facts, "canWave") }
            if action == .call { return fact(facts, "canCall") }
            if action == .joinRoom { return fact(facts, "canJoinRoom") }
            if action == .copyEmail { return fact(facts, "hasEmail") }
            if action == .starThread { return fact(facts, "hasThread") }
            if action == .starPerson { return fact(facts, "hasFavorite") }
            if action == .openCore { return fact(facts, "hasCore") }
            if action == .makeResponsible { return fact(facts, "canMakeResponsible") }
        }
        return true
    }
}

/// The three state changes an issue row offers, with GitHub's own reasons:
/// finished work and decided-against work read apart on GitHub.
enum WorkIssueStateChange: Sendable {
    case close
    case closeNotPlanned
    case reopen

    var state: String { self == .reopen ? "open" : "closed" }
    var stateReason: String? {
        switch self {
        case .close: "completed"
        case .closeNotPlanned: "not_planned"
        case .reopen: nil
        }
    }
}

/// What a row in INBOX or on Home's WORK card can do from its menu, decided
/// once for the Mac and the phone. Each surface only draws the list — an
/// `NSMenu` on the Mac, a `contextMenu` on iOS — and performs the action
/// with its own API and windows. So a talk row offers the same four things
/// on every surface, and a new action lands everywhere at once.
///
/// Groups are separated by a line. The first group is what the row is for,
/// then what makes it leave the list, then where else it can be opened.
enum WorkRowAction: Identifiable, Sendable {
    // Where it goes.
    /// Open a subject or Mine at a pane. `title` is the row's own wording:
    /// "Open Acme", "Open", "Open in Mine".
    case open(WorkDestination, title: String)
    case openGitHub(URL)
    case copyLink(String)
    case openDocument(id: String, title: String)
    case openCore(URL)
    /// Open the calendar on one event, by the door a search row spells
    /// (`<calendarId>:<eventId>`).
    case openEvent(reference: String)

    // Unread talk.
    /// Open the conversation behind its own door: Work for a subject's,
    /// Team for a person's. The surface that drew the row performs it.
    case openConversation(ThreadSummary)
    case markRead(ThreadSummary)
    /// Muted for a week, or unmuted — the same rule as the thread pane.
    case mute(ThreadSummary)
    case archive(ThreadSummary)

    // A proposed task.
    case accept(CrmTask)
    case decline(CrmTask)

    // An unfiled Quick Note.
    /// Open the note to rewrite it — Home's drawer, popover or dialog.
    case editNote(QuickNote)
    case fileNote(QuickNote)
    /// To another workspace this device is signed in to: one action per
    /// workspace, folded into one Move to ▸ submenu (`submenu`).
    case moveNote(QuickNote, to: StarlingsWorkspace)
    case deleteNote(QuickNote)

    // A sales touch.
    case startLead(UntriagedTouch)
    case dismissTouch(UntriagedTouch)
    case undoDismissTouch(UntriagedTouch)
    case copyEmail(String)

    // An open comment thread on a document.
    case resolveComment(WorkInboxComment)

    // A decision waiting on you: one option, chosen from the row's menu,
    // or the whole of it — context, links, options and a note — opened.
    case answerDecision(DecisionAsk, option: DecisionAskOption)
    case openDecision(DecisionAsk)
    case openQuestion(AttentionRequest)

    // A row with no other resolution here: a guest's booking (filing it
    // happens in the calendar's inspector) or something assigned to you
    // (its work is MINE's). Seen, or unseen again.
    case dismissBooking(key: String)
    case undoDismissBooking(key: String)
    case markSeen(key: String)

    // A calendar request in INBOX. `key` is the INBOX item, which leaves at
    // once when the write succeeds.
    /// Accept, Maybe or Decline, written to Google Calendar.
    case respondToInvitation(CalendarEventSummary, CalendarRSVP, key: String)
    /// An event read from mail forwarded to calendar@: added to the primary
    /// calendar, or discarded.
    case addForwardedEvent(ProposedCalendarEvent, key: String)
    case discardForwardedEvent(ProposedCalendarEvent, key: String)

    // One of your own tasks — Home's due rows and Mine.
    case complete(CrmMyTask)
    /// Set the task to cancelled: it leaves the list because it will not be
    /// done. The status editor and the board can reopen it.
    case cancel(CrmMyTask)
    /// Hand the task to GitHub. Once only: a second issue would orphan the
    /// first.
    case promote(CrmMyTask)

    // A task in a subject's Tasks pane. These stay separate from `CrmMyTask`:
    // the subject endpoint has the full record and can complete or promote it
    // without pretending that Mine's summary is complete.
    case completeTask(CrmTask)
    case cancelTask(CrmTask)
    case promoteTask(CrmTask)

    /// Delete a task, from Mine or a subject's Tasks pane. The
    /// surface asks first; the row leaves when the write succeeds.
    case deleteTask(id: String, title: String)

    // A GitHub issue, wherever it is listed. `projectID` is the project the
    // list belongs to, so its channel hears about the change; nil where the
    // list is not one project's (Mine, INBOX).
    case setIssueState(CrmIssue, projectID: String?, WorkIssueStateChange)

    // Who holds it, from an UNOWNED row: one action per teammate, folded into
    // one Assign to ▸ submenu by both native renderers (`isAssign`).
    case assignTask(CrmMyTask, CrmTeamMember)
    /// The teammate's GitHub login becomes the issue's whole assignee set.
    case assignIssue(CrmIssue, CrmTeamMember)

    /// A person row on a project or lead: they answer for it (docs/OWNERSHIP.md).
    case makeResponsible(CrmSubject, email: String)
    /// To one agent, with the brief the surface asks for next.
    /// One item per agent, as on a Board card.
    case handOff(HandOffTarget, Peer)
    // After the call: read the follow-up and approve it, or not.
    case openFollowUp(InboxFollowUpItem)
    case dismissFollowUp(InboxFollowUpItem)

    /// Drawn inside the group's Assign to ▸ submenu, not as an item of its own.
    var isAssign: Bool {
        switch self {
        case .assignTask, .assignIssue: true
        default: false
        }
    }

    /// One submenu a group folds several actions into, where the first of
    /// them was. Both native renderers draw it; the items are the names.
    enum Submenu: Hashable {
        case assign
        case moveNote
        /// One Hand off to ▸ with the agents, not one item per agent.
        case handOff

        var title: String {
            switch self {
            case .assign: String(localized: "Assign to")
            case .moveNote: String(localized: "Move to")
            case .handOff: String(localized: "Hand off to")
            }
        }

        var symbol: MenuSymbol {
            switch self {
            case .assign: .assign
            case .moveNote: .move
            case .handOff: .handOff
            }
        }
    }

    var submenu: Submenu? {
        switch self {
        case .assignTask, .assignIssue: .assign
        case .moveNote: .moveNote
        case .handOff: .handOff
        default: nil
        }
    }

    /// The item a group's submenu is drawn in place of.
    func isFirstOfSubmenu(in group: [WorkRowAction]) -> Bool {
        guard let submenu else { return false }
        return group.first { $0.submenu == submenu }?.id == id
    }

    var isHandOff: Bool {
        if case .handOff = self { true } else { false }
    }

    /// Close, close as not planned or reopen: the issue writes every list performs.
    var isIssueStateChange: Bool {
        if case .setIssueState = self { true } else { false }
    }

    var id: String {
        switch self {
        case .open(let destination, _): "open:\(destination.hashValue)"
        case .openGitHub(let url): "github:\(url.absoluteString)"
        case .copyLink(let link): "copy-link:\(link)"
        case .openDocument(let id, _): "document:\(id)"
        case .openCore(let url): "core:\(url.absoluteString)"
        case .openEvent(let reference): "event:\(reference)"
        case .openConversation(let thread): "conversation:\(thread.id)"
        case .markRead(let thread): "read:\(thread.id)"
        case .mute(let thread): "mute:\(thread.id)"
        case .archive(let thread): "archive:\(thread.id)"
        case .accept(let task): "accept:\(task.id)"
        case .decline(let task): "decline:\(task.id)"
        case .editNote(let note): "edit:\(note.id)"
        case .fileNote(let note): "file:\(note.id)"
        case .moveNote(let note, let workspace): "move:\(note.id):\(workspace.webOrigin)"
        case .deleteNote(let note): "delete:\(note.id)"
        case .startLead(let touch): "lead:\(touch.id)"
        case .dismissTouch(let touch): "dismiss:\(touch.id)"
        case .undoDismissTouch(let touch): "undismiss:\(touch.id)"
        case .copyEmail(let email): "email:\(email)"
        case .resolveComment(let comment): "resolve:\(comment.thread.id)"
        case .answerDecision(let ask, let option): "answer:\(ask.id):\(option.key)"
        case .openDecision(let ask): "decision:\(ask.id)"
        case .openQuestion(let request): "question:\(request.id)"
        case .dismissBooking(let key): "dismiss:\(key)"
        case .undoDismissBooking(let key): "undismiss:\(key)"
        case .markSeen(let key): "seen:\(key)"
        case .respondToInvitation(_, let response, let key): "rsvp:\(key):\(response.rawValue)"
        case .addForwardedEvent(_, let key): "add-event:\(key)"
        case .discardForwardedEvent(_, let key): "discard-event:\(key)"
        case .complete(let task): "done:\(task.id)"
        case .promote(let task): "promote:\(task.id)"
        case .completeTask(let task): "done-task:\(task.id)"
        case .cancel(let task): "cancel:\(task.id)"
        case .cancelTask(let task): "cancel-task:\(task.id)"
        case .setIssueState(let issue, _, let change): "issue-\(change.state)-\(change.stateReason ?? ""):\(issue.id)"
        case .promoteTask(let task): "promote-task:\(task.id)"
        case .deleteTask(let id, _): "delete-task:\(id)"
        case .assignTask(let task, let member): "assign-task:\(task.id):\(member.id)"
        case .assignIssue(let issue, let member): "assign-issue:\(issue.id):\(member.id)"
        case .makeResponsible(let subject, let email): "make-responsible:\(subject.id):\(email)"
        case .handOff(let target, let agent): "hand-off:\(target.ref.kind):\(target.ref.id):\(agent.email)"
        case .openFollowUp(let item): "open-followup:\(item.key)"
        case .dismissFollowUp(let item): "dismiss-followup:\(item.key)"
        }
    }

    var title: String {
        switch self {
        case .open(_, let title): title
        case .openGitHub: String(localized: "Open on GitHub")
        case .copyLink: String(localized: "Copy link")
        case .openDocument: String(localized: "Open document")
        case .openCore: String(localized: "Open full record")
        case .openEvent: String(localized: "Open in Calendar")
        case .openConversation: String(localized: "Open")
        case .markRead: String(localized: "Mark as read")
        case .mute(let thread): thread.isMuted ? String(localized: "Unmute") : String(localized: "Mute")
        case .archive(let thread): thread.archivedAt == nil ? String(localized: "Archive") : String(localized: "Keep in chat")
        case .accept: String(localized: "Accept")
        case .decline: String(localized: "Decline")
        case .editNote: String(localized: "Edit")
        case .fileNote: String(localized: "File…")
        // The submenu says "Move to"; its items are the workspaces.
        case .moveNote(_, let workspace): workspace.name
        case .deleteNote: String(localized: "Delete")
        case .startLead: String(localized: "Start a lead…")
        case .dismissTouch: String(localized: "Dismiss")
        case .undoDismissTouch: String(localized: "Undo dismiss")
        case .copyEmail: String(localized: "Copy contact email")
        case .resolveComment: String(localized: "Resolve")
        case .answerDecision(let ask, let option):
            option.key == ask.recommendation
                ? String(localized: "Answer: \(option.label) (recommended)")
                : String(localized: "Answer: \(option.label)")
        case .openDecision: String(localized: "Open decision")
        case .openQuestion: String(localized: "Open question")
        case .dismissBooking: String(localized: "Dismiss")
        case .undoDismissBooking: String(localized: "Undo dismiss")
        case .markSeen: String(localized: "Seen")
        case .respondToInvitation(_, let response, _): response.answerTitle
        case .addForwardedEvent: String(localized: "Add to calendar")
        case .discardForwardedEvent: String(localized: "Discard")
        case .complete: String(localized: "Done")
        case .promote: String(localized: "File on GitHub")
        case .completeTask: String(localized: "Done")
        case .cancel, .cancelTask: String(localized: "Cancel task")
        case .setIssueState(_, _, .close): String(localized: "Close issue")
        case .setIssueState(_, _, .closeNotPlanned): String(localized: "Close as not planned")
        case .setIssueState(_, _, .reopen): String(localized: "Reopen issue")
        case .promoteTask: String(localized: "File on GitHub")
        case .deleteTask: String(localized: "Delete")
        // The submenu says "Assign to"; its items are the names.
        case .assignTask(_, let member), .assignIssue(_, let member): member.name
        case .makeResponsible: String(localized: "Make responsible")
        // The submenu says "Hand off to"; its items are the agents.
        case .handOff(_, let agent): agent.displayName
        case .openFollowUp: String(localized: "Open")
        case .dismissFollowUp: String(localized: "Dismiss")
        }
    }

    /// The action's glyph on both native menus: the registry verb's, or its
    /// undo when the row is already in that state.
    var menuSymbol: MenuSymbol {
        switch self {
        case .mute(let thread) where thread.isMuted: .unmute
        case .archive(let thread) where thread.archivedAt != nil: .unarchive
        case .respondToInvitation(_, .tentative, _): .maybe
        case .respondToInvitation(_, .declined, _): .decline
        case .addForwardedEvent: .newEvent
        default: registryActionID?.menuSymbol ?? .open
        }
    }

    var symbolName: String { menuSymbol.rawValue }

    private var registryActionID: WorkRowActionID? {
        switch self {
        case .open: .open
        case .openGitHub: .openGithub
        case .copyLink: .copyLink
        case .openDocument: .openDocument
        case .openCore: .openCore
        case .openEvent: .openCalendar
        case .openConversation: .open
        case .markRead: .markRead
        case .mute: .mute
        case .archive: .archive
        case .accept: .accept
        case .decline: .decline
        case .editNote: .edit
        case .fileNote: .fileNote
        case .moveNote: .moveWorkspace
        case .deleteNote: .delete
        case .startLead: .startLead
        case .dismissTouch: .dismiss
        case .undoDismissTouch: .undoDismiss
        case .copyEmail: .copyEmail
        case .resolveComment: .resolve
        case .answerDecision: .decide
        case .openDecision, .openQuestion: .open
        case .dismissBooking: .dismiss
        case .undoDismissBooking: .undoDismiss
        case .markSeen: .markSeen
        case .respondToInvitation: .rsvp
        case .addForwardedEvent: .accept
        case .discardForwardedEvent: .decline
        case .complete, .completeTask: .complete
        case .cancel, .cancelTask: .cancel
        case .promote, .promoteTask: .fileGithub
        case .deleteTask: .delete
        case .setIssueState(_, _, .close): .closeIssue
        case .setIssueState(_, _, .closeNotPlanned): .closeNotPlanned
        case .setIssueState(_, _, .reopen): .reopenIssue
        case .assignTask, .assignIssue: .assign
        case .makeResponsible: .makeResponsible
        case .handOff: .handOff
        case .openFollowUp: .open
        case .dismissFollowUp: .dismiss
        }
    }

    /// Drawn red by both native menu renderers from the shared registry rule.
    var isDestructive: Bool {
        registryActionID.map(WorkRowActionRegistry.isDestructive) ?? false
    }

    /// The row leaves because it was turned down, not done — the phone's
    /// haptic says which.
    var leavesByRefusal: Bool {
        switch self {
        case .deleteNote, .deleteTask, .decline, .dismissTouch, .dismissBooking, .cancel, .cancelTask,
             .setIssueState(_, _, .closeNotPlanned), .respondToInvitation(_, .declined, _), .discardForwardedEvent: true
        default: false
        }
    }
}

extension ThreadSummary {
    /// A row on Home's MESSAGES card, in groups. Every client draws this.
    func homeRowActions(client: WorkActionClient) -> [[WorkRowAction]] {
        let ids = WorkRowActionRegistry.groups(
            kind: .conversation, context: WorkConversationMenuContext.home, client: client,
            facts: WorkRowActionFacts(["hasUnread": unread, "isDirect": kind == .dm, "hasCore": subject?.coreURL != nil])
        )
        return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
            switch action {
            case .open: return .openConversation(self)
            case .markRead: return .markRead(self)
            case .mute: return .mute(self)
            case .archive: return .archive(self)
            case .openCore: return subject?.coreURL.map(WorkRowAction.openCore)
            default: return nil
            }
        }
    }
}

extension WorkInboxItem {
    /// The row's menu, in groups. Every surface that lists INBOX draws this.
    var rowActions: [[WorkRowAction]] {
        rowActions(client: .mac)
    }

    func rowActions(client: WorkActionClient) -> [[WorkRowAction]] {
        switch self {
        case .talk(let thread, _, _, _):
            let subject = thread.subject
            let ids = WorkRowActionRegistry.groups(
                kind: .inboxTalk, context: WorkInboxTalkMenuContext.row, client: client,
                facts: WorkRowActionFacts(["hasSubject": subject != nil, "hasUnread": thread.unread, "hasCore": subject?.coreURL != nil])
            )
            return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
                switch action {
                case .openSubject:
                    guard let subject else { return nil }
                    return .open(WorkDestination(subject: subject, pane: .talk), title: String(localized: "Open \(subject.title)"))
                case .markRead: return .markRead(thread)
                case .mute: return .mute(thread)
                case .openCore: return thread.subject?.coreURL.map(WorkRowAction.openCore)
                default: return nil
                }
            }
        case .task(let task, let subject, _, _):
            return task.proposedRowActions(subject: subject, context: .inboxProposed, client: client)
        case .followUp(let item, _, _):
            let ids = WorkRowActionRegistry.groups(kind: .inboxFollowup, context: WorkInboxFollowupMenuContext.row, client: client)
            return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
                switch action {
                case .open: return .openFollowUp(item)
                case .dismiss: return .dismissFollowUp(item)
                default: return nil
                }
            }
        case .card(let card, _, _):
            let ids = WorkRowActionRegistry.groups(
                kind: .inboxCard, context: WorkInboxCardMenuContext.row, client: client,
                facts: WorkRowActionFacts(["isIssue": card.issue != nil])
            )
            return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
                switch action {
                case .open: return .open(card.destination, title: String(localized: "Open"))
                case .openSubject:
                    return .open(WorkDestination(subject: card.subject), title: String(localized: "Open \(card.subject.title)"))
                case .openGithub: return card.issue.flatMap { URL(string: $0.url) }.map(WorkRowAction.openGitHub)
                default: return nil
                }
            }
        case .note(let note, _, _):
            return note.rowActions(client: client)
        case .sales(let touch, _, _):
            let hasEmail = touch.contact.email.map { !$0.isEmpty } ?? false
            let ids = WorkRowActionRegistry.groups(
                kind: .inboxSales, context: WorkInboxSalesMenuContext.row, client: client,
                facts: WorkRowActionFacts(["isDismissed": touch.dismissed, "hasEmail": hasEmail])
            )
            return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
                switch action {
                case .startLead: return .startLead(touch)
                case .dismiss: return .dismissTouch(touch)
                case .undoDismiss: return .undoDismissTouch(touch)
                case .copyEmail: return touch.contact.email.map(WorkRowAction.copyEmail)
                default: return nil
                }
            }
        case .comment(let comment, _, _):
            let subject = comment.subject
            let ids = WorkRowActionRegistry.groups(
                kind: .inboxComment, context: WorkInboxCommentMenuContext.row, client: client,
                facts: WorkRowActionFacts(["hasSubject": subject != nil, "hasCore": subject?.coreURL != nil])
            )
            return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
                switch action {
                case .openDocument: return .openDocument(id: comment.document.id, title: comment.document.title)
                case .openSubject:
                    guard let subject else { return nil }
                    return .open(WorkDestination(subject: subject, pane: .talk), title: String(localized: "Open \(subject.title)"))
                case .resolve: return .resolveComment(comment)
                case .openCore: return comment.subject?.coreURL.map(WorkRowAction.openCore)
                default: return nil
                }
            }
        case .booking(let booking, let key, _):
            let ids = WorkRowActionRegistry.groups(
                kind: .inboxBooking, context: WorkInboxBookingMenuContext.row, client: client,
                facts: WorkRowActionFacts(["hasEvent": booking.eventReference != nil, "hasEmail": !booking.booking.guestEmail.isEmpty])
            )
            return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
                switch action {
                case .openCalendar: return booking.eventReference.map(WorkRowAction.openEvent(reference:))
                case .copyEmail: return .copyEmail(booking.booking.guestEmail)
                case .dismiss: return .dismissBooking(key: key)
                default: return nil
                }
            }
        case .question(let request, _, _):
            return WorkRowActionRegistry.groups(kind: .inboxQuestion, context: WorkInboxQuestionMenuContext.row, client: client).map { group in
                group.compactMap { $0 == .open ? .openQuestion(request) : nil }
            }
        case .decision(let ask, _, _):
            // `decide` is one item per option, the recommendation first-class
            // but in the ask's own order; `open` shows the whole of it.
            let ids = WorkRowActionRegistry.groups(kind: .inboxDecision, context: WorkInboxDecisionMenuContext.row, client: client)
            return ids.map { group in
                group.flatMap { action -> [WorkRowAction] in
                    switch action {
                    case .decide: return ask.options.map { WorkRowAction.answerDecision(ask, option: $0) }
                    case .open: return [.openDecision(ask)]
                    default: return []
                    }
                }
            }.filter { !$0.isEmpty }
        case .invitation(let event, let key, _):
            // `rsvp` is one item per answer, in `CalendarRSVP.answers` order,
            // as `decide` is one per option.
            let ids = WorkRowActionRegistry.groups(kind: .inboxInvitation, context: WorkInboxInvitationMenuContext.row, client: client)
            return flatMapWorkRowActionGroups(ids) { action -> [WorkRowAction] in
                switch action {
                case .rsvp: return CalendarRSVP.answers.map { WorkRowAction.respondToInvitation(event, $0, key: key) }
                case .openCalendar: return [.openEvent(reference: event.eventReference)]
                default: return []
                }
            }
        case .forwarded(let event, let key, _):
            let ids = WorkRowActionRegistry.groups(kind: .inboxForwarded, context: WorkInboxForwardedMenuContext.row, client: client)
            return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
                switch action {
                case .accept: return .addForwardedEvent(event, key: key)
                case .decline: return .discardForwardedEvent(event, key: key)
                default: return nil
                }
            }
        case .interest(let interest, let key, _):
            return submissionActions(email: interest.email, key: key, client: client)
        case .submission(let submission, let key, _):
            // The same menu as an interest row: write to them, or dismiss.
            return submissionActions(email: submission.email, key: key, client: client)
        case .guest:
            // The row opens its conversation; the web gives it no menu either.
            return []
        case .commercial(let item, let key, _):
            // Open the subject on its Overview, or dismiss. A dismissed row
            // leaves the list, so the row is never dismissed while drawn.
            let ids = WorkRowActionRegistry.groups(
                kind: .inboxCommercial, context: WorkInboxCommercialMenuContext.row, client: client,
                facts: WorkRowActionFacts(["isDismissed": false])
            )
            return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
                switch action {
                case .openSubject:
                    return .open(WorkDestination(subject: item.crmSubject), title: String(localized: "Open \(item.subject.title)"))
                case .dismiss: return .dismissBooking(key: key)
                case .undoDismiss: return .undoDismissBooking(key: key)
                default: return nil
                }
            }
        }
    }

    /// A form's answers, or an interest request: write to them, or dismiss.
    private func submissionActions(email: String, key: String, client: WorkActionClient) -> [[WorkRowAction]] {
        let ids = WorkRowActionRegistry.groups(
            kind: .inboxInterest, context: WorkInboxInterestMenuContext.row, client: client,
            facts: WorkRowActionFacts(["hasEmail": !email.isEmpty])
        )
        return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
            switch action {
            case .copyEmail: return .copyEmail(email)
            case .dismiss: return .dismissBooking(key: key)
            default: return nil
            }
        }
    }
}

private func mapWorkRowActionGroups(
    _ groups: [[WorkRowActionID]],
    action: (WorkRowActionID) -> WorkRowAction?
) -> [[WorkRowAction]] {
    groups.map { $0.compactMap(action) }.filter { !$0.isEmpty }
}

/// The same, for an id that stands for several items (`assign`: one per teammate).
private func flatMapWorkRowActionGroups(
    _ groups: [[WorkRowActionID]],
    actions: (WorkRowActionID) -> [WorkRowAction]
) -> [[WorkRowAction]] {
    groups.map { $0.flatMap(actions) }.filter { !$0.isEmpty }
}

/// Assign to's people in the order the submenu lists them: you first, named
/// "Me" (mz, 2026-10-01), then everyone else by name. `me` is the signed-in
/// address; a write reads only the member's id and login, never the label.
private func assignableTeam(_ team: [CrmTeamMember], needsGithub: Bool, me: String?) -> [CrmTeamMember] {
    let mine = me?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
    let isMe = { (member: CrmTeamMember) in
        !mine.isEmpty && (member.email ?? "").trimmingCharacters(in: .whitespaces).lowercased() == mine
    }
    // People by name, then agents by name.
    let people = team
        .filter { !needsGithub || !($0.githubLogin ?? "").isEmpty }
        .sorted {
            ($0.kind == .agent ? 1 : 0, $0.name.lowercased()) < ($1.kind == .agent ? 1 : 0, $1.name.lowercased())
        }
    let others = people.filter { !isMe($0) }
    guard let you = people.first(where: isMe) else { return others }
    let labelled = CrmTeamMember(id: you.id, name: String(localized: "Me"), email: you.email, githubLogin: you.githubLogin, kind: you.kind)
    return [labelled] + others
}

extension CrmMyTask {
    /// The menu on one of your own tasks — Home's due rows and the phone's
    /// Mine. Done first, because ticking work off where it is read is the
    /// point of the list.
    var rowActions: [[WorkRowAction]] {
        rowActions(context: .mine)
    }

    func rowActions(
        context: WorkTaskMenuContext,
        seenKey: String? = nil,
        client: WorkActionClient = .mac,
        team: [CrmTeamMember] = [],
        me: String? = nil,
        agents: [Peer] = []
    ) -> [[WorkRowAction]] {
        let subject = self.subject
        let people = assignableTeam(team, needsGithub: false, me: me)
        let ids = WorkRowActionRegistry.groups(
            kind: .task, context: context, client: client,
            facts: WorkRowActionFacts([
                "hasSubject": subject != nil,
                "hasCore": subject?.coreURL != nil,
                "canFileOnGitHub": projectID != nil && githubIssueNumber == nil,
                "canAssign": !people.isEmpty,
                "canHandOff": !agents.isEmpty,
                "canDelete": true,
            ])
        )
        let target = HandOffTarget(
            title: title, issueNumber: nil, ref: ThreadMessageRef(kind: "task", id: id),
            subjectKind: subject?.kind, subjectID: subject?.id
        )
        func single(_ action: WorkRowActionID) -> WorkRowAction? {
            switch action {
            case .complete: return .complete(self)
            case .cancel: return .cancel(self)
            case .fileGithub: return .promote(self)
            case .openSubject:
                guard let subject else { return nil }
                return .open(WorkDestination(subject: subject, pane: .tasks), title: String(localized: "Open \(subject.title)"))
            case .openMine: return .open(.mine(taskID: id), title: String(localized: "Open in Mine"))
            case .openCore: return subject?.coreURL.map(WorkRowAction.openCore)
            case .markSeen: return seenKey.map { .markSeen(key: $0) }
            case .delete: return .deleteTask(id: id, title: title)
            default: return nil
            }
        }

        return flatMapWorkRowActionGroups(ids) { action -> [WorkRowAction] in
            if action == .assign { return people.map { .assignTask(self, $0) } }
            if action == .handOff { return agents.map { .handOff(target, $0) } }
            return single(action).map { [$0] } ?? []
        }
    }
}

extension CrmTask {
    /// The same registry is used by the subject's Tasks pane. A proposed task
    /// has answers; an open task has the one quick resolution and, when
    /// eligible, the GitHub hand-off.
    /// `subject` is nil where only the subject's title is known (the live
    /// meeting's panel): the doors that need the record drop out.
    func proposedRowActions(
        subject: CrmSubject?,
        context: WorkTaskMenuContext = .subjectProposed,
        client: WorkActionClient = .mac
    ) -> [[WorkRowAction]] {
        let ids = WorkRowActionRegistry.groups(
            kind: .task, context: context, client: client,
            facts: WorkRowActionFacts(["hasSubject": subject != nil, "hasCore": subject?.coreURL != nil, "canFileOnGitHub": false])
        )
        return mapWorkRowActionGroups(ids) { action -> WorkRowAction? in
            switch action {
            case .accept: return .accept(self)
            case .decline: return .decline(self)
            case .openSubject:
                guard let subject else { return nil }
                return .open(WorkDestination(subject: subject, pane: .tasks), title: String(localized: "Open \(subject.title)"))
            case .openCore: return subject?.coreURL.map(WorkRowAction.openCore)
            default: return nil
            }
        }
    }

    /// `agents` are who it can be handed to; none, and Hand off drops out.
    func rowActions(subject: CrmSubject?, agents: [Peer] = [], client: WorkActionClient = .mac) -> [[WorkRowAction]] {
        let ids = WorkRowActionRegistry.groups(
            kind: .task, context: WorkTaskMenuContext.subjectOpen, client: client,
            facts: WorkRowActionFacts([
                "hasSubject": subject != nil,
                "hasCore": subject?.coreURL != nil,
                "canFileOnGitHub": projectID != nil && githubIssueNumber == nil,
                "canHandOff": !agents.isEmpty,
                "canDelete": true,
            ])
        )
        let target = HandOffTarget(
            title: title, issueNumber: nil, ref: ThreadMessageRef(kind: "task", id: id),
            subjectKind: subject?.kind, subjectID: subject?.id
        )
        return flatMapWorkRowActionGroups(ids) { action -> [WorkRowAction] in
            switch action {
            case .complete: [.completeTask(self)]
            case .cancel: [.cancelTask(self)]
            case .fileGithub: [.promoteTask(self)]
            case .handOff: agents.map { .handOff(target, $0) }
            case .openCore: subject?.coreURL.map { [.openCore($0)] } ?? []
            case .delete: [.deleteTask(id: id, title: title)]
            default: []
            }
        }
    }
}

extension CrmIssue {
    /// Close or reopen, from any issue row's menu. An open issue can be
    /// finished or decided against; a closed one can only come back.
    func rowActions(
        projectID: String?,
        context: WorkIssueMenuContext = .row,
        client: WorkActionClient = .mac,
        canMarkSeen: Bool = false,
        team: [CrmTeamMember] = [],
        me: String? = nil,
        agents: [Peer] = []
    ) -> [[WorkRowAction]] {
        let url = URL(string: self.url)
        let people = assignableTeam(team, needsGithub: true, me: me)
        let ids = WorkRowActionRegistry.groups(
            kind: .issue, context: context, client: client,
            facts: WorkRowActionFacts([
                "isOpen": isOpen, "hasRepo": url != nil, "canMarkSeen": canMarkSeen,
                "canAssign": !people.isEmpty, "canHandOff": !agents.isEmpty,
            ])
        )
        // An issue is a project's: the hand-off is said in that project's channel.
        let target = HandOffTarget(
            title: title, issueNumber: number, ref: ThreadMessageRef(kind: "issue", id: id),
            subjectKind: projectID == nil ? nil : "project", subjectID: projectID
        )
        func single(_ action: WorkRowActionID) -> WorkRowAction? {
            switch action {
            case .open:
                guard let destination = WorkDestination.issue(reference: id) else { return nil }
                return .open(destination, title: String(localized: "Open"))
            case .openGithub: return url.map(WorkRowAction.openGitHub)
            case .copyLink: return url.map { WorkRowAction.copyLink($0.absoluteString) }
            case .closeIssue: return .setIssueState(self, projectID: projectID, .close)
            case .closeNotPlanned: return .setIssueState(self, projectID: projectID, .closeNotPlanned)
            case .reopenIssue: return .setIssueState(self, projectID: projectID, .reopen)
            default: return nil
            }
        }

        return flatMapWorkRowActionGroups(ids) { action -> [WorkRowAction] in
            if action == .assign { return people.map { .assignIssue(self, $0) } }
            if action == .handOff { return agents.map { .handOff(target, $0) } }
            return single(action).map { [$0] } ?? []
        }
    }

    func stateActions(
        projectID: String?,
        context: WorkIssueMenuContext = .row,
        client: WorkActionClient = .mac,
        canMarkSeen: Bool = false
    ) -> [WorkRowAction] {
        rowActions(projectID: projectID, context: context, client: client, canMarkSeen: canMarkSeen)
            .flatMap { $0 }
            .filter { if case .setIssueState = $0 { true } else { false } }
    }
}

/// Move to ▸ another workspace: the rule both native apps share. The
/// device holds one session per workspace (`WorkspaceScope`), so a move is a
/// create on the other workspace's API with its own token, then a delete
/// here. The server has no move: each workspace is its own database.
@MainActor
enum QuickNoteMove {
    /// The other workspaces on this device that `isSignedIn` holds a session
    /// for, in the switcher's order. Empty with one workspace, so the menu
    /// draws no Move to.
    static func targets(isSignedIn: (StarlingsWorkspace) -> Bool) -> [StarlingsWorkspace] {
        let store = StarlingsWorkspaceStore.shared
        return store.known.filter { $0.webOrigin != store.current.webOrigin && isSignedIn($0) }
    }

    /// The note as the other workspace's create. Same id, so a retry after a
    /// lost answer finds the note it already made; written when it was
    /// written. The meeting link stays behind: that meeting is not there.
    static func create(_ note: QuickNote) -> QuickNoteCreate {
        let written = ISODate.parse(note.createdAt).map { Int(($0.timeIntervalSince1970 * 1000).rounded()) }
        return QuickNoteCreate(body: note.body, source: note.source, id: note.id, capturedAt: written)
    }

    /// The red line a failed move shows.
    static func failure(_ error: any Error, to workspace: StarlingsWorkspace) -> String {
        if let failure = error as? StarlingsError, failure.isSessionRefusal || failure.code.hasPrefix("auth.") {
            return String(localized: "Sign in to \(workspace.name) again to move notes there.")
        }
        let message = (error as? StarlingsError)?.message ?? ""
        return message.isEmpty ? String(localized: "Couldn’t move the note to \(workspace.name).") : message
    }
}

extension QuickNote {
    /// The note's menu, in groups, wherever a note row is listed: Home's
    /// QUICK NOTES card and INBOX. `editable` adds Edit, for the surfaces
    /// that open the note itself (Home); INBOX's tap files it instead. File
    /// stays available after the first filing, like the note editors' action.
    ///
    /// `moveTargets` are the other workspaces this device is signed in to
    /// (`QuickNoteMove.targets`). Move to ▸ is drawn only when there is one,
    /// and only for an open note: a filed note points at something the
    /// other workspace does not have.
    func rowActions(
        editable: Bool = false,
        client: WorkActionClient = .mac,
        moveTargets: [StarlingsWorkspace] = []
    ) -> [[WorkRowAction]] {
        let context: WorkQuickNoteMenuContext = editable ? .home : .inbox
        let targets = isOpen ? moveTargets : []
        let ids = WorkRowActionRegistry.groups(
            kind: .quickNote, context: context, client: client,
            facts: WorkRowActionFacts(["isEditable": editable, "hasOtherWorkspace": !targets.isEmpty])
        )
        return flatMapWorkRowActionGroups(ids) { action -> [WorkRowAction] in
            switch action {
            case .edit: return [.editNote(self)]
            case .fileNote: return [.fileNote(self)]
            case .moveWorkspace: return targets.map { .moveNote(self, to: $0) }
            case .delete: return [.deleteNote(self)]
            default: return []
            }
        }
    }
}

/// What a task delete says before and after, the same on the Mac
/// and the phone: one question, a destructive Delete, and the fallback line
/// when the Worker gives no message of its own.
enum TaskDeleteCopy {
    static func title(_ title: String) -> String { String(localized: "Delete “\(title)”?") }
    static var message: String { String(localized: "This can’t be undone.") }
    static var confirm: String { String(localized: "Delete") }
    static var cancel: String { String(localized: "Cancel") }
    static var failure: String { String(localized: "Couldn’t delete that task.") }
}
