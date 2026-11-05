@preconcurrency import AVFoundation
import CoreAudio
import Foundation
import LiveKit

enum MediaDevicePreferences {
    private static let cameraKey = "meet.preferredCameraID"
    private static let microphoneKey = "meet.preferredMicrophoneID"
    private static let speakerKey = "meet.preferredSpeakerID"

    static let didChangeNotification = Notification.Name("MeetMediaDevicePreferencesDidChange")

    static var preferredCameraID: String? {
        get {
            let value = UserDefaults.standard.string(forKey: cameraKey)
            return (value?.isEmpty == false) ? value : nil
        }
        set {
            UserDefaults.standard.set(newValue, forKey: cameraKey)
            NotificationCenter.default.post(name: didChangeNotification, object: nil)
        }
    }

    static var preferredMicrophoneID: String? {
        get {
            let value = UserDefaults.standard.string(forKey: microphoneKey)
            return (value?.isEmpty == false) ? value : nil
        }
        set {
            UserDefaults.standard.set(newValue, forKey: microphoneKey)
            NotificationCenter.default.post(name: didChangeNotification, object: nil)
        }
    }

    static var preferredSpeakerID: String? {
        get {
            let value = UserDefaults.standard.string(forKey: speakerKey)
            return (value?.isEmpty == false) ? value : nil
        }
        set {
            UserDefaults.standard.set(newValue, forKey: speakerKey)
            NotificationCenter.default.post(name: didChangeNotification, object: nil)
        }
    }

    static func resolveCameraID(from devices: [MediaDevice]) -> String? {
        resolve(preferredID: preferredCameraID, from: devices)
    }

    static func resolveMicrophoneID(from devices: [MediaDevice]) -> String? {
        if let preferredMicrophoneID, devices.contains(where: { $0.id == preferredMicrophoneID }) {
            return preferredMicrophoneID
        }
        // A stored device that is no longer plugged in should fall back to what
        // the rest of the system is using, not to whichever device sorts first.
        if let systemDefault = AudioDeviceCatalog.defaultInputUID(),
           devices.contains(where: { $0.id == systemDefault }) {
            return systemDefault
        }
        return devices.first?.id
    }

    static func resolveSpeakerID(from devices: [MediaDevice]) -> String? {
        if let preferredSpeakerID, devices.contains(where: { $0.id == preferredSpeakerID }) {
            return preferredSpeakerID
        }
        if let systemDefault = AudioDeviceCatalog.defaultOutputUID(),
           devices.contains(where: { $0.id == systemDefault }) {
            return systemDefault
        }
        return devices.first?.id
    }

    static func applyMicrophoneSelection(id: String?) {
        guard let id, let device = liveKitInputDevice(for: id) else { return }
        apply(inputDevice: device)
    }

    /// Handing LiveKit an input device restarts the whole Core Audio module —
    /// playout with it — so setting the device already in use cuts the people
    /// you are listening to off for nothing. Unmuting re-applied the microphone
    /// every time, and the restart's own device notification came straight back
    /// here to do it again: mute took the speaker down with the mic. Only touch
    /// the module when the device is genuinely changing.
    static func apply(inputDevice device: AudioDevice) {
        guard AudioManager.shared.inputDevice.deviceId != device.deviceId else { return }
        AudioManager.shared.inputDevice = device
    }

    static func applySpeakerSelection(id: String?) {
        guard let id, let device = liveKitOutputDevice(for: id) else { return }
        apply(outputDevice: device)
    }

    /// Playout is the other half of the same module, so the same rule holds:
    /// set the output only when it is changing. See ``apply(inputDevice:)``.
    static func apply(outputDevice device: AudioDevice) {
        guard AudioManager.shared.outputDevice.deviceId != device.deviceId else { return }
        AudioManager.shared.outputDevice = device
    }

