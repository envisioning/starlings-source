import AVFoundation
import FluidAudio
import Foundation

/// The two-track pass (docs/AMBIENT_CAPTURE.md §2): a captured folder's
/// CAFs into a transcript that says who said what, filed on the owner's
/// room as an ambient meeting so the notes, the category and the CRM write
/// are the ones a hosted meeting gets.
///
/// Mic track → recognizer; every word is the owner's and nothing can
/// relabel it. System track → recognizer + diarizer → `SpeakerMerger`.
/// Interleaved by time, uploaded through the same transcript route, then
/// finalized — the Worker takes it from there. The tracks are deleted once
/// the transcript is verified on the server: crash safety without an
/// archive (the decision in the brief).
actor AmbientCapturePass {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    /// The pass failed for the `passAttemptLimit`-th time; the capture's
    /// folder is deleted.
    struct Discarded: Error, CustomStringConvertible {
        let underlying: Error
        var description: String { "deleted after \(AmbientCapturePolicy.passAttemptLimit) failed passes: \(underlying)" }
    }

    /// What the pass needs from the app: the API, and who the owner is.
    struct Environment: Sendable {
        let api: MeetingControlAPI
        let ownerName: String
        /// The signed-in account's address, lowercased, or nil when nobody
        /// is signed in. Read when the transcript is ready to file.
        let signedInOwner: @Sendable () -> String?
    }

    private let environment: Environment
    private var diarizer: DiarizerManager?

    init(environment: Environment) {
        self.environment = environment
    }

    /// Process one capture. Throws with the manifest updated to say why, so
    /// the next launch tries again; on success the transcript is on the
    /// server and the folder is gone. The record is read from disk, not
    /// taken from the caller: a folder deleted since it was queued is left
    /// deleted. A capture of another account, or of none, is deleted, never filed; one
    /// that fails `passAttemptLimit` times is deleted and throws `Discarded`.
    func process(_ manifest: AmbientCaptureManifest, in directory: URL) async throws {
        guard FileManager.default.fileExists(atPath: AmbientCaptureStore.manifestURL(in: directory).path) else { return }
        var record = (try? AmbientCaptureStore.read(from: directory)) ?? manifest
        guard record.status == .captured || record.status == .interrupted else { return }
        guard record.hasRecoverableAudio else {
            // Nothing a transcript can come from: the record goes too.
            AmbientCaptureStore.remove(directory)
            return
        }
        // Another workspace's capture waits, untouched and uncounted, until
        // that workspace is active: the API files on the active one.
        guard record.workspaceOrigin == StarlingsWorkspace.active.webOrigin else {
            throw Failure(description: "another workspace is active")
        }
        // Counted before the work, so a pass that crashes the app counts.
        record.passAttempts += 1
        try? AmbientCaptureStore.write(record, to: directory)
        do {
            let segments = try await transcribe(record, in: directory)
            record.note("Transcribed: \(segments.count) segments across \(record.parts.count) part\(record.parts.count == 1 ? "" : "s").")
            try? AmbientCaptureStore.write(record, to: directory)

            // Whose it is, checked at the last moment before filing: the
            // API files on whoever is signed in now.
            guard FileManager.default.fileExists(atPath: directory.path) else { return }
            guard let signedIn = environment.signedInOwner() else {
                // Not the capture's fault: this try does not count.
                record.passAttempts -= 1
                throw Failure(description: "nobody is signed in")
            }
            // No owner (an older build, or a start while signed out) is not
            // proof it is this account's: deleted, never filed.
            guard record.owner == signedIn else {
                AmbientCaptureStore.remove(directory)
                return
            }

            let meetingID = try await file(record, segments: segments)
            record.note("Filed as meeting \(meetingID); finalized.")
            record.status = .processed
            // Verified on the server (finalize answered with the transcript):
            // the audio has done its job. `processed` first, so a crash
            // before the removal leaves a folder the launch sweep removes.
            try? AmbientCaptureStore.write(record, to: directory)
            AmbientCaptureStore.remove(directory)
        } catch {
            // Deleted under the pass (sign-out): nothing left to count.
            guard FileManager.default.fileExists(atPath: directory.path) else { throw error }
            if record.passAttempts >= AmbientCapturePolicy.passAttemptLimit {
                AmbientCaptureStore.remove(directory)
                throw Discarded(underlying: error)
            }
            record.note("Pass failed: \(error). Will retry at the next launch.")
            try? AmbientCaptureStore.write(record, to: directory)
            throw error
        }
    }

    /// The transcript without the upload — the smoke run's view of the pass.
    func dryRun(_ manifest: AmbientCaptureManifest, in directory: URL) async throws -> [SpeakerMerger.Segment] {
        try await transcribe(manifest, in: directory)
    }

    // MARK: - Transcription

    private func transcribe(_ manifest: AmbientCaptureManifest, in directory: URL) async throws -> [SpeakerMerger.Segment] {
        let models = try await SpeechModelLoader.shared.models()
        let asr = AsrManager(models: models)
        defer { Task { await asr.cleanup() } }
        var all: [SpeakerMerger.Segment] = []
        var allTurns: [SpeakerMerger.Turn] = []
        for part in manifest.parts {
            // Offsets are from the capture's start; a later part's clock is
            // where it began, so the gap between parts stays a gap.
            let offset = part.startedAt.timeIntervalSince(manifest.startedAt)
            let micURL = directory.appendingPathComponent(part.micFile)
            let systemURL = directory.appendingPathComponent(part.systemFile)

            var mic: [SpeakerMerger.Segment] = []
            if part.micFrames > 0 {
                let tokens = try await tokens(of: micURL, with: asr)
                // The owner's own voice: labeled once, immune to any remapping.
                mic = SpeakerMerger.merge(tokens: tokens, turns: [], fallback: environment.ownerName)
            }

            var system: [SpeakerMerger.Segment] = []
            if part.systemFrames > 0 {
                let tokens = try await tokens(of: systemURL, with: asr)
                let turns = (try? await diarize(systemURL, attendeeCount: max(manifest.attendees.count - 1, 0))) ?? []
                system = SpeakerMerger.merge(tokens: tokens, turns: turns)
                allTurns += turns.map { SpeakerMerger.Turn(speaker: $0.speaker, start: $0.start + offset, end: $0.end + offset) }
            }
            all += SpeakerMerger.interleave(mic: mic, system: system).map { segment in
                SpeakerMerger.Segment(speaker: segment.speaker, start: segment.start + offset, end: segment.end + offset, text: segment.text, wordCount: segment.wordCount)
            }
        }
        // Names: the extension's lit tiles vote for each cluster; the rest
        // read Speaker 1, 2… Then every name in the text is spelled the way
        // the roster and the calendar spell it.
        let speaking = AmbientCaptureStore.readSpeaking(in: directory)
        let names = SpeakerNaming.resolve(turns: allTurns, events: speaking, exclude: [environment.ownerName])
        let glossary = NameCorrection.glossary(from: manifest.attendees + [environment.ownerName])
        return SpeakerNaming.apply(names, to: all).map { segment in
            SpeakerMerger.Segment(speaker: segment.speaker, start: segment.start, end: segment.end, text: NameCorrection.correct(segment.text, glossary: glossary), wordCount: segment.wordCount)
        }
    }

    private func tokens(of url: URL, with asr: AsrManager) async throws -> [(token: String, start: Double, end: Double)] {
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(url, decoderState: &state)
        guard let timings = result.tokenTimings, !timings.isEmpty else {
            // No timings: one word, the whole track. Still a transcript.
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? [] : [(" " + text, 0, result.duration)]
        }
        return timings.map { ($0.token, $0.startTime, $0.endTime) }
    }

    private func diarize(_ url: URL, attendeeCount: Int) async throws -> [SpeakerMerger.Turn] {
        let manager: DiarizerManager
        if let ready = diarizer {
            manager = ready
        } else {
            var config = DiarizerConfig.default
            // A count from the calendar or the roster bounds the clusters;
            // one more than known, never exactly (someone always joins).
            if attendeeCount > 0 { config.numClusters = -1 }
            let fresh = DiarizerManager(config: config)
            let models = try await DiarizerModels.downloadIfNeeded()
            fresh.initialize(models: models)
            diarizer = fresh
            manager = fresh
        }
        let samples = try Self.samples(of: url)
        let result = try manager.performCompleteDiarization(samples, sampleRate: 16_000)
        // Labels normalized to S<n> in first-appearance order, whatever the
        // library called them.
        var order: [String: String] = [:]
        return result.segments.sorted { $0.startTimeSeconds < $1.startTimeSeconds }.map { segment in
            let label = order[segment.speakerId] ?? {
                let next = "S\(order.count)"
                order[segment.speakerId] = next
                return next
            }()
            return SpeakerMerger.Turn(speaker: label, start: Double(segment.startTimeSeconds), end: Double(segment.endTimeSeconds))
        }
    }

    /// A 16 kHz mono Int16 CAF as floats in −1…1.
    private static func samples(of url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: file.fileFormat.sampleRate, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length)) else {
            throw Failure(description: "cannot read \(url.lastPathComponent)")
        }
        try file.read(into: buffer)
        guard let channel = buffer.floatChannelData?[0] else { return [] }
        return Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    }

    // MARK: - Filing

    private func file(_ manifest: AmbientCaptureManifest, segments: [SpeakerMerger.Segment]) async throws -> String {
        let room = try await environment.api.ownerRoom().room.slug
        let endedAt = manifest.endedAt ?? manifest.parts.last?.endedAt ?? Date()
        let meetingID = try await environment.api.createAmbientMeeting(
            room: room,
            startedAt: manifest.startedAt,
            endedAt: endedAt,
            title: manifest.title,
            attendees: manifest.attendees.map { AmbientAttendee(name: $0, email: .ifSome(manifest.attendeeEmails[$0])) }
        )
        let transcript = segments.map { segment in
            TranscriptSegment(
                id: UUID(),
                meetingID: meetingID,
                speakerID: segment.speaker == environment.ownerName ? "owner" : "ambient:\(segment.speaker.lowercased().replacingOccurrences(of: " ", with: "-"))",
                speakerName: segment.speaker,
                language: LocalMeetingTranscriber.inferLanguage(segment.text),
                startsAtMilliseconds: Int64(segment.start * 1000),
                endsAtMilliseconds: Int64(max(segment.start, segment.end) * 1000),
                text: segment.text,
                isFinal: true
            )
        }
        for batch in stride(from: 0, to: transcript.count, by: 200) {
            try await environment.api.appendTranscript(room: room, meetingID: meetingID, segments: Array(transcript[batch..<min(batch + 200, transcript.count)]))
        }
        try await environment.api.finalizeMeeting(room: room, meetingID: meetingID)
        return meetingID
    }
}

