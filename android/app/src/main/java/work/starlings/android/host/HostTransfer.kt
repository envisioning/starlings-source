package work.starlings.android.host

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import work.starlings.android.Tile
import work.starlings.contracts.HostMessageWire
import work.starlings.contracts.HostMessageWireType

/** One device in the call that Move host… can hand the host to. */
data class HostTarget(val identity: String, val name: String, val device: String)

/**
 * `MobileGuestSession.hostTargets`: the other native devices in the call
 * that could host, sorted by name. The Worker checks that each is an
 * Envisioning member's. Android is on the list too: its host and its guest
 * session both answer an offer.
 */
object HostTargets {
    fun from(tiles: List<Tile>): List<HostTarget> = tiles
        .filter { !it.isLocal && !it.screenShare && !it.host }
        .mapNotNull { tile ->
            val client = tile.facts.app ?: return@mapNotNull null
            // The device names stay English, as the client badges do on iOS.
            val device = when (client.app) {
                "mac" -> "Mac"
                "ios" -> if (client.device == "tablet") "iPad" else "iPhone"
                "android" -> "Android"
                else -> return@mapNotNull null
            }
            HostTarget(tile.key, tile.name.ifBlank { tile.key }, device)
        }
        .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER, HostTarget::name))
}

/**
 * An offer to host a colleague's meeting, received in the call as a guest
 * (`JoinViewModel.hostOfferFrom`). Only a signed-in member can
 * answer it: the answer is the member's, not the guest's. Yes leaves the
 * call as a guest; the app opens the room again as its host.
 */
class HostOfferWatch {
    data class State(
        /** Who asked, while the question is open. Blank when the Worker named nobody ("Someone"). */
        val from: String? = null,
        /** Why a yes did not go through, in English (an error). */
        val failure: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** A `host.v1` message from the guest call. Only an offer naming this connection asks anything. */
    fun receive(message: HostMessageWire, ownIdentity: String?) {
        if (message.type != HostMessageWireType.OFFERED || ownIdentity == null || message.targetIdentity != ownIdentity) return
        _state.value = State(from = message.fromName?.trim().orEmpty())
    }

    /**
     * Answers the open offer for the call on [room] and [meetingId]. The
     * room's slug on a yes the Worker took, so the caller opens it as host;
     * null otherwise. No [api] (signed out) answers nothing.
     */
    suspend fun answer(accept: Boolean, api: HostApi?, room: String?, meetingId: String?): String? {
        _state.value = State()
        if (api == null || room == null || meetingId == null) return null
        try {
            api.answerOffer(room, meetingId, accept)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (accept) _state.update { it.copy(failure = RoomHost.describe(e)) }
            return null
        }
        return if (accept) room else null
    }

    fun dismissFailure() {
        _state.update { it.copy(failure = null) }
    }

    /** The call ended: the question goes with it. */
    fun clear() {
        _state.value = State()
    }
}
