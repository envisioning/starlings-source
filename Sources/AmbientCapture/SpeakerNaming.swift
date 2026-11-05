import Foundation

/// Names for the diarizer's clusters (docs/AMBIENT_CAPTURE.md §5, lifted
/// from Blaise C4's `SpeakerResolver` and G2): mechanical when the extension
/// saw who was speaking, by overlap voting; never invented. A cluster no
/// vote reaches stays `Speaker n`.
enum SpeakerNaming {
    /// One second of "this person's tile was lit", from the extension, in
    /// seconds from the capture's start.
    struct SpeakingEvent: Codable, Equatable, Sendable {
        let name: String
        let at: Double
    }

    /// How much of a cluster's speech a name must cover to claim it, and by
    /// how much it must beat the runner-up. Below either, the cluster stays
    /// unnamed — a wrong name on a timeline is worse than none.
    static let minimumCoverage = 0.3
    static let minimumMargin = 1.5
    /// A speaking event marks the second it was observed in; the tile lags
    /// speech a little, so each event covers a window around it.
    static let eventWindow: ClosedRange<Double> = -1.0...1.5

    /// Cluster label → name, for the clusters the votes decide. `exclude`
    /// is the owner: on the mic track, never a system-track cluster.
    static func resolve(
        turns: [SpeakerMerger.Turn],
        events: [SpeakingEvent],
        exclude: Set<String> = []
    ) -> [String: String] {
        guard !turns.isEmpty, !events.isEmpty else { return [:] }
        let names = Set(events.map(\.name)).subtracting(exclude)
        guard !names.isEmpty else { return [:] }
        // Per name, the seconds their tile was lit, as intervals.
        var lit: [String: [(Double, Double)]] = [:]
        for event in events where names.contains(event.name) {
            lit[event.name, default: []].append((event.at + eventWindow.lowerBound, event.at + eventWindow.upperBound))
        }
        var resolved: [String: String] = [:]
        let clusters = Set(turns.map(\.speaker))
        var claimed: Set<String> = []
        // Biggest clusters first, so the loudest voice gets first pick of a name.
        // Deterministic on a tie, so the same evidence names the same cluster.
        let byDuration = clusters.sorted { a, b in
            let ta = total(of: a, in: turns), tb = total(of: b, in: turns)
            return ta == tb ? a < b : ta > tb
        }
        for cluster in byDuration {
            let clusterTurns = turns.filter { $0.speaker == cluster }
            let duration = clusterTurns.reduce(0.0) { $0 + ($1.end - $1.start) }
            guard duration > 0 else { continue }
            var votes: [(name: String, overlap: Double)] = []
            for (name, intervals) in lit where !claimed.contains(name) {
                var overlap = 0.0
                for turn in clusterTurns {
                    for interval in intervals {
                        overlap += max(0, min(turn.end, interval.1) - max(turn.start, interval.0))
                    }
                }
                votes.append((name, overlap))
            }
            votes.sort { $0.overlap > $1.overlap }
            guard let best = votes.first, best.overlap / duration >= minimumCoverage else { continue }
            let runnerUp = votes.dropFirst().first?.overlap ?? 0
            guard runnerUp == 0 || best.overlap / runnerUp >= minimumMargin else { continue }
            resolved[cluster] = best.name
            claimed.insert(best.name)
        }
        return resolved
    }

    private static func total(of cluster: String, in turns: [SpeakerMerger.Turn]) -> Double {
        turns.filter { $0.speaker == cluster }.reduce(0.0) { $0 + ($1.end - $1.start) }
    }

    /// Apply names; unnamed clusters read `Speaker 1`, `Speaker 2`… in
    /// first-appearance order, never the diarizer's own labels.
    static func apply(_ names: [String: String], to segments: [SpeakerMerger.Segment]) -> [SpeakerMerger.Segment] {
        var anonymous: [String: String] = [:]
        return segments.map { segment in
            if let name = names[segment.speaker] {
                return SpeakerMerger.Segment(speaker: name, start: segment.start, end: segment.end, text: segment.text, wordCount: segment.wordCount)
            }
            guard segment.speaker.hasPrefix("S"), Int(segment.speaker.dropFirst()) != nil else { return segment }
            let label = anonymous[segment.speaker] ?? {
                let next = "Speaker \(anonymous.count + 1)"
                anonymous[segment.speaker] = next
                return next
            }()
            return SpeakerMerger.Segment(speaker: label, start: segment.start, end: segment.end, text: segment.text, wordCount: segment.wordCount)
        }
    }
}

/// Names spelled the way the CRM spells them: the recognizer
/// hears "Fabbio", the roster says "Fabio". A pure, single-pass, idempotent
/// substitution — a word within a small edit distance of a known name's
/// word becomes that word; nothing else is touched.
enum NameCorrection {
    /// Edit distance allowed by word length: none under four letters (too
    /// many real words), one to six, two from seven.
    static func allowedDistance(for length: Int) -> Int {
        switch length {
        case ..<4: 0
        case 4...6: 1
        default: 2
        }
    }

    /// The words of every known name, keyed lowercase, worth correcting to.
    static func glossary(from names: [String]) -> [String: String] {
        var words: [String: String] = [:]
        for name in names {
            for word in name.split(separator: " ") where word.count >= 4 {
                let clean = word.trimmingCharacters(in: .punctuationCharacters)
                if clean.count >= 4 { words[clean.lowercased()] = clean }
            }
        }
        return words
    }

    static func correct(_ text: String, glossary: [String: String]) -> String {
        guard !glossary.isEmpty else { return text }
        var out = ""
        var word = ""
        func flush() {
            guard !word.isEmpty else { return }
            out += replacement(for: word, glossary: glossary)
            word = ""
        }
        for character in text {
            if character.isLetter || character == "'" || character == "’" {
                word.append(character)
            } else {
                flush()
                out.append(character)
            }
        }
        flush()
        return out
    }

    private static func replacement(for word: String, glossary: [String: String]) -> String {
        let lower = word.lowercased()
        if let exact = glossary[lower] { return exact }
        let allowed = allowedDistance(for: word.count)
        guard allowed > 0 else { return word }
        var best: (String, Int)?
        for (key, spelled) in glossary where abs(key.count - lower.count) <= allowed {
            let distance = levenshtein(lower, key, limit: allowed)
            if distance <= allowed, best == nil || distance < best!.1 { best = (spelled, distance) }
        }
        guard let (spelled, _) = best else { return word }
        // Keep the sentence's capitalisation habit for a name: a name is
        // capitalised, so the glossary's spelling wins as is.
        return spelled
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
}
