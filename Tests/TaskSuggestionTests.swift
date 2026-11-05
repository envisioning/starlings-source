import XCTest
@testable import Starlings

/// The stages between a language model and the owner's CRM. These are the
/// parts that must hold without Apple Intelligence, so they are tested with a
/// stub extractor and the deterministic rules engine.
final class TaskSuggestionHeuristicsTests: XCTestCase {
    func testCueGateFiresOnSpokenCommitments() {
        XCTAssertTrue(TaskSuggestionHeuristics.mentionsCommitment("I'll send the deck on Friday."))
        XCTAssertTrue(TaskSuggestionHeuristics.mentionsCommitment("Can you share the numbers?"))
        XCTAssertTrue(TaskSuggestionHeuristics.mentionsCommitment("Vou mandar o orçamento amanhã."))
        XCTAssertTrue(TaskSuggestionHeuristics.mentionsCommitment("Ich schicke dir die Notizen."))
    }

    func testCueGateIgnoresDiscussion() {
        XCTAssertFalse(TaskSuggestionHeuristics.mentionsCommitment("The pricing model is interesting."))
        XCTAssertFalse(TaskSuggestionHeuristics.mentionsCommitment("They had a similar problem last year."))
    }

    func testCueGateDoesNotFireOnSubstrings() {
        // " send " must not match "sender" — the padded-cue rule.
        XCTAssertFalse(TaskSuggestionHeuristics.mentionsCommitment("The sender was unknown."))
    }

    func testDedupeKeyIgnoresWordOrderAndFiller() {
        let first = TaskSuggestionHeuristics.dedupeKey(for: "Send the pricing deck")
        let second = TaskSuggestionHeuristics.dedupeKey(for: "pricing deck to send")
        XCTAssertEqual(first, second)
    }

    func testDuplicateDetectionCatchesRestatedWork() {
        let existing = [TaskSuggestionHeuristics.dedupeKey(for: "Send pricing deck to Acme")]
        let restated = TaskSuggestionHeuristics.dedupeKey(for: "Send the pricing deck to Acme")
        XCTAssertTrue(TaskSuggestionHeuristics.isDuplicate(restated, of: existing))

        let unrelated = TaskSuggestionHeuristics.dedupeKey(for: "Book the workshop room")
        XCTAssertFalse(TaskSuggestionHeuristics.isDuplicate(unrelated, of: existing))
    }

    func testQuoteVerificationForgivesPunctuationButNotInvention() {
        let window = "Okay so I'll send the pricing deck on Friday, before the review."
        XCTAssertTrue(TaskSuggestionHeuristics.containsQuote("I'll send the pricing deck on Friday", in: window))
        XCTAssertTrue(TaskSuggestionHeuristics.containsQuote("ill send the pricing deck on friday.", in: window))
        XCTAssertFalse(TaskSuggestionHeuristics.containsQuote("I'll also renew the annual contract", in: window))
    }

    func testResponsibleGuessFollowsWhoTookTheWork() {
        XCTAssertEqual(TaskSuggestionHeuristics.impliedResponsible(in: "I'll send the deck"), .team)
        XCTAssertEqual(TaskSuggestionHeuristics.impliedResponsible(in: "Can you send the deck?"), .client)
        XCTAssertEqual(TaskSuggestionHeuristics.impliedResponsible(in: "The deck exists somewhere"), .unassigned)
    }

    func testRulesExtractorProposesOnlyTheCommitmentSentence() async throws {
        let segment = Self.segment("The market looks crowded. I'll send the pricing deck on Friday.")
        let candidates = try await RulesTaskExtractor().extract(window: [segment])
        XCTAssertEqual(candidates.count, 1)
        XCTAssertEqual(candidates.first?.title, "I'll send the pricing deck on Friday")
        XCTAssertEqual(candidates.first?.responsible, .team)
    }

    static func segment(
        _ text: String,
        speaker: String = "Rosa",
        startsAt: Int64 = 0
    ) -> TranscriptSegment {
        TranscriptSegment(
            id: UUID(),
            meetingID: "meeting-1",
            speakerID: "rosa",
            speakerName: speaker,
            language: .english,
            startsAtMilliseconds: startsAt,
            endsAtMilliseconds: startsAt + 4000,
            text: text,
            isFinal: true
        )
    }
}

/// Fixed candidates, and a count of how often the engine actually reached for
/// the model — the chunk gate and the debounce are only real if this stays low.
private final class StubExtractor: TaskSuggestionExtracting, @unchecked Sendable {
    var engineName: String { "stub" }

