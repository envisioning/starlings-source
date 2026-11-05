import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// One project's board on the phone (docs/BOARD.md):
/// its tasks and issues as a stage-grouped list with a move menu — the Mac's
/// columns and the web's, read down instead of across. One read
/// (`GET /api/crm/board?project_id=`), again every 30 seconds while it is on
/// screen, dealt by the shared `WorkItems.board`; a move is the shared
/// `WorkItems.write`, the same PATCH the Mac makes. DONE and DROPPED start
/// folded. The filter menu narrows by holder and hides columns; both narrow
/// what is drawn, never what is stored.
struct MobileProjectBoardView: View {
    let subject: CrmSubject
    /// A card's last line: the project's Talk, at that message.
    var onOpenTrace: (CardTrace) -> Void = { _ in }

    @EnvironmentObject private var app: StarlingsAppModel
    /// Home and Mine read from this; a move asks it to read again. It also
    /// holds the person's hidden columns.
    @EnvironmentObject private var work: MobileMyWorkStore
    @EnvironmentObject private var team: MobileTeamStore

    @State private var response: CrmBoardResponse?
    @State private var errorMessage: String?
    @State private var notice: String?
    /// The card whose Hand off is open.
    @State private var handingOff: MobileBoardCard?
    @State private var showsFinished = false
    @State private var moving: Set<String> = []
    /// `anyone`, `people`, `agents` or `agent:<email>` (`passesHolderFilter`).
    @State private var holderFilter = WorkHolderChoice.anyone.rawValue
    /// The task filters beside it (`passesTaskFilter`). They last the session.
    @State private var dueFilter = WorkDueFilter.any
    @State private var sideFilter = WorkSideFilter.any
    /// A task card's Delete, while the question is up.
    @State private var deletingTask: MobileTaskDeletion?

    /// The board reads itself again at this cadence while it is up, as the Mac's does.
    private static let refreshInterval: Duration = .seconds(30)

    private var agents: [Peer] { team.roster.peers.filter(\.isAgent) }
    private var hiddenStages: Set<WorkStage> { work.subjectState.boardHiddenStages }

