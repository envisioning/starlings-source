import UIKit
import StarlingsContracts
import XCTest
@testable import Starlings

final class StarlingsMobileTests: XCTestCase {
    func testRoomParserAcceptsCanonicalBookingLink() {
        let path = MobileRoomPath(input: "https://envisioning.starlings.example/room/rosa/booking_123")
        XCTAssertEqual(path?.slug, "rosa")
        XCTAssertEqual(path?.bookingToken, "booking_123")
    }

    func testRoomParserAcceptsShortRoomName() {
        XCTAssertEqual(MobileRoomPath(input: "ROSA")?.slug, "rosa")
        XCTAssertNil(MobileRoomPath(input: "https://envisioning.starlings.example/rosa"))
    }

    // `MobileRoomHost.device` reads UIDevice, so this case runs on the main actor.
    @MainActor
    func testHostSessionCarriesLeasePacingAndDeviceIdentity() throws {
        let payload = """
        {
          "room": { "slug": "rosa", "kind": "permanent", "expiresAt": null },
          "connection": {
            "server_url": "wss://livekit.example",
            "participant_token": "token",
            "artifact_token": "artifact",
            "participant_token_expires_at": 1787317561,
            "meeting_id": "6f1c9e1e-6d6a-4f2f-9d0a-2f6e3f1b4c55",
            "livekit_room": "meet-rosa-6f1c9e1e",
            "started_at": 1787313900000
          },
          "lease": { "host_lease_expires_at": 1787313961000, "renew_after_ms": 10000 },
          "captions": { "topic": "captions.v1", "publisher_identity": "rosa+iphone@example.com" }
        }
        """
        let original = StarlingsWorkspace.active
        defer { StarlingsWorkspace.setActive(original) }
        StarlingsWorkspace.setActive(.tests)
        let session = try JSONDecoder().decode(OwnerHostSessionResponse.self, from: Data(payload.utf8))
        XCTAssertEqual(session.room.slug, "rosa")
        XCTAssertEqual(session.connection.livekitRoom, "meet-rosa-6f1c9e1e")
        // Pacing comes from the Worker, not from a constant in this app.
        XCTAssertEqual(session.lease.renewInterval, 10)
        XCTAssertEqual(session.lease.expiresAt.timeIntervalSince1970, 1_787_313_961)

        // The phone publishes under its own identity so it cannot evict the
        // owner's Mac, and that identity still reads as one of us.
        XCTAssertEqual(session.captions.publisherIdentity, "rosa+iphone@example.com")
        XCTAssertTrue(CaptionMessage.acceptsPublisherIdentity(session.captions.publisherIdentity))
        XCTAssertEqual(
            EnvisioningIdentity.accountAddress(session.captions.publisherIdentity),
            "rosa@example.com"
        )
        XCTAssertEqual(
            EnvisioningIdentity.deviceScopedIdentity("rosa@example.com", device: MobileRoomHost.device),
            UIDevice.current.userInterfaceIdiom == .pad
                ? "rosa+ipad@example.com"
                : "rosa+iphone@example.com"
        )
    }

    func testWaitingRoomKeepsServerOrderAndOnlyWaitingRows() throws {
        let payload = """
        {
          "requests": [
            {
              "id": "b", "meetingId": "m", "name": "Second", "email": "b@example.net",
              "identity": "guest:b", "status": "waiting",
              "createdAt": 1787313962000, "bookingToken": null, "client": null
            },
            {
              "id": "a", "meetingId": "m", "name": "First", "email": "a@example.net",
              "identity": "guest:a", "status": "waiting",
              "createdAt": 1787313961000, "bookingToken": null, "client": null
            },
            {
              "id": "c", "meetingId": "m", "name": "Admitted", "email": "c@example.net",
              "identity": "guest:c", "status": "admitted",
              "createdAt": 1787313963000, "bookingToken": null, "client": null
            }
          ],
          "lurkers": [
            {
              "id": "l", "stage": "preview", "name": "Browser guest", "city": "São Paulo",
              "country": "BR", "bookingToken": null, "client": null,
              "seenAt": 1787313960000, "createdAt": 1787313960000
            }
          ]
        }
        """
        let snapshot = try JSONDecoder().decode(LobbySnapshotResponse.self, from: Data(payload.utf8))
        // The queue is FIFO by knock time, not by the order the poll returned
        // them, and somebody already admitted is not still at the door.
        let queue = snapshot.requests.filter(\.isWaiting).sorted { $0.createdAt < $1.createdAt }
        XCTAssertEqual(queue.map(\.name), ["First", "Second"])
        XCTAssertEqual(queue.first?.knockedAt.timeIntervalSince1970, 1_787_313_961)
        XCTAssertEqual(snapshot.lurkers.first?.location, "São Paulo")
        XCTAssertEqual(snapshot.lurkers.first?.displayName, "Browser guest")
        let countryOnly = GuestPresenceRow(
            id: "country-only", stage: .visit, name: nil,
            city: nil, country: "BR", seenAt: 0, createdAt: 0
        )
        XCTAssertNil(countryOnly.location)
    }

    func testGuestIdentityRequiresEmail() {
        XCTAssertFalse(MobileGuestIdentity(name: "Guest", email: "").isValid)
        XCTAssertTrue(MobileGuestIdentity(name: "Guest", email: "guest@example.net").isValid)
    }

    func testInternalRoomProjectionCarriesSignedInMember() throws {
        let payload = #"{"slug":"team","kind":"permanent","internal":true,"owner_name":"Rosa","you":{"name":"Ada","email":"ada@example.com"}}"#
        let room = try JSONDecoder().decode(PublicRoomResponse.self, from: Data(payload.utf8))
        XCTAssertEqual(room.slug, "team")
        XCTAssertTrue(room.isInternal == true)
        XCTAssertEqual(room.you?.name, "Ada")
        XCTAssertEqual(room.you?.email, "ada@example.com")
    }

    func testBookingProjectionBuildsInviteCard() throws {
        let data = try XCTUnwrap(#"{"title":"Design review","subject":"Roadmap","starts_at":"2099-08-11T10:00:00Z","ends_at":"2099-08-11T11:00:00Z","status":"scheduled"}"#.data(using: .utf8))
        let projection = try JSONDecoder().decode(StarlingsMintedBookingProjection.self, from: data)
        guard case let .scheduled(title, subject, startsAt, endsAt) = projection.card else {
            return XCTFail("Expected a scheduled invite card")
        }
        XCTAssertEqual(title, "Design review")
        XCTAssertEqual(subject, "Roadmap")
        XCTAssertNotNil(startsAt)
        XCTAssertNotNil(endsAt)
    }

    func testCancelledBookingProjectionExpires() throws {
        let data = try XCTUnwrap(#"{"title":null,"subject":null,"starts_at":null,"ends_at":null,"status":"cancelled"}"#.data(using: .utf8))
        let projection = try JSONDecoder().decode(StarlingsMintedBookingProjection.self, from: data)
        XCTAssertEqual(projection.card, .expired)
    }
}
