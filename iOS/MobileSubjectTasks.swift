import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// The CRM's open tasks on one subject, and the sheet that writes them.
///
/// Every write goes through the Worker to Core — this is the CRM's list, not a
/// copy of it, so a task completed here is completed everywhere. See
/// docs/TASK_SUGGESTIONS.md for the other way a task gets here.
struct MobileSubjectTasksView: View {
    let subject: CrmSubject
    private let startsWithNewTask: Bool
    @Binding private var newTaskRequest: UUID?

    @EnvironmentObject private var app: StarlingsAppModel
    /// Home's today card reads from this. Every write here asks it to read
    /// again, so a tick on a subject never lags Home by a poll.
    @EnvironmentObject private var work: MobileMyWorkStore
    /// The agents a task row can be handed to.
    @EnvironmentObject private var peers: MobileTeamStore
    @Environment(\.openURL) private var openURL
    @State private var tasks: [CrmTask] = []
    @State private var handingOff: MobileHandOffRequest?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var loadRequestID = 0
    @State private var optimisticCompletionIDs: Set<String> = []
    @State private var haptic = StarlingsHapticPulse()
    /// The list's failed refresh, apart from `errorMessage` (a failed write):
    /// the snapshot behind it is still up, so the line says how old it is.
    @State private var refreshError: String?
    @State private var updatedAt: Date?
    @State private var editing: CrmTaskDraft?
    /// Who the work can go to. Loaded once with the list — the roster changes
    /// far less often than the tasks do.
    @State private var team: [CrmTeamMember] = []
    @State private var goals: [CrmGoal] = []
    /// Why the roster is empty, when it is. Shown in the editor rather than
    /// here: it only matters at the moment somebody looks for a name.
    @State private var teamError: String?
    /// The task filters (`passesTaskFilter`). They last the session.
    @State private var dueFilter = WorkDueFilter.any
    @State private var sideFilter = WorkSideFilter.any
    /// A row's Delete, while the question is up.
    @State private var deletingTask: MobileTaskDeletion?
    /// An organization's Tasks By project: this device's choice,
    /// the groups read for it, and each project's remembered fold.
    @AppStorage(CrmOrganizationProjectTaskGroups.byProjectDefaultsKey) private var byProject = false
    @State private var groups: CrmOrganizationProjectTaskGroups?
    @State private var groupsError: String?
    @State private var foldedProjects: Set<String> = []

    init(
        subject: CrmSubject,
        startsWithNewTask: Bool = false,
        newTaskRequest: Binding<UUID?> = .constant(nil)
    ) {
        self.subject = subject
        self.startsWithNewTask = startsWithNewTask
        _newTaskRequest = newTaskRequest
        _editing = State(initialValue: startsWithNewTask ? CrmTaskDraft(subject: subject) : nil)
    }

    private var visibleTasks: [CrmTask] {
        tasks.filter(isShown)
    }

    /// Open, not just ticked off here, and through the task filters.
    private func isShown(_ task: CrmTask) -> Bool {
        !task.status.isFinished && !optimisticCompletionIDs.contains(task.id)
            && WorkItems.passesTaskFilter(task, due: dueFilter, side: sideFilter)
    }

    private var showsByProject: Bool { subject.isPartner && byProject }

    /// The groups through the same filters; a project they empty leaves.
    private var shownProjects: [CrmOrganizationProjectTaskGroups.Project] {
        (groups?.projects ?? []).compactMap { project in
            let tasks = project.tasks.filter(isShown)
            guard !tasks.isEmpty else { return nil }
            return CrmOrganizationProjectTaskGroups.Project(id: project.id, title: project.title, status: project.status, tasks: tasks)
        }
    }

