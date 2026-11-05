import AVFoundation
import Foundation
import LiveKit
import os
#if os(macOS)
import CoreAudio
#endif

/// Spatial audio: each remote voice plays from where that person's tile sits
/// on the stage. Shared between the Mac and iOS clients so a voice
/// on the left of the grid is on the left of the headphones on both.
///
/// LiveKit keeps decoding and mixing every remote track through its own
/// device module. This stage taps each microphone track with an
/// `AudioRenderer` — the same tap the transcriber uses — mutes that track in
/// LiveKit's flat mix (`RemoteAudioTrack.volume = 0`; WebRTC hands the tap its
/// samples before it applies the gain), and plays the tapped audio through an
/// `AVAudioEnvironmentNode`, one mono source per track, placed on an arc in
/// front of the listener. Screen-share audio is left in LiveKit's mix: a
/// desktop has no face to sit under.
enum SpatialAudioPreferences {
    /// Also the `@AppStorage` key on the phone. Never change it.
    static let key = "meet.audio.spatial"
    /// Off for everyone until they turn it on. The key is written only when
    /// someone flips the switch, so a stored `true` is their own choice.
    static let defaultValue = false

    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) as? Bool ?? defaultValue
    }

    static func setEnabled(_ value: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: key)
    }
}

/// Where a tile sits on the stage, as the listener sees it: `x` runs -1 (left
/// edge) to 1 (right edge), `y` runs -1 (bottom) to 1 (top). The stage's own
/// coordinate system is the caller's problem; the arc is not.
struct SpatialAudioPosition: Equatable, Sendable {
    var x: Float
    var y: Float

    /// Centre of a tile in a stage whose origin is top-left (SwiftUI, web).
    init(center: CGPoint, in size: CGSize) {
        self.init(
            x: Float(center.x / max(size.width, 1)) * 2 - 1,
            y: 1 - Float(center.y / max(size.height, 1)) * 2
        )
    }

    /// Centre of a tile in a stage whose origin is bottom-left (AppKit).
    init(flippedCenter center: CGPoint, in size: CGSize) {
        self.init(
            x: Float(center.x / max(size.width, 1)) * 2 - 1,
            y: Float(center.y / max(size.height, 1)) * 2 - 1
        )
    }

    init(x: Float, y: Float) {
        self.x = min(max(x, -1), 1)
        self.y = min(max(y, -1), 1)
    }

    /// The arc: ±60° of azimuth across the stage width, a little elevation
    /// across its height, everyone at the same distance so nobody is quieter
    /// for sitting in a corner. The web's `spatial-audio.ts` places the same
    /// arc in Web Audio.
    var point: AVAudio3DPoint {
        let azimuth = x * (Float.pi / 3)
        let radius: Float = 1.5
        return AVAudio3DPoint(
            x: sin(azimuth) * radius,
            y: y * 0.4,
            z: -cos(azimuth) * radius
        )
    }
}

/// The engine and the arc. Owned by the meeting session; one per call.
@MainActor
final class SpatialAudioStage {
    private let engine = AVAudioEngine()
    private let environment = AVAudioEnvironmentNode()
    private var sources: [String: SpatialAudioSource] = [:]
    private var positions: [String: SpatialAudioPosition] = [:]
    private var enabled = false
    /// Runs while any source is still on its way to where its tile went.
    private var glideTask: Task<Void, Never>?
    #if os(macOS)
    private var outputDeviceID: AudioDeviceID?
    #endif
    // Removed in deinit, which is nonisolated; the array is only ever
    // written in init.
    nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
    /// The engine could not run and the arc has been handed back to LiveKit's
    /// flat mix. The session turns this into a notice: a stage that fails
    /// quietly is every voice muted, because each track is at volume 0 in
    /// LiveKit and nowhere else.
    var onFailure: ((String) -> Void)?

