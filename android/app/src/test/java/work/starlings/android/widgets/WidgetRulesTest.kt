package work.starlings.android.widgets

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.UpcomingTier
import work.starlings.contracts.CalendarAttendeeStatus
import work.starlings.contracts.CalendarAttendeeWire
import work.starlings.contracts.CalendarEventWire
import work.starlings.contracts.CalendarMeetingPlatform
import work.starlings.contracts.CalendarSemanticRole
import work.starlings.contracts.CrmMyTaskWire
import java.time.Instant
import java.time.ZoneId

/** The widgets' readings (WidgetAgenda.kt, WidgetWork.kt), against iOS AgendaFile, StarlingsGlance and TodayWidgets. */
class WidgetRulesTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val now = Instant.parse("2026-10-28T10:00:00Z").toEpochMilli()
    private val minute = 60_000L

    private fun wire(
        id: String,
        start: String,
        end: String,
        title: String = "Standup $id",
        platform: CalendarMeetingPlatform = CalendarMeetingPlatform.NONE,
        conferenceUrl: String = "",
        joinUrl: String = "",
        attendees: List<CalendarAttendeeWire> = emptyList(),
        allDay: Boolean = false,
    ) = CalendarEventWire(
        id = id, calendarId = "primary", calendarSummary = "Work", htmlLink = "", title = title, start = start, end = end,
        joinUrl = joinUrl, roomSlug = "", isMeetEvent = false, attendees = attendees, organizerSelf = false,
        platform = platform, conferenceUrl = conferenceUrl, allDay = allDay, recurringEventId = "",
        recurring = false, description = "secret", location = "", demoted = false, calendarRole = CalendarSemanticRole.ORDINARY,
    )

    private fun person(name: String, email: String, self: Boolean = false) =
        CalendarAttendeeWire(name = name, email = email, status = CalendarAttendeeStatus.ACCEPTED, optional = false, isSelf = self)

    private fun file(meetings: List<WidgetMeeting>, rows: Int? = null) = WidgetAgendaFile(owner = "rosa@org.example", savedAtMs = now, homeFollowingRows = rows, meetings = meetings)

    @Test
    fun meetingKeepsOnlyWhatAGlanceDraws() {
        val zoom = wire(
            "z", "2026-10-28T11:00:00Z", "2026-10-28T11:30:00Z",
            platform = CalendarMeetingPlatform.ZOOM, conferenceUrl = "https://zoom.us/j/1",
            attendees = listOf(person("Rosa Lima", "rosa@org.example", self = true), person("Ana Souza", "ana@x.com"), person("", "bruno@x.com")),
        )
        val m = WidgetAgenda.meeting(zoom, ownSlug = null, now = now)!!
        assertEquals(WidgetJoin(WidgetJoin.Kind.EXTERNAL, "https://zoom.us/j/1"), m.join)
        assertTrue(m.isVideo)
        assertEquals("Work", m.calendar)
        assertEquals("names, never addresses; never you", listOf("Ana", "bruno"), m.attendees)
        assertFalse("no description on disk", Json.encodeToString(WidgetMeeting.serializer(), m).contains("secret"))

        assertNull("ended", WidgetAgenda.meeting(wire("e", "2026-10-28T08:00:00Z", "2026-10-28T09:00:00Z"), null, now))
        assertNull("no readable start", WidgetAgenda.meeting(wire("u", "", "2026-10-28T12:00:00Z"), null, now))
        assertNull("no link", WidgetAgenda.meeting(wire("p", "2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z"), null, now)!!.join)
    }

    @Test
    fun ownRoomHasNoJoinAndAColleaguesRoomKnocks() {
        val ours = wire("o", "2026-10-28T11:00:00Z", "2026-10-28T12:00:00Z", platform = CalendarMeetingPlatform.STARLINGS, joinUrl = "https://envisioning.starlings.example/room/rosa")
        assertNull(WidgetAgenda.meeting(ours, ownSlug = "rosa", now = now)!!.join)
        assertEquals(WidgetJoin.Kind.ROOM, WidgetAgenda.meeting(ours, ownSlug = "ana", now = now)!!.join?.kind)
    }

    @Test
    fun planIsHomesPlanAndTodayIsNowThenToday() {
        val meetings = WidgetAgenda.meetings(
            listOf(
                wire("tomorrow", "2026-10-29T09:00:00Z", "2026-10-29T10:00:00Z"),
                wire("later", "2026-10-28T14:00:00Z", "2026-10-28T15:00:00Z"),
                wire("live", "2026-10-28T09:30:00Z", "2026-10-28T10:30:00Z"),
            ),
            null, now,
        )
        assertEquals("soonest first", listOf("live", "later", "tomorrow"), meetings.map { it.id })
        val f = file(meetings)
        val plan = WidgetAgenda.plan(f, now, zone)
        assertEquals("live", WidgetAgenda.focus(plan, f)?.id)
        assertEquals(UpcomingTier.NOW, plan.tiers["live"])
        assertEquals(listOf("live", "later"), WidgetAgenda.today(plan, f).map { it.id })
        assertEquals(listOf("later"), WidgetAgenda.rows(plan.homeRows, f).map { it.id })
        assertEquals("the owner's row count", 0, WidgetAgenda.plan(file(meetings, rows = 0), now, zone).homeRows.size)
        assertTrue(WidgetAgenda.showsCountdown(meetings[1], plan))
        assertFalse("tomorrow says its date", WidgetAgenda.showsCountdown(meetings[2], plan))

        val closed = WidgetAgenda.plan(file(listOf(meetings[2])), now, zone)
        assertNull("a closed day never counts down to tomorrow", WidgetAgenda.focus(closed, file(listOf(meetings[2]))))
        assertNull("no file is an empty day", WidgetAgenda.plan(null, now, zone).focus)
    }

    @Test
    fun countdownCountsToTheStartThenTheEnd() {
        val m = WidgetAgenda.meeting(wire("a", "2026-10-28T10:30:00Z", "2026-10-28T11:00:00Z"), null, now)!!
        assertEquals(Instant.parse("2026-10-28T10:30:00Z").toEpochMilli(), WidgetAgenda.countdownTarget(m, now))
        val during = now + 40 * minute
        assertTrue(WidgetAgenda.hasStarted(m, during))
        assertEquals(Instant.parse("2026-10-28T11:00:00Z").toEpochMilli(), WidgetAgenda.countdownTarget(m, during))
        assertNull(WidgetAgenda.countdownTarget(m.copy(allDay = true), now))
    }

    @Test
    fun whoLineIsTwoNamesThenHowManyMore() {
        assertEquals("", WidgetAgenda.whoLine(emptyList()))
        assertEquals("Ana", WidgetAgenda.whoLine(listOf("Ana", "")))
        assertEquals("Ana, Bruno", WidgetAgenda.whoLine(listOf("Ana", "Bruno")))
        assertEquals("Ana, Bruno +2", WidgetAgenda.whoLine(listOf("Ana", "Bruno", "Caio", "Dora")))
        assertEquals("Ana", WidgetAgenda.firstName("  Ana Souza ", "x@y.com"))
        assertEquals("x", WidgetAgenda.firstName(" ", "x@y.com"))
    }

    @Test
    fun refreshFollowsAgendaFileEntryDates() {
        val m = WidgetAgenda.meeting(wire("a", "2026-10-28T12:00:00Z", "2026-10-28T13:00:00Z"), null, now)!!
        val dates = WidgetAgenda.entryDates(now, listOf(m), zone)
        assertEquals(now, dates.first())
        assertTrue("the lead", (Instant.parse("2026-10-28T11:50:00Z").toEpochMilli() + 1_000) in dates)
        assertTrue("the start", (Instant.parse("2026-10-28T12:00:00Z").toEpochMilli() + 1_000) in dates)
        assertTrue("the end", (Instant.parse("2026-10-28T13:00:00Z").toEpochMilli() + 1_000) in dates)
        assertTrue("midnight in the zone", (Instant.parse("2026-10-28T23:00:00Z").toEpochMilli() + 1_000) in dates)
        assertTrue("each minute for the first hour", (now + 59 * minute) in dates)
        assertFalse("then every five", (now + 62 * minute) in dates)
        assertTrue(dates.size <= 240)
        assertEquals(now + minute, WidgetAgenda.nextRefresh(now, listOf(m), zone))
    }

    private fun task(id: String, due: String?, project: String? = "p1", lead: String? = null, org: String? = null) = CrmMyTaskWire(
        id = id, title = "Task $id", status = "pending", responsibleParty = "team", dueDate = due,
        projectId = project, leadId = lead, organizationId = org, subjectTitle = "Acme",
    )

    @Test
    fun workIsLateThenTodayTasksWithTheirDoors() {
        val rows = WidgetWork.rows(
            listOf(task("today", "2026-10-28"), task("late", "2026-10-20", project = null, lead = "l1"), task("soon", "2026-11-02"), task("loose", "2026-10-28T15:00:00Z", project = null)),
            emptyList(), now, zone,
        )
        assertEquals(listOf("late", "today", "loose"), rows.map { it.id })
        assertEquals(listOf(true, false, false), rows.map { it.overdue })
        assertEquals("/work/lead/l1?pane=tasks", rows[0].path)
        assertEquals("/work/project/p1?pane=tasks", rows[1].path)
        assertEquals("a task with no subject opens itself", "/work/task/loose", rows[2].path)
        assertEquals(1 to 2, WidgetWork.counts(rows))
        assertEquals("/work/organization/o1?pane=tasks", WidgetWork.door(task("o", null, project = null, org = "o1")))

        assertTrue("only soon work: Home's Next fill, not today's work", WidgetWork.rows(listOf(task("soon", "2026-11-02")), emptyList(), now, zone).isEmpty())
    }
}
