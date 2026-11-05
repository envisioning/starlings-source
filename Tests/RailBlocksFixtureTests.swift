import XCTest
@testable import Starlings

final class RailBlocksFixtureTests: XCTestCase {
    func testTheRegistryMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(Set(table.blocks.keys), Set(RailSurface.allCases.map(\.rawValue)))
        for surface in RailSurface.allCases {
            let expected = try XCTUnwrap(table.blocks[surface.rawValue], surface.rawValue)
            let actual = try XCTUnwrap(RailBlockRegistry.blocks[surface], surface.rawValue)
            XCTAssertEqual(actual.map(\.id), expected.map(\.id), surface.rawValue)
            XCTAssertEqual(actual.map(\.key), expected.map(\.key), surface.rawValue)
            XCTAssertEqual(actual.map(\.hidesWhenEmpty), expected.map(\.hidesWhenEmpty), surface.rawValue)
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "rail-blocks", withExtension: "json"),
            "fixtures/rail-blocks.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let blocks: [String: [FixtureBlock]]
    }

    private struct FixtureBlock: Decodable {
        let id: String
        let key: String
        let hidesWhenEmpty: Bool
    }
}