    init() {
        engine.attach(environment)
        environment.listenerPosition = AVAudio3DPoint(x: 0, y: 0, z: 0)
        environment.listenerVectorOrientation = AVAudio3DVectorOrientation(
            forward: AVAudio3DVector(x: 0, y: 0, z: -1),
            up: AVAudio3DVector(x: 0, y: 1, z: 0)
        )
        // Everyone sits at the reference distance, so this only has to be
        // flat: a voice does not fade for being at the edge of the grid.
        environment.distanceAttenuationParameters.referenceDistance = 1.5
        environment.distanceAttenuationParameters.maximumDistance = 100
        environment.distanceAttenuationParameters.rolloffFactor = 0
        environment.reverbParameters.enable = false

        // A device change under the engine — headphones in, the Yeti
        // re-enumerating, the default output moving — stops an AVAudioEngine
        // and leaves it stopped. Every track is still at volume 0 in LiveKit,
        // so a stopped engine is a silent call until something restarts it.
        // This is that something.
        observers.append(NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.restartAfterInterruption(reason: "audio configuration changed") }
        })
        #if os(iOS)
        // A phone call or Siri interrupts the session; when it ends the
        // engine is stopped just the same.
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            MainActor.assumeIsolated { self?.restartAfterInterruption(reason: "audio session interruption ended") }
        })
        #endif
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    private func restartAfterInterruption(reason: String) {
        guard enabled else { return }
        NSLog("Meet spatial audio: %@; restarting the engine", reason)
        engine.stop()
        startEngine()
    }

    /// The engine will not run. Hand every voice back to LiveKit's mix at
    /// unity — audible and flat beats placed and silent — and say so.
    private func fallBack(_ detail: String) {
        for source in sources.values {
            source.track.volume = 1
            disconnect(source)
        }
        engine.stop()
        enabled = false
        NSLog("Meet spatial audio fell back to LiveKit's mix: %@", detail)
        onFailure?(detail)
    }

    /// Off tears the arc down and hands every track back to LiveKit's mix at
    /// unity; on takes the tracks already attached and mutes them there.
    func setEnabled(_ next: Bool) {
        guard next != enabled else { return }
        enabled = next
        if next {
            startEngine()
            // A start that fell back has already put every track at unity;
            // muting them now would be the silent call this guards against.
            guard enabled else { return }
            for source in sources.values {
                connect(source)
                source.track.volume = 0
            }
            applyPositions()
        } else {
            glideTask?.cancel()
            glideTask = nil
            for source in sources.values {
                source.track.volume = 1
                disconnect(source)
            }
            engine.stop()
        }
    }

    #if os(macOS)
    /// The same output LiveKit plays through, or the arc comes out of one
    /// device and the rest of the room out of another.
    func setOutputDevice(_ deviceID: AudioDeviceID?) {
        guard deviceID != outputDeviceID else { return }
        outputDeviceID = deviceID
        guard enabled else { return }
        engine.stop()
        startEngine()
    }
    #endif

    /// A microphone track arrived. `person` is the account address the stage
    /// keys tiles by, so a second device of the same person sits on that
    /// person's one tile.
    func attach(track: RemoteAudioTrack, sid: String, person: String) {
        guard sources[sid] == nil else { return }
        let source = SpatialAudioSource(track: track, person: person)
        sources[sid] = source
        guard enabled else { return }
        connect(source)
        track.volume = 0
        applyPositions()
    }

    func detach(sid: String) {
        guard let source = sources.removeValue(forKey: sid) else { return }
        source.track.volume = 1
        disconnect(source)
    }

    func detachAll() {
        for sid in Array(sources.keys) { detach(sid: sid) }
        engine.stop()
        enabled = false
    }

    /// The stage's answer to "where is everyone", keyed by account address.
    /// A person with no tile — mid-layout, or camera tile collapsed into a
    /// second device's — stays where they last were, or dead centre.
    func setPositions(_ next: [String: SpatialAudioPosition]) {
        guard next != positions else { return }
        positions = next
        applyPositions()
    }

    /// A tile that reflows slides the voice rather than jumping it, the way
    /// the web's `setTargetAtTime` does. `AVAudioMixing.position` has no
    /// automation of its own, so this steps it: every 20 ms each source
    /// closes a third of the gap to its target, which is a 50 ms time
    /// constant, and the task ends once everyone has arrived.
    private func applyPositions() {
        guard enabled else { return }
        for source in sources.values {
            source.target = (positions[source.person] ?? SpatialAudioPosition(x: 0, y: 0)).point
            if !source.hasPosition {
                // First placement is immediate: nothing to glide from.
                source.node.position = source.target
                source.hasPosition = true
            }
        }
        guard glideTask == nil else { return }
        glideTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(20))
                guard let self, self.enabled else { break }
                var moving = false
                for source in self.sources.values {
                    let at = source.node.position
                    let to = source.target
                    let gap = (to.x - at.x, to.y - at.y, to.z - at.z)
                    if abs(gap.0) < 0.005, abs(gap.1) < 0.005, abs(gap.2) < 0.005 {
                        if at.x != to.x || at.y != to.y || at.z != to.z { source.node.position = to }
                        continue
                    }
                    moving = true
                    source.node.position = AVAudio3DPoint(
                        x: at.x + gap.0 / 3,
                        y: at.y + gap.1 / 3,
                        z: at.z + gap.2 / 3
                    )
                }
                if !moving { break }
            }
            self?.glideTask = nil
        }
    }

    private func connect(_ source: SpatialAudioSource) {
        guard !source.isConnected else { return }
        engine.attach(source.node)
        engine.connect(source.node, to: environment, format: SpatialAudioSource.format)
        source.node.renderingAlgorithm = .auto
        source.node.reverbBlend = 0
        source.isConnected = true
        source.track.add(audioRenderer: source)
    }

    private func disconnect(_ source: SpatialAudioSource) {
        guard source.isConnected else { return }
        source.track.remove(audioRenderer: source)
        engine.disconnectNodeOutput(source.node)
        engine.detach(source.node)
        source.isConnected = false
        source.hasPosition = false
        source.ring.clear()
    }

    private func startEngine() {
        // The environment node renders stereo whatever the output's own
        // channel count; a mono route just folds it back down.
        let stereo = AVAudioFormat(standardFormatWithSampleRate: SpatialAudioSource.sampleRate, channels: 2)
        engine.connect(environment, to: engine.mainMixerNode, format: stereo)
        #if os(macOS)
        if let unit = engine.outputNode.audioUnit {
            if let outputDeviceID {
                var deviceID = outputDeviceID
                _ = AudioUnitSetProperty(
                    unit,
                    kAudioOutputUnitProperty_CurrentDevice,
                    kAudioUnitScope_Global,
                    0,
                    &deviceID,
                    UInt32(MemoryLayout<AudioDeviceID>.size)
                )
            }
            // 128 frames at 48 kHz is 2.7 ms per pull. The default is 512
            // (10.7 ms), which alone is most of the budget the whole feature
            // has. The HAL rounds to what the device supports.
            var frames: UInt32 = 128
            _ = AudioUnitSetProperty(
                unit,
                kAudioDevicePropertyBufferFrameSize,
                kAudioUnitScope_Global,
                0,
                &frames,
                UInt32(MemoryLayout<UInt32>.size)
            )
        }
        #endif
        engine.prepare()
        do {
            try engine.start()
        } catch {
            fallBack("engine did not start: \(error.localizedDescription)")
            return
        }
        #if os(macOS)
        // Which device the arc actually landed on, beside the one asked for:
        // the two differing is voices on the monitor and the share on the
        // headset, and the log is the only place that shows.
        if let unit = engine.outputNode.audioUnit {
            var actual = AudioDeviceID(kAudioObjectUnknown)
            var size = UInt32(MemoryLayout<AudioDeviceID>.size)
            _ = AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &actual, &size)
            let wanted = outputDeviceID.flatMap(AudioDeviceCatalog.name(for:)) ?? "system default"
            let playing = AudioDeviceCatalog.name(for: actual) ?? "device \(actual)"
            NSLog("Meet spatial audio engine running on %@ (asked for %@)", playing, wanted)
        }
        #endif
    }
}

