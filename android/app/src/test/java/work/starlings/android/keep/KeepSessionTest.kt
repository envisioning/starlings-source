package work.starlings.android.keep

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import work.starlings.android.api.KeepRoutes
import work.starlings.contracts.WireJson

/**
 * The key session against a Keep that only stores what it is sent, as the
 * real one does: enrol, a vault, an item, lock, unlock, the idle lock, and
 * a member's removal re-sealing every item. The fake never sees a key; the
 * test proves the session sends only ciphertext.
 */
class KeepSessionTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var now = 0L
    private val keep = FakeKeep()
    private val client = KeepClient(
        baseUrl = { "https://keep.test".toHttpUrl() },
        tokenProvider = { "evk_test" },
        http = OkHttpClient.Builder().addInterceptor(keep).build(),
    )
    private val session = KeepSession(client, scope, idleLockMs = 15 * 60 * 1000L, clock = { now })

    @After
    fun tearDown() = scope.cancel()

    @Test
    fun enrolsUnlocksAndKeepsOnlyCiphertext() = runBlocking {
        session.refresh()
        assertTrue(session.state is KeepSession.State.Unenrolled)
        session.enrol("a long enough passphrase")
        assertTrue(session.isUnlocked)
        assertTrue(session.hasPassphrase)

        val vault = client.vault(session.createVault("Client", projectId = "p1", members = emptyList()).id)
        assertEquals("p1", session.vault(forProject = "p1")?.projectId)
        val body = KeepItemBody(username = "ops", password = "correct horse battery staple", url = "https://db", notes = "n")
        session.createItem("DB", KeepItemKind.DATABASE, body, vault)
        val fresh = client.vault(vault.id)
        assertEquals(body, session.open(fresh.items.single(), fresh))
        // The server holds nothing readable.
        assertFalse(keep.everything().contains("correct horse"))

        session.lock()
        assertTrue(session.state is KeepSession.State.Locked)
        assertThrows(KeepLockedError::class.java) { runBlocking { session.open(fresh.items.single(), fresh) } }
        assertThrows(KeepCryptoError::class.java) { runBlocking { session.unlock("not the passphrase") } }
        session.unlock("a long enough passphrase")
        assertEquals(body, session.open(fresh.items.single(), fresh))
    }

    @Test
    fun enrolsAndUnlocksWithAPasskeysPRF() = runBlocking {
        session.refresh()
        val prf = KeepCrypto.randomBytes(32)
        session.enrol(KeepPasskeyEnrolment("cred-1", prf.copyOf()))
        assertTrue(session.isUnlocked)
        assertEquals("cred-1", session.passkeyCredentialId)
        assertFalse(session.hasPassphrase)
        assertFalse(keep.everything().contains(KeepCrypto.base64URL(prf)))

        session.lock()
        assertThrows(KeepCryptoError::class.java) { runBlocking { session.unlock(KeepCrypto.randomBytes(32)) } }
        session.unlock(prf.copyOf())
        assertTrue(session.isUnlocked)
    }

    @Test
    fun locksAfterFifteenIdleMinutesEvenAfterSleep() = runBlocking {
        session.refresh()
        session.enrol("a long enough passphrase")
        now += 14 * 60 * 1000L
        session.touch()
        now += 14 * 60 * 1000L
        assertFalse(session.checkIdle())
        assertTrue(session.isUnlocked)
        // The timer could not run while the phone slept; the next look locks.
        now += 2 * 60 * 1000L
        assertTrue(session.checkIdle())
        assertTrue(session.state is KeepSession.State.Locked)
    }

    @Test
    fun ensureVaultMakesTheProjectVaultOnce() = runBlocking {
        session.refresh()
        session.enrol("a long enough passphrase")
        val first = session.ensureVault("p9", "Pilot")
        val again = session.ensureVault("p9", "Pilot")
        assertEquals(first, again)
        assertEquals(1, keep.vaults.size)
        assertEquals("Pilot", session.vaults.single().name)
    }

    @Test
    fun revokeReSealsUnderTheNextKey() = runBlocking {
        session.refresh()
        session.enrol("a long enough passphrase")
        val colleague = KeepCrypto.generateStaffKeypair()
        keep.directory += KeepDirectoryEntry("me@x.com", "Me", keep.key!!.publicKey, "2026-01-01T00:00:00Z")
        keep.directory += KeepDirectoryEntry("b@x.com", "B", colleague.publicKey, "2026-01-01T00:00:00Z")
        val created = session.createVault("Shared", projectId = null, members = keep.directory.toList())
        session.createItem("Login", KeepItemKind.LOGIN, KeepItemBody(password = "p"), client.vault(created.id))
        val before = client.vault(created.id)
        assertEquals(listOf("me@x.com", "b@x.com"), before.members.map { it.email })
        val after = session.revoke(before, "b@x.com", keep.directory.toList())
        assertEquals(before.keyVersion + 1, after.keyVersion)
        assertEquals(listOf("me@x.com"), after.members.map { it.email })
        val fresh = client.vault(created.id)
        assertEquals(KeepItemBody(password = "p"), session.open(fresh.items.single(), fresh))
    }

    @Test
    fun theRecoveryCeremonyCoversOldVaultsAndSendsNoShare() = runBlocking {
        session.refresh()
        session.enrol("a long enough passphrase")
        val old = session.createVault("Old", projectId = null, members = emptyList())
        assertFalse(old.recoveryWrapped)

        val shares = session.createRecoveryKey(listOf("me@x.com", "b@x.com"))
        assertTrue(shares.a.startsWith("keep-recovery-A:"))
        assertTrue(shares.b.startsWith("keep-recovery-B:"))
        assertEquals(listOf("me@x.com", "b@x.com"), session.recoveryKey?.holders)
        // The vault made before the key got its recovery wrap without asking.
        assertTrue(session.vaults.single().recoveryWrapped)
        // Keep holds the public half only: neither share, nor the private key, ever left.
        val sent = keep.everything()
        assertFalse(sent.contains(shares.a.substringAfter(':')))
        assertFalse(sent.contains(shares.b.substringAfter(':')))
        assertFalse(shares.toString().contains("keep-recovery"))
    }

    @Test
    fun bothSharesReopenAVaultItsMembersLost() = runBlocking {
        session.refresh()
        session.enrol("a long enough passphrase")
        val shares = session.createRecoveryKey(listOf("me@x.com", "b@x.com"))
        val created = session.createVault("Lost", projectId = null, members = emptyList())
        session.createItem("DB", KeepItemKind.DATABASE, KeepItemBody(password = "s3cret"), client.vault(created.id))
        // Every member's copy is gone: only recovery can open it now.
        keep.wraps[created.id] = keep.wraps.getValue(created.id) - "me@x.com"
        session.lock()
        session.unlock("a long enough passphrase")
        assertTrue(session.vaults.isEmpty())

        // Two shares of another key make a key, not the published one.
        val stranger = KeepCrypto.splitSecret(KeepCrypto.exportPrivateKey(KeepCrypto.generateStaffKeypair()))
        val wrong = assertThrows(KeepCryptoError::class.java) {
            runBlocking { session.recoveryPrivateKey(KeepCrypto.formatShare("A", stranger.first), KeepCrypto.formatShare("B", stranger.second)) }
        }
        assertEquals(KeepCryptoError.Kind.CANNOT_OPEN, wrong.kind)

        // Either order works.
        val key = session.recoveryPrivateKey(shares.b, shares.a)
        val entry = session.recoveryVaults().single { it.id == created.id }
        session.recover(entry, key)
        val fresh = client.vault(created.id)
        assertEquals(KeepItemBody(password = "s3cret"), session.open(fresh.items.single(), fresh))
        assertEquals(listOf("Lost"), session.vaults.map { it.name })
    }

    @Test
    fun oneShareTwiceIsRefused() {
        val (a, _) = KeepCrypto.splitSecret(KeepCrypto.exportPrivateKey(KeepCrypto.generateStaffKeypair()))
        val share = KeepCrypto.formatShare("A", a)
        val error = assertThrows(KeepCryptoError::class.java) { KeepSession.recoveryKeyFromShares(share, share) }
        assertEquals(KeepCryptoError.Kind.BAD_ENCODING, error.kind)
    }

    @Test
    fun aRefusedTokenSaysSo() = runBlocking {
        keep.refuse = true
        session.refresh()
        assertEquals(KeepClientError.Unauthorized().message, (session.state as KeepSession.State.Failed).message)
    }

    @Test
    fun releaseNamesMatchIgnoringCaseAndAccents() {
        assertTrue(KeepSession.sameName("Café Prod", "cafe prod"))
        assertFalse(KeepSession.sameName("Prod", "Staging"))
    }

    @Test
    fun theTokenRouteIsOneTheWorkerAnswers() {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val table = WireJson.parseToJsonElement(File(dir, "routes.json").readText()).jsonObject["routes"].toString()
        val route = KeepRoutes.token("Pixel")
        assertTrue(table.contains("\"${route.signature}\""))
        assertEquals("{\"device_name\":\"Pixel\"}", route.body)
    }

    @Test
    fun theCredentialRenewsInItsLastWeek() {
        val base = java.time.Instant.parse("2026-10-29T00:00:00Z").toEpochMilli()
        fun credential(expires: String) = KeepCredential("evk", expires, "me@x.com", "https://a", "https://k")
        assertFalse(credential("2026-11-30T00:00:00Z").expiresSoon(base))
        assertTrue(credential("2026-11-04T00:00:00Z").expiresSoon(base))
        assertTrue(credential("not a date").expiresSoon(base))
        assertFalse(credential("2026-11-30T00:00:00.000Z").toString().contains("evk"))
    }

    /** A Keep that stores what it is sent and answers in its shapes. */
    private class FakeKeep : Interceptor {
        var refuse = false
        var key: KeepStaffKey? = null
        val directory = mutableListOf<KeepDirectoryEntry>()
        val vaults = linkedMapOf<String, KeepVaultDetail>()
        private val sealedItems = hashMapOf<String, KeepItemDetail>()
        val wraps = hashMapOf<String, Map<String, KeepWrappedKey>>()
        var recovery: KeepRecoveryKey? = null
        private val recoveryWraps = hashMapOf<String, KeepWrappedKey>()
        private val log = StringBuilder()

        @kotlinx.serialization.Serializable
        private data class CoverInput(@kotlinx.serialization.SerialName("recovery_wrapped_key") val recoveryWrappedKey: KeepWrappedKey)

        @kotlinx.serialization.Serializable
        private data class JoinInput(@kotlinx.serialization.SerialName("wrapped_key") val wrappedKey: KeepWrappedKey)

        fun everything(): String = log.toString()

        private fun me() = KeepMe("me@x.com", "Me", key != null, key, "https://core.test")

        private fun detail(id: String, who: String = "me@x.com"): KeepVaultDetail {
            val v = vaults.getValue(id)
            return v.copy(
                wrappedKey = wraps.getValue(id).getValue(who),
                items = sealedItems.values.filter { it.vaultId == id }.map {
                    KeepItemSummary(it.id, id, it.name, it.kind, it.keyVersion, "me@x.com", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
                },
                itemCount = sealedItems.values.count { it.vaultId == id },
            )
        }

        private fun summary(d: KeepVaultDetail) = KeepVaultSummary(
            d.id, d.name, d.icon, d.projectId, d.keyVersion, d.wrappedKey, d.recoveryWrapped, d.memberCount, d.itemCount, d.createdBy, d.createdAt, d.updatedAt,
        )

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            val text = request.body?.let { Buffer().also(it::writeTo).readUtf8() }.orEmpty()
            log.append(text)
            val path = request.url.encodedPath
            val parts = path.removePrefix("/api/").split('/')
            fun ok(json: String) = respond(chain, 200, json)
            if (refuse) return respond(chain, 401, "{\"error\":\"no\"}")
            return when {
                request.method == "GET" && path == "/api/me" -> ok(KeepJson.encodeToString(KeepMe.serializer(), me()))
                request.method == "PUT" && path == "/api/keys/me" -> {
                    val input = KeepJson.decodeFromString(KeepEnrolInput.serializer(), text)
                    key = KeepStaffKey("me@x.com", "Me", input.suite, input.publicKey, input.wrappedPrivateKey, input.wrap, listOf(KeepKeyWrap(input.wrappedPrivateKey, input.wrap)), "t", "t")
                    ok(KeepJson.encodeToString(KeepStaffKey.serializer(), key!!))
                }
                request.method == "GET" && path == "/api/recovery" ->
                    ok("{\"recovery\":" + (recovery?.let { KeepJson.encodeToString(KeepRecoveryKey.serializer(), it) } ?: "null") + "}")
                request.method == "PUT" && path == "/api/recovery" -> {
                    val input = KeepJson.decodeFromString(KeepSetRecoveryInput.serializer(), text)
                    recovery = KeepRecoveryKey(input.publicKey, input.holders, "me@x.com", "2026-10-29T00:00:00Z")
                    ok(KeepJson.encodeToString(KeepRecoveryKey.serializer(), recovery!!))
                }
                request.method == "POST" && parts.size == 3 && parts[0] == "vaults" && parts[2] == "recovery" -> {
                    recoveryWraps[parts[1]] = KeepJson.decodeFromString(CoverInput.serializer(), text).recoveryWrappedKey
                    vaults[parts[1]] = vaults.getValue(parts[1]).copy(recoveryWrapped = true)
                    ok(KeepJson.encodeToString(KeepVaultDetail.serializer(), detail(parts[1])))
                }
                request.method == "GET" && path == "/api/recovery/vaults" -> ok(
                    "{\"vaults\":" + KeepJson.encodeToString(
                        kotlinx.serialization.builtins.ListSerializer(KeepRecoveryVaultEntry.serializer()),
                        recoveryWraps.map { (id, wrap) ->
                            val v = vaults.getValue(id)
                            KeepRecoveryVaultEntry(id, v.name, v.icon, v.projectId, v.keyVersion, wraps.getValue(id).size, wraps.getValue(id).keys.toList(), wrap)
                        },
                    ) + "}",
                )
                request.method == "POST" && parts.size == 4 && parts[0] == "recovery" && parts[3] == "join" -> {
                    val wrap = KeepJson.decodeFromString(JoinInput.serializer(), text).wrappedKey
                    wraps[parts[2]] = wraps.getValue(parts[2]) + ("me@x.com" to wrap)
                    ok("{}")
                }
                request.method == "GET" && path == "/api/vaults" -> ok("{\"vaults\":" + vaults.keys.filter { wraps.getValue(it).containsKey("me@x.com") }.map { summary(detail(it)) }.let { KeepJson.encodeToString(kotlinx.serialization.builtins.ListSerializer(KeepVaultSummary.serializer()), it) } + "}")
                request.method == "POST" && path == "/api/vaults" -> {
                    val input = KeepJson.decodeFromString(KeepCreateVaultInput.serializer(), text)
                    val id = "v${vaults.size + 1}"
                    wraps[id] = input.members.associate { it.email to it.wrappedKey }
                    input.recoveryWrappedKey?.let { recoveryWraps[id] = it }
                    vaults[id] = KeepVaultDetail(
                        id, input.name, input.icon, input.projectId, 1, input.members.first().wrappedKey, input.members.size, 0, "me@x.com", "t", "t",
                        input.members.map { KeepVaultMember(it.email, it.email, "me@x.com", "t") }, input.recoveryWrappedKey != null, emptyList(),
                    )
                    ok(KeepJson.encodeToString(KeepVaultDetail.serializer(), detail(id)))
                }
                request.method == "GET" && parts.size == 2 && parts[0] == "vaults" -> ok(KeepJson.encodeToString(KeepVaultDetail.serializer(), detail(parts[1])))
                request.method == "POST" && parts.size == 3 && parts[2] == "items" -> {
                    val input = KeepJson.decodeFromString(KeepCreateItemInput.serializer(), text)
                    val item = KeepItemDetail(input.id, parts[1], input.name, input.kind, input.keyVersion, input.sealed)
                    sealedItems[input.id] = item
                    ok(KeepJson.encodeToString(KeepItemDetail.serializer(), item))
                }
                request.method == "GET" && parts.size == 4 && parts[2] == "items" -> ok(KeepJson.encodeToString(KeepItemDetail.serializer(), sealedItems.getValue(parts[3])))
                request.method == "POST" && parts.size == 3 && parts[2] == "rotate" -> {
                    val input = KeepJson.decodeFromString(KeepRotateInput.serializer(), text)
                    val id = parts[1]
                    // The server refuses a rotation that misses an item.
                    val mine = sealedItems.values.filter { it.vaultId == id }.map { it.id }.toSet()
                    if (input.items.map { it.id }.toSet() != mine) return respond(chain, 400, "{\"error\":\"missed an item\"}")
                    input.items.forEach { sealedItems[it.id] = sealedItems.getValue(it.id).copy(sealed = it.sealed, keyVersion = input.keyVersion) }
                    wraps[id] = input.members.associate { it.email to it.wrappedKey }
                    vaults[id] = vaults.getValue(id).copy(
                        keyVersion = input.keyVersion, memberCount = input.members.size,
                        members = input.members.map { KeepVaultMember(it.email, it.email, "me@x.com", "t") },
                    )
                    ok(KeepJson.encodeToString(KeepVaultDetail.serializer(), detail(id)))
                }
                else -> respond(chain, 404, JsonObject(mapOf("error" to kotlinx.serialization.json.JsonPrimitive("no route $path"))).toString())
            }
        }

        private fun respond(chain: Interceptor.Chain, code: Int, json: String): Response = Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("")
            .body(json.toResponseBody("application/json".toMediaType()))
            .build()
    }
}
