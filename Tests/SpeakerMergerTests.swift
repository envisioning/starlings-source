import XCTest
@testable import Starlings

/// The two-track pass's middle, on fixtures (docs/AMBIENT_CAPTURE.md §2).
final class SpeakerMergerTests: XCTestCase {
    private func tok(_ t: String, _ s: Double, _ e: Double) -> (token: String, start: Double, end: Double) { (t, s, e) }

    func testTokensGlueIntoWordsOnTheSpaceMarker() {
        let words = SpeakerMerger.words(fromTokens: [tok(" Let", 0, 0.2), tok("'s", 0.2, 0.3), tok(" start", 0.4, 0.8), tok("▁now", 0.9, 1.1)])
        XCTAssertEqual(words.map(\.text), ["Let's", "start", "now"])
        XCTAssertEqual(words[0].start, 0)
        XCTAssertEqual(words[0].end, 0.3)
    }

    func testWordsGoToTheCoveringTurnAndGapsToTheNearest() {
        let words = [
            SpeakerMerger.Word(text: "hi", start: 0, end: 0.5),
            SpeakerMerger.Word(text: "there", start: 0.5, end: 1),
            SpeakerMerger.Word(text: "hello", start: 3, end: 3.5),
            SpeakerMerger.Word(text: "far", start: 20, end: 20.5),
        ]
        let turns = [SpeakerMerger.Turn(speaker: "S0", start: 0, end: 1.2), SpeakerMerger.Turn(speaker: "S1", start: 2.5, end: 4)]
        XCTAssertEqual(SpeakerMerger.assign(words, to: turns), ["S0", "S0", "S1", "S1"])
    }

    func testNoTurnsMeansEveryWordIsUnattributed() {
        let words = [SpeakerMerger.Word(text: "a", start: 0, end: 1)]
        XCTAssertEqual(SpeakerMerger.assign(words, to: []), [nil])
        XCTAssertEqual(SpeakerMerger.segments(words: words, speakers: [nil], fallback: "Speaker").map(\.speaker), ["Speaker"])
    }

    func testFragmentsHealLeftAndSameSpeakerRunsConsolidate() {
        let words = [
            SpeakerMerger.Word(text: "we", start: 0, end: 0.3),
            SpeakerMerger.Word(text: "agreed", start: 0.3, end: 0.8),
            SpeakerMerger.Word(text: "yes", start: 0.9, end: 1.1),   // one short word, other speaker: a fragment
            SpeakerMerger.Word(text: "on", start: 1.2, end: 1.4),
            SpeakerMerger.Word(text: "Friday", start: 1.4, end: 1.9),
            SpeakerMerger.Word(text: "approved", start: 5, end: 6.2), // one word over a second: stands
        ]
        let speakers: [String?] = ["A", "A", "B", "A", "A", "B"]
        let segments = SpeakerMerger.segments(words: words, speakers: speakers, fallback: "Speaker")
        XCTAssertEqual(segments.map(\.speaker), ["A", "B"])
        XCTAssertEqual(segments[0].text, "we agreed yes on Friday")
        XCTAssertEqual(segments[1].text, "approved")
    }

    func testTheLeftmostFragmentMergesRightAndTakesItsNeighboursSpeaker() {
        let words = [
            SpeakerMerger.Word(text: "um", start: 0, end: 0.2),
            SpeakerMerger.Word(text: "so", start: 0.3, end: 0.6),
            SpeakerMerger.Word(text: "then", start: 0.6, end: 1),
        ]
        let segments = SpeakerMerger.segments(words: words, speakers: ["B", "A", "A"], fallback: "Speaker")
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].speaker, "A")
        XCTAssertEqual(segments[0].text, "um so then")
    }

    func testInterleaveOrdersByStartWithTheMicFirstOnATie() {
        let mic = [SpeakerMerger.Segment(speaker: "Me", start: 1, end: 2, text: "m", wordCount: 1)]
        let system = [
            SpeakerMerger.Segment(speaker: "S0", start: 0, end: 0.5, text: "a", wordCount: 1),
            SpeakerMerger.Segment(speaker: "S1", start: 1, end: 3, text: "b", wordCount: 1),
        ]
        XCTAssertEqual(SpeakerMerger.interleave(mic: mic, system: system).map(\.text), ["a", "m", "b"])
    }
}
