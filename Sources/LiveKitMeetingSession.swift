import AVFoundation
import Foundation
import LiveKit
import StarlingsContracts

@MainActor
final class LiveKitMeetingSession: NSObject, MeetingSession {
    private(set) var phase: MeetingPhase = .setup {
        didSet { onPhaseChange?(phase) }
    }

    var onPhaseChange: ((MeetingPhase) -> Void)?
    var onLocalVideoTrack: ((VideoTrack?) -> Void)?
    var onLocalScreenShareTrack: ((VideoTrack?) -> Void)?
    var onLocalSpeakingChange: ((Bool) -> Void)?
    var onRemoteVideosChange: (([MeetingRemoteVideo]) -> Void)?
    var onRaisedHandsChange: (([RaisedHand]) -> Void)?
    var onLocalHandRaisedChange: ((Bool) -> Void)?
    var onParticipantCountChange: ((Int) -> Void)?
    /// A person arrived or left, by name — people, not devices, the same fold
    /// `updateParticipantCount` makes. Fed to VoiceOver; the count above is
    /// what the stage draws.
    var onParticipantArrived: ((String) -> Void)?
    var onParticipantLeft: ((String) -> Void)?
    var onConnectionQualityChange: (([MeetingParticipantQuality]) -> Void)?
    var onBandwidthChange: ((MeetingBandwidthSnapshot) -> Void)?
    var onMeetingContext: ((MeetingContext) -> Void)?
    var onHostStateChange: ((Bool, String?) -> Void)?
    var onHostReleaseRequested: (() async -> Void)?
    var onHostOffered: ((String?) async -> Void)?
    var localIdentity: String? { room.localParticipant.identity?.stringValue }
    var onTranscriptSegment: ((TranscriptSegment) async -> Void)?
    /// Names beyond the roster — the team, the calendar's invitees — that the
    /// name pass may spell to. The roster is read off the room.
    var knownNames: [String] = []
    /// The spell checker the name pass asks before touching a word.
    var wordChecker: TranscriptNameLexicon.WordChecker?
    var onTranscriptionStatus: ((String) -> Void)?
    var onChatMessage: ((MeetingChatMessage) -> Void)?
    var onReaction: ((MeetingReaction, String) -> Void)?
    /// The tally changed. Passed whole rather than as a delta: a chat row
    /// draws what is on its message now, and a client that missed one delta
    /// would stay wrong until the next one.
    var onChatReactionsChange: ((ChatReactionTally) -> Void)?
    var onScreenShareStoppedByHost: ((String) -> Void)?
    var onMicrophoneMutedByHost: ((String) -> Void)?
    var onRemovedByHost: ((String) -> Void)?
    var onMicrophoneEnabledChange: ((Bool) -> Void)?
    var onLocalScreenShareEnabledChange: ((Bool) -> Void)?
    var onNonFatalError: ((StarlingsError) -> Void)?

    private let room: Room
    private let roomOptions: RoomOptions
    private let connectionDetailsProvider: ConnectionDetailsProviding
    private var isIntentionalDisconnect = false
    private var ownerIdentity: String?
    private var hostIdentity: String?
    private var holdsHost = false
    private var microphoneEnabledBeforeHostRelease: Bool?
    private var hostTransition: Task<Void, Never>?
    private var activeConfiguration: MeetingConfiguration?
    private var activeMeetingID: String?
    private var activeMeetingStartedAt: Date?
    /// Set when the host removes this Mac, so the disconnect that follows a
    /// moment later reads as an ending rather than a connection failure worth
    /// retrying. Cleared on the next connect.
    private var removedByHost: String?
    private var preferredCameraID: String?
    private var preferredMicrophoneID: String?
    private var preferredSpeakerID: String?
    /// The speaker switch made once per call when the first remote voice
    /// starts playout. See ``reassertSpeakerForPlayout()``.
    private var speakerReassertTask: Task<Void, Never>?
    private var speakerReassertedForPlayout = false
    private var speakingIdentities: Set<String> = []
    /// When each identity's hand went up. Read from participant attributes,
    /// which is why a hand survives a reconnect and reaches a late joiner —
    /// see `MeetingHands`.
    private var handsByIdentity: [String: Date] = [:]
    /// Remote people by address, with the name each was last seen under.
    private var knownPeople: [String: String]?
    private var remoteVideoTracks: [Track.Sid: RemoteVideo] = [:]
    private var remoteAudioRenderers: [Track.Sid: RemoteAudioBinding] = [:]
    private var localAudioRenderer: MeetingAudioRenderer?
    /// Every remote microphone on the arc, whether or not this Mac transcribes.
    private let spatialStage = SpatialAudioStage()
    private var spatialAudioWanted = SpatialAudioPreferences.isEnabled()
    private var transcriber: LocalMeetingTranscriber?
    private var transcriptionPreparationTask: Task<Void, Never>?
    private var transcriptionWatchdogTask: Task<Void, Never>?
    private var transcriptionHealthSnapshot: LocalTranscriptionHealthSnapshot?
    private var transcriptionMicrophoneExpected = false {
        didSet {
            if transcriptionMicrophoneExpected, !oldValue {
                transcriptionMicrophoneExpectedSince = Date()
            }
        }
    }
    /// When the microphone last became expected, or last restarted. Frames
    /// from before that say nothing about capture now (`TranscriptionStallCheck`).
    private var transcriptionMicrophoneExpectedSince: Date?
    /// The host's own speaker id, whose frames the stall check reads.
    private var transcriptionLocalSpeakerID: String?
    private var transcriptionNoAudioIssueReported = false
    private var transcriptionAudioRecoveryAttempted = false
    private var transcriptionIsEnding = false
    private var backgroundEffectProcessor: (any LiveKit.VideoProcessor)?
    private var backgroundEffect: MeetingBackgroundEffect = .none
    private let qualityTracker = MeetingQualityTracker()
    private let bandwidthSampler = MeetingBandwidthSampler()
    private let downstreamUsageMeter = MeetingDownstreamUsageMeter()
    private var debugContext: MeetingBandwidthDebugContext?
    /// Dedupes `lk.chat` text streams against legacy `lk-chat-topic` packets (web sends both).
    private var seenChatMessageIDs: Set<String> = []
    /// Who has which emoji on which chat message. Lives as long as the call.
    private var chatReactions = ChatReactionTally()
    /// Per-sender floor between toggles, so a held key cannot flood the topic.
    private var lastChatReactionAt = Date.distantPast

    init(connectionDetailsProvider: ConnectionDetailsProviding = HTTPConnectionDetailsProvider()) {
        self.connectionDetailsProvider = connectionDetailsProvider
        // Both default to false in the SDK. Without adaptiveStream every tile
        // subscribes to the highest simulcast layer regardless of how small it
        // is drawn, which burns decode CPU on weaker Macs and multiplies the
        // metered downstream bandwidth. dynacast stops publishing layers that
        // nobody is subscribed to. Safe here because every track is rendered
        // through a LiveKit `VideoView`, which reports its size to the SDK.
        // reportRemoteTrackStatistics turns on the ~1s WebRTC stats timer for
        // local and remote tracks (needed for the live ↑↓ bandwidth readout).
        // The SDK default share is 1080p30 at 5 Mbps with no simulcast
        // layers, so nothing can step it down for a slow receiver, and on a
        // weak uplink it starves the sharer's own audio. Screens are mostly
        // static; 15 fps at 2 Mbps keeps text sharp and leaves headroom.
        let options = RoomOptions(
            defaultScreenShareCaptureOptions: ScreenShareCaptureOptions(
                dimensions: .h1080_169,
                fps: 15
            ),
            defaultVideoPublishOptions: VideoPublishOptions(
                screenShareEncoding: VideoEncoding(maxBitrate: 2_000_000, maxFps: 15)
            ),
            adaptiveStream: true,
            dynacast: true,
            reportRemoteTrackStatistics: true
        )
        roomOptions = options
        room = Room(roomOptions: options)
        super.init()
        room.add(delegate: self)
        bandwidthSampler.onChange = { [weak self] snapshot in
            self?.onBandwidthChange?(snapshot)
        }
    }

