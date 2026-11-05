import Foundation

// The Work surface, as something any other surface can point at. Shared by the
// Mac and the iOS app so Home, the menu bar, a notification, or a filed
// meeting name the same place on both. See docs/WORK.md.

/// Which view of a subject Work opens on. Overview is the landing state; the
/// remaining values are the dedicated panes behind its contextual groups.
enum WorkPane: String, Hashable, Sendable {
    case overview
    case talk
    case tasks
    case issues
    case interactions
}

/// A creation shortcut carried with a Work destination. The subject remains
/// the destination; the action only tells its detail view which editor to
/// present on arrival.
enum WorkAction: String, Hashable, Sendable {
    case newTask
    case newIssue
    /// A new document about the subject; the Documents pane asks for its title.
    case newDocument
}

/// Status choices shared by the native Work sidebars. The ids and their order come from
/// the one table every client reads (`SubjectStatusRegistry`); this adds the
/// words people read. `open` is deliberately a product filter rather than a Core status:
/// it keeps the default project view useful while still making Archived an explicit choice.
struct CrmSubjectStatusOption: Hashable, Identifiable, Sendable {
    let id: String
    let title: String

    /// Browse's filter for projects and for leads.
    static let project: [CrmSubjectStatusOption] = SubjectStatusRegistry.project.filter.map(option)
    static let lead: [CrmSubjectStatusOption] = SubjectStatusRegistry.lead.filter.map(option)
    /// A prospect for Signals is a lead with that source: one more choice on Browse's Leads filter.
    static let signalsLeads = CrmSubjectStatusOption(id: "source:signals", title: String(localized: "Signals"))
    static let leadFilter: [CrmSubjectStatusOption] = lead + [signalsLeads]

    /// Core's own words only, for an editor's dropdown.
    static func editable(for kind: MeetingCategoryKind.SubjectKind) -> [CrmSubjectStatusOption] {
        (SubjectStatusRegistry.choices(for: kind)?.statuses ?? []).map(option)
    }

    static func options(for kind: MeetingCategoryKind.SubjectKind) -> [CrmSubjectStatusOption] {
        kind == .project ? project : lead
    }

    private static func option(_ id: String) -> CrmSubjectStatusOption {
        .init(id: id, title: title(for: id))
    }

    /// The word on screen; a status stays English on the wire. An unknown id reads as itself.
    static func title(for id: String) -> String {
        switch id {
        case "open": String(localized: "Open")
        case "all": String(localized: "All")
        case "Active": String(localized: "Active")
        case "Paused": String(localized: "Paused")
        case "Archived": String(localized: "Archived")
        case "Conversations": String(localized: "Conversations")
        case "Opportunity Identified": String(localized: "Opportunity Identified")
        case "Proposal Out": String(localized: "Proposal Out")
        case "Active Negotiation": String(localized: "Active Negotiation")
        case "Waiting on External Factor": String(localized: "Waiting on External Factor")
        case "Closed Won": String(localized: "Closed Won")
        case "Closed Lost": String(localized: "Closed Lost")
        default: id
        }
    }
}

/// The number behind one status option. `hasMore` is a lower bound from a
/// page that was cut at Core's cap; `GET /api/crm/subject-counts` counts
/// rows, not pages, so from there it is always false.
struct CrmSubjectStatusCount: Equatable, Sendable {
    let count: Int
    let hasMore: Bool

    var displayText: String { "\(count)\(hasMore ? "+" : "")" }
}

/// `GET /api/crm/subject-counts?kind&q` — every status badge for one kind
/// in one answer (`CrmSubjectCountsResponse` in packages/contracts, docs/WORK.md).
/// Keys are Core's statuses plus `all` and `open`; a status with no rows is
/// absent, which is zero once the answer arrived. Projects come split by
/// Core's `is_internal` flag into `internal` and `client`.
struct CrmSubjectCountsResponse: Decodable, Sendable {
    let counts: [String: Int]
    let internalCounts: [String: Int]?
    let client: [String: Int]?

