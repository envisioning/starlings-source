import AppKit
import SwiftUI

@MainActor
final class MainWindowController: NSWindowController, NSToolbarDelegate {
    let meetingViewController: MeetingViewController
    /// Home: the launch card. This is what the window shows;
    /// `meetingViewController` is what the rest of the app talks to.
    private let homeViewController: StarlingsHomeViewController
    /// The room: the stage and the rail, in a window of their own that opens
    /// with the stage and closes with it (`syncRoomWindow`).
    private lazy var roomWindowController: RoomWindowController = {
        let controller = RoomWindowController(meeting: meetingViewController)
        roomWindowBuilt = true
        return controller
    }()
    /// Set once the Room window exists. Building it loads the shell, whose
    /// `viewDidLoad` syncs the rail and so calls `onImmersiveChange`; a
    /// callback that read `roomWindowController` there re-entered this lazy
    /// initializer until the stack overflowed (7.2.2 launch crash).
    private var roomWindowBuilt = false
    /// The signed-out Join flow was asked for from onboarding, so the room
    /// may stand while Home still shows the sign-in card.
    private var guestJoinRequested = false
    private var roomSyncScheduled = false
    private let surfaceSwitcher = StarlingsSurfaceSwitcher(surface: .meet)
    private let ownerSessionStore = OwnerSessionStore()
    private let ownerAuthenticator = GoogleOwnerAuthenticator()
    /// The onboarding surface while it is up, for a carried link.
    private weak var onboarding: OnboardingViewController?
    private lazy var settingsWindowController = SettingsWindowController(
        settingsViewController: SettingsViewController(
            ownerSessionStore: ownerSessionStore,
            authenticator: ownerAuthenticator,
            core: coreSession,
            keep: keepAccess
        )
    )
    private lazy var calendarWindowController: CalendarWindowController = {
        let workspace = CalendarWorkspace(
            backend: MeetingControlAPI(ownerSessionStore: ownerSessionStore)
        )
        let controller = CalendarWindowController(workspace: workspace)
        controller.calendarViewController.roomContext = { [weak self] in
            self?.meetingViewController.calendarRoomContext()
        }
        controller.calendarViewController.onOpenWork = { [weak self] destination in
            self?.showWork(destination)
        }
        // Everyone at Envisioning first (the roster knows their names), then
        // whoever Contacts knows by address. Read at completion time.
        controller.calendarViewController.inviteeSuggestions = { [weak self] in
            var seen = Set<String>()
            var out: [(email: String, name: String)] = []
            for peer in self?.peerWatch.roster.people ?? [] where !peer.email.isEmpty {
                guard seen.insert(peer.email.lowercased()).inserted else { continue }
                out.append((peer.email.lowercased(), peer.displayName))
            }
            for (email, name) in ContactEmailDirectory.displayNameByEmail() where seen.insert(email).inserted {
                out.append((email, name))
            }
            return out
        }
        // Which guests on an opened event are contacts. Best
        // effort: a failed read, signed out included, is nil and the rows
        // stay as they are.
        let contactsAPI = MeetingControlAPI(ownerSessionStore: ownerSessionStore)
        controller.calendarViewController.contactLookup = { emails in
            try? await contactsAPI.crmContacts(emails: emails)
        }
        calendarWindowBuilt = true
        return controller
    }()
    /// Set once Calendar exists, so an INBOX answer reloads an open Calendar
    /// without building one nobody opened.
    private var calendarWindowBuilt = false
    private var updateRequestedObserver: (any NSObjectProtocol)?
    /// Presence for the life of the app rather than the life of either
    /// destination window — the menu bar, ring notification, Team window and
    /// launch surface all read this one poll. See `PeerWatch`.
    private(set) lazy var peerWatch: PeerWatch = {
        let watch = PeerWatch(
            api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
            ownerSessionStore: ownerSessionStore
        )
        watch.onJoinRing = { [weak self] slug in self?.callRoom(slug: slug) }
        // Asking, answered, or nobody there. Both destination surfaces listen
        // so the status remains visible after the action's source is closed.
        watch.onCallProgress = { [weak self] line, tone in
            self?.teamWindowController.teamViewController.reportCallProgress(line, tone: tone)
        }
        watch.onWaveProgress = { [weak self] line in
            self?.teamWindowController.teamViewController.reportCallProgress(line, tone: .danger)
        }
        // The wave may come from the menu bar or the Lounge as well as
        // Team, so it speaks in whichever window is in front.
        watch.onWaved = { [weak self] line in
            StarlingsToast.show(line, in: NSApp.keyWindow ?? NSApp.mainWindow ?? self?.teamWindowController.window)
        }
        return watch
    }()
    /// Your own work for the life of the app — the launch card and the menu
    /// bar say what is due today with the Work window shut. See `WorkWatch`.
    /// This Mac's standing with Core — token, registry, repository — for the
    /// life of the app. The Work window draws from it; Settings connects it.
    private(set) lazy var coreSession = CoreSession(
        apiEndpoint: HTTPConnectionDetailsProvider.configuredAPIBase.absoluteString,
        deviceName: Host.current().localizedName ?? String(localized: "Mac")
    )
    /// This Mac's standing with Docs — token and client — for the life of the
    /// app. Work's Documents pane and Docs block draw from it; Settings
    /// connects it.
    private(set) lazy var docsSession = DocsSession(
        apiEndpoint: HTTPConnectionDetailsProvider.configuredAPIBase.absoluteString,
        deviceName: Host.current().localizedName ?? String(localized: "Mac"),
        ownerSession: { DocsOwnerSession(OwnerSessionStore()) }
    )
    /// This Mac's standing with Keep — token and key session — for the life
    /// of the app. The Keep window draws from it; Work › Keep… opens it.
    private(set) lazy var keepAccess = KeepAccess(
        apiEndpoint: HTTPConnectionDetailsProvider.configuredAPIBase.absoluteString,
        deviceName: Host.current().localizedName ?? String(localized: "Mac")
    )
    /// Keep, the vaults. Not a fifth destination: it hangs off Work, in a
    /// plain window of its own (docs/KEEP.md).
    private lazy var keepWindowController = KeepWindowController(access: keepAccess)
    private(set) lazy var workWatch = WorkWatch(
        api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
        ownerSessionStore: ownerSessionStore
    )
    private(set) lazy var commercialWatch = CommercialWatch(
        api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
        ownerSessionStore: ownerSessionStore
    )
    /// Home's QUICK ACCESS list: starred rows, resolved by the Worker.
    private(set) lazy var starredWatch = StarredWatch(
        api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
        ownerSessionStore: ownerSessionStore
    )
    /// For the one-off writes Home makes on its own: filing a Quick Note.
    private lazy var quickNoteAPI = MeetingControlAPI(ownerSessionStore: ownerSessionStore)
    /// Quick Notes belong to Home, so their private capture list stays alive
    /// beside WorkWatch even when the Work window is closed.
    private(set) lazy var quickNotesWatch = QuickNotesWatch(
        api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
        ownerSessionStore: ownerSessionStore
    )
    private lazy var workWindowController: WorkWindowController = {
        let controller = WorkWindowController(
            api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
            watch: peerWatch,
            work: workWatch,
            core: coreSession,
            docs: docsSession,
            favorites: starredWatch,
            owner: (try? ownerSessionStore.load())?.owner
        )
        // Work → room. The meeting window owns the room and files it under
        // the subject once it is up; Work only names what it is about, and
        // only offers to while this Mac can actually start one.
        controller.workViewController.canMeet = { [weak self] in
            self?.meetingViewController.canStartHostRoom ?? false
        }
        controller.workViewController.onOpenKeep = { [weak self] subject in
            self?.showKeep(project: subject)
        }
        controller.workViewController.onOpenPeer = { [weak self] email in
            self?.showConversation(peerEmail: email)
        }
        controller.workViewController.onOpenConversation = { [weak self] threadID, title in
            self?.showConversation(threadID: threadID, title: title)
        }
        controller.workViewController.onOpenCalendarEvent = { [weak self] reference in
            guard let self else { return }
            showCalendar(nil)
            calendarWindowController.calendarViewController.reveal(eventReference: reference)
        }
        controller.workViewController.onCalendarAnswered = { [weak self] in
            guard let self else { return }
            meetingViewController.refreshUpcomingAfterCalendarAnswer()
            // An invitation answered or an event added from INBOX changes the
            // grid too; Calendar reads again if it was ever opened.
            if calendarWindowBuilt { calendarWindowController.calendarViewController.refreshCalendar(nil) }
        }
        controller.workViewController.onMeetAbout = { [weak self] subject in
            guard let self, meetingViewController.startRoom(filedAs: subject) else { return }
            showMeetingWindow()
        }
        controller.workViewController.onSubjectStateChanged = { [weak self] in
            self?.starredWatch.refreshNow()
        }
        controller.workViewController.onQuickNoteSaved = { [weak self] note in self?.didSaveQuickNote(note) }
        return controller
    }()
    private lazy var teamWindowController: TeamWindowController = {
        let controller = TeamWindowController(
            api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
            watch: peerWatch,
            favorites: starredWatch,
            owner: (try? ownerSessionStore.load())?.owner
        )
        controller.teamViewController.onOpenInternalRoom = { [weak self] in
            guard let self else { return }
            self.meetingViewController.loadViewIfNeeded()
            guard self.meetingViewController.startInternalRoom() else { return }
            self.showMeetingWindow()
        }
        controller.teamViewController.onCallPeer = { [weak self] peer in self?.callPeer(peer) }
        controller.teamViewController.onJoinPeerRoom = { [weak self] peer in
            guard let self, let slug = peer.joinRoomSlug else { return }
            self.callRoom(slug: slug)
        }
        controller.teamViewController.onQuickNoteSaved = { [weak self] note in self?.didSaveQuickNote(note) }
        return controller
    }()
    /// Docs, the corpus. The Work window keeps the contextual slice; this
    /// window is everything else (docs/DOCS.md).
    private lazy var docsWindowController = DocsWindowController(
        api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
        docs: docsSession,
        core: coreSession,
        favorites: starredWatch
    )
    /// ⌘K. One panel for the app, shown over whichever window is key.
    private lazy var searchPanelController = SearchPanelController(
        api: MeetingControlAPI(ownerSessionStore: ownerSessionStore),
        docs: docsSession,
        core: coreSession,
        navigator: self
    )
    private var showingOnboarding = false

