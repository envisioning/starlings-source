package work.starlings.android.host

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.ConnectionDetails
import work.starlings.contracts.HostDevice
import work.starlings.contracts.HostHeartbeatResponse
import work.starlings.contracts.HostLeaseGrant
import work.starlings.contracts.HostMessageWire
import work.starlings.contracts.HostMessageWireType
import work.starlings.contracts.HostMutationResponse
import work.starlings.contracts.HostMutationResponseStatus
import work.starlings.contracts.LobbyRequestResponse
import work.starlings.contracts.LobbySnapshotResponse
import work.starlings.contracts.LobbySnapshotResponseMeeting
import work.starlings.contracts.LobbyStatusValue
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.MeetingCategoryUpdate
import work.starlings.contracts.OwnerHostRoomConfiguration
import work.starlings.contracts.OwnerHostSessionResponse
import work.starlings.contracts.OwnerHostSessionResponseCaptions
import work.starlings.contracts.PeerKindValue
import work.starlings.contracts.PeerStatusValue
import work.starlings.contracts.PeerWire
import work.starlings.contracts.SessionDoorResponse
import java.io.IOException

/** [RoomHost] and [LobbyWatch] on a fake clock, a fake API and fake media: no network, no LiveKit. */
class RoomHostTest {
    private val me = "rosa+iphone-i1@org.example"
    private val mac = "rosa+mac-m1@org.example"

    /** Sleepers wake only when the test moves the clock. */
    private class FakeTime(var now: Long = 1_000_000L) {
        private val sleepers = mutableListOf<Pair<Long, CompletableDeferred<Unit>>>()

        suspend fun sleep(ms: Long) {
            val wake = CompletableDeferred<Unit>()
            sleepers += (now + ms) to wake
            wake.await()
        }

        suspend fun advance(ms: Long) {
            val target = now + ms
            settle()
            while (true) {
                val next = sleepers.filter { it.first <= target && !it.second.isCompleted }.minByOrNull { it.first } ?: break
                now = next.first
                sleepers.remove(next)
                next.second.complete(Unit)
                settle()
            }
            now = target
            settle()
        }
    }

    private class FakeApi(val holdsHost: Boolean = true) : HostApi {
        val calls = mutableListOf<String>()
        var heartbeatFails = false
        var lobbyAnswer = LobbySnapshotResponse(requests = emptyList(), lurkers = emptyList())
        var claimStatus = HostMutationResponseStatus.HOST
        var claimFails = false
        var offerFails = false
        /** What each release answers, in turn; then `released`. */
        val releases = ArrayDeque<HostMutationResponseStatus>()
        var sessions = 0
        var sessionFails = false
        var now: () -> Long = { 0L }

        override suspend fun hostSession(device: HostDevice, room: String?): OwnerHostSessionResponse {
            calls += "host-session $device"
            sessions += 1
            if (sessionFails) throw IOException("offline")
            return OwnerHostSessionResponse(
                room = OwnerHostRoomConfiguration(room ?: "rosa"),
                connection = ConnectionDetails(
                    serverUrl = "wss://sfu", participantToken = "t", participantTokenExpiresAt = 0, artifactToken = "a",
                    meetingId = "m1", livekitRoom = "lk", startedAt = 0,
                    ownerIdentity = "rosa+iphone-i1@org.example",
                    hostIdentity = if (holdsHost) "rosa+iphone-i1@org.example" else "rosa+mac-m1@org.example",
                    isHost = holdsHost,
                ),
                lease = HostLeaseGrant(hostLeaseExpiresAt = now() + 30_000, renewAfterMs = 10_000),
                captions = OwnerHostSessionResponseCaptions(publisherIdentity = "rosa+iphone-i1@org.example"),
            )
        }

        override suspend fun heartbeat(room: String, meetingId: String): HostHeartbeatResponse {
            calls += "heartbeat"
            if (heartbeatFails) throw IOException("offline")
            return HostHeartbeatResponse(now() + 30_000, 10_000, ok = true)
        }

        override suspend fun claim(room: String, meetingId: String, device: HostDevice, ifVacant: Boolean): HostMutationResponse {
            calls += "claim vacant=$ifVacant"
            if (claimFails) throw IOException("offline")
            return HostMutationResponse(claimStatus, hostLeaseExpiresAt = now() + 30_000)
        }

