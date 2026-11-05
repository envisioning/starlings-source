import XCTest
@testable import Starlings

/// The automation brain (docs/AMBIENT_CAPTURE.md §4), driven with a fake
/// clock: notify once, stop quietly, grace a rejoin, watch for the ends
/// nobody saw.
final class StarlingsCallTrackerTests: XCTestCase {
    private let code = "abc-defg-hij"

    func testFreshStartNotifiesOnceAndStaleStartDoesNot() {
        var tracker = StarlingsCallTracker()
        XCTAssertEqual(tracker.signal(.callStarted, code: code, at: 1_000, now: 1_010), [.notifyStarted(code: code)])
        // A reload re-fires call-started; the notice is already up.
        XCTAssertEqual(tracker.signal(.callStarted, code: code, at: 1_020, now: 1_025), [])
        // A buffered start from long ago is bookkeeping, never a banner.
        var late = StarlingsCallTracker()
        XCTAssertEqual(late.signal(.callStarted, code: code, at: 1_000, now: 1_500), [])
    }

    func testReplayedOrOlderSignalsDoNothing() {
        var tracker = StarlingsCallTracker()
        _ = tracker.signal(.callStarted, code: code, at: 1_000, now: 1_001)
        XCTAssertEqual(tracker.signal(.callEnded, code: code, at: 1_000, now: 1_002), [])
        XCTAssertEqual(tracker.signal(.callEnded, code: code, at: 900, now: 1_002), [])
    }

    func testDeclineIsRememberedUntilTheCallEnds() {
        var tracker = StarlingsCallTracker()
        _ = tracker.signal(.callStarted, code: code, at: 1_000, now: 1_001)
        tracker.startNoticeDismissed(code: code)
        XCTAssertEqual(tracker.signal(.callStarted, code: code, at: 1_100, now: 1_101), [])
        _ = tracker.signal(.callEnded, code: code, at: 1_200, now: 1_201)
        XCTAssertEqual(tracker.signal(.callStarted, code: code, at: 1_300, now: 1_301), [.notifyStarted(code: code)])
    }

    func testRecordTapStartsAndTheStartWithdrawsTheNotice() {
        var tracker = StarlingsCallTracker()
        _ = tracker.signal(.callStarted, code: code, at: 1_000, now: 1_001)
        XCTAssertEqual(tracker.recordTapped(code: code), [.startRecording(code: code)])
        XCTAssertEqual(tracker.recordingStarted(code: code, scheduledEnd: nil, now: 1_002), [])
        XCTAssertTrue(tracker.isRecording)
        // Started by another path while the notice was up: the notice goes.
        var other = StarlingsCallTracker()
        _ = other.signal(.callStarted, code: code, at: 1_000, now: 1_001)
        XCTAssertEqual(other.recordingStarted(code: code, scheduledEnd: nil, now: 1_002), [.withdrawStartNotice(code: code)])
    }

    func testEndDebouncesThenStopsIntoGraceAndARejoinResumes() {
        var tracker = StarlingsCallTracker()
        _ = tracker.recordingStarted(code: code, scheduledEnd: nil, now: 1_000)
        XCTAssertEqual(tracker.signal(.callEnded, code: code, at: 2_000, now: 2_000), [])
        XCTAssertEqual(tracker.phase, .endPending(code: code, at: 2_025))
        // A flicker inside the debounce cancels it.
        XCTAssertEqual(tracker.signal(.heartbeat, code: code, at: 2_010, now: 2_010), [])
        XCTAssertEqual(tracker.phase, .recording(code: code))
        // A real end: stop, quietly, into grace.
        _ = tracker.signal(.callEnded, code: code, at: 2_100, now: 2_100)
        XCTAssertEqual(tracker.tick(now: 2_120, uptime: 100), [])
        XCTAssertEqual(tracker.tick(now: 2_125, uptime: 105), [.stopRecording(code: code, finalize: false)])
        XCTAssertEqual(tracker.phase, .grace(code: code, until: 2_425))
        // The rejoin resumes as part n+1 — no banner.
        XCTAssertEqual(tracker.signal(.callStarted, code: code, at: 2_200, now: 2_200), [.resumeRecording(code: code)])
        XCTAssertEqual(tracker.recordingStarted(code: code, scheduledEnd: nil, now: 2_201), [])
        XCTAssertTrue(tracker.extensionSpokeForRecording)
    }

