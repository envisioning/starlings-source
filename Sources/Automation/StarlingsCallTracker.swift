import Foundation

/// The brain of recording automation (docs/AMBIENT_CAPTURE.md §4, lifted
/// from Blaise C14/G11): what to do when a Google Meet call starts, ends,
/// or goes quiet, given what the extension says and what the recorder is
/// doing. Pure — every input is a value, every output is an action, the
/// clock is passed in — so all of it is tested without a browser or a
/// microphone.
///
/// Four behaviours, each a rule stated once:
///
/// 1. **A fresh `callStarted` asks, once.** Notify with a Record button
///    unless a recording for that code is already running, the code is in
///    grace (a rejoin — resume instead), or the person declined this call
///    before (never nag twice).
/// 2. **A confirmed end stops, quietly.** `callEnded` starts a 25 s
///    debounce; any signal for the same code inside it cancels. A real end
///    stops the recording without a word. Within ten minutes of the
///    calendar's scheduled end it finalizes at once; otherwise it enters
///    grace.
/// 3. **Grace turns a rejoin into part n+1.** After an auto-stop the code
///    holds for the resume window; a `callStarted` or `heartbeat` inside it
///    resumes the same meeting. Expiry finalizes.
/// 4. **The watchdog covers ends nobody saw.** Armed once the extension has
///    spoken for this recording; five minutes of silence, confirmed 90 s
///    later on a clock that does not run through sleep, is a stop — and the
///    one auto-stop that notifies, with Resume, because it is the low-
///    confidence path.
struct StarlingsCallTracker: Equatable {
    // MARK: Inputs

    enum Signal: Equatable {
        case callStarted
        case callEnded
        case heartbeat
        /// Any accepted batch with the code: roster churn, speech. Proof of
        /// life, nothing more.
        case liveness
    }

    struct Config: Equatable {
        /// A `callStarted` older than this is bookkeeping, not news.
        var freshnessSeconds: TimeInterval = 120
        var endDebounceSeconds: TimeInterval = 25
        /// 0 = Off: an auto-stop finalizes at once, no grace.
        var graceSeconds: TimeInterval = 300
        var watchdogStaleSeconds: TimeInterval = 300
        var watchdogConfirmSeconds: TimeInterval = 90
        /// An end inside this window before the scheduled end processes now.
        var scheduledEndBandSeconds: TimeInterval = 600
    }

    // MARK: Outputs

    enum Action: Equatable {
        /// Post "Meeting in progress" with a Record button.
        case notifyStarted(code: String)
        /// Take the start notification down: recorded by another path, or over.
        case withdrawStartNotice(code: String)
        /// Start recording this code (from the notification's button).
        case startRecording(code: String)
        /// Stop the running recording. `finalize` false = enter grace after.
        case stopRecording(code: String, finalize: Bool)
        /// Resume the graced meeting as its next part.
        case resumeRecording(code: String)
        /// Grace ran out: finalize what is on disk.
        case finalize(code: String)
        /// The watchdog stopped it: say so, offer Resume.
        case notifyWatchdogStopped(code: String, resumable: Bool)
    }

    // MARK: State

    enum Phase: Equatable {
        case idle
        case recording(code: String)
        /// `callEnded` seen; stop fires at `at` unless a signal cancels.
        case endPending(code: String, at: TimeInterval)
        /// Auto-stopped with recoverable audio; a rejoin before `until` resumes.
        case grace(code: String, until: TimeInterval)
    }

    private(set) var config: Config
    private(set) var phase: Phase = .idle
    /// Per code: the newest signal time seen. A signal at or before it is a
    /// replay and does nothing.
    private(set) var lastSignalAt: [String: TimeInterval] = [:]
    /// Codes the person declined; cleared when the call ends.
    private(set) var declined: Set<String> = []
    /// Start notifications currently up.
    private(set) var noticed: Set<String> = []
    /// Scheduled end of the meeting being recorded, when the calendar knew.
    private(set) var scheduledEnd: TimeInterval?
    // Watchdog
    private(set) var extensionSpokeForRecording = false
    private(set) var lastRecordingSignalAt: TimeInterval?
    private(set) var staleSinceUptime: TimeInterval?

    init(config: Config = Config()) {
        self.config = config
    }

    /// Settings changed the resume window; the next auto-stop uses it.
    mutating func setGraceSeconds(_ seconds: TimeInterval) {
        config.graceSeconds = seconds
    }

    // MARK: Signals from the extension