    enum CodingKeys: String, CodingKey {
        case counts, client
        case internalCounts = "internal"
    }

    /// One badge per option the sidebar offers, from one bucket.
    static func badges(
        _ bucket: [String: Int],
        for kind: MeetingCategoryKind.SubjectKind
    ) -> [String: CrmSubjectStatusCount] {
        var badges: [String: CrmSubjectStatusCount] = [:]
        for option in CrmSubjectStatusOption.options(for: kind) {
            badges[option.id] = CrmSubjectStatusCount(count: bucket[option.id] ?? 0, hasMore: false)
        }
        return badges
    }

    /// Sales: the whole kind.
    var leadBadges: [String: CrmSubjectStatusCount] { Self.badges(counts, for: .lead) }
    /// The workspace's own projects: Core's `is_internal` rows.
    var internalBadges: [String: CrmSubjectStatusCount] { Self.badges(internalCounts ?? [:], for: .project) }
    /// Client Projects: the rest.
    var clientBadges: [String: CrmSubjectStatusCount] { Self.badges(client ?? [:], for: .project) }
}

/// How a Work sidebar list orders its subjects — independent of
/// `CrmSubjectStatusOption`, which decides *which* subjects show at all.
struct CrmSubjectSortOption: Hashable, Identifiable, Sendable {
    let id: String
    let title: String

    /// Overdue first, then open count, then title. The closest honest proxy
    /// for "needs attention" the list payload supports — it carries no
    /// `updated_at`, so true recency isn't available without a Core change.
    static let busiest = CrmSubjectSortOption(id: "busiest", title: String(localized: "Busiest First"))
    static let alphabetical = CrmSubjectSortOption(id: "alphabetical", title: String(localized: "Alphabetical"))
    static let all: [CrmSubjectSortOption] = [.busiest, .alphabetical]
}

extension Array where Element == CrmSubject {
    /// The rail's order ( slice 3c): what moved last, first. A row
    /// with no activity known sorts after every row with one, in the
    /// busiest order — the fallback until Core sends its own timestamp.
    func sortedByActivity(now: Date = Date()) -> [CrmSubject] {
        WorkList.ordered(self, sort: .activity, now: now)
    }

    /// `optionID` is `CrmSubjectSortOption.id`; anything unrecognized falls
    /// back to `.busiest` rather than leaving the list in server order.
    func sorted(bySidebarOption optionID: String) -> [CrmSubject] {
        switch optionID {
        case CrmSubjectSortOption.alphabetical.id:
            return sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        default:
            return sorted { a, b in
                if a.overdueTasks != b.overdueTasks { return a.overdueTasks > b.overdueTasks }
                if a.openTasks != b.openTasks { return a.openTasks > b.openTasks }
                return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
        }
    }
}

/// A place in Work: a project or lead and the pane to land on, or Mine. This
/// is what a row on Home hands over — the subject is the object, the pane is
/// the reason somebody tapped.
///
/// Mine is a target here rather than a surface of its own on purpose: it is
/// the same tasks and issues on your axis instead of the subject's, and a
/// slicing difference is not a new destination. It is the only place a task
/// Core kept without a subject can be read. See docs/WORK.md §5c.
struct WorkDestination: Hashable, Sendable {
    enum Target: Hashable, Sendable {
        /// Your own list. A task id lands on that row; nil only opens the list.
        case mine(taskID: String?)
        case subject(CrmSubject)
        /// One GitHub issue, read in the app's own issue view rather than on
        /// github.com (#225). Loaded on arrival: a search row carries the
        /// reference, not the row.
        case issue(owner: String, repo: String, number: Int)
        /// One Core entity (Contacts, Organizations…) by contract id, read in
        /// Work's Core view (#222). Resolved on arrival against the linked
        /// registry: a search row carries the id, not the contract.
        case coreEntity(id: String)
        /// A person outside the workspace, by contact id: their
        /// page. A search row and an organization's page carry the id; an
        /// event's guest row also carries the name.
        case contact(id: String, name: String?)
    }

    let target: Target
    var pane: WorkPane = .overview
    var action: WorkAction? = nil

