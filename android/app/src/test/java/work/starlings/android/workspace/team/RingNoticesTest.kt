package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.IncomingRing
import work.starlings.contracts.RingKind

/** `RingNotices.plan` of iOS/RingNotices.swift. */
class RingNoticesTest {
    private val link: (String) -> String = { "https://envisioning.starlings.example/room/$it" }

    private fun ring(kind: RingKind, name: String? = "Ana", room: String? = "ana", createdAt: Long = 1_790_000_000_123) =
        IncomingRing(kind, "ana@org.example", name, room, createdAt, createdAt + 45_000)

    @Test
    fun noRingClearsTheRecord() {
        assertEquals(RingNotices.Plan(null, null), RingNotices.plan(null, "ana@org.example#1790000000", link))
    }

    @Test
    fun eachRingIsAnnouncedOnce() {
        val first = RingNotices.plan(ring(RingKind.CALL), null, link)
        assertEquals("ana@org.example#1790000000", first.announced)
        assertTrue(first.notice!!.isCall)
        val again = RingNotices.plan(ring(RingKind.CALL), first.announced, link)
        assertNull("the same ring on the next poll", again.notice)
        assertEquals(first.announced, again.announced)
        val next = RingNotices.plan(ring(RingKind.CALL, createdAt = 1_790_000_060_000), first.announced, link)
        assertEquals("a new ring from the same person", "ana@org.example#1790000060", next.announced)
    }

    @Test
    fun onlyAWaveCarriesTheRoomLink() {
        val wave = RingNotices.plan(ring(RingKind.WAVE), null, link).notice!!
        assertEquals("https://envisioning.starlings.example/room/ana", wave.joinUrl)
        assertFalse(wave.isCall)
        assertFalse(wave.isAgentAsk)
        assertNull(RingNotices.plan(ring(RingKind.CALL), null, link).notice!!.joinUrl)
        assertNull("a wave with no room", RingNotices.plan(ring(RingKind.WAVE, room = null), null, link).notice!!.joinUrl)
    }

    @Test
    fun anAgentAskIsItsOwnKindAndAnUnknownKindIsAWave() {
        assertTrue(RingNotices.plan(ring(RingKind.AGENT_START), null, link).notice!!.isAgentAsk)
        val unknown = RingNotices.plan(ring(RingKind("hug")), null, link).notice!!
        assertFalse(unknown.isCall)
        assertEquals("https://envisioning.starlings.example/room/ana", unknown.joinUrl)
    }

    @Test
    fun theCallerIsNamedOrTheirAddressIs() {
        assertEquals("Ana", RingNotices.plan(ring(RingKind.CALL), null, link).notice!!.callerName)
        assertEquals("ana", RingNotices.plan(ring(RingKind.CALL, name = " "), null, link).notice!!.callerName)
    }
}
