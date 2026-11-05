import Foundation
import StarlingsContracts
import XCTest
@testable import Starlings

/// The same fixture is decoded by Mac and iOS tests. It pins the optional
/// member identity and internal-room fields alongside the booking projection.
final class RoomEntryContractFixtureTests: XCTestCase {
    func testValidRoomFixturesDecodeWithAndWithoutMemberFields() throws {
        let rows = try fixtureRows(section: "public_rooms")
        let validRows = rows.filter { ($0["valid"] as? Bool) == true }
        XCTAssertGreaterThanOrEqual(validRows.count, 3)

        let rooms = try validRows.map { row in
            try JSONDecoder().decode(PublicRoomResponse.self, from: payload(row))
        }
        let memberRoom = try XCTUnwrap(rooms.first { $0.slug == "rosa" })
        XCTAssertEqual(memberRoom.kind, .permanent)
        XCTAssertEqual(memberRoom.isInternal, false)
        XCTAssertEqual(memberRoom.you?.name, "ROSA")
        XCTAssertEqual(memberRoom.you?.email, "rosa@example.com")

        let internalRoom = try XCTUnwrap(rooms.first { $0.slug == "team" })
        XCTAssertEqual(internalRoom.isInternal, true)
        XCTAssertEqual(internalRoom.you?.name, "Ada")

        let roomWithoutOptionalFields = try XCTUnwrap(rooms.first { $0.slug == "team-room" })
        XCTAssertNil(roomWithoutOptionalFields.isInternal)
        XCTAssertNil(roomWithoutOptionalFields.you)
    }

    func testValidBookingFixturesDecodeWithGeneratedProjection() throws {
        let rows = try fixtureRows(section: "booking_projections")
        let validRows = rows.filter { ($0["valid"] as? Bool) == true }
        XCTAssertGreaterThanOrEqual(validRows.count, 2)

        let bookings = try validRows.map { row in
            try JSONDecoder().decode(StarlingsMintedBookingProjection.self, from: payload(row))
        }
        XCTAssertTrue(bookings.contains { $0.status == .scheduled && $0.guestName == "Ana" })
        XCTAssertTrue(bookings.contains { $0.status == .cancelled && $0.title == nil })
    }

    private func fixtureRows(section: String) throws -> [[String: Any]] {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(bundle.url(forResource: "room-entry", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try XCTUnwrap(root[section] as? [[String: Any]])
    }

    private func payload(_ row: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: XCTUnwrap(row["value"] as? [String: Any]))
    }
}
