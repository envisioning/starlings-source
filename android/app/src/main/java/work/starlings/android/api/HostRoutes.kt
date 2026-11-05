package work.starlings.android.api

import work.starlings.contracts.EndMeetingRequest
import work.starlings.contracts.EndMeetingResponse
import work.starlings.contracts.FinalizeMeetingResponse
import work.starlings.contracts.HostClaimRequest
import work.starlings.contracts.HostDevice
import work.starlings.contracts.HostHeartbeatResponse
import work.starlings.contracts.HostOfferAnswerRequest
import work.starlings.contracts.HostOfferAnswerResponse
import work.starlings.contracts.HostOfferRequest
import work.starlings.contracts.HostOfferResponse
import work.starlings.contracts.HostMutationResponse
import work.starlings.contracts.HostSessionStartRequest
import work.starlings.contracts.LobbyDecisionRequest
import work.starlings.contracts.LobbyDecisionResponse
import work.starlings.contracts.LowerHandsResponse
import work.starlings.contracts.LobbySnapshotResponse
import work.starlings.contracts.MeetingCategoryResponse
import work.starlings.contracts.MeetingCategoryUpdate
import work.starlings.contracts.OwnerHostSessionResponse
import work.starlings.contracts.ParticipantMuteRequest
import work.starlings.contracts.ParticipantMuteResponse
import work.starlings.contracts.ParticipantRemoveRequest
import work.starlings.contracts.ParticipantRemoveResponse
import work.starlings.contracts.Patch
import work.starlings.contracts.ScreenShareStopRequest
import work.starlings.contracts.ScreenShareStopResponse
import work.starlings.contracts.TranscriptViewResponse
import work.starlings.contracts.SessionDoorResponse

/**
 * Hosting the owner's room: the host routes of `Sources/StarlingsRoomRoutes.swift`
 * that `iOS/MobileRoomHost.swift` and `iOS/MobileLobbyWatch.swift` send.
 * None of them is kept as a snapshot: a lease, a queue and a door are live
 * or they are nothing.
 */
object HostRoutes {
    /**
     * Start or resume the owner's meeting: the room, the connection, the
     * lease window and the caption topic. Safe to send again, because the
     * Worker resumes the open meeting. A null [room] is the owner's own room.
     */
    fun hostSession(device: HostDevice?, room: String?): Route<OwnerHostSessionResponse> = Route(
        "POST", listOf("owner", "host-session"),
        body = json(HostSessionStartRequest.serializer(), HostSessionStartRequest(device, room)),
        answer = Answer.Wire(OwnerHostSessionResponse.serializer()), operation = "Couldn’t start your room",
    )

