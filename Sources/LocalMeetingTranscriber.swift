import AVFoundation
import FluidAudio
import Foundation
import LiveKit

struct TranscriptionSpeaker: Hashable, Sendable {
    let id: String
    let name: String
}

struct TranscriptionAudioFrame: Sendable {
    let samples: [Float]
    let sampleRate: Double
    let capturedAt: Date
}

/// Copies LiveKit's short-lived PCM buffers into a bounded stream. No audio is
/// persisted; the copies only live long enough for voice activity detection.
final class MeetingAudioRenderer: AudioRenderer, @unchecked Sendable {
    private let continuation: AsyncStream<TranscriptionAudioFrame>.Continuation
    private let consumer: Task<Void, Never>

    init(speaker: TranscriptionSpeaker, transcriber: LocalMeetingTranscriber) {
        let pair = AsyncStream.makeStream(
            of: TranscriptionAudioFrame.self,
            bufferingPolicy: .bufferingNewest(1_200)
        )
        continuation = pair.continuation
        consumer = Task {
            for await frame in pair.stream {
                if Task.isCancelled { break }
                await transcriber.ingest(frame, from: speaker)
            }
        }
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        guard let samples = Self.copyMonoSamples(from: pcmBuffer), !samples.isEmpty else { return }
        continuation.yield(TranscriptionAudioFrame(
            samples: samples,
            sampleRate: pcmBuffer.format.sampleRate,
            capturedAt: Date()
        ))
    }

    func finish() {
        continuation.finish()
    }

    func drain() async {
        continuation.finish()
        await consumer.value
    }

    deinit {
        continuation.finish()
        consumer.cancel()
    }

    /// One mono float channel per frame, whatever LiveKit handed over. Shared with
    /// `SpatialAudioStage`, which spatialises the same tap.
    static func copyMonoSamples(from buffer: AVAudioPCMBuffer) -> [Float]? {
        let frames = Int(buffer.frameLength)
        let channels = Int(buffer.format.channelCount)
        guard frames > 0, channels > 0 else { return nil }
        let interleaved = buffer.format.isInterleaved
        var result = [Float](repeating: 0, count: frames)

        switch buffer.format.commonFormat {
        case .pcmFormatFloat32:
            guard let data = buffer.floatChannelData else { return nil }
            mix(frames: frames, channels: channels, interleaved: interleaved, into: &result) {
                data[$0][$1]
            }
        case .pcmFormatFloat64:
            // AVAudioPCMBuffer exposes Float32 channel data, not Float64;
            // LiveKit's capture module supplies Int16 on this path.
            return nil
        case .pcmFormatInt16:
            guard let data = buffer.int16ChannelData else { return nil }
            mix(frames: frames, channels: channels, interleaved: interleaved, into: &result) {
                Float(data[$0][$1]) / 32_768
            }
        case .pcmFormatInt32:
            guard let data = buffer.int32ChannelData else { return nil }
            mix(frames: frames, channels: channels, interleaved: interleaved, into: &result) {
                Float(data[$0][$1]) / 2_147_483_648
            }
        default:
            return nil
        }
        return result
    }

    private static func mix(
        frames: Int,
        channels: Int,
        interleaved: Bool,
        into result: inout [Float],
        sample: (_ channel: Int, _ offset: Int) -> Float
    ) {
        let divisor = Float(channels)
        for frame in 0..<frames {
            var value: Float = 0
            for channel in 0..<channels {
                let dataChannel = interleaved ? 0 : channel
                let offset = interleaved ? frame * channels + channel : frame
                value += sample(dataChannel, offset)
            }
            result[frame] = value / divisor
        }
    }
}

enum LocalTranscriptionModelStatus: Equatable, Sendable {
    case unsupportedPlatform
    case notDownloaded
    case ready
}

/// Host-only Parakeet v3 status and optional pre-download outside a live room.
enum LocalTranscriptionModel {
    static let version: AsrModelVersion = .v3
    static let encoderPrecision: ParakeetEncoderPrecision = .int8

    static func status() -> LocalTranscriptionModelStatus {
        guard SystemInfo.isAppleSilicon else { return .unsupportedPlatform }
        let cache = AsrModels.defaultCacheDirectory(for: version)
        if AsrModels.modelsExist(at: cache, version: version, encoderPrecision: encoderPrecision) {
            return .ready
        }
        return .notDownloaded
    }

