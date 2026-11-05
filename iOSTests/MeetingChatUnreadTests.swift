import XCTest
@testable import Starlings

final class MeetingChatUnreadTests: XCTestCase {
    private func message(id: String, local: Bool) -> MeetingChatMessage {
        MeetingChatMessage(
            id: id,
            timestamp: Date(timeIntervalSince1970: 1_700_000_000),
            text: id,
            senderIdentity: local ? "local" : "remote",
            senderName: local ? "You" : "Guest",
            isLocal: local
        )
    }

    func testCountsOnlyNewRemoteMessages() {
        let previous = [message(id: "old", local: false)]
        let current = previous + [
            message(id: "mine", local: true),
            message(id: "new-1", local: false),
            message(id: "new-2", local: false),
        ]

        XCTAssertEqual(
            MeetingChatUnread.newlyReceivedRemoteMessageCount(previous: previous, current: current),
            2
        )
    }

    func testRepeatedPublishedValuesDoNotRecountMessages() {
        let messages = [message(id: "same", local: false)]

        XCTAssertEqual(
            MeetingChatUnread.newlyReceivedRemoteMessageCount(previous: messages, current: messages),
            0
        )
    }
}
