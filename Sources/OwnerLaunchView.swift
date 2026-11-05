import AppKit
import StarlingsContracts

enum LaunchStatusTone {
    case neutral
    case danger
}

/// Launch surface — full-bleed owner idle home: clock, upcoming, and the room
/// launcher with its waiting queue. See docs/SURFACES.md.
@MainActor
final class OwnerLaunchView: NSView {
    var onStart: (() -> Void)?
    private var onDeclineAll: (() -> Void)?
    var onUseUpcoming: ((CalendarEventSummary) -> Void)?
    /// A click on an upcoming row: Calendar opens on that event. Joining is
    /// the hero's button and every row's context menu (`onUseUpcoming`).
    var onOpenUpcoming: ((CalendarEventSummary) -> Void)?
    /// A published CMS event row opens its public or registration page.
    var onOpenPublicEvent: ((PublicEventsCalendar.Event) -> Void)?
    var onToggleUpcomingDemoted: ((CalendarEventSummary) -> Void)?
    /// What an invitation on the INBOX card overlaps, read from the calendar
    /// this screen already holds.
    var conflictsForInvitation: ((CalendarEventSummary) -> [CalendarConflict])?
    var onWork: (() -> Void)?
    var onTeam: (() -> Void)?
    /// A Messages row opens its own conversation, not the Team lounge.
    /// A thread id, and the title to show for a thread no conversation list holds.
    var onOpenConversation: ((String, String?) -> Void)?
    /// No calendar is connected yet: open Settings on the Calendar page.
    var onConnectCalendar: (() -> Void)?
    /// A row in the WORK block named a subject and a pane.
    var onOpenWork: ((WorkDestination) -> Void)?
    /// A row in the RECENT block: a search row, opened through the same
    /// door the ⌘K palette uses (`searchOpen`).
    var onOpenSearchRow: ((SearchRow) -> Void)?
    /// Whose recents to draw: the signed-in owner's address, asked for at
    /// render time so a sign-in after launch is honoured.
    var recentsOwner: (() -> String?)?
    /// The gear over the strip: Settings on the Home page.
    var onOpenHomeSettings: (() -> Void)?
    /// A WORK row's menu choice — the same list the Work window offers
    /// (`WorkRowAction`); the window controller carries it out.
    var onWorkRowAction: ((WorkRowAction) -> Void)?
    /// Home capture stays almost empty; Work owns the later filing decision.
    var onCreateQuickNote: ((String) -> Void)?
    var onUpdateQuickNote: ((QuickNote, String) -> Void)?
    var onTriageQuickNote: ((QuickNote) -> Void)?
    var onDeleteQuickNote: ((QuickNote) -> Void)?
    var onMoveQuickNote: ((QuickNote, StarlingsWorkspace) -> Void)?
    var onCloseRoom: (() -> Void)?
    /// A setup step was clicked (docs/ONBOARDING.md §The setup checklist).
    var onOpenSetupStep: ((SetupStep) -> Void)?
    /// An admin turned the checklist off for everyone.
    var onTurnOffSetup: (() -> Void)?
    /// Skip on a setup step: clears it from this owner's card on every client.
    var onSkipSetupStep: ((SetupStep) -> Void)?
    private let clockLabel = NSTextField(labelWithString: "")
    private let versionLabel = NSTextField(labelWithString: StarlingsVersionLine.text)
    private let signedInEmailLabel = NSTextField(labelWithString: "")
    private let dateLabel = NSTextField(labelWithString: "")
    private let nextTitleLabel = NSTextField(labelWithString: NSLocalizedString(UpcomingConfiguration.current.sectionTitle, comment: "Upcoming section title from upcoming-config.json"))
    private let upcomingStack = NSStackView()
    private let publicEventsTitleLabel = NSTextField(labelWithString: String(localized: "EVENTS"))
    private let publicEventsStack = NSStackView()
    private let upcomingEmptyLabel = StarlingsTypography.wrappingLabel(String(localized: "No calendar connected yet."))
    private let upcomingTodayButton = NSButton(title: String(localized: "See rest of day"), target: nil, action: nil)
    /// A door rather than a sentence: "in Settings" told you where to go and
    /// then left you to find it.
    private let connectCalendarButton = NSButton(title: String(localized: "Connect Google Calendar"), target: nil, action: nil)
    /// The module's title, the same YOUR ROOM as iPhone and web. Guests
    /// waiting to enter list under the room's name, inside this card.
    private let roomTitleLabel = NSTextField(labelWithString: String(localized: "YOUR ROOM"))
    /// The room's short name and its link, as on iPhone and web.
    private let roomNameLabel = NSTextField(labelWithString: "")
    private let roomURLLabel = NSTextField(labelWithString: "")
    private let roomIdentityStack = NSStackView()
    private let waitingEmptyLabel = StarlingsTypography.wrappingLabel("")
    private let waitingStack = NSStackView()
    /// Today's work: what is late, what is due, and which subjects have new
    /// talk. Hidden outright when there is nothing — no furniture.
    private let workTitleLabel = NSTextField(labelWithString: String(localized: "MINE"))
    private let workCountLabel = NSTextField(labelWithString: "")
    private let workStack = NSStackView()
    private var workPanel: NSView?
    /// The read-only commercial projection from Core. It folds away when the
    /// bridge is unavailable; Home never invents a zero for a failed read.
    private let commercialTitleLabel = NSTextField(labelWithString: String(localized: "COMMERCIAL"))
    private let commercialCountLabel = NSTextField(labelWithString: String(localized: "12 months"))
    private let commercialSubtitleLabel = NSTextField(labelWithString: String(localized: "Offers & sales"))
    private let commercialStatsStack = NSStackView()
    private let commercialOffersValue = NSTextField(labelWithString: "")
    private let commercialSalesValue = NSTextField(labelWithString: "")
    private let commercialPipelineValue = NSTextField(labelWithString: "")
    private let commercialLicensesValue = NSTextField(labelWithString: "")
    private let commercialChart = LaunchCommercialChartView()
    private let commercialRangeStart = NSTextField(labelWithString: "")
    private let commercialRangeEnd = NSTextField(labelWithString: "")
    private let commercialRangeStack = NSStackView()
    private let commercialMoreButton = NSButton(title: String(localized: "View Sales in Work"), target: nil, action: nil)
    private let commercialStack = NSStackView()
    private var commercialPanel: NSView?
    private var commercialSummary: CommercialSummary?
    private let quickNotesView = MacQuickNotesPanel()
    /// The setup checklist: above the modules, not one of them, until its
    /// steps are done, hidden or turned off (`SetupChecklist.card`).
    private let setupTitleLabel = NSTextField(labelWithString: String(localized: "GET STARTED"))
    private let setupStack = NSStackView()
    private let setupNotice = StarlingsNoticeView(wrapping: true)
    private let setupHideButton = NSButton(title: String(localized: "Hide"), target: nil, action: nil)
    private let setupTurnOffButton = NSButton(title: String(localized: "Turn off for everyone"), target: nil, action: nil)
    private var setupPanel: NSView?
    private var setupCard: SetupChecklist.Card = .none
    private var setupCanTurnOff = false
    private var setupError: String?
    private var mine: HomeMine = .empty
    /// INBOX beside the unread talk: proposals, notes, touches, comments.
    /// Keep the source snapshot for change detection; the card draws its
    /// projection below ("inbox everywhere").
    private var inboxBesideTalk: [WorkInboxItem] = []
    /// The INBOX card's items beside the unread conversations: INBOX minus
    /// Quick Notes and minus owned work. The full INBOX remains in Work.
    private var inboxForCard: [WorkInboxItem] = []
    /// What is new (module `messages`): every unread conversation and the
    /// INBOX items, each row opening the door that owns it. Same card as iOS
    /// Home and the web.
    private let messagesTitleLabel = NSTextField(labelWithString: String(localized: "INBOX"))
    private let messagesCountLabel = NSTextField(labelWithString: "")
    private let messagesStack = NSStackView()
    /// The jump list: starred rows first, then the recent things this Mac
    /// opened. A row that is in both sources is drawn once.
    private let recentTitleLabel = NSTextField(labelWithString: String(localized: "QUICK ACCESS"))
    private let recentScrollView = NSScrollView()
    private let recentStack = NSStackView()
    private var recentRows: [SearchRow] = []
    private var agentAvatars: [String: AgentAvatarIdentityWire] = [:]
    private var recentsObserver: (any NSObjectProtocol)?
    /// Cross-device rows from the Worker, placed before device recents.
    private var starredRows: [SearchRow] = []
    private var starredRowsAnswered = false
    /// One quiet gear on the strip's top right, into Settings → Home.
    private let homeSettingsButton = NSButton(title: "", target: nil, action: nil)
    private var messagesPanel: NSView?
    private var unreadThreads: [ThreadSummary] = []
    /// One panel per Home module, so the strip can be re-ordered from the
    /// shared layout (`HomeLayout`, fixtures/home-layout.json) rather than
    /// from the order `build()` happened to add them in.
    private var modulePanels: [HomeModuleID: NSView] = [:]
    /// Which modules have had a first answer — a snapshot or a live read.
    /// Until then a module that hides when empty draws its reserved placeholder
    /// rows instead of nothing, so Home does not assemble itself one block at
    /// a time on a cold start (docs/CACHING.md).
    private var moduleAnswered: Set<HomeModuleID> = []
    /// A module with nothing to say hides itself (messages, work); the
    /// layout hides the rest. `applyLayout` reads both.
    private var moduleHasContent: [HomeModuleID: Bool] = [:]
    private var moduleLayout: [HomeModuleSetting] = HomeLayoutCache.load()
    /// Home stays structurally stable until the first answer from each remote
    /// module has landed. The individual renderers keep their answers in
    /// memory, but only the final projection is allowed to replace the rows.
    private var homeInitialLoadSettled = false
    /// Every snapshot on disk has been painted (`finishSnapshotPass`).
    private var snapshotPassFinished = false
    private var homeUpcomingTimedOut = false
    private var isCommittingInitialHome = false
    private var pendingQuickNotes: [QuickNote] = []
    /// The notes above still on this Mac, not on the Worker.
    private var unsentQuickNotes: [QuickNote.ID: QuickNotePending] = [:]
    private var pendingRoomMapping: (mapped: Bool, email: String?)?
    /// The module columns side by side, with Quick Access below them. One column until the window has
    /// room for two at `minColumnWidth`; `layout()` flips `twoColumns`.
    /// Rules: a column is `columnWidth` when the window allows, narrower
    /// when two do not fit at that width, never wider. Content clips or
    /// wraps to the column; it never sets the width.
    private let strip = NSStackView()
    private let columnsRow = NSStackView()
    private let leftColumn = NSStackView()
    private let rightColumn = NSStackView()
    /// Active with two columns: the right column matches the left.
    private var rightColumnWidth: NSLayoutConstraint?
    /// Active with one column: the column row ends where the left column does.
    private var columnsRowTrailingToLeft: NSLayoutConstraint?
    private static let columnWidth: CGFloat = 420
    /// The narrowest a column goes before the second one folds. Two at
    /// this width is what a phone in landscape offers, and the phone and
    /// the browser flip on the same number.
    private static let minColumnWidth: CGFloat = 340
    private static let columnGap: CGFloat = 16
    private static let sideMargin: CGFloat = 28
    /// Document width at which two columns fit at `minColumnWidth`; the
    /// columns then grow to `columnWidth` as the window allows.
    private static let twoColumnMinWidth = minColumnWidth * 2 + columnGap + sideMargin * 2
    private var twoColumns = false
    /// A data answer may hide a panel, but it must not move every panel after
    /// it. Column ownership is recomputed when the user's layout or the
    /// one/two-column mode changes, then chosen by measured panel height, and
    /// again only when the columns are `HomeLayout.columnsLopsided`.
    private var columnAssignment: [HomeModuleID: Bool]?
    private var isBalancingColumns = false
    private var columnCheckScheduled = false
    private var frameObserver: (any NSObjectProtocol)?
    private var columnFrameObservers: [any NSObjectProtocol] = []
    /// Never shown. It holds the canonical invite for the header's copy
    /// button; `roomURLLabel` draws the link.
    private let roomLinkRow = CopyableURLRow()
    private lazy var copyRoomLinkButton = StarlingsPanelHeader.actionButton(
        symbolName: Self.copySymbol, accessibilityLabel: String(localized: "Copy room link"), target: self, action: #selector(copyRoomLinkTapped)
    )
    private let statusLabel = StarlingsNoticeView(wrapping: true)
    private let statusPanel = NSView()
    /// Stands in for Start when this account has no room mapped — a state with
    /// a next step, drawn where the button would be so nothing looks broken.
    private let noRoomLabel = StarlingsTypography.wrappingLabel("")
    /// Same quiet × as a waiting-room decline/remove — one style for every
    /// "make this go away without a second confirm" affordance.
    private let closeRoomButton = NSButton(title: "", target: nil, action: nil)
    private static let closeRoomSymbolConfig = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
    private let startButton = NSButton(title: String(localized: "Start room"), target: nil, action: nil)
    private var startTitle = String(localized: "Start room")
    private var startYieldsAccent = false

    private var copyFlashWorkItem: DispatchWorkItem?

    private var clockTimer: Timer?
    /// Which row gets the full treatment, decided by `MeetingFocus` rather than
    /// here — `nil` is a closed day, and a closed day has no hero at all.
    private var upcomingFocus: CalendarEventSummary?
    /// The compact rows after the hero, already selected by the shared Upcoming
    /// plan. AppKit only draws them; it does not decide whether tomorrow belongs.
    private var upcomingFollowing: [CalendarEventSummary] = []
    private var publicEvents: [PublicEventsCalendar.Event] = []
    private var upcomingCountdownIDs: Set<String> = []
    /// Nil until the Worker has answered once. The card says nothing about
    /// a calendar it has not asked about yet: "No calendar connected" over a
    /// connected one, for the half second before the answer, read as a bug.
    private var upcomingCalendarConnected: Bool?
    private var upcomingEmptyMessage: String?
    private var upcomingRemainingToday: [CalendarEventSummary] = []
    private var isShowingRemainingToday = false
    private let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()
    private let softEdge = StarlingsSoftEdgeView()
    private var softEdgeHeight: NSLayoutConstraint!
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        // No canvas background — the brand grid sits behind this view, and
        // the section panels (UPCOMING, WORK, WAITING) and the actions block
        // each carry their own `elevated` fill so the field shows through.
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setVisible(_ visible: Bool) {
        isHidden = !visible
        if visible {
            startClock()
            tickClock()
            renderRecent()
        } else {
            stopClock()
        }
    }

