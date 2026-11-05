import XCTest
@testable import Starlings

final class PeerPresenceTests: XCTestCase {
    /// Native join surfaces must keep the same pre-knock request budget as the
    /// browser; this is deliberately pinned to the shared contract's value.
    func testGuestPresenceCadenceMatchesContract() {
        XCTAssertEqual(PeerPresenceCadence.guestPresenceHeartbeat, 15)
        XCTAssertEqual(PeerPresenceCadence.rosterPoll, 30)
        XCTAssertEqual(StarlingsPollingCadence.lobbyFallback, 5)
        XCTAssertEqual(StarlingsPollingCadence.qualityReport, 300)
    }

    private func roster(_ json: String) throws -> PeerRoster {
        try JSONDecoder().decode(PeerRoster.self, from: Data(json.utf8))
    }

    func testRosterDecodesTheShapeTheWorkerSends() throws {
        let decoded = try roster("""
        {
          "generated_at": 1700000000000,
          "peers": [
            {
              "email": "ada@example.com",
              "name": "Ada Lovelace",
              "room_slug": "ada",
              "kind": "human",
              "status": "in_meeting",
              "since": 1699999990000,
              "last_seen_at": 1699999990000,
              "clients": ["mac"],
              "invisible": false,
              "last_client": "mac",
              "participants": 3,
              "is_self": false
            },
            {
              "email": "rosa@example.com",
              "name": "Rosa",
              "room_slug": "rosa",
              "kind": "human",
              "status": "active",
              "since": 1699999999000,
              "last_seen_at": 1699999999000,
              "clients": ["ios"],
              "invisible": false,
              "last_client": "ios",
              "participants": 0,
              "is_self": true
            }
          ]
        }
        """)

        XCTAssertEqual(decoded.peers.count, 2)
        XCTAssertEqual(decoded.others.map(\.email), ["ada@example.com"])
        XCTAssertEqual(decoded.me?.email, "rosa@example.com")
        XCTAssertEqual(decoded.aroundCount, 1)
        XCTAssertEqual(decoded.peers[0].participants, 3)
        XCTAssertEqual(decoded.peers[0].shortName, "Ada")
    }

    /// A status the phone has not learned yet must dim one row, never fail the
    /// whole roster.
    func testUnknownStatusDecodesAsOffline() throws {
        let decoded = try roster("""
        { "generated_at": 1, "peers": [
          { "email": "new@example.com", "name": null, "room_slug": null,
            "kind": "human", "status": "huddling", "since": null,
            "last_seen_at": 1, "clients": [], "invisible": false, "last_client": null,
            "participants": 0, "is_self": false } ] }
        """)
        XCTAssertEqual(decoded.peers.first?.status, .offline)
        XCTAssertEqual(decoded.peers.first?.displayName, "new")
    }

    /// Every field the presence work added, in one decode — and an unknown
    /// device name, which must dim a badge rather than fail the roster.
    func testRosterDecodesDevicesDoNotDisturbAndTheRing() throws {
        let decoded = try roster("""
        {
          "generated_at": 1700000000000,
          "incoming_ring": {
            "kind": "call",
            "caller_email": "ada@example.com",
            "caller_name": "Ada Lovelace",
            "room_slug": "ada",
            "created_at": 1699999999000,
            "expires_at": 4102444800000
          },
          "peers": [
            {
              "email": "ada@example.com",
              "name": "Ada Lovelace",
              "kind": "human",
              "room_slug": "ada",
              "status": "dnd",
              "since": null,
              "last_seen_at": 1699999990000,
              "last_client": "ios",
              "clients": ["mac", "ios", "hologram"],
              "busy_until": null,
              "dnd_until": 4102444800000,
              "invisible": false,
              "participants": 0,
              "is_self": false
            }
          ]
        }
        """)

        let peer = try XCTUnwrap(decoded.peers.first)
        XCTAssertEqual(peer.status, .doNotDisturb)
        XCTAssertEqual(peer.kind, .human)
        XCTAssertEqual(peer.clients, [.mac, .ios])
        XCTAssertEqual(peer.clients.map(\.label), ["Desktop", "Mobile"])
        XCTAssertNotNil(peer.dndUntil)
        XCTAssertNotNil(peer.lastSeenAt)
        // Nobody rings a person who has asked not to be disturbed.
        XCTAssertFalse(peer.isRingable)
        XCTAssertEqual(decoded.liveRing?.callerDisplayName, "Ada Lovelace")
    }

    /// An expired ring is not a missed call — it is nothing. Without this the
    /// banner would sit there long after the moment somebody wanted you.
    func testExpiredRingIsNotShown() throws {
        let decoded = try roster("""
        { "generated_at": 1700000000000, "peers": [],
          "incoming_ring": { "kind": "wave", "caller_email": "ada@example.com", "caller_name": null,
            "room_slug": null, "created_at": 1000, "expires_at": 2000 } }
        """)
        XCTAssertNotNil(decoded.incomingRing)
        XCTAssertNil(decoded.liveRing)
    }

    /// A kind and a device this build has not heard of must dim a badge, never
    /// fail the roster: the Worker learns names before every installed app does.
    /// (The fields themselves are required by the contract, so a roster that
    /// omits them is a broken Worker, not an older one.)
    func testUnfamiliarKindAndDeviceStillDecode() throws {
        let decoded = try roster("""
        { "generated_at": 1, "peers": [
          { "email": "new@example.com", "name": "New", "room_slug": null,
            "kind": "swarm", "status": "active", "since": 1, "last_seen_at": 1,
            "clients": ["hologram"], "invisible": false, "last_client": "mac",
            "participants": 0, "is_self": false } ] }
        """)
        let peer = try XCTUnwrap(decoded.peers.first)
        XCTAssertEqual(peer.kind, .human)
        XCTAssertEqual(peer.clients, [])
    }

    /// Every timeboxed answer ends. One that did not would leave a person
    /// silently off the roster for good.
    func testTimeboxedStatusOptionsExpire() throws {
        let now = Date()
        for option in PeerStatusOption.allCases {
            let resolved = option.resolve(now: now)
            switch option {
            case .focused:
                XCTAssertEqual(resolved.intent, .focused)
                XCTAssertGreaterThan(try XCTUnwrap(resolved.intentUntil), now, "Focused must end")
                XCTAssertNil(resolved.dndUntil)
            case .unavailable:
                XCTAssertNil(resolved.intent)
                XCTAssertGreaterThan(try XCTUnwrap(resolved.dndUntil), now, "Unavailable must end")
            case .available, .offline:
                XCTAssertNil(resolved.intentUntil)
                XCTAssertNil(resolved.dndUntil)
            }
        }
    }

    /// Only a live host lease can answer a knock. Without push there is nothing
    /// to ring on a phone, so an awake phone must not offer a Call button.
    func testOnlyRoomBackedPresenceIsCallable() {
        let inMeeting = Peer(email: "a@example.com", name: "A", roomSlug: "a", status: .inMeeting)
        let available = Peer(email: "b@example.com", name: "B", roomSlug: "b", status: .available)
        let activePhone = Peer(email: "c@example.com", name: "C", roomSlug: "c", status: .active)
        let roomless = Peer(email: "d@example.com", name: "D", roomSlug: nil, status: .available)
        let me = Peer(email: "e@example.com", name: "E", roomSlug: "e", status: .available, isSelf: true)

        XCTAssertTrue(inMeeting.isCallable)
        XCTAssertTrue(available.isCallable)
        XCTAssertFalse(activePhone.isCallable)
        XCTAssertFalse(roomless.isCallable)
        XCTAssertFalse(me.isCallable)
    }
}