    private let lock = NSLock()
    private var _calls = 0
    private var _candidates: [ExtractedTaskCandidate]

    var calls: Int {
        lock.withLock { _calls }
    }

    init(candidates: [ExtractedTaskCandidate]) {
        _candidates = candidates
    }

    func setCandidates(_ candidates: [ExtractedTaskCandidate]) {
        lock.withLock { _candidates = candidates }
    }

    func extract(window: [TranscriptSegment]) async throws -> [ExtractedTaskCandidate] {
        lock.withLock {
            _calls += 1
            return _candidates
        }
    }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_000_000)

    var now: Date {
        lock.withLock { value }
    }

    func advance(_ interval: TimeInterval) {
        lock.withLock { value = value.addingTimeInterval(interval) }
    }
}

final class TaskSuggestionEngineTests: XCTestCase {
    /// Most of these assert what happens *around* an extraction, so they hand
    /// the engine a zero-length chunk and let every utterance through. The
    /// chunk gate itself is covered on its own, below.
    private func makeEngine(
        extractor: any TaskSuggestionExtracting,
        clock: TestClock,
        configuration: TaskSuggestionEngine.Configuration = .init(chunkDuration: 0, debounce: 0)
    ) -> TaskSuggestionEngine {
        TaskSuggestionEngine(
            meetingID: "meeting-1",
            extractor: extractor,
            configuration: configuration,
            now: { clock.now }
        )
    }

    private static let sendDeck = ExtractedTaskCandidate(
        title: "Send the pricing deck",
        quote: "I'll send the pricing deck on Friday",
        responsible: .team,
        confidence: 0.9
    )

