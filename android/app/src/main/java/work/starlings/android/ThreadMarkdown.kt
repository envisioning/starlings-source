package work.starlings.android

/**
 * A run of text with the marks that survived parsing. Nested emphasis
 * collapses into one span: `**bold *and italic***` is a bold-italic run.
 */
data class MarkdownSpan(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val strike: Boolean = false,
    val code: Boolean = false,
    /** Already clamped to `http`, `https` or `mailto`. */
    val link: String? = null,
    /** The email this run names. Only `highlightingMentions` sets it, never `parse`. */
    val mention: String? = null,
)

sealed interface MarkdownBlockKind {
    data object Paragraph : MarkdownBlockKind
    /** 1...3. Deeper hashes read as level 3. */
    data class Heading(val level: Int) : MarkdownBlockKind
    /** Indent level, 0-based and capped at 2. */
    data class Bullet(val level: Int) : MarkdownBlockKind
    /** Indent level, and the number as written. */
    data class Ordered(val level: Int, val number: Int) : MarkdownBlockKind
    data object Quote : MarkdownBlockKind
    /** Verbatim, newlines intact. The block's spans are empty. */
    data class Code(val text: String) : MarkdownBlockKind
}

data class MarkdownBlock(val kind: MarkdownBlockKind, val spans: List<MarkdownSpan>)

/**
 * The small Markdown a conversation is written in: `Sources/ThreadMarkdown.swift`
 * and `web/src/markdown-parse.ts`, held to `fixtures/thread-markdown.json`.
 *
 * A subset: paragraphs, headings, bullet and numbered lists, quotes, fenced
 * code, and inline bold, italic, strikethrough, code, links and bare URLs.
 * A "character" here is a grapheme cluster, as in Swift.
 */
object ThreadMarkdown {
    // Blocks

