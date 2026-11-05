import EnvisioningUI
import SwiftUI
import UIKit
import StarlingsContracts

/// Audience-aware root. With no owner session this is the visitor door; with a
/// verified Envisioning session it is the companion view of the owner's room.
struct MobileHomeView: View {
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var meetings: UpcomingMeetingsStore
    @EnvironmentObject private var team: MobileTeamStore
    @EnvironmentObject private var work: MobileMyWorkStore
    @EnvironmentObject private var commercial: MobileCommercialStore
    @EnvironmentObject private var quickNotes: MobileQuickNotesStore
    @EnvironmentObject private var homeLayout: MobileHomeLayoutStore
    @State private var room: OwnerRoomConfiguration?
    @State private var isLoadingRoom = false
    @State private var roomError: String?
    /// The Worker said `room_not_found`: this account has no row in
    /// `OWNER_ROOM_MAP`. Distinct from a lookup that merely failed.
    @State private var roomIsUnmapped = false
    /// Hosting takes the whole screen: it is a meeting, not a panel over Home.
    @State private var isHosting = false
    /// "Copied" on the room link for a moment after a tap.
    @State private var roomLinkCopied = false
    /// Quick Note capture is a drawer of its own so the toolbar action still
    /// works when the QUICK NOTES module is hidden or lower on the page.
    @State private var isQuickNoteCapturePresented = false
    /// The subject a palette verb asked the next hosted room to be filed under.
    @State private var hostFiling: CrmSubject?
    /// A colleague's room this member accepted to host.
    @State private var colleagueHostRoom: String?
    @State private var isWalkUp = false
    /// Joining belongs to Home as well. A room link or a Team call opens the
    /// same full-screen Join flow over Home rather than creating a fifth tab.
    @State private var isJoining = false
    /// A decision from the WORK card, read whole before it is answered.
    @State private var openQuestion: AttentionRequest?
    @State private var openDecision: DecisionAsk?
    /// A Mine row's Delete, while the question is up.
    @State private var deletingTask: MobileTaskDeletion?
    /// The INBOX key of the calendar answer in flight on the Inbox card.
    @State private var answeringCalendarKey: String?
    /// Every visible module has answered once, or ten seconds have passed.
    /// Until then a module with no answer yet draws a fixed-height loading
    /// shell in its place; after it, a module still without one draws
    /// nothing. Each module swaps its own shell as its answer lands — a
    /// snapshot on the first frame, most days — and never waits for the
    /// slowest of the others (docs/CACHING.md). Held for the owner: a token
    /// renewal or a return to this tab refreshes behind what is drawn.
    @State private var homeIsSettled = false
    /// Whose Home the state above describes, and when its reads last went
    /// out, so a return to the tab within a minute does not read again.
    @State private var loadedOwner: String?
    @State private var lastHomeRead: Date?
    @State private var roomLoadAnswered = false
    @State private var publicEvents: [PublicEventsCalendar.Event] = []
    @State private var publicEventsReady = false
    /// The setup checklist (docs/ONBOARDING.md): the last good answer, the
    /// error when there is none, and whether "You're set up" was already said.
    @State private var setup: SetupResponse?
    @State private var setupError: String?
    @State private var setupDoneSaid: Bool?
    @State private var setupHidden = false
    /// Wide is the platform's word: `.regular` on an iPad, or a Plus-class
    /// phone turned sideways. The Mac and the browser test their width in
    /// points; the phone's own width test is this, and it needs no
    /// measuring, so it cannot lag a rotation or feed back from the columns.
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// Each module's drawn height, for packing the two columns. A module
    /// that draws nothing never reports.
    @State private var moduleHeights: [HomeModuleID: CGFloat] = [:]
    /// Which modules sit in the right column. Nil is the alternating first
    /// placement; the Mac's `columnAssignment`, with the same lifetime.
    @State private var columnAssignment: [HomeModuleID: Bool]?

    /// The Mac's `OwnerLaunchView` numbers: a column is `columnWidth` when
    /// the screen allows, never wider; narrower when two must share less.
    private static let columnWidth: CGFloat = 420
    private static let columnGap: CGFloat = 16
    private static let sideMargin: CGFloat = 20

    private var twoColumns: Bool { horizontalSizeClass == .regular }
    /// Whether the merged jump list has anything to draw. The card owns the
    /// rows; this lets layout skip an empty module.
    @State private var hasHomeRows = false

    /// Which modules draw — the Mac's `panelShouldHide`, inverted. The
    /// layout iterates only these: a module that draws nothing must not
    /// take a slot, a column's spacing, or a place in the packing. Whether
    /// an empty module draws is the registry's (`HomeLayout.draws`, SHOW in
    /// fixtures/home-layout.json); this says only whether it has rows.
    private func moduleDraws(_ module: HomeModuleID) -> Bool {
        HomeLayout.draws(module, hasContent: moduleHasContent(module))
    }

    private func moduleHasContent(_ module: HomeModuleID) -> Bool {
        switch module {
        case .messages: !team.unreadThreads.isEmpty || !work.inboxForHomeCard.isEmpty
        case .work: !work.homeMine.isEmpty
        case .commercial: commercial.summary != nil
        case .events: !publicEvents.isEmpty
        case .recent: hasHomeRows
        // These draw empty (`showsEmpty`): their content does not decide.
        case .notes, .agenda, .room: false
        }
    }

    /// The person's enabled modules, less those whose work modules the
    /// workspace has off: the same rule as the web and the Mac.
    private var visibleModules: [HomeModuleID] {
        HomeLayout.visible(homeLayout.layout, workModules: work.subjectState.workModules)
    }

    /// The modules Home draws, in the person's order: every visible module
    /// while loading (each shows a shell), only the ones with content once
    /// settled.
    private var drawnModules: [HomeModuleID] {
        visibleModules.filter { module in
            moduleIsAnswered(module) ? moduleDraws(module) : !homeIsSettled
        }
    }

    /// Quick Access spans the full Home width below the two regular columns.
    private var columnModules: [HomeModuleID] { drawnModules.filter { $0 != .recent } }