    /// A signal for `code`, stamped by the extension at `at` (event time,
    /// never receipt time), received when the clock says `now`.
    mutating func signal(_ signal: Signal, code: String, at: TimeInterval, now: TimeInterval) -> [Action] {
        // Replay and out-of-order guard: one clock per code, both kinds.
        if let last = lastSignalAt[code], at <= last { return [] }
        lastSignalAt[code] = at

        var actions: [Action] = []
        switch phase {
        case .recording(let recordingCode) where recordingCode == code:
            extensionSpokeForRecording = true
            lastRecordingSignalAt = at
            staleSinceUptime = nil
            if signal == .callEnded {
                phase = .endPending(code: code, at: now + config.endDebounceSeconds)
            }
        case .endPending(let pendingCode, _) where pendingCode == code:
            // Any sign of life cancels the pending stop — a reconnect flicker.
            if signal != .callEnded {
                phase = .recording(code: code)
                lastRecordingSignalAt = at
            }
        case .grace(let gracedCode, _) where gracedCode == code:
            if signal == .callStarted || signal == .heartbeat || signal == .liveness {
                phase = .recording(code: code)
                lastRecordingSignalAt = at
                staleSinceUptime = nil
                actions.append(.resumeRecording(code: code))
            }
        default:
            switch signal {
            case .callStarted:
                let fresh = now - at <= config.freshnessSeconds
                if fresh, !declined.contains(code), !noticed.contains(code), !isRecording {
                    noticed.insert(code)
                    actions.append(.notifyStarted(code: code))
                }
            case .callEnded:
                // A call we never recorded is over: the offer goes, the
                // decline is forgotten.
                if noticed.remove(code) != nil { actions.append(.withdrawStartNotice(code: code)) }
                declined.remove(code)
            case .heartbeat, .liveness:
                break
            }
        }
        return actions
    }

    // MARK: The person

    /// Record was tapped on the start notification.
    mutating func recordTapped(code: String) -> [Action] {
        noticed.remove(code)
        return [.startRecording(code: code)]
    }

    /// The notification was cleared without Record: do not ask again for
    /// this call.
    mutating func startNoticeDismissed(code: String) {
        noticed.remove(code)
        declined.insert(code)
    }

    /// Resume was tapped on the watchdog notification.
    mutating func resumeTapped(code: String) -> [Action] {
        guard case .grace(let gracedCode, _) = phase, gracedCode == code else { return [] }
        phase = .recording(code: code)
        return [.resumeRecording(code: code)]
    }

    // MARK: The recorder

    /// A recording started (by any path) for `code`, with the calendar's
    /// scheduled end when known.
    mutating func recordingStarted(code: String, scheduledEnd: TimeInterval?, now: TimeInterval) -> [Action] {
        var actions: [Action] = []
        if noticed.remove(code) != nil { actions.append(.withdrawStartNotice(code: code)) }
        self.scheduledEnd = scheduledEnd
        switch phase {
        case .grace(let gracedCode, _) where gracedCode == code,
             .recording(let gracedCode) where gracedCode == code:
            // A resume: the extension already spoke for this meeting, and
            // the signal that resumed it is the freshest thing heard.
            extensionSpokeForRecording = true
        default:
            extensionSpokeForRecording = false
            lastRecordingSignalAt = nil
        }
        staleSinceUptime = nil
        phase = .recording(code: code)
        return actions
    }

    /// A manual stop. Never enters grace; the decline memory is not touched
    /// (manual only — a person who stopped does not want to be re-asked).
    mutating func recordingStoppedManually(code: String) {
        phase = .idle
        declined.insert(code)
        scheduledEnd = nil
        extensionSpokeForRecording = false
    }

    // MARK: The clock

    /// Called every few seconds. `now` is wall time; `uptime` is the process
    /// clock that does not advance through sleep.
    mutating func tick(now: TimeInterval, uptime: TimeInterval) -> [Action] {
        switch phase {
        case .endPending(let code, let at) where now >= at:
            return autoStop(code: code, now: now, watchdog: false)
        case .grace(let code, let until) where now >= until:
            phase = .idle
            scheduledEnd = nil
            return [.finalize(code: code)]
        case .recording(let code):
            guard extensionSpokeForRecording, let last = lastRecordingSignalAt else { return [] }
            let stale = now - last > config.watchdogStaleSeconds
            guard stale else {
                staleSinceUptime = nil
                return []
            }
            guard let since = staleSinceUptime else {
                staleSinceUptime = uptime
                return []
            }
            guard uptime >= since + config.watchdogConfirmSeconds else { return [] }
            return autoStop(code: code, now: now, watchdog: true)
        default:
            return []
        }
    }

    private mutating func autoStop(code: String, now: TimeInterval, watchdog: Bool) -> [Action] {
        // Within the band before the scheduled end, an end is an end.
        let inBand = scheduledEnd.map { now >= $0 - config.scheduledEndBandSeconds } ?? false
        let graced = config.graceSeconds > 0 && !inBand
        var actions: [Action] = [.stopRecording(code: code, finalize: !graced)]
        if graced {
            phase = .grace(code: code, until: now + config.graceSeconds)
        } else {
            phase = .idle
            scheduledEnd = nil
        }
        if watchdog { actions.append(.notifyWatchdogStopped(code: code, resumable: graced)) }
        return actions
    }

    /// The recorder found nothing recoverable at an auto-stop: there is
    /// nothing to resume into.
    mutating func autoStopLeftNothing(code: String) {
        if case .grace(let gracedCode, _) = phase, gracedCode == code {
            phase = .idle
            scheduledEnd = nil
        }
    }

    var isRecording: Bool {
        if case .recording = phase { return true }
        if case .endPending = phase { return true }
        return false
    }

    var currentCode: String? {
        switch phase {
        case .recording(let code), .endPending(let code, _), .grace(let code, _): code
        case .idle: nil
        }
    }
}
