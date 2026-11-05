package work.starlings.android.api

import work.starlings.contracts.Acknowledgement
import work.starlings.contracts.PeerAppearOfflineRequest
import work.starlings.contracts.PeerAppearOfflineResponse
import work.starlings.contracts.PeerCallRequest
import work.starlings.contracts.PeerRingRequest

/**
 * The Team routes [TeamRoutes] does not carry yet: a wave, a call, the ring
 * answer and appear offline (`Sources/StarlingsPeerRoutes.swift`). Held to
 * `fixtures/routes.json` by `TeamExtraRoutesTest`.
 */
object TeamExtraRoutes {
    /** A wave: no push, and no promise it arrived. The other side reads it on its next roster poll. */
    fun ring(peerEmail: String): Route<Acknowledgement> = Route(
        "POST", listOf("peers", "ring"), body = json(PeerRingRequest.serializer(), PeerRingRequest(peerEmail)),
        answer = Answer.Wire(Acknowledgement.serializer()), operation = "Couldn’t wave at them",
    )

    /** Ask them to open their room and talk now. */
    fun call(peerEmail: String): Route<Acknowledgement> = Route(
        "POST", listOf("peers", "call"), body = json(PeerCallRequest.serializer(), PeerCallRequest(peerEmail)),
        answer = Answer.Wire(Acknowledgement.serializer()), operation = "Couldn’t call them",
    )

    /** Answered or dismissed: the ring for you goes. */
    val clearRing: Route<Acknowledgement> = Route(
        "POST", listOf("peers", "ring", "clear"), body = EMPTY_BODY,
        answer = Answer.Wire(Acknowledgement.serializer()), operation = "Couldn’t clear that",
    )

    fun appearOffline(invisible: Boolean): Route<PeerAppearOfflineResponse> = Route(
        "POST", listOf("peers", "appear-offline"),
        body = json(PeerAppearOfflineRequest.serializer(), PeerAppearOfflineRequest(invisible)),
        answer = Answer.Wire(PeerAppearOfflineResponse.serializer()), operation = "Couldn’t change your visibility",
    )
}
