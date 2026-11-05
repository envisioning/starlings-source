import Combine
import Foundation
import WidgetKit
import UIKit
import SwiftUI

/// Your own work — every task and issue assigned to you — for the life of the
/// app rather than the life of the Work tab.
///
/// Home shows Mine, and Home is the tab that is open.
/// So this reads `/api/crm/mine` on its own cadence, slow, because a task's
/// date changes about once a day; every write in Work asks it to read again
/// so a tick never lags Home by a poll. Stopped in the background like
/// presence: a list nobody is looking at is not worth the battery.
///
/// What of the list is in focus is `WorkItems.focus`, decided on this phone,
/// which is the device that knows what day it is. Same rule as the Mac.
@MainActor
final class MobileMyWorkStore: ObservableObject {
    static let poll: TimeInterval = 300

    @Published private(set) var tasks: [CrmMyTask] = [] {
        // The Today's work widget reads the same rows Home draws, from the
        // agenda file; it learns of a change on the next reload.
        didSet { publishTodayWork() }
    }
    @Published private(set) var issues: [CrmIssue] = [] {
        didSet { publishTodayWork() }
    }
    @Published private(set) var recentlyClosed: [CrmRecentlyClosedItem] = []
    @Published private(set) var recentlyClosedError: String?
    /// Overview's UNOWNED (docs/BOARD.md §Unowned): open work nobody on our
    /// side holds, already through the shared rule at the Worker.
    @Published private(set) var unownedTasks: [CrmMyTask] = []
    @Published private(set) var unownedIssues: [CrmIssue] = []
    /// The project each UNOWNED issue was read for, by issue id.
    @Published private(set) var unownedIssueSubjects: [String: UnownedSubjects.Subject] = [:]
    /// Subjects whose work could not be read, by title.
    /// What the UNOWNED read could not give in full: failures and cap hits.
    @Published private(set) var unownedGaps = WorkReadGaps.none
    @Published private(set) var unownedError: String?
    /// Who UNOWNED's Assign to ▸ offers: Core's team, read once with the list.
    @Published private(set) var assignableTeam: [CrmTeamMember] = []
    /// Nil until somebody says who they are on GitHub.
    @Published private(set) var githubLogin: String?
    @Published private(set) var isLoading = false
    /// Set only when the list could not be read at all. A stale list is shown
    /// as-is: last-known beats an empty card.
    @Published private(set) var errorMessage: String?
    /// The refresh failed but a list is still up — the snapshot or the last
    /// live read. `updatedAt` says how old it is; the view reads both into
    /// one line with Retry (docs/CACHING.md).
    @Published private(set) var refreshFailure: String?
    /// When the last *live* Mine read landed — never a snapshot's date. So a
    /// screen that opens right after the store refreshed can skip its own.
    private var lastLiveReadAt: Date?
    var readMineJustNow: Bool { lastLiveReadAt.map { Date().timeIntervalSince($0) < 15 } ?? false }
    @Published private(set) var updatedAt: Date?
    /// INBOX, on the same cadence ("inbox everywhere"): the tab
    /// badge, Home and the Work tab's first block read it. Unread talk inside
    /// it is also on the roster poll; badges add the two.
    @Published private(set) var inbox: WorkInboxResponse = .empty
    @Published private(set) var inboxError: String?
    /// Star / mute and the SALES opt-in, per person; overrides by
    /// `SubjectState.key`, moved in place the moment a row's menu is used.
    @Published private(set) var subjectState: SubjectStateResponse = .unknown
    @Published private(set) var subjectOverrides: [String: SubjectStateOverride] = [:]
    /// Home replaces its loading projection only after both Mine and INBOX
    /// have answered once, including an empty or unavailable answer.
    @Published private(set) var homeReady = false

    var focus: HomeFocus { HomeFocus.plan(tasks: tasks, issues: issues) }
    var homeMine: HomeMine { HomeMine.plan(tasks: tasks, issues: issues) }