    static func prepare(progressHandler: (@Sendable (Double) -> Void)? = nil) async throws {
        guard SystemInfo.isAppleSilicon else {
            throw LocalTranscriptionModelError.unsupportedPlatform
        }
        _ = try await AsrModels.download(
            version: version,
            encoderPrecision: encoderPrecision,
            progressHandler: { progress in
                progressHandler?(progress.fractionCompleted)
            }
        )
    }
}

/// Loads the speech models once per app run and hands the same instance to
/// every meeting.
///
/// Loading is not just I/O: CoreML compiles the encoder for the Neural Engine,
/// which takes ~17s the first time the compiled artifact is not in the system
/// cache (after an OS update, a rebuild with a new signature, or a cleared
/// cache). Paying that at meeting start meant the recognizer did not exist for
/// the first seconds of the call and every frame was dropped on the floor —
/// speech that simply never reached the transcript. Warm it while the owner is
/// still on the launch screen instead.
actor SpeechModelLoader {
    static let shared = SpeechModelLoader()

    private var loading: Task<AsrModels, Error>?
    /// Kick off loading without waiting — call as soon as the app is idle.
    nonisolated func warmUp() {
        guard SystemInfo.isAppleSilicon else { return }
        Task { _ = try? await models() }
    }

    func models() async throws -> AsrModels {
        if let loading { return try await loading.value }
        let task = Task {
            try await AsrModels.downloadAndLoad(
                version: LocalTranscriptionModel.version,
                encoderPrecision: LocalTranscriptionModel.encoderPrecision
            )
        }
        loading = task
        do {
            return try await task.value
        } catch {
            // Let the next meeting retry rather than caching the failure.
            loading = nil
            throw error
        }
    }

}

enum LocalTranscriptionModelError: LocalizedError {
    case unsupportedPlatform

    var errorDescription: String? {
        switch self {
        case .unsupportedPlatform:
            "Local transcription requires Apple Silicon"
        }
    }
}

/// The engine-facing request deliberately carries no FluidAudio types. A
/// different on-device recognizer can accept the same in-memory samples and
/// language hint without making the meeting pipeline know how it works.
enum LocalTranscriptionLanguage: String, Sendable {
    case english
    case portuguese
    case german
}

struct LocalTranscriptionRequest: Sendable {
    let samples: [Float]
    let languageHint: LocalTranscriptionLanguage?
}

struct LocalTranscriptionResult: Sendable {
    let text: String
}

/// Actor-safe boundary around a local speech engine. Implementations own
/// decoder state and model resources; the meeting actor only sees values and
/// lifecycle operations. No PCM crosses this boundary except in memory.
protocol LocalTranscriptionEngine: Actor {
    func isReady() async -> Bool
    func transcribe(_ request: LocalTranscriptionRequest) async throws -> LocalTranscriptionResult
    func cleanup() async
}

/// Model loading is separate from the meeting lifecycle so tests can provide a
/// fake engine and production can keep its existing shared model warm-up.
protocol LocalTranscriptionEngineProvider: Sendable {
    func makeEngine() async throws -> any LocalTranscriptionEngine
}

struct FluidAudioTranscriptionEngineProvider: LocalTranscriptionEngineProvider {
    func makeEngine() async throws -> any LocalTranscriptionEngine {
        let models = try await SpeechModelLoader.shared.models()
        return FluidAudioTranscriptionEngine(models: models)
    }
}

enum LocalTranscriptionEngineError: LocalizedError, Sendable {
    case notReady

    var errorDescription: String? {
        switch self {
        case .notReady:
            "The local transcription engine did not become ready"
        }
    }
}

/// Production Parakeet adapter. FluidAudio remains the default engine, but it
/// is now replaceable and its decoder state cannot leak into the meeting code.
actor FluidAudioTranscriptionEngine: LocalTranscriptionEngine {
    private let manager: AsrManager

    init(models: AsrModels) {
        manager = AsrManager(models: models)
    }

    func isReady() async -> Bool {
        await manager.isAvailable
    }

    func transcribe(_ request: LocalTranscriptionRequest) async throws -> LocalTranscriptionResult {
        var decoderState = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
        let result = try await manager.transcribe(
            request.samples,
            decoderState: &decoderState,
            language: request.languageHint?.fluidAudioLanguage
        )
        return LocalTranscriptionResult(text: result.text)
    }

    func cleanup() async {
        await manager.cleanup()
    }
}

