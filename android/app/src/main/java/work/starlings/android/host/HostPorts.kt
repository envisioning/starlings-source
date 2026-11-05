package work.starlings.android.host

import kotlinx.coroutines.flow.StateFlow
import work.starlings.android.api.HostRoutes
import work.starlings.android.api.StarlingsClient
import work.starlings.android.api.TeamRoutes
import work.starlings.contracts.MeetingCategoryUpdate
import work.starlings.contracts.ConnectionDetails
import work.starlings.contracts.HostDevice
import work.starlings.contracts.HostHeartbeatResponse
import work.starlings.contracts.HostMutationResponse
import work.starlings.contracts.LobbySnapshotResponse
import work.starlings.contracts.OwnerHostSessionResponse
import work.starlings.contracts.PeerWire
import work.starlings.contracts.SessionDoorResponse

/**
 * What [RoomHost] and [LobbyWatch] send: the host calls of `iOS/StarlingsAPI.swift`.
 * [ClientHostApi] sends them through the signed-in client; the JVM tests
 * answer them from a fake.
 */
interface HostApi {
    suspend fun hostSession(device: HostDevice, room: String?): OwnerHostSessionResponse
    suspend fun heartbeat(room: String, meetingId: String): HostHeartbeatResponse
    suspend fun claim(room: String, meetingId: String, device: HostDevice, ifVacant: Boolean): HostMutationResponse
    suspend fun release(room: String, meetingId: String): HostMutationResponse
    /** Move host…: ask [targetIdentity], another device in the call, to take the host. */
    suspend fun offer(room: String, meetingId: String, targetIdentity: String)
    /** Answer an offer to host a colleague's meeting, as this member. */
    suspend fun answerOffer(room: String, meetingId: String, accept: Boolean)
    suspend fun end(room: String, meetingId: String, everyone: Boolean)
    suspend fun finalize(room: String, meetingId: String)
    suspend fun lobby(room: String): LobbySnapshotResponse
    suspend fun decide(room: String, requestId: String, admit: Boolean, onBehalfOf: String?)
    suspend fun closeSessionDoor(room: String): SessionDoorResponse
    /** File the meeting (`PUT …/category`), as the filing sheet does: Meet about this files the room as it opens. */
    suspend fun setCategory(room: String, meetingId: String, update: MeetingCategoryUpdate)
    /** The team roster, for the recording-notetaker attribution. */
    suspend fun peers(): List<PeerWire>
}

/** [HostApi] over `OwnerAccount.client`. */
class ClientHostApi(private val client: StarlingsClient) : HostApi {
    override suspend fun hostSession(device: HostDevice, room: String?) = client.call(HostRoutes.hostSession(device, room))
    override suspend fun heartbeat(room: String, meetingId: String) = client.call(HostRoutes.heartbeat(room, meetingId))
    override suspend fun claim(room: String, meetingId: String, device: HostDevice, ifVacant: Boolean) =
        client.call(HostRoutes.claim(room, meetingId, device, ifVacant))
    override suspend fun release(room: String, meetingId: String) = client.call(HostRoutes.release(room, meetingId))
    override suspend fun offer(room: String, meetingId: String, targetIdentity: String) {
        client.call(HostRoutes.offer(room, meetingId, targetIdentity))
    }
    override suspend fun answerOffer(room: String, meetingId: String, accept: Boolean) {
        client.call(HostRoutes.answerOffer(room, meetingId, accept))
    }
    override suspend fun end(room: String, meetingId: String, everyone: Boolean) { client.call(HostRoutes.end(room, meetingId, everyone)) }
    override suspend fun finalize(room: String, meetingId: String) { client.call(HostRoutes.finalize(room, meetingId)) }
    override suspend fun lobby(room: String) = client.call(HostRoutes.lobby(room))
    override suspend fun decide(room: String, requestId: String, admit: Boolean, onBehalfOf: String?) {
        client.call(HostRoutes.decide(room, requestId, admit, onBehalfOf))
    }
    override suspend fun closeSessionDoor(room: String) = client.call(HostRoutes.closeSessionDoor(room))
    override suspend fun setCategory(room: String, meetingId: String, update: MeetingCategoryUpdate) {
        client.call(HostRoutes.setCategory(room, meetingId, update))
    }
    override suspend fun peers(): List<PeerWire> = client.call(TeamRoutes.peers).peers
}

/**
 * The media of a hosted call, as [RoomHost] reads it. `MobileRoomHost`
 * holds a `MobileGuestSession`; on Android the call is `CallSession`, which
 * implements this once it can connect with owner credentials (see the
 * hosting hook in the area report).
 */
sealed interface HostMediaState {
    data object Idle : HostMediaState
    data object Connecting : HostMediaState

    /** Connected, audio held: the only state in which the lease renews. */
    data object Live : HostMediaState

    /** LiveKit is re-establishing the connection. */
    data object Reconnecting : HostMediaState

    /** Another app holds the audio (a phone call). The lease lapses like any other host's. */
    data object Interrupted : HostMediaState

    /** LiveKit gave up. The host stops renewing at once and tries one resume. */
    data class Failed(val message: String) : HostMediaState

    /** The room closed under this device: ended elsewhere, removed, or another device took the identity. */
    data object Ended : HostMediaState
}

interface HostMedia {
    val hostState: StateFlow<HostMediaState>

    /**
     * Connects with the owner's connection details. With [microphoneAllowed]
     * false (a companion) the microphone never publishes, not even for the
     * moment before the roster loads. Returns once [hostState] is [HostMediaState.Live]
     * or [HostMediaState.Failed].
     */
    suspend fun connect(room: String, details: ConnectionDetails, microphoneAllowed: Boolean)

    /**
     * This device holds the host, or no longer does. Losing it mutes the
     * microphone and keeps it off; gaining it opens the microphone only with
     * [unmute] (a handover), never on the first start.
     */
    suspend fun setHoldsHost(holds: Boolean, unmute: Boolean)

    suspend fun disconnect()
}

/**
 * Local transcription on the host device (docs/TRANSCRIPTION.md). Android has
 * no transcriber yet, so [RoomHost] gets none and every meeting it hosts
 * finalizes straight away. The rule it holds already: a companion never
 * begins one.
 */
interface HostTranscriber {
    suspend fun begin(room: String, meetingId: String, startedAtMs: Long)

    /** Stop listening and keep what was heard for upload. */
    suspend fun drain()

    /** Upload pending text. True when all of it reached the room. */
    suspend fun flush(room: String, meetingId: String): Boolean

    /** Hand the meeting to the artifact queue after the last text: the outbox's `requestFinalization`. */
    suspend fun requestFinalization(room: String, meetingId: String)
}
