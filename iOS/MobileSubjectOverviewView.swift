import DocsKit
import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// The phone's subject Overview keeps the Mac hierarchy while replacing its
/// split view with stacked, independently foldable groups.
struct MobileSubjectOverviewView: View {
    let subject: CrmSubject
    /// The subject channel's forwarding address, known once its conversation has been opened.
    let inboundAddress: String?
    @Binding private var issues: [CrmIssue]
    @Binding private var interactions: [CrmInteraction]
    let onOpenPane: (WorkPane) -> Void
    let onOpenDocuments: () -> Void
    let onOpenSubject: (CrmSubject) -> Void
    /// The + on the Tasks or Issues header: the pane opens with its
    /// new-item sheet up, the same as Mac's header +.
    let onNew: (WorkPane) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var docs: DocsSession
    @EnvironmentObject private var work: MobileMyWorkStore
    @EnvironmentObject private var peerStore: MobileTeamStore
    @State private var handingOff: MobileHandOffRequest?
    /// A TASKS row's Delete, while the question is up.
    @State private var deletingTask: MobileTaskDeletion?
    @Environment(\.openURL) private var openURL
    @State private var tasks: [CrmTask] = []
    @State private var goals: [CrmGoal] = []
    @State private var decisions: [CrmDecision] = []
    @State private var goalsError: String?
    @State private var decisionsError: String?
    @State private var isLoadingGoals = false
    @State private var isLoadingDecisions = false
    @State private var newGoal = false
    @State private var newDecision = false
    @State private var goalToSettle: CrmGoal?
    @State private var writeError: String?
    /// The responsible person this view chose, until the parent's subject
    /// catches up: `.some(nil)` is a cleared choice (docs/OWNERSHIP.md).
    @State private var chosenResponsible: String??
    /// The roster, read when the goal sheet first opens; empty means no
    /// Owner row rather than an empty menu.
    @State private var team: [CrmTeamMember] = []
    @State private var documents: [DocsDocumentSummary] = []
    @State private var detail: CrmSubjectDetail?
    /// The form answers that filed a lead (docs/FORMS.md); nil for most leads.
    @State private var submission: FormSubmission?
    @State private var submissionError: String?
    @State private var taskError: String?
    @State private var documentsError: String?
    @State private var detailError: String?
    @State private var isLoadingDetail = false
    @State private var collapsed: Set<String> = []
    /// The offer open in its read sheet.
    @State private var openingOffer: MobileOpenOffer?
    @State private var openingLicense: CrmLicense?
    @State private var isLoadingTasks = false
    @State private var isLoadingDocuments = false
    /// The people on the subject: an organization's contacts, a project's
    /// contacts, a lead's contact.
    @State private var contacts: [CrmContact] = []
    @State private var contactsError: String?
    /// True until the first read lands, so the group does not say "No
    /// contacts." before it has asked.
    @State private var isLoadingContacts = true
    /// Contacts has no pane of its own: Show all draws every one in place.
    @State private var showsAllContacts = false
    /// A lead's or an organization's offers and licenses: one read, one
    /// load, one error for both groups.
    @State private var commercial: CrmSubjectCommercialResponse?
    @State private var commercialError: String?
    /// True until the first read lands, so neither group says "No offers."
    /// or "No licenses." before it has asked.
    @State private var isLoadingCommercial = true
    /// Offers and Licenses have no pane of their own either.
    @State private var showsAllOffers = false
    @State private var showsAllLicenses = false

    init(
        subject: CrmSubject,
        inboundAddress: String? = nil,
        issues: Binding<[CrmIssue]>,
        interactions: Binding<[CrmInteraction]>,
        onOpenPane: @escaping (WorkPane) -> Void,
        onOpenDocuments: @escaping () -> Void,
        onOpenSubject: @escaping (CrmSubject) -> Void,
        onNew: @escaping (WorkPane) -> Void
    ) {
        self.subject = subject
        self.inboundAddress = inboundAddress
        _issues = issues
        _interactions = interactions
        self.onOpenPane = onOpenPane
        self.onOpenDocuments = onOpenDocuments
        self.onOpenSubject = onOpenSubject
        self.onNew = onNew
    }

    private var groupKeyPrefix: String { "\(subject.kind):\(subject.id):overview:" }