    func connect(configuration: MeetingConfiguration, entry: MeetingEntry) async {
        guard phase != .connecting, phase != .connected else { return }
        phase = .connecting
        isIntentionalDisconnect = false
        removedByHost = nil
        preferredCameraID = configuration.cameraID
        activeConfiguration = configuration
        ownerIdentity = nil
        hostIdentity = nil
        holdsHost = false
        microphoneEnabledBeforeHostRelease = nil
        speakingIdentities = []
        handsByIdentity = [:]
        knownPeople = nil
        chatReactions = ChatReactionTally()

        do {
            let details: ConnectionDetails
            switch entry {
            case .host:
                guard configuration.role == .host else { throw StarlingsError.invalidEntry }
                details = try await connectionDetailsProvider.connectionDetails(for: configuration)
            case .admittedGuest(let admitted):
                guard configuration.role == .guest else { throw StarlingsError.invalidEntry }
                details = admitted
            }
            ownerIdentity = details.ownerIdentity
            hostIdentity = details.hostIdentity
            holdsHost = configuration.role == .host && (details.isHost ?? true)
            activeMeetingID = details.meetingID
            activeMeetingStartedAt = details.startedDate
            onMeetingContext?(MeetingContext(
                room: configuration.room,
                meetingID: details.meetingID,
                artifactToken: details.artifactToken,
                role: configuration.role,
                startedAt: details.startedDate,
                ownerIdentity: ownerIdentity,
                hostIdentity: hostIdentity
            ))
            onHostStateChange?(holdsHost, hostIdentity)
            debugContext = MeetingBandwidthDebugContext(
                roomSlug: configuration.room.rawValue,
                meetingID: details.meetingID,
                liveKitURL: details.serverURL,
                role: configuration.role == .host ? "host" : "guest"
            )
            selectMicrophone(id: configuration.microphoneID)
            selectSpeaker(id: configuration.speakerID)

            // Reaching the SFU and publishing to it fail for entirely different
            // reasons — an unreachable server versus a camera another app is
            // holding. They used to share one catch, so both read "Timed out".
            let connectStartedAt = Date()
            do {
                try await room.connect(url: details.serverURL, token: details.participantToken)
            } catch {
                throw StarlingsError.liveKit(error, stage: .connect, elapsed: Date().timeIntervalSince(connectStartedAt))
            }

            if configuration.role == .host, holdsHost, !configuration.isWalkUp {
                beginLocalTranscription(
                    meetingID: details.meetingID,
                    owner: configuration.identity,
                    roomStartedAt: details.startedDate,
                    microphoneEnabled: configuration.microphoneEnabled
                )
            } else if configuration.isWalkUp {
                onTranscriptionStatus?("Not transcribing — someone walked up")
            } else {
                onTranscriptionStatus?("Shared captions from the host Mac")
            }

            do {
                try await setCamera(enabled: configuration.cameraEnabled)
            } catch {
                throw StarlingsError.liveKit(error, stage: .camera)
            }
            // The platform audio module resolves its input to macOS's default
            // first. Select Meet's device before the publication creates its
            // capture track; applying it only afterwards can leave the
            // published track on that default.
            let microphoneEnabled = configuration.role == .host
                ? holdsHost && configuration.microphoneEnabled
                : configuration.microphoneEnabled
            if microphoneEnabled {
                applyPreferredMicrophone()
            }
            do {
                try await room.localParticipant.setMicrophone(enabled: microphoneEnabled)
            } catch {
                throw StarlingsError.liveKit(error, stage: .microphone)
            }
            // Publishing may initialize/reconfigure the platform module once
            // more, so make the post-publication route explicit as well.
            applyPreferredMicrophone()
            speakerReassertedForPlayout = false
            applyPreferredSpeaker()
            if !configuration.cameraEnabled {
                onLocalVideoTrack?(nil)
            }

            // Chat rides the data channel. Losing it is not a reason to keep
            // someone out of a meeting whose audio and video are already up, so
            // this one degrades instead of failing the join.
            do {
                try await registerChatHandler()
            } catch {
                let failure = StarlingsError.liveKit(error, stage: .chat)
                StarlingsDiagnosticsLog.shared.record(failure, context: "chat unavailable")
                onNonFatalError?(failure)
            }

            phase = .connected
            onMicrophoneEnabledChange?(microphoneEnabled)
            qualityTracker.start()
            downstreamUsageMeter.start()
            bandwidthSampler.start(room: room)
            // A remote track may have subscribed while `room.connect` was
            // still completing, before the transcription renderer existed.
            // Re-scan after the whole connection is established so that race
            // cannot leave an audible participant permanently untranscribed.
            attachSubscribedRemoteAudioRenderers()
            attachSubscribedSpatialSources()
            if hasSubscribedRemoteAudio() {
                reassertSpeakerForPlayout()
            }
            spatialStage.onFailure = { [weak self] detail in
                let failure = StarlingsError(
                    code: "spatial_audio_unavailable",
                    title: String(localized: "Spatial audio is off for this call"),
                    message: String(localized: "The audio engine stopped, so voices play through the speaker as usual."),
                    recovery: .none,
                    diagnostic: detail
                )
                StarlingsDiagnosticsLog.shared.record(failure, context: "spatial audio")
                self?.onNonFatalError?(failure)
            }
            spatialStage.setEnabled(spatialAudioWanted)
            // Seeded from the room rather than only from later changes: a host
            // opening the app mid-meeting has to see the hands already up, and
            // that is the whole reason a hand is an attribute rather than an
            // event. `didUpdateAttributes` only ever reports what changes next.
            readHandsFromRoom()
            publishRemoteVideos()
            publishConnectionQuality()
            updateParticipantCount()
        } catch {
            let failure = StarlingsError.liveKit(error, stage: .connect)
            StarlingsDiagnosticsLog.shared.record(failure, context: "connection failed")
            await endLocalTranscription()
            await unregisterChatHandler()
            backgroundEffectProcessor = nil
            backgroundEffect = .none
            bandwidthSampler.stop()
            debugContext = nil
            await room.disconnect()
            preferredCameraID = nil
            activeConfiguration = nil
            activeMeetingID = nil
            activeMeetingStartedAt = nil
            ownerIdentity = nil
            hostIdentity = nil
            holdsHost = false
            microphoneEnabledBeforeHostRelease = nil
            transcriptionHealthSnapshot = nil
            transcriptionMicrophoneExpected = false
            transcriptionNoAudioIssueReported = false
            transcriptionAudioRecoveryAttempted = false
            speakingIdentities = []
            handsByIdentity = [:]
            knownPeople = nil
            seenChatMessageIDs.removeAll()
            qualityTracker.reset()
            onConnectionQualityChange?([])
            phase = .failed(failure)
        }
    }

    func disconnect() async {
        isIntentionalDisconnect = true
        await endLocalTranscription()
        await unregisterChatHandler()
        // Freeze the counters but keep them readable so the caller can post a
        // final report after the room is gone. `start()` clears them again.
        qualityTracker.stop()
        bandwidthSampler.stop()
        onConnectionQualityChange?([])
        spatialStage.detachAll()
        speakerReassertTask?.cancel()
        speakerReassertTask = nil
        await room.disconnect()
        remoteVideoTracks.removeAll()
        transcriptionHealthSnapshot = nil
        transcriptionMicrophoneExpected = false
        transcriptionNoAudioIssueReported = false
        transcriptionAudioRecoveryAttempted = false
        speakingIdentities = []
        handsByIdentity = [:]
        knownPeople = nil
        seenChatMessageIDs.removeAll()
        preferredCameraID = nil
        activeConfiguration = nil
        activeMeetingID = nil
        activeMeetingStartedAt = nil
        ownerIdentity = nil
        hostIdentity = nil
        holdsHost = false
        microphoneEnabledBeforeHostRelease = nil
        backgroundEffectProcessor = nil
        backgroundEffect = .none
        debugContext = nil
        onLocalVideoTrack?(nil)
        onLocalScreenShareTrack?(nil)
        onLocalScreenShareEnabledChange?(false)
        onLocalSpeakingChange?(false)
        publishRemoteVideos()
        phase = .ended
    }

    /// Stop local capture and drain transcription while this Mac still holds
    /// the server host. The caller flushes the text outbox before releasing it.
    func prepareForHostRelease() async {
        guard holdsHost else { return }
        microphoneEnabledBeforeHostRelease = room.localParticipant.isMicrophoneEnabled()
        if room.localParticipant.isMicrophoneEnabled() {
            _ = try? await room.localParticipant.setMicrophone(enabled: false)
        }
        transcriptionMicrophoneExpected = false
        onMicrophoneEnabledChange?(false)
        await endLocalTranscription()
    }

