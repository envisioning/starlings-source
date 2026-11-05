package work.starlings.android.workspace.team

/** `ThreadMarkdownFormatAction` (`Sources/ThreadMarkdown.swift`): the composer's format menu, in its order. */
enum class FormatAction { BOLD, ITALIC, STRIKETHROUGH, INLINE_CODE, LINK, BULLETED_LIST, NUMBERED_LIST, QUOTE, CODE_BLOCK }

/**
 * `ThreadMarkdownEditing`: Markdown authoring on the composer's text and
 * selection. Messages stay plain text on the wire; these edits only add
 * syntax the `ThreadMarkdown` renderers read. Offsets are UTF-16, as
 * `NSRange` and Compose's `TextRange` both count. Pure, for the JVM tests.
 */
object ThreadMarkdownEditing {
    /** [start] and [end] are the selection after the edit. */
    data class Edit(val text: String, val start: Int, val end: Int)

    /** The localized words a wrap inserts when nothing is selected ("bold text", "italic text"). */
    data class Placeholders(val bold: String = "bold text", val italic: String = "italic text")

    fun apply(action: FormatAction, text: String, start: Int, end: Int, placeholders: Placeholders = Placeholders()): Edit {
        val lo = minOf(start, end).coerceIn(0, text.length)
        val hi = maxOf(start, end).coerceIn(0, text.length)
        return when (action) {
            FormatAction.BOLD -> wrap("**", "**", placeholders.bold, text, lo, hi)
            FormatAction.ITALIC -> wrap("*", "*", placeholders.italic, text, lo, hi)
            FormatAction.STRIKETHROUGH -> wrap("~~", "~~", "strikethrough", text, lo, hi)
            FormatAction.INLINE_CODE -> wrap("`", "`", "code", text, lo, hi)
            FormatAction.LINK -> link(text, lo, hi)
            FormatAction.BULLETED_LIST -> listLines(false, text, lo, hi)
            FormatAction.NUMBERED_LIST -> listLines(true, text, lo, hi)
            FormatAction.QUOTE -> prefixLines("> ", text, lo, hi)
            FormatAction.CODE_BLOCK -> codeBlock(text, lo, hi)
        }
    }

    private fun replace(text: String, lo: Int, hi: Int, with: String) = text.substring(0, lo) + with + text.substring(hi)

    /** A second press on wrapped text takes the markers off: the controls toggle. */
    private fun wrap(prefix: String, suffix: String, placeholder: String, text: String, lo: Int, hi: Int): Edit {
        val selected = text.substring(lo, hi)
        if (hi > lo && lo >= prefix.length && hi + suffix.length <= text.length &&
            text.substring(lo - prefix.length, lo) == prefix && text.substring(hi, hi + suffix.length) == suffix
        ) {
            val from = lo - prefix.length
            val result = replace(text, from, hi + suffix.length, selected)
            return Edit(result, from, from + selected.length)
        }
        val content = if (hi > lo) selected else placeholder
        val result = replace(text, lo, hi, prefix + content + suffix)
        return Edit(result, lo + prefix.length, lo + prefix.length + content.length)
    }

    private fun link(text: String, lo: Int, hi: Int): Edit {
        val label = if (hi > lo) text.substring(lo, hi) else "link text"
        val target = "https://example.com"
        val result = replace(text, lo, hi, "[$label]($target)")
        val targetStart = lo + "[$label](".length
        return Edit(result, targetStart, targetStart + target.length)
    }

    /** Whole lines under the selection, the trailing newline included when there is one. */
    private fun lineBounds(text: String, lo: Int, hi: Int): IntRange {
        val start = minOf(lo, text.length)
        val last = if (hi == lo) start else minOf(hi - 1, text.length)
        var lineStart = start
        while (lineStart > 0 && text[lineStart - 1] != '\n') lineStart--
        var lineEnd = last
        while (lineEnd < text.length && text[lineEnd] != '\n') lineEnd++
        if (lineEnd < text.length) lineEnd++
        return lineStart until lineEnd
    }

