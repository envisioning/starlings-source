import AVFoundation
import FluidAudio
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import VisionKit

/// What the composer's + menu can produce on the device itself, beyond what
/// is already on it: a photo or video from the camera, a scanned document, a
/// voice message. Each hands back bytes the thread store can stage like any
/// other file — the composer does not care where an attachment came from.
struct ComposerCapture: Sendable {
    let name: String
    let contentType: String
    let data: Data
}

/// The system camera, for a still or a clip. Returned as JPEG or QuickTime,
/// the formats the camera writes without a second pass.
struct CameraCapture: UIViewControllerRepresentable {
    let onCapture: (ComposerCapture) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoQuality = .typeHigh
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraCapture
        init(_ parent: CameraCapture) { self.parent = parent }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.85) {
                parent.onCapture(ComposerCapture(name: "photo.jpg", contentType: "image/jpeg", data: data))
            } else if let url = info[.mediaURL] as? URL, let data = try? Data(contentsOf: url) {
                parent.onCapture(ComposerCapture(name: "video.mov", contentType: "video/quicktime", data: data))
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

/// The system document scanner. Every page goes into one PDF, which is what
/// the person on the other end expects a scan to be.
struct DocumentScan: UIViewControllerRepresentable {
    let onCapture: @MainActor @Sendable (ComposerCapture) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool { VNDocumentCameraViewController.isSupported }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let scanner = VNDocumentCameraViewController()
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    /// VisionKit's delegate is not main-actor, so the coordinator keeps the
    /// Sendable pieces it needs and hops for each callback.
    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        private let onCapture: @MainActor @Sendable (ComposerCapture) -> Void
        private let dismiss: DismissAction
        @MainActor init(_ parent: DocumentScan) { onCapture = parent.onCapture; dismiss = parent.dismiss }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            let data = Self.pdf(from: scan)
            let onCapture = self.onCapture, dismiss = self.dismiss
            Task { @MainActor in
                if !data.isEmpty {
                    onCapture(ComposerCapture(name: "scan.pdf", contentType: "application/pdf", data: data))
                }
                dismiss()
            }
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            let dismiss = self.dismiss
            Task { @MainActor in dismiss() }
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            let dismiss = self.dismiss
            Task { @MainActor in dismiss() }
        }

        /// One page per scanned image, each page the image's own size at 72 dpi
        /// scaled to letter width, so a phone scan is not a poster.
        private static func pdf(from scan: VNDocumentCameraScan) -> Data {
            guard scan.pageCount > 0 else { return Data() }
            let width: CGFloat = 612
            let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: width, height: 792))
            return renderer.pdfData { context in
                for index in 0..<scan.pageCount {
                    let image = scan.imageOfPage(at: index)
                    guard image.size.width > 0 else { continue }
                    let height = image.size.height * width / image.size.width
                    let page = CGRect(x: 0, y: 0, width: width, height: height)
                    context.beginPage(withBounds: page, pageInfo: [:])
                    image.draw(in: page)
                }
            }
        }
    }
}

