import Foundation

/// Where an `@mention` is written, read back, and highlighted, on the Mac and
/// on the phone. One rule, so a colleague named correctly on one client
/// cannot silently fail to be named — or drawn — on the other.
///
/// A mention names a person by their email's local part (`ana.silva`, the
/// piece before the `@`) or by the whole address — never by a display name,
/// which nobody but Core treats as an identifier and which two colleagues can
/// share. Web mirrors this in `web/src/ThreadPane.tsx` and `web/src/markdown.tsx`.
enum MentionMatching {
    /// Somebody who can be named. Only the email matters here — a display name
    /// is not a mention target.
    struct Candidate: Sendable {
        let email: String

        init(email: String) {
            self.email = email
        }
    }

    /// Given the finished text, who it still names. Read back off what was
    /// actually typed rather than remembered as somebody composes — a handle
    /// completed and then deleted is not a mention.
    static func mentions(in text: String, candidates: some Sequence<Candidate>) -> [String] {
        let characters = Array(text.lowercased())
        var seen = Set<String>()
        var result: [String] = []
        for candidate in candidates {
            let email = candidate.email.lowercased()
            guard !email.isEmpty, !seen.contains(email) else { continue }
            let named = !ranges(of: localPart(of: email), in: characters).isEmpty
                || !ranges(of: email, in: characters).isEmpty
            guard named else { continue }
            seen.insert(email)
            result.append(candidate.email)
        }
        return result
    }

    /// Where each candidate is actually named in `text` — a mentioned handle,
    /// widest match first, with nothing overlapping kept twice (a full
    /// address wins over the local part sitting inside it). For a renderer
    /// that wants to draw a mention differently from the words around it,
    /// never for a client deciding *whether* something is a mention — that
    /// decision is `mentions(in:candidates:)`, on the same rule.
    ///
    /// Ranges are Character offsets into `text` — safe to slice `Array(text)`
    /// with directly, never `NSRange`/UTF-16; a caller drawing into AppKit or
    /// UIKit converts at that boundary, not here.
    static func highlightRanges(
        in text: String,
        candidates: some Sequence<Candidate>
    ) -> [(range: Range<Int>, email: String)] {
        let characters = Array(text.lowercased())
        guard characters.count == Array(text).count else {
            // Lowercasing changed the character count — a rare case-folding
            // edge (not true of any handle character this ever matches
            // against). Skip highlighting rather than risk slicing `text` at
            // an offset `characters` no longer agrees with.
            return []
        }
        var found: [(range: Range<Int>, email: String)] = []
        for candidate in candidates {
            let email = candidate.email.lowercased()
            guard !email.isEmpty else { continue }
            for needle in Set([localPart(of: email), email]) where !needle.isEmpty {
                for range in ranges(of: needle, in: characters) {
                    found.append((range, candidate.email))
                }
            }
        }
        found.sort {
            $0.range.count != $1.range.count
                ? $0.range.count > $1.range.count
                : $0.range.lowerBound < $1.range.lowerBound
        }
        var kept: [(range: Range<Int>, email: String)] = []
        for candidate in found where !kept.contains(where: { $0.range.overlaps(candidate.range) }) {
            kept.append(candidate)
        }
        return kept.sorted { $0.range.lowerBound < $1.range.lowerBound }
    }

    /// `ana.silva` from `ana.silva@example.com`.
    static func localPart(of email: String) -> String {
        String(email.split(separator: "@", maxSplits: 1).first ?? Substring(email))
    }

    /// Every `@needle` in `characters` that is a whole handle, not a piece of
    /// a longer one — `contains("@ana")` is also true of `@ana.wilson`, and a
    /// mention that reaches the wrong colleague every time one handle happens
    /// to start the same way as another's is worse than none at all. Each
    /// returned range includes the leading `@`.
    private static func ranges(of needle: String, in characters: [Character]) -> [Range<Int>] {
        guard !needle.isEmpty else { return [] }
        let pattern = Array("@" + needle)
        var results: [Range<Int>] = []
        var index = 0
        while index + pattern.count <= characters.count {
            if Array(characters[index..<(index + pattern.count)]) == pattern {
                let leadOK = index == 0 || !lastScalarIsHandleCharacter(in: characters[index - 1])
                let tailIndex = index + pattern.count
                let tailOK = tailIndex >= characters.count
                    || !firstScalarIsHandleCharacter(in: characters[tailIndex])
                if leadOK, tailOK {
                    results.append(index..<tailIndex)
                    index = tailIndex
                    continue
                }
            }
            index += 1
        }
        return results
    }

    /// What a handle or an email's local part is made of — wide enough that
    /// `ana.silva` and `ana_silva` both bound correctly, narrow enough that a
    /// sentence's own punctuation never reads as part of one.
    private static func lastScalarIsHandleCharacter(in character: Character) -> Bool {
        guard let scalar = character.unicodeScalars.last else { return false }
        return isHandleScalar(scalar)
    }

    private static func firstScalarIsHandleCharacter(in character: Character) -> Bool {
        guard let scalar = character.unicodeScalars.first else { return false }
        return isHandleScalar(scalar)
    }

    /// Match Unicode general categories L/M/N with the web's code-point
    /// predicate. A `Character` can contain both a base letter and combining
    /// marks; use the scalar touching the boundary so punctuation plus a mark
    /// stays punctuation on both clients.
    private static func isHandleScalar(_ scalar: Unicode.Scalar) -> Bool {
        return switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .nonspacingMark, .spacingMark, .enclosingMark,
             .decimalNumber, .letterNumber, .otherNumber:
            true
        default:
            scalar == "." || scalar == "_" || scalar == "+" || scalar == "-"
        }
    }
}