    var body: some View {
        StarlingsList {
            metadataSection
            contextSections
            // The groups, their order and what each needs are the registry's
            // (`SubjectOverviewGroup.layout`); this view draws them.
            ForEach(overviewGroups, id: \.self) { group in
                overviewGroup(group)
            }
        }
        .refreshable {
            await loadGoals()
            await loadDecisions()
            await loadTasks()
            await loadDocuments()
            await loadDetail()
            await loadContacts()
            await loadSubmission()
            await loadCommercial()
        }
        .task(id: "\(subject.kind):\(subject.id)") {
            await loadGoals()
            await loadDecisions()
            await loadTasks()
            await loadDocuments()
            await loadDetail()
            await loadContacts()
            await loadSubmission()
            await loadCommercial()
        }
        // The workspace's modules can land after the subject: Offers and
        // Licenses follow them.
        .onChange(of: work.subjectState.workModules) { _, _ in
            Task { await loadCommercial() }
        }
        .taskDeleteConfirmation($deletingTask) { deletion in
            Task {
                do {
                    try await work.deleteTask(id: deletion.id)
                    tasks.removeAll { $0.id == deletion.id }
                    await loadTasks()
                } catch {
                    app.alertMessage = (error as? StarlingsError)?.message ?? TaskDeleteCopy.failure
                }
            }
        }
        .sheet(item: $openingLicense) { license in
            MobileLicenseView(license: license)
        }
        .sheet(item: $openingOffer) { open in
            if let credentials = app.ownerCredentials {
                MobileOfferView(client: MobileOfferClient(api: app.api, credentials: credentials), offerID: open.id) {
                    Task { await loadCommercial() }
                }
            }
        }
        .sheet(item: $handingOff) { request in
            MobileHandOffEditor(
                cardTitle: request.target.title,
                agents: peerStore.roster.peers.filter(\.isAgent),
                preselected: request.agent
            ) { agent, handoff in
                Task {
                    do {
                        try await MobileHandOff.send(app: app, target: request.target, to: agent, handoff: handoff)
                    } catch {
                        app.alertMessage = error.localizedDescription
                    }
                }
            }
        }
        .sheet(isPresented: $newGoal) {
            MobileGoalEditor(team: team) { draft in Task { await createGoal(draft) } }
                .task { await loadTeam() }
        }
        .sheet(isPresented: $newDecision) {
            MobileDecisionEditor(goals: liveGoals) { draft in Task { await createDecision(draft) } }
        }
        // A goal has no page to open; its row offers the one thing to do
        // with it — settle its status.
        .confirmationDialog(goalToSettle?.title ?? "", isPresented: Binding(get: { goalToSettle != nil }, set: { if !$0 { goalToSettle = nil } }), titleVisibility: .visible) {
            if let goal = goalToSettle {
                if goal.status == .open {
                    Button("Met") { Task { await setGoal(goal, status: .met) } }
                    Button("Drop", role: .destructive) { Task { await setGoal(goal, status: .dropped) } }
                } else {
                    Button("Reopen") { Task { await setGoal(goal, status: .open) } }
                }
            }
        }
        .meetHaptic(.error, whenSet: writeError)
    }

    /// The groups this subject draws, in the registry's order.
    private var overviewGroups: [SubjectOverviewGroup] {
        var has: Set<SubjectOverviewGroup.Need> = []
        if subject.hasRepo || !issues.isEmpty || isIssuesRelevant { has.insert(.repo) }
        if docs.isLinked, subject.docsSubject != nil { has.insert(.docs) }
        // Nil work modules is every module on.
        let modules = work.subjectState.workModules
        if modules?.contains(.offers) ?? true { has.insert(.offers) }
        if modules?.contains(.licenses) ?? true { has.insert(.licenses) }
        return SubjectOverviewGroup.groups(for: subject.subjectKind, has: has)
    }

