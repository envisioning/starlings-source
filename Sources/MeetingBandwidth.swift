import Foundation
import LiveKit

/// Point-in-time room bandwidth measured from WebRTC RTP stats on this Mac.
struct MeetingBandwidthSnapshot: Equatable, Sendable {
    let downBps: UInt64
    let upBps: UInt64
    let incomingVideo: [MeetingBandwidthIncomingVideo]
    let outgoingVideo: [MeetingBandwidthOutgoingVideo]
    let sampledAt: Date

    var headerTitle: String {
        "\(Self.formatCompact(downBps)) in · \(Self.formatCompact(upBps)) out"
    }

    var totalsMenuTitle: String {
        "Incoming \(Self.formatBitrate(downBps)) · Outgoing \(Self.formatBitrate(upBps))"
    }

    static func formatBitrate(_ bps: UInt64) -> String {
        if bps < 1_000 { return "\(bps) bps" }
        if bps < 1_000_000 {
            return String(format: "%.1f kbps", Double(bps) / 1_000)
        }
        return String(format: "%.2f Mbps", Double(bps) / 1_000_000)
    }

    /// Short header form: `420k`, `1.2M`.
    static func formatCompact(_ bps: UInt64) -> String {
        if bps < 1_000 { return "0" }
        if bps < 1_000_000 {
            return String(format: "%.0fk", Double(bps) / 1_000)
        }
        return String(format: "%.1fM", Double(bps) / 1_000_000)
    }
}

struct MeetingBandwidthIncomingVideo: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let sourceLabel: String
    let bitrateBps: UInt64
    let width: UInt?
    let height: UInt?
    let fps: Double?
    let framesDroppedDelta: UInt
    let freezeCount: UInt
    let totalFreezesDuration: Double
    let packetsLost: Int64

    var menuTitle: String {
        var parts = [
            "Incoming · \(name) \(sourceLabel)",
            MeetingBandwidthSnapshot.formatBitrate(bitrateBps),
        ]
        if let width, let height {
            let fpsPart = fps.map { String(format: "@%.0f", $0) } ?? ""
            parts.append("\(width)x\(height)\(fpsPart)")
        }
        if framesDroppedDelta > 0 {
            parts.append("drop+\(framesDroppedDelta)")
        }
        if freezeCount > 0 {
            parts.append(String(format: "freeze=\(freezeCount)/%.1fs", totalFreezesDuration))
        }
        if packetsLost > 0 {
            parts.append("lost=\(packetsLost)")
        }
        return parts.joined(separator: " · ")
    }
}

struct MeetingBandwidthOutgoingVideo: Identifiable, Equatable, Sendable {
    let id: String
    let sourceLabel: String
    let bitrateBps: UInt64
    let width: UInt?
    let height: UInt?
    let fps: Double?
    let qualityLimitation: String?

    var menuTitle: String {
        var parts = [
            "Outgoing · you \(sourceLabel)",
            MeetingBandwidthSnapshot.formatBitrate(bitrateBps),
        ]
        if let width, let height {
            let fpsPart = fps.map { String(format: "@%.0f", $0) } ?? ""
            parts.append("\(width)x\(height)\(fpsPart)")
        }
        if let qualityLimitation, qualityLimitation != "none" {
            parts.append("limit=\(qualityLimitation)")
        }
        return parts.joined(separator: " · ")
    }
}

/// Metadata safe to include in a pasteable support dump (no tokens / secrets).
struct MeetingBandwidthDebugContext: Equatable, Sendable {
    let roomSlug: String
    let meetingID: String
    let liveKitURL: String
    let role: String
}

/// Polls LiveKit track statistics (~1s) and aggregates in/out bitrates.
@MainActor
final class MeetingBandwidthSampler {
    private weak var room: Room?
    private var task: Task<Void, Never>?
    private var previousFramesDropped: [String: UInt] = [:]
    private(set) var snapshot: MeetingBandwidthSnapshot?

    var onChange: ((MeetingBandwidthSnapshot) -> Void)?

