import AppKit
import Foundation
import UserNotifications

/// Recording that starts and stops itself (docs/AMBIENT_CAPTURE.md §4).
///
/// Three inputs — the browser extension's batches through the loopback
/// listener, the recorder's own events, and a five-second tick — go into
/// the pure `StarlingsCallTracker`; its actions come out here as notifications,
/// starts, stops and resumes on `AmbientCaptureController`. Plus the
/// calendar: one minute before an event with a conference link — Google
/// Meet, Zoom, Teams, Webex or any other — a "Launch & Record"
/// notification that opens the link and starts a recording carrying the
/// event's title and attendees.
@MainActor
final class StarlingsAutomationController {
    nonisolated static let startCategory = "MEET_CALL_START"
    nonisolated static let recordAction = "MEET_CALL_RECORD"
    nonisolated static let watchdogCategory = "MEET_CALL_WATCHDOG"
    nonisolated static let resumeAction = "MEET_CALL_RESUME"
    nonisolated static let launchCategory = "MEET_CALL_LAUNCH"
    nonisolated static let launchAction = "MEET_CALL_LAUNCH_RECORD"
    nonisolated static let codeKey = "meetingCode"
    nonisolated static let eventKey = "calendarEventID"

    /// Settings: the resume window in seconds; 0 is Off.
    static var graceSeconds: TimeInterval {
        get {
            let stored = UserDefaults.standard.object(forKey: "meet.automation.graceSeconds") as? Double
            return stored ?? 300
        }
        set { UserDefaults.standard.set(newValue, forKey: "meet.automation.graceSeconds") }
    }

    static var category: [UNNotificationCategory] {
        [
            UNNotificationCategory(
                identifier: startCategory,
                actions: [UNNotificationAction(identifier: recordAction, title: String(localized: "Record"), options: [])],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: watchdogCategory,
                actions: [UNNotificationAction(identifier: resumeAction, title: String(localized: "Resume"), options: [])],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: launchCategory,
                actions: [UNNotificationAction(identifier: launchAction, title: String(localized: "Launch & Record"), options: [.foreground])],
                intentIdentifiers: []
            ),
        ]
    }

    private let capture: AmbientCaptureController
    private var tracker: StarlingsCallTracker
    private var listener: StarlingsEventsListener?
    /// Zoom's roster and lifecycle through Accessibility — the second
    /// signal source, feeding the same tracker as the extension.
    private var zoom: ZoomCallReader?
    private var tick: Timer?
    /// The last roster the extension sent per code, for a start's attendees.
    private var rosters: [String: (title: String?, names: [String])] = [:]
    /// What the calendar knows, keyed by Meet code, for titles and ends.
    private var eventsByCode: [String: CalendarEventSummary] = [:]
    private var launchNoticed: Set<String> = []
    /// Graced captures, by code, so a resume knows where to reopen.
    private var graced: [String: (manifest: AmbientCaptureManifest, directory: URL)] = [:]
    /// Whether the last stop was an auto-stop (so its outcome may grace).
    private var stoppingAutomatically = false
    /// A graced capture the tracker no longer holds — grace expired, or the
    /// call moved on — goes to the pass through this. Until then the pass
    /// leaves it alone, so a resume never meets a part it filed.
    var onReleased: ((AmbientCaptureManifest, URL) -> Void)?

    /// Whether this capture is held in grace for a resume.
    func isHolding(_ id: UUID) -> Bool {
        graced.values.contains { $0.manifest.id == id }
    }

    /// Sign-out deleted every capture: nothing is left to resume.
    func dropHeld() {
        graced.removeAll()
    }

    init(capture: AmbientCaptureController) {
        self.capture = capture
        tracker = StarlingsCallTracker(config: .init(graceSeconds: Self.graceSeconds))
        capture.onStopped = { [weak self] manifest, directory in
            self?.captureStopped(manifest, in: directory)
        }
    }