    init(subject: CrmSubject, pane: WorkPane = .overview, action: WorkAction? = nil) {
        self.target = .subject(subject)
        self.pane = pane
        self.action = action
    }

    private init(target: Target, pane: WorkPane, action: WorkAction?) {
        self.target = target
        self.pane = pane
        self.action = action
    }

    /// Work, on Mine — optionally reading one of your rows.
    static func mine(taskID: String? = nil) -> WorkDestination {
        WorkDestination(target: .mine(taskID: taskID), pane: .tasks, action: nil)
    }

    /// Work, reading one Core entity — the id a search row carries.
    static func coreEntity(id: String) -> WorkDestination {
        WorkDestination(target: .coreEntity(id: id), pane: .tasks, action: nil)
    }

    /// Work, reading one contact's page. `name` titles the page while it loads.
    static func contact(id: String, name: String? = nil) -> WorkDestination {
        WorkDestination(target: .contact(id: id, name: name), pane: .overview, action: nil)
    }

    /// Work, reading one issue named `owner/repo#n` — the id a search row and
    /// a thread ref carry. Nil when the reference does not parse, and the
    /// caller falls back to github.com.
    static func issue(reference: String) -> WorkDestination? {
        let parts = reference.split(separator: "#", maxSplits: 1)
        guard parts.count == 2, let number = Int(parts[1]), number > 0 else { return nil }
        let slug = parts[0].split(separator: "/", maxSplits: 1)
        guard slug.count == 2, !slug[0].isEmpty, !slug[1].isEmpty else { return nil }
        return WorkDestination(
            target: .issue(owner: String(slug[0]), repo: String(slug[1]), number: number),
            pane: .issues,
            action: nil
        )
    }

    /// The subject this destination names, where it names one. Mine answers
    /// nil, because a list across every subject belongs to none of them.
    var subject: CrmSubject? {
        if case .subject(let subject) = target { return subject }
        return nil
    }
}

extension CrmSubject {
    /// Canonical Core pages. Native clients link here instead of recreating a
    /// CRM detail route, so web and app links always open the same record.
    var coreURL: URL? {
        // A partner *is* an organization (PARTNERS (HQ Docs)) and an event is a
        // CMS row (docs/EVENTS.md): `CORE_SUBJECT_COLLECTIONS`, generated.
        EnvisioningDeployment.coreDashboardURL(collection: subjectKind.coreCollection, id: id)
    }

    /// The kind a meeting is filed under when it is about this subject.
    var meetingKind: MeetingCategoryKind {
        MeetingCategoryKind.allCases.first { $0.subjectKind?.rawValue == kind } ?? .project
    }

    /// The filing a meeting about this subject writes — the same body the CRM
    /// sidebar and the phone's filing sheet send, so a room opened from Work
    /// is filed exactly as one filed by hand.
    var meetingFiling: MeetingCategoryUpdate {
        MeetingCategoryUpdate(meetingKind: meetingKind, subjectID: id, subjectTitle: title)
    }

    /// The workspace's own projects. Core's `is_internal` flag decides
    /// ( decision 2); the "Envisioning " title prefix is
    /// only the fallback for a row from Envisioning's Core that has not sent
    /// the flag yet. The rule itself is `SubjectState.group`, pinned by
    /// `fixtures/subject-state.json`; this is that rule's answer, not a
    /// second copy of it.
    var isInternalProject: Bool { group == .envisioning }

