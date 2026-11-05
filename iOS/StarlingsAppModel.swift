import Combine
import EnvisioningUI
import Foundation
import StarlingsContracts
import SwiftUI
import UIKit
import UserNotifications

struct PendingThreadFocus: Equatable {
    let threadID: String
    let focus: MessageFocus
}

@MainActor
final class StarlingsAppModel: ObservableObject {
    /// Destinations, and what each one is *about*: Home is today and owns the
    /// room/Meet flow, Calendar is when, Work is the work graph, and Team is
    /// people and actors. Mine remains a first-class view inside Work, not a
    /// fourth destination.
    /// Settings is not a destination — it hangs off Home's toolbar, the way
    /// ⌘, hangs off the Mac.
    enum Tab: Hashable, CaseIterable {
        case home, calendar, work, team, docs

        /// The shared destination; its order and title are `MEMBER_SURFACES`
        /// (Generated/MemberSurfacesRegistry.swift).
        var surface: MemberSurface {
            switch self {
            case .home: .home
            case .calendar: .calendar
            case .work: .work
            case .team: .team
            case .docs: .docs
            }
        }

        var title: String { surface.title }
    }

    @Published var selectedTab: Tab = .home {
        didSet { refreshTabs() }
    }
    /// The tabs the bar lists, in order (`SurfaceVisibility`,
    ///). The selected tab is always listed: a link can open
    /// Calendar while it is hidden, and the bar always names where you are.
    @Published private(set) var tabs: [Tab] = Tab.allCases.filter { SurfaceVisibility.isVisible($0.surface) }
    private var surfaceObservers: [any NSObjectProtocol] = []
    @Published private(set) var isSigningIn = false
    @Published private(set) var isEnteringWorkspace = false
    /// The sign-in in flight, so a second tap can supersede it (see `signIn`).
    private var signInTask: Task<Void, Never>?
    /// The renewal in flight, so a second caller waits for its answer instead
    /// of deciding the session is dead while it is still being renewed.
    private var renewalTask: Task<SessionRenewal, Never>?
    /// The one response to "the Worker refused the token"; every surface that
    /// notices the same thing at the same moment joins it rather than
    /// starting its own, which is what used to stack three identical alerts.
    private var expiredSessionTask: Task<Void, Never>?
    private var sessionRejectionObserver: (any NSObjectProtocol)?

    /// A verified Envisioning session. Home and Calendar exist only with one:
    /// they are the member workspace, not the visitor door.
    var isSignedIn: Bool { ownerCredentials != nil }
    /// Incremented whenever the Calendar tab is selected, including selecting
    /// it again while it is already active. The calendar uses that reselection
    /// as the native-tab equivalent of Calendar.app's Today button.
    @Published private(set) var calendarTabActivation = 0
    @Published var ownerCredentials: MobileOwnerCredentials?
    @Published var pendingJoinInput: String?
    @Published var pendingCallRoom: String?
    /// A colleague's room this member accepted to host: Home opens
    /// it as its host, and the phone takes the host once it is in.
    @Published var pendingColleagueHostRoom: String?
    @Published var pendingWalkUp = false
    /// The member said yes to their own Claude's ask. Distinct from
    /// `pendingWalkUp` because this meeting transcribes: it is convened, with a
    /// title and attendees on the calendar, not a "got a sec?".
    @Published var pendingAgentStart = false
    /// Name and email typed on the first screen, handed to Home's Join flow so the
    /// visitor is not asked for them twice. Same route `pendingJoinInput` takes.
    @Published var pendingGuestIdentity: MobileGuestIdentity?
    @Published var alertMessage: String?
    /// A link for another workspace, waiting for the member to open it there
    /// (slice F). Shown by `meetAlertHost`.
    @Published var linkWorkspaceOffer: LinkWorkspaceOffer?

    struct LinkWorkspaceOffer: Equatable {
        let workspace: StarlingsWorkspace
        let link: String
    }
    /// A place in Work somebody asked to see — a row on Home today, a filed
    /// meeting later. Work takes it on arrival and clears it, so the same
    /// request is honoured whether or not the tab has been built yet.
    @Published var pendingWork: WorkDestination?
    /// A conversation somebody named from Home or a notification. Team owns
    /// the roster and consumes this when its tab is built.
    @Published var pendingTeamThreadID: String?
    var pendingTeamThreadTitle: String?
    /// Where that conversation lands once it is open: scrolled to the line
    /// and flashed once. The thread view consumes it.
    @Published var pendingThreadFocus: PendingThreadFocus?
    /// A person or agent the ⌘K palette named, with the verb it asked for
    /// ( decision 7). Team consumes it when the roster can answer.
    @Published var pendingTeamPeer: PendingTeamPeer?
    /// A document the palette named. Docs consumes it when its tab is built.
    @Published var pendingDocument: PendingDocument?
    @Published var pendingDocsFolderID: String?
    /// The New quick note control was pressed. The QUICK NOTES card on Home
    /// opens its field and clears this.
    @Published var pendingQuickNote = false
    /// An event a Home row or the palette named. Calendar pages to its day,
    /// opens it, and clears this — whether or not the tab has been built yet.
    @Published var pendingCalendarEvent: CalendarOpenRequest?
    /// A Settings page the palette or a surface menu named; `nil` is the
    /// root. Whichever tab is showing presents the sheet on it.
    @Published var pendingSettingsPage: StarlingsSettingID?
    @Published var isSettingsPresented = false
    /// The palette's verbs that a tab performs: Start room on Home, the
    /// internal room on Team.
    @Published var pendingHostRoom = false
    @Published var pendingInternalRoom = false
    /// Search, presented over whichever tab asked ( decision 2).
    @Published var isSearchPresented = false

    struct PendingTeamPeer: Equatable {
        let email: String
        let verb: SearchPersonVerb?
    }

    /// Start room about this: Home hosts the owner's room filed
    /// under the subject the palette named.
    @Published var pendingHostRoomFiling: CrmSubject?