        override suspend fun release(room: String, meetingId: String): HostMutationResponse {
            calls += "release"
            return HostMutationResponse(releases.removeFirstOrNull() ?: HostMutationResponseStatus.RELEASED, hostLeaseExpiresAt = now())
        }

        override suspend fun offer(room: String, meetingId: String, targetIdentity: String) {
            calls += "offer $targetIdentity"
            if (offerFails) throw IOException("offline")
        }

        override suspend fun answerOffer(room: String, meetingId: String, accept: Boolean) { calls += "answer $room $meetingId accept=$accept" }

        override suspend fun end(room: String, meetingId: String, everyone: Boolean) { calls += "end everyone=$everyone" }
        override suspend fun finalize(room: String, meetingId: String) { calls += "finalize" }
        override suspend fun lobby(room: String): LobbySnapshotResponse { calls += "lobby"; return lobbyAnswer }
        override suspend fun decide(room: String, requestId: String, admit: Boolean, onBehalfOf: String?) {
            calls += "decide $requestId admit=$admit for=$onBehalfOf"
        }
        override suspend fun closeSessionDoor(room: String) = SessionDoorResponse(false)
        var categoryFails = false
        override suspend fun setCategory(room: String, meetingId: String, update: MeetingCategoryUpdate) {
            calls += "category $room $meetingId ${update.meetingKind.value}"
            if (categoryFails) throw IOException("offline")
        }
        override suspend fun peers(): List<PeerWire> = listOf(PeerWire(
            email = "ana@org.example", name = "Ana", kind = PeerKindValue.known.first(), status = PeerStatusValue.known.first(),
            lastSeenAt = 0, clients = emptyList(), invisible = false, participants = 0, isSelf = false,
        ))
    }

    private class FakeMedia(val log: MutableList<String>) : HostMedia {
        val flow = MutableStateFlow<HostMediaState>(HostMediaState.Idle)
        override val hostState: StateFlow<HostMediaState> = flow
        var micAllowed: Boolean? = null
        var failOnConnect = false

        override suspend fun connect(room: String, details: ConnectionDetails, microphoneAllowed: Boolean) {
            log += "connect mic=$microphoneAllowed"
            micAllowed = microphoneAllowed
            flow.value = if (failOnConnect) HostMediaState.Failed("no media") else HostMediaState.Live
        }

        override suspend fun setHoldsHost(holds: Boolean, unmute: Boolean) {
            log += "holds=$holds unmute=$unmute"
            micAllowed = holds
        }

        override suspend fun disconnect() {
            log += "disconnect"
            flow.value = HostMediaState.Idle
        }
    }

    private class FakeTranscriber(val log: MutableList<String>) : HostTranscriber {
        override suspend fun begin(room: String, meetingId: String, startedAtMs: Long) { log += "transcribe" }
        override suspend fun drain() { log += "drain" }
        override suspend fun flush(room: String, meetingId: String) = true
        override suspend fun requestFinalization(room: String, meetingId: String) { log += "outbox finalize" }
    }

    private class Rig(holdsHost: Boolean = true) {
        val time = FakeTime()
        val api = FakeApi(holdsHost).also { a -> a.now = { time.now } }
        val media = FakeMedia(api.calls)
        lateinit var host: RoomHost

        fun build(scope: CoroutineScope, transcribes: Boolean = false, room: String? = null, claimsHostOnJoin: Boolean = false, filing: MeetingCategoryUpdate? = null) {
            host = RoomHost(
                api, media, scope, HostDevice.IPHONE,
                requestedRoom = room,
                claimsHostOnJoin = claimsHostOnJoin,
                filing = filing,
                transcriber = if (transcribes) FakeTranscriber(api.calls) else null,
                onOwnMeetingEnded = { _, _ -> api.calls += "nudge" },
                clock = { time.now }, sleep = time::sleep,
            )
        }
        val beats get() = api.calls.count { it == "heartbeat" }
    }

    private fun hosting(
        holdsHost: Boolean = true,
        transcribes: Boolean = false,
        room: String? = null,
        claimsHostOnJoin: Boolean = false,
        filing: MeetingCategoryUpdate? = null,
        categoryFails: Boolean = false,
        test: suspend Rig.() -> Unit,
    ) = runBlocking {
        val rig = Rig(holdsHost)
        rig.api.categoryFails = categoryFails
        val scope = CoroutineScope(coroutineContext + Job())
        rig.build(scope, transcribes, room, claimsHostOnJoin, filing)
        try {
            rig.host.start()
            settle()
            rig.test()
        } finally {
            scope.cancel()
        }
    }

