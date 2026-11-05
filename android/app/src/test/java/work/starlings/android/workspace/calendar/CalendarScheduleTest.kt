package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate

/** Schedule a meeting's rules, case by case from `StarlingsScheduleTimeZone` and `MobileAgendaStrip`. */
class CalendarScheduleTest {
    private val july = Instant.parse("2026-07-01T12:00:00Z")

    @Test
    fun zonePreference() {
        assertEquals("lisbon", CalendarSchedule.preferred("lisbon", "Asia/Tokyo").id)
        assertEquals("tokyo", CalendarSchedule.preferred(null, "Asia/Tokyo").id)
        assertEquals("amsterdam", CalendarSchedule.preferred("nowhere", "Europe/Berlin").id)
        assertEquals("newYork", CalendarSchedule.preferred(null, "America/Toronto").id)
        // Same offset as a preset, else Amsterdam.
        assertEquals("amsterdam", CalendarSchedule.preferred(null, "Europe/Rome", july).id)
        assertEquals("amsterdam", CalendarSchedule.preferred(null, "Not/AZone", july).id)
    }

    @Test
    fun workspaceShortlist() {
        // No shortlist, or one with no known preset: every preset.
        assertEquals(10, CalendarSchedule.offered(null).size)
        assertEquals(10, CalendarSchedule.offered(listOf("mars")).size)
        // The presets' own order, not the list's.
        assertEquals(listOf("saoPaulo", "london"), CalendarSchedule.offered(listOf("london", "saoPaulo")).map { it.id })

        val offered = CalendarSchedule.offered(listOf("saoPaulo", "london"))
        assertEquals("london", CalendarSchedule.preferred("london", "Asia/Tokyo", offered = offered).id)
        // A stored zone or the phone's zone outside the shortlist does not count; no Amsterdam, so the first.
        assertEquals("saoPaulo", CalendarSchedule.preferred("tokyo", "Asia/Tokyo", offered = offered).id)
        assertEquals("london", CalendarSchedule.preferred(null, "Europe/Dublin", offered = offered).id)
        val withAmsterdam = CalendarSchedule.offered(listOf("tokyo", "amsterdam"))
        assertEquals("amsterdam", CalendarSchedule.preferred(null, "America/New_York", offered = withAmsterdam).id)
    }

    @Test
    fun nextQuarterHourIsNeverNow() {
        val at = Instant.parse("2026-10-28T09:15:00Z").toEpochMilli()
        assertEquals(Instant.parse("2026-10-28T09:30:00Z").toEpochMilli(), CalendarSchedule.nextQuarterHour(at))
        assertEquals(Instant.parse("2026-10-28T09:30:00Z").toEpochMilli(), CalendarSchedule.nextQuarterHour(at + 60_000))
    }

    @Test
    fun stripDays() {
        val today = LocalDate.of(2026, 10, 28)
        val weekdays = CalendarSchedule.stripDays(today, showWeekends = false)
        assertEquals(30, weekdays.size)
        assertTrue(weekdays.none { it.dayOfWeek == DayOfWeek.SATURDAY || it.dayOfWeek == DayOfWeek.SUNDAY })
        assertEquals(42, CalendarSchedule.stripDays(today, showWeekends = true).size)
    }

    @Test
    fun guests() {
        assertEquals(listOf("ana@x.com"), CalendarSchedule.addGuest(emptyList(), " Ana@X.com "))
        assertEquals(listOf("ana@x.com"), CalendarSchedule.addGuest(listOf("ana@x.com"), "ana@x.com"))
        assertEquals(emptyList<String>(), CalendarSchedule.addGuest(emptyList(), "Ana"))
    }
}
