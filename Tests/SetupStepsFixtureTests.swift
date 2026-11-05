import XCTest
@testable import Starlings

/// Holds the generated `SetupStep` table to `fixtures/setup-steps.json`, which is generated from
/// `packages/contracts/src/setup-steps.ts` like the table itself: the same steps in the same
/// order, the same roles, the same required flag and the same web route
/// (docs/ONBOARDING.md §The setup checklist).
final class SetupStepsFixtureTests: XCTestCase {
    func testTheSwiftTableMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(SetupStep.allCases.map(\.rawValue), table.steps.map(\.id))
        for (step, expected) in zip(SetupStep.allCases, table.steps) {
            XCTAssertEqual(step.roles, expected.roles, expected.id)
            XCTAssertEqual(step.isRequired, expected.required, expected.id)
            XCTAssertEqual(step.webRoute, expected.route, expected.id)
            XCTAssertFalse(step.title.isEmpty, expected.id)
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "setup-steps", withExtension: "json"),
            "fixtures/setup-steps.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let steps: [Step]
    }

    private struct Step: Decodable {
        let id: String
        let roles: [String]
        let required: Bool
        let route: String
    }
}
