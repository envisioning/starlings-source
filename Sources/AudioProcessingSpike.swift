#if DEBUG
import AVFoundation
import AppKit
import Foundation
import LiveKit

/// A launch-time probe for the single question the Mac noise-reduction design
/// hangs on: can this app keep its per-app microphone picker *and* reach
/// Apple's platform voice processing?
///
/// The picker only works on the Core Audio HAL module — see the module choice
/// in ``AppDelegate`` — while Apple's Voice Processing I/O unit has
/// historically only run on the AVAudioEngine module. LiveKit 2.16 added typed
/// per-effect modes (``NoiseSuppressionMode/platform``) and a resolved-state
/// readback (``AudioManager/audioProcessingState``), so the old answer may no
/// longer hold. This measures it rather than assuming it.
///
/// Four questions, answered per audio device module:
///
/// 1. Does forcing `.platform` noise suppression resolve to Apple's path?
/// 2. Does a per-app microphone choice survive capture starting?
/// 3. Is Meet eligible for the system Voice Isolation microphone mode at all?
/// 4. Do buffers reach `capturePostProcessingDelegate` — the seat a DNN filter
///    would occupy — under both modules?
///
/// Run it with `scripts/audio-spike.sh`, which launches the app once per
/// module. Nothing here ships: the file is Debug-only, and the app runs it only
/// when explicitly asked.
enum AudioProcessingSpike {
    static let defaultsSpikeKey = "MeetAudioSpike"
    static let defaultsModuleKey = "MeetAudioDeviceModule"
    static let defaultsMicrophoneKey = "MeetAudioSpikeMicrophone"

    /// Whether this launch is a spike run rather than an ordinary app launch.
    static var isRequested: Bool {
        if ProcessInfo.processInfo.environment["MEET_AUDIO_SPIKE"] == "1" { return true }
        return UserDefaults.standard.bool(forKey: defaultsSpikeKey)
    }

    /// The module this run pins. Defaults to the shipping choice, so an
    /// ordinary Debug launch behaves exactly as it does today.
    static var requestedModuleType: AudioDeviceModuleType {
        let requested = ProcessInfo.processInfo.environment["MEET_AUDIO_ADM"]
            ?? UserDefaults.standard.string(forKey: defaultsModuleKey)
        return requested == "audioEngine" ? .audioEngine : .platformDefault
    }

    static var moduleName: String {
        requestedModuleType == .audioEngine ? "audioEngine" : "platformDefault"
    }

    // MARK: - Run

    @MainActor
    static func run() async {
        // No window, no Dock bounce: the operator is watching a terminal tail,
        // not this process.
        NSApp.setActivationPolicy(.accessory)

        let report = SpikeReport(url: reportURL())
        report.heading("Starlings audio processing spike — module: \(moduleName)")
        reportEnvironment(to: report)

        guard await requestMicrophoneAccess() else {
            report.line("FAILED: no microphone permission. Grant it and re-run.")
            report.finish()
            NSApp.terminate(nil)
            return
        }

        let microphone = reportDevices(to: report)
        reportMicrophoneModes(to: report, stage: "before capture")

        for probeCase in cases {
            await measure(probeCase, microphone: microphone, report: report)
        }

        reportVerdict(to: report)
        report.finish()
        NSApp.terminate(nil)
    }

    // MARK: - Cases

    private struct ProbeCase {
        let name: String
        let options: AudioProcessingOptions
        let captureOptions: AudioCaptureOptions
    }

    private static let cases: [ProbeCase] = [
        ProbeCase(
            name: "automatic — SDK default, what Starlings ships today",
            options: AudioProcessingOptions(),
            captureOptions: AudioCaptureOptions()
        ),
        ProbeCase(
            name: "platform — Apple voice processing demanded, no fallback",
            options: AudioProcessingOptions(
                echoCancellationMode: .platform,
                autoGainControlMode: .platform,
                noiseSuppressionMode: .platform
            ),
            captureOptions: AudioCaptureOptions(
                echoCancellationMode: .platform,
                autoGainControlMode: .platform,
                noiseSuppressionMode: .platform
            )
        ),
        ProbeCase(
            name: "software — WebRTC APM forced, platform effects off",
            options: AudioProcessingOptions(
                echoCancellationMode: .software,
                autoGainControlMode: .software,
                noiseSuppressionMode: .software
            ),
            captureOptions: AudioCaptureOptions(
                echoCancellationMode: .software,
                autoGainControlMode: .software,
                noiseSuppressionMode: .software
            )
        ),
        ProbeCase(
            name: "off — original sound, every effect disabled",
            options: .noProcessing,
            captureOptions: AudioCaptureOptions(
                echoCancellation: false,
                autoGainControl: false,
                noiseSuppression: false
            )
        ),
    ]