    init() {
        let viewController = MeetingViewController(
            ownerSessionStore: ownerSessionStore,
            ownerAuthenticator: ownerAuthenticator
        )
        meetingViewController = viewController
        let home = StarlingsHomeViewController(meeting: viewController)
        homeViewController = home
        let window = NSWindow(contentViewController: home)
        window.setContentSize(StarlingsSurface.meet.openingContentSize)
        // The floor and the ceiling are `StarlingsWindowMetrics`' — one rule for all
        // five windows. Home answers with the launch card's floor; the Room
        // window with the stage, or the stage plus the rail.
        super.init(window: window)
        StarlingsWindowChrome.apply(
            to: window,
            surface: .meet,
            toolbarIdentifier: "MeetMainToolbar",
            delegate: self,
            contentUnderToolbar: true
        )
        window.center()
        // The Room window keeps its chrome for the whole meeting. Only Focus
        // takes it, and Focus is asked for — see `StarlingsWindowChrome.setImmersive`.
        // A Room window not built yet has no chrome to change.
        viewController.onImmersiveChange = { [weak self] immersive in
            guard let self, self.roomWindowBuilt else { return }
            StarlingsWindowChrome.setImmersive(immersive, on: self.roomWindowController.window)
        }
        viewController.onStageVisibilityChange = { [weak self] _ in
            self?.scheduleRoomSync()
        }
        viewController.onShowRoom = { [weak self] in
            self?.roomWindowController.show()
        }
        // Keep the first frame independent of Keychain access. The store's
        // defaults hint says which surface to draw; the app delegate then
        // resolves the stored owner session asynchronously and corrects it.
        // Drawing onboarding unconditionally here is what flashed the sign-in
        // card at a signed-in owner on every launch.
        if ownerSessionStore.expectsOwnerSession {
            showHomeAwaitingSession()
        } else {
            showOnboarding()
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(ownerSessionDidExpire),
            name: OwnerSessionStore.didExpireNotification,
            object: nil
        )
        // The idle launch surface is this app's home screen, so it is where
        // "somebody wrote to you" belongs. Team is still the only place to read
        // it; this only says there is something to read.
        peerWatch.observeUnread { [weak self] threads in
            self?.meetingViewController.setUnreadMessages(threads)
        }
        peerWatch.observe { [weak self] roster in
            self?.meetingViewController.setPeerRoster(roster)
        }
        peerWatch.start()
        // Today's work belongs on the same home screen. A row there opens the
        // Work window on that subject — the launch surface names the place,
        // this controller owns the window.
        workWatch.observeInbox { [weak self] inbox in
            self?.meetingViewController.setInbox(inbox)
        }
        workWatch.observe { [weak self] tasks, issues in
            self?.meetingViewController.setMine(tasks: tasks, issues: issues)
        }
        commercialWatch.observe { [weak self] summary in
            self?.meetingViewController.setCommercial(summary)
        }
        starredWatch.observe { [weak self] rows in
            self?.meetingViewController.setStarred(rows)
        }
        meetingViewController.onOpenWork = { [weak self] destination in
            self?.showWork(destination)
        }
        meetingViewController.onOpenSearchRow = { [weak self] row in
            self?.searchOpen(row, verb: nil)
        }
        meetingViewController.onWorkRowAction = { [weak self] action in
            self?.performHomeWorkAction(action)
        }
        quickNotesWatch.observe { [weak self] notes in
            guard let self else { return }
            meetingViewController.setQuickNotes(notes, unsent: quickNotesWatch.pending)
        }
        meetingViewController.onCreateQuickNote = { [weak self] body in
            self?.saveQuickNote(body)
        }
        meetingViewController.onUpdateQuickNote = { [weak self] note, body in
            self?.updateQuickNote(note, body: body)
        }
        meetingViewController.onDeleteQuickNote = { [weak self] note in
            self?.deleteQuickNote(note)
        }
        meetingViewController.onMoveQuickNote = { [weak self] note, workspace in
            self?.moveQuickNote(note, to: workspace)
        }
        meetingViewController.onTriageQuickNote = { [weak self] note in
            guard let self else { return }
            // A note still on this Mac cannot be pointed at what filing makes
            //: it goes out first.
            guard quickNotesWatch.pending[note.id] == nil else {
                meetingViewController.setQuickNoteSaving(false, error: String(localized: "Not sent yet. Try again when you’re online."))
                quickNotesWatch.refreshNow()
                return
            }
            QuickNoteFiling.present(over: window, note: note, api: quickNoteAPI, docs: docsSession) { [weak self] (_: QuickNote, _: QuickNotePromotionKind) in
                self?.quickNotesWatch.refreshNow()
            }
        }
        meetingViewController.onOpenTeam = { [weak self] in
            self?.showTeam(nil)
        }
        meetingViewController.onOpenConversation = { [weak self] threadID, title in
            self?.showConversation(threadID: threadID, title: title)
        }
        meetingViewController.onOpenDocs = { [weak self] in
            self?.showDocs(nil)
        }
        meetingViewController.onOpenCalendarSettings = { [weak self] in
            self?.showCalendarSettings()
        }
        meetingViewController.onOpenHomeSettings = { [weak self] in
            self?.showHomeSettings()
        }
        meetingViewController.onOpenSettingsPage = { [weak self] page in
            guard let self else { return }
            settingsWindowController.show()
            settingsWindowController.settingsViewController.show(page: page)
        }
        meetingViewController.onRevealCalendarEvent = { [weak self] event in
            self?.showCalendar(revealing: event)
        }
        // Each watch paints its snapshot as it starts, before its first
        // request; then the calendar's and EVENTS', and Home commits what
        // disk had as its first frame (docs/CACHING.md).
        workWatch.start()
        commercialWatch.start()
        starredWatch.start()
        quickNotesWatch.start()
        if ownerSessionStore.expectsOwnerSession {
            meetingViewController.paintHomeSnapshots()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    var isOwnerSignedIn: Bool {
        (try? ownerSessionStore.load()) != nil
    }

    /// The switcher, and nothing after it: Home has no sidebar and no
    /// inspector. The meeting rail and its toggle are the Room window's
    /// (`RoomWindowController`).
    ///
    /// A gear used to live here as a titlebar accessory, because this window
    /// hid its title and drew to the top edge, so the corner opposite the
    /// traffic lights was the only chrome it had. It has a real toolbar now,
    /// and Settings is a ⌘, in the app menu the way macOS keeps it — a second
    /// route in every window's corner was one more thing that made the three
    /// windows look like three apps.
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.meetSurfaces, .flexibleSpace]
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
        case .meetSurfaces: return surfaceSwitcher.item()
        default: return nil
        }
    }

    @objc func showSettings(_ sender: Any?) {
        settingsWindowController.show()
    }

    /// ⌘K, from the menu. Signed-out, the palette has nothing to ask.
    func showSearch() {
        guard isOwnerSignedIn else { return }
        searchPanelController.toggle(over: NSApp.keyWindow ?? window)
    }

    /// Settings, open on the Calendar page — where a calendar is connected.
    func showCalendarSettings() {
        settingsWindowController.show()
        settingsWindowController.settingsViewController.showCalendarSettings()
    }

    /// Home's gear: Settings on the Home page, where the modules are
    /// ordered and switched.
    func showHomeSettings() {
        settingsWindowController.show()
        settingsWindowController.settingsViewController.show(page: .home)
    }

    @objc func showCalendar(_ sender: Any?) {
        guard isOwnerSignedIn else { return }  //
        calendarWindowController.show(relativeTo: window)
    }

    func showCalendarToday(_ sender: Any? = nil) {
        guard isOwnerSignedIn else { return }  //
        calendarWindowController.show(relativeTo: window, focusToday: true)
    }

    /// Calendar, open on one event — what a click on a Home row does.
    func showCalendar(revealing event: CalendarEventSummary) {
        guard isOwnerSignedIn else { return }  //
        calendarWindowController.show(relativeTo: window, revealing: event)
    }

    /// Open Team, the people and actors destination. The old method name stays
    /// as a compatibility shim for notification/menu callers while they move.
    func showTeam(_ sender: Any? = nil) {
        guard isOwnerSignedIn else { return }  //
        teamWindowController.show(relativeTo: window)
    }

    func showWorkTeam() {
        showTeam(nil)
    }

    /// A message banner opens the conversation it announced, not the Team
    /// lounge. `show` renders the rail first, so the thread lists are in
    /// place before the lookup.
    ///
    /// The one permalink route: Home's Messages rows, banners and
    /// search results land here and arrive scrolled to the line, flashed once.
    /// `title` opens a thread no conversation list holds (a guest thread on
    /// intake) by id; without it, an unknown id leaves Team on the lounge.
    func showConversation(threadID: String, title: String? = nil, focus: MessageFocus = .newest) {
        guard isOwnerSignedIn else { return }  //
        teamWindowController.show(relativeTo: window)
        teamWindowController.teamViewController.openThread(id: threadID, title: title, focus: focus)
    }

    /// Open a direct message named by a person row in another surface.
    func showConversation(peerEmail: String) {
        guard isOwnerSignedIn else { return }  //
        teamWindowController.show(relativeTo: window)
        teamWindowController.teamViewController.openPeer(email: peerEmail)
    }

    func showKeep() {
        guard isOwnerSignedIn else { return }  //
        keepWindowController.show(relativeTo: window)
    }

    /// Keep, on one project's vault — made on the way in if there is none.
    func showKeep(project: CrmSubject) {
        guard isOwnerSignedIn else { return }  //
        keepWindowController.show(relativeTo: window)
        Task { @MainActor in
            let session = keepAccess.session
            guard session.isUnlocked else { return }
            if let id = try? await session.ensureVault(forProject: project.id, named: project.title) {
                session.requestedVaultId = id
            }
        }
    }

    func showDocs(_ sender: Any? = nil) {
        guard isOwnerSignedIn else { return }  //
        docsWindowController.show(relativeTo: window)
    }

    /// One document by id, in the Docs window: the ⌘K palette's document
    /// door and a wikilink's.
    func openDocument(id: String, title: String) {
        showDocs(nil)
        docsWindowController.docsViewController.open(documentID: id, title: title)
    }

    @objc func showWork(_ sender: Any?) {
        guard isOwnerSignedIn else { return }  //
        workWindowController.show(relativeTo: window)
    }

    func newWorkProject() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.newProjectFromMenu()
    }

    func newWorkLead() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.newLeadFromMenu()
    }

    func newWorkTask() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.newTaskFromMenu()
    }

    func newWorkIssue() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.newIssueFromMenu()
    }

    func newWorkDocument() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.newDocumentFromMenu()
    }

    func newWorkQuickNote() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.newQuickNotePressed()
    }

    func searchWorkDocs() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.searchDocsFromMenu()
    }

    func showWorkOverview() {
        guard isOwnerSignedIn else { return }  //
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.showOverview()
    }

    func showWorkBrowse() {
        guard isOwnerSignedIn else { return }  //
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.showBrowse()
    }

    func workBack() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.goBack()
    }

    func workForward() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.goForward()
    }

    private func didSaveQuickNote(_ note: QuickNote) {
        quickNotesWatch.adopt(note)
        workWindowController.workViewController.refreshInboxNow()
    }

    /// Saved on this Mac at once and sent behind it, so the
    /// composer clears with or without a connection.
    private func saveQuickNote(_ body: String) {
        if quickNotesWatch.create(body: body) {
            meetingViewController.markQuickNoteSaved()
        } else {
            meetingViewController.setQuickNoteSaving(false, error: String(localized: "Sign in to save Quick Notes."))
        }
    }

    private func updateQuickNote(_ note: QuickNote, body: String) {
        meetingViewController.setQuickNoteSaving(true)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await quickNotesWatch.update(id: note.id, body: body)
                meetingViewController.markQuickNoteSaved()
            } catch {
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t save Quick Note")
                meetingViewController.setQuickNoteSaving(false, error: message)
            }
        }
    }

    private func deleteQuickNote(_ note: QuickNote) {
        meetingViewController.setQuickNoteSaving(true)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await quickNotesWatch.delete(id: note.id)
                meetingViewController.setQuickNoteSaving(false)
            } catch {
                let message = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t delete Quick Note")
                meetingViewController.setQuickNoteSaving(false, error: message)
            }
        }
    }

    private func moveQuickNote(_ note: QuickNote, to workspace: StarlingsWorkspace) {
        meetingViewController.setQuickNoteSaving(true)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await quickNotesWatch.move(id: note.id, to: workspace)
                meetingViewController.setQuickNoteSaving(false)
            } catch {
                meetingViewController.setQuickNoteSaving(false, error: QuickNoteMove.failure(error, to: workspace))
            }
        }
    }

    func meetAboutSelectedWork() {
        workWindowController.show(relativeTo: window)
        workWindowController.workViewController.meetAboutSelectedFromMenu()
    }

    /// A Home WORK row's menu choice. The Work window carries it out — it
    /// owns the API, the sheets and the refresh — and is brought forward only
    /// when the action opens something there. A write that only has to leave
    /// INBOX runs with the window wherever it is.
    private func performHomeWorkAction(_ action: WorkRowAction) {
        switch action {
        case .open(let destination, _):
            showWork(destination)
        case .openDocument, .fileNote, .startLead, .openDecision, .openQuestion:
            workWindowController.show(relativeTo: window)
            workWindowController.workViewController.performRowAction(action)
        default:
            workWindowController.workViewController.performRowAction(action)
        }
    }

    /// Work, opened on a named subject and pane — from a Home row, the menu
    /// bar, or later a filed meeting.
    func showWork(_ destination: WorkDestination) {
        guard isOwnerSignedIn else { return }  //
        workWindowController.show(relativeTo: window, destination: destination)
    }

    /// Work, on Mine. A destination inside Work rather than a window of its
    /// own — see docs/WORK.md §5c.
    func showWorkMine(taskID: String? = nil) {
        showWork(.mine(taskID: taskID))
    }

    /// Knock on a colleague's room, from wherever the decision was made: the
    /// Team roster, the menu bar, or a ring notification.
    ///
    /// Call *is* the deliberate act — opening a roster still rings nobody — so
    /// it knocks rather than filling in a form for the person to submit. The
    /// knock still goes through the Join surface, which already owns identity,
    /// devices, and the admission contract; a call must not become a second way
    /// into a room.
    /// Two different things wear one button, and which one you get depends on
    /// whether there is a room to walk into.
    ///
    /// **A meeting is running** — knock, and walk in. `memberAdmission` at the
    /// Worker lets a verified member past the queue, so this is already one
    /// click, and it stays exactly as it was.
    ///
    /// **They are only available** — there is nothing to join yet, and the old
    /// behaviour parked the caller in a lobby waiting for a room somebody had
    /// not decided to open. Ask instead: they get Open room / Not now, and we
    /// walk in on our own the moment their room is live.
    /// See docs/SURFACES.md §Reaching a person.
    ///
    /// Every plan ends in a room, a request, or a line that says why not
    ///. A row menu is built from an older roster, so the plan is
    /// read from the newest one.
    func callPeer(_ peer: Peer) {
        let current = peerWatch.roster.peers.first {
            $0.email.caseInsensitiveCompare(peer.email) == .orderedSame
        } ?? peer
        switch current.callPlan {
        case .join(let slug):
            callRoom(slug: slug)
        case .ask(let slug):
            peerWatch.call(current, slug: slug)
        case .unavailable(let reason):
            teamWindowController.teamViewController.reportCallProgress(reason, tone: .danger)
        }
    }

    /// Call from the menu bar. The menu bar has no window of its own to say
    /// anything in, so Team comes forward first and carries the progress.
    func callPeerFromMenuBar(_ peer: Peer) {
        showTeam(nil)
        callPeer(peer)
    }

    /// Wave somebody from the menu bar's Team contact submenu. The actual
    /// request stays on the app-wide watch so it shares the same owner session
    /// and API path as the Team surface.
    func wavePeer(email: String) {
        peerWatch.wave(peerEmail: email)
    }

    func callRoom(slug: String) {
        let owner = try? ownerSessionStore.load()
        // Team can invoke this while the meeting window is hidden. Force the
        // meeting view to wire its phase and media callbacks before the async
        // join starts, otherwise a fast internal-room admission can connect
        // before the control row exists and leave live controls hidden.
        meetingViewController.loadViewIfNeeded()
        let knocked = meetingViewController.callRoom(
            slug: slug,
            name: owner?.owner.name ?? "",
            email: owner?.owner.email ?? ""
        )
        showMeetingWindow()
        // Mid-meeting, Call stops short of the knock. Say so, or the window
        // comes forward and nothing seems to happen.
        if !knocked {
            StarlingsToast.show(
                String(localized: "Leave this call first"),
                in: roomWindowController.isShowing ? roomWindowController.window : window
            )
        }
    }

    /// "Not now". The ring is cleared at the Worker as well as locally, so the
    /// caller stops waiting instead of watching a request time out.
    func dismissIncomingRing() {
        Task { await peerWatch.clearRing() }
    }

    /// A colleague called and you said yes, from the banner. Opens your room —
    /// the caller walks in by themselves once it is live.
    func openRoomForWalkUp() {
        meetingViewController.loadViewIfNeeded()
        meetingViewController.openRoomForWalkUp()
        showMeetingWindow()
    }

    /// The member said yes to their own Claude's ask.
    func openRoomForAgentAsk() {
        meetingViewController.loadViewIfNeeded()
        meetingViewController.openRoomForAgentAsk()
        showMeetingWindow()
    }

    /// Admit or decline from a knock notification's action button, without the
    /// person having to find the window the queue lives in.
    func decideWaitingGuest(requestID: String, admit: Bool) {
        meetingViewController.decideWaitingGuest(requestID: requestID, admit: admit)
        if admit { showMeetingWindow() }
    }

    @objc func newCalendarEvent(_ sender: Any?) {
        calendarWindowController.show(relativeTo: window, createEvent: true)
    }

    /// Where the room is: the Room window while the stage stands, Home
    /// otherwise, where YOUR ROOM and the waiting room are.
    func showMeetingWindow() {
        if meetingViewController.isStageVisible, !showingOnboarding || guestJoinRequested {
            roomWindowController.show()
        } else {
            showHome()
        }
    }

    /// Home, the surface: ⌘1 and the switcher. Never the Room window.
    func showHome() {
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    /// The stage's visibility can flip more than once in one pass (sign-out
    /// clears the session, then onboarding goes up), so the window follows
    /// on the next turn of the run loop, once the pass has settled.
    private func scheduleRoomSync() {
        guard !roomSyncScheduled else { return }
        roomSyncScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            roomSyncScheduled = false
            syncRoomWindow()
        }
    }

    /// Open the Room window when the stage has something to show, close it
    /// when it has not. Onboarding hides the stage unless the person chose
    /// to join as a guest. Closing it while the meeting runs is allowed: the
    /// meeting goes on, and Home's Start says Open meeting.
    private func syncRoomWindow() {
        let wanted = meetingViewController.isStageVisible && (!showingOnboarding || guestJoinRequested)
        if wanted {
            guard !roomWindowController.isShowing else { return }
            roomWindowController.window?.subtitle = meetingViewController.isHostRole
                ? String(localized: "Host")
                : String(localized: "Join")
            roomWindowController.show()
        } else if roomWindowController.isShowing {
            let roomWasKey = roomWindowController.window?.isKeyWindow ?? false
            roomWindowController.hide()
            if roomWasKey { showHome() }
        }
    }

    @objc func checkForUpdates(_ sender: Any?) {
        settingsWindowController.show()
        settingsWindowController.settingsViewController.showAboutAndCheckForUpdates()
    }

    @objc func signInFromMenu(_ sender: Any?) {
        if (try? ownerSessionStore.load()) != nil {
            showSettings(sender)
            return
        }
        guard let window else { return }
        Task {
            do {
                let credentials = try await ownerAuthenticator.authenticate(in: window)
                handleSignedIn(credentials)
            } catch {
                present(
                    StarlingsError.wrapping(error, code: "auth.sign_in_failed", title: String(localized: "Sign-in didn’t finish")),
                    in: window
                )
            }
        }
    }

    /// Same contract as `MeetingViewController.present(_:)`: the code and the
    /// raw text go to Console, only the written copy reaches the sheet.
    private func present(_ error: StarlingsError, in window: NSWindow?) {
        StarlingsDiagnosticsLog.shared.record(error, context: "error")
        let alert = NSAlert()
        alert.messageText = error.title
        alert.informativeText = error.message
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "OK"))
        let copyResponse = alert.addCopyErrorButton()
        let handle: (NSApplication.ModalResponse) -> Void = { response in
            if response == copyResponse { StarlingsErrorReport.copy(error) }
        }
        if let window {
            alert.beginSheetModal(for: window, completionHandler: handle)
        } else {
            handle(alert.runModal())
        }
    }

    @objc func signOutFromMenu(_ sender: Any?) {
        // The Worker hears first, best effort, so this Mac's tokens are
        // refused from its next request (docs/ADMIN.md §5a).
        MeetingControlAPI(ownerSessionStore: ownerSessionStore)
            .revokeOwnDeviceBestEffort(deviceID: ownerSessionStore.deviceID())
        do {
            try ownerSessionStore.clear()
            // This workspace's caches only: another signed-in workspace keeps
            // its own (slice G).
            WorkspaceSignOut.purgeLocalData(allWorkspaces: false)
            // A running recording stops, and no capture waits for whoever
            // signs in next.
            AmbientCaptureController.ownerSignedOut()
            handleSignedOut()
        } catch {
            present(StarlingsError.wrapping(error, code: "auth.sign_out_failed", title: String(localized: "Couldn’t sign out")), in: window)
        }
    }

    /// Sign out of every workspace on this Mac (slice G): each one's session,
    /// with its own Worker told first, best effort, then every cache and
    /// capture. The app stays on the active workspace, signed out.
    @objc func signOutOfAllWorkspacesFromMenu(_ sender: Any?) {
        let store = StarlingsWorkspaceStore.shared
        do {
            for workspace in store.known {
                let sessions = OwnerSessionStore(scope: WorkspaceScope(workspace))
                MeetingControlAPI(apiBaseURL: workspace.apiBaseURL, ownerSessionStore: sessions, webOrigin: workspace.webOrigin)
                    .revokeOwnDeviceBestEffort(deviceID: sessions.deviceID())
                try sessions.clear()
            }
            WorkspaceSignOut.purgeLocalData(allWorkspaces: true)
            AmbientCaptureController.ownerSignedOut(allWorkspaces: true)
            // Every row stays, signed out: the door lists them.
            handleSignedOut()
        } catch {
            present(StarlingsError.wrapping(error, code: "auth.sign_out_failed", title: String(localized: "Couldn’t sign out")), in: window)
        }
    }

    func presentInitialSurface() {
        let store = ownerSessionStore
        // A link that chose this workspace before the relaunch.
        let carried = StarlingsWorkspaceLink.takeCarried()
        Task { @MainActor [weak self] in
            let credentials = await Task.detached(priority: .userInitiated) {
                try? store.load()
            }.value
            guard let self else { return }
            if let credentials {
                if self.showingOnboarding {
                    self.showMeeting(asGuest: false)
                } else {
                    // Home is already up; fill in who is signed in.
                    self.meetingViewController.applyOwnerSession(credentials)
                }
                if let carried {
                    self.showMeeting(asGuest: true)
                    self.meetingViewController.applyCarriedLink(carried)
                }
            } else {
                if !self.showingOnboarding {
                    // The hint was stale: the item is gone.
                    self.meetingViewController.clearOwnerSession()
                    self.showOnboarding()
                }
                if let carried { self.onboarding?.applyCarriedLink(carried) }
            }
            // A switch or an add relaunched the app: say where the person is.
            if let name = StarlingsWorkspaceStore.shared.takeArrival() {
                StarlingsToast.show(String(localized: "You’re in \(name)"), in: self.window)
            }
        }
    }

    /// Home as host, drawn before the Keychain has been asked. Identical to
    /// `showMeeting(asGuest: false)` minus the synchronous session read;
    /// `presentInitialSurface` supplies or retracts the session afterwards.
    private func showHomeAwaitingSession() {
        showingOnboarding = false
        guestJoinRequested = false
        setMemberChrome(visible: true)
        showSurface(homeViewController, subtitle: "")
        meetingViewController.enterHostMode()
    }

    /// Finish the app-wide wiring after Home is already on screen. Settings
    /// owns several integrations and must not delay the first window.
    func prepareForAppLaunch() {
        wireSettings()
        // The workspace's current name and mark, from its descriptor.
        Task { await StarlingsWorkspaceStore.shared.refresh() }
    }

    func showOnboarding() {
        showingOnboarding = true
        guestJoinRequested = false
        scheduleRoomSync()
        setMemberChrome(visible: false)
        let onboarding = OnboardingViewController(authenticator: ownerAuthenticator)
        self.onboarding = onboarding
        onboarding.onSignedIn = { [weak self] credentials in
            self?.handleSignedIn(credentials)
        }
        onboarding.onContinueAsGuest = { [weak self] name, email, room in
            self?.guestJoinRequested = true
            self?.meetingViewController.applyGuestIdentity(name: name, email: email, room: room)
            self?.showMeeting(asGuest: true)
        }
        showSurface(onboarding, subtitle: "")
    }

    /// Host: Home with your room on it. Join: the Room window with the Join
    /// form, over Home for a member, over the sign-in card for a guest.
    func showMeeting(asGuest: Bool) {
        let signedIn = (try? ownerSessionStore.load()) != nil
        if !asGuest || signedIn {
            showingOnboarding = false
            guestJoinRequested = false
            setMemberChrome(visible: true)
            showSurface(homeViewController, subtitle: "")
        }
        meetingViewController.applyStoredOwnerSession()
        if asGuest {
            // A guest join asked for while signed out stands over the sign-in card.
            if !signedIn { guestJoinRequested = true }
            meetingViewController.enterJoinMode()
            scheduleRoomSync()
            DispatchQueue.main.async { [weak self] in self?.showMeetingWindow() }
        } else {
            meetingViewController.enterHostMode()
            showWindow(nil)
        }
    }

    /// Swaps what the window shows without letting it resize itself.
    ///
    /// Assigning `contentViewController` re-sizes the window to the incoming
    /// view's fitting size — which is neither the size launched at nor the one
    /// the participant dragged to, so signing in used to shrink the window to
    /// whatever the meeting body happened to need. The frame belongs to the
    /// participant, not to the surface currently inside it.
    ///
    /// The window is always called Home; anything urgent about it, such as
    /// guests waiting, is the subtitle, the way Work names the subject it is
    /// reading. The mode (Host or Join) is the Room window's subtitle.
    private func showSurface(_ controller: NSViewController, subtitle: String) {
        guard let window else { return }
        let size = window.contentRect(forFrameRect: window.frame).size
        window.contentViewController = controller
        window.setContentSize(size)
        // The floor belongs to whatever is now inside the window — onboarding
        // and the meeting do not need the same room.
        StarlingsWindowMetrics.refresh(window)
        window.title = StarlingsSurface.meet.title
        window.subtitle = subtitle
    }

    func handleSignedIn(_ credentials: OwnerSessionCredentials) {
        meetingViewController.applyOwnerSession(credentials)
        quickNotesWatch.refreshNow()
        commercialWatch.refreshNow()
        starredWatch.refreshNow()
        showMeeting(asGuest: false)
        settingsWindowController.settingsViewController.refresh()
        linkSignedInServices()
    }

    /// Docs and Keep come with the Meet session: no Connect step in Settings.
    /// Run at launch and after each sign-in, only while an owner is signed in.
    private func linkSignedInServices() {
        guard (try? ownerSessionStore.load()) != nil else { return }
        Task { await docsSession.ensureLinked() }
        Task { await keepAccess.ensureLinked() }
        loadHomeWorkModules()
    }

    /// Home follows the workspace's work modules: the last known
    /// answer first, then the Worker's. They change when an admin turns one
    /// on or off, so a launch and a sign-in are the moments to read them.
    private func loadHomeWorkModules() {
        let api = MeetingControlAPI(ownerSessionStore: ownerSessionStore)
        if let cached = api.snapshot(MeetingControlAPI.subjectStateSnapshotKey, as: SubjectStateResponse.self) {
            meetingViewController.setWorkModules(cached.value.workModules)
        }
        Task { [weak self] in
            guard let state = try? await api.crmSubjectState() else { return }
            self?.meetingViewController.setWorkModules(state.workModules)
        }
    }

    /// Signed out, no member destination is visible (docs/SURFACES.md):
    /// the surface switcher goes with the toolbar that holds it. Passed in,
    /// not read from the Keychain, so the first frame never waits on it.
    private func setMemberChrome(visible: Bool) {
        window?.toolbar?.isVisible = visible
    }

    /// Calendar, Work, Team, Docs and Keep close on sign-out. By
    /// type, so a window that was never opened is not made to close it.
    private func closeMemberWindows() {
        for window in NSApp.windows {
            switch window.windowController {
            case is CalendarWindowController, is WorkWindowController, is TeamWindowController,
                 is DocsWindowController, is KeepWindowController:
                window.close()
            default:
                break
            }
        }
    }

    func handleSignedOut() {
        closeMemberWindows()
        meetingViewController.clearOwnerSession()
        Task { await coreSession.ownerSignedOut() }
        docsSession.ownerSignedOut()
        keepAccess.ownerSignedOut()
        showOnboarding()
        settingsWindowController.settingsViewController.refresh()
        // Another signed-in workspace takes over; the app relaunches on it.
        WorkspaceSignOut.moveToNextWorkspace(hasSession: WorkspaceAccounts.hasSession)
    }

    /// The server stopped honouring the stored session and the API layer
    /// dropped it. Without this, the launch surface kept the email, the
    /// upcoming list and a live Start button off a Keychain item that was
    /// already gone, while Settings and Work — which read it fresh — said
    /// "not signed in". Same redraw as sign-out; a live room is left alone,
    /// since its lease is what will fail next and that path has its own copy.
    @objc private func ownerSessionDidExpire() {
        closeMemberWindows()
        meetingViewController.clearOwnerSession()
        Task { await coreSession.ownerSignedOut() }
        docsSession.ownerSignedOut()
        keepAccess.ownerSignedOut()
        settingsWindowController.settingsViewController.refresh()
        if meetingViewController.isBetweenMeetings, !showingOnboarding {
            showOnboarding()
        }
    }

    private func wireSettings() {
        // How this Mac asks its Worker for a Core token. Wired here rather
        // than in the property: a closure with an actor of its own cannot sit
        // in a lazy initializer.
        let coreAPI = MeetingControlAPI(ownerSessionStore: ownerSessionStore)
        let deviceName = coreSession.deviceName
        coreSession.broker = { try await coreAPI.coreToken(deviceName: deviceName) }
        Task { await coreSession.refreshIfNeeded() }
        // Docs rides on the owner session: renew it when it is
        // near its end, then hand it over. A rejected session is the
        // renewer's to report, as for every other request.
        docsSession.broker = {
            await OwnerSessionRenewer.shared.renewIfNeeded()
            return DocsOwnerSession(OwnerSessionStore())
        }
        // Documents that floated when the app quit come back with it.
        FloatingDocuments.shared.configure(api: coreAPI, docs: docsSession, core: coreSession)
        keepAccess.broker = { try await coreAPI.keepToken(deviceName: deviceName) }
        linkSignedInServices()
        let settings = settingsWindowController.settingsViewController
        meetingViewController.onUpdateAction = { [weak self] in
            self?.handleUpdateBannerAction()
        }
        // Update on an error a retired route sent runs the same update.
        updateRequestedObserver = NotificationCenter.default.addObserver(
            forName: StarlingsUpgradeRecommendation.updateRequestedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.handleUpdateBannerAction() }
        }
        settings.onSessionChanged = { [weak self] credentials in
            guard let self else { return }
            if let credentials {
                self.meetingViewController.applyOwnerSession(credentials)
                self.quickNotesWatch.refreshNow()
                self.commercialWatch.refreshNow()
                self.starredWatch.refreshNow()
                self.linkSignedInServices()
                if self.showingOnboarding {
                    self.showMeeting(asGuest: false)
                }
            } else {
                self.meetingViewController.clearOwnerSession()
                self.quickNotesWatch.refreshNow()
                self.commercialWatch.refreshNow()
                self.starredWatch.refreshNow()
            }
        }
        settings.onSignOut = { [weak self] in
            self?.handleSignedOut()
        }
    }

    private func handleUpdateBannerAction() {
        settingsWindowController.show()
        if UpdateCheck.canSelfUpdate {
            settingsWindowController.settingsViewController.installAvailableUpdateFromBanner()
        } else {
            settingsWindowController.settingsViewController.showAboutAndCheckForUpdates()
        }
    }
}

