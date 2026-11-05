import AppKit
import DocsKit
import StarlingsContracts

/// The grouped work shown beside a subject's conversation. The groups are
/// deliberately named after the dedicated Work panes so Overview is a useful
/// landing surface, not a second work filter.
enum WorkSubjectOverviewGroup: String, CaseIterable, Hashable, Sendable {
    case goals
    case decisions
    case tasks
    case issues
    /// The people on the subject: an organization's contacts, a project's
    /// contacts, a lead's contact.
    case contacts
    /// A lead's or an organization's offers and licenses, one read for both
    ///. Each is drawn while its work module is on.
    case offers
    case licenses
    case documents
    case history
    case related
    /// The form answers that filed a lead (docs/FORMS.md). Drawn only when there are some.
    case submission

    var title: String {
        switch self {
        case .goals: String(localized: "GOALS")
        case .decisions: String(localized: "DECISIONS")
        case .tasks: String(localized: "TASKS")
        case .issues: String(localized: "ISSUES")
        case .contacts: String(localized: "CONTACTS")
        case .offers: String(localized: "OFFERS")
        case .licenses: String(localized: "LICENSES")
        case .documents: String(localized: "DOCUMENTS")
        case .history: String(localized: "HISTORY")
        case .related: String(localized: "RELATED SUBJECTS")
        case .submission: String(localized: "ANSWERS")
        }
    }

    /// The header on one subject: `related` is a lead's projects and a
    /// project's lead, the lead-to-project edge (ADR 0008), on those kinds.
    func title(on subject: CrmSubject) -> String {
        guard self == .related else { return title }
        return switch subject.subjectKind {
        case .lead: String(localized: "PROJECTS")
        case .project: String(localized: "WON FROM")
        case .event, .organization: title
        }
    }
}

/// Mac's subject Overview: Talk stays full height, while the contextual work
/// preview is independently foldable and resizable. Each read owns its own
/// loading/error state so a Docs or GitHub outage cannot blank the conversation.
@MainActor
final class WorkSubjectOverviewView: NSView {
    var onOpenTask: ((CrmTask) -> Void)?
    var onOpenIssue: ((CrmIssue) -> Void)?
    /// A task or issue row's menu choice (`WorkRowAction`), for the Work
    /// window to perform.
    var onRowAction: ((WorkRowAction) -> Void)?
    /// Who a task row can be handed to.
    var agents: [Peer] = []
    var onOpenInteraction: ((CrmInteraction) -> Void)?
    var onOpenDocument: ((String, String) -> Void)?
    var onOpenSubject: ((CrmSubject) -> Void)?
    /// A contact row: the contact's id and name.
    var onOpenContact: ((String, String) -> Void)?
    var onShowAll: ((WorkSubjectOverviewGroup) -> Void)?
    /// Board on a project's TASKS header: the project's tasks and issues by
    /// stage (docs/BOARD.md).
    var onShowBoard: (() -> Void)?
    /// The + on a Goals, Decisions, Tasks, Issues or Offers header: make one on this subject.
    var onNew: ((WorkSubjectOverviewGroup) -> Void)?
    /// An Offers row: the editor, while offers answer from this workspace.
    var onOpenOffer: ((String) -> Void)?
    /// A Licenses row: the editor, under the same rule.
    var onOpenLicense: ((CrmLicense) -> Void)?
    /// An organization's Partner discount row: its sheet.
    var onEditPartnerDiscount: ((CrmSubject, OrganizationDiscountResponse) -> Void)?
    /// A goal row: Met, Drop or Reopen, from its menu.
    var onSetGoalStatus: ((CrmGoal, GoalStatus) -> Void)?
    /// The goals landed or changed: the inspector's card follows.
    var onGoalsChanged: (() -> Void)?
    /// Whether the signed-in person is a workspace admin: the read-only
    /// notice offers Upgrade to an admin only.
    var isWorkspaceAdmin: () -> Bool = { false }

    private let api: MeetingControlAPI
    private let docs: DocsSession
    private let favorites: StarredWatch
    /// Talk | Work, in the proportion the user left them; the Work half is
    /// the split's trailing pane, on the panel ground.
    private lazy var splitView = StarlingsHalvesSplitView(name: "WorkSubjectOverview", trailing: workScroll)
    private let workScroll = NSScrollView()
    private let workStack = NSStackView()
    /// The row the inspector is showing, so it stays lit while it is open.
    private var selectedKey: String?

    private var subject: CrmSubject?
    private var goals: [CrmGoal] = []
    private var decisions: [CrmDecision] = []
    private var tasks: [CrmTask] = []
    private var issues: [CrmIssue] = []
    private var documents: [DocsDocumentSummary] = []
    private var interactions: [CrmInteraction] = []
    private var related: [CrmSubject] = []
    private var contacts: [CrmContact] = []
    private var submission: FormSubmission?
    private var submissionLoad: Task<Void, Never>?
    private var loaded: Set<WorkSubjectOverviewGroup> = []
    /// Groups whose Show all draws every row in place (Contacts, Offers, Licenses).
    private var expanded: Set<WorkSubjectOverviewGroup> = []
    private var errors: [WorkSubjectOverviewGroup: String] = [:]
    private var goalsLoad: Task<Void, Never>?
    private var decisionsLoad: Task<Void, Never>?
    private var tasksLoad: Task<Void, Never>?
    private var issuesLoad: Task<Void, Never>?
    private var documentsLoad: Task<Void, Never>?
    private var historyLoad: Task<Void, Never>?
    private var detailLoad: Task<Void, Never>?
    private var contactsLoad: Task<Void, Never>?
    /// Offers and licenses: one read, one load, one error for both groups.
    private var commercial: CrmSubjectCommercialResponse?
    /// The organization's standing discount: nil until read, and on any other subject.
    private var partnerDiscount: OrganizationDiscountResponse?
    private var commercialLoad: Task<Void, Never>?
    /// The workspace's work modules (`SubjectStateResponse.workModules`);
    /// nil is every module on.
    private var workModules: [WorkModule]?
    /// The workspace's plan, read each time a project shows. Kept across
    /// subjects so a second project does not flash its notice away.
    private var plan: WorkspacePlanResponse?
    private var planLoad: Task<Void, Never>?
    private weak var talkView: NSView?