/// Runs the pass over every capture that is waiting, one at a time: at
/// launch for what a previous run left, and after every stop.
@MainActor
final class AmbientCapturePassRunner {
    private let pass: AmbientCapturePass
    private var running = false
    private var queued: [(AmbientCaptureManifest, URL)] = []
    /// What is held back from the pass right now — a capture in grace for
    /// a resume. Asked at drain time, so a hold that starts after the
    /// enqueue still holds.
    var isHeld: ((UUID) -> Bool)?

    init(environment: AmbientCapturePass.Environment) {
        pass = AmbientCapturePass(environment: environment)
    }

    /// Sign-out: nothing queued runs. A pass already running finds its
    /// folder gone and stops before it files.
    func cancelPending() {
        queued.removeAll()
    }

    /// Everything on disk that is captured and not yet processed.
    func processPending() {
        for (directory, manifest) in AmbientCaptureStore.all() where manifest.status == .captured || manifest.status == .interrupted {
            enqueue(manifest, in: directory)
        }
    }

    func enqueue(_ manifest: AmbientCaptureManifest, in directory: URL) {
        guard !queued.contains(where: { $0.0.id == manifest.id }), isHeld?(manifest.id) != true else { return }
        queued.append((manifest, directory))
        drain()
    }

    private func drain() {
        guard !running, let next = queued.first else { return }
        queued.removeFirst()
        // Held since it was queued: the release enqueues it again.
        guard isHeld?(next.0.id) != true else { return drain() }
        running = true
        Task {
            do {
                try await pass.process(next.0, in: next.1)
            } catch let discarded as AmbientCapturePass.Discarded {
                StarlingsDiagnosticsLog.shared.record(
                    StarlingsError(code: "ambient.pass.discarded", title: String(localized: "Couldn’t transcribe a recording"), message: String(localized: "The recording from \(StarlingsDateFormatting.dateTime(next.0.startedAt, dateStyle: .abbreviated)) couldn’t be transcribed and was deleted."), severity: .notice, diagnostic: String(describing: discarded)),
                    context: "ambient"
                )
            } catch {
                // A folder that is gone was deleted on purpose (sign-out):
                // nothing is kept, so nothing to say.
                if FileManager.default.fileExists(atPath: next.1.path) {
                    StarlingsDiagnosticsLog.shared.record(
                        StarlingsError(code: "ambient.pass.failed", title: String(localized: "Couldn’t transcribe a recording"), message: String(localized: "The recording from \(StarlingsDateFormatting.dateTime(next.0.startedAt, dateStyle: .abbreviated)) is kept; Starlings tries again at the next launch."), severity: .notice, diagnostic: String(describing: error)),
                        context: "ambient"
                    )
                }
            }
            running = false
            drain()
        }
    }
}
