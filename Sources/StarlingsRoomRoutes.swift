import Foundation
import StarlingsContracts

/// The rooms and lobby routes, each named once for the Mac and the
/// phone: the knock and what follows it, the owner's room and its waiting
/// room, the host lease, moderation, the meeting's own record (transcript,
/// end, finalize, category) and what any participant reports with the
/// meeting's artifact token. One name per route, whatever each client calls
/// its method.
///
/// A route does not say whose bearer it carries; the caller does: the owner
/// session for the owner's routes, a lobby token for the knock's status,
/// the artifact token for a participant's own reports, and none for a guest.
enum StarlingsRoomRoutes {
    // MARK: The knock

    /// A knock. A signed-in member sends their session with it: the room
    /// treats a verified member as a caller, not a visitor.
    static func knock(room: String, _ request: JoinRequest) -> StarlingsRoute<JoinRequestReceipt> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "join-requests"], body: request,
            operation: String(localized: "Couldn’t ask to join"),
            origin: true
        )
    }

    /// Pre-knock presence, the native twin of the browser join page's
    /// heartbeat: the one trace a guest leaves for an owner who is away.
    /// A display name at most, never the email (docs/PRIVACY.md).
    static func guestPresence(room: String, _ report: GuestPresenceReport) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "guest-presence"], body: report,
            operation: String(localized: "Couldn’t say you’re here"),
            origin: true
        )
    }

    /// An invite's card. A 404 is an expired or cancelled card, not an outage.
    static func booking(room: String, token: String) -> StarlingsRoute<StarlingsMintedBookingProjection> {
        StarlingsRoute(
            method: "GET", path: ["rooms", room, "bookings", token],
            operation: String(localized: "Couldn’t load this invite")
        )
    }

    /// A room's public face. An internal room answers only a verified member,
    /// so a signed-in caller sends their session.
    static func publicRoom(_ room: String) -> StarlingsRoute<PublicRoomResponse> {
        StarlingsRoute(
            method: "GET", path: ["rooms", room],
            operation: String(localized: "Couldn’t load this room")
        )
    }

    /// The knock's state, read with its lobby token.
    static func joinStatus(room: String, requestID: String) -> StarlingsRoute<JoinStatusResponse> {
        StarlingsRoute(
            method: "GET", path: ["rooms", room, "join-requests", requestID],
            operation: String(localized: "Lost track of your join request")
        )
    }

    /// An admitted knock trades its lobby token for the meeting's connection.
    /// No LiveKit token before the owner admits.
    static func exchangeAdmission(room: String, requestID: String, lobbyToken: String) -> StarlingsRoute<ConnectionDetails> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "join-requests", requestID, "exchange"],
            body: LobbyExchangeRequest(lobbyToken: lobbyToken),
            operation: String(localized: "Couldn’t enter the meeting"),
            origin: true
        )
    }

    // MARK: The owner's room

    static let ownerRoom = StarlingsRoute<OwnerRoomResponse>(
        method: "GET", path: ["owner", "room"],
        operation: String(localized: "Couldn’t load your room"),
        snapshotKey: StarlingsSnapshotKey.ownerRoom
    )

    /// Start or resume hosting the owner's permanent room, or another room
    /// this owner may host. It cannot create a room; repeating it resumes the
    /// open meeting. `device` keeps one device from evicting another: each
    /// publishes under its own identity.
    static func hostSession(device: HostDevice, room: String?) -> StarlingsRoute<OwnerHostSessionResponse> {
        StarlingsRoute(
            method: "POST", path: ["owner", "host-session"],
            body: HostSessionStartRequest(device: device, room: room),
            operation: String(localized: "Couldn’t start your room")
        )
    }

    /// Who is at the door. Polled while hosting, on both clients.
    static func lobby(room: String) -> StarlingsRoute<LobbySnapshotResponse> {
        StarlingsRoute(
            method: "GET", path: ["rooms", room, "lobby"],
            operation: String(localized: "Couldn’t read your waiting room")
        )
    }

    static func updateRoomSettings(room: String, _ settings: RoomSettingsUpdate) -> StarlingsRoute<RoomSettings> {
        StarlingsRoute(
            method: "PATCH", path: ["rooms", room, "settings"], body: settings,
            operation: String(localized: "Couldn’t update room settings")
        )
    }

    /// Admit or decline one knock. The Worker re-checks room ownership and
    /// the host lease before it mints anything.
    static func decide(room: String, requestID: String, admit: Bool, onBehalfOf: String?) -> StarlingsRoute<LobbyDecisionResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "join-requests", requestID, "decision"],
            body: LobbyDecisionRequest(admit: admit, onBehalfOf: .ifSome(onBehalfOf)),
            operation: admit ? String(localized: "Couldn’t admit that guest") : String(localized: "Couldn’t decline that guest")
        )
    }

    /// Close the second door of an event session (docs/SESSIONS.md §7):
    /// registration links stop admitting, and those guests knock again.
    static func closeSessionDoor(room: String) -> StarlingsRoute<SessionDoorResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "session", "door"],
            operation: String(localized: "Couldn’t close the door")
        )
    }

    /// Close a pre-knock visitor's connection and block their tab from
    /// announcing again for a while: the strongest thing a host can do to
    /// somebody with no live socket.
    static func removeGuestPresence(room: String, presenceID: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "guest-presence", presenceID, "remove"],
            operation: String(localized: "Couldn’t remove that visitor")
        )
    }

    /// Soft host presence while idle on the owner's launch screen.
    static func touchPresence(room: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "presence"],
            operation: String(localized: "Couldn’t update presence")
        )
    }

    // MARK: The host

    /// Renew the host lease. The room admits nobody once it lapses.
    static func hostHeartbeat(room: String, meetingID: String) -> StarlingsRoute<HostHeartbeatResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "heartbeat"], body: StarlingsEmptyBody(),
            operation: String(localized: "Couldn’t keep your room open")
        )
    }

    /// Take the host: at once when nobody holds it, or by asking the current
    /// host to hand over. `ifVacant` never takes a live host.
    static func claimHost(room: String, meetingID: String, device: HostDevice, ifVacant: Bool) -> StarlingsRoute<HostMutationResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "host", "claim"],
            body: HostClaimRequest(device: device, ifVacant: ifVacant ? true : nil),
            operation: String(localized: "Couldn’t take host")
        )
    }

    /// Ask one device in the call to host.
    static func offerHost(room: String, meetingID: String, targetIdentity: String) -> StarlingsRoute<HostOfferResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "host", "offer"],
            body: HostOfferRequest(targetIdentity: targetIdentity),
            operation: String(localized: "Couldn’t move host")
        )
    }

    /// Answer an offer to host, as this member. The room is not theirs.
    static func answerHostOffer(room: String, meetingID: String, accept: Bool) -> StarlingsRoute<HostOfferAnswerResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "host", "offer", "answer"],
            body: HostOfferAnswerRequest(accept: accept),
            operation: String(localized: "Couldn’t answer")
        )
    }

    /// Stop hosting. The answer says who hosts now.
    static func releaseHost(room: String, meetingID: String) -> StarlingsRoute<HostMutationResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "host", "release"], body: StarlingsEmptyBody(),
            operation: String(localized: "Couldn’t hand over host")
        )
    }

    // MARK: Moderation

    /// Stop one participant's screen share. It stops the share in flight; it
    /// does not take away the right to share again.
    static func stopScreenShare(room: String, meetingID: String, identity: String) -> StarlingsRoute<ScreenShareStopResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "screen-share", "stop"],
            body: ScreenShareStopRequest(identity: identity),
            operation: String(localized: "Couldn’t stop that screen share")
        )
    }

    /// Close one participant's microphone, or everyone's but the host's (a nil
    /// identity). There is no unmute: reopening a microphone belongs to the
    /// person behind it.
    static func muteParticipant(room: String, meetingID: String, identity: String?) -> StarlingsRoute<ParticipantMuteResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "participants", "mute"],
            body: ParticipantMuteRequest(identity: identity),
            operation: identity == nil ? String(localized: "Couldn’t mute everyone else") : String(localized: "Couldn’t mute that person")
        )
    }

    /// What the host reads after a mute: `muted` counts the microphones it
    /// closed, so zero means nothing changed (already off, or not in the room).
    static func muteOutcome(muted: Int, everyone: Bool) -> String {
        switch (everyone, muted) {
        case (false, 0): String(localized: "Their microphone was already off.")
        case (false, _): String(localized: "Microphone muted.")
        case (true, 0): String(localized: "No one else had a microphone on.")
        case (true, 1): String(localized: "Muted 1 microphone.")
        case (true, _): String(localized: "Muted \(muted) microphones.")
        }
    }

    /// Disconnect one participant and spend their admission, so coming back
    /// means knocking again.
    static func removeParticipant(room: String, meetingID: String, identity: String) -> StarlingsRoute<ParticipantRemoveResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "participants", "remove"],
            body: ParticipantRemoveRequest(identity: identity),
            operation: String(localized: "Couldn’t remove that person")
        )
    }

    /// Lower every hand in the room: a moderation act, owner-only. Answers how
    /// many were up.
    static func lowerAllHands(room: String, meetingID: String) -> StarlingsRoute<LowerHandsResponse> {
        StarlingsRoute(
            method: "DELETE", path: ["rooms", room, "meetings", meetingID, "hands"],
            operation: String(localized: "Couldn’t lower the hands")
        )
    }

    // MARK: The meeting's record

    /// Finalized transcript text, in batches. Never audio, never a partial
    /// segment. Idempotent by segment id, which makes an outbox retry safe.
    static func appendTranscript(room: String, meetingID: String, segments: [TranscriptSegment]) -> StarlingsRoute<TranscriptAppendResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "transcript"],
            body: TranscriptBatch(segments: segments.map(\.wire)),
            operation: String(localized: "Couldn’t upload the transcript")
        )
    }

    /// The meeting's record as its page reads it. The owner reads
    /// it live; anyone else once it is filed and over.
    static func transcript(room: String, meetingID: String) -> StarlingsRoute<TranscriptViewResponse> {
        StarlingsRoute(
            method: "GET", path: ["rooms", room, "meetings", meetingID, "transcript"],
            operation: String(localized: "Couldn’t load the transcript")
        )
    }

    /// A meeting the Mac captured outside any room, created on the owner's
    /// room with its roster (docs/AMBIENT_CAPTURE.md).
    static func createAmbientMeeting(room: String, _ request: AmbientMeetingRequest) -> StarlingsRoute<AmbientMeetingResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", "ambient"], body: request,
            operation: String(localized: "Couldn’t file the recording")
        )
    }

    /// Mark the meeting ended now; `finalize` still runs after it for the
    /// artifact. On `/room/team` the call stays up for whoever remains unless
    /// `everyone`.
    static func end(room: String, meetingID: String, everyone: Bool) -> StarlingsRoute<EndMeetingResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "end"],
            body: EndMeetingRequest(everyone: everyone ? true : nil),
            operation: String(localized: "Couldn’t end the meeting")
        )
    }

    /// Close a meeting this client never joined: the one a crash left open.
    /// No artifact to finalize and no lease to renew.
    static func closeOpenMeeting(room: String, meetingID: String) -> StarlingsRoute<EndMeetingResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "end"],
            operation: String(localized: "Couldn’t close the room")
        )
    }

    /// Hand the meeting to the artifact queue. Separate from `end` on purpose:
    /// media teardown must not wait on it.
    static func finalize(room: String, meetingID: String) -> StarlingsRoute<FinalizeMeetingResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "finalize"], body: StarlingsEmptyBody(),
            operation: String(localized: "Couldn’t finish the meeting")
        )
    }

    /// How this meeting is filed in the CRM. Members only: it rides on the
    /// owner session, never the artifact token.
    static func category(room: String, meetingID: String) -> StarlingsRoute<MeetingCategory> {
        StarlingsRoute(
            method: "GET", path: ["rooms", room, "meetings", meetingID, "category"],
            operation: String(localized: "Couldn’t load how this meeting is filed")
        )
    }

    static func setCategory(room: String, meetingID: String, _ update: MeetingCategoryUpdate) -> StarlingsRoute<MeetingCategory> {
        StarlingsRoute(
            method: "PUT", path: ["rooms", room, "meetings", meetingID, "category"], body: update,
            operation: String(localized: "Couldn’t file this meeting")
        )
    }

    /// A chunk of live transcript in, proposed commitments out. Stateless on
    /// the Worker; the client keeps the suggestions and checks the quotes.
    static func proposeTaskCandidates(room: String, meetingID: String, excerpt: String, knownTitles: [String]) -> StarlingsRoute<TaskCandidatesResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "task-candidates"],
            body: TaskCandidateRequest(excerpt: excerpt, knownTitles: knownTitles.isEmpty ? nil : knownTitles),
            operation: String(localized: "Couldn’t propose tasks")
        )
    }

    // MARK: A participant's own reports (artifact token)

    /// This client's own call quality. The server takes identity and role
    /// from the token, never the body.
    static func reportQuality(room: String, meetingID: String, _ report: MeetingQualityReport) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "quality"], body: report,
            operation: String(localized: "Couldn’t report call quality")
        )
    }

    /// This client's cumulative LiveKit receiver-byte estimate.
    static func reportDownstreamUsage(room: String, meetingID: String, _ report: DownstreamUsageReport) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "downstream-usage"], body: report,
            operation: String(localized: "Couldn’t report downstream usage")
        )
    }

    /// What a pasted link in the meeting's chat points at. Authorized by the
    /// meeting, not an account: a guest has none.
    static func linkPreview(room: String, meetingID: String, url link: String) -> StarlingsRoute<LinkPreviewEnvelope> {
        StarlingsRoute(
            method: "GET", path: ["rooms", room, "meetings", meetingID, "link-preview"],
            query: LinkPreviewQuery(url: link).queryItems,
            operation: String(localized: "Couldn’t read that link")
        )
    }

    /// Put this client's own hand up or down. The token decides whose hand;
    /// the Worker writes the attribute (`MeetingHands`).
    static func setOwnHand(room: String, meetingID: String, raised: Bool) -> StarlingsRoute<HandResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", room, "meetings", meetingID, "hand"], body: HandUpdate(raised: raised),
            operation: raised ? String(localized: "Couldn’t raise your hand") : String(localized: "Couldn’t lower your hand")
        )
    }
}
