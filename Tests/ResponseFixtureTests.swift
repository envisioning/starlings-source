import Foundation
import StarlingsContracts
import XCTest
@testable import Starlings

/// Decode `data` as `Wire`, the way `send(_:as:)` does.
private func decodeRecorded<Wire: Decodable>(_ type: Wire.Type, _ data: Data) throws -> Wire {
    try JSONDecoder().decode(type, from: data)
}

/// The length of the array at `key` in the body as the Worker sent it.
private func recordedCount(_ key: String, in data: Data) throws -> Int {
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return try XCTUnwrap(object[key] as? [Any], "\(key) is not an array in the recorded body").count
}

/// What the Worker really answers (meet#593). Every file in
/// `fixtures/responses/` is the body the Worker's own route test recorded for
/// one read the clients make. Each is decoded here through the generated wire
/// type for its route and then through the model the app draws from, the way
/// `send(_:as:)` does. The web parses the same files with the route's zod
/// schema (`web/src/response-fixtures.test.ts`) and the Worker holds each file
/// to what the route answers (`services/control-plane/test/response-fixtures.test.ts`).
///
/// A failure here is a question about the fixture first. A field that moved
/// fails all three suites: re-record (`node scripts/record-response-fixtures.mjs
/// --write`), then change the contract and the clients until they agree.
///
/// Built into the Mac and the iOS test bundles, so each app decodes with the
/// models it compiles (iOS builds its own copy of the shared Swift files).
final class ResponseFixtureTests: XCTestCase {
    /// One recorded read: its decode through the wire type, then the app's model.
    /// A row the model drops is a row the app never draws, so lengths are compared.
    private static var reads: [String: (Data) throws -> Void] { [
        "workspace-descriptor": { data in
            let descriptor = try decodeRecorded(StarlingsContracts.WorkspaceDescriptor.self, data)
            XCTAssertEqual(descriptor.version, 1)
            XCTAssertFalse(descriptor.name.isEmpty)
            XCTAssertFalse(descriptor.identity.domains.isEmpty)
        },
        "owner-room": { data in
            let response = try decodeRecorded(StarlingsContracts.OwnerRoomResponse.self, data)
            XCTAssertFalse(response.room.slug.isEmpty)
        },
        "crm-subjects": { data in
            _ = try decodeRecorded(StarlingsContracts.CrmSubjectsResponse.self, data)
            let model = try decodeRecorded(Starlings.CrmSubjectsResponse.self, data)
            XCTAssertEqual(model.subjects.count, try recordedCount("subjects", in: data))
        },
        "crm-subject-project": { data in
            _ = try decodeRecorded(StarlingsContracts.CrmSubjectDetailResponse.self, data)
            _ = try decodeRecorded(Starlings.CrmSubjectDetailResponse.self, data)
        },
        "crm-mine": { data in
            _ = try decodeRecorded(StarlingsContracts.CrmMyWorkResponse.self, data)
            let model = try decodeRecorded(Starlings.CrmMyWorkResponse.self, data)
            XCTAssertEqual(model.tasks.count, try recordedCount("tasks", in: data))
            XCTAssertEqual(model.issues.count, try recordedCount("issues", in: data))
        },
        "crm-board": { data in
            _ = try decodeRecorded(StarlingsContracts.CrmBoardResponse.self, data)
            let model = try decodeRecorded(Starlings.CrmBoardResponse.self, data)
            XCTAssertEqual(model.subjects.count, try recordedCount("subjects", in: data))
            XCTAssertEqual(model.tasks.count, try recordedCount("tasks", in: data))
            XCTAssertEqual(model.issues.count, try recordedCount("issues", in: data))
        },
        "threads": { data in
            _ = try decodeRecorded(StarlingsContracts.ThreadsResponse.self, data)
            let model = try decodeRecorded(Starlings.ThreadListResponse.self, data)
            XCTAssertEqual(model.threads.count, try recordedCount("threads", in: data))
        },
        "thread-messages": { data in
            _ = try decodeRecorded(StarlingsContracts.ThreadMessagesResponse.self, data)
            let model = try decodeRecorded(Starlings.ThreadMessagesPage.self, data)
            XCTAssertEqual(model.messages.count, try recordedCount("messages", in: data))
        },
        "peers": { data in
            _ = try decodeRecorded(StarlingsContracts.PeersResponse.self, data)
            let model = try decodeRecorded(Starlings.PeerRoster.self, data)
            XCTAssertEqual(model.peers.count, try recordedCount("peers", in: data))
        },
        "calendar-upcoming": { data in
            let response = try decodeRecorded(StarlingsContracts.CalendarEventsResponse.self, data)
            XCTAssertEqual(response.summaries.count, try recordedCount("events", in: data))
        },
        "crm-inbox": { data in
            _ = try decodeRecorded(StarlingsContracts.InboxResponse.self, data)
            let model = try decodeRecorded(Starlings.ExampleInboxResponse.self, data)
            // An inbox row of a source this build does not know is dropped on purpose;
            // every row the Worker sends today is one it knows.
            XCTAssertEqual(model.items.count, try recordedCount("items", in: data))
        },
        "search": { data in
            _ = try decodeRecorded(StarlingsContracts.SearchResponseWire.self, data)
            let model = try decodeRecorded(Starlings.SearchResponse.self, data)
            XCTAssertEqual(model.rows.count, try recordedCount("rows", in: data))
        },
        "favorites": { data in
            let response = try decodeRecorded(StarlingsContracts.FavoritesResponseWire.self, data)
            XCTAssertEqual(response.favorites.count, try recordedCount("favorites", in: data))
        },
        "crm-starred": { data in
            _ = try decodeRecorded(StarlingsContracts.SearchResponseWire.self, data)
            let model = try decodeRecorded(Starlings.SearchResponse.self, data)
            XCTAssertEqual(model.rows.count, try recordedCount("rows", in: data))
        },
        "decision-asks": { data in
            let response = try decodeRecorded(StarlingsContracts.DecisionAsksResponse.self, data)
            XCTAssertEqual(response.asks.count, try recordedCount("asks", in: data))
        },
        "meeting-category": { data in
            _ = try decodeRecorded(StarlingsContracts.MeetingCategoryResponse.self, data)
            let model = try decodeRecorded(Starlings.MeetingCategory.self, data)
            XCTAssertNotEqual(model.meetingKind, .uncategorized)
        },
    ] }

    private func recordedFiles() throws -> [String: Data] {
        let bundle = Bundle(for: Self.self)
        let directory = try XCTUnwrap(
            bundle.url(forResource: "responses", withExtension: nil),
            "fixtures/responses is not in the test bundle — check project.yml."
        )
        let urls = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        return try Dictionary(uniqueKeysWithValues: urls
            .filter { $0.pathExtension == "json" }
            .map { ($0.deletingPathExtension().lastPathComponent, try Data(contentsOf: $0)) })
    }

    /// A file nobody decodes would be a read the Mac and iPhone never check, and
    /// a read named here without a file would pass on nothing.
    func testEveryRecordedResponseHasADecodeAndEveryDecodeAFile() throws {
        XCTAssertEqual(Set(try recordedFiles().keys), Set(Self.reads.keys))
    }

    func testEveryRecordedResponseDecodesThroughItsWireTypeAndModel() throws {
        for (name, data) in try recordedFiles().sorted(by: { $0.key < $1.key }) {
            let read = try XCTUnwrap(Self.reads[name], "no decode for fixtures/responses/\(name).json")
            do {
                try read(data)
            } catch {
                XCTFail("fixtures/responses/\(name).json does not decode: \(error)")
            }
        }
    }
}
