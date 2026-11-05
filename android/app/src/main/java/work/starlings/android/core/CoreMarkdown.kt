package work.starlings.android.core

/**
 * core-kit `MarkdownText`'s blocks: a CRM note read line by line (author
 * line breaks kept, never reflowed), with headings, bullet and numbered
 * items, quotes, fenced code, rules and a picture alone on its line. The
 * runs inside a block are [work.starlings.android.ThreadMarkdown.spans].
 */
object CoreMarkdown {
    sealed interface Block {
        data class Heading(val text: String, val level: Int) : Block
        data class Bullet(val text: String) : Block
        data class Ordered(val number: Int, val text: String) : Block
        data class Quote(val text: String) : Block
        data class Code(val text: String) : Block
        data class Image(val alt: String, val url: String) : Block
        data object Rule : Block
        data class Paragraph(val text: String) : Block
        data object Blank : Block
    }

    fun blocks(markdown: String): List<Block> {
        val out = mutableListOf<Block>()
        var code: MutableList<String>? = null
        for (line in markdown.split("\r\n", "\n", "\r")) {
            val trimmed = line.trim(' ', '\t')
            if (trimmed.startsWith("```")) {
                val collected = code
                if (collected != null) {
                    out += Block.Code(collected.joinToString("\n"))
                    code = null
                } else {
                    code = mutableListOf()
                }
                continue
            }
            val open = code
            if (open != null) { open += line; continue }
            if (trimmed.isEmpty()) { out += Block.Blank; continue }
            if (trimmed.length >= 3 && (trimmed.all { it == '-' } || trimmed.all { it == '*' } || trimmed.all { it == '_' })) {
                out += Block.Rule
                continue
            }
            val picture = image(trimmed)
            if (picture != null) { out += picture; continue }
            if (trimmed.startsWith("#")) {
                val hashes = trimmed.takeWhile { it == '#' }.length
                val rest = trimmed.drop(hashes)
                val text = rest.trim(' ', '\t')
                // "#1" is a reference, not a heading.
                if (text.isNotEmpty() && rest.startsWith(" ")) { out += Block.Heading(text, hashes); continue }
            }
            if (trimmed.startsWith("> ")) { out += Block.Quote(trimmed.drop(2)); continue }
            if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) { out += Block.Bullet(trimmed.drop(2)); continue }
            out += ordered(trimmed) ?: Block.Paragraph(trimmed)
        }
        // An unterminated fence still reads as code.
        code?.let { out += Block.Code(it.joinToString("\n")) }
        return out
    }

    /** `![alt](url)` as the whole line, http or https only. */
    private fun image(text: String): Block.Image? {
        if (!text.startsWith("![") || !text.endsWith(")")) return null
        val close = text.indexOf("](")
        if (close < 0 || close + 2 >= text.length) return null
        val alt = text.substring(2, close)
        val url = text.substring(close + 2, text.length - 1).trim()
        val scheme = url.substringBefore(':', "").lowercase()
        if (scheme != "http" && scheme != "https") return null
        return Block.Image(alt, url)
    }

    /** `<digits>. text`. */
    private fun ordered(text: String): Block.Ordered? {
        val digits = text.takeWhile { it.isDigit() }
        if (digits.isEmpty()) return null
        val number = digits.toIntOrNull() ?: return null
        val rest = text.drop(digits.length)
        if (!rest.startsWith(". ")) return null
        return Block.Ordered(number, rest.drop(2))
    }
}