    func resumeHostAfterReleaseFailure() async {
        guard holdsHost, phase == .connected, let configuration = activeConfiguration else { return }
        let microphoneEnabled = microphoneEnabledBeforeHostRelease ?? configuration.microphoneEnabled
        if !configuration.isWalkUp, transcriber == nil, let activeMeetingID {
            beginLocalTranscription(
                meetingID: activeMeetingID,
                owner: configuration.identity,
                roomStartedAt: activeMeetingStartedAt ?? Date(),
                microphoneEnabled: microphoneEnabled
            )
        }
        do {
            try await setMicrophone(enabled: microphoneEnabled)
            microphoneEnabledBeforeHostRelease = nil
        } catch {
            onNonFatalError?(StarlingsError.liveKit(error, stage: .microphone))
        }
    }

    /// Apply the host state after a server message or a lobby refresh. A new
    /// host starts local transcription before opening its microphone; a
    /// companion is muted before its transcriber drains.
    ///
    /// Transitions run one at a time, in order: a lobby refresh or a server
    /// message that lands while a companion drains its transcriber waits for
    /// that drain, and is then applied, not dropped.
    func setHost(enabled: Bool) async {
        let previous = hostTransition
        let transition = Task { @MainActor [weak self] in
            await previous?.value
            await self?.applyHost(enabled: enabled)
        }
        hostTransition = transition
        await transition.value
    }

    private func applyHost(enabled: Bool) async {
        guard phase == .connected, activeConfiguration?.role == .host else { return }
        guard holdsHost != enabled else {
            onHostStateChange?(holdsHost, hostIdentity)
            return
        }
        if enabled {
            holdsHost = true
            hostIdentity = ownerIdentity
            if let configuration = activeConfiguration,
               !configuration.isWalkUp,
               let activeMeetingID {
                beginLocalTranscription(
                    meetingID: activeMeetingID,
                    owner: configuration.identity,
                    roomStartedAt: activeMeetingStartedAt ?? Date(),
                    microphoneEnabled: configuration.microphoneEnabled
                )
            }
            do {
                try await setMicrophone(enabled: activeConfiguration?.microphoneEnabled ?? true)
            } catch {
                onNonFatalError?(StarlingsError.liveKit(error, stage: .microphone))
            }
        } else {
            if room.localParticipant.isMicrophoneEnabled() {
                _ = try? await room.localParticipant.setMicrophone(enabled: false)
            }
            transcriptionMicrophoneExpected = false
            onMicrophoneEnabledChange?(false)
            await endLocalTranscription()
            holdsHost = false
            microphoneEnabledBeforeHostRelease = nil
        }
        onHostStateChange?(holdsHost, hostIdentity)
    }

    func updateHost(identity: String?) async {
        guard activeConfiguration?.role == .host else { return }
        hostIdentity = identity
        await setHost(enabled: identity != nil && identity == ownerIdentity)
    }

