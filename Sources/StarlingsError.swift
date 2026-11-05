import Foundation
import StarlingsContracts
import LiveKit

/// One typed failure, carried from where it is raised to where it is shown.
///
/// The rule this type exists to enforce: no vendor or HTTP string reaches a
/// person. `diagnostic` keeps the raw text for logs and Copy; everything
/// else is written for whoever is trying to get into a meeting.
/// Codes are catalogued in `docs/ERRORS.md`.
struct StarlingsError: Error, Equatable, Sendable {
    /// What the user can do about it — drives the alert's non-dismiss button.
    enum Recovery: Equatable, Sendable {
        case none
        case retry
        case rejoin
        case signIn
        /// This build is too old for the route (`client_update_required`).
        case update
        case openCameraSettings
        case openMicrophoneSettings
        case openScreenRecordingSettings

        var buttonTitle: String? {
            switch self {
            case .none: nil
            case .retry: String(localized: "Try again")
            case .rejoin: String(localized: "Rejoin")
            case .signIn: String(localized: "Sign in again")
            case .update: String(localized: "Update")
            case .openCameraSettings, .openMicrophoneSettings, .openScreenRecordingSettings: String(localized: "Open Settings")
            }
        }
    }

    /// How loudly to say it. Only `.blocking` is allowed to take over the screen.
    enum Severity: Equatable, Sendable {
        /// Stops what the user asked for and needs a decision — modal.
        case blocking
        /// Worth saying where it happened, never modal.
        case notice
        /// Log only: nothing the user asked for failed and they cannot act.
        case silent
    }

    /// Stable, greppable, never localized.
    let code: String
    let title: String
    var message: String
    var recovery: Recovery = .none
    var severity: Severity = .blocking
    /// Underlying vendor or HTTP text. Diagnostics only — never the whole UI.
    var diagnostic: String = ""
    /// The Worker's stable code, when it answered with one. Match on this.
    var serverCode: String? = nil
    /// The Worker's request id, for matching a report to its `request.failed` log.
    var requestID: String? = nil
    /// The HTTP status, when the Worker answered at all. Nil for a failure
    /// that never got an answer, or one raised on this device.
    var status: Int? = nil

    /// What Console gets. One line, code first, so a support report can be grepped.
    var logLine: String {
        diagnostic.isEmpty ? code : "\(code) — \(diagnostic)"
    }

    /// The Worker refused the owner JWT on the request. Matched on the code
    /// alone, never the prose.
    var isOwnerSessionRejection: Bool { serverCode == ControlErrorCodeValue.ownerAuthRequired.rawValue }

    /// The Worker refused a refresh token outright (expired, spent, revoked or
    /// off-domain), as opposed to being unreachable. Only this is a reason to
    /// sign somebody out; everything else is "try again later".
    var isSessionRefusal: Bool { status == 401 || status == 403 }
}

/// `localizedDescription` is the sentence, on both clients. The phone has
/// always shown an error's `localizedDescription`; before the Mac
/// type had none, and a site that showed it read "The operation couldn’t be
/// completed".
extension StarlingsError: LocalizedError {
    var errorDescription: String? { message }
}

// MARK: - Failures raised on this device

extension StarlingsError {
    /// A failure this device raised itself, in one sentence: a form that
    /// cannot be sent, an answer that cannot be read, a step that needs
    /// something first. The phone's `MobileMeetError(message:)` before.
    static func local(_ message: String, diagnostic: String = "") -> StarlingsError {
        StarlingsError(code: "local.failed", title: "", message: message, diagnostic: diagnostic)
    }
}

// MARK: - LiveKit

extension StarlingsError {
    /// Where a LiveKit failure happened.
    ///
    /// The same `LiveKitError` means different things at different stages —
    /// `.timedOut` while connecting is a server we cannot reach; while starting
    /// the camera it is a capture device that never delivered a frame. Callers
    /// pass the stage precisely so those stop sharing one message.
    enum Stage: Equatable, Sendable {
        case connect
        case camera
        case microphone
        case chat
        case screenShare
        case backgroundEffect
        case session
        case deviceSwap
    }

