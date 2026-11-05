package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.ThreadReleaseRequest
import work.starlings.contracts.ThreadReleaseState
import work.starlings.contracts.ThreadReleaseStatus

/** The release card's rules, as `ThreadReleaseCard` in `Sources/KeepReleaseSheet.swift`. */
class ThreadReleaseTest {
    private val now = 1_800_000_000_000L
    private val request = ThreadReleaseRequest("REQ-1", "Client", "Vendor login", "Deploy", "Needs the vendor API", 900, "pk")

    private fun state(status: ThreadReleaseStatus, expiresAt: Long = now + 60_000, name: String? = "Rosa", endedBy: String? = null) =
        ThreadReleaseState(status, "rosa@x.com", name, now - 60_000, expiresAt, "v1", "Vendor login", endedByEmail = endedBy)

    @Test
    fun aRequestWithoutStateWaits() {
        assertNull(ThreadReleaseCard.status(null, now))
        assertFalse(ThreadReleaseCard.isLive(null, now))
    }

    @Test
    fun theStatusLineFollowsKeep() {
        assertEquals(ThreadReleaseCard.Status.ApprovedUntil("Rosa", now + 60_000), ThreadReleaseCard.status(state(ThreadReleaseStatus.APPROVED), now))
        assertEquals(ThreadReleaseCard.Status.Expired("Rosa"), ThreadReleaseCard.status(state(ThreadReleaseStatus.APPROVED, expiresAt = now), now))
        assertEquals(ThreadReleaseCard.Status.UsedUntil("Rosa", now + 60_000), ThreadReleaseCard.status(state(ThreadReleaseStatus.USED), now))
        assertEquals(ThreadReleaseCard.Status.Used("Rosa"), ThreadReleaseCard.status(state(ThreadReleaseStatus.USED, expiresAt = now - 1), now))
        // Ended names who ended it, else the approver; a missing name falls back to the address.
        assertEquals(ThreadReleaseCard.Status.Ended("mz@x.com"), ThreadReleaseCard.status(state(ThreadReleaseStatus.ENDED, endedBy = "mz@x.com"), now))
        assertEquals(ThreadReleaseCard.Status.Ended("rosa@x.com"), ThreadReleaseCard.status(state(ThreadReleaseStatus.ENDED, name = null), now))
    }

    @Test
    fun endNowOnlyWhileApprovedOrUsedAndUnexpired() {
        assertTrue(ThreadReleaseCard.isLive(state(ThreadReleaseStatus.APPROVED), now))
        assertTrue(ThreadReleaseCard.isLive(state(ThreadReleaseStatus.USED), now))
        assertFalse(ThreadReleaseCard.isLive(state(ThreadReleaseStatus.ENDED), now))
        assertFalse(ThreadReleaseCard.isLive(state(ThreadReleaseStatus.APPROVED, expiresAt = now), now))
    }

    @Test
    fun askedForIsMinutesUnderAnHourElseHoursAndMinutes() {
        assertEquals(0L to 15L, ThreadReleaseCard.askedFor(request))
        assertEquals(1L to 30L, ThreadReleaseCard.askedFor(request.copy(expiresInSeconds = 5400)))
        assertEquals(24L to 0L, ThreadReleaseCard.askedFor(request.copy(expiresInSeconds = 86_400)))
        assertNull(ThreadReleaseCard.askedFor(request.copy(expiresInSeconds = null)))
    }

    @Test
    fun theKeepRequestNamesTheAgentAndCarriesTheKey() {
        val keep = ThreadReleaseCard.keepRequest(request, "vocab@agents.x")
        assertEquals("REQ-1", keep.requestId)
        assertEquals("vocab@agents.x", keep.agent)
        assertEquals("Vendor login", keep.item)
        assertEquals("pk", keep.sessionPublicKey)
    }
}
