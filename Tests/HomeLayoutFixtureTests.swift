import XCTest
@testable import Starlings

/// The shared table, run against the Swift implementation. The TypeScript port
/// runs the same file (`services/control-plane/test/home-layout.test.ts`),
/// which is the whole point: three surfaces drawing Home in three orders is
/// the drift this table exists to prevent.
///
/// A failure here is a question about `fixtures/home-layout.json` first — the
/// rules live there, and both implementations answer to it.
final class HomeLayoutFixtureTests: XCTestCase {
    func testModulesMatchTheTable() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1, "The fixture changed shape; re-read its rules before touching this.")
        XCTAssertEqual(table.modules.map(\.id), HomeModuleID.allCases.map(\.rawValue))
        for (fixture, code) in zip(table.modules, HomeLayout.modules) {
            XCTAssertEqual(fixture.id, code.id.rawValue)
            XCTAssertEqual(fixture.title, code.title, fixture.id)
            XCTAssertEqual(fixture.detail, code.detail, fixture.id)
            XCTAssertEqual(fixture.enabledByDefault, code.enabledByDefault, fixture.id)
            XCTAssertEqual(fixture.rows, code.rows, fixture.id)
            XCTAssertEqual(fixture.canHide, code.canHide, fixture.id)
            XCTAssertEqual(fixture.showsEmpty, code.showsEmpty, fixture.id)
        }
    }

    func testEveryFixtureCase() throws {
        let table = try loadTable()
        XCTAssertFalse(table.cases.isEmpty)
        for testCase in table.cases {
            let resolved = HomeLayout.resolve(testCase.stored)
            XCTAssertEqual(resolved, testCase.expect, testCase.name)
            // Resolving a resolved list changes nothing.
            XCTAssertEqual(HomeLayout.resolve(resolved), resolved, testCase.name)
        }
    }

    func testPackCases() throws {
        let table = try loadTable()
        XCTAssertFalse(table.packCases.isEmpty)
        for testCase in table.packCases {
            let modules = testCase.modules.compactMap(HomeModuleID.init(rawValue:))
            var heights: [HomeModuleID: CGFloat] = [:]
            for (id, height) in testCase.heights {
                if let module = HomeModuleID(rawValue: id) { heights[module] = CGFloat(height) }
            }
            let packed = HomeLayout.packColumns(modules, heights: heights, gap: CGFloat(testCase.gap))
            XCTAssertEqual(modules.filter { packed[$0] == true }.map(\.rawValue), testCase.expectRight, testCase.name)
            XCTAssertFalse(HomeLayout.columnsLopsided(modules, heights: heights, assignment: packed, gap: CGFloat(testCase.gap)), testCase.name)
        }
    }

    func testLopsidedCases() throws {
        let table = try loadTable()
        XCTAssertFalse(table.lopsidedCases.isEmpty)
        for testCase in table.lopsidedCases {
            var heights: [HomeModuleID: CGFloat] = [:]
            for (id, height) in testCase.heights {
                if let module = HomeModuleID(rawValue: id) { heights[module] = CGFloat(height) }
            }
            var assignment: [HomeModuleID: Bool] = [:]
            for id in testCase.left { if let module = HomeModuleID(rawValue: id) { assignment[module] = false } }
            for id in testCase.right { if let module = HomeModuleID(rawValue: id) { assignment[module] = true } }
            let lopsided = HomeLayout.columnsLopsided(Array(heights.keys), heights: heights, assignment: assignment, gap: CGFloat(testCase.gap))
            XCTAssertEqual(lopsided, testCase.expect, testCase.name)
        }
    }

    func testRecentMergeCases() throws {
        let table = try loadTable()
        XCTAssertFalse(table.recentMergeCases.isEmpty)
        for testCase in table.recentMergeCases {
            let merged = HomeLayout.mergeRecentRows(
                try searchRows(testCase.recent),
                starredRows: try searchRows(testCase.starred)
            )
            XCTAssertEqual(merged.map(\.key), testCase.expect.map { "\($0.kind):\($0.id)" }, testCase.name)
        }
    }

    func testInboxOrderMatchesTheTable() throws {
        let table = try loadTable()
        XCTAssertFalse(table.inboxOrderCases.isEmpty)
        for testCase in table.inboxOrderCases {
            let ordered = HomeLayout.orderInbox(testCase.rows, pinned: \.pinned, at: \.at)
            XCTAssertEqual(ordered.map(\.id), testCase.expect, testCase.name)
        }
    }

    func testVisibleCases() throws {
        let table = try loadTable()
        XCTAssertFalse(table.visibleCases.isEmpty)
        for testCase in table.visibleCases {
            let workModules = testCase.workModules.map { $0.compactMap(WorkModule.init(rawValue:)) }
            XCTAssertEqual(
                HomeLayout.visible(HomeLayout.resolve(nil), workModules: workModules).map(\.rawValue),
                testCase.expect,
                testCase.name
            )
        }
    }

    func testOfferedCases() throws {
        let table = try loadTable()
        XCTAssertFalse(table.offeredCases.isEmpty)
        for testCase in table.offeredCases {
            let workModules = testCase.workModules.map { $0.compactMap(WorkModule.init(rawValue:)) }
            XCTAssertEqual(
                HomeLayout.offered(HomeLayout.resolve(testCase.stored), workModules: workModules).map(\.id.rawValue),
                testCase.expect, testCase.name
            )
        }
    }

    func testMoveCases() throws {
        let table = try loadTable()
        XCTAssertFalse(table.moveCases.isEmpty)
        for testCase in table.moveCases {
            let workModules = testCase.workModules.map { $0.compactMap(WorkModule.init(rawValue:)) }
            let layout = HomeLayout.resolve(testCase.layout)
            let id = try XCTUnwrap(HomeModuleID(rawValue: testCase.id))
            let next = HomeLayout.move(layout, id, testCase.direction == "up" ? .up : .down, workModules: workModules)
            XCTAssertEqual(next.map(\.id.rawValue), testCase.expect, testCase.name)
            for row in next { XCTAssertEqual(row.enabled, layout.first { $0.id == row.id }?.enabled) }
        }
    }

    func testShowCases() throws {
        let table = try loadTable()
        XCTAssertFalse(table.showCases.isEmpty)
        for testCase in table.showCases {
            let content = Set(testCase.content.compactMap(HomeModuleID.init(rawValue:)))
            let drawn = HomeLayout.visible(HomeLayout.resolve(nil)).filter {
                HomeLayout.draws($0, hasContent: content.contains($0))
            }
            XCTAssertEqual(drawn.map(\.rawValue), testCase.expect, testCase.name)
        }
    }

    func testVisibleAndMove() {
        let layout = HomeLayout.resolve([
            HomeModuleSettingWire(id: "agenda", enabled: true),
            HomeModuleSettingWire(id: "notes", enabled: false),
        ])
        XCTAssertEqual(layout.map(\.id), [.messages, .work, .commercial, .agenda, .events, .room, .notes, .recent])
        XCTAssertEqual(HomeLayout.visible(layout), [.messages, .work, .commercial, .agenda, .events, .room, .recent])
        XCTAssertEqual(
            HomeLayout.move(layout, .agenda, .up).map(\.id),
            [.messages, .work, .agenda, .commercial, .events, .room, .notes, .recent]
        )
        XCTAssertEqual(HomeLayout.move(layout, .messages, .up).map(\.id), layout.map(\.id))
        XCTAssertEqual(HomeLayout.move(layout, .notes, .down).map(\.id), layout.map(\.id))
        XCTAssertEqual(HomeLayout.move(layout, .recent, .up).map(\.id), layout.map(\.id))
    }

    func testWireRoundTrip() throws {
        let json = Data(#"{"modules":[{"id":"room","enabled":false},{"id":"later","enabled":true}],"updated_at":12}"#.utf8)
        let response = try JSONDecoder().decode(HomePreferencesResponse.self, from: json)
        XCTAssertEqual(response.updatedAt, 12)
        XCTAssertEqual(response.layout.map(\.id), [.messages, .work, .commercial, .notes, .agenda, .events, .room, .recent])
        XCTAssertTrue(response.layout.first(where: { $0.id == .room })?.enabled == true, "the room cannot be hidden")

        let update = HomePreferencesUpdate(response.layout)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(update)) as? [String: Any]
        let modules = try XCTUnwrap(encoded?["modules"] as? [[String: Any]])
        XCTAssertEqual(modules.count, HomeModuleID.allCases.count)
        XCTAssertEqual(modules.first?["id"] as? String, "messages")
    }

    func testCacheSurvivesAnUnknownModule() {
        let suite = "HomeLayoutFixtureTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(HomeLayoutCache.load(defaults: defaults), HomeLayout.defaults)
        let layout = HomeLayout.move(HomeLayout.defaults, .agenda, .up)
        HomeLayoutCache.store(layout, defaults: defaults)
        XCTAssertEqual(HomeLayoutCache.load(defaults: defaults), layout)
    }

    // MARK: - The table

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "home-layout", withExtension: "json"),
            "fixtures/home-layout.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let modules: [FixtureModule]
        let cases: [FixtureCase]
        let recentMergeCases: [FixtureRecentMergeCase]
        let packCases: [FixturePackCase]
        let lopsidedCases: [FixtureLopsidedCase]
        let inboxOrderCases: [FixtureInboxOrderCase]
        let visibleCases: [FixtureVisibleCase]
        let offeredCases: [FixtureOfferedCase]
        let moveCases: [FixtureMoveCase]
        let showCases: [FixtureShowCase]
    }

    private struct FixtureOfferedCase: Decodable {
        let name: String
        let stored: [HomeModuleSettingWire]?
        let workModules: [String]?
        let expect: [String]
    }

    private struct FixtureMoveCase: Decodable {
        let name: String
        let layout: [HomeModuleSettingWire]?
        let workModules: [String]?
        let id: String
        let direction: String
        let expect: [String]
    }

    private struct FixtureShowCase: Decodable {
        let name: String
        let content: [String]
        let expect: [String]
    }

    private struct FixtureVisibleCase: Decodable {
        let name: String
        let workModules: [String]?
        let expect: [String]
    }

    private struct FixtureInboxOrderCase: Decodable {
        let name: String
        let rows: [FixtureInboxRow]
        let expect: [String]
    }

    private struct FixtureInboxRow: Decodable {
        let id: String
        let pinned: Bool
        let at: Double
    }

    private struct FixtureLopsidedCase: Decodable {
        let name: String
        let gap: Double
        let heights: [String: Double]
        let left: [String]
        let right: [String]
        let expect: Bool
    }

    private struct FixturePackCase: Decodable {
        let name: String
        let gap: Double
        let modules: [String]
        let heights: [String: Double]
        let expectRight: [String]
    }

    private struct FixtureModule: Decodable {
        let id: String
        let title: String
        let detail: String
        let enabledByDefault: Bool
        let rows: Int?
        let canHide: Bool
        let showsEmpty: Bool
    }

    private struct FixtureCase: Decodable {
        let name: String
        let stored: [HomeModuleSettingWire]?
        let expect: [HomeModuleSetting]
    }

    private struct FixtureRecentMergeCase: Decodable {
        let name: String
        let starred: [FixtureSearchKey]
        let recent: [FixtureSearchKey]
        let expect: [FixtureSearchKey]
    }

    private struct FixtureSearchKey: Decodable {
        let kind: String
        let id: String
    }

    private func searchRows(_ keys: [FixtureSearchKey]) throws -> [SearchRow] {
        try keys.map { key in
            guard let kind = SearchKind(rawValue: key.kind) else {
                throw FixtureError.unknownSearchKind(key.kind)
            }
            let door: SearchDoor
            switch kind {
            case .person: door = .person(id: key.id)
            case .thread: door = .thread(id: key.id)
            default: throw FixtureError.unsupportedSearchKind(key.kind)
            }
            return SearchRow(kind: kind, id: key.id, title: key.id, subtitle: "", door: door)
        }
    }

    private enum FixtureError: Error {
        case unknownSearchKind(String)
        case unsupportedSearchKind(String)
    }
}