    /** Renew the host lease. The room admits nobody once it lapses. */
    fun heartbeat(room: String, meetingId: String): Route<HostHeartbeatResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "heartbeat"), body = EMPTY_BODY,
        answer = Answer.Wire(HostHeartbeatResponse.serializer()), operation = "Couldn’t keep your room open",
    )

    /** Take the host: at once when nobody holds it, or by asking the host to hand over. [ifVacant] never takes a live host. */
    fun claim(room: String, meetingId: String, device: HostDevice, ifVacant: Boolean): Route<HostMutationResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "host", "claim"),
        body = json(HostClaimRequest.serializer(), HostClaimRequest(device, if (ifVacant) true else null)),
        answer = Answer.Wire(HostMutationResponse.serializer()), operation = "Couldn’t take host",
    )

    /** Stop hosting. The answer says who hosts now; `host` means this device still does. */
    fun release(room: String, meetingId: String): Route<HostMutationResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "host", "release"), body = EMPTY_BODY,
        answer = Answer.Wire(HostMutationResponse.serializer()), operation = "Couldn’t hand over host",
    )

    /** Hand the host to another device in the call (Move host…). The Worker checks that it is an Envisioning member's. */
    fun offer(room: String, meetingId: String, targetIdentity: String): Route<HostOfferResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "host", "offer"),
        body = json(HostOfferRequest.serializer(), HostOfferRequest(targetIdentity)),
        answer = Answer.Wire(HostOfferResponse.serializer()), operation = "Couldn’t move host",
    )

    /** Answer an offer to host, as this member. The room is not theirs. */
    fun answerOffer(room: String, meetingId: String, accept: Boolean): Route<HostOfferAnswerResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "host", "offer", "answer"),
        body = json(HostOfferAnswerRequest.serializer(), HostOfferAnswerRequest(accept)),
        answer = Answer.Wire(HostOfferAnswerResponse.serializer()), operation = "Couldn’t answer",
    )

    /** Who is at the door. Polled while hosting, as the Mac and iOS do. */
    fun lobby(room: String): Route<LobbySnapshotResponse> = Route(
        "GET", listOf("rooms", room, "lobby"),
        answer = Answer.Wire(LobbySnapshotResponse.serializer()), operation = "Couldn’t read your waiting room",
    )

    /** Admit or decline one knock. The Worker checks room ownership and the host lease before it mints anything. */
    fun decide(room: String, requestId: String, admit: Boolean, onBehalfOf: String?): Route<LobbyDecisionResponse> = Route(
        "POST", listOf("rooms", room, "join-requests", requestId, "decision"),
        body = json(LobbyDecisionRequest.serializer(), LobbyDecisionRequest(admit, Patch.ifSome(onBehalfOf))),
        answer = Answer.Wire(LobbyDecisionResponse.serializer()),
        operation = if (admit) "Couldn’t admit that guest" else "Couldn’t decline that guest",
    )

    /** Close an event session's second door (docs/SESSIONS.md §7): registration links stop admitting. */
    fun closeSessionDoor(room: String): Route<SessionDoorResponse> = Route(
        "POST", listOf("rooms", room, "session", "door"),
        answer = Answer.Wire(SessionDoorResponse.serializer()), operation = "Couldn’t close the door",
    )

    /** End the meeting. On a personal room that closes it for everyone; on `/room/team` only [everyone] does. */
    fun end(room: String, meetingId: String, everyone: Boolean): Route<EndMeetingResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "end"),
        body = json(EndMeetingRequest.serializer(), EndMeetingRequest(if (everyone) true else null)),
        answer = Answer.Wire(EndMeetingResponse.serializer()), operation = "Couldn’t end the meeting",
    )

    /** Hand the meeting to the artifact queue. Separate from [end]: media teardown never waits on it. */
    fun finalize(room: String, meetingId: String): Route<FinalizeMeetingResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "finalize"), body = EMPTY_BODY,
        answer = Answer.Wire(FinalizeMeetingResponse.serializer()), operation = "Couldn’t finish the meeting",
    )

    // Moderation (`MobileParticipantsSheet`). The Worker checks room ownership and the host lease before it touches the SFU.

    /** Stop one participant's screen share. It does not take away the right to share again. */
    fun stopScreenShare(room: String, meetingId: String, identity: String): Route<ScreenShareStopResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "screen-share", "stop"),
        body = json(ScreenShareStopRequest.serializer(), ScreenShareStopRequest(identity)),
        answer = Answer.Wire(ScreenShareStopResponse.serializer()), operation = "Couldn’t stop that screen share",
    )

    /** Close one participant's microphone, or everyone's but the host's ([identity] null). There is no unmute. */
    fun mute(room: String, meetingId: String, identity: String?): Route<ParticipantMuteResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "participants", "mute"),
        body = json(ParticipantMuteRequest.serializer(), ParticipantMuteRequest(identity)),
        answer = Answer.Wire(ParticipantMuteResponse.serializer()),
        operation = if (identity == null) "Couldn’t mute everyone else" else "Couldn’t mute that person",
    )

    /** Disconnect one participant and spend their admission: coming back means knocking again. */
    fun remove(room: String, meetingId: String, identity: String): Route<ParticipantRemoveResponse> = Route(
        "POST", listOf("rooms", room, "meetings", meetingId, "participants", "remove"),
        body = json(ParticipantRemoveRequest.serializer(), ParticipantRemoveRequest(identity)),
        answer = Answer.Wire(ParticipantRemoveResponse.serializer()), operation = "Couldn’t remove that person",
    )

    /** Lower every hand in the room: a moderation act, owner-only. Answers how many were up. */
    fun lowerAllHands(room: String, meetingId: String): Route<LowerHandsResponse> = Route(
        "DELETE", listOf("rooms", room, "meetings", meetingId, "hands"),
        answer = Answer.Wire(LowerHandsResponse.serializer()), operation = "Couldn’t lower the hands",
    )

    // Filing and the record (`MobileMeetingFilingView`, `MobileTranscriptPanel`).

    /** How this meeting is filed in Core. */
    fun category(room: String, meetingId: String): Route<MeetingCategoryResponse> = Route(
        "GET", listOf("rooms", room, "meetings", meetingId, "category"),
        answer = Answer.Wire(MeetingCategoryResponse.serializer()), operation = "Couldn’t load how this meeting is filed",
    )

    fun setCategory(room: String, meetingId: String, update: MeetingCategoryUpdate): Route<MeetingCategoryResponse> = Route(
        "PUT", listOf("rooms", room, "meetings", meetingId, "category"),
        body = json(MeetingCategoryUpdate.serializer(), update),
        answer = Answer.Wire(MeetingCategoryResponse.serializer()), operation = "Couldn’t file this meeting",
    )

    /** The meeting's record as its page reads it. The owner reads it while the meeting runs. */
    fun transcript(room: String, meetingId: String): Route<TranscriptViewResponse> = Route(
        "GET", listOf("rooms", room, "meetings", meetingId, "transcript"),
        answer = Answer.Wire(TranscriptViewResponse.serializer()), operation = "Couldn’t load the transcript",
    )
}
