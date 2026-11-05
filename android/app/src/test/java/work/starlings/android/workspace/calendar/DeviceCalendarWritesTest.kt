package work.starlings.android.workspace.calendar

import android.provider.CalendarContract
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * What the phone's own calendars are handed, as `EventKitCalendarStore`
 * sets an `EKEvent`: times and zones, all-day dates, a series edited from
 * one occurrence, and the location rule.
 */
class DeviceCalendarWritesTest {
    private val saoPaulo = ZoneId.of("America/Sao_Paulo")
    private val lisbon = ZoneId.of("Europe/Lisbon")

    private fun at(zone: ZoneId, y: Int, m: Int, d: Int, h: Int = 0, min: Int = 0): Long =
        LocalDateTime.of(y, m, d, h, min).atZone(zone).toInstant().toEpochMilli()

    private fun utc(y: Int, m: Int, d: Int): Long = LocalDate.of(y, m, d).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()

    private fun values(start: Long, end: Long, allDay: Boolean = false, location: String? = "", notes: String? = "") =
        DeviceCalendarWrites.Values("Dentist", start, end, allDay, location, notes)

    @Test
    fun theColumnNamesAreCalendarContracts() {
        assertEquals(CalendarContract.Events.CALENDAR_ID, DeviceCalendarWrites.CALENDAR_ID)
        assertEquals(CalendarContract.Attendees.EVENT_ID, DeviceCalendarWrites.EVENT_ID)
        assertEquals(CalendarContract.Events.TITLE, DeviceCalendarWrites.TITLE)
        assertEquals(CalendarContract.Events.DTSTART, DeviceCalendarWrites.DTSTART)
        assertEquals(CalendarContract.Events.DTEND, DeviceCalendarWrites.DTEND)
        assertEquals(CalendarContract.Events.DURATION, DeviceCalendarWrites.DURATION)
        assertEquals(CalendarContract.Events.EVENT_TIMEZONE, DeviceCalendarWrites.EVENT_TIMEZONE)
        assertEquals(CalendarContract.Events.EVENT_END_TIMEZONE, DeviceCalendarWrites.EVENT_END_TIMEZONE)
        assertEquals(CalendarContract.Events.ALL_DAY, DeviceCalendarWrites.ALL_DAY)
        assertEquals(CalendarContract.Events.RRULE, DeviceCalendarWrites.RRULE)
        assertEquals(CalendarContract.Events.RDATE, DeviceCalendarWrites.RDATE)
        assertEquals(CalendarContract.Events.EXRULE, DeviceCalendarWrites.EXRULE)
        assertEquals(CalendarContract.Events.EXDATE, DeviceCalendarWrites.EXDATE)
        assertEquals(CalendarContract.Events.EVENT_LOCATION, DeviceCalendarWrites.EVENT_LOCATION)
        assertEquals(CalendarContract.Events.DESCRIPTION, DeviceCalendarWrites.DESCRIPTION)
        assertEquals(CalendarContract.Events.AVAILABILITY, DeviceCalendarWrites.AVAILABILITY)
        assertEquals(CalendarContract.Events.ACCESS_LEVEL, DeviceCalendarWrites.ACCESS_LEVEL)
        assertEquals(CalendarContract.Events.HAS_ALARM, DeviceCalendarWrites.HAS_ALARM)
        assertEquals(CalendarContract.Events.ORIGINAL_INSTANCE_TIME, DeviceCalendarWrites.ORIGINAL_INSTANCE_TIME)
        assertEquals(CalendarContract.Events.STATUS, DeviceCalendarWrites.STATUS)
        assertEquals(CalendarContract.Events.STATUS_CANCELED, DeviceCalendarWrites.STATUS_CANCELED)
        assertEquals(
            listOf(
                CalendarContract.Attendees.ATTENDEE_NAME, CalendarContract.Attendees.ATTENDEE_EMAIL,
                CalendarContract.Attendees.ATTENDEE_RELATIONSHIP, CalendarContract.Attendees.ATTENDEE_TYPE,
                CalendarContract.Attendees.ATTENDEE_STATUS,
            ),
            DeviceCalendarWrites.ATTENDEE_COLUMNS,
        )
        assertEquals(listOf(CalendarContract.Reminders.MINUTES, CalendarContract.Reminders.METHOD), DeviceCalendarWrites.REMINDER_COLUMNS)
    }

