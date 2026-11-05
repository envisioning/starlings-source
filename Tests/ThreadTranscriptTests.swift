import XCTest
@testable import Starlings

/// The rules that make a transcript readable, tested without a view: where a
/// day starts, where the reader left off, and which lines are one person
/// speaking once.
final class ThreadTranscriptTests: XCTestCase {
    func testReplyAddressIsLimitedToSubjectTalk() {
        let supported: [ThreadKind] = [.project, .lead, .organization, .event]
        for kind in supported {
            let address = ThreadAddress(
                target: .subject(kind: kind, id: "subject"),
                title: "Talk",
                prompt: "Message",
                emptyLine: "Nothing here yet.",
                subtitle: nil
            )
            XCTAssertTrue(address.supportsMessageReplies, "Subject Talk should allow message replies")
        }

        XCTAssertFalse(ThreadAddress.team.supportsMessageReplies)
        let peer = ThreadAddress(
            target: .peer(email: "ada@example.com"),
            title: "Ada",
            prompt: "Message Ada",
            emptyLine: "Nothing here yet.",
            subtitle: nil
        )
        XCTAssertFalse(peer.supportsMessageReplies)
    }

    private func message(
        _ id: String,
        from email: String,
        at date: Date,
        mine: Bool = false,
        type: ThreadMessageType = .text,
        deletedAt: Date? = nil,
        text: String = "hello",
        isPartial: Bool = false,
        attachments: [ThreadMessageAttachment] = [],
        via: String? = nil
    ) -> ThreadMessage {
        ThreadMessage(
            id: id,
            threadID: "t1",
            sentAt: date,
            senderEmail: email,
            senderName: nil,
            text: text,
            isMine: mine,
            type: type,
            attachments: attachments,
            deletedAt: deletedAt,
            isPartial: isPartial,
            via: via
        )
    }

    private let start = Date(timeIntervalSince1970: 1_760_000_000)
    private let agent = "status@example.com"

    func testReplyDraftSelectsFinalTextAndCanBeCancelled() {
        let parent = message("parent", from: "ada@example.com", at: start)
        var draft = ThreadReplyDraft()
        XCTAssertTrue(draft.select(parent))
        XCTAssertEqual(draft.parentMessageID, "parent")
        draft.cancel()
        XCTAssertNil(draft.parentMessageID)
    }

    func testReplyDraftRejectsEventsPartialAndWithdrawnMessages() {
        var draft = ThreadReplyDraft()
        XCTAssertFalse(draft.select(message("event", from: agent, at: start, type: .event)))
        XCTAssertFalse(draft.select(message("partial", from: agent, at: start, isPartial: true)))
        XCTAssertFalse(draft.select(message("deleted", from: agent, at: start, deletedAt: start)))
        XCTAssertNil(draft.parentMessageID)
    }

    func testReplyPreviewUsesOnlyTextAndClampsLongContent() {
        let parent = message("parent", from: "ada@example.com", at: start, text: "  First\nsecond   line  ")
        XCTAssertEqual(ThreadReplyPreviewContent.resolve(parent), .init(author: "ada", text: "First second line"))

        let long = message("long", from: "ada@example.com", at: start, text: String(repeating: "x", count: 130))
        XCTAssertEqual(ThreadReplyPreviewContent.resolve(long).text.count, 120)
        XCTAssertTrue(ThreadReplyPreviewContent.resolve(long).text.hasSuffix("…"))
    }

    func testReplyPreviewDoesNotRevealAttachmentNamesOrWithdrawnText() {
        let attachment = ThreadMessageAttachment(
            id: "file-1", name: "private-plan.pdf", contentType: "application/pdf", bytes: 12
        )
        let fileOnly = message("file", from: "ada@example.com", at: start, text: "", attachments: [attachment])
        XCTAssertEqual(ThreadReplyPreviewContent.resolve(fileOnly).text, "Attachment")
        XCTAssertFalse(ThreadReplyPreviewContent.resolve(fileOnly).text.contains(attachment.name))

        let withdrawn = message("gone", from: "ada@example.com", at: start, deletedAt: start, text: "Secret words", attachments: [attachment])
        XCTAssertEqual(ThreadReplyPreviewContent.resolve(withdrawn).text, "Message withdrawn")
        XCTAssertFalse(ThreadReplyPreviewContent.resolve(withdrawn).text.contains("Secret words"))
        XCTAssertFalse(ThreadReplyPreviewContent.resolve(withdrawn).text.contains(attachment.name))
    }

