import AppKit

/// The Mac's dictionary, for the transcript name pass: a word the
/// spell checker accepts in the segment's language is a plain word and is
/// never rewritten to a name. Asked with the lowercase form, so a capitalised
/// name entry ("Michel") does not shield a misheard name where "table" does.
enum StarlingsSpellChecker {
    @MainActor
    static func isWord(_ word: String, language: TranscriptLanguage) -> Bool {
        let checker = NSSpellChecker.shared
        for code in codes(for: language) {
            let range = checker.checkSpelling(of: word, startingAt: 0, language: code, wrap: false, inSpellDocumentWithTag: 0, wordCount: nil)
            if range.location == NSNotFound { return true }
        }
        return false
    }

    /// An unclassified segment follows the device's explicit spoken languages,
    /// then the workspace's offered languages. Interface defaults cannot replace
    /// a person's explicit transcription choice.
    static func codes(
        for language: TranscriptLanguage,
        spoken: [TranscriptLanguage] = TranscriptionLanguages.selected,
        offered: [StarlingsLanguage] = StarlingsLanguage.offered
    ) -> [String] {
        switch language {
        case .english: return ["en"]
        case .portuguese: return ["pt_BR", "pt"]
        case .german: return ["de"]
        case .undetermined:
            let explicit = spoken.filter { $0 != .undetermined }
            if !explicit.isEmpty { return explicit.flatMap { codes(for: $0, spoken: [], offered: offered) } }
            return offered.flatMap { $0 == .portuguese ? ["pt_BR", "pt"] : ["en"] }
        }
    }
}