    init(api: MeetingControlAPI, docs: DocsSession, favorites: StarredWatch) {
        self.api = api
        self.docs = docs
        self.favorites = favorites
        super.init(frame: .zero)

        addSubview(splitView)
        NSLayoutConstraint.activate([
            splitView.leadingAnchor.constraint(equalTo: leadingAnchor),
            splitView.trailingAnchor.constraint(equalTo: trailingAnchor),
            splitView.topAnchor.constraint(equalTo: topAnchor),
            splitView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        workStack.orientation = .vertical
        workStack.alignment = .leading
        workStack.spacing = 12
        workStack.edgeInsets = NSEdgeInsets(top: 12, left: 16, bottom: 18, right: 16)
        workStack.translatesAutoresizingMaskIntoConstraints = false

        workScroll.drawsBackground = false
        workScroll.hasVerticalScroller = true
        workScroll.borderType = .noBorder
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        workScroll.contentView = clip
        workScroll.documentView = workStack
        workStack.widthAnchor.constraint(equalTo: workScroll.contentView.widthAnchor).isActive = true

        // The Overview is the middle column's remainder, the same as Talk on
        // its own: nothing in here may hold the window open. Rows truncate
        // instead (see `StarlingsShellViewController`'s note on the middle column).
        for host in [self, splitView, workScroll, workStack] as [NSView] {
            host.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            host.setContentHuggingPriority(.defaultLow, for: .horizontal)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The existing Talk view is hosted rather than recreated, so its
    /// composer, scroll position, mentions, and read receipts stay exactly
    /// the same as the dedicated Talk pane.
    func setTalkView(_ view: NSView) {
        guard talkView !== view else { return }
        talkView?.removeFromSuperview()
        talkView = view
        splitView.setLeading(view)
    }

    /// Re-read the TASKS and ISSUES blocks after a write from any list.
    func reloadWork() {
        guard let subject else { return }
        switch subject.subjectKind {
        case .project, .lead, .event, .organization: loadTasks(for: subject)
        }
        if subject.kind == "project", subject.hasRepo { loadIssues(for: subject) }
    }

    func show(_ subject: CrmSubject) {
        cancelLoads()
        self.subject = subject
        selectedKey = nil
        goals = []
        decisions = []
        tasks = []
        issues = []
        documents = []
        interactions = []
        related = []
        contacts = []
        commercial = nil
        submission = nil
        loaded = []
        expanded = []
        errors = [:]
        render()

        if subject.kind == "lead" { loadSubmission(for: subject) }
        if subject.kind == "project" {
            loadGoals(for: subject)
            loadPlan(for: subject)
        }
        loadDecisions(for: subject)
        switch subject.subjectKind {
        case .project, .lead, .event, .organization:
            loadTasks(for: subject)
        }
        if subject.kind == "project", subject.hasRepo { loadIssues(for: subject) }
        if docs.isLinked, subject.docsSubject != nil { loadDocuments(for: subject) }
        if !subject.isEvent { loadHistory(for: subject) }
        if subject.isPartner || subject.kind == "lead" || subject.kind == "project" { loadRelated(for: subject) }
        if hasContacts(subject) { loadContacts(for: subject) }
        if hasCommercial(subject) { loadCommercial(for: subject) }
    }

    /// The workspace's work modules changed: Offers and Licenses follow.
    func setWorkModules(_ modules: [WorkModule]?) {
        guard modules != workModules else { return }
        workModules = modules
        guard let subject else { return }
        if hasCommercial(subject), commercialLoad == nil, !loaded.contains(.offers) { loadCommercial(for: subject) }
        render()
    }

    func clear() {
        cancelLoads()
        subject = nil
        selectedKey = nil
        goals = []
        decisions = []
        tasks = []
        issues = []
        documents = []
        interactions = []
        related = []
        contacts = []
        commercial = nil
        submission = nil
        loaded = []
        expanded = []
        errors = [:]
        render()
    }

    /// The inspector went back to the subject's metadata: no row is open.
    func clearSelection() {
        guard selectedKey != nil else { return }
        selectedKey = nil
        render()
    }

    private func select(_ key: String) {
        guard selectedKey != key else { return }
        selectedKey = key
        render()
    }

    private func cancelLoads() {
        goalsLoad?.cancel()
        decisionsLoad?.cancel()
        goalsLoad = nil
        decisionsLoad = nil
        tasksLoad?.cancel()
        issuesLoad?.cancel()
        documentsLoad?.cancel()
        historyLoad?.cancel()
        detailLoad?.cancel()
        submissionLoad?.cancel()
        submissionLoad = nil
        planLoad?.cancel()
        planLoad = nil
        tasksLoad = nil
        issuesLoad = nil
        documentsLoad = nil
        historyLoad = nil
        detailLoad = nil
        contactsLoad?.cancel()
        contactsLoad = nil
        commercialLoad?.cancel()
        commercialLoad = nil
    }

    private func isCurrent(_ subject: CrmSubject) -> Bool {
        self.subject?.kind == subject.kind && self.subject?.id == subject.id
    }

    private func loadTasks(for subject: CrmSubject) {
        let projectID = subject.kind == "project" ? subject.id : nil
        let leadID = subject.kind == "lead" ? subject.id : nil
        let eventID = subject.kind == "event" ? subject.id : nil
        let organizationID = subject.kind == "organization" ? subject.id : nil
        let key = MeetingControlAPI.tasksSnapshotKey(projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID)
        if let cached = api.snapshot(key, as: CrmTasksResponse.self) {
            tasks = cached.value.tasks
            render()
        }
        tasksLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await api.crmTasks(projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID)
                guard !Task.isCancelled, isCurrent(subject) else { return }
                tasks = result
                loaded.insert(.tasks)
                errors[.tasks] = nil
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                loaded.insert(.tasks)
                errors[.tasks] = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load tasks")
            }
            render()
        }
    }

    /// Every status: met and dropped fold under the open ones, so what the
    /// project settled on is one Show all away, not gone.
    func loadGoals(for subject: CrmSubject) {
        goalsLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await api.crmGoals(projectID: subject.id, includeClosed: true)
                guard !Task.isCancelled, isCurrent(subject) else { return }
                goals = result
                loaded.insert(.goals)
                errors[.goals] = nil
                onGoalsChanged?()
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                loaded.insert(.goals)
                errors[.goals] = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load goals")
            }
            render()
        }
    }