    /// The module's store holds an answer — a snapshot or a live read — and
    /// the order it sits in is known.
    private func moduleIsAnswered(_ module: HomeModuleID) -> Bool {
        guard homeLayout.homeReady else { return false }
        return switch module {
        case .messages: team.homeMessagesReady || work.homeReady
        case .work: work.homeReady
        case .commercial: commercial.homeReady
        case .notes: quickNotes.homeReady
        case .agenda: meetings.homeReady
        case .events: publicEventsReady
        case .room: roomLoadAnswered
        case .recent: true
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Group {
                    if let owner = app.ownerCredentials?.owner {
                        ownerHome(owner: owner)
                    } else {
                        visitorHome
                    }
                }
            }
            // Let SwiftUI own bounce/overflow. Measuring the live content and
            // toggling scrolling from that measurement made every late card
            // answer another layout pass.
            .scrollBounceBehavior(.basedOnSize, axes: .vertical)
            // Home is today, and the Octa clock already says so. A large
            // "Home" over it is a second title for the same thing — and over
            // the first-run card it is the loudest thing on the screen before
            // anyone has done anything.
            .background {
                // The grid is decoration and says so: no hit testing, hidden
                // from VoiceOver, and gone entirely when the preference is
                // off. The shared surface modifier below owns the ground.
                MobileHomeGridBackground()
            }
            .meetSurfaceBackground()
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            // Search stays in More like it does on the other tabs; the
            // trailing create action is always available while signed in.
            .toolbar {
                MobileSurfaceMenu(settingsPage: .home, settingsTitle: "Home settings…")
                // Which workspace this is, and who is signed in.
                if let owner = app.ownerCredentials?.owner {
                    ToolbarItem(placement: .principal) {
                        MobileWorkspaceSwitcher(address: owner.email)
                    }
                }
                if app.ownerCredentials != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { isQuickNoteCapturePresented = true } label: {
                            Image(systemName: "plus")
                        }
                        .meetToolbarProminent()
                        .accessibilityLabel("New Quick Note")
                    }
                }
            }
            .meetSettingsSheet()
            .meetSearchSheet()
            .sheet(isPresented: $isQuickNoteCapturePresented) {
                MobileQuickNoteCaptureSheet()
                    .meetDrawer()
            }
            // The palette's door that Home performs: Start room. The request
            // is consumed as it is honoured.
            .onReceive(app.$pendingHostRoom) { requested in
                guard requested else { return }
                app.pendingHostRoom = false
                // The subject the palette named, if any, for the
                // cover to file the room under.
                hostFiling = app.pendingHostRoomFiling
                app.pendingHostRoomFiling = nil
                guard !isHosting else { return }
                isHosting = true
            }
            .fullScreenCover(isPresented: $isJoining) {
                JoinView().neutralChrome().meetAlertHost()
            }
            .taskDeleteConfirmation($deletingTask) { deletion in
                Task {
                    do {
                        try await work.deleteTask(id: deletion.id)
                    } catch {
                        app.alertMessage = (error as? StarlingsError)?.message ?? TaskDeleteCopy.failure
                    }
                }
            }
            .sheet(item: $openQuestion) { request in
                MobileAttentionQuestionSheet(request: request).meetDrawer()
            }
            .sheet(item: $openDecision) { ask in
                MobileDecisionSheet(ask: ask) { option, note in
                    Task {
                        do {
                            try await work.answerDecision(ask, option: option, note: note)
                        } catch {
                            app.alertMessage = error.localizedDescription
                        }
                    }
                }
                .meetDrawer()
            }
            .onAppear { presentPendingJoinIfNeeded() }
            .onChange(of: app.pendingJoinInput) { _, input in
                if input != nil { isJoining = true }
            }
            .onChange(of: app.pendingCallRoom) { _, room in
                if room != nil { isJoining = true }
            }
            .onReceive(app.$pendingWalkUp) { requested in
                guard requested else { return }
                app.pendingWalkUp = false
                guard !isHosting else { return }
                isWalkUp = true
                isHosting = true
            }
            .onReceive(app.$pendingAgentStart) { requested in
                guard requested else { return }
                app.pendingAgentStart = false
                guard !isHosting else { return }
                // Not a walk-up: an agent's ask carries a calendar event, so
                // the meeting is convened and transcribes.
                isWalkUp = false
                isHosting = true
            }
            .onReceive(app.$pendingColleagueHostRoom) { room in
                guard let room else { return }
                app.pendingColleagueHostRoom = nil
                guard !isHosting else { return }
                colleagueHostRoom = room
                isJoining = false
                // One cover at a time: let Join go before the host opens.
                Task {
                    try? await Task.sleep(for: .milliseconds(600))
                    isHosting = true
                }
            }
            .fullScreenCover(isPresented: $isHosting, onDismiss: { isWalkUp = false; hostFiling = nil; colleagueHostRoom = nil }) {
                MobileHostView(
                    api: app.api,
                    outbox: app.artifactOutbox,
                    filing: hostFiling,
                    isWalkUp: isWalkUp,
                    room: colleagueHostRoom,
                    claimsHostOnJoin: colleagueHostRoom != nil
                ).meetAlertHost()
            }
            .refreshable {
                async let agenda: Void = meetings.refresh(force: true)
                async let workRead: Void = work.refresh()
                async let notesRead: Void = quickNotes.refresh()
                async let layoutRead: Void = homeLayout.refresh()
                async let events: Void = loadPublicEvents()
                async let starred: Void = app.refreshFavorites()
                async let roomRead: Void = loadOwnerRoom()
                _ = await (agenda, workRead, notesRead, layoutRead, events, starred, roomRead)
                lastHomeRead = Date()
            }
        }
        // Synchronously, before the first frame: the task below starts after it.
        .onAppear { paintHomeSnapshots() }
        .task(id: app.ownerCredentials?.owner.email) {
            paintHomeSnapshots()

            // The stores read their own lists on sign-in and on their polls;
            // what Home reads itself goes out here, side by side, and nothing
            // on screen waits for all of it. Unstructured, so a tab switch
            // that cancels this task does not cancel a read halfway.
            let reads = Task { await readHome() }
            if !homeIsSettled {
                let deadline = Date().addingTimeInterval(10)
                while !Task.isCancelled && !visibleModules.allSatisfy(moduleIsAnswered) && Date() < deadline {
                    try? await Task.sleep(for: .milliseconds(50))
                }
                guard !Task.isCancelled else { return }
                homeIsSettled = true
            }
            await reads.value
        }
    }

    /// What Home reads itself — YOUR ROOM and EVENTS — as last saved, before
    /// any request (docs/CACHING.md). The stores paint theirs as
    /// they attach. A different owner starts from their own snapshots.
    private func paintHomeSnapshots() {
        let owner = app.ownerCredentials?.owner.email
        if owner != loadedOwner {
            loadedOwner = owner
            lastHomeRead = nil
            homeIsSettled = false
            room = nil
            roomLoadAnswered = false
            publicEventsReady = false
            publicEvents = []
            setup = nil
            setupError = nil
            setupDoneSaid = nil
        }
        guard let credentials = app.ownerCredentials else { return }
        if room == nil,
           let cached = app.api.snapshot(StarlingsAPI.roomSnapshotKey, credentials: credentials, as: OwnerRoomResponse.self) {
            room = cached.value.room
            roomLoadAnswered = true
        }
        if !publicEventsReady, let cached = PublicEventsCalendar.cached() {
            publicEvents = cached
            publicEventsReady = true
        }
    }

    /// Home's own reads: the room, the events, the stars, and the agenda if
    /// it has gone cold. Skipped when they went out under
    /// a minute ago — a tab switch is not a reason to ask again.
    private func readHome() async {
        if let lastHomeRead, Date().timeIntervalSince(lastHomeRead) < 60 { return }
        lastHomeRead = Date()
        async let roomRead: Void = loadOwnerRoom()
        async let agenda: Void = meetings.refresh()
        async let events: Void = loadPublicEvents()
        async let starred: Void = app.refreshFavorites()
        async let setupRead: Void = loadSetup()
        _ = await (roomRead, agenda, events, starred, setupRead)
    }

    /// The owner's setup steps. "You're set up" is said once per workspace
    /// and person on this device: the flag is read once, and set once the
    /// answer says every required step is done.
    private func loadSetup() async {
        guard let credentials = app.ownerCredentials else { return }
        let workspace = StarlingsWorkspace.active.webOrigin
        let owner = credentials.owner.email
        if setupDoneSaid == nil { setupDoneSaid = SetupChecklist.doneSaid(workspace: workspace, owner: owner) }
        do {
            let answer = try await app.api.setup(credentials: credentials)
            setup = answer
            setupError = nil
            if answer.on, answer.complete { SetupChecklist.markDoneSaid(workspace: workspace, owner: owner) }
        } catch {
            if setup == nil { setupError = error.localizedDescription }
        }
    }

    private func turnOffSetup() {
        guard let credentials = app.ownerCredentials else { return }
        Task {
            do {
                setup = try await app.api.setSetupChecklist(credentials: credentials, on: false)
                setupError = nil
            } catch {
                setupError = error.localizedDescription
            }
        }
    }

    private func skipSetupStep(_ step: SetupStep) {
        guard let credentials = app.ownerCredentials else { return }
        let workspace = StarlingsWorkspace.active.webOrigin
        let owner = credentials.owner.email
        Task {
            do {
                let answer = try await app.api.skipSetupStep(credentials: credentials, step)
                setup = answer
                setupError = nil
                if answer.on, answer.complete { SetupChecklist.markDoneSaid(workspace: workspace, owner: owner) }
            } catch {
                setupError = error.localizedDescription
            }
        }
    }

    private func openSetupStep(_ step: SetupStep) {
        switch SetupChecklist.destination(for: step, webOrigin: StarlingsWorkspace.active.webOrigin) {
        case .settings(let page)?: app.openSettings(page: page)
        case .work?: app.selectTab(.work)
        case .room?: if room != nil { isHosting = true }
        case .web(let url)?: openURL(url)
        case nil: break
        }
    }

    @ViewBuilder
    private var setupCard: some View {
        let card = SetupChecklist.card(setup, hidden: setupHidden || SetupChecklistSession.hidden, doneSaid: setupDoneSaid ?? true)
        if card != .none || (setupError != nil && !(setupHidden || SetupChecklistSession.hidden)) {
            MobileSetupCard(
                card: card,
                canTurnOff: setup?.canTurnOff ?? false,
                error: setupError,
                open: openSetupStep,
                skip: skipSetupStep,
                hide: {
                    SetupChecklistSession.hidden = true
                    setupHidden = true
                },
                turnOff: turnOffSetup,
                retry: { Task { await loadSetup() } }
            )
            .frame(maxWidth: Self.columnWidth * 2 + Self.columnGap)
            .frame(maxWidth: .infinity)
        }
    }

    private var visitorHome: some View {
        VStack(spacing: 10) {
            MobileFirstRunCard()

            Text(StarlingsAppVersion.line)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
            .padding(20)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
    }

    private var myRoomIsOpen: Bool { team.me?.status == .inMeeting }

    /// A WORK row's menu choice. What opens a screen goes to that tab;
    /// filing a note or starting a lead is the Work tab's sheet, so those
    /// land there too. A write goes to the store the Work tab shares.
    private func performWorkRowAction(_ action: WorkRowAction) {
        switch action {
        case .open(let destination, _):
            switch destination.target {
            case .subject(let subject): app.openWork(subject: subject, pane: destination.pane)
            case .mine(let taskID): app.openMine(taskID: taskID)
            case .issue, .coreEntity, .contact:
                app.pendingWork = destination
                app.selectTab(.work)
            }
        case .openDocument(let id, let title):
            app.openDocument(id: id, title: title)
        case .openCore(let url):
            openURL(url)
        case .openEvent(let reference):
            app.openCalendar(eventReference: reference)
        case .fileNote, .startLead:
            app.selectTab(.work)
        case .openQuestion(let request):
            openQuestion = request
        case .openDecision(let ask):
            openDecision = ask
        case .copyEmail(let email):
            UIPasteboard.general.string = email
        case .deleteTask(let id, let title):
            deletingTask = MobileTaskDeletion(id: id, title: title)
        case .deleteNote(let note):
            Task {
                _ = await quickNotes.delete(note)
                await work.refreshInbox()
            }
        default:
            Task {
                do {
                    if try await work.perform(action) { await team.refresh() }
                } catch {
                    app.alertMessage = error.localizedDescription
                }
            }
        }
    }

    /// An invitation or an event from email, answered on its Home row. One
    /// at a time: the row shows it is busy, and leaves when the write lands.
    private func answerCalendarRequest(_ action: WorkRowAction, key: String) {
        guard answeringCalendarKey == nil else { return }
        answeringCalendarKey = key
        Task {
            defer { answeringCalendarKey = nil }
            do {
                _ = try await work.perform(action)
            } catch {
                app.alertMessage = error.localizedDescription
            }
        }
    }

    private func presentPendingJoinIfNeeded() {
        if app.pendingJoinInput != nil || app.pendingCallRoom != nil {
            isJoining = true
        }
    }

    private func ownerHome(owner: MobileOwnerProfile) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            MobileMeetHero()
                // The shortcut into Settings → Home, where the modules
                // below are ordered and switched: one quiet gear on the
                // strip's top right, the corner the Mac and the web give it.
                .overlay(alignment: .topTrailing) {
                    Button { app.openSettings(page: .home) } label: {
                        Image(systemName: "gearshape")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .meetHoverLift(cornerRadius: 16)
                    .accessibilityLabel("Home settings")
                }

            // The setup checklist: not a module, so not in the person's
            // order; it draws above them until its steps are done, hidden or
            // turned off (docs/ONBOARDING.md).
            setupCard

            // The order is the person's, not this file's: `HomeLayout`
            // (fixtures/home-layout.json) decides which modules draw and in
            // what order, the same list the Mac and the browser read. A card
            // with nothing to say still draws nothing — an empty "all clear"
            // card is furniture — but that is the card's own rule, not the
            // layout's.
            //
            // Wide enough for two columns at the Mac's width, the modules
            // pack side by side the way the Mac packs them: the person's
            // order kept inside each column, and the columns close in height.
            if twoColumns {
                HStack(alignment: .top, spacing: Self.columnGap) {
                    moduleColumn(right: false, owner: owner)
                    moduleColumn(right: true, owner: owner)
                }
                .frame(maxWidth: Self.columnWidth * 2 + Self.columnGap)
                .frame(maxWidth: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(columnModules, id: \.self) { module in
                        measuredModule(module, owner: owner)
                    }
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }

            if drawnModules.contains(.recent) {
                measuredModule(.recent, owner: owner)
                    .frame(maxWidth: Self.columnWidth * 2 + Self.columnGap)
                    .frame(maxWidth: .infinity)
            }

            // Same line the Mac prints under its own launch surface, in the
            // same words. "Which build am I on" is the first thing anybody is
            // asked when they report something, and it should not require
            // opening Settings to answer.
            Text(StarlingsAppVersion.line)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, 4)
        }
        .padding(Self.sideMargin)
        .frame(maxWidth: .infinity)
        // Column ownership is decided once per layout or column mode, from
        // measured heights, then held — repacking on every late answer
        // would move cards under the reader's finger. A late answer that
        // leaves the columns lopsided packs them again.
        .onChange(of: twoColumns) { _, _ in resetColumns() }
        .onChange(of: visibleModules) { _, _ in resetColumns() }
        .onChange(of: homeIsSettled) { _, settled in
            if settled { balanceColumns() }
        }
        .onChange(of: moduleHeights) { _, _ in repackIfLopsided() }
        .onAppear { updateHomeRowsPresence(owner: owner.email) }
        .onReceive(NotificationCenter.default.publisher(for: SearchRecents.didChange).receive(on: DispatchQueue.main)) { _ in
            updateHomeRowsPresence(owner: owner.email)
        }
        .onChange(of: app.starredRows) { _, _ in updateHomeRowsPresence(owner: owner.email) }
        // Legacy CRM star actions mirror into shared favorites; refresh the
        // same app store so Work and Home stay in step.
        .onChange(of: work.subjectOverrides) { _, _ in
            guard homeIsSettled else { return }
            Task { await app.refreshFavorites() }
        }
    }

    private func moduleColumn(right: Bool, owner: MobileOwnerProfile) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            ForEach(columnModules.filter { isRightColumn($0) == right }, id: \.self) { module in
                measuredModule(module, owner: owner)
            }
        }
        .frame(maxWidth: Self.columnWidth, alignment: .top)
    }

    @ViewBuilder
    private func measuredModule(_ module: HomeModuleID, owner: MobileOwnerProfile) -> some View {
        Group {
            if moduleIsAnswered(module) {
                homeModule(module, owner: owner)
            } else {
                MobileHomeLoadingCard(module: module)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { moduleHeights[module] = $0 }
    }

    /// Alternating until the balanced assignment exists — the Mac's
    /// `alternatingColumnAssignment`, the first placement that gives the
    /// cards a real width to measure in.
    private func isRightColumn(_ module: HomeModuleID) -> Bool {
        if let columnAssignment { return columnAssignment[module] ?? false }
        guard let slot = columnModules.firstIndex(of: module) else { return false }
        return slot % 2 == 1
    }

    private func resetColumns() {
        columnAssignment = nil
        if homeIsSettled { balanceColumns() }
    }

    /// Height packing, the Mac's `balancedColumnAssignment`: tallest module
    /// first, each to the shorter column, so the two columns end close in
    /// height. The person's order holds inside each column, not across
    /// them — a card may sit beside an earlier one rather than under it.
    /// Runs one pass after the alternating placement has had a frame to
    /// lay out and report its heights, then holds (`repackIfLopsided`).
    private func balanceColumns() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(120))
            guard twoColumns, homeIsSettled, columnAssignment == nil else { return }
            // Nothing measured yet: stay alternating rather than freeze
            // every module into the left column.
            guard moduleHeights.values.contains(where: { $0 > 0 }) else { return }
            columnAssignment = HomeLayout.packColumns(columnModules, heights: moduleHeights, gap: 20)
        }
    }

    /// The held assignment stays until `HomeLayout.columnsLopsided` says a
    /// late answer has left one column far taller than the other.
    private func repackIfLopsided() {
        guard twoColumns, homeIsSettled, let columnAssignment else { return }
        guard HomeLayout.columnsLopsided(columnModules, heights: moduleHeights, assignment: columnAssignment, gap: 20) else { return }
        self.columnAssignment = HomeLayout.packColumns(columnModules, heights: moduleHeights, gap: 20)
    }

    @ViewBuilder
    private func homeModule(_ module: HomeModuleID, owner: MobileOwnerProfile) -> some View {
        switch module {
        case .messages:
            // What is new: unread conversations and INBOX items. A person
            // waiting on an answer is the one thing on this screen that goes
            // stale, which is why the default order puts it first.
            if !team.unreadThreads.isEmpty || !work.inboxForHomeCard.isEmpty {
                MobileHomeInboxCard(
                    threads: team.unreadThreads,
                    inbox: work.inboxForHomeCard,
                    open: { thread in
                        // Subject conversations belong to Work; people and
                        // agents belong to Team.
                        if let subject = thread.subject {
                            app.openWork(subject: subject)
                        } else {
                            app.openTeam(threadID: thread.id)
                        }
                    },
                    openInbox: { item in
                        if case .decision(let ask, _, _) = item {
                            openDecision = ask
                        } else if case .question(let request, _, _) = item {
                            openQuestion = request
                        } else if let threadID = item.glanceThreadID {
                            app.openTeam(threadID: threadID, title: item.glanceTitle)
                        } else if let destination = item.glanceDestination, let subject = destination.subject {
                            app.openWork(subject: subject, pane: destination.pane)
                        } else {
                            app.selectTab(.work)
                        }
                    },
                    openWork: { app.selectTab(.work) },
                    perform: performWorkRowAction,
                    answeringKey: answeringCalendarKey,
                    answer: answerCalendarRequest,
                    conflicts: { invitation in
                        CalendarConflictDetector.conflicts(
                            for: invitation.calendarConflictEvent,
                            among: meetings.agenda.map(\.calendarConflictEvent)
                        )
                    }
                )
            }

        case .work:
            // All of Mine. New things are the INBOX card's.
            if !work.homeMine.isEmpty {
                MobileTodayWorkCard(
                    mine: work.homeMine,
                    openWork: { app.selectTab(.work) },
                    perform: performWorkRowAction
                )
            }

        case .commercial:
            if let summary = commercial.summary {
                MobileCommercialCard(summary: summary)
            }

        case .notes:
            MobileQuickNotesCard()

        case .agenda:
            MobileNextMeetingCard(
                plan: meetings.plan,
                following: meetings.plan.homeRows,
                isUnavailable: meetings.isUnavailable,
                isCalendarNotConnected: meetings.isCalendarNotConnected,
                connectCalendar: connectCalendar
            ) { event in
                app.openCalendar(event: event)
            } join: { event in
                join(event)
            } demote: { event, demoted in
                Task { await meetings.setDemoted(event, demoted: demoted) }
            }

        case .events:
            if !publicEvents.isEmpty {
                MobileHomeEventsCard(events: publicEvents)
            }

        case .room:
            roomCard(owner: owner)

        case .recent:
            MobileRecentCard(owner: owner.email, starredRows: app.starredRows) { row in
                app.openSearch(row, verb: nil)
            }
        }
    }

    private func updateHomeRowsPresence(owner: String) {
        hasHomeRows = !HomeLayout.mergeRecentRows(
            SearchRecents.homeRows(owner: owner),
            starredRows: app.starredRows
        ).isEmpty
    }

    /// The Upcoming card's Connect Google Calendar: the same OAuth flow as
    /// Calendar → Sources, then a fresh agenda read.
    private func connectCalendar() async -> String? {
        do {
            _ = try await app.connectCalendar()
            await meetings.refresh(force: true)
            return nil
        } catch is CancellationError {
            return nil
        } catch {
            return MobileCalendarStore.describe(error)
        }
    }

    /// Never Safari. Our own room opens as host; a colleague's Meet room is
    /// a knock, the same one Call makes from Team; anything else goes to the
    /// app that owns it (Zoom, Teams) through its own link.
    private func join(_ event: MobileCalendarEvent) {
        guard event.isVideoMeeting, let url = event.conferenceLink else { return }
        guard event.isStarlingsRoom, let path = MobileRoomPath(input: url.absoluteString) else {
            openURL(url)
            return
        }
        if let room, path.slug == room.slug {
            guard !isHosting else { return }
            isHosting = true
        } else {
            app.pendingCallRoom = path.slug
        }
    }

    /// Whether the hero is currently the screen's one accent, so the room
    /// card's Start steps down to neutral. Same clock as the hero's button.
    private func heroHoldsAccent(at now: Date) -> Bool {
        guard let next = meetings.plan.focus, next.isVideoMeeting else { return false }
        return MeetingFocus.canJoin(next, now: now)
    }

    private func roomCard(owner: MobileOwnerProfile) -> some View {
        StarlingsCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("YOUR ROOM")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        if isLoadingRoom {
                            // The slug's own line, held by a bar until it lands.
                            Capsule()
                                .fill(EnvisioningSurface.border)
                                .frame(width: 140, height: 20)
                                .padding(.vertical, 4)
                                .accessibilityHidden(true)
                        } else if let room {
                            Text(room.slug).font(.title2.bold())
                            roomLinkButton(MeetingInvite.absoluteURL(slug: room.slug))
                        } else if roomIsUnmapped {
                            // A verified member with no row in OWNER_ROOM_MAP.
                            // A state with a next step, not an error: the
                            // other tabs work without a room.
                            Text("No room yet").font(.title2.bold())
                            Text("No room is mapped to \(owner.email). Ask the Starlings admin.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            Text(roomError ?? String(localized: "Couldn’t load your room right now. Pull to try again."))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                }

                // Your own row on the roster is the only honest answer to
                // "is my room open" — the same signal Team reads about
                // everybody else, pointed back at you. Closed says nothing.
                if !roomIsUnmapped, myRoomIsOpen {
                    Text("Your room is open.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if let room {
                    // One accent per screen: while the hero's Join is on
                    // screen, Start is the second thing and drops to neutral.
                    TimelineView(.periodic(from: .now, by: 15)) { timeline in
                        // Starting is a host action, so it needs the room
                        // the Worker maps to this owner — never a slug
                        // typed here. The link line above copies; Start
                        // takes the whole row.
                        Button {
                            isHosting = true
                        } label: {
                            Label(
                                String(localized: "Start room"),
                                systemImage: "video.fill"
                            )
                        }
                        .meetPrimaryButtonStyle(accent: !heroHoldsAccent(at: timeline.date))
                    }
                }
            }
        }
    }

    /// The room's link as a line that copies itself, with "Copied" for a
    /// moment after (the copy pattern of the event editor's link row).
    private func roomLinkButton(_ link: String) -> some View {
        Button {
            UIPasteboard.general.string = link
            roomLinkCopied = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.2))
                roomLinkCopied = false
            }
        } label: {
            HStack(spacing: 6) {
                Text(roomLinkCopied ? String(localized: "Copied") : link)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: roomLinkCopied ? "checkmark" : "doc.on.doc")
                    .foregroundStyle(StarlingsMobileColors.accent)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.meetPlain)
        .accessibilityLabel(roomLinkCopied ? String(localized: "Copied") : String(localized: "Copy room link"))
    }

    // The agenda itself belongs to UpcomingMeetingsStore; Home only owns the
    // room lookup, which changes about once a year.
    private func loadOwnerRoom() async {
        guard let credentials = app.ownerCredentials else {
            room = nil
            roomError = nil
            roomIsUnmapped = false
            roomLoadAnswered = true
            return
        }
        // Last known first: the room changes about once a year, so the saved
        // one is the answer until the read says otherwise.
        if room == nil,
           let cached = app.api.snapshot(StarlingsAPI.roomSnapshotKey, credentials: credentials, as: OwnerRoomResponse.self) {
            room = cached.value.room
            roomLoadAnswered = true
        }
        isLoadingRoom = room == nil
        roomError = nil
        defer {
            isLoadingRoom = false
            roomLoadAnswered = true
        }
        do {
            room = try await app.api.ownerRoom(credentials: credentials)
            roomIsUnmapped = false
        } catch is CancellationError {
            return
        } catch {
            // Keyed off the stable code, never the prose.
            roomIsUnmapped = (error as? StarlingsError)?.serverCode == ControlErrorCodeValue.roomNotFound.rawValue
            // A failed read keeps a room already on screen; only the Worker
            // saying there is none takes it away.
            if roomIsUnmapped || room == nil {
                room = nil
                roomError = roomIsUnmapped ? nil : error.localizedDescription
            }
        }
    }

    private func loadPublicEvents() async {
        guard app.ownerCredentials != nil else {
            publicEvents = []
            publicEventsReady = true
            return
        }
        if !publicEventsReady, let cached = PublicEventsCalendar.cached() {
            publicEvents = cached
            publicEventsReady = true
        }
        let fresh = await PublicEventsCalendar.load()
        // A failed read answers empty; the last known rows stand instead.
        publicEvents = PublicEventsCalendar.cached() ?? fresh
        publicEventsReady = true
    }

}

