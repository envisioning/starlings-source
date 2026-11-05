import CoreAudio
import Foundation

/// Live captions during an ambient capture: a view of what the
/// two tracks are hearing while the recording runs, so the person knows the
/// call is being captured and who it thinks is speaking. Nothing here is a
/// transcript. The final transcript is still the post-hoc pass over the CAFs
/// (`AmbientCapturePass`); nothing from this view is uploaded.
///
/// The audio path is the room path's: the session hands each IO buffer to
/// `AmbientLiveCaptionFeed`, which downmixes to mono and feeds the same
/// `LocalMeetingTranscriber` a hosted meeting runs, with two "speakers" — the
/// mic lane, which is the owner, and the system lane, which is everyone else.
/// The system lane takes a name only when the call app reported that person
/// as speaking at that moment (the extension's lit tiles, or the Zoom
/// reader). Otherwise it carries no name. It never invents one.
enum AmbientCaptionLane: String, Sendable {
    case mic
    case system
}

struct AmbientCaptionLine: Identifiable, Equatable, Sendable {
    let id: UUID
    let lane: AmbientCaptionLane
    /// The owner on the mic lane; a reported speaker on the system lane; nil
    /// when nobody was reported.
    let speaker: String?
    /// Seconds since the capture started.
    let at: TimeInterval
    let text: String
}

/// What each track has delivered lately, for the "is Meet hearing this?"
/// line. Peaks come from the session's own metering.
struct AmbientCaptionTrackHealth: Equatable, Sendable {
    var peak: Float = 0
    var lastAudioAt: Date?
    var lastWordsAt: Date?
}

/// Main-actor state the window draws. Lives on the controller for the whole
/// app's life; a feed attaches to it per recording.
@MainActor
final class AmbientLiveCaptionsModel {
    static let lineLimit = 400

    private(set) var lines: [AmbientCaptionLine] = []
    private(set) var mic = AmbientCaptionTrackHealth()
    private(set) var system = AmbientCaptionTrackHealth()
    /// The engine's own line: loading, failed, or empty when it runs.
    private(set) var status = ""
    var onChange: (() -> Void)?

    func reset() {
        lines = []
        mic = AmbientCaptionTrackHealth()
        system = AmbientCaptionTrackHealth()
        status = ""
        onChange?()
    }

    func append(_ line: AmbientCaptionLine) {
        lines.append(line)
        if lines.count > Self.lineLimit { lines.removeFirst(lines.count - Self.lineLimit) }
        switch line.lane {
        case .mic: mic.lastWordsAt = Date()
        case .system: system.lastWordsAt = Date()
        }
        onChange?()
    }

    func setStatus(_ text: String) {
        guard status != text else { return }
        status = text
        onChange?()
    }

    func observe(micPeak: Float, systemPeak: Float, at: Date) {
        mic.peak = micPeak
        system.peak = systemPeak
        if micPeak > 0 { mic.lastAudioAt = at }
        if systemPeak > 0 { system.lastAudioAt = at }
        // Levels tick with every buffer; the window polls them on its own
        // clock instead of being redrawn a hundred times a second.
    }
}

/// One recording's worth of live recognition. Created by the controller at
/// start, finished at stop. Buffers arrive on the IO thread and leave it at
/// once through a bounded stream, the way `MeetingAudioRenderer` does for
/// LiveKit; the transcriber never runs on the IO thread.
final class AmbientLiveCaptionFeed: @unchecked Sendable {
    private let transcriber: LocalMeetingTranscriber
    private let model: AmbientLiveCaptionsModel
    private let ownerName: String
    private let startedAt: Date
    private let micStream: AsyncStream<TranscriptionAudioFrame>.Continuation
    private let systemStream: AsyncStream<TranscriptionAudioFrame>.Continuation
    private var consumers: [Task<Void, Never>] = []
    private var prepare: Task<Void, Never>?

    /// Who the call app said was speaking, and when — the last ten minutes,
    /// the same evidence the pass votes with, kept in memory for the lane.
    private let speakingLock = NSLock()
    private var speaking: [SpeakerNaming.SpeakingEvent] = []
    private static let speakingWindow: TimeInterval = 600

    /// Metering reaches the model on the main queue, but at most this often.
    private let meterLock = NSLock()
    private var lastMeterAt: TimeInterval = 0
    private var micPeakSince: Float = 0
    private var systemPeakSince: Float = 0

