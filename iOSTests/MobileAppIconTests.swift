import XCTest
@testable import Starlings

final class MobileAppIconTests: XCTestCase {
    func testChoicesMatchPrimaryAndAlternateIconNames() {
        XCTAssertEqual(
            MobileAppIconChoice.allCases.map(\.alternateIconName),
            [nil, "starlings-graphite-accent", "starlings-graphite-white"]
        )
    }

    func testUnknownSystemIconFallsBackToThePrimaryIcon() {
        XCTAssertEqual(
            MobileAppIconChoice.current(alternateIconName: "not-a-meet-icon"),
            .accentBackgroundBlackMark
        )
        XCTAssertEqual(
            MobileAppIconChoice.current(alternateIconName: nil),
            .accentBackgroundBlackMark
        )
    }
}