/// One remote microphone on the arc: LiveKit's tap fills a ring, the source
/// node's render block drains it. The tap and the render block are on two
/// different real-time-ish threads, so the ring is the only thing they share.
private final class SpatialAudioSource: AudioRenderer, @unchecked Sendable {
    static let sampleRate: Double = 48_000
    static let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!

    let track: RemoteAudioTrack
    let person: String
    let ring = SpatialAudioRing(capacity: Int(sampleRate / 2))
    var isConnected = false
    /// Where the stage wants this voice; `node.position` catches up to it.
    var target = AVAudio3DPoint(x: 0, y: 0, z: -1.5)
    var hasPosition = false
    private(set) var node: AVAudioSourceNode!

    init(track: RemoteAudioTrack, person: String) {
        self.track = track
        self.person = person
        let ring = self.ring
        node = AVAudioSourceNode(format: Self.format) { isSilence, _, frameCount, audioBufferList in
            let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
            guard let out = buffers.first?.mData?.assumingMemoryBound(to: Float.self) else { return noErr }
            let filled = ring.read(into: out, count: Int(frameCount))
            if filled == 0 { isSilence.pointee = true }
            return noErr
        }
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        guard let samples = MeetingAudioRenderer.copyMonoSamples(from: pcmBuffer), !samples.isEmpty else { return }
        let rate = pcmBuffer.format.sampleRate
        if rate == Self.sampleRate || rate <= 0 {
            ring.write(samples)
        } else {
            ring.write(Self.resample(samples, from: rate, to: Self.sampleRate))
        }
    }

