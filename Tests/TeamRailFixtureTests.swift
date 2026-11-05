import XCTest
@testable import Starlings

final class TeamRailFixtureTests: XCTestCase {
    func testTheRulesMatchTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(TeamRailRules.directKind, table.directKind)
        for row in table.order {
            XCTAssertEqual(
                TeamRailRules.order(emails: row.emails, directs: row.directs.map(\.direct)),
                row.out,
                row.name
            )
        }
        for row in table.stray {
            XCTAssertEqual(
                TeamRailRules.isStray(row.direct.direct, rosterEmails: Set(row.roster), selfEmail: row.selfEmail),
                row.out,
                row.name
            )
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "team-rail", withExtension: "json"),
            "fixtures/team-rail.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let directKind: String
        let order: [OrderRow]
        let stray: [StrayRow]
    }

    private struct OrderRow: Decodable {
        let name: String
        let emails: [String]
        let directs: [FixtureDirect]
        let out: [String]
    }

    private struct StrayRow: Decodable {
        let name: String
        let direct: FixtureDirect
        let roster: [String]
        let selfEmail: String?
        let out: Bool
    }

    private struct FixtureDirect: Decodable {
        let kind: String
        let isGroup: Bool
        let peerEmail: String?
        let lastMessageAt: Double?

        var direct: TeamRailDirect {
            TeamRailDirect(kind: kind, isGroup: isGroup, peerEmail: peerEmail, lastMessageAt: lastMessageAt)
        }
    }
}
