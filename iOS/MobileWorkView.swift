import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// Work — the member surface for the work graph: Mine, Envisioning Projects,
/// Projects, and an optional Sales section for leads. People and agents live in
/// Team, so this view never turns a roster into another kind of work section.
///
/// The projects and leads Envisioning is working on, read from Core through
/// the Worker, and the roster of who — and which software — is addressable
/// the same way. Opening a subject is opening its conversation and its
/// tasks; opening a peer opens the same thread pane. See docs/CHANNELS.md
/// and docs/WORK_SURFACE.md.
struct MobileWorkView: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.openURL) private var openURL
    /// Unread and presence both come from the one roster poll Home reads too,
    /// so a badge on the tab and a dot on a row can never disagree.
    @EnvironmentObject private var team: MobileTeamStore
    /// Mine is the store's list, not a copy: Home's today card and this pane
    /// read the same rows, and a tick on either refreshes both.
    @EnvironmentObject private var work: MobileMyWorkStore
    /// The same unfiled capture list Home draws; Work is where it gets filed.
    @EnvironmentObject private var quickNotes: MobileQuickNotesStore
    @EnvironmentObject private var upcoming: UpcomingMeetingsStore
    /// The subject on screen, driven from outside as well as by a tap: a row
    /// on Home names a project and a pane, and this stack opens it there.
    @State private var path: [WorkDestination] = []
    /// iPad: the rail's marked row. Overview is `.mine(taskID: nil)`, the
    /// value every door already uses for "Work's own lists".
    @State private var railSelection: WorkDestination? = WorkDestination.mine(taskID: nil)
    /// The SUBJECTS order last drawn, so the open subject holds its place.
    @State private var subjectRailOrder: [String] = []
    @State private var isBrowsePresented = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// Core is its own page behind the surface menu, not the foot of the
    /// list; the menu button pushes it.
    @State private var isKeepPresented = false
    @State private var keepProject: CrmSubject?

    @State private var loginDraft = ""
    @State private var isAskingLogin = false
    @State private var query = ""
    @State private var mineFilter = WorkSidebarPreferences.mineFilter()
    /// MINE on Recently finished: a choice in its Due menu, as on the Mac and
    /// the web — not a list of its own. This screen only.
    @State private var mineShowsFinished = false
    @State private var unownedOrigin = WorkSidebarPreferences.unownedOrigin()
    // Every Overview header folds, kept per device under the shared
    // registry's key (`rail-blocks.ts`, `workOverview`) — the Mac's fold store.
    @AppStorage(OverviewFold.inbox) private var inboxFolded = false
    @AppStorage(OverviewFold.activity) private var activityFolded = false
    @AppStorage(OverviewFold.quickNotes) private var quickNotesFolded = false
    @AppStorage(OverviewFold.mine) private var mineFolded = false
    @AppStorage(OverviewFold.unowned) private var unownedFolded = false
    @State private var unownedHiddenSubjects = WorkSidebarPreferences.unownedHiddenSubjects()
    @State private var inboxFilter = WorkSidebarPreferences.inboxFilter()
    /// The search in flight, cancelled when a later one supersedes it —
    /// otherwise a slow early request lands after a fast later one and puts a
    /// stale list on screen.
    @State private var searchTask: Task<Void, Never>?
    @State private var isLoading = false
    @State private var errorMessage: String?
    /// What a swipe did, once Core says it did: the row is already gone by
    /// then, so the hand is the only place the outcome can land.
    @State private var haptic = StarlingsHapticPulse()

    /// The age of the three subject lists — the snapshot's, or the last live
    /// read's — for the line a failed refresh shows beside them.
    @State private var subjectsUpdatedAt: Date?
    /// The subject lists' failed refresh, apart from `errorMessage` (a failed
    /// write): only this one has a list behind it to be old and a read to retry.
    @State private var subjectsRefreshError: String?

    /// Envisioning and Projects share Core's `.project` kind — the split is
    /// purely `isInternalProject`, applied after each is fetched, the same
    /// way the Mac sidebar splits one Core list in two. Each keeps its own
    /// status filter and sort so switching one never disturbs the other,
    /// same as the Mac's independent sections.
    @State private var envisioningSubjects: [CrmSubject] = []
    @State private var envisioningHasMore = false
    // A plain per-session default, like the status filters below — unlike
    // sort, which the task explicitly asks to persist.
    @State private var envisioningStatusFilter = SubjectStatusRegistry.project.defaultFilter
    @State private var envisioningSortOption = WorkSidebarPreferences.sort(
        for: "work.envisioning",
        allowed: CrmSubjectSortOption.all.map(\.id),
        fallback: CrmSubjectSortOption.busiest.id
    )
    /// "Open (16)" on the status menu, same as the Mac. Envisioning's own
    /// counts come straight from Core; client Projects' counts are the
    /// global total minus Envisioning's, since Core has no internal/
    /// external flag to ask for one half directly — see `loadAll()`.
    @State private var envisioningStatusCounts: [String: CrmSubjectStatusCount] = [:]

    @State private var projectSubjects: [CrmSubject] = []
    @State private var projectHasMore = false
    @State private var projectStatusFilter = SubjectStatusRegistry.project.defaultFilter
    @State private var projectSortOption = WorkSidebarPreferences.sort(
        for: "work.projects",
        allowed: CrmSubjectSortOption.all.map(\.id),
        fallback: CrmSubjectSortOption.busiest.id
    )
    @State private var projectStatusCounts: [String: CrmSubjectStatusCount] = [:]

    @State private var leadSubjects: [CrmSubject] = []
    @State private var leadHasMore = false
    /// Organizations (ADR 0006): every CRM organization, through
    /// Core's list filters, Partner on by default. No status or sort of its
    /// own; read behind the three lists and never failing them.
    @State private var partnerSubjects: [CrmSubject] = []
    @State private var partnerHasMore = false
    @State private var organizationFilter = OrganizationListFilter.saved()
    /// Every industry and country, from the last organization read, for the filter menu.
    @State private var organizationFacets: CrmSubjectsResponseFacets?
    /// Contacts: every contact, with its own search and Core's
    /// contact filters. Read only while the group is open.
    @State private var contactRows: [CrmContact] = []
    @State private var contactHasMore = false
    @State private var contactsLoaded = false
    @State private var contactQuery = ""
    @State private var contactFilter = ContactListFilter.saved()
    /// Every country and language, from the last contact read, for the filter menu.
    @State private var contactFacets: CrmContactsResponseFacets?
    @State private var contactError: String?
    /// Goes up when a contact page changed a contact, so the group reads again.
    @State private var contactRevision = 0
    @State private var isPickingContactOrganization = false
    /// The Contacts fold, under the Mac's key. The group starts folded.
    @State private var contactsFolded = UserDefaults.standard.object(
        forKey: RailBlock.foldDefaultsPrefix + MobileContactsGroup.key
    ) as? Bool ?? true
    /// Browse's folded groups, under the Mac's fold keys (`meet.sidebarFold.<group key>`).
    @State private var browseFolded: Set<String> = Set(
        BrowseGroupRegistry.order
            .map { BrowseGroupRegistry.spec(for: $0).preferenceKey }
            .filter { UserDefaults.standard.bool(forKey: RailBlock.foldDefaultsPrefix + $0) }
    )
    /// Upcoming and live CMS events, soonest first (docs/EVENTS.md).
    @State private var eventSubjects: [CrmSubject] = []
    @State private var eventHasMore = false
    @State private var leadStatusFilter = SubjectStatusRegistry.lead.defaultFilter
    @State private var leadSortOption = WorkSidebarPreferences.sort(
        for: "work.leads",
        allowed: CrmSubjectSortOption.all.map(\.id),
        fallback: CrmSubjectSortOption.busiest.id
    )
    @State private var leadStatusCounts: [String: CrmSubjectStatusCount] = [:]
    /// Sales is the Worker's `sales_enabled`, read through the store, so the
    /// choice follows the account across the Mac and the web.
    private var salesVisible: Bool { BrowseGroupRegistry.isShown(.sales, salesEnabled: work.salesEnabled, workModules: work.subjectState.workModules) }
    /// A group whose work module is off is not drawn (docs/WORK_MODEL.md).
    private func groupOn(_ group: SubjectGroup) -> Bool {
        BrowseGroupRegistry.isKindShown(group, state: work.subjectState)
    }

    @State private var editorTarget: MobileSubjectEditorTarget?
    @State private var triageNote: QuickNote?
    /// The decision opened from INBOX, read whole before it is answered.
    @State private var openQuestion: AttentionRequest?
    @State private var openDecision: DecisionAsk?
    /// A Mine row's Delete, while the question is up.
    @State private var deletingTask: MobileTaskDeletion?
    @State private var openFollowUp: InboxFollowUpItem?
    /// A row's "Hand off to …" waiting for its brief.
    @State private var handingOff: MobileHandOffRequest?
    @State private var isCapturingQuickNote = false
    @State private var quickNoteDraft = ""
    @State private var renameTarget: MobileSubjectRenameTarget?
    @State private var renameDraft = ""
    @State private var repoTarget: CrmSubject?
    /// The lead whose Win sheet is up (ADR 0008).
    @State private var winTarget: CrmSubject?

    var body: some View {
        Group {
            // iPad follows the Mac rail (decided 2026-09-29): a
            // sidebar of Overview then SUBJECTS, and Overview's INBOX, Quick
            // Notes and MINE as columns. A compact width — any iPhone, or an
            // iPad in a narrow Split View — keeps the one list.
            if app.isSignedIn, horizontalSizeClass == .regular {
                splitView
            } else {
                NavigationStack(path: $path) {
                    Group {
                        if app.isSignedIn {
                            list
                        } else {
                            signedOut
                        }
                    }
                    .meetSurfaceBackground()
                    .modifier(WorkStackDestinations(destinations: stackDestinations))
                    .navigationTitle("Work")
                    .navigationBarTitleDisplayMode(.large)
                }
            }
        }
        .onChange(of: path) { before, next in
            // A hop is recorded whichever door it came through: into the
            // device's recents, the list Home's Quick Access module and the
            // search sheet share. Only the destination just pushed — a
            // pop leaves nothing behind.
            syncRailSelection(to: next)
            guard next.count > before.count, let subject = next.last?.subject else { return }
            if let row = SearchRow.subject(subject) {
                SearchRecents.remember(row, owner: app.ownerCredentials?.owner.email ?? "")
            }
        }
        // `onReceive` rather than `onChange`: it also fires with whatever
        // is already pending when this tab is first built, which is the
        // case when Home names a project before Work has ever been shown.
        .onReceive(app.$pendingWork) { destination in
            guard let destination else { return }
            // Mine is this tab's own first section (on iPad, Overview's
            // column), so naming it without a row is a pop, not a push: the
            // list is already here.
            if case .mine(let taskID) = destination.target, taskID == nil {
                path = []
            } else {
                path = [destination]
            }
            Task { @MainActor in app.pendingWork = nil }
        }
        .alert("Your GitHub username", isPresented: $isAskingLogin) {
            TextField("octocat", text: $loginDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) { }
            Button("Save") { Task { await saveLogin() } }
        } message: {
            Text("Finds the issues assigned to you.")
        }
        // Polling belongs to the app, not to this tab: Home draws the same
        // unread list, and a ring has to reach somebody who is looking at it.
        // `MobileTeamStore` stops itself when the app goes to the background,
        // and starting it again here is a defensive no-op once it already has.
        .task { team.start() }
    }

    /// Where a pushed Work value lands — the one table the phone's stack and
    /// the iPad's detail stack both declare.
    private var stackDestinations: WorkStackDestinations.Destinations {
        WorkStackDestinations.Destinations(
            destination: { destination in
                AnyView(Group {
                    switch destination.target {
                    case .subject(let subject):
                        MobileSubjectView(
                            subject: subject,
                            initialPane: destination.pane,
                            action: destination.action
                        )
                    case .mine(let taskID):
                        mineDestination(taskID: taskID)
                    case .issue(let owner, let repo, let number):
                        MobileIssueDoor(owner: owner, repo: repo, number: number)
                    case .coreEntity(let id):
                        MobileCoreEntityDoor(id: id)
                    case .contact(let id, _):
                        MobileContactView(contactID: id)
                    }
                })
            },
            // Browse: the directory, pushed from the foot of SUBJECTS
            // ( slice 7). The same four groups the Mac's Browse holds.
            browse: { AnyView(browseList) },
            keep: { landing in
                if let landing {
                    AnyView(MobileKeepScreen(landing: .project(id: landing.id, name: landing.title)))
                } else {
                    AnyView(MobileKeepScreen())
                }
            },
            isBrowsePresented: $isBrowsePresented,
            isKeepPresented: $isKeepPresented,
            keepProject: $keepProject
        )
    }

    // MARK: - iPad: the Mac rail

    /// The rail is Overview, then SUBJECTS with Browse… at its foot — the
    /// Mac's `WorkSidebarPreferences.catalog` since 2026-09-23. The detail
    /// column is one stack: Overview at its root, a subject pushed on it, so
    /// every door that sets `path` (Home, search, a row menu) works unchanged.
    private var splitView: some View {
        surfaceEffects(NavigationSplitView {
            listChrome(
                List(selection: $railSelection) {
                    Group {
                        Section {
                            NavigationLink(value: WorkDestination.mine(taskID: nil)) {
                                Label {
                                    Text("Overview")
                                } icon: {
                                    Image(systemName: "square.grid.2x2")
                                }
                            }
                            .accessibilityHint("Inbox, Quick Notes and Mine")
                        }
                        subjectsSection(inRail: true)
                    }
                    .meetListRows()
                }
                .meetSurfaceBackground()
            )
            .navigationTitle("Work")
            .navigationSplitViewColumnWidth(min: 260, ideal: 300)
        } detail: {
            NavigationStack(path: $path) {
                overviewColumns
                    .meetSurfaceBackground()
                    .modifier(WorkStackDestinations(destinations: stackDestinations))
                    .navigationTitle("Overview")
                    .navigationBarTitleDisplayMode(.large)
            }
        }
        .onChange(of: railSelection) { _, next in
            guard let next else { return }
            if next == WorkDestination.mine(taskID: nil) {
                if !path.isEmpty { path = [] }
            } else if path.first != next {
                path = [next]
            }
        })
    }

    /// Overview on a wide screen: INBOX with Quick Notes below it in one
    /// column, MINE in the other, each scrolling on its own like the Mac's
    /// `StarlingsHalvesSplitView`. Three sections, never one merged list.
    private var overviewColumns: some View {
        HStack(spacing: 0) {
            StarlingsList {
                errorSections
                todaySection
                overviewEmptySection
                inboxSection
                quickNotesSection
                activitySection
            }
            .frame(maxWidth: .infinity)
            Divider()
                .ignoresSafeArea(edges: .bottom)
            StarlingsList {
                mineSection
                unownedSection
            }
            .frame(maxWidth: .infinity)
        }
        .refreshable { await loadAll() }
    }

    /// The rail marks what the detail column shows: Overview at the root, a
    /// subject's row while that subject is open. A task or issue opened from
    /// Overview's columns leaves the rail unmarked rather than calling it
    /// Overview, which would pop it.
    private func syncRailSelection(to next: [WorkDestination]) {
        guard horizontalSizeClass == .regular else { return }
        if next.isEmpty {
            railSelection = WorkDestination.mine(taskID: nil)
        } else if let first = next.first, first.subject != nil {
            if railSelection != first { railSelection = first }
        } else {
            railSelection = nil
        }
    }

    private var signedOut: some View {
        VStack(spacing: 12) {
            MobileSignInButton(prominence: .bordered)
        }
        .padding(28)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// A failed write, a failed Mine read, or a stale subject list — one
    /// notice at the top of the list (on iPad, of Overview's first column).
    @ViewBuilder
    private var errorSections: some View {
            if let errorMessage = work.errorMessage ?? errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage)
                }
            } else if let failure = work.refreshFailure {
                Section {
                    StarlingsErrorNotice(message: failure, updatedAt: work.updatedAt) {
                        Task { await work.refresh() }
                    }
                }
            } else if let subjectsRefreshError {
                Section {
                    StarlingsErrorNotice(message: subjectsRefreshError, updatedAt: subjectsShowingUpdatedAt) {
                        Task { await loadAll(refreshMine: false) }
                    }
                }
            }
    }

    /// The phone's one list (decided 2026-09-29): a phone has no
    /// second column, so Overview's parts stack — today's meetings, then
    /// INBOX, Quick Notes and MINE as three separate sections, never merged,
    /// then one short SUBJECTS list with Browse at its foot. The subjects you
    /// were just in are in Home's Quick Access module, not a row here.
    private var list: some View {
        surfaceEffects(listChrome(
            StarlingsList {
                errorSections

                todaySection

                overviewEmptySection

                inboxSection

                quickNotesSection
                activitySection

                mineSection

                unownedSection

                subjectsSection(inRail: false)
            }
            .refreshable { await loadAll() }
        ))
    }

    /// The bar and the search field Work's list wears — the phone's one
    /// list, or the iPad rail.
    private func listChrome<Content: View>(_ content: Content) -> some View {
        content
        .searchable(text: $query, prompt: String(localized: "Search"))
        // The bar every tab wears (`MobileSurfaceMenu`): the surface menu
        // with Keep, and Add. Sales sits in the SUBJECTS menu.
        .toolbar {
            MobileSurfaceMenu(settingsPage: .work, settingsTitle: "Work settings…") {
                // Only where the workspace has it: the vaults,
                // native, with the key on this phone (docs/KEEP.md).
                if StarlingsWorkspace.active.has(.keep) {
                    Button {
                        isKeepPresented = true
                    } label: {
                        Label("Keep…", systemImage: "key")
                    }
                }
                if StarlingsWorkspace.active.has(.keep) {
                    Divider()
                }
            }
            MobileSurfaceAddMenu {
                Menu {
                    Button {
                        editorTarget = MobileSubjectEditorTarget(kind: .project)
                    } label: {
                        Label("New project…", systemImage: "folder.badge.plus")
                    }
                    Button {
                        // A lead is sales work: filing one turns Sales on.
                        if !salesVisible { Task { await setSalesEnabled(true) } }
                        editorTarget = MobileSubjectEditorTarget(kind: .lead)
                    } label: {
                        Label("New lead…", systemImage: "person.badge.plus")
                    }
                    Button {
                        isCapturingQuickNote = true
                    } label: {
                        Label("New quick note…", systemImage: "note.text.badge.plus")
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add")
            }
        }
    }

    /// What the Work surface does wherever it is drawn: loading, refresh on
    /// another screen's write, haptics, and the sheets its rows open. Applied
    /// once per layout — on iPad around the whole split view, so a sheet a
    /// column opens never hangs off a collapsed sidebar.
    private func surfaceEffects<Content: View>(_ content: Content) -> some View {
        content
        // Another screen wrote and the API layer said which lists that made
        // stale; Mine's store listens for itself.
        .onReceive(NotificationCenter.default.publisher(for: SnapshotStore.didInvalidateNotification).receive(on: DispatchQueue.main)) { note in
            guard let owner = app.ownerCredentials?.owner.email,
                  let prefixes = SnapshotStore.invalidatedPrefixes(in: note, owner: owner)
            else { return }
            if SnapshotStore.matches(key: StarlingsAPI.subjectsSnapshotPrefix, prefixes: prefixes) {
                searchTask?.cancel()
                searchTask = Task { await loadAll(refreshMine: false) }
            }
            if SnapshotStore.matches(key: StarlingsAPI.inboxSnapshotKey, prefixes: prefixes) {
                Task { await work.refreshInbox() }
            }
        }
        .onChange(of: query) { _, _ in schedule() }
        .onChange(of: envisioningStatusFilter) { _, _ in schedule() }
        .onChange(of: projectStatusFilter) { _, _ in schedule() }
        .onChange(of: leadStatusFilter) { _, _ in schedule() }
        // The store reads Mine itself when credentials land; a tab opened in
        // the same breath must not ask Core a second time.
        .task(id: app.ownerCredentials?.accessToken) { await loadAll(refreshMine: !work.readMineJustNow) }
        .meetHaptics(haptic)
        .meetHaptic(.error, whenSet: errorMessage)
        .meetSearchSheet()
        .meetSettingsSheet()
        .sheet(item: $triageNote) { note in
            MobileQuickNoteTriageSheet(note: note)
                .meetDrawer()
        }
        .taskDeleteConfirmation($deletingTask) { deletion in
            Task {
                do {
                    try await work.deleteTask(id: deletion.id)
                    errorMessage = nil
                    haptic.fire(.destructive)
                } catch {
                    errorMessage = (error as? StarlingsError)?.message ?? TaskDeleteCopy.failure
                }
            }
        }
        .sheet(item: $openQuestion) { request in
                MobileAttentionQuestionSheet(request: request).meetDrawer()
            }
            .sheet(item: $openDecision) { ask in
            MobileDecisionSheet(ask: ask) { option, note in answerDecision(ask, option: option, note: note) }
                .meetDrawer()
        }
        .sheet(item: $handingOff) { request in
            MobileHandOffEditor(
                cardTitle: request.target.title,
                agents: team.roster.peers.filter(\.isAgent),
                preselected: request.agent
            ) { agent, handoff in
                Task {
                    do {
                        try await MobileHandOff.send(app: app, target: request.target, to: agent, handoff: handoff)
                        errorMessage = nil
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
            }
        }
        .sheet(item: $openFollowUp) { item in
            MobileFollowUpSheet(item: item) { accept, decline in
                approveFollowUp(item, accept: accept, decline: decline)
            } onDismiss: {
                perform(.dismissFollowUp(item))
            }
            .meetDrawer()
        }
        .alert("New Quick Note", isPresented: $isCapturingQuickNote) {
            TextField("What should you remember?", text: $quickNoteDraft)
            Button("Add") {
                let body = quickNoteDraft
                quickNoteDraft = ""
                Task { if await quickNotes.create(body: body, source: .work) { haptic.fire(.success) } }
            }
            Button("Cancel", role: .cancel) { quickNoteDraft = "" }
        } message: {
            Text("Capture now, file later.")
        }
        .sheet(item: $editorTarget) { target in
            MobileSubjectEditorView(target: target) { detail in
                let summary = detail.summary
                if target.subject == nil {
                    place(summary)
                    path = [WorkDestination(subject: summary, pane: .talk)]
                } else {
                    // A rename can cross the Envisioning/client line (adding
                    // or dropping the "Envisioning " prefix), so drop it from
                    // every list before filing it back under whichever it is
                    // now — same rule the Mac sidebar applies.
                    place(summary)
                }
                editorTarget = nil
                Task { await loadAll() }
            }
        }
        .sheet(item: $winTarget) { lead in
            MobileLeadWinView(lead: lead) { response in won(lead, response) }
        }
        .sheet(item: $repoTarget) { subject in
            MobileProjectRepoPicker(subject: subject) { _ in
                markRepoLinked(subject)
                repoTarget = nil
            }
        }
        .alert(
            "Rename \(renameTarget?.subject.subjectKind.editorTitle.lowercased() ?? "subject")",
            isPresented: Binding(
                get: { renameTarget != nil },
                set: { isPresented in
                    if !isPresented { renameTarget = nil }
                }
            )
        ) {
            TextField("Name", text: $renameDraft)
                .textInputAutocapitalization(.sentences)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Rename") {
                guard let target = renameTarget else { return }
                let title = renameDraft
                renameTarget = nil
                Task { await rename(target.subject, title: title) }
            }
        } message: {
            EmptyView()
        }
    }

    // MARK: - Overview and INBOX

    /// Nothing today, nothing in INBOX, nothing in MINE: one line and the
    /// door to Browse, ahead of the empty blocks.
    @ViewBuilder
    private var overviewEmptySection: some View {
        let wanted = query.trimmingCharacters(in: .whitespaces)
        if wanted.isEmpty, upcoming.todayMeetings.isEmpty,
           work.inbox.items.isEmpty, quickNoteItems.isEmpty,
           work.minePlan(query: "").openCount == 0, work.unownedPlan().openCount == 0, !work.isLoading {
            Section {
                Text("Nothing needs you.")
                    .foregroundStyle(.secondary)
                NavigationLink(value: MobileWorkBrowse()) {
                    Text("Browse subjects")
                }
            }
        }
    }

    /// TODAY: today's meetings about a subject, in start order; a row opens
    /// the subject at Talk. Same rule as the Mac (`WorkTodayMeetings`).
    @ViewBuilder
    private var todaySection: some View {
        let rows = upcoming.todayMeetings
        if query.trimmingCharacters(in: .whitespaces).isEmpty, !rows.isEmpty {
            Section {
                ForEach(rows) { row in
                    NavigationLink(value: WorkDestination(subject: row.subject, pane: .talk)) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title)
                                Text(row.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "calendar")
                        }
                    }
                }
            } header: {
                Text("Today")
            }
        }
    }

    /// INBOX: what needs you, newest first, each row leaving when resolved —
    /// the same list the Mac rail, Home and the tab badge read.
    private var inboxSection: some View {
        // The first text is the row's title, the rest its subtitle — the one
        // matcher (invariant 27), thinning the list in place.
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        func matches(_ texts: [String?]) -> Bool {
            let parts = texts.compactMap { $0 }
            return Search.matches(query: wanted, title: parts.first ?? "", subtitle: parts.dropFirst().joined(separator: " "))
        }
        let unreadIDs = Set(team.unreadSubjectThreads.map(\.id))
        let allItems = work.inbox.items.filter { item in
            switch item {
            case .talk(let thread, _, _, _):
                // A talk row the roster poll has already seen read is dropped
                // rather than shown stale.
                return unreadIDs.contains(thread.id) && matches([thread.subject?.title, thread.lastMessagePreview])
            case .task(let task, let subject, _, _): return matches([task.title, subject.title])
            case .card(let card, _, _): return matches([card.title, card.detail])
            case .followUp: return matches([item.glanceTitle, item.glanceDetail])
            case .note: return false
            case .sales(let touch, _, _): return !touch.dismissed && matches([touch.displayTitle, touch.metadataLabel])
            case .comment(let comment, _, _): return matches([comment.document.title, comment.latest.bodyMd, comment.subject?.title])
            case .booking(let booking, _, _): return matches([booking.booking.guestName, booking.booking.guestOrganization, booking.booking.guestNotes])
            case .invitation(let event, _, _): return matches([item.glanceTitle, item.glanceDetail, event.location])
            case .forwarded(let event, _, _): return matches([item.glanceTitle, item.glanceDetail, event.location])
            case .interest, .submission, .commercial, .decision, .question, .guest: return matches([item.glanceTitle, item.glanceDetail])
            }
        }
        let items = allItems.filter { $0.matches(inboxFilter) }
        return Section {
            if !inboxFolded {
                if let message = work.inboxError {
                    StarlingsErrorNotice(message: message) { Task { await work.refreshInbox() } }
                }
                ForEach(items) { item in
                    workItemRow(item)
                }
                if items.isEmpty && work.inboxError == nil {
                    Text(allItems.isEmpty
                        ? (wanted.isEmpty ? String(localized: "Nothing needs you.") : String(localized: "Nothing matches."))
                        : String(localized: "Nothing matches."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            HStack {
                foldTitle("Inbox", folded: $inboxFolded)
                Spacer()
                // The one total a header keeps: what is waiting on you.
                if !allItems.isEmpty { Text("\(allItems.count)").monospacedDigit() }
                inboxFilterMenu(inboxFilter, items: allItems)
            }
        } footer: {
            if !work.inbox.partial.isEmpty {
                Text(work.inbox.partialLine ?? "")
            }
            if let line = work.inbox.cappedLine {
                Text(line)
            }
        }
    }

    private var activitySection: some View {
        let entries = work.inbox.recent.filter { $0.matchesActivity(query: query) }
        return Section {
            if !activityFolded {
                Text("Latest 30 entries · Past 7 days")
                    .font(.footnote).foregroundStyle(.secondary)
                ForEach(entries) { entry in
                    NavigationLink(value: WorkDestination(subject: entry.subject.crmSubject, pane: .interactions)) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.title)
                                Text(entry.activityDetail).font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "clock") }
                    }
                }
                if work.isLoading && entries.isEmpty {
                    Text("Loading…").font(.footnote).foregroundStyle(.secondary)
                }
                if entries.isEmpty && work.inbox.recentPartial.isEmpty && !work.isLoading && work.inboxError == nil {
                    Text(query.isEmpty ? String(localized: "No activity this week.") : String(localized: "Nothing matches."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !work.inbox.recentPartial.isEmpty || work.inboxError != nil {
                    StarlingsErrorNotice(message: String(localized: "Couldn’t read some activity. Refresh to try again.")) {
                        Task { await work.refreshInbox() }
                    }
                }
            }
        } header: {
            foldTitle(LocalizedStringKey(String(localized: "Activity")), folded: $activityFolded)
        }
    }

    /// Captured notes have their own list directly below INBOX. The rows use
    /// the same feed so the source preference and triage actions stay intact.
    @ViewBuilder
    private var quickNotesSection: some View {
        let allItems = quickNoteItems
        if !allItems.isEmpty {
            let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
            let items = allItems.filter { item in
                switch item {
                case .note(let note, _, _):
                    Search.matches(query: wanted, title: note.body, subtitle: "")
                default:
                    false
                }
            }
            Section {
                if !quickNotesFolded {
                    if items.isEmpty {
                        Text("Nothing matches.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(items) { item in
                        workItemRow(item)
                    }
                }
            } header: {
                HStack {
                    foldTitle("Quick Notes", folded: $quickNotesFolded)
                    Spacer()
                }
            }
        }
    }

    /// INBOX's notes with the captures this phone has not sent yet on top
    ///: the feed only knows what reached the Worker.
    private var quickNoteItems: [WorkInboxItem] {
        let inbox = work.inbox.quickNoteItems
        let known = Set(inbox.compactMap { item -> String? in
            if case .note(let note, _, _) = item { return note.id }
            return nil
        })
        let waiting = quickNotes.pending.values
            .filter { !known.contains($0.id) }
            .sorted { $0.capturedAt > $1.capturedAt }
            .map { WorkInboxItem.note($0.note, key: "pending:\($0.id)", at: $0.capturedAt) }
        return waiting + inbox
    }

    /// One Work row, drawn the way its source's own list presents it.
    @ViewBuilder
    private func workItemRow(_ item: WorkInboxItem) -> some View {
        switch item {
        case .talk(let thread, let mention, _, _):
            if let subject = thread.subject {
                NavigationLink(value: WorkDestination(subject: subject, pane: .talk)) {
                    WorkSidebarRow.subject(
                        subject,
                        hasUnread: true,
                        detail: (mention ? String(localized: "Mentions you · ") : "") + (thread.lastMessagePreview ?? thread.kind.channelNoun.capitalized)
                    )
                }
                // A full swipe right marks it read: the registry's own action,
                // offered only while the row is unread.
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    if let markRead = item.rowActions(client: .ios).markRead {
                        Button { perform(markRead) } label: {
                            Label(markRead.title, systemImage: markRead.symbolName)
                        }
                        .tint(StarlingsMobileColors.accent)
                    }
                }
                .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
            }
        case .task(let task, let subject, _, _):
            NavigationLink(value: WorkDestination(subject: subject, pane: .tasks)) {
                WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    leadingShape: .square,
                    title: task.title,
                    subtitle: String(localized: "Proposed · \(subject.title)"),
                    accessibilityLabel: "\(task.title). Proposed on \(subject.title)."
                )
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Accept") { perform(.accept(task)) }
                    .tint(StarlingsMobileColors.accent)
                Button("Decline", role: .destructive) { perform(.decline(task)) }
                    .tint(.gray)
            }
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .card(let card, _, _):
            // The card itself: the issue view, or the task on its subject.
            NavigationLink(value: card.destination) {
                WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    leadingShape: .square,
                    title: card.title,
                    subtitle: card.detail,
                    accessibilityLabel: "\(card.title). \(card.detail)."
                )
            }
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .followUp(let followUp, _, _):
            Button { openFollowUp = followUp } label: {
                WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    leadingShape: .square,
                    title: item.glanceTitle,
                    subtitle: item.glanceDetail,
                    accessibilityLabel: "\(item.glanceTitle). \(item.glanceDetail)."
                )
            }
            .buttonStyle(.meetPlain)
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .note(let note, _, _):
            Button {
                triageNote = note
            } label: {
                // A capture still on this phone says so.
                let detail = quickNotes.pending[note.id] == nil ? note.detailLabel : String(localized: "Not sent yet")
                WorkSidebarRow(
                    leading: .glyph(systemName: "pencil"),
                    leadingShape: .square,
                    title: note.firstLine,
                    subtitle: detail,
                    accessibilityLabel: String(localized: "\(note.firstLine). \(detail). File this note.")
                )
            }
            .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Delete", role: .destructive) { perform(.deleteNote(note)) }
                Button("File…") { triageNote = note }
                    .tint(StarlingsMobileColors.accent)
            }
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .sales(let touch, _, _):
            Button {
                startLead(from: touch)
            } label: {
                WorkSidebarRow(
                    leading: .glyph(systemName: "tray"),
                    title: touch.displayTitle,
                    subtitle: String(localized: "Sales · ") + touch.metadataLabel,
                    accessibilityLabel: String(localized: "\(touch.displayTitle). \(touch.metadataLabel). Start a lead.")
                )
            }
            .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Dismiss", role: .destructive) { perform(.dismissTouch(touch)) }
                    .tint(.gray)
                Button("Start a lead") { startLead(from: touch) }
                    .tint(StarlingsMobileColors.accent)
            }
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .comment(let comment, _, _):
            let row = WorkSidebarRow(
                leading: .glyph(systemName: "text.bubble"),
                leadingShape: .square,
                title: comment.document.title,
                subtitle: String(localized: "Comment · \(comment.latest.who): \(comment.latest.bodyMd)"),
                accessibilityLabel: "\(comment.document.title). Comment by \(comment.latest.who)."
            )
            if let subject = comment.subject {
                NavigationLink(value: WorkDestination(subject: subject, pane: .talk)) { row }
                    .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
            } else {
                row.contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
            }
        case .booking(let booking, let key, _):
            let name = booking.booking.guestName
            Button {
                if let reference = booking.eventReference { app.openCalendar(eventReference: reference) }
            } label: {
                WorkSidebarRow(
                    leading: .glyph(systemName: "calendar.badge.plus"),
                    title: name,
                    subtitle: booking.detailLabel,
                    accessibilityLabel: String(localized: "\(name). \(booking.detailLabel). Opens the event in Calendar.")
                )
            }
            .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Dismiss", role: .destructive) { perform(.dismissBooking(key: key)) }
                    .tint(.gray)
            }
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .invitation(let event, let key, _):
            // The event in Calendar, as a booking opens; the answers are the
            // swipe and the menu.
            Button {
                app.openCalendar(eventReference: event.eventReference)
            } label: {
                WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    title: item.glanceTitle,
                    subtitle: item.glanceDetail,
                    accessibilityLabel: String(localized: "\(item.glanceTitle). \(item.glanceDetail). Opens the event in Calendar.")
                )
            }
            .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(CalendarRSVP.accepted.answerTitle) { perform(.respondToInvitation(event, .accepted, key: key)) }
                    .tint(StarlingsMobileColors.accent)
                Button(CalendarRSVP.tentative.answerTitle) { perform(.respondToInvitation(event, .tentative, key: key)) }
                Button(CalendarRSVP.declined.answerTitle, role: .destructive) { perform(.respondToInvitation(event, .declined, key: key)) }
                    .tint(.gray)
            }
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .forwarded(let event, let key, _):
            // No event exists yet, so a tap offers the two answers: the
            // row's menu, drawn as a tap menu rather than a long press.
            Menu {
                WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform)
            } label: {
                WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    title: item.glanceTitle,
                    subtitle: item.glanceDetail,
                    accessibilityLabel: String(localized: "\(item.glanceTitle). \(item.glanceDetail). Add to calendar or discard.")
                )
            }
            // `.button` lets the menu take the plain style: a rail row, not an accent link.
            .menuStyle(.button)
            .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Add") { perform(.addForwardedEvent(event, key: key)) }
                    .tint(StarlingsMobileColors.accent)
                Button("Discard", role: .destructive) { perform(.discardForwardedEvent(event, key: key)) }
                    .tint(.gray)
            }
        case .question(let request, _, _):
            Button {
                openQuestion = request
            } label: {
                WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    leadingShape: .square,
                    title: item.glanceTitle,
                    subtitle: item.glanceDetail,
                    accessibilityLabel: String(localized: "\(item.glanceTitle). \(item.glanceDetail). Open the question.")
                )
            }
            .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .decision(let ask, _, _):
            Button {
                openDecision = ask
            } label: {
                WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    leadingShape: .square,
                    title: ask.question,
                    subtitle: ask.detailLabel,
                    accessibilityLabel: String(localized: "\(ask.question). \(ask.detailLabel). Open the decision.")
                )
            }
            .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                // The recommendation in one swipe; any other answer from the menu or the sheet.
                if let recommended = ask.options.first(where: { $0.key == ask.recommendation }) {
                    Button("Recommended") { perform(.answerDecision(ask, option: recommended)) }
                        .tint(StarlingsMobileColors.accent)
                }
            }
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .interest, .submission, .commercial:
            Group {
                let row = WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    leadingShape: item.glanceUsesSquareMark ? .square : .round,
                    title: item.glanceTitle,
                    subtitle: item.glanceDetail,
                    accessibilityLabel: "\(item.glanceTitle). \(item.glanceDetail)."
                )
                // The lead it filed, or the subject an offer or license is
                // on, opens; an older form row has nowhere to go.
                if let destination = item.glanceDestination {
                    NavigationLink(value: destination) { row }
                } else {
                    row
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Dismiss", role: .destructive) { perform(.dismissBooking(key: item.id)) }
                    .tint(.gray)
            }
            .contextMenu { WorkRowActionMenu(groups: item.rowActions(client: .ios), perform: perform) }
        case .guest(let guest, _, _):
            // An app user's or a public contact's line on intake opens the
            // conversation in Team; a guest line on a subject opens its Talk.
            Button {
                if let threadID = item.glanceThreadID {
                    app.openTeam(threadID: threadID, title: item.glanceTitle)
                } else {
                    app.openWork(subject: guest.crmSubject, pane: .talk)
                }
            } label: {
                WorkSidebarRow(
                    leading: .glyph(systemName: item.glanceSymbolName),
                    leadingShape: .round,
                    title: item.glanceTitle,
                    subtitle: item.glanceDetail,
                    accessibilityLabel: String(localized: "\(item.glanceTitle). \(item.glanceDetail). Open the conversation.")
                )
            }
            .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Dismiss", role: .destructive) { perform(.dismissBooking(key: item.id)) }
                    .tint(.gray)
            }
        }
    }

    /// One row's menu choice. What opens a screen or a sheet is done here;
    /// a write goes to the store, which Home's card shares
    /// (`MobileMyWorkStore.perform`).
    /// After the call: approve, then open the draft in the mail app.
    private func approveFollowUp(_ item: InboxFollowUpItem, accept: [String], decline: [String]) {
        Task {
            guard let credentials = app.ownerCredentials else { return }
            do {
                let answer = try await app.api.approveFollowUp(credentials: credentials, item, accept: accept, decline: decline)
                let draft = FollowUpMail.draft(to: answer.mail.to, subject: answer.mail.subject, body: answer.mail.body)
                if draft.bodyOnClipboard { UIPasteboard.general.string = answer.mail.body }
                if let url = draft.url { openURL(url) }
                if draft.bodyOnClipboard { app.alertMessage = String(localized: "The message is on the clipboard. Paste it into the mail.") }
                await work.refreshInbox()
                await work.refresh()
            } catch {
                app.alertMessage = error.localizedDescription
            }
        }
    }

    /// Who a row can be handed to.
    private var agents: [Peer] { team.roster.peers.filter(\.isAgent) }

    private func perform(_ action: WorkRowAction) {
        switch action {
        case .open(let destination, _):
            path.append(destination)
        case .openDocument(let id, let title):
            app.openDocument(id: id, title: title)
        case .openCore(let url):
            openURL(url)
        case .openEvent(let reference):
            app.openCalendar(eventReference: reference)
        case .openConversation(let thread):
            if let subject = thread.subject { path.append(WorkDestination(subject: subject, pane: .talk)) } else { app.openTeam(threadID: thread.id) }
        case .fileNote(let note):
            triageNote = note
        case .openQuestion(let request):
            openQuestion = request
        case .openDecision(let ask):
            openDecision = ask
        case .openFollowUp(let item):
            openFollowUp = item
        case .handOff(let target, let agent):
            handingOff = MobileHandOffRequest(target: target, agent: agent)
        case .deleteTask(let id, let title):
            deletingTask = MobileTaskDeletion(id: id, title: title)
        case .deleteNote(let note):
            Task {
                if await quickNotes.delete(note) { haptic.fire(.destructive) }
                await work.refreshInbox()
            }
        case .startLead(let touch):
            startLead(from: touch)
        case .copyEmail(let email):
            UIPasteboard.general.string = email
        default:
            Task {
                do {
                    let talk = try await work.perform(action)
                    errorMessage = nil
                    haptic.fire(action.leavesByRefusal ? .destructive : .success)
                    if talk { await team.refresh() }
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func answerDecision(_ ask: DecisionAsk, option: DecisionAskOption, note: String?) {
        Task {
            do {
                try await work.answerDecision(ask, option: option, note: note)
                errorMessage = nil
                haptic.fire(.success)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Mine

    private var mineSection: some View {
        Group {
            // One list in the order it is owed, from the same table of rules
            // the Mac and the web answer to (fixtures/work-items.json). The
            // store plans first and searches second, so a promoted task stays
            // the canonical row even when a query matches its GitHub ref.
            // One section, no date headers: the row says its date, and
            // MINE reads the same on the Mac and the web.
            let allPlan = work.minePlan(query: query)
            let plan = allPlan.filtered(by: mineFilter)
            Section {
                if !mineFolded {
                    if mineShowsFinished {
                        finishedRows
                    } else {
                        ForEach(plan.order) { item in
                            mineRow(item)
                        }
                        if plan.openCount == 0 && !work.isLoading {
                            let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
                            Text(allPlan.openCount > 0
                                ? String(localized: "Nothing matches.")
                                : (wanted.isEmpty ? String(localized: "Nothing is assigned to you.") : String(localized: "Nothing matches.")))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if work.githubLogin == nil {
                        // The honest reason the half is missing, and the fix, in
                        // the place where it is noticed.
                        Button("Set your GitHub username") {
                            loginDraft = ""
                            isAskingLogin = true
                        }
                        .font(.callout)
                    }
                }
            } header: {
                HStack {
                    foldTitle("Mine", folded: $mineFolded)
                    Spacer()
                    mineFilterMenu(mineFilter)
                }
            } footer: {
                if let githubLogin = work.githubLogin {
                    Text("Matched to @\(githubLogin) on GitHub.")
                } else {
                    Text("GitHub usernames, not emails.")
                }
            }
        }
    }

    /// MINE on Recently finished: your own work closed this week, of the
    /// type MINE's Type menu names, newest first, each with Reopen.
    @ViewBuilder
    private var finishedRows: some View {
        if let error = work.recentlyClosedError {
            StarlingsErrorNotice(message: error)
        }
        let items = work.recentlyClosed.filter { mineFilter.origin == .all || $0.kind.rawValue == mineFilter.origin.rawValue }
        if items.isEmpty && work.recentlyClosedError == nil {
            Text("Nothing finished this week.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        ForEach(items) { item in
            HStack(spacing: 10) {
                Image(systemName: item.kind == .task ? "checkmark.circle" : "exclamationmark.circle")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.body)
                    Text(item.subjectTitle ?? item.issue.map { "\($0.repo) #\($0.number)" } ?? String(localized: "Task"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button("Reopen") {
                    Task {
                        do {
                            try await work.reopenRecentlyClosed(item)
                            errorMessage = nil
                        } catch {
                            errorMessage = error.localizedDescription
                        }
                    }
                }
                .buttonStyle(.borderless)
            }
            .padding(.vertical, 3)
        }
    }

    // MARK: - Unowned

    /// Below MINE: open work nobody on our side holds, on every subject
    /// (docs/BOARD.md §Unowned). The same rows as MINE, so a row reads and
    /// swipes the same; absent when there is none, because a section that
    /// reads empty every day stops being read.
    @ViewBuilder
    private var unownedSection: some View {
        let allPlan = work.unownedPlan(query: query)
        let plan = UnownedSubjects.shown(allPlan, hidden: unownedHiddenSubjects, issueSubjects: work.unownedIssueSubjects)
            .filtered(by: MineFilter(section: .all, origin: unownedOrigin))
        // A failed read is red with Copy and Retry, naming each source and
        // its cause; a subject that hit the row cap is quiet copy.
        let failure = work.unownedError ?? work.unownedGaps.failureLine
        let truncated = work.unownedError == nil ? work.unownedGaps.truncatedLine : nil
        if allPlan.openCount > 0 || failure != nil {
            Section {
                if !unownedFolded {
                    if let failure {
                        StarlingsErrorNotice(message: failure) {
                            Task { await work.refresh() }
                        }
                    }
                    if let truncated {
                        Text(truncated)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(plan.order) { item in
                        mineRow(item, assignTeam: work.assignableTeam)
                    }
                    if plan.openCount == 0 && allPlan.openCount > 0 {
                        Text("Nothing matches.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                HStack {
                    foldTitle("Unowned", folded: $unownedFolded)
                    Spacer()
                    if allPlan.openCount > 0 {
                        unownedFilterMenu(allPlan)
                    }
                }
            } footer: {
                Text("Open on a subject, and nobody on our side holds it.")
            }
        }
    }

    /// One of your own rows, read on its own. The store may not hold it yet
    /// when Home named it on a cold tab, and it may never hold it again if it
    /// was completed somewhere else — both are said rather than drawn blank.
    @ViewBuilder
    private func mineDestination(taskID: String?) -> some View {
        // UNOWNED's rows open here too: same summary shape, nobody's yet.
        if let taskID, let task = work.tasks.first(where: { $0.id == taskID }) ?? work.unownedTasks.first(where: { $0.id == taskID }) {
            MobileTaskView(summary: task)
        } else if taskID != nil, work.isLoading {
            // A whole screen with nothing to stand in for: the one place a
            // centred wait is right (EnvisioningUI States.swift, rule 4).
            EnvisioningLoadingState(String(localized: "Loading…"))
        } else {
            ContentUnavailableView(
                "Not on your list",
                systemImage: "checkmark.circle",
                description: Text("This task is not assigned to you any more.")
            )
        }
    }

    /// One planned row. The planner already decided which side is set and
    /// where the row sits, so this only draws — and keeps the two swipes on
    /// the task rows, because ticking work off where it is read is the whole
    /// point of Mine.
    ///
    /// `assignTeam` is set on an UNOWNED row: its menu is the registry's
    /// `unowned`, which leads with Assign to ▸.
    @ViewBuilder
    private func mineRow(_ item: PlannedWorkItem, assignTeam: [CrmTeamMember]? = nil) -> some View {
        switch item {
        case .task(let task):
            // The row opens the task, not its subject: the task is what was
            // tapped, and the reader links back to the subject in its own
            // Details section. It is also the only way a task Core kept
            // without a subject can be opened at all.
            NavigationLink(value: WorkDestination.mine(taskID: task.id)) {
                MyTaskRow(task: task)
            }
            .transition(.opacity.combined(with: .move(edge: .leading)))
            // What you owe can be ticked off where it is read, without
            // opening the subject: the one edit worth a swipe. Same write the
            // subject's list makes.
            .swipeActions(edge: .trailing) {
                Button {
                    perform(.complete(task))
                } label: {
                    Label("Done", systemImage: "checkmark.circle")
                }
                .tint(StarlingsMobileColors.accent)
            }
            .swipeActions(edge: .leading) {
                // Only for a project with somewhere to file, and only once: a
                // second filing would orphan the first.
                if task.projectID != nil, task.githubIssueNumber == nil {
                    Button {
                        perform(.promote(task))
                    } label: {
                        Label("File on GitHub", systemImage: "arrow.up.forward.square")
                    }
                }
            }
            .contextMenu {
                WorkRowActionMenu(
                    groups: assignTeam.map {
                        task.rowActions(context: .unowned, client: .ios, team: $0, me: app.ownerCredentials?.owner.email, agents: agents)
                    } ?? task.rowActions(context: .mine, client: .ios, agents: agents),
                    perform: perform
                )
                MobileFavoriteAction(target: FavoriteTarget(kind: .crmTask, targetRef: task.id))
            }
        case .issue(let issue):
            NavigationLink {
                MobileIssueView(issue: issue, onChange: {
                    Task { await work.refresh() }
                })
            } label: {
                IssueRow(issue: issue)
            }
            .contextMenu {
                WorkRowActionMenu(
                    groups: assignTeam.map { team in
                        issue.rowActions(projectID: nil, context: .unowned, client: .ios, team: team, me: app.ownerCredentials?.owner.email, agents: agents)
                            .map { $0.filter { $0.isAssign || $0.isIssueStateChange || $0.isHandOff } }
                            .filter { !$0.isEmpty }
                    } ?? [issue.stateActions(projectID: nil)],
                    perform: perform
                )
                MobileFavoriteAction(target: FavoriteTarget(
                    kind: .githubIssue,
                    targetRef: "\(issue.owner.lowercased())/\(issue.repo.lowercased())#\(issue.number)"
                ))
            }
        case .subjectTask:
            // Mine is built from `CrmMyTask` and issues only.
            EmptyView()
        }
    }

    // MARK: - Sales touches, as INBOX draws them

    private func startLead(from touch: UntriagedTouch) {
        editorTarget = MobileSubjectEditorTarget(
            kind: .lead,
            prefill: .init(
                title: touch.prefill.title,
                notes: touch.draftNotes,
                organizationID: touch.prefill.organizationID,
                contactID: touch.prefill.contactID
            )
        )
    }

    private func setSalesEnabled(_ enabled: Bool) async {
        do {
            try await work.setSalesEnabled(enabled)
            errorMessage = nil
            await loadAll(refreshMine: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - SUBJECTS and Browse

    /// One bounded, automatic wall of subjects. Browse remains the full
    /// directory; the wall floats what matters from live signals so it does
    /// not turn into a 70-row upfront list.
    /// `inRail` is the iPad sidebar, whose rows select rather than push and
    /// whose Browse… opens in the detail column.
    private func subjectsSection(inRail: Bool) -> some View {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let everything = envisioningSubjects + projectSubjects + partnerSubjects + eventSubjects + leadSubjects
        let listed = everything.filter { subject in
            let state = work.resolvedState(for: subject)
            return searching || state.listed
        }
        let ranked = WorkSubjectRanker.rail(
            listed,
            signals: Dictionary(uniqueKeysWithValues: listed.map { subject in
                let state = work.resolvedState(for: subject)
                return (subject.id, WorkRankSignals(
                    starred: state.starred,
                    directAttention: false,
                    unread: team.unreadSubjectIDs.contains(subject.id)
                ))
            }),
            holding: path.first?.subject?.id,
            previous: subjectRailOrder
        )
        let ordered = ranked.map(\.subject)
        let empty = String(localized: "No active subjects yet.")
        return Section {
            if isLoading && everything.isEmpty {
                EnvisioningPlaceholderRows()
            }
            if ordered.isEmpty {
                Text(searching ? String(localized: "Nothing matches.") : empty)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            subjectRows(ordered, emptyMessage: "")
            let browseRow = WorkSidebarRow(
                leading: .glyph(systemName: "list.bullet.rectangle"),
                title: String(localized: "Browse…"),
                subtitle: String(localized: "Every subject, by relationship"),
                isSubdued: true,
                accessibilityLabel: String(localized: "Browse every subject")
            )
            if inRail {
                Button {
                    railSelection = nil
                    path = []
                    isBrowsePresented = true
                } label: {
                    browseRow
                }
                .buttonStyle(.plain) // hover: rail row, rows do not lift (DESIGN.md)
            } else {
                NavigationLink(value: MobileWorkBrowse()) { browseRow }
            }
        } header: {
            HStack {
                Text("Subjects")
                Spacer()
            }
        }
        .onChange(of: ordered.map(\.id), initial: true) { _, ids in
            subjectRailOrder = ids
        }
    }

    private func mineFilterMenu(_ filter: MineFilter) -> some View {
        Menu {
            let counted = work.minePlan(query: query)
            Picker("Due", selection: Binding<MineSectionFilter?>(
                get: { mineShowsFinished ? nil : filter.section },
                set: { next in
                    // nil is Recently finished: the open list gives way to it.
                    guard let next else { mineShowsFinished = true; return }
                    mineShowsFinished = false
                    var updated = filter
                    updated.section = next
                    changeMineFilter(updated)
                }
            )) {
                ForEach(MineSectionFilter.allCases, id: \.self) { option in
                    Text("\(option.title) (\(counted.count(matching: MineFilter(section: option, origin: filter.origin))))").tag(Optional(option))
                }
                Text("Recently finished (\(finishedCount(filter.origin)))").tag(MineSectionFilter?.none)
            }
            .pickerStyle(.menu)
            Picker("Type", selection: Binding(
                get: { filter.origin },
                set: { next in
                    var updated = filter
                    updated.origin = next
                    changeMineFilter(updated)
                }
            )) {
                ForEach(MineOriginFilter.allCases, id: \.self) { option in
                    let count = mineShowsFinished
                        ? finishedCount(option)
                        : counted.count(matching: MineFilter(section: filter.section, origin: option))
                    Text("\(option.title) (\(count))").tag(option)
                }
            }
            .pickerStyle(.menu)
            if !filter.isDefault || mineShowsFinished {
                Divider()
                Button("Reset") {
                    mineShowsFinished = false
                    changeMineFilter(.default)
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .foregroundStyle(filter.isDefault && !mineShowsFinished ? AnyShapeStyle(.secondary) : AnyShapeStyle(StarlingsMobileColors.accent))
        }
        .textCase(nil)
        .accessibilityLabel("Filter Mine")
    }

    private func changeUnownedHidden(_ keys: Set<String>) {
        unownedHiddenSubjects = keys
        WorkSidebarPreferences.setUnownedHiddenSubjects(keys)
    }

    /// A section header's title that folds the section: chevron, then the name.
    private func foldTitle(_ title: LocalizedStringKey, folded: Binding<Bool>) -> some View {
        Button {
            withAnimation(.snappy) { folded.wrappedValue.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: folded.wrappedValue ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.semibold))
                Text(title)
            }
        }
        .buttonStyle(.meetPlain)
        .accessibilityValue(folded.wrappedValue ? Text("Folded") : Text("Open"))
    }

    /// Recently finished rows of one type, for the count beside a menu row.
    private func finishedCount(_ origin: MineOriginFilter) -> Int {
        work.recentlyClosed.filter { origin == .all || $0.kind.rawValue == origin.rawValue }.count
    }

    /// UNOWNED's filter: Type (tasks, GitHub issues, or both), then one
    /// toggle per subject with unowned work of that type.
    private func unownedFilterMenu(_ all: WorkPlan<PlannedWorkItem>) -> some View {
        let shown = UnownedSubjects.shown(all, hidden: unownedHiddenSubjects, issueSubjects: work.unownedIssueSubjects)
        let subjects = UnownedSubjects.choices(all, origin: unownedOrigin, issueSubjects: work.unownedIssueSubjects)
        return Menu {
            Picker("Type", selection: Binding(
                get: { unownedOrigin },
                set: { next in
                    unownedOrigin = next
                    WorkSidebarPreferences.setUnownedOrigin(next)
                }
            )) {
                ForEach(MineOriginFilter.allCases, id: \.self) { option in
                    Text("\(option.title) (\(shown.count(matching: MineFilter(section: .all, origin: option))))").tag(option)
                }
            }
            .pickerStyle(.menu)
            if !subjects.isEmpty {
                Section("Subjects") {
                    ForEach(subjects) { subject in
                        Button {
                            var next = unownedHiddenSubjects
                            if next.remove(subject.key) == nil { next.insert(subject.key) }
                            changeUnownedHidden(next)
                        } label: {
                            if unownedHiddenSubjects.contains(subject.key) {
                                Text("\(subject.title) (\(subject.count))")
                            } else {
                                Label("\(subject.title) (\(subject.count))", systemImage: "checkmark")
                            }
                        }
                    }
                }
            }
            if !unownedHiddenSubjects.isEmpty {
                Divider()
                Button("Show all subjects") { changeUnownedHidden([]) }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .foregroundStyle(unownedOrigin == WorkSidebarPreferences.unownedOriginDefault && unownedHiddenSubjects.isEmpty ? AnyShapeStyle(.secondary) : AnyShapeStyle(StarlingsMobileColors.accent))
        }
        .textCase(nil)
        .accessibilityLabel("Filter Unowned")
    }

    private func inboxFilterMenu(_ filter: InboxFilterSource, items: [WorkInboxItem]) -> some View {
        let present = Set(items.map(\.filterSource))
        let options = InboxFilterSource.allCases.filter { $0 != .note && ($0 == .all || present.contains($0) || $0 == filter) }
        return Menu {
            Picker("Source", selection: Binding(
                get: { filter },
                set: { changeInboxFilter($0) }
            )) {
                ForEach(options, id: \.self) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.menu)
            if !filter.isDefault {
                Divider()
                Button("Reset") { changeInboxFilter(.all) }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .foregroundStyle(filter.isDefault ? AnyShapeStyle(.secondary) : AnyShapeStyle(StarlingsMobileColors.accent))
        }
        .textCase(nil)
        .accessibilityLabel("Filter Inbox")
    }

    private func changeMineFilter(_ filter: MineFilter) {
        mineFilter = filter
        WorkSidebarPreferences.setMineFilter(filter)
    }

    private func changeInboxFilter(_ filter: InboxFilterSource) {
        inboxFilter = filter
        WorkSidebarPreferences.setInboxFilter(filter)
    }

    /// The directory: the four groups by relationship, each by organization,
    /// with the status filter and sort the rail used to carry. SALES only
    /// with Sales on. What you do not follow sits behind one line per group.
    private var browseList: some View {
        StarlingsList {
            if groupOn(.envisioning) {
            subjectSection(
                title: StarlingsWorkspace.active.projectGroupName,
                subjects: envisioningSubjects,
                hasMore: envisioningHasMore,
                statusOptions: CrmSubjectStatusOption.project,
                statusCounts: envisioningStatusCounts,
                statusFilter: $envisioningStatusFilter,
                sortOption: $envisioningSortOption,
                sortKey: BrowseGroupRegistry.spec(for: .envisioning).preferenceKey
            )
            }
            if groupOn(.clients) {
            subjectSection(
                title: SubjectGroup.clients.title.capitalized,
                subjects: projectSubjects,
                hasMore: projectHasMore,
                statusOptions: CrmSubjectStatusOption.project,
                statusCounts: projectStatusCounts,
                statusFilter: $projectStatusFilter,
                sortOption: $projectSortOption,
                sortKey: BrowseGroupRegistry.spec(for: .clients).preferenceKey
            )
            }
            if groupOn(.partners) {
            subjectSection(
                title: SubjectGroup.partners.title.capitalized,
                subjects: partnerSubjects,
                hasMore: partnerHasMore,
                statusOptions: [],
                statusCounts: [:],
                statusFilter: nil,
                sortOption: nil,
                sortKey: BrowseGroupRegistry.spec(for: .partners).preferenceKey,
                emptyMessage: organizationFilter.isDefault ? String(localized: "No partners yet.") : String(localized: "Nothing matches."),
                headerAccessory: AnyView(organizationFilterMenu)
            )
            contactsSection
            }
            if groupOn(.events) {
            subjectSection(
                title: SubjectGroup.events.title.capitalized,
                subjects: eventSubjects,
                hasMore: eventHasMore,
                statusOptions: [],
                statusCounts: [:],
                statusFilter: nil,
                sortOption: nil,
                sortKey: BrowseGroupRegistry.spec(for: .events).preferenceKey
            )
            }
            if salesVisible {
                subjectSection(
                    title: SubjectGroup.sales.title.capitalized,
                    subjects: leadSubjects,
                    hasMore: leadHasMore,
                    statusOptions: CrmSubjectStatusOption.lead,
                    statusCounts: leadStatusCounts,
                    statusFilter: $leadStatusFilter,
                    sortOption: $leadSortOption,
                    sortKey: BrowseGroupRegistry.spec(for: .sales).preferenceKey
                )
            } else if groupOn(.sales) {
                Section {
                    Button("Turn Sales on") { Task { await setSalesEnabled(true) } }
                } footer: {
                    Text("The lead pipeline, sales touches in Inbox, and open leads on your list. Follows your account.")
                }
            }
            // The records with no subject page (decided by MZ, 2026-11-05): the phone reads them.
            if work.subjectState.workModules?.contains(.offers) ?? true {
                MobileOffersGroup(api: app.api, credentials: app.ownerCredentials)
            }
            if work.subjectState.workModules?.contains(.licenses) ?? true {
                MobileLicensesGroup(api: app.api, credentials: app.ownerCredentials)
            }
            // The foot of Browse: the registry's tables with no subject door
            // yet (#1262). Only where the workspace has them.
            if StarlingsWorkspace.active.has(.core) {
                Section {
                    NavigationLink {
                        otherRecordsList
                    } label: {
                        WorkSidebarRow(
                            leading: .glyph(systemName: "square.grid.2x2"),
                            title: String(localized: "Other records"),
                            subtitle: ""
                        )
                    }
                }
            }
        }
        .searchable(text: $query, prompt: String(localized: "Search"))
        .task(id: MobileContactsGroup.LoadKey(open: !contactsFolded, query: contactQuery, filter: contactFilter, revision: contactRevision)) {
            await loadContacts()
        }
        .onReceive(NotificationCenter.default.publisher(for: .mobileContactsDidChange)) { _ in
            contactRevision += 1
        }
        .sheet(isPresented: $isPickingContactOrganization) {
            MobileContactOrganizationFilterView(filter: contactFilter) { next in changeContactFilter(next) }
        }
        .navigationTitle("Browse")
        .navigationBarTitleDisplayMode(.large)
    }

    /// The page behind Browse's foot row: the registry's tables with no
    /// subject door yet.
    private var otherRecordsList: some View {
        StarlingsList {
            MobileCoreSection()
        }
        .navigationTitle("Other records")
        .navigationBarTitleDisplayMode(.large)
    }

    /// A subject row's menu. Which actions, in what order, for which kind comes from the shared
    /// action table (`WorkRowActionRegistry`, pinned to `fixtures/work-actions.json`), as a task
    /// row's does; this supplies what each one does here, and its words.
    @ViewBuilder
    private func subjectMenu(_ subject: CrmSubject) -> some View {
        let groups = WorkRowActionRegistry.groups(
            kind: .subject,
            context: subject.isPartner ? "organization" : "row",
            client: .ios,
            facts: WorkRowActionFacts([
                "isPartner": subject.isPartner,
                "isEvent": subject.isEvent,
                "isProject": subject.kind == "project",
                "isOpenLead": subject.isOpenLead,
                "hasRepo": subject.hasRepo,
                "hasCore": subject.coreURL != nil,
            ])
        )
        ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
            if index > 0 { Divider() }
            ForEach(group, id: \.rawValue) { action in
                subjectAction(action, subject)
            }
        }
    }

    private func subjectButton(_ title: String, _ symbol: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) { Label(title, systemImage: symbol) }
    }

    @ViewBuilder
    private func subjectAction(_ action: WorkRowActionID, _ subject: CrmSubject) -> some View {
        let state = work.resolvedState(for: subject)
        switch action {
        case .star where work.subjectState != .unknown:
            subjectButton(state.starred ? String(localized: "Unstar") : String(localized: "Star"), state.starred ? "star.slash" : "star") {
                Task { await changeState(subject, SubjectStateUpdate(starred: !state.starred)) }
            }
        case .mute where work.subjectState != .unknown:
            subjectButton(state.muted ? String(localized: "Unmute") : String(localized: "Mute"), state.muted ? "bell" : "bell.slash") {
                Task { await changeState(subject, SubjectStateUpdate(muted: !state.muted)) }
            }
        case .open:
            subjectButton(String(localized: "Open"), "arrow.up.right") {
                // A partner's Open lands on its Overview; anything else on its Talk.
                path = [WorkDestination(subject: subject, pane: subject.isPartner ? .overview : .talk)]
            }
        case .openTalk:
            subjectButton(String(localized: "Open talk"), "bubble.left") { path = [WorkDestination(subject: subject, pane: .talk)] }
        case .openHistory:
            subjectButton(String(localized: "Open history"), "clock") { path = [WorkDestination(subject: subject, pane: .interactions)] }
        case .openTasks:
            subjectButton(String(localized: "Open tasks"), "checklist") { path = [WorkDestination(subject: subject, pane: .tasks)] }
        case .newTask:
            subjectButton(String(localized: "New task"), "plus.circle") { path = [WorkDestination(subject: subject, pane: .tasks, action: .newTask)] }
        case .openIssues:
            subjectButton(String(localized: "Open issues"), "exclamationmark.circle") { path = [WorkDestination(subject: subject, pane: .issues)] }
        case .newIssue:
            subjectButton(String(localized: "New issue"), "plus.circle") { path = [WorkDestination(subject: subject, pane: .issues, action: .newIssue)] }
        case .editDetails:
            subjectButton(String(localized: "Edit details"), "slider.horizontal.3") {
                editorTarget = MobileSubjectEditorTarget(kind: subject.subjectKind, subject: subject)
            }
        case .rename:
            subjectButton(String(localized: "Rename…"), "pencil") { beginRename(subject) }
        case .winLead:
            subjectButton(String(localized: "Win…"), WorkRowActionID.winLead.menuSymbol.rawValue) { winTarget = subject }
        case .startRoom:
            // The room files itself under this subject the moment it is up.
            if app.isSignedIn {
                subjectButton(String(localized: "Meet about this"), "video") { app.startRoom(about: subject) }
            }
        case .linkRepository:
            subjectButton(String(localized: "Link GitHub repository…"), "link") { repoTarget = subject }
        case .keepVault where StarlingsWorkspace.active.has(.keep):
            // The project's vault in Keep, made on first open (docs/KEEP.md).
            subjectButton(String(localized: "Keep vault"), "key") { keepProject = subject }
        case .openCore:
            if let url = subject.coreURL {
                subjectButton(String(localized: "Open full record"), "safari") { openURL(url) }
            }
        default:
            EmptyView()
        }
    }

    private func changeState(_ subject: CrmSubject, _ update: SubjectStateUpdate) async {
        do {
            try await work.setSubjectState(subject, update: update)
            if update.starred != nil { await app.refreshFavorites() }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Core's organization list filters: Partner, Agency and
    /// Existing client turn on and off; Industry and Country pick one value
    /// from what the organizations carry.
    private var organizationFilterMenu: some View {
        Menu {
            Toggle("Partner", isOn: organizationBinding(\.partner))
            Toggle("Agency", isOn: organizationBinding(\.agency))
            Toggle("Existing client", isOn: organizationBinding(\.existingClient))
            if let facets = organizationFacets {
                if !facets.industries.isEmpty {
                    Picker("Industry", selection: organizationBinding(\.industry)) {
                        Text("Any").tag(String?.none)
                        ForEach(facets.industries, id: \.self) { Text(verbatim: $0).tag(String?.some($0)) }
                    }
                    .pickerStyle(.menu)
                }
                if !facets.countries.isEmpty {
                    Picker("Country", selection: organizationBinding(\.country)) {
                        Text("Any").tag(String?.none)
                        ForEach(facets.countries, id: \.self) { Text(verbatim: $0).tag(String?.some($0)) }
                    }
                    .pickerStyle(.menu)
                }
            }
            if !organizationFilter.isDefault {
                Divider()
                Button("Reset") { changeOrganizationFilter(.default) }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .foregroundStyle(organizationFilter.isDefault ? AnyShapeStyle(.secondary) : AnyShapeStyle(StarlingsMobileColors.accent))
        }
        .textCase(nil)
        .accessibilityLabel("Filter Organizations")
    }

    private func organizationBinding<Value>(_ path: WritableKeyPath<OrganizationListFilter, Value>) -> Binding<Value> {
        Binding(
            get: { organizationFilter[keyPath: path] },
            set: { value in
                var next = organizationFilter
                next[keyPath: path] = value
                changeOrganizationFilter(next)
            }
        )
    }

    private func changeOrganizationFilter(_ next: OrganizationListFilter) {
        guard next != organizationFilter else { return }
        organizationFilter = next
        next.save()
        Task { await loadOrganizations() }
    }

    /// The Organizations group alone, after its filter changed.
    private func loadOrganizations() async {
        guard let credentials = app.ownerCredentials else { return }
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let page = try? await app.api.crmSubjectPage(
            credentials: credentials, kind: .organization, query: trimmedQuery, status: nil, organizations: organizationFilter
        ) else { return }
        guard !Task.isCancelled else { return }
        partnerSubjects = page.subjects
        partnerHasMore = page.hasMore
        if let facets = page.facets { organizationFacets = facets }
    }

    /// The Contacts group: its own search, Core's contact
    /// filters on the header, and a row per contact that opens its page.
    /// The Worker searches and filters; the group draws what it answers.
    @ViewBuilder
    private var contactsSection: some View {
        let folded = Binding(
            get: { contactsFolded },
            set: { next in
                contactsFolded = next
                UserDefaults.standard.set(next, forKey: RailBlock.foldDefaultsPrefix + MobileContactsGroup.key)
            }
        )
        let searching = !contactQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        Section {
            if !contactsFolded {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField(String(localized: "Search contacts"), text: $contactQuery)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                }
                if let contactError {
                    StarlingsErrorNotice(message: contactError) { contactRevision += 1 }
                } else if !contactsLoaded {
                    EnvisioningPlaceholderRows()
                } else if contactRows.isEmpty {
                    Text(searching || !contactFilter.isDefault ? String(localized: "Nothing matches.") : String(localized: "No contacts yet."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(contactRows, id: \.id) { contact in
                    NavigationLink(value: WorkDestination.contact(id: contact.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(contact.displayName)
                                .font(.body)
                                .lineLimit(1)
                            if !contact.context.isEmpty {
                                Text(contact.context)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }
        } header: {
            HStack {
                foldTitle("Contacts", folded: folded)
                Spacer()
                if contactsLoaded {
                    Text(verbatim: "\(contactRows.count)\(contactHasMore ? "+" : "")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                }
                contactFilterMenu
            }
        }
    }

    /// Core's contact list filters: Organization opens a search,
    /// Country and Language pick from what the contacts carry, Partner and
    /// Existing client turn on and off, Signals status picks one of five.
    private var contactFilterMenu: some View {
        Menu {
            Button {
                isPickingContactOrganization = true
            } label: {
                if let name = contactFilter.organizationName, contactFilter.organizationID != nil {
                    Text("Organization: \(name)")
                } else {
                    Text("Organization")
                }
            }
            if let countries = contactFacets?.countries, !countries.isEmpty {
                Picker("Country", selection: contactBinding(\.country)) {
                    Text("Any").tag(String?.none)
                    ForEach(countries.sorted { ContactFieldText.country($0).localizedStandardCompare(ContactFieldText.country($1)) == .orderedAscending }, id: \.self) { code in
                        Text(verbatim: ContactFieldText.country(code)).tag(String?.some(code))
                    }
                }
                .pickerStyle(.menu)
            }
            Divider()
            Toggle("Partner", isOn: contactBinding(\.partner))
            Toggle("Existing client", isOn: contactBinding(\.existingClient))
            Divider()
            Picker("Signals status", selection: contactBinding(\.signalsOutreachStatus)) {
                Text("Any").tag(CrmContactsQuerySignalsOutreachStatus?.none)
                ForEach(CrmContactsQuerySignalsOutreachStatus.known, id: \.self) { status in
                    Text(verbatim: ContactFieldText.outreach(status.rawValue)).tag(CrmContactsQuerySignalsOutreachStatus?.some(status))
                }
            }
            .pickerStyle(.menu)
            if let languages = contactFacets?.languages, !languages.isEmpty {
                Picker("Language", selection: contactBinding(\.preferredLanguage)) {
                    Text("Any").tag(String?.none)
                    ForEach(languages, id: \.self) { code in
                        Text(verbatim: ContactFieldText.language(code)).tag(String?.some(code))
                    }
                }
                .pickerStyle(.menu)
            }
            if !contactFilter.isDefault {
                Divider()
                Button("Reset") { changeContactFilter(.default) }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .foregroundStyle(contactFilter.isDefault ? AnyShapeStyle(.secondary) : AnyShapeStyle(StarlingsMobileColors.accent))
        }
        .textCase(nil)
        .accessibilityLabel("Filter Contacts")
    }

    private func contactBinding<Value>(_ path: WritableKeyPath<ContactListFilter, Value>) -> Binding<Value> {
        Binding(
            get: { contactFilter[keyPath: path] },
            set: { value in
                var next = contactFilter
                next[keyPath: path] = value
                changeContactFilter(next)
            }
        )
    }

    /// A new filter is kept on this device; the group's task reads again.
    private func changeContactFilter(_ next: ContactListFilter) {
        guard next != contactFilter else { return }
        contactFilter = next
        next.save()
    }

    /// The Contacts group's page, while the group is open. A search waits
    /// for a pause in typing; a filter reads at once.
    private func loadContacts() async {
        guard !contactsFolded, let credentials = app.ownerCredentials else { return }
        if !contactQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try? await Task.sleep(for: .milliseconds(250))
        }
        guard !Task.isCancelled else { return }
        do {
            let page = try await app.api.crmContactList(credentials: credentials, query: contactQuery, filter: contactFilter)
            guard !Task.isCancelled else { return }
            contactRows = page.contacts
            contactHasMore = page.hasMore
            if let facets = page.facets { contactFacets = facets }
            contactError = nil
            contactsLoaded = true
        } catch {
            guard !Task.isCancelled else { return }
            contactError = error.localizedDescription
        }
    }

    /// A Browse group's fold, kept under the Mac's key so the group has one name on both.
    private func browseFold(_ key: String) -> Binding<Bool> {
        Binding(
            get: { browseFolded.contains(key) },
            set: { folded in
                if folded { browseFolded.insert(key) } else { browseFolded.remove(key) }
                UserDefaults.standard.set(folded, forKey: RailBlock.foldDefaultsPrefix + key)
            }
        )
    }

    private func statusTitle(_ option: CrmSubjectStatusOption, counts: [String: CrmSubjectStatusCount]) -> String {
        guard let count = counts[option.id] else { return option.title }
        return String(localized: "\(option.title) (\(count.displayText))")
    }

    /// One Browse group. Starred at the top, bucketed by organization (a
    /// line above an organization with more than one row, NO ORGANIZATION
    /// last).
    @ViewBuilder
    private func subjectSection(
        title: String,
        subjects: [CrmSubject],
        hasMore: Bool,
        statusOptions: [CrmSubjectStatusOption],
        statusCounts: [String: CrmSubjectStatusCount],
        statusFilter: Binding<String>?,
        sortOption: Binding<String>?,
        sortKey: String,
        emptyMessage: String? = nil,
        headerAccessory: AnyView? = nil
    ) -> some View {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let starred = subjects.filter { work.resolvedState(for: $0).starred }
        let rest = subjects.filter { !work.resolvedState(for: $0).starred }
        let buckets = Self.organizationBuckets(starred + rest)
        // A search opens every group: a match inside a folded one is no match at all.
        let folded = browseFold(sortKey)
        Section {
            if !folded.wrappedValue || searching {
                if let statusFilter, !statusOptions.isEmpty {
                    Picker("Status", selection: statusFilter) {
                        ForEach(statusOptions) { option in
                            Text(statusTitle(option, counts: statusCounts)).tag(option.id)
                        }
                    }
                    .pickerStyle(.menu)
                }
                if let sortOption {
                    // Order, not filter — a choice here never asks Core again.
                    Picker("Sort", selection: Binding(
                        get: { sortOption.wrappedValue },
                        set: { value in
                            sortOption.wrappedValue = value
                            WorkSidebarPreferences.setSort(value, for: sortKey)
                            reorder(sortKey: sortKey, by: value)
                        }
                    )) {
                        ForEach(CrmSubjectSortOption.all) { option in
                            Text(option.title).tag(option.id)
                        }
                    }
                    .pickerStyle(.menu)
                }

                if subjects.isEmpty && !isLoading {
                    Text(searching ? String(localized: "Nothing matches.") : emptyMessage ?? String(localized: "Nothing here yet."))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(buckets, id: \.key) { bucket in
                    if bucket.named, buckets.count > 1 {
                        Text(bucket.name.uppercased())
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .listRowSeparator(.hidden)
                    }
                    subjectRows(bucket.rows, emptyMessage: "")
                }
                if hasMore {
                    Text("First \(subjects.count). Search to find the rest.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            HStack {
                foldTitle(LocalizedStringKey(title), folded: folded)
                Spacer()
                headerAccessory
            }
        }
    }

    /// Rows bucketed by organization, a bucket keeping the place of its
    /// first row. `named` says whether a line is drawn above the rows: only
    /// for an organization with more than one, or for NO ORGANIZATION when
    /// there are organizations above it to tell it from.
    private struct OrganizationBucket {
        let key: String
        let name: String
        let named: Bool
        let rows: [CrmSubject]
    }

    private static func organizationBuckets(_ subjects: [CrmSubject]) -> [OrganizationBucket] {
        var order: [String] = []
        var named: [String: [CrmSubject]] = [:]
        var loose: [CrmSubject] = []
        for subject in subjects {
            guard let id = subject.organizationID, !id.isEmpty else { loose.append(subject); continue }
            if named[id] == nil { order.append(id) }
            named[id, default: []].append(subject)
        }
        var buckets = order.map { id -> OrganizationBucket in
            let rows = named[id] ?? []
            let name = rows.first?.organizationName ?? rows.first?.subtitle ?? String(localized: "Organization")
            return OrganizationBucket(key: id, name: name, named: rows.count > 1, rows: rows)
        }
        if !loose.isEmpty {
            buckets.append(OrganizationBucket(key: "none", name: "No organization", named: !order.isEmpty, rows: loose))
        }
        return buckets
    }

    @ViewBuilder
    private func subjectRows(_ subjects: [CrmSubject], emptyMessage: String) -> some View {
        ForEach(subjects) { subject in
            let state = work.resolvedState(for: subject)
            let eventLabel = subject.isEvent
                ? WorkItems.eventCountdownLabel(eventDate: subject.eventDate, now: Date(), calendar: .current)
                : nil
            NavigationLink(value: WorkDestination(subject: subject, pane: subject.isPartner ? .interactions : .talk)) {
                WorkSidebarRow.subject(
                    subject,
                    hasUnread: team.unreadSubjectIDs.contains(subject.id),
                    detail: [subjectKindLabel(subject), subject.standing(includeRepository: true, eventLabel: eventLabel)]
                        .filter { !$0.isEmpty }
                        .joined(separator: " · "),
                    isStarred: state.starred,
                    isMuted: state.muted
                )
            }
            .contextMenu { subjectMenu(subject) }
            .accessibilityHint("Long-press or right-click for subject actions")
        }
        if subjects.isEmpty && !isLoading && !emptyMessage.isEmpty {
            Text(emptyMessage)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    /// The kind, spelled for a row no header names.
    private func subjectKindLabel(_ subject: CrmSubject) -> String {
        switch subject.subjectKind {
        case .project: subject.isInternalProject ? StarlingsWorkspace.active.projectGroupName : String(localized: "Client")
        case .lead, .organization, .event: subject.subjectKind.label
        }
    }

    // MARK: - Load

    /// A beat of quiet before asking, so typing a project name is one
    /// request rather than one per letter.
    private func schedule() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            // Mine is already in the environment store. Search and subject
            // filters must not re-read the owner's entire queue.
            await loadAll(refreshMine: false)
        }
    }

    private func loadAll(refreshMine: Bool = true) async {
        guard let credentials = app.ownerCredentials else {
            envisioningSubjects = []
            projectSubjects = []
            leadSubjects = []
            envisioningStatusCounts = [:]
            projectStatusCounts = [:]
            leadStatusCounts = [:]
            return
        }
        isLoading = true
        defer { isLoading = false }
        // Envisioning and client Projects are each the *whole* set of
        // projects at their own status filter — Core has no internal/
        // external flag to ask for one half directly, so both halves fetch
        // and keep only their own rows. When the two filters happen to match
        // this duplicates a Core query; an accepted tradeoff, the same one
        // Projects and Sales already make by always being two independent
        // fetches — see docs/WORK.md.
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Last known first: the three lists paint from their snapshots for
        // this exact query and filter, then the live reads replace them.
        if envisioningSubjects.isEmpty, projectSubjects.isEmpty, leadSubjects.isEmpty {
            if let cached = app.api.snapshot(
                StarlingsAPI.subjectsSnapshotKey(kind: .project, query: trimmedQuery, status: envisioningStatusFilter),
                credentials: credentials, as: CrmSubjectsResponse.self
            ) {
                envisioningSubjects = cached.value.subjects.filter(\.isInternalProject)
                envisioningHasMore = cached.value.hasMore
            }
            if let cached = app.api.snapshot(
                StarlingsAPI.subjectsSnapshotKey(kind: .project, query: trimmedQuery, status: projectStatusFilter),
                credentials: credentials, as: CrmSubjectsResponse.self
            ) {
                projectSubjects = cached.value.subjects.filter { !$0.isInternalProject }
                projectHasMore = cached.value.hasMore
            }
            if let cached = app.api.snapshot(
                StarlingsAPI.subjectsSnapshotKey(kind: .lead, query: trimmedQuery, status: leadStatusFilter),
                credentials: credentials, as: CrmSubjectsResponse.self
            ) {
                leadSubjects = cached.value.subjects
                leadHasMore = cached.value.hasMore
                subjectsUpdatedAt = cached.savedAt
            }
            if partnerSubjects.isEmpty,
               let cached = app.api.snapshot(
                StarlingsAPI.subjectsSnapshotKey(kind: .organization, query: trimmedQuery, status: organizationFilter.snapshotTag),
                credentials: credentials, as: CrmSubjectsResponse.self
               ) {
                partnerSubjects = cached.value.subjects
                partnerHasMore = cached.value.hasMore
            }
            if eventSubjects.isEmpty,
               let cached = app.api.snapshot(
                StarlingsAPI.subjectsSnapshotKey(kind: .event, query: trimmedQuery, status: nil),
                credentials: credentials, as: CrmSubjectsResponse.self
               ) {
                eventSubjects = cached.value.subjects
                eventHasMore = cached.value.hasMore
            }
            // The badges too, from their own snapshots.
            if envisioningStatusCounts.isEmpty, projectStatusCounts.isEmpty,
               let cached = app.api.snapshot(
                StarlingsAPI.subjectCountsSnapshotKey(kind: .project, query: ""),
                credentials: credentials, as: CrmSubjectCountsResponse.self
               ) {
                envisioningStatusCounts = cached.value.internalBadges
                projectStatusCounts = cached.value.clientBadges
            }
            if leadStatusCounts.isEmpty,
               let cached = app.api.snapshot(
                StarlingsAPI.subjectCountsSnapshotKey(kind: .lead, query: trimmedQuery),
                credentials: credentials, as: CrmSubjectCountsResponse.self
               ) {
                leadStatusCounts = cached.value.leadBadges
            }
        }
        // Everything above painted from disk before the first await. Now
        // every live read at once — Mine and Quick Notes included, which used
        // to run first and alone, holding the lists blank for two Core round
        // trips before the snapshot even drew (docs/CACHING.md §Order).
        async let mineRead: Void = refreshMine ? work.refresh() : ()
        async let notesRead: Void = refreshMine ? quickNotes.refresh() : ()
        async let envisioningPage = app.api.crmSubjectPage(
            credentials: credentials, kind: .project, query: trimmedQuery, status: envisioningStatusFilter
        )
        async let projectPage = app.api.crmSubjectPage(
            credentials: credentials, kind: .project, query: trimmedQuery, status: projectStatusFilter
        )
        async let leadPage = app.api.crmSubjectPage(
            credentials: credentials, kind: .lead, query: trimmedQuery, status: leadStatusFilter
        )
        // Organizations ride beside the rest and never fail the rail: a Core
        // that does not answer `kind=partner` yet leaves the block quiet.
        async let partnerPage = try? app.api.crmSubjectPage(
            credentials: credentials, kind: .organization, query: trimmedQuery, status: nil, organizations: organizationFilter
        )
        // Events the same way (docs/EVENTS.md): Core answers the open ones,
        // today and later on this phone's day, soonest first.
        async let eventPage = try? app.api.crmSubjectPage(credentials: credentials, kind: .event, query: trimmedQuery, status: nil)
        // Status-filter badge counts ("Open (16)"), same as the Mac's: one
        // request per kind. The project badges ignore the search box — Core's
        // `q` has no documented way to AND two terms — and come split by
        // Core's `is_internal` flag; Sales follows the search box, same as
        // its row list does (docs/WORK.md). A count that failed keeps the
        // last badges up rather than printing a wrong number.
        async let projectCounts = try? app.api.crmSubjectCounts(credentials: credentials, kind: .project, query: "")
        async let leadCounts = try? app.api.crmSubjectCounts(credentials: credentials, kind: .lead, query: trimmedQuery)
        let (projects, leads) = await (projectCounts, leadCounts)
        guard !Task.isCancelled else { return }
        if let projects {
            envisioningStatusCounts = projects.internalBadges
            projectStatusCounts = projects.clientBadges
        }
        if let leads { leadStatusCounts = leads.leadBadges }
        do {
            let (envisioningFound, projectFound, leadFound) = try await (envisioningPage, projectPage, leadPage)
            guard !Task.isCancelled else { return }
            envisioningSubjects = envisioningFound.subjects
                .filter(\.isInternalProject)
                .sorted(bySidebarOption: envisioningSortOption)
            envisioningHasMore = envisioningFound.hasMore
            projectSubjects = projectFound.subjects
                .filter { !$0.isInternalProject }
                .sorted(bySidebarOption: projectSortOption)
            projectHasMore = projectFound.hasMore
            leadSubjects = leadFound.subjects.sorted(bySidebarOption: leadSortOption)
            leadHasMore = leadFound.hasMore
            subjectsUpdatedAt = Date()
            subjectsRefreshError = nil
        } catch {
            guard !Task.isCancelled else { return }
            // The lists painted above stay — snapshot or last live read — and
            // the notice at the top says how old they are, with Retry. Only
            // lists with nothing to show are empty (docs/CACHING.md).
            subjectsRefreshError = error.localizedDescription
        }
        if let page = await partnerPage {
            guard !Task.isCancelled else { return }
            partnerSubjects = page.subjects
            partnerHasMore = page.hasMore
            if let facets = page.facets { organizationFacets = facets }
        }
        if let page = await eventPage {
            guard !Task.isCancelled else { return }
            eventSubjects = page.subjects
            eventHasMore = page.hasMore
        }
        _ = await (mineRead, notesRead)
    }

    /// The age to print beside a failed subjects refresh; nil when nothing
    /// is on screen to be stale.
    private var subjectsShowingUpdatedAt: Date? {
        envisioningSubjects.isEmpty && projectSubjects.isEmpty && leadSubjects.isEmpty ? nil : subjectsUpdatedAt
    }

    /// A pure client-side reorder of whichever array `sortKey` names —
    /// unlike a status filter, a sort choice never needs to ask Core again.
    private func reorder(sortKey: String, by value: String) {
        switch sortKey {
        case "work.envisioning": envisioningSubjects = envisioningSubjects.sorted(bySidebarOption: value)
        case "work.projects": projectSubjects = projectSubjects.sorted(bySidebarOption: value)
        case "work.leads": leadSubjects = leadSubjects.sorted(bySidebarOption: value)
        default: break
        }
    }

    /// File a subject under whichever of the three lists it now belongs to,
    /// dropping it from the other two first — the same rule a rename crossing
    /// the Envisioning/client line needs on the Mac sidebar.
    private func place(_ summary: CrmSubject) {
        envisioningSubjects.removeAll { $0.id == summary.id }
        projectSubjects.removeAll { $0.id == summary.id }
        leadSubjects.removeAll { $0.id == summary.id }
        switch (summary.kind, summary.isInternalProject) {
        case ("lead", _):
            leadSubjects.insert(summary, at: 0)
        case (_, true):
            envisioningSubjects.insert(summary, at: 0)
        default:
            projectSubjects.insert(summary, at: 0)
        }
    }

    /// A won lead: file the new project, open it, and say what did not land.
    /// Same refresh as a project made from the New Project sheet.
    private func won(_ lead: CrmSubject, _ response: CrmLeadWinResponse) {
        let project = CrmSubjectDetail(wire: response.project).summary
        leadSubjects.removeAll { $0.id == lead.id }
        place(project)
        path = [WorkDestination(subject: project, pane: .talk)]
        winTarget = nil
        let unmoved = response.unmovedTaskIDs.count
        if !response.leadClosed {
            errorMessage = String(localized: "Project started. The lead is still open.")
        } else if unmoved > 0 {
            errorMessage = String(localized: "\(unmoved) tasks stayed on the lead.")
        } else {
            errorMessage = nil
            haptic.fire(.success)
        }
        Task { await loadAll() }
    }

    private func markRepoLinked(_ subject: CrmSubject) {
        func updated(_ list: [CrmSubject]) -> [CrmSubject] {
            list.map { item in
                guard item.id == subject.id else { return item }
                // Every field rides along: dropping `isInternal` here would
                // send the row back to the title-prefix fallback and could
                // move it between sections on a repo link.
                return CrmSubject(
                    id: item.id,
                    kind: item.kind,
                    title: item.title,
                    subtitle: item.subtitle,
                    openTasks: item.openTasks,
                    overdueTasks: item.overdueTasks,
                    hasRepo: true,
                    agentEmail: item.agentEmail,
                    organizationLogoURL: item.organizationLogoURL,
                    organizationID: item.organizationID,
                    organizationName: item.organizationName,
                    isInternal: item.isInternal
                )
            }
        }
        envisioningSubjects = updated(envisioningSubjects)
        projectSubjects = updated(projectSubjects)
    }

    private func saveLogin() async {
        let wanted = loginDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await work.setGithubLogin(wanted.isEmpty ? nil : wanted)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func beginRename(_ subject: CrmSubject) {
        renameDraft = subject.title
        renameTarget = MobileSubjectRenameTarget(subject: subject)
    }

    private func rename(_ subject: CrmSubject, title: String) async {
        guard let credentials = app.ownerCredentials else { return }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else {
            errorMessage = "Add a name first."
            return
        }
        do {
            let detail = try await app.api.renameCrmSubject(
                credentials: credentials,
                kind: subject.subjectKind,
                id: subject.id,
                title: cleanTitle
            )
            place(detail.summary)
            errorMessage = nil
            // Re-query so a rename that no longer matches the active search
            // disappears, while counts and unread state stay from Core.
            await loadAll()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// The Browse screen's address on the stack. A value, not a subject: the
/// directory is a view, not a place work happens (docs/WORK.md §5d).
struct MobileWorkBrowse: Hashable {}

private struct MobileSubjectRenameTarget: Identifiable {
    let subject: CrmSubject

    var id: String { "\(subject.kind)-\(subject.id)" }
}

/// A small Core-backed picker for linking a project to a repository visible to
/// Core's GitHub App. The app credential never leaves Core.
struct MobileProjectRepoPicker: View {
    let subject: CrmSubject
    let onLinked: (CrmGithubRepo) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [CrmGithubRepo] = []
    @State private var linked: [CrmGithubRepo] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var savingID: String?

    var body: some View {
        NavigationStack {
            StarlingsList {
                if let errorMessage {
                    StarlingsErrorNotice(message: errorMessage)
                }
                if !linked.isEmpty {
                    Section("Already linked") {
                        ForEach(linked) { repo in
                            Label(repo.address, systemImage: repo.isPrimary ? "star.fill" : "link")
                        }
                    }
                }
                Section("Available repositories") {
                    ForEach(results) { repo in
                        Button {
                            Task { await link(repo) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(repo.address)
                                    if let label = repo.label, !label.isEmpty {
                                        Text(label)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if savingID == repo.id {
                                    ProgressView().controlSize(.small)
                                }
                            }
                        }
                        .disabled(savingID != nil || linked.contains(where: { $0.owner == repo.owner && $0.repo == repo.repo }))
                    }
                    if results.isEmpty && isLoading {
                        EnvisioningPlaceholderRows()
                    }
                    if results.isEmpty && !isLoading {
                        Text(query.isEmpty ? String(localized: "No repositories available.") : String(localized: "No repositories match."))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .searchable(text: $query, prompt: String(localized: "Search"))
            .navigationTitle("Link GitHub")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await loadLinked(); await search() }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(180))
                guard !Task.isCancelled else { return }
                await search()
            }
        }
    }

    private func loadLinked() async {
        guard let credentials = app.ownerCredentials else { return }
        linked = (try? await app.api.crmProjectRepos(credentials: credentials, projectID: subject.id)) ?? []
    }

    private func search() async {
        guard let credentials = app.ownerCredentials else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            results = try await app.api.crmGithubRepos(credentials: credentials, query: query)
            errorMessage = nil
        } catch {
            results = []
            errorMessage = error.localizedDescription
        }
    }

    private func link(_ repo: CrmGithubRepo) async {
        guard let credentials = app.ownerCredentials else { return }
        savingID = repo.id
        defer { savingID = nil }
        do {
            let saved = try await app.api.addCrmProjectRepo(
                credentials: credentials,
                create: CrmProjectRepoCreate(
                    projectID: subject.id,
                    owner: repo.owner,
                    repo: repo.repo,
                    label: repo.label,
                    milestone: repo.milestone,
                    isPrimary: linked.isEmpty
                )
            )
            onLinked(saved)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// One task from the cross-subject list: what, when, and which project it came
/// from — unreadable without the last of those.
private struct MyTaskRow: View {
    let task: CrmMyTask

    var body: some View {
        MobileWorkRow(title: task.title) {
            MobileCompactMark(systemName: "checkmark", shape: .square, size: 18)
                .accessibilityLabel("Task")
        } metadata: {
            HStack(spacing: 6) {
                if let due = CrmTaskDate.date(task.dueDate) {
                    // Neutral ink, bold weight when overdue — no tint
                    // (docs/DESIGN.md, "The accent budget").
                    Text(StarlingsDateFormatting.date(due))
                        .fontWeight(task.isOverdue ? .bold : .regular)
                        .foregroundStyle(task.isOverdue ? Color.primary : Color.secondary)
                    Text("·")
                }
                if let subject = task.subjectTitle {
                    Text(subject)
                }
                if let number = task.githubIssueNumber {
                    Text("·")
                    Text("#\(number)")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

/// The pushes Work's stack knows, declared once for the phone's stack and the
/// iPad's detail stack. The views come from `MobileWorkView`, which owns the
/// state they read.
private struct WorkStackDestinations: ViewModifier {
    struct Destinations {
        let destination: (WorkDestination) -> AnyView
        let browse: () -> AnyView
        let keep: (CrmSubject?) -> AnyView
        let isBrowsePresented: Binding<Bool>
        let isKeepPresented: Binding<Bool>
        let keepProject: Binding<CrmSubject?>
    }

    let destinations: Destinations

    func body(content: Content) -> some View {
        content
            .navigationDestination(for: WorkDestination.self) { destination in
                destinations.destination(destination)
            }
            .navigationDestination(for: MobileWorkBrowse.self) { _ in
                destinations.browse()
            }
            .navigationDestination(isPresented: destinations.isBrowsePresented) {
                destinations.browse()
            }
            .navigationDestination(isPresented: destinations.isKeepPresented) {
                destinations.keep(nil)
            }
            .navigationDestination(item: destinations.keepProject) { project in
                destinations.keep(project)
            }
    }
}

/// Work Overview's fold keys, from the shared registry (`rail-blocks.ts`,
/// `workOverview`): the Mac and the web fold the same block under the same name.
private enum OverviewFold {
    static let inbox = RailBlockRegistry.block(.workOverview, "inbox").foldDefaultsKey
    static let activity = RailBlockRegistry.block(.workOverview, "activity").foldDefaultsKey
    static let quickNotes = RailBlockRegistry.block(.workOverview, "quickNotes").foldDefaultsKey
    static let mine = RailBlockRegistry.block(.workOverview, "mine").foldDefaultsKey
    static let unowned = RailBlockRegistry.block(.workOverview, "unowned").foldDefaultsKey
}