private struct MobileHomeLoadingCard: View {
    let module: HomeModuleID

    private var rowCount: Int {
        switch module {
        case .messages, .work, .events: HomeLayout.rows(for: module)
        case .commercial: 5
        case .notes: 5
        case .agenda: 4
        case .room: 3
        case .recent: 1
        }
    }

    private var rowHeight: CGFloat {
        switch module {
        case .notes, .agenda, .events, .room: 60
        default: 54
        }
    }

    var body: some View {
        StarlingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    placeholder(width: 92, height: 10)
                    Spacer(minLength: 12)
                    placeholder(width: 44, height: 10)
                }

                ForEach(0..<rowCount, id: \.self) { _ in
                    HStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 5)
                            .fill(StarlingsMobileColors.border)
                            .frame(width: 16, height: 16)
                        VStack(alignment: .leading, spacing: 6) {
                            placeholder(width: 150, height: 10)
                            placeholder(width: 218, height: 8)
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
                    .padding(12)
                    .meetContainerShape(cornerRadius: EnvisioningRadius.field)
                    .meetConcentricBackground(
                        StarlingsMobileColors.elevated,
                        fallbackRadius: EnvisioningRadius.field
                    )
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func placeholder(width: CGFloat, height: CGFloat) -> some View {
        Capsule()
            .fill(StarlingsMobileColors.border)
            .frame(width: width, height: height)
    }
}

/// "Somebody wrote to you", on the screen you open first.
///
/// Home cannot read a conversation — Work and Team own different conversation
/// kinds, and a second reader here would be a second place to mark things read.
/// So this says who is waiting and what they said, and hands over to the right
/// destination, where the conversation actually is. It appears
/// only when there is something in it: an empty "no messages" card is a row
/// of furniture that answers a question nobody asked.
///
/// There is no push behind any of this. A message that lands while Meet is
/// closed is not announced — it is simply here, unread, the next time the app
/// is opened, which is exactly what this card is for.
/// What you opened last, on this phone: subjects, conversations, documents
/// — `SearchRecents`, the list the search sheet ranks by (invariant 27),
/// as a strip of tiles: the mark over the name, the shape Work's tiles had.
/// Work, Team and Docs write it when a thing opens by hand. Nothing opened
/// yet hides the card. Same card as the Mac and the web.
private struct MobileRecentCard: View {
    let owner: String
    let starredRows: [SearchRow]
    let open: (SearchRow) -> Void
    @State private var recentRows: [SearchRow]

