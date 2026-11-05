import XCTest
@testable import Starlings

/// Holds the Swift settings registry to `fixtures/settings-pages.json`, which is generated from
/// `packages/contracts/src/settings-pages.ts` like the registry's own table: the same pages,
/// groups and order, and the same Mac and iOS surfaces. The web is not in the Swift registry; it
/// reads the TypeScript table. What the declarations of `StarlingsSettingID` and `SearchSettingsPage`
/// name is held to the fixture here too.
final class SettingsPagesFixtureTests: XCTestCase {
    func testTheNativeRegistryMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(StarlingsSettingsGroup.allCases.map(\.rawValue), table.groups.map(\.id))
        for (group, expected) in zip(StarlingsSettingsGroup.allCases, table.groups) {
            XCTAssertEqual(group.title, expected.title, expected.id)
        }
        let actual = StarlingsSettingID.allCases
        XCTAssertEqual(actual.map { "\($0)" }, table.pages.map(\.id))
        for (id, expected) in zip(actual, table.pages) {
            let definition = StarlingsSettingsRegistry.definition(for: id)
            XCTAssertEqual(definition.group.rawValue, expected.group, expected.id)
            XCTAssertEqual(definition.surfaces.contains(.macSettingsSidebar), expected.clients.contains("mac"), expected.id)
            XCTAssertEqual(definition.surfaces.contains(.iosSettings), expected.clients.contains("ios"), expected.id)
            XCTAssertEqual(definition.surfaces.contains(.iosCalendarSettings), expected.iosCalendarSettings ?? false, expected.id)
        }
    }

    func testSearchDoorsAreThePagesEveryClientLists() throws {
        let table = try loadTable()
        XCTAssertEqual(table.everywhere, table.pages.filter { Set($0.clients) == ["mac", "ios", "web"] }.map(\.id))
        XCTAssertEqual(SearchSettingsPage.allCases.map(\.rawValue), table.everywhere)
        for page in SearchSettingsPage.allCases {
            XCTAssertNotNil(StarlingsSettingID.allCases.first { "\($0)" == page.rawValue }, page.rawValue)
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "settings-pages", withExtension: "json"),
            "fixtures/settings-pages.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let groups: [Group]
        let pages: [Page]
        let everywhere: [String]
    }

    private struct Group: Decodable {
        let id: String
        let title: String
    }

    private struct Page: Decodable {
        let id: String
        let group: String
        let clients: [String]
        let iosCalendarSettings: Bool?
    }
}
