import Foundation

/// The letters a camera-off tile shows. Shared by the Mac stage, the Mac
/// floating self-view, and the iOS grid — a participant's avatar must not
/// depend on which client is drawing it. The web guest applies the same rule in
/// `participantInitials`, and `fixtures/participant-initials.json` pins both.
///
/// The first letter of the first two words, uppercased, after every
/// parenthetical is dropped: a pronoun, a role or a company in brackets is not
/// part of anybody's name, however many words it holds (`Ana (Envisioning
/// Labs) Silva` is `AS`). An unclosed `(` runs to the end. A letter is a
/// character as a person sees it, so `🇳🇴` and `É` written as `E` plus an accent
/// are one letter each. No letters at all is `?`.
enum ParticipantInitials {
    static func make(from name: String) -> String {
        let withoutParentheticals = name.replacingOccurrences(
            of: #"\([^)]*(\)|$)"#, with: " ", options: .regularExpression
        )
        let parts = withoutParentheticals
            .split(whereSeparator: \.isWhitespace)
            .prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}
