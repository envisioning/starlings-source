package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

/** The web paths Calendar reads (`eventHref`, `/calendar?day=`), as the web page parses them. */
class CalendarRouteTest {
    @Test
    fun plainCalendar() {
        assertEquals(CalendarRoute(null, null), CalendarRoute.parse("/calendar"))
        assertEquals(CalendarRoute(null, null), CalendarRoute.parse("/calendar/"))
        assertEquals(CalendarRoute(null, LocalDate.of(2026, 10, 28)), CalendarRoute.parse("/calendar?day=2026-10-28"))
        assertEquals(CalendarRoute(null, null), CalendarRoute.parse("/calendar?day=tomorrow&scope=today"))
    }

    @Test
    fun eventPermalink() {
        val route = CalendarRoute.parse("/calendar/event/primary%3Aabc123?day=2026-11-02")!!
        assertEquals("primary:abc123", route.eventId)
        assertEquals("abc123", route.rawEventId)
        assertEquals(LocalDate.of(2026, 11, 2), route.day)
        assertEquals("a+b", CalendarRoute.parse("/calendar/event/a+b")!!.eventId)
        assertEquals("ada@x.com", CalendarRoute.parse("/calendar/event/g%3Aada%40x.com%3Aada@x.com")!!.rawEventId)
    }

    @Test
    fun notCalendar() {
        assertNull(CalendarRoute.parse("/work/task/1"))
        assertNull(CalendarRoute.parse("/calendar/event/"))
        assertNull(CalendarRoute.parse("/calendar/person/x"))
        assertNull(CalendarRoute.parse("/calendar/event/%00"))
    }
}
