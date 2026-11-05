import Foundation

/// Turns the live transcript into proposed tasks.
///
/// Sequence: keep a rolling window, wait for a chunk of speech to accumulate,
/// extract, verify the quote, de-duplicate, cap.
///
/// It used to trigger on cue phrases — `I'll`, `can you`, `by Friday` — which
/// made the suggestions as literal as the word list: a sentence that contained
/// "send" became a task and a commitment assembled across three turns did not.
/// The trigger is now the *chunk*: enough speech to read, handed to a model big
/// enough to judge it. That trades latency for sense, deliberately — this is a
/// sidebar, not a caption. The cue list survives only as a hint inside the
/// rules extractor, which has no model to think with.
actor TaskSuggestionEngine {
    struct Configuration: Sendable {
        /// How much speech the extractor sees. Long enough to hold a whole
        /// exchange, not just the sentence that ended it.
        var windowDuration: TimeInterval = 300
        /// Speech that has to accumulate before another extraction is worth
        /// spending. This is the gate now — no keywords in it.
        var chunkDuration: TimeInterval = 120
        /// Floor between two extractions, whatever the chunk says. Speech that
        /// arrives inside the gap keeps accumulating rather than being dropped.
        var debounce: TimeInterval = 45
        /// Silence after which a part-grown chunk is read anyway, so the last
        /// thing agreed before the room went quiet is not held hostage to
        /// somebody talking again.
        var quietFlush: TimeInterval = 45
        var minimumConfidence: Double = 0.4
        /// Unresolved suggestions on screen at once.
        var maximumProposed: Int = 5
    }

    /// What the engine did this meeting, for the debug report — counts and
    /// titles, never transcript text (`docs/TASK_SUGGESTIONS.md`, traps).
    /// Titles are the model's words, not the room's; quotes stay out.
    struct Report: Sendable, Equatable {
        var engineName: String
        var extractionCount = 0
        var failedExtractionCount = 0
        /// Candidates the extractor returned, before any check.
        var candidateCount = 0
        var droppedBelowConfidence: [String] = []
        /// The anti-hallucination check: quote not found in the window.
        var droppedByQuote: [String] = []
        var droppedAsDuplicate: [String] = []
        /// Unresolved rows the cap aged out.
        var agedOutCount = 0
        var proposedCount = 0
        var acceptedCount = 0
        var dismissedCount = 0

        func lines() -> [String] {
            var lines: [String] = []
            lines.append("engine: \(engineName)")
            lines.append("extractions: \(extractionCount) failed=\(failedExtractionCount)")
            lines.append("candidates: \(candidateCount)")
            lines.append("proposed: \(proposedCount) accepted=\(acceptedCount) dismissed=\(dismissedCount) aged_out=\(agedOutCount)")
            lines.append(contentsOf: Self.dropped("below_confidence", droppedBelowConfidence))
            lines.append(contentsOf: Self.dropped("quote_not_in_window", droppedByQuote))
            lines.append(contentsOf: Self.dropped("duplicate", droppedAsDuplicate))
            return lines
        }

        private static func dropped(_ reason: String, _ titles: [String]) -> [String] {
            guard !titles.isEmpty else { return ["dropped_\(reason): 0"] }
            return ["dropped_\(reason): \(titles.count)"] + titles.map { "  - \($0)" }
        }
    }

    private let meetingID: String
    private let extractor: any TaskSuggestionExtracting
    private let configuration: Configuration
    private let now: @Sendable () -> Date

    private var window: [TranscriptSegment] = []
    private var suggestions: [TaskSuggestion] = []
    /// Keys of open CRM tasks for the categorized subject. A meeting that
    /// restates existing work should not propose it again.
    private var knownTaskKeys: [String] = []
    private var lastExtractionAt: Date?
    private var lastIngestAt: Date?
    /// Speech ingested since the last extraction, in seconds. The chunk.
    private var pendingSpeech: TimeInterval = 0
    private var isExtracting = false
    private(set) var report: Report
    /// Who is in the room, for the extractor. Set by the host once
    /// the roster and the team are known; empty is fine.
    private var knownNames: [String] = []

    func setKnownNames(_ names: [String]) {
        knownNames = names
    }

    init(
        meetingID: String,
        extractor: any TaskSuggestionExtracting,
        configuration: Configuration = Configuration(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.meetingID = meetingID
        self.extractor = extractor
        self.configuration = configuration
        self.now = now
        self.report = Report(engineName: extractor.engineName)
    }

    var proposed: [TaskSuggestion] {
        suggestions.filter { $0.status == .proposed }
    }

    func setKnownTaskTitles(_ titles: [String]) {
        knownTaskKeys = titles.map(TaskSuggestionHeuristics.dedupeKey(for:))
    }

    /// Feed one finalized utterance. Returns only the suggestions that are new
    /// — the caller renders those and marks their transcript lines.
    func ingest(_ segment: TranscriptSegment) async -> [TaskSuggestion] {
        appendToWindow(segment)
        pendingSpeech += Self.duration(of: segment)
        lastIngestAt = now()
        guard !isExtracting, pendingSpeech >= configuration.chunkDuration else { return [] }
        if let last = lastExtractionAt, now().timeIntervalSince(last) < configuration.debounce {
            // Inside the debounce gap: the chunk keeps growing rather than
            // being thrown away, and the next utterance past the gap runs it.
            return []
        }
        return await runExtraction()
    }

    /// Read a part-grown chunk once the room has been quiet for a while.
    ///
    /// Cheap to call often — the caller polls it off the meeting clock, and it
    /// is a no-op until there is both something to read and a real gap in the
    /// speech. Without it, "so you'll send that over" said at the end of a call
    /// would wait for a chunk that never arrives.
    func flushIfQuiet() async -> [TaskSuggestion] {
        guard !isExtracting, pendingSpeech > 0, let last = lastIngestAt else { return [] }
        guard now().timeIntervalSince(last) >= configuration.quietFlush else { return [] }
        return await runExtraction()
    }

    private static func duration(of segment: TranscriptSegment) -> TimeInterval {
        max(0, TimeInterval(segment.endsAtMilliseconds - segment.startsAtMilliseconds) / 1000)
    }

    func markAccepted(id: UUID, crmTaskID: String) {
        guard let index = suggestions.firstIndex(where: { $0.id == id }) else { return }
        suggestions[index].status = .accepted
        suggestions[index].crmTaskID = crmTaskID
        report.acceptedCount += 1
    }

    func markDismissed(id: UUID) {
        guard let index = suggestions.firstIndex(where: { $0.id == id }) else { return }
        suggestions[index].status = .dismissed
        report.dismissedCount += 1
    }

    private func appendToWindow(_ segment: TranscriptSegment) {
        window.append(segment)
        let cutoff = segment.endsAtMilliseconds - Int64(configuration.windowDuration * 1000)
        window.removeAll { $0.endsAtMilliseconds < cutoff }
    }

    private func runExtraction() async -> [TaskSuggestion] {
        isExtracting = true
        pendingSpeech = 0
        lastExtractionAt = now()
        let snapshot = window
        defer { isExtracting = false }

        report.extractionCount += 1
        let candidates: [ExtractedTaskCandidate]
        do {
            candidates = try await extractor.extract(window: snapshot, knownNames: knownNames)
        } catch {
            report.failedExtractionCount += 1
            // Never fatal, never user-visible noise: the next chunk tries again.
            StarlingsDiagnosticsLog.shared.record(
                StarlingsError.wrapping(error, code: "tasks.suggest", title: String(localized: "Task suggestions")),
                context: "task suggestion extraction"
            )
            return []
        }

        let windowText = snapshot.map(\.text).joined(separator: " ")
        report.candidateCount += candidates.count
        var accepted: [TaskSuggestion] = []
        for candidate in candidates {
            guard let suggestion = verify(candidate, window: snapshot, windowText: windowText) else { continue }
            suggestions.append(suggestion)
            accepted.append(suggestion)
            report.proposedCount += 1
        }
        enforceProposedCap()
        return accepted.filter { new in proposed.contains { $0.id == new.id } }
    }

    /// Everything that has to be true before a suggestion reaches the panel.
    private func verify(
        _ candidate: ExtractedTaskCandidate,
        window snapshot: [TranscriptSegment],
        windowText: String
    ) -> TaskSuggestion? {
        let title = candidate.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 200 else { return nil }
        guard candidate.confidence >= configuration.minimumConfidence else {
            report.droppedBelowConfidence.append(title)
            return nil
        }
        guard TaskSuggestionHeuristics.containsQuote(candidate.quote, in: windowText) else {
            report.droppedByQuote.append(title)
            return nil
        }

        let key = TaskSuggestionHeuristics.dedupeKey(for: title)
        guard !key.isEmpty else { return nil }
        // Compare against every suggestion this meeting made, including the
        // dismissed ones — a rejected suggestion coming back is worse than one
        // that never came.
        let seen = knownTaskKeys + suggestions.map(\.dedupeKey)
        guard !TaskSuggestionHeuristics.isDuplicate(key, of: seen) else {
            report.droppedAsDuplicate.append(title)
            return nil
        }

        let sources = sourceSegments(for: candidate.quote, in: snapshot)
        let anchor = sources.last ?? snapshot.last
        return TaskSuggestion(
            id: UUID(),
            meetingID: meetingID,
            sourceSegmentIDs: sources.map(\.id),
            title: title,
            quote: candidate.quote.trimmingCharacters(in: .whitespacesAndNewlines),
            speakerName: anchor?.speakerName ?? "",
            startsAtMilliseconds: anchor?.startsAtMilliseconds ?? 0,
            responsibleGuess: candidate.responsible == .unassigned
                ? TaskSuggestionHeuristics.impliedResponsible(in: candidate.quote)
                : candidate.responsible,
            confidence: candidate.confidence,
            dedupeKey: key,
            status: .proposed,
            crmTaskID: nil
        )
    }

    /// Which utterances the quote came out of — this is what lets the caption
    /// panel show that a line produced a task.
    private func sourceSegments(
        for quote: String,
        in snapshot: [TranscriptSegment]
    ) -> [TranscriptSegment] {
        let needle = TaskSuggestionHeuristics.normalized(quote)
        guard !needle.isEmpty else { return [] }
        let matches = snapshot.filter { segment in
            let haystack = TaskSuggestionHeuristics.normalized(segment.text)
            return haystack.contains(needle) || needle.contains(haystack)
        }
        if !matches.isEmpty { return matches }
        // A quote spanning two utterances matches neither whole: fall back to
        // the segments that share most of its words.
        let needleTokens = Set(needle.split(separator: " ").map(String.init))
        return snapshot.filter { segment in
            let tokens = Set(TaskSuggestionHeuristics.tokens(segment.text))
            guard !tokens.isEmpty else { return false }
            return Double(tokens.intersection(needleTokens).count) / Double(needleTokens.count) >= 0.4
        }
    }

    /// The panel is a sidebar, not a feed. Oldest unresolved goes first.
    private func enforceProposedCap() {
        var overflow = proposed.count - configuration.maximumProposed
        guard overflow > 0 else { return }
        for index in suggestions.indices where overflow > 0 {
            guard suggestions[index].status == .proposed else { continue }
            suggestions[index].status = .dismissed
            report.agedOutCount += 1
            overflow -= 1
        }
    }
}

/// Picks the extractor and explains itself when it can't run.
enum TaskSuggestionEngineFactory {
    struct Resolution {
        let extractor: (any TaskSuggestionExtracting)?
        /// One line for the tasks panel. Non-nil only when worth saying.
        let note: String?
    }

    /// The engine as Settings reports it, outside any meeting: which one the
    /// switch names, whether this device can run it, and why. The live
    /// answer — the Worker saying it has no model, say — is the panel's
    /// note; this is the standing one.
    struct Status: Equatable, Sendable {
        let mode: TaskSuggestionMode
        /// Row value: the engine's name, or "Off".
        let name: String
        /// Row detail: what it does, or why it cannot run here.
        let detail: String
        let available: Bool
    }

    /// `makeCloud` builds the control-plane extractor, which needs the live
    /// meeting and the owner session — things this enum has no business
    /// knowing. It returns nil when there is nothing to build it from.
    @MainActor
    static func resolve(
        mode: TaskSuggestionMode = .current,
        makeCloud: @MainActor () -> (any TaskSuggestionExtracting)? = { nil }
    ) -> Resolution {
        switch mode {
        case .off:
            return Resolution(extractor: nil, note: nil)
        case .cloud:
            guard let extractor = makeCloud() else {
                return Resolution(extractor: nil, note: String(localized: "Suggestions off — no meeting to read."))
            }
            return Resolution(extractor: extractor, note: nil)
        case .rules:
            return Resolution(extractor: RulesTaskExtractor(), note: String(localized: "Suggestions: rules engine."))
        case .onDevice:
            if let reason = onDeviceUnavailableReason() {
                return Resolution(extractor: nil, note: String(localized: "Suggestions off — \(reason)"))
            }
            #if canImport(FoundationModels)
            if #available(macOS 26.0, iOS 26.0, *) {
                return Resolution(extractor: FoundationModelsTaskExtractor(), note: nil)
            }
            #endif
            return Resolution(extractor: nil, note: String(localized: "Suggestions off — \(Self.onDeviceOSRequirement)"))
        }
    }

    @MainActor
    static func status(mode: TaskSuggestionMode = .current) -> Status {
        switch mode {
        case .off:
            return Status(
                mode: mode,
                name: "Off",
                detail: String(localized: "Nothing is proposed."),
                available: false
            )
        case .cloud:
            return Status(
                mode: mode,
                name: "Control plane model",
                detail: String(localized: "Reads a few minutes of speech at a time while you host."),
                available: true
            )
        case .rules:
            return Status(
                mode: mode,
                name: "Rules",
                detail: String(localized: "Cue phrases, no model."),
                available: true
            )
        case .onDevice:
            if let reason = onDeviceUnavailableReason() {
                return Status(
                    mode: mode,
                    name: "On-device model",
                    detail: String(localized: "Cannot run: \(reason) Suggestions are off until that changes."),
                    available: false
                )
            }
            return Status(
                mode: mode,
                name: "On-device model",
                detail: String(localized: "Apple’s model, on this device."),
                available: true
            )
        }
    }

    private static var onDeviceOSRequirement: String {
        #if os(iOS)
        "on-device model needs iOS 26."
        #else
        "on-device model needs macOS 26."
        #endif
    }

    /// Nil when Apple's model can run here. The reason ends with a period so
    /// it can close a sentence on its own.
    @MainActor
    private static func onDeviceUnavailableReason() -> String? {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, *) {
            switch FoundationModelsTaskExtractor.availability {
            case .available: return nil
            case .unavailable(let reason): return reason
            }
        }
        #endif
        return onDeviceOSRequirement
    }
}

/// The task-suggestions section of the meeting debug report: which engine
/// the switch names, which one actually ran, and what the checks dropped.
enum TaskSuggestionDebugReport {
    static func lines(
        status: TaskSuggestionEngineFactory.Status,
        resolutionNote: String?,
        liveNote: String? = nil,
        report: TaskSuggestionEngine.Report?
    ) -> [String] {
        var lines = ["## Task suggestions"]
        lines.append("mode: \(status.mode.rawValue) (\(status.name))")
        if let resolutionNote {
            lines.append("resolution: \(resolutionNote)")
        }
        if let liveNote {
            lines.append("live: \(liveNote)")
        }
        guard let report else {
            lines.append("engine: none — nothing ran this meeting")
            return lines
        }
        lines.append(contentsOf: report.lines())
        return lines
    }
}