    /// Opus decodes at 48 kHz on every path LiveKit takes here, so this is a
    /// guard, not a feature: linear interpolation is enough for a voice that
    /// arrived at another rate.
    private static func resample(_ samples: [Float], from source: Double, to target: Double) -> [Float] {
        let ratio = source / target
        let count = Int(Double(samples.count) / ratio)
        var out = [Float](repeating: 0, count: count)
        for index in 0..<count {
            let position = Double(index) * ratio
            let left = Int(position)
            let right = min(left + 1, samples.count - 1)
            let fraction = Float(position - Double(left))
            out[index] = samples[left] * (1 - fraction) + samples[right] * fraction
        }
        return out
    }
}

/// Single-producer, single-consumer ring under one lock. The critical
/// sections are a memcpy of ten milliseconds of audio, which is well inside
/// what the render thread can afford; what it cannot afford is allocation, so
/// the storage is fixed at construction.
///
/// Latency is the point of the whole feature, so the ring is also the jitter
/// buffer, and a thin one: it waits for one WebRTC frame (`primeFrames`,
/// 5 ms) before it plays, and if the tap ever gets ahead by more than
/// `maxFrames` (40 ms) it drops the oldest audio rather than let the delay
/// grow. A late packet is a few milliseconds of silence inside the render
/// pull, not a reprime: the ring only re-arms when it has run completely
/// empty. WebRTC's own jitter buffer has already smoothed the network before
/// the tap, so this one does not need to do that work twice.
final class SpatialAudioRing: @unchecked Sendable {
    private var storage: [Float]
    private var readIndex = 0
    private var writeIndex = 0
    private var available = 0
    private var primed = false
    private let lock = OSAllocatedUnfairLock()
    private let primeFrames = 240
    private let maxFrames = 1_920

    init(capacity: Int) {
        storage = [Float](repeating: 0, count: max(capacity, 9_600))
    }

    func write(_ samples: [Float]) {
        lock.withLock {
            let capacity = storage.count
            if available + samples.count > maxFrames {
                // Ahead of the render thread: skip forward and stay live.
                let drop = available + samples.count - maxFrames
                readIndex = (readIndex + drop) % capacity
                available -= drop
            }
            for sample in samples {
                storage[writeIndex] = sample
                writeIndex = (writeIndex + 1) % capacity
            }
            available += samples.count
            if available >= primeFrames { primed = true }
        }
    }

    /// Frames written into `out`; the rest of `count` is zeroed. Zero means
    /// silence, which the render block reports so the mixer can skip it.
    func read(into out: UnsafeMutablePointer<Float>, count: Int) -> Int {
        // Explicit lock/unlock: `withLock` is `@Sendable`, and a raw pointer
        // is not something Swift lets a `@Sendable` closure capture.
        lock.lock()
        defer { lock.unlock() }
        guard primed, available > 0 else {
            out.update(repeating: 0, count: count)
            return 0
        }
        let capacity = storage.count
        let take = min(count, available)
        for index in 0..<take {
            out[index] = storage[readIndex]
            readIndex = (readIndex + 1) % capacity
        }
        if take < count {
            out.advanced(by: take).update(repeating: 0, count: count - take)
        }
        available -= take
        // Completely dry: re-arm on the next frame. A partial pull stays
        // primed, so one late packet costs a few zero samples, not a gap.
        if available == 0 { primed = false }
        return take
    }

    func clear() {
        lock.withLock {
            readIndex = 0
            writeIndex = 0
            available = 0
            primed = false
        }
    }
}
