import XCTest
@testable import Starlings

final class BrowseGroupsFixtureTests: XCTestCase {
    func testTheRegistryMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(table.order, BrowseGroupRegistry.order.map(\.rawValue))
        XCTAssertEqual(Set(table.groups.keys), Set(SubjectGroup.allCases.map(\.rawValue)))
        for group in SubjectGroup.allCases {
            let expected = try XCTUnwrap(table.groups[group.rawValue], group.rawValue)
            let actual = BrowseGroupRegistry.spec(for: group)
            XCTAssertEqual(actual.subjectKind.rawValue, expected.subjectKind, group.rawValue)
            XCTAssertEqual(actual.list?.rawValue, expected.list, group.rawValue)
            XCTAssertEqual(actual.startsCollapsed, expected.startsCollapsed, group.rawValue)
            XCTAssertEqual(actual.needsSales, expected.needsSales, group.rawValue)
            XCTAssertEqual(actual.preferenceKey, expected.preferenceKey, group.rawValue)
        }
    }

    func testSalesOnlyShowsWithSalesOn() throws {
        for row in try loadTable().shown {
            let group = try XCTUnwrap(SubjectGroup(rawValue: row.group), row.group)
            XCTAssertEqual(BrowseGroupRegistry.isShown(group, salesEnabled: row.salesEnabled), row.out, "\(row.group) \(row.salesEnabled)")
        }
    }

    func testTheSavedKeysAreTheOnesTheMacAlreadyUses() {
        XCTAssertEqual(WorkSidebarPreferences.browseKeys, BrowseGroupRegistry.order.map { BrowseGroupRegistry.spec(for: $0).preferenceKey })
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "browse-groups", withExtension: "json"),
            "fixtures/browse-groups.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let order: [String]
        let groups: [String: FixtureGroup]
        let shown: [FixtureShown]
    }

    private struct FixtureShown: Decodable {
        let group: String
        let salesEnabled: Bool
        let out: Bool
    }

    private struct FixtureGroup: Decodable {
        let subjectKind: String
        let list: String?
        let startsCollapsed: Bool
        let needsSales: Bool
        let preferenceKey: String
    }
}
