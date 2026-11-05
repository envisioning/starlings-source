import XCTest
@testable import Starlings

/// The shared table, run against the Swift implementation. The TypeScript
/// port runs the same file (`services/control-plane/test/search.test.ts`),
/// which is the whole point: five search fields on three surfaces matching on
/// five rules is the drift this table exists to prevent.
///
/// A failure here is a question about `fixtures/search-rows.json` first — the
/// rules live there, and both implementations answer to it.
final class SearchFixtureTests: XCTestCase {
    func testTablesMatchTheCode() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1, "The fixture changed shape; re-read its rules before touching this.")
        XCTAssertEqual(table.kinds, Search.kinds.map(\.rawValue))
        XCTAssertEqual(table.hitKinds, Search.hitKinds.map(\.rawValue))
        XCTAssertEqual(table.doorKinds, Search.doorKinds.map(\.rawValue))
        XCTAssertEqual(table.destinations, SearchDestination.allCases.map(\.rawValue))
        XCTAssertEqual(table.settingsPages, SearchSettingsPage.allCases.map(\.rawValue))
        XCTAssertEqual(table.verbs, SearchVerb.allCases.map(\.rawValue))
        XCTAssertEqual(table.personVerbs["person"], SearchPersonVerb.allCases.map(\.rawValue))
        for kind in SearchKind.allCases {
            XCTAssertEqual(Search.personVerbs(for: kind).map(\.rawValue), table.personVerbs[kind.rawValue] ?? [], kind.rawValue)
        }
        XCTAssertEqual(table.subjectVerbs["project"], SearchSubjectVerb.allCases.map(\.rawValue))
        for kind in SearchSubjectKind.allCases {
            XCTAssertEqual(Search.subjectVerbs(for: kind).map(\.rawValue), table.subjectVerbs[kind.rawValue] ?? [], kind.rawValue)
        }
        XCTAssertEqual(Set(table.scopes.keys), Set(Search.Scope.allCases.map(\.rawValue)))
        for scope in Search.Scope.allCases {
            XCTAssertEqual(table.scopes[scope.rawValue], scope.kinds.map(\.rawValue), scope.rawValue)
        }
    }

    func testEveryRowInTheCorpusIsARow() throws {
        let table = try loadTable()
        XCTAssertFalse(table.rows.isEmpty)
        XCTAssertEqual(Set(table.rows.map(\.key)).count, table.rows.count, "row keys are unique")
        for row in table.rows {
            XCTAssertEqual(row.door.string, row.doorString, row.key)
        }
    }

    func testEveryDoorReadsAndWrites() throws {
        let table = try loadTable()
        for entry in table.doors {
            let door = try XCTUnwrap(SearchDoor(string: entry.door), entry.door)
            XCTAssertEqual(door.string, entry.door)
            XCTAssertEqual(door, entry.parsed.door, entry.door)
        }
        for bad in table.badDoors {
            XCTAssertNil(SearchDoor(string: bad), "\"\(bad)\" parsed")
            let json = Data(#"{"kind":"verb","id":"x","title":"x","subtitle":"","door":"\#(bad)"}"#.utf8)
            XCTAssertThrowsError(try JSONDecoder().decode(SearchRow.self, from: json), "\"\(bad)\" decoded")
        }
    }

    func testEveryFixtureCase() throws {
        let table = try loadTable()
        XCTAssertFalse(table.cases.isEmpty)
        for testCase in table.cases {
            let scope = try XCTUnwrap(Search.Scope(rawValue: testCase.scope), testCase.name)
            let order = try XCTUnwrap(Search.Order(rawValue: testCase.order), testCase.name)
            let found = Search.run(table.rows, query: testCase.query, scope: scope.kinds, order: order, recents: testCase.recents)
            XCTAssertEqual(found.map(\.key), testCase.expect, testCase.name)
        }
    }

    func testRecentsRememberOnceNewestFirstAndNeverADoor() throws {
        let table = try loadTable()
        let nadia = try XCTUnwrap(table.rows.first { $0.id == "nadia@example.com" })
        let doc = try XCTUnwrap(table.rows.first { $0.id == "doc_42" })
        let door = try XCTUnwrap(table.rows.first { $0.kind == .destination })
        var recents = Search.remember([], doc)
        recents = Search.remember(recents, nadia)
        recents = Search.remember(recents, doc)
        recents = Search.remember(recents, door)
        XCTAssertEqual(recents, ["document:doc_42", "person:nadia@example.com"])
        XCTAssertEqual(Search.remember(["a:1", "b:2"], doc, limit: 2), ["document:doc_42", "a:1"])

        let suite = "SearchFixtureTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let rosa = "rosa@example.com"
        XCTAssertEqual(SearchRecents.load(owner: rosa, defaults: defaults), [])
        SearchRecents.remember(doc, owner: rosa, defaults: defaults)
        SearchRecents.remember(nadia, owner: rosa, defaults: defaults)
        SearchRecents.remember(door, owner: rosa, defaults: defaults)
        XCTAssertEqual(SearchRecents.load(owner: rosa, defaults: defaults), [nadia, doc])
        XCTAssertEqual(SearchRecents.keys(owner: rosa, defaults: defaults), ["person:nadia@example.com", "document:doc_42"])
        // Another owner on the same device sees none of it (meet#193); nobody
        // signed in remembers nothing; sign-out drops every owner's.
        XCTAssertEqual(SearchRecents.load(owner: "ana@example.com", defaults: defaults), [])
        SearchRecents.remember(doc, owner: "", defaults: defaults)
        XCTAssertEqual(SearchRecents.load(owner: "", defaults: defaults), [])
        SearchRecents.purgeAll(defaults: defaults)
        XCTAssertEqual(SearchRecents.load(owner: rosa, defaults: defaults), [])
    }

    // MARK: - The table

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "search-rows", withExtension: "json"),
            "fixtures/search-rows.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let kinds: [String]
        let hitKinds: [String]
        let doorKinds: [String]
        let destinations: [String]
        let settingsPages: [String]
        let verbs: [String]
        let personVerbs: [String: [String]]
        let subjectVerbs: [String: [String]]
        let scopes: [String: [String]]
        let doors: [FixtureDoor]
        let badDoors: [String]
        let rows: [SearchRow]
        let cases: [FixtureCase]
    }

    private struct FixtureDoor: Decodable {
        let door: String
        let parsed: ParsedDoor
    }

    /// The fixture spells a parsed door as the TypeScript union does; this
    /// reads that spelling back into the Swift enum.
    private struct ParsedDoor: Decodable {
        let door: SearchDoor

        private enum CodingKeys: String, CodingKey {
            case to, destination, page, verb, subjectKind, id
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let to = try container.decode(String.self, forKey: .to)
            switch to {
            case "destination": door = .destination(try container.decode(SearchDestination.self, forKey: .destination))
            case "settings": door = .settings(try container.decode(SearchSettingsPage.self, forKey: .page))
            case "verb": door = .verb(try container.decode(SearchVerb.self, forKey: .verb))
            case "subject":
                door = .subject(
                    try container.decode(SearchSubjectKind.self, forKey: .subjectKind),
                    id: try container.decode(String.self, forKey: .id)
                )
            default:
                let id = try container.decode(String.self, forKey: .id)
                guard let parsed = SearchDoor(string: "\(to):\(id)") else {
                    throw DecodingError.dataCorruptedError(forKey: .to, in: container, debugDescription: "no door kind \(to)")
                }
                door = parsed
            }
        }
    }

    private struct FixtureCase: Decodable {
        let name: String
        let query: String
        let scope: String
        let order: String
        let recents: [String]
        let expect: [String]
    }
}
