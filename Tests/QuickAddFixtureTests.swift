import XCTest
@testable import Starlings

/// The shared quick-add grammar (`fixtures/quick-add.json`, meet#235), run
/// by both test targets: one grammar, two parsers, and the Worker's suite
/// reads the same file.
final class QuickAddFixtureTests: XCTestCase {
    private struct Table: Decodable {
        let version: Int
        let now: String
        let defaultDurationMinutes: Int
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let input: String
        let expect: Expected
    }

    private struct Expected: Decodable {
        let title: String
        let start: String?
        let end: String?
        let allDay: Bool
        let location: String?
        let invitees: [String]
        let confidence: Double
    }

    func testTheTable() throws {
        let url = try XCTUnwrap(
            Bundle(for: type(of: self)).url(forResource: "quick-add", withExtension: "json"),
            "fixtures/quick-add.json is not in the test bundle — check project.yml."
        )
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
        XCTAssertEqual(table.version, 1)
        let context = CalendarQuickAdd.Context(now: table.now, defaultDurationMinutes: table.defaultDurationMinutes)
        for testCase in table.cases {
            let draft = CalendarQuickAdd.parse(testCase.input, context: context)
            let expected = CalendarQuickAddDraft(
                title: testCase.expect.title,
                start: testCase.expect.start,
                end: testCase.expect.end,
                allDay: testCase.expect.allDay,
                location: testCase.expect.location,
                invitees: testCase.expect.invitees,
                confidence: testCase.expect.confidence
            )
            XCTAssertEqual(draft, expected, testCase.name)
        }
    }
}