    @MainActor
    init(model: AmbientLiveCaptionsModel, ownerName: String, startedAt: Date) {
        self.model = model
        self.ownerName = ownerName
        self.startedAt = startedAt
        model.reset()
        let owner = TranscriptionSpeaker(id: "owner", name: ownerName)
        let call = TranscriptionSpeaker(id: "system", name: "")
        // Captured for the handlers below; the class is not ready until
        // `super`-less init completes, so the closures reach the model directly.
        let feedModel = model
        let resolve = ResolverBox()
        let transcriber = LocalMeetingTranscriber(
            meetingID: "ambient-live",
            startedAt: startedAt,
            onSegment: { segment in
                let lane: AmbientCaptionLane = segment.speakerID == owner.id ? .mic : .system
                let name: String? = lane == .mic
                    ? ownerName
                    : resolve.resolver?(Double(segment.startsAtMilliseconds) / 1_000, Double(segment.endsAtMilliseconds) / 1_000)
                let line = AmbientCaptionLine(
                    id: segment.id,
                    lane: lane,
                    speaker: name,
                    at: Double(segment.startsAtMilliseconds) / 1_000,
                    text: segment.text
                )
                await MainActor.run { feedModel.append(line) }
            },
            onStatus: { text in
                await MainActor.run { feedModel.setStatus(text) }
            }
        )
        self.transcriber = transcriber
        let micPair = AsyncStream.makeStream(of: TranscriptionAudioFrame.self, bufferingPolicy: .bufferingNewest(1_200))
        let systemPair = AsyncStream.makeStream(of: TranscriptionAudioFrame.self, bufferingPolicy: .bufferingNewest(1_200))
        micStream = micPair.continuation
        systemStream = systemPair.continuation
        consumers = [
            Task {
                for await frame in micPair.stream {
                    if Task.isCancelled { break }
                    await transcriber.ingest(frame, from: owner)
                }
            },
            Task {
                for await frame in systemPair.stream {
                    if Task.isCancelled { break }
                    await transcriber.ingest(frame, from: call)
                }
            },
        ]
        resolve.resolver = { [weak self] start, end in self?.reportedSpeaker(between: start, and: end) }
        prepare = Task { await transcriber.prepare() }
    }

    /// The resolver is set after `self` exists; the box lets the segment
    /// handler, created before that, reach it without a retain cycle.
    private final class ResolverBox: @unchecked Sendable {
        var resolver: ((Double, Double) -> String?)?
    }

    // MARK: - From the session (IO thread)

    /// One IO delivery, already accepted by the session (right generation,
    /// not stopped). Interleaved Float32 at the graph's rate; downmixed here.
    func ingest(mic: AudioBuffer?, tap: AudioBuffer?, sampleRate: Double, micPeak: Float, tapPeak: Float, at: TimeInterval) {
        let captured = Date(timeIntervalSinceReferenceDate: at)
        if let mic, let samples = Self.mono(mic) {
            micStream.yield(TranscriptionAudioFrame(samples: samples, sampleRate: sampleRate, capturedAt: captured))
        }
        if let tap, let samples = Self.mono(tap) {
            systemStream.yield(TranscriptionAudioFrame(samples: samples, sampleRate: sampleRate, capturedAt: captured))
        }
        let publish: (Float, Float)? = meterLock.withLock {
            micPeakSince = max(micPeakSince, micPeak)
            systemPeakSince = max(systemPeakSince, tapPeak)
            guard at - lastMeterAt >= 0.25 else { return nil }
            lastMeterAt = at
            defer { micPeakSince = 0; systemPeakSince = 0 }
            return (micPeakSince, systemPeakSince)
        }
        if let publish {
            let model = model
            DispatchQueue.main.async {
                MainActor.assumeIsolated { model.observe(micPeak: publish.0, systemPeak: publish.1, at: captured) }
            }
        }
    }

    /// The call app's active speakers this second, on the same clock the
    /// session writes to disk for the pass.
    func absorb(speaking names: [String]) {
        guard !names.isEmpty else { return }
        let at = Date().timeIntervalSince(startedAt)
        speakingLock.withLock {
            speaking += names.map { .init(name: $0, at: at) }
            let floor = at - Self.speakingWindow
            if let first = speaking.firstIndex(where: { $0.at >= floor }), first > 0 {
                speaking.removeFirst(first)
            }
        }
    }

    /// Stop recognizing. Utterances in flight finish; the model keeps its
    /// lines until the next recording resets it.
    func finish() {
        prepare?.cancel()
        micStream.finish()
        systemStream.finish()
        let consumers = consumers
        let transcriber = transcriber
        Task {
            for consumer in consumers { await consumer.value }
            await transcriber.finish()
        }
    }

    // MARK: - Names

    /// The name the call app lit most during `[start, end]`, with a second
    /// of slack either side. The owner is the mic lane and never a candidate
    /// here (Zoom lights the owner's own tile too). Nobody reported → nil.
    private func reportedSpeaker(between start: Double, and end: Double) -> String? {
        let events = speakingLock.withLock { speaking }
        var votes: [String: Int] = [:]
        for event in events where event.at >= start - 1 && event.at <= end + 1 && event.name != ownerName {
            votes[event.name, default: 0] += 1
        }
        guard let best = votes.max(by: { $0.value < $1.value }) else { return nil }
        // Two names lit equally is not one name.
        let tied = votes.filter { $0.value == best.value }.count
        return tied == 1 ? best.key : nil
    }

    private static func mono(_ buffer: AudioBuffer) -> [Float]? {
        guard let data = buffer.mData, buffer.mNumberChannels > 0, buffer.mDataByteSize > 0 else { return nil }
        let channels = Int(buffer.mNumberChannels)
        let source = data.assumingMemoryBound(to: Float.self)
        let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
        let frames = count / channels
        guard frames > 0 else { return nil }
        if channels == 1 { return Array(UnsafeBufferPointer(start: source, count: frames)) }
        var out = [Float](repeating: 0, count: frames)
        let gain = 1 / Float(channels)
        for frame in 0..<frames {
            var sum: Float = 0
            let base = frame * channels
            for channel in 0..<channels { sum += source[base + channel] }
            out[frame] = sum * gain
        }
        return out
    }
}
