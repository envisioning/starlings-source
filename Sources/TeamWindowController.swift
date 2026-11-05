import AppKit

/// Team is the Mac destination for people and actors. Work owns the subject
/// graph; this window owns the roster, Everyone, direct/group conversations,
/// presence actions, and agent conversations.
extension NSToolbarItem.Identifier {
    static let teamSearch = NSToolbarItem.Identifier("meet.team.search")
}

@MainActor
final class TeamWindowController: NSWindowController, NSToolbarDelegate {
    let teamViewController: TeamViewController
    private let surfaceSwitcher = StarlingsSurfaceSwitcher(surface: .team)

    init(api: MeetingControlAPI, watch: PeerWatch, favorites: StarredWatch, owner: OwnerProfile? = nil) {
        let viewController = TeamViewController(api: api, watch: watch, favorites: favorites, owner: owner)
        teamViewController = viewController
        let window = NSWindow(contentViewController: viewController)
        window.setContentSize(StarlingsSurface.team.openingContentSize)
        super.init(window: window)
        StarlingsWindowChrome.apply(
            to: window,
            surface: .team,
            toolbarIdentifier: "MeetTeamToolbar",
            delegate: self
        )
        shouldCascadeWindows = false
        // The old autosave holds a frame this window ratcheted its way to —
        // 1612pt on a 1920pt display, wide enough that the shared placement
        // rule had nowhere to put it but hard against the screen edge. The
        // ratchet is fixed above the fold now (nothing in Team's columns may
        // *require* width any more); a new name is what stops an existing
        // install from restoring the evidence of the old one.
        windowFrameAutosaveName = "MeetTeamWindow5"
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        StarlingsShellViewController.leadingToolbarItems
            + [.flexibleSpace, .meetNew, .teamSearch]
            + StarlingsShellViewController.trailingToolbarItems
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier identifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch identifier {
        case .meetSurfaces:
            return surfaceSwitcher.item()
        case .meetSurfacesDivider:
            return StarlingsSurfaceSwitcher.dividerItem()
        case .meetNew:
            let item = NSToolbarItem(itemIdentifier: identifier)
            item.image = NSImage(systemSymbolName: "plus", accessibilityDescription: String(localized: "New group"))
            item.label = String(localized: "New")
            item.toolTip = String(localized: "New group conversation")
            item.target = teamViewController
            item.action = #selector(TeamViewController.newGroupPressed(_:))
            return item
        case .teamSearch:
            return StarlingsSearchField.toolbarItem(identifier, field: teamViewController.searchField, toolTip: String(localized: "Search people, agents and conversations (⌘F). ⌘K searches anything."))
        default:
            return nil
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(relativeTo host: NSWindow? = nil) {
        guard let window else { return }
        if !window.setFrameUsingName(windowFrameAutosaveName), let host {
            window.setFrameOrigin(NSPoint(
                x: host.frame.midX - window.frame.width / 2,
                y: host.frame.midY - window.frame.height / 2
            ))
        }
        StarlingsWindowMetrics.refresh(window)
        teamViewController.prepareForOpening(in: window)
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        teamViewController.windowDidOpen()
    }
}

@MainActor
final class TeamViewController: StarlingsShellViewController, NSMenuDelegate {
    var onCallPeer: ((Peer) -> Void)?
    var onJoinPeerRoom: ((Peer) -> Void)?
    var onOpenInternalRoom: (() -> Void)?
    var onQuickNoteSaved: ((QuickNote) -> Void)?

    let searchField = StarlingsSearchField()

    private let api: MeetingControlAPI
    private let watch: PeerWatch
    private let favorites: StarredWatch
    private let sidebarScroll = NSScrollView()
    private let sidebarStack = NSStackView()
    private let detailTitle = NSTextField(labelWithString: String(localized: "Team"))
    private let detailSubtitle = NSTextField(labelWithString: String(localized: "People and agents"))
    private let internalRoomButton = NSButton(title: String(localized: "Open /room/team"), target: nil, action: nil)
    private let statusLine = StarlingsNoticeView()
    /// The lounge's own header: title, subtitle and the Team Room button. It
    /// belongs to the grid, not the detail column, so it hides with the
    /// lounge when a thread takes over the middle pane.
    private let loungeHeader = NSStackView()
    private let lounge = WorkLoungeView()
    private lazy var threadPane = ThreadPaneView(api: api)
    private lazy var inspector = WorkInspectorViewController(api: api)
    private var roster: PeerRoster = .empty
    private var unreadThreads: [ThreadSummary] = []
    private var groupThreads: [ThreadSummary] = []
    private var directThreads: [ThreadSummary] = []
    /// The rail's three blocks, the same `SidebarSection` Work and Calendar
    /// build from, folds remembered under `meet.sidebarFold.team.*`. Rows are
    /// replaced on every render; the sections themselves persist, so a fold
    /// survives a redraw. Empty blocks hide: a search with no
    /// people in it should not leave a PEOPLE header over nothing.
    /// Everyone and the groups: the conversations with no roster row to
    /// live on. People and agents are listed once, in PEOPLE and AGENTS, in
    /// `TeamRail.order` (2026-09-15).
    private lazy var groupsSection = RailBlockRegistry.section(.team, "groups", title: String(localized: "GROUPS"))
    /// You, at the top, as one row (asked for 2026-09-13): the lounge's self
    /// strip is only on screen while no conversation is open, and a rail
    /// that lists everybody but you hides where your own status lives. Click
    /// opens Notes to self; the context menu is the status menu.
    /// The way back to the grid ( slice 3d). The lounge was what
    /// Team opened on and nothing else: one click on a person and it was
    /// gone for the session. Same row Work has for Overview.
    private lazy var loungeRow: WorkSidebarRowView = {
        let row = WorkSidebarRowView(
            leading: .glyph(systemSymbolName: "person.3.fill", accessibilityLabel: String(localized: "Lounge")),
            title: String(localized: "Lounge"),
            subtitle: String(localized: "Who is around"),
            isSelected: true,
            accessibilityLabel: String(localized: "Lounge"),
            onSelect: { [weak self] in self?.showLounge() }
        )
        return row
    }()
    private let youSection = RailBlockRegistry.section(.team, "you", title: String(localized: "YOU"))
    private let peopleSection = RailBlockRegistry.section(.team, "people", title: String(localized: "PEOPLE"))
    private let agentsSection = RailBlockRegistry.section(.team, "agents", title: String(localized: "AGENTS"))
    private var sections: [SidebarSection] { [youSection, groupsSection, peopleSection, agentsSection] }

    private var currentAddress: ThreadAddress?
    private var statusTask: Task<Void, Never>?
    /// What the rail last drew, row by row. The roster poll republishes every
    /// beat — one a second while an agent is answering — and a rebuild on
    /// each one tore every row out and put it back: hover lost, the scroll
    /// clamped, the rail visibly twitching. Rows are still built each time
    /// (cheap, detached); they only replace the old ones when this differs.
    private var renderedRail: [String]?
    /// The info card the inspector is drawing, so a poll that changes nothing
    /// about a group or the Everyone channel does not redraw it.
    private var shownInfo: WorkInspectorInfo?

    override var openingFirstResponder: NSView? { sidebarScroll }
    override var surfaceSearchField: NSSearchField? { searchField }

    init(api: MeetingControlAPI, watch: PeerWatch, favorites: StarredWatch, owner: OwnerProfile? = nil) {
        self.api = api
        self.watch = watch
        self.favorites = favorites
        // Team kept its own fold store before every rail shared one; carry
        // those folds over once so nobody's closed PEOPLE springs open.
        MeetingSidebarFoldPreferences.migrate(legacyArrayKey: "team.sidebar.collapsedSections", keyPrefix: "team.")
        super.init(nibName: nil, bundle: nil)

        watch.observe { [weak self] roster in
            guard let self else { return }
            self.roster = roster
            guard isViewLoaded, view.window != nil else { return }
            lounge.setRoster(roster)
            lounge.setSelfUnread(roster.me.map { self.hasUnread(peer: $0) } ?? false)
            threadPane.setMentionable(roster.peers)
            renderSidebar()
            refreshInspector()
        }
        watch.observeGroups { [weak self] groups in
            guard let self else { return }
            self.groupThreads = groups
            guard isViewLoaded, view.window != nil else { return }
            renderSidebar()
        }
        watch.observeDirects { [weak self] directs in
            guard let self else { return }
            self.directThreads = directs
            guard isViewLoaded, view.window != nil else { return }
            renderSidebar()
        }
        watch.observeUnread { [weak self] unread in
            guard let self else { return }
            self.unreadThreads = unread
            self.lounge.setSelfUnread(self.roster.me.map { self.hasUnread(peer: $0) } ?? false)
            guard isViewLoaded, view.window != nil else { return }
            renderSidebar()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        searchField.configure(
            placeholder: String(localized: "Search"),
            target: self,
            action: #selector(searchChanged)
        )

        statusLine.label.allowSqueezing()

        sidebarStack.orientation = .vertical
        sidebarStack.alignment = .leading
        sidebarStack.spacing = 10
        sidebarStack.translatesAutoresizingMaskIntoConstraints = false
        sidebarStack.menu = NSMenu()
        sidebarStack.menu?.delegate = self
        loungeRow.translatesAutoresizingMaskIntoConstraints = false
        sidebarStack.addArrangedSubview(loungeRow)
        loungeRow.widthAnchor.constraint(equalTo: sidebarStack.widthAnchor).isActive = true
        for section in sections {
            section.translatesAutoresizingMaskIntoConstraints = false
            sidebarStack.addArrangedSubview(section)
            section.widthAnchor.constraint(equalTo: sidebarStack.widthAnchor).isActive = true
        }

        sidebarScroll.drawsBackground = false
        sidebarScroll.hasVerticalScroller = true
        sidebarScroll.borderType = .noBorder
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        sidebarScroll.contentView = clip
        sidebarScroll.documentView = sidebarStack
        sidebarScroll.translatesAutoresizingMaskIntoConstraints = false

        let sidebar = NSStackView(views: [sidebarScroll])
        sidebar.orientation = .vertical
        sidebar.alignment = .leading
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        sidebarScroll.widthAnchor.constraint(equalTo: sidebar.widthAnchor).isActive = true
        sidebarStack.widthAnchor.constraint(equalTo: sidebarScroll.contentView.widthAnchor).isActive = true
        for column in [sidebar, sidebarScroll, sidebarStack] as [NSView] {
            column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        // A stack defends its arranged views from being clipped, at
        // `.defaultHigh`, and states that as a constraint the column carries
        // up to the window — the same knob that pinned the roster grid. The
        // rail is a list of rows that may all truncate; say so.
        for stack in [sidebar, sidebarStack] {
            stack.setClippingResistancePriority(.defaultLow, for: .horizontal)
            stack.setHuggingPriority(.defaultLow, for: .horizontal)
        }

        let detail = NSView()
        detail.wantsLayer = true
        detail.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.canvas, for: detail).cgColor
        // **The middle column is the remainder, never a demand.** Both of
        // Team's documents live in here at once — the lounge and the thread —
        // and a hidden view's constraints are as live as a visible one's, so
        // either could ask for width the shell had not budgeted. That ask is
        // what grew the Team window a little on every inspector reveal until
        // it hit the display edge and could no longer be moved.
        for host in [detail, lounge, threadPane] as [NSView] {
            host.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            host.setContentHuggingPriority(.defaultLow, for: .horizontal)
        }
        let detailPane = StarlingsShellPaneViewController(view: detail)

        style(detailTitle, size: 20, weight: .semibold, color: StarlingsColors.primaryText)
        style(detailSubtitle, size: 12, weight: .regular, color: StarlingsColors.secondaryText)
        let headerText = NSStackView(views: [detailTitle, detailSubtitle])
        headerText.orientation = .vertical
        headerText.alignment = .leading
        headerText.spacing = 2
        headerText.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        internalRoomButton.applyMeetFilledStyle(
            .accent,
            title: String(localized: "Team Room"),
            height: 44,
            symbolName: "video.fill"
        )
        internalRoomButton.target = self
        internalRoomButton.action = #selector(openInternalRoomTapped)
        internalRoomButton.setAccessibilityLabel(String(localized: "Team Room"))
        let header = loungeHeader
        for view in [headerText, NSView(), internalRoomButton] {
            header.addArrangedSubview(view)
        }
        header.orientation = .horizontal
        header.alignment = .top
        header.spacing = 12
        header.translatesAutoresizingMaskIntoConstraints = false

        statusLine.translatesAutoresizingMaskIntoConstraints = false
        lounge.translatesAutoresizingMaskIntoConstraints = false
        threadPane.translatesAutoresizingMaskIntoConstraints = false

        detail.addSubview(header)
        detail.addSubview(statusLine)
        detail.addSubview(lounge)
        detail.addSubview(threadPane)

        NSLayoutConstraint.activate([
            detail.heightAnchor.constraint(greaterThanOrEqualToConstant: 360),
            header.topAnchor.constraint(equalTo: detail.topAnchor, constant: 18),
            header.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            header.trailingAnchor.constraint(equalTo: detail.trailingAnchor, constant: -20),
            statusLine.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            statusLine.leadingAnchor.constraint(equalTo: detail.leadingAnchor, constant: 20),
            statusLine.trailingAnchor.constraint(lessThanOrEqualTo: detail.trailingAnchor, constant: -20),
            lounge.topAnchor.constraint(equalTo: statusLine.bottomAnchor, constant: 4),
            lounge.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            lounge.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            lounge.bottomAnchor.constraint(equalTo: detail.bottomAnchor),
            threadPane.topAnchor.constraint(equalTo: detail.topAnchor),
            threadPane.leadingAnchor.constraint(equalTo: detail.leadingAnchor),
            threadPane.trailingAnchor.constraint(equalTo: detail.trailingAnchor),
            threadPane.bottomAnchor.constraint(equalTo: detail.bottomAnchor),
        ])

        installColumns(
            sidebar: sidebar,
            detail: detailPane,
            inspector: inspector,
            // Names the two remembered column widths. It is no longer an
            // `NSSplitView` autosave name: renaming that key was what kept
            // giving Team one good launch and then the old oversized
            // arrangement back on the next one.
            columnsName: "MeetTeamSplit5"
        )

        lounge.onSelect = { [weak self] peer in self?.open(.peer(peer)) }
        lounge.onMessage = { [weak self] peer in self?.open(.peer(peer)) }
        lounge.onJoin = { [weak self] peer in self?.onJoinPeerRoom?(peer) }
        lounge.onStatusChange = { [weak self] option in self?.applyStatus(option) }
        lounge.setRoster(roster)
        lounge.setSelfUnread(roster.me.map { hasUnread(peer: $0) } ?? false)
        threadPane.setMentionable(roster.peers)
        threadPane.onRosterWanted = { [weak self] in self?.watch.refreshNow() }
        threadPane.onThreadRead = { [weak self] threadID in self?.watch.markRead(threadID: threadID) }
        threadPane.onQuickNoteSaved = { [weak self] note in self?.onQuickNoteSaved?(note) }
        threadPane.onConversationChange = { [weak self] address in
            guard let self else { return }
            StarlingsWindowChrome.setContextTitle(for: self.view.window, surface: .team, context: address?.title)
            guard let address else { return }
            detailTitle.stringValue = address.title
            detailSubtitle.stringValue = address.subtitle ?? String(localized: "Conversation")
        }
        inspector.onOpenPeer = { [weak self] email in self?.openPeer(email: email) }
        inspector.onNewTaskForPeer = { [weak self] peer in self?.createTask(for: peer) }
        inspector.onReturnToContext = { [weak self] in self?.returnToPersonContext() }
        inspector.onDismiss = { [weak self] in self?.returnToPersonContext() }

        showLounge()
        renderSidebar()
    }

    func windowDidOpen() {
        StarlingsWindowChrome.setContextTitle(for: view.window, surface: .team, context: currentAddress?.title)
        lounge.setRoster(roster)
        lounge.setSelfUnread(roster.me.map { hasUnread(peer: $0) } ?? false)
        threadPane.setMentionable(roster.peers)
        threadPane.resume()
        renderSidebar()
    }

    /// Open the conversation a message banner named. The thread is looked up
    /// in whatever the watch already holds — unread first, then the group and
    /// direct lists — so a banner for a conversation you have since read
    /// still lands on it. An id nothing knows yet (a first message from a
    /// brand-new group that has not been polled) leaves you on the lounge.
    func openThread(id threadID: String, title: String? = nil, focus: MessageFocus = .newest) {
        if threadID == TeamThread.id {
            open(.team)
        } else if let thread = unreadThreads.first(where: { $0.id == threadID }),
                  let address = unreadAddress(for: thread) {
            open(address)
        } else if let group = groupThreads.first(where: { $0.id == threadID }),
                  let address = ThreadAddress.group(group) {
            open(address)
        } else if let direct = directThreads.first(where: { $0.id == threadID }),
                  let address = ThreadAddress.direct(direct) {
            open(address)
        } else if let title {
            // A thread no list carries (an app user's conversation on
            // intake): open it by id; its messages read brings the summary.
            open(.thread(id: threadID, title: title))
        } else {
            return
        }
        for section in sections { section.expand() }
        threadPane.focus(focus)
    }

    /// A conversation opened by id: someone outside the workspace wrote in.
    private func guestConversationInfo(address: ThreadAddress) -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: address.title,
            subtitle: address.subtitle ?? String(localized: "Conversation"),
            sections: [.init(String(localized: "ABOUT"), lines: [String(localized: "Someone outside the workspace wrote here. A reply goes back to them.")])]
        )
    }

    /// The roster's row for an address, when the roster has it.
    func peer(email: String) -> Peer? {
        roster.peers.first { $0.email == email }
    }

    /// A person or agent, opened the way their row opens them — the ⌘K
    /// palette's person door. Unknown addresses leave you on the lounge.
    func openPeer(email: String) {
        guard let peer = peer(email: email) else { return }
        open(.peer(peer))
    }

    /// Progress on a call, or why it did not start. Progress belongs on the
    /// status line (docs/DESIGN.md, Toast), but an open conversation covers
    /// that line, and a Team window off screen shows nothing at all. A line
    /// nobody can see made Call look like it did nothing, so then
    /// the same line goes out as a toast.
    func reportCallProgress(_ line: String, tone: StarlingsToastTone) {
        setStatus(line, tone: tone == .danger ? .danger : .neutral)
        let window = isViewLoaded ? view.window : nil
        let onScreen = window?.isVisible == true
        if onScreen, currentAddress == nil { return }
        StarlingsToast.show(line, tone: tone, in: onScreen ? window : (NSApp.keyWindow ?? NSApp.mainWindow))
    }

    private func style(_ label: NSTextField, size: CGFloat, weight: NSFont.Weight, color: NSColor) {
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(size), weight: weight)
        label.textColor = color
        label.allowSqueezing()
    }

