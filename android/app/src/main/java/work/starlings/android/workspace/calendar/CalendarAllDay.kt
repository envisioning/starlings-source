package work.starlings.android.workspace.calendar

import work.starlings.android.CalendarDates
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.math.roundToInt

/**
 * The all-day band and the long-press move (`CalendarWeekMath.packAllDay`,
 * `allDayDayRange`, `allDayInclusiveEnd` in `Sources/CalendarModels.swift`,
 * `movePreview` in `iOS/MobileCalendarTimeGrid.swift`). A span covering
 * several days on screen is one bar; overlapping bars take separate rows.
 */
object CalendarAllDay {
    data class Span(val id: String, val start: Long, val end: Long)

    data class Layout(val id: String, val startIndex: Int, val endIndex: Int, val row: Int)

    /** The last day an all-day span covers: an end at midnight, or at the start's own clock, is exclusive. */
    fun inclusiveEnd(start: Long, end: Long, zone: ZoneId): LocalDate {
        val startAt = Instant.ofEpochMilli(start).atZone(zone)
        val endAt = Instant.ofEpochMilli(end).atZone(zone)
        val startDay = startAt.toLocalDate()
        val endDay = endAt.toLocalDate()
        val midnight = endAt.toLocalTime().toSecondOfDay() == 0
        val sameClock = startAt.toLocalTime().toSecondOfDay() == endAt.toLocalTime().toSecondOfDay()
        if ((midnight || sameClock) && endDay.isAfter(startDay)) return endDay.minusDays(1)
        return if (endDay.isAfter(startDay)) endDay else startDay
    }

    /** The indexes of [days] the span covers, or null when it misses them all. */
    fun dayRange(start: Long, end: Long, days: List<LocalDate>, zone: ZoneId): IntRange? {
        if (days.isEmpty()) return null
        val first = CalendarDates.day(start, zone)
        val last = inclusiveEnd(start, end, zone)
        val covered = days.indices.filter { !days[it].isBefore(first) && !days[it].isAfter(last) }
        return if (covered.isEmpty()) null else covered.first()..covered.last()
    }

    /** One bar per span, earliest first and longest first on a tie, each in the first row free from its start. */
    fun pack(spans: List<Span>, days: List<LocalDate>, zone: ZoneId): List<Layout> {
        val ranked = spans.mapNotNull { span -> dayRange(span.start, span.end, days, zone)?.let { Triple(span.id, it.first, it.last) } }
            .sortedWith(compareBy<Triple<String, Int, Int>> { it.second }.thenByDescending { it.third - it.second })
        val rowEnds = mutableListOf<Int>()
        return ranked.map { (id, first, last) ->
            var row = 0
            while (row < rowEnds.size && rowEnds[row] >= first) row++
            if (row == rowEnds.size) rowEnds += last else rowEnds[row] = last
            Layout(id, first, last, row)
        }
    }

    data class Move(val start: Long, val end: Long, val dayDelta: Int)

    /**
     * Where a long-press drag puts an event: whole columns sideways, snapped
     * minutes down the grid, the length kept, and never off the days shown or
     * past the day's end. An all-day event moves by days only.
     */
    fun move(
        start: Long,
        end: Long,
        allDay: Boolean,
        days: List<LocalDate>,
        originIndex: Int,
        columns: Float,
        minutes: Float,
        zone: ZoneId,
        snapMinutes: Int,
    ): Move {
        val delta = columns.roundToInt().coerceIn(-originIndex, days.size - 1 - originIndex)
        val destination = days[(originIndex + delta).coerceIn(0, days.size - 1)]
        val destinationStart = CalendarDates.startOfDay(destination, zone)
        val duration = maxOf(60_000L, end - start)
        val moved = if (allDay) {
            destinationStart
        } else {
            val intoDay = start - CalendarDates.startOfDay(CalendarDates.day(start, zone), zone)
            val raw = destinationStart + intoDay + (minutes * 60_000f).toLong()
            val step = snapMinutes * 60_000L
            val snapped = destinationStart + Math.floorDiv(raw - destinationStart, step) * step
            val latest = destinationStart + maxOf(0L, 86_400_000L - duration)
            snapped.coerceIn(destinationStart, latest)
        }
        return Move(moved, moved + duration, delta)
    }
}