private extension LocalTranscriptionLanguage {
    var fluidAudioLanguage: Language {
        switch self {
        case .english: return .english
        case .portuguese: return .portuguese
        case .german: return .german
        }
    }
}

/// Audio/recognition counters safe to include in a support report. It never
/// contains PCM, recognized text, participant names, or participant IDs.
struct LocalTranscriptionHealthSnapshot: Equatable, Sendable {
    let modelReady: Bool
    let modelReadyAt: Date?
    let receivedAudioFrameCount: Int
    let receivedAudioSampleCount: Int
    let framesReceivedBeforeModelReady: Int
    let preparationBufferOverflowCount: Int
    let speechFrameCount: Int
    let discardedUtteranceCount: Int
    let emittedSegmentCount: Int
    let failedSegmentCount: Int
    let activeSpeakerCount: Int
    let lastAudioAt: Date?
    let lastSpeechAt: Date?
    let lastSegmentAt: Date?
    let lastFailureKind: String?
}

/// The one stall rule for the host microphone, on the Mac and on the phone
///. Capture counts as lost when no frame from the host's own
/// microphone has reached the transcriber for `silenceLimit` seconds while the
/// host is unmuted. WebRTC hands the renderer a frame every 10 ms, silence
/// included, so a quiet host is not a stall; a phone call, Siri or a lost
/// capture tap after a route change is.
///
/// `expectedSince` is the latest of: the model became ready, the microphone
/// became expected (unmute), the last restart. Frames from before a mute say
/// nothing about capture after it.
enum TranscriptionStallCheck {
    static let silenceLimit: TimeInterval = 5

    static func isStalled(lastLocalAudioAt: Date?, expectedSince: Date, now: Date) -> Bool {
        let since = max(lastLocalAudioAt ?? .distantPast, expectedSince)
        return now.timeIntervalSince(since) >= silenceLimit
    }

    static func isFlowing(lastLocalAudioAt: Date?, now: Date) -> Bool {
        guard let lastLocalAudioAt else { return false }
        return now.timeIntervalSince(lastLocalAudioAt) < silenceLimit
    }
}