    /// The title as shown in the sidebar. Inside its own section, titled
    /// with the workspace's name, a leading "<name> " is redundant, so it's
    /// dropped for display only — `title` itself (and everything
    /// derived from it, like `meetingFiling`) still carries the full CRM
    /// name. An internal project titled without the prefix keeps its title
    /// whole.
    var displayTitle: String {
        let prefix = "\(StarlingsWorkspace.active.projectGroupName) "
        guard isInternalProject, title.hasPrefix(prefix) else { return title }
        return String(title.dropFirst(prefix.count))
    }
}

extension CrmMyTask {
    /// What Mine knows about this task, in the shape the detail view reads.
    /// Mine carries no notes, assignee or tags, so those stay absent rather
    /// than being invented — the full record from Core replaces this the
    /// moment it lands.
    var partialTask: CrmTask {
        CrmTask(
            id: id,
            title: title,
            status: status,
            priority: priority,
            githubOwner: githubOwner,
            githubRepo: githubRepo,
            githubIssueNumber: githubIssueNumber,
            dueDate: dueDate,
            projectID: projectID,
            leadID: leadID,
            eventID: eventID,
            organizationID: organizationID,
            meetingID: meetingID
        )
    }
}

// MARK: - Automatic subject ranking

struct WorkRankSignals: Sendable {
    var starred = false
    var directAttention = false
    var unread = false
}

/// The weights of the SUBJECTS score. `default` is generated from
/// `packages/contracts/src/work-ranker.ts` (Sources/Generated/WorkRankerRegistry.swift).
struct WorkRankCriteria: Sendable {
    var railLimit: Int
    var starred: Double
    var directAttention: Double
    var unread: Double
    var overduePerTask: Double
    var overdueCap: Int
    var eventToday: Double
    var eventSoonBase: Double
    var eventSoonDecayPerDay: Double
    var eventHorizonDays: Int
    var openWorkPerTask: Double
    var openWorkCap: Int
    var recentActivityMax: Double
    var activityHalfLife: TimeInterval
    var staleAfter: TimeInterval
    var staleWork: Double
}

enum WorkRankReasonCode: String, Sendable {
    case starred
    case directAttention = "direct_attention"
    case unread
    case overdue
    case eventToday = "event_today"
    case eventSoon = "event_soon"
    case openWork = "open_work"
    case recentActivity = "recent_activity"
    case staleWork = "stale_work"
}

struct WorkRankReason: Equatable, Sendable {
    let code: WorkRankReasonCode
    let points: Double
}

struct RankedWorkSubject: Equatable, Sendable {
    let subject: CrmSubject
    let score: Double
    let reasons: [WorkRankReason]
}

/// A bounded, explainable, wall-like order. Browse remains the full directory.
enum WorkSubjectRanker {
    private static let day: TimeInterval = 24 * 60 * 60

    static func rank(_ subjects: [CrmSubject], signals: [String: WorkRankSignals] = [:], now: Date = Date(), criteria: WorkRankCriteria = .default) -> [RankedWorkSubject] {
        subjects.map { rankOne($0, signal: signals[$0.id] ?? WorkRankSignals(), now: now, criteria: criteria) }
            .sorted { left, right in
                if left.score != right.score { return left.score > right.score }
                let leftActivity = parseISO(left.subject.lastActivityAt) ?? .distantPast
                let rightActivity = parseISO(right.subject.lastActivityAt) ?? .distantPast
                if leftActivity != rightActivity { return leftActivity > rightActivity }
                let title = left.subject.title.localizedCaseInsensitiveCompare(right.subject.title)
                return title == .orderedSame ? left.subject.id < right.subject.id : title == .orderedAscending
            }
    }

    /// `holding` keeps the open subject at the index it had in `previous`,
    /// the last order drawn. Opening a subject reads it, and reading clears
    /// its unread signal: ranked as-is, the row would slide away from the
    /// click that picked it. Mirrors `holdWorkRankPlace` in
    /// `packages/contracts/src/work-ranker.ts`.
    static func rail(_ subjects: [CrmSubject], signals: [String: WorkRankSignals] = [:], now: Date = Date(), criteria: WorkRankCriteria = .default, holding heldID: String? = nil, previous: [String] = []) -> [RankedWorkSubject] {
        var ranked = rank(subjects, signals: signals, now: now, criteria: criteria)
        if let heldID,
           let from = ranked.firstIndex(where: { $0.subject.id == heldID }),
           let was = previous.firstIndex(of: heldID),
           from != was {
            let held = ranked.remove(at: from)
            ranked.insert(held, at: min(was, ranked.count))
        }
        return Array(ranked.prefix(max(0, criteria.railLimit)))
    }