    private func beginLocalTranscription(
        meetingID: String,
        owner: MeetingIdentity,
        roomStartedAt: Date,
        microphoneEnabled: Bool
    ) {
        transcriptionHealthSnapshot = nil
        transcriptionMicrophoneExpected = microphoneEnabled
        transcriptionNoAudioIssueReported = false
        transcriptionAudioRecoveryAttempted = false
        transcriptionIsEnding = false
        let transcriber = LocalMeetingTranscriber(
            meetingID: meetingID,
            startedAt: roomStartedAt,
            onSegment: { [weak self] segment in
                await self?.deliverTranscriptSegment(segment)
            },
            onStatus: { [weak self] status in
                await MainActor.run { self?.onTranscriptionStatus?(status) }
            },
            onFailure: { [weak self] diagnostic in
                await MainActor.run {
                    guard let self else { return }
                    let failure = StarlingsError(
                        code: "transcription.engine_failed",
                        title: String(localized: "Transcription unavailable"),
                        message: String(localized: "The meeting is still connected, but local transcription is not working. Check the microphone and Captions settings, then rejoin."),
                        recovery: .rejoin,
                        severity: .notice,
                        diagnostic: diagnostic
                    )
                    StarlingsDiagnosticsLog.shared.record(failure, context: "transcription")
                    self.onNonFatalError?(failure)
                }
            }
        )
        self.transcriber = transcriber
        let localSpeaker = TranscriptionSpeaker(id: "owner:\(owner.email.lowercased())", name: owner.name)
        transcriptionLocalSpeakerID = localSpeaker.id
        transcriptionMicrophoneExpectedSince = Date()
        let renderer = MeetingAudioRenderer(speaker: localSpeaker, transcriber: transcriber)
        localAudioRenderer = renderer
        AudioManager.shared.add(localAudioRenderer: renderer)
        attachSubscribedRemoteAudioRenderers()
        onTranscriptionStatus?("Preparing transcription…")
        transcriptionPreparationTask = Task { await transcriber.prepare() }
        transcriptionWatchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { return }
                await self?.checkTranscriptionHealth()
            }
        }
    }

    private func deliverTranscriptSegment(_ heard: TranscriptSegment) async {
        // Names first, so captions, the panel, the artifact and the task
        // extractor all read the same spelling.
        let segment = nameLexicon().correct(heard, isWord: wordChecker)
        do {
            try await publishCaption(segment)
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

    private func endLocalTranscription() async {
        transcriptionIsEnding = true
        transcriptionPreparationTask?.cancel()
        transcriptionPreparationTask = nil
        transcriptionWatchdogTask?.cancel()
        transcriptionWatchdogTask = nil
        var renderers: [MeetingAudioRenderer] = []
        if let localAudioRenderer {
            AudioManager.shared.remove(localAudioRenderer: localAudioRenderer)
            localAudioRenderer.finish()
            renderers.append(localAudioRenderer)
        }
        self.localAudioRenderer = nil
        for binding in remoteAudioRenderers.values {
            binding.track.remove(audioRenderer: binding.renderer)
            binding.renderer.finish()
            renderers.append(binding.renderer)
        }
        remoteAudioRenderers.removeAll()
        for renderer in renderers {
            await renderer.drain()
        }
        await transcriber?.finish()
        transcriber = nil
    }

    /// Attach every subscribed remote audio track, including tracks that were
    /// delivered by LiveKit before local transcription finished preparing.
    /// The SID guard makes this safe to call from both the delegate callback
    /// and the post-connect repair scan.
    private func attachSubscribedRemoteAudioRenderers() {
        guard transcriber != nil else { return }
        for participant in room.remoteParticipants.values {
            for publication in participant.trackPublications.values {
                guard let publication = publication as? RemoteTrackPublication,
                      publication.kind == .audio,
                      publication.isSubscribed,
                      let track = publication.track as? RemoteAudioTrack else { continue }
                attachRemoteAudioRenderer(
                    track: track,
                    publication: publication,
                    participant: participant
                )
            }
        }
    }

    private func attachRemoteAudioRenderer(
        track: RemoteAudioTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
    ) {
        guard let transcriber else { return }
        let sid = publication.sid
        guard remoteAudioRenderers[sid] == nil else { return }
        let speaker = TranscriptionSpeaker(
            id: participant.identity?.stringValue ?? "guest:\(sid.stringValue)",
            name: participant.name ?? participant.identity?.stringValue ?? String(localized: "Guest")
        )
        let renderer = MeetingAudioRenderer(speaker: speaker, transcriber: transcriber)
        track.add(audioRenderer: renderer)
        remoteAudioRenderers[sid] = RemoteAudioBinding(track: track, renderer: renderer)
    }

    /// Runs every five seconds while this Mac transcribes. Reads when the
    /// host's own microphone last delivered a frame, not only whether one
    /// ever did: capture can stop mid-meeting after a route change
    /// while LiveKit stays connected. One restart per stall; a restart that
    /// fails, or a stall that outlives the restart, tells the host.
    private func checkTranscriptionHealth() async {
        guard !transcriptionIsEnding,
              phase == .connected,
              let transcriber else { return }
        let snapshot = await transcriber.healthSnapshot()
        transcriptionHealthSnapshot = snapshot
        guard snapshot.modelReady else { return }

        // A muted host with no remote track has no expected PCM. That is a
        // valid waiting state, not a broken recognizer.
        guard transcriptionMicrophoneExpected else {
            if snapshot.receivedAudioFrameCount == 0 {
                onTranscriptionStatus?("Transcription ready — microphone muted; unmute to transcribe")
            }
            return
        }

        let now = Date()
        var localAudioAt: Date?
        if let transcriptionLocalSpeakerID {
            localAudioAt = await transcriber.lastAudioAt(speakerID: transcriptionLocalSpeakerID)
        }
        if TranscriptionStallCheck.isFlowing(lastLocalAudioAt: localAudioAt, now: now) {
            if transcriptionNoAudioIssueReported {
                transcriptionNoAudioIssueReported = false
                onTranscriptionStatus?("")
            }
            // Capture is back. A later stall gets its own restart.
            transcriptionAudioRecoveryAttempted = false
            return
        }
        let expectedSince = [snapshot.modelReadyAt, transcriptionMicrophoneExpectedSince]
            .compactMap { $0 }
            .max() ?? now
        guard TranscriptionStallCheck.isStalled(
            lastLocalAudioAt: localAudioAt,
            expectedSince: expectedSince,
            now: now
        ), !transcriptionNoAudioIssueReported else { return }

        if !transcriptionAudioRecoveryAttempted {
            transcriptionAudioRecoveryAttempted = true
            onTranscriptionStatus?("Transcription is checking the microphone…")
            do {
                // The platform audio module can lose its capture tap across a
                // route change or mute transition while LiveKit stays
                // connected. One controlled restart repairs that state before
                // declaring transcription broken.
                try await room.localParticipant.setMicrophone(enabled: false)
                applyPreferredMicrophone()
                try await room.localParticipant.setMicrophone(enabled: true)
                transcriptionMicrophoneExpected = true
                // The restart gets its own full window before the next verdict.
                transcriptionMicrophoneExpectedSince = Date()
                return
            } catch {
                let diagnostic = error.localizedDescription
                let failure = StarlingsError(
                    code: "transcription.audio_recovery_failed",
                    title: String(localized: "Transcription microphone recovery failed"),
                    message: String(localized: "Starlings couldn’t restart the microphone audio used for local transcription. Check microphone access and rejoin."),
                    recovery: .openMicrophoneSettings,
                    severity: .notice,
                    diagnostic: diagnostic
                )
                StarlingsDiagnosticsLog.shared.record(failure, context: "transcription")
                onTranscriptionStatus?(failure.title)
                onNonFatalError?(failure)
                transcriptionNoAudioIssueReported = true
                return
            }
        }

        transcriptionNoAudioIssueReported = true
        let failure = StarlingsError(
            code: "transcription.no_audio_frames",
            title: String(localized: "Transcription is not receiving audio"),
            message: String(localized: "The meeting is connected, but no microphone audio is reaching local transcription. Check the selected microphone, then mute and unmute or rejoin."),
            recovery: .openMicrophoneSettings,
            severity: .notice
        )
        StarlingsDiagnosticsLog.shared.record(failure, context: "transcription")
        onTranscriptionStatus?(failure.title)
        onNonFatalError?(failure)
    }

    /// Muting disables the local audio track. With the `.platformDefault`
    /// device module that `AppDelegate` pins, WebRTC then stops recording on
    /// the module, so the transcription tap receives no frames while muted.
    /// Playout is not stopped. Unmuting re-enables the track, WebRTC restarts
    /// recording, and the chosen input is re-applied before that happens so
    /// the restarted capture does not land on the system default.
    ///
    /// `AudioManager.setRecordingAlwaysPreparedMode` is not an option here: it
    /// is an `AVAudioEngine` feature and the ADM returns -1 for it on
    /// `.platformDefault` before touching anything (see `RTCAudioDeviceModule.mm`,
    /// `AudioEngineDeviceOrNull`). Meet 2.6.0–2.6.4 called it on every unmute
    /// and surfaced that -1 as "Microphone capture couldn’t be prepared".
    func setMicrophone(enabled: Bool) async throws {
        if enabled, activeConfiguration?.role == .host, !holdsHost {
            throw StarlingsError.invalidEntry
        }
        if enabled {
            applyPreferredMicrophone()
        }
        try await room.localParticipant.setMicrophone(enabled: enabled)
        transcriptionMicrophoneExpected = enabled
        if enabled {
            applyPreferredMicrophone()
        } else if transcriber != nil {
            onTranscriptionStatus?("Transcription ready — microphone muted; unmute to transcribe")
        }
    }

    func setCamera(enabled: Bool) async throws {
        if enabled {
            guard let cameraID = preferredCameraID,
                  let camera = AVCaptureDevice(uniqueID: cameraID) else {
                throw StarlingsError.cameraMissing()
            }
            let options = CameraCaptureOptions(
                device: camera,
                dimensions: .h720_169,
                fps: 30
            )
            // LiveKit camera off is mute (stop capture), not unpublish. Re-enable
            // only unmutes and ignores captureOptions — so didPublishTrack never
            // fires again, and a device change while muted would stick to the old
            // camera. Re-bind the local tile ourselves after unmute.
            let existingTrack = localCameraTrack()
            try await room.localParticipant.setCamera(
                enabled: true,
                captureOptions: options
            )
            if existingTrack != nil,
               let cameraTrack = localCameraTrack(),
               let capturer = cameraTrack.capturer as? CameraCapturer,
               capturer.options.device?.uniqueID != cameraID {
                _ = try await capturer.set(options: options)
            }
            if backgroundEffect != .none {
                try await setBackgroundEffect(backgroundEffect)
            }
            onLocalVideoTrack?(localCameraTrack())
        } else {
            // Stopping the capture session takes a beat, and the tile holds its
            // last frame for every bit of it. Blank the tile first so the press
            // reads as instant, and put the picture back if the stop fails.
            onLocalVideoTrack?(nil)
            do {
                try await room.localParticipant.setCamera(enabled: false)
            } catch {
                onLocalVideoTrack?(localCameraTrack())
                throw error
            }
            backgroundEffectProcessor = nil
        }
    }

    /// Retarget the live camera without republishing: subscribers keep the same
    /// track, and the background effect processor stays attached.
    func setCameraDevice(id: String) async throws {
        preferredCameraID = id
        guard let cameraTrack = localCameraTrack() else { return }
        guard let camera = AVCaptureDevice(uniqueID: id) else {
            throw StarlingsError.cameraMissing()
        }
        guard let capturer = cameraTrack.capturer as? CameraCapturer else {
            try await setCamera(enabled: true)
            return
        }
        _ = try await capturer.set(options: CameraCaptureOptions(
            device: camera,
            dimensions: .h720_169,
            fps: 30
        ))
    }

    func setBackgroundEffect(_ effect: MeetingBackgroundEffect) async throws {
        backgroundEffect = effect
        guard let cameraTrack = localCameraTrack() else {
            backgroundEffectProcessor = nil
            return
        }
        // Assign the track processor before dropping the previous strong ref.
        // The capturer only holds the processor weakly — reversing this order
        // briefly clears the effect and leaks a raw camera frame.
        let processor = effect.makeProcessor()
        cameraTrack.processor = processor
        backgroundEffectProcessor = processor
    }

    private func localCameraTrack() -> LocalVideoTrack? {
        room.localParticipant.localVideoTracks
            .first(where: { $0.source == .camera })?
            .track as? LocalVideoTrack
    }

    private func localScreenShareTrack() -> VideoTrack? {
        room.localParticipant.localVideoTracks
            .first(where: { $0.source == .screenShareVideo })?
            .track as? VideoTrack
    }

    func setScreenShare(enabled: Bool) async throws {
        try await publishScreenShare(enabled: enabled, source: nil)
    }

    func setScreenShare(source: MacOSScreenCaptureSource) async throws {
        try await publishScreenShare(enabled: true, source: source)
    }

    private func publishScreenShare(enabled: Bool, source: MacOSScreenCaptureSource?) async throws {
        if !enabled {
            try await room.localParticipant.setScreenShare(enabled: false)
            return
        }

        // ScreenCaptureKit can fail only after LiveKit has created a native
        // capture track. Check TCC first so a denied permission is reported as
        // an optional media failure and never participates in room lifecycle.
        guard ScreenCaptureAccess.ensurePermission() else {
            throw StarlingsError.screenCapturePermissionDenied()
        }

        if let source {
            if room.localParticipant.isScreenShareEnabled() {
                try await room.localParticipant.setScreenShare(enabled: false)
            }
            // The factory ignores room defaults; pass the capture cap so the
            // picker path matches `setScreenShare(enabled:)`. The publish call
            // with nil options does fall back to the room's encoding cap.
            let track = LocalVideoTrack.createMacOSScreenShareTrack(
                source: source,
                options: roomOptions.defaultScreenShareCaptureOptions,
                reportStatistics: roomOptions.reportRemoteTrackStatistics
            )
            try await room.localParticipant.publish(videoTrack: track)
            return
        }

        try await room.localParticipant.setScreenShare(enabled: true)
    }

    /// The host stopped this Mac's share. The SFU muted it the moment they
    /// pressed the button, so nobody is still watching; unpublishing here is
    /// what releases ScreenCaptureKit, so macOS stops showing the screen
    /// recording indicator for a share that no longer goes anywhere.
    private func handleScreenShareStoppedByHost(stoppedBy: String) async {
        if room.localParticipant.isScreenShareEnabled() {
            // Nothing useful to do if it fails: the SFU has already stopped
            // forwarding, so the share is over for everyone either way.
            _ = try? await room.localParticipant.setScreenShare(enabled: false)
        }
        onScreenShareStoppedByHost?(stoppedBy)
    }

    /// The host closed this Mac's microphone. The SFU stopped carrying the
    /// audio the moment they pressed it, so nobody can hear this Mac either
    /// way; muting locally is what releases the capture, so macOS stops showing
    /// the orange microphone indicator for audio that goes nowhere.
    ///
    /// Unmuting is left entirely to the person here. Nothing in this path
    /// re-opens a microphone.
    private func handleMicrophoneMutedByHost(mutedBy: String) async {
        if room.localParticipant.isMicrophoneEnabled() {
            _ = try? await room.localParticipant.setMicrophone(enabled: false)
        }
        onMicrophoneEnabledChange?(false)
        onMicrophoneMutedByHost?(mutedBy)
    }

    /// The host removed this Mac from the meeting. The disconnect is already on
    /// its way from the SFU; this only gets the reason in ahead of it, so the
    /// ending can be named instead of looking like a network drop.
    private func handleRemovedByHost(removedBy: String) {
        removedByHost = removedBy
        onRemovedByHost?(removedBy)
    }

    func publishCaption(_ segment: TranscriptSegment) async throws {
        let data = try JSONEncoder().encode(CaptionMessage(segment: segment))
        guard data.count <= 15_000 else { throw StarlingsError.captionTooLarge }
        try await room.localParticipant.publish(
            data: data,
            options: DataPublishOptions(
                topic: CaptionMessage.topic,
                reliable: segment.isFinal
            )
        )
    }

    /// Put a reaction on a chat message, or take it off again.
    ///
    /// Reliable, unlike a flying reaction: this one is state, and a dropped
    /// packet would leave one participant's screen showing a tally that stays
    /// wrong for the rest of the call. LiveKit does not echo data back to its
    /// publisher, so the sender applies its own toggle — the same way it adds
    /// its own chat message locally.
    func toggleChatReaction(_ reaction: MeetingReaction, on messageID: String) async {
        guard phase == .connected else { return }
        let now = Date()
        guard now.timeIntervalSince(lastChatReactionAt) >= ChatReaction.minimumInterval else { return }
        lastChatReactionAt = now

        let identity = room.localParticipant.identity?.stringValue ?? "local"
        let on = !chatReactions.contains(identity, reaction: reaction, on: messageID)
        let packet = ChatReactionMessage(messageID: messageID, reaction: reaction, on: on)
        if chatReactions.apply(packet, from: identity) {
            onChatReactionsChange?(chatReactions)
        }
        guard let data = try? JSONEncoder().encode(packet) else { return }
        try? await room.localParticipant.publish(
            data: data,
            options: DataPublishOptions(topic: ChatReaction.topic, reliable: true)
        )
    }

    /// Whether this Mac has that reaction on that message, for drawing a pill
    /// as pressed without the chat panel keeping its own copy of the tally.
    func localHasChatReaction(_ reaction: MeetingReaction, on messageID: String) -> Bool {
        let identity = room.localParticipant.identity?.stringValue ?? "local"
        return chatReactions.contains(identity, reaction: reaction, on: messageID)
    }

    /// Fire-and-forget: lossy, unacknowledged, and never retried. A reaction
    /// that arrives late is worse than one that never arrives, and reliable
    /// delivery would queue them into a clump after a bad network moment.
    func sendReaction(_ reaction: MeetingReaction) async {
        guard phase == .connected else { return }
        guard let data = try? JSONEncoder().encode(ReactionMessage(reaction)) else { return }
        try? await room.localParticipant.publish(
            data: data,
            options: DataPublishOptions(topic: MeetingReaction.topic, reliable: false)
        )
    }

    /// Matches the browser LiveKit Components chat: text stream on `lk.chat`, plus a
    /// legacy `lk-chat-topic` packet so older peers still see the message.
    func sendChat(_ text: String) async throws {
        guard phase == .connected else { throw StarlingsError.chatNotConnected }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard trimmed.utf8.count <= 8_000 else { throw StarlingsError.chatTooLong }

        let info = try await room.localParticipant.sendText(trimmed, for: MeetingChatMessage.topic)
        let timestamp = Date()
        let wire = LegacyChatWireMessage(
            id: info.id,
            timestamp: Int64(timestamp.timeIntervalSince1970 * 1000),
            message: trimmed,
            ignoreLegacy: true
        )
        if let data = try? JSONEncoder().encode(wire) {
            try? await room.localParticipant.publish(
                data: data,
                options: DataPublishOptions(topic: MeetingChatMessage.legacyTopic, reliable: true)
            )
        }

        let local = room.localParticipant
        let identity = local.identity?.stringValue ?? "local"
        let message = MeetingChatMessage(
            id: info.id,
            timestamp: timestamp,
            text: trimmed,
            senderIdentity: identity,
            senderName: local.name ?? String(localized: "You"),
            isLocal: true
        )
        deliverChatMessage(message)
    }

    private func registerChatHandler() async throws {
        try await room.registerTextStreamHandler(for: MeetingChatMessage.topic) { [weak self] reader, participantIdentity in
            let text: String
            do {
                text = try await reader.readAll()
            } catch {
                // One dropped inbound message. Nothing for the reader to act on,
                // but it should not vanish without a trace either.
                NSLog("Meet chat message dropped: %@", error.localizedDescription)
                return
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            await MainActor.run {
                guard let self else { return }
                let identity = participantIdentity.stringValue
                let remote = self.room.remoteParticipants[participantIdentity]
                let message = MeetingChatMessage(
                    id: reader.info.id,
                    timestamp: reader.info.timestamp,
                    text: trimmed,
                    senderIdentity: identity,
                    senderName: remote?.name ?? identity,
                    isLocal: false
                )
                self.deliverChatMessage(message)
            }
        }
    }

    private func unregisterChatHandler() async {
        await room.unregisterTextStreamHandler(for: MeetingChatMessage.topic)
    }

    private func deliverChatMessage(_ message: MeetingChatMessage) {
        if seenChatMessageIDs.contains(message.id) { return }
        seenChatMessageIDs.insert(message.id)
        // Cap the dedupe set so a long meeting cannot grow it without bound.
        if seenChatMessageIDs.count > 500 {
            seenChatMessageIDs.removeAll(keepingCapacity: true)
        }
        onChatMessage?(message)
    }

    private func handleLegacyChatPacket(data: Data, participant: RemoteParticipant?) {
        guard let wire = try? JSONDecoder().decode(LegacyChatWireMessage.self, from: data) else { return }
        if wire.ignoreLegacy == true { return }
        let trimmed = wire.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let identity = participant?.identity?.stringValue ?? "guest"
        let message = MeetingChatMessage(
            id: wire.id,
            timestamp: Date(timeIntervalSince1970: TimeInterval(wire.timestamp) / 1000),
            text: trimmed,
            senderIdentity: identity,
            senderName: participant?.name ?? identity,
            isLocal: false
        )
        deliverChatMessage(message)
    }

    private func selectMicrophone(id: String) {
        preferredMicrophoneID = id
        applyPreferredMicrophone()
    }

    private func selectSpeaker(id: String?) {
        guard let id else { return }
        preferredSpeakerID = id
        applyPreferredSpeaker()
    }

    /// Where this Mac plays the room. Same late-binding as the microphone: the
    /// device module lists outputs only once a call has initialized it.
    func setSpeaker(id: String) {
        preferredSpeakerID = id
        applyPreferredSpeaker()
    }

    func setSpatialAudio(enabled: Bool) {
        spatialAudioWanted = enabled
        guard phase == .connected else { return }
        spatialStage.setEnabled(enabled)
    }

    func setSpatialAudioPositions(_ positions: [String: SpatialAudioPosition]) {
        spatialStage.setPositions(positions)
    }

    /// Same subscribe race as the transcription tap: a track that arrived
    /// while `room.connect` was still completing is picked up here.
    private func attachSubscribedSpatialSources() {
        for participant in room.remoteParticipants.values {
            for publication in participant.trackPublications.values {
                guard let publication = publication as? RemoteTrackPublication,
                      publication.isSubscribed,
                      let track = publication.track as? RemoteAudioTrack else { continue }
                attachSpatialSource(track: track, publication: publication, participant: participant)
            }
        }
    }

    /// Microphones only. A share's audio has no tile to sit under and stays
    /// in LiveKit's own mix.
    private func attachSpatialSource(
        track: RemoteAudioTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
    ) {
        guard publication.source == .microphone else { return }
        let identity = participant.identity?.stringValue ?? publication.sid.stringValue
        spatialStage.attach(
            track: track,
            sid: publication.sid.stringValue,
            person: EnvisioningIdentity.accountAddress(identity.lowercased())
        )
    }

    /// LiveKit's macOS device module lists inputs only once a call has
    /// initialized it, so the chosen device is applied again after the
    /// microphone track is published rather than failing the join.
    private func applyPreferredMicrophone() {
        guard let id = preferredMicrophoneID else { return }
        guard let device = MediaDevicePreferences.liveKitInputDevice(for: id) else {
            NSLog("Meet microphone %@ not yet visible to LiveKit; using the system default", id)
            return
        }
        MediaDevicePreferences.apply(inputDevice: device)
    }

    private func applyPreferredSpeaker() {
        guard let id = preferredSpeakerID else { return }
        spatialStage.setOutputDevice(AudioDeviceCatalog.audioDeviceID(for: id))
        guard let device = MediaDevicePreferences.liveKitOutputDevice(for: id) else {
            NSLog("Meet speaker %@ not yet visible to LiveKit; using the system default", id)
            return
        }
        MediaDevicePreferences.apply(outputDevice: device)
    }

    private func hasSubscribedRemoteAudio() -> Bool {
        room.remoteParticipants.values.contains { participant in
            participant.trackPublications.values.contains { publication in
                (publication as? RemoteTrackPublication)?.track is RemoteAudioTrack
            }
        }
    }

    /// The device module starts playout only when the first remote voice
    /// arrives, and from there it can play through a speaker other than the
    /// one it reports. Setting the chosen speaker at join is too early and is
    /// skipped as unchanged. So once per call, just after the first remote
    /// audio track subscribes, make a real switch to the chosen speaker
    /// (``MediaDevicePreferences/reassert(outputDevice:)``). The short wait
    /// lets the module finish starting playout first.
    private func reassertSpeakerForPlayout() {
        guard phase == .connected, !speakerReassertedForPlayout, speakerReassertTask == nil else { return }
        speakerReassertTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard let self, !Task.isCancelled else { return }
            self.speakerReassertTask = nil
            guard self.phase == .connected, !self.speakerReassertedForPlayout else { return }
            self.speakerReassertedForPlayout = true
            guard let id = self.preferredSpeakerID,
                  let device = MediaDevicePreferences.liveKitOutputDevice(for: id) else { return }
            MediaDevicePreferences.reassert(outputDevice: device)
        }
    }

    /// People, not connections. Someone in the room from two devices publishes
    /// under two identities that resolve to one address, and the count on the
    /// stage has to say how many people are in the meeting.
    private func updateParticipantCount() {
        var people = Set<String>()
        var names: [String: String] = [:]
        people.insert(EnvisioningIdentity.accountAddress(
            (room.localParticipant.identity?.stringValue ?? "local").lowercased()
        ))
        for participant in room.remoteParticipants.values {
            let identity = participant.identity?.stringValue
                ?? participant.sid?.stringValue
                ?? UUID().uuidString
            let address = EnvisioningIdentity.accountAddress(identity.lowercased())
            people.insert(address)
            if names[address] == nil { names[address] = participant.name ?? identity }
        }
        onParticipantCountChange?(people.count)
        // The first pass after connect is the baseline: the room as found,
        // not a list of arrivals.
        if let before = knownPeople {
            for address in names.keys where !before.keys.contains(address) {
                onParticipantArrived?(names[address] ?? address)
            }
            for (address, name) in before where names[address] == nil {
                onParticipantLeft?(name)
            }
        }
        knownPeople = names
    }

    /// Local participant first, then remotes by name, so the menu order is
    /// stable as people come and go.
    var participantQuality: [MeetingParticipantQuality] {
        guard phase == .connected else { return [] }
        let local = room.localParticipant
        let localEntry = MeetingParticipantQuality(
            id: local.identity?.stringValue ?? "local",
            name: local.name ?? String(localized: "You"),
            isLocal: true,
            quality: MeetingConnectionQuality(local.connectionQuality),
            client: GuestClient.fromParticipantMetadata(local.metadata),
            isOwner: GuestClient.isOwnerParticipant(local.metadata),
            isHost: HostAttribute.isHost(local.attributes),
            recording: GuestClient.consentFromParticipantMetadata(local.metadata) != nil,
            onBehalfOf: GuestClient.consentFromParticipantMetadata(local.metadata)?.onBehalfOf,
            registered: GuestClient.isRegisteredParticipant(local.metadata)
        )
        let remotes = room.remoteParticipants.values
            .map { participant in
                MeetingParticipantQuality(
                    // Stable fallback: a fresh UUID per call would rebuild this
                    // participant's row on every quality tick.
                    id: participant.identity?.stringValue ?? participant.sid?.stringValue ?? "unknown-participant",
                    name: participant.name ?? participant.identity?.stringValue ?? String(localized: "Guest"),
                    isLocal: false,
                    quality: MeetingConnectionQuality(participant.connectionQuality),
                    client: GuestClient.fromParticipantMetadata(participant.metadata),
                    isOwner: GuestClient.isOwnerParticipant(participant.metadata),
                    isHost: HostAttribute.isHost(participant.attributes),
                    recording: GuestClient.consentFromParticipantMetadata(participant.metadata) != nil,
                    onBehalfOf: GuestClient.consentFromParticipantMetadata(participant.metadata)?.onBehalfOf,
                    registered: GuestClient.isRegisteredParticipant(participant.metadata)
                )
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        return [localEntry] + remotes
    }

    func qualityReport() -> MeetingQualityReport? {
        qualityTracker.report(client: .mac)
    }

    func downstreamUsageReport() -> DownstreamUsageReport? {
        return downstreamUsageMeter.report(room: room)
    }

    var bandwidthSnapshot: MeetingBandwidthSnapshot? {
        bandwidthSampler.snapshot
    }

    func buildDebugReport() -> String {
        MeetingBandwidthDebugReport.build(
            context: debugContext,
            connectionState: String(describing: room.connectionState),
            adaptiveStream: roomOptions.adaptiveStream,
            dynacast: roomOptions.dynacast,
            serverVersion: room.serverVersion,
            serverRegion: room.serverRegion,
            quality: qualityReport(),
            participantQuality: participantQuality,
            bandwidth: bandwidthSnapshot,
            transcription: transcriptionHealthSnapshot,
            microphone: MicrophoneProcessingSnapshot.current(),
            recentErrors: StarlingsDiagnosticsLog.shared.reportLines()
        )
    }

    private func publishConnectionQuality() {
        onConnectionQualityChange?(participantQuality)
    }
}


extension LiveKitMeetingSession: RoomDelegate {
    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant?,
        didReceiveData data: Data,
        forTopic topic: String,
        encryptionType: EncryptionType
    ) {
        if topic == MeetingChatMessage.legacyTopic {
            Task { @MainActor [weak self] in
                self?.handleLegacyChatPacket(data: data, participant: participant)
            }
            return
        }
        if topic == MeetingReaction.topic {
            // Participant-published, so unlike moderation a packet with nobody
            // behind it is the odd one out — and the sender is also the whole
            // of the attribution, since the payload carries no name to forge.
            // Anything outside the palette is dropped by `ReactionMessage`.
            guard let participant,
                  let message = try? JSONDecoder().decode(ReactionMessage.self, from: data),
                  let reaction = message.reaction else { return }
            let sender = participant.name ?? participant.identity?.stringValue ?? String(localized: "Guest")
            Task { @MainActor [weak self] in
                self?.onReaction?(reaction, sender)
            }
            return
        }
        if topic == ChatReaction.topic {
            // Same rule as a flying reaction: participant-published, and the
            // payload carries no name, so the sender is the whole of the
            // attribution. `ChatReactionMessage` drops anything malformed or
            // outside the palette.
            guard let participant,
                  let identity = participant.identity?.stringValue,
                  let message = try? JSONDecoder().decode(ChatReactionMessage.self, from: data) else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.chatReactions.apply(message, from: identity) {
                    self.onChatReactionsChange?(self.chatReactions)
                }
            }
            return
        }
        if topic == HostMessageWire.topic {
            // Host packets are server-sent only. The Worker validates the
            // owner and serializes the transfer; participant-published packets
            // on this topic never grant a microphone or transcription rights.
            guard participant == nil,
                  let message = try? JSONDecoder().decode(HostMessageWire.self, from: data),
                  message.version == 1 else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch message.type.rawValue {
                case HostMessageWireType.releaseRequested.rawValue:
                    guard message.hostIdentity == self.ownerIdentity else { return }
                    await self.onHostReleaseRequested?()
                case HostMessageWireType.changed.rawValue:
                    await self.updateHost(identity: message.hostIdentity)
                case HostMessageWireType.offered.rawValue:
                    guard let target = message.targetIdentity, target == self.localIdentity else { return }
                    await self.onHostOffered?(message.fromName)
                default:
                    break
                }
            }
            return
        }
        if topic == ModerationMessage.topic {
            // Server-sent only: a packet with a participant behind it is a
            // guest impersonating the control plane, not the host.
            guard participant == nil,
                  let message = try? JSONDecoder().decode(ModerationMessage.self, from: data),
                  message.version == 1 else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                switch message.type {
                case ModerationMessage.screenShareStopped:
                    await self.handleScreenShareStoppedByHost(stoppedBy: message.by)
                case ModerationMessage.audioMuted:
                    await self.handleMicrophoneMutedByHost(mutedBy: message.by)
                case ModerationMessage.participantRemoved:
                    self.handleRemovedByHost(removedBy: message.by)
                default:
                    // A moderation action this build has never heard of. The
                    // SFU half of it has already happened; there is nothing
                    // useful to say about the half we cannot name.
                    break
                }
            }
            return
        }
        guard topic == CaptionMessage.topic,
              CaptionMessage.acceptsPublisherIdentity(participant?.identity?.stringValue),
              let message = try? JSONDecoder().decode(CaptionMessage.self, from: data),
              message.version == 1 else { return }
        Task { @MainActor [weak self] in
            await self?.onTranscriptSegment?(message.segment)
        }
    }

    nonisolated func room(
        _ room: Room,
        participant: LocalParticipant,
        didPublishTrack publication: LocalTrackPublication
    ) {
        if publication.source == .screenShareVideo {
            let track = publication.track as? VideoTrack
            Task { @MainActor [weak self] in
                self?.onLocalScreenShareTrack?(track)
                self?.onLocalScreenShareEnabledChange?(true)
            }
            return
        }
        guard let track = publication.track as? VideoTrack,
              publication.source == .camera else { return }
        Task { @MainActor [weak self] in
            self?.onLocalVideoTrack?(track)
        }
    }

    nonisolated func room(
        _ room: Room,
        participant: LocalParticipant,
        didUnpublishTrack publication: LocalTrackPublication
    ) {
        guard publication.source == .screenShareVideo else { return }
        Task { @MainActor [weak self] in
            self?.onLocalScreenShareTrack?(nil)
            self?.onLocalScreenShareEnabledChange?(false)
        }
    }

    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant,
        didSubscribeTrack publication: RemoteTrackPublication
    ) {
        if let audioTrack = publication.track as? RemoteAudioTrack {
            Task { @MainActor [weak self] in
                self?.attachRemoteAudioRenderer(
                    track: audioTrack,
                    publication: publication,
                    participant: participant
                )
                self?.attachSpatialSource(
                    track: audioTrack,
                    publication: publication,
                    participant: participant
                )
                self?.reassertSpeakerForPlayout()
            }
            return
        }
        guard let track = publication.track as? VideoTrack else { return }
        let name = participant.name ?? participant.identity?.stringValue ?? String(localized: "Guest")
        let identity = participant.identity?.stringValue ?? name
        let source = publication.source
        let sid = publication.sid
        Task { @MainActor [weak self] in
            self?.remoteVideoTracks[sid] = RemoteVideo(
                track: track,
                name: name,
                identity: identity,
                source: source
            )
            self?.publishRemoteVideos()
            self?.updateParticipantCount()
        }
    }

    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant,
        didUnsubscribeTrack publication: RemoteTrackPublication
    ) {
        let sid = publication.sid
        Task { @MainActor [weak self] in
            if let binding = self?.remoteAudioRenderers.removeValue(forKey: sid) {
                binding.track.remove(audioRenderer: binding.renderer)
                binding.renderer.finish()
            }
            self?.spatialStage.detach(sid: sid.stringValue)
            self?.remoteVideoTracks.removeValue(forKey: sid)
            self?.publishRemoteVideos()
        }
    }

    /// Camera off — and share paused — is a mute, not an unpublish, so this is
    /// the only signal that a tile should stop showing video. Handling it for
    /// the local participant too means the host's own tile blanks whatever
    /// muted the camera, including a mute this app did not initiate. The local
    /// microphone rides the same signal for the same reason.
    nonisolated func room(
        _ room: Room,
        participant: Participant,
        trackPublication: TrackPublication,
        didUpdateIsMuted isMuted: Bool
    ) {
        let source = trackPublication.source
        let isLocal = participant is LocalParticipant
        // A microphone the host closed is muted at the SFU whether or not the
        // moderation packet arrives, so this is the signal of record for what
        // the Mute button should say.
        if isLocal, source == .microphone {
            Task { @MainActor [weak self] in
                self?.transcriptionMicrophoneExpected = !isMuted
                self?.onMicrophoneEnabledChange?(!isMuted)
            }
            return
        }
        guard source == .camera || source == .screenShareVideo else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if isLocal, source == .camera {
                self.onLocalVideoTrack?(isMuted ? nil : self.localCameraTrack())
            } else if isLocal, source == .screenShareVideo {
                // Pause the local content tile without changing the sharing
                // control's published-state label. Unpublishing still clears
                // it through didUnpublishTrack above.
                self.onLocalScreenShareTrack?(
                    isMuted ? nil : self.localScreenShareTrack()
                )
            } else {
                self.publishRemoteVideos()
            }
        }
    }

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor [weak self] in
            self?.attachSubscribedRemoteAudioRenderers()
            self?.publishRemoteVideos()
            self?.updateParticipantCount()
            self?.publishConnectionQuality()
        }
    }

    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        let identity = participant.identity?.stringValue
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let identity {
                self.remoteVideoTracks = self.remoteVideoTracks.filter { $0.value.identity != identity }
                // A hand belongs to somebody in the room. Leaving lowers it,
                // and a queue that lists people who have gone is a queue the
                // host stops reading.
                self.handsByIdentity.removeValue(forKey: identity)
                self.publishRaisedHands()
            }
            self.publishRemoteVideos()
            self.updateParticipantCount()
            self.publishConnectionQuality()
        }
    }

    nonisolated func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        let identities = Set(participants.compactMap { $0.identity?.stringValue })
        let localSpeaking = participants.contains { $0 is LocalParticipant }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.speakingIdentities = identities
            self.onLocalSpeakingChange?(localSpeaking)
            self.publishRemoteVideos()
        }
    }

    /// A hand went up or came down.
    ///
    /// Attributes are how a hand reaches a late joiner and survives a
    /// reconnect: LiveKit hands the current set to every client that arrives,
    /// so a host who opens the app mid-meeting sees the queue that is already
    /// waiting rather than only the hands raised from then on.
    nonisolated func room(
        _ room: Room,
        participant: Participant,
        didUpdateAttributes attributes: [String: String]
    ) {
        let identity = participant.identity?.stringValue
        let raisedAt = MeetingHand.raisedAt(attributes[MeetingHand.attribute])
        let name = participant.name ?? identity
        Task { @MainActor [weak self] in
            guard let self, let identity else { return }
            // Stale is treated as down here as well as in the count, so a hand
            // nobody is counting is not one the stage still badges.
            if let raisedAt, Date().timeIntervalSince(raisedAt) < MeetingHand.staleAfter {
                handsByIdentity[identity] = raisedAt
            } else {
                handsByIdentity.removeValue(forKey: identity)
            }
            publishRaisedHands(names: [identity: name ?? identity])
            publishRemoteVideos()
        }
    }

    /// Read every hand currently up, from the attributes the room already
    /// holds. Called on connect; changes after that arrive as delegate calls.
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
        publishRaisedHands()
    }

    /// The queue, oldest raise first.
    ///
    /// Names are read from the room rather than remembered, so somebody who
    /// renamed themselves is not listed under the name they arrived with. The
    /// caller may pass names it already has, for the participant whose change
    /// prompted this.
    private func publishRaisedHands(names: [String: String] = [:]) {
        var known = names
        var everyone: [Participant] = Array(room.remoteParticipants.values)
        everyone.append(room.localParticipant)
        for participant in everyone {
            guard let identity = participant.identity?.stringValue else { continue }
            known[identity] = participant.name ?? known[identity] ?? identity
        }
        let mine = room.localParticipant.identity?.stringValue
        let hands = handsByIdentity.map { identity, at in
            RaisedHand(
                identity: identity,
                name: known[identity] ?? identity,
                raisedAt: at,
                isLocal: identity == mine
            )
        }
        onRaisedHandsChange?(hands.inQueueOrder)
        onLocalHandRaisedChange?(mine.map { handsByIdentity[$0] != nil } ?? false)
    }

    nonisolated func room(
        _ room: Room,
        participant: Participant,
        didUpdateConnectionQuality quality: ConnectionQuality
    ) {
        let isLocal = participant is LocalParticipant
        let mapped = MeetingConnectionQuality(quality)
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Only the local participant's own experience is accumulated for the
            // QoE report; every other client reports for itself.
            if isLocal { self.qualityTracker.record(quality: mapped) }
            self.publishConnectionQuality()
            // Republish so the affected participant's own tile picks up (or
            // drops) its weak-connection warning.
            self.publishRemoteVideos()
        }
    }

    nonisolated func room(
        _ room: Room,
        didUpdateConnectionState connectionState: ConnectionState,
        from oldConnectionState: ConnectionState
    ) {
        let didStartReconnecting = connectionState == .reconnecting && oldConnectionState != .reconnecting
        Task { @MainActor [weak self] in
            guard let self else { return }
            if didStartReconnecting { self.qualityTracker.recordReconnect() }
            self.publishConnectionQuality()
        }
    }

    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor [weak self] in
            guard let self, !self.isIntentionalDisconnect else { return }
            await self.endLocalTranscription()
            await self.unregisterChatHandler()
            self.remoteVideoTracks.removeAll()
            self.speakingIdentities = []
            self.seenChatMessageIDs.removeAll()
            self.backgroundEffectProcessor = nil
            self.backgroundEffect = .none
            self.qualityTracker.stop()
            self.bandwidthSampler.stop()
            self.debugContext = nil
            self.onLocalVideoTrack?(nil)
            self.onLocalScreenShareTrack?(nil)
            self.onLocalScreenShareEnabledChange?(false)
            self.onLocalSpeakingChange?(false)
            self.onConnectionQualityChange?([])
            self.publishRemoteVideos()
            // A removal is an ending somebody chose, not a fault: the notice
            // has already said who, and offering Reconnect would only walk
            // into a door the control plane has closed.
            if self.removedByHost != nil {
                self.removedByHost = nil
                self.phase = .ended
                return
            }
            // Reached only after the SDK has exhausted its own reconnect
            // attempts, so this is a real ending — but of a meeting that was
            // working, which is a different sentence from failing to join one.
            let failure = error.map { StarlingsError.liveKit($0, stage: .session) } ?? .sessionLost
            StarlingsDiagnosticsLog.shared.record(failure, context: "disconnected")
            self.phase = .failed(failure)
        }
    }
}

