import XCTest
@testable import Starlings

/// The shared table, run against the Swift implementation. The TypeScript port
/// runs the same file (`services/control-plane/test/work-items.test.ts`), which
/// is the whole point: three surfaces answering "what do I owe" with three
/// orderings is the drift this table exists to prevent.
///
/// A failure here is a question about `fixtures/work-items.json` first — the
/// rules live there, and both implementations answer to it.
final class WorkItemFixtureTests: XCTestCase {
    func testEveryFixtureCase() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 2, "The fixture changed shape; re-read its rules before touching this.")
        XCTAssertFalse(table.cases.isEmpty)

        for testCase in table.cases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now), testCase.name)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone), testCase.name)

            let plan = WorkItems.plan(testCase.items, now: now, calendar: calendar)

            XCTAssertEqual(plan.order.map(\.workID), testCase.expect.order, "order — \(testCase.name)")
            for section in WorkSection.allCases {
                XCTAssertEqual(
                    plan.items(in: section).map(\.workID),
                    testCase.expect.sections[section.rawValue] ?? [],
                    "\(section.rawValue) — \(testCase.name)"
                )
            }
            XCTAssertEqual(plan.openCount, testCase.expect.open, "open — \(testCase.name)")
            XCTAssertEqual(plan.lateCount, testCase.expect.late, "late — \(testCase.name)")
        }
    }

    func testSectionsPartitionTheOrder() throws {
        for testCase in try loadTable().cases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone))
            let plan = WorkItems.plan(testCase.items, now: now, calendar: calendar)
            let grouped = WorkSection.allCases.flatMap { plan.items(in: $0).map(\.workID) }
            XCTAssertEqual(grouped, plan.order.map(\.workID), testCase.name)
            for section in WorkSection.allCases {
                for item in plan.items(in: section) {
                    XCTAssertEqual(plan.sectionOf[item.workID], section, testCase.name)
                }
            }
        }
    }

    func testFilteringPreservesThePlan() throws {
        let now = try XCTUnwrap(ISODate.parse("2026-09-10T12:00:00Z"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let items = [
            FixtureItem(
                id: "late-task",
                origin: "task",
                done: false,
                filed: true,
                dueDate: "2026-09-09T10:00:00Z",
                updatedAt: nil,
                githubRef: nil
            ),
            FixtureItem(
                id: "today-task",
                origin: "task",
                done: false,
                filed: true,
                dueDate: "2026-09-10T10:00:00Z",
                updatedAt: nil,
                githubRef: nil
            ),
            FixtureItem(
                id: "today-issue",
                origin: "issue",
                done: false,
                filed: true,
                dueDate: nil,
                updatedAt: "2026-09-10T11:00:00Z",
                githubRef: nil
            ),
        ]

        let filtered = WorkItems.plan(items, now: now, calendar: calendar)
            .filtered { $0.workID == "today-task" }

        XCTAssertEqual(filtered.order.map(\.workID), ["today-task"])
        XCTAssertEqual(filtered.items(in: .today).map(\.workID), ["today-task"])
        XCTAssertTrue(filtered.items(in: .late).isEmpty)
        XCTAssertEqual(filtered.sectionOf, ["today-task": .today])

        let mineFiltered = WorkItems.plan(items, now: now, calendar: calendar)
            .filtered(by: MineFilter(section: .today, origin: .task))
        XCTAssertEqual(mineFiltered.order.map(\.workID), ["today-task"])
        XCTAssertEqual(mineFiltered.sectionOf, ["today-task": .today])
    }

    // MARK: - Stages (docs/BOARD.md)

    func testStageVocabularyIsTheColumns() throws {
        let stages = try loadTable().stages
        XCTAssertEqual(stages.vocabulary, WorkStage.allCases.map(\.rawValue))
    }

    func testEveryStageCase() throws {
        for testCase in try loadTable().stages.stageCases {
            XCTAssertEqual(WorkItems.stage(of: testCase.item).rawValue, testCase.expect, testCase.name)
        }
    }

    func testEveryWriteCase() throws {
        for testCase in try loadTable().stages.writeCases {
            let stage = try XCTUnwrap(WorkStage(rawValue: testCase.stage), testCase.name)
            let write = WorkItems.write(stage, for: testCase.item)
            switch write {
            case .task(let status):
                XCTAssertEqual(testCase.item.origin, "task", testCase.name)
                XCTAssertEqual(status, testCase.expect.status, testCase.name)
            case .issue(let state, let stateReason, let labels):
                XCTAssertEqual(testCase.item.origin, "issue", testCase.name)
                XCTAssertEqual(state, testCase.expect.state, testCase.name)
                XCTAssertEqual(stateReason, testCase.expect.stateReason, testCase.name)
                XCTAssertEqual(labels, testCase.expect.labels, testCase.name)
            }
        }
    }

    func testEveryHolderCase() throws {
        for testCase in try loadTable().stages.holderCases {
            XCTAssertEqual(
                WorkItems.passesHolderFilter(testCase.item, filter: testCase.filter, agentEmail: testCase.agentEmail),
                testCase.expect,
                testCase.name
            )
        }
    }

    func testEveryTaskFilterCase() throws {
        for testCase in try loadTable().stages.taskFilterCases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now), testCase.name)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone), testCase.name)
            let due = try XCTUnwrap(WorkDueFilter(rawValue: testCase.filter.due), testCase.name)
            let side = try XCTUnwrap(WorkSideFilter(rawValue: testCase.filter.side), testCase.name)
            XCTAssertEqual(
                WorkItems.passesTaskFilter(testCase.item, due: due, side: side, now: now, calendar: calendar),
                testCase.expect,
                testCase.name
            )
        }
    }

    func testEveryBoardCase() throws {
        for testCase in try loadTable().stages.boardCases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now), testCase.name)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone), testCase.name)
            let since = try testCase.finishedSince.map { try XCTUnwrap(ISODate.parse($0), testCase.name) }

            let board = WorkItems.board(testCase.items, now: now, calendar: calendar, finishedSince: since)

            for stage in WorkStage.allCases {
                XCTAssertEqual(
                    board.items(in: stage).map(\.workID),
                    testCase.expect.columns[stage.rawValue] ?? [],
                    "\(stage.rawValue) — \(testCase.name)"
                )
                for item in board.items(in: stage) {
                    XCTAssertEqual(board.stageOf[item.workID], stage, testCase.name)
                }
            }
        }
    }

    // MARK: - Unowned (docs/BOARD.md §Unowned)

    func testEveryUnownedCase() throws {
        for testCase in try loadTable().unowned.cases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now), testCase.name)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone), testCase.name)
            let rows = WorkItems.unowned(testCase.items, now: now, calendar: calendar)
            XCTAssertEqual(rows.map(\.workID), testCase.expect, testCase.name)
        }
    }

    // MARK: - Focus (docs/WORK.md §1)

    func testEveryFocusCase() throws {
        for testCase in try loadTable().focus.cases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now), testCase.name)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone), testCase.name)
            let plan = WorkItems.plan(testCase.items, now: now, calendar: calendar)
            let focus = WorkItems.focus(plan, now: now, calendar: calendar)
            XCTAssertEqual(focus.rows.map(\.workID), testCase.expect.rows, testCase.name)
            XCTAssertEqual(focus.next, testCase.expect.next, testCase.name)
            XCTAssertEqual(focus.lateCount, testCase.expect.lateCount, testCase.name)
            XCTAssertEqual(focus.todayCount, testCase.expect.todayCount, testCase.name)
            let filtered = plan.filtered(by: MineFilter(section: .focus, origin: .all), now: now, calendar: calendar)
            XCTAssertEqual(filtered.order.map(\.workID), testCase.expect.mineFilter, testCase.name)
        }
    }

    // MARK: - The table

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "work-items", withExtension: "json"),
            "fixtures/work-items.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    func testEveryPhaseCase() throws {
        let events = try loadTable().events
        XCTAssertEqual(events.vocabulary, EventPhase.allCases.map(\.rawValue))
        for testCase in events.phaseCases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now), testCase.name)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone), testCase.name)
            XCTAssertEqual(
                WorkItems.eventPhase(eventDate: testCase.eventDate, now: now, calendar: calendar).rawValue,
                testCase.expect,
                testCase.name
            )
            XCTAssertEqual(
                WorkItems.eventDaysUntil(eventDate: testCase.eventDate, now: now, calendar: calendar),
                testCase.daysUntil,
                testCase.name
            )
        }
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let cases: [FixtureCase]
        let stages: FixtureStages
        let events: FixtureEvents
        let unowned: FixtureUnowned
        let focus: FixtureFocus
    }

    private struct FixtureFocus: Decodable {
        let cases: [FocusCase]
    }

    private struct FocusCase: Decodable {
        let name: String
        let now: String
        let timeZone: String
        let items: [FixtureCard]
        let expect: FocusExpectation
    }

    private struct FocusExpectation: Decodable {
        let rows: [String]
        let next: Bool
        let lateCount: Int
        let todayCount: Int
        let mineFilter: [String]
    }

    private struct FixtureUnowned: Decodable {
        let cases: [UnownedCase]
    }

    private struct UnownedCase: Decodable {
        let name: String
        let now: String
        let timeZone: String
        let items: [FixtureCard]
        let expect: [String]
    }

    private struct FixtureEvents: Decodable {
        let vocabulary: [String]
        let phaseCases: [PhaseCase]
    }

    private struct PhaseCase: Decodable {
        let name: String
        let eventDate: String?
        let now: String
        let timeZone: String
        let expect: String
        let daysUntil: Int?
    }

    private struct FixtureStages: Decodable {
        let vocabulary: [String]
        let stageCases: [StageCase]
        let writeCases: [WriteCase]
        let boardCases: [BoardCase]
        let holderCases: [HolderCase]
        let taskFilterCases: [TaskFilterCase]
    }

    private struct TaskFilterCase: Decodable {
        struct Filter: Decodable {
            let due: String
            let side: String
        }
        let name: String
        let now: String
        let timeZone: String
        let item: FixtureCard
        let filter: Filter
        let expect: Bool
    }

    private struct HolderCase: Decodable {
        let name: String
        let item: FixtureCard
        let filter: String
        let agentEmail: String?
        let expect: Bool
    }

    private struct StageCase: Decodable {
        let name: String
        let item: FixtureCard
        let expect: String
    }

    private struct WriteCase: Decodable {
        let name: String
        let item: FixtureCard
        let stage: String
        let expect: WriteExpectation
    }

    private struct WriteExpectation: Decodable {
        let status: String?
        let state: String?
        let stateReason: String?
        let labels: [String]?

        enum CodingKeys: String, CodingKey {
            case status, state, labels
            case stateReason = "state_reason"
        }
    }

    private struct BoardCase: Decodable {
        let name: String
        let now: String
        let timeZone: String
        let finishedSince: String?
        let items: [FixtureCard]
        let expect: BoardExpectation
    }

    private struct BoardExpectation: Decodable {
        let columns: [String: [String]]
    }

    /// A stage or board row: the planning fields are optional because a stage
    /// case names only the half the rule reads.
    private struct FixtureCard: Decodable, WorkHeldCard {
        let id: String
        let origin: String
        let done: Bool?
        let filed: Bool?
        let dueDate: String?
        let updatedAt: String?
        let githubRef: String?
        let status: String?
        let state: String?
        let stateReason: String?
        let labels: [String]?
        let assignee: String?
        let responsibleParty: String?
        let assignees: [String]?

        var workID: String { id }
        var workOrigin: WorkItemOrigin { origin == "issue" ? .issue : .task }
        var workIsDone: Bool { done ?? false }
        var workIsFiled: Bool { filed ?? true }
        var workDueDate: Date? { dueDate.flatMap(ISODate.parse) }
        var workUpdatedAt: Date? { updatedAt.flatMap(ISODate.parse) }
        var workGithubRef: String? { githubRef }
        var workTaskStatus: String? { status }
        var workIssueState: String? { state }
        var workIssueStateReason: String? { stateReason }
        var workLabels: [String] { labels ?? [] }
        var workAssignee: String? { assignee }
        var workResponsibleParty: String? { responsibleParty }
        var workAssignees: [String] { assignees ?? [] }
    }

    private struct FixtureCase: Decodable {
        let name: String
        let now: String
        let timeZone: String
        let items: [FixtureItem]
        let expect: FixtureExpectation
    }

    private struct FixtureExpectation: Decodable {
        let order: [String]
        let sections: [String: [String]]
        let open: Int
        let late: Int
    }

    /// The neutral shape the table is written in. Conforming it here rather
    /// than reusing a wire type keeps the table about the rules, and keeps a
    /// decoding bug in one client from looking like a rules failure in both.
    private struct FixtureItem: Decodable, WorkCard {
        let id: String
        let origin: String
        let done: Bool
        let filed: Bool
        let dueDate: String?
        let updatedAt: String?
        let githubRef: String?

        var workID: String { id }
        var workOrigin: WorkItemOrigin { origin == "issue" ? .issue : .task }
        var workIsDone: Bool { done }
        var workIsFiled: Bool { filed }
        var workDueDate: Date? { dueDate.flatMap(ISODate.parse) }
        var workUpdatedAt: Date? { updatedAt.flatMap(ISODate.parse) }
        var workGithubRef: String? { githubRef }
        var workTaskStatus: String? { nil }
        var workIssueState: String? { nil }
        var workIssueStateReason: String? { nil }
        var workLabels: [String] { [] }
    }
}