    @ViewBuilder
    private func overviewGroup(_ group: SubjectOverviewGroup) -> some View {
        switch group {
        case .goals:
            groupSection(
                key: "goals",
                title: String(localized: "Goals"),
                rows: Array(GoalsDecisions.sorted(goals).prefix(5)).map { goal in
                    AnyView(Button { goalToSettle = goal } label: {
                        MobileWorkRow(title: goal.title) {
                            MobileCompactMark(
                                systemName: MobileGoalRow.symbol(goal),
                                shape: .square,
                                size: 24,
                                color: GoalsDecisions.isLate(goal) ? StarlingsMobileColors.danger : Color.secondary
                            )
                        } metadata: {
                            Text(MobileGoalRow.metadata(goal))
                        }
                    }.buttonStyle(.meetPlain))
                },
                count: goals.count,
                isLoading: isLoadingGoals,
                error: goalsError,
                showAll: nil,
                retry: { Task { await loadGoals() } },
                onNew: { newGoal = true }
            )
        case .submission:
            if subject.kind == "lead", submission != nil || submissionError != nil {
                groupSection(
                    key: "submission",
                    title: submission?.title ?? String(localized: "Answers"),
                    rows: submission.map { [AnyView(MobileSubmissionAnswers(submission: $0))] } ?? [],
                    count: 0,
                    isLoading: false,
                    error: submissionError,
                    showAll: nil,
                    retry: { Task { await loadSubmission() } }
                )
            }
        case .tasks:
            groupSection(
                key: "tasks",
                title: String(localized: "Tasks"),
                rows: Array(tasks.prefix(5)).map { task in
                    AnyView(NavigationLink { MobileTaskView(task: task, subject: subject) { id in tasks.removeAll { $0.id == id } } } label: {
                        MobileWorkRow(title: task.title) {
                            MobileCompactMark(
                                systemName: task.isOverdue ? "exclamationmark.circle" : "checkmark",
                                shape: .square,
                                size: 24,
                                color: task.isOverdue ? StarlingsMobileColors.danger : Color.secondary
                            )
                        } metadata: {
                            Text([task.status.menuTitle, MobileDayLabel.text(task.dueDate).map { String(localized: "Due \($0)") }]
                                .compactMap { $0 }.joined(separator: " · "))
                        }
                    }
                    .buttonStyle(.meetPlain)
                    .contextMenu {
                        WorkRowActionMenu(
                            groups: task.status.isProposed
                                ? task.proposedRowActions(subject: subject)
                                : task.rowActions(subject: subject, agents: peerStore.roster.peers.filter(\.isAgent), client: .ios),
                            perform: perform
                        )
                    })
                },
                count: tasks.count,
                isLoading: isLoadingTasks,
                error: taskError,
                showAll: { onOpenPane(.tasks) },
                retry: { Task { await loadTasks() } },
                onNew: { onNew(.tasks) }
            )
        case .issues:
            groupSection(
                key: "issues",
                title: String(localized: "Issues"),
                rows: Array(issues.prefix(5)).map { issue in
                    AnyView(Button { onOpenPane(.issues) } label: {
                        MobileWorkRow(title: issue.title) {
                        MobileCompactMark(
                            systemName: issue.isOpen ? "circle" : "checkmark.circle",
                            shape: .square,
                            size: 24
                        )
                        } metadata: {
                            Text("\(issue.repo) \(issue.shortReference) · \(issue.stateSummary)")
                        }
                    }
                    .buttonStyle(.meetPlain)
                    .contextMenu {
                        WorkRowActionMenu(groups: [issue.stateActions(projectID: subject.id)], perform: perform)
                    })
                },
                count: issues.count,
                isLoading: false,
                error: nil,
                showAll: { onOpenPane(.issues) },
                retry: nil,
                onNew: subject.hasRepo ? { onNew(.issues) } : nil
            )
        case .decisions:
            groupSection(
                key: "decisions",
                title: String(localized: "Decisions"),
                rows: Array(decisions.prefix(5)).map { decision in
                    AnyView(MobileWorkRow(title: decision.body) {
                        MobileCompactMark(systemName: "checkmark.seal", shape: .square, size: 24)
                    } metadata: {
                        Text(MobileDecisionRow.metadata(decision, goals: goals))
                    })
                },
                count: decisions.count,
                isLoading: isLoadingDecisions,
                error: decisionsError,
                showAll: { onOpenPane(.interactions) },
                retry: { Task { await loadDecisions() } },
                onNew: { newDecision = true }
            )
        case .documents:
            groupSection(
                key: "documents",
                title: String(localized: "Documents"),
                rows: Array(documents.prefix(5)).map { document in
                    AnyView(Button { onOpenDocuments() } label: {
                        MobileWorkRow(title: document.title) {
                            Image(systemName: document.kind == "pdf" ? "doc.richtext" : "doc.text")
                                .foregroundStyle(.secondary)
                        } metadata: {
                            Text(document.path)
                        }
                    }.buttonStyle(.meetPlain))
                },
                count: documents.count,
                isLoading: isLoadingDocuments,
                error: documentsError,
                showAll: onOpenDocuments,
                retry: { Task { await loadDocuments() } }
            )
        case .history:
            groupSection(
                key: "history",
                title: String(localized: "History"),
                rows: Array(interactions.prefix(5)).map { interaction in
                    AnyView(Button { onOpenPane(.interactions) } label: {
                        MobileWorkRow(title: interaction.displayTitle) {
                            Image(systemName: interaction.symbolName).foregroundStyle(.secondary)
                        } metadata: {
                            Text(interaction.metadataLabel)
                        }
                    }.buttonStyle(.meetPlain))
                },
                count: interactions.count,
                isLoading: false,
                error: nil,
                showAll: { onOpenPane(.interactions) },
                retry: nil
            )
        case .contacts:
            groupSection(
                key: "contacts",
                title: String(localized: "Contacts"),
                rows: contactRows,
                count: contacts.count,
                isLoading: isLoadingContacts,
                error: contactsError,
                showAll: showsAllContacts ? nil : { showsAllContacts = true },
                retry: {
                    Task {
                        // A project's or a lead's contacts are named by its record.
                        if detail == nil { await loadDetail() }
                        await loadContacts()
                    }
                },
                emptyText: String(localized: "No contacts.")
            )
        case .offers:
            // A nil list in the answer is a module the workspace has off.
            if isLoadingCommercial || commercialError != nil || commercial?.offers != nil {
                let offers = commercial?.offers ?? []
                groupSection(
                    key: "offers",
                    title: String(localized: "Offers"),
                    rows: offers.prefix(showsAllOffers ? offers.count : 5).map { offer in
                        let row = MobileWorkRow(title: SubjectCommercial.offerTitle(offer)) {
                            MobileCompactMark(systemName: "doc.plaintext", shape: .square, size: 24)
                        } metadata: {
                            Text(SubjectCommercial.offerSubtitle(offer, day: MobileDayLabel.text))
                        }
                        // While Core holds the commercial group a row only reads here, as on the web.
                        guard OfferAvailability.isEditableHere else { return AnyView(row) }
                        return AnyView(Button { openingOffer = MobileOpenOffer(id: offer.id) } label: { row.contentShape(Rectangle()) }
                            .buttonStyle(.meetPlain))
                    },
                    count: offers.count,
                    isLoading: isLoadingCommercial,
                    error: commercialError,
                    showAll: showsAllOffers ? nil : { showsAllOffers = true },
                    retry: { Task { await loadCommercial() } },
                    emptyText: String(localized: "No offers.")
                )
            }
        case .licenses:
            if isLoadingCommercial || commercialError != nil || commercial?.licenses != nil {
                let licenses = commercial?.licenses ?? []
                groupSection(
                    key: "licenses",
                    title: String(localized: "Licenses"),
                    rows: licenses.prefix(showsAllLicenses ? licenses.count : 5).map { license in
                        AnyView(Button { openingLicense = license } label: { MobileWorkRow(title: SubjectCommercial.licenseTitle(license)) {
                            MobileCompactMark(systemName: "key", shape: .square, size: 24)
                        } metadata: {
                            // Due for renewal: neutral ink, bold (docs/DESIGN.md, colour budget).
                            if SubjectCommercial.renewsSoon(license) {
                                Text(SubjectCommercial.licenseSubtitle(license, day: MobileDayLabel.text))
                                    .fontWeight(.bold)
                                    .foregroundStyle(StarlingsMobileColors.primary)
                            } else {
                                Text(SubjectCommercial.licenseSubtitle(license, day: MobileDayLabel.text))
                            }
                        } }.buttonStyle(.meetPlain))
                    },
                    count: licenses.count,
                    isLoading: isLoadingCommercial,
                    error: commercialError,
                    showAll: showsAllLicenses ? nil : { showsAllLicenses = true },
                    retry: { Task { await loadCommercial() } },
                    emptyText: String(localized: "No licenses.")
                )
            }
        case .related:
            if subject.isPartner {
                groupSection(
                    key: "related",
                    title: String(localized: "Related subjects"),
                    rows: relatedRows,
                    count: relatedSubjects.count,
                    isLoading: detail == nil && detailError == nil,
                    error: detailError,
                    showAll: nil,
                    retry: { Task { await loadDetail() } }
                )
            } else if subject.kind == "lead" || subject.kind == "project", !relatedSubjects.isEmpty {
                // The lead-to-project edge (ADR 0008). About shows the detail's loading and error.
                groupSection(
                    key: "related",
                    title: subject.kind == "lead" ? String(localized: "Projects") : String(localized: "Won from"),
                    rows: relatedRows,
                    count: relatedSubjects.count,
                    isLoading: false,
                    error: nil,
                    showAll: nil,
                    retry: nil
                )
            }
        }
    }