    static func liveKit(_ error: Error, stage: Stage, elapsed: TimeInterval? = nil) -> StarlingsError {
        if let already = error as? StarlingsError { return already }

        var diagnostic = error.localizedDescription
        if let elapsed {
            diagnostic += String(format: " [after %.1fs]", elapsed)
        }

        guard let live = error as? LiveKitError else {
            return StarlingsError(
                code: "\(stagePrefix(stage)).unknown",
                title: stageTitle(stage),
                message: String(localized: "Something went wrong that Starlings doesn’t recognize."),
                recovery: .retry,
                severity: stage == .screenShare ? .notice : .blocking,
                diagnostic: diagnostic
            )
        }

        switch live.type {
        case .timedOut:
            return timeout(stage: stage, diagnostic: diagnostic)

        case .network:
            return StarlingsError(
                code: "connect.network",
                title: String(localized: "No connection"),
                message: String(localized: "This Mac can’t reach the network. Check your Wi-Fi or Ethernet and try again."),
                recovery: .retry,
                diagnostic: diagnostic
            )

        case .serverPingTimedOut:
            return StarlingsError(
                code: "connect.ping_timeout",
                title: stage == .session ? String(localized: "Disconnected") : String(localized: "Lost the meeting server"),
                message: String(localized: "The meeting server stopped responding."),
                recovery: stage == .session ? .rejoin : .retry,
                diagnostic: diagnostic
            )

        case .webRTC:
            return StarlingsError(
                code: "connect.webrtc",
                title: String(localized: "Couldn’t set up video"),
                message: String(localized: "This Mac couldn’t build the video connection. Trying again usually clears it."),
                recovery: .retry,
                diagnostic: diagnostic
            )

        case .failedToParseUrl:
            return StarlingsError(
                code: "connect.bad_url",
                title: String(localized: "This build is misconfigured"),
                message: String(localized: "The meeting server address is invalid. Contact the Starlings team."),
                diagnostic: diagnostic
            )

        case .insufficientPermissions:
            if stage == .screenShare {
                return StarlingsError(
                    code: "media.screenshare_not_allowed",
                    title: String(localized: "Screen sharing isn’t available"),
                    message: String(localized: "This meeting did not allow this Mac to publish a screen share."),
                    severity: .notice,
                    diagnostic: diagnostic
                )
            }
            return StarlingsError(
                code: "connect.token_rejected",
                title: String(localized: "Access is no longer valid"),
                message: String(localized: "Your access to this room has expired or was revoked. Sign in again to continue."),
                recovery: .signIn,
                diagnostic: diagnostic
            )

        case .joinFailure, .stateMismatch:
            return StarlingsError(
                code: "connect.join_failure",
                title: String(localized: "The meeting server refused the connection"),
                message: String(localized: "The server wouldn’t let this Mac into the room. Trying again usually clears it."),
                recovery: .retry,
                diagnostic: diagnostic
            )

        case .duplicateIdentity:
            return StarlingsError(
                code: "connect.duplicate_identity",
                title: String(localized: "You’re already in this meeting"),
                message: String(localized: "This account is connected from another window or device. Leave that one, then rejoin here."),
                recovery: .retry,
                diagnostic: diagnostic
            )

        case .participantRemoved:
            return StarlingsError(
                code: "session.removed",
                title: String(localized: "Removed from the meeting"),
                message: String(localized: "The host removed you from this meeting."),
                diagnostic: diagnostic
            )

        case .roomDeleted:
            return StarlingsError(
                code: "session.room_closed",
                title: String(localized: "Meeting ended"),
                message: String(localized: "The host ended this meeting."),
                severity: .notice,
                diagnostic: diagnostic
            )

        case .serverShutdown:
            return StarlingsError(
                code: "session.server_shutdown",
                title: String(localized: "Disconnected"),
                message: String(localized: "The meeting server restarted. Rejoining should get you back in."),
                recovery: .rejoin,
                diagnostic: diagnostic
            )

        case .deviceAccessDenied:
            return deviceAccessDenied(stage: stage, diagnostic: diagnostic)

        case .deviceNotFound:
            return stage == .microphone
                ? .microphoneMissing(diagnostic: diagnostic)
                : .cameraMissing(diagnostic: diagnostic)

        case .captureFormatNotFound, .unableToResolveFPSRange, .capturerDimensionsNotResolved:
            return StarlingsError(
                code: "media.capture_format",
                title: String(localized: "Your camera didn’t start"),
                message: String(localized: "This camera format is unsupported. Choose another camera or join without video."),
                diagnostic: diagnostic
            )

        case .codecNotSupported:
            return StarlingsError(
                code: "media.codec_unsupported",
                title: String(localized: "Can’t send video from this Mac"),
                message: String(localized: "This Mac can’t encode video for this meeting. You can still join with audio."),
                diagnostic: diagnostic
            )

        case .audioEngine, .audioSession, .soundPlayer:
            return StarlingsError(
                code: "media.audio_engine",
                title: String(localized: "Audio didn’t start"),
                message: String(localized: "macOS couldn’t access audio. Close apps using the mic and try again."),
                recovery: .retry,
                diagnostic: diagnostic
            )

        case .encryptionFailed, .decryptionFailed:
            return StarlingsError(
                code: "media.encryption",
                title: String(localized: "Secure connection failed"),
                message: String(localized: "Media security failed, so Starlings stopped."),
                diagnostic: diagnostic
            )

        case .cancelled:
            return StarlingsError(
                code: "\(stagePrefix(stage)).cancelled",
                title: String(localized: "Cancelled"),
                message: String(localized: "That was cancelled before it finished."),
                severity: .silent,
                diagnostic: diagnostic
            )

        default:
            return StarlingsError(
                code: "\(stagePrefix(stage)).unknown",
                title: stageTitle(stage),
                message: String(localized: "Something went wrong that Starlings doesn’t recognize."),
                recovery: .retry,
                diagnostic: diagnostic
            )
        }
    }

