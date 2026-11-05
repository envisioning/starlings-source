import XCTest
@testable import Starlings

final class RingNoticeTests: XCTestCase {
    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)
    private let origin = "https://envisioning.starlings.example"

    private func ring(
        caller: String = "ada@example.com",
        name: String? = "Ada Lovelace",
        room: String? = "ada",
        createdAt: Date? = nil
    ) -> PeerRing {
        let created = createdAt ?? epoch
        return PeerRing(
            callerEmail: caller,
            callerName: name,
            roomSlug: room,
            createdAt: created,
            expiresAt: created.addingTimeInterval(45)
        )
    }

    func testCallNeverOffersToJoinTheCallersRoom() {
        let call = PeerRing(kind: .call, callerEmail: "ada@example.com", callerName: "Ada",
            roomSlug: "ada", createdAt: epoch, expiresAt: epoch.addingTimeInterval(45))
        let result = RingNotices.plan(ring: call, announced: nil, webOrigin: origin)
        XCTAssertEqual(result.notice?.isCall, true)
        XCTAssertNil(result.notice?.joinURL)
    }

    func testAnnouncesARingNobodyHasSeen() {
        let result = RingNotices.plan(ring: ring(), announced: nil, webOrigin: origin)
        XCTAssertEqual(result.notice?.callerName, "Ada Lovelace")
        XCTAssertEqual(result.notice?.roomSlug, "ada")
        XCTAssertEqual(result.notice?.joinURL, "https://envisioning.starlings.example/room/ada")
        XCTAssertEqual(result.announced, result.notice?.key)
    }

    /// A ring sits in the roster for its whole forty-five seconds, so it is
    /// read by four or five polls. Announcing each one would be one nudge
    /// arriving as five banners.
    func testStaysQuietForARingAlreadyAnnounced() {
        let first = RingNotices.plan(ring: ring(), announced: nil, webOrigin: origin)
        let second = RingNotices.plan(ring: ring(), announced: first.announced, webOrigin: origin)
        XCTAssertNil(second.notice)
        XCTAssertEqual(second.announced, first.announced)
    }

    /// The same person ringing again is a second nudge, not the first one
    /// still arriving — the creation time is what separates them.
    func testAnnouncesTheSameCallerRingingAgain() {
        let first = RingNotices.plan(ring: ring(), announced: nil, webOrigin: origin)
        let again = ring(createdAt: epoch.addingTimeInterval(120))
        let second = RingNotices.plan(ring: again, announced: first.announced, webOrigin: origin)
        XCTAssertNotNil(second.notice)
        XCTAssertNotEqual(second.announced, first.announced)
    }

    /// No ring means the banner should come down, and the next one from the
    /// same person at the same second must not be swallowed as a duplicate.
    func testForgetsWhatItAnnouncedOnceTheRingIsGone() {
        let result = RingNotices.plan(ring: nil, announced: "ada@example.com#1700000000", webOrigin: origin)
        XCTAssertNil(result.notice)
        XCTAssertNil(result.announced)
    }

    /// A colleague with no room can still nudge you; there is simply nowhere
    /// for Join to take you, so the notice carries no URL.
    func testARingWithoutARoomCarriesNoJoinURL() {
        let result = RingNotices.plan(ring: ring(room: nil), announced: nil, webOrigin: origin)
        XCTAssertNotNil(result.notice)
        XCTAssertNil(result.notice?.joinURL)
    }

    /// Unnamed callers fall back to the local part rather than showing an
    /// address in a banner.
    func testFallsBackToTheLocalPartWhenThereIsNoName() {
        let result = RingNotices.plan(ring: ring(name: nil), announced: nil, webOrigin: origin)
        XCTAssertEqual(result.notice?.callerName, "ada")
    }

    /// Debug runs against a loopback origin, and a banner that offered a
    /// production link there would leave the stack the host is leasing.
    func testKeepsALoopbackOriginForLocalDevelopment() {
        let result = RingNotices.plan(ring: ring(), announced: nil, webOrigin: "http://127.0.0.1:5173")
        XCTAssertEqual(result.notice?.joinURL, "http://127.0.0.1:5173/room/ada")
    }
}