    func setRoomPath(_ path: String, webOrigin: String) {
        roomLinkRow.setRoomPath(path, webOrigin: webOrigin)
        renderRoomIdentity()
    }

    func setInviteURL(_ absoluteURL: String) {
        roomLinkRow.setInviteURL(absoluteURL)
        renderRoomIdentity()
    }

    private func renderRoomIdentity() {
        copyRoomLinkButton.toolTip = copyTooltip()
        let link = roomLinkRow.clipboardString
        roomNameLabel.stringValue = MeetingInvite.roomSlug(fromJoinURL: link) ?? ""
        roomURLLabel.stringValue = link
        roomNameLabel.isHidden = roomNameLabel.stringValue.isEmpty
        roomURLLabel.isHidden = link.isEmpty
    }

    func setSignedInEmail(_ email: String?) {
        signedInEmailLabel.stringValue = email ?? ""
        signedInEmailLabel.isHidden = email == nil || email?.isEmpty == true
    }

    func setUpcoming(
        focus: CalendarEventSummary?,
        following: [CalendarEventSummary],
        remainingToday: [CalendarEventSummary] = [],
        countdownIDs: Set<String> = [],
        calendarConnected: Bool?,
        emptyMessage: String? = nil,
        heroLabel: String = NSLocalizedString(UpcomingConfiguration.current.sectionTitle, comment: "Upcoming section title from upcoming-config.json")
    ) {
        nextTitleLabel.stringValue = heroLabel
        upcomingFocus = focus
        upcomingFollowing = following
        upcomingRemainingToday = remainingToday
        upcomingCountdownIDs = countdownIDs
        upcomingCalendarConnected = calendarConnected
        upcomingEmptyMessage = emptyMessage
        if calendarConnected != nil { homeUpcomingTimedOut = false }
        if remainingToday.isEmpty { isShowingRemainingToday = false }
        renderUpcomingList()
        refreshStartEmphasis()
    }

    /// Published CMS events are a separate Home signal from the owner's
    /// calendar. The feed is company-wide, so it needs no calendar connection
    /// or owner-specific filtering.
    func setPublicEvents(_ events: [PublicEventsCalendar.Event]) {
        publicEvents = events
        renderPublicEvents()
    }

    private func renderPublicEvents() {
        setModuleHasContent(.events, !publicEvents.isEmpty)
        guard homeInitialLoadSettled else {
            showPlaceholders(in: publicEventsStack, module: .events)
            maybeSettleInitialHome()
            return
        }
        publicEventsStack.arrangedSubviews.forEach {
            publicEventsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for event in publicEvents.prefix(HomeLayout.rows(for: .events)) {
            let row = LaunchWorkRow(
                title: event.title,
                detail: publicEventDetail(event),
                trailing: "",
                isLate: false,
                symbolName: "megaphone"
            )
            if !event.url.isEmpty {
                row.onOpen = { [weak self] in self?.onOpenPublicEvent?(event) }
            }
            publicEventsStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: publicEventsStack.widthAnchor).isActive = true
        }
        if publicEvents.count > 3 {
            let more = NSTextField(labelWithString: String(localized: "and \(publicEvents.count - 3) more"))
            more.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            more.textColor = StarlingsColors.secondaryText
            publicEventsStack.addArrangedSubview(more)
        }
    }

    private func publicEventDetail(_ event: PublicEventsCalendar.Event) -> String {
        let when = event.startDate.map { event.isAllDay ? StarlingsDateFormatting.date($0) : StarlingsDateFormatting.dayTime($0) }
        let location = event.location.trimmingCharacters(in: .whitespacesAndNewlines)
        return [when, location.isEmpty ? nil : location].compactMap { $0 }.joined(separator: " · ")
    }