    private val about = MeetingFiling.about(CrmSubjectKind.LEAD, "l1", "Acme")

    @Test
    fun meetAboutThisFilesTheRoomBeforeItConnects() = hosting(filing = about) {
        assertEquals("filed as the meeting exists", "category rosa m1 lead", api.calls[1])
        assertEquals("then the media", "connect mic=true", api.calls[2])
        assertEquals(HostPhase.HOSTING, host.state.value.phase)
        assertNull(host.state.value.notice)
    }

    @Test
    fun aRefusedFilingStillOpensTheRoomAndSaysSo() = hosting(filing = about, categoryFails = true) {
        assertEquals(HostPhase.HOSTING, host.state.value.phase)
        assertEquals(HostNotice.FilingFailed, host.state.value.notice)
    }

    @Test
    fun aPlainStartFilesNothing() = hosting {
        assertFalse(api.calls.any { it.startsWith("category") })
    }

    @Test
    fun hostRenewsAtTheWorkersPace() = hosting {
        assertEquals(HostPhase.HOSTING, host.state.value.phase)
        assertTrue(host.state.value.holdsHost)
        assertEquals("connect mic=true", api.calls[1])
        assertEquals("a first start never unmutes", "holds=true unmute=false", api.calls[2])
        assertEquals(0, beats)
        time.advance(10_000)
        assertEquals(1, beats)
        time.advance(20_000)
        assertEquals(3, beats)
        assertEquals(time.now + 30_000, host.state.value.leaseExpiresAtMs)
        assertFalse(host.state.value.leaseLapsed)
    }

    @Test
    fun interruptionStopsRenewingAndTheLeaseLapsesWithNoGrace() = hosting {
        time.advance(10_000)
        assertEquals(1, beats)
        val expires = host.state.value.leaseExpiresAtMs!!
        media.flow.value = HostMediaState.Interrupted
        settle()
        time.advance(29_999)
        assertEquals("no beat while another app holds the audio", 1, beats)
        assertFalse(host.state.value.leaseLapsed)
        time.advance(10_000)
        assertTrue(time.now >= expires)
        assertTrue(host.state.value.leaseLapsed)
        // Back: renew now, not at the next tick.
        media.flow.value = HostMediaState.Live
        settle()
        assertEquals(2, beats)
        assertFalse(host.state.value.leaseLapsed)
    }

    @Test
    fun reconnectingDoesNotRenewEither() = hosting {
        media.flow.value = HostMediaState.Reconnecting
        settle()
        time.advance(40_000)
        assertEquals(0, beats)
        assertTrue(host.state.value.leaseLapsed)
    }

    @Test
    fun failedBeatsSayNothingUntilTheGrantRunsOut() = hosting {
        api.heartbeatFails = true
        time.advance(20_000)
        assertEquals(2, beats)
        assertFalse(host.state.value.leaseLapsed)
        time.advance(10_000)
        assertTrue(host.state.value.leaseLapsed)
        api.heartbeatFails = false
        time.advance(10_000)
        assertFalse(host.state.value.leaseLapsed)
    }

    @Test
    fun mediaFailureStopsTheLeaseThenResumesOnce() = hosting {
        media.flow.value = HostMediaState.Failed("gone")
        settle()
        assertEquals(2, api.sessions)
        val disconnect = api.calls.indexOf("disconnect")
        val second = api.calls.indexOfLast { it.startsWith("host-session") }
        assertTrue("teardown before the resume", disconnect in 0 until second)
        assertEquals(HostPhase.HOSTING, host.state.value.phase)
        time.advance(10_000)
        assertEquals("one heartbeat loop, not two", 1, beats)
    }

    @Test
    fun aResumeThatFailsShowsTheFailureAndNeverBeats() = hosting {
        api.sessionFails = true
        media.flow.value = HostMediaState.Failed("gone")
        settle()
        assertEquals(HostPhase.FAILED, host.state.value.phase)
        time.advance(60_000)
        assertEquals(0, beats)
        assertEquals("the lobby stopped too", 1, api.calls.count { it == "lobby" })
    }

    @Test
    fun mediaThatNeverConnectsFails() = runBlocking {
        val rig = Rig()
        val scope = CoroutineScope(coroutineContext + Job())
        rig.build(scope)
        rig.media.failOnConnect = true
        rig.host.start().join()
        assertEquals(HostPhase.FAILED, rig.host.state.value.phase)
        assertEquals("no media", rig.host.state.value.failure)
        assertTrue(rig.api.calls.contains("disconnect"))
        scope.cancel()
    }