    /// `.timedOut` carries no label out of the SDK's completers, so the stage is
    /// the only thing that says which wait expired. Within `.connect` the join
    /// and transport waits stay merged on purpose — the elapsed time in
    /// `diagnostic` separates them in logs without guessing at SDK constants.
    private static func timeout(stage: Stage, diagnostic: String) -> StarlingsError {
        switch stage {
        case .connect:
            StarlingsError(
                code: "connect.timeout",
                title: String(localized: "Can’t reach the meeting server"),
                message: String(localized: "The meeting connection failed. The server may be down or this network may block video."),
                recovery: .retry,
                diagnostic: diagnostic
            )
        case .camera, .deviceSwap:
            StarlingsError(
                code: "media.camera_start_timeout",
                title: String(localized: "Your camera didn’t start"),
                message: String(localized: "No picture from the camera. Close other apps using it or choose another camera."),
                diagnostic: diagnostic
            )
        case .microphone:
            StarlingsError(
                code: "media.mic_start_timeout",
                title: String(localized: "Your microphone didn’t start"),
                message: String(localized: "The microphone never opened. Another app may be using it."),
                diagnostic: diagnostic
            )
        case .chat:
            // Chat and captions ride the data channel. Losing them is not a
            // reason to keep someone out of a meeting that otherwise works.
            StarlingsError(
                code: "media.datachannel_timeout",
                title: String(localized: "Chat is unavailable"),
                message: String(localized: "Chat and captions couldn’t start for this meeting. Everything else works."),
                severity: .notice,
                diagnostic: diagnostic
            )
        case .screenShare:
            StarlingsError(
                code: "media.screenshare_timeout",
                title: String(localized: "Screen sharing didn’t start"),
                message: String(localized: "macOS didn’t hand over the screen in time. Try sharing again."),
                recovery: .retry,
                severity: .notice,
                diagnostic: diagnostic
            )
        case .backgroundEffect:
            StarlingsError(
                code: "media.background_timeout",
                title: String(localized: "Background effect didn’t start"),
                message: String(localized: "The effect couldn’t be applied, so your camera is showing the real background."),
                severity: .notice,
                diagnostic: diagnostic
            )
        case .session:
            StarlingsError(
                code: "session.dropped",
                title: String(localized: "Disconnected"),
                message: String(localized: "The connection to the meeting was lost."),
                recovery: .rejoin,
                diagnostic: diagnostic
            )
        }
    }

