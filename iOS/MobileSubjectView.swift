import DocsUI
import StarlingsContracts
import SwiftUI

/// One project or lead: what is being said about it, and what is owed on it.
///
/// Two views of one object rather than two destinations. The conversation is
/// the same thread the Worker find-or-creates for the subject, and the tasks
/// are the CRM's own — Meet shows both and owns neither.
struct MobileSubjectView: View {
    @State private var currentSubject: CrmSubject

    /// Four panes, not one long project stream. Talk, structured work, GitHub
    /// issues, and durable CRM interactions are views of the same subject.
    private enum Pane: String, CaseIterable, Identifiable {
        case overview
        case conversation
        case tasks
        case issues
        /// A project's tasks and issues by stage (docs/BOARD.md).
        case board
        case interactions
        case fields
        case documents
        /// The partner's own page (PARTNERS (HQ Docs)): what the relationship
        /// is, and the projects, leads and contacts that hang off it.
        case partner
        /// The event's own page (docs/EVENTS.md): when and where, and the
        /// projects that link to it.
        case event

        var id: String { rawValue }

        /// The shared pane; its title is `SUBJECT_PANES` (Generated/SubjectPanesRegistry.swift).
        var shared: SubjectPane {
            switch self {
            case .overview: .overview
            case .conversation: .talk
            case .tasks: .tasks
            case .issues: .issues
            case .board: .board
            case .interactions: .interactions
            case .fields: .fields
            case .documents: .documents
            case .partner: .partner
            case .event: .event
            }
        }

        var label: String { shared.title }

        init(_ shared: SubjectPane) {
            switch shared {
            case .overview: self = .overview
            case .talk: self = .conversation
            case .tasks: self = .tasks
            case .issues: self = .issues
            case .board: self = .board
            case .interactions: self = .interactions
            case .fields: self = .fields
            case .documents: self = .documents
            case .partner: self = .partner
            case .event: self = .event
            }
        }
    }

    @State private var pane: Pane
    @EnvironmentObject private var app: StarlingsAppModel
    /// For the signed-in person's role: the read-only notice offers Upgrade to an admin.
    @EnvironmentObject private var work: MobileMyWorkStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// The forwarding address of each subject channel opened here, for the Email block.
    @State private var inboundAddresses: [String: String] = [:]
    @State private var newTaskRequest: UUID?
    @State private var newIssueRequest: UUID?
    /// New document from the palette: the Docs pane opens and asks for a title.
    @State private var newDocumentRequested = false
    /// Owned here, not by the Issues/Interactions panes, so the tab bar's
    /// "(n)" has a total before either pane has ever been opened. Each pane
    /// still does its own loading against these same bindings once visited.
    @State private var issues: [CrmIssue] = []
    @State private var isIssuesLinked = false
    @State private var interactions: [CrmInteraction] = []
    /// The plan holds this project read-only. Read each time a
    /// project shows; no polling.
    @State private var isFrozen = false

    /// Talk unless the place that named this subject said otherwise — a task
    /// row on Home lands on Tasks, an unread row on Talk.
    init(subject: CrmSubject, initialPane: WorkPane = .overview, action: WorkAction? = nil) {
        _currentSubject = State(initialValue: subject)
        let pane: Pane = if subject.isPartner {
            // No issues on a partner (they stay project-only); it talks on
            // its organization ( slice 4a) and holds tasks filed on
            // it. Its page is the door unless Talk, Tasks or History was
            // asked for.
            switch initialPane {
            case .overview: .overview
            case .talk: .conversation
            case .tasks: .tasks
            case .interactions: .interactions
            case .issues: .partner
            }
        } else if subject.isEvent {
            // No issues and no history on an event (docs/EVENTS.md); its
            // page stands in for both.
            switch initialPane {
            case .overview: .overview
            case .talk: .conversation
            case .tasks: .tasks
            case .issues, .interactions: .event
            }
        } else {
            switch initialPane {
            case .overview: .overview
            case .talk: .conversation
            case .tasks: .tasks
            case .issues: subject.kind == "project" ? .issues : .conversation
            case .interactions: .interactions
            }
        }
        _pane = State(initialValue: pane)
        _newTaskRequest = State(initialValue: action == .newTask ? UUID() : nil)
        _newIssueRequest = State(initialValue: action == .newIssue ? UUID() : nil)
        if action == .newDocument { _pane = State(initialValue: .documents) }
        _newDocumentRequested = State(initialValue: action == .newDocument)
    }

