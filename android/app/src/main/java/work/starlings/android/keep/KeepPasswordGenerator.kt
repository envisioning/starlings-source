package work.starlings.android.keep

/**
 * Passwords for items: core-kit `KeepKit/KeepPasswordGenerator.swift`. One
 * generator, a small options value, and named presets.
 */
data class KeepPasswordOptions(
    val style: Style = Style.CHARACTERS,
    val length: Int = 20,
    val uppercase: Boolean = true,
    val digits: Boolean = true,
    val symbols: Boolean = true,
    /** Drop 0/O, 1/l/I and the like. */
    val avoidAmbiguous: Boolean = true,
) {
    enum class Style {
        /** One run of characters. */
        CHARACTERS,
        /** Groups of four joined by dashes, readable aloud. */
        GROUPS,
        /** Digits only: a PIN. */
        DIGITS,
    }

    companion object {
        val strong = KeepPasswordOptions()
        val long = KeepPasswordOptions(length = 32)
        val readable = KeepPasswordOptions(style = Style.GROUPS, length = 20, uppercase = false, digits = true, symbols = false)
        val pin = KeepPasswordOptions(style = Style.DIGITS, length = 6, uppercase = false, digits = true, symbols = false, avoidAmbiguous = false)
        /** For a vendor that refuses symbols. */
        val alphanumeric = KeepPasswordOptions(length = 24, symbols = false)
    }
}

/** A preset of the Generate menu. [title] is core-kit's, untranslated there too. */
data class KeepPasswordPreset(val id: String, val title: String, val options: KeepPasswordOptions) {
    companion object {
        /** The menu, in order. */
        val all: List<KeepPasswordPreset> = listOf(
            KeepPasswordPreset("strong", "Strong · 20", KeepPasswordOptions.strong),
            KeepPasswordPreset("long", "Long · 32", KeepPasswordOptions.long),
            KeepPasswordPreset("alnum", "No symbols · 24", KeepPasswordOptions.alphanumeric),
            KeepPasswordPreset("readable", "Readable groups", KeepPasswordOptions.readable),
            KeepPasswordPreset("pin", "PIN · 6 digits", KeepPasswordOptions.pin),
        )
    }
}

object KeepPasswordGenerator {
    private const val LOWER = "abcdefghijklmnopqrstuvwxyz"
    private const val UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    private const val DIGIT_CHARS = "0123456789"
    private const val SYMBOL_CHARS = "!#$%&*+-=?@^_~"
    private val ambiguous = setOf('0', 'O', 'o', '1', 'l', 'I', '|')

    fun generate(options: KeepPasswordOptions): String = when (options.style) {
        KeepPasswordOptions.Style.DIGITS -> String(pick(DIGIT_CHARS.toList(), maxOf(4, options.length)).toCharArray())
        KeepPasswordOptions.Style.GROUPS -> {
            val alphabet = alphabet(options)
            (0 until maxOf(2, options.length / 4)).joinToString("-") { String(pick(alphabet, 4).toCharArray()) }
        }
        KeepPasswordOptions.Style.CHARACTERS -> {
            val alphabet = alphabet(options)
            // Keep drawing until every enabled class is present, so a vendor's
            // "must contain a digit" rule never bounces a generated password.
            var result: List<Char>
            do {
                result = pick(alphabet, maxOf(8, options.length))
            } while (!satisfies(result, options))
            String(result.toCharArray())
        }
    }

    private fun alphabet(options: KeepPasswordOptions): List<Char> {
        var set = LOWER
        if (options.uppercase) set += UPPER
        if (options.digits) set += DIGIT_CHARS
        if (options.symbols) set += SYMBOL_CHARS
        val chars = set.toList()
        return if (options.avoidAmbiguous) chars.filter { it !in ambiguous } else chars
    }

    private fun satisfies(chars: List<Char>, options: KeepPasswordOptions): Boolean {
        if (options.uppercase && chars.none { it.isUpperCase() }) return false
        if (options.digits && chars.none { it.isDigit() }) return false
        if (options.symbols && chars.none { it in SYMBOL_CHARS }) return false
        return true
    }

    /** Uniform picks: rejection sampling over a byte, so no modulo bias. */
    internal fun pick(alphabet: List<Char>, count: Int): List<Char> {
        require(alphabet.isNotEmpty() && alphabet.size <= 256)
        val limit = 256 - (256 % alphabet.size)
        val out = ArrayList<Char>(count)
        while (out.size < count) {
            for (byte in KeepCrypto.randomBytes(count * 2)) {
                val value = byte.toInt() and 0xff
                if (value >= limit) continue
                out.add(alphabet[value % alphabet.size])
                if (out.size == count) break
            }
        }
        return out
    }
}

/**
 * A generated passphrase: five groups of four from a 31-letter alphabet with
 * no look-alikes, `xxxx-xxxx-xxxx-xxxx-xxxx` (core-kit `KeepPassphrase.swift`).
 * Shown once and copied; the person stores it in their own password manager.
 */
object KeepPassphrase {
    private const val ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"

    fun generate(groups: Int = 5, groupLength: Int = 4): String {
        val bytes = KeepCrypto.randomBytes(groups * groupLength)
        var index = 0
        return (0 until groups).joinToString("-") {
            buildString {
                repeat(groupLength) {
                    append(ALPHABET[(bytes[index].toInt() and 0xff) % ALPHABET.length])
                    index++
                }
            }
        }
    }
}
