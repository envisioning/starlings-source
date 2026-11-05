@preconcurrency import AVFoundation
import AppKit
import LiveKit

@MainActor
final class CameraPreviewView: NSView {
    private let videoView = VideoView()
    private let emptyLabel = NSTextField(labelWithString: String(localized: "Camera preview"))

    private var track: LocalVideoTrack?
    private var backgroundProcessor: (any LiveKit.VideoProcessor)?
    private var backgroundEffect: MeetingBackgroundEffect = .none
    private var transitionTask: Task<Void, Never>?
    private var transitionGeneration = 0

    var mirrorsPreview: Bool = true {
        didSet {
            videoView.mirrorMode = mirrorsPreview ? .mirror : .auto
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 18
        layer?.masksToBounds = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor

        videoView.layoutMode = .fill
        videoView.mirrorMode = .mirror
        // LiveKit's Metal renderer can block the AppKit main queue while
        // CAMetalLayer is waiting for a drawable (notably during camera
        // teardown/toggles). The sample-buffer renderer stays entirely on the
        // supported AVFoundation display path and keeps both UI and CLI alive.
        videoView.renderMode = .sampleBuffer
        addSubview(videoView)
        videoView.translatesAutoresizingMaskIntoConstraints = false
        videoView.pinToEdges(of: self)

        emptyLabel.textColor = StarlingsColors.secondaryText
        emptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .medium)
        addSubview(emptyLabel)
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            emptyLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(deviceID: String?) {
        transitionGeneration += 1
        let generation = transitionGeneration
        let priorTask = transitionTask

        emptyLabel.stringValue = deviceID == nil ? String(localized: "Camera is off") : String(localized: "Starting camera…")
        emptyLabel.isHidden = false

        // Never cancel an in-flight start/stop: RTCCameraVideoCapturer asserts if
        // it is deallocated while the capture session is still running. Chain
        // transitions and drop stale results via generation instead.
        transitionTask = Task { [weak self] in
            await priorTask?.value
            await self?.apply(deviceID: deviceID, generation: generation)
        }
    }

    func setBackgroundEffect(_ effect: MeetingBackgroundEffect) {
        backgroundEffect = effect
        applyBackgroundEffectToTrack()
    }

    private func applyBackgroundEffectToTrack() {
        guard let track else {
            backgroundProcessor = nil
            return
        }
        let processor = backgroundEffect.makeProcessor()
        track.processor = processor
        backgroundProcessor = processor
    }

    func stop() {
        Task { await stopAndWait() }
    }

    func stopAndWait() async {
        transitionGeneration += 1
        let generation = transitionGeneration
        let priorTask = transitionTask
        transitionTask = Task { [weak self] in
            await priorTask?.value
            await self?.apply(deviceID: nil, generation: generation)
        }
        await transitionTask?.value
    }

    private func apply(deviceID: String?, generation: Int) async {
        guard transitionGeneration == generation else { return }

        let previous = track
        track = nil
        backgroundProcessor = nil
        videoView.track = nil

        if let previous {
            try? await previous.stop()
        }

        guard transitionGeneration == generation else { return }

        guard let deviceID else {
            emptyLabel.stringValue = String(localized: "Camera is off")
            emptyLabel.isHidden = false
            return
        }

        guard let device = AVCaptureDevice(uniqueID: deviceID) else {
            emptyLabel.stringValue = String(localized: "Camera unavailable")
            emptyLabel.isHidden = false
            return
        }

        let options = CameraCaptureOptions(
            device: device,
            dimensions: .h720_169,
            fps: 30
        )
        let nextTrack = LocalVideoTrack.createCameraTrack(options: options)

        do {
            try await nextTrack.start()
        } catch {
            try? await nextTrack.stop()
            guard transitionGeneration == generation else { return }
            emptyLabel.stringValue = String(localized: "Camera unavailable")
            emptyLabel.isHidden = false
            return
        }

        if transitionGeneration != generation {
            try? await nextTrack.stop()
            return
        }

        track = nextTrack
        applyBackgroundEffectToTrack()
        videoView.track = nextTrack
        emptyLabel.isHidden = true
    }
}
