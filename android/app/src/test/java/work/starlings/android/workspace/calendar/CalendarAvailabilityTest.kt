package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.CalendarBusyInterval
import work.starlings.contracts.CalendarFreeBusyPerson
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** `MobileCalendarAvailability`, case by case: no fixture pins free/busy reading. */
class CalendarAvailabilityTest {
    private val zone = ZoneId.of("UTC")
    private val day = LocalDate.of(2026, 10, 28)
    private fun at(t: String) = Instant.parse("2026-10-28T${t}:00Z").toEpochMilli()
    private val ana = CalendarFreeBusyPerson("ana@x.com", listOf(CalendarBusyInterval("2026-10-28T09:00:00Z", "2026-10-28T10:00:00Z")), "")
    private val bo = CalendarFreeBusyPerson("bo@x.com", listOf(CalendarBusyInterval("2026-10-28T09:30:00Z", "2026-10-28T11:00:00Z")), "")
    private val cy = CalendarFreeBusyPerson("cy@y.com", emptyList(), "notFound")

    @Test
    fun busyMergesAcrossPeopleAndSkipsUnreadable() {
        val window = CalendarAvailability.Span(at("08:00"), at("20:00"))
        assertEquals(listOf(CalendarAvailability.Span(at("09:00"), at("11:00"))), CalendarAvailability.busy(listOf(ana, bo, cy), window, zone))
        assertEquals(listOf("cy@y.com"), CalendarAvailability.unreadable(listOf(ana, cy)))
    }

    @Test
    fun conflictsAreHalfOpen() {
        assertEquals(emptyList<String>(), CalendarAvailability.conflicts(listOf(ana), CalendarAvailability.Span(at("10:00"), at("10:30")), zone))
        assertEquals(listOf("ana@x.com", "bo@x.com"), CalendarAvailability.conflicts(listOf(ana, bo, cy), CalendarAvailability.Span(at("09:45"), at("10:15")), zone))
    }

    @Test
    fun windowWidensToHoldTheSlot() {
        assertEquals(CalendarAvailability.Span(at("08:00"), at("20:00")), CalendarAvailability.window(CalendarAvailability.Span(at("09:00"), at("10:00")), day, zone))
        assertEquals(CalendarAvailability.Span(at("06:30"), at("21:00")), CalendarAvailability.window(CalendarAvailability.Span(at("06:30"), at("21:00")), day, zone))
        assertEquals(at("14:00"), CalendarAvailability.pick(CalendarAvailability.Span(at("08:00"), at("20:00")), 0.51f, 15))
    }

    @Test
    fun matches() {
        val people = listOf(CalendarAvailability.Suggestion("ana@x.com", "Ana Lima"), CalendarAvailability.Suggestion("bo@x.com", "Bo"))
        assertEquals(listOf("ana@x.com"), CalendarAvailability.matches(people, "lim", emptyList(), null).map { it.email })
        assertEquals(emptyList<String>(), CalendarAvailability.matches(people, "ana", listOf("ana@x.com"), null).map { it.email })
        assertEquals(emptyList<String>(), CalendarAvailability.matches(people, "bo", emptyList(), "BO@x.com").map { it.email })
        assertEquals(emptyList<String>(), CalendarAvailability.matches(people, " ", emptyList(), null))
    }
}
