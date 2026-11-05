import AVFoundation
import CoreAudio
import Foundation

/// One ambient recording from start to stop: the graph, the two track
/// writers, the manifest on disk, and everything that can go wrong in
/// between — a route change, a silent track, a full disk, a writer that
/// fails. The policy for each is in `AmbientCapturePolicy`; this is where it
/// is applied.
///
/// All state lives on one serial queue. The IO thread only hands buffers in
/// (through `ioLock`, never the queue); the UI only hears events out, on the
/// main queue.
enum AmbientCaptureWarning: Equatable, Sendable {
    /// The default input or output moved; the graph is being rebuilt.
    case rebuilding
    /// The graph has been down for a while and is still retrying.
    case captureDown
    /// The microphone has delivered only zeros for a minute.
    case micSilent
    /// The tap has delivered only zeros for a minute while something
    /// plays — the System Audio Recording grant is missing or revoked.
    case tapSilent
    /// Six hours in. Nothing wrong; said once.
    case longSession

    var text: String {
        switch self {
        case .rebuilding: String(localized: "Audio device changed — reconnecting")
        case .captureDown: String(localized: "Audio device changed — recording is paused, retrying")
        case .micSilent: String(localized: "The microphone is silent")
        case .tapSilent: String(localized: "No system audio — check System Audio Recording permission")
        case .longSession: String(localized: "Recording for over six hours")
        }
    }
}

enum AmbientCaptureEvent: Equatable, Sendable {
    case started
    case warning(AmbientCaptureWarning)
    case warningCleared(AmbientCaptureWarning)
    /// Recording stopped on its own: a writer failed, or the rebuild
    /// ladder ran out. The tracks up to that point are on disk.
    case stoppedOnFailure(String)
    case stopped(AmbientCaptureManifest)
}


/// What a capture is about when it starts, when anything is known.
struct AmbientCaptureContext: Sendable {
    var title: String?
    var meetingCode: String?
    var calendarEventID: String?
    var scheduledEnd: Date?
    var attendees: [String] = []
    var attendeeEmails: [String: String] = [:]
    /// The signed-in account's address, lowercased; the controller fills it.
    var owner: String?
}

struct AmbientCaptureStartFailure: Error, CustomStringConvertible {
    let description: String
}

/// What the controller holds without naming the availability-gated class.
protocol AmbientCaptureSessionHandle: AnyObject {
    var startedAt: Date { get }
    func stop()
    func stopAndWait()
}

@available(macOS 14.2, *)
final class AmbientCaptureSession: AmbientCaptureSessionHandle, @unchecked Sendable {
    let id: UUID
    let directory: URL
    private(set) var manifest: AmbientCaptureManifest
    private let queue = DispatchQueue(label: "meet.ambient.session")
    private let input: AmbientInputDevice
    private let onEvent: @Sendable (AmbientCaptureEvent) -> Void

    private var graph: AmbientCaptureGraph?
    private var micWriter: AmbientTrackWriter?
    private var systemWriter: AmbientTrackWriter?
    private var stopped = false

    /// What the IO thread reads: the current generation and rate, and the
    /// writers. Under its own lock, because the IO thread must never wait
    /// on the session queue.
    private struct IOState {
        var generation = 0
        var rate: Double = 48_000
        var mic: AmbientTrackWriter?
        var system: AmbientTrackWriter?
        /// Live captions, when the controller attached a feed.
        var live: AmbientLiveCaptionFeed?
        var stopped = false
    }
    private let ioLock = NSLock()
    private var io = IOState()
    private var deliveries: Int64 = 0

    // Health
    private var micSilence = SilenceDetector(threshold: AmbientCapturePolicy.micSilenceWarningSeconds)
    private var tapSilence = SilenceDetector(threshold: AmbientCapturePolicy.tapSilenceWarningSeconds)
    private var activeWarnings: Set<AmbientCaptureWarning> = []
    private var lastDeliveryAt: TimeInterval?
    private var healthTimer: DispatchSourceTimer?

