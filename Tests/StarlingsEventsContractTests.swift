import XCTest
@testable import Starlings

final class StarlingsEventsContractTests: XCTestCase {
    func testUnknownLifecycleKindKeepsTheRestOfTheBatch() throws {
        let data = Data("""
        {
          "schemaVersion": 2,
          "meetingCode": "abc-defg-hij",
          "capturedAtMs": 10,
          "roster": [{"name": "Ana", "speaking": true}],
          "lifecycle": {"kind": "newer-call-event", "atMs": 9}
        }
        """.utf8)

        let batch = try JSONDecoder().decode(StarlingsEventsBatch.self, from: data)
        XCTAssertEqual(batch.schemaVersion, 2)
        XCTAssertEqual(batch.meetingCode, "abc-defg-hij")
        XCTAssertEqual(batch.roster.map(\.name), ["Ana"])
        XCTAssertEqual(batch.roster.first?.speaking, true)
        XCTAssertEqual(batch.lifecycle?.kind.eventKind, .other("newer-call-event"))
    }
}