    init(owner: String, starredRows: [SearchRow], open: @escaping (SearchRow) -> Void) {
        self.owner = owner
        self.starredRows = starredRows
        self.open = open
        _recentRows = State(initialValue: SearchRecents.homeRows(owner: owner))
    }

    var body: some View {
        MobileSearchRowTilesCard(
            title: String(localized: "QUICK ACCESS"),
            rows: HomeLayout.mergeRecentRows(recentRows, starredRows: starredRows),
            starredKeys: Set(starredRows.map(\.key)),
            open: open
        )
            .onAppear { reload() }
            .onChange(of: owner) { _, _ in reload() }
            .onReceive(NotificationCenter.default.publisher(for: SearchRecents.didChange).receive(on: DispatchQueue.main)) { _ in reload() }
    }

    private func reload() {
        recentRows = SearchRecents.homeRows(owner: owner)
    }
}

/// A card of search-row tiles: the mark over the name, a row opening through
/// the palette's door, and a star mark when that row leads the list.
private struct MobileSearchRowTilesCard: View {
    let title: String
    let rows: [SearchRow]
    let starredKeys: Set<String>
    let open: (SearchRow) -> Void
    @EnvironmentObject private var team: MobileTeamStore

    var body: some View {
        if !rows.isEmpty {
            StarlingsCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text(title)
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 10) {
                            ForEach(rows) { row in
                                Button { open(row) } label: { tile(row, isStarred: starredKeys.contains(row.key)) }
                                    .buttonStyle(.meetPlain)
                                    .accessibilityLabel([
                                        row.title,
                                        starredKeys.contains(row.key) ? String(localized: "Starred") : nil,
                                        row.subtitle.isEmpty ? nil : row.subtitle,
                                        row.homeTypeLabel,
                                    ].compactMap { $0 }.joined(separator: ". "))
                            }
                        }
                        // The favorite badge overlaps the mark by four points;
                        // leave room at the scroll viewport's top edge so it
                        // stays a complete circle on the first tile.
                        .padding(.top, 4)
                    }
                }
            }
        }
    }

    private func tile(_ row: SearchRow, isStarred: Bool) -> some View {
        VStack(spacing: 6) {
            ZStack(alignment: .topLeading) {
                mark(row)
                if isStarred {
                    FavoriteStarBadge(size: .tile)
                        .offset(x: -4, y: -4)
                }
            }
            .frame(width: 42, height: 42)
            Text(row.title)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
            Text(row.homeTypeLabel)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(StarlingsMobileColors.border.opacity(0.28), in: Capsule())
                .overlay(Capsule().strokeBorder(StarlingsMobileColors.border, lineWidth: 0.5))
        }
        .frame(width: 84)
        .contentShape(Rectangle())
    }

    /// A subject's logo, a person's face, or the kind's glyph.
    @ViewBuilder
    private func mark(_ row: SearchRow) -> some View {
        switch row.door {
        case .person(let email):
            PersonAvatarImage(email: email, displayName: row.title, version: nil, diameter: 40, source: team.avatarSource)
        case .agent(let email):
            if let identity = team.roster.peers.first(where: {
                $0.isAgent && $0.email.caseInsensitiveCompare(email) == .orderedSame
            })?.agentAvatar {
                AgentAvatarImage(identity: identity, diameter: 40)
            } else {
                PersonAvatarImage(email: email, displayName: row.title, version: nil, diameter: 40, source: team.avatarSource)
            }
        default:
            if let image = row.image, let url = URL(string: image) {
                WorkOrgLogoMark(url: url, fallbackSystemName: row.symbolName)
            } else {
                WorkGlyphMark(content: .symbol(row.symbolName), shape: row.kind == .task || row.kind == .issue ? .square : .round)
            }
        }
    }
}

