import Foundation

/// Extraction against the control plane's model instead of the one on this Mac.
///
/// Apple's on-device model reads a sentence and writes a title; this one reads
/// a few minutes of the meeting and is asked to judge the conversation. That
/// is the whole reason it exists — quality, not availability
/// (`docs/TASK_SUGGESTIONS.md`).
///
/// The transcript window is finalized text that the outbox already ships to the
/// same control plane, so this adds a *purpose*, not a new data flow
/// (`docs/PRIVACY.md`). Nothing is stored on the way: the Worker answers and
/// forgets, and every candidate still has to survive the quote check and the
/// dedupe in `TaskSuggestionEngine` before the owner sees a row.
actor WorkerTaskExtractor: TaskSuggestionExtracting {
    nonisolated var engineName: String { "control-plane" }

    private let api: MeetingControlAPI
    private let context: MeetingContext
    /// Said once, when the control plane answers that it has no model wired up.
    /// Without it the panel would just stay empty and look broken.
    private let onNote: @Sendable (String) -> Void
    private var reportedEngineOff = false
    /// Titles the panel already knows about, so a chunk that restates open work
    /// does not spend a proposal on it. Set from the main actor as tasks load.
    private var knownTitles: [String] = []

    init(
        api: MeetingControlAPI,
        context: MeetingContext,
        onNote: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.api = api
        self.context = context
        self.onNote = onNote
    }

    func setKnownTitles(_ titles: [String]) {
        knownTitles = Array(titles.prefix(50))
    }

    func extract(window: [TranscriptSegment]) async throws -> [ExtractedTaskCandidate] {
        let excerpt = Self.excerpt(from: window)
        guard !excerpt.isEmpty else { return [] }
        let response = try await api.proposeTaskCandidates(
            context: context,
            excerpt: excerpt,
            knownTitles: knownTitles
        )
        if response.engine == .off, !reportedEngineOff {
            reportedEngineOff = true
            onNote(String(localized: "Suggestions off — no model configured on the control plane."))
        }
        return response.candidates.compactMap { candidate in
            let title = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let quote = candidate.quote.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty, !quote.isEmpty else { return nil }
            return ExtractedTaskCandidate(
                title: title,
                quote: quote,
                responsible: TaskSuggestionHeuristics.responsible(from: candidate.responsible.rawValue),
                confidence: min(1, max(0, candidate.confidence))
            )
        }
    }

    /// Same shape the on-device extractor uses: speaker and clock, so the model
    /// can tell a question from an answer.
    private static func excerpt(from window: [TranscriptSegment]) -> String {
        window
            .map { segment in
                let stamp = TaskSuggestion.timestampLabel(segment.startsAtMilliseconds)
                return String(localized: "[\(stamp)] \(segment.speakerName): \(segment.text)")
            }
            .joined(separator: "\n")
    }
}
