import XCTest
@testable import Starlings

/// Which languages a device expects to hear.
///
/// The interesting property is that an untouched install must behave exactly as
/// it did before this setting existed — an empty selection is "weigh
/// everything", not "label nothing" — and that the store stays canonical
/// whatever order the switches were flipped in.
final class TranscriptionLanguagesTests: XCTestCase {
    private let key = "meet.transcription.languages"
    private var saved: [String]?

    override func setUp() {
        super.setUp()
        saved = UserDefaults.standard.stringArray(forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
    }

    override func tearDown() {
        if let saved {
            UserDefaults.standard.set(saved, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
        super.tearDown()
    }

    func testAnUntouchedInstallWeighsEveryLanguage() {
        XCTAssertTrue(TranscriptionLanguages.selected.isEmpty)
        // Empty means "no preference", so every language stays a candidate.
        // Reading it as "label nothing" would silently break every install
        // that never opens Settings.
        XCTAssertEqual(TranscriptionLanguages.candidates, TranscriptionLanguages.selectable)
    }

    func testChoosingNarrowsTheCandidates() {
        TranscriptionLanguages.selected = [.portuguese, .english]
        XCTAssertEqual(TranscriptionLanguages.candidates, [.english, .portuguese])
        // German is not merely outranked — it is not weighed at all, which is
        // the whole point of choosing.
        XCTAssertFalse(TranscriptionLanguages.candidates.contains(.german))
    }

    func testStoresInOneOrderHoweverItWasChosen() {
        // Two people who pick the same pair in a different order must get the
        // same selection, or the tie-break in `inferLanguage` reads differently
        // on two machines that were configured identically.
        TranscriptionLanguages.selected = [.portuguese, .english]
        XCTAssertEqual(TranscriptionLanguages.selected, [.english, .portuguese])
        TranscriptionLanguages.selected = [.english, .portuguese]
        XCTAssertEqual(TranscriptionLanguages.selected, [.english, .portuguese])
    }

    func testGermanIsNoLongerSelectable() {
        // Envisioning meetings are only ever English or Portuguese (Brazil).
        // `TranscriptLanguage.german` stays a valid case, for old segments, but
        // is not offered — and is dropped from anything written directly.
        XCTAssertFalse(TranscriptionLanguages.selectable.contains(.german))
        TranscriptionLanguages.selected = [.german, .english]
        XCTAssertEqual(TranscriptionLanguages.selected, [.english])
    }

    func testTogglingIsReversibleAndAnswersTheResult() {
        XCTAssertEqual(TranscriptionLanguages.toggle(.portuguese), [.portuguese])
        XCTAssertTrue(TranscriptionLanguages.isSelected(.portuguese))
        XCTAssertEqual(TranscriptionLanguages.toggle(.portuguese), [])
        XCTAssertFalse(TranscriptionLanguages.isSelected(.portuguese))
        // And back to the shipping behaviour, not to nothing.
        XCTAssertEqual(TranscriptionLanguages.candidates, TranscriptionLanguages.selectable)
    }

    func testDropsAStoredLanguageThisBuildNoLongerOffers() {
        // A preference nobody can clear is worse than one that quietly lapses.
        UserDefaults.standard.set(["en", "xx", "und"], forKey: key)
        XCTAssertEqual(TranscriptionLanguages.selected, [.english])
    }

    func testSummaryNamesTheChoiceRatherThanItsCodes() {
        XCTAssertEqual(TranscriptionLanguages.summary([]), "Every language Starlings knows")
        XCTAssertEqual(
            TranscriptionLanguages.summary([.english, .portuguese]),
            "English, Portuguese"
        )
    }
}