    /// The subject's tabs, from the one table every client reads
    /// (`SubjectPane.layout`). Issues once a repository is
    /// linked (Core's marker, or the issues answer saying so); Fields only
    /// where the workspace has Core, Documents only where it has Docs
    ///. On a wide screen Talk is half of Overview, as on the Mac
    /// and web, so it has no tab of its own.
    private var panes: [Pane] {
        var has: Set<SubjectPane.Need> = []
        if currentSubject.hasRepo || isIssuesLinked { has.insert(.repo) }
        if !sideBySide { has.insert(.narrow) }
        if StarlingsWorkspace.active.has(.core) { has.insert(.core) }
        if StarlingsWorkspace.active.has(.docs) { has.insert(.docs) }
        return SubjectPane.panes(for: currentSubject.subjectKind, has: has).map(Pane.init)
    }

    /// A regular-width screen (iPad, full width): Talk beside the subject's
    /// work groups. A compact one keeps Talk as its own pane.
    private var sideBySide: Bool { horizontalSizeClass == .regular }

    /// Talk was asked for while it lives inside Overview.
    private var shownPane: Pane { pane == .conversation && sideBySide ? .overview : pane }

    /// Talk stays a bare word — an unread thread already has its own signal
    /// elsewhere — but the other panes say how much is behind them.
    private func label(for pane: Pane) -> String {
        let count: Int? = switch pane {
        case .overview, .conversation, .board, .fields, .documents, .partner, .event: nil
        case .tasks: currentSubject.openTasks
        case .issues: issues.count
        case .interactions: interactions.count
        }
        guard let count, count > 0 else { return pane.label }
        return String(localized: "\(pane.label) (\(count))")
    }

    /// Issues and Interactions are loaded here, once per subject, so the tab
    /// bar has a total before either pane has ever been opened — the same
    /// reason Tasks can lean on `currentSubject.openTasks` for free. Each pane
    /// still refines this on its own once visited (filters, paging).
    private func loadCounts() async {
        guard let credentials = app.ownerCredentials else { return }
        if currentSubject.kind == "project" {
            // A failed read draws nothing; the Worker still refuses the write.
            let plan = try? await app.api.workspacePlan(credentials: credentials)
            isFrozen = WorkspacePlanNotice.isFrozen(projectID: currentSubject.id, plan: plan)
        } else {
            isFrozen = false
        }
        if currentSubject.kind == "project",
           let found = try? await app.api.crmIssues(credentials: credentials, projectID: currentSubject.id) {
            issues = found.issues
            isIssuesLinked = found.linked
        }
        if !currentSubject.isEvent {
            let (projectID, leadID, organizationID) = StarlingsAPI.interactionsQuery(for: currentSubject)
            if let found = try? await app.api.crmInteractions(
                credentials: credentials, projectID: projectID, leadID: leadID, organizationID: organizationID
            ) {
                interactions = found
            }
        }
    }

    /// The subject's conversation, which tells the Email block its forwarding address.
    private var talk: some View {
        let subject = currentSubject
        return MobileThreadView(
            address: .subject(subject),
            onInboundAddress: { inboundAddresses[subject.id] = $0 },
            refSubject: subject,
            onShowOverview: { pane = .overview }
        )
    }