/// The Home favorite badge shares the web and Mac surface/ink tokens. Kept
/// local to Home so Work's compact sidebar badge can keep its own geometry.
private struct MobileHomeInboxCard: View {
    /// The roster, so a channel's row can name who wrote it.
    @EnvironmentObject private var team: MobileTeamStore
    let threads: [ThreadSummary]
    let inbox: [WorkInboxItem]
    /// One conversation, tapped: Home decides which tab that is.
    let open: (ThreadSummary) -> Void
    let openInbox: (WorkInboxItem) -> Void
    let openWork: () -> Void
    /// A menu choice other than Open, performed as a WORK row's is.
    let perform: (WorkRowAction) -> Void
    /// The calendar answer in flight, by INBOX key; nil when none is.
    let answeringKey: String?
    /// An invitation or an event from email, answered on its row.
    let answer: (WorkRowAction, String) -> Void
    /// What an invitation overlaps on the agenda.
    let conflicts: (CalendarEventSummary) -> [CalendarConflict]

    /// One card row: an unread conversation, or an INBOX item.
    private enum Row: Identifiable {
        case thread(ThreadSummary)
        case item(WorkInboxItem)

        var id: String {
            switch self {
            case .thread(let thread): "thread:\(thread.id)"
            case .item(let item): item.id
            }
        }

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

    private var rows: [Row] {
        HomeLayout.orderInbox(threads.map(Row.thread) + inbox.map(Row.item), pinned: \.isPinned, at: \.at)
    }

    var body: some View {
        let rows = rows
        // Three, then a count. A card that grows without limit stops being a
        // signal and becomes the list Work's INBOX already is.
        let listed = Array(rows.prefix(HomeLayout.rows(for: .messages)))
        StarlingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("INBOX")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(rows.count == 1 ? String(localized: "1 new") : String(localized: "\(rows.count) new"))
                        .font(.caption.bold())
                        .foregroundStyle(.primary)
                }