    // Route changes
    private var debounce = RouteChangeDebounce()
    private var ladder = RebuildRetryLadder()
    private var rebuildTimer: DispatchSourceTimer?
    private var downSince: TimeInterval?
    private var generation = 0
    private var listenerBlock: AudioObjectPropertyListenerBlock?
    private var listenerAddresses: [AudioObjectPropertyAddress] = []

    typealias Context = AmbientCaptureContext

    /// Opens the tracks, builds the graph, writes the first manifest, and
    /// starts. When any step throws, the folder and the tracks it opened are
    /// removed before the error goes up: nothing is left on disk.
    convenience init(input: AmbientInputDevice, title: String?, onEvent: @escaping @Sendable (AmbientCaptureEvent) -> Void) throws {
        try self.init(input: input, context: Context(title: title), onEvent: onEvent)
    }

    init(input: AmbientInputDevice, context: Context, onEvent: @escaping @Sendable (AmbientCaptureEvent) -> Void) throws {
        try Self.assertDiskSpace()
        id = UUID()
        directory = AmbientCaptureStore.directory(for: id)
        self.input = input
        self.onEvent = onEvent
        let now = Date()
        var fresh = AmbientCaptureManifest(
            id: id,
            source: "ambient",
            startedAt: now,
            status: .recording,
            inputName: input.name,
            trackSampleRate: AmbientCapturePolicy.trackSampleRate,
            parts: [],
            title: context.title
        )
        fresh.meetingCode = context.meetingCode
        fresh.calendarEventID = context.calendarEventID
        fresh.scheduledEnd = context.scheduledEnd
        fresh.absorb(attendees: context.attendees)
        fresh.attendeeEmails = context.attendeeEmails
        fresh.owner = context.owner
        fresh.workspace = StarlingsWorkspace.active.webOrigin
        manifest = fresh
        // The graph is built on the caller's thread — the main thread, with
        // its run loop free the moment this returns. Built from inside a
        // `queue.sync` the aggregate reported `noErr` on start and never ran.
        do {
            try openPart(at: now)
            try buildGraph()
            manifest.note("Started. Microphone: \(input.name). Output: \(graph?.outputName ?? "?").", at: now)
            try AmbientCaptureStore.write(manifest, to: directory)
        } catch {
            // A fresh folder: everything in it is this start's.
            abandonStart()
            AmbientCaptureStore.remove(directory)
            throw error
        }
        queue.sync {
            installRouteListeners()
            startHealthTimer()
        }
        onEvent(.started)
    }

