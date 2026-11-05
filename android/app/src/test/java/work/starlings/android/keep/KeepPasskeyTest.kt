package work.starlings.android.keep

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.boolean
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The passkey ceremony's JSON, without a device: the relying party, the
 * salt and the PRF extension's shape KeepKit sends, and the PRF output
 * read back from a response into the same wrapping key core-kit's vectors
 * were sealed under.
 */
class KeepPasskeyTest {
    private val rp = "keep.workers.org.example"
    private val challenge = ByteArray(32) { it.toByte() }

    private fun obj(json: String): JsonObject = KeepJson.parseToJsonElement(json).jsonObject
    private fun JsonObject.str(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.o(key: String) = getValue(key).jsonObject

    @Test
    fun theSaltIsKeepKits() {
        assertEquals("keep.org.example/prf/v1", String(KeepCrypto.prfSalt))
        assertEquals("a2VlcC5lbnZpc2lvbmluZy5jb20vcHJmL3Yx", KeepCrypto.base64URL(KeepCrypto.prfSalt))
    }

    @Test
    fun registrationAsksForPRFOnTheKeepRelyingParty() {
        val userId = ByteArray(16) { 7 }
        val json = obj(KeepPasskeyRequests.registration(rp, challenge, userId, "me@x.com", "Me", KeepCrypto.prfSalt))
        assertEquals(KeepCrypto.base64URL(challenge), json.str("challenge"))
        assertEquals(rp, json.o("rp").str("id"))
        assertEquals(KeepCrypto.base64URL(userId), json.o("user").str("id"))
        assertEquals("me@x.com", json.o("user").str("name"))
        assertEquals("Me", json.o("user").str("displayName"))
        assertEquals(listOf(-7, -257), json.getValue("pubKeyCredParams").jsonArray.map { it.jsonObject.getValue("alg").jsonPrimitive.int })
        assertEquals("required", json.o("authenticatorSelection").str("userVerification"))
        assertEquals("required", json.o("authenticatorSelection").str("residentKey"))
        assertTrue(json.o("authenticatorSelection").getValue("requireResidentKey").jsonPrimitive.boolean)
        val prf = json.o("extensions").o("prf")
        assertEquals(setOf("eval"), prf.keys)
        assertEquals(setOf("first"), prf.o("eval").keys)
        assertArrayEquals(KeepCrypto.prfSalt, KeepCrypto.data(prf.o("eval").str("first")))
    }

    @Test
    fun assertionNamesOneCredentialAndTheSameSalt() {
        val credential = KeepCrypto.base64URL(byteArrayOf(1, 2, 3, -1, -2))
        val json = obj(KeepPasskeyRequests.assertion(rp, challenge, credential, KeepCrypto.prfSalt))
        assertEquals(rp, json.str("rpId"))
        assertEquals(KeepCrypto.base64URL(challenge), json.str("challenge"))
        assertEquals("required", json.str("userVerification"))
        val allow = json.getValue("allowCredentials") as JsonArray
        assertEquals(1, allow.size)
        assertEquals("public-key", allow[0].jsonObject.str("type"))
        assertEquals(credential, allow[0].jsonObject.str("id"))
        assertArrayEquals(KeepCrypto.prfSalt, KeepCrypto.data(json.o("extensions").o("prf").o("eval").str("first")))
    }

    @Test
    fun assertionTakesACredentialIdWithPadding() {
        val id = byteArrayOf(1, 2, 3, 4)
        val json = obj(KeepPasskeyRequests.assertion(rp, challenge, KeepCrypto.base64URL(id) + "==", KeepCrypto.prfSalt))
        assertEquals(KeepCrypto.base64URL(id), json.getValue("allowCredentials").jsonArray[0].jsonObject.str("id"))
    }

    @Test
    fun registrationReadsTheCredentialAndPRF() {
        val prf = ByteArray(32) { 9 }
        val raw = byteArrayOf(10, 20, 30)
        val withPRF = KeepPasskeyRequests.parseRegistration(
            """{"id":"${KeepCrypto.base64URL(raw)}","rawId":"${KeepCrypto.base64URL(raw)}","type":"public-key",
               "clientExtensionResults":{"prf":{"enabled":true,"results":{"first":"${KeepCrypto.base64URL(prf)}"}}}}""",
        )
        assertEquals(KeepCrypto.base64URL(raw), withPRF.credentialId)
        assertArrayEquals(prf, withPRF.prf)
        assertTrue(withPRF.prfEnabled)

        // Enabled, not evaluated: the caller asks once more.
        val enabledOnly = KeepPasskeyRequests.parseRegistration("""{"rawId":"CgsM","clientExtensionResults":{"prf":{"enabled":true}}}""")
        assertNull(enabledOnly.prf)
        assertTrue(enabledOnly.prfEnabled)

        val none = KeepPasskeyRequests.parseRegistration("""{"id":"CgsM","clientExtensionResults":{}}""")
        assertNull(none.prf)
        assertFalse(none.prfEnabled)

        assertThrows(KeepPasskeyError.Failed::class.java) { KeepPasskeyRequests.parseRegistration("""{"type":"public-key"}""") }
        assertThrows(KeepPasskeyError.Failed::class.java) { KeepPasskeyRequests.parseRegistration("not json") }
    }

    @Test
    fun assertionWithoutPRFGivesNothing() {
        assertNull(KeepPasskeyRequests.parseAssertion("""{"id":"CgsM","clientExtensionResults":{}}"""))
        assertNull(KeepPasskeyRequests.parseAssertion("""{"id":"CgsM","clientExtensionResults":{"prf":{"results":{"first":""}}}}"""))
    }

    /** The vector's PRF output, as Credential Manager returns it, opens the vector's PRF wrap. */
    @Test
    fun prfFromAnAssertionOpensCoreKitsVector() {
        val text = javaClass.classLoader!!.getResource("keep/vectors.json")!!.readText()
        val v = KeepJson.decodeFromString(KeepCryptoTest.Vectors.serializer(), text)
        val response = """{"id":"x","rawId":"x","type":"public-key","response":{},
            "clientExtensionResults":{"prf":{"results":{"first":"${v.prf.output}"}}}}"""
        val prf = KeepPasskeyRequests.parseAssertion(response)!!
        assertEquals(32, prf.size)
        val wrappingKey = KeepCrypto.wrappingKey(prf, KeepCrypto.data(v.prf.wrap.hkdfSalt!!))
        assertEquals(v.staff.publicKey, KeepCrypto.unwrapPrivateKey(v.prf.wrapped, wrappingKey).publicKey)

        prf[0] = (prf[0] + 1).toByte()
        val wrong = KeepCrypto.wrappingKey(prf, KeepCrypto.data(v.prf.wrap.hkdfSalt!!))
        assertThrows(KeepCryptoError::class.java) { KeepCrypto.unwrapPrivateKey(v.prf.wrapped, wrong) }
    }

    @Test
    fun enrolmentHidesItsSecret() {
        val e = KeepPasskeyEnrolment("cred", ByteArray(32) { 5 })
        assertFalse(e.toString().contains("5"))
        assertEquals("This passkey does not support PRF. Use a passphrase instead.", KeepPasskeyError.NoPRF().message)
    }
}