    private fun prefixLines(marker: String, text: String, lo: Int, hi: Int): Edit {
        val bounds = lineBounds(text, lo, hi)
        val boundsStart = bounds.first
        val boundsEnd = bounds.last + 1
        val original = text.substring(boundsStart, boundsEnd)
        val lines = original.split("\n").toMutableList()
        val emptyLine = hi == lo && lines.first().isEmpty()
        val nonempty = lines.indices.filter { lines[it].isNotEmpty() }
        val formatted = nonempty.isNotEmpty() && nonempty.all { lines[it].startsWith(marker) }
        if (emptyLine) {
            lines[0] = marker
        } else {
            for (i in nonempty) lines[i] = if (formatted) lines[i].removePrefix(marker) else marker + lines[i]
        }
        val replacement = lines.joinToString("\n")
        val result = replace(text, boundsStart, boundsEnd, replacement)
        return if (hi == lo) {
            val caret = maxOf(boundsStart, lo + if (formatted) -marker.length else marker.length)
            Edit(result, caret, caret)
        } else {
            Edit(result, boundsStart, boundsStart + replacement.length)
        }
    }

    private val bullet = Regex("^[-*+] ")
    private val ordered = Regex("^\\d+[.)] ")

    private fun bulletPrefix(line: String): String? = bullet.find(line)?.value
    private fun orderedPrefix(line: String): String? = ordered.find(line)?.value

    private fun listLines(numbered: Boolean, text: String, lo: Int, hi: Int): Edit {
        val bounds = lineBounds(text, lo, hi)
        val boundsStart = bounds.first
        val boundsEnd = bounds.last + 1
        val original = text.substring(boundsStart, boundsEnd)
        val lines = original.split("\n").toMutableList()
        val emptyLine = hi == lo && lines.first().isEmpty()
        val nonempty = lines.indices.filter { lines[it].isNotEmpty() }
        val formatted = nonempty.isNotEmpty() && nonempty.all { if (numbered) orderedPrefix(lines[it]) != null else bulletPrefix(lines[it]) != null }
        val target = if (numbered) "1. " else "- "
        if (emptyLine) {
            lines[0] = target
        } else {
            nonempty.forEachIndexed { item, index ->
                var content = lines[index]
                if (formatted) {
                    (if (numbered) orderedPrefix(content) else bulletPrefix(content))?.let { content = content.substring(it.length) }
                } else {
                    (bulletPrefix(content) ?: orderedPrefix(content))?.let { content = content.substring(it.length) }
                    content = (if (numbered) "${item + 1}. " else "- ") + content
                }
                lines[index] = content
            }
        }
        val replacement = lines.joinToString("\n")
        val result = replace(text, boundsStart, boundsEnd, replacement)
        if (hi > lo) return Edit(result, boundsStart, boundsStart + replacement.length)
        val relative = maxOf(0, lo - boundsStart)
        val caretLine = text.substring(boundsStart, boundsStart + relative).split("\n").size - 1
        val current = original.split("\n")[caretLine]
        val currentPrefix = bulletPrefix(current) ?: orderedPrefix(current)
        val caret = when {
            emptyLine -> lo + target.length
            formatted -> maxOf(boundsStart, lo - (currentPrefix?.length ?: 0))
            relative <= (currentPrefix?.length ?: 0) -> boundsStart + target.length
            else -> lo + target.length - (currentPrefix?.length ?: 0)
        }
        return Edit(result, caret, caret)
    }

    private fun codeBlock(text: String, lo: Int, hi: Int): Edit {
        val content = if (hi > lo) text.substring(lo, hi) else "code"
        val result = replace(text, lo, hi, "```\n$content\n```")
        return Edit(result, lo + 4, lo + 4 + content.length)
    }
}