    @objc private func searchChanged() {
        renderSidebar()
    }

    @objc private func openInternalRoomTapped() {
        onOpenInternalRoom?()
    }

    private var query: String {
        searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Escape, anywhere in the window: back to the grid.
    override func cancelOperation(_ sender: Any?) {
        guard currentAddress != nil else { return }
        showLounge()
        renderSidebar()
    }

    private func showLounge() {
        currentAddress = nil
        StarlingsWindowChrome.setContextTitle(for: view.window, surface: .team, context: nil)
        loungeRow.isSelected = true
        lounge.isHidden = false
        loungeHeader.isHidden = false
        threadPane.isHidden = true
        detailTitle.stringValue = String(localized: "Team")
        detailSubtitle.stringValue = String(localized: "People and agents")
        showInfo(teamOverviewInfo())
        setInspector(visible: false)
    }

    /// The inspector's info card, drawn only when it changed. `showInfo`
    /// clears and rebuilds the column; on a poll that is a flicker over the
    /// same words.
    private func showInfo(_ info: WorkInspectorInfo) {
        guard info != shownInfo else { return }
        shownInfo = info
        inspector.showInfo(info)
    }

    private func open(_ address: ThreadAddress) {
        currentAddress = address
        StarlingsWindowChrome.setContextTitle(for: view.window, surface: .team, context: address.title)
        loungeRow.isSelected = false
        if let unread = unreadThreads.first(where: { unreadAddress(for: $0)?.id == address.id }) {
            watch.markRead(threadID: unread.id)
        } else if let email = address.peerEmail {
            watch.markRead(peerEmail: email)
        } else if case let .thread(id) = address.target {
            watch.markRead(threadID: id)
        } else {
            watch.markRead(threadID: address.id)
        }
        lounge.isHidden = true
        loungeHeader.isHidden = true
        // Match Work's ordering: establish the inspector before exposing a
        // new middle-pane document. Revealing the conversation first makes
        // AppKit lay out a two-pane detail, then preserve that width when the
        // inspector is added, which is how Team used to push the window past
        // the display edge.
        switch address.target {
        case let .peer(email):
            if let peer = roster.peers.first(where: { $0.email == email }) {
                setInspector(visible: true)
                shownInfo = nil
                inspector.showPerson(peer, api: api, mine: [])
            } else {
                setInspector(visible: true)
                showInfo(WorkInspectorInfo(
                    title: address.title,
                    subtitle: address.subtitle ?? String(localized: "Conversation"),
                    sections: [
                        .init(String(localized: "ABOUT"), lines: [String(localized: "This conversation is still loading its member information.")]),
                    ]
                ))
            }
        case .team:
            setInspector(visible: true)
            showInfo(teamConversationInfo())
        case let .group(emails):
            setInspector(visible: true)
            showInfo(groupConversationInfo(address: address, emails: emails))
        case .subject:
            // Team does not normally open subject channels, but an address
            // can arrive from a shared thread route. Keep the panel honest if
            // that happens instead of falling back to an empty inspector.
            setInspector(visible: true)
            showInfo(WorkInspectorInfo(
                title: address.title,
                subtitle: address.subtitle ?? String(localized: "Conversation"),
                sections: [.init(String(localized: "ABOUT"), lines: [String(localized: "This conversation belongs to a Work subject.")])]
            ))
        case .thread:
            setInspector(visible: true)
            showInfo(guestConversationInfo(address: address))
        }
        threadPane.isHidden = false
        threadPane.setMentionable(roster.peers)
        threadPane.show(address)
        renderSidebar()
    }

    private func returnToPersonContext() {
        guard case let .peer(email)? = currentAddress?.target,
              let peer = roster.peers.first(where: { $0.email.caseInsensitiveCompare(email) == .orderedSame })
        else { return }
        shownInfo = nil
        inspector.showPerson(peer, api: api, mine: [])
    }

    private func createTask(for peer: Peer) {
        Task { [weak self] in
            guard let self else { return }
            do {
                async let projectRead = api.crmSubjectPage(kind: .project, query: "")
                async let leadRead = api.crmSubjectPage(kind: .lead, query: "")
                async let partnerRead = api.crmSubjectPage(kind: .organization, query: "")
                async let teamRead = api.crmTeam()
                let projects = try await projectRead.subjects
                let leads = try await leadRead.subjects
                let members = try await teamRead
                let partners = try await partnerRead.subjects
                let subjects = projects + leads + partners
                inspector.taskTeam = members
                let ownerEmail = roster.me?.email.lowercased()
                let selfMemberID = ownerEmail.flatMap { email in
                    members.first { $0.email?.lowercased() == email }?.id
                }
                guard let selfMemberID else {
                    throw NSError(
                        domain: "Meet.TeamTaskCreation",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: String(localized: "Couldn’t load the team")]
                    )
                }

                MeetingTaskEditor.present(
                    over: view.window,
                    title: String(localized: "New task"),
                    initial: MeetingTaskEditor.Draft(
                        title: "",
                        notes: "",
                        status: .pending,
                        responsible: .team
                    ),
                    team: members,
                    subjectField: .choose(
                        initial: nil,
                        options: subjects,
                        search: { [weak self] query in await self?.searchTaskSubjects(query) ?? [] }
                    ),
                    selfMemberID: selfMemberID,
                    isNew: true
                ) { [weak self] draft in
                    guard let self, let subject = draft.subject else { return }
                    Task { [weak self] in
                        guard let self else { return }
                        do {
                            _ = try await api.createCrmTask(CrmTaskCreate(
                                title: draft.title,
                                notes: draft.notes.isEmpty ? nil : draft.notes,
                                status: draft.status.rawValue,
                                responsibleParty: draft.responsible.rawValue,
                                assignedTo: Patch(draft.assignedTo),
                                dueDate: draft.dueDate.map(CrmTaskDate.wire),
                                projectID: subject.kind == "project" ? subject.id : nil,
                                leadID: subject.kind == "lead" ? subject.id : nil,
                                organizationID: subject.kind == "organization" ? subject.id : nil,
                                goalID: draft.goalID
                            ))
                            guard case let .peer(email)? = currentAddress?.target,
                                  email.caseInsensitiveCompare(peer.email) == .orderedSame
                            else { return }
                            inspector.showPerson(peer, api: api, mine: [])
                        } catch {
                            presentTaskError(error)
                        }
                    }
                }
            } catch {
                presentTaskError(error)
            }
        }
    }

