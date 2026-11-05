package work.starlings.android.host

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.android.GuestClient
import work.starlings.android.ParticipantFacts
import work.starlings.android.Tile
import work.starlings.contracts.HostMessageWire
import work.starlings.contracts.HostMessageWireType
import work.starlings.contracts.LobbyRequestResponse
import work.starlings.contracts.LobbyStatusValue
import java.io.IOException

/** Move host… targets, the guest's offer to host, and when a knock becomes a notification. */
class HostTransferTest {
    private fun tile(
        key: String,
        name: String,
        app: String?,
        device: String = "desktop",
        local: Boolean = false,
        host: Boolean = false,
        share: Boolean = false,
    ) = Tile(
        key = key, name = name, initialsOf = name, isLocal = local, speaking = false, video = null, screenShare = share,
        host = host, facts = ParticipantFacts(null, false, false, app?.let { GuestClient(it, device) }),
    )

    @Test
    fun moveHostOffersTheOtherNativeDevicesByName() {
        val tiles = listOf(
            tile("me", "You", "android", "mobile", local = true),
            tile("rosa+mac", "rosa", "mac"),
            tile("ana+ipad", "Ana", "ios", "tablet"),
            tile("ana+iphone", "Ana", "ios", "mobile"),
            tile("bo+android", "Bo", "android", "mobile"),
            tile("guest:web", "Visitor", "web"),
            tile("old", "Old build", null),
            tile("lu+mac", "Lu", "mac", host = true),
            tile("rosa+mac:screen", "Screen", "mac", share = true),
        )
        assertEquals(
            listOf(
                HostTarget("ana+ipad", "Ana", "iPad"),
                HostTarget("ana+iphone", "Ana", "iPhone"),
                HostTarget("bo+android", "Bo", "Android"),
                HostTarget("rosa+mac", "rosa", "Mac"),
            ),
            HostTargets.from(tiles),
        )
    }

    private class AnswerApi(val fails: Boolean = false) : HostApi by Unanswered {
        val answers = mutableListOf<String>()
        override suspend fun answerOffer(room: String, meetingId: String, accept: Boolean) {
            answers += "$room $meetingId $accept"
            if (fails) throw IOException("offline")
        }
    }

    /** Every call but the one under test fails the test. */
    private object Unanswered : HostApi {
        override suspend fun hostSession(device: work.starlings.contracts.HostDevice, room: String?) = error("unexpected")
        override suspend fun heartbeat(room: String, meetingId: String) = error("unexpected")
        override suspend fun claim(room: String, meetingId: String, device: work.starlings.contracts.HostDevice, ifVacant: Boolean) = error("unexpected")
        override suspend fun release(room: String, meetingId: String) = error("unexpected")
        override suspend fun offer(room: String, meetingId: String, targetIdentity: String) = error("unexpected")
        override suspend fun answerOffer(room: String, meetingId: String, accept: Boolean) = error("unexpected")
        override suspend fun end(room: String, meetingId: String, everyone: Boolean) = error("unexpected")
        override suspend fun finalize(room: String, meetingId: String) = error("unexpected")
        override suspend fun lobby(room: String) = error("unexpected")
        override suspend fun decide(room: String, requestId: String, admit: Boolean, onBehalfOf: String?) = error("unexpected")
        override suspend fun closeSessionDoor(room: String) = error("unexpected")
        override suspend fun setCategory(room: String, meetingId: String, update: work.starlings.contracts.MeetingCategoryUpdate) = error("unexpected")
        override suspend fun peers() = error("unexpected")
    }

    private fun offered(target: String?, from: String? = "Ana") =
        HostMessageWire(version = 1, type = HostMessageWireType.OFFERED, targetIdentity = target, fromName = from)

    @Test
    fun aGuestIsAskedOnlyByAnOfferNamingItsOwnConnection() {
        val watch = HostOfferWatch()
        watch.receive(offered("someone-else"), "me")
        assertNull(watch.state.value.from)
        watch.receive(HostMessageWire(version = 1, type = HostMessageWireType.CHANGED, hostIdentity = "me"), "me")
        assertNull(watch.state.value.from)
        watch.receive(offered("me"), null)
        assertNull("not connected yet: nobody to ask", watch.state.value.from)
        watch.receive(offered("me"), "me")
        assertEquals("Ana", watch.state.value.from)
        watch.receive(offered("me", from = null), "me")
        assertEquals("the screen says Someone", "", watch.state.value.from)
    }

    @Test
    fun yesAnswersTheWorkerThenNamesTheRoomToHost() = runBlocking {
        val watch = HostOfferWatch()
        val api = AnswerApi()
        watch.receive(offered("me"), "me")
        assertEquals("ana", watch.answer(true, api, "ana", "m1"))
        assertEquals(listOf("ana m1 true"), api.answers)
        assertNull("the question is closed", watch.state.value.from)
    }

