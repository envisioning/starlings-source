package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.CalCalendar
import work.starlings.android.CalSource
import work.starlings.android.CalendarMerge
import work.starlings.android.Rsvp
import work.starlings.contracts.CalendarAttendeeStatus
import java.time.LocalDate
import java.time.ZoneId

/**
 * The phone's own calendars as `EventKitCalendarStore` reads EventKit:
 * which accounts, how they group and key, the events, and the
 * `CalendarSourcePreferences.adoptLocal` rule for a calendar that is new.
 */
class DeviceCalendarsTest {
    private val zone = ZoneId.of("Europe/Lisbon")
    private val local = DeviceCalendarRules.localGroupTitle(tablet = false)

    private fun row(id: String, title: String, type: String = DeviceCalendarRules.LOCAL_ACCOUNT_TYPE, name: String = "Phone", owner: String = "") =
        DeviceCalendarRules.Row(id, name, type, title, 0x3366CC, writable = true, owner = owner)

    @Test
    fun googleStaysOnTheWorkerSoItIsNeverListedTwice() {
        assertTrue(DeviceCalendarRules.includeAccount(DeviceCalendarRules.LOCAL_ACCOUNT_TYPE, "Phone"))
        assertFalse(DeviceCalendarRules.includeAccount("com.google", "rosa@org.example"))
        assertFalse(DeviceCalendarRules.includeAccount("com.android.exchange", "rosa@gmail.com"))
        assertTrue(DeviceCalendarRules.includeAccount("com.android.exchange", "rosa@work.example"))
        val calendars = DeviceCalendarRules.calendars(listOf(row("1", "Home"), row("2", "Work", "com.google", "rosa@org.example")), local)
        assertEquals(listOf("Home"), calendars.map { it.title })
    }

    @Test
    fun aCalendarKeysOnItsAccountAndTitleAsEventKitDoes() {
        val calendars = DeviceCalendarRules.calendars(
            listOf(row("7", "Family", "com.example.caldav", " Fastmail ", owner = "Rosa@Fastmail.com"), row("3", "Home")),
            local,
        )
        val family = calendars.first { it.title == "Family" }
        assertEquals(CalSource.DEVICE, family.source)
        assertEquals("ek:7", family.id)
        assertEquals("Fastmail", family.groupTitle)
        assertEquals("ek:fastmail/family", family.visibilityKey)
        assertEquals("account:fastmail", family.accountKey)
        assertEquals("rosa@fastmail.com", family.accountEmail)
        assertEquals(0xFF3366CCL, family.color)
        assertEquals("On My Phone", calendars.first { it.title == "Home" }.groupTitle)
        assertEquals("On My Tablet", DeviceCalendarRules.localGroupTitle(tablet = true))
    }

    @Test
    fun groupsReadGoogleThenAccountsThenThePhoneThenFeeds() {
        fun cal(title: String, group: String, source: CalSource) = CalCalendar("$group/$title", source, title, title, group, false, 0)
        val ordered = DeviceCalendarRules.orderedGroups(
            listOf(
                cal("Feed", "Subscribed", CalSource.SUBSCRIPTION),
                cal("b", "On My Phone", CalSource.DEVICE),
                cal("Zeta", "Fastmail", CalSource.DEVICE),
                cal("Alpha", "Fastmail", CalSource.DEVICE),
                cal("Work", "Google", CalSource.GOOGLE),
            ),
        )
        assertEquals(listOf("Google", "Fastmail", "On My Phone", "Subscribed"), ordered.map { it.first })
        assertEquals(listOf("Alpha", "Zeta"), ordered[1].second.map { it.title })
    }

    @Test
    fun anAllDayInstanceCoversItsDatesInThePhonesZone() {
        // 12 and 13 March, stored as UTC midnights.
        val begin = LocalDate.of(2026, 3, 12).atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli()
        val end = LocalDate.of(2026, 3, 14).atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli()
        val (start, stop) = DeviceCalendarRules.allDaySpan(begin, end, ZoneId.of("America/Sao_Paulo"))
        assertEquals(LocalDate.of(2026, 3, 12).atStartOfDay(ZoneId.of("America/Sao_Paulo")).toInstant().toEpochMilli(), start)
        assertEquals(LocalDate.of(2026, 3, 14).atStartOfDay(ZoneId.of("America/Sao_Paulo")).toInstant().toEpochMilli(), stop)
    }