    /// A real switch to `device`, made through another output when the module
    /// already reports `device`. The module can report the speaker chosen last
    /// time while it plays somewhere else, and setting the reported device
    /// again changes nothing: the room stayed silent until the person switched
    /// the speaker away and back by hand (meet, 2026-10-08 and 2026-10-20).
    /// This is that same away-and-back, for a call's first remote voice.
    static func reassert(outputDevice device: AudioDevice) {
        let manager = AudioManager.shared
        if manager.outputDevice.deviceId == device.deviceId,
           let other = manager.outputDevices.first(where: { $0.deviceId != device.deviceId }) {
            manager.outputDevice = other
        }
        manager.outputDevice = device
    }

    /// Matches a Core Audio UID against LiveKit's device module, which reports
    /// either the UID or the numeric device ID depending on the module in use.
    /// Returns nil until the module has been initialized by a live call.
    static func liveKitInputDevice(for id: String) -> AudioDevice? {
        liveKitDevice(for: id, in: AudioManager.shared.inputDevices)
    }

    static func liveKitOutputDevice(for id: String) -> AudioDevice? {
        liveKitDevice(for: id, in: AudioManager.shared.outputDevices)
    }

    private static func liveKitDevice(for id: String, in devices: [AudioDevice]) -> AudioDevice? {
        if let match = devices.first(where: { $0.deviceId == id }) {
            return match
        }
        guard let deviceID = AudioDeviceCatalog.audioDeviceID(for: id) else { return nil }
        if let match = devices.first(where: { $0.deviceId == String(deviceID) }) {
            return match
        }
        guard let name = AudioDeviceCatalog.name(for: deviceID) else { return nil }
        return devices.first { $0.name == name }
    }

    private static func resolve(preferredID: String?, from devices: [MediaDevice]) -> String? {
        if let preferredID, devices.contains(where: { $0.id == preferredID }) {
            return preferredID
        }
        return devices.first?.id
    }
}

@MainActor
final class MediaDeviceService {
    private(set) var cameras: [MediaDevice] = []
    private(set) var microphones: [MediaDevice] = []
    private(set) var speakers: [MediaDevice] = []

    /// Fired after ``cameras`` / ``microphones`` change (hot-plug, Continuity Camera, ADM refresh).
    var onDevicesChanged: (() -> Void)?

    private var cameraSession: AVCaptureDevice.DiscoverySession
    private var cameraObservation: NSKeyValueObservation?
    private var connectedObserver: (any NSObjectProtocol)?
    private var disconnectedObserver: (any NSObjectProtocol)?
    private let audioDeviceMonitor = AudioDeviceCatalogMonitor()
    private var isMonitoring = false

    var cameraPermission: PermissionState {
        PermissionState(AVCaptureDevice.authorizationStatus(for: .video))
    }

    var microphonePermission: PermissionState {
        PermissionState(AVCaptureDevice.authorizationStatus(for: .audio))
    }

    init() {
        cameraSession = Self.makeCameraSession()
        refreshDevices()
    }

    deinit {
        cameraObservation?.invalidate()
        if let connectedObserver {
            NotificationCenter.default.removeObserver(connectedObserver)
        }
        if let disconnectedObserver {
            NotificationCenter.default.removeObserver(disconnectedObserver)
        }
    }