    /** A message in, its blocks out. An unterminated fence ends at the end of the message. */
    fun parse(text: String): List<MarkdownBlock> {
        val lines = text.replace("\r\n", "\n").split("\n")
        val blocks = mutableListOf<MarkdownBlock>()
        val paragraph = mutableListOf<String>()

        fun flushParagraph() {
            if (paragraph.isEmpty()) return
            blocks += MarkdownBlock(MarkdownBlockKind.Paragraph, spans(paragraph.joinToString("\n")))
            paragraph.clear()
        }

        var index = 0
        while (index < lines.size) {
            val line = lines[index]
            val trimmed = trimSpaces(line)

            if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
                flushParagraph()
                val fence = trimmed.substring(0, 3)
                val body = mutableListOf<String>()
                index += 1
                while (index < lines.size && !trimSpaces(lines[index]).startsWith(fence)) {
                    body += lines[index]
                    index += 1
                }
                if (index < lines.size) index += 1
                blocks += MarkdownBlock(MarkdownBlockKind.Code(body.joinToString("\n")), emptyList())
                continue
            }

            if (trimmed.isEmpty()) {
                flushParagraph()
                index += 1
                continue
            }

            val heading = heading(trimmed)
            if (heading != null) {
                flushParagraph()
                blocks += MarkdownBlock(MarkdownBlockKind.Heading(heading.first), spans(heading.second))
                index += 1
                continue
            }

            if (trimmed.startsWith(">")) {
                flushParagraph()
                blocks += MarkdownBlock(MarkdownBlockKind.Quote, spans(trimSpaces(trimmed.substring(1))))
                index += 1
                continue
            }

            val bullet = bullet(line)
            if (bullet != null) {
                flushParagraph()
                blocks += MarkdownBlock(MarkdownBlockKind.Bullet(bullet.first), spans(bullet.second))
                index += 1
                continue
            }

            val ordered = ordered(line)
            if (ordered != null) {
                flushParagraph()
                blocks += MarkdownBlock(MarkdownBlockKind.Ordered(ordered.level, ordered.number), spans(ordered.text))
                index += 1
                continue
            }

            paragraph += trimmed
            index += 1
        }
        flushParagraph()
        return blocks
    }

    /**
     * Split the plain runs of these blocks where a message's resolved mentions
     * name somebody. A link or code span is left whole: its `@` is literal.
     */
    fun highlightingMentions(blocks: List<MarkdownBlock>, mentionedEmails: List<String>): List<MarkdownBlock> {
        if (mentionedEmails.isEmpty()) return blocks
        return blocks.map { block ->
            block.copy(spans = block.spans.flatMap { span ->
                if (span.mention != null || span.link != null || span.code) listOf(span) else split(span, mentionedEmails)
            })
        }
    }

    private fun split(span: MarkdownSpan, emails: List<String>): List<MarkdownSpan> {
        val ranges = MentionMatching.highlightRanges(span.text, emails)
        if (ranges.isEmpty()) return listOf(span)
        val characters = graphemes(span.text)
        fun slice(from: Int, to: Int) = characters.subList(from, to).joinToString("")
        val result = mutableListOf<MarkdownSpan>()
        var cursor = 0
        for (match in ranges) {
            if (match.range.first > cursor) result += span.copy(text = slice(cursor, match.range.first))
            result += span.copy(text = slice(match.range.first, match.range.last + 1), mention = match.email)
            cursor = match.range.last + 1
        }
        if (cursor < characters.size) result += span.copy(text = slice(cursor, characters.size))
        return result
    }

    /** The words without their marks: bullets read `• `, numbers `n. `, code verbatim. */
    fun plainText(text: String): String = parse(text).joinToString("\n") { block ->
        val content = block.spans.joinToString("") { it.text }
        when (val kind = block.kind) {
            is MarkdownBlockKind.Bullet -> "• $content"
            is MarkdownBlockKind.Ordered -> "${kind.number}. $content"
            is MarkdownBlockKind.Code -> kind.text
            else -> content
        }
    }

    /** `plainText` on one line: runs of whitespace become single spaces. */
    fun plainPreview(text: String): String =
        graphemes(plainText(text)).fold(mutableListOf(StringBuilder())) { words, g ->
            if (isWhitespace(g)) { if (words.last().isNotEmpty()) words += StringBuilder() } else words.last().append(g)
            words
        }.filter { it.isNotEmpty() }.joinToString(" ")

    /**
     * The first `https` link outside code blocks, for a link preview
     * (`Sources/LinkPreview.swift`). `http` is skipped: the Worker refuses it.
     */
    fun firstPreviewableLink(text: String): String? {
        for (block in parse(text)) {
            if (block.kind is MarkdownBlockKind.Code) continue
            block.spans.firstNotNullOfOrNull { s -> s.link?.takeIf { it.startsWith("https://") } }?.let { return it }
        }
        return null
    }

    /** `#tag` is a tag, not a heading: the space after the hashes makes it one. */
    private fun heading(trimmed: String): Pair<Int, String>? {
        val hashes = trimmed.takeWhile { it == '#' }.length
        if (hashes == 0 || hashes > 6) return null
        val rest = trimmed.substring(hashes)
        if (!rest.startsWith(" ")) return null
        return minOf(hashes, 3) to trimSpaces(rest)
    }

    /** `-`, `*` or `+` and a space. Without the space it is emphasis or a rule. */
    private fun bullet(line: String): Pair<Int, String>? {
        val level = indentLevel(line)
        val trimmed = trimSpaces(line)
        val marker = trimmed.firstOrNull() ?: return null
        if (marker != '-' && marker != '*' && marker != '+') return null
        if (graphemes(trimmed).first().length != 1) return null
        val rest = trimmed.substring(1)
        if (!rest.startsWith(" ")) return null
        return level to trimSpaces(rest)
    }

    private data class OrderedItem(val level: Int, val number: Int, val text: String)

    /** Up to nine digits, then `.` or `)`, then a space. */
    private fun ordered(line: String): OrderedItem? {
        val level = indentLevel(line)
        val characters = graphemes(trimSpaces(line))
        var i = 0
        val digits = StringBuilder()
        while (i < characters.size && isNumber(characters[i]) && i < 9) {
            digits.append(characters[i])
            i += 1
        }
        if (digits.isEmpty() || !digits.all { it in '0'..'9' }) return null
        val number = digits.toString().toInt()
        if (i >= characters.size || (characters[i] != "." && characters[i] != ")")) return null
        i += 1
        if (i >= characters.size || characters[i] != " ") return null
        return OrderedItem(level, number, trimSpaces(characters.subList(i, characters.size).joinToString("")))
    }

    /** Two spaces, or one tab, is a nesting step, capped at 2. */
    private fun indentLevel(line: String): Int {
        var spaces = 0
        for (c in line) {
            if (c == ' ') spaces += 1 else if (c == '\t') spaces += 2 else break
        }
        return minOf(2, spaces / 2)
    }

    // Inline

    fun spans(text: String): List<MarkdownSpan> = inline(graphemes(text), MarkdownSpan(""))

    private fun inline(characters: List<String>, base: MarkdownSpan): List<MarkdownSpan> {
        val spans = mutableListOf<MarkdownSpan>()
        val literal = StringBuilder()
        var index = 0

        fun flush() {
            if (literal.isEmpty()) return
            spans += base.copy(text = literal.toString())
            literal.clear()
        }
        fun slice(from: Int, to: Int) = characters.subList(from, to)

        while (index < characters.size) {
            val character = characters[index]

            // A backslash escape is the only way to type a marker literally.
            if (character == "\\" && index + 1 < characters.size && isMarker(characters[index + 1])) {
                literal.append(characters[index + 1])
                index += 2
                continue
            }

            if (character == "`") {
                val close = firstIndex("`", characters, index + 1)
                if (close != null) {
                    flush()
                    spans += base.copy(code = true, text = slice(index + 1, close).joinToString(""))
                    index = close + 1
                    continue
                }
            }

            if (character == "~" && index + 1 < characters.size && characters[index + 1] == "~") {
                val close = closingEmphasis(characters, "~", 2, index + 2, index)
                if (close != null) {
                    flush()
                    spans += inline(slice(index + 2, close), base.copy(strike = true))
                    index = close + 2
                    continue
                }
            }

            if (character == "[") {
                val label = closingBracket(characters, index)
                if (label != null && label + 1 < characters.size && characters[label + 1] == "(") {
                    val paren = firstIndex(")", characters, label + 2)
                    val url = paren?.let { safeURL(trimSpaces(slice(label + 2, it).joinToString(""))) }
                    if (paren != null && url != null) {
                        flush()
                        spans += inline(slice(index + 1, label), base.copy(link = url))
                        index = paren + 1
                        continue
                    }
                }
            }

            if (character == "*" || character == "_") {
                // Up to three markers. A run that never closes at its own width tries a narrower one.
                var run = 1
                while (run < 3 && index + run < characters.size && characters[index + run] == character) run += 1
                var emphasised = false
                var width = run
                while (width >= 1 && !emphasised) {
                    val close = closingEmphasis(characters, character, width, index + width, index)
                    if (close != null) {
                        flush()
                        val inner = when {
                            width >= 3 -> base.copy(bold = true, italic = true)
                            width == 2 -> base.copy(bold = true)
                            else -> base.copy(italic = true)
                        }
                        spans += inline(slice(index + width, close), inner)
                        index = close + width
                        emphasised = true
                    }
                    width -= 1
                }
                if (emphasised) continue
            }

            val bare = autolink(characters, index)
            if (bare != null) {
                flush()
                spans += base.copy(link = bare.url, text = bare.display)
                index = bare.end
                continue
            }

            literal.append(character)
            index += 1
        }
        flush()
        return spans
    }

    private const val MARKERS = "\\`*_~[]()#>-+.!"

    private fun isMarker(g: String) = g.length == 1 && g[0] in MARKERS

    private fun firstIndex(needle: String, characters: List<String>, from: Int): Int? =
        (from until characters.size).firstOrNull { characters[it] == needle }

    /** The `]` that closes this `[`, counting nested pairs. */
    private fun closingBracket(characters: List<String>, from: Int): Int? {
        var depth = 0
        for (i in from until characters.size) {
            if (characters[i] == "[") depth += 1
            if (characters[i] == "]") {
                depth -= 1
                if (depth == 0) return i
            }
        }
        return null
    }

    /**
     * Where this emphasis run ends, or null. No whitespace just inside the
     * markers, and `_` only at word boundaries, so `snake_case_names` survives.
     */
    private fun closingEmphasis(characters: List<String>, marker: String, width: Int, from: Int, opener: Int): Int? {
        if (from >= characters.size || isWhitespace(characters[from])) return null
        if (marker == "_" && opener > 0 && isWordCharacter(characters[opener - 1])) return null
        var index = from
        while (index + width <= characters.size) {
            val matches = (0 until width).all { characters[index + it] == marker }
            if (matches && index > from && !isWhitespace(characters[index - 1])) {
                val after = index + width
                val boundary = after >= characters.size || !isWordCharacter(characters[after])
                if (marker != "_" || boundary) return index
            }
            index += 1
        }
        return null
    }

    private data class Autolink(val url: String, val display: String, val end: Int)

    /**
     * A URL nobody wrapped in brackets: `http://`, `https://` or `www.` (read as
     * `https`). Not mid-word. Trailing sentence punctuation and an unopened `)` stay outside.
     */
    private fun autolink(characters: List<String>, index: Int): Autolink? {
        if (index > 0 && isWordCharacter(characters[index - 1])) return null
        val scheme = when {
            matches(characters, index, "https://") || matches(characters, index, "http://") -> ""
            matches(characters, index, "www.") -> "https://"
            else -> return null
        }
        var end = index
        while (end < characters.size && !isWhitespace(characters[end]) && !isOneOf(characters[end], "<>\"'`")) end += 1
        while (end > index) {
            val last = characters[end - 1]
            if (isOneOf(last, ".,;:!?]}'\"")) { end -= 1; continue }
            if (last == ")") {
                val text = characters.subList(index, end)
                if (text.count { it == "(" } < text.count { it == ")" }) { end -= 1; continue }
            }
            break
        }
        val display = characters.subList(index, end)
        val shortest = if (scheme.isEmpty()) 8 else 4
        if (display.size <= shortest) return null
        val shown = display.joinToString("")
        val url = safeURL(scheme + shown) ?: return null
        return Autolink(url, shown, end)
    }

    private fun matches(characters: List<String>, index: Int, prefix: String): Boolean {
        if (index + prefix.length > characters.size) return false
        return prefix.indices.all { characters[index + it].lowercase() == prefix[it].toString() }
    }

    /**
     * Only `https`, `http` and `mailto` targets link, at most 2048 characters
     * without whitespace, and parseable as a URI. Anything else stays plain
     * text on every client.
     */
    fun safeURL(target: String): String? {
        val characters = graphemes(target)
        if (characters.isEmpty() || characters.size > 2048) return null
        if (characters.any(::isWhitespace)) return null
        val lowered = target.lowercase()
        if (!lowered.startsWith("https://") && !lowered.startsWith("http://") && !lowered.startsWith("mailto:")) return null
        // Swift's `URL(string:)` gate: a target that does not parse as a URI never links.
        if (runCatching { java.net.URI(target) }.isFailure) return null
        return target
    }

    private fun isOneOf(g: String, set: String) = g.length == 1 && g[0] in set

    /** Swift's `.whitespaces`: spaces and tabs, not newlines. */
    private fun trimSpaces(s: String): String =
        s.trim { it == ' ' || it == '\t' || Character.getType(it) == Character.SPACE_SEPARATOR.toInt() }

    private fun isWhitespace(g: String): Boolean {
        val cp = g.codePointAt(0)
        return Character.isWhitespace(cp) || Character.isSpaceChar(cp) || cp == 0x85
    }

    private fun isNumber(g: String): Boolean = when (Character.getType(g.codePointAt(0))) {
        Character.DECIMAL_DIGIT_NUMBER.toInt(), Character.LETTER_NUMBER.toInt(), Character.OTHER_NUMBER.toInt() -> true
        else -> false
    }

    private fun isWordCharacter(g: String): Boolean {
        val cp = g.codePointAt(0)
        return Character.isLetter(cp) || Character.isAlphabetic(cp) || isNumber(g)
    }
}
