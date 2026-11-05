import Foundation
import XCTest
@testable import Starlings

final class LocalMeetingTranscriberTests: XCTestCase {
    private let startedAt = Date(timeIntervalSince1970: 1_000)
    private let sampleRate = 16_000.0
    private let speaker = TranscriptionSpeaker(id: "speaker-a", name: "Ava")
    private var savedLanguages: [String]?

    override func setUp() {
        super.setUp()
        let key = "meet.transcription.languages"
        savedLanguages = UserDefaults.standard.stringArray(forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
    }

    override func tearDown() {
        let key = "meet.transcription.languages"
        if let savedLanguages {
            UserDefaults.standard.set(savedLanguages, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
        super.tearDown()
    }

    func testBuffersAudioUntilTheEngineIsReadyAndPreservesSpeakerRouting() async {
        let engine = FakeTranscriptionEngine(output: "hello from the room")
        let recorder = CallbackRecorder()
        let transcriber = makeTranscriber(
            provider: FakeTranscriptionEngineProvider(engine: engine),
            recorder: recorder
        )

        await transcriber.ingest(frame(amplitude: 0.1, samples: 4_800, at: 0.3), from: speaker)
        await transcriber.ingest(frame(amplitude: 0, samples: 12_000, at: 1.05), from: speaker)

        let beforePreparation = await transcriber.healthSnapshot()
        XCTAssertFalse(beforePreparation.modelReady)
        XCTAssertEqual(beforePreparation.framesReceivedBeforeModelReady, 2)

        await transcriber.prepare()

        let segments = await recorder.segments
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments.first?.meetingID, "meeting-1")
        XCTAssertEqual(segments.first?.speakerID, speaker.id)
        XCTAssertEqual(segments.first?.speakerName, speaker.name)
        XCTAssertEqual(segments.first?.text, "hello from the room")
        XCTAssertTrue(segments.first?.isFinal == true)

        let requests = await engine.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.samples.count, 16_000)
        XCTAssertNil(requests.first?.languageHint)

        let afterPreparation = await transcriber.healthSnapshot()
        XCTAssertTrue(afterPreparation.modelReady)
        XCTAssertEqual(afterPreparation.emittedSegmentCount, 1)
    }

    func testRoutesSegmentsForMultipleSpeakersThroughOneEngine() async {
        let engine = FakeTranscriptionEngine(output: "one segment")
        let recorder = CallbackRecorder()
        let transcriber = makeTranscriber(
            provider: FakeTranscriptionEngineProvider(engine: engine),
            recorder: recorder
        )
        let secondSpeaker = TranscriptionSpeaker(id: "speaker-b", name: "Bo")

        await transcriber.prepare()
        await emitUtterance(to: transcriber, speaker: speaker, startingAt: 0.3)
        await emitUtterance(to: transcriber, speaker: secondSpeaker, startingAt: 2.3)

        let segments = await recorder.segments
        XCTAssertEqual(segments.map(\.speakerID), [speaker.id, secondSpeaker.id])
        XCTAssertEqual(segments.map(\.speakerName), [speaker.name, secondSpeaker.name])
        let health = await transcriber.healthSnapshot()
        let requests = await engine.requests
        XCTAssertEqual(health.activeSpeakerCount, 2)
        XCTAssertEqual(requests.count, 2)
    }

    func testShortUtteranceIsDiscardedBeforeCallingTheEngine() async {
        let engine = FakeTranscriptionEngine(output: "should not be used")
        let recorder = CallbackRecorder()
        let transcriber = makeTranscriber(
            provider: FakeTranscriptionEngineProvider(engine: engine),
            recorder: recorder
        )

        await transcriber.prepare()
        await transcriber.ingest(frame(amplitude: 0.1, samples: 3_200, at: 0.3), from: speaker)
        await transcriber.ingest(frame(amplitude: 0, samples: 12_000, at: 1.05), from: speaker)

        let health = await transcriber.healthSnapshot()
        XCTAssertEqual(health.discardedUtteranceCount, 1)
        XCTAssertEqual(health.emittedSegmentCount, 0)
        // A short utterance is counted, not announced: 07a5427 dropped the
        // noise-event status lines from the label.
        let statuses = await recorder.statuses
        let requests = await engine.requests
        XCTAssertFalse(statuses.contains { $0.contains("skipped a short") })
        XCTAssertTrue(requests.isEmpty)
    }

    func testEmptyEngineResultIsDiscarded() async {
        let engine = FakeTranscriptionEngine(output: " \n")
        let recorder = CallbackRecorder()
        let transcriber = makeTranscriber(
            provider: FakeTranscriptionEngineProvider(engine: engine),
            recorder: recorder
        )

        await transcriber.prepare()
        await emitUtterance(to: transcriber, speaker: speaker, startingAt: 0.3)

        let health = await transcriber.healthSnapshot()
        XCTAssertEqual(health.discardedUtteranceCount, 1)
        let segments = await recorder.segments
        let statuses = await recorder.statuses
        XCTAssertTrue(segments.isEmpty)
        XCTAssertFalse(statuses.contains { $0.contains("produced no text") })
    }

    func testEngineFailureReportsOnceAndDoesNotEmitASegment() async {
        let engine = FakeTranscriptionEngine(failure: .inferenceFailed)
        let recorder = CallbackRecorder()
        let transcriber = makeTranscriber(
            provider: FakeTranscriptionEngineProvider(engine: engine),
            recorder: recorder
        )

        await transcriber.prepare()
        await emitUtterance(to: transcriber, speaker: speaker, startingAt: 0.3)

        let health = await transcriber.healthSnapshot()
        XCTAssertEqual(health.failedSegmentCount, 1)
        XCTAssertEqual(health.lastFailureKind, "speech recognition")
        let failures = await recorder.failures
        let segments = await recorder.segments
        let statuses = await recorder.statuses
        XCTAssertEqual(failures.count, 1)
        XCTAssertTrue(segments.isEmpty)
        XCTAssertTrue(statuses.contains { $0.contains("speech recognition failed") })
    }

    func testUnavailableEngineReportsFailureAndNeverClaimsReadiness() async {
        let engine = FakeTranscriptionEngine(isReady: false, output: "not used")
        let recorder = CallbackRecorder()
        let transcriber = makeTranscriber(
            provider: FakeTranscriptionEngineProvider(engine: engine),
            recorder: recorder
        )

        await transcriber.prepare()

        let health = await transcriber.healthSnapshot()
        XCTAssertFalse(health.modelReady)
        XCTAssertNil(health.modelReadyAt)
        let failures = await recorder.failures
        let statuses = await recorder.statuses
        let requests = await engine.requests
        XCTAssertEqual(failures.count, 1)
        XCTAssertTrue(statuses.contains { $0.contains("Transcription unavailable") })
        XCTAssertEqual(requests.count, 0)
    }

    func testPreparationCancellationIsNonFatal() async {
        let recorder = CallbackRecorder()
        let transcriber = makeTranscriber(
            provider: FakeTranscriptionEngineProvider(cancellation: true),
            recorder: recorder
        )

        await transcriber.prepare()

        let failures = await recorder.failures
        let statuses = await recorder.statuses
        let health = await transcriber.healthSnapshot()
        XCTAssertTrue(failures.isEmpty)
        XCTAssertTrue(statuses.contains { $0 == "Transcription stopped" })
        XCTAssertFalse(health.modelReady)
    }

    func testFinishCleansUpTheEngineExactlyOnce() async {
        let engine = FakeTranscriptionEngine(output: "unused")
        let recorder = CallbackRecorder()
        let transcriber = makeTranscriber(
            provider: FakeTranscriptionEngineProvider(engine: engine),
            recorder: recorder
        )

        await transcriber.prepare()
        await transcriber.finish()
        await transcriber.finish()

        let cleanupCount = await engine.cleanupCount
        let health = await transcriber.healthSnapshot()
        let statuses = await recorder.statuses
        XCTAssertEqual(cleanupCount, 1)
        XCTAssertFalse(health.modelReady)
        XCTAssertEqual(statuses.last, "Transcription stopped; no audio was retained")
    }

    private func makeTranscriber(
        provider: any LocalTranscriptionEngineProvider,
        recorder: CallbackRecorder
    ) -> LocalMeetingTranscriber {
        LocalMeetingTranscriber(
            meetingID: "meeting-1",
            startedAt: startedAt,
            onSegment: { segment in await recorder.record(segment) },
            onStatus: { status in await recorder.record(status: status) },
            onFailure: { failure in await recorder.record(failure: failure) },
            engineProvider: provider
        )
    }

    private func emitUtterance(
        to transcriber: LocalMeetingTranscriber,
        speaker: TranscriptionSpeaker,
        startingAt: TimeInterval
    ) async {
        await transcriber.ingest(
            frame(amplitude: 0.1, samples: 4_800, at: startingAt),
            from: speaker
        )
        await transcriber.ingest(
            frame(amplitude: 0, samples: 12_000, at: startingAt + 0.75),
            from: speaker
        )
    }

    private func frame(
        amplitude: Float,
        samples: Int,
        at offset: TimeInterval
    ) -> TranscriptionAudioFrame {
        TranscriptionAudioFrame(
            samples: Array(repeating: amplitude, count: samples),
            sampleRate: sampleRate,
            capturedAt: startedAt.addingTimeInterval(offset)
        )
    }
}

private actor CallbackRecorder {
    var segments: [TranscriptSegment] = []
    var statuses: [String] = []
    var failures: [String] = []

    func record(_ segment: TranscriptSegment) {
        segments.append(segment)
    }

    func record(status: String) {
        statuses.append(status)
    }

    func record(failure: String) {
        failures.append(failure)
    }
}

private enum FakeTranscriptionEngineError: LocalizedError, Sendable {
    case inferenceFailed
    case providerFailed