    func loadDecisions(for subject: CrmSubject) {
        decisionsLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await api.crmDecisions(subjectKind: subject.kind, subjectID: subject.id)
                guard !Task.isCancelled, isCurrent(subject) else { return }
                decisions = result
                loaded.insert(.decisions)
                errors[.decisions] = nil
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                loaded.insert(.decisions)
                errors[.decisions] = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load decisions")
            }
            render()
        }
    }

    /// No polling: the plan changes on web Admin, and the next project shown reads it again.
    /// A failed read draws nothing; the Worker still refuses the write.
    private func loadPlan(for subject: CrmSubject) {
        planLoad = Task { [weak self] in
            guard let self else { return }
            guard let result = try? await api.workspacePlan() else { return }
            guard !Task.isCancelled, isCurrent(subject) else { return }
            guard result != plan else { return }
            plan = result
            render()
        }
    }

    /// The live goals, for a picker: the task sheet, the decision sheet.
    var liveGoals: [CrmGoal] { GoalsDecisions.sorted(goals.filter(GoalsDecisions.isLive)) }

    private func loadIssues(for subject: CrmSubject) {
        issuesLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await api.crmIssues(projectID: subject.id)
                guard !Task.isCancelled, isCurrent(subject) else { return }
                issues = result.issues
                loaded.insert(.issues)
                errors[.issues] = nil
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                loaded.insert(.issues)
                errors[.issues] = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load issues")
            }
            render()
        }
    }

    private func loadDocuments(for subject: CrmSubject) {
        documentsLoad = Task { [weak self] in
            guard let self else { return }
            guard let about = subject.docsSubject else { return }
            do {
                let result = try await docs.client.documents(about: about, limit: 20)
                guard !Task.isCancelled, isCurrent(subject) else { return }
                documents = result
                loaded.insert(.documents)
                errors[.documents] = nil
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                loaded.insert(.documents)
                errors[.documents] = error.localizedDescription
            }
            render()
        }
    }

    private func loadHistory(for subject: CrmSubject) {
        let query = MeetingControlAPI.interactionsQuery(for: subject)
        historyLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await api.crmInteractions(
                    projectID: query.projectID,
                    leadID: query.leadID,
                    organizationID: query.organizationID
                )
                guard !Task.isCancelled, isCurrent(subject) else { return }
                interactions = result
                loaded.insert(.history)
                errors[.history] = nil
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                loaded.insert(.history)
                errors[.history] = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load history")
            }
            render()
        }
    }

    private func loadRelated(for subject: CrmSubject) {
        detailLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let detail = try await api.crmSubjectDetail(kind: subject.subjectKind, id: subject.id)
                guard !Task.isCancelled, isCurrent(subject) else { return }
                related = (detail.related?.projects ?? []).map {
                    CrmSubject(id: $0.id, kind: "project", title: $0.title ?? String(localized: "Untitled project"), subtitle: $0.status)
                } + (detail.related?.leads ?? []).map {
                    CrmSubject(id: $0.id, kind: "lead", title: $0.title ?? String(localized: "Untitled lead"), subtitle: $0.status)
                }
                loaded.insert(.related)
                errors[.related] = nil
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                loaded.insert(.related)
                errors[.related] = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load related subjects")
            }
            render()
        }
    }

    /// The registry draws Contacts on these kinds (`SubjectOverviewGroup.layout`).
    private func hasContacts(_ subject: CrmSubject) -> Bool {
        SubjectOverviewGroup.layout[subject.subjectKind]?.contains(.contacts) ?? false
    }

    /// An organization's contacts by its id; a project's or a lead's by the
    /// ids its record names.
    private func loadContacts(for subject: CrmSubject) {
        contactsLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let result: [CrmContact]
                if subject.subjectKind == .organization {
                    result = try await api.crmContacts(organizationID: subject.id)
                } else {
                    let detail = try await api.crmSubjectDetail(kind: subject.subjectKind, id: subject.id)
                    var ids: [String] = []
                    for id in [detail.contactID].compactMap({ $0 }) + (detail.contactIDs ?? []) where !id.isEmpty && !ids.contains(id) {
                        ids.append(id)
                    }
                    result = ids.isEmpty ? [] : try await api.crmContacts(ids: ids)
                }
                guard !Task.isCancelled, isCurrent(subject) else { return }
                contacts = result.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
                loaded.insert(.contacts)
                errors[.contacts] = nil
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                loaded.insert(.contacts)
                errors[.contacts] = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load contacts")
            }
            render()
        }
    }

    /// Offers or Licenses is drawn on this subject (`groups(for:)`).
    private func hasCommercial(_ subject: CrmSubject) -> Bool {
        groups(for: subject).contains { $0 == .offers || $0 == .licenses }
    }

    /// One read for both groups: they load, fail and retry together.
    private func loadCommercial(for subject: CrmSubject) {
        commercialLoad?.cancel()
        commercialLoad = Task { [weak self] in
            guard let self else { return }
            let error: String?
            do {
                let result = try await api.crmSubjectCommercial(kind: subject.subjectKind, id: subject.id)
                guard !Task.isCancelled, isCurrent(subject) else { return }
                commercial = result
                error = nil
                if showsPartnerDiscount(subject), result.offers != nil {
                    // The row stays away when this read fails; the Offers group still draws.
                    let discount = try? await api.organizationDiscount(id: subject.id)
                    guard !Task.isCancelled, isCurrent(subject) else { return }
                    partnerDiscount = discount
                } else {
                    partnerDiscount = nil
                }
            } catch let failure {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                error = (failure as? StarlingsError)?.message ?? String(localized: "Couldn’t load offers and licenses")
            }
            for group in [WorkSubjectOverviewGroup.offers, .licenses] {
                loaded.insert(group)
                errors[group] = error
            }
            commercialLoad = nil
            render()
        }
    }

    /// Partner discount sits on the organization, which needs the subjects group here too.
    private func showsPartnerDiscount(_ subject: CrmSubject) -> Bool {
        subject.kind == "organization" && OfferAvailability.isEditableHere
            && !(StarlingsWorkspace.active.services?.coreHolds(collection: "organizations") ?? true)
    }

    /// An offer changed in the editor, or a discount in its sheet: the group follows.
    func reloadCommercial() {
        guard let subject, hasCommercial(subject) else { return }
        loadCommercial(for: subject)
    }

    private func loadSubmission(for subject: CrmSubject) {
        submissionLoad = Task { [weak self] in
            guard let self else { return }
            do {
                let submission = try await api.leadSubmission(id: subject.id)
                guard !Task.isCancelled, isCurrent(subject) else { return }
                self.submission = submission
                errors[.submission] = nil
            } catch {
                guard !Task.isCancelled, isCurrent(subject) else { return }
                errors[.submission] = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load the answers")
            }
            loaded.insert(.submission)
            render()
        }
    }

    private func retry(_ group: WorkSubjectOverviewGroup) {
        guard let subject else { return }
        loaded.remove(group)
        errors[group] = nil
        render()
        switch group {
        case .goals: loadGoals(for: subject)
        case .decisions: loadDecisions(for: subject)
        case .tasks: loadTasks(for: subject)
        case .issues: loadIssues(for: subject)
        case .documents: loadDocuments(for: subject)
        case .history: loadHistory(for: subject)
        case .related: loadRelated(for: subject)
        case .contacts: loadContacts(for: subject)
        case .submission: loadSubmission(for: subject)
        case .offers, .licenses:
            loaded.subtract([.offers, .licenses])
            errors[.offers] = nil
            errors[.licenses] = nil
            render()
            loadCommercial(for: subject)
        }
    }

    /// The groups, their order and what each needs are the registry's
    /// (`SubjectOverviewGroup.layout`); this view draws them.
    private func groups(for subject: CrmSubject) -> [WorkSubjectOverviewGroup] {
        var has: Set<SubjectOverviewGroup.Need> = []
        if subject.hasRepo { has.insert(.repo) }
        if docs.isLinked && subject.docsSubject != nil { has.insert(.docs) }
        if workModules?.contains(.offers) ?? true { has.insert(.offers) }
        if workModules?.contains(.licenses) ?? true { has.insert(.licenses) }
        return SubjectOverviewGroup.groups(for: subject.subjectKind, has: has)
            .compactMap { WorkSubjectOverviewGroup(rawValue: $0.rawValue) }
    }

    private func render() {
        workStack.arrangedSubviews.forEach {
            workStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        guard let subject else { return }

        if subject.kind == "project", WorkspacePlanNotice.isFrozen(projectID: subject.id, plan: plan) {
            let isAdmin = isWorkspaceAdmin()
            let upgrade: (() -> Void)? = isAdmin ? { _ = NSWorkspace.shared.open(WorkspacePlanRules.upgradeURL) } : nil
            let notice = WorkSubjectOverviewMessageRow(
                message: WorkspacePlanNotice.frozenText(isAdmin: isAdmin),
                actionTitle: WorkspacePlanRules.upgradeText,
                retry: upgrade
            )
            notice.translatesAutoresizingMaskIntoConstraints = false
            workStack.addArrangedSubview(notice)
            let insets = workStack.edgeInsets
            notice.widthAnchor.constraint(equalTo: workStack.widthAnchor, constant: -(insets.left + insets.right)).isActive = true
        }

        for group in groups(for: subject) {
            let rows = rowData(for: group)
            let state = groupState(for: group)
            let canAdd = canAdd(group, to: subject)
            // A group that can take a new item keeps its header when empty;
            // the + is the only way to make the first one from here.
            // Contacts, Offers and Licenses keep their header when empty, with
            // a line that says so.
            let saysEmpty = emptyText(for: group) != nil
            guard canAdd || saysEmpty || state.loading || !rows.isEmpty || state.error != nil else { continue }
            // A nil list in the answer is a module the workspace has off.
            if group == .offers, !state.loading, state.error == nil, commercial?.offers == nil { continue }
            if group == .licenses, !state.loading, state.error == nil, commercial?.licenses == nil { continue }
            // Most leads have no answers: no placeholder while it is asked.
            if group == .submission, rows.isEmpty, state.error == nil { continue }
            // Most leads start no project and most projects have no lead.
            if group == .related, !subject.isPartner, rows.isEmpty, state.error == nil { continue }
            var controls: [NSView] = []
            // Contacts, Offers and Licenses have no page of their own: Show
            // all draws every one in place.
            let expandsInPlace = group == .contacts || group == .offers || group == .licenses
            let limit = expandsInPlace && expanded.contains(group) ? rows.count : 5
            if group == .tasks, subject.kind == "project" {
                controls.append(WorkSubjectOverviewLinkButton(
                    title: SubjectPane.board.title,
                    accessibilityLabel: String(localized: "Open the board"),
                    onPress: { [weak self] in self?.onShowBoard?() }
                ))
            }
            if rows.count > 5, SubjectOverviewGroup(rawValue: group.rawValue)?.showAll != nil {
                controls.append(showAllButton(for: group))
            } else if rows.count > 5, expandsInPlace, !expanded.contains(group) {
                controls.append(WorkSubjectOverviewLinkButton(
                    title: String(localized: "Show all"),
                    accessibilityLabel: String(localized: "Show all \(group.title.lowercased())"),
                    onPress: { [weak self] in
                        self?.expanded.insert(group)
                        self?.render()
                    }
                ))
            }
            if canAdd { controls.append(newButton(for: group)) }
            let accessory: NSView? = switch controls.count {
            case 0: nil
            case 1: controls[0]
            default: {
                let row = NSStackView(views: controls)
                row.orientation = .horizontal
                row.alignment = .centerY
                row.spacing = 4
                return row
            }()
            }
            let section = SidebarSection(
                title: group == .submission ? submission?.title.uppercased() ?? group.title : group.title(on: subject),
                key: foldKey(for: group, subject: subject),
                accessory: accessory,
                hidesWhenEmpty: false
            )
            let visible = Array(rows.prefix(limit))
            if visible.isEmpty, let error = state.error {
                section.setRows([messageRow(error, retry: { [weak self] in self?.retry(group) })], count: 0)
            } else if visible.isEmpty && state.loading {
                section.setRows(StarlingsPlaceholderRowView.rows(), count: 0)
            } else if visible.isEmpty, let empty = emptyText(for: group) {
                section.setRows([WorkSubjectOverviewMessageRow(message: empty, retry: nil)], count: 0)
            } else {
                var views = visible
                if let error = state.error {
                    views.append(messageRow(error, retry: { [weak self] in self?.retry(group) }))
                }
                let uncounted = group == .offers && partnerDiscount != nil ? 1 : 0
                section.setRows(views, count: group == .submission ? 0 : rows.count - uncounted)
            }
            section.translatesAutoresizingMaskIntoConstraints = false
            workStack.addArrangedSubview(section)
            // Inside the stack's side insets: pinned to its full width, a
            // section would run edge to edge and the insets would be ignored.
            let insets = workStack.edgeInsets
            section.widthAnchor.constraint(equalTo: workStack.widthAnchor, constant: -(insets.left + insets.right)).isActive = true
        }
    }

    /// The line an empty group draws; nil for a group that hides when empty.
    private func emptyText(for group: WorkSubjectOverviewGroup) -> String? {
        switch group {
        case .contacts: String(localized: "No contacts.")
        case .offers: String(localized: "No offers.")
        case .licenses: String(localized: "No licenses.")
        default: nil
        }
    }

    private func foldKey(for group: WorkSubjectOverviewGroup, subject: CrmSubject) -> String {
        "work.subject-overview.\(subject.kind).\(subject.id).\(group.rawValue)"
    }

    private struct GroupState {
        let loading: Bool
        let error: String?
    }

    private func groupState(for group: WorkSubjectOverviewGroup) -> GroupState {
        GroupState(loading: !loaded.contains(group), error: errors[group])
    }

    private func rowData(for group: WorkSubjectOverviewGroup) -> [NSView] {
        switch group {
        case .goals:
            return GoalsDecisions.sorted(goals).map { goal in
                let late = GoalsDecisions.isLate(goal)
                let date = CrmTaskDate.display(goal.targetDate).map { late ? String(localized: "Late, \($0)") : $0 }
                let status = goal.status == .open ? nil : goal.status.label
                let meta = [date, status, goal.ownerName].compactMap { $0 }.joined(separator: " · ")
                let key = "goal:\(goal.id)"
                return WorkSubjectOverviewRow(
                    symbol: goal.status == .met ? "checkmark.circle" : late ? "exclamationmark.circle" : "flag",
                    markShape: .square,
                    title: goal.title,
                    subtitle: meta,
                    isSelected: selectedKey == key,
                    onActivate: { [weak self] in self?.showGoalMenu(goal) }
                )
            }
        case .decisions:
            return decisions.map { decision in
                let day = CrmTaskDate.display(decision.decidedAt)
                let via = decision.source == .agent ? decision.sourceRef.map { String(localized: "via \($0)") } : nil
                let goal = decision.goalID.flatMap { id in goals.first { $0.id == id }?.title }
                let meta = [day, decision.decidedByName, via, goal].compactMap { $0 }.joined(separator: " · ")
                return WorkSubjectOverviewRow(
                    symbol: "checkmark.seal",
                    markShape: .square,
                    title: decision.body,
                    subtitle: meta,
                    isSelected: false,
                    onActivate: {}
                )
            }
        case .tasks:
            return tasks
                .sorted { left, right in
                    if left.isOverdue != right.isOverdue { return left.isOverdue }
                    let leftDate = CrmTaskDate.date(left.dueDate) ?? .distantFuture
                    let rightDate = CrmTaskDate.date(right.dueDate) ?? .distantFuture
                    if leftDate != rightDate { return leftDate < rightDate }
                    return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
                }
                .map { task in
                    let due = CrmTaskDate.display(task.dueDate).map { String(localized: "Due \($0)") }
                    let meta = [task.status.menuTitle, due, task.assigneeName].compactMap { $0 }.joined(separator: " · ")
                    let key = "task:\(task.id)"
                    return WorkSubjectOverviewRow(
                        symbol: task.isOverdue ? "exclamationmark.circle" : "checkmark",
                        markShape: .square,
                        title: task.title,
                        subtitle: meta,
                        isSelected: selectedKey == key,
                        menuActions: subject.map { task.status.isProposed ? task.proposedRowActions(subject: $0) : task.rowActions(subject: $0, agents: agents) } ?? [],
                        favoriteTarget: FavoriteTarget(kind: .crmTask, targetRef: task.id.lowercased()),
                        favorites: favorites,
                        onMenuAction: { [weak self] action in self?.onRowAction?(action) },
                        onActivate: { [weak self] in
                            self?.select(key)
                            self?.onOpenTask?(task)
                        }
                    )
                }
        case .issues:
            return issues.map { issue in
                let key = "issue:\(issue.id)"
                return WorkSubjectOverviewRow(
                    symbol: issue.isOpen ? "circle" : "checkmark.circle",
                    markShape: .square,
                    title: issue.title,
                    subtitle: "\(issue.repo) \(issue.shortReference) · \(issue.stateSummary)",
                    isSelected: selectedKey == key,
                    menuActions: [issue.stateActions(projectID: subject?.kind == "project" ? subject?.id : nil)],
                    favoriteTarget: FavoriteTarget(
                        kind: .githubIssue,
                        targetRef: "\(issue.owner.lowercased())/\(issue.repo.lowercased())#\(issue.number)"
                    ),
                    favorites: favorites,
                    onMenuAction: { [weak self] action in self?.onRowAction?(action) },
                    onActivate: { [weak self] in
                        self?.select(key)
                        self?.onOpenIssue?(issue)
                    }
                )
            }
        case .documents:
            return documents.map { document in
                let key = "document:\(document.id)"
                return WorkSubjectOverviewRow(
                    symbol: document.kind == "pdf" ? "doc.richtext" : "doc.text",
                    title: document.title,
                    subtitle: document.path,
                    isSelected: selectedKey == key,
                    favoriteTarget: FavoriteTarget(kind: .docsDocument, targetRef: document.id.lowercased()),
                    favorites: favorites,
                    onActivate: { [weak self] in
                        self?.select(key)
                        self?.onOpenDocument?(document.id, document.title)
                    }
                )
            }
        case .history:
            return interactions.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }.map { interaction in
                let key = "interaction:\(interaction.id)"
                return WorkSubjectOverviewRow(
                    symbol: interaction.symbolName,
                    title: interaction.displayTitle,
                    subtitle: interaction.metadataLabel,
                    isSelected: selectedKey == key,
                    onActivate: { [weak self] in
                        self?.select(key)
                        self?.onOpenInteraction?(interaction)
                    }
                )
            }
        case .submission:
            return submission.map { [WorkSubmissionAnswersView(submission: $0)] } ?? []
        case .contacts:
            // An organization's contacts all work there: the row says only what they do.
            let showsOrganization = subject?.subjectKind != .organization
            return contacts.map { contact in
                let key = "contact:\(contact.id)"
                let subtitle = [contact.title, showsOrganization ? contact.organizationName : nil]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .joined(separator: " · ")
                return WorkSubjectOverviewRow(
                    symbol: "person",
                    title: contact.displayName,
                    subtitle: subtitle,
                    isSelected: selectedKey == key,
                    onActivate: { [weak self] in
                        self?.select(key)
                        self?.onOpenContact?(contact.id, contact.displayName)
                    }
                )
            }
        case .offers:
            var rows: [NSView] = []
            if let partnerDiscount, let subject {
                rows.append(WorkSubjectOverviewRow(
                    symbol: "percent",
                    markShape: .square,
                    title: String(localized: "Partner discount"),
                    subtitle: partnerDiscount.defaultDiscountPercentage.map { "\($0.formatted())%" } ?? String(localized: "None"),
                    isSelected: false,
                    onActivate: { [weak self] in self?.onEditPartnerDiscount?(subject, partnerDiscount) }
                ))
            }
            return rows + (commercial?.offers ?? []).map { offer in
                WorkSubjectOverviewRow(
                    symbol: "doc.plaintext",
                    markShape: .square,
                    title: SubjectCommercial.offerTitle(offer),
                    subtitle: SubjectCommercial.offerSubtitle(offer, day: CrmTaskDate.display),
                    isSelected: false,
                    onActivate: { [weak self] in
                        guard OfferAvailability.isEditableHere else { return }
                        self?.onOpenOffer?(offer.id)
                    }
                )
            }
        case .licenses:
            return (commercial?.licenses ?? []).map { license in
                WorkSubjectOverviewRow(
                    symbol: "key",
                    markShape: .square,
                    title: SubjectCommercial.licenseTitle(license),
                    subtitle: SubjectCommercial.licenseSubtitle(license, day: CrmTaskDate.display),
                    // Due for renewal: neutral ink, bold (docs/DESIGN.md, colour budget).
                    subtitleEmphasis: SubjectCommercial.renewsSoon(license),
                    isSelected: false,
                    onActivate: { [weak self] in
                        guard OfferAvailability.isEditableHere else { return }
                        self?.onOpenLicense?(license)
                    }
                )
            }
        case .related:
            return related.map { subject in
                return WorkSubjectOverviewRow(
                    symbol: "arrow.triangle.branch",
                    title: subject.title,
                    subtitle: subject.subtitle,
                    isSelected: false,
                    onActivate: { [weak self] in self?.onOpenSubject?(subject) }
                )
            }
        }
    }

    /// Tasks go on a project, lead, event or partner; issues on a project with a
    /// repository. Documents, History and Related are made elsewhere.
    private func canAdd(_ group: WorkSubjectOverviewGroup, to subject: CrmSubject) -> Bool {
        switch group {
        case .goals: subject.kind == "project"
        case .decisions: true
        case .tasks: true
        case .issues: subject.kind == "project" && subject.hasRepo
        case .offers, .licenses: OfferAvailability.isEditableHere
        case .documents, .history, .related, .contacts, .submission: false
        }
    }

    private func newButton(for group: WorkSubjectOverviewGroup) -> NSButton {
        let button = NSButton(
            image: NSImage(systemSymbolName: "plus", accessibilityDescription: nil) ?? NSImage(),
            target: self,
            action: #selector(newPressed(_:))
        )
        button.tag = WorkSubjectOverviewGroup.allCases.firstIndex(of: group) ?? 0
        button.bezelStyle = .inline
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.contentTintColor = StarlingsColors.secondaryText
        button.toolTip = switch group {
        case .goals: String(localized: "New Goal")
        case .decisions: String(localized: "Record Decision")
        case .issues: String(localized: "New Issue")
        case .offers: String(localized: "New offer")
        case .licenses: String(localized: "New license")
        default: String(localized: "New Task")
        }
        button.setAccessibilityLabel(button.toolTip ?? "")
        SettingsChrome.applyQuietButton(button)
        return button
    }

    @objc private func newPressed(_ sender: NSButton) {
        let groups = WorkSubjectOverviewGroup.allCases
        guard groups.indices.contains(sender.tag) else { return }
        onNew?(groups[sender.tag])
    }

    /// A goal has no page to open; activating its row offers the one thing
    /// to do with it — settle its status.
    private func showGoalMenu(_ goal: CrmGoal) {
        let menu = NSMenu()
        let items: [(String, GoalStatus, MenuSymbol)] = goal.status == .open
            ? [(String(localized: "Met"), .met, WorkRowActionID.met.menuSymbol), (String(localized: "Drop"), .dropped, WorkRowActionID.drop.menuSymbol)]
            : [(String(localized: "Reopen"), .open, WorkRowActionID.reopen.menuSymbol)]
        for (title, status, symbol) in items {
            let item = NSMenuItem(title: title, action: #selector(goalMenuPressed(_:)), keyEquivalent: "").symbol(symbol)
            item.target = self
            item.representedObject = GoalStatusChange(goal: goal, status: status)
            menu.addItem(item)
        }
        let point = window.map { convert($0.mouseLocationOutsideOfEventStream, from: nil) } ?? .zero
        menu.popUp(positioning: nil, at: point, in: self)
    }

    private final class GoalStatusChange: NSObject {
        let goal: CrmGoal
        let status: GoalStatus
        init(goal: CrmGoal, status: GoalStatus) { self.goal = goal; self.status = status }
    }

    @objc private func goalMenuPressed(_ sender: NSMenuItem) {
        guard let change = sender.representedObject as? GoalStatusChange else { return }
        onSetGoalStatus?(change.goal, change.status)
    }

    private func showAllButton(for group: WorkSubjectOverviewGroup) -> NSButton {
        WorkSubjectOverviewLinkButton(
            title: String(localized: "Show all"),
            accessibilityLabel: String(localized: "Show all \(group.title.lowercased())"),
            onPress: { [weak self] in self?.onShowAll?(group) }
        )
    }

    /// A group's failed read: red, with Copy and Retry.
    private func messageRow(_ message: String, retry: (() -> Void)?) -> NSView {
        WorkSubjectOverviewErrorRow(message: message, retry: retry)
    }
}