    private var liveGoals: [CrmGoal] { GoalsDecisions.sorted(goals.filter(GoalsDecisions.isLive)) }

    /// The phone stacks the context groups at the top of Overview; Mac and
    /// web draw the same facts in their right inspector. Person rows route to
    /// Team's existing DM destination.
    private var contextWorkLines: [String] {
        var lines = [String(localized: "\(subject.openTasks) open tasks")]
        if subject.overdueTasks > 0 { lines.append(String(localized: "\(subject.overdueTasks) overdue")) }
        if subject.kind == "project" {
            lines.append(subject.hasRepo ? String(localized: "Repository linked") : String(localized: "No repository linked"))
        }
        return lines
    }

    @ViewBuilder
    /// The blocks of the subject's context, in the order the shared registry gives for its
    /// kind (`SubjectContextRegistry`, pinned to `fixtures/subject-context.json`). This draws
    /// what each one says; a block with nothing to say draws nothing.
    private var contextSections: some View {
        ForEach(SubjectContextRegistry.blocks(for: subject.subjectKind, client: .ios), id: \.self) { block in
            contextBlock(block)
        }
    }

    @ViewBuilder
    private func contextBlock(_ block: SubjectContextBlock) -> some View {
        switch block {
        case .team: teamBlock
        case .agents: agentsBlock
        case .when: whenBlock
        case .where: whereBlock
        case .links: linksBlock
        case .website: websiteBlock
        case .work: workBlock
        case .goals: EmptyView()  // a group of the Overview body on iOS (`SubjectContextRegistry.notOn`)
        case .relationship: relationshipBlock
        case .about: aboutBlock
        case .email: emailBlock
        }
    }

    /// Chosen, else suggested from this subject's open tasks; projects and leads only.
    private var responsible: Responsible? {
        Responsible.of(
            kind: subject.kind,
            responsibleEmail: chosenResponsible ?? subject.responsibleEmail,
            tasks: tasks.map { Responsible.Task(assigneeEmail: $0.assigneeEmail, status: $0.status.rawValue) }
        )
    }

