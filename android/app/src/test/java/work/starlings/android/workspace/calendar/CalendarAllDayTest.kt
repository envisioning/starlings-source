package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/** `CalendarWeekMath.packAllDay` and the long-press `movePreview`, case by case from the Swift. */
class CalendarAllDayTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val days = (0..2L).map { LocalDate.of(2026, 10, 27).plusDays(it) }
    private fun midnight(day: Int) = LocalDate.of(2026, 10, day).atStartOfDay(zone).toInstant().toEpochMilli()
    private fun at(value: String) = LocalDateTime.parse(value).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun inclusiveEnd() {
        assertEquals(LocalDate.of(2026, 10, 28), CalendarAllDay.inclusiveEnd(midnight(27), midnight(29), zone))
        assertEquals(LocalDate.of(2026, 10, 27), CalendarAllDay.inclusiveEnd(midnight(27), midnight(27) + 60_000, zone))
        assertEquals(LocalDate.of(2026, 10, 27), CalendarAllDay.inclusiveEnd(midnight(27), midnight(27), zone))
    }

    @Test
    fun aSpanOverSeveralDaysIsOneBar() {
        val layout = CalendarAllDay.pack(
            listOf(
                CalendarAllDay.Span("offsite", midnight(26), midnight(29)),
                CalendarAllDay.Span("holiday", midnight(28), midnight(29)),
                CalendarAllDay.Span("launch", midnight(29), midnight(30)),
                CalendarAllDay.Span("gone", midnight(1), midnight(2)),
            ),
            days, zone,
        )
        assertEquals(
            listOf(
                CalendarAllDay.Layout("offsite", 0, 1, 0),
                CalendarAllDay.Layout("holiday", 1, 1, 1),
                CalendarAllDay.Layout("launch", 2, 2, 0),
            ),
            layout,
        )
        assertNull(CalendarAllDay.dayRange(midnight(30), midnight(31), days, zone))
    }

    @Test
    fun moveSnapsAndStaysOnScreen() {
        val start = at("2026-10-27T09:00")
        val end = at("2026-10-27T10:00")
        val down = CalendarAllDay.move(start, end, false, days, 0, 1.4f, 37f, zone, 15)
        assertEquals(at("2026-10-28T09:30"), down.start)
        assertEquals(at("2026-10-28T10:30"), down.end)
        assertEquals(1, down.dayDelta)
        assertEquals(0, CalendarAllDay.move(start, end, false, days, 0, -3f, 0f, zone, 15).dayDelta)
        // Never past the day's end: the length still fits.
        assertEquals(at("2026-10-27T23:00"), CalendarAllDay.move(start, end, false, days, 0, 0f, 20 * 60f, zone, 15).start)
        assertEquals(midnight(29), CalendarAllDay.move(midnight(27), midnight(28), true, days, 0, 2.2f, 0f, zone, 15).start)
    }
}
