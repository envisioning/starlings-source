package work.starlings.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.CalendarAttendeeStatus
import work.starlings.contracts.CalendarAttendeeWire
import work.starlings.contracts.CalendarEventsResponse
import work.starlings.contracts.CalendarEventWire
import work.starlings.contracts.CalendarMeetingPlatform
import work.starlings.contracts.CalendarSemanticRole
import work.starlings.contracts.GoogleCalendarListEntry
import work.starlings.contracts.WireJson
import java.io.File
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId

/**
 * The Calendar tab's rules in `CalendarAgenda.kt`, case by case from the
 * Swift they port (`CalendarWorkspace`, `CalendarWeekMath`,
 * `MobileCalendarLayout`, `CalendarMeetingPlatform.inferred`). No fixture
 * pins these yet, so the cases are the Swift behaviour.
 */
class CalendarAgendaTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val hosts = listOf("envisioning.starlings.example")

    private fun entry(id: String, summary: String = id, writable: Boolean = true, email: String = "a@org.example", color: String? = null) =
        GoogleCalendarListEntry(id, summary, primary = false, selected = true, writable = writable, accountId = "acc", accountEmail = email, backgroundColor = color)

    private fun wire(
        id: String,
        calendarId: String = "primary",
        title: String = "Standup",
        start: String = "2026-10-28T09:00:00.000Z",
        end: String = "2026-10-28T09:30:00.000Z",
        allDay: Boolean = false,
        attendees: List<CalendarAttendeeWire> = emptyList(),
        joinUrl: String = "",
        conferenceUrl: String = "",
        roomSlug: String = "",
        location: String = "",
    ) = CalendarEventWire(
        id = id, calendarId = calendarId, calendarSummary = "", htmlLink = "", title = title, start = start, end = end,
        joinUrl = joinUrl, roomSlug = roomSlug, isMeetEvent = false, attendees = attendees, organizerSelf = false,
        platform = CalendarMeetingPlatform.NONE, conferenceUrl = conferenceUrl, allDay = allDay, recurringEventId = "",
        recurring = false, description = "", location = location, demoted = false, calendarRole = CalendarSemanticRole.ORDINARY,
    )

    private fun person(email: String, status: CalendarAttendeeStatus, self: Boolean = false) =
        CalendarAttendeeWire(name = "", email = email, status = status, optional = false, isSelf = self)

    @Test
    fun googleCalendarsNameAccountsOnlyWhenThereAreSeveral() {
        val one = CalCalendar.google(listOf(entry("primary", color = "#123456")), namesAccounts = false).single()
        assertEquals("g:primary", one.id)
        assertEquals("Google", one.groupTitle)
        assertEquals(0xFF123456L, one.color)
        assertEquals("a@org.example", CalCalendar.google(listOf(entry("primary")), namesAccounts = true).single().groupTitle)
        assertEquals("a calendar without a colour takes the palette", CalendarColors.fallback(1), CalCalendar.google(listOf(entry("x"), entry("y")), false)[1].color)
        assertTrue(one.isMemberAccount)
        assertFalse(CalCalendar.google(listOf(entry("p", email = "me@gmail.com")), false).single().isMemberAccount)
    }

    @Test
    fun globalInterestIsTheCompanyCalendarByTitle() {
        val internal = CalCalendar.google(listOf(entry("int", summary = "Envisioning Internal")), false).single()
        assertEquals(CalendarSemanticRole.GLOBAL_INTEREST, internal.role)
        assertEquals(CalendarColors.globalInterest, internal.displayColor)
        assertFalse("never the default write target", internal.canBeWriteTarget)
        assertFalse(internal.canBeMoveTarget)
    }

    @Test
    fun hiddenByCalendarOrAccountKey() {
        val cal = CalCalendar.google(listOf(entry("primary")), false).single()
        assertTrue(cal.isIn(listOf("g:primary")))
        assertTrue(cal.isIn(listOf(CalendarKeys.account("Google"))))
        assertFalse(cal.isIn(listOf("g:other")))
    }

    @Test
    fun googleEventFromTheWire() {
        val calendars = CalCalendar.google(listOf(entry("primary")), false)
        val e = CalEvent.google(
            wire(
                "primary:abc",
                attendees = listOf(person("a@org.example", CalendarAttendeeStatus.NEEDS_ACTION, self = true), person("b@x.com", CalendarAttendeeStatus.ACCEPTED)),
                joinUrl = "https://envisioning.starlings.example/room/pilot",
                conferenceUrl = "https://zoom.us/j/1",
            ),
            calendars, hosts, zone,
        )!!
        assertEquals("g:primary:abc", e.id)
        assertEquals("abc", e.rawEventId)
        assertEquals("g:primary", e.calendarId)
        assertEquals("the conference link comes first", "https://zoom.us/j/1", e.joinUrl)
        assertEquals(Rsvp.NEEDS_ACTION, e.myResponse)
        assertTrue(e.canRespond)
        assertEquals(Attendance.CONFIRMED, e.attendance)
        assertEquals("event:g:primary:abc", e.demotionKey)
        assertEquals("primary", e.googleCalendarId)
        assertNull("an event on a calendar that is not listed is left out", CalEvent.google(wire("x", calendarId = "other"), calendars, hosts, zone))
    }

    @Test
    fun allDayDatesAreLocalDays() {
        val calendars = CalCalendar.google(listOf(entry("primary")), false)
        val e = CalEvent.google(wire("d", start = "2026-10-28", end = "2026-10-30"), calendars, hosts, zone)!!
        assertTrue(e.allDay)
        assertTrue(CalendarMerge.allDayCovers(e, LocalDate.of(2026, 10, 29), zone))
        assertFalse("the end is exclusive", CalendarMerge.allDayCovers(e, LocalDate.of(2026, 10, 30), zone))
        assertEquals(2, CalendarMerge.agenda(listOf(LocalDate.of(2026, 10, 28), LocalDate.of(2026, 10, 29), LocalDate.of(2026, 10, 30)), listOf(e), zone).size)
    }

    @Test
    fun attendanceCountsOthersOnly() {
        assertNull(Attendance.of(listOf(person("me@x.com", CalendarAttendeeStatus.ACCEPTED, self = true))))
        assertEquals(Attendance.DECLINED, Attendance.of(listOf(person("b@x.com", CalendarAttendeeStatus.DECLINED))))
        assertEquals(Attendance.PENDING, Attendance.of(listOf(person("b@x.com", CalendarAttendeeStatus.ACCEPTED), person("c@x.com", CalendarAttendeeStatus.TENTATIVE))))
        assertEquals(
            "a guest who declined drops out of the check",
            Attendance.CONFIRMED,
            Attendance.of(listOf(person("b@x.com", CalendarAttendeeStatus.ACCEPTED), person("c@x.com", CalendarAttendeeStatus.DECLINED))),
        )
    }

    @Test
    fun platformIsInferredFromTheDestination() {
        fun p(join: String, location: String = "", slug: String = "") = MeetingPlatforms.inferred(join, location, slug, hosts)
        assertEquals(CalendarMeetingPlatform.STARLINGS, p("", slug = "pilot"))
        assertEquals(CalendarMeetingPlatform.STARLINGS, p("https://envisioning.starlings.example/room/pilot"))
        assertEquals("another workspace's room is a link", CalendarMeetingPlatform.OTHER, p("https://other.starlings.example/room/pilot"))
        assertEquals(CalendarMeetingPlatform.GOOGLE_MEET, p("https://meet.google.com/abc"))
        assertEquals(CalendarMeetingPlatform.ZOOM, p("https://us02web.zoom.us/j/1"))
        assertEquals(CalendarMeetingPlatform.TEAMS, p("", "Microsoft Teams Meeting"))
        assertEquals(CalendarMeetingPlatform.NONE, p("", "Room 4"))
    }

    @Test
    fun oneEventOnTwoCalendarsIsOneBlock() {
        val calendars = CalCalendar.google(listOf(entry("a"), entry("b")), false)
        val a = CalEvent.google(wire("a:1", calendarId = "a"), calendars, hosts, zone)!!
        val b = CalEvent.google(wire("b:1", calendarId = "b", title = " standup "), calendars, hosts, zone)!!
        val twice = CalEvent.google(wire("a:2", calendarId = "a"), calendars, hosts, zone)!!
        val groups = CalendarMerge.consolidate(listOf(a, b, twice), zone)
        assertEquals(2, groups.size)
        assertEquals(listOf("g:a", "g:b"), groups[0].calendarIds)
        assertEquals("a real second copy on one calendar stays", listOf("g:a"), groups[1].calendarIds)
    }

    @Test
    fun dayOrderIsAllDayFirstThenStart() {
        val calendars = CalCalendar.google(listOf(entry("primary")), false)
        val late = CalEvent.google(wire("late", title = "Late", start = "2026-10-28T15:00:00Z", end = "2026-10-28T16:00:00Z"), calendars, hosts, zone)!!
        val early = CalEvent.google(wire("early", title = "Early"), calendars, hosts, zone)!!
        val day = CalEvent.google(wire("day", title = "Trip", start = "2026-10-28", end = "2026-10-29", allDay = true), calendars, hosts, zone)!!
        val overnight = CalEvent.google(wire("night", title = "Night", start = "2026-10-27T22:00:00Z", end = "2026-10-28T01:00:00Z"), calendars, hosts, zone)!!
        val order = CalendarMerge.groupsOn(LocalDate.of(2026, 10, 28), listOf(late, early, day, overnight), zone).map { it.event.title }
        assertEquals(listOf("Trip", "Night", "Early", "Late"), order)
    }

    @Test
    fun displayedLeavesHiddenFromNextOut() {
        val calendars = CalCalendar.google(listOf(entry("primary")), false)
        val e = CalEvent.google(wire("x"), calendars, hosts, zone)!!
        assertEquals(1, CalendarMerge.displayed(listOf(e)).size)
        assertEquals(0, CalendarMerge.displayed(listOf(e.copy(demoted = true))).size)
        assertEquals(1, CalendarMerge.displayed(listOf(e.copy(myResponse = Rsvp.DECLINED))).size)
    }

    @Test
    fun layoutsAndSteps() {
        val wed = LocalDate.of(2026, 10, 28)
        assertEquals(listOf(wed), CalendarLayout.DAY.days(wed, DayOfWeek.MONDAY))
        assertEquals(3, CalendarLayout.THREE_DAY.days(wed, DayOfWeek.MONDAY).size)
        assertEquals("a multi-day window steps one day", wed.plusDays(1), CalendarLayout.THREE_DAY.step(wed, 1))
        val month = CalendarLayout.MONTH.days(wed, DayOfWeek.MONDAY)
        assertEquals(42, month.size)
        assertEquals(LocalDate.of(2026, 9, 28), month.first())
        assertEquals(LocalDate.of(2026, 9, 27), CalendarLayout.MONTH.days(wed, DayOfWeek.SUNDAY).first())
        assertEquals("the list is a rolling week", wed, CalendarLayout.AGENDA.days(wed, DayOfWeek.MONDAY).first())
        assertEquals(wed.plusWeeks(1), CalendarLayout.AGENDA.step(wed, 1))
        assertEquals(CalendarLayout.AGENDA, CalendarLayout.of("agenda"))
    }

    @Test
    fun packCascadesCollisions() {
        val packs = CalendarPacking.pack(
            listOf(TimedSpan("a", 0, 60), TimedSpan("b", 0, 30), TimedSpan("c", 30, 60), TimedSpan("d", 100, 120)),
        ).associateBy { it.id }
        assertEquals(0, packs.getValue("a").column)
        assertEquals(1, packs.getValue("b").column)
        assertEquals("a freed lane is reused", 1, packs.getValue("c").column)
        assertEquals(2, packs.getValue("a").columnCount)
        assertEquals(1, packs.getValue("d").columnCount)
        assertEquals(0.34, packs.getValue("b").leadingFraction, 1e-9)
    }

    @Test
    fun travelAndSnap() {
        assertNull(CalendarTravel.validMinutes(0))
        assertEquals(30, CalendarTravel.validMinutes(30))
        assertNull(CalendarTravel.validMinutes(24 * 60 + 1))
        assertEquals(900_000L, CalendarPacking.snapUp(1, 15))
        assertEquals(900_000L, CalendarPacking.snapUp(900_000L, 15))
    }

    @Test
    fun theUpcomingFixtureDecodesAsFeedRows() {
        // The one calendar response fixture is a feed row: it is not a Google calendar's, so it is left out.
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val response = WireJson.decodeFromString(CalendarEventsResponse.serializer(), File(dir, "responses/calendar-upcoming.json").readText())
        val calendars = CalCalendar.google(listOf(entry("primary")), false)
        assertTrue(response.events.isNotEmpty())
        assertTrue(response.events.all { CalEvent.google(it, calendars, hosts, zone) == null })
    }
}
