package work.starlings.android.keep

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RFC 6238 Appendix B vectors (SHA-1, secret "12345678901234567890"), plus
 * the shapes 1Password exports. Mirrors core-kit `KeepTOTPTests.swift`.
 */
class KeepTOTPTest {
    private val rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" // base32 of 12345678901234567890

    @Test
    fun rfc6238SHA1Vectors() {
        val totp = KeepTOTP.parse("otpauth://totp/RFC:test?secret=$rfcSecret&digits=8")!!
        assertEquals("94287082", totp.code(59))
        assertEquals("07081804", totp.code(1_111_111_109))
        assertEquals("89005924", totp.code(1_234_567_890))
        assertEquals("65353130", totp.code(20_000_000_000))
    }

    /** RFC 6238 Appendix B for SHA-256 and SHA-512, with their longer seeds. */
    @Test
    fun rfc6238OtherAlgorithms() {
        val seed32 = KeepTOTP.base32Encode("12345678901234567890123456789012".toByteArray())
        val seed64 = KeepTOTP.base32Encode("1234567890123456789012345678901234567890123456789012345678901234".toByteArray())
        val sha256 = KeepTOTP.parse("otpauth://totp/x?secret=$seed32&digits=8&algorithm=SHA256")!!
        val sha512 = KeepTOTP.parse("otpauth://totp/x?secret=$seed64&digits=8&algorithm=sha512")!!
        assertEquals("46119246", sha256.code(59))
        assertEquals("90693936", sha512.code(59))
        assertEquals("91819424", sha256.code(1_234_567_890))
        assertEquals("93441116", sha512.code(1_234_567_890))
    }

    @Test
    fun bareSecretAndSpaces() {
        val totp = KeepTOTP.parse("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")!!
        assertEquals(6, totp.digits)
        assertEquals("287082", totp.code(59))
        assertTrue(totp.uri.startsWith("otpauth://totp/"))
        assertArrayEquals(totp.secret, KeepTOTP.parse(totp.uri)!!.secret)
    }

    @Test
    fun labelAndIssuer() {
        val totp = KeepTOTP.parse("otpauth://totp/GitHub:rosa%40org.example?secret=$rfcSecret&issuer=GitHub&period=60")!!
        assertEquals("GitHub", totp.issuer)
        assertEquals("rosa@org.example", totp.account)
        assertEquals(60, totp.period)
        assertEquals(1, totp.secondsRemaining(59))
        // The canonical form keeps everything that is not a default, and reads back the same.
        val again = KeepTOTP.parse(totp.uri)!!
        assertEquals(totp, again)
        assertEquals("otpauth://totp/GitHub:rosa@org.example?secret=$rfcSecret&issuer=GitHub&period=60", totp.uri)
    }

    @Test
    fun rejectsGarbage() {
        assertNull(KeepTOTP.parse(""))
        assertNull(KeepTOTP.parse("not base32 !!"))
        assertNull(KeepTOTP.parse("otpauth://hotp/x?secret=$rfcSecret"))
        assertNotNull(KeepTOTP.parse("OTPAUTH://TOTP/x?SECRET=$rfcSecret"))
    }

    @Test
    fun base32RoundTrips() {
        for (size in 0..40) {
            val bytes = KeepCrypto.randomBytes(size)
            assertArrayEquals(bytes, KeepTOTP.base32Decode(KeepTOTP.base32Encode(bytes)))
        }
    }
}
