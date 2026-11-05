import XCTest
@testable import Starlings

/// iOS draws the Docs and Team rails from the shared table (`RailBlockRegistry`, decided in
/// `packages/contracts/src/rail-blocks.ts`). These pin that the blocks the phone knows how to draw
/// are the table's rows, in its order, and that a reorder in the table reorders the phone.
final class MobileRailBlocksTests: XCTestCase {
    func testTheDocsRailDrawsEveryRowOfTheTableInItsOrder() throws {
        let table = try XCTUnwrap(RailBlockRegistry.blocks[.docs])
        XCTAssertEqual(MobileDocsBlock.allCases.map(\.rawValue).sorted(), table.map(\.id).sorted())
        XCTAssertEqual(MobileRail.blocks(MobileDocsBlock.self).map(\.block), table)
    }

    func testTheTeamRailDrawsEveryRowOfTheTableInItsOrder() throws {
        let table = try XCTUnwrap(RailBlockRegistry.blocks[.team])
        XCTAssertEqual(MobileTeamBlock.allCases.map(\.rawValue).sorted(), table.map(\.id).sorted())
        XCTAssertEqual(MobileRail.blocks(MobileTeamBlock.self).map(\.block), table)
    }

    func testAnEmptyBlockIsLeftOutOnlyWhenTheTableHidesItWhileEmpty() throws {
        // Every block empty: what is left is exactly the blocks the table keeps.
        let docs = try XCTUnwrap(RailBlockRegistry.blocks[.docs])
        XCTAssertEqual(
            MobileRail.blocks(MobileDocsBlock.self, empty: Set(MobileDocsBlock.allCases)).map(\.block.id),
            docs.filter { !$0.hidesWhenEmpty }.map(\.id)
        )
        let team = try XCTUnwrap(RailBlockRegistry.blocks[.team])
        XCTAssertEqual(
            MobileRail.blocks(MobileTeamBlock.self, empty: Set(MobileTeamBlock.allCases)).map(\.block.id),
            team.filter { !$0.hidesWhenEmpty }.map(\.id)
        )
        // The Docs library stays while empty (a mirror that failed to load says so inside it).
        XCTAssertTrue(MobileRail.blocks(MobileDocsBlock.self, empty: [.library]).contains { $0.kind == .library })
        XCTAssertFalse(MobileRail.blocks(MobileDocsBlock.self, empty: [.folders]).contains { $0.kind == .folders })
    }

    func testReorderingTheTableReordersTheRail() throws {
        let table = try XCTUnwrap(RailBlockRegistry.blocks[.team])
        let reordered = Array(table.reversed())
        XCTAssertEqual(
            MobileRail.blocks(MobileTeamBlock.self, table: reordered).map(\.block.id),
            reordered.map(\.id)
        )
    }

    func testAFoldIsKeptUnderTheTablesKeyAsTheMacKeepsIt() throws {
        let people = RailBlockRegistry.block(.team, "people")
        XCTAssertEqual(people.foldDefaultsKey, "meet.sidebarFold.team.people")
    }
}