    /// The widget and the watch list only what is late or due today: their
    /// count line says nothing else. Those rows are always tasks, because an
    /// issue has no due date.
    private func publishTodayWork() {
        let plan = focus
        let late = Set(plan.rows.prefix(plan.lateCount).map(\.workID))
        let rows = plan.datedRows.compactMap { item -> CrmMyTask? in
            if case .task(let task) = item { return task }
            return nil
        }.map { task in
            WatchBridgeSnapshot.WorkRow(
                id: task.id,
                title: task.title,
                subjectTitle: task.subjectTitle,
                subjectKind: task.projectID != nil ? "project" : task.leadID != nil ? "lead" : task.partnerOrganizationID != nil ? "organization" : nil,
                subjectID: task.projectID ?? task.leadID ?? task.partnerOrganizationID,
                due: CrmTaskDate.date(task.dueDate),
                overdue: late.contains(task.id)
            )
        }
        AgendaFile.writeWork(rows)
        WatchBridgeSession.shared.updateWork(rows)
        WidgetCenter.shared.reloadTimelines(ofKind: WatchBridgeSnapshot.todayWorkWidgetKind)
    }
    var inboxBesideTalk: [WorkInboxItem] { inbox.itemsBesideTalk }
    /// Home's WORK card: INBOX minus Quick Notes, which Home lists in their own card.
    var inboxForHomeCard: [WorkInboxItem] { inbox.itemsForHomeCard }
    var salesEnabled: Bool { subjectState.salesEnabled }

    /// The person's answer for one subject; before the Worker has answered,
    /// every subject reads as listed.
    func resolvedState(for subject: CrmSubject) -> ResolvedSubjectState {
        guard subjectState != .unknown else { return .plain }
        return SubjectState.resolve(group: subject.group, prefs: subjectState.prefs, override: subjectOverrides[subject.stateKey])
    }

    /// The complete cross-subject plan. The view may narrow it for search,
    /// but it must never rebuild the task/issue pile or filter before the
    /// promotion dedupe has run.
    func minePlan(query: String = "") -> WorkPlan<PlannedWorkItem> {
        WorkItems.planMine(tasks: tasks, issues: issues, query: query)
    }

    /// UNOWNED in Mine's plan: the Worker chose the rows, this only orders them.
    func unownedPlan(query: String = "") -> WorkPlan<PlannedWorkItem> {
        WorkItems.planMine(tasks: unownedTasks, issues: unownedIssues, query: query)
    }

    private weak var app: StarlingsAppModel?
    private var attached = false
    private var pollTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []
    private var homeTasksAnswered = false
    private var homeInboxAnswered = false
    /// Whose lists are drawn: the owner painted at attach, then each sign-in.
    private var paintedOwner: String?
    private var recentlyClosedRequestID = 0
    private var unownedRequestID = 0
    private var mineRefreshRequestID = 0
    private var inboxRefreshRequestID = 0
    private var optimisticTaskCompletionIDs: Set<String> = []

    private func updateHomeReadiness() {
        homeReady = homeTasksAnswered && homeInboxAnswered
    }