    @ViewBuilder
    private var teamBlock: some View {
        let peers = peerStore.roster
        let responsible = responsible
        let chosen = responsible?.source == .chosen ? responsible?.email : nil
        let canChoose = subject.kind == "project" || subject.kind == "lead"
        let everyone = (peers.me.map { [$0] } ?? []) + peers.people
        // The responsible person first, as on the Mac and the web.
        let people = everyone.filter { $0.email.lowercased() == responsible?.email } + everyone.filter { $0.email.lowercased() != responsible?.email }
        let around = people.filter { $0.status != .offline }.count
        let peopleCount = people.count == 1 ? String(localized: "1 person") : String(localized: "\(people.count) people")
        let summary = [peopleCount, String(localized: "\(around) around"), String(localized: "All \(StarlingsWorkspace.active.name) members")]
            .joined(separator: " · ")
        let teamRows: [AnyView] = people.isEmpty ? [] : [AnyView(
            Text(summary).font(.footnote).foregroundStyle(.secondary)
        )] + people.map { peer in
            let note = peer.email.lowercased() == responsible?.email ? responsible?.label : nil
            let row = WorkSidebarRow.peer(peer, hasUnread: peerStore.unreadPeerEmails.contains(peer.email), note: note)
            let groups: [[WorkRowAction]] = canChoose && peer.email.lowercased() != chosen
                ? [[.makeResponsible(subject, email: peer.email)]]
                : []
            if peer.isSelf {
                return AnyView(row.contextMenu { WorkRowActionMenu(groups: groups, perform: perform) })
            } else {
                return AnyView(
                    Button { app.openTeam(peerEmail: peer.email) } label: { row }
                        .buttonStyle(.plain)
                        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                        .contextMenu { WorkRowActionMenu(groups: groups, perform: perform) }
                )
            }
        }
        groupSection(
            key: "team",
            title: String(localized: "Team"),
            rows: teamRows,
            count: people.count,
            isLoading: peerStore.isLoading && people.isEmpty,
            error: peerStore.errorMessage,
            showAll: nil,
            retry: { Task { await peerStore.refresh() } }
        )
    }

    @ViewBuilder
    private var agentsBlock: some View {
        let peers = peerStore.roster
        let agentEmail = subject.agentEmail?.trimmingCharacters(in: .whitespacesAndNewlines)
        let agent = agentEmail.flatMap { email in
            peers.agents.first { $0.email.caseInsensitiveCompare(email) == .orderedSame }
        }
        let agentRows: [AnyView] = if let agent {
            [AnyView(
                Button { app.openTeam(peerEmail: agent.email) } label: {
                    WorkSidebarRow.peer(agent, hasUnread: peerStore.unreadPeerEmails.contains(agent.email))
                }
                .buttonStyle(.plain)
                .meetHoverLift(cornerRadius: EnvisioningRadius.control)
            )]
        } else if let agentEmail, !agentEmail.isEmpty {
            [AnyView(Text(peerStore.isLoading ? String(localized: "Loading agent…") : String(localized: "Agent not in the roster."))
                .font(.footnote).foregroundStyle(.secondary))]
        } else {
            [AnyView(Text("None attached. @mention an agent to bring it in.")
                .font(.footnote).foregroundStyle(.secondary))]
        }
        groupSection(
            key: "agents",
            title: String(localized: "Agents"),
            rows: agentRows,
            count: agent == nil ? 0 : 1,
            isLoading: false,
            error: nil,
            showAll: nil,
            retry: nil
        )
    }

    @ViewBuilder
    private var workBlock: some View {
        groupSection(
            key: "context-work",
            title: String(localized: "Work"),
            rows: contextWorkLines.map { AnyView(Text($0).font(.footnote)) },
            count: 0,
            isLoading: false,
            error: nil,
            showAll: nil,
            retry: nil
        )
    }

    @ViewBuilder
    private var relationshipBlock: some View {
        // An organization's block is what it is to the workspace
        //; a project's or a lead's is its organization.
        let line = subject.isPartner ? detail?.relationshipLine : subject.organizationName
        if let line, !line.isEmpty {
            groupSection(
                key: "relationship",
                title: String(localized: "Relationship"),
                rows: [AnyView(Text(line).font(.footnote))],
                count: 0,
                isLoading: false,
                error: nil,
                showAll: nil,
                retry: nil
            )
        }
    }

    @ViewBuilder
    private var emailBlock: some View {
        if let inboundAddress {
            groupSection(
                key: "email",
                title: String(localized: "Email"),
                rows: [AnyView(Text(inboundAddress).font(.footnote).textSelection(.enabled))],
                count: 0,
                isLoading: false,
                error: nil,
                showAll: nil,
                retry: nil
            )
        }
    }