private extension LiveKitMeetingSession {
    struct RemoteVideo {
        let track: VideoTrack
        let name: String
        let identity: String
        let source: Track.Source
    }

    struct RemoteAudioBinding {
        let track: RemoteAudioTrack
        let renderer: MeetingAudioRenderer
    }

    func publishRemoteVideos() {
        var tiles: [MeetingRemoteVideo] = []
        let participants = room.remoteParticipants.values.sorted { lhs, rhs in
            let left = lhs.name ?? lhs.identity?.stringValue ?? ""
            let right = rhs.name ?? rhs.identity?.stringValue ?? ""
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }

        for participant in participants {
            // Stable fallback: a fresh UUID per call would tear down and
            // rebuild this participant's tile on every publish.
            let identity = participant.identity?.stringValue
                ?? participant.sid?.stringValue
                ?? "unknown-participant"
            let name = participant.name ?? identity
            let quality = MeetingConnectionQuality(participant.connectionQuality)
            let camera = remoteVideoTracks.values.first {
                $0.identity == identity && $0.source == .camera
            }
            // A muted camera stays subscribed and simply stops delivering
            // frames, so handing the track to the tile would leave the last one
            // frozen on screen. Drop it instead: the tile falls back to the
            // avatar, which is what that person's own client shows them too.
            let cameraTrack = camera.map(\.track).flatMap { $0.isMuted ? nil : $0 }
            tiles.append(
                MeetingRemoteVideo(
                    id: "\(identity):camera",
                    identity: identity,
                    track: cameraTrack,
                    participantName: name,
                    isScreenShare: false,
                    isSpeaking: speakingIdentities.contains(identity),
                    handRaised: handsByIdentity[identity] != nil,
                    isHost: HostAttribute.isHost(participant.attributes),
                    quality: quality,
                    recording: GuestClient.consentFromParticipantMetadata(participant.metadata) != nil,
                    onBehalfOf: GuestClient.consentFromParticipantMetadata(participant.metadata)?.onBehalfOf
                )
            )

            // A paused share is not a share: drop the tile rather than leave a
            // frozen desktop on the stage. A camera keeps its tile because the
            // avatar still says who is there — a share has nobody behind it.
            let shares = remoteVideoTracks
                .filter {
                    $0.value.identity == identity
                        && $0.value.source == .screenShareVideo
                        && !$0.value.track.isMuted
                }
                .sorted { $0.key.stringValue < $1.key.stringValue }
            for (sid, share) in shares {
                tiles.append(
                    MeetingRemoteVideo(
                        id: "\(identity):screen:\(sid.stringValue)",
                        identity: identity,
                        track: share.track,
                        participantName: name,
                        isScreenShare: true,
                        isSpeaking: false,
                        // A screen has no hand. The badge belongs to the person,
                        // and their camera tile is where it goes.
                        handRaised: false,
                        isHost: false,
                        quality: quality,
                        recording: GuestClient.consentFromParticipantMetadata(participant.metadata) != nil,
                        onBehalfOf: GuestClient.consentFromParticipantMetadata(participant.metadata)?.onBehalfOf
                    )
                )
            }
        }

        onRemoteVideosChange?(Self.mergingDevicesOfOnePerson(tiles))
    }

