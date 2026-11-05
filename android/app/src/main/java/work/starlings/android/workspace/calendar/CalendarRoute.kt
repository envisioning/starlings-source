package work.starlings.android.workspace.calendar

import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.LocalDate

/**
 * Where a route into the Calendar tab points, from the web paths the web
 * app reads (`web/src/CalendarPage.tsx`, `work-hrefs.ts` `eventHref`):
 * `/calendar`, `/calendar?day=YYYY-MM-DD`, and an event's permalink
 * `/calendar/event/<id>?day=YYYY-MM-DD`. The id is what the
 * Worker spells (`<calendarId>:<eventId>`, or a feed row's own id); the
 * match is on the raw id after the last colon, as `reveal(eventReference:)`
 * in `iOS/MobileCalendarStore.swift` and the web page do it.
 */
data class CalendarRoute(val eventId: String?, val day: LocalDate?) {
    /** The raw event id the match runs on. */
    val rawEventId: String? get() = eventId?.let { it.substring(it.lastIndexOf(':') + 1) }?.ifEmpty { null }

    companion object {
        /** Null when [route] is not a Calendar path. */
        fun parse(route: String): CalendarRoute? {
            val path = route.substringBefore('#').substringBefore('?')
            val query = route.substringBefore('#').substringAfter('?', "")
            val day = query.split('&')
                .map { it.split('=', limit = 2) }
                .firstOrNull { it.size == 2 && it[0] == "day" }
                ?.let { runCatching { LocalDate.parse(decode(it[1])) }.getOrNull() }
            val segments = path.trim('/').split('/').filter { it.isNotEmpty() }
            return when {
                segments == listOf("calendar") -> CalendarRoute(null, day)
                segments.size == 3 && segments[0] == "calendar" && segments[1] == "event" -> {
                    val id = decode(segments[2])?.takeIf { it.isNotEmpty() && it.length <= MAX_ID_LENGTH && it.none { ch -> ch.isISOControl() } }
                        ?: return null
                    CalendarRoute(id, day)
                }
                else -> null
            }
        }

        /** `encodeURIComponent` writes `+` as `%2B`, so a bare `+` stays a plus. */
        private fun decode(raw: String): String? =
            runCatching { URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8) }.getOrNull()

        /** `MAX_ID_LENGTH` in `packages/contracts/src/permalinks.ts`. */
        private const val MAX_ID_LENGTH = 512
    }
}
