import XCTest
@testable import Starlings

/// `fixtures/transcript-names.json` is the contract for the transcript name
/// pass (meet#155); this holds `TranscriptNameLexicon` to it.
final class TranscriptNameLexiconTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Case: Decodable {
            let name: String
            let names: [String]
            let language: TranscriptLanguage
            let heard: String
            let expected: String
        }
        let words: [String: [String]]
        let cases: [Case]
    }

    private func loadFixture() throws -> Fixture {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "transcript-names", withExtension: "json"),
            "fixtures/transcript-names.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    @MainActor
    func testEveryCaseInTheFixture() throws {
        let fixture = try loadFixture()
        let words = fixture.words
        let isWord: TranscriptNameLexicon.WordChecker = { word, language in
            words[language.rawValue, default: []].contains(word)
        }
        for entry in fixture.cases {
            let lexicon = TranscriptNameLexicon(names: entry.names)
            XCTAssertEqual(lexicon.correct(entry.heard, language: entry.language, isWord: isWord), entry.expected, entry.name)
        }
    }

    @MainActor
    func testASegmentKeepsEverythingButItsText() {
        let lexicon = TranscriptNameLexicon(names: ["Luiz Silva"])
        let heard = TranscriptSegment(
            id: UUID(), meetingID: "m", speakerID: "owner:rosa", speakerName: "Rosa",
            language: .english, startsAtMilliseconds: 10, endsAtMilliseconds: 900,
            text: "Luís is here.", isFinal: true
        )
        let written = lexicon.correct(heard, isWord: nil)
        XCTAssertEqual(written.text, "Luiz is here.")
        XCTAssertEqual(written.id, heard.id)
        XCTAssertEqual(written.speakerName, heard.speakerName)
        XCTAssertEqual(written.startsAtMilliseconds, heard.startsAtMilliseconds)
        // Unchanged text is the same value, not a copy.
        XCTAssertEqual(lexicon.correct(written, isWord: nil), written)
    }

    func testSoundFoldsWhatTheRecognizerConfuses() {
        XCTAssertEqual(TranscriptNameLexicon.sound(of: "luis"), TranscriptNameLexicon.sound(of: "luiz"))
        XCTAssertEqual(TranscriptNameLexicon.sound(of: "joel"), TranscriptNameLexicon.sound(of: "joell"))
        XCTAssertNotEqual(TranscriptNameLexicon.sound(of: "sergio"), TranscriptNameLexicon.sound(of: "serge"))
        XCTAssertEqual(TranscriptNameLexicon.fold("Sérgio"), "sergio")
        XCTAssertEqual(TranscriptNameLexicon.fold("O’Neil"), "oneil")
    }
}
