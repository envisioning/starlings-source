import AppKit
import Foundation

/// The one place the app starts and stops ambient capture, and the state the
/// menu bar draws. Owns at most one session. Main-actor: every UI reads it,
/// every session event lands here.
///
/// States, in display priority: recording > warning > alarm > idle. An alarm
/// is a post-stop state — loud, dismissable, never recording-disabling: a new
/// capture is startable from it, and the next successful start clears it.
@MainActor
final class AmbientCaptureController {
    enum State: Equatable {
        case unsupported
        case idle
        case recording(since: Date, warnings: [AmbientCaptureWarning])
        /// Stopped on its own. The text is what the menu shows until dismissed.
        case alarm(String)
    }

    private(set) var state: State {
        didSet { onChange?(state) }
    }
    /// The menu bar, and anything else that draws the state.
    var onChange: ((State) -> Void)?
    /// Automation hears every stop: the manifest, and whether it was a failure.
    var onStopped: ((AmbientCaptureManifest, URL) -> Void)?
    /// The signed-in account's address, lowercased, or nil. Read at each
    /// start and stamped on the manifest as its owner.
    var signedInOwner: (() -> String?)?
    /// Sign-out deleted every capture: the pass and automation drop what
    /// they hold.
    var onDiscarded: (() -> Void)?

    /// What the mic lane of the live captions is labeled. Set by the app
    /// from the owner session; "Me" until then.
    var ownerName = "Me"
    /// The live captions view's state. One model for the app's
    /// life; a feed attaches per recording and the window draws it.
    let liveCaptions = AmbientLiveCaptionsModel()
    private var liveFeed: AmbientLiveCaptionFeed?

    private var session: AmbientCaptureSessionHandle?
    private var warnings: [AmbientCaptureWarning] = []
    private var startedAt: Date?
    /// Where the current (or last) capture lives, for a resume.
    private(set) var currentDirectory: URL?
    private(set) var currentManifestID: UUID?
    private var context: AmbientCaptureContext?
    /// A session stopped by sign-out: its `stopped` event files nothing.
    private var discardedID: UUID?

    /// The app's one controller, for sign-out, which has no other way to
    /// reach it.
    private static weak var live: AmbientCaptureController?