    private func renderUpcomingList() {
        guard homeInitialLoadSettled else {
            showPlaceholders(in: upcomingStack, rows: 4)
            maybeSettleInitialHome()
            return
        }
        upcomingStack.arrangedSubviews.forEach {
            upcomingStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        if upcomingFocus == nil, upcomingFollowing.isEmpty {
            // Keep the connection action beside the explanation whenever no
            // calendar is available. The launch surface is the place where
            // this state is discovered, so it should also be the place where
            // the owner can move on from it.
            let needsCalendar = upcomingCalendarConnected == false
            switch upcomingCalendarConnected {
            case nil:
                // A timeout is not a calendar verdict. Leave a quiet shell
                // rather than keeping an indefinite loading promise alive.
                if homeUpcomingTimedOut {
                    upcomingEmptyLabel.stringValue = ""
                    upcomingStack.addArrangedSubview(upcomingEmptyLabel)
                    upcomingEmptyLabel.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
                    renderUpcomingFooter()
                    return
                }
                showPlaceholders(in: upcomingStack, rows: 4)
                renderUpcomingFooter()
                return
            case true?:
                upcomingEmptyLabel.stringValue = upcomingEmptyMessage ?? String(localized: "Nothing left today.")
            case false?:
                upcomingEmptyLabel.stringValue = upcomingEmptyMessage ?? String(localized: "No calendar connected yet.")
            }
            // The gate is the button alone: no sentence before it.
            if needsCalendar && StarlingsWorkspace.active.calendarConnectable {
                upcomingStack.addArrangedSubview(connectCalendarButton)
            } else {
                upcomingStack.addArrangedSubview(upcomingEmptyLabel)
                upcomingEmptyLabel.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
            }
            renderUpcomingFooter()
            return
        }

        // A closed day still has an answer. The same shared policy that selected
        // the following rows also decides whether tomorrow is allowed here.
        if upcomingFocus == nil {
            upcomingEmptyLabel.stringValue = upcomingEmptyMessage ?? String(localized: "Nothing left today.")
            upcomingStack.addArrangedSubview(upcomingEmptyLabel)
            upcomingEmptyLabel.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
        }

        if let focus = upcomingFocus {
            let row = LaunchUpcomingRow(event: focus)
            row.onUse = { [weak self] selected in
                self?.onUseUpcoming?(selected)
            }
            row.onOpen = { [weak self] selected in
                self?.onOpenUpcoming?(selected)
            }
            row.onToggleDemoted = { [weak self] selected in self?.onToggleUpcomingDemoted?(selected) }
            upcomingStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
        }

        for event in upcomingFollowing {
            let row = UpcomingCompactRow(
                event: event,
                showsTimeLeft: upcomingCountdownIDs.contains(event.id),
                opensEvent: true
            )
            row.onUse = { [weak self] selected in
                self?.onUseUpcoming?(selected)
            }
            row.onOpen = { [weak self] selected in
                self?.onOpenUpcoming?(selected)
            }
            row.onToggleDemoted = { [weak self] selected in self?.onToggleUpcomingDemoted?(selected) }
            upcomingStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
        }
        renderUpcomingFooter()
    }

    private func renderUpcomingFooter() {
        guard upcomingCalendarConnected == true,
              !upcomingRemainingToday.isEmpty
        else { return }

        let footer = NSStackView()
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 12

        upcomingTodayButton.title = isShowingRemainingToday ? String(localized: "Hide rest of day") : String(localized: "See rest of day")
        footer.addArrangedSubview(upcomingTodayButton)
        upcomingStack.addArrangedSubview(footer)
        footer.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true

        guard isShowingRemainingToday else { return }
        for event in upcomingRemainingToday {
            let row = UpcomingCompactRow(event: event, opensEvent: true)
            row.onUse = { [weak self] selected in
                self?.onUseUpcoming?(selected)
            }
            row.onOpen = { [weak self] selected in
                self?.onOpenUpcoming?(selected)
            }
            row.onToggleDemoted = { [weak self] selected in self?.onToggleUpcomingDemoted?(selected) }
            upcomingStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
        }
    }

    func setWaitingEmptyMessage(_ message: String) {
        // The section still has to say something once the link row moved into
        // the header, so an empty message falls back to a short placeholder.
        // Nothing to say when nobody is waiting: the header already carries
        // the copy-link button, and "Empty" only named the absence.
        waitingEmptyLabel.stringValue = message
    }

    func setStartTitle(_ title: String) {
        guard title != startTitle else { return }
        startTitle = title
        applyStartChrome()
    }

    /// One accent per screen. While the hero's Join is on screen, Start is
    /// the second thing on it and drops to neutral; the moment the window
    /// closes it takes the accent back. Re-applied only on a change: the
    /// filled style installs hover tracking, and the clock ticks every second.
    private func refreshStartEmphasis() {
        let heroHoldsAccent = upcomingFocus.map { $0.isVideoMeeting && MeetingFocus.canJoin($0) } ?? false
        guard heroHoldsAccent != startYieldsAccent else { return }
        startYieldsAccent = heroHoldsAccent
        applyStartChrome()
    }

    private func applyStartChrome() {
        // Same video mark as web Join / Ask to join (SF Symbol ↔ SVG).
        startButton.applyMeetFilledStyle(startYieldsAccent ? .neutral : .accent, title: startTitle, symbolName: "video.fill")
    }

    /// Outcome above Start: failed attempt, or an open meeting left after a
    /// crash/quit. Nil hides the row. `offersClose` adds the way out for the
    /// second case — Start reclaims the stale room, this walks away from it.
    func setStatus(_ message: String?, tone: LaunchStatusTone = .neutral, offersClose: Bool = false, detail: String? = nil) {
        closeRoomButton.isHidden = !offersClose
        guard let message, !message.isEmpty else {
            statusPanel.isHidden = true
            statusLabel.clear()
            return
        }
        statusPanel.isHidden = false
        statusLabel.setText(message, tone: tone == .danger ? .danger : .neutral, detail: detail)
    }

    /// Somebody wrote to you while this window sat idle.
    ///
    /// Work and Team own their conversation readers. Home shows what is waiting
    /// and routes each row to the destination that owns it.
    func setUnreadMessages(_ threads: [ThreadSummary]) {
        let first = !moduleAnswered.contains(.messages)
        guard first || threads != unreadThreads else { return }
        unreadThreads = threads
        renderInbox()
    }

    /// The setup checklist's answer (`GET /api/setup`), or the error that
    /// stopped it. What draws is `SetupChecklist.card`, as on the phone.
    func setSetup(_ setup: SetupResponse?, doneSaid: Bool, error: String?) {
        let card = SetupChecklist.card(setup, hidden: SetupChecklistSession.hidden, doneSaid: doneSaid)
        let canTurnOff = setup?.canTurnOff ?? false
        let shownError = SetupChecklistSession.hidden ? nil : error
        guard card != setupCard || canTurnOff != setupCanTurnOff || shownError != setupError else { return }
        setupCard = card
        setupCanTurnOff = canTurnOff
        setupError = shownError
        renderSetup()
    }

    private func renderSetup() {
        setupStack.arrangedSubviews.forEach {
            setupStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        var listsSteps = false
        switch setupCard {
        case .none:
            break
        case .done:
            let label = StarlingsTypography.wrappingLabel(String(localized: "You’re set up."))
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
            label.textColor = StarlingsColors.primaryText
            setupStack.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: setupStack.widthAnchor).isActive = true
        case .steps(let rows):
            listsSteps = true
            for row in rows {
                let detail = row.state.blocked?.reason ?? (row.state.done ? String(localized: "Done") : "")
                let item = LaunchWorkRow(
                    title: row.step.title,
                    detail: detail,
                    trailing: row.state.required || row.state.done ? "" : String(localized: "Optional"),
                    isLate: row.isNext,
                    symbolName: row.state.done ? "checkmark" : "circle",
                    interactive: row.opens
                )
                if row.opens {
                    item.onOpen = { [weak self] in self?.onOpenSetupStep?(row.step) }
                }
                guard row.skippable else {
                    setupStack.addArrangedSubview(item)
                    item.widthAnchor.constraint(equalTo: setupStack.widthAnchor).isActive = true
                    continue
                }
                // Skip sits beside the row, not in it: the row is itself a button.
                let skip = SetupSkipButton(title: String(localized: "Skip"), target: nil, action: nil)
                skip.step = row.step
                styleSetupAction(skip, action: #selector(setupSkipTapped(_:)))
                skip.setAccessibilityLabel(String(localized: "Skip \(row.step.title)"))
                let line = NSStackView(views: [item, skip])
                line.orientation = .horizontal
                line.alignment = .centerY
                line.spacing = 8
                item.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
                setupStack.addArrangedSubview(line)
                line.widthAnchor.constraint(equalTo: setupStack.widthAnchor).isActive = true
            }
        }
        setupTurnOffButton.isHidden = !(setupCanTurnOff && listsSteps)
        if let setupError {
            setupNotice.setText(setupError, tone: .danger)
        } else {
            setupNotice.clear()
        }
        setupPanel?.isHidden = setupCard == .none && setupError == nil
    }

    @objc private func setupHideTapped() {
        SetupChecklistSession.hidden = true
        setupCard = .none
        setupError = nil
        renderSetup()
    }

    @objc private func setupTurnOffTapped() {
        onTurnOffSetup?()
    }

    @objc private func setupSkipTapped(_ sender: SetupSkipButton) {
        guard let step = sender.step else { return }
        onSkipSetupStep?(step)
    }

    /// The card's quiet text buttons: Hide, Turn off for everyone, Skip.
    private func styleSetupAction(_ button: NSButton, action: Selector) {
        button.bezelStyle = .inline
        SettingsChrome.applyQuietButton(button)
        button.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        button.contentTintColor = StarlingsColors.secondaryText
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.target = self
        button.action = action
    }

    /// Which modules Home draws and in what order — the owner's choice, read
    /// from the Worker and shared with the phone and the browser.
    func setLayout(_ layout: [HomeModuleSetting]) {
        let resolved = HomeLayout.resolve(layout)
        guard resolved != self.moduleLayout else { return }
        self.moduleLayout = resolved
        columnAssignment = nil
        applyLayout()
    }

    /// The workspace's work modules. A module that draws one of
    /// them goes while all of its own are off; nil, an older Worker's
    /// answer, draws everything.
    func setWorkModules(_ modules: [WorkModule]?) {
        guard modules != workModules else { return }
        workModules = modules
        columnAssignment = nil
        applyLayout()
    }

    private var workModules: [WorkModule]?

    /// Whether Home draws `module` at all: on in the layout, and its work
    /// modules on in the workspace (`HomeLayout.visible`).
    private func isDrawn(_ module: HomeModuleID) -> Bool {
        HomeLayout.visible(moduleLayout, workModules: workModules).contains(module)
    }

    /// The commercial card is a read-only Core projection. A nil answer is a
    /// real answer too: hide the module after the bridge has had its chance.
    func setCommercial(_ summary: CommercialSummary?) {
        guard commercialSummary != summary || !moduleAnswered.contains(.commercial) else { return }
        commercialSummary = summary
        setModuleHasContent(.commercial, summary != nil)
        renderCommercial()
    }

    /// Rebuild the strip: enabled modules in layout order, with the Mac's
    /// WAITING ROOM queue inside the room launcher, and a module hidden when
    /// the layout says so or when it has nothing to draw.
    /// With two columns the visible blocks are assigned by measured height so
    /// the columns stay close in height; a block that folds or grows later
    /// leaves the other modules in their assigned columns until the columns
    /// are lopsided.
    private func applyLayout() {
        clearColumnViews()
        var freshAssignment = false
        if twoColumns, columnAssignment == nil {
            columnAssignment = alternatingColumnAssignment()
            freshAssignment = true
        }
        placePanelsInColumns()

        // The first placement gives AppKit a real width-constrained layout to
        // measure. Pack from those measured heights, then hold the result.
        // Repacking on every late answer would recreate the jitter this
        // surface is deliberately avoiding.
        guard twoColumns, homeInitialLoadSettled, !isBalancingColumns else { return }
        balanceColumns(onlyIfLopsided: !freshAssignment)
    }

    /// Packs the columns from measured heights. With `onlyIfLopsided`, a held
    /// assignment stays unless `HomeLayout.columnsLopsided` rejects it.
    private func balanceColumns(onlyIfLopsided: Bool) {
        isBalancingColumns = true
        layoutSubtreeIfNeeded()
        let modules = moduleLayout.filter { isDrawn($0.id) && $0.id != .recent }.map(\.id)
        let heights = panelHeights(modules)
        isBalancingColumns = false
        if onlyIfLopsided, let columnAssignment,
           !HomeLayout.columnsLopsided(modules, heights: heights, assignment: columnAssignment, gap: Self.columnGap) {
            return
        }
        let balanced = HomeLayout.packColumns(modules, heights: heights, gap: Self.columnGap)
        guard balanced != columnAssignment else { return }
        columnAssignment = balanced
        clearColumnViews()
        placePanelsInColumns()
    }

    /// A column changed height: a card loaded, grew or folded. Check the held
    /// assignment once the current layout pass is over.
    private func scheduleColumnCheck() {
        guard twoColumns, homeInitialLoadSettled, !isBalancingColumns, !columnCheckScheduled else { return }
        columnCheckScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.columnCheckScheduled = false
            guard self.twoColumns, self.homeInitialLoadSettled, !self.isBalancingColumns, self.columnAssignment != nil else { return }
            self.balanceColumns(onlyIfLopsided: true)
        }
    }

    private func clearColumnViews() {
        for column in [leftColumn, rightColumn] {
            for view in column.arrangedSubviews {
                column.removeArrangedSubview(view)
                view.removeFromSuperview()
            }
        }
    }

    private func alternatingColumnAssignment() -> [HomeModuleID: Bool] {
        var slot = 0
        var assignment: [HomeModuleID: Bool] = [:]
        for row in moduleLayout where isDrawn(row.id) && row.id != .recent {
            assignment[row.id] = slot % 2 == 1
            slot += 1
        }
        return assignment
    }

    private func placePanelsInColumns() {
        for row in moduleLayout {
            guard row.id != .recent else { continue }
            guard let panel = modulePanels[row.id] else { continue }
            panel.isHidden = panelShouldHide(row.id)
            let column = twoColumns && columnAssignment?[row.id] == true ? rightColumn : leftColumn
            column.addArrangedSubview(panel)
            panel.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        if twoColumns, rightColumn.superview !== columnsRow {
            columnsRow.addArrangedSubview(rightColumn)
            rightColumnWidth?.isActive = true
        } else if !twoColumns, rightColumn.superview === columnsRow {
            columnsRow.removeArrangedSubview(rightColumn)
            rightColumn.removeFromSuperview()
            rightColumnWidth?.isActive = false
        }
        columnsRowTrailingToLeft?.isActive = !twoColumns
        modulePanels[.recent]?.isHidden = panelShouldHide(.recent)
    }

    /// Heights for `HomeLayout.packColumns`, the phone's packer too. Hidden
    /// modules have no height; the packer still gives them an owner so a
    /// late answer does not default into the left side.
    private func panelHeights(_ modules: [HomeModuleID]) -> [HomeModuleID: CGFloat] {
        var heights: [HomeModuleID: CGFloat] = [:]
        for module in modules where !panelShouldHide(module) {
            heights[module] = estimatedPanelHeight(for: module)
        }
        return heights
    }

    private func estimatedPanelHeight(for module: HomeModuleID) -> CGFloat {
        guard let panel = modulePanels[module] else { return 0 }
        let panelHeight = max(measuredHeight(panel.frame.height), measuredHeight(panel.fittingSize.height))
        return panelHeight
    }

    private func measuredHeight(_ value: CGFloat) -> CGFloat {
        value.isFinite && value > 0 ? value : 0
    }

    /// One or two columns follows the view's width. `setFrameSize` runs it
    /// on every resize step: a frame change alone does not promise a
    /// `layout()` pass, and a Home that widened to two columns must narrow
    /// back to one on the same drag.
    private func updateColumnCount() {
        let wide = bounds.width >= Self.twoColumnMinWidth
        guard wide != twoColumns else { return }
        twoColumns = wide
        columnAssignment = nil
        applyLayout()
        needsLayout = true
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateColumnCount()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // The frame the constraint engine hands this view does not always
        // arrive through `setFrameSize`; the notification always fires.
        postsFrameChangedNotifications = true
        if frameObserver == nil {
            frameObserver = NotificationCenter.default.addObserver(
                forName: NSView.frameDidChangeNotification, object: self, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.updateColumnCount() }
            }
        }
        updateColumnCount()
    }

    override func layout() {
        updateColumnCount()
        // The toolbar's height, as AppKit reports it to a view pinned to the
        // window's top edge; zero when the window has no toolbar over it.
        softEdgeHeight.constant = safeAreaInsets.top + StarlingsSoftEdgeView.ramp
        super.layout()
        if recentStack.arrangedSubviews.count != recentRows.count {
            drawRecentTiles()
        }
    }

    private func setModuleHasContent(_ module: HomeModuleID, _ hasContent: Bool) {
        moduleHasContent[module] = hasContent
        moduleAnswered.insert(module)
        guard homeInitialLoadSettled else {
            // Before the commit an answered module keeps its place, but a
            // module the layout turned off never shows, not even for a frame.
            modulePanels[module]?.isHidden = !isDrawn(module)
            return
        }
        setPanel(module, hidden: !isDrawn(module) || !HomeLayout.draws(module, hasContent: hasContent))
    }

    /// The window controller has painted every snapshot it has, before any
    /// request (`MeetingViewController.paintHomeSnapshots`).
    func finishSnapshotPass() {
        snapshotPassFinished = true
        maybeSettleInitialHome()
    }

    /// The first Home projection is committed as one layout change. With
    /// nothing saved — a first launch — every module waits for its first
    /// answer so the surface does not assemble itself one card at a time.
    /// With snapshots, the commit is the first frame (docs/CACHING.md: no
    /// module waits for another): every module that painted from disk draws,
    /// and one with nothing saved keeps its placeholder rows until it answers.
    private func maybeSettleInitialHome() {
        guard !homeInitialLoadSettled else { return }
        let remote: [HomeModuleID] = [.messages, .work, .commercial, .events]
        let upcomingAnswered = upcomingCalendarConnected != nil || homeUpcomingTimedOut
        let everyAnswer = remote.allSatisfy(moduleAnswered.contains) && starredRowsAnswered && upcomingAnswered
        let paintedFromDisk = snapshotPassFinished
            && (remote.contains(where: moduleAnswered.contains) || starredRowsAnswered || upcomingAnswered)
        guard everyAnswer || paintedFromDisk else { return }

        homeInitialLoadSettled = true
        isCommittingInitialHome = true
        // Only what has answered draws; `render…` marks a module answered,
        // so one still waiting keeps the placeholders `build()` gave it.
        if moduleAnswered.contains(.messages) { renderInbox() }
        if moduleAnswered.contains(.work) { renderWork() }
        renderUpcomingList()
        if moduleAnswered.contains(.events) { renderPublicEvents() }
        renderRecent()
        if moduleAnswered.contains(.commercial) { renderCommercial() }
        quickNotesView.setNotes(pendingQuickNotes, unsent: unsentQuickNotes)
        if let pendingRoomMapping {
            applyRoomMapped(pendingRoomMapping.mapped, email: pendingRoomMapping.email)
        }
        isCommittingInitialHome = false
        columnAssignment = nil
        applyLayout()
    }

    /// A module that has not answered stays up with placeholders; one that
    /// has answered empty goes, unless the registry says it draws empty
    /// (`HomeLayout.draws`). The fold is not animated: a late answer is a
    /// load, and a load lands.
    private func panelShouldHide(_ module: HomeModuleID) -> Bool {
        if !isDrawn(module) { return true }
        guard let hasContent = moduleHasContent[module],
              !HomeLayout.draws(module, hasContent: hasContent) else { return false }
        return moduleAnswered.contains(module)
    }

    private func setPanel(_ module: HomeModuleID, hidden: Bool) {
        guard let panel = modulePanels[module], panel.isHidden != hidden else { return }
        panel.isHidden = hidden
        if twoColumns && !isCommittingInitialHome { applyLayout() }
    }

    /// A capped list module waits with as many placeholder rows as it will
    /// draw (`HomeLayout.rows`), so the answer does not change the height.
    private func showPlaceholders(in stack: NSStackView, module: HomeModuleID) {
        showPlaceholders(in: stack, rows: HomeLayout.rows(for: module))
    }

    private func showPlaceholders(in stack: NSStackView, rows: Int) {
        if stack.arrangedSubviews.count == rows,
           stack.arrangedSubviews.allSatisfy({ $0 is LaunchPlaceholderRow }) {
            return
        }
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for row in (0..<rows).map({ _ in LaunchPlaceholderRow() }) {
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    /// One INBOX card row: an unread conversation, or an INBOX item.
    private enum HomeInboxRow {
        case thread(ThreadSummary)
        case item(WorkInboxItem)

        var at: Double {
            switch self {
            case .thread(let thread): (thread.lastMessageAt?.timeIntervalSince1970 ?? 0) * 1000
            case .item(let item): Double(item.at)
            }
        }

        /// Invitations and decisions lead (`HomeLayout.orderInbox`), in
        /// INBOX's order: invitations first. Questions would too, but this
        /// build does not draw them.
        var isPinned: Bool {
            switch self {
            case .item(.invitation), .item(.decision): return true
            default: return false
            }
        }
    }

    /// What is new: unread conversations and INBOX items, invitations and
    /// decisions first,
    /// then newest first (`HomeLayout.orderInbox`), three rows, then a line
    /// to Work's INBOX for the rest. What you already own is the WORK card's.
    private func renderInbox() {
        let rows = HomeLayout.orderInbox(
            unreadThreads.map(HomeInboxRow.thread) + inboxForCard.map(HomeInboxRow.item),
            pinned: \.isPinned,
            at: \.at
        )
        setModuleHasContent(.messages, !rows.isEmpty)
        guard homeInitialLoadSettled else {
            showPlaceholders(in: messagesStack, module: .messages)
            maybeSettleInitialHome()
            return
        }
        messagesStack.arrangedSubviews.forEach {
            messagesStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        guard !rows.isEmpty else { return }
        messagesCountLabel.stringValue = rows.count == 1 ? String(localized: "1 new") : String(localized: "\(rows.count) new")

        // Three, then a count. A card that grows without limit stops being a
        // signal and becomes the list Work's INBOX already is.
        let listed = rows.prefix(HomeLayout.rows(for: .messages))
        for entry in listed {
            let row: NSView
            switch entry {
            case .thread(let thread):
                row = threadRow(thread)
            case .item(let item):
                row = inboxItemRow(item)
            }
            messagesStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: messagesStack.widthAnchor).isActive = true
        }
        if rows.count > listed.count {
            let more = NSButton(
                title: String(localized: "and \(rows.count - listed.count) more in Work"),
                target: self,
                action: #selector(workTapped)
            )
            more.bezelStyle = .inline
            more.controlSize = .small
            SettingsChrome.applyQuietButton(more)
            more.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            more.contentTintColor = StarlingsColors.secondaryText
            messagesStack.addArrangedSubview(more)
        }
    }

    /// The roster `setAgentAvatars` last handed over.
    private var roster: [Peer] = []

    private func threadRow(_ thread: ThreadSummary) -> LaunchWorkRow {
        let row = LaunchWorkRow(
            title: thread.title,
            // A channel's line names who wrote it.
            detail: thread.previewWithSender(roster: roster) ?? "",
            trailing: thread.lastMessageAt.map { LaunchWorkRow.relative($0) } ?? "",
            isLate: false,
            mark: .unread
        )
        // "3 seconds ago" keeps counting on the launch clock's tick.
        row.relativeTo = thread.lastMessageAt
        // A conversation lives behind exactly one door: a subject's is
        // Work, a person's or the Team channel is Team.
        row.onOpen = { [weak self] in
            if let subject = thread.subject {
                self?.onOpenWork?(WorkDestination(subject: subject, pane: .talk))
            } else if let open = self?.onOpenConversation {
                open(thread.id, nil)
            } else {
                self?.onTeam?()
            }
        }
        // The same menu the phone and the browser draw (`conversation`,
        // `home`). Open is the row's own door; the rest go to Work.
        row.menuProvider = { [weak self, weak row] in
            NSMenu.workRow(thread.homeRowActions(client: .mac)) { action in
                if case .openConversation = action { row?.onOpen?() } else { self?.onWorkRowAction?(action) }
            }
        }
        return row
    }

    private func inboxItemRow(_ item: WorkInboxItem) -> NSView {
        // A calendar answer is given on the row itself, as Calendar's
        // inspector gives it; the action is INBOX's, so the row leaves at once.
        switch item {
        case .invitation(let event, let key, _):
            let row = LaunchCalendarInvitationRow(event: event, conflicts: conflictsForInvitation?(event) ?? [])
            row.onRespond = { [weak self] response in
                self?.onWorkRowAction?(.respondToInvitation(event, response, key: key))
            }
            return row
        case .forwarded(let event, let key, _):
            let row = LaunchPendingEventRow(event: event)
            row.onAnswer = { [weak self] add in
                self?.onWorkRowAction?(add ? .addForwardedEvent(event, key: key) : .discardForwardedEvent(event, key: key))
            }
            return row
        default:
            break
        }
        let row = LaunchWorkRow(
            title: item.glanceTitle,
            detail: item.glanceDetail,
            trailing: "",
            isLate: false,
            symbolName: item.glanceSymbolName,
            markShape: item.glanceUsesSquareMark ? .square : .round
        )
        row.onOpen = { [weak self] in
            guard let self else { return }
            if case .decision(let ask, _, _) = item {
                // Read whole, in Work's sheet, before answering.
                onWorkRowAction?(.openDecision(ask))
            } else if case .question(let request, _, _) = item {
                onWorkRowAction?(.openQuestion(request))
            } else if let threadID = item.glanceThreadID {
                onOpenConversation?(threadID, item.glanceTitle)
            } else if let destination = item.glanceDestination {
                onOpenWork?(destination)
            } else {
                workTapped()
            }
        }
        row.menuProvider = { [weak self] in
            NSMenu.workRow(item.rowActions) { self?.onWorkRowAction?($0) }
        }
        return row
    }

    /// Starred things lead in their service order; the device's last eight
    /// opened rows follow. The shared Home rule removes overlaps.
    private func renderRecent() {
        recentRows = HomeLayout.mergeRecentRows(
            SearchRecents.homeRows(owner: recentsOwner?() ?? ""),
            starredRows: starredRows
        )
        guard homeInitialLoadSettled else {
            moduleHasContent[.recent] = !recentRows.isEmpty
            moduleAnswered.remove(.recent)
            showPlaceholders(in: recentStack, rows: 1)
            return
        }
        setModuleHasContent(.recent, !recentRows.isEmpty)
        drawRecentTiles()
    }

    /// Starred rows come from `StarredWatch` and lead the shared jump list.
    func setStarred(_ rows: [SearchRow]) {
        starredRows = rows
        starredRowsAnswered = true
        renderRecent()
        maybeSettleInitialHome()
    }

    /// Home tiles share the identity already resolved by the peer roster,
    /// and Inbox rows name a channel's sender from it.
    func setAgentAvatars(_ peers: [Peer]) {
        var next: [String: AgentAvatarIdentityWire] = [:]
        for peer in peers where peer.isAgent {
            if let avatar = peer.agentAvatar { next[peer.email.lowercased()] = avatar }
        }
        agentAvatars = next
        drawRecentTiles()
        let names = peers.map { [$0.email, $0.displayName] }
        guard names != roster.map({ [$0.email, $0.displayName] }) else { return }
        roster = peers
        renderInbox()
    }

    private func drawRecentTiles() {
        let starredKeys = Set(starredRows.map(\.key))
        recentStack.arrangedSubviews.forEach {
            recentStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for entry in recentRows {
            let agentAvatar: AgentAvatarIdentityWire? = switch entry.door {
            case .agent(let email): agentAvatars[email.lowercased()]
            default: nil
            }
            let tile = LaunchRecentTile(row: entry, isStarred: starredKeys.contains(entry.key), agentAvatar: agentAvatar) { [weak self] row in
                self?.onOpenSearchRow?(row)
            }
            recentStack.addArrangedSubview(tile)
        }
        let size = recentStack.fittingSize
        let count = recentStack.arrangedSubviews.count
        let tileRowWidth = CGFloat(count) * LaunchRecentTile.width + CGFloat(max(0, count - 1)) * recentStack.spacing
        recentStack.setFrameSize(NSSize(width: max(max(size.width, tileRowWidth), 1), height: 144))
    }

    private func renderCommercial() {
        guard commercialPanel != nil else { return }
        guard homeInitialLoadSettled else {
            showCommercialPlaceholder()
            maybeSettleInitialHome()
            return
        }
        commercialStack.arrangedSubviews.forEach {
            commercialStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        guard let summary = commercialSummary else { return }

        commercialCountLabel.stringValue = String(localized: "\(summary.lookbackMonths) months")
        commercialOffersValue.stringValue = summary.offers.formatted(.number.locale(StarlingsDateFormatting.locale))
        commercialSalesValue.stringValue = commercialCurrency(summary.salesAmount, code: summary.currencyCode)
        commercialPipelineValue.stringValue = commercialCurrency(summary.pipelineAmount, code: summary.currencyCode)
        commercialLicensesValue.stringValue = summary.newLicenses?.formatted(.number.locale(StarlingsDateFormatting.locale)) ?? String(localized: "Unavailable")
        commercialChart.setPoints(summary.points)
        commercialRangeStart.stringValue = summary.points.first?.label ?? ""
        commercialRangeEnd.stringValue = summary.points.last?.label ?? ""

        commercialStack.addArrangedSubview(commercialSubtitleLabel)
        for view in [commercialStatsStack, commercialChart, commercialRangeStack, commercialMoreButton] as [NSView] {
            commercialStack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: commercialStack.widthAnchor).isActive = true
        }
    }

    private func showCommercialPlaceholder() {
        commercialStack.arrangedSubviews.forEach {
            commercialStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for row in (0..<4).map({ _ in LaunchPlaceholderRow() }) {
            commercialStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: commercialStack.widthAnchor).isActive = true
        }
    }

    private func commercialCurrency(_ value: Double, code: String) -> String {
        let formatter = NumberFormatter()
        formatter.locale = .current
        formatter.numberStyle = .currency
        formatter.currencyCode = code
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "\(value) \(code)"
    }

    /// Mine, every row of it, planned here on the Mac that knows what day it is.
    func setWork(tasks: [CrmMyTask], issues: [CrmIssue]) {
        let next = HomeMine.plan(tasks: tasks, issues: issues)
        guard !moduleAnswered.contains(.work) || next != mine else { return }
        mine = next
        renderWork()
    }

    func setInbox(_ inbox: WorkInboxResponse) {
        let next = inbox.itemsBesideTalk
        guard !moduleAnswered.contains(.messages) || next.map(\.id) != inboxBesideTalk.map(\.id) else { return }
        inboxBesideTalk = next
        inboxForCard = inbox.itemsForHomeCard
        renderInbox()
    }

    func setQuickNotes(_ notes: [QuickNote], unsent: [QuickNote.ID: QuickNotePending] = [:]) {
        pendingQuickNotes = notes
        unsentQuickNotes = unsent
        if homeInitialLoadSettled { quickNotesView.setNotes(notes, unsent: unsent) }
    }

    func setQuickNoteSaving(_ saving: Bool, error: String? = nil) {
        quickNotesView.setSaving(saving, error: error)
    }

    func markQuickNoteSaved() {
        quickNotesView.markSaved()
    }

    /// All of Mine, in Mine's order — a handful, with a line to Work for the
    /// rest. Nothing new lands here; that is the INBOX card's.
    private func renderWork() {
        let hasContent = !mine.isEmpty
        setModuleHasContent(.work, hasContent)
        guard homeInitialLoadSettled else {
            showPlaceholders(in: workStack, module: .work)
            maybeSettleInitialHome()
            return
        }
        workStack.arrangedSubviews.forEach {
            workStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        guard hasContent else { return }

        // The word "overdue" is already in the string — no tint on top of it
        // (docs/DESIGN.md, "The accent budget").
        workCountLabel.stringValue = mine.summary ?? ""

        let shownRows = mine.rows.prefix(HomeLayout.rows(for: .work))
        for item in shownRows {
            let row = LaunchWorkRow(
                title: item.homeTitle,
                detail: item.homeDetail,
                trailing: mine.when(item),
                isLate: mine.isLate(item),
                symbolName: item.homeSymbol,
                markShape: .square
            )
            row.onOpen = { [weak self] in
                guard let destination = item.homeDestination else { return }
                self?.onOpenWork?(destination)
            }
            row.menuProvider = { [weak self] in
                NSMenu.workRow(item.homeRowActions()) { self?.onWorkRowAction?($0) }
            }
            workStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: workStack.widthAnchor).isActive = true
        }
        let hidden = mine.rows.count - shownRows.count
        if hidden > 0 {
            let more = NSButton(
                title: String(localized: "and \(hidden) more in Work"),
                target: self,
                action: #selector(workTapped)
            )
            more.bezelStyle = .inline
            more.controlSize = .small
            SettingsChrome.applyQuietButton(more)
            more.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            more.contentTintColor = StarlingsColors.secondaryText
            workStack.addArrangedSubview(more)
        }
    }

    func renderWaiting(
        requests: [LobbyRequestResponse],
        lurkers: [GuestPresenceRow],
        prelive: Bool,
        people: [Peer],
        onStartAndAdmit: @escaping (String, String?) -> Void,
        onAdmit: @escaping (String, String?) -> Void,
        onDecline: @escaping (String) -> Void,
        onDeclineAll: @escaping () -> Void,
        onRemoveLurker: @escaping (String) -> Void
    ) {
        waitingStack.arrangedSubviews.forEach {
            waitingStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        if requests.isEmpty && lurkers.isEmpty {
            // Nobody waiting → the copy button in the header is the whole
            // affordance. Printing the URL here only repeated what the button
            // already puts on the clipboard.
            if !waitingEmptyLabel.stringValue.isEmpty {
                waitingStack.addArrangedSubview(waitingEmptyLabel)
                waitingEmptyLabel.widthAnchor.constraint(equalTo: waitingStack.widthAnchor).isActive = true
            }
            return
        }
        for lurker in lurkers {
            let row = LobbyLurkerRow(
                lurkerID: lurker.id,
                detail: LobbyLurkerCopy.detail(for: lurker),
                country: lurker.country,
                client: lurker.client
            )
            row.onRemove = onRemoveLurker
            waitingStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: waitingStack.widthAnchor).isActive = true
        }
        for (index, request) in requests.enumerated() {
            let row = LobbyGuestRow(
                requestID: request.id,
                detail: LobbyGuestCopy.detail(for: request),
                client: request.client,
                recording: request.recording == true,
                onBehalfOf: request.onBehalfOf,
                people: people
            )
            let isNext = index == 0
            // Before the room is live, the launch CTA already owns the single
            // accent action; keep each queue row to its decline affordance.
            // Once live, admission belongs to the row as usual.
            row.configure(
                admitTitle: prelive ? String(localized: "Start & Admit") : String(localized: "Admit"),
                admitVisible: !prelive,
                admitEnabled: true,
                isNext: isNext,
                busy: false
            )
            row.onAdmit = prelive ? onStartAndAdmit : onAdmit
            row.onDecline = onDecline
            waitingStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: waitingStack.widthAnchor).isActive = true
        }
        // Abandoned tabs leave knocks behind — one click clears the queue.
        if requests.count > 1 {
            self.onDeclineAll = onDeclineAll
            let clear = NSButton(title: String(localized: "Clear waiting room"), target: self, action: #selector(declineAllTapped))
            SettingsChrome.applySecondaryButton(clear, title: String(localized: "Clear waiting room"))
            waitingStack.addArrangedSubview(clear)
        }
    }

    @objc private func declineAllTapped() {
        onDeclineAll?()
    }

    func setStartEnabled(_ enabled: Bool) {
        startButton.isEnabled = enabled
    }

    /// Whether this account has a room in `OWNER_ROOM_MAP`. Without one there
    /// is nothing to start and no link to copy, so both go away and the row
    /// says what to do instead — the other doors on this card still work.
    func setRoomMapped(_ mapped: Bool, email: String? = nil) {
        pendingRoomMapping = (mapped, email)
        guard homeInitialLoadSettled else { return }
        applyRoomMapped(mapped, email: email)
    }

    private func applyRoomMapped(_ mapped: Bool, email: String? = nil) {
        startButton.isHidden = !mapped
        copyRoomLinkButton.isHidden = !mapped
        roomIdentityStack.isHidden = !mapped
        noRoomLabel.isHidden = mapped
        guard !mapped else { return }
        let account = email.map { " to \($0)" } ?? ""
        noRoomLabel.stringValue = String(localized: "No room is mapped\(account). Ask the Starlings admin.")
    }

    private func build() {
        // The logged-in Home identity is the live clock, not a second Meet logo.
        clockLabel.font = StarlingsBrand.homeClockFont(ofSize: 80, weight: .medium)
        clockLabel.textColor = StarlingsColors.primaryText
        clockLabel.alignment = .center
        clockLabel.setContentHuggingPriority(.required, for: .vertical)
        clockLabel.setContentCompressionResistancePriority(.defaultHigh, for: .vertical)

        dateLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(14), weight: .medium)
        dateLabel.textColor = StarlingsColors.secondaryText
        dateLabel.alignment = .center

        let clockBlock = NSStackView(views: [clockLabel, dateLabel])
        clockBlock.orientation = .vertical
        clockBlock.alignment = .centerX
        clockBlock.spacing = 4
        clockBlock.setCustomSpacing(16, after: dateLabel)

        styleSectionLabel(nextTitleLabel)
        upcomingTodayButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(upcomingTodayButton)
        upcomingTodayButton.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        upcomingTodayButton.contentTintColor = StarlingsColors.secondaryText
        upcomingTodayButton.setContentHuggingPriority(.required, for: .horizontal)
        upcomingTodayButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        upcomingTodayButton.target = self
        upcomingTodayButton.action = #selector(seeRestOfTodayTapped)

        // No reload control: the card polls, and ⌘R (View → Reload) is there
        // for the impatient. A button that repeats what the app does on its
        // own reads as a promise that it does not.
        let upcomingTitleRow = StarlingsPanelHeader.row(title: nextTitleLabel)

        upcomingEmptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        upcomingEmptyLabel.textColor = StarlingsColors.secondaryText
        SettingsChrome.applySecondaryButton(connectCalendarButton, title: String(localized: "Connect Google Calendar"), symbolName: "calendar.badge.plus", height: 36)
        connectCalendarButton.target = self
        connectCalendarButton.action = #selector(connectCalendarTapped)
        upcomingStack.orientation = .vertical
        upcomingStack.alignment = .leading
        upcomingStack.spacing = 10
        upcomingStack.addArrangedSubview(upcomingEmptyLabel)

        let nextBlock = NSStackView(views: [upcomingTitleRow, upcomingStack])
        nextBlock.orientation = .vertical
        nextBlock.alignment = .leading
        nextBlock.spacing = 8
        let upcomingPanel = launchSectionPanel(wrapping: nextBlock)

        styleSectionLabel(publicEventsTitleLabel)
        publicEventsStack.orientation = .vertical
        publicEventsStack.alignment = .leading
        publicEventsStack.spacing = 8
        let publicEventsTitleRow = StarlingsPanelHeader.row(title: publicEventsTitleLabel)
        let publicEventsBlock = NSStackView(views: [publicEventsTitleRow, publicEventsStack])
        publicEventsBlock.orientation = .vertical
        publicEventsBlock.alignment = .leading
        publicEventsBlock.spacing = 8
        let publicEventsPanel = launchSectionPanel(wrapping: publicEventsBlock)

        // Today's work sits under today's meetings: the two halves of the day
        // Home is about. Built hidden; `renderWork` shows it when it has rows.
        styleSectionLabel(workTitleLabel)
        styleCountLabel(workCountLabel)
        let workTitleRow = StarlingsPanelHeader.row(title: workTitleLabel, count: workCountLabel)
        workStack.orientation = .vertical
        workStack.alignment = .leading
        workStack.spacing = 8
        let workBlock = NSStackView(views: [workTitleRow, workStack])
        workBlock.orientation = .vertical
        workBlock.alignment = .leading
        workBlock.spacing = 8
        let workPanel = launchSectionPanel(wrapping: workBlock)
        workPanel.isHidden = true
        self.workPanel = workPanel
        // Pinned like every other block's stack: a row with nothing on its
        // trailing edge — an INBOX row — hugged its title otherwise, and the
        // card drew a tile the width of one word.
        workStack.widthAnchor.constraint(equalTo: workBlock.widthAnchor).isActive = true

        styleSectionLabel(commercialTitleLabel)
        styleCountLabel(commercialCountLabel)
        commercialSubtitleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        commercialSubtitleLabel.textColor = StarlingsColors.secondaryText
        let commercialTitleRow = StarlingsPanelHeader.row(title: commercialTitleLabel, count: commercialCountLabel)
        commercialStatsStack.orientation = .horizontal
        commercialStatsStack.alignment = .top
        commercialStatsStack.distribution = .fillEqually
        commercialStatsStack.spacing = 10
        commercialStatsStack.addArrangedSubview(commercialStat(label: String(localized: "Offers"), value: commercialOffersValue))
        commercialStatsStack.addArrangedSubview(commercialStat(label: String(localized: "Sales"), value: commercialSalesValue))
        commercialStatsStack.addArrangedSubview(commercialStat(label: String(localized: "Pipeline"), value: commercialPipelineValue))
        commercialStatsStack.addArrangedSubview(commercialStat(label: String(localized: "New licenses"), value: commercialLicensesValue))
        commercialChart.heightAnchor.constraint(equalToConstant: 72).isActive = true
        commercialRangeStack.orientation = .horizontal
        commercialRangeStack.alignment = .centerY
        commercialRangeStack.distribution = .fillEqually
        for label in [commercialRangeStart, commercialRangeEnd] {
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
            label.textColor = StarlingsColors.secondaryText
        }
        commercialRangeStack.addArrangedSubview(commercialRangeStart)
        commercialRangeStack.addArrangedSubview(commercialRangeEnd)
        commercialRangeEnd.alignment = .right
        SettingsChrome.applyQuietButton(commercialMoreButton)
        commercialMoreButton.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        commercialMoreButton.contentTintColor = StarlingsColors.secondaryText
        commercialMoreButton.target = self
        commercialMoreButton.action = #selector(commercialTapped)
        commercialMoreButton.alignment = .left
        commercialStack.orientation = .vertical
        commercialStack.alignment = .leading
        commercialStack.spacing = 8
        let commercialBlock = NSStackView(views: [commercialTitleRow, commercialStack])
        commercialBlock.orientation = .vertical
        commercialBlock.alignment = .leading
        commercialBlock.spacing = 8
        let commercialPanel = launchSectionPanel(wrapping: commercialBlock)
        self.commercialPanel = commercialPanel
        commercialTitleRow.widthAnchor.constraint(equalTo: commercialBlock.widthAnchor).isActive = true
        commercialStack.widthAnchor.constraint(equalTo: commercialBlock.widthAnchor).isActive = true
        // The stats, chart, range and button rows are only arranged into
        // `commercialStack` by `renderCommercial()`; their width constraints
        // live there too. Activating them here, before the views share an
        // ancestor, throws inside `applicationDidFinishLaunching` — AppKit
        // swallows it and the main window is never built.
        showCommercialPlaceholder()

        styleSectionLabel(messagesTitleLabel)
        styleCountLabel(messagesCountLabel)
        let messagesTitleRow = StarlingsPanelHeader.row(title: messagesTitleLabel, count: messagesCountLabel)
        messagesStack.orientation = .vertical
        messagesStack.alignment = .leading
        messagesStack.spacing = 8
        let messagesBlock = NSStackView(views: [messagesTitleRow, messagesStack])
        messagesBlock.orientation = .vertical
        messagesBlock.alignment = .leading
        messagesBlock.spacing = 8
        let messagesPanel = launchSectionPanel(wrapping: messagesBlock)
        messagesPanel.isHidden = true
        self.messagesPanel = messagesPanel

        styleSectionLabel(recentTitleLabel)
        recentStack.orientation = .horizontal
        recentStack.alignment = .top
        recentStack.spacing = 8
        recentStack.distribution = .fill
        recentStack.translatesAutoresizingMaskIntoConstraints = true
        recentScrollView.documentView = recentStack
        recentScrollView.drawsBackground = false
        recentScrollView.hasVerticalScroller = false
        // No scroller at all: `.overlay` is overridden by macOS whenever
        // "Show scroll bars" is Always or a mouse is attached. The row still
        // scrolls by trackpad and shift-wheel.
        recentScrollView.hasHorizontalScroller = false
        recentScrollView.borderType = .noBorder
        recentScrollView.heightAnchor.constraint(equalToConstant: 144).isActive = true
        let recentBlock = NSStackView(views: [recentTitleLabel, recentScrollView])
        recentBlock.orientation = .vertical
        recentBlock.alignment = .leading
        recentBlock.spacing = 8
        let recentPanel = launchSectionPanel(wrapping: recentBlock)
        recentPanel.isHidden = true

        homeSettingsButton.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: String(localized: "Home settings"))?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
        homeSettingsButton.imagePosition = .imageOnly
        homeSettingsButton.bezelStyle = .inline
        homeSettingsButton.contentTintColor = StarlingsColors.secondaryText
        homeSettingsButton.toolTip = String(localized: "Home settings")
        homeSettingsButton.setAccessibilityLabel(String(localized: "Home settings"))
        homeSettingsButton.target = self
        homeSettingsButton.action = #selector(homeSettingsTapped)
        SettingsChrome.applyQuietButton(homeSettingsButton, cornerRadius: 10)
        homeSettingsButton.translatesAutoresizingMaskIntoConstraints = false
        homeSettingsButton.widthAnchor.constraint(equalToConstant: 20).isActive = true
        homeSettingsButton.heightAnchor.constraint(equalToConstant: 20).isActive = true
        // A subject opened in Work, a conversation in Team, a document in
        // Docs: the list changed under this card, so redraw it.
        recentsObserver = NotificationCenter.default.addObserver(
            forName: SearchRecents.didChange, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.renderRecent() }
        }

        quickNotesView.onCreate = { [weak self] body in
            self?.onCreateQuickNote?(body)
        }
        quickNotesView.onUpdate = { [weak self] note, body in
            self?.onUpdateQuickNote?(note, body)
        }
        quickNotesView.onDelete = { [weak self] note in
            self?.onDeleteQuickNote?(note)
        }
        quickNotesView.onMove = { [weak self] note, workspace in
            self?.onMoveQuickNote?(note, workspace)
        }
        quickNotesView.onSelect = { [weak self] note in
            self?.onTriageQuickNote?(note)
        }
        let quickNotesPanel = launchSectionPanel(wrapping: quickNotesView)

        styleSectionLabel(setupTitleLabel)
        for (button, action) in [(setupTurnOffButton, #selector(setupTurnOffTapped)), (setupHideButton, #selector(setupHideTapped))] {
            styleSetupAction(button, action: action)
        }
        let setupActions = NSStackView(views: [setupTurnOffButton, setupHideButton])
        setupActions.orientation = .horizontal
        setupActions.spacing = 8
        let setupTitleRow = StarlingsPanelHeader.row(title: setupTitleLabel, action: setupActions)
        setupStack.orientation = .vertical
        setupStack.alignment = .leading
        setupStack.spacing = 8
        setupNotice.label.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        let setupBlock = NSStackView(views: [setupTitleRow, setupStack, setupNotice])
        setupBlock.orientation = .vertical
        setupBlock.alignment = .leading
        setupBlock.spacing = 8
        setupTitleRow.widthAnchor.constraint(equalTo: setupBlock.widthAnchor).isActive = true
        setupStack.widthAnchor.constraint(equalTo: setupBlock.widthAnchor).isActive = true
        let setupPanel = launchSectionPanel(wrapping: setupBlock)
        setupPanel.isHidden = true
        self.setupPanel = setupPanel

        styleSectionLabel(roomTitleLabel)
        copyRoomLinkButton.toolTip = copyTooltip()
        let waitingTitleRow = StarlingsPanelHeader.row(title: roomTitleLabel, action: copyRoomLinkButton)
        roomNameLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(20), weight: .semibold)
        roomNameLabel.textColor = StarlingsColors.primaryText
        roomNameLabel.lineBreakMode = .byTruncatingTail
        roomURLLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        roomURLLabel.textColor = StarlingsColors.secondaryText
        roomURLLabel.lineBreakMode = .byTruncatingMiddle
        roomURLLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        roomIdentityStack.orientation = .vertical
        roomIdentityStack.alignment = .leading
        roomIdentityStack.spacing = 2
        roomIdentityStack.setViews([roomNameLabel, roomURLLabel], in: .leading)
        renderRoomIdentity()

        waitingEmptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        waitingEmptyLabel.textColor = StarlingsColors.secondaryText
        waitingStack.orientation = .vertical
        waitingStack.alignment = .leading
        waitingStack.spacing = 10
        setWaitingEmptyMessage("")
        waitingStack.addArrangedSubview(waitingEmptyLabel)

        let waitingBlock = NSStackView(views: [waitingTitleRow, roomIdentityStack, waitingStack])
        waitingBlock.orientation = .vertical
        waitingBlock.alignment = .leading
        waitingBlock.spacing = 8
        startButton.controlSize = .large
        applyStartChrome()
        // Height comes from applyMeetFilledStyle (44).
        startButton.target = self
        startButton.action = #selector(startTapped)

        statusLabel.hidesWhenEmpty = false
        statusLabel.label.font = .systemFont(ofSize: StarlingsTypography.scaled(13))

        closeRoomButton.image = NSImage(
            systemSymbolName: "xmark",
            accessibilityDescription: String(localized: "Close room")
        )?.withSymbolConfiguration(Self.closeRoomSymbolConfig)
        closeRoomButton.imagePosition = .imageOnly
        closeRoomButton.bezelStyle = .inline
        closeRoomButton.isBordered = false
        closeRoomButton.contentTintColor = StarlingsColors.secondaryText
        closeRoomButton.toolTip = String(localized: "End the meeting still open from the last session")
        closeRoomButton.setAccessibilityLabel(String(localized: "Close room"))
        closeRoomButton.target = self
        closeRoomButton.action = #selector(closeRoomTapped)
        closeRoomButton.setContentHuggingPriority(.required, for: .horizontal)
        closeRoomButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        SettingsChrome.applyQuietButton(closeRoomButton)
        closeRoomButton.widthAnchor.constraint(equalToConstant: 22).isActive = true
        closeRoomButton.heightAnchor.constraint(equalToConstant: 22).isActive = true
        closeRoomButton.isHidden = true

        let statusRow = NSStackView(views: [statusLabel, closeRoomButton])
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = 12
        SettingsChrome.applyGroupSurface(statusPanel)
        statusPanel.addSubview(statusRow)
        statusRow.translatesAutoresizingMaskIntoConstraints = false
        statusRow.pinToEdges(of: statusPanel, insets: NSEdgeInsets(top: 8, left: 14, bottom: 8, right: 8))
        statusPanel.isHidden = true

        // Status sits under Start, not above it: the CTA is what you came for,
        // and "room still open — Join to reclaim" reads as a footnote to the
        // button rather than a banner you have to get past.
        noRoomLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        noRoomLabel.textColor = StarlingsColors.secondaryText
        noRoomLabel.isHidden = true

        let actions = NSStackView(views: [waitingBlock, startButton, noRoomLabel, statusPanel])
        actions.orientation = .vertical
        actions.alignment = .leading
        actions.spacing = 10
        waitingBlock.widthAnchor.constraint(equalTo: actions.widthAnchor).isActive = true
        noRoomLabel.widthAnchor.constraint(equalTo: actions.widthAnchor).isActive = true
        // The queue and room actions share one panel, so the host has one
        // place to start the room or act on someone waiting to enter.
        let actionsPanel = launchSectionPanel(wrapping: actions)

        // The strip's order is the person's (`setLayout`), not this file's.
        // Register each panel under its module id and let `applyLayout`
        // place them; the empty-when-nothing rule stays with each renderer.
        modulePanels = [
            .messages: messagesPanel,
            .work: workPanel,
            .commercial: commercialPanel,
            .notes: quickNotesPanel,
            .agenda: upcomingPanel,
            .events: publicEventsPanel,
            .room: actionsPanel,
            .recent: recentPanel,
        ]
        moduleHasContent = [.messages: false, .work: false, .commercial: false, .events: false, .recent: false]
        showPlaceholders(in: messagesStack, module: .messages)
        showPlaceholders(in: workStack, module: .work)
        showPlaceholders(in: publicEventsStack, module: .events)
        // Recents are on disk, so this module answers at once: no placeholders.
        renderRecent()
        // Offline, or a Worker that will not answer: placeholders are a
        // promise, and a promise kept for longer than this is a lie. The
        // module folds; the first real answer unfolds it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self else { return }
            for module in [HomeModuleID.messages, .work, .commercial, .events] where !moduleAnswered.contains(module) {
                setModuleHasContent(module, false)
            }
            starredRowsAnswered = true
            if upcomingCalendarConnected == nil, upcomingFocus == nil, upcomingFollowing.isEmpty,
               upcomingStack.arrangedSubviews.contains(where: { $0 is LaunchPlaceholderRow }) {
                homeUpcomingTimedOut = true
                // No verdict on the calendar either way: an empty card, as
                // before, not "no calendar connected".
                for view in upcomingStack.arrangedSubviews {
                    upcomingStack.removeArrangedSubview(view)
                    view.removeFromSuperview()
                }
                upcomingEmptyLabel.stringValue = ""
                upcomingStack.addArrangedSubview(upcomingEmptyLabel)
                upcomingEmptyLabel.widthAnchor.constraint(equalTo: upcomingStack.widthAnchor).isActive = true
            }
            maybeSettleInitialHome()
        }
        // The row stack measures itself to the taller column; Quick Access
        // then follows it as a full-width module below both columns.
        strip.translatesAutoresizingMaskIntoConstraints = false
        strip.orientation = .vertical
        strip.alignment = .leading
        strip.spacing = Self.columnGap
        strip.distribution = .fill
        columnsRow.translatesAutoresizingMaskIntoConstraints = false
        columnsRow.orientation = .horizontal
        columnsRow.alignment = .top
        columnsRow.spacing = Self.columnGap
        columnsRow.distribution = .fill
        for column in [leftColumn, rightColumn] {
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = Self.columnGap
            column.translatesAutoresizingMaskIntoConstraints = false
            // The column ends at its last card. A horizontal NSStackView
            // pulls every arranged view to its full height at 250, even with
            // `.top` alignment; the stretch went into one card, the packer
            // measured that card at the stretched height, and put it alone
            // in a column. Hugging does not stop it; this pull at 260 does.
            let shortest = column.heightAnchor.constraint(equalToConstant: 0)
            shortest.priority = NSLayoutConstraint.Priority(260)
            shortest.isActive = true
            column.postsFrameChangedNotifications = true
            columnFrameObservers.append(NotificationCenter.default.addObserver(
                forName: NSView.frameDidChangeNotification, object: column, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.scheduleColumnCheck() }
            })
        }
        columnsRow.addArrangedSubview(leftColumn)
        if let setupPanel = self.setupPanel {
            strip.addArrangedSubview(setupPanel)
            setupPanel.widthAnchor.constraint(equalTo: strip.widthAnchor).isActive = true
        }
        strip.addArrangedSubview(columnsRow)
        if let quickAccess = modulePanels[.recent] {
            strip.addArrangedSubview(quickAccess)
            quickAccess.widthAnchor.constraint(equalTo: strip.widthAnchor).isActive = true
        }
        rightColumnWidth = rightColumn.widthAnchor.constraint(equalTo: leftColumn.widthAnchor)
        columnsRowTrailingToLeft = columnsRow.trailingAnchor.constraint(equalTo: leftColumn.trailingAnchor)
        applyLayout()