    func testMissingReplyParentHasAGenericPreview() {
        XCTAssertEqual(ThreadReplyPreviewContent.resolve(nil), .init(author: "Earlier message", text: ""))
    }

    func testFoldsAnAgentsConsecutiveStepsIntoOneTrail() {
        let rows = ThreadTranscript.rows(
            for: [
                message("q", from: "rosa@example.com", at: start, mine: true),
                message("s1", from: agent, at: start.addingTimeInterval(1), type: .event),
                message("s2", from: agent, at: start.addingTimeInterval(2), type: .event),
                message("a", from: agent, at: start.addingTimeInterval(3)),
                message("e", from: "meet@org.example", at: start.addingTimeInterval(4), type: .event),
            ],
            unreadBoundary: nil,
            agentEmails: [agent]
        )
        XCTAssertEqual(rows.count, 5)
        XCTAssertEqual(rows[2].steps?.map(\.id), ["s1", "s2"])
        // Meet's own line stays a line.
        guard case .event = rows[4] else { return XCTFail("expected an event row") }
    }

    func testFoldsNothingWithoutTheRostersAgents() {
        let rows = ThreadTranscript.rows(
            for: [
                message("s1", from: agent, at: start, type: .event),
                message("s2", from: agent, at: start.addingTimeInterval(1), type: .event),
            ],
            unreadBoundary: nil
        )
        XCTAssertEqual(rows.count, 3)
        XCTAssertNil(rows[1].steps)
    }

    func testElapsedLabelReadsLikeAStopwatch() {
        XCTAssertEqual(ThreadTranscript.elapsedLabel(since: start, now: start.addingTimeInterval(7)), "0:07")
        XCTAssertEqual(ThreadTranscript.elapsedLabel(since: start, now: start.addingTimeInterval(102)), "1:42")
        XCTAssertEqual(ThreadTranscript.elapsedLabel(since: start, now: start.addingTimeInterval(725)), "12:05")
        XCTAssertEqual(ThreadTranscript.elapsedLabel(since: start.addingTimeInterval(5), now: start), "0:00")
    }

    func testGroupsConsecutiveMessagesFromOnePerson() {
        let rows = ThreadTranscript.rows(
            for: [
                message("a", from: "ada@example.com", at: start),
                message("b", from: "ada@example.com", at: start.addingTimeInterval(60)),
                message("c", from: "rosa@example.com", at: start.addingTimeInterval(120)),
            ],
            unreadBoundary: nil
        )
        XCTAssertEqual(rows, [
            .day(start),
            .message(rows[1].message!, grouped: false),
            .message(rows[2].message!, grouped: true),
            .message(rows[3].message!, grouped: false),
        ])
    }

    func testBreaksTheGroupPastTheWindow() {
        let rows = ThreadTranscript.rows(
            for: [
                message("a", from: "ada@example.com", at: start),
                message("b", from: "ada@example.com", at: start.addingTimeInterval(600)),
            ],
            unreadBoundary: nil
        )
        // Six minutes apart is a second turn, not another paragraph.
        guard case .message(_, let grouped) = rows[2] else { return XCTFail("expected a message row") }
        XCTAssertFalse(grouped)
    }

    func testBreaksTheGroupWhenTheMembersClaudeTakesOver() {
        let rows = ThreadTranscript.rows(
            for: [
                message("a", from: "ada@example.com", at: start),
                message("b", from: "ada@example.com", at: start.addingTimeInterval(10), via: "claude.ai"),
            ],
            unreadBoundary: nil
        )
        // The "via" tag is in the header, so a line her Claude sent starts a turn.
        guard case .message(_, let grouped) = rows[2] else { return XCTFail("expected a message row") }
        XCTAssertFalse(grouped)
    }

    func testStartsANewDayAndNeverGroupsAcrossIt() {
        let nextDay = start.addingTimeInterval(26 * 3600)
        let rows = ThreadTranscript.rows(
            for: [
                message("a", from: "ada@example.com", at: start),
                message("b", from: "ada@example.com", at: nextDay),
            ],
            unreadBoundary: nil
        )
        XCTAssertEqual(rows.count, 4)
        guard case .day = rows[2] else { return XCTFail("expected a second day divider") }
        guard case .message(_, let grouped) = rows[3] else { return XCTFail("expected a message row") }
        XCTAssertFalse(grouped)
    }