/// A quiet text button on a group header: Show all, or Board.
@MainActor
private final class WorkSubjectOverviewLinkButton: NSButton {
    private let onPress: () -> Void

    init(title: String, accessibilityLabel: String, onPress: @escaping () -> Void) {
        self.onPress = onPress
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .inline
        isBordered = false
        font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        contentTintColor = StarlingsColors.secondaryText
        setAccessibilityLabel(accessibilityLabel)
        target = self
        action = #selector(pressed)
        SettingsChrome.applyQuietButton(self)
    }

    @objc private func pressed() { onPress() }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

@MainActor
private final class WorkSubjectOverviewMessageRow: WorkListRowView {
    private let retry: (() -> Void)?

    /// `actionTitle` names the button; Retry unless the row says otherwise.
    init(message: String, actionTitle: String = String(localized: "Retry"), retry: (() -> Void)?) {
        self.retry = retry
        let label = NSTextField(labelWithString: message)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        label.textColor = StarlingsColors.secondaryText
        label.maximumNumberOfLines = 2
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let content: NSView
        if retry != nil {
            let button = NSButton(title: actionTitle, target: nil, action: nil)
            SettingsChrome.applyQuietButton(button)
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
            let row = NSStackView(views: [label, button])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 8
            row.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            button.target = nil
            content = row
            super.init(content: content, isSelected: false, accessibilityLabel: message, onActivate: {})
            button.target = self
            button.action = #selector(retryPressed)
            return
        }
        content = label
        super.init(content: content, isSelected: false, accessibilityLabel: message, onActivate: {})
    }