    @Test
    fun aTimedEventKeepsItsInstantsAndThePhonesZone() {
        val start = at(saoPaulo, 2026, 3, 12, 9, 30)
        val row = DeviceCalendarWrites.eventRow(values(start, start + 45 * 60_000L, location = "Clinic", notes = "Bring the card"), saoPaulo)
        assertEquals(start, row[DeviceCalendarWrites.DTSTART])
        assertEquals(start + 45 * 60_000L, row[DeviceCalendarWrites.DTEND])
        assertEquals("America/Sao_Paulo", row[DeviceCalendarWrites.EVENT_TIMEZONE])
        assertEquals(0, row[DeviceCalendarWrites.ALL_DAY])
        assertEquals("Dentist", row[DeviceCalendarWrites.TITLE])
        assertEquals("Clinic", row[DeviceCalendarWrites.EVENT_LOCATION])
        assertEquals("Bring the card", row[DeviceCalendarWrites.DESCRIPTION])
        assertFalse(row.containsKey(DeviceCalendarWrites.DURATION))
    }

    @Test
    fun anAllDayEventIsUtcMidnightsOfThePhonesDates() {
        // The editor hands local midnights, the end the exclusive next one.
        val start = at(saoPaulo, 2026, 3, 12)
        val end = at(saoPaulo, 2026, 3, 14)
        val row = DeviceCalendarWrites.eventRow(values(start, end, allDay = true), saoPaulo)
        assertEquals(utc(2026, 3, 12), row[DeviceCalendarWrites.DTSTART])
        assertEquals(utc(2026, 3, 14), row[DeviceCalendarWrites.DTEND])
        assertEquals("UTC", row[DeviceCalendarWrites.EVENT_TIMEZONE])
        assertEquals(1, row[DeviceCalendarWrites.ALL_DAY])
        // A zero-length all-day event still covers its date.
        val one = DeviceCalendarWrites.times(values(start, start, allDay = true), saoPaulo)
        assertEquals(utc(2026, 3, 13), one.end)
    }

    @Test
    fun anAllDayEventWrittenThenReadIsTheSameDates() {
        val start = at(lisbon, 2026, 10, 25)
        val end = at(lisbon, 2026, 10, 26)
        val times = DeviceCalendarWrites.times(values(start, end, allDay = true), lisbon)
        assertEquals(start to end, DeviceCalendarRules.allDaySpan(times.start, times.end, lisbon))
    }

    @Test
    fun anOccurrenceIsFoundAtTheTimeTheProviderStored() {
        val timed = at(lisbon, 2026, 3, 12, 10)
        assertEquals(timed, DeviceCalendarWrites.instanceTime(timed, allDay = false, zone = lisbon))
        // The read moved the all-day UTC midnight to the phone's; the write moves it back.
        assertEquals(utc(2026, 3, 12), DeviceCalendarWrites.instanceTime(at(saoPaulo, 2026, 3, 12), allDay = true, zone = saoPaulo))
        val exception = DeviceCalendarWrites.exceptionRow(values(timed + 3_600_000L, timed + 7_200_000L), timed, lisbon)
        assertEquals(timed, exception[DeviceCalendarWrites.ORIGINAL_INSTANCE_TIME])
        assertEquals(timed + 3_600_000L, exception[DeviceCalendarWrites.DTSTART])
        val cancelled = DeviceCalendarWrites.cancelledRow(timed)
        assertEquals(setOf(DeviceCalendarWrites.ORIGINAL_INSTANCE_TIME, DeviceCalendarWrites.STATUS), cancelled.keys)
        assertEquals(timed, cancelled[DeviceCalendarWrites.ORIGINAL_INSTANCE_TIME])
        assertEquals(DeviceCalendarWrites.STATUS_CANCELED, cancelled[DeviceCalendarWrites.STATUS])
    }

