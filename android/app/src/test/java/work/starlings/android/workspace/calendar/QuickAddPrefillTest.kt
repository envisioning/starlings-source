package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CalendarQuickAddDraftWire
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/** Quick add's answer into the editor, on the shapes `fixtures/quick-add.json` pins. */
class QuickAddPrefillTest {
    private val zone = ZoneId.of("Europe/Lisbon")
    private fun at(value: String) = LocalDateTime.parse(value).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun timedDraftIsWallTime() {
        val read = QuickAddPrefill.of(
            CalendarQuickAddDraftWire("Coffee", "2026-09-24T14:00", "2026-09-24T14:45", false, " Ground ", listOf("Ana", "bo@x.com"), 1.0),
            fromModel = false, zone = zone, defaultDurationMinutes = 60,
        )
        assertEquals(at("2026-09-24T14:00"), read.start)
        assertEquals(at("2026-09-24T14:45"), read.end)
        assertEquals("Ground", read.location)
        assertEquals(listOf("bo@x.com"), read.invitees)
        assertEquals(listOf("Ana"), read.names)
        assertEquals(QuickAddPrefill.Note.FILLED, read.note)
    }

    @Test
    fun allDayEndIsTheLastDay() {
        val read = QuickAddPrefill.of(
            CalendarQuickAddDraftWire("Board offsite", "2026-10-03", "2026-10-06", true, null, emptyList(), 1.0),
            fromModel = false, zone = zone, defaultDurationMinutes = 60,
        )
        assertEquals(LocalDate.of(2026, 10, 5).atStartOfDay(zone).toInstant().toEpochMilli(), read.end)
    }

    @Test
    fun noDateKeepsTheTitleOnly() {
        val read = QuickAddPrefill.of(CalendarQuickAddDraftWire("Dentist", null, null, false, null, emptyList(), 0.0), false, zone, 60)
        assertNull(read.start)
        assertNull(read.end)
        assertEquals(QuickAddPrefill.Note.NO_DATE, read.note)
        assertEquals(QuickAddPrefill.Note.MODEL, read.copy(fromModel = true).note)
        assertEquals(QuickAddPrefill.Note.DAY_ONLY, read.copy(confidence = 0.5).note)
    }
}
