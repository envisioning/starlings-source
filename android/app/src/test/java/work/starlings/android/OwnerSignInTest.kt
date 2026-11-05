package work.starlings.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.Base64

/** The PKCE attempt of `Sources/WorkspaceSignIn.swift`, and the callback the Worker allows. */
class OwnerSignInTest {
    private val origin = "https://envisioning.starlings.example"

    @Test
    fun challengeAndStart() {
        val a = OwnerSignInAttempt(origin)
        assertEquals(43, a.challenge.length)
        val expected = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(a.verifier.toByteArray()))
        assertEquals(expected, a.challenge)
        assertEquals(
            "$origin/api/auth/native/start?code_challenge=${a.challenge}&state=${a.state}&callback=work.starlings.android%3A%2Fauth%2Fcallback",
            a.startUrl,
        )
        assertNotEquals(a.state, OwnerSignInAttempt(origin).state)
    }

    @Test
    fun callback() {
        val a = OwnerSignInAttempt(origin)
        val cb = OwnerSignInAttempt.CALLBACK
        assertEquals(OwnerSignInAttempt.Result.Code("abc+/="), a.read("$cb?code=abc%2B%2F%3D&state=${a.state}"))
        assertEquals(OwnerSignInAttempt.Result.Cancelled, a.read("$cb?state=${a.state}&error=cancelled"))
        assertEquals(OwnerSignInAttempt.Result.Invalid, a.read("$cb?code=abc&state=other"))
        assertEquals(OwnerSignInAttempt.Result.Invalid, a.read("$cb?state=${a.state}"))
        assertEquals(OwnerSignInAttempt.Result.Invalid, a.read("work.starlings.android:/auth/other?code=abc&state=${a.state}"))
        assertEquals(OwnerSignInAttempt.Result.Invalid, a.read("com.starlingshq.app:/auth/callback?code=abc&state=${a.state}"))
    }

    /** The callback is the one the Worker's allowlist names. */
    @Test
    fun callbackMatchesTheContract() {
        val dir = System.getProperty("starlings.contracts") ?: error("starlings.contracts is not set")
        val source = File(dir, "native-app.ts").readText()
        assertTrue(source.contains("ANDROID_NATIVE_SIGN_IN_CALLBACK = '${OwnerSignInAttempt.CALLBACK}'"))
    }
}