    @Test
    fun noAnswersAndStaysAGuest() = runBlocking {
        val watch = HostOfferWatch()
        val api = AnswerApi()
        watch.receive(offered("me"), "me")
        assertNull(watch.answer(false, api, "ana", "m1"))
        assertEquals(listOf("ana m1 false"), api.answers)
    }

    @Test
    fun aYesTheWorkerRefusedSaysSoAndHostsNothing() = runBlocking {
        val watch = HostOfferWatch()
        watch.receive(offered("me"), "me")
        assertNull(watch.answer(true, AnswerApi(fails = true), "ana", "m1"))
        assertEquals("offline", watch.state.value.failure)
        watch.dismissFailure()
        assertNull(watch.state.value.failure)
    }

    @Test
    fun signedOutOrWithoutAMeetingNothingIsSent() = runBlocking {
        val watch = HostOfferWatch()
        val api = AnswerApi()
        watch.receive(offered("me"), "me")
        assertNull(watch.answer(true, null, "ana", "m1"))
        assertNull(watch.answer(true, api, "ana", null))
        assertEquals(emptyList<String>(), api.answers)
    }

    // Knock notifications

    private val hosting = HostState(phase = HostPhase.HOSTING, holdsHost = true, room = "rosa")

    private fun lobby(count: Int, vararg names: String) = LobbyWatch.State(
        waiting = names.map(::knock),
        knockCount = count,
        announced = names.lastOrNull()?.let(::knock),
    )

    private fun knock(name: String) = LobbyRequestResponse(
        id = name, meetingId = "m1", name = name, email = "", identity = "guest:$name", status = LobbyStatusValue.WAITING, createdAt = 0,
    )

    @Test
    fun aKnockInTheBackgroundIsPostedOnceNamingTheGuest() {
        val gate = KnockNoticeGate()
        assertEquals(KnockNoticeGate.Action.Keep, gate.step(hosting, LobbyWatch.State(), foreground = false))
        assertEquals(KnockNoticeGate.Action.Post("Ana", 1), gate.step(hosting, lobby(1, "Ana"), foreground = false))
        assertEquals("the next poll is no new knock", KnockNoticeGate.Action.Keep, gate.step(hosting, lobby(1, "Ana"), foreground = false))
        assertEquals("a second knock replaces it, with the count", KnockNoticeGate.Action.Post("Bo", 2), gate.step(hosting, lobby(2, "Ana", "Bo"), foreground = false))
        assertEquals("an empty door withdraws it", KnockNoticeGate.Action.Withdraw, gate.step(hosting, lobby(2), foreground = false))
        assertEquals(KnockNoticeGate.Action.Keep, gate.step(hosting, lobby(2), foreground = false))
    }

    @Test
    fun aKnockOnScreenIsNeverPostedLater() {
        val gate = KnockNoticeGate()
        assertEquals(KnockNoticeGate.Action.Keep, gate.step(hosting, lobby(1, "Ana"), foreground = true))
        assertEquals(KnockNoticeGate.Action.Keep, gate.step(hosting, lobby(1, "Ana"), foreground = false))
    }

    @Test
    fun comingBackWithdrawsTheNotification() {
        val gate = KnockNoticeGate()
        gate.step(hosting, lobby(1, "Ana"), foreground = false)
        assertEquals(KnockNoticeGate.Action.Withdraw, gate.step(hosting, lobby(1, "Ana"), foreground = true))
    }

    @Test
    fun aCompanionOrAnEndedMeetingPostsNothing() {
        val gate = KnockNoticeGate()
        val companion = hosting.copy(holdsHost = false)
        assertEquals(KnockNoticeGate.Action.Keep, gate.step(companion, lobby(1, "Ana"), foreground = false))
        assertEquals(KnockNoticeGate.Action.Post("Bo", 2), gate.step(hosting, lobby(2, "Ana", "Bo"), foreground = false))
        assertEquals("losing the host withdraws it", KnockNoticeGate.Action.Withdraw, gate.step(companion, lobby(2, "Ana", "Bo"), foreground = false))
        gate.step(hosting, lobby(3, "Ana", "Bo", "Cy"), foreground = false)
        assertEquals(KnockNoticeGate.Action.Withdraw, gate.step(HostState(phase = HostPhase.ENDED), LobbyWatch.State(), foreground = false))
    }

    @Test
    fun resetWithdrawsWhatIsUp() {
        val gate = KnockNoticeGate()
        assertEquals(KnockNoticeGate.Action.Keep, gate.reset())
        gate.step(hosting, lobby(1, "Ana"), foreground = false)
        assertEquals(KnockNoticeGate.Action.Withdraw, gate.reset())
        assertEquals(KnockNoticeGate.Action.Keep, gate.reset())
    }
}
