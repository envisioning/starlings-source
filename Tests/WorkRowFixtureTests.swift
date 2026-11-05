import XCTest
@testable import Starlings

/// The shared table, run against `WorkSubjectRowSpec`, which both the Mac's
/// `WorkSidebarRowView.subject` and the phone's `WorkSidebarRow.subject`
/// build from. Runs on both test targets (project.yml), so a row state that
/// reads differently on one platform is a failing test, not a doc note.
///
/// A failure here is a question about `fixtures/work-rows.json` first.
final class WorkRowFixtureTests: XCTestCase {
    func testEveryCase() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 2, "The fixture changed shape; re-read its rules before touching this.")
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            let spec = WorkSubjectRowSpec(
                title: row.title, hasUnread: row.hasUnread, isStarred: row.isStarred,
                isMuted: row.isMuted, isSubdued: row.isSubdued
            )
            XCTAssertEqual(spec.showsUnread, row.expect.showsUnread, "showsUnread — \(row.name)")
            XCTAssertEqual(spec.showsStarBadge, row.expect.showsStarBadge, "showsStarBadge — \(row.name)")
            XCTAssertEqual(spec.weight, row.expect.weight, "weight — \(row.name)")
            XCTAssertEqual(spec.ink, row.expect.ink, "ink — \(row.name)")
            XCTAssertEqual(spec.trailing, row.expect.trailing, "trailing — \(row.name)")
            XCTAssertEqual(spec.accessibilityLabel, row.expect.accessibilityLabel, "label — \(row.name)")
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "work-rows", withExtension: "json"),
            "fixtures/work-rows.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let cases: [FixtureCase]
    }

    private struct FixtureCase: Decodable {
        let name: String
        let title: String
        let hasUnread: Bool
        let isStarred: Bool
        let isMuted: Bool
        let isSubdued: Bool
        let expect: Expect
    }

    private struct Expect: Decodable {
        let showsUnread: Bool
        let showsStarBadge: Bool
        let weight: WorkSubjectRowSpec.Weight
        let ink: WorkSubjectRowSpec.Ink
        let trailing: WorkSubjectRowSpec.Trailing
        let accessibilityLabel: String
    }
}
