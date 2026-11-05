import XCTest
@testable import Starlings

final class SubjectStatusFixtureTests: XCTestCase {
    func testTheRegistryMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(Set(table.kinds.keys), ["project", "lead"])
        for (name, expected) in table.kinds {
            let kind = try XCTUnwrap(MeetingCategoryKind.SubjectKind(rawValue: name), name)
            let actual = try XCTUnwrap(SubjectStatusRegistry.choices(for: kind), name)
            XCTAssertEqual(actual.statuses, expected.statuses, name)
            XCTAssertEqual(actual.open, expected.open, name)
            XCTAssertEqual(actual.filter, expected.filter, name)
            XCTAssertEqual(actual.defaultFilter, expected.defaultFilter, name)
            XCTAssertEqual(actual.defaultStatus, expected.defaultStatus, name)
        }
        XCTAssertNil(SubjectStatusRegistry.choices(for: .organization))
        XCTAssertNil(SubjectStatusRegistry.choices(for: .event))
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "subject-status", withExtension: "json"),
            "fixtures/subject-status.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let kinds: [String: FixtureChoices]
    }

    private struct FixtureChoices: Decodable {
        let statuses: [String]
        let open: [String]
        let filter: [String]
        let defaultFilter: String
        let defaultStatus: String
    }
}
