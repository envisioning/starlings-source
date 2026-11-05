import XCTest
@testable import Starlings

/// The tally every client keeps for reactions on in-meeting chat.
///
/// It is fed by a data topic, which means it applies bytes any participant may
/// publish. Two properties are what make that safe to do: a packet outside the
/// shape changes nothing at all, and the same packet twice leaves the tally
/// exactly where it was — which is what lets a toggle survive a redelivery or
/// a client that lost track.
///
/// `packages/contracts/src/chat-reactions.ts` holds the same rules for the
/// browser, and `services/control-plane/test/chat-reactions.test.ts` tests
/// them there. Both are here so the two halves cannot drift quietly.
final class ChatReactionTallyTests: XCTestCase {
    private let thumbsUp = MeetingReaction.thumbsUp
    private let party = MeetingReaction.party

    private func packet(_ reaction: MeetingReaction, on: Bool, message: String = "TX_1") -> ChatReactionMessage {
        ChatReactionMessage(messageID: message, reaction: reaction, on: on)
    }

    func testCountsPeopleRatherThanPackets() {
        var tally = ChatReactionTally()
        XCTAssertTrue(tally.apply(packet(thumbsUp, on: true), from: "rosa"))
        // The same person again is not a second reactor, and not a redraw.
        XCTAssertFalse(tally.apply(packet(thumbsUp, on: true), from: "rosa"))
        XCTAssertTrue(tally.apply(packet(thumbsUp, on: true), from: "ada"))
        XCTAssertEqual(tally.reactions(on: "TX_1").first?.count, 2)
    }

    func testTakingOneOffLeavesTheRest() {
        var tally = ChatReactionTally()
        tally.apply(packet(thumbsUp, on: true), from: "rosa")
        tally.apply(packet(thumbsUp, on: true), from: "ada")
        tally.apply(packet(thumbsUp, on: false), from: "rosa")
        XCTAssertEqual(tally.reactions(on: "TX_1").first?.reactors, ["ada"])
        XCTAssertFalse(tally.contains("rosa", reaction: thumbsUp, on: "TX_1"))
    }

    func testForgetsAnEmojiNobodyHasAndAMessageNobodyReactedTo() {
        // An emoji with no reactors is not an empty pill, it is no pill.
        var tally = ChatReactionTally()
        tally.apply(packet(party, on: true), from: "rosa")
        tally.apply(packet(party, on: false), from: "rosa")
        XCTAssertTrue(tally.isEmpty(on: "TX_1"))
        XCTAssertEqual(tally.reactions(on: "TX_1").count, 0)
    }

    func testTakingOffWhatWasNeverOnChangesNothing() {
        var tally = ChatReactionTally()
        XCTAssertFalse(tally.apply(packet(thumbsUp, on: false), from: "rosa"))
        XCTAssertTrue(tally.isEmpty(on: "TX_1"))
    }

    func testDrawsTheRowInTheOrderThePaletteIsIn() {
        // Two clients showing the same message must show the same row, which a
        // dictionary's own order would not give them.
        var tally = ChatReactionTally()
        for reaction in ChatReaction.emoji.reversed() {
            tally.apply(packet(reaction, on: true), from: "rosa")
        }
        XCTAssertEqual(tally.reactions(on: "TX_1").map(\.reaction), ChatReaction.emoji)
    }

    func testRefusesAPacketItCannotVouchFor() {
        // Malformed and unrecognized end the same way, or the difference
        // becomes something to probe on a topic any guest can publish to.
        let unknownEmoji = try! JSONDecoder().decode(
            ChatReactionMessage.self,
            from: Data(#"{"version":1,"message_id":"TX_1","emoji":"🦆","on":true}"#.utf8)
        )
        let wrongVersion = try! JSONDecoder().decode(
            ChatReactionMessage.self,
            from: Data(#"{"version":2,"message_id":"TX_1","emoji":"👍","on":true}"#.utf8)
        )
        let emptyID = try! JSONDecoder().decode(
            ChatReactionMessage.self,
            from: Data(#"{"version":1,"message_id":"","emoji":"👍","on":true}"#.utf8)
        )
        // A message id long enough to be a payload of its own is not a stream
        // id, and would be a way to grow every client's map.
        let hugeID = try! JSONDecoder().decode(
            ChatReactionMessage.self,
            from: Data(#"{"version":1,"message_id":"\#(String(repeating: "x", count: 129))","emoji":"👍","on":true}"#.utf8)
        )

        var tally = ChatReactionTally()
        for bad in [unknownEmoji, wrongVersion, emptyID, hugeID] {
            XCTAssertNil(bad.reaction)
            XCTAssertFalse(tally.apply(bad, from: "rosa"))
        }
        XCTAssertTrue(tally.isEmpty(on: "TX_1"))
    }

    func testRoundTripsThroughTheWire() {
        let sent = ChatReactionMessage(messageID: "TX_9", reaction: party, on: false)
        let data = try! JSONEncoder().encode(sent)
        let read = try! JSONDecoder().decode(ChatReactionMessage.self, from: data)
        XCTAssertEqual(read.reaction, party)
        XCTAssertEqual(read.messageID, "TX_9")
        XCTAssertFalse(read.on)
        // The key the browser reads, spelled the way the browser spells it.
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("\"message_id\""))
    }
}
