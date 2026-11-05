import AVFoundation
import Combine
import Foundation
import LiveKit
import StarlingsContracts

struct MobileVideo: Identifiable {
    let id: String
    /// Account address of the person behind the tile — two devices of one
    /// person already collapse onto it (`publishVideos`), and spatial audio
    /// keys a voice's place by it. Empty for the local tile.
    let person: String
    /// Nil while that camera is off. Camera off is a mute rather than an
    /// unpublish, so a tile that kept the track would sit on the last frame it
    /// decoded — the tile shows the person's initials instead.
    let track: VideoTrack?
    let name: String
    let isLocal: Bool
    let isScreenShare: Bool
    let isSpeaking: Bool
    /// Their hand is up, and stays up until it is lowered — see `MeetingHands`.
    let handRaised: Bool
    /// This device hosts the meeting (`HostAttribute`).
    let isHost: Bool
    let quality: MeetingConnectionQuality
    let recording: Bool
    let onBehalfOf: String?
}

/// One notice on the stage foot, as the phone shows it: an SF Symbol and a
/// sentence. A host moderation action names who acted; the transcription
/// audio fault uses the same shape.
struct MobileModerationNotice: Equatable, Sendable {
    let symbol: String
    let text: String
}

@MainActor
final class MobileGuestSession: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case connecting
        case connected
        case ended
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle {
        didSet {
            switch phase {
            case .connecting, .connected: MobileCallActivity.report(self, live: true)
            case .idle, .ended, .failed: MobileCallActivity.report(self, live: false)
            }
        }
    }
    /// Why the meeting stopped, when this phone was not the one that left. Set
    /// before `phase`, so an observer reacting to `.ended` already has the
    /// sentence to show. Nil after an ordinary leave — that needs no reason.
    @Published private(set) var endingReason: String?
    @Published private(set) var previewTrack: LocalVideoTrack?
    @Published private(set) var videos: [MobileVideo] = []
    @Published private(set) var captions: [TranscriptSegment] = []
    @Published private(set) var chatMessages: [MeetingChatMessage] = []
    /// Who has which emoji on which chat message, for as long as the call.
    ///
    /// One published value rather than one per message: a chat pane is a
    /// handful of rows on a phone, and a dictionary of observables to keep
    /// them independent would cost more than the redraw it saves.
    @Published private(set) var chatReactions = ChatReactionTally()
    @Published private(set) var microphoneEnabled = true {
        didSet {
            if microphoneEnabled, !oldValue { microphoneExpectedSince = Date() }
        }
    }
    @Published private(set) var cameraEnabled = true
    @Published private(set) var participantCount = 1
    /// Your own hand, read from the room rather than from the last tap: a raise
    /// the control plane refused leaves this false, and a host lowering every
    /// hand puts it down without this phone being told separately.
    @Published private(set) var handRaised = false
    /// Everyone with a hand up, oldest raise first.
    @Published private(set) var raisedHands: [RaisedHand] = []
    /// Emoji currently in flight, oldest first. Ephemeral in the strongest
    /// sense: nothing here is stored, uploaded, or replayed to a late joiner.
    @Published private(set) var reactions: [MobileFlyingReaction] = []
    /// Hiding your own tile stops it being drawn, never published. The room
    /// still sees you — this is about not watching yourself for an hour.
    @Published var selfViewHidden = false
    /// Blur or a Block plate behind you. Runs on this device through Vision
    /// segmentation — nothing about it reaches the control plane, and the
    /// meeting sees only the composited frames.
    @Published private(set) var backgroundEffect: MeetingBackgroundEffect = .none
    /// Per-person connection quality, for the quality panel. Keyed by identity
    /// so a device shows its own line even when two belong to one person.
    @Published private(set) var quality: [MobileParticipantQuality] = []
    /// True while LiveKit is re-establishing the session. Distinct from
    /// `.failed`: the meeting is not over, it is just not there this second.
    @Published private(set) var isReconnecting = false
    /// True while another device of the same person is in this meeting.
    ///
    /// Two live microphones in one room is feedback, and two transcribed copies
    /// of one voice in the artifact. So the arriving device is a companion: it
    /// sees, is seen, chats, and answers the door, but its microphone stays
    /// off. This is an echo rule, not a permission — the control plane knows
    /// nothing about it, and it clears itself the moment the other device
    /// leaves.
    @Published private(set) var isCompanion = false
    /// This device hosts the meeting: never a companion, whatever
    /// other devices of this person are in the call.
    @Published private(set) var holdsHost = false
    /// Server-sent host messages (`host.v1`): a handover asked of this host,
    /// a new host, or an offer to host. The owner of this session decides.
    var onHostMessage: ((HostMessageWire) async -> Void)?
    /// This connection's LiveKit identity, the one host messages name.
    var ownIdentity: String? { room.localParticipant.identity?.stringValue }
    /// The room and meeting this session is in, once connected.
    var meetingContext: (room: String, meetingID: String)? {
        handContext.map { ($0.room, $0.meetingID) }
    }
    /// Host moderation, said out loud. A microphone that goes dead with no
    /// explanation reads as a broken phone, and a removal reads as a dropped
    /// call — both are things somebody would leave the meeting to go and fix.
    /// Dismissible: it is history, not a standing rule.
    @Published var moderationNotice: MobileModerationNotice?
    /// The host's own microphone stopped reaching the transcriber, and one
    /// restart did not bring it back. Same banner shape as a
    /// moderation notice; dismissible, and cleared when audio flows again.
    @Published var transcriptionNotice: MobileModerationNotice?

    /// Which microphone the phone is listening through, for the menu on the
    /// mute button. Owned here so prejoin and the call read the same list.
    let audioInputs = MobileAudioInputs()

    private let room: Room
    /// Front or back. Published so the camera menu can put a checkmark on the
    /// one in use rather than leaving Flip as the only way to find out.
    @Published private(set) var cameraPosition: AVCaptureDevice.Position = .front
    private var speakingIdentities: Set<String> = []
    private var intentionalDisconnect = false
    /// Set when the host removes this phone, so the disconnect that follows a
    /// moment later reads as an ending with a reason rather than a fault.
    private var removedByHost = false
    private var seenChatIDs: Set<String> = []
    /// Set only while this device holds the host. Nil on a guest, nil on a
    /// companion: one device transcribes a meeting, or the artifact gets the
    /// same sentence twice in two voices.
    private var transcriber: LocalMeetingTranscriber?
    private var lastReactionSentAt: Date?
    /// Per-sender floor between chat-reaction toggles, so a held button cannot
    /// flood the topic.
    private var lastChatReactionAt: Date?
    /// Held so the processor is not deallocated while the capturer still feeds
    /// it, and so switching effects replaces rather than stacks.
    private var backgroundProcessor: (any LiveKit.VideoProcessor)?
    private var localAudioRenderer: MeetingAudioRenderer?
    /// The stall check (`TranscriptionStallCheck`). Only while this
    /// device transcribes.
    private var transcriptionWatchdog: Task<Void, Never>?
    private var downstreamUsageTask: Task<Void, Never>?
    private let downstreamUsageMeter = MeetingDownstreamUsageMeter()
    private var transcriptionLocalSpeakerID: String?
    private var microphoneExpectedSince: Date?
    private var audioRecoveryAttempted = false
    private var noAudioReported = false
    /// True between an audio-session interruption's begin and end. The call or
    /// Siri holds the audio then; a restart cannot win, so the check waits.
    private var audioSessionInterrupted = false
    private var audioSessionObservers: [NSObjectProtocol] = []
    private var remoteAudioRenderers: [String: (track: RemoteAudioTrack, renderer: MeetingAudioRenderer)] = [:]
    /// Every remote microphone on the arc, host or guest alike.
    private let spatialStage = SpatialAudioStage()
    private var spatialAudioObserver: NSObjectProtocol?
    /// Called with each finalized segment, on the main actor. The host hands
    /// these to the shared outbox; nothing else in this class knows about
    /// upload, because a failed upload must never disturb media.
    var onTranscriptSegment: ((TranscriptSegment) async -> Void)?
    var onTranscriptionStatus: ((String) -> Void)?
    /// Names beyond the roster — the team — the name pass may spell to
    ///. The roster is read off the room.
    var knownNames: [String] = []
    /// Called on the main actor when LiveKit has exhausted its own reconnects
    /// and the room went down without this device asking — never for an
    /// intentional disconnect. The host uses this to stop renewing the lease:
    /// media and the lease must not fail independently. It fires for a room
    /// the host closed too, because a room this device can no longer see must
    /// stop admitting guests either way.
    var onMediaFailure: (@MainActor (String) -> Void)?

    override init() {
        room = Room(roomOptions: RoomOptions(
            adaptiveStream: true,
            dynacast: true,
            reportRemoteTrackStatistics: true
        ))
        super.init()
        room.add(delegate: self)
        Task {
            await WorkspaceBackgrounds.refresh()
            backgroundEffect = WorkspaceBackgrounds.preferredEffect
            applyBackgroundEffect()
        }
    }

    func preparePreview() async throws {
        await WorkspaceBackgrounds.refresh()
        backgroundEffect = WorkspaceBackgrounds.preferredEffect
        guard cameraEnabled, previewTrack == nil else { return }
        guard await requestPermission(for: .video) else {
            throw StarlingsError.local(String(localized: "Allow Camera access in Settings before joining with video."))
        }
        let track = LocalVideoTrack.createCameraTrack(
            options: CameraCaptureOptions(position: cameraPosition, dimensions: .h720_169, fps: 30)
        )
        try await track.start()
        previewTrack = track
        applyBackgroundEffect()
    }

    func stopPreview() async {
        guard let previewTrack else { return }
        self.previewTrack = nil
        try? await previewTrack.stop()
    }

    /// Where a hand is written. Held from the connection because the control
    /// plane, not this phone, writes the attribute — see `MeetingHands`.
    private var handContext: (room: String, meetingID: String, artifactToken: String)?
    /// When each identity's hand went up, from participant attributes.
    private var handsByIdentity: [String: Date] = [:]

    /// `room` is the slug, which the connection details do not carry: raising a
    /// hand is a call to the control plane, and that address needs it.
    func connect(room slug: String, details: ConnectionDetails) async {
        guard phase != .connecting, phase != .connected else { return }
        // Owner connection details come from `/rooms/:slug/start`. A device
        // identified as a companion must never briefly publish the default-on
        // microphone while the participant roster catches up.
        if details.ownerIdentity != nil, details.isHost == false {
            microphoneEnabled = false
        }
        handContext = (room: slug, meetingID: details.meetingID, artifactToken: details.artifactToken)
        phase = .connecting
        intentionalDisconnect = false
        endingReason = nil
        removedByHost = false
        moderationNotice = nil
        await stopPreview()
        do {
            guard await requestPermission(for: .audio) else {
                throw StarlingsError.local(String(localized: "Allow Microphone access in Settings before joining."))
            }
            try await room.connect(url: details.serverURL, token: details.participantToken)
            try await registerChatHandler()
            if cameraEnabled {
                try await room.localParticipant.setCamera(
                    enabled: true,
                    captureOptions: CameraCaptureOptions(
                        position: cameraPosition,
                        dimensions: .h720_169,
                        fps: 30
                    )
                )
            }
            try await room.localParticipant.setMicrophone(enabled: microphoneEnabled)
            // The processor lives on the track, and joining makes a new one.
            applyBackgroundEffect()
            phase = .connected
            startDownstreamUsageReporting()
            for participant in room.remoteParticipants.values {
                for publication in participant.audioTracks {
                    attachSpatialSource(to: publication, of: participant)
                }
            }
            spatialStage.onFailure = { detail in
                StarlingsDiagnosticsLog.shared.record(
                    StarlingsError(
                        code: "spatial_audio_unavailable",
                        title: String(localized: "Spatial audio is off for this call"),
                        message: String(localized: "The audio engine stopped, so voices play through the speaker as usual."),
                        recovery: .none,
                        diagnostic: detail
                    ),
                    context: "spatial audio"
                )
            }
            spatialStage.setEnabled(SpatialAudioPreferences.isEnabled())
            armSpatialAudioPreference()
            // Seeded from the room, not only from what changes next: a phone
            // joining mid-meeting has to see the hands already up, which is the
            // whole reason a hand is an attribute rather than an event.
            readHandsFromRoom()
            publishVideos()
            updateParticipantCount()
        } catch {
            await unregisterChatHandler()
            await room.disconnect()
            phase = .failed(error.localizedDescription)
        }
    }

    /// Start transcribing this meeting on this device. Called by the host once
    /// it knows it holds the host; a guest never calls it.
    ///
    /// The models are large and CoreML compiles the encoder on first use, so
    /// preparation runs off the connect path: a meeting that starts before the
    /// recognizer is warm loses the opening seconds of speech rather than the
    /// opening seconds of media.
    func beginTranscription(
        meetingID: String,
        owner: MobileOwnerProfile,
        startedAt: Date
    ) {
        guard transcriber == nil else { return }
        let transcriber = LocalMeetingTranscriber(
            meetingID: meetingID,
            startedAt: startedAt,
            onSegment: { [weak self] segment in
                await self?.deliverTranscriptSegment(segment)
            },
            onStatus: { [weak self] status in
                await MainActor.run { self?.onTranscriptionStatus?(status) }
            }
        )
        self.transcriber = transcriber
        let localSpeaker = TranscriptionSpeaker(id: "owner:\(owner.email.lowercased())", name: owner.name)
        transcriptionLocalSpeakerID = localSpeaker.id
        microphoneExpectedSince = Date()
        audioRecoveryAttempted = false
        noAudioReported = false
        let renderer = MeetingAudioRenderer(speaker: localSpeaker, transcriber: transcriber)
        localAudioRenderer = renderer
        AudioManager.shared.add(localAudioRenderer: renderer)
        for participant in room.remoteParticipants.values {
            for publication in participant.audioTracks {
                attachTranscription(to: publication, of: participant)
            }
        }
        onTranscriptionStatus?("Preparing transcription…")
        Task { await transcriber.prepare() }
        transcriptionWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { return }
                await self?.checkTranscriptionHealth()
            }
        }
        watchAudioSession()
    }

    /// A phone call, Siri, or an AirPods route change can stop capture while
    /// LiveKit stays connected. Each one runs the stall check at
    /// once instead of on the next tick, with a fresh restart allowed. The
    /// check restarts only when capture is actually stalled, so the route
    /// change that a restart itself causes cannot loop.
    private func watchAudioSession() {
        guard audioSessionObservers.isEmpty else { return }
        let center = NotificationCenter.default
        audioSessionObservers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            MainActor.assumeIsolated {
                guard let self else { return }
                switch type {
                case .began:
                    self.audioSessionInterrupted = true
                case .ended:
                    self.audioSessionInterrupted = false
                    self.rearmAudioRecovery()
                    Task { await self.checkTranscriptionHealth() }
                @unknown default:
                    break
                }
            }
        })
        audioSessionObservers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                  reason == .newDeviceAvailable || reason == .oldDeviceUnavailable else { return }
            MainActor.assumeIsolated {
                guard let self else { return }
                self.rearmAudioRecovery()
                Task { await self.checkTranscriptionHealth() }
            }
        })
    }

    private func rearmAudioRecovery() {
        audioRecoveryAttempted = false
        noAudioReported = false
    }

    /// The Mac's check (`LiveKitMeetingSession.checkTranscriptionHealth`),
    /// on the phone. Reads when the host's own microphone last delivered a
    /// frame. One restart per stall; a restart that fails, or a stall that
    /// outlives it, tells the host.
    private func checkTranscriptionHealth() async {
        guard let transcriber,
              let speakerID = transcriptionLocalSpeakerID,
              phase == .connected,
              !isReconnecting,
              !audioSessionInterrupted,
              microphoneEnabled,
              !isCompanion else { return }
        let snapshot = await transcriber.healthSnapshot()
        guard snapshot.modelReady else { return }
        let now = Date()
        let localAudioAt = await transcriber.lastAudioAt(speakerID: speakerID)
        if TranscriptionStallCheck.isFlowing(lastLocalAudioAt: localAudioAt, now: now) {
            if noAudioReported {
                noAudioReported = false
                transcriptionNotice = nil
                onTranscriptionStatus?("")
            }
            audioRecoveryAttempted = false
            return
        }
        let expectedSince = [snapshot.modelReadyAt, microphoneExpectedSince]
            .compactMap { $0 }
            .max() ?? now
        guard TranscriptionStallCheck.isStalled(
            lastLocalAudioAt: localAudioAt,
            expectedSince: expectedSince,
            now: now
        ), !noAudioReported else { return }

        if !audioRecoveryAttempted {
            audioRecoveryAttempted = true
            onTranscriptionStatus?("Transcription is checking the microphone…")
            do {
                try await room.localParticipant.setMicrophone(enabled: false)
                try await room.localParticipant.setMicrophone(enabled: true)
                // The restart gets its own full window before the next verdict.
                microphoneExpectedSince = Date()
                return
            } catch {
                reportTranscriptionAudio(StarlingsError(
                    code: "transcription.audio_recovery_failed",
                    title: String(localized: "Transcription microphone recovery failed"),
                    message: String(localized: "Starlings couldn’t restart the microphone audio used for local transcription. Check microphone access and rejoin."),
                    recovery: .openMicrophoneSettings,
                    severity: .notice,
                    diagnostic: error.localizedDescription
                ))
                return
            }
        }
        reportTranscriptionAudio(StarlingsError(
            code: "transcription.no_audio_frames",
            title: String(localized: "Transcription is not receiving audio"),
            message: String(localized: "The meeting is connected, but no microphone audio is reaching local transcription. Check the selected microphone, then mute and unmute or rejoin."),
            recovery: .openMicrophoneSettings,
            severity: .notice
        ))
    }

    private func reportTranscriptionAudio(_ failure: StarlingsError) {
        noAudioReported = true
        StarlingsDiagnosticsLog.shared.record(failure, context: "transcription")
        onTranscriptionStatus?(failure.title)
        transcriptionNotice = MobileModerationNotice(symbol: "mic.slash", text: failure.message)
    }

    /// Publish the segment to everyone as a caption, then hand it to the host
    /// for upload. Captions failing must not stop the transcript: one is a
    /// convenience on screen, the other is the artifact.
    private func deliverTranscriptSegment(_ heard: TranscriptSegment) async {
        // Names first, so captions, the panel, the artifact and the task
        // extractor all read the same spelling.
        let segment = nameLexicon().correct(heard, isWord: MobileSpellChecker.isWord)
        do {
            let data = try JSONEncoder().encode(CaptionMessage(segment: segment))
            if data.count <= 15_000 {
                try await room.localParticipant.publish(
                    data: data,
                    options: DataPublishOptions(topic: CaptionMessage.topic, reliable: segment.isFinal)
                )
            }
        } catch {
            onTranscriptionStatus?("Captions couldn’t reach guests; the transcript is still being kept locally.")
        }
        await onTranscriptSegment?(segment)
    }

    /// The roster's spellings outrank the team's: a person is in the room
    /// under the name they gave.
    private func nameLexicon() -> TranscriptNameLexicon {
        var names = room.remoteParticipants.values.compactMap(\.name)
        if let me = room.localParticipant.name { names.append(me) }
        names.append(contentsOf: knownNames)
        return TranscriptNameLexicon(names: names)
    }

    private func attachTranscription(to publication: TrackPublication, of participant: RemoteParticipant) {
        guard let transcriber, let audioTrack = publication.track as? RemoteAudioTrack else { return }
        let sid = publication.sid.stringValue
        guard remoteAudioRenderers[sid] == nil else { return }
        let renderer = MeetingAudioRenderer(
            speaker: TranscriptionSpeaker(
                id: participant.identity?.stringValue ?? "guest:\(sid)",
                name: participant.name ?? participant.identity?.stringValue ?? String(localized: "Guest")
            ),
            transcriber: transcriber
        )
        audioTrack.add(audioRenderer: renderer)
        remoteAudioRenderers[sid] = (audioTrack, renderer)
    }

    private func detachTranscription(from publication: TrackPublication) {
        guard let binding = remoteAudioRenderers.removeValue(forKey: publication.sid.stringValue) else { return }
        binding.track.remove(audioRenderer: binding.renderer)
        binding.renderer.finish()
    }

    /// Microphones only. A share's audio has no tile to sit under and stays
    /// in LiveKit's own mix.
    private func attachSpatialSource(to publication: TrackPublication, of participant: RemoteParticipant) {
        guard publication.source == .microphone,
              let audioTrack = publication.track as? RemoteAudioTrack else { return }
        let identity = participant.identity?.stringValue ?? publication.sid.stringValue
        spatialStage.attach(
            track: audioTrack,
            sid: publication.sid.stringValue,
            person: EnvisioningIdentity.accountAddress(identity.lowercased())
        )
    }

    /// The call view reports where each remote person's tile is after every
    /// layout, keyed by account address — the same key `publishVideos` merges
    /// two devices of one person under.
    func setSpatialAudioPositions(_ positions: [String: SpatialAudioPosition]) {
        spatialStage.setPositions(positions)
    }

    /// Settings › Calls › Spatial audio, applied to the live call. The
    /// toggle is `@AppStorage`, so the signal is the defaults changing.
    private func armSpatialAudioPreference() {
        guard spatialAudioObserver == nil else { return }
        spatialAudioObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.phase == .connected else { return }
                self.spatialStage.setEnabled(SpatialAudioPreferences.isEnabled())
            }
        }
    }

    /// Become the host, or stop being it. A new host opens its
    /// microphone when `unmute` says so; a former host is muted and its
    /// transcriber drained, so none of its speech is lost or transcribed twice.
    func setHoldsHost(_ value: Bool, unmute: Bool = true) async {
        holdsHost = value
        if value {
            isCompanion = false
            guard unmute, !microphoneEnabled, phase == .connected else { return }
            microphoneEnabled = true
            do {
                try await room.localParticipant.setMicrophone(enabled: true)
            } catch {
                microphoneEnabled = false
            }
        } else {
            if microphoneEnabled, phase == .connected {
                microphoneEnabled = false
                try? await room.localParticipant.setMicrophone(enabled: false)
            }
            await drainTranscription()
        }
    }

    /// Stop the transcriber and wait for its last segments.
    func drainTranscription() async {
        guard transcriber != nil else { return }
        await endTranscription()
    }

    /// Other native devices in the call that could host, for Move host…:
    /// a Mac, an iPhone or an iPad. The Worker checks that each is an
    /// Envisioning member.
    var hostTargets: [(identity: String, name: String, device: String)] {
        guard phase == .connected else { return [] }
        return room.remoteParticipants.values.compactMap { participant in
            guard let identity = participant.identity?.stringValue,
                  !HostAttribute.isHost(participant.attributes),
                  let client = GuestClient.fromParticipantMetadata(participant.metadata),
                  client.app == .mac || client.app == .ios else { return nil }
            let device = client.app == .mac ? "Mac" : (client.device == .tablet ? "iPad" : "iPhone")
            return (identity, participant.name ?? identity, device)
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Drain rather than drop: the last seconds of speech are still in flight
    /// in the renderers when somebody presses End, and they belong in the
    /// artifact like every other second of the meeting.
    private func endTranscription() async {
        transcriptionWatchdog?.cancel()
        transcriptionWatchdog = nil
        for observer in audioSessionObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        audioSessionObservers = []
        audioSessionInterrupted = false
        transcriptionLocalSpeakerID = nil
        transcriptionNotice = nil
        rearmAudioRecovery()
        var renderers: [MeetingAudioRenderer] = []
        if let localAudioRenderer {
            AudioManager.shared.remove(localAudioRenderer: localAudioRenderer)
            localAudioRenderer.finish()
            renderers.append(localAudioRenderer)
        }
        localAudioRenderer = nil
        for binding in remoteAudioRenderers.values {
            binding.track.remove(audioRenderer: binding.renderer)
            binding.renderer.finish()
            renderers.append(binding.renderer)
        }
        remoteAudioRenderers.removeAll()
        for renderer in renderers {
            await renderer.drain()
        }
        if let transcriber {
            await transcriber.finish()
        }
        transcriber = nil
    }

    func disconnect() async {
        intentionalDisconnect = true
        stopDownstreamUsageReporting()
        flushDownstreamUsageReport()
        await endTranscription()
        await unregisterChatHandler()
        spatialStage.detachAll()
        await room.disconnect()
        videos = []
        captions = []
        chatMessages = []
        chatReactions = ChatReactionTally()
        seenChatIDs = []
        speakingIdentities = []
        participantCount = 1
        endingReason = nil
        phase = .ended
    }

    private func startDownstreamUsageReporting() {
        stopDownstreamUsageReporting()
        downstreamUsageMeter.start()
        downstreamUsageTask = Task { [weak self] in
            self?.flushDownstreamUsageReport()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(StarlingsPollingCadence.downstreamUsageReport))
                if Task.isCancelled { return }
                self?.flushDownstreamUsageReport()
            }
        }
    }

    private func stopDownstreamUsageReporting() {
        downstreamUsageTask?.cancel()
        downstreamUsageTask = nil
    }

    private func flushDownstreamUsageReport() {
        guard let handContext else { return }
        let report = downstreamUsageMeter.report(room: room)
        let api = StarlingsAPI(environment: .configured())
        Task {
            try? await api.reportDownstreamUsage(
                room: handContext.room,
                meetingID: handContext.meetingID,
                artifactToken: handContext.artifactToken,
                report: report
            )
        }
    }

    func toggleMicrophone() async {
        // A companion cannot unmute: the other device is the one holding the
        // microphone, and there is no way to mute it from here. The surface
        // says so rather than letting the button do nothing.
        guard !(isCompanion && !microphoneEnabled) else { return }
        microphoneEnabled.toggle()
        guard phase == .connected else { return }
        do {
            try await room.localParticipant.setMicrophone(enabled: microphoneEnabled)
        } catch {
            microphoneEnabled.toggle()
        }
    }

    /// Send one reaction, lossy and unbuffered.
    ///
    /// Rate-limited per sender by the shared floor, so one enthusiastic person
    /// cannot fill everybody's screen. Published unreliably on purpose: a
    /// reaction that arrives after the moment is worse than one that never
    /// arrives, so it is never retried.
    /// Read every hand currently up from the attributes the room already holds.
    /// Called on connect; changes after that arrive through the delegate.
    private func readHandsFromRoom() {
        var everyone: [Participant] = Array(room.remoteParticipants.values)
        everyone.append(room.localParticipant)
        let now = Date()
        handsByIdentity = [:]
        for participant in everyone {
            guard let identity = participant.identity?.stringValue else { continue }
            guard let at = MeetingHand.raisedAt(participant.attributes[MeetingHand.attribute]) else { continue }
            guard now.timeIntervalSince(at) < MeetingHand.staleAfter else { continue }
            handsByIdentity[identity] = at
        }
        publishHands()
    }

    private func publishHands() {
        var everyone: [Participant] = Array(room.remoteParticipants.values)
        everyone.append(room.localParticipant)
        var names: [String: String] = [:]
        for participant in everyone {
            guard let identity = participant.identity?.stringValue else { continue }
            names[identity] = participant.name ?? identity
        }
        let mine = room.localParticipant.identity?.stringValue
        raisedHands = handsByIdentity.map { identity, at in
            RaisedHand(
                identity: identity,
                name: names[identity] ?? identity,
                raisedAt: at,
                isLocal: identity == mine
            )
        }.inQueueOrder
        handRaised = mine.map { handsByIdentity[$0] != nil } ?? false
        publishVideos()
    }

    /// Raise or lower your own hand.
    ///
    /// The write goes to the control plane, which takes the identity from this
    /// meeting's token — see `MeetingHands` for why no client writes the
    /// attribute itself. Nothing is assumed locally: the control changes when
    /// the room says it did.
    /// Say a moderation action failed, in the banner the call screen already
    /// watches. Used by the host, which has no error surface of its own.
    func reportModerationFailure(_ text: String) {
        moderationNotice = MobileModerationNotice(symbol: "hand.raised.slash", text: text)
    }

    /// What a pasted link in the chat points at, read by the Worker rather
    /// than by this phone — see `LinkPreview` for why no client fetches a link
    /// itself. Authorized by the meeting, like the hand, because a guest has
    /// no account to authorize it with.
    ///
    /// Nil rather than throwing: a link that cannot be read is still a link,
    /// the message is already legible, and there is nothing the reader could
    /// do about a site that did not answer.
    func chatLinkPreview(for link: String) async -> LinkPreview? {
        guard let handContext else { return nil }
        return try? await StarlingsAPI(environment: .configured()).meetingLinkPreview(
            room: handContext.room,
            meetingID: handContext.meetingID,
            artifactToken: handContext.artifactToken,
            url: link
        )
    }

    func setOwnHand(raised: Bool) async {
        guard phase == .connected, let handContext else { return }
        do {
            try await StarlingsAPI(environment: .configured()).setOwnHand(
                room: handContext.room,
                meetingID: handContext.meetingID,
                artifactToken: handContext.artifactToken,
                raised: raised
            )
        } catch {
            moderationNotice = MobileModerationNotice(
                symbol: "hand.raised.slash",
                text: raised ? String(localized: "Couldn’t raise your hand.") : String(localized: "Couldn’t lower your hand.")
            )
        }
    }

    func sendReaction(_ reaction: MeetingReaction) async {
        guard phase == .connected else { return }
        let now = Date()
        if let lastReactionSentAt, now.timeIntervalSince(lastReactionSentAt) < MeetingReaction.minimumInterval {
            return
        }
        lastReactionSentAt = now
        show(reaction, from: room.localParticipant.name ?? String(localized: "You"))
        guard let data = try? JSONEncoder().encode(ReactionMessage(reaction)) else { return }
        try? await room.localParticipant.publish(
            data: data,
            options: DataPublishOptions(topic: MeetingReaction.topic, reliable: false)
        )
    }

    /// Put a reaction on a chat message, or take it off again.
    ///
    /// Reliable, unlike a flying reaction: this one is state, and a dropped
    /// packet would leave this phone showing a tally that stays wrong for the
    /// rest of the call. LiveKit does not echo data to its publisher, so the
    /// sender applies its own toggle — the same way it adds its own message.
    func toggleChatReaction(_ reaction: MeetingReaction, on messageID: String) async {
        guard phase == .connected else { return }
        let now = Date()
        if let lastChatReactionAt, now.timeIntervalSince(lastChatReactionAt) < ChatReaction.minimumInterval {
            return
        }
        lastChatReactionAt = now

        let identity = room.localParticipant.identity?.stringValue ?? "local"
        let on = !chatReactions.contains(identity, reaction: reaction, on: messageID)
        let packet = ChatReactionMessage(messageID: messageID, reaction: reaction, on: on)
        chatReactions.apply(packet, from: identity)
        guard let data = try? JSONEncoder().encode(packet) else { return }
        try? await room.localParticipant.publish(
            data: data,
            options: DataPublishOptions(topic: ChatReaction.topic, reliable: true)
        )
    }

    /// Whether this phone has that reaction on that message, for drawing a
    /// pill as pressed.
    func localHasChatReaction(_ reaction: MeetingReaction, on messageID: String) -> Bool {
        let identity = room.localParticipant.identity?.stringValue ?? "local"
        return chatReactions.contains(identity, reaction: reaction, on: messageID)
    }

    /// Attribution comes from the publishing participant, never from the
    /// packet: the wire body has nowhere to put somebody else's name.
    private func show(_ reaction: MeetingReaction, from sender: String) {
        reactions.append(MobileFlyingReaction(reaction: reaction, senderName: sender))
        if reactions.count > MeetingReaction.maximumOnscreen {
            reactions.removeFirst(reactions.count - MeetingReaction.maximumOnscreen)
        }
    }

    /// Called by the overlay when an emoji finishes its flight. The model drops
    /// it here rather than on a timer of its own, so nothing accumulates while
    /// the view is off screen.
    func retireReaction(_ id: UUID) {
        reactions.removeAll { $0.id == id }
    }

    /// Applies to the live camera track and to the pre-join preview alike, so
    /// what you choose before joining is what the room gets.
    func setBackgroundEffect(_ effect: MeetingBackgroundEffect) {
        backgroundEffect = effect.resolved
        WorkspaceBackgrounds.remember(effect)
        applyBackgroundEffect()
    }

    private func applyBackgroundEffect() {
        let processor = backgroundEffect.makeProcessor()
        backgroundProcessor = processor
        if let preview = previewTrack {
            preview.processor = processor
        }
        if let camera = room.localParticipant.firstCameraVideoTrack as? LocalVideoTrack {
            camera.processor = processor
        }
    }

    func toggleSelfView() {
        selfViewHidden.toggle()
    }

    /// One host moderation action. The SFU half has already happened; this is
    /// the half that keeps the controls honest and says who did it.
    ///
    /// Nothing here re-opens a microphone: a host may close one, but opening it
    /// again belongs to the person holding the phone.
    private func handleModeration(_ message: ModerationMessage) async {
        switch message.type {
        case ModerationMessage.audioMuted:
            if microphoneEnabled {
                microphoneEnabled = false
                // Also releases the capture, so iOS stops showing the recording
                // indicator for a microphone nobody can hear.
                try? await room.localParticipant.setMicrophone(enabled: false)
            }
            moderationNotice = MobileModerationNotice(
                symbol: "mic.slash.fill",
                text: "\(message.by) muted you. Unmute when you need to speak."
            )
        case ModerationMessage.participantRemoved:
            removedByHost = true
            moderationNotice = MobileModerationNotice(
                symbol: "person.fill.xmark",
                text: "\(message.by) removed you from this meeting."
            )
        default:
            // Screen sharing has no counterpart here, and an action this build
            // cannot name has nothing useful to say about itself.
            break
        }
    }

    func toggleCamera() async {
        cameraEnabled.toggle()
        if phase == .connected {
            // Blank the tile before the await: stopping the capture session
            // takes a beat, and until it returns the tile keeps showing frames
            // from a camera the button already says is off.
            publishVideos()
            do {
                try await room.localParticipant.setCamera(
                    enabled: cameraEnabled,
                    captureOptions: CameraCaptureOptions(
                        position: cameraPosition,
                        dimensions: .h720_169,
                        fps: 30
                    )
                )
                applyBackgroundEffect()
                publishVideos()
            } catch {
                cameraEnabled.toggle()
            }
        } else if cameraEnabled {
            try? await preparePreview()
        } else {
            await stopPreview()
        }
    }

    /// Naming a camera rather than flipping to it. Two positions is the whole
    /// of the phone's device list, so this is `switchCamera` with the answer
    /// already known.
    func selectCamera(position: AVCaptureDevice.Position) async {
        guard position != cameraPosition else { return }
        await switchCamera()
    }

    func switchCamera() async {
        cameraPosition = cameraPosition == .front ? .back : .front
        if phase == .connected,
           let track = room.localParticipant.firstCameraVideoTrack as? LocalVideoTrack,
           let capturer = track.capturer as? CameraCapturer {
            _ = try? await capturer.switchCameraPosition()
            return
        }
        await stopPreview()
        try? await preparePreview()
    }

    func sendChat(_ text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard phase == .connected, !trimmed.isEmpty else { return }
        guard trimmed.utf8.count <= 8_000 else {
            throw StarlingsError.local(String(localized: "Chat messages must be 8,000 bytes or shorter."))
        }
        let info = try await room.localParticipant.sendText(trimmed, for: MeetingChatMessage.topic)
        let local = room.localParticipant
        deliverChat(MeetingChatMessage(
            id: info.id,
            timestamp: Date(),
            text: trimmed,
            senderIdentity: local.identity?.stringValue ?? "local",
            senderName: local.name ?? String(localized: "You"),
            isLocal: true
        ))
    }

    private func registerChatHandler() async throws {
        try await room.registerTextStreamHandler(for: MeetingChatMessage.topic) { [weak self] reader, identity in
            let text: String
            do {
                text = try await reader.readAll()
            } catch {
                // One dropped inbound message. Nothing for the reader to act on,
                // but it should not vanish without a trace either (the Mac rule).
                NSLog("Meet chat message dropped: %@", error.localizedDescription)
                return
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            await MainActor.run {
                guard let self else { return }
                let participant = self.room.remoteParticipants[identity]
                self.deliverChat(MeetingChatMessage(
                    id: reader.info.id,
                    timestamp: reader.info.timestamp,
                    text: trimmed,
                    senderIdentity: identity.stringValue,
                    senderName: participant?.name ?? identity.stringValue,
                    isLocal: false
                ))
            }
        }
    }

    private func unregisterChatHandler() async {
        await room.unregisterTextStreamHandler(for: MeetingChatMessage.topic)
    }

    private func deliverChat(_ message: MeetingChatMessage) {
        guard seenChatIDs.insert(message.id).inserted else { return }
        if seenChatIDs.count > 500 { seenChatIDs.removeAll(keepingCapacity: true) }
        chatMessages.append(message)
    }

    /// Everyone in the room gets a tile, camera or no camera — the same shape
    /// the Mac stage publishes. A tile that vanished when its owner turned the
    /// camera off would make your own camera button look like it had dropped
    /// you from the meeting, and would hide who else is still listening.
    private func publishVideos() {
        guard phase == .connected else {
            videos = []
            return
        }
        var next: [MobileVideo] = []
        let localIdentity = room.localParticipant.identity?.stringValue ?? ""
        // One person, one camera tile. An owner in the room from two devices is
        // two LiveKit participants on purpose — LiveKit evicts a duplicate
        // identity — so `mz+mac@…` and `mz+iphone@…` collapse back to `mz@…`
        // here. Your own tile always wins for you; shares never merge, because
        // a share from someone's second device is another thing to look at.
        var cameraIndexByPerson: [String: Int] = [
            EnvisioningIdentity.accountAddress(localIdentity.lowercased()): 0,
        ]
        // Read the track's own mute state rather than trusting `cameraEnabled`:
        // a mute this app did not initiate must blank the tile too.
        let localCamera = room.localParticipant.firstCameraVideoTrack
        next.append(MobileVideo(
            id: "__local__",
            person: "",
            track: cameraEnabled && localCamera?.isMuted == false ? localCamera : nil,
            name: room.localParticipant.name ?? String(localized: "You"),
            isLocal: true,
            isScreenShare: false,
            isSpeaking: speakingIdentities.contains(localIdentity),
            handRaised: handsByIdentity[localIdentity] != nil,
            isHost: HostAttribute.isHost(room.localParticipant.attributes),
            quality: MeetingConnectionQuality(room.localParticipant.connectionQuality),
            recording: false,
            onBehalfOf: nil
        ))
        for participant in room.remoteParticipants.values {
            let identity = participant.identity?.stringValue
                ?? participant.sid?.stringValue
                ?? "remote"
            let camera = participant.videoTracks.first { $0.source == Track.Source.camera }
            let person = EnvisioningIdentity.accountAddress(identity.lowercased())
            let consent = GuestClient.consentFromParticipantMetadata(participant.metadata)
            let cameraTile = MobileVideo(
                id: "\(identity):camera",
                person: person,
                track: camera?.isMuted == false ? camera?.track as? VideoTrack : nil,
                name: participant.name ?? identity,
                isLocal: false,
                isScreenShare: false,
                isSpeaking: speakingIdentities.contains(identity),
                handRaised: handsByIdentity[identity] != nil,
                isHost: HostAttribute.isHost(participant.attributes),
                quality: MeetingConnectionQuality(participant.connectionQuality),
                recording: consent != nil,
                onBehalfOf: consent?.onBehalfOf
            )
            if let kept = cameraIndexByPerson[person] {
                // Another device of somebody already on the stage: keep the one
                // with a live camera, and prefer the one that is speaking.
                let existing = next[kept]
                if !existing.isLocal {
                    let replaces = (cameraTile.track != nil && existing.track == nil)
                        || (cameraTile.isSpeaking && !existing.isSpeaking
                            && (cameraTile.track != nil) == (existing.track != nil))
                    if replaces { next[kept] = cameraTile }
                }
            } else {
                cameraIndexByPerson[person] = next.count
                next.append(cameraTile)
            }
            // A paused share is not a share: drop the tile rather than leave a
            // frozen desktop on the stage.
            let shares = participant.videoTracks.filter {
                $0.source == Track.Source.screenShareVideo && !$0.isMuted
            }
            for publication in shares {
                guard let track = publication.track as? VideoTrack else { continue }
                next.append(MobileVideo(
                    id: "\(identity):screen:\(publication.sid.stringValue)",
                    person: person,
                    track: track,
                    name: participant.name ?? identity,
                    isLocal: false,
                    isScreenShare: true,
                    isSpeaking: false,
                    // A screen has no hand: the badge belongs to the person.
                    handRaised: false,
                    isHost: false,
                    quality: MeetingConnectionQuality(participant.connectionQuality),
                    recording: consent != nil,
                    onBehalfOf: consent?.onBehalfOf
                ))
            }
        }
        videos = next.sorted {
            if $0.isScreenShare != $1.isScreenShare { return $0.isScreenShare }
            if $0.isLocal != $1.isLocal { return $0.isLocal }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    /// You first, then everybody else by name — the same order the Mac's
    /// quality menu uses, so the list does not reshuffle as people come and go.
    private func refreshQuality() {
        guard phase == .connected else {
            quality = []
            return
        }
        let local = room.localParticipant
        var rows = [MobileParticipantQuality(
            id: local.identity?.stringValue ?? "local",
            name: local.name ?? String(localized: "You"),
            isLocal: true,
            quality: local.connectionQuality,
            isSharingScreen: local.videoTracks.contains { $0.source == Track.Source.screenShareVideo },
            client: GuestClient.fromParticipantMetadata(local.metadata),
            recording: GuestClient.consentFromParticipantMetadata(local.metadata) != nil,
            onBehalfOf: GuestClient.consentFromParticipantMetadata(local.metadata)?.onBehalfOf,
            registered: GuestClient.isRegisteredParticipant(local.metadata)
        )]
        rows.append(contentsOf: room.remoteParticipants.values.map { participant in
            MobileParticipantQuality(
                id: participant.identity?.stringValue
                    ?? participant.sid?.stringValue
                    ?? "unknown-participant",
                name: participant.name ?? participant.identity?.stringValue ?? String(localized: "Guest"),
                isLocal: false,
                quality: participant.connectionQuality,
                isSharingScreen: participant.videoTracks.contains {
                    $0.source == Track.Source.screenShareVideo && !$0.isMuted
                },
                client: GuestClient.fromParticipantMetadata(participant.metadata),
                recording: GuestClient.consentFromParticipantMetadata(participant.metadata) != nil,
                onBehalfOf: GuestClient.consentFromParticipantMetadata(participant.metadata)?.onBehalfOf,
                registered: GuestClient.isRegisteredParticipant(participant.metadata)
            )
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending })
        quality = rows
    }

    /// People, not connections — two devices of one person are one participant.
    private func updateParticipantCount() {
        let me = EnvisioningIdentity.accountAddress(
            (room.localParticipant.identity?.stringValue ?? "local").lowercased()
        )
        var people: Set<String> = [me]
        var meTwice = false
        for participant in room.remoteParticipants.values {
            let identity = participant.identity?.stringValue
                ?? participant.sid?.stringValue
                ?? UUID().uuidString
            let person = EnvisioningIdentity.accountAddress(identity.lowercased())
            if person == me { meTwice = true }
            people.insert(person)
        }
        participantCount = people.count
        applyCompanionRule(meTwice)
    }

    /// Arriving where you already are makes this device the companion. Leaving
    /// companion does not unmute on its own: the other device dropping out is
    /// not a reason to start broadcasting a room somebody walked away from.
    private func applyCompanionRule(_ meTwice: Bool) {
        let companion = meTwice && !holdsHost
        guard companion != isCompanion else { return }
        isCompanion = companion
        guard companion, microphoneEnabled else { return }
        microphoneEnabled = false
        Task { [room] in
            try? await room.localParticipant.setMicrophone(enabled: false)
        }
    }

    private func requestPermission(for mediaType: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: mediaType) {
        case .authorized: true
        case .notDetermined: await AVCaptureDevice.requestAccess(for: mediaType)
        default: false
        }
    }
}

extension MobileGuestSession: RoomDelegate {
    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant?,
        didReceiveData data: Data,
        forTopic topic: String,
        encryptionType: EncryptionType
    ) {
        if topic == MeetingReaction.topic {
            guard let message = try? JSONDecoder().decode(ReactionMessage.self, from: data),
                  let reaction = message.reaction else { return }
            let sender = participant?.name ?? participant?.identity?.stringValue ?? String(localized: "Someone")
            Task { @MainActor [weak self] in self?.show(reaction, from: sender) }
            return
        }
        if topic == ChatReaction.topic {
            // Same rule as a flying reaction: participant-published, and the
            // payload carries no name, so the sender is the whole of the
            // attribution. `ChatReactionMessage` drops anything malformed or
            // outside the palette.
            guard let identity = participant?.identity?.stringValue,
                  let message = try? JSONDecoder().decode(ChatReactionMessage.self, from: data) else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.chatReactions.apply(message, from: identity)
            }
            return
        }
        if topic == HostMessageWire.topic {
            // Server-sent only, like moderation: a packet with a sender is a
            // participant forging the topic and never moves the host.
            guard participant == nil,
                  let message = try? JSONDecoder().decode(HostMessageWire.self, from: data),
                  message.version == 1 else { return }
            Task { @MainActor [weak self] in
                await self?.onHostMessage?(message)
            }
            return
        }
        if topic == ModerationMessage.topic {
            // Server-sent only: the control plane publishes these through
            // RoomService, so the packet arrives with nobody behind it. One
            // that carries a sender is a guest forging the topic.
            guard participant == nil,
                  let message = try? JSONDecoder().decode(ModerationMessage.self, from: data),
                  message.version == 1 else { return }
            Task { @MainActor [weak self] in
                await self?.handleModeration(message)
            }
            return
        }
        guard topic == CaptionMessage.topic,
              CaptionMessage.acceptsPublisherIdentity(participant?.identity?.stringValue),
              let message = try? JSONDecoder().decode(CaptionMessage.self, from: data),
              message.version == 1 else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.captions.removeAll { $0.id == message.segment.id }
            self.captions.append(message.segment)
            // The same 500 the Mac panel and the web keep; the
            // strip over the stage reads only the last line.
            let limit = CaptionMessage.historyLineLimit
            if self.captions.count > limit { self.captions.removeFirst(self.captions.count - limit) }
        }
    }

    nonisolated func room(
        _ room: Room,
        participant: LocalParticipant,
        didPublishTrack publication: LocalTrackPublication
    ) {
        Task { @MainActor [weak self] in self?.publishVideos() }
    }

    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant,
        didSubscribeTrack publication: RemoteTrackPublication
    ) {
        Task { @MainActor [weak self] in
            self?.publishVideos()
            self?.updateParticipantCount()
            // Every voice in the room reaches the recognizer, which is what
            // makes the transcript say who said what. No-op unless this device
            // holds the host.
            self?.attachTranscription(to: publication, of: participant)
            self?.attachSpatialSource(to: publication, of: participant)
        }
    }

    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant,
        didUnsubscribeTrack publication: RemoteTrackPublication
    ) {
        Task { @MainActor [weak self] in
            self?.publishVideos()
            self?.detachTranscription(from: publication)
            self?.spatialStage.detach(sid: publication.sid.stringValue)
        }
    }

    /// Turning a camera off mutes the track and stops the frames; the
    /// publication stays subscribed. This is the only notice a tile gets that
    /// it should stop showing video — and, for the local microphone, the signal
    /// of record for what the mic button should say, including a mute this app
    /// did not initiate.
    nonisolated func room(
        _ room: Room,
        participant: Participant,
        trackPublication: TrackPublication,
        didUpdateIsMuted isMuted: Bool
    ) {
        if participant is LocalParticipant, trackPublication.source == .microphone {
            Task { @MainActor [weak self] in self?.microphoneEnabled = !isMuted }
            return
        }
        guard trackPublication.kind == .video else { return }
        Task { @MainActor [weak self] in self?.publishVideos() }
    }

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor [weak self] in
            self?.publishVideos()
            self?.updateParticipantCount()
        }
    }

    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue
        Task { @MainActor [weak self] in
            guard let self else { return }
            // A hand belongs to somebody in the room; leaving lowers it.
            if let identity, handsByIdentity.removeValue(forKey: identity) != nil {
                publishHands()
            }
            publishVideos()
            updateParticipantCount()
        }
    }

    /// A hand went up or came down. Attributes are what carry it to a phone
    /// that joined after the raise, and across a reconnect.
    nonisolated func room(
        _ room: Room,
        participant: Participant,
        didUpdateAttributes attributes: [String: String]
    ) {
        let identity = participant.identity?.stringValue
        let raisedAt = MeetingHand.raisedAt(attributes[MeetingHand.attribute])
        Task { @MainActor [weak self] in
            guard let self, let identity else { return }
            if let raisedAt, Date().timeIntervalSince(raisedAt) < MeetingHand.staleAfter {
                handsByIdentity[identity] = raisedAt
            } else {
                handsByIdentity.removeValue(forKey: identity)
            }
            publishHands()
            // The Host badge rides the same attribute update.
            publishVideos()
        }
    }

    nonisolated func room(
        _ room: Room,
        participant: Participant,
        didUpdateConnectionQuality quality: ConnectionQuality
    ) {
        Task { @MainActor [weak self] in
            self?.publishVideos()
            self?.refreshQuality()
        }
    }

    /// Reconnecting is not disconnected. The panel says which one it is, so a
    /// held lift ride does not read as a meeting that ended.
    nonisolated func room(
        _ room: Room,
        didUpdateConnectionState connectionState: ConnectionState,
        from oldConnectionState: ConnectionState
    ) {
        Task { @MainActor [weak self] in
            self?.isReconnecting = connectionState == .reconnecting
            self?.refreshQuality()
        }
    }

    nonisolated func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        let identities = Set(participants.compactMap { $0.identity?.stringValue })
        Task { @MainActor [weak self] in
            self?.speakingIdentities = identities
            self?.publishVideos()
        }
    }

    /// Reached only after the SDK has exhausted its own reconnects, so there
    /// is nothing left to retry quietly. What splits the two phases is who
    /// decided: a room the host closed, or a seat the host took away, is an
    /// *ending* and says why; anything else is a connection that died under a
    /// meeting that was working. The Mac draws the same line through
    /// `StarlingsError.liveKit`, the browser through `ownerClosedTheRoom`.
    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        let ending = Self.ending(for: error)
        Task { @MainActor [weak self] in
            guard let self, !self.intentionalDisconnect else { return }
            self.stopDownstreamUsageReporting()
            self.flushDownstreamUsageReport()
            await self.unregisterChatHandler()
            self.videos = []
            self.endingReason = ending.reason
            switch ending {
            case .closed: self.phase = .ended
            case .lost(let reason): self.phase = .failed(reason)
            }
            self.onMediaFailure?(ending.reason)
        }
    }

    /// A disconnect nobody on this phone asked for, split by who decided it.
    private enum Ending {
        /// The room closed this seat on purpose. The meeting is over here.
        case closed(String)
        /// The connection died under a meeting that was working.
        case lost(String)

        var reason: String {
            switch self {
            case .closed(let reason), .lost(let reason): reason
            }
        }
    }

    /// The wording the Mac already gives these same LiveKit reasons in
    /// `StarlingsError.liveKit` — the raw `localizedDescription` is "Room deleted".
    private nonisolated static func ending(for error: LiveKitError?) -> Ending {
        guard let type = error?.type else {
            return .lost("The connection to the meeting was lost.")
        }
        switch type {
        case .roomDeleted:
            return .closed("The host ended this meeting.")
        case .participantRemoved:
            return .closed("The host removed you from this meeting.")
        case .duplicateIdentity:
            return .lost("This account joined from another device, and that one has the meeting now.")
        case .serverShutdown:
            return .lost("The meeting server restarted. Joining again should get you back in.")
        default:
            return .lost("The connection to the meeting was lost.")
        }
    }
}