    @ViewBuilder
    private var aboutBlock: some View {
        let aboutLines: [String] = {
            guard let detail else { return [] }
            var lines = [detail.status]
            // How many of Core's five checks are set.
            if subject.kind == "lead" { lines.append(LeadQualification.summary(detail.characteristics)) }
            let dates = [detail.startDate, detail.endDate].compactMap { MobileDayLabel.text($0) }.joined(separator: " → ")
            if !dates.isEmpty { lines.append(dates) }
            if (subject.kind == "project" || subject.isPartner), let url = detail.url, !url.isEmpty { lines.append(url) }
            let notes = subject.kind == "project" || subject.isPartner ? detail.description : detail.notes
            if let notes = notes?.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
                lines.append(String(notes.prefix(180)))
            }
            if subject.isPartner, let industry = detail.industry, !industry.isEmpty { lines.insert(industry, at: 0) }
            return lines.filter { !$0.isEmpty }
        }()
        if detail != nil || detailError != nil || isLoadingDetail {
            groupSection(
                key: "about",
                title: String(localized: "About"),
                rows: aboutLines.map { AnyView(Text($0).font(.footnote)) },
                count: 0,
                isLoading: isLoadingDetail,
                error: detailError,
                showAll: nil,
                retry: { Task { await loadDetail() } }
            )
        }
    }

    /// An event's facts (docs/EVENTS.md): when, where, the links, and whether the website lists it.
    @ViewBuilder
    private var whenBlock: some View {
        let raw = detail?.eventDate ?? subject.eventDate
        let day: String = {
            guard let raw else { return String(localized: "No date yet") }
            let parser = DateFormatter()
            parser.calendar = Calendar(identifier: .gregorian)
            parser.dateFormat = "yyyy-MM-dd"
            guard let date = parser.date(from: String(raw.prefix(10))) else { return String(localized: "No date yet") }
            return date.formatted(date: .complete, time: .omitted)
        }()
        let lines: [String] = {
            var lines = [day]
            if let startAt = detail?.startAt, let start = ISODate.parse(startAt) {
                let timeZone = detail?.timezone.flatMap(TimeZone.init(identifier:))
                lines.append([StarlingsDateFormatting.time(start, timeZone: timeZone), detail?.timezone].compactMap { $0 }.joined(separator: " "))
            }
            return lines
        }()
        eventBlockSection(key: "when", title: String(localized: "When"), lines: lines)
    }

    @ViewBuilder
    private var whereBlock: some View {
        let lines = [detail?.place, detail?.location].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if !lines.isEmpty { eventBlockSection(key: "where", title: String(localized: "Where"), lines: lines) }
    }

    @ViewBuilder
    private var linksBlock: some View {
        let lines: [String] = {
            var lines: [String] = []
            if let url = detail?.url, !url.isEmpty { lines.append(url) }
            if let partner = detail?.partner, !partner.isEmpty {
                lines.append([partner, detail?.partnerURL].compactMap { $0 }.joined(separator: " · "))
            }
            return lines
        }()
        if !lines.isEmpty { eventBlockSection(key: "links", title: String(localized: "Links"), lines: lines) }
    }

    @ViewBuilder
    private var websiteBlock: some View {
        if let published = detail?.published ?? subject.published {
            eventBlockSection(key: "website", title: String(localized: "Website"), lines: [published ? String(localized: "Listed") : String(localized: "Not listed yet")])
        }
    }

    private func eventBlockSection(key: String, title: String, lines: [String]) -> some View {
        groupSection(
            key: key,
            title: title,
            rows: lines.map { AnyView(Text($0).font(.footnote).textSelection(.enabled)) },
            count: 0,
            isLoading: false,
            error: nil,
            showAll: nil,
            retry: nil
        )
    }

    private var metadataSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(subject.title).font(.headline)
                Text([subject.subtitle, subject.organizationName, subject.standing]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let detail, !detail.status.isEmpty {
                    Text(detail.status).font(.caption).foregroundStyle(.secondary)
                }
                if subject.openTasks > 0 {
                    Text("\(subject.openTasks) open tasks")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        } header: {
            Text(subject.subjectKind.rawValue.capitalized)
        }
    }

    private var isIssuesRelevant: Bool {
        subject.hasRepo
    }

    private var relatedSubjects: [CrmSubject] {
        guard let related = detail?.related else { return [] }
        return related.projects.map {
            CrmSubject(id: $0.id, kind: "project", title: $0.title ?? String(localized: "Untitled project"), subtitle: $0.status)
        } + related.leads.map {
            CrmSubject(id: $0.id, kind: "lead", title: $0.title ?? String(localized: "Untitled lead"), subtitle: $0.status)
        }
    }

    private var relatedRows: [AnyView] {
        relatedSubjects.prefix(5).map { related in
            AnyView(Button { onOpenSubject(related) } label: {
                MobileWorkRow(title: related.title) {
                    Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
                } metadata: {
                    Text(related.subtitle ?? related.kind.capitalized)
                }
            }.buttonStyle(.meetPlain))
        }
    }

    private var contactRows: [AnyView] {
        // An organization's contacts all work there: the row says only what they do.
        let showsOrganization = subject.subjectKind != .organization
        return contacts.prefix(showsAllContacts ? contacts.count : 5).map { contact in
            let subtitle = [contact.title, showsOrganization ? contact.organizationName : nil]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: " · ")
            return AnyView(NavigationLink { MobileContactView(contactID: contact.id) } label: {
                MobileWorkRow(title: contact.displayName) {
                    Image(systemName: "person").foregroundStyle(.secondary)
                } metadata: {
                    if !subtitle.isEmpty { Text(subtitle) }
                }
            }.buttonStyle(.meetPlain))
        }
    }

    @ViewBuilder
    private func groupSection(
        key: String,
        title: String,
        rows: [AnyView],
        count: Int,
        isLoading: Bool,
        error: String?,
        showAll: (() -> Void)?,
        retry: (() -> Void)?,
        onNew: (() -> Void)? = nil,
        emptyText: String? = nil
    ) -> some View {
        let stateKey = groupKeyPrefix + key
        // A group that can take a new item, or says when it has none, keeps
        // its header when empty.
        if onNew != nil || emptyText != nil || isLoading || error != nil || !rows.isEmpty {
            Section {
                DisclosureGroup(
                    isExpanded: Binding(
                        get: { !collapsed.contains(stateKey) },
                        set: { expanded in
                            if expanded { collapsed.remove(stateKey) } else { collapsed.insert(stateKey) }
                        }
                    )
                ) {
                    if let error {
                        StarlingsErrorNotice(message: error, retry: retry)
                    } else if isLoading && rows.isEmpty {
                        EnvisioningPlaceholderRows()
                    } else if rows.isEmpty, let emptyText {
                        Text(emptyText).font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in row }
                        if let showAll, count > 5 {
                            Button("Show all", action: showAll)
                                .font(.footnote.weight(.medium))
                        }
                    }
                } label: {
                    HStack {
                        Text(title)
                        if count > 0 { Text("\(count)").foregroundStyle(.secondary) }
                        Spacer()
                        if let onNew {
                            Button(action: onNew) {
                                Image(systemName: "plus")
                            }
                            .buttonStyle(.meetPlain)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(
                                key == "goals" ? String(localized: "New Goal")
                                    : key == "decisions" ? String(localized: "Record Decision")
                                    : key == "tasks" ? String(localized: "New Task") : String(localized: "New Issue")
                            )
                        }
                    }
                }
            }
        }
    }

    /// A TASKS or ISSUES row's menu choice: the same registry as the Tasks
    /// and Issues panes. Each write re-reads this block and the store Mine
    /// and Home read.
    private func perform(_ action: WorkRowAction) {
        if case .openCore(let url) = action {
            openURL(url)
            return
        }
        if case .handOff(let target, let agent) = action {
            handingOff = MobileHandOffRequest(target: target, agent: agent)
            return
        }
        if case .deleteTask(let id, let title) = action {
            deletingTask = MobileTaskDeletion(id: id, title: title)
            return
        }
        Task {
            guard let credentials = app.ownerCredentials else { return }
            let api = app.api
            do {
                switch action {
                case .accept(let task):
                    _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .proposalDecision(accepted: true))
                case .decline(let task):
                    _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .proposalDecision(accepted: false))
                case .completeTask(let task):
                    _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .completion(true))
                case .cancelTask(let task):
                    _ = try await api.updateCrmTask(credentials: credentials, id: task.id, update: .cancellation)
                case .promoteTask(let task):
                    _ = try await api.createCrmIssue(credentials: credentials,
                        .promotion(projectID: subject.id, taskID: task.id, title: task.title, body: task.notes))
                case .setIssueState(let issue, let projectID, let change):
                    _ = try await api.updateCrmIssue(credentials: credentials, .stateChange(change, issue: issue, projectID: projectID))
                    if let found = try? await api.crmIssues(credentials: credentials, projectID: subject.id) {
                        issues = found.issues
                    }
                case .makeResponsible(let chosen, let email):
                    let detail = try await api.setCrmSubjectResponsible(credentials: credentials, kind: chosen.subjectKind, id: chosen.id, email: email)
                    chosenResponsible = .some(detail.responsibleEmail)
                    return
                default:
                    return
                }
                await loadTasks()
                await work.refresh()
            } catch {
                app.alertMessage = error.localizedDescription
            }
        }
    }

    private func loadTasks() async {
        guard let credentials = app.ownerCredentials else { return }
        isLoadingTasks = tasks.isEmpty
        do {
            tasks = try await app.api.crmTasks(
                credentials: credentials,
                projectID: subject.kind == "project" ? subject.id : nil,
                leadID: subject.kind == "lead" ? subject.id : nil,
                eventID: subject.kind == "event" ? subject.id : nil,
                organizationID: subject.isPartner ? subject.id : nil
            )
            taskError = nil
        } catch {
            taskError = error.localizedDescription
        }
        isLoadingTasks = false
    }

    private func loadTeam() async {
        guard team.isEmpty, let credentials = app.ownerCredentials else { return }
        team = (try? await app.api.crmTeam(credentials: credentials)) ?? []
    }

    private func loadGoals() async {
        guard let credentials = app.ownerCredentials, subject.kind == "project" else { return }
        isLoadingGoals = goals.isEmpty
        do {
            goals = try await app.api.crmGoals(credentials: credentials, projectID: subject.id, includeClosed: true)
            goalsError = nil
        } catch {
            goalsError = error.localizedDescription
        }
        isLoadingGoals = false
    }

    private func loadDecisions() async {
        guard let credentials = app.ownerCredentials else { return }
        isLoadingDecisions = decisions.isEmpty
        do {
            decisions = try await app.api.crmDecisions(credentials: credentials, subjectKind: subject.kind, subjectID: subject.id)
            decisionsError = nil
        } catch {
            decisionsError = error.localizedDescription
        }
        isLoadingDecisions = false
    }

    private func createGoal(_ draft: MobileGoalEditor.Draft) async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            _ = try await app.api.createCrmGoal(credentials: credentials, CrmGoalCreate(
                projectID: subject.id,
                title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
                targetDate: draft.targetDate.map { CrmTaskDate.civilDay($0) },
                owner: draft.owner
            ))
            await loadGoals()
        } catch {
            writeError = error.localizedDescription
        }
    }

    private func setGoal(_ goal: CrmGoal, status: GoalStatus) async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            _ = try await app.api.updateCrmGoal(credentials: credentials, id: goal.id, update: CrmGoalUpdate(status: status))
            await loadGoals()
        } catch {
            writeError = error.localizedDescription
        }
    }

    private func createDecision(_ draft: MobileDecisionEditor.Draft) async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            _ = try await app.api.createCrmDecision(credentials: credentials, CrmDecisionCreate(
                subjectKind: subject.kind,
                subjectID: subject.id,
                body: draft.body.trimmingCharacters(in: .whitespacesAndNewlines),
                goalID: draft.goalID
            ))
            await loadDecisions()
        } catch {
            writeError = error.localizedDescription
        }
    }

    private func loadDocuments() async {
        guard docs.isLinked, let about = subject.docsSubject else { return }
        isLoadingDocuments = documents.isEmpty
        do {
            documents = try await docs.client.documents(about: about, limit: 20)
            documentsError = nil
        } catch {
            documentsError = error.localizedDescription
        }
        isLoadingDocuments = false
    }

    private func loadSubmission() async {
        guard subject.kind == "lead", let credentials = app.ownerCredentials else { return }
        do {
            submission = try await app.api.leadSubmission(credentials: credentials, id: subject.id)
            submissionError = nil
        } catch {
            submissionError = error.localizedDescription
        }
    }

    /// An organization's contacts by its id; a project's or a lead's by the
    /// ids its record names, so this runs after `loadDetail`.
    private func loadContacts() async {
        guard let credentials = app.ownerCredentials,
              SubjectOverviewGroup.layout[subject.subjectKind]?.contains(.contacts) == true else {
            isLoadingContacts = false
            return
        }
        isLoadingContacts = contacts.isEmpty
        defer { isLoadingContacts = false }
        do {
            let result: [CrmContact]
            if subject.subjectKind == .organization {
                result = try await app.api.crmContacts(credentials: credentials, organizationID: subject.id)
            } else {
                guard let detail else {
                    contactsError = detailError ?? String(localized: "Couldn’t load contacts")
                    return
                }
                var ids: [String] = []
                for id in [detail.contactID].compactMap({ $0 }) + (detail.contactIDs ?? []) where !id.isEmpty && !ids.contains(id) {
                    ids.append(id)
                }
                result = ids.isEmpty ? [] : try await app.api.crmContacts(credentials: credentials, ids: ids)
            }
            contacts = result.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            contactsError = nil
        } catch {
            contactsError = error.localizedDescription
        }
    }

    /// Offers and Licenses, one read for both; skipped when neither is drawn.
    private func loadCommercial() async {
        guard let credentials = app.ownerCredentials,
              overviewGroups.contains(where: { $0 == .offers || $0 == .licenses }) else {
            isLoadingCommercial = false
            return
        }
        isLoadingCommercial = commercial == nil
        defer { isLoadingCommercial = false }
        do {
            commercial = try await app.api.crmSubjectCommercial(credentials: credentials, kind: subject.subjectKind, id: subject.id)
            commercialError = nil
        } catch {
            commercialError = error.localizedDescription
        }
    }

    private func loadDetail() async {
        guard let credentials = app.ownerCredentials else { return }
        isLoadingDetail = detail == nil
        do {
            let fresh = try await app.api.crmSubjectDetail(credentials: credentials, kind: subject.subjectKind, id: subject.id)
            detailError = nil
            // A merged id: the subject page holds the survivor from here on.
            if let mergedID = fresh.mergedFrom, fresh.id != subject.id {
                let survivor = fresh.summary
                isLoadingDetail = false
                await app.adoptSurvivor(kind: subject.kind, mergedID: mergedID, survivor: SearchRow.subject(survivor), survivorID: survivor.id)
                onOpenSubject(survivor)
                return
            }
            detail = fresh
        } catch {
            detailError = error.localizedDescription
        }
        isLoadingDetail = false
    }
}

/// A lead's form answers (docs/FORMS.md): the date it came in, then each
/// section's questions with the answers under them, all of them, as one
/// block. The text is selectable, to copy a quote out.
struct MobileSubmissionAnswers: View {
    let submission: FormSubmission

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sent \(CrmTaskDate.display(submission.submittedAt) ?? String(submission.submittedAt.prefix(10)))")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ForEach(submission.sections, id: \.title) { section in
                VStack(alignment: .leading, spacing: 6) {
                    Text(section.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(section.answers, id: \.question) { item in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.question).font(.caption).foregroundStyle(.secondary)
                            Text(item.answer).font(.subheadline)
                        }
                    }
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }
}

/// An Offers row the person opened.
struct MobileOpenOffer: Identifiable {
    let id: String
}
