package work.starlings.android

import work.starlings.contracts.TranscriptViewResponse
import java.text.Normalizer
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * A meeting transcript as a file, and the link a share carries:
 * `Sources/TranscriptExport.swift` and `packages/contracts/src/transcript-export.ts`,
 * held to `fixtures/transcript-export.json` by `TranscriptExportFixtureTest`.
 * Struck lines are left out and a renamed speaker takes the new name. The
 * labels in the file ("Date", "Attendees") are fixed English: a document.
 */
object TranscriptExport {
    enum class Format(val extension: String) { MARKDOWN("md"), TEXT("txt") }

    data class Line(val id: String, val speakerId: String, val speakerName: String, val startsAtMs: Long, val text: String)

    data class Input(
        val title: String,
        /** Epoch milliseconds. */
        val startedAt: Long,
        /** IANA zone the date is written in. Null or unknown: UTC. */
        val timeZone: String?,
        val subject: String? = null,
        /** Empty: the people who spoke, in the order they first spoke. */
        val attendees: List<String> = emptyList(),
        val link: String? = null,
        val lines: List<Line>,
        val struck: Set<String> = emptySet(),
        /** By speaker id. */
        val renames: Map<String, String> = emptyMap(),
    )

    private const val UNNAMED_SPEAKER = "Speaker"

    fun permalinkPath(room: String, meetingId: String): String = "/meetings/${encodeComponent(room)}/${encodeComponent(meetingId)}"

    /** Always the workspace's public origin. The link grants nothing. */
    fun permalink(origin: String, room: String, meetingId: String): String = origin.trim('/') + permalinkPath(room, meetingId)

    /** `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )`. */
    private fun encodeComponent(value: String): String {
        val out = StringBuilder()
        for (b in value.toByteArray(Charsets.UTF_8)) {
            val ch = (b.toInt() and 0xFF).toChar()
            if (ch in 'a'..'z' || ch in 'A'..'Z' || ch in '0'..'9' || ch in "-_.!~*'()") out.append(ch)
            else out.append('%').append("%02X".format(b.toInt() and 0xFF))
        }
        return out.toString()
    }

    /** `hh:mm:ss`, the Docs transcript's own spelling. */
    fun clock(ms: Long): String {
        val total = maxOf(0L, ms / 1000)
        return listOf(total / 3600, (total % 3600) / 60, total % 60).joinToString(":") { it.toString().padStart(2, '0') }
    }

    /** JavaScript's `\s`, exactly. */
    private fun isSpace(cp: Int): Boolean = when (cp) {
        in 0x09..0x0D, 0x20, 0xA0, 0x1680, in 0x2000..0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true
        else -> false
    }

    /** Whitespace runs, newlines included, are one space; the ends are trimmed. */
    private fun oneLine(value: String): String {
        val out = StringBuilder()
        var pending = false
        var i = 0
        while (i < value.length) {
            val cp = value.codePointAt(i)
            i += Character.charCount(cp)
            if (isSpace(cp)) { pending = out.isNotEmpty(); continue }
            if (pending) out.append(' ')
            pending = false
            out.appendCodePoint(cp)
        }
        return out.toString()
    }

    fun lines(input: Input): List<Line> = input.lines.mapNotNull { line ->
        if (line.id in input.struck) return@mapNotNull null
        val text = oneLine(line.text)
        if (text.isEmpty()) return@mapNotNull null
        val renamed = oneLine(input.renames[line.speakerId].orEmpty())
        val original = oneLine(line.speakerName)
        val speaker = renamed.ifEmpty { original.ifEmpty { UNNAMED_SPEAKER } }
        line.copy(speakerName = speaker, text = text)
    }

    fun attendees(input: Input): List<String> {
        val given = input.attendees.map(::oneLine).filter { it.isNotEmpty() }
        return (given.ifEmpty { lines(input).map { it.speakerName } }).distinct()
    }