    func attach(to app: StarlingsAppModel) {
        guard !attached else { return }
        attached = true
        self.app = app
        // Disk first, synchronously, before the sink below hops to the main
        // actor and the poll sends its first request (docs/CACHING.md,
        //): Home's WORK card draws in the first frame.
        paintedOwner = app.ownerCredentials?.owner.email
        paintSnapshots()

        app.$ownerCredentials
            .map { @Sendable in $0?.owner.email }
            .removeDuplicates()
            .sink { @Sendable email in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    // The same owner as the one painted at attach: keep what
                    // is drawn. Clearing it here flashed the placeholders.
                    if email != self.paintedOwner {
                        self.paintedOwner = email
                        self.recentlyClosedRequestID += 1
                        self.tasks = []
                        self.issues = []
                        self.recentlyClosed = []
                        self.recentlyClosedError = nil
                        self.clearUnowned()
                        self.githubLogin = nil
                        self.homeTasksAnswered = false
                        self.homeInboxAnswered = false
                        self.homeReady = false
                        self.paintSnapshots()
                    }
                    // The poll's first pass is the read. Refreshing here as
                    // well sent every request of a launch twice.
                    self.stop()
                    if self.app?.ownerCredentials != nil {
                        self.start()
                    } else {
                        await self.refresh()
                    }
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.start() } }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.stop() } }
            .store(in: &cancellables)

        // A write somewhere else — a task completed from a subject pane —
        // made Mine stale. Re-read now rather than at the next poll, so
        // Home's card and the Work tab agree.
        NotificationCenter.default.publisher(for: SnapshotStore.didInvalidateNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                guard let self, let owner = app.ownerCredentials?.owner.email,
                      let prefixes = SnapshotStore.invalidatedPrefixes(in: note, owner: owner),
                      SnapshotStore.matches(key: StarlingsAPI.mineSnapshotKey, prefixes: prefixes)
                else { return }
                Task { @MainActor [weak self] in await self?.refresh() }
            }
            .store(in: &cancellables)
        // No `start()` here: the credentials sink above fires with the
        // current session and starts the poll.
    }

    /// Mine and INBOX as last saved, for the signed-in owner. No request.
    private func paintSnapshots() {
        guard let app, let credentials = app.ownerCredentials else { return }
        if tasks.isEmpty, issues.isEmpty,
           let cached = app.api.snapshot(StarlingsAPI.mineSnapshotKey, credentials: credentials, as: CrmMyWorkResponse.self) {
            tasks = cached.value.tasks.filter { !optimisticTaskCompletionIDs.contains($0.id) }
            issues = cached.value.issues
            githubLogin = cached.value.githubLogin
            updatedAt = cached.savedAt
            homeTasksAnswered = true
        }
        if inbox.items.isEmpty, inbox.recent.isEmpty,
           let cached = app.api.snapshot(StarlingsAPI.inboxSnapshotKey, credentials: credentials, as: WorkInboxResponse.self) {
            inbox = inboxWithoutOptimisticallyCompletedTasks(cached.value)
            homeInboxAnswered = true
        }
        updateHomeReadiness()
    }

    func start() {
        guard app?.ownerCredentials != nil else { return }
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(for: .seconds(Self.poll))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        mineRefreshRequestID += 1
        let requestID = mineRefreshRequestID
        guard let app, let credentials = app.ownerCredentials else {
            inboxRefreshRequestID += 1
            recentlyClosedRequestID += 1
            tasks = []
            issues = []
            recentlyClosed = []
            recentlyClosedError = nil
            clearUnowned()
            githubLogin = nil
            errorMessage = nil
            refreshFailure = nil
            updatedAt = nil
            inbox = .empty
            subjectState = .unknown
            subjectOverrides = [:]
            homeTasksAnswered = false
            homeInboxAnswered = false
            homeReady = false
            return
        }
        // Last known first (docs/CACHING.md): a cold tab paints both
        // snapshots before any request goes out.
        paintSnapshots()
        async let inboxRead: Void = refreshInbox()
        async let stateRead: Void = refreshSubjectState()
        async let recentRead: Void = refreshRecentlyClosed(credentials: credentials)
        async let unownedRead: Void = refreshUnowned(credentials: credentials)
        isLoading = tasks.isEmpty
        defer { isLoading = false }
        do {
            let work = try await app.api.crmMyWork(credentials: credentials)
            if requestID == mineRefreshRequestID {
                tasks = work.tasks.filter { !optimisticTaskCompletionIDs.contains($0.id) }
                issues = work.issues
                githubLogin = work.githubLogin
                updatedAt = Date()
                lastLiveReadAt = updatedAt
                errorMessage = nil
                refreshFailure = nil
            }
        } catch {
            if requestID == mineRefreshRequestID {
                // Keep whatever list is already on screen, and say it is old.
                if tasks.isEmpty && issues.isEmpty {
                    errorMessage = error.localizedDescription
                    refreshFailure = nil
                } else {
                    errorMessage = nil
                    refreshFailure = error.localizedDescription
                }
            }
        }
        homeTasksAnswered = true
        updateHomeReadiness()
        _ = await (inboxRead, stateRead)
        _ = await recentRead
        _ = await unownedRead
    }

    private func refreshUnowned(credentials: MobileOwnerCredentials) async {
        guard let app else { return }
        unownedRequestID += 1
        let requestID = unownedRequestID
        do {
            let response = try await app.api.crmUnownedWork(credentials: credentials)
            guard requestID == unownedRequestID else { return }
            unownedTasks = response.tasks.filter { !optimisticTaskCompletionIDs.contains($0.id) }
            unownedIssues = response.issues
            unownedIssueSubjects = response.issueSubjects
            unownedGaps = response.gaps
            unownedError = nil
            // The roster changes far less often than the work does.
            if assignableTeam.isEmpty, !response.tasks.isEmpty || !response.issues.isEmpty {
                assignableTeam = (try? await app.api.crmTeam(credentials: credentials)) ?? []
            }
        } catch {
            guard requestID == unownedRequestID else { return }
            unownedError = error.localizedDescription
        }
    }

    /// A row acted on leaves UNOWNED at once — done, cancelled, closed or
    /// now held by someone. The refresh each write ends with re-reads the
    /// list, so a write that fails brings its row back.
    private func leaveUnowned(after action: WorkRowAction) {
        switch action {
        case .complete(let task), .cancel(let task), .assignTask(let task, _):
            unownedTasks.removeAll { $0.id == task.id }
        case .setIssueState(let issue, _, .close), .setIssueState(let issue, _, .closeNotPlanned), .assignIssue(let issue, _):
            unownedIssues.removeAll { $0.id == issue.id }
        default:
            break
        }
    }

    private func clearUnowned() {
        unownedRequestID += 1
        unownedTasks = []
        unownedIssues = []
        unownedIssueSubjects = [:]
        unownedGaps = .none
        unownedError = nil
        assignableTeam = []
    }

    private func refreshRecentlyClosed(credentials: MobileOwnerCredentials) async {
        guard let app else { return }
        recentlyClosedRequestID += 1
        let requestID = recentlyClosedRequestID
        do {
            let response = try await app.api.crmRecentlyClosedWork(credentials: credentials)
            guard requestID == recentlyClosedRequestID else { return }
            recentlyClosed = response.items
            recentlyClosedError = nil
        } catch {
            guard requestID == recentlyClosedRequestID else { return }
            recentlyClosedError = error.localizedDescription
        }
    }

    func reopenRecentlyClosed(_ item: CrmRecentlyClosedItem) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        switch item.kind {
        case .task:
            _ = try await app.api.updateCrmTask(credentials: credentials, id: item.id, update: .completion(false))
        case .issue:
            guard let issue = item.issue else { return }
            _ = try await app.api.updateCrmIssue(
                credentials: credentials,
                .stateChange(.reopen, issue: issue, projectID: item.projectID)
            )
        }
        await refresh()
    }

    /// INBOX on its own: a Core that will not answer for tasks must not
    /// empty a note somebody typed a minute ago.
    func refreshInbox() async {
        inboxRefreshRequestID += 1
        let requestID = inboxRefreshRequestID
        guard let app, let credentials = app.ownerCredentials else {
            homeInboxAnswered = false
            homeReady = false
            return
        }
        if inbox.items.isEmpty, inbox.recent.isEmpty,
           let cached = app.api.snapshot(StarlingsAPI.inboxSnapshotKey, credentials: credentials, as: WorkInboxResponse.self) {
            inbox = inboxWithoutOptimisticallyCompletedTasks(cached.value)
            homeInboxAnswered = true
            updateHomeReadiness()
        }
        do {
            let response = try await app.api.crmInbox(credentials: credentials)
            guard requestID == inboxRefreshRequestID else { return }
            inbox = inboxWithoutOptimisticallyCompletedTasks(response.retainingQuestions(from: inbox))
            inboxError = nil
            announceNewInboxRows()
        } catch {
            guard requestID == inboxRefreshRequestID else { return }
            inboxError = (error as? StarlingsError)?.serverCode == "not_configured" ? nil : error.localizedDescription
        }
        homeInboxAnswered = true
        updateHomeReadiness()
    }

    private func inboxTaskID(_ item: WorkInboxItem) -> String? {
        switch item {
        case .task(let task, _, _, _): task.id
        default: nil
        }
    }

    private func inboxWithoutOptimisticallyCompletedTasks(_ response: WorkInboxResponse) -> WorkInboxResponse {
        guard !optimisticTaskCompletionIDs.isEmpty else { return response }
        return WorkInboxResponse(
            items: response.items.filter { item in
                guard let id = inboxTaskID(item) else { return true }
                return !optimisticTaskCompletionIDs.contains(id)
            },
            recent: response.recent,
            partial: response.partial,
            recentPartial: response.recentPartial,
            taskPartial: response.taskPartial,
            capped: response.capped
        )
    }

    private func replacingInboxItems(_ items: [WorkInboxItem]) {
        inbox = WorkInboxResponse(
            items: items,
            recent: inbox.recent,
            partial: inbox.partial,
            recentPartial: inbox.recentPartial,
            taskPartial: inbox.taskPartial,
            capped: inbox.capped
        )
    }

    /// Remove task rows as soon as Done is chosen. A failed write restores
    /// those exact rows; reads started before the write cannot put them back.
    private func completeMineTask(_ task: CrmMyTask, api: StarlingsAPI, credentials: MobileOwnerCredentials) async throws {
        guard optimisticTaskCompletionIDs.insert(task.id).inserted else { return }
        mineRefreshRequestID += 1
        inboxRefreshRequestID += 1

        let taskIndex = tasks.firstIndex(where: { $0.id == task.id })
        let unownedIndex = unownedTasks.firstIndex(where: { $0.id == task.id })
        unownedRequestID += 1
        let removedInboxItems = inbox.items.enumerated().filter { inboxTaskID($0.element) == task.id }
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeOut(duration: 0.16)) {
            tasks.removeAll { $0.id == task.id }
            unownedTasks.removeAll { $0.id == task.id }
            replacingInboxItems(inbox.items.filter { inboxTaskID($0) != task.id })
        }

        do {
            _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .completion(true))
            mineRefreshRequestID += 1
            inboxRefreshRequestID += 1
            optimisticTaskCompletionIDs.remove(task.id)
            Task { await refresh() }
        } catch {
            mineRefreshRequestID += 1
            inboxRefreshRequestID += 1
            optimisticTaskCompletionIDs.remove(task.id)
            withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeOut(duration: 0.16)) {
                if let taskIndex, !tasks.contains(where: { $0.id == task.id }) {
                    tasks.insert(task, at: min(taskIndex, tasks.endIndex))
                }
                if let unownedIndex, !unownedTasks.contains(where: { $0.id == task.id }) {
                    unownedTasks.insert(task, at: min(unownedIndex, unownedTasks.endIndex))
                }
                var items = inbox.items
                for entry in removedInboxItems where !items.contains(where: { $0.id == entry.element.id }) {
                    items.insert(entry.element, at: min(entry.offset, items.endIndex))
                }
                replacingInboxItems(items)
            }
            throw error
        }
    }

    /// Which rows have been seen, for `InboxNotices.plan`. The first read
    /// after launch records; only what arrives after it is a banner.
    private var seenInboxKeys: Set<String> = []
    private var hasObservedInbox = false

    private func announceNewInboxRows() {
        let planned = InboxNotices.plan(items: inbox.items, seen: seenInboxKeys, isFirstObservation: !hasObservedInbox)
        seenInboxKeys = planned.seen
        hasObservedInbox = true
        Task { await InboxNotices.deliver(planned.notices, authorize: MeetingNotices.requestAuthorization) }
    }

    func refreshSubjectState() async {
        guard let app, let credentials = app.ownerCredentials else { return }
        do {
            apply(try await app.api.crmSubjectState(credentials: credentials))
        } catch {
            // The rail drawn from `.unknown` hides nothing; it fills in next time.
        }
    }

    private func apply(_ response: SubjectStateResponse) {
        subjectState = response
        subjectOverrides = Dictionary(response.states.map { ($0.subjectKey, $0.override) }, uniquingKeysWith: { _, latest in latest })
    }

    /// Applied in place first, then sent; on failure the row goes back.
    func setSubjectState(_ subject: CrmSubject, update: SubjectStateUpdate) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        let key = subject.stateKey
        let before = subjectOverrides[key]
        let next = update.applied(to: before ?? SubjectStateOverride(starred: false, muted: false))
        subjectOverrides[key] = next.isDefault ? nil : next
        do {
            let stored = try await app.api.crmSetSubjectState(credentials: credentials, kind: subject.subjectKind, id: subject.id, update: update)
            subjectOverrides[key] = stored?.override
            await refreshInbox()
        } catch {
            subjectOverrides[key] = before
            throw error
        }
    }

    /// A row's menu choice that is a write — the ones that make the row
    /// leave INBOX or Mine (`WorkRowAction`). Home and the Work tab both
    /// land here, so a decline on Home and a decline in Work are one call.
    /// Anything that opens a screen or a sheet is the view's, and is not
    /// sent here. Returns whether the row is a talk row, because unread
    /// talk is the roster poll's and the caller re-reads that too.
    @discardableResult
    func perform(_ action: WorkRowAction) async throws -> Bool {
        guard let app, let credentials = app.ownerCredentials else { return false }
        let api = app.api
        leaveUnowned(after: action)
        switch action {
        case .markRead(let thread):
            try await api.markThreadRead(credentials: credentials, threadID: thread.id)
            return true
        case .mute(let thread):
            // Muted for a week rather than forever — the thread pane's rule.
            let until: Date? = thread.isMuted ? nil : Date().addingTimeInterval(7 * 24 * 3600)
            try await api.muteThread(credentials: credentials, threadID: thread.id, until: until)
            return true
        case .archive(let thread):
            try await api.archiveThread(credentials: credentials, threadID: thread.id, archived: thread.archivedAt == nil)
            return true
        case .accept(let task):
            _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .proposalDecision(accepted: true))
            await refresh()
        case .decline(let task):
            _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .proposalDecision(accepted: false))
            await refresh()
        case .dismissTouch(let touch):
            try await api.setSalesInboxDismissed(credentials: credentials, id: touch.id, dismissed: true)
            await refreshInbox()
        case .undoDismissTouch(let touch):
            try await api.setSalesInboxDismissed(credentials: credentials, id: touch.id, dismissed: false)
            await refreshInbox()
        case .resolveComment(let comment):
            try await api.resolveComment(credentials: credentials, threadID: comment.thread.id)
            await refreshInbox()
        case .answerDecision(let ask, let option):
            _ = try await api.answerDecisionAsk(credentials: credentials, id: ask.id, answer: option.key, note: nil)
            await refreshInbox()
        case .dismissBooking(let key):
            try await api.setInboxItemDismissed(credentials: credentials, key: key, dismissed: true)
            await refreshInbox()
        case .undoDismissBooking(let key):
            try await api.setInboxItemDismissed(credentials: credentials, key: key, dismissed: false)
            await refreshInbox()
        case .markSeen(let key):
            try await api.setInboxItemDismissed(credentials: credentials, key: key, dismissed: true)
            await refreshInbox()
        // A calendar answer leaves INBOX as soon as the write succeeds:
        // Google can take a moment to show the new attendee status.
        case .respondToInvitation(let event, let response, let key):
            _ = try await MobileCalendarBackend(credentials: credentials).respondToCalendarEvent(
                calendarId: event.calendarId, eventId: event.rawEventID, response: response
            )
            inbox = inbox.removing(key: key)
            await refreshInbox()
        case .addForwardedEvent(let event, let key):
            _ = try await MobileCalendarBackend(credentials: credentials).addPendingCalendarEvent(id: event.id)
            inbox = inbox.removing(key: key)
            await refreshInbox()
        case .discardForwardedEvent(let event, let key):
            try await MobileCalendarBackend(credentials: credentials).discardPendingCalendarEvent(id: event.id)
            inbox = inbox.removing(key: key)
            await refreshInbox()
        case .complete(let task):
            try await completeMineTask(task, api: api, credentials: credentials)
        case .cancel(let task):
            _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .cancellation)
            await refresh()
        case .setIssueState(let issue, let projectID, let change):
            _ = try await api.updateCrmIssue(credentials: credentials, .stateChange(change, issue: issue, projectID: projectID))
            await refresh()
        case .promote(let task):
            guard let projectID = task.projectID else { return false }
            _ = try await api.createCrmIssue(credentials: credentials,
                .promotion(projectID: projectID, taskID: task.id, title: task.title, body: nil))
            await refresh()
        case .assignTask(let task, let member):
            _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .assignment(to: member))
            await refresh()
        case .assignIssue(let issue, let member):
            guard let update = CrmIssueUpdate.assignment(issue, to: member) else { return false }
            _ = try await api.updateCrmIssue(credentials: credentials, update)
            await refresh()
        case .dismissFollowUp(let item):
            try await api.dismissFollowUp(credentials: credentials, item)
            await refreshInbox()
        // The view asked first (`taskDeleteConfirmation`); this is the write.
        case .deleteTask(let id, _):
            try await deleteTask(id: id)
        case .open, .openConversation, .openGitHub, .copyLink, .openDocument, .openCore, .openEvent, .editNote, .fileNote, .moveNote, .deleteNote, .startLead, .copyEmail,
             .completeTask, .cancelTask, .promoteTask, .openDecision, .makeResponsible, .openFollowUp, .handOff, .openQuestion:
            assertionFailure("\(action.title) is the view's to perform")
        }
        return false
    }

    /// Delete a task, then read Mine, Home and INBOX again.
    func deleteTask(id: String) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        try await app.api.deleteCrmTask(credentials: credentials, id: id)
        await refresh()
    }

    /// A decision answered from its sheet, with the note written there.
    func answerDecision(_ ask: DecisionAsk, option: DecisionAskOption, note: String?) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        _ = try await app.api.answerDecisionAsk(credentials: credentials, id: ask.id, answer: option.key, note: note)
        await refreshInbox()
    }

    /// How the SUBJECTS list reads — the same answer the Mac rail and the
    /// web rail draw. Applied in place first, then sent; on failure the
    /// list goes back to what the Worker last said.
    var workList: WorkListPreferences { subjectState.workList }

    func setWorkList(_ prefs: WorkListPreferences) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        let before = subjectState
        subjectState = before.with(workList: prefs)
        do {
            apply(try await app.api.crmSetWorkPreferences(credentials: credentials, workList: prefs))
        } catch {
            subjectState = before
            throw error
        }
    }

    /// Hide or show Board columns, on every project and device.
    /// Applied in place first, then sent whole; on failure they come back.
    func setBoardHiddenStages(_ stages: Set<WorkStage>) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        let before = subjectState
        subjectState = before.with(boardHiddenStages: stages)
        do {
            apply(try await app.api.crmSetWorkPreferences(credentials: credentials, boardHiddenStages: stages))
        } catch {
            subjectState = before
            throw error
        }
    }

    /// Which INBOX sources are on for you, defaults filled in.
    var inboxSources: [String: Bool] { InboxSourceSpec.resolve(subjectState.inboxSources) }

    /// Turn one INBOX source on or off. Applied in place first, then sent
    /// whole; on failure the switch goes back. INBOX is re-read after,
    /// since the change is about what it carries.
    func setInboxSource(_ source: String, on: Bool) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        let before = subjectState
        var next = before.inboxSources
        next[source] = on
        subjectState = before.with(inboxSources: next)
        do {
            apply(try await app.api.crmSetWorkPreferences(credentials: credentials, inboxSources: next))
        } catch {
            subjectState = before
            throw error
        }
        await refreshInbox()
    }

    /// The SALES opt-in follows the account; the Worker answers with the
    /// whole state, since turning Sales on changes which leads are listed.
    /// Which subject kinds you hide in Work, sent whole.
    func setHiddenKinds(_ kinds: [String]) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        apply(try await app.api.crmSetWorkPreferences(credentials: credentials, hiddenKinds: kinds))
        await refreshInbox()
    }

    func setSalesEnabled(_ enabled: Bool) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        apply(try await app.api.crmSetWorkPreferences(credentials: credentials, salesEnabled: enabled))
        await refreshInbox()
    }

    /// Say who you are on GitHub. Only ever your own record — the Worker takes
    /// the address from the session. Re-reads, because the issues half of the
    /// list exists only once this is known.
    func setGithubLogin(_ login: String?) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        githubLogin = try await app.api.setCrmGithubLogin(credentials: credentials, login: login)
        await refresh()
    }
}
