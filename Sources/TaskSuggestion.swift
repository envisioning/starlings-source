import Foundation

/// A task the meeting proposed, derived from what someone actually said.
///
/// Local to this Mac. Nothing here has been written to Core — a suggestion
/// becomes a CRM row only when the owner accepts it, through the same
/// `createCrmTask` path as a hand-typed task. See `docs/TASK_SUGGESTIONS.md`.
struct TaskSuggestion: Identifiable, Equatable, Sendable {
    enum Status: String, Sendable {
        case proposed
        case accepted
        case dismissed
    }

    let id: UUID
    let meetingID: String
    /// Segments the quote came from, so the caption panel can mark the line
    /// that produced this suggestion.
    let sourceSegmentIDs: [UUID]
    let title: String
    /// Verbatim transcript span. Provenance in the UI *and* the check that
    /// keeps invented tasks off screen.
    let quote: String
    let speakerName: String
    let startsAtMilliseconds: Int64
    let responsibleGuess: CrmTaskResponsible
    let confidence: Double
    let dedupeKey: String
    var status: Status
    var crmTaskID: String?

    /// Notes seeded into the editor on accept: the sentence, who said it, when.
    var provenanceNote: String {
        "“\(quote)” — \(speakerName), \(Self.timestampLabel(startsAtMilliseconds))"
    }

    static func timestampLabel(_ milliseconds: Int64) -> String {
        let total = max(0, Int(milliseconds / 1000))
        return String(format: "%02d:%02d", total / 60, total % 60)
    }
}

/// What the extractor returns before the engine verifies and de-duplicates it.
struct ExtractedTaskCandidate: Equatable, Sendable {
    let title: String
    let quote: String
    let responsible: CrmTaskResponsible
    /// 0…1. The engine drops anything under its threshold.
    let confidence: Double
}

/// Anything that can turn a window of transcript into candidate tasks.
/// Implementations are actors (the on-device session is not `Sendable`), so
/// every requirement is `async` or `nonisolated`.
protocol TaskSuggestionExtracting: Sendable {
    nonisolated var engineName: String { get }
    func extract(window: [TranscriptSegment]) async throws -> [ExtractedTaskCandidate]
    /// The same, told who is in the room — the roster, the team and the
    /// invitees, spelled the CRM's way — so a title or an owner
    /// uses that spelling. An extractor that has no use for names gets the
    /// plain call.
    func extract(window: [TranscriptSegment], knownNames: [String]) async throws -> [ExtractedTaskCandidate]
}

extension TaskSuggestionExtracting {
    func extract(window: [TranscriptSegment], knownNames: [String]) async throws -> [ExtractedTaskCandidate] {
        try await extract(window: window)
    }
}

/// Which extractor runs. Read from `UserDefaults` so a test session can pick
/// another engine without a rebuild:
///
///     defaults write com.starlingshq.app meet.taskSuggestions rules
enum TaskSuggestionMode: String, Sendable {
    /// No extraction at all.
    case off
    /// The control plane's larger model, reading a few minutes of speech at a
    /// time. The default: a small model reading one sentence proposes what it
    /// heard, not what was agreed.
    case cloud
    /// Apple's on-device model with guided generation. Needs macOS 26 / iOS 26
    /// and Apple Intelligence enabled; reports why when it can't run. Smaller,
    /// and it never leaves the device.
    case onDevice = "on"
    /// Deterministic cue-phrase extraction. Lower quality, always available —
    /// this is what makes the pipeline testable without any model.
    case rules

    static let defaultsKey = "meet.taskSuggestions"

    static var current: TaskSuggestionMode {
        guard let raw = UserDefaults.standard.string(forKey: defaultsKey) else { return .cloud }
        return TaskSuggestionMode(rawValue: raw) ?? .cloud
    }
}

