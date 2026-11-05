import XCTest
@testable import Starlings

final class LeadQualificationFixtureTests: XCTestCase {
    func testTheKeysMatchTheFixture() throws {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "lead-qualification", withExtension: "json"),
            "fixtures/lead-qualification.json is not in the test bundle — check project.yml."
        )
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(LeadQualification.keys, table.keys)
    }

    func testEveryKeyHasAWordOfItsOwn() {
        for key in LeadQualification.keys {
            XCTAssertNotEqual(LeadQualification.title(for: key), key, "\(key) shows as its wire key")
        }
    }

    func testCountSummaryAndMergeKeepOtherCharacteristics() {
        let read: [String: Bool] = ["project_fit": true, "custom_flag": true]
        XCTAssertEqual(LeadQualification.count(read), 1)
        XCTAssertEqual(LeadQualification.count(nil), 0)
        let merged = LeadQualification.merged(read, key: "budget_availability", value: true)
        XCTAssertEqual(merged, ["project_fit": true, "custom_flag": true, "budget_availability": true])
        XCTAssertEqual(LeadQualification.count(merged), 2)
        // A key that is not one of the five is not written.
        XCTAssertEqual(LeadQualification.merged(read, key: "vibes", value: true), read)
    }

    private struct Table: Decodable {
        let version: Int
        let keys: [String]
    }
}
