package work.starlings.android.keep

import java.net.URI
import java.net.URLDecoder
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * RFC 6238 time-based one-time codes from an `otpauth://totp/…` URI or a
 * bare base32 secret, as 1Password exports them: core-kit
 * `KeepKit/KeepTOTP.swift`. Computed on the device from the sealed secret;
 * the server never sees the secret or a code.
 */
class KeepTOTP private constructor(
    internal val secret: ByteArray,
    val digits: Int,
    val period: Int,
    val algorithm: Algorithm,
    val issuer: String?,
    val account: String?,
) {
    enum class Algorithm(val wire: String, internal val mac: String) {
        SHA1("SHA1", "HmacSHA1"), SHA256("SHA256", "HmacSHA256"), SHA512("SHA512", "HmacSHA512"),
    }

    /** The code for [epochSeconds], zero-padded to [digits]. */
    fun code(epochSeconds: Long = System.currentTimeMillis() / 1000): String {
        val counter = epochSeconds / period
        val message = ByteArray(8) { (counter ushr (56 - it * 8)).toByte() }
        val name = algorithm.mac
        val mac = Mac.getInstance(name).apply { init(SecretKeySpec(secret, name)) }.doFinal(message)
        val offset = mac[mac.size - 1].toInt() and 0x0f
        val binary = ((mac[offset].toInt() and 0x7f) shl 24) or
            ((mac[offset + 1].toInt() and 0xff) shl 16) or
            ((mac[offset + 2].toInt() and 0xff) shl 8) or
            (mac[offset + 3].toInt() and 0xff)
        var modulo = 1L
        repeat(digits) { modulo *= 10 }
        return (binary.toLong() % modulo).toString().padStart(digits, '0')
    }

    /** Seconds until the current code changes. */
    fun secondsRemaining(epochSeconds: Long = System.currentTimeMillis() / 1000): Int = period - (epochSeconds % period).toInt()

    /** A canonical URI for storage, from whatever the person pasted. */
    val uri: String
        get() {
            val label = listOfNotNull(issuer, account).joinToString(":").ifEmpty { "Keep" }
            val items = buildList {
                add("secret" to base32Encode(secret))
                issuer?.let { add("issuer" to it) }
                if (algorithm != Algorithm.SHA1) add("algorithm" to algorithm.wire)
                if (digits != 6) add("digits" to digits.toString())
                if (period != 30) add("period" to period.toString())
            }
            return "otpauth://totp/" + pathEncode(label) + "?" + items.joinToString("&") { (k, v) -> "$k=${queryEncode(v)}" }
        }

    override fun equals(other: Any?): Boolean = other is KeepTOTP && other.secret.contentEquals(secret) &&
        other.digits == digits && other.period == period && other.algorithm == algorithm && other.issuer == issuer && other.account == account

    override fun hashCode(): Int = secret.contentHashCode()

    override fun toString(): String = "KeepTOTP(…)"

    companion object {
        /** Parses an `otpauth://totp/` URI, or a bare base32 secret (spaces allowed). Null when it is neither. */
        fun parse(text: String): KeepTOTP? {
            val trimmed = text.trim()
            if (trimmed.isEmpty()) return null
            if (trimmed.lowercase().startsWith("otpauth://")) {
                val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
                if (uri.host?.lowercase() != "totp") return null
                val items = linkedMapOf<String, String>()
                uri.rawQuery?.split('&')?.forEach { pair ->
                    if (pair.isEmpty()) return@forEach
                    val at = pair.indexOf('=')
                    val name = decode(if (at < 0) pair else pair.substring(0, at)).lowercase()
                    val value = if (at < 0) "" else decode(pair.substring(at + 1))
                    items.putIfAbsent(name, value)
                }
                val secret = items["secret"]?.let(::base32Decode)?.takeIf { it.isNotEmpty() } ?: return null
                val label = (uri.rawPath ?: "").removePrefix("/").let(::percentDecode)
                val parts = label.split(":", limit = 2).map { it.trim() }
                return KeepTOTP(
                    secret = secret,
                    digits = items["digits"]?.toIntOrNull() ?: 6,
                    period = items["period"]?.toIntOrNull() ?: 30,
                    algorithm = Algorithm.entries.firstOrNull { it.wire == (items["algorithm"] ?: "SHA1").uppercase() } ?: Algorithm.SHA1,
                    issuer = items["issuer"] ?: (if (parts.size == 2) parts[0] else null),
                    account = if (parts.size == 2) parts[1] else parts.firstOrNull(),
                ).takeIf { it.digits in 1..9 && it.period > 0 }
            }
            val secret = base32Decode(trimmed)?.takeIf { it.isNotEmpty() } ?: return null
            return KeepTOTP(secret, 6, 30, Algorithm.SHA1, null, null)
        }

        private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

        internal fun base32Decode(text: String): ByteArray? {
            val cleaned = text.uppercase().filter { it != ' ' && it != '-' && it != '=' }
            var bits = 0
            var value = 0
            val out = java.io.ByteArrayOutputStream()
            for (char in cleaned) {
                val index = ALPHABET.indexOf(char)
                if (index < 0) return null
                value = (value shl 5) or index
                bits += 5
                if (bits >= 8) {
                    out.write((value shr (bits - 8)) and 0xff)
                    bits -= 8
                }
                value = value and 0xffff
            }
            return out.toByteArray()
        }

        internal fun base32Encode(data: ByteArray): String {
            var bits = 0
            var value = 0
            val out = StringBuilder()
            for (byte in data) {
                value = (value shl 8) or (byte.toInt() and 0xff)
                bits += 8
                while (bits >= 5) {
                    out.append(ALPHABET[(value shr (bits - 5)) and 31])
                    bits -= 5
                }
                value = value and 0xffff
            }
            if (bits > 0) out.append(ALPHABET[(value shl (5 - bits)) and 31])
            return out.toString()
        }

        private fun decode(s: String): String = percentDecode(s)

        /** Percent escapes only: `+` stays a plus, as `URLComponents` and `removingPercentEncoding` leave it. */
        private fun percentDecode(s: String): String = runCatching { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s)

        /** What URLComponents leaves in a path: unreserved, sub-delims, `:` and `@`. */
        private fun pathEncode(s: String): String = buildString {
            for (byte in s.toByteArray(Charsets.UTF_8)) {
                val c = byte.toInt() and 0xff
                val ch = c.toChar()
                if (c < 0x80 && (ch.isLetterOrDigit() || ch in "-._~!$&'()*+,;=:@")) append(ch) else append("%%%02X".format(c))
            }
        }

        /** What URLComponents leaves in a query value. */
        private fun queryEncode(s: String): String = buildString {
            for (byte in s.toByteArray(Charsets.UTF_8)) {
                val c = byte.toInt() and 0xff
                val ch = c.toChar()
                if (c < 0x80 && (ch.isLetterOrDigit() || ch in "-._~!$'()*+,;:@/?")) append(ch) else append("%%%02X".format(c))
            }
        }
    }
}