    @MainActor
    private static func measure(
        _ probeCase: ProbeCase,
        microphone: MediaDevice?,
        report: SpikeReport
    ) async {
        report.heading("Mode: \(probeCase.name)")

        // The track-level call is the API a real implementation would use to
        // change tiers mid-meeting, so its verdict matters as much as capture's.
        let track = LocalAudioTrack.createTrack(options: probeCase.captureOptions)
        do {
            let result = try track.setAudioProcessingOptions(probeCase.options)
            report.line("setAudioProcessingOptions → \(result)")
        } catch let error as AudioProcessingOptionsError {
            report.line("setAudioProcessingOptions → REJECTED (\(error.code)): \(error.message)")
        } catch {
            report.line("setAudioProcessingOptions → THREW: \(error.localizedDescription)")
        }

        if let microphone, let device = MediaDevicePreferences.liveKitInputDevice(for: microphone.id) {
            AudioManager.shared.inputDevice = device
            report.line("requested input: \(microphone.name) [\(microphone.id)]")
        } else if let microphone {
            report.line("requested input: \(microphone.name) [\(microphone.id)] — LiveKit does not list it yet")
        }

        let probe = CapturePostProcessingProbe()
        AudioManager.shared.capturePostProcessingDelegate = probe

        do {
            try AudioManager.shared.startLocalRecording(audioProcessingOptions: probeCase.options)
        } catch {
            report.line("startLocalRecording → FAILED: \(error.localizedDescription)")
            AudioManager.shared.capturePostProcessingDelegate = nil
            return
        }

        report.line("capturing 3s — speak into the microphone you selected")
        for _ in 0 ..< 6 {
            try? await Task.sleep(for: .milliseconds(500))
            let sample = probe.snapshot()
            report.line("  \(meter(sample.peak))  frames \(sample.frameCount)")
        }

        reportProbe(probe, to: report)
        reportProcessingState(to: report)
        reportPlatformVoiceProcessing(to: report)
        reportActiveInput(requested: microphone, to: report)
        reportMicrophoneModes(to: report, stage: "during capture")

        try? AudioManager.shared.stopLocalRecording()
        AudioManager.shared.capturePostProcessingDelegate = nil
        // The module needs a beat to tear capture down before the next case
        // starts it again; without it the readbacks describe the previous run.
        try? await Task.sleep(for: .milliseconds(750))
    }

    // MARK: - Readbacks

    private static func reportEnvironment(to report: SpikeReport) {
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        report.line("macOS: \(os)")
        report.line("audio device module: \(moduleName)")
        report.line("platform voice processing allowed: \(AudioManager.shared.isPlatformVoiceProcessingAllowed)")
        report.line("advanced ducking: \(AudioManager.shared.isAdvancedDuckingEnabled)")
    }

    private static func reportDevices(to report: SpikeReport) -> MediaDevice? {
        report.heading("Input devices")

        let halDevices = AudioDeviceCatalog.inputs()
        let systemDefault = AudioDeviceCatalog.defaultInputUID()
        report.line("Core Audio HAL sees \(halDevices.count):")
        for device in halDevices {
            let marker = device.id == systemDefault ? String(localized: " (system default)") : ""
            report.line("  \(device.name) [\(device.id)]\(marker)")
        }

        let liveKitDevices = AudioManager.shared.inputDevices
        report.line("LiveKit sees \(liveKitDevices.count) before capture:")
        for device in liveKitDevices {
            report.line("  \(device.name) [\(device.deviceId)] default=\(device.isDefault)")
        }

        // A device that is *not* the system default is the only one that proves
        // per-app selection: picking the default proves nothing, since a module
        // that ignores the request lands on it anyway.
        let requestedUID = ProcessInfo.processInfo.environment["MEET_AUDIO_SPIKE_MIC"]
            ?? UserDefaults.standard.string(forKey: defaultsMicrophoneKey)
        // Three steps rather than one chained expression: the chain of
        // closures was more than the type checker would finish in time.
        var microphone = halDevices.first { $0.id == requestedUID }
        if microphone == nil { microphone = halDevices.first { $0.id != systemDefault } }
        if microphone == nil { microphone = halDevices.first }
        if let microphone {
            let note = microphone.id == systemDefault
                ? String(localized: " — WARNING: this is the system default, so selection cannot be proven")
                : ""
            report.line("spike will select: \(microphone.name)\(note)")
        } else {
            report.line("no input devices found")
        }
        return microphone
    }