                ForEach(listed) { entry in
                    switch entry {
                    case .thread(let thread):
                        Button { open(thread) } label: { row(thread) }
                            .buttonStyle(.plain) // hover: meetHomeRow
                            // The same menu the Mac and the browser draw
                            // (`conversation`, `home`). Open is the row's own door.
                            .contextMenu {
                                WorkRowActionMenu(groups: thread.homeRowActions(client: .ios)) { action in
                                    if case .openConversation = action { open(thread) } else { perform(action) }
                                }
                            }
                    case .item(.invitation(let event, let key, _)):
                        // A calendar request is answered on the row itself.
                        MobileCalendarInvitationRow(event: event, conflicts: conflicts(event), key: key, answeringKey: answeringKey) { response in
                            answer(.respondToInvitation(event, response, key: key), key)
                        }
                        .transition(.opacity.combined(with: .move(edge: .leading)))
                    case .item(.forwarded(let event, let key, _)):
                        MobilePendingCalendarEventRow(event: event, key: key, answeringKey: answeringKey) { add in
                            answer(add ? .addForwardedEvent(event, key: key) : .discardForwardedEvent(event, key: key), key)
                        }
                        .transition(.opacity.combined(with: .move(edge: .leading)))
                    case .item(let item):
                        Button { openInbox(item) } label: { inboxRow(item) }
                            .buttonStyle(.plain) // hover: meetHomeRow
                            .transition(.opacity.combined(with: .move(edge: .leading)))
                            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
                    }
                }

                if rows.count > listed.count {
                    Button { openWork() } label: {
                        Text("and \(rows.count - listed.count) more in Work")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.meetPlain)
                }
            }
        }
    }

    private func inboxRow(_ item: WorkInboxItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            MobileCompactMark(
                systemName: item.glanceSymbolName,
                shape: item.glanceUsesSquareMark ? .square : .round,
                size: 24
            )
            .meetFirstLineMark(.headline)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.glanceTitle)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(item.glanceDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .meetLineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .meetHomeRow()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.glanceTitle), \(item.glanceDetail)")
    }

    private func row(_ thread: ThreadSummary) -> some View {
        // The dot centres on the row; the copy and its "when" stay aligned
        // to the title line.
        HStack(alignment: .center, spacing: 10) {
            MobileCompactMark(content: .unread)
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(thread.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .meetLineLimit(1)
                    // A channel's line names who wrote it.
                    if let preview = thread.previewWithSender(roster: team.roster.peers) {
                        Text(preview)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 8)
                if let at = thread.lastMessageAt {
                    // Re-rendered on a tick so "3 seconds ago" keeps counting
                    // while Home sits open. Clamp forward: clock skew between
                    // this phone and the control plane must never produce
                    // "in 3 minutes".
                    TimelineView(.periodic(from: .now, by: 1)) { timeline in
                        Text(min(at, timeline.date).formatted(.relative(presentation: .named)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.trailing)
                    }
                }
            }
        }
        .meetHomeRow()
        .accessibilityElement(children: .combine)
        // A channel is a place, a DM is a person: "from Everyone" would be a lie
        // about who wrote it.
        .accessibilityLabel(
            thread.kind.isChannel
                ? String(localized: "Unread message in \(thread.title)")
                : "Unread message from \(thread.title)"
        )
    }
}

/// An event proposed from a forwarded mail on Home's INBOX card:
/// title, when and that it came from email, then Add (the accent) and
/// Discard. Same shape as an invitation row.
private struct MobilePendingCalendarEventRow: View {
    let event: ProposedCalendarEvent
    /// The row's INBOX key, and the one being answered now, if any.
    let key: String
    let answeringKey: String?
    /// Add (true) or Discard (false).
    let answer: (Bool) -> Void

    private var isBusy: Bool { answeringKey == key }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                MobileCompactMark(systemName: "envelope.badge", shape: .round, size: 24)
                    .meetFirstLineMark(.headline)
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(event.scheduleLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .meetLineLimit(1)
                    if let location = event.location, !location.isEmpty {
                        Text(location)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
            }

            HStack(spacing: 8) {
                Button {
                    answer(true)
                } label: {
                    Label("Add", systemImage: "calendar.badge.plus")
                }
                .meetRSVPButtonStyle(filled: true)
                .controlSize(.small)
                .disabled(answeringKey != nil)
                Button {
                    answer(false)
                } label: {
                    Label("Discard", systemImage: "xmark")
                }
                .meetRSVPButtonStyle(filled: false)
                .controlSize(.small)
                .disabled(answeringKey != nil)
                if isBusy {
                    Spacer(minLength: 0)
                    ProgressView().controlSize(.small).tint(.secondary)
                }
            }
        }
        .meetHomeRow()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Event from email: \(event.title), \(event.scheduleLine)")
    }
}

/// A calendar invitation on Home's INBOX card, answered on the row. The
/// answer is written to Google Calendar, so the item leaves every device.
private struct MobileCalendarInvitationRow: View {
    let event: CalendarEventSummary
    let conflicts: [CalendarConflict]
    /// The row's INBOX key, and the one being answered now, if any.
    let key: String
    let answeringKey: String?
    let respond: (CalendarRSVP) -> Void

    private var isBusy: Bool { answeringKey == key }
    private var anyActionBusy: Bool { answeringKey != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                MobileCompactMark(systemName: "calendar.badge.clock", shape: .round, size: 24)
                    .meetFirstLineMark(.headline)
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.title.isEmpty ? String(localized: "Calendar invitation") : event.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(event.invitationDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .meetLineLimit(1)
                    if let conflictLine = CalendarConflictDetector.line(for: conflicts) {
                        Label(conflictLine, systemImage: "exclamationmark.triangle")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
            }

            // Accept is the row's primary action and wears the accent fill;
            // Maybe and Decline stay neutral (docs/DESIGN.md, "The accent
            // budget").
            HStack(spacing: 8) {
                ForEach(CalendarRSVP.answers, id: \.rawValue) { response in
                    Button {
                        respond(response)
                    } label: {
                        Label(Self.title(for: response), systemImage: Self.symbol(for: response))
                    }
                    .meetRSVPButtonStyle(filled: response == .accepted)
                    .controlSize(.small)
                    .disabled(anyActionBusy)
                }
                if isBusy {
                    Spacer(minLength: 0)
                    ProgressView().controlSize(.small).tint(.secondary)
                }
            }
        }
        .meetHomeRow()
        .accessibilityElement(children: .contain)
        .accessibilityLabel([
            "Calendar invitation: \(event.title)",
            CalendarConflictDetector.line(for: conflicts),
        ].compactMap { $0 }.joined(separator: ", "))
    }

    private static func title(for response: CalendarRSVP) -> String {
        response == .needsAction ? String(localized: "Reply") : response.answerTitle
    }

    private static func symbol(for response: CalendarRSVP) -> String {
        switch response {
        case .accepted: "checkmark"
        case .tentative: "questionmark"
        case .declined: "xmark"
        case .needsAction: "ellipsis"
        }
    }

}

/// Home's Mine card: all of Mine, in Mine's order. Same rows as the Mac
/// launch card, planned by the same `HomeMine`, so the two devices never
/// disagree. Nothing new lands here; that is the INBOX card's.
private struct MobileTodayWorkCard: View {
    let mine: HomeMine
    let openWork: () -> Void
    /// A tap, and a row's long-press: the same actions the Work tab offers
    /// (`WorkRowAction`).
    let perform: (WorkRowAction) -> Void

    /// A handful, then a count. Home is a glance, not the list.
    private var listed: [PlannedWorkItem] { Array(mine.rows.prefix(HomeLayout.rows(for: .work))) }
    private var hidden: Int { mine.rows.count - listed.count }

    var body: some View {
        StarlingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("MINE")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Spacer()
                    if let summary = mine.summary {
                        // The word "overdue" is already in the string — no
                        // tint needed on top of it (docs/DESIGN.md, "The
                        // accent budget").
                        Text(summary)
                            .font(.caption.bold())
                            .foregroundStyle(.primary)
                    }
                }

                ForEach(listed) { item in
                    Button {
                        if let destination = item.homeDestination { perform(.open(destination, title: item.homeTitle)) }
                    } label: { row(item) }
                        .buttonStyle(.plain) // hover: meetHomeRow
                        .transition(.opacity.combined(with: .move(edge: .leading)))
                        .contextMenu { WorkRowActionMenu(groups: item.homeRowActions(client: .ios), perform: perform) }
                }