    var errorDescription: String? {
        switch self {
        case .inferenceFailed:
            "fake inference failed"
        case .providerFailed:
            "fake provider failed"
        }
    }
}

private actor FakeTranscriptionEngine: LocalTranscriptionEngine {
    let ready: Bool
    let output: String
    let failure: FakeTranscriptionEngineError?
    var requests: [LocalTranscriptionRequest] = []
    var cleanupCount = 0

    init(
        isReady: Bool = true,
        output: String = "fake transcript",
        failure: FakeTranscriptionEngineError? = nil
    ) {
        self.ready = isReady
        self.output = output
        self.failure = failure
    }

    func isReady() async -> Bool {
        ready
    }

    func transcribe(_ request: LocalTranscriptionRequest) async throws -> LocalTranscriptionResult {
        requests.append(request)
        if let failure { throw failure }
        return LocalTranscriptionResult(text: output)
    }

    func cleanup() async {
        cleanupCount += 1
    }
}

private struct FakeTranscriptionEngineProvider: LocalTranscriptionEngineProvider {
    let engine: FakeTranscriptionEngine?
    let failure: FakeTranscriptionEngineError?
    let cancellation: Bool

    init(
        engine: FakeTranscriptionEngine? = nil,
        failure: FakeTranscriptionEngineError? = nil,
        cancellation: Bool = false
    ) {
        self.engine = engine
        self.failure = failure
        self.cancellation = cancellation
    }

    func makeEngine() async throws -> any LocalTranscriptionEngine {
        if cancellation { throw CancellationError() }
        if let failure { throw failure }
        return engine ?? FakeTranscriptionEngine()
    }
}
