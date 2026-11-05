import XCTest
import StarlingsContracts
@testable import Starlings

final class FavoriteTargetsTests: XCTestCase {
    func testCMSWorkEventUsesCMSFavoriteKind() throws {
        let eventID = "d7b7820a-a16d-4b93-a4c2-8513e3572e72"

        let target = try XCTUnwrap(FavoriteTargets.crmSubject(kind: "event", id: eventID))

        XCTAssertEqual(target.kind, .cmsEvent)
        XCTAssertEqual(target.targetRef, eventID)
    }

    func testUnsupportedCRMSubjectDoesNotBecomeAFavorite() {
        XCTAssertNil(FavoriteTargets.crmSubject(kind: "unknown", id: "record"))
    }
}