    func testMarksWhereTheReaderLeftOff() {
        let boundary = start.addingTimeInterval(30)
        let rows = ThreadTranscript.rows(
            for: [
                message("a", from: "ada@example.com", at: start),
                message("b", from: "ada@example.com", at: start.addingTimeInterval(60)),
            ],
            unreadBoundary: boundary
        )
        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(rows[2], .unreadMark)
    }

    func testDrawsTheMarkOnlyOnce() {
        let rows = ThreadTranscript.rows(
            for: (0..<3).map {
                message("m\($0)", from: "ada@example.com", at: start.addingTimeInterval(Double($0) * 60))
            },
            unreadBoundary: start.addingTimeInterval(-1)
        )
        XCTAssertEqual(rows.filter { $0 == .unreadMark }.count, 1)
    }

    func testNeverMarksYourOwnMessageAsTheThingYouMissed() {
        let rows = ThreadTranscript.rows(
            for: [message("a", from: "rosa@example.com", at: start, mine: true)],
            unreadBoundary: start.addingTimeInterval(-1)
        )
        XCTAssertFalse(rows.contains(.unreadMark))
    }

    func testEventsAreNeverGroupedAndBreakTheGroupAroundThem() {
        let rows = ThreadTranscript.rows(
            for: [
                message("a", from: "ada@example.com", at: start),
                message("e", from: "meet@org.example", at: start.addingTimeInterval(10), type: .event),
                message("b", from: "ada@example.com", at: start.addingTimeInterval(20)),
            ],
            unreadBoundary: nil
        )
        guard case .event = rows[2] else { return XCTFail("expected an event row") }
        guard case .message(_, let grouped) = rows[3] else { return XCTFail("expected a message row") }
        // The same person, ten seconds later — but not the same breath.
        XCTAssertFalse(grouped)
    }

    func testAWithdrawnMessageBreaksTheGroupOnBothSides() {
        let rows = ThreadTranscript.rows(
            for: [
                message("a", from: "ada@example.com", at: start),
                message("b", from: "ada@example.com", at: start.addingTimeInterval(10), deletedAt: start),
                message("c", from: "ada@example.com", at: start.addingTimeInterval(20)),
            ],
            unreadBoundary: nil
        )
        guard case .message(_, let second) = rows[2] else { return XCTFail("expected a message row") }
        guard case .message(_, let third) = rows[3] else { return XCTFail("expected a message row") }
        XCTAssertFalse(second)
        XCTAssertFalse(third)
    }
}

/// The clock and the working pattern behind a person's header line.
final class PeerWorkingHoursTests: XCTestCase {
    private let nineToSix = PeerWorkingHours(startMinute: 540, endMinute: 1080, days: 0b0011111)

    func testInsideAndOutsideAWeekday() {
        // Calendar weekdays: Sunday is 1, Monday 2, Saturday 7.
        XCTAssertTrue(nineToSix.contains(minuteOfDay: 600, gregorianWeekday: 2))
        XCTAssertFalse(nineToSix.contains(minuteOfDay: 1380, gregorianWeekday: 2))
        XCTAssertFalse(nineToSix.contains(minuteOfDay: 600, gregorianWeekday: 1))
        XCTAssertFalse(nineToSix.contains(minuteOfDay: 600, gregorianWeekday: 7))
    }

    func testAShiftAcrossMidnight() {
        let nights = PeerWorkingHours(startMinute: 1320, endMinute: 360, days: 0b0011111)
        XCTAssertTrue(nights.contains(minuteOfDay: 1380, gregorianWeekday: 3))
        XCTAssertTrue(nights.contains(minuteOfDay: 120, gregorianWeekday: 3))
        XCTAssertFalse(nights.contains(minuteOfDay: 720, gregorianWeekday: 3))
    }

    func testNeverSaidIsUndecidableRatherThanOffDuty() {
        let peer = Peer(email: "ada@example.com", name: "Ada", roomSlug: nil, status: .available)
        XCTAssertNil(peer.isWithinWorkingHours)
        XCTAssertNil(peer.localTimeDescription)
    }

    func testAZoneWithoutHoursStillGivesAClock() {
        let peer = Peer(
            email: "ada@example.com",
            name: "Ada",
            roomSlug: nil,
            status: .available,
            timeZoneIdentifier: "Asia/Tokyo"
        )
        XCTAssertNotNil(peer.localTimeDescription)
        XCTAssertNil(peer.isWithinWorkingHours)
    }
}