    func start() {
        do {
            let door = try StarlingsEventsListener(token: StarlingsEventsPairing.token) { [weak self] batch in
                Task { @MainActor in self?.receive(batch) }
            }
            door.start()
            listener = door
        } catch {
            StarlingsDiagnosticsLog.shared.record(
                StarlingsError(code: "automation.listener", title: String(localized: "Starlings events door closed"), message: String(localized: "The browser extension cannot reach Starlings: \(error.localizedDescription)"), severity: .silent, diagnostic: String(describing: error)),
                context: "automation"
            )
        }
        let reader = ZoomCallReader(
            isRecording: { [weak self] in self?.isRecordingZoom == true },
            onBatch: { [weak self] batch in self?.receive(batch) }
        )
        reader.start()
        zoom = reader
        tick = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.evaluate() }
        }
    }

    func stop() {
        zoom?.stop()
        zoom = nil
        listener?.stop()
        listener = nil
        tick?.invalidate()
        tick = nil
    }

    /// Whether the running recording is a Zoom call — found by Zoom's
    /// window, launched from a Zoom event on the calendar, or started by
    /// hand (no code) while Zoom is the call that is up; the reader then
    /// keeps the roster read going every second for it.
    private var isRecordingZoom: Bool {
        guard capture.isRecording else { return false }
        guard let code = capture.currentMeetingCode else { return true }
        if code.hasPrefix("zoom:") { return true }
        return code.hasPrefix("event:") && eventsByCode[code]?.platform == .zoom
    }

    // MARK: - Calendar

    /// What is coming up, from the same feed the menu bar reads. Every
    /// event with a conference link gets a "Launch & Record" a minute
    /// before it starts, the way Granola asks. A Google Meet event is keyed
    /// by its Meet code so the extension's batches land on the same
    /// recording; any other platform is keyed by the event.
    func updateUpcoming(_ events: [CalendarEventSummary]) {
        var byCode: [String: CalendarEventSummary] = [:]
        for event in events {
            guard let code = Self.code(for: event) else { continue }
            byCode[code] = event
        }
        eventsByCode = byCode
        let now = Date()
        for (code, event) in byCode {
            guard let start = event.upcomingStart, !launchNoticed.contains(event.id) else { continue }
            let lead = start.timeIntervalSince(now)
            guard lead <= 60, lead > -300, !capture.isRecording else { continue }
            launchNoticed.insert(event.id)
            let content = UNMutableNotificationContent()
            content.title = event.title.isEmpty ? String(localized: "Meeting starting") : event.title
            content.body = "Starts \(StarlingsDateFormatting.time(start)) on \(event.platform.displayName)"
            content.categoryIdentifier = Self.launchCategory
            content.userInfo = [Self.codeKey: code, Self.eventKey: event.id]
            let request = UNNotificationRequest(identifier: "meet.launch.\(event.id)", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request)
        }
    }

    /// The tracker's code for a calendar event, or nil when there is
    /// nothing to record: no link, or one of Meet's own rooms, which
    /// records itself.
    static func code(for event: CalendarEventSummary) -> String? {
        if let meet = meetCode(in: event.conferenceUrl) ?? meetCode(in: event.joinUrl) { return meet }
        guard !event.launchURL.isEmpty else { return nil }
        switch event.platform {
        case .starlings, .none: return nil
        default: return "event:\(event.id)"
        }
    }

    /// `abc-defg-hij` from any Google Meet URL.
    static func meetCode(in url: String) -> String? {
        guard let match = url.range(of: #"meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})"#, options: .regularExpression) else { return nil }
        return String(url[match].split(separator: "/").last ?? "")
    }

    // MARK: - Extension batches

    func receive(_ batch: StarlingsEventsBatch) {
        // A Zoom recording launched from the calendar carries the event's
        // code; Zoom's own signals steer it, so its end stops the recording.
        var code = batch.meetingCode
        if code.hasPrefix("zoom:"), capture.isRecording,
           let current = capture.currentMeetingCode, current.hasPrefix("event:"),
           eventsByCode[current]?.platform == .zoom {
            code = current
        }
        let names = batch.roster.map(\.name)
        rosters[code] = (batch.title, names)
        // A recording started by hand from the menu has no code. The one
        // call that is up is the call being recorded, so its roster and its
        // lit tiles are this recording's evidence too.
        let adopts = capture.currentMeetingCode == code || capture.currentMeetingCode == nil
        if capture.isRecording, adopts {
            capture.absorb(attendees: names, speaking: batch.roster.filter { $0.speaking == true }.map(\.name), title: batch.title)
            if code.hasPrefix("zoom:") { noteZoomRead(batch, into: capture.currentDirectory) }
        }
        let now = Date().timeIntervalSince1970
        var actions: [StarlingsCallTracker.Action] = []
        if let lifecycle = batch.lifecycle {
            let signal: StarlingsCallTracker.Signal = switch lifecycle.kind.eventKind {
            case .callStarted: .callStarted
            case .callEnded: .callEnded
            case .heartbeat: .heartbeat
            case .other: .liveness
            }
            actions += tracker.signal(signal, code: code, at: Double(lifecycle.atMs) / 1000, now: now)
        } else {
            actions += tracker.signal(.liveness, code: code, at: Double(batch.capturedAtMs) / 1000, now: now)
        }
        perform(actions)
    }

    /// What the Zoom reader delivered, once per recording, in the capture
    /// folder — trust, roster size, and the AX tree when the roster is
    /// empty — so a call that came out with no names can be read afterwards
    /// without a Debug build (the selectors are guesses until tuned).
    private var zoomReadNoted: URL?
    private func noteZoomRead(_ batch: StarlingsEventsBatch, into directory: URL?) {
        guard let directory, zoomReadNoted != directory else { return }
        zoomReadNoted = directory
        var lines = [
            "trusted: \(ZoomCallReader.isTrusted)",
            "roster: \(batch.roster.count) (\(batch.roster.filter { $0.speaking == true }.count) speaking)",
            "title: \(batch.title ?? "-")",
        ]
        if batch.roster.isEmpty { lines.append(ZoomCallReader.dump()) }
        try? lines.joined(separator: "\n").write(to: directory.appendingPathComponent("zoom-read.txt"), atomically: true, encoding: .utf8)
    }

    // MARK: - Notifications

    /// The notification centre's answer, routed by the app delegate.
    func handleNotification(category: String, action: String, code: String?, eventID: String?) {
        switch category {
        case Self.startCategory:
            guard let code else { return }
            if action == UNNotificationDismissActionIdentifier {
                tracker.startNoticeDismissed(code: code)
            } else {
                // Record, or the banner itself: one click anywhere records.
                perform(tracker.recordTapped(code: code))
            }
        case Self.watchdogCategory:
            guard let code, action == Self.resumeAction || action == UNNotificationDefaultActionIdentifier else { return }
            perform(tracker.resumeTapped(code: code))
        case Self.launchCategory:
            guard let code, action != UNNotificationDismissActionIdentifier else { return }
            launchAndRecord(code: code, eventID: eventID)
        default:
            break
        }
    }

    private func launchAndRecord(code: String, eventID: String?) {
        let event = eventID.flatMap { id in eventsByCode.values.first { $0.id == id } } ?? eventsByCode[code]
        let url = event.map(\.launchURL).flatMap { $0.isEmpty ? nil : $0 } ?? "https://meet.google.com/\(code)"
        if let link = URL(string: url) {
            // Google Meet opens in Chrome, never the default browser: the
            // extension lives there. Every other platform opens its own way.
            if !code.hasPrefix("event:"), let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
                NSWorkspace.shared.open([link], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration())
            } else {
                NSWorkspace.shared.open(link)
            }
        }
        startRecording(code: code)
    }

    // MARK: - Actions

    /// Every action, for the smoke run and the diagnostics log.
    var onAction: ((StarlingsCallTracker.Action) -> Void)?

    private func perform(_ actions: [StarlingsCallTracker.Action]) {
        for action in actions {
            onAction?(action)
            switch action {
            case .notifyStarted(let code):
                let event = eventsByCode[code]
                let content = UNMutableNotificationContent()
                content.title = String(localized: "Meeting in progress")
                content.body = event.map { "\($0.title) · \(code)" } ?? (code.hasPrefix("zoom:") ? "Zoom" : code)
                content.categoryIdentifier = Self.startCategory
                content.userInfo = [Self.codeKey: code]
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "meet.start.\(code)", content: content, trigger: nil))
            case .withdrawStartNotice(let code):
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["meet.start.\(code)"])
            case .startRecording(let code):
                startRecording(code: code)
            case .stopRecording(let code, _):
                stoppingAutomatically = true
                _ = code
                capture.stop()
            case .resumeRecording(let code):
                guard let held = graced[code] else { break }
                do {
                    try capture.resume(manifest: held.manifest, in: held.directory)
                    graced[code] = nil
                    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["meet.watchdog.\(code)"])
                    perform(tracker.recordingStarted(code: code, scheduledEnd: held.manifest.scheduledEnd?.timeIntervalSince1970, now: Date().timeIntervalSince1970))
                } catch {
                    StarlingsDiagnosticsLog.shared.record(StarlingsError.wrapping(error, code: "automation.resume", title: String(localized: "Couldn’t resume the recording")), context: "automation")
                }
            case .finalize(let code):
                // The capture itself goes to the pass in `releaseUnheld`.
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["meet.watchdog.\(code)"])
            case .notifyWatchdogStopped(let code, let resumable):
                let content = UNMutableNotificationContent()
                content.title = String(localized: "Recording stopped")
                content.body = resumable
                    ? String(localized: "The meeting appears to have ended. Resume if it has not.")
                    : "The meeting appears to have ended."
                content.categoryIdentifier = resumable ? Self.watchdogCategory : ""
                content.userInfo = [Self.codeKey: code]
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "meet.watchdog.\(code)", content: content, trigger: nil))
            }
        }
        releaseUnheld()
    }

    /// Hands the pass every graced capture whose grace is over: expired
    /// (`finalize`), a failed resume, or another call started.
    private func releaseUnheld() {
        for (code, held) in graced {
            if case .grace(let gracedCode, _) = tracker.phase, gracedCode == code { continue }
            graced[code] = nil
            onReleased?(held.manifest, held.directory)
        }
    }

    private func startRecording(code: String) {
        let event = eventsByCode[code]
        let roster = rosters[code]
        var context = AmbientCaptureContext()
        context.meetingCode = code
        context.title = event?.title.nonEmpty ?? roster?.title
        context.calendarEventID = event?.id
        context.scheduledEnd = event?.upcomingEnd
        context.attendees = (event?.attendees.map { $0.name.isEmpty ? $0.email : $0.name } ?? []) + (roster?.names ?? [])
        // The calendar knows addresses; the page never does. Core links a
        // contact by address, so these are what make a name a person.
        for attendee in event?.attendees ?? [] where !attendee.email.isEmpty {
            context.attendeeEmails[attendee.name.isEmpty ? attendee.email : attendee.name] = attendee.email
        }
        do {
            try capture.start(context: context)
            perform(tracker.recordingStarted(code: code, scheduledEnd: context.scheduledEnd?.timeIntervalSince1970, now: Date().timeIntervalSince1970))
        } catch {
            StarlingsDiagnosticsLog.shared.record(StarlingsError.wrapping(error, code: "automation.start", title: String(localized: "Couldn’t start recording")), context: "automation")
        }
    }

    private func captureStopped(_ manifest: AmbientCaptureManifest, in directory: URL) {
        guard let code = manifest.meetingCode else { return }
        if stoppingAutomatically {
            stoppingAutomatically = false
            if case .grace = tracker.phase, manifest.hasRecoverableAudio {
                graced[code] = (manifest, directory)
            } else {
                tracker.autoStopLeftNothing(code: code)
            }
        } else {
            tracker.recordingStoppedManually(code: code)
        }
    }

    private func evaluate() {
        tracker.setGraceSeconds(Self.graceSeconds)
        perform(tracker.tick(now: Date().timeIntervalSince1970, uptime: ProcessInfo.processInfo.systemUptime))
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