    @Test
    fun aSeriesMovesItsFirstStartByTheDaysTheOccurrenceMoved() {
        // Weekly from Monday 2 March at 10:00; the 16 March one moves to Tuesday 17 at 14:00 for 30 minutes.
        val seriesStart = at(lisbon, 2026, 3, 2, 10)
        val occurrence = at(lisbon, 2026, 3, 16, 10)
        val moved = at(lisbon, 2026, 3, 17, 14)
        val row = DeviceCalendarWrites.seriesRow(values(moved, moved + 30 * 60_000L), seriesStart, false, occurrence, false, lisbon)
        assertEquals(at(lisbon, 2026, 3, 3, 14), row[DeviceCalendarWrites.DTSTART])
        assertEquals("P1800S", row[DeviceCalendarWrites.DURATION])
        assertTrue(row.containsKey(DeviceCalendarWrites.DTEND))
        assertNull(row[DeviceCalendarWrites.DTEND])
        assertEquals("Europe/Lisbon", row[DeviceCalendarWrites.EVENT_TIMEZONE])
        assertFalse(row.containsKey(DeviceCalendarWrites.RRULE))
    }

    @Test
    fun aSeriesKeepsItsWallClockAcrossSummerTime() {
        // Lisbon goes to summer time on 29 March 2026: a title edit after it leaves 10:00 as 10:00.
        val seriesStart = at(lisbon, 2026, 3, 2, 10)
        val occurrence = at(lisbon, 2026, 4, 6, 10)
        val row = DeviceCalendarWrites.seriesRow(values(occurrence, occurrence + 3_600_000L), seriesStart, false, occurrence, false, lisbon)
        assertEquals(seriesStart, row[DeviceCalendarWrites.DTSTART])
        assertEquals("P3600S", row[DeviceCalendarWrites.DURATION])
    }

    @Test
    fun anAllDaySeriesIsWholeDays() {
        val seriesStart = utc(2026, 3, 2)
        val occurrence = utc(2026, 3, 9)
        // The occurrence moves a day later and covers two days.
        val start = at(saoPaulo, 2026, 3, 10)
        val row = DeviceCalendarWrites.seriesRow(values(start, at(saoPaulo, 2026, 3, 12), allDay = true), seriesStart, true, occurrence, true, saoPaulo)
        assertEquals(utc(2026, 3, 3), row[DeviceCalendarWrites.DTSTART])
        assertEquals("P2D", row[DeviceCalendarWrites.DURATION])
        assertEquals("UTC", row[DeviceCalendarWrites.EVENT_TIMEZONE])
        assertEquals(1, row[DeviceCalendarWrites.ALL_DAY])
    }

    @Test
    fun aTypedPlaceWinsAndTheLinkTakesAnEmptySlot() {
        assertEquals("Ground", DeviceCalendarWrites.storedLocation("Ground", "https://starlings.example/room/ana"))
        assertEquals("https://starlings.example/room/ana", DeviceCalendarWrites.storedLocation("  ", "https://starlings.example/room/ana"))
        assertEquals("", DeviceCalendarWrites.storedLocation("", null))
        // Null leaves the stored value alone: no column is written.
        assertNull(DeviceCalendarWrites.storedLocation(null, "https://starlings.example/room/ana"))
        val row = DeviceCalendarWrites.eventRow(values(0, 60_000L, location = null, notes = null), lisbon)
        assertFalse(row.containsKey(DeviceCalendarWrites.EVENT_LOCATION))
        assertFalse(row.containsKey(DeviceCalendarWrites.DESCRIPTION))
    }
}