    private static func deviceAccessDenied(stage: Stage, diagnostic: String) -> StarlingsError {
        stage == .microphone
            ? StarlingsError(
                code: "media.mic_denied",
                title: String(localized: "Starlings doesn’t have microphone access"),
                message: String(localized: "Allow Starlings to use the microphone in System Settings, then try again."),
                recovery: .openMicrophoneSettings,
                diagnostic: diagnostic
            )
            : StarlingsError(
                code: "media.camera_denied",
                title: String(localized: "Starlings doesn’t have camera access"),
                message: String(localized: "Allow Starlings to use the camera in System Settings, then try again."),
                recovery: .openCameraSettings,
                diagnostic: diagnostic
            )
    }

    private static func stagePrefix(_ stage: Stage) -> String {
        switch stage {
        case .connect: "connect"
        case .camera, .microphone, .screenShare, .backgroundEffect, .deviceSwap: "media"
        case .chat: "chat"
        case .session: "session"
        }
    }

    private static func stageTitle(_ stage: Stage) -> String {
        switch stage {
        case .connect: String(localized: "Couldn’t join the meeting")
        case .camera, .deviceSwap: String(localized: "Camera problem")
        case .microphone: String(localized: "Microphone problem")
        case .chat: String(localized: "Chat problem")
        case .screenShare: String(localized: "Screen sharing problem")
        case .backgroundEffect: String(localized: "Background effect problem")
        case .session: String(localized: "Disconnected")
        }
    }
}

// MARK: - Media and session states we raise ourselves

extension StarlingsError {
    static func screenCapturePermissionDenied(diagnostic: String = "") -> StarlingsError {
        StarlingsError(
            code: "media.screen_capture_denied",
            title: String(localized: "Starlings doesn’t have Screen Recording access"),
            message: String(localized: "Allow Starlings in System Settings → Privacy & Security → Screen Recording, then quit and reopen Starlings before sharing."),
            recovery: .openScreenRecordingSettings,
            diagnostic: diagnostic
        )
    }

    static func cameraMissing(diagnostic: String = "") -> StarlingsError {
        StarlingsError(
            code: "media.camera_missing",
            title: String(localized: "That camera is gone"),
            message: String(localized: "The selected camera isn’t connected any more. Pick a different one."),
            diagnostic: diagnostic
        )
    }

    static func microphoneMissing(diagnostic: String = "") -> StarlingsError {
        StarlingsError(
            code: "media.mic_missing",
            title: String(localized: "That microphone is gone"),
            message: String(localized: "The selected microphone isn’t available any more. Pick a different one."),
            diagnostic: diagnostic
        )
    }

    static let chatTooLong = StarlingsError(
        code: "chat.too_long",
        title: String(localized: "Message too long"),
        message: String(localized: "Shorten this message and send it again."),
        severity: .notice
    )

    static let chatNotConnected = StarlingsError(
        code: "chat.not_connected",
        title: String(localized: "Not in the meeting"),
        message: String(localized: "Join the meeting before sending chat."),
        severity: .notice
    )

    /// The user never asked for this caption — dropping one is not their problem.
    static let captionTooLarge = StarlingsError(
        code: "caption.too_large",
        title: String(localized: "Caption dropped"),
        message: String(localized: "A caption segment was too large to publish."),
        severity: .silent
    )

    static let invalidEntry = StarlingsError(
        code: "connect.invalid_entry",
        title: String(localized: "Couldn’t join the meeting"),
        message: String(localized: "This Mac’s role doesn’t match the connection it was given. Try joining again."),
        recovery: .retry
    )

    static let sessionLost = StarlingsError(
        code: "session.dropped",
        title: String(localized: "Disconnected"),
        message: String(localized: "The connection to the meeting was lost."),
        recovery: .rejoin
    )
}