    struct PendingDocument: Hashable {
        let id: String
        let title: String
    }
    /// Shared favorites and their authorized, mixed-kind Home destinations.
    /// Every iOS surface reads and mutates this one app-owned cache.
    @Published private(set) var favorites: [FavoriteRow] = []
    @Published private(set) var starredRows: [SearchRow] = []
    @Published private(set) var favoritesReady = false
    /// Reads that began before a write must not roll the shared cache back.
    private var favoritesRevision = 0
    private var favoritesRefresh: Task<Void, Never>?
    /// Depths of the alert hosts currently mounted (see MobileAlertHost).
    /// Only the deepest one presents, so an error raised from a sheet is shown
    /// by that sheet instead of being swallowed by the covered tab bar.
    @Published private(set) var alertHostDepths: Set<Int> = []

    var topAlertHostDepth: Int? { alertHostDepths.max() }

    func registerAlertHost(depth: Int) { alertHostDepths.insert(depth) }

    func unregisterAlertHost(depth: Int) { alertHostDepths.remove(depth) }

    /// The Keychain, behind a protocol so the renewal rule can be tested
    /// without it.
    let sessionStore: any MobileOwnerSessionKeychain
    /// `.shared` in the app; a stubbed session in tests.
    private let urlSession: URLSession
    let authenticator = MobileGoogleAuthenticator()
    /// Owns the agenda, the next meeting, the T-1 warning, and the Live
    /// Activity. Every surface reads it rather than fetching its own copy.
    let upcoming = UpcomingMeetingsStore()
    private let noticeDelegate = MeetingNoticeDelegate()

    init(
        sessionStore: any MobileOwnerSessionKeychain = MobileOwnerSessionStore(),
        urlSession: URLSession = .shared
    ) {
        self.sessionStore = sessionStore
        self.urlSession = urlSession
        ownerCredentials = try? sessionStore.load()
        // A visitor is rendered by `MobileVisitorRoot`; Home is the member
        // landing destination once the workspace becomes available.
        selectedTab = .home
        // Home's first frame comes from disk, read here, before any view or
        // request exists (docs/CACHING.md).
        upcoming.paintSnapshot(owner: ownerCredentials?.owner.email)
        paintHomeSnapshots()
    }

    /// The stars, as last saved for the signed-in owner. Synchronous and
    /// request-free: the refreshes below replace them in place.
    func paintHomeSnapshots() {
        guard let credentials = ownerCredentials else { return }
        let api = self.api
        if !favoritesReady,
           let cachedFavorites = api.snapshot(StarlingsAPI.favoritesSnapshotKey, credentials: credentials, as: FavoritesResponseWire.self),
           let cachedStarred = api.snapshot(StarlingsAPI.starredSnapshotKey, credentials: credentials, as: SearchResponse.self) {
            favorites = cachedFavorites.value.favorites
            starredRows = SearchAnswer(cachedStarred.value).rows
            favoritesReady = true
        }
    }

