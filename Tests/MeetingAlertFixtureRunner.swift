import Foundation
import XCTest
@testable import Starlings

/// Runs `fixtures/meeting-alerts.json` against `MeetingAlertPlan`. Compiled
/// into both test targets so the two schedulers answer to one table.
enum MeetingAlertFixtureRunner {
    struct Event: MeetingAlertEvent {
        let upcomingID: String
        let upcomingCalendarID: String? = "primary"
        let upcomingTitle: String
        let upcomingStart: Date?
        let upcomingEnd: Date?
        let upcomingIsAllDay: Bool
        let upcomingIsDemoted: Bool
        let alertLaunchURL: URL? = nil
    }

    private struct Table: Decodable {
        let version: Int
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let lead: Int
        let meetings: Meetings
        let expect: [Expected]?
        let expectCount: Int?
        let expectFirst: String?
    }

    private enum Meetings: Decodable {
        case listed([Row])
        case generated(count: Int, everyMinutes: Int, minutes: Int)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let rows = try? container.decode([Row].self) {
                self = .listed(rows)
                return
            }
            let generator = try container.decode(Generator.self)
            self = .generated(count: generator.count, everyMinutes: generator.everyMinutes, minutes: generator.minutes)
        }

        private struct Generator: Decodable {
            let count: Int
            let everyMinutes: Int
            let minutes: Int
        }
    }

    private struct Row: Decodable {
        let id: String
        let startsIn: TimeInterval
        let minutes: Int
        let demoted: Bool?
        let allDay: Bool?
    }

    private struct Expected: Decodable {
        let id: String
        let firesIn: TimeInterval
    }

    static func run(bundle: Bundle, file: StaticString = #filePath, line: UInt = #line) throws {
        let url = try XCTUnwrap(
            bundle.url(forResource: "meeting-alerts", withExtension: "json"),
            "fixtures/meeting-alerts.json is not in the test bundle — check project.yml.",
            file: file,
            line: line
        )
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
        XCTAssertEqual(table.version, 1, file: file, line: line)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for testCase in table.cases {
            let events = events(for: testCase.meetings, now: now)
            let planned = MeetingAlertPlan.plan(meetings: events, now: now, lead: TimeInterval(testCase.lead * 60))
            if let expect = testCase.expect {
                XCTAssertEqual(planned.map(\.eventID), expect.map(\.id), testCase.name, file: file, line: line)
                for (notice, expected) in zip(planned, expect) {
                    XCTAssertEqual(notice.fireAt, now.addingTimeInterval(expected.firesIn), testCase.name, file: file, line: line)
                }
            }
            if let count = testCase.expectCount {
                XCTAssertEqual(planned.count, count, testCase.name, file: file, line: line)
            }
            if let first = testCase.expectFirst {
                XCTAssertEqual(planned.first?.eventID, first, testCase.name, file: file, line: line)
            }
        }
    }

    private static func events(for meetings: Meetings, now: Date) -> [Event] {
        switch meetings {
        case .listed(let rows):
            return rows.map { row in
                let start = now.addingTimeInterval(row.startsIn)
                return Event(
                    upcomingID: row.id,
                    upcomingTitle: row.id,
                    upcomingStart: start,
                    upcomingEnd: start.addingTimeInterval(TimeInterval(row.minutes * 60)),
                    upcomingIsAllDay: row.allDay ?? false,
                    upcomingIsDemoted: row.demoted ?? false
                )
            }
        case .generated(let count, let everyMinutes, let minutes):
            return (0..<count).map { index in
                let start = now.addingTimeInterval(TimeInterval((index + 1) * everyMinutes * 60))
                return Event(
                    upcomingID: "e\(index)",
                    upcomingTitle: "Sync \(index)",
                    upcomingStart: start,
                    upcomingEnd: start.addingTimeInterval(TimeInterval(minutes * 60)),
                    upcomingIsAllDay: false,
                    upcomingIsDemoted: false
                )
            }
        }
    }
}