actor LocalMeetingTranscriber {
    typealias SegmentHandler = @Sendable (TranscriptSegment) async -> Void
    typealias StatusHandler = @Sendable (String) async -> Void
    typealias FailureHandler = @Sendable (String) async -> Void

    private struct SpeakerBuffer {
        var speaker: TranscriptionSpeaker
        var sourceSampleRate: Double
        var preRoll: [Float] = []
        var utterance: [Float] = []
        var speechSamples = 0
        var silenceSamples = 0
        var startsAtMilliseconds: Int64?

        var isSpeaking: Bool { !utterance.isEmpty }

        mutating func clearUtterance() {
            utterance.removeAll(keepingCapacity: true)
            speechSamples = 0
            silenceSamples = 0
            startsAtMilliseconds = nil
        }
    }

    private struct PendingUtterance: Sendable {
        let speaker: TranscriptionSpeaker
        let samples: [Float]
        let sourceSampleRate: Double
        let startsAtMilliseconds: Int64
        let endsAtMilliseconds: Int64
    }

    private let meetingID: String
    private let startedAt: Date
    private let engineProvider: any LocalTranscriptionEngineProvider
    private let onSegment: SegmentHandler
    private let onStatus: StatusHandler
    private let onFailure: FailureHandler?
    private let converter = AudioConverter()
    private var engine: (any LocalTranscriptionEngine)?
    private var speakers: [String: SpeakerBuffer] = [:]
    private var didFailPreparation = false
    private var isFinished = false
    private var modelReadyAt: Date?
    private var receivedAudioFrameCount = 0
    private var receivedAudioSampleCount = 0
    private var framesReceivedBeforeModelReady = 0
    private var preparationBufferOverflowCount = 0
    private var preparationFrames: [(frame: TranscriptionAudioFrame, speaker: TranscriptionSpeaker)] = []
    private let preparationBufferLimit = 1_200
    private var speechFrameCount = 0
    private var discardedUtteranceCount = 0
    private var emittedSegmentCount = 0
    private var failedSegmentCount = 0
    private var activeSpeakerIDs = Set<String>()
    private var lastAudioAt: Date?
    /// Per speaker, so the stall check reads the host's own microphone. A
    /// remote voice still arriving must not hide a dead local capture.
    /// Never leaves the actor, and never enters the health snapshot.
    private var lastAudioAtBySpeaker: [String: Date] = [:]
    private var lastSpeechAt: Date?
    private var lastSegmentAt: Date?
    private var lastFailureKind: String?
    private var didReportFailure = false

    init(
        meetingID: String,
        startedAt: Date,
        onSegment: @escaping SegmentHandler,
        onStatus: @escaping StatusHandler,
        onFailure: FailureHandler? = nil,
        engineProvider: any LocalTranscriptionEngineProvider = FluidAudioTranscriptionEngineProvider()
    ) {
        self.meetingID = meetingID
        self.startedAt = startedAt
        self.engineProvider = engineProvider
        self.onSegment = onSegment
        self.onStatus = onStatus
        self.onFailure = onFailure
    }

    func healthSnapshot() -> LocalTranscriptionHealthSnapshot {
        LocalTranscriptionHealthSnapshot(
            modelReady: engine != nil,
            modelReadyAt: modelReadyAt,
            receivedAudioFrameCount: receivedAudioFrameCount,
            receivedAudioSampleCount: receivedAudioSampleCount,
            framesReceivedBeforeModelReady: framesReceivedBeforeModelReady,
            preparationBufferOverflowCount: preparationBufferOverflowCount,
            speechFrameCount: speechFrameCount,
            discardedUtteranceCount: discardedUtteranceCount,
            emittedSegmentCount: emittedSegmentCount,
            failedSegmentCount: failedSegmentCount,
            activeSpeakerCount: activeSpeakerIDs.count,
            lastAudioAt: lastAudioAt,
            lastSpeechAt: lastSpeechAt,
            lastSegmentAt: lastSegmentAt,
            lastFailureKind: lastFailureKind
        )
    }

    /// When the last frame from one speaker arrived. The stall check asks
    /// for the host's own id (`TranscriptionStallCheck`).
    func lastAudioAt(speakerID: String) -> Date? {
        lastAudioAtBySpeaker[speakerID]
    }

    func prepare() async {
        guard engine == nil, !didFailPreparation, !isFinished else { return }
        await onStatus(String(localized: "Downloading or loading the speech model…"))
        do {
            // Shared across meetings: usually already warm, so this returns at
            // once instead of re-paying the Neural Engine compile.
            let candidate = try await engineProvider.makeEngine()
            try Task.checkCancellation()
            guard await candidate.isReady() else {
                throw LocalTranscriptionEngineError.notReady
            }
            engine = candidate
            modelReadyAt = Date()
            // Ready is the quiet state: no status line for it. The caption
            // panel's line count is the sign that transcription is working.
            await onStatus("")

            // Keep a bounded in-memory tail while CoreML is loading so speech
            // that arrives during startup is not silently thrown away. The
            // buffer is deliberately finite and is cleared as soon as it is
            // replayed or preparation fails.
            let bufferedFrames = preparationFrames
            preparationFrames.removeAll(keepingCapacity: true)
            if !bufferedFrames.isEmpty {
                for buffered in bufferedFrames {
                    await ingest(buffered.frame, from: buffered.speaker)
                }
            }

        } catch is CancellationError {
            preparationFrames.removeAll(keepingCapacity: true)
            await onStatus(String(localized: "Transcription stopped"))
        } catch {
            preparationFrames.removeAll(keepingCapacity: true)
            didFailPreparation = true
            lastFailureKind = "speech model preparation"
            await onStatus(String(localized: "Transcription unavailable — speech model couldn’t be loaded"))
            await reportFailure(error.localizedDescription)
        }
    }

    func ingest(_ frame: TranscriptionAudioFrame, from speaker: TranscriptionSpeaker) async {
        guard !isFinished, !frame.samples.isEmpty else { return }
        receivedAudioFrameCount += 1
        receivedAudioSampleCount += frame.samples.count
        lastAudioAt = frame.capturedAt
        lastAudioAtBySpeaker[speaker.id] = frame.capturedAt
        activeSpeakerIDs.insert(speaker.id)
        guard engine != nil else {
            framesReceivedBeforeModelReady += 1
            if preparationFrames.count >= preparationBufferLimit {
                preparationFrames.removeFirst()
                preparationBufferOverflowCount += 1
            }
            preparationFrames.append((frame: frame, speaker: speaker))
            return
        }
        var state = speakers[speaker.id] ?? SpeakerBuffer(
            speaker: speaker,
            sourceSampleRate: frame.sampleRate
        )
        if abs(state.sourceSampleRate - frame.sampleRate) > 1 {
            state = SpeakerBuffer(speaker: speaker, sourceSampleRate: frame.sampleRate)
        } else {
            state.speaker = speaker
        }

        let speech = Self.containsSpeech(frame.samples)
        if speech {
            speechFrameCount += 1
            lastSpeechAt = frame.capturedAt
        }
        let preRollLimit = Int(frame.sampleRate * 0.25)
        if !state.isSpeaking {
            state.preRoll.append(contentsOf: frame.samples)
            if state.preRoll.count > preRollLimit {
                state.preRoll.removeFirst(state.preRoll.count - preRollLimit)
            }
            if speech {
                state.utterance = state.preRoll
                state.speechSamples = frame.samples.count
                state.startsAtMilliseconds = max(
                    0,
                    elapsedMilliseconds(at: frame.capturedAt)
                        - Int64(Double(state.preRoll.count) / frame.sampleRate * 1_000)
                )
                state.preRoll.removeAll(keepingCapacity: true)
            }
        } else {
            state.utterance.append(contentsOf: frame.samples)
            if speech {
                state.speechSamples += frame.samples.count
                state.silenceSamples = 0
            } else {
                state.silenceSamples += frame.samples.count
            }
        }

        let silenceLimit = Int(frame.sampleRate * 0.75)
        let utteranceLimit = Int(frame.sampleRate * 12)
        let shouldFinalize = state.isSpeaking
            && (state.silenceSamples >= silenceLimit || state.utterance.count >= utteranceLimit)
        let wasSpeaking = state.isSpeaking
        let pending = shouldFinalize
            ? takeUtterance(from: &state, endingAt: frame.capturedAt)
            : nil
        speakers[speaker.id] = state
        if let pending {
            await transcribe(pending)
        } else if shouldFinalize && wasSpeaking {
            // Noise blips (coughs, clicks) land here. Count them for the debug
            // report; the status label stays on the last real state.
            discardedUtteranceCount += 1
        }
    }

    func finish() async {
        guard !isFinished else { return }
        isFinished = true
        preparationFrames.removeAll(keepingCapacity: true)
        for key in speakers.keys.sorted() {
            guard var state = speakers[key] else { continue }
            let pending = takeUtterance(from: &state, endingAt: Date())
            speakers[key] = state
            if let pending { await transcribe(pending) }
        }
        speakers.removeAll()
        if let engine { await engine.cleanup() }
        engine = nil
        await onStatus(String(localized: "Transcription stopped; no audio was retained"))
    }

    private func takeUtterance(
        from state: inout SpeakerBuffer,
        endingAt: Date
    ) -> PendingUtterance? {
        let minimumSpeechSamples = Int(state.sourceSampleRate * 0.3)
        guard state.isSpeaking,
              state.speechSamples >= minimumSpeechSamples,
              let startsAt = state.startsAtMilliseconds else {
            state.clearUtterance()
            return nil
        }
        let pending = PendingUtterance(
            speaker: state.speaker,
            samples: state.utterance,
            sourceSampleRate: state.sourceSampleRate,
            startsAtMilliseconds: startsAt,
            endsAtMilliseconds: max(startsAt, elapsedMilliseconds(at: endingAt))
        )
        state.clearUtterance()
        return pending
    }

    private func transcribe(_ utterance: PendingUtterance) async {
        guard let engine else { return }
        do {
            let samples = try converter.resample(
                utterance.samples,
                from: utterance.sourceSampleRate
            )
            guard samples.count >= 4_800 else {
                discardedUtteranceCount += 1
                return
            }
            let result = try await engine.transcribe(
                LocalTranscriptionRequest(
                    samples: samples,
                    languageHint: Self.languageHint(for: TranscriptionLanguages.selected)
                )
            )
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                discardedUtteranceCount += 1
                return
            }
            emittedSegmentCount += 1
            lastSegmentAt = Date()
            await onSegment(TranscriptSegment(
                id: UUID(),
                meetingID: meetingID,
                speakerID: utterance.speaker.id,
                speakerName: utterance.speaker.name,
                language: Self.inferLanguage(text),
                startsAtMilliseconds: utterance.startsAtMilliseconds,
                endsAtMilliseconds: utterance.endsAtMilliseconds,
                text: text,
                isFinal: true
            ))
        } catch {
            failedSegmentCount += 1
            lastFailureKind = "speech recognition"
            await onStatus(String(localized: "Transcription error — local speech recognition failed"))
            await reportFailure(error.localizedDescription)
        }
    }

    private func reportFailure(_ diagnostic: String) async {
        guard !didReportFailure else { return }
        didReportFailure = true
        await onFailure?(diagnostic)
    }

    private func elapsedMilliseconds(at date: Date) -> Int64 {
        Int64(max(0, date.timeIntervalSince(startedAt) * 1_000))
    }

    private static func containsSpeech(_ samples: [Float]) -> Bool {
        var energy: Double = 0
        var peak: Float = 0
        for sample in samples {
            let magnitude = abs(sample)
            peak = max(peak, magnitude)
            energy += Double(sample * sample)
        }
        let rms = sqrt(energy / Double(samples.count))
        return rms >= 0.008 || peak >= 0.04
    }

    /// An empty selection passes no hint — the engine keeps its full freedom,
    /// same as before this preference existed. The production adapter maps
    /// this value to FluidAudio's script filter; another engine may interpret
    /// the hint in its own way.
    static func languageHint(for selected: [TranscriptLanguage]) -> LocalTranscriptionLanguage? {
        if selected.contains(.english) { return .english }
        if selected.contains(.portuguese) { return .portuguese }
        if selected.contains(.german) { return .german }
        return nil
    }

    /// What language a finished segment is labelled with.
    ///
    /// Markers in the recognized text, weighed against each other — this runs
    /// *after* the model and cannot affect what was heard. What it can do is
    /// stop guessing at languages nobody in the room speaks: the candidates are
    /// whatever this device was told to expect, and with exactly one expected
    /// there is nothing to weigh at all. See `TranscriptionLanguages`.
    ///
    /// With nothing chosen it weighs everything and falls back to English on a
    /// tie, which is the behaviour this has always had.
    /// Shared with the two-track pass: the same guess for a segment's
    /// language, from the same markers.
    static func inferLanguage(_ text: String) -> TranscriptLanguage {
        let candidates = TranscriptionLanguages.candidates
        // One expected language is an answer, not a question. It also makes a
        // short segment — "Exato." — land on the right language, where markers
        // have almost nothing to go on.
        if candidates.count == 1, let only = candidates.first { return only }

        let normalized = text
            .lowercased()
            .folding(options: [.diacriticInsensitive], locale: Locale(identifier: "en"))
        let words = Set(normalized.split(whereSeparator: { !$0.isLetter }).map(String.init))
        let portugueseMarkers: Set<String> = [
            "a", "agora", "ainda", "assim", "com", "como", "da", "de", "do", "e",
            "entao", "esta", "eu", "isso", "mais", "mas", "na", "nao", "no", "nos",
            "o", "os", "para", "por", "porque", "que", "se", "sim", "tambem", "uma", "voce",
        ]
        let englishMarkers: Set<String> = [
            "a", "and", "are", "but", "for", "from", "have", "i", "in", "is", "it", "not",
            "of", "on", "so", "that", "the", "this", "to", "we", "what", "with", "you",
        ]
        let germanMarkers: Set<String> = [
            "aber", "auch", "auf", "das", "dass", "dem", "den", "der", "des", "die",
            "ein", "eine", "fur", "haben", "ich", "ist", "ja", "mit", "nicht", "noch",
            "oder", "schon", "sie", "sind", "und", "von", "was", "wenn", "wie", "wir", "zu",
        ]
        let markers: [TranscriptLanguage: Set<String>] = [
            .english: englishMarkers,
            .portuguese: portugueseMarkers,
            .german: germanMarkers,
        ]

        // Only what this device expects to hear. A Portuguese-and-English room
        // never has a line handed to German because three short words happened
        // to overlap, which is exactly what the old three-way weigh allowed.
        //
        // Ties keep the first candidate rather than always English: with a
        // selection, first means the one nearest the top of the picker, and
        // preferring English regardless would undo the point of choosing.
        var best = candidates.first ?? .english
        var bestScore = -1
        for language in candidates {
            let score = markers[language].map { words.intersection($0).count } ?? 0
            if score > bestScore {
                best = language
                bestScore = score
            }
        }
        return best
    }
}
