package work.starlings.android

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId

/** `MeetingAlertPlan.body` and the lead choices of iOS `MeetingAlertSettings`. */
class MeetingWarningsTest {
    @Test
    fun body() {
        val start = Upcoming.parse("2026-10-28T13:05:00Z")!!
        assertEquals("Starting · 14:05", MeetingWarnings.body(start, ZoneId.of("Europe/Amsterdam")))
    }

    @Test
    fun leadDefault() {
        assertEquals(listOf(1, 2, 5, 10, 15), MeetingAlertPlan.leadChoices)
        assertEquals(1, MeetingWarnings.DEFAULT_LEAD_MINUTES)
    }
}