    var body: some View {
        let board = WorkItems.board(cards.filter {
            WorkItems.passesHolderFilter($0, filter: holderFilter, agentEmail: subject.agentEmail)
                && WorkItems.passesTaskFilter($0, due: dueFilter, side: sideFilter)
        })
        let offered = WorkStage.allCases.filter { !$0.isFinished || showsFinished }
        let hiddenCount = offered.filter(hiddenStages.contains).reduce(0) { $0 + board.items(in: $1).count }
        StarlingsList {
            if let errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage, updatedAt: nil) {
                        Task { await load() }
                    }
                }
            }
            // A failed read is red with Copy and Retry; a cap hit is quiet copy.
            if let failure = response?.gaps.failureLine {
                Section {
                    StarlingsErrorNotice(message: failure) {
                        Task { await load() }
                    }
                }
            }
            let lines = [
                response?.gaps.truncatedLine,
                hiddenCount > 0 ? String(localized: "\(hiddenCount) cards in hidden columns") : nil,
                notice,
            ].compactMap { $0 }
            if !lines.isEmpty {
                Section {
                    Text(lines.joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if response == nil && errorMessage == nil {
                Section { EnvisioningPlaceholderRows() }
            }
            if response != nil {
                ForEach(offered.filter { !hiddenStages.contains($0) }, id: \.self) { stage in
                    let items = board.items(in: stage)
                    Section {
                        if items.isEmpty {
                            Text("Nothing here.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(items) { card in
                            row(card, stage: stage)
                        }
                    } header: {
                        HStack {
                            Text(stage.columnLabel.capitalized)
                            Spacer()
                            if !items.isEmpty { Text("\(items.count)").monospacedDigit() }
                        }
                    }
                }
                Section {
                    Button(showsFinished ? String(localized: "Hide finished") : String(localized: "Show finished")) {
                        showsFinished.toggle()
                    }
                    .font(.callout)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                filterMenu
            }
        }
        .task(id: subject.id) {
            // An agent's move mid-run has to show without a pull. The task
            // ends when the board leaves the screen.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: Self.refreshInterval)
            }
        }
        .refreshable { await load() }
        .taskDeleteConfirmation($deletingTask) { deletion in
            Task { await delete(deletion) }
        }
        .sheet(item: $handingOff) { card in
            MobileHandOffEditor(cardTitle: card.title, agents: agents, preselected: nil) { agent, handoff in
                Task { await handOff(card, to: agent, handoff: handoff) }
            }
        }
    }

    // MARK: - Filter

    /// Who holds the cards shown, then which columns show.
    private var filterMenu: some View {
        Menu {
            Picker("Held by", selection: $holderFilter) {
                ForEach(WorkHolderChoice.allCases, id: \.self) { choice in
                    Text(choice.title).tag(choice.rawValue)
                }
                ForEach(agents, id: \.email) { agent in
                    Text(agent.displayName).tag("agent:\(agent.email)")
                }
            }
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
            Section("Columns") {
                ForEach(WorkStage.allCases, id: \.self) { stage in
                    Toggle(stage.columnLabel.capitalized, isOn: Binding(
                        get: { !hiddenStages.contains(stage) },
                        set: { shown in
                            var next = hiddenStages
                            if shown { next.remove(stage) } else { next.insert(stage) }
                            Task {
                                do { try await work.setBoardHiddenStages(next) } catch { errorMessage = error.localizedDescription }
                            }
                        }
                    ))
                }
            }
        } label: {
            let filtered = holderFilter != WorkHolderChoice.anyone.rawValue || dueFilter != .any || sideFilter != .any
                || !hiddenStages.isEmpty
            Image(systemName: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Filter the board")
    }

    // MARK: - Rows

    @ViewBuilder
    private func row(_ card: MobileBoardCard, stage: WorkStage) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            NavigationLink {
                switch card.source {
                case .task(let task): MobileTaskView(task: task, subject: subject) { _ in Task { await load() } }
                case .issue(let issue): MobileIssueView(issue: issue, projectID: subject.id)
                }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: card.workOrigin == .issue ? "smallcircle.filled.circle" : "circle")
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(card.title)
                            .lineLimit(2)
                        Text(card.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if moving.contains(card.id) {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .buttonStyle(.plain) // hover: NavigationLink row, the List highlights it
            if let trace = card.trace {
                // The last thing that happened: a door into Talk, at that line.
                Button {
                    onOpenTrace(trace)
                } label: {
                    Text(trace.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .padding(.leading, 32)
                }
                .buttonStyle(.plain) // hover: a line of text in a List row, not a control with a box
            }
        }
        .contextMenu {
            Menu("Move to") {
                ForEach(WorkStage.allCases.filter { $0 != stage }, id: \.self) { target in
                    Button(target.columnLabel.capitalized) {
                        Task { await move(card, to: target) }
                    }
                }
            }
            if !agents.isEmpty, !stage.isFinished {
                Button("Hand off…") { handingOff = card }
            }
            // Delete: a task only; an issue is GitHub's to close.
            if let task = card.task {
                Button(role: .destructive) {
                    deletingTask = MobileTaskDeletion(id: task.id, title: task.title)
                } label: {
                    Label(TaskDeleteCopy.confirm, systemImage: MenuSymbol.delete.rawValue)
                }
            }
        }
        .swipeActions(edge: .trailing) {
            if stage != .done {
                Button {
                    Task { await move(card, to: .done) }
                } label: {
                    Label("Done", systemImage: "checkmark.circle")
                }
                .tint(StarlingsMobileColors.accent)
            }
        }
    }

    // MARK: - Data

    private var cards: [MobileBoardCard] {
        guard let response else { return [] }
        let traces = Dictionary(response.traces.map { ("\($0.refKind):\($0.refID)", $0) }, uniquingKeysWith: { first, _ in first })
        let tasks = response.tasks.map { MobileBoardCard(source: .task($0), trace: traces["task:\($0.id)"]) }
        let issues = response.issues.map { MobileBoardCard(source: .issue($0), trace: traces["issue:\($0.id)"]) }
        return tasks + issues
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            response = try await app.api.crmBoard(credentials: credentials, projectID: subject.id)
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// The one write a stage move makes, then a re-read of the project.
    private func move(_ card: MobileBoardCard, to stage: WorkStage) async {
        guard let credentials = app.ownerCredentials else { return }
        moving.insert(card.id)
        defer { moving.remove(card.id) }
        do {
            switch WorkItems.write(stage, for: card) {
            case .task(let status):
                _ = try await app.api.updateCrmTask(credentials: credentials, id: card.workID, update: .stage(status))
            case .issue(let state, let stateReason, let labels):
                guard let issue = card.issue else { return }
                _ = try await app.api.updateCrmIssue(credentials: credentials, .stageMove(
                    issue, projectID: subject.id, state: state, stateReason: stateReason, labels: labels
                ))
            }
            errorMessage = nil
            await load()
            await work.refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Delete a task card, then read the project again.
    private func delete(_ deletion: MobileTaskDeletion) async {
        do {
            try await work.deleteTask(id: deletion.id)
            errorMessage = nil
            await load()
        } catch {
            errorMessage = (error as? StarlingsError)?.message ?? TaskDeleteCopy.failure
        }
    }

    /// Hand off (docs/SURFACES.md): a message to the agent that
    /// carries the card's ref and the brief, the one the Mac sends. The
    /// runtime reads the card from the ref and the brief from `handoff`; the
    /// text repeats both for the person who reads the conversation later.
    private func handOff(_ card: MobileBoardCard, to agent: Peer, handoff: ThreadHandoff) async {
        let target = HandOffTarget(
            title: card.title,
            issueNumber: card.issue?.number,
            ref: ThreadMessageRef(kind: card.workOrigin == .issue ? "issue" : "task", id: card.workID),
            subjectKind: subject.kind,
            subjectID: subject.id
        )
        do {
            try await MobileHandOff.send(app: app, target: target, to: agent, handoff: handoff)
            notice = String(localized: "Handed off to \(agent.displayName)")
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// A card on the phone's board: a task or an issue and its last event line,
/// the Mac's `BoardCard` without the pasteboard. The project is the board's.
struct MobileBoardCard: ProjectedWorkCard, Identifiable, Equatable {
    enum Source: Equatable {
        case task(CrmTask)
        case issue(CrmIssue)
    }

    let source: Source
    let trace: CardTrace?

    var id: String { workID }

    var task: CrmTask? { if case .task(let task) = source { task } else { nil } }
    var issue: CrmIssue? { if case .issue(let issue) = source { issue } else { nil } }

    var workTask: (any WorkTaskFields)? { task }
    var workIssue: CrmIssue? { issue }

    var title: String {
        switch source {
        case .task(let task): task.title
        case .issue(let issue): issue.title
        }
    }

    /// "Task · Due 18 Sep" / "meet #147".
    var detail: String {
        var parts: [String] = []
        switch source {
        case .task(let task):
            parts.append(task.githubIssueNumber.map { String(localized: "Task · #\($0)") } ?? String(localized: "Task"))
            if let name = task.assigneeName { parts.append(name) }
            if let due = CrmTaskDate.date(task.dueDate) {
                parts.append(String(localized: "Due \(due.formatted(date: .abbreviated, time: .omitted))"))
            }
        case .issue(let issue):
            parts.append("\(issue.repo) #\(issue.number)")
            if let login = issue.assigneeLogin { parts.append(login) }
        }
        return parts.joined(separator: " · ")
    }
}

/// The task filters read who holds a card and which side owes it.
extension MobileBoardCard: WorkHeldCard {
    var workAssignee: String? { task.flatMap { $0.assigneeID ?? $0.assigneeEmail } }
    var workResponsibleParty: String? { task?.responsibleParty.rawValue }
    var workAssignees: [String] { issue?.assignees.map(\.login) ?? [] }
}