        // Same line the unsigned door prints, in the same words, and the same
        // line iOS puts under its own Home. A host who is already signed in
        // should not have to sign out or open Settings to read their build.
        versionLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        versionLabel.textColor = StarlingsColors.secondaryText
        versionLabel.alignment = .center
        versionLabel.isSelectable = false

        signedInEmailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        signedInEmailLabel.textColor = StarlingsColors.secondaryText
        signedInEmailLabel.alignment = .center
        signedInEmailLabel.lineBreakMode = .byTruncatingMiddle
        signedInEmailLabel.isSelectable = false
        signedInEmailLabel.isHidden = true

        let topSpacer = NSView()
        let midSpacer = NSView()
        let bottomSpacer = NSView()
        // Keep the launch content visually centered in a tall window. The equal
        // outer spacers collapse to their minimums when the column needs to
        // scroll, so a short window still grows the document instead of clipping.
        topSpacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        midSpacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        bottomSpacer.setContentHuggingPriority(.defaultLow, for: .vertical)

        let column = NSStackView(views: [
            topSpacer, clockBlock, midSpacer, strip, versionLabel, signedInEmailLabel, bottomSpacer,
        ])
        column.orientation = .vertical
        column.alignment = .centerX
        column.spacing = 0
        column.setCustomSpacing(24, after: clockBlock)
        column.setCustomSpacing(16, after: strip)
        column.setCustomSpacing(4, after: versionLabel)
        column.translatesAutoresizingMaskIntoConstraints = false

