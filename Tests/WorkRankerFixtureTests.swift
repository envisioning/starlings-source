import XCTest
@testable import Starlings

/// Holds the Swift ranker to `fixtures/work-ranker.json`, which is written from the TypeScript
/// ranker (`packages/contracts/src/work-ranker.ts`) — the source of truth.
final class WorkRankerFixtureTests: XCTestCase {
    func testTheDefaultCriteriaMatchTheFixture() throws {
        let table = try loadTable()
        let criteria = WorkRankCriteria.default
        let expected = table.criteria
        XCTAssertEqual(criteria.railLimit, expected.railLimit)
        XCTAssertEqual(criteria.starred, expected.starred)
        XCTAssertEqual(criteria.directAttention, expected.directAttention)
        XCTAssertEqual(criteria.unread, expected.unread)
        XCTAssertEqual(criteria.overduePerTask, expected.overduePerTask)
        XCTAssertEqual(criteria.overdueCap, expected.overdueCap)
        XCTAssertEqual(criteria.eventToday, expected.eventToday)
        XCTAssertEqual(criteria.eventSoonBase, expected.eventSoonBase)
        XCTAssertEqual(criteria.eventSoonDecayPerDay, expected.eventSoonDecayPerDay)
        XCTAssertEqual(criteria.eventHorizonDays, expected.eventHorizonDays)
        XCTAssertEqual(criteria.openWorkPerTask, expected.openWorkPerTask)
        XCTAssertEqual(criteria.openWorkCap, expected.openWorkCap)
        XCTAssertEqual(criteria.recentActivityMax, expected.recentActivityMax)
        XCTAssertEqual(criteria.activityHalfLife * 1_000, expected.activityHalfLifeMs)
        XCTAssertEqual(criteria.staleAfter * 1_000, expected.staleAfterMs)
        XCTAssertEqual(criteria.staleWork, expected.staleWork)
    }

    func testTheRankingMatchesTheFixture() throws {
        let table = try loadTable()
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: table.now))
        for row in table.cases {
            let subjects = row.subjects.map { subject in
                CrmSubject(
                    id: subject.id,
                    kind: subject.kind,
                    title: subject.title,
                    subtitle: nil,
                    openTasks: subject.openTasks ?? 0,
                    overdueTasks: subject.overdueTasks ?? 0,
                    lastActivityAt: subject.lastActivityAt,
                    eventDate: subject.eventDate
                )
            }
            let signals = row.signals.mapValues {
                WorkRankSignals(starred: $0.starred ?? false, directAttention: $0.directAttention ?? false, unread: $0.unread ?? false)
            }
            let ranked = WorkSubjectRanker.rank(subjects, signals: signals, now: now)
            XCTAssertEqual(ranked.map(\.subject.id), row.order, row.name)
            XCTAssertEqual(WorkSubjectRanker.rail(subjects, signals: signals, now: now).map(\.subject.id), row.rail, row.name)
            for entry in ranked {
                XCTAssertEqual(entry.score, try XCTUnwrap(row.scores[entry.subject.id]), accuracy: 0.001, "\(row.name): \(entry.subject.id)")
            }
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "work-ranker", withExtension: "json"),
            "fixtures/work-ranker.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let now: String
        let criteria: Criteria
        let cases: [Row]
    }

    private struct Criteria: Decodable {
        let railLimit: Int
        let starred: Double
        let directAttention: Double
        let unread: Double
        let overduePerTask: Double
        let overdueCap: Int
        let eventToday: Double
        let eventSoonBase: Double
        let eventSoonDecayPerDay: Double
        let eventHorizonDays: Int
        let openWorkPerTask: Double
        let openWorkCap: Int
        let recentActivityMax: Double
        let activityHalfLifeMs: Double
        let staleAfterMs: Double
        let staleWork: Double
    }

    private struct Row: Decodable {
        let name: String
        let subjects: [Subject]
        let signals: [String: Signals]
        let order: [String]
        let rail: [String]
        let scores: [String: Double]
    }

    private struct Subject: Decodable {
        let id: String
        let title: String
        let kind: String
        let openTasks: Int?
        let overdueTasks: Int?
        let lastActivityAt: String?
        let eventDate: String?

        enum CodingKeys: String, CodingKey {
            case id, title, kind
            case openTasks = "open_tasks"
            case overdueTasks = "overdue_tasks"
            case lastActivityAt = "last_activity_at"
            case eventDate = "event_date"
        }
    }

    private struct Signals: Decodable {
        let starred: Bool?
        let directAttention: Bool?
        let unread: Bool?

        enum CodingKeys: String, CodingKey {
            case starred, unread
            case directAttention = "direct_attention"
        }
    }
}
