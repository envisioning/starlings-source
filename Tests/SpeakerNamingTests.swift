import XCTest
@testable import Starlings

/// Names for clusters by overlap voting, and spellings from the roster
/// (docs/AMBIENT_CAPTURE.md §5).
final class SpeakerNamingTests: XCTestCase {
    private func turn(_ s: String, _ a: Double, _ b: Double) -> SpeakerMerger.Turn { .init(speaker: s, start: a, end: b) }
    private func lit(_ name: String, _ seconds: [Double]) -> [SpeakerNaming.SpeakingEvent] { seconds.map { .init(name: name, at: $0) } }

    func testClustersTakeTheNameWhoseTileWasLitWhileTheySpoke() {
        let turns = [turn("S0", 0, 10), turn("S1", 12, 20), turn("S0", 22, 30)]
        let events = lit("Ana", [1, 2, 3, 4, 5, 6, 7, 8, 23, 24, 25, 26, 27]) + lit("Bo", [13, 14, 15, 16, 17, 18])
        let names = SpeakerNaming.resolve(turns: turns, events: events)
        XCTAssertEqual(names, ["S0": "Ana", "S1": "Bo"])
    }

    func testAClusterNobodyLitStaysUnnamedAndTheOwnerIsNeverACandidate() {
        let turns = [turn("S0", 0, 10), turn("S1", 12, 20)]
        let events = lit("Ana", [1, 2, 3, 4, 5]) + lit("Rosa", [13, 14, 15, 16, 17])
        let names = SpeakerNaming.resolve(turns: turns, events: events, exclude: ["Rosa"])
        XCTAssertEqual(names, ["S0": "Ana"])
        let applied = SpeakerNaming.apply(names, to: [
            .init(speaker: "S1", start: 12, end: 20, text: "x", wordCount: 1),
            .init(speaker: "S0", start: 0, end: 10, text: "y", wordCount: 1),
        ])
        XCTAssertEqual(applied.map(\.speaker), ["Speaker 1", "Ana"])
    }

    func testATooCloseVoteNamesNobody() {
        let turns = [turn("S0", 0, 10)]
        let events = lit("Ana", [1, 2, 3, 4]) + lit("Bo", [5, 6, 7, 8])
        XCTAssertEqual(SpeakerNaming.resolve(turns: turns, events: events), [:])
    }

    func testANameIsClaimedOnce() {
        let turns = [turn("S0", 0, 10), turn("S1", 10, 20)]
        let events = lit("Ana", [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13])
        let names = SpeakerNaming.resolve(turns: turns, events: events)
        XCTAssertEqual(names, ["S0": "Ana"])
    }

    func testNamesAreCorrectedToTheRosterSpelling() {
        let glossary = NameCorrection.glossary(from: ["Felix Andrade", "Rosa Ortiz", "Bo"])
        XCTAssertEqual(NameCorrection.correct("I spoke with Felyx and Rossa about it.", glossary: glossary), "I spoke with Felix and Rosa about it.")
        // Idempotent, and short common words are never touched.
        let once = NameCorrection.correct("Felix said no, so we go.", glossary: glossary)
        XCTAssertEqual(NameCorrection.correct(once, glossary: glossary), once)
        XCTAssertEqual(NameCorrection.correct("The orbit is broken.", glossary: glossary), "The orbit is broken.")
        XCTAssertEqual(NameCorrection.correct("Andrada joined late.", glossary: glossary), "Andrade joined late.")
    }
}