    /// One person, one camera tile.
    ///
    /// An owner in the room from two devices is two LiveKit participants on
    /// purpose — LiveKit evicts a duplicate identity, so each device publishes
    /// under `mz+mac@…` / `mz+iphone@…`. On the stage they are one person, and
    /// the tile to keep is the one with a live camera.
    ///
    /// Screen shares are left alone deliberately: a share from the second
    /// device is another thing to look at, not a duplicate of the first.
    static func mergingDevicesOfOnePerson(_ tiles: [MeetingRemoteVideo]) -> [MeetingRemoteVideo] {
        var keptCameraIndexByPerson: [String: Int] = [:]
        var merged: [MeetingRemoteVideo] = []
        for tile in tiles {
            guard !tile.isScreenShare else {
                merged.append(tile)
                continue
            }
            let person = EnvisioningIdentity.accountAddress(tile.identity.lowercased())
            guard let index = keptCameraIndexByPerson[person] else {
                keptCameraIndexByPerson[person] = merged.count
                merged.append(tile)
                continue
            }
            let kept = merged[index]
            let replaces = (tile.track != nil && kept.track == nil)
                || (tile.isSpeaking && !kept.isSpeaking && (tile.track != nil) == (kept.track != nil))
            if replaces { merged[index] = tile }
        }
        return merged
    }
}