        let document = NSView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(column)
        // The gear sits in the 24pt between the clock and the strip, flush
        // with the strip's right edge: over the tiles, never a row of its own.
        document.addSubview(homeSettingsButton)
        NSLayoutConstraint.activate([
            homeSettingsButton.trailingAnchor.constraint(equalTo: strip.trailingAnchor),
            homeSettingsButton.bottomAnchor.constraint(equalTo: strip.topAnchor, constant: -2),
        ])

        let clipView = OwnerLaunchFlippedClipView()
        clipView.drawsBackground = false

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.contentView = clipView
        scroll.documentView = document
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        addSubview(scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        // The column runs under the toolbar; below macOS 26 this is what it
        // passes under. On 26 the toolbar's own glass draws the edge.
        addSubview(softEdge, positioned: .above, relativeTo: scroll)
        softEdge.isHidden = StarlingsWindowChrome.hasNativeScrollEdge
        softEdgeHeight = softEdge.heightAnchor.constraint(equalToConstant: StarlingsSoftEdgeView.ramp)

        // Stay at `columnWidth` when there’s room; shrink before horizontal
        // clipping. The second column matches the first. Below the right
        // column's leading (499) on purpose: between `twoColumnMinWidth` and
        // two full columns the solver must narrow both columns, not drop
        // the right one off the strip.
        let stripWidth = leftColumn.widthAnchor.constraint(equalToConstant: Self.columnWidth)
        stripWidth.priority = NSLayoutConstraint.Priority(498)
        let stripFit = strip.widthAnchor.constraint(lessThanOrEqualTo: document.widthAnchor, constant: -Self.sideMargin * 2)
        let columnLeading = column.leadingAnchor.constraint(greaterThanOrEqualTo: document.leadingAnchor, constant: Self.sideMargin)
        let columnTrailing = column.trailingAnchor.constraint(lessThanOrEqualTo: document.trailingAnchor, constant: -Self.sideMargin)

        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),