/// A voice message: recorded here, transcribed here, then handed back as the
/// audio plus its words. The words become the message text, so the person or
/// agent on the other end reads it without playing it — and an agent, whose
/// hand-off carries text only, gets it at all. The same on-device Parakeet
/// engine a meeting uses; nothing leaves the phone before the person sends.
struct VoiceMemoSheet: View {
    let onCapture: (ComposerCapture, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var recorder = VoiceMemoRecorder()
    @ScaledMetric(relativeTo: .largeTitle) var elapsedSize: CGFloat = 44

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                switch recorder.phase {
                case .idle, .recording:
                    Text(recorder.elapsedText)
                        .font(.system(size: elapsedSize, weight: .light, design: .rounded).monospacedDigit())
                    Button {
                        if recorder.phase == .recording {
                            Task { await finish() }
                        } else {
                            recorder.start()
                        }
                    } label: {
                        Image(systemName: recorder.phase == .recording ? "stop.fill" : "mic.fill")
                            .font(.title)
                            .foregroundStyle(StarlingsMobileColors.accentInk)
                            .frame(width: 76, height: 76)
                            .background(Circle().fill(recorder.phase == .recording ? Color.red : StarlingsMobileColors.accent))
                    }
                    .accessibilityLabel(recorder.phase == .recording ? String(localized: "Stop") : String(localized: "Record"))
                case .transcribing:
                    GatheringDotsView(side: 64, ink: StarlingsMobileColors.secondary, motion: .thinking)
                    Text("Transcribing…").foregroundStyle(.secondary)
                }
                if let failure = recorder.failure {
                    StarlingsErrorNotice(message: failure, font: .footnote)
                }
                Spacer()
            }
            .padding(24)
            .navigationTitle("Voice message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { recorder.cancel(); dismiss() }
                }
            }
            .interactiveDismissDisabled(recorder.phase != .idle)
            // The 76pt button is the whole screen, so its state change is felt:
            // recording begins under the thumb, stopping is the firmer one.
            .meetHaptic(trigger: recorder.phase) { _, phase in
                switch phase {
                case .recording: .toggle
                case .transcribing: .destructive
                case .idle: nil
                }
            }
            .meetHaptic(.error, whenSet: recorder.failure)
        }
        .onAppear { recorder.start() }
    }

    private func finish() async {
        guard let (capture, transcript) = await recorder.stopAndTranscribe() else { return }
        onCapture(capture, transcript)
        dismiss()
    }
}

@MainActor
final class VoiceMemoRecorder: ObservableObject {
    enum Phase { case idle, recording, transcribing }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var failure: String?

    private var recorder: AVAudioRecorder?
    private var clock: Timer?
    private var fileURL: URL?

    var elapsedText: String {
        let seconds = Int(elapsed)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    func start() {
        guard phase == .idle else { return }
        failure = nil
        // Transcription needs the model; without it the message would be
        // audio nobody on the other end can read, so the gate is up front.
        guard LocalTranscriptionModel.status() == .ready else {
            failure = "Download the transcription model in Settings first."
            return
        }
        Task { [weak self] in
            let granted = await AVAudioApplication.requestRecordPermission()
            guard let self else { return }
            guard granted else { self.failure = "Microphone access is off."; return }
            self.beginRecording()
        }
    }

    private func beginRecording() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.record()
            self.recorder = recorder
            fileURL = url
            elapsed = 0
            phase = .recording
            clock = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.elapsed = self?.recorder?.currentTime ?? 0 }
            }
        } catch {
            failure = error.localizedDescription
        }
    }

    func cancel() {
        clock?.invalidate()
        recorder?.stop()
        recorder = nil
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil
        phase = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The recording, and what it said. Nil when there was nothing usable.
    func stopAndTranscribe() async -> (ComposerCapture, String)? {
        guard phase == .recording, let fileURL else { return nil }
        clock?.invalidate()
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        phase = .transcribing
        defer { phase = .idle }
        do {
            let data = try Data(contentsOf: fileURL)
            let samples = try AudioConverter().resampleAudioFile(fileURL)
            let engine = try await FluidAudioTranscriptionEngineProvider().makeEngine()
            let result = try await engine.transcribe(LocalTranscriptionRequest(
                samples: samples,
                languageHint: LocalMeetingTranscriber.languageHint(for: TranscriptionLanguages.selected)
            ))
            // No cleanup: the engine's models are the shared ones a meeting
            // warms, and releasing them here would cost the next call its start.
            try? FileManager.default.removeItem(at: fileURL)
            self.fileURL = nil
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !data.isEmpty else { return nil }
            return (ComposerCapture(name: "voice.m4a", contentType: "audio/mp4", data: data), text)
        } catch {
            failure = error.localizedDescription
            return nil
        }
    }
}