    /// The subject's work groups; on a wide screen Talk stands beside them in
    /// equal halves, each scrolling on its own, like the Mac's
    /// `StarlingsHalvesSplitView`.
    @ViewBuilder
    private var overview: some View {
        let groups = MobileSubjectOverviewView(
            subject: currentSubject,
            inboundAddress: inboundAddresses[currentSubject.id],
            issues: $issues,
            interactions: $interactions,
            onOpenPane: { requested in
                pane = pane(for: requested)
            },
            onOpenDocuments: { pane = .documents },
            onOpenSubject: { subject in
                currentSubject = subject
                pane = .overview
            },
            onNew: { requested in
                switch requested {
                case .tasks: newTaskRequest = UUID()
                case .issues: newIssueRequest = UUID()
                default: break
                }
                pane = pane(for: requested)
            }
        )
        if sideBySide {
            HStack(spacing: 0) {
                talk
                    .frame(maxWidth: .infinity)
                Divider()
                    .ignoresSafeArea(edges: .bottom)
                groups
                    .frame(maxWidth: .infinity)
            }
        } else {
            groups
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if isFrozen {
                MobileWorkspacePlanNotice(
                    message: WorkspacePlanNotice.frozenText(isAdmin: work.subjectState.isWorkspaceAdmin),
                    offersUpgrade: work.subjectState.isWorkspaceAdmin
                )
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
            Picker("View", selection: Binding(get: { shownPane }, set: { pane = $0 })) {
                ForEach(panes) { pane in
                    Text(label(for: pane)).tag(pane)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            switch shownPane {
            case .overview:
                overview
            case .conversation:
                talk
            case .tasks:
                MobileSubjectTasksView(
                    subject: currentSubject,
                    newTaskRequest: $newTaskRequest
                )
            case .issues:
                MobileSubjectIssuesView(
                    subject: currentSubject,
                    issues: $issues,
                    isLinked: $isIssuesLinked,
                    newIssueRequest: $newIssueRequest
                )
            case .board:
                MobileProjectBoardView(subject: currentSubject) { trace in
                    // Talk lands on the card's last line.
                    app.pendingThreadFocus = PendingThreadFocus(threadID: trace.threadID, focus: .message(trace.messageID))
                    pane = .conversation
                }
            case .interactions:
                MobileSubjectInteractionsView(subject: currentSubject, interactions: $interactions)
            case .fields:
                MobileSubjectFieldsView(subject: currentSubject)
            case .documents:
                MobileSubjectDocumentsView(subject: currentSubject)
                    .task {
                        guard newDocumentRequested else { return }
                        newDocumentRequested = false
                        // The pane may be built this very turn; let it attach first.
                        try? await Task.sleep(for: .milliseconds(150))
                        NotificationCenter.default.post(name: DocumentsPane.requestNew, object: "core:\(currentSubject.kind):\(currentSubject.id)")
                    }
            case .partner:
                MobilePartnerDetailView(subject: currentSubject) { survivor in currentSubject = survivor }
            case .event:
                MobileEventDetailView(subject: currentSubject)
            }
        }
        .background(StarlingsMobileColors.canvas.ignoresSafeArea())
        .task(id: "\(currentSubject.kind):\(currentSubject.id)") { await loadCounts() }
        .onChange(of: panes) { _, available in
            // A lead has no issues pane; do not strand somebody on a tab that
            // just disappeared.
            if !available.contains(pane) { pane = available.contains(.conversation) ? .conversation : .overview }
        }
        .navigationTitle(currentSubject.title)
        .navigationBarTitleDisplayMode(.inline)
        // The bar carries nothing of its own. The pane that creates things
        // (Tasks, Issues) puts its one filled `+` top right, and that is the
        // whole trailing side — docs/DESIGN.md, "The phone's bar". Editing
        // the subject is the Work list row's context menu.
    }

    private func pane(for requested: WorkPane) -> Pane {
        switch requested {
        case .overview: .overview
        case .talk: .conversation
        case .tasks: .tasks
        case .issues: .issues
        case .interactions: .interactions
        }
    }
}
