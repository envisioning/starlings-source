import AVFoundation
import Foundation
import LiveKit

/// What is cleaning the microphone right now, read back from the two places
/// that decide it: macOS/iOS (the Mic Mode the user picked in Control Center)
/// and LiveKit (which noise-suppression implementation the engine resolved).
///
/// Meet cannot set a Mic Mode — `preferredMicrophoneMode` is read-only and
/// belongs to the user — it can only be eligible for one. Eligibility means
/// capturing through Apple's Voice Processing I/O unit, and whether LiveKit's
/// audio module reaches that unit is exactly what `platformNoiseSuppression`
/// reports. Surfaces read this so a "Voice Isolation" that does nothing can
/// be told apart from one that is on.
struct MicrophoneProcessingSnapshot: Equatable, Sendable {
    enum Mode: String, Sendable {
        case standard
        case wideSpectrum = "wide_spectrum"
        case voiceIsolation = "voice_isolation"
        case unknown
    }

    /// The Mic Mode the user chose in Control Center.
    var preferredMode: Mode
    /// The Mic Mode the audio route is applying; differs from `preferredMode`
    /// when the route cannot honour it.
    var activeMode: Mode
    /// Whether Apple's Voice Processing I/O offers noise suppression on this
    /// audio path at all. `false` is the answer the Mac's HAL module gives.
    var platformAvailable: Bool
    /// Whether the Voice Processing I/O unit is live — the eligibility gate
    /// for Mic Modes.
    var platformActive: Bool
    /// LiveKit's verdict on which noise-suppression implementation runs.
    var noiseSuppression: String
    var echoCancellation: String

    static func current() -> MicrophoneProcessingSnapshot {
        let platform = AudioManager.shared.platformVoiceProcessingState
        let processing = AudioManager.shared.audioProcessingState
        return MicrophoneProcessingSnapshot(
            preferredMode: Mode(AVCaptureDevice.preferredMicrophoneMode),
            activeMode: Mode(AVCaptureDevice.activeMicrophoneMode),
            platformAvailable: platform.noiseSuppression.isAvailable,
            platformActive: platform.voiceProcessingEnabled.isActive,
            noiseSuppression: processing.noiseSuppression.effective.description,
            echoCancellation: processing.echoCancellation.effective.description
        )
    }

    /// One line for a settings row or a menu footer.
    var summary: String {
        if activeMode == .voiceIsolation {
            return String(localized: "Voice Isolation is on")
        }
        if platformActive {
            return String(localized: "Apple voice processing — pick Voice Isolation in Mic Modes")
        }
        if preferredMode == .voiceIsolation {
            return String(localized: "Voice Isolation is chosen, but this audio path cannot apply it — noise suppression is \(noiseSuppression.lowercased())")
        }
        return String(localized: "Noise suppression: \(noiseSuppression.lowercased())")
    }

    /// Debug-report lines. `snake_case` keys, one fact per line, like the rest
    /// of the report.
    var reportLines: [String] {
        [
            "mic_mode: preferred=\(preferredMode.rawValue) active=\(activeMode.rawValue)",
            "platform_voice_processing: available=\(platformAvailable) active=\(platformActive)",
            "noise_suppression: \(noiseSuppression)",
            "echo_cancellation: \(echoCancellation)",
        ]
    }
}

extension MicrophoneProcessingSnapshot.Mode {
    init(_ mode: AVCaptureDevice.MicrophoneMode) {
        switch mode {
        case .standard: self = .standard
        case .wideSpectrum: self = .wideSpectrum
        case .voiceIsolation: self = .voiceIsolation
        @unknown default: self = .unknown
        }
    }
}

enum MicrophoneModes {
    /// Opens the system Mic Modes picker. Non-blocking; the user's choice
    /// arrives through `AVCaptureDevice.preferredMicrophoneMode`.
    static func showSystemPicker() {
        AVCaptureDevice.showSystemUserInterface(.microphoneModes)
    }
}
