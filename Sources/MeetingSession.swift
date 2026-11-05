import Foundation
import LiveKit
import StarlingsContracts

struct MeetingRemoteVideo: Identifiable {
    let id: String
    /// LiveKit identity of the publisher. Carried alongside the display name
    /// because moderation has to name a participant, and two people can share
    /// a display name.
    let identity: String
    let track: VideoTrack?
    let participantName: String
    let isScreenShare: Bool
    let isSpeaking: Bool
    /// Their hand is up. State, not an event — see `MeetingHands`.
    let handRaised: Bool
    /// This device hosts: it admits guests and takes the notes.
    let isHost: Bool
    let quality: MeetingConnectionQuality
    let recording: Bool
    let onBehalfOf: String?
}

@MainActor
protocol MeetingSession: AnyObject {
    var phase: MeetingPhase { get }
    var onPhaseChange: ((MeetingPhase) -> Void)? { get set }
    var onLocalVideoTrack: ((VideoTrack?) -> Void)? { get set }
    /// The local screen share is content on the stage, not a second self-view.
    /// The track is passed separately so the Mac can render it for the sharer.
    var onLocalScreenShareTrack: ((VideoTrack?) -> Void)? { get set }
    var onLocalSpeakingChange: ((Bool) -> Void)? { get set }
    var onRemoteVideosChange: (([MeetingRemoteVideo]) -> Void)? { get set }
    /// Who has a hand up, oldest raise first. Published separately from the
    /// tiles because the host has to be able to see a queue whose people are
    /// off-stage — a badge alone answers "who", never "is anybody waiting".
    var onRaisedHandsChange: (([RaisedHand]) -> Void)? { get set }
    /// Your own hand, separately from the queue: the control that raised it has
    /// to reflect what the room says rather than what was last clicked, so a
    /// refused raise leaves the button down and a host's "lower all" puts it
    /// down without this client being told twice.
    var onLocalHandRaisedChange: ((Bool) -> Void)? { get set }
    var onParticipantCountChange: ((Int) -> Void)? { get set }
    var onParticipantArrived: ((String) -> Void)? { get set }
    var onParticipantLeft: ((String) -> Void)? { get set }
    var onConnectionQualityChange: (([MeetingParticipantQuality]) -> Void)? { get set }
    var onBandwidthChange: ((MeetingBandwidthSnapshot) -> Void)? { get set }
    var onMeetingContext: ((MeetingContext) -> Void)? { get set }
    /// The current host changed, including when this Mac becomes a muted companion.
    var onHostStateChange: ((Bool, String?) -> Void)? { get set }
    /// A waiting Mac asked the current host to hand over after local capture drains.
    var onHostReleaseRequested: (() async -> Void)? { get set }
    /// The host asked this device to host; the argument is who asked.
    var onHostOffered: ((String?) async -> Void)? { get set }
    /// This connection's LiveKit identity, the one an offer names.
    var localIdentity: String? { get }
    var onTranscriptSegment: ((TranscriptSegment) async -> Void)? { get set }
    var knownNames: [String] { get set }
    var wordChecker: TranscriptNameLexicon.WordChecker? { get set }
    /// Something the transcriber wants said: loading, muted, failed. An empty
    /// string means the last thing it said no longer applies.
    var onTranscriptionStatus: ((String) -> Void)? { get set }
    var onChatMessage: ((MeetingChatMessage) -> Void)? { get set }
    /// Someone sent an emoji reaction, with the display name to caption it
    /// with. Ephemeral: animate it and forget it.
    var onReaction: ((MeetingReaction, String) -> Void)? { get set }
    /// The reactions on chat messages changed. Unlike the one above this is
    /// state, not a moment — the whole tally is passed so a client that missed
    /// a packet cannot stay wrong.
    var onChatReactionsChange: ((ChatReactionTally) -> Void)? { get set }
    /// The room owner stopped this Mac's screen share. Carries their name so
    /// the notice can say who, rather than letting the share vanish silently.
    var onScreenShareStoppedByHost: ((String) -> Void)? { get set }
    /// The room owner closed this Mac's microphone. Same shape and the same
    /// reason: the SFU has already stopped carrying the audio, and this is what
    /// keeps the Mute button honest and says who did it.
    var onMicrophoneMutedByHost: ((String) -> Void)? { get set }
    /// The room owner removed this Mac from the meeting. Arrives just before
    /// the disconnect, so the ending can be named rather than looking like a
    /// dropped connection.
    var onRemovedByHost: ((String) -> Void)? { get set }
    /// The local microphone's published state changed, including changes this
    /// app did not initiate. The one signal that keeps the Mute button honest
    /// when something else moved it.
    var onMicrophoneEnabledChange: ((Bool) -> Void)? { get set }
    /// The local screen share was published or unpublished, including when
    /// macOS stops ScreenCaptureKit because access is revoked or a display
    /// disappears. The button and local border must follow the track.
    var onLocalScreenShareEnabledChange: ((Bool) -> Void)? { get set }
    /// Something degraded but the meeting continues — chat unavailable, an
    /// effect that wouldn't start. Never a modal.
    var onNonFatalError: ((StarlingsError) -> Void)? { get set }
    func connect(configuration: MeetingConfiguration, entry: MeetingEntry) async
    func prepareForHostRelease() async
    func resumeHostAfterReleaseFailure() async
    func updateHost(identity: String?) async
    func disconnect() async
    func setMicrophone(enabled: Bool) async throws
    func setCamera(enabled: Bool) async throws
    func setCameraDevice(id: String) async throws
    /// Where the room is played on this Mac. Not throwing and not async: the
    /// output device is the device module's, and nothing is republished.
    func setSpeaker(id: String)
    /// Spatial audio: voices play from where their tiles sit. The
    /// stage reports where that is, keyed by account address, after every
    /// layout pass.
    func setSpatialAudio(enabled: Bool)
    func setSpatialAudioPositions(_ positions: [String: SpatialAudioPosition])
    func setBackgroundEffect(_ effect: MeetingBackgroundEffect) async throws
    func setScreenShare(enabled: Bool) async throws
    func setScreenShare(source: MacOSScreenCaptureSource) async throws
    func publishCaption(_ segment: TranscriptSegment) async throws
    func sendChat(_ text: String) async throws
    /// Fire-and-forget, so it cannot fail loudly enough to interrupt a meeting.
    func sendReaction(_ reaction: MeetingReaction) async
    /// Put a reaction on one chat message, or take it off again. Reliable,
    /// because this one has to still be right in ten minutes.
    func toggleChatReaction(_ reaction: MeetingReaction, on messageID: String) async
    /// Whether this Mac has that reaction on that message, so a pill can draw
    /// itself pressed without the chat panel keeping a second copy of the tally.
    func localHasChatReaction(_ reaction: MeetingReaction, on messageID: String) -> Bool
    var participantQuality: [MeetingParticipantQuality] { get }
    func qualityReport() -> MeetingQualityReport?
    func downstreamUsageReport() -> DownstreamUsageReport?
    var bandwidthSnapshot: MeetingBandwidthSnapshot? { get }
    func buildDebugReport() -> String
}
