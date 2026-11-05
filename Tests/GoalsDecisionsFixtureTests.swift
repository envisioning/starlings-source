import XCTest
import StarlingsContracts
@testable import Starlings

/// The shared table, run against the Swift implementation. The TypeScript
/// port runs the same file (`services/control-plane/test/goals-decisions.test.ts`).
/// A failure here is a question about `fixtures/goals-decisions.json` first.
final class GoalsDecisionsFixtureTests: XCTestCase {
    func testLate() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1, "The fixture changed shape; re-read its rules before touching this.")
        XCTAssertFalse(table.late.isEmpty)
        for row in table.late {
            XCTAssertEqual(GoalsDecisions.isLate(goal(row.goal), now: table.now, calendar: table.calendar), row.expect, row.name)
        }
    }

    func testLive() throws {
        let table = try loadTable()
        for row in table.live {
            XCTAssertEqual(GoalsDecisions.isLive(goal(row.goal)), row.expect, row.name)
        }
    }

    func testOrder() throws {
        let table = try loadTable()
        for row in table.order {
            let sorted = GoalsDecisions.sorted(row.goals.map(goal), now: table.now, calendar: table.calendar)
            XCTAssertEqual(sorted.map(\.id), row.expect, row.name)
        }
    }

    private func goal(_ row: FixtureGoal) -> CrmGoal {
        CrmGoal(
            id: row.id ?? "g", projectID: "p", title: row.title ?? "",
            status: GoalStatus(rawValue: row.status), targetDate: row.targetDate,
            createdAt: row.createdAt ?? "2026-09-01T00:00:00Z", updatedAt: row.updatedAt
        )
    }

    private struct FixtureGoal: Decodable {
        let id: String?
        let status: String
        let targetDate: String?
        let title: String?
        let createdAt: String?
        let updatedAt: String?
        enum CodingKeys: String, CodingKey {
            case id, status, title
            case targetDate = "target_date"
            case createdAt = "created_at"
            case updatedAt = "updated_at"
        }
    }

    private struct LateCase: Decodable { let name: String; let goal: FixtureGoal; let expect: Bool }
    private struct OrderCase: Decodable { let name: String; let goals: [FixtureGoal]; let expect: [String] }

    private struct FixtureTable: Decodable {
        let version: Int
        let today: String
        let timeZone: String
        let late: [LateCase]
        let live: [LateCase]
        let order: [OrderCase]
        enum CodingKeys: String, CodingKey { case version, today, late, live, order; case timeZone = "time_zone" }

        var now: Date {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: today) ?? .distantPast
        }
        var calendar: Calendar {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: timeZone) ?? .gmt
            return calendar
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "goals-decisions", withExtension: "json"),
            "fixtures/goals-decisions.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }
}