    func start(room: Room) {
        stop()
        self.room = room
        previousFramesDropped = [:]
        snapshot = nil
        task = Task { [weak self] in
            // First SDK tick often has no `previous`, so bps stays 0 — wait one
            // interval before the first publish so the header is not a fake zero.
            try? await Task.sleep(for: .milliseconds(1_100))
            while !Task.isCancelled {
                self?.sample()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        room = nil
        previousFramesDropped = [:]
        snapshot = nil
    }

    private func sample() {
        guard let room else { return }

        var down: UInt64 = 0
        var up: UInt64 = 0
        var incoming: [MeetingBandwidthIncomingVideo] = []
        var outgoing: [MeetingBandwidthOutgoingVideo] = []

        for publication in room.localParticipant.trackPublications.values {
            guard let track = publication.track else { continue }
            guard let stats = track.statistics else { continue }
            for outbound in stats.outboundRtpStream {
                up &+= outbound.bps
            }
            guard publication.kind == .video else { continue }
            let streams = stats.outboundRtpStream
            guard !streams.isEmpty else { continue }
            let bitrate = streams.reduce(UInt64(0)) { $0 &+ $1.bps }
            let primary = streams.max(by: { $0.bps < $1.bps }) ?? streams[0]
            let limitation = primary.qualityLimitationReason?.rawValue
            outgoing.append(
                MeetingBandwidthOutgoingVideo(
                    id: publication.sid.stringValue,
                    sourceLabel: Self.sourceLabel(publication.source),
                    bitrateBps: bitrate,
                    width: primary.frameWidth,
                    height: primary.frameHeight,
                    fps: primary.framesPerSecond,
                    qualityLimitation: limitation
                )
            )
        }

        for participant in room.remoteParticipants.values {
            let name = participant.name
                ?? participant.identity?.stringValue
                ?? String(localized: "Guest")
            for publication in participant.trackPublications.values {
                guard publication.isSubscribed, let track = publication.track else { continue }
                guard let stats = track.statistics else { continue }
                for inbound in stats.inboundRtpStream {
                    down &+= inbound.bps
                }
                guard publication.kind == .video else { continue }
                guard let inbound = stats.inboundRtpStream.first else { continue }
                let key = publication.sid.stringValue
                let dropped = inbound.framesDropped ?? 0
                let previous = previousFramesDropped[key] ?? dropped
                let delta = dropped >= previous ? dropped - previous : 0
                previousFramesDropped[key] = dropped
                incoming.append(
                    MeetingBandwidthIncomingVideo(
                        id: key,
                        name: name,
                        sourceLabel: Self.sourceLabel(publication.source),
                        bitrateBps: inbound.bps,
                        width: inbound.frameWidth,
                        height: inbound.frameHeight,
                        fps: inbound.framesPerSecond,
                        framesDroppedDelta: delta,
                        freezeCount: inbound.freezeCount ?? 0,
                        totalFreezesDuration: inbound.totalFreezesDuration ?? 0,
                        packetsLost: inbound.packetsLost ?? 0
                    )
                )
            }
        }

        incoming.sort {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        outgoing.sort {
            $0.sourceLabel.localizedCaseInsensitiveCompare($1.sourceLabel) == .orderedAscending
        }

        let next = MeetingBandwidthSnapshot(
            downBps: down,
            upBps: up,
            incomingVideo: incoming,
            outgoingVideo: outgoing,
            sampledAt: Date()
        )
        snapshot = next
        onChange?(next)
    }

    private static func sourceLabel(_ source: Track.Source) -> String {
        switch source {
        case .camera: "camera"
        case .screenShareVideo: "screen"
        case .microphone: "mic"
        case .screenShareAudio: "screen-audio"
        case .unknown: "unknown"
        @unknown default: "unknown"
        }
    }
}

enum MeetingBandwidthDebugReport {
    static func build(
        context: MeetingBandwidthDebugContext?,
        connectionState: String,
        adaptiveStream: Bool,
        dynacast: Bool,
        serverVersion: String?,
        serverRegion: String?,
        quality: MeetingQualityReport?,
        participantQuality: [MeetingParticipantQuality],
        bandwidth: MeetingBandwidthSnapshot?,
        transcription: LocalTranscriptionHealthSnapshot?,
        microphone: MicrophoneProcessingSnapshot?,
        recentErrors: [String]
    ) -> String {
        var lines: [String] = []
        let push = { (line: String) in lines.append(line) }

        push("Starlings Mac debug report")
        push("collected_at: \(ISO8601DateFormatter().string(from: Date()))")
        if let context {
            push("room_slug: \(context.roomSlug)")
            push("meeting_id: \(context.meetingID)")
            push("livekit_url: \(sanitizeLiveKitURL(context.liveKitURL))")
            push("role: \(context.role)")
        }
        push("connection_state: \(connectionState)")
        push("adaptive_stream: \(adaptiveStream)")
        push("dynacast: \(dynacast)")
        if let serverVersion {
            push(
                "livekit_server: version=\(serverVersion) region=\(serverRegion ?? "?")"
            )
        }

        push("")
        push("## Session quality (this client)")
        if let quality {
            push("worst: \(quality.worstQuality)")
            push("reconnects: \(quality.reconnectCount)")
            push("connected: \(formatMs(quality.connectedMs))")
            push(
                "buckets: excellent=\(formatMs(quality.excellentMs)) good=\(formatMs(quality.goodMs)) poor=\(formatMs(quality.poorMs)) lost=\(formatMs(quality.lostMs))"
            )
        } else {
            push("(no quality samples yet)")
        }

        push("")
        push("## Participants (\(participantQuality.count))")
        if participantQuality.isEmpty {
            push("(none)")
        } else {
            for entry in participantQuality {
                let who = entry.isLocal ? "local" : "remote"
                push("\(who) name=\(quote(entry.name)) quality=\(entry.quality.rawValue)")
            }
        }

        push("")
        push("## Bandwidth (this Mac)")
        if let bandwidth {
            push("down: \(MeetingBandwidthSnapshot.formatBitrate(bandwidth.downBps))")
            push("up: \(MeetingBandwidthSnapshot.formatBitrate(bandwidth.upBps))")
            push("sampled_at: \(ISO8601DateFormatter().string(from: bandwidth.sampledAt))")
            if bandwidth.outgoingVideo.isEmpty {
                push("outgoing_video: (none)")
            } else {
                for row in bandwidth.outgoingVideo {
                    push("outgoing_video: \(row.menuTitle)")
                }
            }
            if bandwidth.incomingVideo.isEmpty {
                push("incoming_video: (none)")
            } else {
                for row in bandwidth.incomingVideo {
                    push("incoming_video: \(row.menuTitle)")
                }
            }
        } else {
            push("(no samples yet — wait a second after join)")
        }

        push("")
        push("## Microphone processing")
        if let microphone {
            microphone.reportLines.forEach(push)
        } else {
            push("(not read)")
        }

        push("")
        push("## Local transcription")
        if let transcription {
            let state: String
            if !transcription.modelReady {
                state = "model_not_ready"
            } else if transcription.receivedAudioFrameCount == 0 {
                state = "no_audio_frames"
            } else if transcription.failedSegmentCount > 0 {
                state = "recognition_error"
            } else if transcription.emittedSegmentCount > 0 {
                state = "healthy"
            } else {
                state = "audio_received_waiting_for_speech"
            }
            push("state: \(state)")
            push("model_ready: \(transcription.modelReady)")
            push("audio_frames: \(transcription.receivedAudioFrameCount)")
            push("audio_samples: \(transcription.receivedAudioSampleCount)")
            push("frames_received_before_model: \(transcription.framesReceivedBeforeModelReady)")
            push("preparation_buffer_overflows: \(transcription.preparationBufferOverflowCount)")
            push("speech_frames: \(transcription.speechFrameCount)")
            push("discarded_utterances: \(transcription.discardedUtteranceCount)")
            push("emitted_segments: \(transcription.emittedSegmentCount)")
            push("failed_segments: \(transcription.failedSegmentCount)")
            push("active_speakers: \(transcription.activeSpeakerCount)")
            if let lastAudioAt = transcription.lastAudioAt {
                push("last_audio_at: \(ISO8601DateFormatter().string(from: lastAudioAt))")
            }
            if let lastSpeechAt = transcription.lastSpeechAt {
                push("last_speech_at: \(ISO8601DateFormatter().string(from: lastSpeechAt))")
            }
            if let lastSegmentAt = transcription.lastSegmentAt {
                push("last_segment_at: \(ISO8601DateFormatter().string(from: lastSegmentAt))")
            }
            if let lastFailureKind = transcription.lastFailureKind {
                push("last_failure: \(lastFailureKind)")
            }
        } else {
            push("(not active on this client)")
        }

        push("")
        push("## Recent errors (\(recentErrors.count))")
        if recentErrors.isEmpty {
            push("(none)")
        } else {
            recentErrors.forEach(push)
        }

        push("")
        push("## Notes")
        push("- No tokens, lobby secrets, captions, or full emails are included.")
        push("- Bitrate lines are approximate over ~1s WebRTC stats windows.")
        push("- Errors are the last 50 failures this app logged, newest last;")
        push("  repeats collapse into one line with a count.")
        push("- Paste this into Slack/email when reporting a bad call.")

        return lines.joined(separator: "\n") + "\n"
    }

    private static func sanitizeLiveKitURL(_ raw: String) -> String {
        guard let url = URL(string: raw), let host = url.host else {
            return String(localized: "(invalid livekit url)")
        }
        let path = url.path.hasSuffix("/") ? String(url.path.dropLast()) : url.path
        let port: String
        if let p = url.port {
            port = ":\(p)"
        } else {
            port = ""
        }
        return "\(url.scheme ?? "wss")://\(host)\(port)\(path)"
    }

    private static func formatMs(_ ms: Int) -> String {
        let total = max(0, ms) / 1_000
        let minutes = total / 60
        let seconds = total % 60
        if minutes == 0 { return "\(seconds)s" }
        return "\(minutes)m\(String(format: "%02d", seconds))s"
    }

    private static func quote(_ value: String) -> String {
        "\"\(value.replacingOccurrences(of: "\"", with: "'"))\""
    }
}