    private static func rankOne(_ subject: CrmSubject, signal: WorkRankSignals, now: Date, criteria: WorkRankCriteria) -> RankedWorkSubject {
        var reasons: [WorkRankReason] = []
        var score = 0.0
        func add(_ code: WorkRankReasonCode, _ points: Double) {
            guard points > 0 else { return }
            score += points
            reasons.append(WorkRankReason(code: code, points: points))
        }
        if signal.starred { add(.starred, criteria.starred) }
        if signal.directAttention { add(.directAttention, criteria.directAttention) }
        if signal.unread { add(.unread, criteria.unread) }
        add(.overdue, Double(min(max(0, subject.overdueTasks), criteria.overdueCap)) * criteria.overduePerTask)
        if subject.kind == "event", let event = eventDay(subject.eventDate) {
            let today = utcCalendar.startOfDay(for: now)
            let daysUntil = utcCalendar.dateComponents([.day], from: today, to: event).day ?? 0
            if daysUntil == 0 { add(.eventToday, criteria.eventToday) }
            else if daysUntil > 0, daysUntil <= criteria.eventHorizonDays {
                add(.eventSoon, max(0, criteria.eventSoonBase - Double(daysUntil - 1) * criteria.eventSoonDecayPerDay))
            }
        }
        add(.openWork, Double(min(max(0, subject.openTasks), criteria.openWorkCap)) * criteria.openWorkPerTask)
        if let activity = parseISO(subject.lastActivityAt) {
            let age = max(0, now.timeIntervalSince(activity))
            add(.recentActivity, criteria.recentActivityMax * pow(0.5, age / criteria.activityHalfLife))
            if subject.openTasks > 0, age >= criteria.staleAfter { add(.staleWork, criteria.staleWork) }
        }
        return RankedWorkSubject(subject: subject, score: score, reasons: reasons)
    }

    private static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }()

    /// The Worker writes `toISOString()`, which carries milliseconds. A bare `ISO8601DateFormatter`
    /// rejects those, which once made every subject's activity count as none.
    private static func parseISO(_ value: String?) -> Date? {
        guard let value else { return nil }
        return ISODate.parse(value)
    }

    private static func eventDay(_ value: String?) -> Date? {
        guard let value, value.count >= 10 else { return nil }
        let parts = value.prefix(10).split(separator: "-")
        guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
        return utcCalendar.date(from: DateComponents(year: year, month: month, day: day))
    }
}

/// Home's Mine card (docs/WORK.md §1): all of Mine, in Mine's order, planned
/// on the device that knows what day it is. The card draws the first rows and
/// a count of the rest.
struct HomeMine: Equatable {
    let rows: [PlannedWorkItem]
    /// Each row's due date against today, filing left out: an unfiled late
    /// task reads as late.
    private let dueSection: [String: WorkSection]

    static let empty = HomeMine(rows: [], dueSection: [:])