    /// Resume a graced capture as its next part: same folder, same manifest,
    /// a new pair of tracks. The gap between the parts is a gap — the pass
    /// stitches parts with silence between their timestamps, not this.
    /// Throws when the folder is gone (sign-out, the sweep): a resume never
    /// recreates a deleted capture. When a later step throws, the new
    /// part's tracks are removed and the manifest on disk is untouched.
    init(resuming existing: AmbientCaptureManifest, in directory: URL, input: AmbientInputDevice, onEvent: @escaping @Sendable (AmbientCaptureEvent) -> Void) throws {
        try Self.assertDiskSpace()
        id = existing.id
        self.directory = directory
        self.input = input
        self.onEvent = onEvent
        var resumed = existing
        resumed.status = .recording
        resumed.endedAt = nil
        manifest = resumed
        let now = Date()
        guard FileManager.default.fileExists(atPath: AmbientCaptureStore.manifestURL(in: directory).path) else {
            throw AmbientCaptureStartFailure(description: "The recording to resume was deleted.")
        }
        do {
            try openPart(at: now)
            try buildGraph()
            manifest.note("Resumed as part \(manifest.parts.count). Microphone: \(input.name). Output: \(graph?.outputName ?? "?").", at: now)
            try AmbientCaptureStore.write(manifest, to: directory)
        } catch {
            abandonStart()
            for part in manifest.parts where part.index >= existing.parts.count {
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(part.micFile))
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(part.systemFile))
            }
            throw error
        }
        queue.sync {
            installRouteListeners()
            startHealthTimer()
        }
        onEvent(.started)
    }

    /// What the extension learned mid-call, folded into the record: who is
    /// there, and — the evidence that names the diarizer's clusters — who
    /// was speaking this second.
    func absorb(attendees: [String], speaking: [String], title: String?) {
        queue.async { [self] in
            guard !stopped else { return }
            manifest.absorb(attendees: attendees)
            if manifest.title == nil, let title, !title.isEmpty { manifest.title = title }
            let at = Date().timeIntervalSince(manifest.startedAt)
            AmbientCaptureStore.appendSpeaking(speaking.map { .init(name: $0, at: at) }, in: directory)
        }
    }

    /// Stops, closes the tracks, verifies them, writes the final manifest,
    /// and reports it. Idempotent.
    func stop() {
        queue.async { [self] in finish(failure: nil) }
    }

    /// `stop()` and wait — for the quit intercept.
    func stopAndWait() {
        queue.sync { [self] in finish(failure: nil) }
    }

    /// Hand every accepted IO buffer to a live-captions feed as well as the
    /// writers. The feed is a view; the writers stay the record.
    func attachLiveCaptions(_ feed: AmbientLiveCaptionFeed?) {
        ioLock.withLock { io.live = feed }
    }

    var startedAt: Date { manifest.startedAt }
    var elapsed: TimeInterval { Date().timeIntervalSince(manifest.startedAt) }

    // MARK: - Parts and graph (on the queue)

    private func openPart(at now: Date) throws {
        let index = manifest.parts.count
        let micFile = "capture_mic_\(index).caf"
        let systemFile = "capture_system_\(index).caf"
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let mic = try AmbientTrackWriter(url: directory.appendingPathComponent(micFile), label: "mic")
        let system = try AmbientTrackWriter(url: directory.appendingPathComponent(systemFile), label: "system")
        let onFailure: @Sendable (AmbientTrackWriter.Failure) -> Void = { [weak self] failure in
            guard let self else { return }
            queue.async { self.finish(failure: "\(failure)") }
        }
        mic.onFailure = onFailure
        system.onFailure = onFailure
        micWriter = mic
        systemWriter = system
        ioLock.withLock {
            io.mic = mic
            io.system = system
        }
        manifest.parts.append(.init(index: index, micFile: micFile, systemFile: systemFile, startedAt: now))
    }

    /// A start that threw: the graph down and the writers closed, so the
    /// caller can remove the files they held.
    private func abandonStart() {
        graph?.tearDown()
        graph = nil
        ioLock.withLock {
            io.stopped = true
            io.mic = nil
            io.system = nil
        }
        _ = micWriter?.close()
        _ = systemWriter?.close()
        micWriter = nil
        systemWriter = nil
    }

    private func buildGraph() throws {
        generation += 1
        let thisGeneration = generation
        let built = try AmbientCaptureGraph(input: input) { [weak self] delivery in
            self?.ingest(delivery, generation: thisGeneration)
        }
        graph = built
        ioLock.withLock {
            io.generation = thisGeneration
            io.rate = built.sampleRate
        }
        micSilence.reset()
        tapSilence.reset()
    }

    /// On the IO thread. Copies into the writers, meters, and returns.
    private func ingest(_ delivery: AmbientCaptureGraph.Delivery, generation: Int) {
        // A buffer from a graph being torn down: drop it, the rebuild will
        // back-fill the gap as silence.
        let state = ioLock.withLock { deliveries += 1; return io }
        guard generation == state.generation, !state.stopped else { return }
        var micPeak: Float = 0
        var tapPeak: Float = 0
        if let mic = delivery.mic {
            micPeak = Self.peak(of: mic)
            state.mic?.append(mic, sampleRate: state.rate)
        }
        if let tap = delivery.tap {
            tapPeak = Self.peak(of: tap)
            state.system?.append(tap, sampleRate: state.rate)
        }
        state.live?.ingest(mic: delivery.mic, tap: delivery.tap, sampleRate: state.rate, micPeak: micPeak, tapPeak: tapPeak, at: delivery.at)
        let at = delivery.at
        let heardMic = micPeak
        let heardTap = tapPeak
        queue.async { [self] in
            guard generation == self.generation, !stopped else { return }
            lastDeliveryAt = at
            if micSilence.observe(peak: heardMic, at: at) {
                raise(.micSilent)
            } else if heardMic > 0 {
                clear(.micSilent)
            }
            if heardTap > 0 {
                _ = tapSilence.observe(peak: heardTap, at: at)
                clear(.tapSilent)
            } else if graph?.outputIsPlaying ?? false {
                // Zeros while something plays: the grant is missing.
                if tapSilence.observe(peak: 0, at: at) { raise(.tapSilent) }
            } else {
                // Silence while nothing plays is not evidence. The clock
                // starts again when something does.
                tapSilence.reset()
            }
        }
    }

    private static func peak(of buffer: AudioBuffer) -> Float {
        guard let data = buffer.mData else { return 0 }
        let samples = data.assumingMemoryBound(to: Float.self)
        let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
        var peak: Float = 0
        var index = 0
        while index < count {
            let value = abs(samples[index])
            if value > peak { peak = value }
            index += 1
        }
        return peak
    }

    // MARK: - Route changes (on the queue)

    private func installRouteListeners() {
        listenerAddresses = [
            CoreAudioProperties.address(kAudioHardwarePropertyDefaultOutputDevice),
            CoreAudioProperties.address(kAudioHardwarePropertyDefaultInputDevice),
        ]
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            queue.async { self.routeChanged() }
        }
        listenerBlock = block
        for index in listenerAddresses.indices {
            let status = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &listenerAddresses[index], queue, block)
            if status != noErr {
                manifest.note("Could not listen for route changes (\(CoreAudioProperties.statusName(status))).")
            }
        }
    }

    private func removeRouteListeners() {
        guard let block = listenerBlock else { return }
        for index in listenerAddresses.indices {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &listenerAddresses[index], queue, block)
        }
        listenerBlock = nil
    }

    private func routeChanged() {
        guard !stopped else { return }
        let now = Date().timeIntervalSinceReferenceDate
        let fireAt = debounce.trigger(at: now)
        manifest.note("Route change; rebuild due in \(String(format: "%.1f", fireAt - now))s.")
        scheduleRebuild(at: fireAt)
        raise(.rebuilding)
    }

    private func scheduleRebuild(at fireAt: TimeInterval) {
        rebuildTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let delay = max(0, fireAt - Date().timeIntervalSinceReferenceDate)
        timer.schedule(deadline: .now() + delay)
        timer.setEventHandler { [weak self] in self?.rebuild() }
        timer.resume()
        rebuildTimer = timer
    }

    private func rebuild() {
        guard !stopped else { return }
        rebuildTimer = nil
        debounce.reset()
        let wentDown = lastDeliveryAt ?? Date().timeIntervalSinceReferenceDate
        if downSince == nil { downSince = wentDown }
        graph?.tearDown()
        graph = nil
        do {
            try buildGraph()
            // The audio between the last buffer and now is gone; the
            // timeline stays true with silence in its place.
            let resumedAt = Date().timeIntervalSinceReferenceDate
            let gap = SilenceBackfill.seconds(lastFrameAt: downSince ?? wentDown, resumedAt: resumedAt)
            if gap > 0 {
                micWriter?.appendSilence(seconds: gap)
                systemWriter?.appendSilence(seconds: gap)
                manifest.note("Rebuilt after a route change; \(String(format: "%.1f", gap))s back-filled as silence. Output: \(graph?.outputName ?? "?").")
            } else {
                manifest.note("Rebuilt after a route change. Output: \(graph?.outputName ?? "?").")
            }
            downSince = nil
            ladder.reset()
            clear(.rebuilding)
            clear(.captureDown)
            try? AmbientCaptureStore.write(manifest, to: directory)
        } catch {
            manifest.note("Rebuild failed: \(error).")
            if let delay = ladder.nextDelay() {
                if let since = downSince, Date().timeIntervalSinceReferenceDate - since > 8 { raise(.captureDown) }
                scheduleRebuild(at: Date().timeIntervalSinceReferenceDate + delay)
            } else {
                finish(failure: "The audio graph couldn’t be rebuilt after a device change: \(error)")
            }
        }
    }

    // MARK: - Health (on the queue)

    private func startHealthTimer() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in
            guard let self, !stopped else { return }
            if elapsed >= AmbientCapturePolicy.longSessionWarningSeconds { raise(.longSession) }
            // Frame counts for the manifest, so a crash keeps a recent total.
            if let index = manifest.parts.indices.last {
                manifest.parts[index].micFrames = micWriter?.frames ?? 0
                manifest.parts[index].systemFrames = systemWriter?.frames ?? 0
            }
            try? AmbientCaptureStore.write(manifest, to: directory)
        }
        timer.resume()
        healthTimer = timer
    }

    private func raise(_ warning: AmbientCaptureWarning) {
        guard activeWarnings.insert(warning).inserted else { return }
        manifest.note("Warning: \(warning.text)")
        let event = AmbientCaptureEvent.warning(warning)
        DispatchQueue.main.async { [onEvent] in onEvent(event) }
    }

    private func clear(_ warning: AmbientCaptureWarning) {
        guard activeWarnings.remove(warning) != nil else { return }
        let event = AmbientCaptureEvent.warningCleared(warning)
        DispatchQueue.main.async { [onEvent] in onEvent(event) }
    }

    // MARK: - Stop (on the queue)

    private func finish(failure: String?) {
        guard !stopped else { return }
        stopped = true
        ioLock.withLock { io.stopped = true }
        rebuildTimer?.cancel()
        rebuildTimer = nil
        healthTimer?.cancel()
        healthTimer = nil
        removeRouteListeners()
        if let graph {
            manifest.note("Graph at stop: running \(graph.isRunning), output playing \(graph.outputIsPlaying), streams \(graph.streamLayout), rate \(graph.sampleRate).")
        }
        graph?.tearDown()
        graph = nil

        let now = Date()
        let micFrames = micWriter?.close() ?? 0
        let systemFrames = systemWriter?.close() ?? 0
        let count = ioLock.withLock { deliveries }
        manifest.note("IO deliveries \(count); mic: \(micWriter?.diagnostics ?? "-"); system: \(systemWriter?.diagnostics ?? "-")", at: now)
        if let index = manifest.parts.indices.last {
            manifest.parts[index].endedAt = now
            manifest.parts[index].micFrames = micFrames
            manifest.parts[index].systemFrames = systemFrames
        }
        manifest.endedAt = now
        if let failure {
            manifest.note("Stopped on failure: \(failure)", at: now)
        } else {
            manifest.note("Stopped.", at: now)
        }
        // Verified on disk, not from the counters: a track the reader cannot
        // open is not a track.
        let verified = manifest.parts.contains { part in
            AmbientTrackWriter.frameCount(of: directory.appendingPathComponent(part.micFile)) > 0
                || AmbientTrackWriter.frameCount(of: directory.appendingPathComponent(part.systemFile)) > 0
        }
        manifest.status = verified ? .captured : .failed
        try? AmbientCaptureStore.write(manifest, to: directory)

        let final = manifest
        DispatchQueue.main.async { [onEvent] in
            if let failure { onEvent(.stoppedOnFailure(failure)) }
            onEvent(.stopped(final))
        }
    }

    // MARK: - Preconditions

    private static func assertDiskSpace() throws {
        let root = AmbientCaptureStore.root
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        if let free = values?.volumeAvailableCapacityForImportantUsage, free < AmbientCapturePolicy.minimumFreeDiskBytes {
            let gb = Double(free) / 1_073_741_824
            throw AmbientCaptureStartFailure(description: String(format: "Only %.1f GB free on this Mac; recording needs 2 GB.", gb))
        }
    }
}