    @Test
    fun companionJoinsWithTheMicOffAndNeverTranscribesOrRenews() = hosting(holdsHost = false, transcribes = true) {
        val s = host.state.value
        assertTrue(s.isCompanion)
        assertFalse(s.exitEndsMeeting)
        assertEquals(false, media.micAllowed)
        assertEquals("connect mic=false", api.calls[1])
        assertFalse(api.calls.contains("transcribe"))
        assertFalse(s.transcribing)
        time.advance(60_000)
        assertEquals(0, beats)
    }

    @Test
    fun hostTranscribesAndFinalizesThroughTheOutbox() = hosting(transcribes = true) {
        assertTrue(host.state.value.transcribing)
        host.end().join()
        settle()
        val order = api.calls.filter { it in setOf("end everyone=false", "drain", "disconnect", "outbox finalize", "finalize") }
        assertEquals(listOf("end everyone=false", "drain", "disconnect", "outbox finalize"), order)
    }

    @Test
    fun endClosesTheRoomFirstThenMediaThenFinalizes() = hosting {
        host.end().join()
        assertEquals(HostPhase.ENDED, host.state.value.phase)
        settle()
        val order = api.calls.filter { it.startsWith("end") || it == "disconnect" || it == "finalize" }
        assertEquals(listOf("end everyone=false", "disconnect", "finalize"), order)
        time.advance(60_000)
        assertEquals(0, beats)
    }

    @Test
    fun endingYourOwnRoomAsksAboutFilingOnce() = hosting {
        host.end().join()
        settle()
        assertEquals(1, api.calls.count { it == "nudge" })
        assertTrue("after the end call", api.calls.indexOf("nudge") > api.calls.indexOf("end everyone=false"))
    }

    @Test
    fun theTeamRoomAndACompanionAskNothing() {
        hosting(room = RoomHost.INTERNAL_ROOM) {
            host.end().join()
            settle()
            assertFalse(api.calls.contains("nudge"))
        }
        hosting(holdsHost = false) {
            host.end().join()
            settle()
            assertFalse(api.calls.contains("nudge"))
        }
    }

    @Test
    fun aCompanionLeavesWithoutEndingOrFinalizing() = hosting(holdsHost = false) {
        host.end().join()
        settle()
        assertEquals(HostPhase.ENDED, host.state.value.phase)
        assertFalse(api.calls.any { it.startsWith("end") || it == "finalize" })
        assertTrue(api.calls.contains("disconnect"))
    }

    @Test
    fun aRoomClosedElsewhereEndsHereWithoutEndingAgain() = hosting {
        media.flow.value = HostMediaState.Ended
        settle()
        assertEquals(HostPhase.ENDED, host.state.value.phase)
        assertFalse(api.calls.any { it.startsWith("end") || it == "finalize" })
        time.advance(60_000)
        assertEquals(0, beats)
    }

    @Test
    fun aCompanionTakesAVacantHostFromTheLobbyPoll() = hosting(holdsHost = false) {
        api.lobbyAnswer = LobbySnapshotResponse(
            meeting = meeting(host = null, expires = time.now - 1),
            requests = emptyList(), lurkers = emptyList(),
        )
        time.advance(5_000)
        assertTrue(api.calls.contains("claim vacant=true"))
        assertTrue(host.state.value.holdsHost)
        assertTrue("taking the host opens the mic", api.calls.contains("holds=true unmute=true"))
        time.advance(10_000)
        assertTrue(beats >= 1)
    }

    @Test
    fun aLiveHostElsewhereIsNeverClaimed() = hosting(holdsHost = false) {
        api.lobbyAnswer = LobbySnapshotResponse(meeting = meeting(host = mac, expires = time.now + 30_000), requests = emptyList(), lurkers = emptyList())
        time.advance(15_000)
        assertFalse(api.calls.any { it.startsWith("claim") })
    }

    @Test
    fun anotherDeviceTakingTheHostStopsTheLease() = hosting {
        host.receive(HostMessageWire(version = 1, type = HostMessageWireType.CHANGED, hostIdentity = mac)).join()
        assertFalse(host.state.value.holdsHost)
        assertTrue(host.state.value.isCompanion)
        assertTrue(api.calls.contains("holds=false unmute=false"))
        time.advance(30_000)
        assertEquals(0, beats)
    }

