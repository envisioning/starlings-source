import UIKit

/// The phone's dictionary, for the transcript name pass: the same
/// contract as the Mac's `StarlingsSpellChecker`, on `UITextChecker`.
enum MobileSpellChecker {
    @MainActor
    static func isWord(_ word: String, language: TranscriptLanguage) -> Bool {
        let checker = UITextChecker()
        let range = NSRange(location: 0, length: (word as NSString).length)
        for code in codes(for: language) {
            let misspelled = checker.rangeOfMisspelledWord(in: word, range: range, startingAt: 0, wrap: false, language: code)
            if misspelled.location == NSNotFound { return true }
        }
        return false
    }

    private static func codes(for language: TranscriptLanguage) -> [String] {
        switch language {
        case .english: ["en_US"]
        case .portuguese: ["pt_BR", "pt_PT"]
        case .german: ["de_DE"]
        case .undetermined: ["en_US", "pt_BR"]
        }
    }
}