            softEdge.leadingAnchor.constraint(equalTo: leadingAnchor),
            softEdge.trailingAnchor.constraint(equalTo: trailingAnchor),
            softEdge.topAnchor.constraint(equalTo: topAnchor),
            softEdgeHeight,

            document.leadingAnchor.constraint(equalTo: clipView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: clipView.trailingAnchor),
            document.topAnchor.constraint(equalTo: clipView.topAnchor),
            document.widthAnchor.constraint(equalTo: clipView.widthAnchor),
            document.heightAnchor.constraint(greaterThanOrEqualTo: clipView.heightAnchor),

            column.topAnchor.constraint(equalTo: document.topAnchor),
            // A window shorter than the launch column scrolls, and the last
            // row used to end flush against the sill. Give it the same air the
            // sides have, so the bottom looks like an edge rather than a cut.
            column.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            column.centerXAnchor.constraint(equalTo: document.centerXAnchor),
            columnLeading,
            columnTrailing,

            topSpacer.heightAnchor.constraint(equalTo: bottomSpacer.heightAnchor),
            topSpacer.heightAnchor.constraint(greaterThanOrEqualToConstant: 24),
            midSpacer.heightAnchor.constraint(equalTo: bottomSpacer.heightAnchor, multiplier: 0.18),

            stripWidth,
            columnsRow.widthAnchor.constraint(equalTo: strip.widthAnchor),
            stripFit,
            // Every panel fills the strip even when its rows have short
            // intrinsic titles; `applyLayout` pins each one as it places it,
            // because a panel leaves the strip when the layout changes.
            upcomingTitleRow.widthAnchor.constraint(equalTo: nextBlock.widthAnchor),
            publicEventsTitleRow.widthAnchor.constraint(equalTo: publicEventsBlock.widthAnchor),
            publicEventsStack.widthAnchor.constraint(equalTo: publicEventsBlock.widthAnchor),
            messagesTitleRow.widthAnchor.constraint(equalTo: messagesBlock.widthAnchor),
            messagesStack.widthAnchor.constraint(equalTo: messagesBlock.widthAnchor),
            upcomingStack.widthAnchor.constraint(equalTo: nextBlock.widthAnchor),
            publicEventsTitleRow.widthAnchor.constraint(equalTo: publicEventsBlock.widthAnchor),
            publicEventsStack.widthAnchor.constraint(equalTo: publicEventsBlock.widthAnchor),
            recentScrollView.widthAnchor.constraint(equalTo: recentBlock.widthAnchor),
            waitingTitleRow.widthAnchor.constraint(equalTo: waitingBlock.widthAnchor),
            waitingStack.widthAnchor.constraint(equalTo: waitingBlock.widthAnchor),
            roomIdentityStack.widthAnchor.constraint(equalTo: waitingBlock.widthAnchor),
            statusPanel.widthAnchor.constraint(equalTo: actions.widthAnchor),
            startButton.widthAnchor.constraint(equalTo: actions.widthAnchor),
        ])

        setUpcoming(focus: nil, following: [], calendarConnected: nil)
        tickClock()
    }

    private func launchSectionPanel(wrapping content: NSView) -> NSView {
        let panel = NSView()
        SettingsChrome.applyGroupSurface(panel)
        panel.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        let inset = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        content.pinToEdges(of: panel, insets: inset)
        return panel
    }

    private func styleSectionLabel(_ label: NSTextField) {
        StarlingsTypography.applySectionLabel(label)
    }

    /// The count on a module's title row: "1 new", "2 pending", "1 overdue".
    private func styleCountLabel(_ label: NSTextField) {
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        label.textColor = StarlingsColors.primaryText
        label.alignment = .right
        StarlingsTypography.applyStaticLabel(label)
    }

    private func commercialStat(label: String, value: NSTextField) -> NSView {
        let title = NSTextField(labelWithString: label.uppercased())
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(9), weight: .semibold)
        title.textColor = StarlingsColors.secondaryText
        title.lineBreakMode = .byTruncatingTail
        value.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        value.textColor = StarlingsColors.primaryText
        value.lineBreakMode = .byTruncatingTail
        value.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let stack = NSStackView(views: [title, value])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        return stack
    }

    private func startClock() {
        stopClock()
        clockTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.tickClock()
            }
        }
        clockTimer?.tolerance = 0.1
    }

    private func stopClock() {
        clockTimer?.invalidate()
        clockTimer = nil
    }

    private func tickClock() {
        let now = Date()
        clockLabel.stringValue = timeFormatter.string(from: now)
        dateLabel.stringValue = StarlingsDateFormatting.homeDate(now)
        for case let row as LaunchUpcomingTimeRow in upcomingStack.arrangedSubviews {
            row.refreshRelativeTime()
        }
        for case let row as LaunchWorkRow in messagesStack.arrangedSubviews {
            row.refreshRelativeTime()
        }
        quickNotesView.refreshRelativeTime()
        refreshStartEmphasis()
    }

    @objc private func startTapped() {
        onStart?()
    }

    @objc private func closeRoomTapped() {
        onCloseRoom?()
    }

    @objc private func copyRoomLinkTapped() {
        guard roomLinkRow.copyInviteLink() else { return }
        applyCopySymbol(Self.copiedSymbol)
        copyFlashWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.applyCopySymbol(Self.copySymbol)
        }
        copyFlashWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4, execute: work)
    }

    private static let copySymbol = "doc.on.doc"
    private static let copiedSymbol = "checkmark"

    private func applyCopySymbol(_ name: String) {
        StarlingsPanelHeader.setSymbol(name, on: copyRoomLinkButton)
    }

    private func copyTooltip() -> String {
        let link = roomLinkRow.displayString
        return link.isEmpty ? String(localized: "Copy room link") : String(localized: "Copy \(link)")
    }

    @objc private func seeRestOfTodayTapped() {
        isShowingRemainingToday.toggle()
        renderUpcomingList()
    }

    @objc private func homeSettingsTapped() {
        onOpenHomeSettings?()
    }

    @objc private func workTapped() {
        onWork?()
    }

    @objc private func commercialTapped() {
        onWork?()
    }

    @objc private func connectCalendarTapped() {
        onConnectCalendar?()
    }
}

/// An invitation in Home's INBOX card, answered on the row. The response is
/// written to Google Calendar, so the item leaves INBOX on every device.
@MainActor
private final class LaunchCalendarInvitationRow: NSView {
    var onRespond: ((CalendarRSVP) -> Void)?

    private let event: CalendarEventSummary
    private let acceptButton = StarlingsFilledButton(style: .accent, title: CalendarRSVP.accepted.answerTitle)
    private let maybeButton = NSButton(title: CalendarRSVP.tentative.answerTitle, target: nil, action: nil)
    private let declineButton = NSButton(title: CalendarRSVP.declined.answerTitle, target: nil, action: nil)