/// Cue matching, normalization, de-duplication, and quote verification.
///
/// Deliberately pure and deterministic: these are the checks that stand
/// between a language model and the owner's CRM, so they are the parts that
/// have to be testable without one.
enum TaskSuggestionHeuristics {
    /// Commitment noises in the three languages the transcriber labels.
    /// Padded with spaces because `normalized` turns punctuation into spaces —
    /// " send " must not fire on "sender".
    static let commitmentCues: [String] = [
        // English
        " i ll ", " i will ", " we ll ", " we will ", " i m going to ", " we re going to ",
        " let s ", " can you ", " could you ", " you need to ", " we need to ", " i need to ",
        " i can ", " i should ", " we should ", " make sure ", " follow up ", " get back to ",
        " send ", " share ", " draft ", " write up ", " put together ", " set up ", " schedule ",
        " remind ", " by monday ", " by tuesday ", " by wednesday ", " by thursday ",
        " by friday ", " next week ", " this week ", " action item ", " take care of ",
        // Portuguese
        " vou ", " vamos ", " eu envio ", " te envio ", " eu mando ", " mandar ", " enviar ",
        " preciso ", " precisamos ", " fico de ", " voce pode ", " podes ", " ate sexta ",
        " ate segunda ", " proxima semana ", " combinado ", " vou mandar ",
        // German
        " ich werde ", " wir werden ", " ich schicke ", " ich mache ", " wir machen ",
        " lass uns ", " kannst du ", " konnen sie ", " ich kummere mich ", " bis freitag ",
        " bis montag ", " nachste woche ", " ich sende ",
    ]

    /// Words that carry no signal when comparing two task titles.
    /// `TASK_SUGGESTION_STOPWORDS`, the list the Worker's evaluator reads too.
    private static let stopwords = Set(ContractConstants.taskSuggestionStopwords)

    /// Lowercase, diacritic-folded, punctuation-as-space, single-spaced.
    static func normalized(_ text: String) -> String {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
        let spaced = folded.map { character -> Character in
            character.isLetter || character.isNumber ? character : " "
        }
        return String(spaced)
            .split(separator: " ", omittingEmptySubsequences: true)
            .joined(separator: " ")
    }

    /// Does this line sound like someone taking work on? The gate that decides
    /// whether an inference is worth spending at all.
    static func mentionsCommitment(_ text: String) -> Bool {
        let haystack = " \(normalized(text)) "
        return commitmentCues.contains { haystack.contains($0) }
    }

    static func tokens(_ text: String) -> [String] {
        normalized(text).split(separator: " ").map(String.init)
    }

    /// Order-independent signature of a title, stopwords removed.
    static func dedupeKey(for title: String) -> String {
        let meaningful = tokens(title).filter { !stopwords.contains($0) && $0.count > 1 }
        let unique = Set(meaningful.isEmpty ? tokens(title) : meaningful)
        return unique.sorted().joined(separator: " ")
    }

    /// Same task said twice, or already open in Core. Exact key match, or
    /// enough token overlap that surfacing both would be noise.
    static func isDuplicate(_ key: String, of existing: [String], threshold: Double = 0.6) -> Bool {
        let candidate = Set(key.split(separator: " ").map(String.init))
        guard !candidate.isEmpty else { return false }
        return existing.contains { other in
            let known = Set(other.split(separator: " ").map(String.init))
            guard !known.isEmpty else { return false }
            if known == candidate { return true }
            let overlap = Double(known.intersection(candidate).count)
            let union = Double(known.union(candidate).count)
            return union > 0 && overlap / union >= threshold
        }
    }

