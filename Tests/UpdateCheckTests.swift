import XCTest
@testable import Starlings

/// Decisions behind offering an app update. See docs/UPDATER.md.
///
/// Reachable without a network or signed binary — the install half cannot run
/// in CI because it replaces the app under test.
final class UpdateCheckTests: XCTestCase {

    private let os = "15.3.0"

    private func feed(
        version: String? = "0.2.0",
        url: String? = "https://site.example/download/mac/0.2.0/Starlings-macOS.zip",
        minMacOS: String? = "14.0",
        sha256: String? = nil,
        size: Int? = nil
    ) -> UpdateFeed {
        UpdateFeed(
            schema: 1, version: version, published: nil, url: url,
            sha256: sha256, size: size, minMacOS: minMacOS, notesMD: nil
        )
    }

    // MARK: Version ordering

    func testTenBeatsNineWithinAPatchLine() {
        XCTAssertEqual(UpdateCheck.isNewer("1.4.10", than: "1.4.9"), true)
        XCTAssertEqual(UpdateCheck.isNewer("1.4.9", than: "1.4.10"), false)
    }

    func testRecommendedMinimumUsesNumericMarketingVersionOrdering() {
        XCTAssertEqual(UpdateCheck.isNewer("4.8.0", than: "4.7.9"), true)
        XCTAssertEqual(UpdateCheck.isNewer("4.7.10", than: "4.7.9"), true)
        XCTAssertEqual(UpdateCheck.isNewer("4.7.2", than: "4.7.2"), false)
    }

    func testRollingSingleDigitLine() {
        XCTAssertEqual(UpdateCheck.isNewer("0.2.0", than: "0.1.9"), true)
        XCTAssertEqual(UpdateCheck.isNewer("0.1.9", than: "0.1.8"), true)
    }

    func testEqualVersionsAreNotNewer() {
        XCTAssertEqual(UpdateCheck.isNewer("0.1.1", than: "0.1.1"), false)
    }

    func testShorterVersionsPadWithZero() {
        XCTAssertEqual(UpdateCheck.isNewer("1.5", than: "1.4.9"), true)
        XCTAssertEqual(UpdateCheck.isNewer("1.4", than: "1.4.0"), false)
    }

    func testNonNumericVersionsRefuseToCompare() {
        XCTAssertNil(UpdateCheck.isNewer("0.2.0-beta", than: "0.1.1"))
        XCTAssertNil(UpdateCheck.isNewer("0.1.1", than: ""))
    }

    // MARK: Decoding

    func testDecodesWithEveryOptionalMissing() throws {
        let json = Data(#"{"version":"0.2.0","url":"https://x/y.zip"}"#.utf8)
        let decoded = try UpdateCheck.decode(json)
        XCTAssertEqual(decoded.version, "0.2.0")
        XCTAssertNil(decoded.sha256)
        XCTAssertNil(decoded.minMacOS)
    }

    func testUnknownFutureKeysAreIgnored() throws {
        let json = Data(#"""
        {"version":"0.2.0","url":"https://x/y.zip","channel":"beta",
         "delta":{"from":"0.1.9","url":"https://x/d.patch"}}
        """#.utf8)
        let decoded = try UpdateCheck.decode(json)
        XCTAssertEqual(decoded.version, "0.2.0")
    }

    func testSnakeCaseKeysMapToProperties() throws {
        let json = Data(#"""
        {"version":"0.2.0","url":"https://x/y.zip",
         "min_macos":"14.0","notes_md":"### Fixed"}
        """#.utf8)
        let decoded = try UpdateCheck.decode(json)
        XCTAssertEqual(decoded.minMacOS, "14.0")
        XCTAssertEqual(decoded.notesMD, "### Fixed")
    }

    func testFeedSummaryIncludesVersionAndPublishedDate() {
        let summary = UpdateCheck.feedSummary(
            version: "0.1.4",
            published: "2026-08-09T18:17:49Z"
        )
        XCTAssertEqual(summary?.hasPrefix("0.1.4 · "), true)
        XCTAssertEqual(summary?.contains("2026"), true)
    }

    func testFeedSummaryFallsBackToVersionAlone() {
        XCTAssertEqual(UpdateCheck.feedSummary(version: "0.1.4", published: nil), "0.1.4")
        XCTAssertNil(UpdateCheck.feedSummary(version: nil, published: "2026-08-09T18:17:49Z"))
    }

    func testMalformedJSONThrowsRatherThanCrashing() {
        XCTAssertThrowsError(try UpdateCheck.decode(Data("not json".utf8)))
    }

    // MARK: What gets offered

    func testOffersANewerVersion() {
        let found = UpdateCheck.evaluate(
            feed: feed(), installed: "0.1.0", osVersion: os)
        XCTAssertEqual(found?.version, "0.2.0")
    }

    func testDoesNotOfferTheInstalledVersion() {
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(version: "0.1.0"), installed: "0.1.0", osVersion: os))
    }

    func testDoesNotOfferADowngrade() {
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(version: "0.0.9"), installed: "0.1.0", osVersion: os))
    }

    func testRefusesANonHTTPSURL() {
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(url: "http://site.example/y.zip"),
            installed: "0.1.0", osVersion: os))
    }

    func testRefusesAURLWithoutAHostOrWithCredentials() {
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(url: "https:///meet/y.zip"),
            installed: "0.1.0", osVersion: os))
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(url: "https://user:password@site.example/y.zip"),
            installed: "0.1.0", osVersion: os))
    }

    func testRefusesMalformedIntegrityMetadata() {
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(sha256: "not-a-digest"), installed: "0.1.0", osVersion: os))
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(size: 0), installed: "0.1.0", osVersion: os))
    }

    func testRefusesAFeedMissingVersionOrURL() {
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(version: nil), installed: "0.1.0", osVersion: os))
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(url: nil), installed: "0.1.0", osVersion: os))
    }

    func testRespectsMinMacOSFloor() {
        XCTAssertNil(UpdateCheck.evaluate(
            feed: feed(minMacOS: "16.0"), installed: "0.1.0", osVersion: "15.3.0"))
    }

    func testUnparseableMinMacOSFailsOpen() {
        let found = UpdateCheck.evaluate(
            feed: feed(minMacOS: "sequoia"), installed: "0.1.0", osVersion: os)
        XCTAssertEqual(found?.version, "0.2.0")
    }

    func testOnlyTheRealApplicationsBundleCanSelfUpdate() {
        XCTAssertTrue(UpdateCheck.isInstalledInApplications(
            at: URL(fileURLWithPath: "/Applications/Starlings.app")))
        XCTAssertFalse(UpdateCheck.isInstalledInApplications(
            at: URL(fileURLWithPath: "/tmp/DerivedData/Starlings.app")))
    }
}