    /// Keep menus current when hardware appears later (Continuity Camera, USB, ADM).
    func beginMonitoring() {
        guard !isMonitoring else { return }
        isMonitoring = true
        observeCameraSession()

        connectedObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureDevice.wasConnectedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.publishDevicesChanged()
            }
        }
        disconnectedObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureDevice.wasDisconnectedNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.publishDevicesChanged()
            }
        }

        audioDeviceMonitor.start { [weak self] in
            self?.publishDevicesChanged()
        }

        AudioManager.shared.onDeviceUpdate = { [weak self] _ in
            Task { @MainActor in
                self?.publishDevicesChanged()
            }
        }

        refreshDevices()
    }

    func refreshDevices() {
        var seenCameraIDs = Set<String>()
        cameras = cameraSession.devices.compactMap { device in
            guard seenCameraIDs.insert(device.uniqueID).inserted else { return nil }
            return MediaDevice(id: device.uniqueID, name: device.localizedName, kind: .camera)
        }

        // Microphones and speakers come from Core Audio rather than
        // AVCaptureDevice or LiveKit: see ``AudioDeviceCatalog``. IDs are Core
        // Audio UIDs, which ``MediaDevicePreferences/applyMicrophoneSelection(id:)``
        // and its speaker twin map back to LiveKit devices once a call has
        // initialized its device module.
        microphones = AudioDeviceCatalog.inputs()
        speakers = AudioDeviceCatalog.outputs()
    }

    func requestPermissions() async -> (camera: PermissionState, microphone: PermissionState) {
        // Device names are useful for diagnostics and CLI automation even while
        // macOS is still presenting the first-run permission sheet.
        refreshDevices()
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        }
        // Recreate the discovery session after TCC changes — a session created
        // before authorization can keep an incomplete device list on macOS.
        rebuildCameraSession()
        refreshDevices()
        return (cameraPermission, microphonePermission)
    }

    private func publishDevicesChanged() {
        refreshDevices()
        onDevicesChanged?()
    }

    private func rebuildCameraSession() {
        cameraObservation?.invalidate()
        cameraObservation = nil
        cameraSession = Self.makeCameraSession()
        if isMonitoring {
            observeCameraSession()
        }
    }

    private func observeCameraSession() {
        cameraObservation?.invalidate()
        cameraObservation = cameraSession.observe(\.devices, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                self?.publishDevicesChanged()
            }
        }
    }

    private static func makeCameraSession() -> AVCaptureDevice.DiscoverySession {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [
                .builtInWideAngleCamera,
                .continuityCamera,
                .deskViewCamera,
                .external,
            ],
            mediaType: .video,
            position: .unspecified
        )
    }
}

/// Meter mic input for Settings without joining a room.
@MainActor
final class MicrophoneLevelMonitor {
    var onLevel: ((Float) -> Void)?
    var onError: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private var isRunning = false
    private var peak: Float = 0

    var isActive: Bool { isRunning }

    func start(deviceID: String?) {
        stop()
        do {
            MediaDevicePreferences.applyMicrophoneSelection(id: deviceID)
            let input = engine.inputNode
            // Device IDs are Core Audio UIDs, not the numeric IDs AUHAL wants.
            if let deviceID, let audioDeviceID = AudioDeviceCatalog.audioDeviceID(for: deviceID) {
                try setInputDevice(audioDeviceID, on: input)
            }
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                onError?("Microphone is unavailable")
                return
            }
            // Tap runs on AVAudioEngine's realtime queue — must not inherit @MainActor.
            input.installTap(onBus: 0, bufferSize: 1_024, format: format) { @Sendable [weak self] buffer, _ in
                let level = Self.normalizedLevel(from: buffer)
                Task { @MainActor in
                    guard let self, self.isRunning else { return }
                    // Fast attack, slower decay so bars feel responsive.
                    self.peak = max(level, self.peak * 0.86)
                    self.onLevel?(self.peak)
                }
            }
            try engine.start()
            isRunning = true
            peak = 0
            onLevel?(0)
        } catch {
            stop()
            onError?(error.localizedDescription)
        }
    }

    func stop() {
        let hadTap = isRunning || engine.isRunning
        isRunning = false
        if hadTap {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        peak = 0
        onLevel?(0)
    }

    private func setInputDevice(_ deviceID: AudioDeviceID, on input: AVAudioInputNode) throws {
        guard let audioUnit = input.audioUnit else { return }
        var id = deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &id,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        guard status == noErr else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "Could not select microphone"]
            )
        }
    }

    nonisolated private static func normalizedLevel(from buffer: AVAudioPCMBuffer) -> Float {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return 0 }

        var sum: Float = 0
        if let channelData = buffer.floatChannelData {
            let samples = UnsafeBufferPointer(start: channelData[0], count: frameLength)
            for sample in samples {
                sum += sample * sample
            }
        } else if let channelData = buffer.int16ChannelData {
            let samples = UnsafeBufferPointer(start: channelData[0], count: frameLength)
            for sample in samples {
                let normalized = Float(sample) / Float(Int16.max)
                sum += normalized * normalized
            }
        } else {
            return 0
        }

        let rms = sqrt(sum / Float(frameLength))
        // Mic signal is usually quiet; boost into a usable meter range.
        let boosted = min(1, rms * 4.5)
        return boosted
    }
}