    init(event: CalendarEventSummary, conflicts: [CalendarConflict] = []) {
        self.event = event
        super.init(frame: .zero)
        SettingsChrome.applyHomeRow(self, interactive: false)

        let title = NSTextField(labelWithString: event.title.isEmpty ? String(localized: "Calendar invitation") : event.title)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        title.textColor = StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let detail = NSTextField(labelWithString: Self.detail(for: event))
        detail.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        detail.textColor = StarlingsColors.secondaryText
        detail.lineBreakMode = .byTruncatingTail
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let copy = NSStackView(views: [title, detail])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 3
        if let conflictLine = CalendarConflictDetector.line(for: conflicts) {
            let conflict = NSTextField(labelWithString: conflictLine)
            conflict.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            conflict.textColor = StarlingsColors.secondaryText
            conflict.lineBreakMode = .byTruncatingTail
            conflict.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            copy.addArrangedSubview(conflict)
        }

        // Accept is the row's primary action and wears the accent fill, as on
        // the phone and the web; Maybe and Decline stay neutral.
        acceptButton.apply(.accent, title: CalendarRSVP.accepted.answerTitle, font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold), height: 30, symbolName: "checkmark")
        SettingsChrome.applySecondaryButton(maybeButton, title: CalendarRSVP.tentative.answerTitle, symbolName: "questionmark", height: 30)
        SettingsChrome.applySecondaryButton(declineButton, title: CalendarRSVP.declined.answerTitle, symbolName: "xmark", height: 30)
        acceptButton.target = self
        acceptButton.action = #selector(acceptTapped)
        maybeButton.target = self
        maybeButton.action = #selector(maybeTapped)
        declineButton.target = self
        declineButton.action = #selector(declineTapped)

        let actions = NSStackView(views: [acceptButton, maybeButton, declineButton])
        actions.orientation = .horizontal
        actions.distribution = .fillEqually
        actions.spacing = 6

        let mark = WorkGlyphMarkView(
            diameter: 24,
            content: .symbol("calendar.badge.clock"),
            accessibilityLabel: "",
            shape: .round
        )
        mark.setAccessibilityElement(false)
        mark.setContentHuggingPriority(.required, for: .horizontal)
        let head = NSStackView(views: [mark, copy])
        head.orientation = .horizontal
        head.alignment = .top
        head.spacing = 10
        let content = NSStackView(views: [head, actions])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 8
        addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        content.pinToEdges(of: self, insets: SettingsChrome.homeRowInset)
        head.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        actions.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        let accessibility = [
            "Calendar invitation: \(event.title)",
            CalendarConflictDetector.line(for: conflicts),
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
        setAccessibilityLabel(accessibility)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func acceptTapped() { onRespond?(.accepted) }
    @objc private func maybeTapped() { onRespond?(.tentative) }
    @objc private func declineTapped() { onRespond?(.declined) }

    private static func detail(for event: CalendarEventSummary) -> String {
        guard let start = CalendarDateParsing.parse(event.start) else { return event.calendarSummary }
        let date = StarlingsDateFormatting.cardDate(start)
        let time = event.isAllDay ? nil : StarlingsDateFormatting.time(start)
        return [date, time, event.calendarSummary.isEmpty ? nil : event.calendarSummary]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}

/// An event proposed from a forwarded mail in Home's INBOX card:
/// title, when and that it came from email, then Add and Discard. Same chrome
/// as an invitation row.
@MainActor
private final class LaunchPendingEventRow: NSView {
    var onAnswer: ((Bool) -> Void)?

    private let addButton = StarlingsFilledButton(style: .accent, title: String(localized: "Add"))
    private let discardButton = NSButton(title: String(localized: "Discard"), target: nil, action: nil)

    init(event: ProposedCalendarEvent) {
        super.init(frame: .zero)
        SettingsChrome.applyHomeRow(self, interactive: false)

        let title = NSTextField(labelWithString: event.title)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        title.textColor = StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let detail = NSTextField(labelWithString: event.scheduleLine)
        detail.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        detail.textColor = StarlingsColors.secondaryText
        detail.lineBreakMode = .byTruncatingTail
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let copy = NSStackView(views: [title, detail])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 3
        if let location = event.location, !location.isEmpty {
            let place = NSTextField(labelWithString: location)
            place.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            place.textColor = StarlingsColors.secondaryText
            place.lineBreakMode = .byTruncatingTail
            place.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            copy.addArrangedSubview(place)
        }

        addButton.apply(.accent, title: String(localized: "Add"), font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold), height: 30, symbolName: "calendar.badge.plus")
        SettingsChrome.applySecondaryButton(discardButton, title: String(localized: "Discard"), symbolName: "xmark", height: 30)
        addButton.target = self
        addButton.action = #selector(addTapped)
        discardButton.target = self
        discardButton.action = #selector(discardTapped)

        let actions = NSStackView(views: [addButton, discardButton])
        actions.orientation = .horizontal
        actions.distribution = .fillEqually
        actions.spacing = 6

        let mark = WorkGlyphMarkView(
            diameter: 24,
            content: .symbol("envelope.badge"),
            accessibilityLabel: "",
            shape: .round
        )
        mark.setAccessibilityElement(false)
        mark.setContentHuggingPriority(.required, for: .horizontal)
        let head = NSStackView(views: [mark, copy])
        head.orientation = .horizontal
        head.alignment = .top
        head.spacing = 10
        let content = NSStackView(views: [head, actions])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 8
        addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        content.pinToEdges(of: self, insets: SettingsChrome.homeRowInset)
        head.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        actions.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        setAccessibilityLabel(String(localized: "Event from email: \(event.title), \(event.scheduleLine)"))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func addTapped() { onAnswer?(true) }
    @objc private func discardTapped() { onAnswer?(false) }
}

/// Compact stacked monthly activity for the commercial Home module. The data
/// is already normalized by Core's bridge; this view only paints it.
@MainActor
private final class LaunchCommercialChartView: NSView {
    private var points: [CommercialHistogramPoint] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityRole(.image)
        setAccessibilityLabel(String(localized: "Monthly commercial activity"))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isFlipped: Bool { false }

    func setPoints(_ points: [CommercialHistogramPoint]) {
        self.points = points
        needsDisplay = true
        setAccessibilityValue(points.map { "\($0.label): \($0.total)" }.joined(separator: ", "))
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard !points.isEmpty else { return }
        let maximum = max(points.map(\.total).max() ?? 0, 1)
        let gap: CGFloat = 3
        let inset: CGFloat = 2
        let barWidth = max(2, (bounds.width - inset * 2 - gap * CGFloat(points.count - 1)) / CGFloat(points.count))

        for (index, point) in points.enumerated() {
            let accepted = max(point.positive, 0)
            let expired = max(point.negative, 0)
            let active = max(point.total - accepted - expired, 0)
            let x = inset + CGFloat(index) * (barWidth + gap)
            var y = bounds.minY
            for (value, color) in [
                (accepted, StarlingsColors.primaryText),
                (active, StarlingsColors.accent),
                (expired, StarlingsColors.secondaryText.withAlphaComponent(0.45)),
            ] {
                let height = bounds.height * CGFloat(value / maximum)
                guard height > 0 else { continue }
                color.setFill()
                NSBezierPath(
                    roundedRect: NSRect(x: x, y: y, width: barWidth, height: height),
                    xRadius: min(2, barWidth / 2),
                    yRadius: min(2, barWidth / 2)
                ).fill()
                y += height
            }
        }
    }
}

/// A row-shaped nothing: the Home row's chrome around the shared placeholder
/// row, drawn while a module waits for its first answer. Same height as a
/// `LaunchWorkRow` with a detail line, so the card does not change size
/// when the real rows land.
@MainActor
private final class LaunchPlaceholderRow: NSView {
    init() {
        super.init(frame: .zero)
        SettingsChrome.applyHomeRow(self, interactive: false)
        let row = StarlingsPlaceholderRowView(verticalInset: 0)
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.homeRowInset)
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// One jump-list thing: a subject's logo, a person's face, or the kind's glyph
/// over the name, with a star mark when the owner starred it.
@MainActor
private final class LaunchRecentTile: NSView {
    /// Four across a 420pt column: 4 × 88 + 3 × 8 fits its 392pt inside,
    /// and 84pt of caption holds "Envisioning" on one line at 11pt.
    static let width: CGFloat = 88
    private let row: SearchRow
    private let onSelect: (SearchRow) -> Void

    init(row: SearchRow, isStarred: Bool, agentAvatar: AgentAvatarIdentityWire?, onSelect: @escaping (SearchRow) -> Void) {
        self.row = row
        self.onSelect = onSelect
        super.init(frame: .zero)

        let well: NSView = switch row.door {
        case .person(let email), .agent(let email):
            StarlingsPersonAvatarView(
                identity: StarlingsAvatarIdentity(displayName: row.title, email: email, agentAvatar: agentAvatar),
                diameter: 36
            )
        default:
            if let image = row.image, let url = URL(string: image) {
                WorkOrgLogoMarkView(diameter: 36, url: url, fallbackSymbolName: row.symbolName, accessibilityLabel: row.title)
            } else {
                WorkGlyphMarkView(
                    diameter: 36,
                    content: .symbol(row.symbolName),
                    accessibilityLabel: row.title,
                    shape: row.usesSquareMark ? .square : .round
                )
            }
        }
        // A desktop icon's caption: the name wraps onto up to three lines
        // under the well and only the rest is cut. `labelWithString` is a
        // single-line cell, so `maximumNumberOfLines = 2` never wrapped it.
        let title = NSTextField(wrappingLabelWithString: row.title)
        title.isSelectable = false
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        title.textColor = StarlingsColors.primaryText
        title.alignment = .center
        // A truncating line-break mode turns a wrapping cell back into one
        // line. Wrap by word, cap the lines, and let the cell put the
        // ellipsis on the last visible line.
        title.lineBreakMode = .byWordWrapping
        title.maximumNumberOfLines = 3
        title.cell?.truncatesLastVisibleLine = true
        title.preferredMaxLayoutWidth = Self.width - 4
        title.setContentCompressionResistancePriority(.required, for: .vertical)

        let mark = NSView()
        mark.addSubview(well)
        well.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            well.centerXAnchor.constraint(equalTo: mark.centerXAnchor),
            well.centerYAnchor.constraint(equalTo: mark.centerYAnchor),
            well.widthAnchor.constraint(equalToConstant: 36),
            well.heightAnchor.constraint(equalToConstant: 36),
            mark.widthAnchor.constraint(equalToConstant: 40),
            mark.heightAnchor.constraint(equalToConstant: 40),
        ])
        if isStarred {
            let badge = StarlingsFavoriteBadge(size: .tile)
            mark.addSubview(badge)
            NSLayoutConstraint.activate([
                badge.topAnchor.constraint(equalTo: mark.topAnchor, constant: -4),
                badge.leadingAnchor.constraint(equalTo: mark.leadingAnchor, constant: -4),
            ])
        }
        let typePill = LaunchRecentTypePill(title: row.homeTypeLabel)
        let stack = NSStackView(views: [mark, title, typePill])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 2, bottom: 10, right: 2)
        title.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -4).isActive = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            widthAnchor.constraint(equalToConstant: Self.width),
        ])
        setAccessibilityRole(.button)
        let starStatus = isStarred ? ", \(String(localized: "Starred"))" : ""
        setAccessibilityLabel("\(row.title)\(starStatus), \(row.homeTypeLabel)")
        // Chromeless at rest; the house lift under the pointer, like every
        // other Home row.
        applyMeetHoverLift(cornerRadius: WorkSidebarRowPaint.cornerRadius)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func mouseDown(with event: NSEvent) { onSelect(row) }
}

/// A quiet, compact kind label under the tile title.
@MainActor
private final class LaunchRecentTypePill: NSView {
    private let label: NSTextField

    init(title: String) {
        label = NSTextField(labelWithString: title)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true
        layer?.cornerRadius = 7
        layer?.borderWidth = 1
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(9), weight: .medium)
        label.textColor = StarlingsColors.secondaryText
        label.alignment = .center
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
        updateColors()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        let size = label.intrinsicContentSize
        return NSSize(width: size.width + 12, height: size.height + 4)
    }

    override func updateLayer() {
        super.updateLayer()
        updateColors()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    private func updateColors() {
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
    }
}

/// One line of today's work on the launch card: a task with its subject and
/// when it was due, or a subject with something new said about it. Same shape
/// as the rest-of-the-day meeting rows above it, because it is read the same
/// way — scanned, then clicked once.
private final class LaunchWorkRow: NSButton {
    private static let leadingMarkSize: CGFloat = 24

    var onOpen: (() -> Void)?
    /// A MESSAGES row's message time: when set, the trailing label is a
    /// relative time the launch clock refreshes (`refreshRelativeTime`).
    var relativeTo: Date?
    private var trailingLabel: NSTextField?

    nonisolated static func relative(_ date: Date) -> String {
        StarlingsDateFormatting.relative(date)
    }

    func refreshRelativeTime() {
        guard let relativeTo, let trailingLabel else { return }
        let next = Self.relative(relativeTo)
        guard trailingLabel.stringValue != next else { return }
        trailingLabel.stringValue = next
    }
    /// Right-click: the row's actions, built when asked so the menu reads
    /// the item's state at that moment.
    var menuProvider: (() -> NSMenu?)?

    /// The row's mark: a symbol for work, or the unread dot the phone and the
    /// browser draw on a MESSAGES row.
    enum Mark {
        case symbol(String, WorkGlyphMarkShape)
        case unread
    }

    convenience init(title: String, detail: String, trailing: String, isLate: Bool, symbolName: String, markShape: WorkGlyphMarkShape = .round, interactive: Bool = true) {
        self.init(title: title, detail: detail, trailing: trailing, isLate: isLate, mark: .symbol(symbolName, markShape), interactive: interactive)
    }