    var body: some View {
        StarlingsList {
            if let errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage)
                }
            } else if let refreshError {
                Section {
                    StarlingsErrorNotice(message: refreshError, updatedAt: tasks.isEmpty ? nil : updatedAt) {
                        Task { await load() }
                    }
                }
            }

            // Proposals first, apart from the open list: questions Core is
            // asking (an offer accepted, an extension requested —),
            // not work anybody committed to.
            // By project draws a proposal inside its project instead.
            let proposed = showsByProject ? [] : visibleTasks.filter(\.status.isProposed)
            if !proposed.isEmpty {
                Section {
                    ForEach(proposed) { task in
                        ProposedTaskRow(
                            task: task,
                            onAccept: { await decide(task, accepted: true) },
                            onDecline: { await decide(task, accepted: false) }
                        )
                        .contextMenu {
                            WorkRowActionMenu(
                                groups: task.proposedRowActions(subject: subject),
                                perform: performTaskAction
                            )
                            MobileFavoriteAction(target: FavoriteTarget(kind: .crmTask, targetRef: task.id))
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button("Decline", role: .destructive) { Task { await decide(task, accepted: false) } }
                                .tint(.gray)
                            Button("Accept") { Task { await decide(task, accepted: true) } }
                                .tint(StarlingsMobileColors.accent)
                        }
                    }
                } header: {
                    Text("Proposed")
                } footer: {
                    Text("Proposed; accept or decline.")
                }
            }

            if showsByProject {
                byProjectSections
            } else {
                Section {
                    ForEach(visibleTasks.filter { !$0.status.isProposed }) { task in
                        openRow(task, rowSubject: subject)
                    }
                    if visibleTasks.isEmpty && isLoading {
                        EnvisioningPlaceholderRows()
                    }
                    if visibleTasks.isEmpty && !isLoading {
                        Text("No open tasks for \(subject.title).")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    tasksHeader(visibleTasks.isEmpty ? String(localized: "Tasks") : String(localized: "\(visibleTasks.count) open"))
                }
            }

        }
        .refreshable { await load() }
        .meetHaptics(haptic)
        .meetHaptic(.error, whenSet: errorMessage)
        // Adding sits where adding sits on iOS — top right, in the bar the
        // screen already has. A full-width button at the bottom took a row of
        // the list and read as the primary act of the screen, which reading
        // the tasks is.
        .taskDeleteConfirmation($deletingTask) { deletion in
            Task { await delete(deletion) }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                filterMenu
            }
            ToolbarItem(placement: .topBarTrailing) {
                // One button, not a shape drawn inside one. The toolbar makes
                // its own button chrome, so a background here nests two — the
                // prominent style fills the button the bar already drew.
                // Septena keeps chrome glyphs ink for the same reason the tab
                // bar owns the accent (`PageAddButton`); this one is filled
                // deliberately, as the only write on the screen.
                Button {
                    editing = CrmTaskDraft(subject: subject)
                } label: {
                    Image(systemName: "plus")
                }
                .meetToolbarProminent()
                .accessibilityLabel("New task")
            }
        }
        .sheet(item: $handingOff) { request in
            MobileHandOffEditor(
                cardTitle: request.target.title,
                agents: peers.roster.peers.filter(\.isAgent),
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
        .sheet(item: $editing) { draft in
            MobileTaskEditor(draft: draft, team: team, teamError: teamError, goals: goalsFor(draft),
                whereText: MobileTaskWhere.text(task: nil, subject: subject, name: nil),
                selfEmail: app.ownerCredentials?.owner.email) { saved in
                Task { await save(saved) }
            }
        }
        .onAppear { consumeNewTaskRequest() }
        .onChange(of: newTaskRequest) { _, _ in consumeNewTaskRequest() }
        .task(id: subject.id) { await load() }
        .onChange(of: byProject) { _, _ in Task { await loadGroups() } }
    }

    // MARK: - Rows and filters

    /// One open task: the reader on tap, the registry's menu (Delete
    /// included), File on GitHub on a swipe where there is a project.
    /// `rowSubject` is the project when the row sits in a By project group.
    @ViewBuilder
    private func openRow(_ task: CrmTask, rowSubject: CrmSubject) -> some View {
        NavigationLink {
            MobileTaskView(task: task, subject: rowSubject) { id in removeLocally(id) }
        } label: {
            TaskRow(task: task) { await close(task) }
        }
        .buttonStyle(.plain) // hover: NavigationLink row, the List highlights it
        .transition(.opacity.combined(with: .move(edge: .leading)))
        .contextMenu {
            WorkRowActionMenu(
                groups: task.rowActions(subject: rowSubject, agents: peers.roster.peers.filter(\.isAgent), client: .ios),
                perform: performTaskAction
            )
            MobileFavoriteAction(target: FavoriteTarget(kind: .crmTask, targetRef: task.id))
        }
        .swipeActions(edge: .leading) {
            // Only for a project with somewhere to file, and only
            // once: a second promotion would orphan the first.
            if rowSubject.kind == "project", task.githubIssueNumber == nil {
                Button {
                    Task { await promote(task) }
                } label: {
                    Label("File on GitHub", systemImage: "arrow.up.forward.square")
                }
                .tint(StarlingsMobileColors.accent)
            }
        }
    }

    /// The TASKS header: the count, and By project on an organization.
    private func tasksHeader(_ title: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            if subject.isPartner {
                Button(String(localized: "By project")) { byProject.toggle() }
                    .buttonStyle(.meetPlain)
                    .foregroundStyle(byProject ? StarlingsMobileColors.accent : Color.secondary)
                    .accessibilityAddTraits(byProject ? .isSelected : [])
            }
        }
    }

    /// One folding section per project, the title opening the project.
    @ViewBuilder
    private var byProjectSections: some View {
        let projects = shownProjects
        let open = projects.reduce(0) { $0 + $1.tasks.filter { !$0.status.isProposed }.count }
        Section {
            if let groupsError {
                StarlingsErrorNotice(message: groupsError) { Task { await loadGroups() } }
            } else if let line = groups?.failureLine {
                StarlingsErrorNotice(message: line) { Task { await loadGroups() } }
            }
            if groups == nil && groupsError == nil {
                EnvisioningPlaceholderRows()
            } else if projects.isEmpty {
                Text("No open tasks for \(subject.title).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            tasksHeader(projects.isEmpty ? String(localized: "Tasks") : String(localized: "\(open) open"))
        }
        ForEach(projects) { project in
            Section {
                if !foldedProjects.contains(project.id) {
                    ForEach(project.tasks) { task in
                        if task.status.isProposed {
                            ProposedTaskRow(
                                task: task,
                                onAccept: { await decide(task, accepted: true) },
                                onDecline: { await decide(task, accepted: false) }
                            )
                        } else {
                            openRow(task, rowSubject: project.subject)
                        }
                    }
                }
            } header: {
                projectHeader(project)
            }
        }
    }

    private func projectHeader(_ project: CrmOrganizationProjectTaskGroups.Project) -> some View {
        let folded = foldedProjects.contains(project.id)
        return HStack(spacing: 6) {
            Button {
                withAnimation(.snappy) { setFolded(!folded, project: project.id) }
            } label: {
                Image(systemName: folded ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.semibold))
            }
            .buttonStyle(.meetPlain)
            .accessibilityLabel(Text(project.title))
            .accessibilityValue(folded ? Text("Folded") : Text("Open"))
            NavigationLink {
                MobileSubjectView(subject: project.subject, initialPane: .tasks)
            } label: {
                Text(project.title)
            }
            .buttonStyle(.meetPlain)
            Spacer()
            Text("\(project.tasks.count)").monospacedDigit()
        }
    }

    private func setFolded(_ folded: Bool, project id: String) {
        if folded { foldedProjects.insert(id) } else { foldedProjects.remove(id) }
        UserDefaults.standard.set(folded, forKey: RailBlock.foldDefaultsPrefix + CrmOrganizationProjectTaskGroups.foldKey(organizationID: subject.id, projectID: id))
    }

    /// Due and Side, the board's menus (docs/BOARD.md "Filters and hidden columns").
    private var filterMenu: some View {
        Menu {
            Picker("Due", selection: $dueFilter) {
                ForEach(WorkDueFilter.allCases, id: \.self) { choice in
                    Text(choice.title).tag(choice)
                }
            }
            Picker("Side", selection: $sideFilter) {
                ForEach(WorkSideFilter.allCases, id: \.self) { choice in
                    Text(choice.label).tag(choice)
                }
            }
        } label: {
            let filtered = dueFilter != .any || sideFilter != .any
            Image(systemName: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Filter the tasks")
    }

    /// The task left (deleted from its screen): out of the list and the groups.
    private func removeLocally(_ id: String) {
        tasks.removeAll { $0.id == id }
        groups = groups?.removing(taskID: id)
    }

    /// Delete a task after the question, then read again.
    private func delete(_ deletion: MobileTaskDeletion) async {
        do {
            try await work.deleteTask(id: deletion.id)
            removeLocally(deletion.id)
            errorMessage = nil
            haptic.fire(.destructive)
            await load()
        } catch {
            errorMessage = (error as? StarlingsError)?.message ?? TaskDeleteCopy.failure
        }
    }

    /// An organization's Tasks By project. Read only while shown.
    private func loadGroups() async {
        guard showsByProject, let credentials = app.ownerCredentials else { return }
        do {
            let read = try await app.api.crmOrganizationProjectTasks(credentials: credentials, organizationID: subject.id)
            foldedProjects = Set(read.projects.map(\.id).filter {
                UserDefaults.standard.bool(forKey: RailBlock.foldDefaultsPrefix + CrmOrganizationProjectTaskGroups.foldKey(organizationID: subject.id, projectID: $0))
            })
            groups = read
            groupsError = nil
        } catch {
            guard !Task.isCancelled else { return }
            groupsError = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    /// The live goals, plus the one the task already serves if it has closed.
    private func goalsFor(_ draft: CrmTaskDraft) -> [CrmGoal] {
        GoalsDecisions.sorted(goals.filter { GoalsDecisions.isLive($0) || $0.id == draft.goalID })
    }

    private func consumeNewTaskRequest() {
        guard newTaskRequest != nil else { return }
        newTaskRequest = nil
        editing = CrmTaskDraft(subject: subject)
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        loadRequestID += 1
        let requestID = loadRequestID
        let projectID = subject.kind == "project" ? subject.id : nil
        let leadID = subject.kind == "lead" ? subject.id : nil
        let eventID = subject.kind == "event" ? subject.id : nil
        let organizationID = subject.isPartner ? subject.id : nil
        // Last known first (docs/CACHING.md): the pane paints the subject's
        // last task list before Core answers.
        if tasks.isEmpty,
           let cached = app.api.snapshot(
               StarlingsAPI.tasksSnapshotKey(projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID),
               credentials: credentials, as: CrmTasksResponse.self
           ) {
            tasks = cached.value.tasks.filter { !optimisticCompletionIDs.contains($0.id) }
            updatedAt = cached.savedAt
        }
        isLoading = visibleTasks.isEmpty
        defer { if requestID == loadRequestID { isLoading = false } }
        if showsByProject { await loadGroups() }
        do {
            let response = try await app.api.crmTasks(credentials: credentials, projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID)
            guard requestID == loadRequestID else { return }
            tasks = response.filter { !optimisticCompletionIDs.contains($0.id) }
            updatedAt = Date()
            refreshError = nil
        } catch {
            guard requestID == loadRequestID else { return }
            // The snapshot stays; the line above says the refresh failed.
            refreshError = error.localizedDescription
        }
        // A roster that cannot be read must not stop somebody writing the task
        // down — but it must not look like a team of nobody either. Swallowing
        // this is what made an outage read as an empty picker.
        if team.isEmpty {
            do {
                team = try await app.api.crmTeam(credentials: credentials)
                teamError = nil
            } catch {
                teamError = error.localizedDescription
            }
        }
        // Goals for the sheet's picker. A failure hides the row;
        // it must not obscure the tasks.
        if subject.kind == "project" {
            goals = (try? await app.api.crmGoals(credentials: credentials, projectID: subject.id, includeClosed: true)) ?? goals
        }
        // Only a project can have repositories; a lead is a conversation before
        // there is code. A failure here hides the section rather than shouting:
        // GitHub being unreachable must not obscure the tasks.
    }

    /// Completing from the row, without opening the sheet: the one edit that is
    /// worth a single tap.
    private func decide(_ task: CrmTask, accepted: Bool) async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            let updated = try await app.api.updateCrmTask(
                credentials: credentials,
                id: task.id,
                update: .proposalDecision(accepted: accepted)
            )
            if accepted {
                tasks = tasks.map { $0.id == task.id ? updated : $0 }
            } else {
                tasks.removeAll { $0.id == task.id }
            }
            haptic.fire(accepted ? .success : .destructive)
            await work.refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Done or cancelled: either way the task leaves the open list.
    private func close(_ task: CrmTask, cancelled: Bool = false) async {
        guard let credentials = app.ownerCredentials else { return }
        guard optimisticCompletionIDs.insert(task.id).inserted else { return }
        let previousIndex = tasks.firstIndex(where: { $0.id == task.id })
        loadRequestID += 1
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeOut(duration: 0.16)) {
            tasks.removeAll { $0.id == task.id }
        }
        do {
            _ = try await app.api.updateCrmTask(
                credentials: credentials,
                id: task.id,
                update: cancelled ? .cancellation : .completion(true)
            )
            // The list is "open tasks", so a closed one leaves it. The local
            // row is already gone; later reads now belong to the new state.
            loadRequestID += 1
            optimisticCompletionIDs.remove(task.id)
            haptic.fire(cancelled ? .destructive : .success)
            Task { await load() }
            Task { await work.refresh() }
        } catch {
            loadRequestID += 1
            optimisticCompletionIDs.remove(task.id)
            withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeOut(duration: 0.16)) {
                if !tasks.contains(where: { $0.id == task.id }) {
                    tasks.insert(task, at: min(previousIndex ?? tasks.endIndex, tasks.endIndex))
                }
            }
            errorMessage = error.localizedDescription
        }
    }

    /// The task keeps a pointer to what it became. The two states stay
    /// independent: this is a hand-off, not a sync.
    private func promote(_ task: CrmTask) async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            // A By project row is the project's, not the organization's.
            _ = try await app.api.createCrmIssue(credentials: credentials,
                .promotion(projectID: task.projectID ?? subject.id, taskID: task.id, title: task.title, body: task.notes))
            haptic.fire(.success)
            await load()
            await work.refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Subject-task rows use the same registry as Work's Mine, Home and
    /// INBOX rows. Opening a Core URL is local; writes stay in this pane so a
    /// completion or GitHub hand-off refreshes this subject and Home together.
    private func performTaskAction(_ action: WorkRowAction) {
        switch action {
        case .accept(let task): Task { await decide(task, accepted: true) }
        case .decline(let task): Task { await decide(task, accepted: false) }
        case .completeTask(let task): Task { await close(task) }
        case .cancelTask(let task): Task { await close(task, cancelled: true) }
        case .promoteTask(let task): Task { await promote(task) }
        case .handOff(let target, let agent): handingOff = MobileHandOffRequest(target: target, agent: agent)
        case .openCore(let url): openURL(url)
        case .deleteTask(let id, let title): deletingTask = MobileTaskDeletion(id: id, title: title)
        default: break
        }
    }

    private func save(_ draft: CrmTaskDraft) async {
        guard let credentials = app.ownerCredentials else { return }
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        let notes = draft.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if let id = draft.id {
                _ = try await app.api.updateCrmTask(
                    credentials: credentials,
                    id: id,
                    update: CrmTaskUpdate(
                        title: title,
                        notes: notes.isEmpty ? nil : notes,
                        status: draft.status.rawValue,
                        responsibleParty: draft.responsible.rawValue,
                        assignedTo: Patch(draft.assignedTo),
                        dueDate: Patch(draft.dueDate.map(CrmTaskDate.wire)),
                        goalID: goals.isEmpty ? .omit : Patch(draft.goalID)
                    )
                )
            } else {
                _ = try await app.api.createCrmTask(
                    credentials: credentials,
                    CrmTaskCreate(
                        title: title,
                        notes: notes.isEmpty ? nil : notes,
                        status: draft.status.rawValue,
                        responsibleParty: draft.responsible.rawValue,
                        assignedTo: Patch(draft.assignedTo),
                        dueDate: draft.dueDate.map(CrmTaskDate.wire),
                        projectID: subject.kind == "project" ? subject.id : nil,
                        leadID: subject.kind == "lead" ? subject.id : nil,
                        eventID: subject.kind == "event" ? subject.id : nil,
                        organizationID: subject.isPartner ? subject.id : nil,
                        goalID: draft.goalID
                    )
                )
            }
            await load()
            await work.refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// A task on its way in or out of the sheet. Identifiable so the sheet is
/// presented by item — presenting by flag needs a second piece of state that
/// can disagree with this one.
struct CrmTaskDraft: Identifiable, Equatable {
    /// Nil for a task that does not exist yet.
    let id: String?
    var title: String
    var notes: String
    var status: CrmTaskStatus
    var responsible: CrmTaskResponsible
    /// Which person, once `responsible` says the team owes it.
    var assignedTo: String?
    /// Undated work never reaches the calendar, which selects on this.
    var dueDate: Date?
    /// The goal this task serves. Nil is none.
    var goalID: String?

    init(task: CrmTask) {
        id = task.id
        title = task.title
        notes = task.notes ?? ""
        status = task.status
        responsible = task.responsibleParty
        assignedTo = task.assigneeID
        dueDate = CrmTaskDate.date(task.dueDate)
        goalID = task.goalID
    }

    init(subject: CrmSubject) {
        id = nil
        title = ""
        notes = ""
        status = .pending
        // Most work a meeting produces is ours. Starting at `team` is the
        // honest default, and it is what puts the member picker in front of
        // somebody rather than behind a menu they have to find.
        responsible = .team
        assignedTo = nil
        dueDate = nil
        goalID = nil
        _ = subject
    }
}

/// A subject's own task row. Shares `MobileWorkRow`'s shell with Mine's
/// `MyTaskRow` — only the leading glyph (a completion toggle here, a plain
/// icon there) and the metadata fields differ.
/// One Core-proposed task with its two answers. No done tick — a proposal is
/// not in a state a tick could describe.
private struct ProposedTaskRow: View {
    let task: CrmTask
    let onAccept: () async -> Void
    let onDecline: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("PROPOSED")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(StarlingsMobileColors.accent.opacity(0.18), in: Capsule())
                Text(task.title).font(.body.weight(.medium))
            }
            if let notes = task.notes, !notes.isEmpty {
                Text(notes).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            HStack(spacing: 8) {
                if let due = CrmTaskDate.date(task.dueDate) {
                    Text("Due \(StarlingsDateFormatting.date(due))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Decline") { Task { await onDecline() } }
                    .buttonStyle(StarlingsBorderedButtonStyle.compact)
                Button("Accept") { Task { await onAccept() } }
                    .buttonStyle(StarlingsFilledButtonStyle.compact)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Proposed task: \(task.title). Accept or decline.")
    }
}

private struct TaskRow: View {
    let task: CrmTask
    let onComplete: () async -> Void

    var body: some View {
        MobileWorkRow(title: task.title) {
            Button {
                Task { await onComplete() }
            } label: {
                Image(systemName: "circle")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.meetPlain)
            .accessibilityLabel("Complete \(task.title)")
        } metadata: {
            HStack(spacing: 6) {
                if let due = CrmTaskDate.date(task.dueDate) {
                    Text(StarlingsDateFormatting.date(due))
                    Text("·")
                }
                Text(task.status.menuTitle)
                Text("·")
                // Who owes it, by name where there is one — "Team" is a
                // side, and a side does not do the work.
                Text(task.assigneeName ?? task.responsibleParty.title)
                // Where it went, so the two lists stop being strangers.
                if let number = task.githubIssueNumber {
                    Text("·")
                    Text("#\(number)")
                }
            }
        }
    }
}

struct MobileTaskEditor: View {
    @State var draft: CrmTaskDraft
    let team: [CrmTeamMember]
    let teamError: String?
    /// The project's live goals, and the one this task already serves.
    /// Empty means no Goal row: off a project there is nothing to pick.
    var goals: [CrmGoal] = []
    /// Read-only "Where" for the form, e.g. "Partner · Echos". Nil hides it.
    var whereText: String? = nil
    /// The signed-in member's address: a new team task starts as theirs
    ///, still changeable.
    var selfEmail: String? = nil
    let onSave: (CrmTaskDraft) -> Void

    @Environment(\.dismiss) private var dismiss
    /// Set once the assignee is picked by hand, so a late team list never
    /// overrides the choice.
    @State private var assigneeChosen = false

    /// Fill a new team task's assignee with the signed-in member, when the
    /// team list holds them and nobody was picked yet.
    private func preselectSelf() {
        guard draft.id == nil, !assigneeChosen, draft.responsible == .team, draft.assignedTo == nil,
              let email = selfEmail?.lowercased(),
              let mine = team.first(where: { $0.email?.lowercased() == email }) else { return }
        draft.assignedTo = mine.id
    }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                if let whereText {
                    Section { LabeledContent("Where", value: whereText) }
                }
                Section {
                    TextField("Task title", text: $draft.title, axis: .vertical)
                        .meetSingleLine($draft.title)
                    TextField("Notes (optional)", text: $draft.notes, axis: .vertical)
                        .lineLimit(1...4)
                }
                Section {
                    // Undated is the honest default for work nobody has
                    // committed to a day, so the picker only appears once
                    // somebody says it has one.
                    Toggle("Due date", isOn: Binding(
                        get: { draft.dueDate != nil },
                        set: { draft.dueDate = $0 ? (draft.dueDate ?? Date()) : nil }
                    ))
                    .meetToggleTint()
                    if draft.dueDate != nil {
                        DatePicker(
                            "Due",
                            selection: Binding(
                                get: { draft.dueDate ?? Date() },
                                set: { draft.dueDate = $0 }
                            ),
                            displayedComponents: .date
                        )
                    }
                }
                Section {
                    Picker("Status", selection: $draft.status) {
                        ForEach(CrmTaskStatus.editable, id: \.self) { status in
                            Text(status.menuTitle).tag(status)
                        }
                    }
                    Picker("Responsible", selection: $draft.responsible) {
                        ForEach(CrmTaskResponsible.allCases, id: \.self) { party in
                            Text(party.menuTitle).tag(party)
                        }
                    }
                    // Only the team has members. A client task is owed by the
                    // client, and naming one of us on it would be a lie about
                    // who is doing the work.
                    if draft.responsible == .team {
                        if team.isEmpty {
                            StarlingsErrorNotice(message: teamError ?? String(localized: "Couldn’t load the team."))
                        } else {
                            StarlingsSearchablePicker(
                                label: String(localized: "Assignee"),
                                placeholder: String(localized: "Nobody yet"),
                                options: [StarlingsSearchablePickerOption(id: "", title: String(localized: "Nobody yet"))]
                                    + team.assigneeOptions,
                                selection: Binding(
                                    get: { draft.assignedTo ?? "" },
                                    set: { assigneeChosen = true; draft.assignedTo = $0.isEmpty ? nil : $0 }
                                ),
                                emptyMessage: String(localized: "No options match that search.")
                            )
                        }
                    }
                }
                .onChange(of: draft.responsible) { _, party in
                    // A task the client owes cannot also be owed by one of us.
                    if party != .team { draft.assignedTo = nil }
                }
                // Where the work points. Only on a project with goals.
                if !goals.isEmpty {
                    Section {
                        StarlingsSearchablePicker(
                            label: String(localized: "Goal"),
                            placeholder: String(localized: "None"),
                            options: [StarlingsSearchablePickerOption(id: "", title: String(localized: "None"))]
                                + goals.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.title) },
                            selection: Binding(
                                get: { draft.goalID ?? "" },
                                set: { draft.goalID = $0.isEmpty ? nil : $0 }
                            ),
                            emptyMessage: String(localized: "No options match that search.")
                        )
                    }
                }
            }
            .navigationTitle(draft.id == nil ? String(localized: "New task") : String(localized: "Edit task"))
            .navigationBarTitleDisplayMode(.inline)
            .onAppear(perform: preselectSelf)
            .onChange(of: team.map(\.id)) { preselectSelf() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(draft)
                        dismiss()
                    }
                    .disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .meetToolbarConfirm()
                }
            }
        }
    }
}
