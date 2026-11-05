package work.starlings.android.host

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import work.starlings.android.api.StarlingsApiError
import work.starlings.contracts.GuestPresenceRow
import work.starlings.contracts.LobbyRequestResponse
import work.starlings.contracts.LobbySnapshotResponseMeeting
import work.starlings.contracts.LobbyStatusValue
import work.starlings.contracts.PeerWire

/**
 * The owner's waiting room, as `iOS/MobileLobbyWatch.swift`: it polls the
 * owner queue every [pollMs] (`StarlingsPollingCadence.lobbyFallback`, 5 s)
 * rather than holding the lobby socket, which the Mac does too.
 */
class LobbyWatch(
    private val api: HostApi,
    private val scope: CoroutineScope,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val pollMs: Long = POLL_MS,
) {
    data class State(
        /** Knocks awaiting a decision, oldest knock first. */
        val waiting: List<LobbyRequestResponse> = emptyList(),
        /** Visitors on the join page who have not knocked. */
        val lurking: List<GuestPresenceRow> = emptyList(),
        /** The team roster, loaded once a recording notetaker waits. */
        val people: List<PeerWire> = emptyList(),
        /**
         * Set when the queue could not be read: the failure's operation, in
         * English. The sheet says so rather than showing an empty room,
         * which would read as "nobody there".
         */
        val unavailable: String? = null,
        /** Requests with a decision in flight, so a double tap cannot admit twice. */
        val deciding: Set<String> = emptySet(),
        /** Ticks once per knock announced: the count, not the queue, so a guest who leaves buzzes nothing. */
        val knockCount: Int = 0,
        /** The knock [knockCount] last ticked for: the guest a knock notification names. */
        val announced: LobbyRequestResponse? = null,
        val sessionDoorOpen: Boolean = false,
        val closingSessionDoor: Boolean = false,
    ) {
        /** What the waiting-room button counts. */
        val count: Int get() = waiting.size + lurking.size
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** The open meeting on every poll, for the host to reconcile who hosts when a `host.v1` message was lost. */
    var onMeeting: (suspend (LobbySnapshotResponseMeeting?) -> Unit)? = null

    private var room: String? = null
    private var poll: Job? = null
    private var announced: Set<String> = emptySet()
    private var loadedPeople = false

    fun start(room: String) {
        this.room = room
        if (poll != null) return
        poll = scope.launch {
            while (isActive) {
                refresh()
                sleep(pollMs)
            }
        }
    }

    fun stop() {
        poll?.cancel()
        poll = null
        room = null
        announced = emptySet()
        loadedPeople = false
        _state.value = State()
    }

    /** True when the control plane took the decision. */
    suspend fun admit(requestId: String, onBehalfOf: String? = null): Boolean = decide(requestId, true, onBehalfOf)

    suspend fun decline(requestId: String): Boolean = decide(requestId, false, null)

    /** Registration links stop admitting for the rest of the session. True when the control plane took it. */
    suspend fun closeSessionDoor(): Boolean {
        val room = room ?: return false
        if (_state.value.closingSessionDoor) return false
        _state.update { it.copy(closingSessionDoor = true) }
        return try {
            val open = api.closeSessionDoor(room).sessionDoorOpen
            _state.update { it.copy(sessionDoorOpen = open, closingSessionDoor = false) }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(unavailable = describe(e), closingSessionDoor = false) }
            false
        }
    }

    private suspend fun decide(requestId: String, admit: Boolean, onBehalfOf: String?): Boolean {
        val room = room ?: return false
        if (requestId in _state.value.deciding) return false
        _state.update { it.copy(deciding = it.deciding + requestId) }
        return try {
            api.decide(room, requestId, admit, onBehalfOf)
            // Drop the row now rather than at the next poll: a row that lingers invites a second tap.
            announced = announced - requestId
            _state.update { s -> s.copy(waiting = s.waiting.filterNot { it.id == requestId }, deciding = s.deciding - requestId) }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(unavailable = describe(e), deciding = it.deciding - requestId) }
            false
        }
    }

    internal suspend fun refresh() {
        val room = room ?: return
        try {
            val snapshot = api.lobby(room)
            onMeeting?.invoke(snapshot.meeting)
            if (this.room != room) return
            val queue = waitingQueue(snapshot.requests)
            _state.update {
                it.copy(
                    unavailable = null,
                    sessionDoorOpen = snapshot.meeting?.sessionDoorOpen == true,
                    waiting = queue,
                    lurking = snapshot.lurkers.sortedBy(GuestPresenceRow::createdAt),
                )
            }
            if (!loadedPeople && queue.any { it.recording == true }) {
                try {
                    val roster = api.peers()
                    loadedPeople = true
                    _state.update { it.copy(people = roster) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Without the roster the notetaker cannot be attributed; the row says so by offering no choice.
                }
            }
            announce(queue)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(unavailable = describe(e)) }
        }
    }

    /** Announce a knock once: the queue holds a waiting row for as long as the guest stands there. */
    private fun announce(queue: List<LobbyRequestResponse>) {
        val ids = queue.map { it.id }.toSet()
        announced = announced intersect ids
        val next = queue.firstOrNull { it.id !in announced } ?: return
        announced = announced + next.id
        _state.update { it.copy(knockCount = it.knockCount + 1, announced = next) }
    }

    companion object {
        /** `StarlingsPollingCadence.lobbyFallback`. */
        const val POLL_MS = 5_000L

        /** Still awaiting an owner decision (`LobbyStatusValue.isPending`), in server knock order. */
        fun waitingQueue(requests: List<LobbyRequestResponse>): List<LobbyRequestResponse> =
            requests.filter { it.status == LobbyStatusValue.WAITING }.sortedBy(LobbyRequestResponse::createdAt)

        /** A recording notetaker is admitted only once someone on the team is named as its sender. */
        fun canAdmit(request: LobbyRequestResponse, chosenSender: String?): Boolean =
            request.recording != true || (chosenSender ?: request.onBehalfOf) != null

        internal fun describe(e: Exception): String = (e as? StarlingsApiError)?.sentence ?: (e.message ?: e.javaClass.simpleName)
    }
}