                if hidden > 0 {
                    Button { openWork() } label: {
                        Text("and \(hidden) more in Work")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.meetPlain)
                }
            }
        }
    }

    private func row(_ item: PlannedWorkItem) -> some View {
        let isLate = mine.isLate(item)
        let when = mine.when(item)
        return HStack(alignment: .top, spacing: 10) {
            MobileCompactMark(
                systemName: item.homeSymbol,
                shape: .square,
                size: 24,
                color: isLate ? Color.primary : Color.secondary
            )
            .meetFirstLineMark(.headline)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.homeTitle)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if !item.homeDetail.isEmpty {
                    Text(item.homeDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .meetLineLimit(1)
                }
            }
            Spacer(minLength: 8)
            // The word "Overdue" is the signal now, not a colour — bold
            // weight carries the emphasis instead (docs/DESIGN.md, "The
            // accent budget").
            Text(when)
                .font(.caption.weight(isLate ? .bold : .semibold))
                .foregroundStyle(isLate ? Color.primary : Color.secondary)
                .multilineTextAlignment(.trailing)
        }
        .meetHomeRow()
        .accessibilityElement(children: .combine)
        .accessibilityLabel([item.homeTitle, item.homeDetail.isEmpty ? nil : item.homeDetail, when].compactMap { $0 }.joined(separator: ", "))
    }
}

/// Published Envisioning events from the CMS projection. This is a signal, not
/// a second calendar: it folds away when the public feed has no upcoming rows.
private struct MobileHomeEventsCard: View {
    let events: [PublicEventsCalendar.Event]
    @Environment(\.openURL) private var openURL

    var body: some View {
        StarlingsCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("EVENTS")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)

                ForEach(Array(events.prefix(HomeLayout.rows(for: .events)))) { event in
                    if let url = URL(string: event.url), !event.url.isEmpty {
                        Button { openURL(url) } label: {
                            eventRow(event)
                        }
                        .buttonStyle(.plain) // hover: meetHomeRow
                        .accessibilityHint("Opens the event page")
                    } else {
                        eventRow(event)
                    }
                }

