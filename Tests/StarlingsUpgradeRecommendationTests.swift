import XCTest
@testable import Starlings

final class StarlingsUpgradeRecommendationTests: XCTestCase {
    func testDismissalHidesRecommendationUntilTheTwentyFourHourWindowEnds() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(StarlingsUpgradeRecommendation.shouldShow(recommended: true, dismissedUntil: nil, now: now))
        XCTAssertFalse(StarlingsUpgradeRecommendation.shouldShow(
            recommended: true,
            dismissedUntil: now.addingTimeInterval(StarlingsUpgradeRecommendation.dismissalInterval),
            now: now
        ))
        XCTAssertTrue(StarlingsUpgradeRecommendation.shouldShow(
            recommended: true,
            dismissedUntil: now.addingTimeInterval(-1),
            now: now
        ))
        XCTAssertFalse(StarlingsUpgradeRecommendation.shouldShow(recommended: false, dismissedUntil: nil, now: now))
    }
}
