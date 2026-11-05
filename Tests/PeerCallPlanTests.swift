import XCTest
@testable import Starlings

/// Call either reaches a room, asks for one, or says why not (meet#555).
final class PeerCallPlanTests: XCTestCase {
    private func peer(
        roomSlug: String? = "ada",
        status: PeerStatus = .available,
        inRoomSlug: String? = nil,
        kind: PeerKind = .human,
        isSelf: Bool = false
    ) -> Peer {
        Peer(
            email: "ada@example.com",
            name: "Ada Lovelace",
            roomSlug: roomSlug,
            status: status,
            kind: kind,
            inRoomSlug: inRoomSlug,
            isSelf: isSelf
        )
    }

    private func reason(_ plan: PeerCallPlan) -> String? {
        if case .unavailable(let reason) = plan { return reason }
        return nil
    }

    func testAvailableColleagueIsAskedToOpenTheirRoom() {
        XCTAssertEqual(peer().callPlan, .ask(slug: "ada"))
    }

    func testColleagueInAMeetingIsJoinedWhereTheyStand() {
        XCTAssertEqual(peer(status: .inMeeting).callPlan, .join(slug: "ada"))
        XCTAssertEqual(peer(status: .inMeeting, inRoomSlug: "grace").callPlan, .join(slug: "grace"))
    }

    func testGuestInSomebodyElsesRoomIsJoinableWithoutARoomOfTheirOwn() {
        XCTAssertEqual(peer(roomSlug: nil, status: .inMeeting, inRoomSlug: "grace").callPlan, .join(slug: "grace"))
    }

    func testEveryDeadEndCarriesAReason() {
        let deadEnds = [
            peer(roomSlug: nil),
            peer(status: .offline),
            peer(status: .doNotDisturb),
            peer(status: .busy),
            peer(kind: .agent),
            peer(isSelf: true),
        ]
        for candidate in deadEnds {
            let line = reason(candidate.callPlan)
            XCTAssertNotNil(line, "\(candidate.status) should not be callable")
            XCTAssertFalse(line?.isEmpty ?? true)
        }
    }

    func testANamedReasonUsesTheirFirstName() {
        XCTAssertTrue(reason(peer(roomSlug: nil).callPlan)?.contains("Ada") == true)
        XCTAssertTrue(reason(peer(status: .offline).callPlan)?.contains("Ada") == true)
    }

    /// The menus offer Call only when `isCallable`; that promise must never
    /// lead to a dead end.
    func testCallableNeverPlansADeadEnd() {
        for status in [PeerStatus.available, .inMeeting] {
            let candidate = peer(status: status)
            XCTAssertTrue(candidate.isCallable)
            XCTAssertNil(reason(candidate.callPlan))
        }
    }
}
