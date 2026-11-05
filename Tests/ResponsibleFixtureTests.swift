import XCTest
@testable import Starlings

/// The shared table, run against the Swift implementation. The TypeScript
/// port runs the same file (`services/control-plane/test/responsible.test.ts`).
/// A failure here is a question about `fixtures/responsible.json` first.
final class ResponsibleFixtureTests: XCTestCase {
    func testChosenSuggestedAndNone() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1, "The fixture changed shape; re-read its rules before touching this.")
        XCTAssertFalse(table.cases.isEmpty)
        for row in table.cases {
            let found = Responsible.of(
                kind: row.subject.kind,
                responsibleEmail: row.subject.responsibleEmail,
                tasks: row.tasks.map { Responsible.Task(assigneeEmail: $0.assigneeEmail, status: $0.status) }
            )
            XCTAssertEqual(found?.email, row.expect?.email, row.name)
            XCTAssertEqual(found?.source.rawValue, row.expect?.source, row.name)
        }
    }

    private struct Subject: Decodable {
        let kind: String
        let responsibleEmail: String?
        enum CodingKeys: String, CodingKey { case kind; case responsibleEmail = "responsible_email" }
    }

    private struct FixtureTask: Decodable {
        let assigneeEmail: String?
        let status: String
        enum CodingKeys: String, CodingKey { case status; case assigneeEmail = "assignee_email" }
    }

    private struct Expect: Decodable { let email: String; let source: String }
    private struct Case: Decodable { let name: String; let subject: Subject; let tasks: [FixtureTask]; let expect: Expect? }
    private struct Table: Decodable { let version: Int; let cases: [Case] }

    private func loadTable() throws -> Table {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "responsible", withExtension: "json"),
            "fixtures/responsible.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
    }
}