    @Test
    fun aReleaseRequestHandsOver() = hosting {
        host.receive(HostMessageWire(version = 1, type = HostMessageWireType.RELEASE_REQUESTED, hostIdentity = me)).join()
        assertTrue(api.calls.contains("release"))
        assertFalse(host.state.value.holdsHost)
    }

    @Test
    fun waitingRoomListsKnocksInOrderAndAdmitsOnce() = hosting {
        api.lobbyAnswer = LobbySnapshotResponse(
            meeting = meeting(host = me, expires = time.now + 30_000),
            requests = listOf(knock("b", 20), knock("a", 10), knock("gone", 5, LobbyStatusValue.EXPIRED), knock("rec", 30, recording = true)),
            lurkers = emptyList(),
        )
        time.advance(5_000)
        val lobby = host.lobby.state.value
        assertEquals(listOf("a", "b", "rec"), lobby.waiting.map { it.id })
        assertEquals(1, lobby.knockCount)
        assertEquals("the roster loads for a recording notetaker", 1, lobby.people.size)
        assertFalse("a notetaker needs a sender", LobbyWatch.canAdmit(lobby.waiting[2], null))
        assertTrue(LobbyWatch.canAdmit(lobby.waiting[2], "ana@org.example"))

        host.admit("a").join()
        host.deny("b").join()
        assertEquals(listOf("rec"), host.lobby.state.value.waiting.map { it.id })
        assertTrue(api.calls.contains("decide a admit=true for=null"))
        assertTrue(api.calls.contains("decide b admit=false for=null"))
    }

    @Test
    fun aQueueThatFailedToLoadSaysSo() = runBlocking {
        val api = object : HostApi by FakeApi() {
            override suspend fun lobby(room: String): LobbySnapshotResponse =
                throw work.starlings.android.api.StarlingsApiError.Offline("Couldn’t read your waiting room", IOException())
        }
        val scope = CoroutineScope(coroutineContext + Job())
        val watch = LobbyWatch(api, scope)
        watch.start("rosa")
        settle()
        assertEquals("Couldn’t read your waiting room", watch.state.value.unavailable)
        watch.stop()
        assertNull(watch.state.value.unavailable)
        scope.cancel()
    }

    @Test
    fun androidNamesItselfAMobileDevice() {
        assertEquals(HostDevice.ANDROID, RoomHost.device(411))
        assertEquals(HostDevice.ANDROID, RoomHost.device(600))
        assertTrue(HostState(phase = HostPhase.HOSTING, holdsHost = true, room = "rosa").exitEndsMeeting)
        assertFalse("on /room/team the host leaves", HostState(phase = HostPhase.HOSTING, holdsHost = true, room = "team").exitEndsMeeting)
    }

    // Move host… and Take host (meet#561)

    @Test
    fun moveHostAsksTheOtherDeviceAndKeepsTheHostUntilItAnswers() = hosting {
        host.offerHost(mac, "Rosa’s Mac").join()
        assertTrue(api.calls.contains("offer $mac"))
        val s = host.state.value
        assertTrue("the lease stays here until the other device takes it", s.holdsHost)
        assertEquals("Rosa’s Mac", s.pendingHostOffer)
        assertEquals(HostNotice.Asked("Rosa’s Mac"), s.notice)
        time.advance(10_000)
        assertEquals(1, beats)
        // The Mac took it: this device stops renewing and the question is closed.
        host.receive(HostMessageWire(version = 1, type = HostMessageWireType.CHANGED, hostIdentity = mac)).join()
        assertFalse(host.state.value.holdsHost)
        assertNull(host.state.value.pendingHostOffer)
        time.advance(30_000)
        assertEquals(1, beats)
    }

    @Test
    fun moveHostThatFailsSaysSoAndKeepsHosting() = hosting {
        api.offerFails = true
        host.offerHost(mac, "Rosa’s Mac").join()
        assertEquals(HostNotice.MoveFailed, host.state.value.notice)
        assertNull(host.state.value.pendingHostOffer)
        assertTrue(host.state.value.holdsHost)
    }

    @Test
    fun aCompanionCannotMoveTheHost() = hosting(holdsHost = false) {
        host.offerHost(mac, "Rosa’s Mac").join()
        assertFalse(api.calls.any { it.startsWith("offer") })
        assertTrue(host.state.value.offersTakeHost)
    }

