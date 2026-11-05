import XCTest
@testable import Starlings

final class SubjectContextFixtureTests: XCTestCase {
    func testTheRegistryMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(table.blocks, SubjectContextBlock.allCases.map(\.rawValue))
        XCTAssertEqual(Set(table.layout.keys), Set(MeetingCategoryKind.SubjectKind.allCases.map(\.rawValue)))
        for kind in MeetingCategoryKind.SubjectKind.allCases {
            let expected = try XCTUnwrap(table.layout[kind.rawValue], kind.rawValue)
            XCTAssertEqual((SubjectContextRegistry.layout[kind] ?? []).map(\.rawValue), expected, kind.rawValue)
            let resolved = try XCTUnwrap(table.resolved[kind.rawValue], kind.rawValue)
            for client in SubjectContextClient.allCases {
                XCTAssertEqual(
                    SubjectContextRegistry.blocks(for: kind, client: client).map(\.rawValue),
                    resolved[client.rawValue],
                    "\(kind.rawValue).\(client.rawValue)"
                )
            }
        }
        for (block, clients) in table.notOn {
            let actual = SubjectContextRegistry.notOn[try XCTUnwrap(SubjectContextBlock(rawValue: block), block)]
            XCTAssertEqual(actual.map { Set($0.map(\.rawValue)) }, Set(clients), block)
        }
        XCTAssertEqual(table.notOn.count, SubjectContextRegistry.notOn.count)
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "subject-context", withExtension: "json"),
            "fixtures/subject-context.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let blocks: [String]
        let layout: [String: [String]]
        let notOn: [String: [String]]
        let resolved: [String: [String: [String]]]
    }
}