    private static func reportProbe(_ probe: CapturePostProcessingProbe, to report: SpikeReport) {
        let sample = probe.snapshot()
        report.line("capturePostProcessingDelegate:")
        if sample.initialized {
            report.line("  initialized at \(sample.sampleRate) Hz, \(sample.channels) ch")
        } else {
            report.line("  never initialized — a DNN filter would receive nothing here")
        }
        report.line("  buffers \(sample.frameCount), peak \(String(format: "%.4f", sample.peak))")
    }

    private static func reportProcessingState(to report: SpikeReport) {
        let state = AudioManager.shared.audioProcessingState
        report.line("audioProcessingState (what the engine resolved):")
        line("echo cancellation", state.echoCancellation, to: report)
        line("noise suppression", state.noiseSuppression, to: report)
        line("auto gain control", state.autoGainControl, to: report)
        line("highpass filter", state.highpassFilter, to: report)
    }

    private static func line<Mode>(
        _ label: String,
        _ state: AudioProcessingComponentState<Mode>,
        to report: SpikeReport
    ) {
        let requested = state.requested.map { "\($0.isEnabled) \(String(describing: $0.mode))" } ?? String(localized: "nobody asked")
        let platform = state.platform
            .map { "resolved=\($0.isResolved) active=\($0.isActive)" } ?? "unavailable"
        report.line("  \(label): effective=\(state.effective)")
        report.line("    requested \(requested)")
        report.line("    software  resolved=\(state.software.isResolved) active=\(state.software.isActive)")
        report.line("    platform  \(platform)")
    }

    private static func reportPlatformVoiceProcessing(to report: SpikeReport) {
        let state = AudioManager.shared.platformVoiceProcessingState
        report.line("platformVoiceProcessingState (Apple VPIO, device level):")
        report.line("  topology: \(state.topology)")
        component("echo cancellation", state.echoCancellation, to: report)
        component("noise suppression", state.noiseSuppression, to: report)
        component("auto gain control", state.autoGainControl, to: report)
        flag("VPIO enabled", state.voiceProcessingEnabled, to: report)
        flag("VPIO bypassed", state.voiceProcessingBypassed, to: report)
        flag("VPIO AGC", state.voiceProcessingAGCEnabled, to: report)
    }

    private static func component(
        _ label: String,
        _ state: PlatformVoiceProcessingComponentState,
        to report: SpikeReport
    ) {
        report.line("  \(label): available=\(state.isAvailable) requested=\(state.isRequested) active=\(state.isActive)")
    }

    private static func flag(
        _ label: String,
        _ state: PlatformVoiceProcessingFlagState,
        to report: SpikeReport
    ) {
        report.line("  \(label): requested=\(state.isRequested) active=\(state.isActive)")
    }

    private static func reportActiveInput(requested: MediaDevice?, to report: SpikeReport) {
        let active = AudioManager.shared.inputDevice
        report.line("active input during capture: \(active.name) [\(active.deviceId)] default=\(active.isDefault)")
        guard let requested else { return }
        let held = active.deviceId == requested.id || active.name == requested.name
        report.line("  per-app selection held: \(held ? "YES" : String(localized: "NO — module fell back"))")
        if let systemDefault = AudioDeviceCatalog.defaultInputUID() {
            report.line("  system default is still: \(systemDefault)")
        }
    }

    private static func reportMicrophoneModes(to report: SpikeReport, stage: String) {
        report.line("microphone modes \(stage): preferred=\(name(for: AVCaptureDevice.preferredMicrophoneMode)) active=\(name(for: AVCaptureDevice.activeMicrophoneMode))")
    }