    @Test
    fun anOfferNobodyTookIsSaidOnTheNextPoll() = hosting {
        host.offerHost(mac, "Rosa’s Mac").join()
        api.lobbyAnswer = LobbySnapshotResponse(meeting = meeting(host = me, expires = time.now + 30_000), requests = emptyList(), lurkers = emptyList())
        time.advance(5_000)
        assertNull(host.state.value.pendingHostOffer)
        assertEquals(HostNotice.NotTaken("Rosa’s Mac"), host.state.value.notice)
        assertTrue(host.state.value.holdsHost)
    }

    @Test
    fun anOfferStillOpenStaysAsked() = hosting {
        host.offerHost(mac, "Rosa’s Mac").join()
        api.lobbyAnswer = LobbySnapshotResponse(
            meeting = meeting(host = me, expires = time.now + 30_000).copy(hostOfferIdentity = mac),
            requests = emptyList(), lurkers = emptyList(),
        )
        time.advance(5_000)
        assertEquals("Rosa’s Mac", host.state.value.pendingHostOffer)
    }

    @Test
    fun takeHostFromALiveHostWaitsForItsHandOver() = hosting(holdsHost = false) {
        api.claimStatus = HostMutationResponseStatus.RELEASE_REQUESTED
        host.takeHost().join()
        assertTrue(api.calls.contains("claim vacant=false"))
        assertFalse("the mic stays off until the Worker says so", host.state.value.holdsHost)
        assertEquals(HostNotice.AwaitingHandOver, host.state.value.notice)
        host.receive(HostMessageWire(version = 1, type = HostMessageWireType.CHANGED, hostIdentity = me)).join()
        assertTrue(host.state.value.holdsHost)
        assertNull(host.state.value.notice)
        assertTrue(api.calls.contains("holds=true unmute=true"))
        time.advance(10_000)
        assertEquals(1, beats)
    }

    @Test
    fun takeHostWhenVacantHostsAtOnce() = hosting(holdsHost = false) {
        host.takeHost().join()
        assertTrue(host.state.value.holdsHost)
        assertFalse(host.state.value.offersTakeHost)
    }

    @Test
    fun takeHostThatFailsSaysSo() = hosting(holdsHost = false) {
        api.claimFails = true
        host.takeHost().join()
        assertEquals(HostNotice.TakeFailed, host.state.value.notice)
        assertFalse(host.state.value.holdsHost)
    }

    @Test
    fun aVacantClaimThatFailsSaysNothing() = hosting(holdsHost = false) {
        api.claimFails = true
        host.receive(HostMessageWire(version = 1, type = HostMessageWireType.CHANGED, hostIdentity = null)).join()
        assertTrue(api.calls.contains("claim vacant=true"))
        assertNull(host.state.value.notice)
    }

    // End for everyone on /room/team (meet#160)

    @Test
    fun onTheTeamRoomLeaveDropsNobodyAndEndForEveryoneIsItsOwnAct() = hosting(room = RoomHost.INTERNAL_ROOM) {
        val s = host.state.value
        assertTrue(s.isInternalRoom)
        assertFalse(s.exitEndsMeeting)
        assertTrue(s.offersEndForEveryone)
        host.endForEveryone().join()
        settle()
        assertTrue(api.calls.contains("end everyone=true"))
        assertEquals(HostPhase.ENDED, host.state.value.phase)
    }

    @Test
    fun theTeamRoomsLeaveSendsNoEveryone() = hosting(room = RoomHost.INTERNAL_ROOM) {
        host.end().join()
        assertTrue(api.calls.contains("end everyone=false"))
    }

    @Test
    fun endForEveryoneOnAPersonalRoomIsTheEnd() = hosting {
        assertFalse("only /room/team offers it in More", host.state.value.offersEndForEveryone)
        host.endForEveryone().join()
        assertTrue(api.calls.contains("end everyone=false"))
        assertEquals(HostPhase.ENDED, host.state.value.phase)
    }

    @Test
    fun endForEveryoneAfterTheHostMovedDoesNothing() = hosting(holdsHost = false, room = RoomHost.INTERNAL_ROOM) {
        assertFalse(host.state.value.offersEndForEveryone)
        host.endForEveryone().join()
        assertFalse(api.calls.any { it.startsWith("end") })
        assertEquals(HostPhase.HOSTING, host.state.value.phase)
    }

