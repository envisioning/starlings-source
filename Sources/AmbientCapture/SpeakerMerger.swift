import Foundation

/// The two-track pass's pure middle (docs/AMBIENT_CAPTURE.md §2, lifted from
/// Blaise C4): words with timings from the recognizer, speaker turns from the
/// diarizer, out come segments that say who said what. Deterministic —
/// the same inputs give the same segments — so it is tested on fixtures.
enum SpeakerMerger {
    struct Word: Equatable, Sendable {
        let text: String
        let start: Double
        let end: Double
    }

    struct Turn: Equatable, Sendable {
        let speaker: String
        let start: Double
        let end: Double
    }

    struct Segment: Equatable, Sendable {
        let speaker: String
        let start: Double
        let end: Double
        let text: String
        var wordCount: Int
    }

    /// A word farther than this from any turn takes the previous word's
    /// speaker (or the next word's, for the first).
    static let nearestTurnReach: Double = 2.0
    /// Adjacent same-speaker segments closer than this become one.
    static let consolidateGap: Double = 2.0
    /// A segment with fewer words *and* shorter than this is a fragment,
    /// healed into its left neighbour. A one-word turn over a second stands.
    static let fragmentMaxWords = 2
    static let fragmentMaxSeconds: Double = 1.0
    /// The label for words no turn claims when there are no turns at all.
    static let unattributed = "Speaker"

    /// Recognizer tokens into words: Parakeet marks a word start with a
    /// leading space (or `▁`); the rest of the pieces glue on.
    static func words(fromTokens tokens: [(token: String, start: Double, end: Double)]) -> [Word] {
        var words: [Word] = []
        for piece in tokens {
            let raw = piece.token
            let startsWord = raw.hasPrefix(" ") || raw.hasPrefix("▁")
            let text = raw.replacingOccurrences(of: "▁", with: "").trimmingCharacters(in: .whitespaces)
            if text.isEmpty { continue }
            if startsWord || words.isEmpty {
                words.append(Word(text: text, start: piece.start, end: max(piece.start, piece.end)))
            } else {
                let last = words.removeLast()
                words.append(Word(text: last.text + text, start: last.start, end: max(last.end, piece.end)))
            }
        }
        return words
    }

    /// Each word to the speaker whose turn covers its midpoint; a word in a
    /// gap to the nearest turn within reach; farther, to its neighbour's.
    static func assign(_ words: [Word], to turns: [Turn]) -> [String?] {
        guard !turns.isEmpty else { return words.map { _ in nil } }
        var assigned: [String?] = words.map { word in
            let mid = (word.start + word.end) / 2
            // Covering turns first; several (overlap) → the one with the
            // greatest overlap with the word, tie → the earlier start.
            let covering = turns.filter { $0.start <= mid && mid <= $0.end }
            if !covering.isEmpty {
                let best = covering.max { a, b in
                    let oa = min(a.end, word.end) - max(a.start, word.start)
                    let ob = min(b.end, word.end) - max(b.start, word.start)
                    return oa == ob ? a.start > b.start : oa < ob
                }
                return best?.speaker
            }
            let nearest = turns.min { distance($0, to: mid) < distance($1, to: mid) }
            if let nearest, distance(nearest, to: mid) <= nearestTurnReach { return nearest.speaker }
            return nil
        }
        // Forward fill from the previous word, then backward for a leading run.
        for index in assigned.indices where assigned[index] == nil {
            if index > 0 { assigned[index] = assigned[index - 1] }
        }
        if let firstKnown = assigned.firstIndex(where: { $0 != nil }) {
            for index in 0..<firstKnown { assigned[index] = assigned[firstKnown] }
        }
        return assigned
    }

    private static func distance(_ turn: Turn, to point: Double) -> Double {
        if point < turn.start { return turn.start - point }
        if point > turn.end { return point - turn.end }
        return 0
    }

    /// Words with speakers into segments: a run of one speaker is a piece;
    /// fragments heal left; adjacent same-speaker pieces within the gap join.
    static func segments(words: [Word], speakers: [String?], fallback: String) -> [Segment] {
        guard !words.isEmpty else { return [] }
        var pieces: [Segment] = []
        for (word, speaker) in zip(words, speakers) {
            let name = speaker ?? fallback
            if var last = pieces.last, last.speaker == name {
                last = Segment(speaker: name, start: last.start, end: max(last.end, word.end), text: last.text + " " + word.text, wordCount: last.wordCount + 1)
                pieces[pieces.count - 1] = last
            } else {
                pieces.append(Segment(speaker: name, start: word.start, end: word.end, text: word.text, wordCount: 1))
            }
        }
        // Boundary repair: a piece never starts before the previous one ends.
        for index in 1..<max(1, pieces.count) where pieces[index].start < pieces[index - 1].end {
            pieces[index] = Segment(speaker: pieces[index].speaker, start: pieces[index - 1].end, end: max(pieces[index].end, pieces[index - 1].end), text: pieces[index].text, wordCount: pieces[index].wordCount)
        }
        // Fragment healing and consolidation in one deterministic
        // left-to-right pass: a fragment merges into its left neighbour,
        // whose speaker wins; the leftmost fragment merges right and takes
        // its neighbour's; adjacent same-speaker pieces within the gap join.
        var healed: [Segment] = []
        for piece in pieces {
            guard let last = healed.last else {
                healed.append(piece)
                continue
            }
            if isFragment(piece) {
                healed[healed.count - 1] = merge(last, piece, speaker: last.speaker)
            } else if isFragment(last) {
                healed[healed.count - 1] = merge(last, piece, speaker: piece.speaker)
            } else if last.speaker == piece.speaker, piece.start - last.end <= consolidateGap {
                healed[healed.count - 1] = merge(last, piece, speaker: last.speaker)
            } else {
                healed.append(piece)
            }
        }
        return healed
    }

    private static func isFragment(_ piece: Segment) -> Bool {
        piece.wordCount < fragmentMaxWords && (piece.end - piece.start) < fragmentMaxSeconds
    }

    private static func merge(_ a: Segment, _ b: Segment, speaker: String) -> Segment {
        Segment(speaker: speaker, start: min(a.start, b.start), end: max(a.end, b.end), text: a.text + " " + b.text, wordCount: a.wordCount + b.wordCount)
    }

    /// The whole pass for one track: tokens + turns → segments.
    static func merge(tokens: [(token: String, start: Double, end: Double)], turns: [Turn], fallback: String = unattributed) -> [Segment] {
        let words = words(fromTokens: tokens)
        return segments(words: words, speakers: assign(words, to: turns), fallback: fallback)
    }

    /// Two tracks into one timeline: by start, the mic first on a tie, then
    /// the original order. Cross-track overlap is legal — people talk over
    /// each other — and is kept.
    static func interleave(mic: [Segment], system: [Segment]) -> [Segment] {
        let tagged = mic.enumerated().map { ($0.element, 0, $0.offset) } + system.enumerated().map { ($0.element, 1, $0.offset) }
        return tagged.sorted { a, b in
            if a.0.start != b.0.start { return a.0.start < b.0.start }
            if a.1 != b.1 { return a.1 < b.1 }
            return a.2 < b.2
        }.map(\.0)
    }
}
