package work.starlings.android

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Base64

/** The renewal rules of iOS `renewSessionIfNeeded`, against an in-memory vault. */
class OwnerSessionTest {
    private class MemoryVault(var stored: OwnerCredentials?) : SessionVault {
        var saves = 0
        override fun load() = stored
        override fun save(credentials: OwnerCredentials) { saves++; stored = credentials }
        override fun clear() { stored = null }
        override fun deviceId() = "device-1"
    }

    private fun jwt(exp: Long): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        return listOf("""{"alg":"HS256"}""", """{"sub":"a","exp":$exp}""", "sig").joinToString(".") { enc.encodeToString(it.toByteArray()) }
    }

    private val now = 1_800_000_000L
    private fun pair(exp: Long, refresh: String? = "refresh-1") = OwnerCredentials(jwt(exp), refresh, "sub", "a@org.example", "A")

    @Test
    fun expiry() {
        assertEquals(now, OwnerAccessToken.expiry(jwt(now)))
        assertNull(OwnerAccessToken.expiry("not.a.jwt!"))
        assertTrue(OwnerAccessToken.expiresSoon(jwt(now + 3_599), now))
        assertFalse(OwnerAccessToken.expiresSoon(jwt(now + 3_600), now))
        assertTrue("unreadable renews", OwnerAccessToken.expiresSoon("garbage", now))
    }

    @Test
    fun renewal() = runBlocking {
        val fresh = pair(now + 8 * 3_600, "refresh-2")

        val valid = MemoryVault(pair(now + 7_200))
        assertEquals(SessionRenewal.STILL_VALID, OwnerSessionRenewer(valid, { now }) { _, _ -> fresh }.renewIfNeeded())

        val due = MemoryVault(pair(now + 60))
        var asked: Pair<String, String>? = null
        assertEquals(SessionRenewal.RENEWED, OwnerSessionRenewer(due, { now }) { t, d -> asked = t to d; fresh }.renewIfNeeded())
        assertEquals("refresh-1" to "device-1", asked)
        assertEquals(fresh, due.stored)

        val refused = MemoryVault(pair(now + 60))
        assertEquals(SessionRenewal.REFUSED, OwnerSessionRenewer(refused, { now }) { _, _ -> throw ServiceStatus(401) }.renewIfNeeded())
        assertNull("a refusal signs out", refused.stored)

        val down = MemoryVault(pair(now + 60))
        assertEquals(SessionRenewal.UNAVAILABLE, OwnerSessionRenewer(down, { now }) { _, _ -> throw ServiceStatus(503) }.renewIfNeeded())
        assertEquals(SessionRenewal.UNAVAILABLE, OwnerSessionRenewer(down, { now }) { _, _ -> throw IOException("offline") }.renewIfNeeded())
        assertTrue("network loss keeps the session", down.stored != null)

        val legacy = MemoryVault(pair(now + 60, refresh = null))
        assertEquals(SessionRenewal.NOTHING_TO_RENEW, OwnerSessionRenewer(legacy, { now }) { _, _ -> fresh }.renewIfNeeded())
    }

    @Test
    fun rejectedRequest() = runBlocking {
        val v = MemoryVault(pair(now + 7_200))
        assertFalse("a forced renewal fixes it silently", OwnerSessionRenewer(v, { now }) { _, _ -> pair(now + 8 * 3_600, "r2") }.handleRejected())
        val gone = MemoryVault(pair(now + 7_200))
        assertTrue(OwnerSessionRenewer(gone, { now }) { _, _ -> throw ServiceStatus(403) }.handleRejected())
        val offline = MemoryVault(pair(now + 7_200))
        assertFalse(OwnerSessionRenewer(offline, { now }) { _, _ -> throw IOException() }.handleRejected())
        val noRefresh = MemoryVault(pair(now + 7_200, null))
        assertTrue(OwnerSessionRenewer(noRefresh, { now }) { _, _ -> error("unused") }.handleRejected())
        assertNull(noRefresh.stored)
    }
}
