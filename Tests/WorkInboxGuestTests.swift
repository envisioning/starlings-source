import Foundation
import StarlingsContracts
import XCTest
@testable import Starlings

/// A guest INBOX row: an app user on `intake` opens its conversation, and a
/// guest line on a subject opens that subject's Talk.
final class WorkInboxGuestTests: XCTestCase {
    private func decode(_ json: String) throws -> WorkInboxResponse {
        try JSONDecoder().decode(WorkInboxResponse.self, from: Data(json.utf8))
    }

    private func row(subject: String, origin: String) -> String {
        """
        {"items": [{"source": "guest", "key": "guest:thread-app", "at": 1, "thread_id": "thread-app",
          "subject": \(subject), "sender_email": null, "preview": "Can I export my notes?", "origin": "\(origin)"}],
         "recent": [], "partial": [], "recent_partial": []}
        """
    }

    func testAnAppUserOnIntakeOpensItsConversation() throws {
        let response = try decode(row(subject: #"{"kind": "organization", "id": "intake", "title": "App user · Ada"}"#, origin: "app"))
        let item = try XCTUnwrap(response.items.first)
        XCTAssertEqual(item.id, "guest:thread-app")
        XCTAssertEqual(item.glanceThreadID, "thread-app")
        XCTAssertNil(item.glanceDestination)
        XCTAssertEqual(item.glanceTitle, "App user · Ada")
        XCTAssertEqual(item.glanceDetail, "App user · Can I export my notes?")
        XCTAssertTrue(item.notifiesLocally)
        XCTAssertTrue(item.matches(.guest))
    }

    func testAGuestLineOnASubjectOpensItsTalk() throws {
        let response = try decode(row(subject: #"{"kind": "lead", "id": "lead-1", "title": "Acme"}"#, origin: "guest"))
        let item = try XCTUnwrap(response.items.first)
        XCTAssertNil(item.glanceThreadID)
        XCTAssertEqual(item.glanceDestination, WorkDestination(subject: CrmSubject(id: "lead-1", kind: "lead", title: "Acme", subtitle: nil), pane: .talk))
    }

    func testAThreadAddressByIDIsKeyedByTheThread() {
        let address = ThreadAddress.thread(id: "thread-app", title: "App user · Ada")
        XCTAssertEqual(address.id, "thread:thread-app")
        XCTAssertNil(address.peerEmail)
        XCTAssertFalse(address.supportsMessageReplies)
    }
}
