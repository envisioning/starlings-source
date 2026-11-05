package work.starlings.android.widgets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** The Lock Screen countdown's rules (MeetingCountdown.kt), against iOS MeetingLiveActivity and MeetingAlertSettings. */
class MeetingCountdownTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val now = Instant.parse("2026-10-28T10:00:00Z").toEpochMilli()
    private val minute = 60_000L
    private val hour = 60 * minute

    private fun meeting(id: String, start: String, end: String, allDay: Boolean = false, demoted: Boolean = false) =
        WidgetMeeting(id = id, title = "Standup $id", start = start, end = end, allDay = allDay, demoted = demoted)

    private fun file(vararg meetings: WidgetMeeting) = WidgetAgendaFile(owner = "rosa@org.example", savedAtMs = now, meetings = meetings.toList())

    @Test
    fun choicesAndDefaultAreTheIOSOnes() {
        assertEquals(listOf(15, 30, 60, 120, 240), MeetingCountdownRules.leadChoices)
        assertEquals(60, MeetingCountdownRules.DEFAULT_LEAD_MINUTES)
    }

    @Test
    fun ineligibilityFollowsMeetingLiveActivity() {
        val soon = meeting("a", "2026-10-28T10:30:00Z", "2026-10-28T11:00:00Z")
        assertEquals("alerts off in Settings", MeetingCountdownRules.ineligibilityReason(soon, now, enabled = false, leadMs = hour))
        assertEquals("no focus meeting", MeetingCountdownRules.ineligibilityReason(null, now, enabled = true, leadMs = hour))
        assertEquals("focus has no start or end", MeetingCountdownRules.ineligibilityReason(meeting("b", "", "2026-10-28T11:00:00Z"), now, true, hour))
        assertEquals("focus already ended", MeetingCountdownRules.ineligibilityReason(meeting("c", "2026-10-28T09:00:00Z", "2026-10-28T10:00:00Z"), now, true, hour))
        assertEquals("focus starts in 30 min, lead is 15 min", MeetingCountdownRules.ineligibilityReason(soon, now, true, 15 * minute))
        assertNull(MeetingCountdownRules.ineligibilityReason(soon, now, true, 30 * minute))
    }

    @Test
    fun countsToTheStartThenToTheEnd() {
        val m = meeting("a", "2026-10-28T10:30:00Z", "2026-10-28T11:00:00Z")
        val before = MeetingCountdownRules.plan(file(m), now, enabled = true, leadMs = hour, zone = zone) as MeetingCountdownRules.Plan.Show
        assertEquals(Instant.parse("2026-10-28T10:30:00Z").toEpochMilli(), before.target)
        val during = MeetingCountdownRules.plan(file(m), now + 40 * minute, true, hour, zone) as MeetingCountdownRules.Plan.Show
        assertTrue(during.started)
        assertEquals(Instant.parse("2026-10-28T11:00:00Z").toEpochMilli(), during.target)
    }

    @Test
    fun followsTheHeroNotTheFirstRow() {
        val allDay = meeting("d", "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", allDay = true)
        val hidden = meeting("h", "2026-10-28T10:10:00Z", "2026-10-28T10:20:00Z", demoted = true)
        val hero = meeting("a", "2026-10-28T10:30:00Z", "2026-10-28T11:00:00Z")
        val plan = MeetingCountdownRules.plan(file(allDay, hidden, hero), now, true, hour, zone) as MeetingCountdownRules.Plan.Show
        assertEquals("a", plan.meeting.id)
        assertEquals("outside the lead", MeetingCountdownRules.Plan.None, MeetingCountdownRules.plan(file(hero), now, true, 15 * minute, zone))
        assertEquals(
            "tomorrow is a closed day", MeetingCountdownRules.Plan.None,
            MeetingCountdownRules.plan(file(meeting("t", "2026-10-29T08:00:00Z", "2026-10-29T09:00:00Z")), now, true, 240 * minute, zone),
        )
    }

    @Test
    fun wakesAtTheNextBoundary() {
        val m = meeting("a", "2026-10-28T12:00:00Z", "2026-10-28T12:30:00Z")
        val enter = Instant.parse("2026-10-28T11:00:00Z").toEpochMilli()
        assertEquals("the lead window opens", enter + 1_000, MeetingCountdownRules.nextChange(file(m), now, hour, zone))
        assertEquals(
            "the start flips the number", Instant.parse("2026-10-28T12:00:00Z").toEpochMilli() + 1_000,
            MeetingCountdownRules.nextChange(file(m), enter + 1_000, hour, zone),
        )
        val midnight = Instant.parse("2026-10-28T23:00:00Z").toEpochMilli()
        assertEquals("no meeting: midnight", midnight + 1_000, MeetingCountdownRules.nextChange(file(), now, hour, zone))
    }
}