// MARK: - Control plane

extension StarlingsError {
    /// Maps a control-plane failure. The server writes for people already, so its
    /// prose is kept as the message — what changes is that the status code stops
    /// being part of the sentence and the title names the operation that failed.
    static func service(
        status: Int,
        serverCode: String?,
        serverMessage: String,
        operation: String
    ) -> StarlingsError {
        let diagnostic = "HTTP \(status)\(serverCode.map { " \($0)" } ?? "")"

        switch serverCode ?? "" {
        case ControlErrorCodeValue.ownerAuthRequired.rawValue:
            return StarlingsError(
                code: "auth.session_expired",
                title: String(localized: "Sign in again"),
                message: String(localized: "Your Starlings sign-in is no longer valid. Sign in to continue."),
                recovery: .signIn,
                diagnostic: diagnostic
            )
        case ControlErrorCodeValue.clientUpdateRequired.rawValue:
            // A retired route this build still calls. The server's
            // sentence says what the update unlocks.
            return StarlingsError(
                code: "client.update_required",
                title: StarlingsUpgradeRecommendation.requiredTitle,
                message: serverMessage,
                recovery: .update,
                diagnostic: diagnostic
            )
        case ControlErrorCodeValue.roomNotFound.rawValue:
            // A verified member with no row in OWNER_ROOM_MAP. A state with a
            // next step, not a fault — Launch reads this code to swap Start
            // for the explanation.
            return StarlingsError(
                code: "room.unmapped",
                title: String(localized: "No room for this account yet"),
                message: String(localized: "No room is mapped to this account. Ask the Starlings admin."),
                severity: .notice,
                diagnostic: diagnostic
            )
        case ControlErrorCodeValue.lobbyCredentialsInvalid.rawValue:
            return StarlingsError(
                code: "lobby.credentials_invalid",
                title: String(localized: "Your place in the waiting room is gone"),
                message: String(localized: "Ask to join again."),
                recovery: .rejoin,
                diagnostic: diagnostic
            )
        case ControlErrorCodeValue.meetingEnded.rawValue, ControlErrorCodeValue.meetingInactive.rawValue:
            return StarlingsError(
                code: "session.room_closed",
                title: String(localized: "Meeting ended"),
                message: serverMessage,
                severity: .notice,
                diagnostic: diagnostic
            )
        case ControlErrorCodeValue.requestAlreadyDecided.rawValue:
            // The queue simply moved on — refreshing shows the truth.
            return StarlingsError(
                code: "lobby.already_decided",
                title: String(localized: "Already handled"),
                message: serverMessage,
                severity: .silent,
                diagnostic: diagnostic
            )
        case ControlErrorCodeValue.rateLimited.rawValue:
            return StarlingsError(
                code: "service.rate_limited",
                title: String(localized: "Too busy right now"),
                message: serverMessage,
                recovery: .retry,
                severity: .notice,
                diagnostic: diagnostic
            )
        case ControlErrorCodeValue.notConfigured.rawValue:
            return StarlingsError(
                code: "service.not_configured",
                title: String(localized: "Starlings isn’t fully set up"),
                message: String(localized: "Starlings is missing configuration. Contact the Starlings team."),
                diagnostic: "\(diagnostic) — \(serverMessage)"
            )
        default:
            break
        }

        if status >= 500 {
            return StarlingsError(
                code: "service.unavailable",
                title: operation,
                message: String(localized: "The meeting service couldn’t complete the request. Try again."),
                recovery: .retry,
                diagnostic: "\(diagnostic) — \(serverMessage)"
            )
        }

        // A 429 with a code of its own (`calendar_failed` when Google is busy)
        // is still "not now": the same code as Meet's own rate limit, so a
        // caller that retries a busy service retries this one too.
        return StarlingsError(
            code: status == 429 ? "service.rate_limited" : "service.rejected",
            title: operation,
            message: serverMessage,
            recovery: status == 429 ? .retry : .none,
            diagnostic: diagnostic
        )
    }