    static func plan(
        tasks: [CrmMyTask],
        issues: [CrmIssue],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> HomeMine {
        let rows = WorkItems.planMine(tasks: tasks, issues: issues, now: now, calendar: calendar).order
        var dueSection: [String: WorkSection] = [:]
        for item in rows {
            dueSection[item.workID] = WorkItems.dateSection(due: item.workDueDate, now: now, calendar: calendar)
        }
        return HomeMine(rows: rows, dueSection: dueSection)
    }

    var isEmpty: Bool { rows.isEmpty }

    /// "2 overdue · 1 due today", or nil when nothing is late or due today.
    var summary: String? {
        let late = dueSection.values.filter { $0 == .late }.count
        let today = dueSection.values.filter { $0 == .today }.count
        var parts: [String] = []
        if late > 0 { parts.append(String(localized: "\(late) overdue")) }
        if today > 0 { parts.append(String(localized: "\(today) due today")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    func isLate(_ item: PlannedWorkItem) -> Bool { dueSection[item.workID] == .late }

    /// The row's date: overdue, today or its day; with no date, its stage
    /// once started.
    func when(_ item: PlannedWorkItem) -> String {
        switch dueSection[item.workID] {
        case .late:
            return item.workDueDate.map { "Overdue · " + StarlingsDateFormatting.date($0) } ?? String(localized: "Overdue")
        case .today:
            return String(localized: "Today")
        case .soon:
            return item.workDueDate.map { StarlingsDateFormatting.date($0) } ?? ""
        default:
            switch WorkItems.stage(of: item) {
            case .doing: return CrmTaskStatus.inProgress.menuTitle
            case .review: return CrmTaskStatus.review.menuTitle
            case .blocked: return CrmTaskStatus.blocked.menuTitle
            default: return ""
            }
        }
    }
}

/// The focus slice of Mine, planned on the device that knows what day it
/// is: the menu bar, the Today's work widget and the watch. `WorkItems.focus`
/// decides the rows, pinned by `focus` in `fixtures/work-items.json`.
typealias HomeFocus = MineFocus<PlannedWorkItem>

extension MineFocus where Item == PlannedWorkItem {
    /// Mine's own plan, then its focus slice: one list, two windows onto it.
    static func plan(
        tasks: [CrmMyTask],
        issues: [CrmIssue],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> HomeFocus {
        WorkItems.focus(
            WorkItems.planMine(tasks: tasks, issues: issues, now: now, calendar: calendar),
            now: now,
            calendar: calendar
        )
    }

    /// The late and due-today rows only: what the Today's work widget and
    /// the watch list, whose count line says nothing else.
    var datedRows: [PlannedWorkItem] { Array(rows.prefix(lateCount + todayCount)) }

    func isToday(_ item: PlannedWorkItem) -> Bool {
        rows.dropFirst(lateCount).prefix(todayCount).contains { $0.workID == item.workID }
    }

    /// Why the row is here: overdue, today, its day under Next, or its stage.
    func when(_ item: PlannedWorkItem) -> String {
        if isLate(item) {
            return item.workDueDate.map { "Overdue · " + StarlingsDateFormatting.date($0) } ?? String(localized: "Overdue")
        }
        if isToday(item) { return String(localized: "Today") }
        if next { return item.workDueDate.map { StarlingsDateFormatting.date($0) } ?? "" }
        switch WorkItems.stage(of: item) {
        case .review: return CrmTaskStatus.review.menuTitle
        case .blocked: return CrmTaskStatus.blocked.menuTitle
        default: return CrmTaskStatus.inProgress.menuTitle
        }
    }
}

extension PlannedWorkItem {
    var homeTitle: String {
        switch self {
        case .task(let task): task.title
        case .subjectTask(let task): task.title
        case .issue(let issue): issue.title
        }
    }

    /// The subject for a task, `repo#n` for an issue.
    var homeDetail: String {
        switch self {
        case .task(let task): task.subjectTitle ?? ""
        case .subjectTask: ""
        case .issue(let issue): "\(issue.repo)#\(issue.number)"
        }
    }

    var homeSymbol: String {
        workOrigin == .issue ? "smallcircle.filled.circle" : "checkmark"
    }

    /// A filed task opens its subject on the Tasks pane; a task with no
    /// subject opens on Mine, the one list that holds it; an issue opens in
    /// Work's reader.
    var homeDestination: WorkDestination? {
        switch self {
        case .task(let task):
            if let subject = task.subject { return WorkDestination(subject: subject, pane: .tasks) }
            return .mine(taskID: task.id)
        case .subjectTask(let task):
            return .mine(taskID: task.id)
        case .issue(let issue):
            return .issue(reference: issue.id)
        }
    }

    /// The row's menu, from the shared registry: the task's own `mine`
    /// context, or the issue's `assigned` one.
    func homeRowActions(client: WorkActionClient = .mac) -> [[WorkRowAction]] {
        switch self {
        case .task(let task): task.rowActions(context: .mine, client: client)
        case .subjectTask: []
        case .issue(let issue): issue.rowActions(projectID: nil, context: .assigned, client: client)
        }
    }
}