    @objc private func retryPressed() { retry?() }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// A failed read in a group, as every Mac error reads: `StarlingsNoticeView`
/// in the danger tone, with Copy, and Retry when the read can be asked again.
@MainActor
private final class WorkSubjectOverviewErrorRow: WorkListRowView {
    private let retry: (() -> Void)?

    init(message: String, retry: (() -> Void)?) {
        self.retry = retry
        let notice = StarlingsNoticeView()
        notice.label.maximumNumberOfLines = 2
        notice.label.lineBreakMode = .byTruncatingTail
        notice.label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        notice.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        notice.showError(message)
        super.init(content: notice, isSelected: false, accessibilityLabel: message, onActivate: {})
        if retry != nil { notice.addRetry(target: self, action: #selector(retryPressed)) }
    }

    @objc private func retryPressed() { retry?() }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

@MainActor
private final class WorkSubjectOverviewRow: WorkListRowView {
    /// The row's right-click (`NSMenu.workRow`); empty for rows without one.
    private let menuActions: [[WorkRowAction]]
    private let onMenuAction: (WorkRowAction) -> Void
    private let favoriteTarget: FavoriteTarget?
    private let favorites: StarredWatch?

    init(
        symbol: String,
        markShape: WorkGlyphMarkShape = .round,
        title: String,
        subtitle: String?,
        subtitleEmphasis: Bool = false,
        isSelected: Bool,
        menuActions: [[WorkRowAction]] = [],
        favoriteTarget: FavoriteTarget? = nil,
        favorites: StarredWatch? = nil,
        onMenuAction: @escaping (WorkRowAction) -> Void = { _ in },
        onActivate: @escaping () -> Void
    ) {
        self.menuActions = menuActions
        self.onMenuAction = onMenuAction
        self.favoriteTarget = favoriteTarget
        self.favorites = favorites
        let image: NSView
        switch markShape {
        case .round:
            let imageView = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil) ?? NSImage())
            imageView.symbolConfiguration = .init(pointSize: 12, weight: .medium)
            imageView.contentTintColor = StarlingsColors.secondaryText
            image = imageView
        case .square:
            let mark = WorkGlyphMarkView(
                diameter: WorkListRowView.leadingSlot,
                content: .symbol(symbol),
                accessibilityLabel: "",
                shape: .square
            )
            mark.setAccessibilityElement(false)
            image = mark
        }
        image.setContentHuggingPriority(.required, for: .horizontal)

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = WorkListRowView.titleFont()
        titleLabel.textColor = StarlingsColors.primaryText
        titleLabel.maximumNumberOfLines = 1
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let text = NSStackView(views: [titleLabel])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = WorkListRowView.textSpacing
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if let subtitle, !subtitle.isEmpty {
            let detail = NSTextField(labelWithString: subtitle)
            detail.font = WorkListRowView.detailFont(bold: subtitleEmphasis)
            detail.textColor = subtitleEmphasis ? StarlingsColors.primaryText : StarlingsColors.secondaryText
            detail.maximumNumberOfLines = 1
            detail.lineBreakMode = .byTruncatingTail
            detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            text.addArrangedSubview(detail)
        }
        let content = WorkListRowView.content(leading: image, text: text)
        content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        super.init(content: content, isSelected: isSelected, accessibilityLabel: title, onActivate: onActivate)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu.workRow(menuActions, perform: onMenuAction) ?? NSMenu()
        if let favoriteTarget, let favorites {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            menu.addFavoriteAction(favoriteTarget, watch: favorites, window: window)
        }
        return menu.items.isEmpty ? nil : menu
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// A lead's form answers as one block of text (docs/FORMS.md): the date it
/// came in, then each section's questions with the answers under them. One
/// view, not a row per answer, so the Overview's five-row preview does not
/// cut the answers short. The text is selectable, to copy a quote out.
@MainActor
final class WorkSubmissionAnswersView: NSView {
    private let label = NSTextField(wrappingLabelWithString: "")

    init(submission: FormSubmission) {
        super.init(frame: .zero)
        label.attributedStringValue = Self.text(submission)
        label.isSelectable = true
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
        setAccessibilityElement(false)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        let width = max(0, bounds.width - 18)
        if label.preferredMaxLayoutWidth != width {
            label.preferredMaxLayoutWidth = width
            label.invalidateIntrinsicContentSize()
        }
    }

    private static func text(_ submission: FormSubmission) -> NSAttributedString {
        let text = NSMutableAttributedString()
        let small = NSFont.systemFont(ofSize: StarlingsTypography.scaled(11))
        let heading = NSFont.systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        let body = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))
        func add(_ string: String, font: NSFont, color: NSColor, after spacing: CGFloat) {
            let paragraph = NSMutableParagraphStyle()
            paragraph.paragraphSpacing = spacing
            text.append(NSAttributedString(string: string + "\n", attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]))
        }
        let day = CrmTaskDate.display(String(submission.submittedAt.prefix(10))) ?? String(submission.submittedAt.prefix(10))
        add(String(localized: "Sent \(day)"), font: small, color: StarlingsColors.secondaryText, after: 10)
        for section in submission.sections {
            add(section.title, font: heading, color: StarlingsColors.secondaryText, after: 4)
            for (index, item) in section.answers.enumerated() {
                add(item.question, font: small, color: StarlingsColors.secondaryText, after: 1)
                add(item.answer, font: body, color: StarlingsColors.primaryText, after: index == section.answers.count - 1 ? 12 : 6)
            }
        }
        if text.length > 0 { text.deleteCharacters(in: NSRange(location: text.length - 1, length: 1)) }
        return text
    }
}
