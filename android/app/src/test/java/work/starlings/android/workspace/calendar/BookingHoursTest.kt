package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.BookingDayHours
import work.starlings.contracts.BookingSettingsResponse
import java.time.ZoneId
import java.util.Locale

/** `Sources/BookingHours.swift`: the defaults, limits and words of Booking hours. */
class BookingHoursTest {
    private fun response(timezone: String? = null) = BookingSettingsResponse(
        active = true, durationMinutes = 30, bufferMinutes = 10, minNoticeHours = 4, maxBookingDays = 60, slotStepMinutes = 15,
        timezone = timezone, weeklyHours = null, room = "rosa",
    )

    @Test
    fun aMemberWithNoHoursStartsOnTheWebsWeekInThisZone() {
        val draft = BookingHours.draft(response(), ZoneId.of("America/Sao_Paulo"))
        assertEquals("America/Sao_Paulo", draft.timezone)
        assertEquals(BookingHours.defaultWeek, draft.weeklyHours)
        assertEquals(BookingDayHours(true, 540, 1020), draft.weeklyHours.mon)
        assertFalse(draft.weeklyHours.sat.enabled)
        assertFalse(draft.weeklyHours.sun.enabled)
        assertEquals("Europe/Lisbon", BookingHours.draft(response("Europe/Lisbon"), ZoneId.of("UTC")).timezone)
    }

    @Test
    fun numberFieldsAreTheWebsFiveInItsOrderAndClamp() {
        val ranges = BookingHours.numberFields.map { it.range }
        assertEquals(listOf(15..240, 5..240, 0..120, 0..168, 1..365), ranges)
        val length = BookingHours.numberFields.first()
        assertEquals(15L, length.clamped(1))
        assertEquals(240L, length.clamped(999))
        val draft = BookingHours.draft(response(), ZoneId.of("UTC"))
        assertEquals(30L, length.get(draft))
        assertEquals(45L, length.get(length.set(draft, 45)))
    }

    @Test
    fun theClockIsQuarterHoursOnTwentyFourHours() {
        assertEquals(96, BookingHours.clockMinutes.size)
        assertEquals("00:00", BookingHours.clock(BookingHours.clockMinutes.first()))
        assertEquals("23:45", BookingHours.clock(BookingHours.clockMinutes.last()))
        assertEquals("09:30", BookingHours.clock(570))
    }

    @Test
    fun theWeekStartsOnMondayAndEditsOneDay() {
        assertEquals("Mon", BookingHours.Weekday.MON.label(Locale.ENGLISH))
        assertEquals(BookingHours.Weekday.SUN, BookingHours.Weekday.entries.last())
        val tuesday = BookingDayHours(false, 600, 660)
        val next = BookingHours.replacing(BookingHours.defaultWeek, BookingHours.Weekday.TUE, tuesday)
        assertEquals(tuesday, BookingHours.hours(next, BookingHours.Weekday.TUE))
        assertEquals(BookingHours.defaultWeek.mon, next.mon)
    }

    @Test
    fun anUnknownZoneIsOfferedFirst() {
        val known = listOf("Europe/Lisbon", "America/Sao_Paulo")
        assertEquals(listOf("America/Sao_Paulo", "Europe/Lisbon"), BookingHours.timeZoneOptions("Europe/Lisbon", known))
        assertEquals("Mars/Olympus", BookingHours.timeZoneOptions("Mars/Olympus", known).first())
        assertTrue(BookingHours.timeZoneOptions(null).contains("Europe/Lisbon"))
    }

    @Test
    fun theNoteNamesTheBookingPageWhenThereIsOne() {
        assertEquals("/book/rosa", BookingHours.bookingPath("rosa"))
        assertNull(BookingHours.bookingPath(null))
    }
}