    init() {
        if #available(macOS 14.2, *) {
            state = .idle
        } else {
            state = .unsupported
        }
        // A manifest still `recording` from a previous launch is a capture
        // the app died in the middle of. Truth first, before any new start.
        let swept = AmbientCaptureStore.sweepInterrupted()
        for manifest in swept {
            StarlingsDiagnosticsLog.shared.record(
                StarlingsError(
                    code: "ambient.capture.interrupted",
                    title: String(localized: "A recording was cut short"),
                    message: String(localized: "Starlings was not running when the recording that started \(StarlingsDateFormatting.dateTime(manifest.startedAt, dateStyle: .abbreviated)) ended. What was captured is kept."),
                    severity: .silent,
                    diagnostic: manifest.status.rawValue
                ),
                context: "ambient"
            )
        }
        AmbientCaptureStore.sweepFinished()
        Self.live = self
    }

    /// Every sign-out path calls this, after the session is cleared: the
    /// recording running now stops, and the signed-out workspace's captures
    /// on this Mac are deleted — the audio, the manifest, `speaking.jsonl`.
    /// No pass will file them on the account that made them, and none may
    /// file them on the next one. Another workspace's captures wait for it
    /// (slice G), unless `allWorkspaces` signs out of every one.
    static func ownerSignedOut(allWorkspaces: Bool = false) {
        if let live {
            live.discardAll(allWorkspaces: allWorkspaces)
        } else {
            removeCaptures(allWorkspaces: allWorkspaces)
        }
    }

    private static func removeCaptures(allWorkspaces: Bool) {
        if allWorkspaces {
            AmbientCaptureStore.removeAll()
        } else {
            AmbientCaptureStore.removeAll(workspaceOrigin: StarlingsWorkspace.active.webOrigin)
        }
    }

    private func discardAll(allWorkspaces: Bool) {
        if let session {
            discardedID = currentManifestID
            session.stopAndWait()
        }
        session = nil
        startedAt = nil
        warnings = []
        context = nil
        currentDirectory = nil
        currentManifestID = nil
        liveFeed?.finish()
        liveFeed = nil
        if state != .unsupported { state = .idle }
        onDiscarded?()
        Self.removeCaptures(allWorkspaces: allWorkspaces)
    }

    var isRecording: Bool {
        if case .recording = state { return true }
        return false
    }

    /// The microphones the menu offers. The default is first.
    var inputs: [AmbientInputDevice] { AmbientInputDevice.available() }

    /// Start with the chosen microphone, or the default. Throws a `StarlingsError`
    /// the caller shows; a start that fails removes what it wrote, so
    /// nothing is on disk when it does.
    func start(input chosen: AmbientInputDevice? = nil, title: String? = nil) throws {
        try start(input: chosen, context: AmbientCaptureContext(title: title))
    }

    /// Start with what is known about the meeting: its title, its Meet code,
    /// the calendar event, the scheduled end, the attendees.
    func start(input chosen: AmbientInputDevice? = nil, context: AmbientCaptureContext) throws {
        guard #available(macOS 14.2, *) else {
            throw StarlingsError(code: "ambient.capture.unsupported", title: String(localized: "Recording needs macOS 14.2"), message: String(localized: "Capturing a meeting’s audio uses a system feature that arrived in macOS 14.2."), severity: .blocking)
        }
        guard session == nil else { return }
        guard let input = chosen ?? inputs.first else {
            throw StarlingsError(code: "ambient.capture.no_input", title: String(localized: "No microphone"), message: String(localized: "Connect a microphone, then start again."), recovery: .openMicrophoneSettings, severity: .blocking)
        }
        var context = context
        context.owner = signedInOwner?()
        do {
            let started = try AmbientCaptureSession(input: input, context: context) { [weak self] event in
                Task { @MainActor in self?.handle(event) }
            }
            adopt(started, context: context)
        } catch let failure as AmbientCaptureStartFailure {
            throw StarlingsError(code: "ambient.capture.disk", title: String(localized: "Not enough disk space"), message: failure.description, severity: .blocking)
        } catch let failure as AmbientCaptureGraphFailure {
            throw StarlingsError(
                code: "ambient.capture.graph",
                title: String(localized: "Couldn’t start capturing audio"),
                message: String(localized: "The audio system refused to start: \(failure.description)."),
                recovery: .openScreenRecordingSettings,
                severity: .blocking,
                diagnostic: failure.description
            )
        } catch {
            throw StarlingsError.wrapping(error, code: "ambient.capture.start", title: String(localized: "Couldn’t start recording"))
        }
    }

    /// Resume the capture at `directory` as its next part (a rejoin inside
    /// the grace window). The microphone is the one it started with when it
    /// is still connected, else the default.
    func resume(manifest: AmbientCaptureManifest, in directory: URL) throws {
        guard #available(macOS 14.2, *), session == nil else { return }
        let available = inputs
        guard let input = available.first(where: { $0.name == manifest.inputName }) ?? available.first else {
            throw StarlingsError(code: "ambient.capture.no_input", title: String(localized: "No microphone"), message: String(localized: "Connect a microphone, then start again."), recovery: .openMicrophoneSettings, severity: .blocking)
        }
        let resumed = try AmbientCaptureSession(resuming: manifest, in: directory, input: input) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        adopt(resumed, context: AmbientCaptureContext(title: manifest.title, meetingCode: manifest.meetingCode, calendarEventID: manifest.calendarEventID, scheduledEnd: manifest.scheduledEnd, attendees: manifest.attendees, attendeeEmails: manifest.attendeeEmails))
    }

    @available(macOS 14.2, *)
    private func adopt(_ started: AmbientCaptureSession, context: AmbientCaptureContext) {
        session = started
        self.context = context
        currentDirectory = started.directory
        currentManifestID = started.id
        warnings = []
        startedAt = started.manifest.startedAt
        let feed = AmbientLiveCaptionFeed(model: liveCaptions, ownerName: ownerName, startedAt: started.manifest.startedAt)
        liveFeed = feed
        started.attachLiveCaptions(feed)
        state = .recording(since: started.manifest.startedAt, warnings: [])
    }

    /// The meeting's Meet code, when the capture running now has one.
    var currentMeetingCode: String? { context?.meetingCode }

    /// What the extension learned mid-call.
    func absorb(attendees: [String], speaking: [String] = [], title: String?) {
        guard #available(macOS 14.2, *), let live = session as? AmbientCaptureSession else { return }
        live.absorb(attendees: attendees, speaking: speaking, title: title)
        liveFeed?.absorb(speaking: speaking)
    }

    func stop() {
        session?.stop()
    }

    /// The quit intercept: stop and finalize before the process goes.
    func stopAndWaitForQuit() {
        session?.stopAndWait()
        session = nil
        liveFeed?.finish()
        liveFeed = nil
    }

    func dismissAlarm() {
        if case .alarm = state { state = .idle }
    }

    /// Seconds recording so far, for the menu's elapsed line.
    var elapsed: TimeInterval? {
        startedAt.map { Date().timeIntervalSince($0) }
    }

    private func handle(_ event: AmbientCaptureEvent) {
        switch event {
        case .started:
            break
        case .warning(let warning):
            if !warnings.contains(warning) { warnings.append(warning) }
            if let startedAt { state = .recording(since: startedAt, warnings: warnings) }
        case .warningCleared(let warning):
            warnings.removeAll { $0 == warning }
            if let startedAt { state = .recording(since: startedAt, warnings: warnings) }
        case .stoppedOnFailure(let text):
            StarlingsDiagnosticsLog.shared.record(
                StarlingsError(code: "ambient.capture.stopped_on_failure", title: String(localized: "Recording stopped"), message: text, severity: .notice, diagnostic: text),
                context: "ambient"
            )
            state = .alarm("Recording stopped: \(text)")
        case .stopped(let manifest):
            // Sign-out stopped it and deleted it; `discardAll` cleaned up.
            if manifest.id == discardedID {
                discardedID = nil
                return
            }
            session = nil
            startedAt = nil
            warnings = []
            liveFeed?.finish()
            liveFeed = nil
            if let currentDirectory {
                onStopped?(manifest, currentDirectory)
                // No part holds a frame: no transcript can come from it.
                if manifest.status == .failed { AmbientCaptureStore.remove(currentDirectory) }
            }
            if manifest.status == .failed {
                state = .alarm("Recording stopped, and nothing was captured.")
            } else if case .alarm = state {
                // The failure line stays until dismissed.
            } else {
                state = .idle
            }
        }
    }

}