    @Test
    fun anEventReadsAsEventKitHandsIt() {
        val calendar = DeviceCalendarRules.calendars(listOf(row("3", "Home", owner = "rosa@fastmail.com")), local).single()
        val begin = 1_773_316_800_000L
        val instance = DeviceCalendarRules.Instance(
            eventId = "42", calendarRawId = "3", title = "Dentist", begin = begin, end = begin,
            allDay = false, recurring = true, location = "https://zoom.us/j/1", notes = "n", timeZone = "Europe/Lisbon", selfStatus = 2,
        )
        val people = listOf(
            DeviceCalendarRules.Attendee("", "Rosa@Fastmail.com", 2, 1),
            DeviceCalendarRules.Attendee("Room 1", "room@x.com", 0, 3),
            DeviceCalendarRules.Attendee("Ana", "ana@x.com", 4, 2),
        )
        val event = DeviceCalendarRules.event(instance, calendar, people, emptyList(), zone)!!
        assertEquals("ek:42:${begin / 1000}", event.id)
        assertEquals("ek:3", event.calendarId)
        assertEquals("event:ek:42:${begin / 1000}", event.demotionKey)
        assertEquals(begin + 60_000L, event.end)
        assertEquals("https://zoom.us/j/1", event.joinUrl)
        assertEquals("", event.location)
        // Writable as its calendar is; EventKit has no reply API, so no reply.
        assertTrue(event.writable)
        assertFalse(event.canRespond)
        val readOnly = DeviceCalendarRules.calendars(listOf(row("3", "Home")), local, canWrite = false).single()
        assertFalse(readOnly.writable)
        assertFalse(DeviceCalendarRules.event(instance, readOnly, people, emptyList(), zone)!!.writable)
        assertEquals(Rsvp.DECLINED, event.myResponse)
        assertEquals(listOf("rosa@fastmail.com", "ana@x.com"), event.attendeeEmails)
        assertTrue(event.attendees.first().isSelf)
        assertTrue(event.attendees[1].optional)
        assertEquals(CalendarAttendeeStatus.TENTATIVE, event.attendees[1].status)
        assertNull(DeviceCalendarRules.event(instance, null, people, emptyList(), zone))
        // Not a guest: nothing to answer, whatever the provider says.
        assertNull(DeviceCalendarRules.event(instance.copy(selfStatus = 1), calendar, emptyList(), emptyList(), zone)!!.myResponse)
    }

    @Test
    fun theSameMeetingOnGoogleAndOnThePhoneMerges() {
        val calendar = DeviceCalendarRules.calendars(listOf(row("3", "Home")), local).single()
        val begin = 1_773_316_800_000L
        val device = DeviceCalendarRules.event(
            DeviceCalendarRules.Instance("42", "3", "Standup", begin, begin + 1_800_000L, false, false, "", "", null, 0),
            calendar, emptyList(), emptyList(), zone,
        )!!
        val google = device.copy(id = "g:x", calendarId = "g:work", source = CalSource.GOOGLE, writable = true)
        val groups = CalendarMerge.consolidate(listOf(device, google), zone)
        assertEquals(1, groups.size)
        // Both can be edited and neither replied to: the first copy leads, as iOS picks.
        assertEquals(device.id, groups.single().event.id)
        assertEquals(listOf("ek:3", "g:work"), groups.single().calendarIds)
        // A Google copy you can reply to leads: the phone's has no reply.
        val invited = google.copy(myResponse = Rsvp.NEEDS_ACTION)
        assertEquals("g:x", CalendarMerge.consolidate(listOf(device, invited), zone).single().event.id)
    }

    @Test
    fun theFirstListIsAdoptedWholeAndLaterOnesAreNew() {
        // Nothing read yet (no access): nothing is seeded.
        assertEquals(null to emptyList<String>(), DeviceCalendarRules.adoptLocal(null, emptySet()))
        val (seen, fresh) = DeviceCalendarRules.adoptLocal(null, setOf("ek:a/b"))
        assertEquals(setOf("ek:a/b"), seen)
        assertTrue(fresh.isEmpty())
        val (next, added) = DeviceCalendarRules.adoptLocal(seen, setOf("ek:a/b", "ek:a/c"))
        assertEquals(setOf("ek:a/b", "ek:a/c"), next)
        assertEquals(listOf("ek:a/c"), added)
        assertEquals(seen to emptyList<String>(), DeviceCalendarRules.adoptLocal(seen, emptySet()))
    }

    @Test
    fun aDeviceResponseMapsAsEventKitsParticipantStatus() {
        assertEquals(Rsvp.ACCEPTED, DeviceCalendarRules.response(1))
        assertEquals(Rsvp.DECLINED, DeviceCalendarRules.response(2))
        assertEquals(Rsvp.NEEDS_ACTION, DeviceCalendarRules.response(3))
        assertEquals(Rsvp.TENTATIVE, DeviceCalendarRules.response(4))
        assertNull(DeviceCalendarRules.response(0))
    }
}
