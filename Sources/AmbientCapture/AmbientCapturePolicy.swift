import Foundation

/// The rules of ambient capture that have nothing to do with CoreAudio, kept
/// apart from it so they can be tested without a microphone. Each is small
/// and stated once; the session reads them, never re-derives them.
/// See docs/AMBIENT_CAPTURE.md §1.
enum AmbientCapturePolicy {
    /// What the tracks are written as: mono, 16 kHz, 16-bit LPCM in a CAF —
    /// the crash-safe shape (AAC does not survive a crash) at ~115 MB/h a
    /// track, and the rate the recognizer wants.
    static let trackSampleRate: Double = 16_000

    /// Below this much free disk a recording does not start.
    static let minimumFreeDiskBytes: Int64 = 2 * 1024 * 1024 * 1024

    /// A mic that has delivered nothing but zeros for this long is a warning.
    static let micSilenceWarningSeconds: TimeInterval = 60
    /// A tap that has delivered nothing but zeros for this long *while the
    /// output device is playing* is a warning — the grant is missing, or was
    /// revoked. Silence while nothing plays is just silence.
    static let tapSilenceWarningSeconds: TimeInterval = 60

    /// Past this the indicator says so; recording continues.
    static let longSessionWarningSeconds: TimeInterval = 6 * 60 * 60

    /// A rebuild back-fills the audio it excised as silence, so the timeline
    /// stays wall-clock-true. Under the floor is jitter, not a gap; over the
    /// cap is a laptop lid, not a device swap.
    static let silenceBackfillFloorSeconds: TimeInterval = 0.05
    static let silenceBackfillCapSeconds: TimeInterval = 300

    /// How many rate-only rebuilds one recording tolerates before it keeps
    /// the graph and accepts drift.
    static let nominalRateRebuildCeiling = 3

    /// A pass that fails this many times on one capture deletes its audio
    /// instead of keeping it for another launch.
    static let passAttemptLimit = 3
}

/// Coalesces a storm of route-change notifications into one rebuild:
/// trailing debounce, with a ceiling so a flapping device cannot starve the
/// rebuild forever. Pure — time is passed in.
struct RouteChangeDebounce: Equatable {
    var trailingDelay: TimeInterval = 0.5
    var ceiling: TimeInterval = 3

    private(set) var firstTriggerAt: TimeInterval?
    private(set) var lastTriggerAt: TimeInterval?

    /// A notification arrived at `now`. Returns when the rebuild should fire.
    mutating func trigger(at now: TimeInterval) -> TimeInterval {
        if firstTriggerAt == nil { firstTriggerAt = now }
        lastTriggerAt = now
        return fireAt ?? now + trailingDelay
    }

    /// When the pending rebuild is due, or nil when nothing is pending.
    var fireAt: TimeInterval? {
        guard let first = firstTriggerAt, let last = lastTriggerAt else { return nil }
        return min(last + trailingDelay, first + ceiling)
    }

    /// The rebuild ran (or was abandoned); the next notification starts fresh.
    mutating func reset() {
        firstTriggerAt = nil
        lastTriggerAt = nil
    }
}

/// A failed rebuild retries on a ladder — 0.5, 1, 2, 4, 8 s — and exhausting
/// it is the write-failure stop. Resets only while a graph is live, so a
/// persistent failure cannot be reset by the storm that caused it.
struct RebuildRetryLadder: Equatable {
    static let delays: [TimeInterval] = [0.5, 1, 2, 4, 8]
    private(set) var attempt = 0

    /// The delay before the next attempt, or nil when the ladder is exhausted.
    mutating func nextDelay() -> TimeInterval? {
        guard attempt < Self.delays.count else { return nil }
        defer { attempt += 1 }
        return Self.delays[attempt]
    }

    var isExhausted: Bool { attempt >= Self.delays.count }

    mutating func reset() { attempt = 0 }
}

/// How much silence to write for the audio a rebuild excised.
enum SilenceBackfill {
    /// `lastFrameAt` is when the old graph delivered its last buffer;
    /// `resumedAt` when the new one delivered its first. Zero under the floor
    /// (jitter), the cap over it (a lid closed).
    static func seconds(lastFrameAt: TimeInterval, resumedAt: TimeInterval) -> TimeInterval {
        let gap = resumedAt - lastFrameAt
        if gap < AmbientCapturePolicy.silenceBackfillFloorSeconds { return 0 }
        return min(gap, AmbientCapturePolicy.silenceBackfillCapSeconds)
    }
}

/// Watches one track for a run of all-zero buffers. Fed from the IO path
/// with a peak per buffer and a clock; answers whether the track has been
/// silent for longer than its threshold. Restarts after any real sample, so
/// a device that comes back clears itself.
struct SilenceDetector: Equatable {
    let threshold: TimeInterval
    private(set) var silentSince: TimeInterval?
    private(set) var everHeard = false

    init(threshold: TimeInterval) {
        self.threshold = threshold
    }

    /// One buffer arrived at `now` with this peak. Returns true when the
    /// silence has just crossed the threshold — once per run of silence.
    mutating func observe(peak: Float, at now: TimeInterval) -> Bool {
        if peak > 0 {
            everHeard = true
            silentSince = nil
            fired = false
            return false
        }
        guard let since = silentSince else {
            silentSince = now
            return false
        }
        if now - since >= threshold, !fired {
            fired = true
            return true
        }
        return false
    }

    /// Whether the current run of silence has already been reported.
    private var fired = false

    /// True while the current run of silence is over the threshold.
    func isSilent(at now: TimeInterval) -> Bool {
        guard let since = silentSince else { return false }
        return now - since >= threshold
    }

    /// A new graph: nothing is known yet.
    mutating func reset() {
        silentSince = nil
        fired = false
    }
}
