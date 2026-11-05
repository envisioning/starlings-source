package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.CalendarLayout
import java.time.LocalDate
import java.time.ZoneId

/** `CalendarWindowPreferences`, case by case, and the opening layout `MobileCalendarStore.init` picks. */
class CalendarDisplayTest {
    @Test
    fun untouchedIsTheIosDefaults() {
        val d = CalendarDisplay.read(emptyMap())
        assertEquals(8, d.dayStartHour)
        assertEquals(20, d.dayEndHour)
        assertEquals(60, d.durationMinutes)
        assertEquals(15, d.snapMinutes)
        assertEquals(48f, d.hourHeight)
        assertTrue(d.showsDeclined)
        assertFalse(d.showsHidden)
        assertNull(d.secondaryZone)
    }

    @Test
    fun storedValuesAreClampedAndChecked() {
        val d = CalendarDisplay.read(
            mapOf(
                CalendarDisplay.KEY_START to 30,
                CalendarDisplay.KEY_END to 3,
                CalendarDisplay.KEY_DURATION to 50,
                CalendarDisplay.KEY_SNAP to 10,
                CalendarDisplay.KEY_HOUR_HEIGHT to 500f,
                CalendarDisplay.KEY_DECLINED to false,
                CalendarDisplay.KEY_SECONDARY to "nowhere",
            ),
        )
        assertEquals(23, d.dayStartHour)
        // The end stays an hour after the start.
        assertEquals(24, d.dayEndHour)
        assertEquals(60, d.durationMinutes)
        assertEquals(10, d.snapMinutes)
        assertEquals(160f, d.hourHeight)
        assertFalse(d.showsDeclined)
        assertNull(d.secondaryZoneId)
    }

    @Test
    fun aStartThatReachesTheEndPushesIt() {
        val d = CalendarDisplay().withStartHour(20)
        assertEquals(20, d.dayStartHour)
        assertEquals(21, d.dayEndHour)
        assertEquals(23, CalendarDisplay().withStartHour(23).dayEndHour)
        assertEquals(9, CalendarDisplay().withEndHour(9).dayEndHour)
    }

    @Test
    fun entriesRoundTrip() {
        val d = CalendarDisplay(dayStartHour = 7, dayEndHour = 19, snapMinutes = 5, hourHeight = 64f, showsHidden = true, secondaryZoneId = "tokyo")
        assertEquals(d, CalendarDisplay.read(d.entries()))
        assertEquals("Tokyo", d.secondaryZone?.city)
    }

    @Test
    fun pinchStaysInTheRange() {
        assertEquals(96f, CalendarDisplay.zoomed(48f, 2f))
        assertEquals(24f, CalendarDisplay.zoomed(48f, 0.1f))
        assertEquals(160f, CalendarDisplay.zoomed(120f, 3f))
    }

    @Test
    fun openingLayout() {
        assertEquals(CalendarLayout.DAY, CalendarDisplay.openingLayout(emptyMap()))
        // Nothing stored: 3 Days on a tablet, as the iPad; a stored Day stays Day there.
        assertEquals(CalendarLayout.THREE_DAY, CalendarDisplay.openingLayout(emptyMap(), tablet = true))
        assertEquals(CalendarLayout.DAY, CalendarDisplay.openingLayout(mapOf(CalendarDisplay.KEY_DEFAULT_VIEW to "day"), tablet = true))
        assertEquals(CalendarLayout.THREE_DAY, CalendarDisplay.openingLayout(mapOf(CalendarDisplay.KEY_DEFAULT_VIEW to "week")))
        assertEquals(CalendarLayout.MONTH, CalendarDisplay.openingLayout(mapOf(CalendarDisplay.KEY_DEFAULT_VIEW to "month")))
        // The exact layout wins over the shared day/week/month.
        assertEquals(
            CalendarLayout.AGENDA,
            CalendarDisplay.openingLayout(mapOf(CalendarDisplay.KEY_DEFAULT_VIEW to "week", CalendarDisplay.KEY_MOBILE_DEFAULT_VIEW to "agenda")),
        )
        assertEquals("week", CalendarDisplay.sharedView(CalendarLayout.TWO_DAY))
        assertEquals("day", CalendarDisplay.sharedView(CalendarLayout.DAY))
    }

    @Test
    fun secondaryHourFollowsTheFirstDay() {
        val amsterdam = ZoneId.of("Europe/Amsterdam")
        val newYork = ZoneId.of("America/New_York")
        // Summer: six hours apart.
        assertEquals(3, CalendarDisplay.secondaryHour(9, LocalDate.of(2026, 7, 1), amsterdam, newYork))
        // 1 November 2026: New York is back on standard time, Amsterdam already was.
        assertEquals(4, CalendarDisplay.secondaryHour(10, LocalDate.of(2026, 11, 2), amsterdam, newYork))
    }
}