    private func searchTaskSubjects(_ query: String) async -> [CrmSubject] {
        async let projects = try? await api.crmSubjectPage(kind: .project, query: query)
        async let leads = try? await api.crmSubjectPage(kind: .lead, query: query)
        async let partners = try? await api.crmSubjectPage(kind: .organization, query: query)
        return ((await projects)?.subjects ?? []) + ((await leads)?.subjects ?? []) + ((await partners)?.subjects ?? [])
    }

    private func presentTaskError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = String(localized: "Couldn’t create that task")
        alert.informativeText = (error as? StarlingsError)?.message ?? error.localizedDescription
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "OK"))
        if let window = view.window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    /// The roster moved under an open inspector. A person's row is handed
    /// over in place — `showPerson` would cancel the Core and calendar reads
    /// in flight and start them again, which on the one-second agent poll
    /// left the panel loading forever.
    private func refreshInspector() {
        guard let address = currentAddress else {
            showInfo(teamOverviewInfo())
            return
        }
        switch address.target {
        case let .peer(email):
            guard let peer = roster.peers.first(where: { $0.email == email }) else { return }
            if shownInfo == nil {
                inspector.updatePerson(peer)
            } else {
                // Opened before the roster knew them; now it does.
                shownInfo = nil
                inspector.showPerson(peer, api: api, mine: [])
            }
        case .team:
            showInfo(teamConversationInfo())
        case let .group(emails):
            showInfo(groupConversationInfo(address: address, emails: emails))
        case .subject:
            showInfo(WorkInspectorInfo(
                title: address.title,
                subtitle: address.subtitle ?? String(localized: "Conversation"),
                sections: [.init(String(localized: "ABOUT"), lines: [String(localized: "This conversation belongs to a Work subject.")])]
            ))
        case .thread:
            showInfo(guestConversationInfo(address: address))
        }
    }

    private func teamOverviewInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: String(localized: "Team"),
            subtitle: String(localized: "People and agents"),
            sections: [
                .init(String(localized: "ABOUT"), lines: [
                    String(localized: "Find people, agents, and Everyone here."),
                    String(localized: "Choose a person or conversation to see its details."),
                ]),
            ]
        )
    }

    private func teamConversationInfo() -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: TeamThread.title,
            subtitle: TeamThread.subtitle,
            sections: [
                .init(String(localized: "ABOUT"), lines: [
                    String(localized: "Everyone at \(StarlingsWorkspace.active.name) can read and reply."),
                ]),
            ],
            team: .everyone(roster: roster)
        )
    }

    private func groupConversationInfo(
        address: ThreadAddress,
        emails: [String]
    ) -> WorkInspectorInfo {
        WorkInspectorInfo(
            title: address.title,
            subtitle: address.subtitle ?? String(localized: "Private conversation"),
            sections: [
                .init(String(localized: "ABOUT"), lines: [
                    String(localized: "Only the people listed here can read and reply."),
                ]),
            ],
            team: .group(emails: emails, roster: roster)
        )
    }

    private func setStatus(_ line: String?, tone: StarlingsNoticeView.Tone = .neutral) {
        statusLine.setText(line, tone: tone)
    }

    private func applyStatus(_ option: PeerStatusOption) {
        let resolved = option.resolve()
        statusTask?.cancel()
        statusTask = Task { [weak self] in
            guard let self else { return }
            do {
                if resolved.setsDND {
                    try await api.setDoNotDisturb(until: resolved.dndUntil)
                }
                if resolved.dndUntil == nil && resolved.setsDND {
                    try await api.setIntent(resolved.intent, until: resolved.intentUntil)
                }
                // Visibility rides every answer: choosing to hide hides, and
                // choosing anything else is choosing to be seen again.
                try await api.setAppearOffline(option.invisible)
                watch.refreshNow()
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change your status"), tone: .danger)
            }
        }
    }

    /// The clipboard, sent to this person or agent without opening the chat
    ///: the message is the one the composer would send. The toast
    /// names who it went to and offers Open, which lands on the thread.
    private func pasteAndSend(to peer: Peer) {
        let text = (NSPasteboard.general.string(forType: .string) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            StarlingsToast.show(String(localized: "Nothing to paste."), tone: .danger, in: view.window)
            return
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let thread = try await api.openThread(peerEmail: peer.email)
                _ = try await api.sendMessage(threadID: thread.id, text: text)
                AgentAsks.record(peer)
                StarlingsToast.show(
                    String(localized: "Sent to \(peer.shortName)"),
                    action: .init(title: String(localized: "Open")) { [weak self] in
                        self?.open(.peer(peer))
                        self?.threadPane.focus(.newest)
                    },
                    in: view.window
                )
            } catch {
                StarlingsToast.show((error as? StarlingsError)?.message ?? error.localizedDescription, tone: .danger, in: view.window)
            }
        }
    }

    private func wave(_ peer: Peer) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await api.ring(peerEmail: peer.email)
                StarlingsToast.show(String(localized: "Waved at \(peer.shortName)"), in: view.window)
            } catch {
                setStatus((error as? StarlingsError)?.message ?? String(localized: "Couldn’t wave at them"), tone: .danger)
            }
        }
    }

    private func renderSidebar() {
        let wanted = query
        // Everything a row draws, in order, so two renders of the same rail
        // compare equal — see `renderedRail`.
        var signature: [String] = [wanted, currentAddress?.id ?? ""]
        func note(_ parts: Any?...) {
            signature.append(parts.map { $0.map { "\($0)" } ?? "" }.joined(separator: "|"))
        }
        func note(peer: Peer, hasUnread: Bool, isSelected: Bool) {
            note(
                "peer", peer.email, peer.displayName, teamPeerSubtitle(for: peer),
                peer.isAgent ? nil : peer.displayState.dot, peer.avatarUpdatedAt,
                peer.favoriteRef, hasUnread, isSelected
            )
        }

        // The one matcher (invariant 27), thinning the list in place.
        func matches(_ title: String, _ subtitle: String) -> Bool {
            Search.matches(query: wanted, title: title, subtitle: subtitle)
        }

        var groupRows: [NSView] = []
        if matches(TeamThread.title, TeamThread.subtitle) {
            let unread = hasUnread(threadID: TeamThread.id)
            let selected = currentAddress?.target == .team
            note("team", unread, selected)
            groupRows.append(WorkSidebarRowView.channel(
                title: TeamThread.title,
                subtitle: TeamThread.subtitle,
                hasUnread: unread,
                isSelected: selected,
                menuProvider: { [weak self] in
                    guard let self else { return nil }
                    let menu = NSMenu()
                    menu.addFavoriteAction(FavoriteTarget(kind: .meetThread, targetRef: TeamThread.id), watch: favorites, window: view.window)
                    return menu
                }
            ) { [weak self] in self?.open(.team) })
        }
        for group in groupThreads {
            guard let address = ThreadAddress.group(group), matches(address.title, address.subtitle ?? String(localized: "Private")) else { continue }
            let subtitle = address.subtitle ?? String(localized: "Private")
            let unread = hasUnread(threadID: group.id)
            let selected = currentAddress?.id == address.id
            note("group", address.id, address.title, subtitle, unread, selected)
            groupRows.append(WorkSidebarRowView.channel(
                title: address.title,
                subtitle: subtitle,
                hasUnread: unread,
                isSelected: selected,
                menuProvider: { [weak self] in
                    guard let self else { return nil }
                    let menu = NSMenu()
                    menu.addFavoriteAction(FavoriteTarget(kind: .meetThread, targetRef: group.id), watch: favorites, window: view.window)
                    return menu
                }
            ) { [weak self] in self?.open(address) })
        }
        // A folded block hides every row's unread dot, so the header carries
        // the news instead. A section only draws its badge while folded, so
        // an open one shows nothing twice.
        func badge(_ count: Int) -> String? { count == 0 ? nil : "\(count) unread" }
        let groupsBadge = badge(unreadThreads.filter { $0.kind == .team || $0.isGroup }.count)
        note("groups", groupsBadge)

        var youRows: [NSView] = []
        if let me = roster.me, matches("Notes to self", me.displayName) {
            let unread = hasUnread(peer: me)
            let selected = currentAddress?.peerEmail == me.email
            note(peer: me, hasUnread: unread, isSelected: selected)
            youRows.append(WorkSidebarRowView.peer(
                me,
                hasUnread: unread,
                isSelected: selected,
                onSelect: { [weak self] peer in self?.open(.peer(peer)) },
                menuProvider: { [weak self] in self?.selfStatusMenu(for: me) }
            ))
        }

        var peopleRows = TeamRail.order(roster.people, directs: directThreads).compactMap { peer -> NSView? in
            guard matches(peer.displayName, peer.conversationSubtitle) else { return nil }
            let unread = hasUnread(peer: peer)
            let selected = currentAddress?.peerEmail == peer.email
            note(peer: peer, hasUnread: unread, isSelected: selected)
            return WorkSidebarRowView.peer(
                peer,
                hasUnread: unread,
                isSelected: selected,
                onSelect: { [weak self] peer in self?.open(.peer(peer)) },
                menuProvider: { [weak self] in self?.peerContextMenu(for: peer) }
            )
        }
        // Conversations that outlived the row that started them: hiding
        // somebody in Admin takes away the way to start a new one, never the
        // one already open. Drawn from the thread, initials for a face.
        for direct in TeamRail.strays(directThreads, roster: roster.peers, selfEmail: roster.me?.email) {
            guard let address = ThreadAddress.direct(direct),
                  matches(address.title, address.subtitle ?? String(localized: "Private conversation")) else { continue }
            let detail = address.subtitle ?? String(localized: "Private conversation")
            let unread = hasUnread(threadID: direct.id)
            let selected = currentAddress?.id == address.id
            note("stray", address.id, address.title, detail, address.peerEmail, unread, selected)
            peopleRows.append(WorkSidebarRowView.conversation(
                leading: .avatar(
                    StarlingsAvatarIdentity(
                        displayName: address.title,
                        email: address.peerEmail,
                        agentAvatar: address.peerEmail.flatMap { email in
                            roster.peers.first { $0.isAgent && $0.email.caseInsensitiveCompare(email) == .orderedSame }?.agentAvatar
                        }
                    ),
                    status: nil
                ),
                title: address.title,
                detail: detail,
                isSelected: selected,
                hasUnread: unread,
                menuProvider: { [weak self] in
                    guard let self else { return nil }
                    let menu = NSMenu()
                    menu.addFavoriteAction(FavoriteTarget(kind: .meetThread, targetRef: direct.id), watch: favorites, window: view.window)
                    return menu
                }
            ) { [weak self] in self?.open(address) })
        }
        let peopleBadge = badge(unreadThreads.filter { thread in
            thread.kind == .dm && !thread.isGroup && thread.peerEmail != roster.me?.email
                && !roster.agents.contains { $0.email == thread.peerEmail }
        }.count)
        note("people", peopleBadge)

        let agentRows = TeamRail.order(roster.agents, directs: directThreads).compactMap { agent -> NSView? in
            guard matches(agent.displayName, agent.agentSubtitle) else { return nil }
            let unread = hasUnread(peer: agent)
            let selected = currentAddress?.peerEmail == agent.email
            note(peer: agent, hasUnread: unread, isSelected: selected)
            return WorkSidebarRowView.peer(
                agent,
                hasUnread: unread,
                isSelected: selected,
                preview: directThreads.first { !$0.isGroup && $0.peerEmail == agent.email }?.lastMessagePreview,
                onSelect: { [weak self] peer in self?.open(.peer(peer)) },
                menuProvider: { [weak self] in self?.peerContextMenu(for: agent) }
            )
        }
        let agentsBadge = badge(unreadThreads.filter { thread in
            thread.kind == .dm && !thread.isGroup && roster.agents.contains { $0.email == thread.peerEmail }
        }.count)
        note("agents", agentsBadge)

        guard signature != renderedRail else { return }
        renderedRail = signature

        sidebarScroll.preservingScrollOffset {
            // A search overrides the fold rather than fighting it: a closed
            // section that silently swallowed matches would make the search
            // look broken, and the person typing has already said what they
            // want.
            for section in sections {
                section.setForcedExpanded(!wanted.isEmpty)
            }
            groupsSection.setRows(groupRows, count: groupRows.count)
            groupsSection.setBadge(groupsBadge)
            youSection.setRows(youRows, count: youRows.count)
            peopleSection.setRows(peopleRows, count: peopleRows.count)
            peopleSection.setBadge(peopleBadge)
            agentsSection.setRows(agentRows, count: agentRows.count)
            agentsSection.setBadge(agentsBadge)
        }
    }

    private func hasUnread(threadID: String) -> Bool {
        unreadThreads.contains { $0.id == threadID }
    }

    private func hasUnread(peer: Peer) -> Bool {
        unreadThreads.contains { $0.kind == .dm && !$0.isGroup && $0.peerEmail == peer.email }
    }

    private func unreadAddress(for thread: ThreadSummary) -> ThreadAddress? {
        if thread.kind == .team { return .team }
        if let group = ThreadAddress.group(thread) { return group }
        guard let email = thread.peerEmail else { return nil }
        if let peer = roster.peers.first(where: { $0.email == email }) { return .peer(peer) }
        return nil
    }

    /// The same list the self strip's popup offers, as a menu: the current
    /// answer checked, the appear-offline reminder as a disabled line while
    /// it applies.
    private func selfStatusMenu(for me: Peer) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(ClosureMenuItem(title: String(localized: "Notes to self"), symbol: .notes) { [weak self] in self?.open(.peer(me)) })
        menu.addItem(.separator())
        let current = PeerStatusOption.selected(for: me)
        for option in PeerStatusOption.allCases {
            let item = ClosureMenuItem(title: option.label) { [weak self] in self?.applyStatus(option) }
            item.state = option == current ? .on : .off
            menu.addItem(item)
        }
        if let target = FavoriteTargets.peer(me) {
            menu.addItem(.separator())
            menu.addFavoriteAction(target, watch: favorites, window: view.window)
        }
        if me.invisible {
            menu.addItem(.separator())
            let reminder = NSMenuItem(title: PeerStatusOption.appearOfflineReminder, action: nil, keyEquivalent: "")
            reminder.isEnabled = false
            menu.addItem(reminder)
        }
        return menu
    }

    private func peerContextMenu(for peer: Peer) -> NSMenu? {
        let menu = NSMenu()
        // Above Star, like the phone's long-press. Offered only
        // when the clipboard holds text, so the row never promises nothing.
        if !peer.isSelf, NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            menu.addItem(ClosureMenuItem(title: String(localized: "Paste and send"), symbol: .paste) { [weak self] in self?.pasteAndSend(to: peer) })
            menu.addItem(.separator())
        }
        if peer.isRingable {
            menu.addItem(ClosureMenuItem(title: String(localized: "Wave"), symbol: .wave) { [weak self] in self?.wave(peer) })
        }
        if peer.isCallable {
            if peer.status == .inMeeting {
                menu.addItem(ClosureMenuItem(title: String(localized: "Join room"), symbol: .video) { [weak self] in self?.onJoinPeerRoom?(peer) })
            } else {
                menu.addItem(ClosureMenuItem(title: String(localized: "Call"), symbol: .video) { [weak self] in self?.onCallPeer?(peer) })
            }
        }
        let peerFavorite = FavoriteTargets.peer(peer)
        if let target = peerFavorite {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            menu.addFavoriteAction(target, watch: favorites, window: view.window)
        }
        // A peer row has one star, for the peer. The conversation's favorite
        // is a fallback only when this peer has no stable favorite reference;
        // showing both here makes agents offer contradictory Star / Unstar
        // actions for the same row.
        if peerFavorite == nil,
           let thread = directThreads.first(where: { $0.peerEmail?.caseInsensitiveCompare(peer.email) == .orderedSame }) {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            menu.addFavoriteAction(FavoriteTarget(kind: .meetThread, targetRef: thread.id), watch: favorites, window: view.window)
        }
        return menu.items.isEmpty ? nil : menu
    }

    /// The toolbar's `+`.
    @objc func newGroupPressed(_ sender: Any?) {
        startGroupConversation()
    }

    private func startGroupConversation() {
        let candidates = roster.people.filter { !$0.isSelf }
        guard candidates.count >= 2 else {
            setStatus(String(localized: "Nobody else has signed in yet."))
            return
        }
        GroupConversationSheet.present(
            in: view.window,
            candidates: candidates,
            maximum: ThreadAddress.groupMaximumOthers
        ) { [weak self] chosen in
            guard let self, chosen.count >= 2 else { return }
            self.open(.group(chosen))
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        // The empty rail has no section header to right-click. Keep the menu
        // quiet until Team grows user-configurable section preferences.
        menu.removeAllItems()
    }

    /// The pane stops with the view; any way back to it (its tab, the Dock,
    /// un-minimising) starts it again, not only `show()`.
    override func viewDidAppear() {
        super.viewDidAppear()
        threadPane.resume()
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        threadPane.stop()
        statusTask?.cancel()
    }
}