    // A colleague's room, on their offer (meet#561)

    @Test
    fun aColleaguesRoomArrivesAsACompanionThenTakesTheHost() = hosting(holdsHost = false, room = "ana", claimsHostOnJoin = true) {
        assertEquals("ana", host.state.value.room)
        assertTrue(host.state.value.colleaguesRoom)
        assertEquals("connect mic=false", api.calls[1])
        assertTrue(api.calls.contains("claim vacant=false"))
        assertTrue(host.state.value.holdsHost)
        assertFalse("the way out is Leave, never End", host.state.value.exitEndsMeeting)
        time.advance(10_000)
        assertEquals(1, beats)
    }

    @Test
    fun leavingAColleaguesRoomHandsTheHostBackAndEndsNothing() = hosting(holdsHost = false, room = "ana", claimsHostOnJoin = true) {
        host.end().join()
        settle()
        assertEquals(HostPhase.ENDED, host.state.value.phase)
        assertTrue(api.calls.contains("release"))
        assertFalse(api.calls.any { it.startsWith("end") || it == "finalize" })
        assertTrue(api.calls.contains("disconnect"))
    }

    @Test
    fun leavingAColleaguesRoomReleasesAgainWhenTheAskerHasGone() = hosting(holdsHost = false, room = "ana", claimsHostOnJoin = true) {
        api.releases += HostMutationResponseStatus.HOST
        host.end().join()
        assertEquals(2, api.calls.count { it == "release" })
        assertEquals(HostPhase.ENDED, host.state.value.phase)
    }

    @Test
    fun aColleaguesRoomTheWorkerKeepsHereStaysHosting() = hosting(holdsHost = false, room = "ana", claimsHostOnJoin = true) {
        api.releases += HostMutationResponseStatus.HOST
        api.releases += HostMutationResponseStatus.HOST
        host.end().join()
        assertEquals(HostPhase.HOSTING, host.state.value.phase)
        assertTrue(host.state.value.holdsHost)
        assertFalse(api.calls.contains("disconnect"))
        time.advance(10_000)
        assertTrue("the lease goes on renewing", beats >= 1)
    }

    @Test
    fun theOwnRoomAndTheTeamRoomAreNoColleaguesRoom() {
        assertFalse(HostState(phase = HostPhase.HOSTING, holdsHost = true, room = "team").colleaguesRoom)
        assertFalse(HostState(phase = HostPhase.HOSTING, holdsHost = true, room = "ana", colleaguesRoom = true).exitEndsMeeting)
        assertTrue(HostState(phase = HostPhase.HOSTING, holdsHost = true, room = "rosa").exitEndsMeeting)
    }

    // Knock notifications

    @Test
    fun aKnockNotificationOpensTheWaitingRoomOnlyWhileHosting() = hosting {
        host.showWaitingRoom()
        assertTrue(host.waitingRoomRequested.value)
        host.waitingRoomShown()
        assertFalse(host.waitingRoomRequested.value)
        host.end().join()
        host.showWaitingRoom()
        assertFalse(host.waitingRoomRequested.value)
    }

    @Test
    fun theLobbyNamesTheGuestItAnnounced() = hosting {
        api.lobbyAnswer = LobbySnapshotResponse(
            meeting = meeting(host = me, expires = time.now + 30_000),
            requests = listOf(knock("a", 10)), lurkers = emptyList(),
        )
        time.advance(5_000)
        assertEquals("a", host.lobby.state.value.announced?.id)
        api.lobbyAnswer = api.lobbyAnswer.copy(requests = listOf(knock("a", 10), knock("b", 20)))
        time.advance(5_000)
        assertEquals("b", host.lobby.state.value.announced?.id)
        assertEquals(2, host.lobby.state.value.knockCount)
    }

    private fun meeting(host: String?, expires: Long) = LobbySnapshotResponseMeeting(
        id = "m1", livekitRoom = "lk", startedAt = 0, hostLeaseExpiresAt = expires, hostIdentity = host,
    )

    private fun knock(id: String, at: Long, status: LobbyStatusValue = LobbyStatusValue.WAITING, recording: Boolean? = null) =
        LobbyRequestResponse(
            id = id, meetingId = "m1", name = id, email = "$id@example.com", identity = "guest:$id",
            status = status, createdAt = at, recording = recording,
        )
}

/** Lets every coroutine that can run, run. */
internal suspend fun settle() = repeat(50) { yield() }