// MARK: - Search doors

extension MainWindowController: SearchNavigating {
    /// Every door names a window this controller already opens, or a verb a
    /// menu item already runs. Nothing here invents navigation.
    func searchOpen(_ row: SearchRow, verb: SearchRowVerb?) {
        switch row.door {
        case .destination(let destination):
            switch destination {
            case .home: showMeetingWindow()
            case .calendar: showCalendar(nil)
            case .work: showWork(nil)
            case .team: showTeam(nil)
            case .docs: showDocs(nil)
            }
        case .settings(let page):
            settingsWindowController.show()
            settingsWindowController.settingsViewController.show(page: page.settingID)
        case .verb(let verbName):
            switch verbName {
            case .newTask: newWorkTask()
            case .newIssue: newWorkIssue()
            case .newDocument: newWorkDocument()
            case .startRoom:
                meetingViewController.loadViewIfNeeded()
                if meetingViewController.canStartHostRoom { meetingViewController.toggleMeeting(nil) }
                showMeetingWindow()
            case .openInternalRoom:
                meetingViewController.loadViewIfNeeded()
                guard meetingViewController.startInternalRoom() else { return }
                showMeetingWindow()
            }
        case .subject(let kind, let id):
            let subject = CrmSubject(id: id, kind: kind.rawValue, title: row.title, subtitle: nil)
            // A subject verb: the subject's own editor, or a room
            // filed under it, instead of the subject's page.
            switch verb {
            case .subject(.newTask): showWork(WorkDestination(subject: subject, pane: .tasks, action: .newTask))
            case .subject(.newIssue): showWork(WorkDestination(subject: subject, pane: .issues, action: .newIssue))
            case .subject(.newDocument): showWork(WorkDestination(subject: subject, pane: .talk, action: .newDocument))
            case .subject(.startRoom):
                meetingViewController.loadViewIfNeeded()
                if meetingViewController.startRoom(filedAs: subject) { showMeetingWindow() }
            case .person, nil:
                showWork(WorkDestination(subject: subject))
            }
        case .person(let email), .agent(let email):
            showTeam(nil)
            let team = teamWindowController.teamViewController
            switch verb {
            case .person(.wave):
                wavePeer(email: email)
                team.openPeer(email: email)
            case .person(.call):
                if let peer = team.peer(email: email), peer.isCallable {
                    callPeer(peer)
                } else {
                    team.openPeer(email: email)
                }
            case .person(.message), .subject, nil:
                team.openPeer(email: email)
            }
        case .contact(let id):
            showWork(.contact(id: id))
        case .thread(let id):
            showConversation(threadID: id)
        case .document(let id):
            openDocument(id: id, title: row.title)
        case .folder(let id):
            showDocs(nil)
            docsWindowController.docsViewController.open(folderID: id)
        case .event(let reference):
            showCalendar(nil)
            calendarWindowController.calendarViewController.reveal(eventReference: reference)
        case .task(let id):
            showWorkMine(taskID: id)
        case .issue(let id):
            // Work reads the issue in its own column, like the web (#225);
            // github.com only for a reference that does not parse.
            if let destination = WorkDestination.issue(reference: id) {
                showWork(destination)
                return
            }
            let parts = id.split(separator: "#", maxSplits: 1)
            guard parts.count == 2, let url = URL(string: "https://github.com/\(parts[0])/issues/\(parts[1])") else { return }
            NSWorkspace.shared.open(url)
        case .core(let entityID):
            showWork(nil)
            workWindowController.workViewController.showCore(entityID: entityID)
        }
    }
}

private extension SearchSettingsPage {
    var settingID: StarlingsSettingID {
        switch self {
        case .account: .account
        case .home: .home
        case .work: .work
        case .calendar: .calendar
        case .appearance: .appearance
        case .about: .about
        }
    }
}
