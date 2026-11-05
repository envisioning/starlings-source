import Foundation

/// Names spelled the way the people in the room spell them, applied to what
/// the recognizer heard. Local STT writes a name as it sounds —
/// Tomás for Thomaz, Fábio for Fabio, Marcel for Marcell — and the wrong
/// spelling then rides into the caption panel, the artifact, Core's note and
/// the task titles. The right spelling is already in the room: the roster,
/// the team, the calendar. This is a text pass on the hosting device before a
/// segment reaches the outbox, so invariant 7 holds: text only, still local.
///
/// One rule per word, in order, and the first that answers wins:
///
/// 1. Under four letters: left alone. Too many real words.
/// 2. The same word as a known name, ignoring accents and case: the name's
///    spelling ("Fábio" → "Fabio").
/// 3. A dictionary word in the segment's language, in lowercase: left alone.
///    Names are capitalised entries, so "michel" is flagged where "table" is
///    not, and a plain word is never rewritten because a name sounds like it.
/// 4. The same sound as exactly one known name — accents folded, th → t,
///    ph → f, z → s, y → i, ck/q/c → k, doubles collapsed, a final e
///    dropped: that name
///    ("Tomás" → "Thomaz"). Two names sharing the sound is a tie, and a tie
///    is left alone: with both Marcell and Marcelle in the room, "Marcel"
///    stays "Michel" rather than become the wrong person.
/// 5. Within a small edit distance of exactly one known name, on the folded
///    word (`NameCorrection`'s rule: one edit to six letters, two from
///    seven): that name. Ties are left alone here too.
///
/// Pure and idempotent: correcting a corrected line changes nothing.
struct TranscriptNameLexicon: Sendable, Equatable {
    /// Whether `word` (already lowercased) is a plain word of `language` —
    /// the client's spell checker, which is `@MainActor` on both platforms.
    typealias WordChecker = @MainActor (String, TranscriptLanguage) -> Bool

    /// Folded lowercase word → the spelling to write.
    private let spellings: [String: String]
    /// Phonetic key → the distinct spellings that share it.
    private let bySound: [String: Set<String>]

    static let empty = TranscriptNameLexicon(names: [])

    var isEmpty: Bool { spellings.isEmpty }

    /// Every word of every name, four letters or longer. "Fabio Andrade"
    /// contributes Fabio and Andrade; a first name alone contributes itself.
    init(names: [String]) {
        var spellings: [String: String] = [:]
        var bySound: [String: Set<String>] = [:]
        for name in names {
            for raw in name.split(whereSeparator: { !$0.isLetter && $0 != "-" && $0 != "'" && $0 != "’" }) {
                let word = String(raw)
                guard word.count >= 4 else { continue }
                let folded = Self.fold(word)
                guard folded.count >= 4 else { continue }
                // First spelling in wins, so the roster (passed first) outranks
                // a team list that spells the same person differently.
                if spellings[folded] == nil { spellings[folded] = word }
                bySound[Self.sound(of: folded), default: []].insert(spellings[folded]!)
            }
        }
        self.spellings = spellings
        self.bySound = bySound
    }

    /// The segment with its text corrected; the same segment when nothing
    /// changed, so identity-keyed consumers see no churn.
    @MainActor
    func correct(_ segment: TranscriptSegment, isWord: WordChecker?) -> TranscriptSegment {
        guard !isEmpty else { return segment }
        let text = correct(segment.text, language: segment.language, isWord: isWord)
        guard text != segment.text else { return segment }
        return TranscriptSegment(
            id: segment.id,
            meetingID: segment.meetingID,
            speakerID: segment.speakerID,
            speakerName: segment.speakerName,
            language: segment.language,
            startsAtMilliseconds: segment.startsAtMilliseconds,
            endsAtMilliseconds: segment.endsAtMilliseconds,
            text: text,
            isFinal: segment.isFinal
        )
    }