    private static func name(for mode: AVCaptureDevice.MicrophoneMode) -> String {
        switch mode {
        case .standard: "standard"
        case .wideSpectrum: "wideSpectrum"
        case .voiceIsolation: "voiceIsolation"
        @unknown default: "unknown"
        }
    }

    private static func reportVerdict(to report: SpikeReport) {
        report.heading("Read this as")
        report.line("Q1 platform noise suppression reachable on \(moduleName)?")
        report.line("    → 'platform' case: effective=Platform and VPIO enabled active=true means yes.")
        report.line("      A REJECTED (platformUnavailable) means Apple's path is out on this module.")
        report.line("Q2 does the per-app microphone choice survive capture?")
        report.line("    → 'per-app selection held' on every case, plus level moving only when")
        report.line("      you speak into the selected microphone.")
        report.line("Q3 is Starlings eligible for system Voice Isolation?")
        report.line("    → 'microphone modes during capture' reporting anything but standard,")
        report.line("      or Control Center offering Starlings a Mic Mode while this ran.")
        report.line("Q4 is the DNN seat live? (this is where Krisp would sit)")
        report.line("    → capturePostProcessingDelegate initialized, with buffers > 0.")
    }

    // MARK: - Helpers

    private static func requestMicrophoneAccess() async -> Bool {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized { return true }
        return await AVCaptureDevice.requestAccess(for: .audio)
    }

    private static func meter(_ peak: Float) -> String {
        let filled = Int((min(max(peak, 0), 1) * 30).rounded())
        return "[" + String(repeating: "#", count: filled)
            + String(repeating: ".", count: 30 - filled) + "]"
    }

    private static func reportURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["MEET_AUDIO_SPIKE_REPORT"] {
            return URL(fileURLWithPath: override)
        }
        let directory = AppFolders.logs
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("audio-spike-\(moduleName).txt")
    }
}

// MARK: - Probe

/// Occupies the seat a noise-cancellation filter would take, and reports
/// whether audio ever arrives there. Deliberately does not modify the buffer.
private final class CapturePostProcessingProbe: NSObject, AudioCustomProcessingDelegate, @unchecked Sendable {
    struct Sample {
        var initialized = false
        var sampleRate = 0
        var channels = 0
        var frameCount = 0
        var peak: Float = 0
    }

    private let lock = NSLock()
    private var sample = Sample()

    @objc var audioProcessingName: String { "meet_audio_spike_probe" }

    func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels: Int) {
        lock.withLock {
            sample.initialized = true
            sample.sampleRate = sampleRateHz
            sample.channels = channels
        }
    }

    func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
        guard audioBuffer.channels > 0, audioBuffer.framesPerBand > 0 else { return }
        let samples = audioBuffer.rawBuffer(forChannel: 0)
        var peak: Float = 0
        for index in 0 ..< audioBuffer.framesPerBand {
            peak = max(peak, abs(samples[index]))
        }
        lock.withLock {
            sample.frameCount += 1
            sample.peak = max(sample.peak, peak)
        }
    }

    func audioProcessingRelease() {}

    /// Reads the accumulated state and resets the peak, so each printed line
    /// describes the half-second it covers rather than the whole run.
    func snapshot() -> Sample {
        lock.withLock {
            let current = sample
            sample.peak = 0
            return current
        }
    }
}

// MARK: - Report

/// Writes each line to a file as it happens, so an operator can `tail -f` the
/// run and speak into a microphone while watching the level move.
/// Shared by every Debug spike (`AudioProcessingSpike`, `SystemAudioTapSpike`).
final class SpikeReport: @unchecked Sendable {
    private let handle: FileHandle?
    private let lock = NSLock()

    init(url: URL) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try? FileHandle(forWritingTo: url)
        line("report: \(url.path)")
    }

    func heading(_ text: String) {
        line("")
        line("── \(text) " + String(repeating: "─", count: max(0, 60 - text.count)))
    }

    func line(_ text: String) {
        lock.withLock {
            print(text)
            // Redirected stdout is block-buffered, and the whole point of this
            // report is that an operator can tail it while speaking.
            fflush(stdout)
            guard let data = (text + "\n").data(using: .utf8) else { return }
            try? handle?.write(contentsOf: data)
        }
    }

    func finish() {
        line("")
        line("SPIKE COMPLETE")
        lock.withLock { try? handle?.close() }
    }
}
#endif