    static func transport(_ error: Error, operation: String) -> StarlingsError {
        let urlError = error as? URLError
        switch urlError?.code {
        case .some(.timedOut):
            return StarlingsError(
                code: "service.timeout",
                title: operation,
                message: String(localized: "The meeting service timed out. Check your connection and try again."),
                recovery: .retry,
                diagnostic: error.localizedDescription
            )
        case .some(.notConnectedToInternet), .some(.networkConnectionLost), .some(.cannotFindHost), .some(.cannotConnectToHost):
            return StarlingsError(
                code: "service.offline",
                title: operation,
                message: String(localized: "Starlings can’t reach the service. Check your connection and try again."),
                recovery: .retry,
                diagnostic: error.localizedDescription
            )
        case .some(.cancelled):
            return StarlingsError(
                code: "service.cancelled",
                title: operation,
                message: String(localized: "That request was cancelled."),
                severity: .silent,
                diagnostic: error.localizedDescription
            )
        default:
            return StarlingsError(
                code: "service.unreachable",
                title: operation,
                message: String(localized: "The request to the meeting service didn’t go through."),
                recovery: .retry,
                diagnostic: error.localizedDescription
            )
        }
    }

    static func authenticationRequired() -> StarlingsError {
        StarlingsError(
            code: "auth.required",
            title: String(localized: "Sign in first"),
            message: String(localized: "Sign in before starting a room."),
            recovery: .signIn
        )
    }

    static func invalidResponse(operation: String) -> StarlingsError {
        StarlingsError(
            code: "service.invalid_response",
            title: operation,
            message: String(localized: "The meeting service sent something Starlings couldn’t read."),
            recovery: .retry,
            diagnostic: "response did not decode"
        )
    }

    /// Anything not already typed — form validation, local subsystems, the long
    /// tail of `LocalizedError` values that already read well.
    static func wrapping(_ error: Error, code: String, title: String, recovery: Recovery = .none) -> StarlingsError {
        if let already = error as? StarlingsError { return already }
        return StarlingsError(
            code: code,
            title: title,
            message: error.localizedDescription,
            recovery: recovery,
            diagnostic: String(describing: type(of: error))
        )
    }

    /// Field-level validation. Shown inline where the field is, never modal.
    static func validation(code: String, message: String) -> StarlingsError {
        StarlingsError(code: code, title: String(localized: "Check this"), message: message, severity: .notice)
    }
}

// The stable codes the control plane sends alongside `error` are generated:
// `ControlErrorCodeValue` in StarlingsContracts, from `CONTROL_ERROR_CODES` in
// `packages/contracts/src/index.ts`. Match on `.rawValue`, never on a literal.

// MARK: - Weather

extension StarlingsError {
    /// The forecast behind the calendar's day header.
    ///
    /// `.silent` on purpose: the calendar itself is unaffected and there is no
    /// button that would help, so this exists to leave a trail in the debug
    /// report rather than to interrupt anyone. It is still *recorded* — a
    /// forecast that silently decodes to nothing is indistinguishable from one
    /// that is merely past its horizon, which is exactly how a total decode
    /// failure once survived unnoticed.
    static func weatherForecastUnavailable(_ diagnostic: String) -> StarlingsError {
        StarlingsError(
            code: "weather.forecast_unavailable",
            title: String(localized: "Weather unavailable"),
            message: String(localized: "The forecast for the place set in Settings couldn’t be read."),
            severity: .silent,
            diagnostic: diagnostic
        )
    }

    /// Naming a city in Settings is something the user actively asked for, so
    /// a failure there is a notice rather than silence — and it must never be
    /// reported as "no such place", which blames their spelling for what is
    /// usually a network fault.
    static func weatherLookupUnavailable(_ diagnostic: String) -> StarlingsError {
        StarlingsError(
            code: "weather.lookup_unavailable",
            title: String(localized: "Couldn’t look that up"),
            message: String(localized: "The place lookup couldn’t be reached."),
            recovery: .retry,
            severity: .notice,
            diagnostic: diagnostic
        )
    }
}