    /// The anti-hallucination check: the quote must actually appear in what
    /// was said. Normalization forgives casing and punctuation; near-complete
    /// token coverage forgives a dropped filler word. Anything further from
    /// the transcript than that is the model writing fiction.
    static func containsQuote(_ quote: String, in window: String, coverage: Double = 0.9) -> Bool {
        let needle = normalized(quote)
        guard needle.count >= 6 else { return false }
        let haystack = normalized(window)
        if haystack.contains(needle) { return true }
        // Elision-insensitive second pass: a model that writes "ill send" for
        // "I'll send" is still quoting. Apostrophes are only collapsed here —
        // doing it in `normalized` would turn "we'll" into "well" and make the
        // cue gate fire on every "well, …".
        if elided(window).contains(elided(quote)) { return true }
        let needleTokens = needle.split(separator: " ").map(String.init)
        guard needleTokens.count >= 3 else { return false }
        let haystackTokens = Set(haystack.split(separator: " ").map(String.init))
        let present = needleTokens.filter { haystackTokens.contains($0) }.count
        return Double(present) / Double(needleTokens.count) >= coverage
    }

    /// Normalized with contractions closed up: "I'll" and "ill" land on the
    /// same string. Only quote verification wants this.
    private static func elided(_ text: String) -> String {
        normalized(
            text
                .replacingOccurrences(of: "'", with: "")
                .replacingOccurrences(of: "\u{2019}", with: "")
        )
    }

    /// Free-text party from a model, mapped onto the CRM's three values.
    static func responsible(from raw: String) -> CrmTaskResponsible {
        switch normalized(raw) {
        case "team", "us", "we", "envisioning", "internal": .team
        case "client", "customer", "them", "lead": .client
        default: .unassigned
        }
    }

    /// Party implied by the sentence itself — used by the rules extractor and
    /// as the fallback when a model returns something unrecognizable.
    static func impliedResponsible(in text: String) -> CrmTaskResponsible {
        let haystack = " \(normalized(text)) "
        let team = [" i ll ", " i will ", " we ll ", " we will ", " i m going to ", " let s ",
                    " i can ", " i need to ", " we need to ", " vou ", " vamos ", " eu envio ",
                    " ich werde ", " wir werden ", " ich schicke ", " ich mache "]
        let client = [" can you ", " could you ", " you need to ", " voce pode ", " podes ",
                      " kannst du ", " konnen sie "]
        if client.contains(where: { haystack.contains($0) }) { return .client }
        if team.contains(where: { haystack.contains($0) }) { return .team }
        return .unassigned
    }

    /// Split a segment into sentence-ish spans so a quote is one commitment,
    /// not a 12-second run of speech.
    static func sentences(in text: String) -> [String] {
        var result: [String] = []
        var current = ""
        for character in text {
            current.append(character)
            if character == "." || character == "?" || character == "!" || character == "\n" {
                let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { result.append(trimmed) }
                current = ""
            }
        }
        let tail = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { result.append(tail) }
        return result
    }

    /// Trim a spoken sentence into something that reads as a task title.
    static func title(fromSpokenSentence sentence: String, limit: Int = 120) -> String {
        let trimmed = sentence
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".!?,;: "))
        guard trimmed.count > limit else { return trimmed }
        let clipped = trimmed.prefix(limit)
        guard let lastSpace = clipped.lastIndex(of: " ") else { return String(clipped) }
        return String(clipped[clipped.startIndex..<lastSpace]) + "…"
    }
}

/// Deterministic extractor: the cue sentence *is* the candidate.
///
/// Lower quality than the model — it proposes the sentence rather than a task
/// title — but it needs no Apple Intelligence, no network, and no
/// non-determinism, which is what makes the rest of the pipeline testable.
struct RulesTaskExtractor: TaskSuggestionExtracting {
    var engineName: String { "rules" }

    func extract(window: [TranscriptSegment]) async throws -> [ExtractedTaskCandidate] {
        guard let latest = window.last else { return [] }
        return TaskSuggestionHeuristics.sentences(in: latest.text)
            .filter(TaskSuggestionHeuristics.mentionsCommitment)
            .map { sentence in
                ExtractedTaskCandidate(
                    title: TaskSuggestionHeuristics.title(fromSpokenSentence: sentence),
                    quote: sentence,
                    responsible: TaskSuggestionHeuristics.impliedResponsible(in: sentence),
                    confidence: 0.5
                )
            }
    }
}
