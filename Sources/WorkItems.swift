import Foundation
import StarlingsContracts

/// What "my work" is and the order it is owed — the one definition, shared by
/// the Mac and iOS. The TypeScript port is
/// `packages/contracts/src/work-items.ts` (web + Worker); both are pinned to
/// the same table of cases in `fixtures/work-items.json`. Change the rules
/// there first.
///
/// A task from Core and an issue from GitHub are two rows in two systems, but
/// they answer one question: *what do I owe*. Left to themselves the surfaces
/// each answered it with their own filter, their own ordering, and a vendor
/// seam down the middle of the list — so the plan is computed here, once, and
/// no surface is allowed a second opinion about which section a row is in or
/// what comes before what.
enum WorkItemOrigin: String, Equatable, Sendable {
    case task
    case issue
}

/// Where a row sits in the plan. `inbox` is work not yet filed to any subject —
/// filing comes before scheduling, whatever date the row carries. It reads
/// as Unfiled on every client, so it is not mistaken for Work's INBOX. The date
/// sections compare civil days, never raw timestamps: work due earlier today
/// is due today, not late. Every issue is `undated`, because GitHub issues
/// carry no due date.
enum WorkSection: String, CaseIterable, Sendable {
    case inbox
    case late
    case today
    case soon
    case undated
}

/// The two contextual axes Mine can narrow without changing its owed order.
/// `MineSectionFilter` and `MineOriginFilter`, their order and their titles,
/// are generated from `MINE_SECTION_FILTERS` and `MINE_ORIGIN_FILTERS` in
/// `packages/contracts/src/work-items.ts` into `Generated/WorkItemsRegistry.swift`.
///
/// `focus` is not a section: it is the slice Home shows (`WorkItems.focus`),
/// so a link from Home lands on the same rows. Its `section` is nil.
extension MineSectionFilter {
    var section: WorkSection? {
        guard self != .all, self != .focus else { return nil }
        return WorkSection(rawValue: rawValue)
    }
}

struct MineFilter: Equatable, Sendable {
    var section: MineSectionFilter = .all
    var origin: MineOriginFilter = .all

    static let `default` = MineFilter()
    var isDefault: Bool { self == .default }
}

/// The little a row has to expose to be planned. Deliberately not a wire type:
/// each surface adapts its own task and issue shapes.
protocol WorkItem {
    /// Stable identity; for an issue, its `owner/repo#number`.
    var workID: String { get }
    var workOrigin: WorkItemOrigin { get }
    /// Completed/cancelled task, or closed issue. Done work is never planned.
    var workIsDone: Bool { get }
    /// Belongs to a project or lead. Every issue is filed by construction.
    var workIsFiled: Bool { get }
    /// Nil is undated, and so is a date nobody could parse.
    var workDueDate: Date? { get }
    var workUpdatedAt: Date? { get }
    /// `owner/repo#number` a promoted task points at.
    var workGithubRef: String? { get }
}

struct WorkPlan<Item: WorkItem> {
    /// Every planned row, sections concatenated in section order.
    let order: [Item]
    let sections: [WorkSection: [Item]]
    let sectionOf: [String: WorkSection]

    /// Planned rows after dedupe — the honest size of the plate.
    var openCount: Int { order.count }
    var lateCount: Int { count(.late) }

    func items(in section: WorkSection) -> [Item] { sections[section] ?? [] }
    func count(_ section: WorkSection) -> Int { items(in: section).count }

    /// Narrow an already-planned pile without re-running its rules. Search
    /// must happen after promotion dedupe: a promoted task remains the row
    /// even when the query matches the GitHub reference rather than the task
    /// title.
    func filtered(_ include: (Item) -> Bool) -> WorkPlan<Item> {
        var filteredSections: [WorkSection: [Item]] = [:]
        var filteredSectionOf: [String: WorkSection] = [:]
        for section in WorkSection.allCases {
            let rows = items(in: section).filter(include)
            guard !rows.isEmpty else { continue }
            filteredSections[section] = rows
            for row in rows { filteredSectionOf[row.workID] = section }
        }
        let filteredOrder = WorkSection.allCases.flatMap { filteredSections[$0] ?? [] }
        return WorkPlan(order: filteredOrder, sections: filteredSections, sectionOf: filteredSectionOf)
    }

    static var empty: WorkPlan<Item> {
        WorkPlan(order: [], sections: [:], sectionOf: [:])
    }
}

