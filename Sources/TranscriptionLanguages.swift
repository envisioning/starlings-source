import Foundation

/// Which languages this device expects to hear when it transcribes.
///
/// **Per device, deliberately.** Transcription is a property of the machine
/// doing the listening — the same machine that already owns its microphone
/// choice in `MediaDeviceService` — so this lives beside that rather than
/// following a person between their Mac and their phone. The two can disagree,
/// and that is correct: they are different rooms with different microphones.
///
/// ## What this does and does not do
///
/// It decides **how a finished segment is labelled**. `LocalMeetingTranscriber`
/// reads the recognized text and picks a language from markers in it; without a
/// selection it weighs every language it knows and falls back to English on a
/// tie, which is how a Portuguese meeting ends up tagged `en`. Narrowing the
/// candidates fixes that, and choosing exactly one removes the guess entirely.
///
/// It also feeds FluidAudio's decoder, but only at the level FluidAudio
/// actually supports: `AsrManager.transcribe`'s `language` hint is a
/// Latin/Cyrillic/Greek *script* filter (`TokenLanguageFilter`, v3 only), not
/// a per-language bias — it cannot tell English from Portuguese, only Latin
/// letters from Cyrillic or Greek ones. `LocalMeetingTranscriber` forwards a
/// selection for exactly that reason: it stops the model wandering into the
/// wrong alphabet mid-meeting, which is the failure this was filed over. Do
/// not let any copy imply it teaches the model to tell the two apart by ear.
enum TranscriptionLanguages {
    /// What may be chosen. `undetermined` is deliberately absent: it is what an
    /// empty selection already means, not something anybody picks.
    ///
    /// Restricted to what Envisioning meetings are actually spoken in.
    /// `TranscriptLanguage.german` stays a valid case, for old segments, but is
    /// not offered here.
    static let selectable: [TranscriptLanguage] = [.english, .portuguese]

    private static let defaultsKey = "meet.transcription.languages"

    /// The languages chosen on this device, in the order above so two screens
    /// never draw the same choice differently.
    ///
    /// Empty means nothing was chosen, which is the shipping behaviour: weigh
    /// everything. An install that never opens Settings behaves exactly as it
    /// did before this existed.
    static var selected: [TranscriptLanguage] {
        get {
            let stored = UserDefaults.standard.stringArray(forKey: defaultsKey) ?? []
            let wanted = Set(stored.compactMap(TranscriptLanguage.init(rawValue:)))
            return selectable.filter(wanted.contains)
        }
        set {
            // Normalized on the way in: stored in the canonical order, with
            // anything unselectable dropped, so a future build that retires a
            // language does not leave a preference nobody can clear.
            let wanted = Set(newValue)
            let kept = selectable.filter(wanted.contains)
            UserDefaults.standard.set(kept.map(\.rawValue), forKey: defaultsKey)
        }
    }

    static func isSelected(_ language: TranscriptLanguage) -> Bool {
        selected.contains(language)
    }

    /// Turn one language on or off, and answer what the selection became.
    @discardableResult
    static func toggle(_ language: TranscriptLanguage) -> [TranscriptLanguage] {
        var next = selected
        if let index = next.firstIndex(of: language) {
            next.remove(at: index)
        } else {
            next.append(language)
        }
        selected = next
        return selected
    }

    /// The languages a transcript may be labelled with: the chosen ones, or
    /// every one this build knows when nothing has been chosen.
    static var candidates: [TranscriptLanguage] {
        let chosen = selected
        return chosen.isEmpty ? selectable : chosen
    }

    /// One line for a settings row. Not a list of codes — the point of the
    /// setting is that a person recognizes their own meetings in it.
    static func summary(_ languages: [TranscriptLanguage] = selected) -> String {
        guard !languages.isEmpty else { return "Every language Starlings knows" }
        return languages.map(\.settingsName).joined(separator: ", ")
    }
}

extension TranscriptLanguage {
    /// What a person calls it. `undetermined` never appears in the picker, but
    /// it can appear on an old segment, so it still needs a word.
    var settingsName: String {
        switch self {
        case .english: return "English"
        case .portuguese: return "Portuguese"
        case .german: return "German"
        case .undetermined: return "Undetermined"
        }
    }
}
