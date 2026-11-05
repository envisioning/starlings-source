import XCTest
@testable import Starlings

final class ThreadMessageContractTests: XCTestCase {
    func testOlderMessageWithoutReplyParentDecodes() throws {
        let message = try decode([:])
        XCTAssertNil(message.replyToMessageID)
    }

    func testExplicitNullReplyParentDecodes() throws {
        let message = try decode(["reply_to_message_id": NSNull()])
        XCTAssertNil(message.replyToMessageID)
    }

    func testReplyParentIdDecodes() throws {
        let message = try decode(["reply_to_message_id": "parent-1"])
        XCTAssertEqual(message.replyToMessageID, "parent-1")
    }

    func testMalformedReplyParentDoesNotDecode() {
        XCTAssertThrowsError(try decode(["reply_to_message_id": 42]))
    }

    func testSendRequestEncodesReplyParentAndOmitsUnsetParent() throws {
        let reply = ThreadSendRequest(text: "Reply", replyToMessageID: .value("parent-1"))
        let replyObject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(reply)) as? [String: Any])
        XCTAssertEqual(replyObject["reply_to_message_id"] as? String, "parent-1")

        let root = ThreadSendRequest(text: "Root message")
        let rootObject = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(root)) as? [String: Any])
        XCTAssertNil(rootObject["reply_to_message_id"])
    }

    private func decode(_ replyFields: [String: Any]) throws -> ThreadMessage {
        var object: [String: Any] = [
            "id": "message-1",
            "thread_id": "thread-1",
            "sent_at": 1_760_000_000_000,
            "sender_email": "ada@example.com",
            "sender_name": "Ada",
            "text": "Hello",
            "is_mine": false,
            "type": "text",
        ]
        object.merge(replyFields) { _, new in new }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(ThreadMessage.self, from: data)
    }
}

/// The Mac's message-banner rule (`MessageNotices.plan`). Kept identical in
/// reasoning to `iOSTests/MessageNoticeTests.swift`; here the case that broke
/// in production — a new lead channel's first line, with channel
/// notifications widened to every message — leads.
final class MessageNoticesPlanTests: XCTestCase {
    private let poll = Date(timeIntervalSince1970: 1_700_000_000)

    private func channel(id: String, kind: ThreadKind = .lead, at: Date, unread: Bool = true) -> ThreadSummary {
        ThreadSummary(
            id: id, kind: kind, parentID: nil, peerEmail: nil, peerName: nil,
            lastMessageAt: at, lastMessagePreview: "New Lead Created: TEST",
            lastSenderEmail: "core@example.com", unread: unread
        )
    }

    private func plan(
        _ threads: [ThreadSummary],
        seen: [String: Date] = [:],
        active: String? = nil,
        previous: Date?,
        allChannels: Bool = true
    ) -> (notices: [MessageNotice], seen: [String: Date]) {
        MessageNotices.plan(
            threads: threads, seen: seen, activeThreadID: active,
            previousObservation: previous, notifyOnAllChannelMessages: allChannels
        )
    }

    func testANewConversationAnnouncesItsFirstMessage() {
        let at = poll.addingTimeInterval(3)
        let result = plan([channel(id: "lead-1", at: at)], previous: poll)
        XCTAssertEqual(result.notices.map(\.threadID), ["lead-1"])
        XCTAssertEqual(result.seen["lead-1"], at)
    }

    func testANewConversationWithOnlyOldMessagesStaysQuiet() {
        let result = plan([channel(id: "joined", at: poll.addingTimeInterval(-3_600))], previous: poll)
        XCTAssertTrue(result.notices.isEmpty)
        XCTAssertNotNil(result.seen["joined"])
    }

    func testFirstObservationAfterLaunchStaysQuiet() {
        let result = plan([channel(id: "lead-1", at: poll.addingTimeInterval(3))], previous: nil)
        XCTAssertTrue(result.notices.isEmpty)
        XCTAssertNotNil(result.seen["lead-1"])
    }

    func testANewChannelStillNeedsAMentionUnlessWidened() {
        let result = plan([channel(id: "lead-1", at: poll.addingTimeInterval(3))], previous: poll, allChannels: false)
        XCTAssertTrue(result.notices.isEmpty)
    }

    func testTheConversationOnScreenStaysQuiet() {
        let result = plan([channel(id: "lead-1", at: poll.addingTimeInterval(3))], active: "lead-1", previous: poll)
        XCTAssertTrue(result.notices.isEmpty)
    }

    func testAKnownConversationAnnouncesOnlyWhatIsNewer() {
        let seenAt = poll.addingTimeInterval(-600)
        let newer = plan([channel(id: "t", at: poll.addingTimeInterval(3))], seen: ["t": seenAt], previous: poll)
        XCTAssertEqual(newer.notices.count, 1)
        let same = plan([channel(id: "t", at: seenAt)], seen: ["t": seenAt], previous: poll)
        XCTAssertTrue(same.notices.isEmpty, "the same message must not announce twice")
        let read = plan([channel(id: "t", at: poll.addingTimeInterval(3), unread: false)], seen: ["t": seenAt], previous: poll)
        XCTAssertTrue(read.notices.isEmpty)
    }
}