extension WorkPlan where Item: WorkCard {
    /// Apply Mine's contextual filter after planning and dedupe. `focus`
    /// keeps the rows `WorkItems.focus` puts first, without its Next fill:
    /// Home fills an empty card, a filter shows what matches.
    func filtered(by filter: MineFilter, now: Date = Date(), calendar: Calendar = .current) -> WorkPlan<Item> {
        let focused: Set<String>? = filter.section == .focus
            ? Set(WorkItems.focusRows(self, now: now, calendar: calendar).map(\.workID))
            : nil
        return filtered { item in
            let sectionMatches: Bool
            if let focused {
                sectionMatches = focused.contains(item.workID)
            } else {
                sectionMatches = filter.section.section.map { sectionOf[item.workID] == $0 } ?? true
            }
            let originMatches = filter.origin == .all || item.workOrigin.rawValue == filter.origin.rawValue
            return sectionMatches && originMatches
        }
    }

    /// How many rows a filter would leave, for the count beside a menu row.
    func count(matching filter: MineFilter, now: Date = Date(), calendar: Calendar = .current) -> Int {
        filtered(by: filter, now: now, calendar: calendar).openCount
    }
}

/// The slice of Mine that Home shows (docs/WORK.md §1). `rows` is late, then
/// due today, then started work with no claim on a day. When all three are
/// empty, `next` is true and `rows` holds the first soon rows instead, so a
/// clear day still says what comes after it. `planFocus` in work-items.ts is
/// the TypeScript port; both answer to `focus` in `fixtures/work-items.json`.
struct MineFocus<Item: WorkCard> {
    let rows: [Item]
    let next: Bool
    let lateCount: Int
    let todayCount: Int

    static var empty: MineFocus<Item> { MineFocus(rows: [], next: false, lateCount: 0, todayCount: 0) }

    var isEmpty: Bool { rows.isEmpty }

