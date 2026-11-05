import Foundation

/// Extraction against the control plane's model instead of the one on this
/// phone — the iPhone twin of `Sources/WorkerTaskExtractor.swift`.
///
/// Apple's on-device model reads a sentence and writes a title; this one reads
/// a few minutes of the meeting and is asked to judge the conversation. The
/// transcript window is finalized text the outbox already ships to the same
/// control plane, so this adds a *purpose*, not a new data flow
/// (`docs/PRIVACY.md`). Every candidate still has to survive the quote check
/// and the dedupe in `TaskSuggestionEngine` before the owner sees a row.
actor MobileWorkerTaskExtractor: TaskSuggestionExtracting {
    nonisolated var engineName: String { "control-plane" }

    private let api: StarlingsAPI
    private let credentials: MobileOwnerCredentials
    private let room: String
    private let meetingID: String
    /// Said once, when the control plane answers that it has no model wired up.
    /// Without it the panel would just stay empty and look broken.
    private let onNote: @Sendable (String) -> Void
    private var reportedEngineOff = false

    init(
        api: StarlingsAPI,
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String,
        onNote: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.api = api
        self.credentials = credentials
        self.room = room
        self.meetingID = meetingID
        self.onNote = onNote
    }

    func extract(window: [TranscriptSegment]) async throws -> [ExtractedTaskCandidate] {
        let excerpt = window
            .map { segment in
                let stamp = TaskSuggestion.timestampLabel(segment.startsAtMilliseconds)
                return String(localized: "[\(stamp)] \(segment.speakerName): \(segment.text)")
            }
            .joined(separator: "\n")
        guard !excerpt.isEmpty else { return [] }

        let response = try await api.proposeTaskCandidates(
            credentials: credentials,
            room: room,
            meetingID: meetingID,
            excerpt: excerpt,
            knownTitles: []
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
}
