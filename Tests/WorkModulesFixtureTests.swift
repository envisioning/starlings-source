import XCTest
@testable import Starlings

/// docs/WORK_MODEL.md, meet#941: the work modules a workspace admin turns on.
/// The table is generated from packages/contracts/src/work-modules.ts; this
/// holds it to fixtures/work-modules.json, which the Worker's suite also reads.
final class WorkModulesFixtureTests: XCTestCase {
    func testTheRegistryMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(table.modules, WorkModule.allCases.map(\.rawValue))
        for module in WorkModule.allCases {
            let spec = try XCTUnwrap(table.specs[module.rawValue], module.rawValue)
            XCTAssertEqual(module.subjectKind?.rawValue, spec.subjectKind, module.rawValue)
            XCTAssertEqual(module.availableOnCore, spec.stores.contains("core"), module.rawValue)
            XCTAssertEqual(module.availableOnD1, spec.stores.contains("d1"), module.rawValue)
            XCTAssertEqual(module.isCommercial, spec.commercial, module.rawValue)
        }
    }

    func testEachKindIsGatedByTheFixturesWorkModule() throws {
        for row in try loadTable().gates {
            let kind = try XCTUnwrap(MeetingCategoryKind.SubjectKind(rawValue: row.kind), row.kind)
            XCTAssertEqual(WorkModule.gating(kind)?.rawValue, row.module, row.kind)
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "work-modules", withExtension: "json"),
            "fixtures/work-modules.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let modules: [String]
        let specs: [String: FixtureSpec]
        let gates: [FixtureGate]
    }

    private struct FixtureSpec: Decodable {
        let subjectKind: String?
        let stores: [String]
        let commercial: Bool
    }

    private struct FixtureGate: Decodable {
        let kind: String
        let module: String?
    }
}