    /// `interactive: false` for a row that opens nothing (a done setup step):
    /// no hover lift, so it does not promise a click (invariant 18).
    init(title: String, detail: String, trailing: String, isLate: Bool, mark: Mark, interactive: Bool = true) {
        super.init(frame: .zero)
        self.title = ""
        isBordered = false
        SettingsChrome.applyHomeRow(self, interactive: interactive)
        target = self
        action = #selector(openTapped)

        let icon: NSView
        switch mark {
        case .symbol(let symbolName, let shape):
            // Neutral ink, as the phone and the browser draw it; a late row
            // steps the mark up to primary with its trailing "when".
            let markView = WorkGlyphMarkView(
                diameter: Self.leadingMarkSize,
                content: .symbol(symbolName),
                accessibilityLabel: "",
                shape: shape,
                tint: isLate ? StarlingsColors.primaryText : StarlingsColors.secondaryText
            )
            markView.setAccessibilityElement(false)
            icon = markView
        case .unread:
            let imageView = NSImageView()
            // An 8pt dot in the accent mark, the phone's and the browser's
            // mark, centred on the row rather than on its title line.
            imageView.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 8, weight: .regular))
            imageView.contentTintColor = StarlingsColors.accentMark
            imageView.translatesAutoresizingMaskIntoConstraints = false
            let well = NSView()
            well.translatesAutoresizingMaskIntoConstraints = false
            well.addSubview(imageView)
            NSLayoutConstraint.activate([
                well.widthAnchor.constraint(equalToConstant: Self.leadingMarkSize),
                imageView.centerXAnchor.constraint(equalTo: well.centerXAnchor),
                imageView.centerYAnchor.constraint(equalTo: well.centerYAnchor),
            ])
            icon = well
        }
        icon.setContentHuggingPriority(.required, for: .horizontal)

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // The labels must not hug either: their widths are tied to the
        // column's, so a label hugging at the default 250 held the whole
        // column at its own intrinsic width and the other line truncated
        // with the row mostly empty ("Conf…" under a short title).
        titleLabel.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)

        let detailLabel = NSTextField(labelWithString: detail)
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        detailLabel.textColor = StarlingsColors.secondaryText
        detailLabel.lineBreakMode = .byTruncatingTail
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detailLabel.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        detailLabel.isHidden = detail.isEmpty

        // The Home row (docs/DESIGN.md): one title line over one metadata
        // line, the same stack the phone and the browser draw.
        let copy = NSStackView(views: [titleLabel, detailLabel])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 3
        // The copy column takes every point the trailing label leaves. A
        // spacer view used to sit between them and won the slack instead,
        // so titles truncated with the row mostly empty.
        copy.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        copy.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let trailingLabel = NSTextField(labelWithString: trailing)
        // Late is bold neutral ink, not a colour — the text itself ("Late",
        // or an overdue date) already says what happened.
        trailingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: isLate ? .bold : .semibold)
        trailingLabel.textColor = isLate ? StarlingsColors.primaryText : StarlingsColors.secondaryText
        trailingLabel.alignment = .right
        trailingLabel.isHidden = trailing.isEmpty
        trailingLabel.setContentHuggingPriority(.required, for: .horizontal)
        trailingLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        self.trailingLabel = trailingLabel

        let row = NSStackView(views: [icon, copy, trailingLabel])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.homeRowInset)
        // Widths, not a fixed height: a row with a detail line is taller than
        // one without, and the tile grows with it.
        titleLabel.widthAnchor.constraint(equalTo: copy.widthAnchor).isActive = true
        detailLabel.widthAnchor.constraint(equalTo: copy.widthAnchor).isActive = true
        if case .unread = mark {
            // The dot's well spans the copy column, so the dot sits on the
            // row's vertical centre while the "when" stays on the title line.
            icon.heightAnchor.constraint(equalTo: copy.heightAnchor).isActive = true
        }
        setAccessibilityLabel([title, detail, trailing].filter { !$0.isEmpty }.joined(separator: ", "))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func openTapped() {
        onOpen?()
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        menuProvider?() ?? super.menu(for: event)
    }
}

/// A setup row's Skip: carries the step it clears.
private final class SetupSkipButton: NSButton {
    var step: SetupStep?
}

/// Top-down document layout inside the launch scroll view (AppKit defaults to bottom-up).
private final class OwnerLaunchFlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

/// Both upcoming row shapes count down on the launch clock's tick.
@MainActor
protocol LaunchUpcomingTimeRow: AnyObject {
    func refreshRelativeTime()
}

@MainActor
private final class LaunchUpcomingRow: NSStackView, LaunchUpcomingTimeRow {
    /// Our own room is the one place the accent lands on a Home row; every
    /// other platform's mark is neutral ink. The phone's `isStarlingsRoom`
    /// rule and the browser's `.home-row-mark--ours`.
    static func platformMarkTint(_ platform: CalendarMeetingPlatform) -> NSColor {
        platform == .starlings ? StarlingsColors.accentMark : StarlingsColors.secondaryText
    }

    var onUse: ((CalendarEventSummary) -> Void)?
    /// A click anywhere on the row but its button: the event in Calendar.
    var onOpen: ((CalendarEventSummary) -> Void)?
    var onToggleDemoted: ((CalendarEventSummary) -> Void)?
    private let event: CalendarEventSummary
    private let eventRow: UpcomingCompactRow
    private let useButton: NSButton
    private let actionRow: NSStackView

    init(event: CalendarEventSummary) {
        self.event = event
        // Our own rooms get the filled CTA (which needs the press-safe subclass);
        // everything else is a quiet inline link out to someone else's product.
        useButton = event.platform == .starlings
            ? StarlingsFilledButton(frame: .zero)
            : NSButton(title: event.platform.actionTitle, target: nil, action: nil)
        let fillsRow = event.platform == .starlings
        actionRow = NSStackView(views: fillsRow ? [useButton] : [NSView(), useButton])
        // The event card owns its title, schedule, roster and its Join: the
        // action is the card's bottom row, inside it.
        eventRow = UpcomingCompactRow(
            event: event,
            showsTimeLeft: true,
            opensEvent: true,
            showsContext: true,
            hidesTimeLeftWhenJoinable: true,
            showsAttendees: true,
            accessory: actionRow
        )
        super.init(frame: .zero)
        orientation = .vertical
        alignment = .leading
        spacing = 6
        eventRow.onOpen = { [weak self] selected in self?.onOpen?(selected) }
        eventRow.onUse = { [weak self] selected in self?.onUse?(selected) }
        eventRow.onToggleDemoted = { [weak self] selected in self?.onToggleDemoted?(selected) }

        if useButton is StarlingsFilledButton {
            applyUseTitle(event.platform.actionTitle)
        } else {
            useButton.title = event.platform.actionTitle
            useButton.bezelStyle = .inline
            SettingsChrome.applyQuietButton(useButton)
            useButton.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
            useButton.imagePosition = .imageLeading
            useButton.contentTintColor = StarlingsColors.secondaryText
            useButton.image = CalendarMeetingPlatformMark.image(
                for: event.platform,
                size: 14,
                color: StarlingsColors.secondaryText
            )
        }
        useButton.target = self
        useButton.action = #selector(useTapped)
        useButton.setContentCompressionResistancePriority(.required, for: .horizontal)

        actionRow.orientation = .horizontal
        actionRow.alignment = .centerY
        actionRow.spacing = 10
        if fillsRow {
            useButton.widthAnchor.constraint(equalTo: actionRow.widthAnchor).isActive = true
        } else {
            useButton.setContentHuggingPriority(.required, for: .horizontal)
        }

        addArrangedSubview(eventRow)
        eventRow.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        refreshRelativeTime()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func refreshRelativeTime() {
        let now = Date()
        eventRow.refreshRelativeTime()
        let canJoin = event.isVideoMeeting && MeetingFocus.canJoin(event, now: now)
        actionRow.isHidden = !canJoin
        guard canJoin else { return }
        let title = MeetingFocus.joinTitle(event.platform.actionTitle, for: event, now: now)
        if useButton is StarlingsFilledButton {
            applyUseTitle(title)
        } else {
            useButton.title = title
        }
    }

    private func applyUseTitle(_ title: String) {
        guard let filled = useButton as? StarlingsFilledButton else { return }
        // The filled CTA's own height, font and radius — the same shell as
        // Start room, so the screen's one accent is never a thin strip.
        filled.apply(
            .accent,
            title: title,
            leadingImage: CalendarMeetingPlatformMark.image(
                for: event.platform,
                size: 16,
                color: StarlingsColors.accentInk
            )
        )
    }

    @objc private func useTapped() {
        onUse?(event)
    }

}

/// Everything after the next meeting: one line, one click. Title and time left
/// are what you scan a day's agenda for — attendees and platform naming belong
/// to the one meeting you are about to walk into, not to the tail.
@MainActor
/// One meeting on one line — the launch card's rest-of-the-day rows, and both
/// surfaces' tomorrow rows.
///
/// `showsTimeLeft: false` drops the countdown. "17h" is a true answer to a
/// question nobody asks the evening before; the clock time is the whole point of
/// a tomorrow row.
///
/// `opensEvent: true` is Home: the click opens the event in Calendar
/// (`onOpen`) and joining moves to the context menu. The menubar keeps the
/// click as the join (`onUse`), which is the one thing a menubar row is for.
final class UpcomingCompactRow: NSButton, LaunchUpcomingTimeRow {
    var onUse: ((CalendarEventSummary) -> Void)?
    var onOpen: ((CalendarEventSummary) -> Void)?
    var onToggleDemoted: ((CalendarEventSummary) -> Void)?
    private let event: CalendarEventSummary
    private let showsTimeLeft: Bool
    private let opensEvent: Bool
    private let showsContext: Bool
    private let hidesTimeLeftWhenJoinable: Bool
    private let showsAttendees: Bool
    private let titleLabel = NSTextField(labelWithString: "")
    private let timeLeftLabel = NSTextField(labelWithString: "")

    init(
        event: CalendarEventSummary,
        showsTimeLeft: Bool = true,
        opensEvent: Bool = false,
        showsContext: Bool = false,
        hidesTimeLeftWhenJoinable: Bool = false,
        showsAttendees: Bool = false,
        accessory: NSView? = nil
    ) {
        self.event = event
        self.showsTimeLeft = showsTimeLeft
        self.opensEvent = opensEvent
        self.showsContext = showsContext
        self.hidesTimeLeftWhenJoinable = hidesTimeLeftWhenJoinable
        self.showsAttendees = showsAttendees
        super.init(frame: .zero)
        title = ""
        isBordered = false
        // A row that opens nothing (an in-person event in the menubar) is
        // still a row; it just does not lift.
        let interactive = opensEvent || event.isVideoMeeting
        SettingsChrome.applyHomeRow(self, interactive: interactive)
        target = self
        action = #selector(rowClicked)
        isEnabled = interactive
        if opensEvent { setAccessibilityLabel(String(localized: "\(event.title), opens in Calendar")) }

        // The same square well every other Home list leads with (Work, Notes,
        // Events), so the column reads as one list of lists. The platform
        // is the glyph inside it.
        let platformIcon = WorkGlyphMarkView(
            diameter: 24,
            content: .platform(event.platform),
            accessibilityLabel: "",
            shape: .square,
            tint: LaunchUpcomingRow.platformMarkTint(event.platform)
        )
        platformIcon.setAccessibilityElement(false)
        platformIcon.setContentHuggingPriority(.required, for: .horizontal)

        titleLabel.stringValue = event.title
        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var scheduleParts = [MeetingCountdown.clockRange(
            startISO: event.start,
            endISO: event.end,
            isAllDay: event.isAllDay
        )]
        if showsContext {
            scheduleParts.append(contentsOf: [event.calendarSummary, event.subject?.title].compactMap { $0 })
        }
        if let travel = CalendarTravelTime.label(minutes: event.travelTimeMinutes) {
            scheduleParts.append(travel)
        }
        let scheduleLabel = NSTextField(labelWithString: scheduleParts.filter { !$0.isEmpty }.joined(separator: " · "))
        scheduleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        scheduleLabel.textColor = StarlingsColors.secondaryText
        scheduleLabel.lineBreakMode = .byTruncatingTail
        scheduleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        timeLeftLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        timeLeftLabel.textColor = StarlingsColors.secondaryText
        timeLeftLabel.alignment = .right
        timeLeftLabel.setContentHuggingPriority(.required, for: .horizontal)
        timeLeftLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        // The Home row (docs/DESIGN.md): mark, title over the schedule line,
        // the countdown trailing — the stack the phone and browser draw.
        let copy = NSStackView(views: [titleLabel, scheduleLabel])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 3
        // The copy column takes every point the trailing label leaves. A
        // spacer view used to sit between them and won the slack instead,
        // so titles truncated with the row mostly empty.
        copy.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        copy.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [platformIcon, copy, NSView(), timeLeftLabel])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 10
        let content = NSStackView()
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 6
        content.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true

        if showsAttendees {
            // Faces in an overlapping row, not a list of names: the card
            // stays one line tall and the inspector has the full list
            //.
            let attendees = CalendarAttendeeStackView(
                attendees: event.attendees,
                contactNames: ContactEmailDirectory.displayNameByEmail()
            )
            if !attendees.isHidden {
                let attendeeColumn = NSView()
                attendeeColumn.addSubview(attendees)
                attendees.pinToEdges(
                    of: attendeeColumn,
                    insets: NSEdgeInsets(top: 0, left: 24 + row.spacing, bottom: 0, right: 0)
                )
                content.addArrangedSubview(attendeeColumn)
                attendeeColumn.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
            }
        }

        // The card's own action (Join), on its bottom row inside the card,
        // never floating below it.
        if let accessory {
            content.addArrangedSubview(accessory)
            accessory.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        }

        addSubview(content)
        content.pinToEdges(of: self, insets: SettingsChrome.homeRowInset)
        titleLabel.widthAnchor.constraint(equalTo: copy.widthAnchor).isActive = true
        // Same as LaunchWorkRow: the title must not hug, or it holds the
        // column at its own width.
        titleLabel.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)

        refreshRelativeTime()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func refreshRelativeTime() {
        let isJoinable = hidesTimeLeftWhenJoinable
            && event.isVideoMeeting
            && MeetingFocus.canJoin(event)
        let label = showsTimeLeft && !isJoinable
            ? MeetingCountdown.timeLeft(startISO: event.start, endISO: event.end)
            : nil
        timeLeftLabel.stringValue = label ?? ""
        timeLeftLabel.isHidden = label == nil
    }

    @objc private func rowClicked() {
        if opensEvent {
            onOpen?(event)
        } else {
            onUse?(event)
        }
    }

    @objc private func useTapped() {
        onUse?(event)
    }

    override func menu(for nsEvent: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        if opensEvent, event.isVideoMeeting {
            let join = menu.addItem(
                withTitle: event.platform.actionTitle,
                action: #selector(useTapped),
                keyEquivalent: ""
            )
            join.symbol(.video)
            join.target = self
        }
        let item = menu.addItem(
            withTitle: event.demoted ? String(localized: "Show in Next") : String(localized: "Hide from Next"),
            action: #selector(toggleDemoted),
            keyEquivalent: ""
        )
        item.symbol(event.demoted ? .seen : .hide)
        item.target = self
        return menu
    }

    @objc private func toggleDemoted() { onToggleDemoted?(event) }
}
