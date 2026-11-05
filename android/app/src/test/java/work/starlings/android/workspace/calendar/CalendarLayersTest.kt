package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.CalEvent
import work.starlings.android.CalSource
import work.starlings.android.CalendarDates
import work.starlings.android.CalendarValues
import work.starlings.android.api.PublicEvent
import work.starlings.contracts.CalendarAvailabilityBlock
import work.starlings.contracts.CrmWorkItem
import work.starlings.contracts.CrmWorkItemKind
import java.time.LocalDate
import java.time.ZoneId

/** `Sources/CalendarLayer.swift`, case by case: no fixture pins the layer rows. */
class CalendarLayersTest {
    private val zone = ZoneId.of("Europe/Amsterdam")

    private fun work(
        id: String = "t1",
        kind: CrmWorkItemKind = CrmWorkItemKind.TASK,
        due: String? = "2026-10-28T14:00:00Z",
        mine: Boolean? = true,
        projectId: String? = null,
        projectTitle: String? = null,
        leadId: String? = null,
    ) = CrmWorkItem(
        id = id, kind = kind, mine = mine, title = "Ship it", status = "in_progress", dueAt = due,
        responsibleParty = "us", projectId = projectId, projectTitle = projectTitle, leadId = leadId,
    )

    @Test
    fun everyKindIsACalendarValuesLayer() {
        assertEquals(CalendarValues.layers.map { it.kind }, CalendarLayerKind.entries.map { it.wire })
    }

    @Test
    fun timedTaskLastsHalfAnHour() {
        val item = CalendarLayers.workItem(work(), zone)!!
        assertEquals("wi:t1", item.id)
        assertEquals(CalendarLayerKind.TASKS, item.kind)
        assertEquals(false, item.allDay)
        assertEquals(30 * 60_000L, item.end - item.start)
        assertEquals("In progress", item.statusText)
    }

    @Test
    fun datedMilestoneCoversItsDay() {
        val item = CalendarLayers.workItem(work(kind = CrmWorkItemKind.MILESTONE, due = "2026-10-28"), zone)!!
        assertEquals(CalendarLayerKind.MILESTONES, item.kind)
        assertTrue(item.allDay)
        assertEquals(CalendarDates.startOfDay(LocalDate.of(2026, 10, 28), zone), item.start)
        assertEquals(CalendarDates.startOfDay(LocalDate.of(2026, 10, 29), zone), item.end)
        assertNull(CalendarLayers.workItem(work(due = null), zone))
    }

    @Test
    fun workLinks() {
        val mine = CalendarLayers.workLinks(work(projectId = "p 1", projectTitle = "Atlas"))
        assertEquals(listOf("/work/task/t1", "/work/project/p%201?pane=tasks"), mine.map { it.path })
        assertEquals("Atlas", (mine[1] as CalendarLayerWorkLink.Subject).name)
        val milestone = CalendarLayers.workLinks(work(kind = CrmWorkItemKind.MILESTONE, mine = false, leadId = "l1"))
        assertEquals(listOf("/work/lead/l1"), milestone.map { it.path })
        assertNull((milestone[0] as CalendarLayerWorkLink.Subject).name)
    }

    @Test
    fun publicEventsAndAvailability() {
        val allDay = CalendarLayers.publicEvent(PublicEvent("e1", "Expo", "2026-10-30", isAllDay = true, signupUrl = "https://x"), zone)!!
        assertTrue(allDay.allDay)
        assertEquals("https://x", allDay.url)
        assertEquals(listOf(allDay), CalendarLayers.on(LocalDate.of(2026, 10, 30), listOf(allDay), zone))
        assertEquals(emptyList<CalendarLayerItem>(), CalendarLayers.on(LocalDate.of(2026, 10, 31), listOf(allDay), zone))
        val timed = CalendarLayers.publicEvent(PublicEvent("e2", "Talk", "2026-10-30", "2026-10-30T10:00:00Z", null, isAllDay = false), zone)!!
        // No end: the projection repeats the start, and a row lasts a minute at least.
        assertEquals(60_000L, timed.end - timed.start)
        assertNull(CalendarLayers.availability(CalendarAvailabilityBlock("2026-10-30T10:00:00Z", "2026-10-30T09:00:00Z"), zone))
        assertEquals("av:2026-10-30T09:00:00Z", CalendarLayers.availability(CalendarAvailabilityBlock("2026-10-30T09:00:00Z", "2026-10-30T10:00:00Z"), zone)!!.id)
    }

    @Test
    fun mirroredPublishedEventIsOneAppointment() {
        val layer = CalendarLayers.publicEvent(PublicEvent("e2", "Talk", "2026-10-30", "2026-10-30T10:00:00Z", "2026-10-30T11:00:00Z", isAllDay = false), zone)!!
        val event = CalEvent(
            id = "g:primary:abc", calendarId = "g:primary", rawEventId = "abc", title = " talk ", start = layer.start, end = layer.end,
            allDay = false, writable = true, recurring = false, joinUrl = "", roomSlug = "", attendeeEmails = emptyList(),
            attendees = emptyList(), source = CalSource.GOOGLE,
        )
        val split = CalendarLayers.splitMirrored(listOf(layer), listOf(event))
        assertEquals(emptyList<CalendarLayerItem>(), split.layers)
        assertEquals(setOf("g:primary:abc"), split.publishedEventIds)
        assertEquals(listOf(layer), CalendarLayers.splitMirrored(listOf(layer), listOf(event.copy(start = layer.start + 1))).layers)
    }
}
