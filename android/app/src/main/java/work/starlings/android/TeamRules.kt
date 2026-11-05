package work.starlings.android

import java.text.BreakIterator

/** The grapheme clusters of [text], in order: what Swift calls its `Character`s. */
internal fun graphemes(text: String): List<String> {
    if (text.isEmpty()) return emptyList()
    val it = BreakIterator.getCharacterInstance().apply { setText(text) }
    val result = mutableListOf<String>()
    var start = it.first()
    var end = it.next()
    while (end != BreakIterator.DONE) {
        result += text.substring(start, end)
        start = end
        end = it.next()
    }
    return result
}

/** One place a candidate is named: grapheme offsets into the text, the `@` included. */
data class MentionRange(val range: IntRange, val email: String)

/**
 * Where an `@mention` is written, read back and highlighted:
 * `Sources/MentionMatching.swift` and `web/src/ThreadPane.tsx`, held to
 * `fixtures/mention-matching.json`.
 *
 * A mention names a person by their email's local part or by the whole
 * address, case-insensitively, never by a display name. A handle is whole:
 * a letter, mark, number, `.`, `_`, `+` or `-` touching either end means it
 * is part of a longer handle.
 */
object MentionMatching {
    /** Who the finished text still names, in candidate order, each email once. */
    fun mentions(text: String, candidates: List<String>): List<String> {
        val characters = graphemes(text.lowercase())
        val seen = mutableSetOf<String>()
        val result = mutableListOf<String>()
        for (candidate in candidates) {
            val email = candidate.lowercase()
            if (email.isEmpty() || email in seen) continue
            val named = ranges(localPart(email), characters).isNotEmpty() || ranges(email, characters).isNotEmpty()
            if (!named) continue
            seen += email
            result += candidate
        }
        return result
    }

    /**
     * Where each candidate is named, widest match first, nothing overlapping
     * kept twice, then in text order. Empty when lowercasing changes the
     * grapheme count, so offsets always agree with [text].
     */
    fun highlightRanges(text: String, candidates: List<String>): List<MentionRange> {
        val characters = graphemes(text.lowercase())
        if (characters.size != graphemes(text).size) return emptyList()
        val found = mutableListOf<MentionRange>()
        for (candidate in candidates) {
            val email = candidate.lowercase()
            if (email.isEmpty()) continue
            for (needle in linkedSetOf(localPart(email), email)) {
                if (needle.isEmpty()) continue
                ranges(needle, characters).forEach { found += MentionRange(it, candidate) }
            }
        }
        val sorted = found.sortedWith(compareByDescending<MentionRange> { it.range.count() }.thenBy { it.range.first })
        val kept = mutableListOf<MentionRange>()
        for (c in sorted) {
            if (kept.none { it.range.first <= c.range.last && c.range.first <= it.range.last }) kept += c
        }
        return kept.sortedBy { it.range.first }
    }

    /** `ana.silva` from `ana.silva@example.com`. */
    fun localPart(email: String): String = email.substringBefore('@')

    /** Every `@needle` in [characters] that is a whole handle. */
    private fun ranges(needle: String, characters: List<String>): List<IntRange> {
        if (needle.isEmpty()) return emptyList()
        val pattern = graphemes("@$needle")
        val results = mutableListOf<IntRange>()
        var index = 0
        while (index + pattern.size <= characters.size) {
            if (characters.subList(index, index + pattern.size) == pattern) {
                val leadOK = index == 0 || !isHandleCodePoint(characters[index - 1].let { it.codePointBefore(it.length) })
                val tail = index + pattern.size
                val tailOK = tail >= characters.size || !isHandleCodePoint(characters[tail].codePointAt(0))
                if (leadOK && tailOK) {
                    results += index until tail
                    index = tail
                    continue
                }
            }
            index += 1
        }
        return results
    }

    /** Unicode categories L, M and N, plus `.`, `_`, `+` and `-`: the web's code-point predicate. */
    private fun isHandleCodePoint(cp: Int): Boolean = when (Character.getType(cp).toByte()) {
        Character.UPPERCASE_LETTER, Character.LOWERCASE_LETTER, Character.TITLECASE_LETTER,
        Character.MODIFIER_LETTER, Character.OTHER_LETTER,
        Character.NON_SPACING_MARK, Character.COMBINING_SPACING_MARK, Character.ENCLOSING_MARK,
        Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER -> true
        else -> cp == '.'.code || cp == '_'.code || cp == '+'.code || cp == '-'.code
    }
}

/**
 * The words a roster shows for presence, keyed by wire id:
 * `packages/contracts/src/presence-values.ts` (Swift:
 * `Sources/Generated/PresenceValuesRegistry.swift`), held to
 * `fixtures/presence-values.json`. An unknown intent shows its own id.
 */
object PresenceLabels {
    /** `dnd` on the wire: they asked not to be interrupted. */
    val status = mapOf(
        "dnd" to "Unavailable",
        "in_meeting" to "In a meeting",
        "busy" to "Busy",
        "available" to "Available",
        "active" to "Active",
        "offline" to "Offline",
    )

    /** Named for where the person is, not for what we build. */
    val client = mapOf(
        "mac" to "Desktop",
        "ios" to "Mobile",
        "web" to "Web",
    )

    val intent = mapOf(
        "available" to "Available",
        "focused" to "Focused",
    )

    fun intentLabel(id: String): String = intent[id] ?: id
}
