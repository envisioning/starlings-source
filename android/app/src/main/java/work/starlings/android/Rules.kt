package work.starlings.android

import java.text.BreakIterator

/**
 * Shared product rules, ported from Swift and TypeScript. Each one is held to
 * the same file under `fixtures/` by `RulesFixtureTest`, so a change to the
 * rule on any client fails the Android gate until this copy follows.
 */
object ParticipantInitials {
    private val parenthetical = Regex("""\([^)]*(\)|$)""")

    /**
     * `ParticipantInitials.make` (Sources/ParticipantInitials.swift): the
     * first letter of the first two words, uppercased, after every
     * parenthetical is dropped. A letter is a grapheme. No letters is `?`.
     */
    fun make(name: String): String {
        val words = parenthetical.replace(name, " ")
            .split { it.isWhitespace() || Character.isSpaceChar(it) }
            .filter { it.isNotEmpty() }
            .take(2)
        val letters = words.map(::firstGrapheme)
        return if (letters.isEmpty()) "?" else letters.joinToString("").uppercase()
    }

    private fun firstGrapheme(word: String): String {
        val it = BreakIterator.getCharacterInstance().apply { setText(word) }
        return word.substring(0, it.next().takeIf { end -> end != BreakIterator.DONE } ?: word.length)
    }

    private fun String.split(separator: (Char) -> Boolean): List<String> {
        val out = mutableListOf<String>()
        val current = StringBuilder()
        forEach { c ->
            if (separator(c)) { out += current.toString(); current.clear() } else current.append(c)
        }
        out += current.toString()
        return out
    }
}

/** `packages/contracts/src/reactions.ts`, pinned by `fixtures/reactions.json`. */
object Reactions {
    const val TOPIC = "reactions.v1"
    val palette = listOf("👍", "❤️", "😂", "🎉")
    val labels = mapOf("👍" to "Thumbs up", "❤️" to "Heart", "😂" to "Laugh", "🎉" to "Celebrate")
    const val MIN_INTERVAL_MS = 350L
    const val FLIGHT_MS = 2600L
    const val FLIGHT_JITTER_MS = 600L
    const val MAX_ONSCREEN = 40

    /** The spoken label of each palette emoji, for TalkBack. */
    val labelResource = mapOf(
        "👍" to R.string.reaction_thumbs_up,
        "❤️" to R.string.reaction_heart,
        "😂" to R.string.reaction_laugh,
        "🎉" to R.string.reaction_celebrate,
    )
}