    /// Called once from the root scene, after the environment is in place.
    func start() {
        // A link that chose this workspace, carried across the rebuild.
        if let carried = StarlingsWorkspaceLink.takeCarried() { pendingJoinInput = carried }
        noticeDelegate.app = self
        UNUserNotificationCenter.current().delegate = noticeDelegate
        MobileNotices.registerCategories()
        upcoming.attach(to: self)
        // The workspace's name, mark and suite, from its descriptor, as on the Mac.
        // The widgets draw its accent: the saved one now, the fresh one after.
        WidgetAccent.publish(WorkspaceAccent.rgb(.mark, dark: true))
        Task {
            await StarlingsWorkspaceStore.shared.refresh()
            WidgetAccent.publish(WorkspaceAccent.rgb(.mark, dark: true))
        }
        // The watch reads the session and the agenda from here; it never
        // signs in on its own.
        WatchBridgeSession.shared.attach(to: self)
        // The API layer says so from whatever request hit the wall first; the
        // response — renew, or sign out and say why — is the same regardless.
        // A calendar connected or removed, or Apple Calendar switched, can
        // change which tabs are listed.
        surfaceObservers = [StarlingsCalendarSources.didChangeNotification, CalendarSourcePreferences.didChange].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshTabs() }
            }
        }
        sessionRejectionObserver = NotificationCenter.default.addObserver(
            forName: StarlingsAPI.ownerSessionRejectedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.handleExpiredOwnerSession() }
        }
        // A request that meets a dead token renews through here and goes out
        // again with the fresh one, so the screen that asked gets its answer.
        Task {
            await MobileOwnerSessionRenewal.shared.install { [weak self] in
                guard let self else { return nil }
                switch await self.renewSessionIfNeeded(force: true) {
                case .renewed, .stillValid: return await self.ownerCredentials?.accessToken
                case .nothingToRenew, .refused, .unavailable: return nil
                }
            }
        }
        Task {
            await renewSessionIfNeeded()
            await retryPendingArtifacts()
            await drainShareOutbox()
        }
        watchNetworkForPendingArtifacts()
        // Crash and hang reports from earlier runs, from MetricKit.
        // Signed out, a payload is dropped: there is no session to send it with.
        let reporter = MetricKitReporter(platform: .ios) { [weak self] report in
            guard let self, let credentials = await self.ownerCredentials else { return }
            let api = await self.api
            try await api.sendDiagnosticReport(credentials: credentials, report)
        }
        reporter.start()
        metricKitReporter = reporter
    }

    var api: StarlingsAPI { StarlingsAPI(environment: .configured(), session: urlSession) }

    func isFavorite(_ target: FavoriteTarget) -> Bool {
        favorites.contains { FavoriteTargets.matches($0, target) }
    }

    func refreshFavorites() async {
        guard ownerCredentials != nil else {
            favorites = []
            starredRows = []
            favoritesReady = true
            return
        }
        if let favoritesRefresh {
            await favoritesRefresh.value
            return
        }
        let task = Task { await loadFavorites() }
        favoritesRefresh = task
        await task.value
        favoritesRefresh = nil
    }

    private func loadFavorites() async {
        let revision = favoritesRevision
        guard let credentials = ownerCredentials else { return }
        let api = self.api
        // Last known first (docs/CACHING.md): STARRED paints from the
        // snapshot on a cold start (already done at init, unless this is a
        // sign-in).
        paintHomeSnapshots()
        async let favoriteAnswer = try? api.crmFavorites(credentials: credentials)
        async let starredAnswer = try? api.crmStarred(credentials: credentials)
        let (nextFavorites, nextStarred) = await (favoriteAnswer, starredAnswer)
        guard revision == favoritesRevision else { return }
        if let nextFavorites { favorites = nextFavorites }
        if let nextStarred { starredRows = nextStarred.rows }
        favoritesReady = true
    }

    func setFavorite(_ target: FavoriteTarget, starred: Bool) async throws {
        guard let credentials = ownerCredentials else {
            throw StarlingsError.local(String(localized: "Sign in to change favorites."))
        }
        favoritesRevision += 1
        try await api.crmSetFavorite(credentials: credentials, target: target, starred: starred)
        favoritesRevision += 1
        // Past the coalescer: a read already in flight began before the
        // write, and its answer is discarded by the revision check.
        await loadFavorites()
    }

    /// A page asked for an id that was merged into another record
    ///: the recents lose the merged id, and its star moves to the
    /// survivor. Quiet on failure: the old star still opens the survivor.
    func adoptSurvivor(kind: String, mergedID: String, survivor: SearchRow?, survivorID: String) async {
        SearchRecents.replace(mergedID: mergedID, with: survivor, owner: ownerCredentials?.owner.email ?? "")
        guard let merged = FavoriteTargets.crmSubject(kind: kind, id: mergedID),
              let moved = FavoriteTargets.crmSubject(kind: kind, id: survivorID),
              favorites.contains(where: { FavoriteTargets.matches($0, merged) }) else { return }
        try? await setFavorite(moved, starred: true)
        try? await setFavorite(merged, starred: false)
    }

    /// Hosted meetings whose transcript text is still on this phone. Kept
    /// current by the outbox itself after every write, so a segment that
    /// failed to upload during a meeting counts as soon as it fails, not at
    /// the next launch.
    @Published private(set) var pendingArtifactMeetings = 0
    /// Launch and becoming active can both start a drain; the second waits its turn by skipping.
    private var isDrainingShareOutbox = false

    /// The one outbox on this device. `MobileRoomHost` writes into
    /// it while hosting and recovery drains it later, through the same
    /// instance — two instances over the file used to overwrite each other.
    /// The uploader is the session that is current at delivery, so a meeting
    /// that ended signed out goes out with the next sign-in.
    lazy var artifactOutbox: MeetingArtifactOutbox = {
        let outbox = MeetingArtifactOutbox(uploader: { [weak self] in
            guard let self, let credentials = await self.ownerCredentials else { return nil }
            return await MobileTranscriptUploader(api: self.api, credentials: credentials)
        })
        let observer: @Sendable (Int) -> Void = { [weak self] count in
            Task { @MainActor [weak self] in self?.pendingArtifactMeetings = count }
        }
        Task { await outbox.observePendingCount(observer) }
        return outbox
    }()
    /// Fires the retry when the network comes back, so text left by a meeting
    /// that ended in a tunnel goes out without waiting for the next foreground.
    /// The same trigger the Mac uses (`ConnectivityRecovery`).
    private var connectivityRecovery: ConnectivityRecovery?
    private var metricKitReporter: MetricKitReporter?

    private func watchNetworkForPendingArtifacts() {
        guard connectivityRecovery == nil else { return }
        let recovery = ConnectivityRecovery { [weak self] in
            Task { await self?.retryPendingArtifacts() }
        }
        recovery.start()
        connectivityRecovery = recovery
    }

    /// Text a hosted meeting left behind — ended offline, or the app died
    /// before the last upload — goes out with the session that is current
    /// now, not the one the meeting had. Runs after renewal on launch, on
    /// every return to the foreground and when the network comes
    /// back. Through the one outbox: a drain in flight for a meeting the host
    /// is still writing to queues behind it instead of racing it.
    func retryPendingArtifacts() async {
        pendingArtifactMeetings = await artifactOutbox.retryPending()
    }

    /// Pages shared from Safari or another app (`ShareOutbox`): the share
    /// extension has no session, so it leaves them here and the app saves
    /// them on becoming active. Only the active workspace's pages go; the
    /// rest wait for it. A page the Worker refuses (4xx but 429) is dropped,
    /// since it would be refused again; offline, 429 or a 5xx stops the run and keeps it.
    func drainShareOutbox() async {
        ShareOutbox.publish(ownerCredentials == nil ? nil : ShareWorkspace(
            webOrigin: StarlingsWorkspace.active.webOrigin,
            name: StarlingsWorkspace.active.name
        ))
        guard !isDrainingShareOutbox, let credentials = ownerCredentials else { return }
        isDrainingShareOutbox = true
        defer { isDrainingShareOutbox = false }
        let origin = StarlingsWorkspace.active.webOrigin
        for item in ShareOutbox.pending() where item.workspaceOrigin == origin {
            guard let url = URL(string: item.url) else {
                ShareOutbox.remove(item.id)
                continue
            }
            do {
                _ = try await api.saveDocsLink(
                    url: url,
                    folderPath: nil,
                    subjects: [],
                    title: item.title,
                    note: item.note,
                    pageHTML: item.pageHTML,
                    credentials: credentials
                )
                ShareOutbox.remove(item.id)
            } catch let error as StarlingsError where (400..<500).contains(error.status ?? 0) && error.status != 429 && !error.isSessionRefusal {
                ShareOutbox.remove(item.id)
            } catch {
                return
            }
        }
    }

    /// A knock answered from the banner — on the phone, or on the watch where
    /// the banner mirrors. Same Worker call as the waiting room's Admit; the
    /// lobby watch's own list catches up on its next poll. A failure is told
    /// through a second banner because the first is already gone.
    func admitKnock(room: String, requestID: String, name: String) async {
        guard let credentials = ownerCredentials else { return }
        do {
            try await api.decideWaitingGuest(
                credentials: credentials,
                room: room,
                requestID: requestID,
                admit: true
            )
            KnockNotices.withdraw()
        } catch {
            await KnockNotices.deliverFailure(name: name)
        }
    }

    /// Host a room filed under `subject`: the search verb's door and the Work row menu's
    /// **Meet about this**. Home starts the room and files it as soon as it exists.
    func startRoom(about subject: CrmSubject) {
        pendingHostRoomFiling = subject
        pendingHostRoom = true
        selectTab(.home)
    }

    private func refreshTabs() {
        let listed = Tab.allCases.filter { $0 == selectedTab || SurfaceVisibility.isVisible($0.surface) }
        if listed != tabs { tabs = listed }
    }

    func selectTab(_ tab: Tab) {
        // Signed out, a link or a Control Center action does not pick the tab
        // the app opens on after sign-in.
        guard isSignedIn else { return }
        if tab == .calendar {
            calendarTabActivation &+= 1
        }
        selectedTab = tab
    }

    /// Settings over the current tab, opened on `page` or on the root.
    func openSettings(page: StarlingsSettingID? = nil) {
        pendingSettingsPage = page
        isSettingsPresented = true
    }

    /// Open a project or lead in Work, from wherever it was named. The subject
    /// is the object; its conversation, tasks and issues are views on it, and
    /// the pane is the reason somebody tapped.
    func openWork(subject: CrmSubject, pane: WorkPane = .talk) {
        guard isSignedIn else { return }  //
        pendingWork = WorkDestination(subject: subject, pane: pane)
        selectTab(.work)
    }

    /// Work, on Mine — optionally reading one of your own rows. Mine is a
    /// destination inside Work rather than a tab of its own (docs/WORK.md
    /// §5c), and it is the only place a task with no subject can be read.
    func openMine(taskID: String? = nil) {
        pendingWork = .mine(taskID: taskID)
        selectTab(.work)
    }

    /// Docs, reading one document — from the palette, or an INBOX comment.
    func openDocument(id: String, title: String) {
        pendingDocument = PendingDocument(id: id, title: title)
        selectTab(.docs)
    }

    /// Docs folder favorites store a durable id; the Docs tab resolves the
    /// current path through its authenticated folder tree before selecting it.
    func openDocsFolder(id: String) {
        pendingDocsFolderID = id
        selectTab(.docs)
    }

    /// Calendar, open on one event. Does not bump `calendarTabActivation`:
    /// that is Today, and this row is not necessarily today.
    func openCalendar(event: MobileCalendarEvent) {
        guard isSignedIn else { return }  //
        pendingCalendarEvent = .feed(event)
        selectedTab = .calendar
    }

    /// Calendar, open on the event a search door names. The door carries
    /// `<calendarId>:<eventId>` and no date, so Calendar finds the day.
    func openCalendar(eventReference: String) {
        guard isSignedIn else { return }  //
        pendingCalendarEvent = .reference(eventReference)
        selectedTab = .calendar
    }

    /// Open a people/agent conversation in Team. The id is optional because a
    /// plain Team route is also useful when the source only knows the surface.
    ///
    /// The one permalink route on the phone: Home's Messages card,
    /// a banner and a search result all arrive here, and the conversation
    /// opens on the line the row previewed.
    /// `title` opens a thread no conversation list holds (a guest thread on
    /// intake) by id; without it, Team opens only a thread its lists know.
    func openTeam(threadID: String? = nil, title: String? = nil, focus: MessageFocus = .newest) {
        pendingTeamThreadTitle = title
        pendingTeamThreadID = threadID
        pendingThreadFocus = threadID.map { PendingThreadFocus(threadID: $0, focus: focus) }
        selectTab(.team)
    }

    /// Open the direct message named by a Work person row. Team resolves the
    /// address against its shared roster before pushing the conversation.
    func openTeam(peerEmail: String) {
        pendingTeamPeer = PendingTeamPeer(email: peerEmail, verb: nil)
        selectTab(.team)
    }

    /// Where a search row goes on the phone. Every door names a
    /// tab and a pending request a tab already honours; nothing here invents
    /// navigation. Verbs the phone cannot perform from a bare row (New task,
    /// New issue, New document — each needs a subject or a list) are not
    /// drawn, so they never arrive here.
    func openSearch(_ row: SearchRow, verb: SearchRowVerb?) {
        isSearchPresented = false
        switch row.door {
        case .destination(let destination):
            switch destination {
            case .home: selectTab(.home)
            case .calendar: selectTab(.calendar)
            case .work: selectTab(.work)
            case .team: selectTab(.team)
            case .docs: selectTab(.docs)
            }
        case .settings(let page):
            let id: StarlingsSettingID = switch page {
            case .account: .account
            case .home: .home
            case .work: .work
            case .calendar: .calendar
            case .appearance: .appearance
            case .about: .about
            }
            openSettings(page: id)
        case .verb(let verbName):
            switch verbName {
            case .startRoom:
                pendingHostRoom = true
                selectTab(.home)
            case .openInternalRoom:
                pendingInternalRoom = true
                selectTab(.team)
            case .newTask, .newIssue, .newDocument:
                return
            }
        case .subject(let kind, let id):
            let subject = CrmSubject(id: id, kind: kind.rawValue, title: row.title, subtitle: nil)
            // A subject verb: the subject's own editor, or the
            // room filed under it, instead of the subject's page.
            switch verb {
            case .subject(.newTask):
                pendingWork = WorkDestination(subject: subject, pane: .tasks, action: .newTask)
                selectTab(.work)
            case .subject(.newIssue):
                pendingWork = WorkDestination(subject: subject, pane: .issues, action: .newIssue)
                selectTab(.work)
            case .subject(.newDocument):
                pendingWork = WorkDestination(subject: subject, pane: .talk, action: .newDocument)
                selectTab(.work)
            case .subject(.startRoom):
                startRoom(about: subject)
            case .person, nil:
                openWork(subject: subject)
            }
        case .person(let email), .agent(let email):
            let personVerb: SearchPersonVerb? = if case .person(let named) = verb { named } else { nil }
            pendingTeamPeer = PendingTeamPeer(email: email, verb: personVerb)
            selectTab(.team)
        case .contact(let id):
            pendingWork = .contact(id: id)
            selectTab(.work)
        case .thread(let id):
            openTeam(threadID: id)
        case .document(let id):
            openDocument(id: id, title: row.title)
        case .folder(let id):
            openDocsFolder(id: id)
        case .event(let reference):
            openCalendar(eventReference: reference)
        case .task(let id):
            openMine(taskID: id)
        case .issue(let id):
            // Work reads the issue in the app, like the web (#225); github.com
            // only for a reference that does not parse.
            if let destination = WorkDestination.issue(reference: id) {
                pendingWork = destination
                selectTab(.work)
                return
            }
            let parts = id.split(separator: "#", maxSplits: 1)
            guard parts.count == 2, let url = URL(string: "https://github.com/\(parts[0])/issues/\(parts[1])") else { return }
            UIApplication.shared.open(url)
        case .core(let id):
            // Work opens that entity, like the Mac (#222); the id used to be
            // dropped here and the tab alone selected.
            pendingWork = .coreEntity(id: id)
            selectTab(.work)
        }
    }

    /// Sign in, or start over if a sign-in is already in flight.
    ///
    /// A tap while the button is busy is somebody saying "that one did
    /// nothing", and it used to be the one gesture the app could not hear:
    /// `isSigningIn` stayed true until Google's sheet called back, which a
    /// sheet that never presented never does, so every later tap was refused
    /// until the app was killed. Now the attempt in flight is cancelled and
    /// this one takes its place. The old one is not awaited — an auth session
    /// that never presented may never answer, and waiting on it would be the
    /// same hang with an extra step.
    func signIn() async {
        if let running = signInTask {
            running.cancel()
            authenticator.cancel()
        }
        isSigningIn = true
        let task = Task { await performSignIn() }
        signInTask = task
        await task.value
        // Only the attempt that is still current gets to turn the spinner off;
        // a superseded one finishing late must not switch off its successor's.
        if signInTask == task {
            signInTask = nil
            isSigningIn = false
        }
    }

    /// The workspace's own web sign-in for any workspace but the build's own,
    /// which keeps the native Google flow until.
    private func signInCredentials() async throws -> MobileOwnerCredentials {
        try await signInCredentials(
            for: StarlingsWorkspace.active, api: api, deviceID: sessionStore.deviceID(), requireActive: true
        )
    }

    /// The sign-in itself, for `workspace` through `api`. The add flow
    /// runs it for a workspace that is not active yet, with that
    /// workspace's own API and device id.
    private func signInCredentials(
        for workspace: StarlingsWorkspace, api: StarlingsAPI, deviceID: String, requireActive: Bool
    ) async throws -> MobileOwnerCredentials {
        if workspace.signsInThroughWorkspace {
            // The https callback needs iOS 17.4 (ASWebAuthenticationSession.Callback.https).
            var httpsCallback = false
            if #available(iOS 17.4, *) { httpsCallback = true }
            let attempt = try WorkspaceSignInAttempt(workspace: workspace, httpsCallback: httpsCallback)
            let code = try await authenticator.authorizeThroughWorkspace(attempt)
            try Task.checkCancellation()
            return try await api.redeemNativeSignIn(attempt.redeemRequest(
                code: code,
                client: .ios,
                deviceID: deviceID,
                deviceName: UIDevice.current.name,
                requireActive: requireActive
            ))
        }
        let code = try await authenticator.authorize(purpose: .owner)
        try Task.checkCancellation()
        return try await api.exchangeOwnerCode(
            code: code.code,
            verifier: code.verifier,
            redirectURI: code.redirectURI,
            nonce: code.nonce,
            deviceID: deviceID,
            deviceName: UIDevice.current.name
        )
    }

    /// Signs in to `workspace` without making it active (Add a workspace,
    ///). The pair is saved in that workspace's own Keychain scope,
    /// so the switch that follows lands signed in; a cancel or a refusal
    /// leaves the active workspace as it was. A 403 at redeem is an account
    /// the workspace does not admit.
    func signIn(into workspace: StarlingsWorkspace) async throws {
        let store = MobileOwnerSessionStore()
        let api = StarlingsAPI(environment: MobileOwnerSessionStore.environment(for: workspace), session: urlSession)
        let credentials: MobileOwnerCredentials
        do {
            credentials = try await signInCredentials(
                for: workspace, api: api, deviceID: store.deviceID(workspace: workspace), requireActive: false
            )
        } catch let refused as StarlingsError where refused.status == 403 {
            throw WorkspaceSignInAttempt.Failure.notInvited
        }
        try Task.checkCancellation()
        try store.save(credentials, workspace: workspace)
    }

    private func performSignIn() async {
        do {
            let workspace = StarlingsWorkspace.active
            let credentials = try await signInCredentials()
            // The pair is for the workspace the attempt started on; save it only there.
            guard StarlingsWorkspace.active.webOrigin == workspace.webOrigin else {
                throw WorkspaceSignInAttempt.Failure.workspaceChanged
            }
            // Past this point the pair is ours and single-use: a superseded
            // attempt must not write it over whatever its successor stored.
            try Task.checkCancellation()
            try sessionStore.save(credentials)
            let storedCredentials = try sessionStore.load()

            // Keep both apps on the same visible hand-off: authentication has
            // succeeded, but the first member surface is not ready until its
            // initial data load has had a chance to finish.
            isEnteringWorkspace = true
            ownerCredentials = storedCredentials
            // Home and Calendar have just appeared in the bar. Land on Home:
            // signing in is how a visitor becomes a member, and leaving them on
            // the join door hides the thing they just unlocked.
            selectTab(.home)
            await Task.yield()
            await upcoming.refresh(force: true)
            isEnteringWorkspace = false
        } catch {
            isEnteringWorkspace = false
            // A superseded attempt's cancellation is not news to the person
            // who superseded it; the attempt that replaced it is on screen.
            guard !Task.isCancelled else { return }
            // Cancelling the browser sheet is a choice, not a failure.
            guard !SignInOutcome.isCancel(error) else { return }
            alertMessage = SignInOutcome.plainMessage(for: error).text
        }
    }

    func signOut() {
        // Tell the Worker first, best effort: the row is what makes this
        // phone's tokens dead from its next request, and Settings › Devices
        // on the other devices stops listing it. A phone that is offline
        // still signs out locally; its row falls out at the 60-day sweep or
        // under somebody's Sign out.
        if let credentials = ownerCredentials {
            let api = api
            let deviceID = sessionStore.deviceID()
            Task(priority: .utility) {
                _ = try? await api.revokeOwnerDevice(credentials: credentials, deviceID: deviceID)
            }
        }
        do {
            try sessionStore.clear()
            // This workspace's caches only: another signed-in workspace keeps
            // its own (slice G).
            WorkspaceSignOut.purgeLocalData(allWorkspaces: false)
            ownerCredentials = nil
            selectTab(.home)
            // Another signed-in workspace takes over; the app rebuilds on it.
            WorkspaceSignOut.moveToNextWorkspace(hasSession: MobileWorkspaceSwitch.hasSession)
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    /// Sign out of a workspace that is not the current one: its
    /// Worker is told first, best effort, then its session and caches go.
    /// The row stays, signed out. The current one signs out with `signOut()`.
    func signOut(of workspace: StarlingsWorkspace) {
        guard workspace.webOrigin != StarlingsWorkspace.active.webOrigin else { return }
        let keychain = MobileOwnerSessionStore()
        if let credentials = try? keychain.load(workspace: workspace) {
            let api = StarlingsAPI(environment: MobileOwnerSessionStore.environment(for: workspace), session: urlSession)
            let deviceID = keychain.deviceID(workspace: workspace)
            Task(priority: .utility) {
                _ = try? await api.revokeOwnerDevice(credentials: credentials, deviceID: deviceID)
            }
        }
        do {
            try keychain.clear(workspace: workspace)
            WorkspaceSignOut.purgeLocalData(of: WorkspaceScope(workspace))
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    /// Remove from this phone: a sign-out when it is signed in,
    /// then the row goes. Not for the current workspace.
    func remove(_ workspace: StarlingsWorkspace) {
        guard workspace.webOrigin != StarlingsWorkspace.active.webOrigin else { return }
        if MobileWorkspaceSwitch.hasSession(workspace) { signOut(of: workspace) }
        StarlingsWorkspaceStore.shared.forget(workspace)
    }

    /// Sign out of every workspace on this phone (slice G): each one's
    /// session, with its own Worker told first, best effort, then every
    /// cache. The app stays on the active workspace, signed out.
    func signOutOfAllWorkspaces() {
        let store = StarlingsWorkspaceStore.shared
        // Every workspace's item, so the Keychain itself, not the one-scope seam.
        let keychain = MobileOwnerSessionStore()
        do {
            for workspace in store.known {
                if let credentials = try? keychain.load(workspace: workspace) {
                    let api = StarlingsAPI(environment: MobileOwnerSessionStore.environment(for: workspace), session: urlSession)
                    let deviceID = keychain.deviceID(workspace: workspace)
                    Task(priority: .utility) {
                        _ = try? await api.revokeOwnerDevice(credentials: credentials, deviceID: deviceID)
                    }
                }
                try keychain.clear(workspace: workspace)
            }
            WorkspaceSignOut.purgeLocalData(allWorkspaces: true)
            // Every row stays, signed out: the door lists them.
            ownerCredentials = nil
            selectTab(.home)
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    /// Keep the session alive without asking for Google again.
    ///
    /// The access token lasts 8h, which used to mean signing in most mornings.
    /// This spends the refresh token instead — on launch and on every return to
    /// the foreground — so the only thing that ever asks for Google is a
    /// session that has been untouched for 60 days, or one the Worker refuses
    /// because the account was revoked or left the domain.
    ///
    /// Two kinds of failure, told apart on purpose. Offline or a Worker that
    /// is down leaves the existing session in place — the token may still have
    /// hours left, and nobody should be signed out mid-meeting by a dropped
    /// connection. A refusal (401 or 403) is the Worker saying this token will
    /// never work again, and keeping it would leave Home drawing a member
    /// workspace off a session that is already gone; that one signs out now
    /// and says so.
    enum SessionRenewal: Equatable {
        /// A fresh pair is in the Keychain and published.
        case renewed
        /// Nothing to do yet: more than an hour left on the access token.
        case stillValid
        /// No session, or a session with no refresh token.
        case nothingToRenew
        /// The Worker refused: expired, spent, revoked or off-domain. The
        /// session is already dropped.
        case refused
        /// Offline, a timeout, or a Worker that did not answer usefully. The
        /// session stays; try again later.
        case unavailable
    }

    @discardableResult
    func renewSessionIfNeeded(force: Bool = false) async -> SessionRenewal {
        if let renewalTask { return await renewalTask.value }
        guard let credentials = ownerCredentials,
              let refreshToken = credentials.refreshToken else { return .nothingToRenew }
        guard force || Self.expiresSoon(credentials.accessToken) else { return .stillValid }
        let task = Task { await renew(refreshToken: refreshToken) }
        renewalTask = task
        let outcome = await task.value
        if renewalTask == task { renewalTask = nil }
        return outcome
    }

    private func renew(refreshToken: String) async -> SessionRenewal {
        do {
            let renewed = try await api.refreshSession(
                refreshToken: refreshToken,
                deviceID: sessionStore.deviceID(),
                deviceName: UIDevice.current.name
            )
            // Save before publishing: a renewed token that never reached the
            // Keychain would be spent, and the stored one is single-use.
            try sessionStore.save(renewed)
            ownerCredentials = try sessionStore.load()
            return .renewed
        } catch let error as StarlingsError where error.isSessionRefusal {
            dropExpiredSession()
            return .refused
        } catch {
            // Offline, the Worker is down, or the Keychain would not take the
            // pair. The current token may still have hours left, and the
            // Worker honours the one just spent for a while yet, so say
            // nothing and try again next time.
            return .unavailable
        }
    }

    /// True within an hour of expiry, or if the token cannot be read.
    ///
    /// Reads `exp` out of the JWT payload rather than tracking issue time: the
    /// Worker owns the lifetime, and a client that assumed 8h would renew at
    /// the wrong moment the day that changes.
    private static func expiresSoon(_ accessToken: String, now: Date = Date()) -> Bool {
        OwnerAccessToken.expiresSoon(accessToken, now: now)
    }

    /// The Worker can reject a cached owner JWT while the app still has a
    /// non-nil Keychain session. Try to renew before making that somebody's
    /// problem: an expired access token with a good refresh token is a silent
    /// fix, not a sign-in prompt. Coalesced: however many requests fail in the
    /// same breath, there is one renewal and at most one alert.
    func handleExpiredOwnerSession() {
        guard ownerCredentials != nil, expiredSessionTask == nil else { return }
        expiredSessionTask = Task {
            defer { expiredSessionTask = nil }
            switch await renewSessionIfNeeded(force: true) {
            case .nothingToRenew:
                // A session with no refresh token — a build before renewal —
                // has nothing left to try.
                dropExpiredSession()
            case .refused:
                // `renew` already dropped it.
                break
            case .renewed, .stillValid, .unavailable:
                // Renewed, or the Worker could not be asked. Neither is a
                // reason to sign anybody out: the next request will say which.
                break
            }
        }
    }

    /// Sign out because the Worker will not honour this session again. The
    /// calendar cache is kept: the same person is about to sign back in, and
    /// an empty grid over breakfast is the wrong way to say "expired".
    private func dropExpiredSession() {
        guard ownerCredentials != nil else { return }
        do {
            try sessionStore.clear()
            ownerCredentials = nil
            selectTab(.home)
            alertMessage = "Your Starlings sign-in expired. Sign in again to continue."
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func connectCalendar() async throws -> CalendarStatus {
        guard let ownerCredentials else {
            throw StarlingsError.local(String(localized: "Sign in before connecting Google Calendar."))
        }
        let code = try await authenticator.authorize(purpose: .calendar)
        return try await api.connectCalendar(
            credentials: ownerCredentials,
            code: code.code,
            verifier: code.verifier,
            redirectURI: code.redirectURI,
            nonce: code.nonce
        )
    }

    /// Attach a calendar-only Google credential without replacing the signed-in
    /// owner. The extra account can provide calendars, but it cannot become the
    /// identity used for Meet or room ownership.
    func addCalendarAccount() async throws -> CalendarAccount {
        guard let ownerCredentials else {
            throw StarlingsError.local(String(localized: "Sign in before adding another Google account."))
        }
        let code = try await authenticator.authorize(purpose: .calendarAccount)
        return try await api.connectAdditionalCalendar(
            credentials: ownerCredentials,
            code: code.code,
            verifier: code.verifier,
            redirectURI: code.redirectURI,
            nonce: code.nonce
        )
    }

    func route(url: URL) {
        // `starlings://` and the `meet://` written before the rename read
        // the same.
        let isAppLink = url.scheme.map { StarlingsGlance.eventSchemes.contains($0.lowercased()) } ?? false
        guard url.scheme == "http" || url.scheme == "https" || isAppLink else { return }
        // `starlings://event/<reference>`: a glance surface for a meeting with
        // no link. The tap lands on the meeting in Calendar, not on
        // Home. Everything else is a room link on its way in.
        if isAppLink, url.host == "event" {
            let reference = url.pathComponents.dropFirst().joined(separator: "/")
            if !reference.isEmpty { openCalendar(eventReference: reference) }
            return
        }
        // `starlings://work/task/<id>` and `starlings://work/subject/<kind>/<id>?title=`:
        // the Today's work widget's rows, landing where Home's do —
        // the subject on Tasks, or Mine for a task Core kept without one.
        if isAppLink, url.host == "work" {
            let parts = Array(url.pathComponents.dropFirst())
            if parts.count >= 2, parts[0] == "task" {
                openMine(taskID: parts[1])
            } else if parts.count >= 3, parts[0] == "subject" {
                let title = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "title" }?.value ?? ""
                openWork(subject: CrmSubject(id: parts[2], kind: parts[1], title: title, subtitle: nil), pane: .tasks)
            } else {
                selectTab(.work)
            }
            return
        }
        if isAppLink, url.host == "calendar" {
            selectTab(.calendar)
            return
        }
        open(link: url.absoluteString)
    }

    /// A room or invite link, opened only under the workspace whose host it
    /// names (slice F). A link for another workspace offers that
    /// workspace; a host that names no workspace is refused.
    func open(link: String) {
        guard !StarlingsWorkspaceLink.isActive(link) else {
            pendingJoinInput = link
            if isSignedIn { selectTab(.home) }
            return
        }
        Task {
            switch await StarlingsWorkspaceLink.resolve(link) {
            case .active:
                pendingJoinInput = link
                if isSignedIn { selectTab(.home) }
            case .other(let workspace):
                linkWorkspaceOffer = LinkWorkspaceOffer(workspace: workspace, link: link)
            case .unknown:
                alertMessage = String(localized: "This link isn’t for a workspace this app can open.")
            }
        }
    }

    /// Opens the offered link's workspace. The root view rebuilds for it and
    /// the new model takes the carried link in `start()`.
    func acceptLinkWorkspaceOffer() {
        guard let offer = linkWorkspaceOffer else { return }
        linkWorkspaceOffer = nil
        StarlingsWorkspaceLink.carry(offer.link, to: offer.workspace)
        StarlingsWorkspaceStore.shared.choose(offer.workspace)
    }

    /// What a Control Center control asked for, performed now that the app is
    /// in front. Called on start and on every return to active: the control
    /// may have launched the app or only brought it forward.
    func performLaunchAction() {
        guard let action = LaunchAction.take() else { return }
        switch action {
        case .joinNextMeeting:
            // The agenda file, not the store: on a cold launch the store has
            // not answered yet, and the file is what the widget showed.
            let agenda = AgendaFile.read()
            if let next = AgendaFile.next(in: agenda), let raw = next.launchURL, let url = URL(string: raw) {
                route(url: url)
            } else if let next = AgendaFile.next(in: agenda) {
                openCalendar(eventReference: next.id)
            } else {
                selectTab(.calendar)
            }
        case .newQuickNote:
            pendingQuickNote = true
            selectTab(.home)
        }
    }
}

/// The native action shared by row menus across Work, Calendar, Docs and Team.
struct MobileFavoriteAction: View {
    @EnvironmentObject private var app: StarlingsAppModel
    let target: FavoriteTarget

    var body: some View {
        let starred = app.isFavorite(target)
        Button {
            Task {
                do {
                    try await app.setFavorite(target, starred: !starred)
                } catch {
                    app.alertMessage = error.localizedDescription
                }
            }
        } label: {
            Label(
                String(localized: starred ? "Unstar" : "Star"),
                systemImage: starred ? "star.slash" : "star"
            )
        }
    }
}

struct MobileFavoriteButton: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @State private var working = false
    let target: FavoriteTarget

    var body: some View {
        let starred = app.isFavorite(target)
        Button {
            working = true
            Task {
                defer { working = false }
                do {
                    try await app.setFavorite(target, starred: !starred)
                } catch {
                    app.alertMessage = error.localizedDescription
                }
            }
        } label: {
            Image(systemName: starred ? "star.fill" : "star")
        }
        .accessibilityLabel(String(localized: starred ? "Unstar" : "Star"))
        .disabled(working)
        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
    }
}

/// Tapping the one-minute warning (or its Join action) should land in the room,
/// a message banner should land in its conversation, and the warning should
/// still be visible when the app is already open.
/// `@unchecked Sendable`: the notification centre calls these back on an
/// arbitrary thread, and the one mutable field is written and read only on the
/// main actor.
private final class MeetingNoticeDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    weak var app: StarlingsAppModel?

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Worth showing even with the app open — you are usually looking at
        // something else on the same screen.
        completionHandler([.banner, .sound, .list])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let content = response.notification.request.content
        // Admit from the knock banner is a background action: answer, then
        // release the system. Everything else below releases first.
        if response.actionIdentifier == KnockNotices.admitAction {
            let room = content.userInfo[KnockNotices.roomKey] as? String
            let requestID = content.userInfo[KnockNotices.requestIDKey] as? String
            let name = content.userInfo[KnockNotices.nameKey] as? String ?? String(localized: "the guest")
            // The handler is not `Sendable`; it is called exactly once, from
            // the main actor, which is where the centre expects it anyway.
            nonisolated(unsafe) let done = completionHandler
            Task { @MainActor [weak self] in
                if let room, let requestID {
                    await self?.app?.admitKnock(room: room, requestID: requestID, name: name)
                }
                done()
            }
            return
        }
        // An INBOX banner opens Work, where the row is at the top; a guest
        // row on intake opens its conversation.
        if content.categoryIdentifier == InboxNotices.categoryIdentifier {
            let threadID = content.userInfo[InboxNotices.threadIDKey] as? String
            let title = content.userInfo[InboxNotices.threadTitleKey] as? String
            completionHandler()
            Task { @MainActor [weak self] in
                if let threadID {
                    self?.app?.openTeam(threadID: threadID, title: title)
                } else {
                    self?.app?.selectTab(.work)
                }
            }
            return
        }
        // A message banner (or its Reply action) opens that conversation.
        if content.categoryIdentifier == MessageNotices.categoryIdentifier {
            let threadID = content.userInfo[MessageNotices.threadIDKey] as? String
            completionHandler()
            Task { @MainActor [weak self] in self?.app?.openTeam(threadID: threadID) }
            return
        }
        let value = content.userInfo[MeetingNotices.launchURLKey] as? String
        let isRing = content.categoryIdentifier == RingNotices.categoryIdentifier || content.categoryIdentifier == RingNotices.callCategoryIdentifier
        // Tapping a ring decides nothing: it opens the roster, where the banner
        // and its Join button already are. Only Join knocks.
        let joins = !isRing || response.actionIdentifier == RingNotices.joinAction
        completionHandler()
        guard joins, let value, let url = URL(string: value) else {
            guard isRing else { return }
            // The roster that shows the ring banner is Team.
            Task { @MainActor [weak self] in self?.app?.selectTab(.team) }
            return
        }
        Task { @MainActor [weak self] in self?.app?.route(url: url) }
    }
}

/// What Calendar is asked to open: a Home row's event, which knows its day, or
/// a search door, which knows only the id.
enum CalendarOpenRequest: Equatable {
    case feed(MobileCalendarEvent)
    case reference(String)

    var id: String {
        switch self {
        case .feed(let event): event.id
        case .reference(let reference): reference
        }
    }
}