    @MainActor
    func correct(_ text: String, language: TranscriptLanguage, isWord: WordChecker?) -> String {
        guard !isEmpty else { return text }
        var out = ""
        var word = ""
        func flush() {
            guard !word.isEmpty else { return }
            out += replacement(for: word, language: language, isWord: isWord)
            word = ""
        }
        for character in text {
            if character.isLetter || character == "'" || character == "’" || character == "-" {
                word.append(character)
            } else {
                flush()
                out.append(character)
            }
        }
        flush()
        return out
    }

    @MainActor
    private func replacement(for word: String, language: TranscriptLanguage, isWord: WordChecker?) -> String {
        // A possessive is the name plus its "'s": correct the name, keep the s.
        for suffix in ["'s", "’s"] where word.count > suffix.count && word.hasSuffix(suffix) {
            let stem = String(word.dropLast(suffix.count))
            return replacement(for: stem, language: language, isWord: isWord) + suffix
        }
        let folded = Self.fold(word)
        guard folded.count >= 4 else { return word }
        if let exact = spellings[folded] { return exact }
        if let isWord, isWord(folded, language) { return word }
        if let same = bySound[Self.sound(of: folded)] {
            return same.count == 1 ? same.first! : word
        }
        let allowed = Self.allowedDistance(for: folded.count)
        guard allowed > 0 else { return word }
        var best: (spelling: String, distance: Int)?
        var tied = false
        for (key, spelling) in spellings where abs(key.count - folded.count) <= allowed {
            let distance = Self.levenshtein(folded, key, limit: allowed)
            guard distance <= allowed else { continue }
            if let current = best {
                if distance < current.distance { best = (spelling, distance); tied = false }
                else if distance == current.distance, spelling != current.spelling { tied = true }
            } else {
                best = (spelling, distance)
            }
        }
        guard let best, !tied else { return word }
        return best.spelling
    }

    /// Edit distance allowed by word length, the same rule as
    /// `NameCorrection` on the ambient path: one to six letters, two from
    /// seven. (Under four never reaches here.)
    static func allowedDistance(for length: Int) -> Int {
        length >= 7 ? 2 : 1
    }

    static func levenshtein(_ a: String, _ b: String, limit: Int) -> Int {
        let x = Array(a), y = Array(b)
        if x.isEmpty { return y.count }
        if y.isEmpty { return x.count }
        var previous = Array(0...y.count)
        for i in 1...x.count {
            var current = [i] + Array(repeating: 0, count: y.count)
            var rowMin = i
            for j in 1...y.count {
                let cost = x[i - 1] == y[j - 1] ? 0 : 1
                current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
                rowMin = min(rowMin, current[j])
            }
            if rowMin > limit { return limit + 1 }
            previous = current
        }
        return previous[y.count]
    }

    /// Lowercase, accents gone, apostrophes and hyphens dropped.
    static func fold(_ word: String) -> String {
        word.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
            .lowercased()
            .filter(\.isLetter)
    }

    /// The word as it sounds, coarsely: enough to make Tomás and Thomaz the
    /// same and keep Fabio and Fable apart.
    static func sound(of folded: String) -> String {
        var s = folded
        for (from, to) in [("th", "t"), ("ph", "f"), ("ck", "k"), ("qu", "k"), ("sch", "sh")] {
            s = s.replacingOccurrences(of: from, with: to)
        }
        var out = ""
        var previous: Character?
        for character in s {
            var c = character
            switch c {
            case "z": c = "s"
            case "y": c = "i"
            case "q", "c": c = "k"
            case "w": c = "v"
            default: break
            }
            if c == previous { continue }
            out.append(c)
            previous = c
        }
        // A final e is usually silent (Marcelle, Moreau's "Anne"): drop it, so
        // Marcell and Marcelle sound the same and are a tie rather than a pick.
        if out.count > 3, out.hasSuffix("e") { out.removeLast() }
        return out
    }
}