    func testGraceExpiryFinalizesAndOffIsImmediate() {
        var tracker = StarlingsCallTracker()
        _ = tracker.recordingStarted(code: code, scheduledEnd: nil, now: 1_000)
        _ = tracker.signal(.callEnded, code: code, at: 2_000, now: 2_000)
        _ = tracker.tick(now: 2_025, uptime: 25)
        XCTAssertEqual(tracker.tick(now: 2_324, uptime: 324), [])
        XCTAssertEqual(tracker.tick(now: 2_325, uptime: 325), [.finalize(code: code)])
        XCTAssertEqual(tracker.phase, .idle)

        var off = StarlingsCallTracker(config: .init(graceSeconds: 0))
        _ = off.recordingStarted(code: code, scheduledEnd: nil, now: 1_000)
        _ = off.signal(.callEnded, code: code, at: 2_000, now: 2_000)
        XCTAssertEqual(off.tick(now: 2_025, uptime: 25), [.stopRecording(code: code, finalize: true)])
        XCTAssertEqual(off.phase, .idle)
    }

    func testAnEndNearTheScheduledEndFinalizesAtOnce() {
        var tracker = StarlingsCallTracker()
        _ = tracker.recordingStarted(code: code, scheduledEnd: 5_000, now: 1_000)
        _ = tracker.signal(.callEnded, code: code, at: 4_500, now: 4_500)
        XCTAssertEqual(tracker.tick(now: 4_525, uptime: 25), [.stopRecording(code: code, finalize: true)])
        XCTAssertEqual(tracker.phase, .idle)
    }

    func testWatchdogArmsOnlyAfterTheExtensionSpokeAndConfirmsOnUptime() {
        var tracker = StarlingsCallTracker()
        _ = tracker.recordingStarted(code: code, scheduledEnd: nil, now: 1_000)
        // No extension signal yet: a manual Zoom recording must never auto-stop.
        XCTAssertEqual(tracker.tick(now: 9_000, uptime: 8_000), [])
        _ = tracker.signal(.liveness, code: code, at: 1_100, now: 1_100)
        // Stale after 5 min: first stale evaluation only records the moment.
        XCTAssertEqual(tracker.tick(now: 1_500, uptime: 500), [])
        XCTAssertEqual(tracker.staleSinceUptime, 500)
        // Sleep: wall time jumps, uptime does not — no confirmation.
        XCTAssertEqual(tracker.tick(now: 5_000, uptime: 510), [])
        // 90 s of real uptime later, still nothing heard: stop, notify, resumable.
        XCTAssertEqual(tracker.tick(now: 5_100, uptime: 590), [
            .stopRecording(code: code, finalize: false),
            .notifyWatchdogStopped(code: code, resumable: true),
        ])
        XCTAssertEqual(tracker.resumeTapped(code: code), [.resumeRecording(code: code)])
    }

    func testAFreshSignalClearsTheWatchdogClock() {
        var tracker = StarlingsCallTracker()
        _ = tracker.recordingStarted(code: code, scheduledEnd: nil, now: 1_000)
        _ = tracker.signal(.liveness, code: code, at: 1_000, now: 1_000)
        _ = tracker.tick(now: 1_400, uptime: 400)
        XCTAssertNotNil(tracker.staleSinceUptime)
        _ = tracker.signal(.heartbeat, code: code, at: 1_450, now: 1_450)
        XCTAssertNil(tracker.staleSinceUptime)
        XCTAssertEqual(tracker.tick(now: 1_500, uptime: 500), [])
    }

    func testManualStopNeverGracesAndRemembersTheDecline() {
        var tracker = StarlingsCallTracker()
        _ = tracker.recordingStarted(code: code, scheduledEnd: nil, now: 1_000)
        tracker.recordingStoppedManually(code: code)
        XCTAssertEqual(tracker.phase, .idle)
        XCTAssertEqual(tracker.signal(.callStarted, code: code, at: 1_100, now: 1_101), [])
    }
}
