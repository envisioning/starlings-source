import XCTest
@testable import Starlings

final class MessageNoticeTests: XCTestCase {
    private func thread(
        id: String,
        peer: String = "ada@example.com",
        at: Date?,
        unread: Bool,
        preview: String? = "ping"
    ) -> ThreadSummary {
        ThreadSummary(
            id: id,
            kind: .dm,
            parentID: nil,
            peerEmail: peer,
            peerName: "Ada",
            lastMessageAt: at,
            lastMessagePreview: preview,
            lastSenderEmail: peer,
            unread: unread
        )
    }

    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    /// The first poll after a launch must record what it sees and announce
    /// nothing — otherwise opening the app fires a banner for every
    /// conversation with an old unread message, which is news about history.
    func testFirstObservationRecordsWithoutAnnouncing() {
        let result = MessageNotices.plan(
            threads: [thread(id: "t1", at: epoch, unread: true)],
            seen: [:],
            activeThreadID: nil,
            previousObservation: nil
        )
        XCTAssertTrue(result.notices.isEmpty)
        XCTAssertEqual(result.seen["t1"], epoch)
    }

    func testAnnouncesAMessageNewerThanWhatWasSeen() {
        let later = epoch.addingTimeInterval(60)
        let result = MessageNotices.plan(
            threads: [thread(id: "t1", at: later, unread: true)],
            seen: ["t1": epoch],
            activeThreadID: nil,
            previousObservation: epoch
        )
        XCTAssertEqual(result.notices.count, 1)
        XCTAssertEqual(result.notices.first?.title, "Ada")
        XCTAssertEqual(result.notices.first?.body, "ping")
        XCTAssertEqual(result.seen["t1"], later)
    }

    /// The conversation on screen announces itself by showing the message.
    func testStaysQuietForTheConversationOnScreen() {
        let later = epoch.addingTimeInterval(60)
        let result = MessageNotices.plan(
            threads: [thread(id: "t1", at: later, unread: true)],
            seen: ["t1": epoch],
            activeThreadID: "t1",
            previousObservation: epoch
        )
        XCTAssertTrue(result.notices.isEmpty)
        // Still recorded, so leaving the thread does not fire a late banner.
        XCTAssertEqual(result.seen["t1"], later)
    }

    func testStaysQuietWhenNothingIsUnreadOrNothingIsNewer() {
        let later = epoch.addingTimeInterval(60)
        let read = MessageNotices.plan(
            threads: [thread(id: "t1", at: later, unread: false)],
            seen: ["t1": epoch], activeThreadID: nil, previousObservation: epoch
        )
        XCTAssertTrue(read.notices.isEmpty)

        let repeated = MessageNotices.plan(
            threads: [thread(id: "t1", at: epoch, unread: true)],
            seen: ["t1": epoch], activeThreadID: nil, previousObservation: epoch
        )
        XCTAssertTrue(repeated.notices.isEmpty, "the same message must not announce twice")
    }

    func testAnnouncesEachConversationSeparately() {
        let later = epoch.addingTimeInterval(60)
        let result = MessageNotices.plan(
            threads: [
                thread(id: "t1", peer: "ada@example.com", at: later, unread: true),
                thread(id: "t2", peer: "sam@example.org", at: later, unread: true),
            ],
            seen: ["t1": epoch, "t2": epoch],
            activeThreadID: nil,
            previousObservation: epoch
        )
        XCTAssertEqual(Set(result.notices.map(\.threadID)), ["t1", "t2"])
    }

    /// A conversation that did not exist at the last poll — a new lead
    /// channel, a first DM — announces its first message. Before this rule a
    /// thread absent from `seen` was only recorded, so a new conversation's
    /// opening line could never banner.
    func testAnnouncesTheFirstMessageInANewConversation() {
        let poll = epoch
        let result = MessageNotices.plan(
            threads: [thread(id: "new", at: poll.addingTimeInterval(5), unread: true)],
            seen: ["t1": epoch],
            activeThreadID: nil,
            previousObservation: poll
        )
        XCTAssertEqual(result.notices.map(\.threadID), ["new"])
        XCTAssertEqual(result.seen["new"], poll.addingTimeInterval(5))
    }

    /// Being added to a conversation with history is not news: its newest
    /// message predates the last poll, so it is recorded and stays quiet.
    func testStaysQuietForANewConversationWithOnlyOldMessages() {
        let poll = epoch
        let old = poll.addingTimeInterval(-3_600)
        let result = MessageNotices.plan(
            threads: [thread(id: "joined", at: old, unread: true)],
            seen: [:],
            activeThreadID: nil,
            previousObservation: poll
        )
        XCTAssertTrue(result.notices.isEmpty)
        XCTAssertEqual(result.seen["joined"], old)
    }

    /// Clock skew between the phone (poll time) and the control plane
    /// (message time) must not swallow a new conversation's first message.
    func testNewConversationToleratesSmallClockSkew() {
        let result = MessageNotices.plan(
            threads: [thread(id: "new", at: epoch.addingTimeInterval(-10), unread: true)],
            seen: [:],
            activeThreadID: nil,
            previousObservation: epoch
        )
        XCTAssertEqual(result.notices.map(\.threadID), ["new"])
    }

    /// The other rules still hold for a new conversation: on screen, read,
    /// or the first poll after launch — no banner.
    func testNewConversationStillRespectsTheOtherRules() {
        let recent = epoch.addingTimeInterval(5)
        let onScreen = MessageNotices.plan(
            threads: [thread(id: "new", at: recent, unread: true)],
            seen: [:], activeThreadID: "new", previousObservation: epoch
        )
        XCTAssertTrue(onScreen.notices.isEmpty)

        let read = MessageNotices.plan(
            threads: [thread(id: "new", at: recent, unread: false)],
            seen: [:], activeThreadID: nil, previousObservation: epoch
        )
        XCTAssertTrue(read.notices.isEmpty)

        let firstPoll = MessageNotices.plan(
            threads: [thread(id: "new", at: recent, unread: true)],
            seen: [:], activeThreadID: nil, previousObservation: nil
        )
        XCTAssertTrue(firstPoll.notices.isEmpty)

        // And once recorded, the same message never announces twice.
        let announced = MessageNotices.plan(
            threads: [thread(id: "new", at: recent, unread: true)],
            seen: [:], activeThreadID: nil, previousObservation: epoch
        )
        let again = MessageNotices.plan(
            threads: [thread(id: "new", at: recent, unread: true)],
            seen: announced.seen, activeThreadID: nil, previousObservation: recent.addingTimeInterval(10)
        )
        XCTAssertEqual(announced.notices.count, 1)
        XCTAssertTrue(again.notices.isEmpty)
    }
}