    private fun zone(id: String?): ZoneId = id?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: ZoneOffset.UTC

    private fun zoneName(id: String?): String = if (id != null && runCatching { ZoneId.of(id) }.isSuccess) id else "UTC"

    private fun wallClock(startedAt: Long, zone: ZoneId): Pair<String, String> {
        val t = Instant.ofEpochMilli(startedAt).atZone(zone)
        fun two(v: Int) = v.toString().padStart(2, '0')
        return "${t.year}-${two(t.monthValue)}-${two(t.dayOfMonth)}" to "${two(t.hour)}:${two(t.minute)}"
    }

    /** `2026-09-30 09:00 (UTC)`: a 24-hour clock, the zone named. */
    fun date(startedAt: Long, timeZone: String?): String {
        val (day, time) = wallClock(startedAt, zone(timeZone))
        return "$day $time (${zoneName(timeZone)})"
    }

    private fun facts(input: Input): List<Pair<String, String>> = buildList {
        add("Date" to date(input.startedAt, input.timeZone))
        attendees(input).takeIf { it.isNotEmpty() }?.let { add("Attendees" to it.joinToString(", ")) }
        oneLine(input.subject.orEmpty()).takeIf { it.isNotEmpty() }?.let { add("Subject" to it) }
        oneLine(input.link.orEmpty()).takeIf { it.isNotEmpty() }?.let { add("Link" to it) }
    }

    fun format(input: Input, format: Format): String {
        val title = oneLine(input.title).ifEmpty { "Meeting" }
        val header = facts(input)
        val kept = lines(input)
        return when (format) {
            Format.MARKDOWN -> {
                val body = if (kept.isEmpty()) "No transcript." else kept.joinToString("\n\n") { "**${it.speakerName}** (${clock(it.startsAtMs)}): ${it.text}" }
                "# $title\n\n${header.joinToString("\n") { "- ${it.first}: ${it.second}" }}\n\n## Transcript\n\n$body\n"
            }
            Format.TEXT -> {
                val body = if (kept.isEmpty()) "No transcript." else kept.joinToString("\n") { "[${clock(it.startsAtMs)}] ${it.speakerName}: ${it.text}" }
                "$title\n${header.joinToString("\n") { "${it.first}: ${it.second}" }}\n\n$body\n"
            }
        }
    }

    /** `pilot-kickoff-2026-09-30.md`. */
    fun fileName(title: String, startedAt: Long, timeZone: String?, format: Format): String {
        val folded = Normalizer.normalize(title, Normalizer.Form.NFKD).filterNot { it.code in 0x300..0x36F }.lowercase()
        val slug = StringBuilder()
        var pendingDash = false
        for (ch in folded) {
            if (ch in 'a'..'z' || ch in '0'..'9') {
                if (pendingDash && slug.isNotEmpty()) slug.append('-')
                pendingDash = false
                slug.append(ch)
            } else {
                pendingDash = true
            }
        }
        val cut = slug.toString().take(60).trimEnd('-').ifEmpty { "transcript" }
        return "$cut-${wallClock(startedAt, zone(timeZone)).first}.${format.extension}"
    }

    /**
     * The record a client fetched (`GET /api/rooms/:slug/meetings/:id/transcript`),
     * ready to format, with the link on [origin]. The record already has struck
     * lines gone and renames applied.
     */
    fun input(view: TranscriptViewResponse, untitled: String, origin: String, timeZone: String? = ZoneId.systemDefault().id): Input {
        val a = view.artifact
        return Input(
            title = a.title ?: untitled,
            startedAt = a.startedAt,
            timeZone = timeZone,
            subject = view.category.subjectTitle,
            attendees = view.attendees.orEmpty(),
            link = permalink(origin, a.roomSlug, a.meetingId),
            lines = a.transcript.map { Line(it.id, it.speakerId, it.speakerName, it.startsAtMs, it.text) },
        )
    }
}
