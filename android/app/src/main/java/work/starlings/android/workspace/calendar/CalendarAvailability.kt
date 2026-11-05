package work.starlings.android.workspace.calendar

import work.starlings.android.CalendarDates
import work.starlings.contracts.CalendarFreeBusyPerson
import java.time.LocalDate
import java.time.ZoneId

/**
 * Reading a free/busy answer (`iOS/MobileCalendarAvailability.swift`), and
 * Add invitee's completions (`MobileInviteesEditor.matches`). Times are
 * epoch ms; a span is half-open.
 */
object CalendarAvailability {
    data class Span(val start: Long, val end: Long)

    /** `CalendarWindowPreferences` defaults: the working day the bar draws. */
    const val DAY_START_HOUR = 8
    const val DAY_END_HOUR = 20

    private fun readable(person: CalendarFreeBusyPerson) = person.error.isEmpty()

    /** Everyone's busy time as one list, clipped to [window]: the bar says whether a slot is taken, not by whom. */
    fun busy(people: List<CalendarFreeBusyPerson>, window: Span, zone: ZoneId): List<Span> {
        val raw = people.filter(::readable).flatMap { it.busy }.mapNotNull { slot ->
            val start = CalendarDates.parse(slot.start, zone) ?: return@mapNotNull null
            val end = CalendarDates.parse(slot.end, zone) ?: return@mapNotNull null
            if (end <= start || start >= window.end || end <= window.start) null
            else Span(maxOf(start, window.start), minOf(end, window.end))
        }.sortedBy { it.start }
        val merged = mutableListOf<Span>()
        for (span in raw) {
            val last = merged.lastOrNull()
            if (last != null && span.start <= last.end) merged[merged.lastIndex] = Span(last.start, maxOf(last.end, span.end))
            else merged += span
        }
        return merged
    }

    /** Who is busy during [slot]. A meeting ending at 15:00 does not clash with one starting at 15:00. */
    fun conflicts(people: List<CalendarFreeBusyPerson>, slot: Span, zone: ZoneId): List<String> =
        people.filter(::readable).filter { person ->
            person.busy.any { busy ->
                val start = CalendarDates.parse(busy.start, zone)
                val end = CalendarDates.parse(busy.end, zone)
                start != null && end != null && start < slot.end && end > slot.start
            }
        }.map { it.email }

    /** Whose calendar could not be read: never shown as free. */
    fun unreadable(people: List<CalendarFreeBusyPerson>): List<String> = people.filter { !readable(it) }.map { it.email }

    /** The hours worth drawing: a working day, widened to hold the slot, inside the day. */
    fun window(slot: Span, day: LocalDate, zone: ZoneId): Span {
        val dayStart = CalendarDates.startOfDay(day, zone)
        val dayEnd = CalendarDates.startOfDay(day.plusDays(1), zone)
        val open = dayStart + DAY_START_HOUR * 3_600_000L
        val close = dayStart + DAY_END_HOUR * 3_600_000L
        return Span(maxOf(dayStart, minOf(open, slot.start)), minOf(dayEnd, maxOf(close, slot.end)))
    }

    /** A tap at [ratio] across the bar, snapped down to the slot grid (`CalendarWeekMath.snap`). */
    fun pick(window: Span, ratio: Float, snapMinutes: Int): Long {
        val span = maxOf(60_000L, window.end - window.start)
        val at = window.start + (span * ratio.coerceIn(0f, 1f)).toLong()
        val step = snapMinutes * 60_000L
        return (at / step) * step
    }

    data class Suggestion(val email: String, val name: String)

    /** Six completions for what is typed: an address prefix or a word of the name, not already invited, not you. */
    fun matches(suggestions: List<Suggestion>, typed: String, taken: Collection<String>, you: String?): List<Suggestion> {
        val needle = typed.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        val skip = taken.map { it.lowercase() }.toSet() + listOfNotNull(you?.lowercase())
        return suggestions
            .filter { it.email.lowercase() !in skip }
            .filter { it.email.lowercase().startsWith(needle) || it.name.lowercase().split(' ').any { word -> word.startsWith(needle) } }
            .take(6)
    }
}