    /// The gate is the chunk now, not a word list: one utterance is never
    /// enough, however committal it sounds.
    func testOneUtteranceIsNotAChunk() async {
        let extractor = StubExtractor(candidates: [Self.sendDeck])
        let engine = TaskSuggestionEngine(
            meetingID: "meeting-1",
            extractor: extractor,
            configuration: .init(),
            now: { Date(timeIntervalSince1970: 1_000_000) }
        )
        let proposed = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.")
        )
        XCTAssertTrue(proposed.isEmpty)
        XCTAssertEqual(extractor.calls, 0)
    }

    func testAccumulatedSpeechTriggersOneExtraction() async {
        let extractor = StubExtractor(candidates: [Self.sendDeck])
        let clock = TestClock()
        let engine = makeEngine(
            extractor: extractor,
            clock: clock,
            configuration: .init(chunkDuration: 40, debounce: 0)
        )
        // Segments are 4 s each, so the tenth one closes the chunk — and it is
        // the chunk that fires, not the sentence.
        for index in 0..<9 {
            let proposed = await engine.ingest(
                TaskSuggestionHeuristicsTests.segment(
                    "Anyway, the market looks crowded.",
                    startsAt: Int64(index) * 4_000
                )
            )
            XCTAssertTrue(proposed.isEmpty)
        }
        XCTAssertEqual(extractor.calls, 0)
        let proposed = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.", startsAt: 36_000)
        )
        XCTAssertEqual(extractor.calls, 1)
        XCTAssertEqual(proposed.count, 1)
    }

    /// A room that goes quiet mid-chunk still gets read — otherwise the last
    /// thing agreed on a call waits for speech that never arrives.
    func testQuietRoomReadsAPartGrownChunk() async {
        let extractor = StubExtractor(candidates: [Self.sendDeck])
        let clock = TestClock()
        let engine = makeEngine(
            extractor: extractor,
            clock: clock,
            configuration: .init(chunkDuration: 120, debounce: 0, quietFlush: 45)
        )
        _ = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.")
        )
        XCTAssertEqual(extractor.calls, 0)

        clock.advance(10)
        let tooSoon = await engine.flushIfQuiet()
        XCTAssertTrue(tooSoon.isEmpty, "Ten seconds is a pause, not a lull")
        XCTAssertEqual(extractor.calls, 0)

        clock.advance(60)
        let proposed = await engine.flushIfQuiet()
        XCTAssertEqual(extractor.calls, 1)
        XCTAssertEqual(proposed.count, 1)

        // Nothing new was said, so there is nothing left to read.
        clock.advance(120)
        let nothingLeft = await engine.flushIfQuiet()
        XCTAssertTrue(nothingLeft.isEmpty)
        XCTAssertEqual(extractor.calls, 1)
    }

    func testCommitmentProducesASuggestionWithProvenance() async {
        let extractor = StubExtractor(candidates: [Self.sendDeck])
        let engine = makeEngine(extractor: extractor, clock: TestClock())
        let segment = TaskSuggestionHeuristicsTests.segment(
            "I'll send the pricing deck on Friday.",
            speaker: "Rosa",
            startsAt: 65_000
        )
        let proposed = await engine.ingest(segment)
        XCTAssertEqual(proposed.count, 1)
        XCTAssertEqual(proposed.first?.title, "Send the pricing deck")
        XCTAssertEqual(proposed.first?.speakerName, "Rosa")
        XCTAssertEqual(proposed.first?.sourceSegmentIDs, [segment.id])
        XCTAssertEqual(proposed.first?.provenanceNote.contains("01:05"), true)
    }

    func testInventedQuoteIsDropped() async {
        let extractor = StubExtractor(candidates: [
            ExtractedTaskCandidate(
                title: "Renew the annual contract",
                quote: "we agreed to renew the annual contract today",
                responsible: .team,
                confidence: 0.95
            ),
        ])
        let engine = makeEngine(extractor: extractor, clock: TestClock())
        let proposed = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.")
        )
        XCTAssertEqual(extractor.calls, 1)
        XCTAssertTrue(proposed.isEmpty, "A quote nobody said must never reach the panel")
    }

    func testLowConfidenceIsDropped() async {
        let extractor = StubExtractor(candidates: [
            ExtractedTaskCandidate(
                title: "Send the pricing deck",
                quote: "I'll send the pricing deck on Friday",
                responsible: .team,
                confidence: 0.1
            ),
        ])
        let engine = makeEngine(extractor: extractor, clock: TestClock())
        let proposed = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.")
        )
        XCTAssertTrue(proposed.isEmpty)
    }

    func testOpenCrmTaskSuppressesTheSameProposal() async {
        let extractor = StubExtractor(candidates: [Self.sendDeck])
        let engine = makeEngine(extractor: extractor, clock: TestClock())
        await engine.setKnownTaskTitles(["Send pricing deck"])
        let proposed = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.")
        )
        XCTAssertTrue(proposed.isEmpty)
    }

    func testDismissedSuggestionDoesNotComeBack() async {
        let extractor = StubExtractor(candidates: [Self.sendDeck])
        let clock = TestClock()
        let engine = makeEngine(extractor: extractor, clock: clock)
        let first = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.")
        )
        XCTAssertEqual(first.count, 1)
        await engine.markDismissed(id: first[0].id)

        clock.advance(60)
        let second = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("Right, I'll send the pricing deck on Friday.", startsAt: 20_000)
        )
        XCTAssertEqual(extractor.calls, 2)
        XCTAssertTrue(second.isEmpty)
    }

    func testDebounceHoldsTheChunkInsteadOfDroppingIt() async {
        let extractor = StubExtractor(candidates: [Self.sendDeck])
        let clock = TestClock()
        let engine = makeEngine(
            extractor: extractor,
            clock: clock,
            configuration: .init(windowDuration: 90, chunkDuration: 0, debounce: 15)
        )
        _ = await engine.ingest(TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday."))
        XCTAssertEqual(extractor.calls, 1)

        // More speech inside the debounce gap: no extra inference.
        extractor.setCandidates([
            ExtractedTaskCandidate(
                title: "Book the workshop room",
                quote: "I'll book the workshop room",
                responsible: .team,
                confidence: 0.9
            ),
        ])
        clock.advance(5)
        let suppressed = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll book the workshop room.", startsAt: 10_000)
        )
        XCTAssertTrue(suppressed.isEmpty)
        XCTAssertEqual(extractor.calls, 1)

        // The chunk survived: the next utterance past the gap runs it.
        clock.advance(20)
        let recovered = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("Anyway, that's the plan.", startsAt: 20_000)
        )
        XCTAssertEqual(extractor.calls, 2)
        XCTAssertEqual(recovered.count, 1)
        XCTAssertEqual(recovered.first?.title, "Book the workshop room")
    }

    func testWindowDropsSpeechOlderThanTheConfiguredDuration() async {
        let extractor = StubExtractor(candidates: [Self.sendDeck])
        let clock = TestClock()
        let engine = makeEngine(
            extractor: extractor,
            clock: clock,
            configuration: .init(windowDuration: 30, chunkDuration: 0, debounce: 0)
        )
        _ = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.", startsAt: 0)
        )
        // 10 minutes later the old sentence is out of the window, so a quote
        // taken from it no longer verifies.
        clock.advance(600)
        let stale = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("Let's move on to hiring.", startsAt: 600_000)
        )
        XCTAssertTrue(stale.isEmpty)
    }

    func testProposedSuggestionsAreCapped() async {
        let extractor = StubExtractor(candidates: [])
        let clock = TestClock()
        let engine = makeEngine(
            extractor: extractor,
            clock: clock,
            configuration: .init(windowDuration: 900, chunkDuration: 0, debounce: 0, maximumProposed: 2)
        )
        let phrases = ["send the pricing deck", "book the workshop room", "draft the scope note"]
        for (index, phrase) in phrases.enumerated() {
            extractor.setCandidates([
                ExtractedTaskCandidate(
                    title: phrase,
                    quote: "I'll \(phrase)",
                    responsible: .team,
                    confidence: 0.9
                ),
            ])
            _ = await engine.ingest(
                TaskSuggestionHeuristicsTests.segment("I'll \(phrase).", startsAt: Int64(index) * 10_000)
            )
        }
        let open = await engine.proposed
        XCTAssertEqual(open.count, 2)
        XCTAssertEqual(open.map(\.title), ["book the workshop room", "draft the scope note"])
    }

    /// The debug report says what the checks did — counts and titles only.
    func testReportTalliesWhatTheChecksDropped() async {
        let extractor = StubExtractor(candidates: [
            Self.sendDeck,
            ExtractedTaskCandidate(
                title: "Invented task",
                quote: "nobody ever said this sentence",
                responsible: .team,
                confidence: 0.9
            ),
            ExtractedTaskCandidate(
                title: "Maybe a task",
                quote: "I'll send the pricing deck on Friday",
                responsible: .team,
                confidence: 0.1
            ),
            ExtractedTaskCandidate(
                title: "Send pricing deck",
                quote: "I'll send the pricing deck on Friday",
                responsible: .team,
                confidence: 0.9
            ),
        ])
        let engine = makeEngine(extractor: extractor, clock: TestClock())
        let proposed = await engine.ingest(
            TaskSuggestionHeuristicsTests.segment("I'll send the pricing deck on Friday.")
        )
        XCTAssertEqual(proposed.map(\.title), ["Send the pricing deck"])

        let report = await engine.report
        XCTAssertEqual(report.engineName, "stub")
        XCTAssertEqual(report.extractionCount, 1)
        XCTAssertEqual(report.candidateCount, 4)
        XCTAssertEqual(report.proposedCount, 1)
        XCTAssertEqual(report.droppedByQuote, ["Invented task"])
        XCTAssertEqual(report.droppedBelowConfidence, ["Maybe a task"])
        XCTAssertEqual(report.droppedAsDuplicate, ["Send pricing deck"])

        let lines = report.lines()
        XCTAssertTrue(lines.contains("dropped_quote_not_in_window: 1"))
        XCTAssertTrue(lines.contains("  - Invented task"))
        // Titles may appear; the transcript itself never does.
        XCTAssertFalse(lines.joined(separator: "\n").contains("nobody ever said"))
    }

    func testDebugReportSectionWithoutAnEngine() {
        let lines = TaskSuggestionDebugReport.lines(
            status: .init(mode: .cloud, name: "Control plane model", detail: "x", available: true),
            resolutionNote: "Suggestions off — no meeting to read.",
            report: nil
        )
        XCTAssertEqual(lines.first, "## Task suggestions")
        XCTAssertTrue(lines.contains("mode: cloud (Control plane model)"))
        XCTAssertTrue(lines.contains("resolution: Suggestions off — no meeting to read."))
        XCTAssertTrue(lines.contains("engine: none — nothing ran this meeting"))
    }

    @MainActor
    func testStatusNamesEveryMode() {
        XCTAssertEqual(TaskSuggestionEngineFactory.status(mode: .off).name, "Off")
        XCTAssertFalse(TaskSuggestionEngineFactory.status(mode: .off).available)
        XCTAssertEqual(TaskSuggestionEngineFactory.status(mode: .cloud).name, "Control plane model")
        XCTAssertEqual(TaskSuggestionEngineFactory.status(mode: .rules).name, "Rules")
        let onDevice = TaskSuggestionEngineFactory.status(mode: .onDevice)
        XCTAssertEqual(onDevice.name, "On-device model")
        // Whatever this machine can do, the detail says so — never blank.
        XCTAssertFalse(onDevice.detail.isEmpty)
    }
}