                if events.count > HomeLayout.rows(for: .events) {
                    Text("and \(events.count - HomeLayout.rows(for: .events)) more")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func eventRow(_ event: PublicEventsCalendar.Event) -> some View {
        HStack(alignment: .top, spacing: 10) {
            MobileCompactMark(systemName: "megaphone", shape: .round, size: 24)
                .meetFirstLineMark(.headline)
            VStack(alignment: .leading, spacing: 3) {
                Text(event.title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(eventSchedule(event))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .meetLineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .meetHomeRow()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(event.title), \(eventSchedule(event))")
    }

    private func eventSchedule(_ event: PublicEventsCalendar.Event) -> String {
        let when = event.startDate.map { event.isAllDay ? StarlingsDateFormatting.date($0) : StarlingsDateFormatting.dayTime($0) }
        let location = event.location.trimmingCharacters(in: .whitespacesAndNewlines)
        return [when, location.isEmpty ? nil : location].compactMap { $0 }.joined(separator: " · ")
    }
}

/// The answer to "what's next" — always present, so an empty calendar reads as
/// an answer rather than as a card that failed to load.
///
/// The hero is the plan's `focus` and nothing else. When the day is closed it
/// stays empty and says so: tomorrow's first meeting appears below, as a row,
/// with the date it actually falls on — never counting down in the slot
/// reserved for what is about to happen.
///
/// A tap on any event opens it in Calendar (`open`). Joining is the hero's
/// button and every row's long-press (`join`), never the row itself.
private struct MobileNextMeetingCard: View {
    let plan: UpcomingPlan<MobileCalendarEvent>
    let following: [MobileCalendarEvent]
    let isUnavailable: Bool
    let isCalendarNotConnected: Bool
    /// Nil on success, else the line to show under the button.
    let connectCalendar: () async -> String?
    let open: (MobileCalendarEvent) -> Void
    let join: (MobileCalendarEvent) -> Void
    let demote: (MobileCalendarEvent, Bool) -> Void
    @State private var isShowingRemainingToday = false
    @State private var isConnecting = false
    @State private var connectError: String?

    var body: some View {
        StarlingsCard {
            VStack(alignment: .leading, spacing: 12) {
                Text(plan.heroLabel)
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)

                if let next = plan.focus {
                    MobileHomeUpcomingRow(
                        event: next,
                        attendees: Array(next.attendees.filter { !$0.isSelf }.prefix(20)),
                        showsCountdown: !next.isAllDay,
                        showsContext: true,
                        hidesCountdownWhenJoinable: true,
                        showsJoinButton: true,
                        action: { open(next) },
                        join: { join(next) },
                        toggleDemoted: { demote(next, !next.demoted) }
                    )
                } else if isCalendarNotConnected && !StarlingsWorkspace.active.calendarConnectable {
                    Text("Calendar connects to Google only.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else if isCalendarNotConnected {
                    Button {
                        isConnecting = true
                        connectError = nil
                        Task {
                            connectError = await connectCalendar()
                            isConnecting = false
                        }
                    } label: {
                        Label(
                            isConnecting ? String(localized: "Connecting…") : String(localized: "Connect Google Calendar"),
                            systemImage: "calendar.badge.plus"
                        )
                    }
                    .buttonStyle(StarlingsBorderedButtonStyle())
                    .disabled(isConnecting)
                    if let connectError {
                        Text(connectError)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text(isUnavailable
                         ? String(localized: "Couldn’t reach your calendar.")
                         : MeetingFocus.closedDaySummary(plan))
                        .foregroundStyle(.secondary)
                }

                if !following.isEmpty {
                    Divider().overlay(StarlingsMobileColors.border)
                    ForEach(following) { event in
                        MobileHomeUpcomingRow(
                            event: event,
                            // A countdown belongs to today. "in 2d 14h" beside a
                            // Monday standup is arithmetic, not information —
                            // the date says it better, and the Mac has always
                            // suppressed it here.
                            showsCountdown: !event.isAllDay && (plan.tier(of: event) == .now || plan.tier(of: event) == .today),
                            hidesCountdownWhenJoinable: false,
                            action: { open(event) },
                            join: { join(event) }
                        ) {
                            demote(event, !event.demoted)
                        }
                    }
                }

                if !plan.remainingToday.isEmpty {
                    Divider().overlay(StarlingsMobileColors.border)
                    VStack(alignment: .leading, spacing: 6) {
                        Button(isShowingRemainingToday ? String(localized: "Hide rest of day") : String(localized: "See rest of day")) {
                            isShowingRemainingToday.toggle()
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .underline()

                        if isShowingRemainingToday {
                            ForEach(plan.remainingToday) { event in
                                MobileHomeUpcomingRow(
                                    event: event,
                                    showsCountdown: !event.isAllDay,
                                    hidesCountdownWhenJoinable: false,
                                    action: { open(event) },
                                    join: { join(event) }
                                ) {
                                    demote(event, !event.demoted)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// One meeting on one line. The row opens the event in Calendar; joining a
/// video meeting is on the long-press, so the tail of the day is read the
/// same way whether a row is a call or a room.
private struct MobileHomeUpcomingRow: View {
    let event: MobileCalendarEvent
    var attendees: [CalendarAttendeeSummary] = []
    let showsCountdown: Bool
    var showsContext = false
    let hidesCountdownWhenJoinable: Bool
    /// The hero's Join, drawn as the card's bottom row, inside it.
    var showsJoinButton = false
    let action: () -> Void
    let join: () -> Void
    let toggleDemoted: () -> Void
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var team: MobileTeamStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: action) {
                rowContent
            }
            .buttonStyle(.plain) // hover: meetHomeRow
            .accessibilityHint("Opens in Calendar")
            .contextMenu {
                if event.isVideoMeeting {
                    Button(action: join) {
                        Label(event.platformActionTitle, systemImage: "video")
                    }
                }
                Button(action: toggleDemoted) {
                    Label(
                        event.demoted ? String(localized: "Show in Next") : String(localized: "Hide from Next"),
                        systemImage: event.demoted ? "arrow.up.circle" : "arrow.down.circle"
                    )
                }
            }

            if !attendees.isEmpty {
                // Faces overlapping in a row, at most five and then "+N",
                // each with its RSVP on the corner. The full list
                // lives in the calendar event; the per-person actions that
                // used to sit on each row are in this stack's long-press.
                MobileAttendeeStack(attendees: attendees, source: team.avatarSource)
                    .contentShape(Rectangle())
                    .contextMenu {
                        ForEach(Array(attendees.enumerated()), id: \.offset) { _, attendee in
                            Menu(attendee.displayName) {
                                if let url = attendee.coreURL {
                                    Button {
                                        openURL(url)
                                    } label: {
                                        Label("Open full record", systemImage: "safari")
                                    }
                                }
                                if let email = attendee.normalizedEmail {
                                    Button {
                                        UIPasteboard.general.string = email
                                    } label: {
                                        Label("Copy Email Address", systemImage: "doc.on.doc")
                                    }
                                }
                            }
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        "Guests: " + attendees.map { "\($0.displayName), \($0.statusLabel)" }.joined(separator: "; ")
                    )
                    .accessibilityHint("Long-press for contact actions")
                // The card's 12pt inset is applied outside this content, so
                // 34pt aligns the faces with the schedule text.
                .padding(.leading, 34)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if showsJoinButton {
                joinButton
            }
        }
        .meetHomeRow()
    }

    // Accent only for our own rooms — the same rule the Mac launch screen
    // applies to its upcoming list. Someone else's Zoom link is a way out of
    // the app, not the CTA. An in-person meeting has no button.
    //
    // And only inside the join window: three hours out the card is a
    // countdown, and the room card's Start holds the accent. The countdown
    // rides the button once it is there, so the reason for the button is on
    // the button.
    @ViewBuilder
    private var joinButton: some View {
        if event.isVideoMeeting {
            TimelineView(.periodic(from: .now, by: 15)) { timeline in
                if MeetingFocus.canJoin(event, now: timeline.date) {
                    let label = HStack(spacing: 8) {
                        MobileMeetingPlatformMark(
                            platform: event.meetingPlatform,
                            size: 20,
                            color: event.isStarlingsRoom ? StarlingsMobileColors.accentInk : .primary
                        )
                        Text(MeetingFocus.joinTitle(event.platformActionTitle, for: event, now: timeline.date))
                    }
                    if event.isStarlingsRoom {
                        Button(action: join) { label }
                            .buttonStyle(StarlingsFilledButtonStyle())
                    } else {
                        Button(action: join) { label }
                            .buttonStyle(StarlingsBorderedButtonStyle())
                    }
                }
            }
        }
    }

    private var rowContent: some View {
            HStack(alignment: .top, spacing: 10) {
                // The Home row's leading mark (docs/DESIGN.md, "Home rows"):
                // the platform in the same square well every other Home list
                // leads with, as the Mac's `UpcomingCompactRow`. Our own room
                // is the one accented mark on a row.
                MobileCompactMark(
                    content: .platform(event.meetingPlatform),
                    shape: .square,
                    size: 24,
                    color: event.isStarlingsRoom ? StarlingsMobileColors.accentMark : .secondary
                )
                .meetFirstLineMark(.headline)
                .accessibilityLabel(event.isVideoMeeting ? event.platformActionTitle : "Calendar event")
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.title)
                        .font(.headline)
                        .meetLineLimit(1)
                    Text(MobileMeetingCountdown.schedule(for: event, includingContext: showsContext))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .meetLineLimit(1)
                }
                Spacer(minLength: 8)
                if showsCountdown {
                    TimelineView(.periodic(from: .now, by: 30)) { timeline in
                        let isJoinable = hidesCountdownWhenJoinable
                            && event.isVideoMeeting
                            && MeetingFocus.canJoin(event, now: timeline.date)
                        if !isJoinable {
                            Text(MobileMeetingCountdown.relative(to: event, from: timeline.date))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.trailing)
                        }
                    }
                }
            }
    }
}

/// One phrasing of "when", shared by every row that shows one.
enum MobileMeetingCountdown {
    /// Absolute: "Today 15:00", "Tomorrow 09:30", "Mon 12 Aug 09:30".
    static func schedule(for event: MobileCalendarEvent, includingContext: Bool = false) -> String {
        var parts = [event.startDate.map { StarlingsDateFormatting.dayTime($0) }].compactMap { $0 }
        if includingContext {
            if !event.calendarSummary.isEmpty { parts.append(event.calendarSummary) }
            if let subject = event.subject { parts.append(subject.title) }
        }
        if let travel = CalendarTravelTime.label(minutes: event.travelTimeMinutes) {
            parts.append(travel)
        }
        return parts.joined(separator: " · ")
    }

    /// Relative, and re-derived from `now` on every tick so a meeting that ends
    /// while you are looking at it stops claiming to be in progress.
    static func relative(to event: MobileCalendarEvent, from now: Date) -> String {
        StarlingsDateFormatting.relativeCountdown(start: event.startDate, end: event.endDate, now: now)
    }
}

private extension View {
    /// A card's primary action, with or without the screen's one accent.
    /// Same frame either way; only the fill changes when the hero takes it.
    @ViewBuilder
    func meetPrimaryButtonStyle(accent: Bool) -> some View {
        if accent {
            buttonStyle(StarlingsFilledButtonStyle())
        } else {
            buttonStyle(StarlingsBorderedButtonStyle(minHeight: 48))
        }
    }

    /// The two RSVP looks share one frame; only the fill differs.
    @ViewBuilder
    func meetRSVPButtonStyle(filled: Bool) -> some View {
        if filled {
            buttonStyle(StarlingsFilledButtonStyle(minHeight: 46))
        } else {
            buttonStyle(StarlingsBorderedButtonStyle())
        }
    }
}


/// An attendee as a face with their RSVP as a small badge on its corner
///: declined is a cross, tentative a question mark, no reply a
/// hollow ring, accepted nothing. The face is the member's Meet profile picture
/// when the address is on the roster (`PersonAvatarStore` resolves email to the
/// roster's current version), initials on a neutral disc otherwise. A member
/// wears a thin ring rather than a second symbol. The Mac and the web draw the
/// same thing.
struct MobileAttendeeAvatar: View {
    let name: String
    let email: String?
    /// Nil draws no badge (a guest not yet invited).
    let status: String?
    let isMember: Bool
    let source: PersonAvatarSource?
    var size: CGFloat = 22
    /// A card-coloured edge, so faces overlapping in a stack read as discs.
    var separated = false

    init(attendee: CalendarAttendeeSummary, source: PersonAvatarSource?, size: CGFloat = 22, separated: Bool = false) {
        self.init(
            name: attendee.displayName, email: attendee.normalizedEmail, status: attendee.status,
            isMember: attendee.isMember, source: source, size: size, separated: separated
        )
    }

    init(name: String, email: String?, status: String?, isMember: Bool, source: PersonAvatarSource?, size: CGFloat = 22, separated: Bool = false) {
        self.name = name
        self.email = email
        self.status = status
        self.isMember = isMember
        self.source = source
        self.size = size
        self.separated = separated
    }

    var body: some View {
        PersonAvatarImage(
            email: email,
            displayName: name,
            version: nil,
            diameter: size,
            source: source
        )
        .overlay {
            if isMember {
                Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1)
            }
        }
        .overlay {
            if separated {
                Circle().strokeBorder(Color(.secondarySystemGroupedBackground), lineWidth: 1.5)
                    .padding(-1.5)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let status, status != "accepted" {
                ZStack {
                    Circle().fill(Color(.secondarySystemGroupedBackground))
                    switch status {
                    case "declined":
                        Image(systemName: "xmark").font(.system(size: 6, weight: .heavy))
                    case "tentative":
                        Image(systemName: "questionmark").font(.system(size: 6, weight: .heavy))
                    default:
                        Circle().strokeBorder(Color.primary, lineWidth: 1).padding(2.5)
                    }
                }
                .foregroundStyle(.primary)
                // Inside the face, so it never hangs below the row.
                .frame(width: 10, height: 10)
            }
        }
        .opacity(status == "declined" ? 0.55 : 1)
        .accessibilityHidden(true)
    }
}

/// The compact guest list: overlapping faces, at most five, then "+N". The
/// first face is on top, so each RSVP badge (bottom right) shows over the next
/// face, and a fifth of a face is covered, so two initials stay readable
/// (the web's `AttendeeStack`).
private struct MobileAttendeeStack: View {
    let attendees: [CalendarAttendeeSummary]
    let source: PersonAvatarSource?
    private let size: CGFloat = 22
    private let maximumFaces = 5

    var body: some View {
        // One face too many is not worth a "+1": show it instead.
        let overflow = attendees.count > maximumFaces ? attendees.count - (maximumFaces - 1) : 0
        let shown = overflow > 0 ? Array(attendees.prefix(maximumFaces - 1)) : attendees
        HStack(spacing: -(size * 0.2).rounded()) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, attendee in
                MobileAttendeeAvatar(attendee: attendee, source: source, size: size, separated: true)
                    .zIndex(Double(shown.count - index))
            }
            if overflow > 0 {
                Text("+\(overflow)")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: size, height: size)
                    .background(Circle().fill(StarlingsMobileColors.elevated))
                    .overlay(Circle().strokeBorder(Color(.secondarySystemGroupedBackground), lineWidth: 1.5))
            }
        }
    }
}
