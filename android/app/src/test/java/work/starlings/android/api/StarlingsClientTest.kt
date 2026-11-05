package work.starlings.android.api

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import work.starlings.android.OwnerCredentials
import work.starlings.android.OwnerSessionRenewer
import work.starlings.android.ServiceStatus
import work.starlings.android.SessionVault
import work.starlings.contracts.ControlErrorCodeValue
import java.io.IOException
import java.nio.file.Files
import java.util.Base64

/** [StarlingsClient] against a fake transport: no network. */
class StarlingsClientTest {
    private val now = 1_800_000_000L
    private val origin = "https://envisioning.starlings.example"

    private fun jwt(exp: Long, tag: String): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        return listOf("""{"alg":"HS256"}""", """{"sub":"$tag","exp":$exp}""", "sig").joinToString(".") { enc.encodeToString(it.toByteArray()) }
    }

    private fun pair(tag: String, exp: Long = now + 8 * 3_600) =
        OwnerCredentials(jwt(exp, tag), "refresh-$tag", "sub", "a@org.example", "A")

    private class MemoryVault(var stored: OwnerCredentials?) : SessionVault {
        override fun load() = stored
        override fun save(credentials: OwnerCredentials) { stored = credentials }
        override fun clear() { stored = null }
        override fun deviceId() = "device-1"
    }

    /** `OwnerAccount.session` over a memory vault and the real renewer. */
    private class Session(val vault: MemoryVault, val renewer: OwnerSessionRenewer, val cache: SnapshotCache?) : OwnerSession {
        var signedOut = false
        override fun credentials() = vault.load()
        override suspend fun renewIfNeeded() { renewer.renewIfNeeded() }
        override suspend fun handleRejected() { if (renewer.handleRejected()) signOut() }
        override fun expire() { vault.clear(); signOut() }
        private fun signOut() { signedOut = true; cache?.purge() }
    }

    /** Answers in order; an [IOException] in the list is thrown instead. */
    private class FakeTransport(vararg answers: Any) : HttpTransport {
        private val queue = ArrayDeque(answers.toList())
        val sent = mutableListOf<HttpRequest>()
        override suspend fun send(request: HttpRequest): HttpResponse {
            sent += request
            return when (val next = queue.removeFirstOrNull() ?: error("no answer left for ${request.method} ${request.url}")) {
                is IOException -> throw next
                is HttpResponse -> next
                else -> error("not an answer")
            }
        }
    }

    private fun ok(body: String, etag: String? = null) = HttpResponse(200, listOfNotNull(etag?.let { "etag" to it }).toMap(), body)
    private fun refused(status: Int = 401) = HttpResponse(status, emptyMap(), """{"error":"Sign in again.","code":"owner_auth_required"}""")

    private val threads = """{"threads":[]}"""

    /** A recorded Worker answer from fixtures/responses/. */
    private fun recorded(name: String) =
        java.io.File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), "responses/$name.json").readText()

    private fun setUp(
        transport: FakeTransport,
        stored: OwnerCredentials? = pair("one"),
        cache: SnapshotCache? = null,
        refresh: suspend (String, String) -> OwnerCredentials = { _, _ -> pair("two") },
    ): Pair<StarlingsClient, Session> {
        val vault = MemoryVault(stored)
        val session = Session(vault, OwnerSessionRenewer(vault, { now }, refresh), cache)
        return StarlingsClient(origin, session, cache, transport, RequestPolicy.retry.withoutPause, "android/0.0.1 (1)") to session
    }

    private fun cache() = SnapshotCache(Files.createTempDirectory("snapshots").toFile(), origin)

    @Test
    fun everyAnswerTellsTheUpdateRecommendation() = runBlocking {
        val transport = FakeTransport(
            HttpResponse(200, mapOf("x-meet-upgrade" to "recommended", "x-meet-update-url" to "https://starlings.example/android"), threads),
            HttpResponse(200, emptyMap(), threads),
        )
        val vault = MemoryVault(pair("one"))
        val session = Session(vault, OwnerSessionRenewer(vault, { now }, { _, _ -> pair("two") }), null)
        val heard = mutableListOf<Pair<Boolean, String?>>()
        val client = StarlingsClient(origin, session, null, transport, RequestPolicy.retry.withoutPause, "android/0.0.1 (1)") { recommended, url -> heard += recommended to url }
        client.call(TeamRoutes.threads)
        client.call(TeamRoutes.threads)
        assertEquals(listOf(true to "https://starlings.example/android", false to null), heard)
    }

    @Test
    fun bearerAndHeaders() = runBlocking {
        val transport = FakeTransport(ok(threads), ok("""{"ok":true}"""))
        val (client, _) = setUp(transport)
        client.call(TeamRoutes.threads)
        client.call(TeamRoutes.markRead("th 1"))

        val read = transport.sent[0]
        assertEquals("GET", read.method)
        assertEquals("$origin/api/threads", read.url)
        assertEquals("Bearer ${pair("one").accessToken}", read.headers["authorization"])
        assertEquals("android/0.0.1 (1)", read.headers["x-meet-client"])
        assertNull("a read sends no body", read.body)
        assertNull(read.headers["content-type"])
        assertFalse("the token never rides the URL", read.url.contains(pair("one").accessToken))

        val write = transport.sent[1]
        assertEquals("$origin/api/threads/th%201/read", write.url)
        assertEquals("application/json", write.headers["content-type"])
        assertEquals("{}", write.body)
    }

    @Test
    fun queryAndTimeout() = runBlocking {
        val transport = FakeTransport(ok(recorded("calendar-upcoming")))
        val (client, _) = setUp(transport)
        client.call(CalendarRoutes.upcoming(36))
        assertEquals("$origin/api/calendar/upcoming?hours=36", transport.sent[0].url)
        assertEquals(RequestPolicy.TIMEOUT_SECONDS, transport.sent[0].timeoutSeconds, 0.0)
        assertEquals(20.0, CalendarRoutes.invitations.timeoutSeconds!!, 0.0)
    }

    @Test
    fun renewsBeforeSendingWhenTheTokenExpiresSoon() = runBlocking {
        val transport = FakeTransport(ok(threads))
        var refreshed = 0
        val (client, session) = setUp(transport, stored = pair("one", exp = now + 60)) { token, _ ->
            refreshed++
            assertEquals("refresh-one", token)
            pair("two")
        }
        client.call(TeamRoutes.threads)
        assertEquals(1, refreshed)
        assertEquals("Bearer ${pair("two").accessToken}", transport.sent.single().headers["authorization"])
        assertEquals(pair("two"), session.vault.stored)
    }

    @Test
    fun refusedOnceRenewsAndSendsAgain() = runBlocking {
        val transport = FakeTransport(refused(), ok(threads))
        val (client, session) = setUp(transport)
        client.call(TeamRoutes.threads)
        assertEquals(2, transport.sent.size)
        assertEquals("Bearer ${pair("one").accessToken}", transport.sent[0].headers["authorization"])
        assertEquals("Bearer ${pair("two").accessToken}", transport.sent[1].headers["authorization"])
        assertFalse(session.signedOut)
        assertEquals(pair("two"), session.vault.stored)
    }

    @Test
    fun aRefusedRenewalSignsOut() = runBlocking {
        val transport = FakeTransport(refused())
        val (client, session) = setUp(transport) { _, _ -> throw ServiceStatus(401) }
        val error = expect<StarlingsApiError.SessionRefused> { client.call(TeamRoutes.threads) }
        assertEquals(StarlingsApiError.Recovery.SIGN_IN, error.recovery)
        assertEquals("the refused request is not sent again", 1, transport.sent.size)
        assertTrue(session.signedOut)
        assertNull(session.vault.stored)
    }

    @Test
    fun aSecondRefusalSignsOut() = runBlocking {
        val transport = FakeTransport(refused(), refused(403))
        val (client, session) = setUp(transport)
        expect<StarlingsApiError.SessionRefused> { client.call(TeamRoutes.threads) }
        assertEquals("one resend, no more", 2, transport.sent.size)
        assertTrue(session.signedOut)
        assertNull(session.vault.stored)
    }

    @Test
    fun aCapabilityRefusalIsNotASignOut() = runBlocking {
        val transport = FakeTransport(HttpResponse(403, emptyMap(), """{"error":"You can’t see that, Rosa.","code":"capability_denied","request_id":"0F2C8A4E-1B3D-4C5E-9F60-7A8B9C0D1E2F"}"""))
        var refreshed = false
        val (client, session) = setUp(transport) { _, _ -> refreshed = true; pair("two") }
        val error = expect<StarlingsApiError.Service> { client.call(WorkRoutes.task("t1")) }
        assertEquals(403, error.status)
        assertEquals(ControlErrorCodeValue.CAPABILITY_DENIED, error.serverCode)
        assertEquals("0f2c8a4e-1b3d-4c5e-9f60-7a8b9c0d1e2f", error.requestId)
        assertFalse("the exception's message holds no server prose", error.message!!.contains("Rosa"))
        assertEquals("a refusal reads as the Worker's sentence", "You can’t see that, Rosa.", error.sentence)
        assertFalse(refreshed)
        assertFalse(session.signedOut)
    }

    @Test
    fun aConflictReadsAsTheWorkersMessage() = runBlocking {
        val body = """{"error":"Still used by 2 calls and 1 task.","code":"conflict"}"""
        val transport = FakeTransport(HttpResponse(409, emptyMap(), body))
        val (client, _) = setUp(transport)
        val error = expect<StarlingsApiError.Service> { client.call(WorkExtraRoutes.deleteContact("c1")) }
        assertEquals("Still used by 2 calls and 1 task.", error.serverMessage)
        assertEquals("Still used by 2 calls and 1 task.", error.sentence)
    }

    @Test
    fun theOperationStandsWhereIosWordsItItself() {
        fun sentence(status: Int, code: ControlErrorCodeValue?, message: String?) =
            StarlingsApiError.Service("Couldn’t delete the contact", status, code, null, message).sentence
        assertEquals("Couldn’t delete the contact", sentence(503, null, "D1 exploded"))
        assertEquals("Couldn’t delete the contact", sentence(409, null, null))
        assertEquals("Couldn’t delete the contact", sentence(409, null, "  "))
        assertEquals("Couldn’t delete the contact", sentence(403, ControlErrorCodeValue.OWNER_AUTH_REQUIRED, "Sign in again."))
        assertEquals("Couldn’t delete the contact", sentence(503, ControlErrorCodeValue.NOT_CONFIGURED, "No key"))
        assertEquals("Slow down.", sentence(429, ControlErrorCodeValue.RATE_LIMITED, "Slow down."))
        assertEquals("Couldn’t delete the contact", StarlingsApiError.SignedOut("Couldn’t delete the contact").sentence)
    }

    @Test
    fun offlineKeepsTheSession() = runBlocking {
        val transport = FakeTransport(IOException("offline"), IOException("offline"), IOException("offline"))
        val (client, session) = setUp(transport)
        val error = expect<StarlingsApiError.Offline> { client.call(TeamRoutes.threads) }
        assertEquals(StarlingsApiError.Recovery.RETRY, error.recovery)
        assertEquals("a GET is sent once more", 2, transport.sent.size)
        expect<StarlingsApiError.Offline> { client.call(TeamRoutes.markRead("th1")) }
        assertEquals("a POST is never sent twice", 3, transport.sent.size)
        assertFalse(session.signedOut)
        assertEquals(pair("one"), session.vault.stored)
    }

    @Test
    fun aRenewalThatCannotReachTheWorkerKeepsTheSession() = runBlocking {
        val transport = FakeTransport(refused())
        val (client, session) = setUp(transport) { _, _ -> throw IOException("offline") }
        val error = expect<StarlingsApiError.Service> { client.call(TeamRoutes.threads) }
        assertEquals(401, error.status)
        assertEquals(1, transport.sent.size)
        assertFalse(session.signedOut)
        assertEquals(pair("one"), session.vault.stored)
    }

    @Test
    fun aServerErrorIsSentOnceMore() = runBlocking {
        val transport = FakeTransport(HttpResponse(503, emptyMap(), ""), ok(threads))
        val (client, _) = setUp(transport)
        client.call(TeamRoutes.threads)
        assertEquals(2, transport.sent.size)
    }

    @Test
    fun signedOutSendsNothing() = runBlocking {
        val transport = FakeTransport()
        val (client, _) = setUp(transport, stored = null)
        expect<StarlingsApiError.SignedOut> { client.call(TeamRoutes.threads) }
        assertTrue(transport.sent.isEmpty())
    }

    @Test
    fun anUndecodableBodyNamesItsType() = runBlocking {
        val (client, _) = setUp(FakeTransport(ok("""{"nope":1}""")))
        val error = expect<StarlingsApiError.Undecodable> { client.call(TeamRoutes.threads) }
        assertTrue(error.message!!.contains("ThreadsResponse"))
    }

    @Test
    fun snapshotReadWhenOffline() = runBlocking {
        val cache = cache()
        val transport = FakeTransport(
            ok("""{"threads":[]}""", etag = "\"v1\""),
            HttpResponse(304, mapOf("etag" to "\"v1\""), ""),
            IOException("offline"), IOException("offline"),
        )
        val (client, session) = setUp(transport, cache = cache)
        assertNull("nothing kept yet", client.snapshot(TeamRoutes.threads))

        client.call(TeamRoutes.threads)
        assertNotNull(client.snapshot(TeamRoutes.threads))

        // The validator goes out; a 304 answers with the kept body.
        assertEquals(0, client.call(TeamRoutes.threads).threads.size)
        assertEquals("\"v1\"", transport.sent[1].headers["if-none-match"])

        expect<StarlingsApiError.Offline> { client.call(TeamRoutes.threads) }
        val painted = client.snapshot(TeamRoutes.threads)
        assertNotNull("offline, the last answer still paints", painted)
        assertEquals(0, painted!!.value.threads.size)
        assertFalse(session.signedOut)
    }

    @Test
    fun aReadAndroidDoesNotKeepIsNotStored() = runBlocking {
        val cache = cache()
        val transport = FakeTransport(ok(recorded("calendar-upcoming"), etag = "\"u1\""))
        val (client, _) = setUp(transport, cache = cache)
        client.call(CalendarRoutes.upcoming(36))
        assertNull(transport.sent.single().headers["if-none-match"])
        assertNull(cache.load("a@org.example", SnapshotKey.CALENDAR_UPCOMING))
        assertNull(client.snapshot(CalendarRoutes.upcoming(36)))
    }

    @Test
    fun aWriteMarksItsListsStale() = runBlocking {
        val cache = cache()
        val (client, _) = setUp(FakeTransport(ok("""{"ok":true}""")), cache = cache)
        val stale = async(start = CoroutineStart.UNDISPATCHED) { cache.invalidations.first() }
        client.call(TeamRoutes.markRead("th1"))
        assertEquals(SnapshotCache.Invalidation("a@org.example", listOf(SnapshotKey.THREADS)), stale.await())
    }

    @Test
    fun theCacheIsPerOwnerAndWorkspaceAndSignOutEmptiesIt() = runBlocking {
        val root = Files.createTempDirectory("snapshots").toFile()
        var clock = 0L
        val cache = SnapshotCache(root, origin) { clock }
        cache.save("A@org.example", SnapshotKey.PEERS, "{}", "\"e\"")
        assertEquals(SnapshotCache.Entry("{}", 0, "\"e\""), cache.load("a@org.example", SnapshotKey.PEERS))
        assertNull("another owner", cache.load("b@org.example", SnapshotKey.PEERS))
        assertNull("another workspace", SnapshotCache(root, "https://other.starlings.example").load("a@org.example", SnapshotKey.PEERS))
        clock = SnapshotCache.MAX_AGE_MS
        assertNull("past a week it is not shown", cache.load("a@org.example", SnapshotKey.PEERS))
        clock = 0

        // A refused session takes the snapshots with it.
        val (client, session) = setUp(FakeTransport(refused()), cache = cache) { _, _ -> throw ServiceStatus(403) }
        expect<StarlingsApiError.SessionRefused> { client.call(TeamRoutes.peers) }
        assertTrue(session.signedOut)
        assertNull(cache.load("a@org.example", SnapshotKey.PEERS))
    }

    private suspend inline fun <reified E : StarlingsApiError> expect(block: suspend () -> Unit): E {
        try {
            block()
        } catch (e: StarlingsApiError) {
            if (e is E) return e
            fail("expected ${E::class.simpleName}, got $e")
        }
        fail("expected ${E::class.simpleName}, nothing thrown")
        throw AssertionError()
    }
}
