import XCTest
@testable import Starlings

/// The rules of ambient capture that need no microphone to test
/// (docs/AMBIENT_CAPTURE.md §1): the route-change debounce and its ceiling,
/// the rebuild ladder, the silence back-fill, the silence detectors, and the
/// manifest's round trip and launch sweep.
final class AmbientCapturePolicyTests: XCTestCase {
    func testDebounceCoalescesAStormAndCeilingsIt() {
        var debounce = RouteChangeDebounce()
        XCTAssertNil(debounce.fireAt)
        XCTAssertEqual(debounce.trigger(at: 10), 10.5)
        // A flapping device keeps re-triggering; the trailing edge moves…
        XCTAssertEqual(debounce.trigger(at: 10.4), 10.9)
        XCTAssertEqual(debounce.trigger(at: 10.8), 11.3)
        // …until the ceiling from the first trigger wins.
        XCTAssertEqual(debounce.trigger(at: 12.9), 13)
        XCTAssertEqual(debounce.trigger(at: 14), 13)
        debounce.reset()
        XCTAssertNil(debounce.fireAt)
        XCTAssertEqual(debounce.trigger(at: 20), 20.5)
    }

    func testLadderWalksFiveStepsThenExhausts() {
        var ladder = RebuildRetryLadder()
        XCTAssertEqual(ladder.nextDelay(), 0.5)
        XCTAssertEqual(ladder.nextDelay(), 1)
        XCTAssertEqual(ladder.nextDelay(), 2)
        XCTAssertEqual(ladder.nextDelay(), 4)
        XCTAssertFalse(ladder.isExhausted)
        XCTAssertEqual(ladder.nextDelay(), 8)
        // The fifth delay was the last one: after it, there is no next.
        XCTAssertTrue(ladder.isExhausted)
        XCTAssertNil(ladder.nextDelay())
        ladder.reset()
        XCTAssertEqual(ladder.nextDelay(), 0.5)
    }

    func testSilenceBackfillHasAFloorAndACap() {
        XCTAssertEqual(SilenceBackfill.seconds(lastFrameAt: 100, resumedAt: 100.02), 0)
        XCTAssertEqual(SilenceBackfill.seconds(lastFrameAt: 100, resumedAt: 101.5), 1.5)
        XCTAssertEqual(SilenceBackfill.seconds(lastFrameAt: 100, resumedAt: 1_000), 300)
    }

    func testSilenceDetectorFiresOncePerRunAndClearsOnSound() {
        var detector = SilenceDetector(threshold: 60)
        XCTAssertFalse(detector.observe(peak: 0, at: 0))
        XCTAssertFalse(detector.observe(peak: 0, at: 30))
        XCTAssertTrue(detector.observe(peak: 0, at: 60))
        // Still silent, already said.
        XCTAssertFalse(detector.observe(peak: 0, at: 90))
        XCTAssertTrue(detector.isSilent(at: 90))
        // Sound clears it; a new run fires again.
        XCTAssertFalse(detector.observe(peak: 0.2, at: 91))
        XCTAssertFalse(detector.isSilent(at: 91))
        XCTAssertTrue(detector.everHeard)
        XCTAssertFalse(detector.observe(peak: 0, at: 100))
        XCTAssertTrue(detector.observe(peak: 0, at: 160))
    }

    func testManifestRoundTripsAndSweepMarksInterrupted() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ambient-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var manifest = AmbientCaptureManifest(
            id: UUID(), source: "ambient", startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            status: .recording, inputName: "BRIO", trackSampleRate: 16_000,
            parts: [.init(index: 0, micFile: "capture_mic_0.caf", systemFile: "capture_system_0.caf", startedAt: Date(timeIntervalSince1970: 1_700_000_000))]
        )
        manifest.note("Started.", at: Date(timeIntervalSince1970: 1_700_000_000))
        // The store never creates a capture's folder; the session does.
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // The write that failed with EPERM while it asked for a protection
        // class (meet#661); the file is owner-only instead.
        try AmbientCaptureStore.write(manifest, to: root)
        let attributes = try FileManager.default.attributesOfItem(atPath: AmbientCaptureStore.manifestURL(in: root).path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let read = try AmbientCaptureStore.read(from: root)
        XCTAssertEqual(read, manifest)
        XCTAssertFalse(read.hasRecoverableAudio)

        // The sweep sees a `recording` manifest with no readable track: failed,
        // dated, with a line saying why.
        var swept = read
        swept.parts[0].endedAt = Date(timeIntervalSince1970: 1_700_000_100)
        swept.endedAt = swept.parts[0].endedAt
        swept.status = swept.hasRecoverableAudio ? .interrupted : .failed
        XCTAssertEqual(swept.status, .failed)
        var withAudio = read
        withAudio.parts[0].micFrames = 16_000
        XCTAssertTrue(withAudio.hasRecoverableAudio)
    }

    /// A manifest from a build before meet#706 has no owner and no pass
    /// count; it still reads, as unowned with no attempts.
    func testManifestFromBeforeOwnersReadsUnowned() throws {
        let json = #"{"id":"6F1C1E4A-2B1D-4C5E-9F00-000000000706","startedAt":"2026-09-01T10:00:00Z","status":"captured","parts":[]}"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let manifest = try decoder.decode(AmbientCaptureManifest.self, from: Data(json.utf8))
        XCTAssertNil(manifest.owner)
        XCTAssertEqual(manifest.passAttempts, 0)

        var owned = manifest
        owned.owner = "rosa@example.com"
        owned.passAttempts = 2
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        XCTAssertEqual(try decoder.decode(AmbientCaptureManifest.self, from: encoder.encode(owned)), owned)
    }

    /// The launch sweep removes what no pass will read — a folder with no
    /// manifest, a `failed` capture, a `processed` one a crash left — and
    /// keeps what the pass still has to do. Removing twice is harmless.
    func testSweepRemovesOrphanFailedAndProcessedFolders() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ambient-sweep-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        func folder(_ status: AmbientCaptureManifest.Status?) throws -> URL {
            let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data("audio".utf8).write(to: directory.appendingPathComponent("capture_mic_0.caf"))
            if let status {
                let manifest = AmbientCaptureManifest(id: UUID(), source: "ambient", startedAt: Date(), status: status, inputName: "BRIO", trackSampleRate: 16_000, parts: [])
                try encoder.encode(manifest).write(to: AmbientCaptureStore.manifestURL(in: directory))
            }
            return directory
        }
        let orphan = try folder(nil)
        let failed = try folder(.failed)
        let processed = try folder(.processed)
        let captured = try folder(.captured)
        let interrupted = try folder(.interrupted)

        AmbientCaptureStore.sweepFinished(in: root)

        let exists = { (url: URL) in FileManager.default.fileExists(atPath: url.path) }
        XCTAssertFalse(exists(orphan))
        XCTAssertFalse(exists(failed))
        XCTAssertFalse(exists(processed))
        XCTAssertTrue(exists(captured))
        XCTAssertTrue(exists(interrupted))

        AmbientCaptureStore.remove(captured)
        AmbientCaptureStore.remove(captured)
        XCTAssertFalse(exists(captured))
    }
}