    /// One line for a card or a badge: "2 overdue · 1 due today". Nil when
    /// nothing is late or due today, so a surface can hide rather than
    /// announce it.
    var summary: String? {
        var parts: [String] = []
        if lateCount > 0 { parts.append(String(localized: "\(lateCount) overdue")) }
        if todayCount > 0 { parts.append(String(localized: "\(todayCount) due today")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Whether a row is late, for the emphasis Home gives it.
    func isLate(_ item: Item) -> Bool { rows.prefix(lateCount).contains { $0.workID == item.workID } }
}

extension MineFocus: Equatable where Item: Equatable {}
extension MineFocus: Sendable where Item: Sendable {}

enum WorkItems {
    /// Plan a mixed pile of tasks and issues.
    ///
    /// A live task that carries a `githubRef` claims that issue: the task is
    /// the one row, because it holds the date and the subject. A done task
    /// claims nothing — its still-open issue is real work and keeps its row.
    static func plan<Item: WorkItem>(
        _ items: [Item],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> WorkPlan<Item> {
        var claimed = Set<String>()
        for item in items where item.workOrigin == .task && !item.workIsDone {
            if let ref = item.workGithubRef { claimed.insert(ref) }
        }

        var sections: [WorkSection: [Item]] = [:]
        var sectionOf: [String: WorkSection] = [:]
        for item in items {
            if item.workIsDone { continue }
            if item.workOrigin == .issue, claimed.contains(item.workID) { continue }
            let section = classify(item, now: now, calendar: calendar)
            sections[section, default: []].append(item)
            sectionOf[item.workID] = section
        }

        for section in WorkSection.allCases {
            guard var rows = sections[section] else { continue }
            switch section {
            case .inbox, .undated: rows.sort(by: byRecentMovement)
            case .late, .today, .soon: rows.sort(by: byDue)
            }
            sections[section] = rows
        }

        let order = WorkSection.allCases.flatMap { sections[$0] ?? [] }
        return WorkPlan(order: order, sections: sections, sectionOf: sectionOf)
    }

    /// The cross-subject list: every task and issue assigned to the owner,
    /// with a promoted task claiming its GitHub issue. This is the only
    /// surface-level entry point for Mine; callers should not rebuild this
    /// pile and apply a second filter before planning.
    static func planMine(
        tasks: [CrmMyTask],
        issues: [CrmIssue],
        query: String = "",
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> WorkPlan<PlannedWorkItem> {
        let plan = plan(
            tasks.map(PlannedWorkItem.task) + issues.map(PlannedWorkItem.issue),
            now: now,
            calendar: calendar
        )
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty else { return plan }
        return plan.filtered { $0.matchesMineQuery(wanted) }
    }

    private static func classify(_ item: WorkItem, now: Date, calendar: Calendar) -> WorkSection {
        guard item.workIsFiled else { return .inbox }
        return dateSection(due: item.workDueDate, now: now, calendar: calendar)
    }

    /// Where a due date falls, with filing left out of it.
    ///
    /// The one civil-day comparison in the app. `plan` reaches it through
    /// `classify`, and `focus` reaches it directly, because Home counts a
    /// late task as late whether or not the row it came from knows its
    /// subject. Two date rules is how a task reads as late in one list and on
    /// time in another, so there is only this one.
    ///
    /// Civil days, never raw timestamps: a date-only column parses to local
    /// midnight, and work due earlier today is due today, not late.
    static func dateSection(due: Date?, now: Date, calendar: Calendar) -> WorkSection {
        guard let due else { return .undated }
        switch calendar.compare(due, to: now, toGranularity: .day) {
        case .orderedAscending: return .late
        case .orderedSame: return .today
        case .orderedDescending: return .soon
        }
    }

    // MARK: - Focus (docs/WORK.md §1)

    /// How many soon rows fill Home when nothing is late, due today or started.
    static let focusNextRows = 3

    /// The started stages: work a person picked up stays in view without a date.
    private static let focusStages: Set<WorkStage> = [.doing, .review, .blocked]

    /// Plan Home from Mine's plan. Dates come from `dateSection`, with filing
    /// left out: an unfiled task that is late is late on Home. Late and today
    /// keep the plan's due order; started rows follow by recent movement.
    static func focus<Item: WorkCard>(
        _ plan: WorkPlan<Item>,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> MineFocus<Item> {
        var late: [Item] = []
        var today: [Item] = []
        var started: [Item] = []
        var soon: [Item] = []
        for item in plan.order {
            switch dateSection(due: item.workDueDate, now: now, calendar: calendar) {
            case .late: late.append(item)
            case .today: today.append(item)
            case let section:
                if focusStages.contains(stage(of: item)) {
                    started.append(item)
                } else if section == .soon {
                    soon.append(item)
                }
            }
        }
        let rows = late.sorted(by: byDue) + today.sorted(by: byDue) + started.sorted(by: byRecentMovement)
        if !rows.isEmpty {
            return MineFocus(rows: rows, next: false, lateCount: late.count, todayCount: today.count)
        }
        return MineFocus(rows: Array(soon.sorted(by: byDue).prefix(focusNextRows)), next: true, lateCount: 0, todayCount: 0)
    }

    /// The focus rows without the Next fill, for Mine's Focus filter.
    static func focusRows<Item: WorkCard>(_ plan: WorkPlan<Item>, now: Date, calendar: Calendar) -> [Item] {
        let slice = focus(plan, now: now, calendar: calendar)
        return slice.next ? [] : slice.rows
    }

    // MARK: - Events (docs/EVENTS.md)

    /// Where an event is in its life. An event has one date and no status
    /// field: the date is the status. `upcoming` and `live` are open subjects;
    /// `past` is closed. Civil days in the reader's calendar, the same rule
    /// `dateSection` applies to a due date. Pinned in
    /// `fixtures/work-items.json` under `events`; change it there first.
    ///
    /// `eventDate` is the CMS `YYYY-MM-DD`, or nil on an undated draft.
    /// Undated is `upcoming`: a draft with tasks is open work, and hiding it
    /// would hide the tasks.
    static func eventPhase(eventDate: String?, now: Date, calendar: Calendar) -> EventPhase {
        guard let daysUntil = eventDaysUntil(eventDate: eventDate, now: now, calendar: calendar) else { return .upcoming }
        if daysUntil < 0 { return .past }
        if daysUntil == 0 { return .live }
        return .upcoming
    }

    /// Civil days until the event in the reader's time zone; nil for an
    /// undated or invalid CMS date. The CMS date is Gregorian regardless of
    /// the reader's preferred calendar.
    static func eventDaysUntil(eventDate: String?, now: Date, calendar: Calendar) -> Int? {
        guard let (year, month, day) = civilDay(eventDate) else { return nil }
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone

        let today = gregorian.dateComponents([.year, .month, .day], from: now)
        guard let todayYear = today.year, let todayMonth = today.month, let todayDay = today.day,
              let todayNoon = gregorian.date(from: DateComponents(year: todayYear, month: todayMonth, day: todayDay, hour: 12)),
              let eventNoon = gregorian.date(from: DateComponents(year: year, month: month, day: day, hour: 12))
        else { return nil }

        let parsed = gregorian.dateComponents([.year, .month, .day], from: eventNoon)
        guard parsed.year == year, parsed.month == month, parsed.day == day else { return nil }
        return gregorian.dateComponents([.day], from: todayNoon, to: eventNoon).day
    }

    /// The sidebar's event metadata: a relative day count, with the existing
    /// phase wording for today, past events, and undated drafts.
    static func eventCountdownLabel(eventDate: String?, now: Date, calendar: Calendar) -> String {
        guard let daysUntil = eventDaysUntil(eventDate: eventDate, now: now, calendar: calendar) else {
            return EventPhase.upcoming.label
        }
        if daysUntil < 0 { return EventPhase.past.label }
        if daysUntil == 0 { return EventPhase.live.label }
        if daysUntil == 1 { return String(localized: "1 day left") }
        return String(localized: "\(daysUntil) days left")
    }

    /// A plain `YYYY-MM-DD` as year, month, day, with no zone to apply: the
    /// CMS date is already a day.
    static func civilDay(_ date: String?) -> (Int, Int, Int)? {
        guard let date, date.count >= 10 else { return nil }
        let parts = date.prefix(10).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              (1...12).contains(month), (1...31).contains(day)
        else { return nil }
        return (year, month, day)
    }

    /// The oldest debt first; ties break on id.
    private static func byDue(_ a: some WorkItem, _ b: some WorkItem) -> Bool {
        let aDue = a.workDueDate ?? .distantPast
        let bDue = b.workDueDate ?? .distantPast
        if aDue != bDue { return aDue < bDue }
        return a.workID < b.workID
    }

    /// Recent movement first, silence last; ties break on id.
    private static func byRecentMovement(_ a: some WorkItem, _ b: some WorkItem) -> Bool {
        switch (a.workUpdatedAt, b.workUpdatedAt) {
        case (let aMs?, let bMs?) where aMs != bMs: return aMs > bMs
        case (.some, .none): return true
        case (.none, .some): return false
        default: return a.workID < b.workID
        }
    }
}

// MARK: - Wire adapters

/// The fields shared by every Core task projection. Keeping this projection
/// here means the planner and board do not need one switch for every rule just
/// because Core has two payload sizes for the same task.
protocol WorkTaskFields: Sendable {
    var id: String { get }
    var status: CrmTaskStatus { get }
    var projectID: String? { get }
    var leadID: String? { get }
    var eventID: String? { get }
    var organizationID: String? { get }
    var meetingID: String? { get }
    var dueDate: String? { get }
    var updatedAt: String? { get }
    var githubOwner: String? { get }
    var githubRepo: String? { get }
    var githubIssueNumber: Int? { get }
}

extension WorkTaskFields {
    /// The partner this task is filed on, or nil. Core echoes
    /// `organization_id` on a task that hangs off a project, lead or event as
    /// context, so the organization only makes it a partner task when no
    /// other subject holds it. The one place that rule lives.
    var partnerOrganizationID: String? {
        guard let organizationID, projectID == nil, leadID == nil, eventID == nil, meetingID == nil else { return nil }
        return organizationID
    }

    var githubRef: String? {
        guard let owner = githubOwner, let repo = githubRepo, let number = githubIssueNumber else {
            return nil
        }
        return "\(owner)/\(repo)#\(number)"
    }
}

extension CrmMyTask: WorkTaskFields {}
extension CrmTask: WorkTaskFields {}

/// Common WorkCard behavior for a task or issue-backed row. A board card can
/// carry subject and trace metadata beside this projection without re-copying
/// the planner's task/issue switches.
protocol ProjectedWorkCard: WorkCard {
    var workTask: (any WorkTaskFields)? { get }
    var workIssue: CrmIssue? { get }
}

extension ProjectedWorkCard {
    var workID: String {
        if let workTask { return workTask.id }
        guard let workIssue else {
            preconditionFailure("A projected work card must contain a task or issue")
        }
        return workIssue.id
    }

    var workOrigin: WorkItemOrigin { workTask == nil ? .issue : .task }

    var workIsDone: Bool {
        if let workTask {
            return workTask.status.isFinished
        }
        return !(workIssue?.isOpen ?? true)
    }

    var workIsFiled: Bool {
        guard let workTask else { return true }
        return workTask.projectID != nil || workTask.leadID != nil || workTask.eventID != nil || workTask.partnerOrganizationID != nil
    }

    var workDueDate: Date? {
        CrmTaskDate.date(workTask?.dueDate)
    }

    var workUpdatedAt: Date? {
        if let workTask { return CrmTaskDate.date(workTask.updatedAt) }
        return CrmTaskDate.date(workIssue?.updatedAt)
    }

    var workGithubRef: String? { workTask?.githubRef }
    var workTaskStatus: String? { workTask?.status.rawValue }
    var workIssueState: String? { workIssue?.state }
    var workIssueStateReason: String? { workIssue?.stateReason }
    var workLabels: [String] { workIssue?.labels ?? [] }
}

/// One planned row for the surfaces to render: the task or the issue it wraps.
/// The planner deduped them, so exactly one side is set.
enum PlannedWorkItem: ProjectedWorkCard, Identifiable, Equatable {
    case task(CrmMyTask)
    case subjectTask(CrmTask)
    case issue(CrmIssue)

    var id: String { workID }

    var workTask: (any WorkTaskFields)? {
        switch self {
        case .task(let task): task
        case .subjectTask(let task): task
        case .issue: nil
        }
    }

    var workIssue: CrmIssue? {
        if case .issue(let issue) = self { return issue }
        return nil
    }

    /// Search fields for Mine. This deliberately includes the subject and
    /// GitHub reference, while leaving the full reader metadata out of the
    /// list query so a comment count or author cannot unexpectedly change
    /// what somebody finds.
    func matchesMineQuery(_ query: String) -> Bool {
        let values: [String]
        switch self {
        case .task(let task):
            values = [
                task.title,
                task.subjectTitle,
                task.githubOwner,
                task.githubRepo,
                task.githubIssueNumber.map { String($0) },
                task.githubIssueNumber.map { "#\($0)" },
            ].compactMap { $0 }
        case .subjectTask(let task):
            values = [task.title]
        case .issue(let issue):
            values = [
                issue.title,
                issue.owner,
                issue.repo,
                issue.id,
                issue.shortReference,
                issue.assigneeLogin,
                issue.author?.login,
            ].compactMap { $0 }
        }
        // The one matcher (invariant 27): the title is the title, the rest
        // is the subtitle a token can still reach.
        return Search.matches(query: query, title: values.first ?? "", subtitle: values.dropFirst().joined(separator: " "))
    }
}

// MARK: - Stages (docs/BOARD.md)

/// Where a piece of work sits in the pipeline, whichever store holds it.
///
/// `WorkSection` answers *when*; this answers *where*. A Core task says it
/// with `status`, a GitHub issue with `state`, `state_reason` and its
/// `agent:*` labels, and the board must never show a task half with four
/// columns and an issue half with six. The rules are pinned under `stages` in
/// `fixtures/work-items.json`; change them there first.
/// The phase of an event subject. See `WorkItems.eventPhase`.
enum EventPhase: String, CaseIterable, Sendable {
    case upcoming
    case live
    case past

    /// Upcoming and live events are open subjects; past is closed.
    var isOpen: Bool { self != .past }

    /// The phase, spelled for a row.
    var label: String {
        switch self {
        case .upcoming: String(localized: "Upcoming")
        case .live: String(localized: "Today")
        case .past: String(localized: "Past")
        }
    }
}

enum WorkStage: String, CaseIterable, Sendable {
    case queued
    case doing
    case review
    case blocked
    case done
    case dropped

    var isFinished: Bool { self == .done || self == .dropped }

    // `columnLabel` is generated from `WORK_STAGE_TITLES` (Generated/WorkItemsRegistry.swift).

    /// The Core status a task in this stage carries. `review` and `blocked`
    /// are sent verbatim even before Core accepts them: the write is refused
    /// loudly there, never translated silently here.
    fileprivate var taskStatus: String {
        switch self {
        case .queued: "pending"
        case .doing: "in_progress"
        case .review: "review"
        case .blocked: "blocked"
        case .done: "completed"
        case .dropped: "cancelled"
        }
    }

    /// The label an open issue carries in this stage. `queued` has none: a
    /// card queued for a person is not queued for an agent, and the hand-off
    /// is what labels it.
    fileprivate var issueLabel: String? {
        switch self {
        case .doing: "agent:building"
        case .review: "agent:review"
        case .blocked: "agent:failed"
        case .queued, .done, .dropped: nil
        }
    }

    /// Every label that means a stage, so a write can take all of them off.
    fileprivate static let allIssueLabels: Set<String> = [
        "agent:queued", "agent:building", "agent:review", "agent:failed",
    ]
}

/// A row that can be staged as well as planned. Task fields for a task, issue
/// fields for an issue; the other side's are ignored.
protocol WorkCard: WorkItem {
    /// Core's status string, verbatim.
    var workTaskStatus: String? { get }
    /// `open` or `closed`.
    var workIssueState: String? { get }
    /// `completed`, `not_planned`, `duplicate`, `reopened`, or nothing.
    var workIssueStateReason: String? { get }
    /// Label names as GitHub returns them.
    var workLabels: [String] { get }
}

/// The one write a stage move makes: a task PATCH, or an issue PATCH with the
/// whole label set (GitHub replaces on PATCH).
enum WorkStageWrite: Equatable, Sendable {
    case task(status: String)
    case issue(state: String, stateReason: String?, labels: [String])
}

struct WorkBoard<Item: WorkCard> {
    let columns: [WorkStage: [Item]]
    let stageOf: [String: WorkStage]

    func items(in stage: WorkStage) -> [Item] { columns[stage] ?? [] }

    static var empty: WorkBoard<Item> { WorkBoard(columns: [:], stageOf: [:]) }
}

extension WorkItems {
    /// The machine has it: an open issue with any of the four stage labels,
    /// `agent:queued` included, as UNOWNED reads it (`isHeldByAgent` in
    /// work-items.ts). A task is a person's until Core has agent team rows.
    static func isHeldByAgent(_ item: some WorkCard) -> Bool {
        guard item.workOrigin == .issue, !stage(of: item).isFinished else { return false }
        return !Set(item.workLabels.map { $0.lowercased() }).isDisjoint(with: WorkStage.allIssueLabels)
    }

    /// The board's holder filter (`passesHolderFilter`): `anyone`, `people`,
    /// `agents`, or `agent:<email>`, matched against the agent the card's
    /// project names. An unknown filter shows everything.
    static func passesHolderFilter(_ item: some WorkCard, filter: String, agentEmail: String?) -> Bool {
        switch filter {
        case WorkHolderChoice.people.rawValue: return !isHeldByAgent(item)
        case WorkHolderChoice.agents.rawValue: return isHeldByAgent(item)
        default:
            guard filter.hasPrefix("agent:") else { return true }
            let wanted = filter.dropFirst("agent:".count).trimmingCharacters(in: .whitespaces).lowercased()
            let named = (agentEmail ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            return isHeldByAgent(item) && named == wanted
        }
    }

    /// The task filters (`passesTaskFilter`). Overdue is open work
    /// due before today in civil days, as the plan's `late` section reads it.
    /// An issue has no date and no side, so it shows only while both filters
    /// are `any`. A task with no side reads as `unassigned`.
    static func passesTaskFilter(
        _ item: some WorkHeldCard,
        due: WorkDueFilter,
        side: WorkSideFilter,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> Bool {
        if due == .any && side == .any { return true }
        guard item.workOrigin == .task else { return false }
        if due == .overdue {
            if stage(of: item).isFinished { return false }
            if dateSection(due: item.workDueDate, now: now, calendar: calendar) != .late { return false }
        }
        if side != .any {
            let party = item.workResponsibleParty.flatMap { $0.isEmpty ? nil : $0 } ?? WorkSideFilter.unassigned.rawValue
            if party != side.rawValue { return false }
        }
        return true
    }

    /// The stage of one row. Pure; the fixture is the spec.
    static func stage(of item: some WorkCard) -> WorkStage {
        switch item.workOrigin {
        case .task:
            return switch item.workTaskStatus ?? "" {
            case "pending": .queued
            case "in_progress": .doing
            case "review": .review
            case "blocked": .blocked
            case "completed": .done
            case "cancelled": .dropped
            // Core-proposed: a question, queued if it ever reaches a
            // board; declined is dropped. Mirrors contracts/work-items.ts.
            case "proposed": .queued
            case "declined": .dropped
            // Open work until Core says otherwise, the same reading `done` gives it.
            default: .queued
            }
        case .issue:
            if item.workIssueState == "closed" {
                let reason = item.workIssueStateReason
                return reason == "not_planned" || reason == "duplicate" ? .dropped : .done
            }
            let labels = Set(item.workLabels.map { $0.lowercased() })
            // The strongest claim on a person's attention wins when labels disagree.
            if labels.contains(WorkStage.blocked.issueLabel!) { return .blocked }
            if labels.contains(WorkStage.review.issueLabel!) { return .review }
            if labels.contains(WorkStage.doing.issueLabel!) { return .doing }
            return .queued
        }
    }

    /// Finished task and issue rows, newest movement first, in one mixed list.
    /// The Worker sends this order to each client from the same shared rule.
    static func recentlyClosed<Item: WorkCard>(
        _ items: [Item],
        finishedSince: Date? = nil
    ) -> [Item] {
        items
            .filter { stage(of: $0).isFinished }
            .filter { item in
                guard let finishedSince else { return true }
                guard let moved = item.workUpdatedAt else { return true }
                return moved >= finishedSince
            }
            .sorted(by: byRecentMovement)
    }

    static func write(_ stage: WorkStage, for item: some WorkCard) -> WorkStageWrite {
        switch item.workOrigin {
        case .task:
            return .task(status: stage.taskStatus)
        case .issue:
            var labels = item.workLabels.filter { !WorkStage.allIssueLabels.contains($0.lowercased()) }
            switch stage {
            case .done: return .issue(state: "closed", stateReason: "completed", labels: labels)
            case .dropped: return .issue(state: "closed", stateReason: "not_planned", labels: labels)
            case .queued: return .issue(state: "open", stateReason: nil, labels: labels)
            case .doing, .review, .blocked:
                labels.append(stage.issueLabel!)
                return .issue(state: "open", stateReason: nil, labels: labels)
            }
        }
    }

    /// Every card in its column.
    ///
    /// A live task that carries a `githubRef` claims its issue, exactly as
    /// `plan` does: the task's stage is the card's, and the issue leaves the
    /// board. Open columns keep the plan's order; finished columns order by
    /// movement, newest first. `finishedSince` drops finished cards that moved
    /// before it, and keeps the ones that cannot say when they moved.
    static func board<Item: WorkCard>(
        _ items: [Item],
        now: Date = Date(),
        calendar: Calendar = .current,
        finishedSince: Date? = nil
    ) -> WorkBoard<Item> {
        var stages: [String: WorkStage] = [:]
        for item in items { stages[item.workID] = stage(of: item) }

        var columns: [WorkStage: [Item]] = [:]
        var stageOf: [String: WorkStage] = [:]

        // The plan already knows how to dedupe and order open work; hand it
        // rows that agree with the stage about being open, so its own `done`
        // never disagrees with the column.
        let open = items.filter { !stages[$0.workID]!.isFinished }.map(OpenCard.init)
        for planned in plan(open, now: now, calendar: calendar).order {
            let stage = stages[planned.workID]!
            columns[stage, default: []].append(planned.card)
            stageOf[planned.workID] = stage
        }

        let finished = recentlyClosed(items, finishedSince: finishedSince)
        for item in finished {
            let stage = stages[item.workID]!
            columns[stage, default: []].append(item)
            stageOf[item.workID] = stage
        }

        return WorkBoard(columns: columns, stageOf: stageOf)
    }

    /// A card handed to `plan` as open, whatever its own `workIsDone` says.
    private struct OpenCard<Item: WorkCard>: WorkItem {
        let card: Item
        var workID: String { card.workID }
        var workOrigin: WorkItemOrigin { card.workOrigin }
        var workIsDone: Bool { false }
        var workIsFiled: Bool { card.workIsFiled }
        var workDueDate: Date? { card.workDueDate }
        var workUpdatedAt: Date? { card.workUpdatedAt }
        var workGithubRef: String? { card.workGithubRef }
    }
}

// MARK: - Task filters

/// A subject's task as the task filters read it: the side and the holder
/// from the full record. Lists of `CrmTask` filter through this, so the one
/// rule (`passesTaskFilter`) is the only rule.
struct HeldTask: ProjectedWorkCard, WorkHeldCard {
    let task: CrmTask

    var workTask: (any WorkTaskFields)? { task }
    var workIssue: CrmIssue? { nil }
    var workAssignee: String? { task.assigneeID ?? task.assigneeEmail }
    var workResponsibleParty: String? { task.responsibleParty.rawValue }
    var workAssignees: [String] { [] }
}

extension WorkItems {
    /// `passesTaskFilter` for a subject's task row.
    static func passesTaskFilter(
        _ task: CrmTask,
        due: WorkDueFilter,
        side: WorkSideFilter,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> Bool {
        passesTaskFilter(HeldTask(task: task), due: due, side: side, now: now, calendar: calendar)
    }
}

// MARK: - Unowned (docs/BOARD.md §Unowned)

/// A card that can say who holds it. Task fields for a task, issue fields for
/// an issue; the other side's are ignored. The Worker answers the list
/// (`GET /api/crm/unowned`); this port exists so the fixture pins both.
protocol WorkHeldCard: WorkCard {
    /// Task: the Core person it is assigned to, by id or address; nil when nobody.
    var workAssignee: String? { get }
    /// Task: Core's side — `team`, `client` or `unassigned`.
    var workResponsibleParty: String? { get }
    /// Issue: the GitHub logins assigned.
    var workAssignees: [String] { get }
}

extension WorkItems {
    /// Nobody on our side holds it. A task with no person, unless the client
    /// owes it; an issue with no assignee and no stage label, because an
    /// `agent:*` stage means an agent holds it. Mirrors `isUnowned`.
    static func isUnowned(_ item: some WorkHeldCard) -> Bool {
        switch item.workOrigin {
        case .task:
            if !(item.workAssignee ?? "").trimmingCharacters(in: .whitespaces).isEmpty { return false }
            return item.workResponsibleParty != "client"
        case .issue:
            if item.workAssignees.contains(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) { return false }
            let labels = Set(item.workLabels.map { $0.lowercased() })
            return labels.isDisjoint(with: WorkStage.allIssueLabels)
        }
    }

    /// Every open card nobody holds, in the plan's order. Open is the board's
    /// open, never a proposal; the plan dedupes first, so a promoted task is
    /// judged and the issue it claims never is. Mirrors `planUnowned`.
    static func unowned<Item: WorkHeldCard>(
        _ items: [Item],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [Item] {
        let open = items
            .filter { !stage(of: $0).isFinished && !($0.workOrigin == .task && $0.workTaskStatus == "proposed") }
            .map(OpenHeldCard.init)
        return plan(open, now: now, calendar: calendar).order
            .map(\.card)
            .filter { isUnowned($0) }
    }

    /// A card handed to `plan` as open, whatever its own `workIsDone` says.
    private struct OpenHeldCard<Item: WorkHeldCard>: WorkItem {
        let card: Item
        var workID: String { card.workID }
        var workOrigin: WorkItemOrigin { card.workOrigin }
        var workIsDone: Bool { false }
        var workIsFiled: Bool { card.workIsFiled }
        var workDueDate: Date? { card.workDueDate }
        var workUpdatedAt: Date? { card.workUpdatedAt }
        var workGithubRef: String? { card.workGithubRef }
    }
}

/// The text of a Hand off message, the same on the Mac and the
/// phone: the card, then what done looks like and what comes back, so a
/// person reading the conversation later sees what was asked. The runtime
/// reads the card from the ref and the brief from `handoff`, not from this.
/// What a hand-off names: the card's title, its issue number when it is
/// one, and the ref the runtime reads its ticket from. A Board
/// card and a task row both make one. The subject is where it is said: its
/// channel, so everyone who sees the card sees the work. A card
/// with no subject goes to the agent's direct conversation.
struct HandOffTarget: Sendable, Hashable {
    let title: String
    let issueNumber: Int?
    let ref: ThreadMessageRef
    var subjectKind: String? = nil
    var subjectID: String? = nil

    var inChannel: Bool { subjectKind != nil && subjectID != nil }
}

enum HandOffText {
    /// "Take #142: Fix the login" for an issue, "Take this task: …" for a task.
    static func cardLine(issueNumber: Int?, title: String) -> String {
        issueNumber.map { "Take #\($0): \(title)" } ?? String(localized: "Take this task: \(title)")
    }

    /// In a channel the message opens with the agent's @mention: that is how
    /// a channel reaches an agent, and the Worker refuses a hand-off without it.
    static func addressed(_ text: String, to agentEmail: String) -> String {
        "@\(MentionMatching.localPart(of: agentEmail)) \(text)"
    }

    static func message(cardLine line: String, doneWhen: String, deliverable: String) -> String {
        [
            line,
            String(localized: "Done when: \(doneWhen)"),
            String(localized: "Deliverable: \(deliverable)"),
        ].joined(separator: "\n")
    }
}
