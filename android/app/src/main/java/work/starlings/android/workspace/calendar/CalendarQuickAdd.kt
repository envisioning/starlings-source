package work.starlings.android.workspace.calendar

import work.starlings.android.CalendarPeople
import work.starlings.contracts.CalendarQuickAddDraftWire
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Quick add's answer as the editor takes it (`MobileCalendarQuickAddPrefill`
 * and `apply(_:)` in `iOS/MobileCalendarEventEditor.swift`). The draft's
 * times are wall time in the zone it was asked in (`YYYY-MM-DDTHH:MM`), or a
 * `YYYY-MM-DD` day when all day (`fixtures/quick-add.json`).
 */
data class QuickAddPrefill(
    val title: String,
    /** Epoch ms; null when no date was read, and the editor's own slot stands. */
    val start: Long?,
    val end: Long?,
    val allDay: Boolean,
    val location: String?,
    /** Addresses the sentence named; names wait for a contact match. */
    val invitees: List<String>,
    /** Names the sentence named after "with"; the editor adds the contact each one matches. */
    val names: List<String> = emptyList(),
    val confidence: Double,
    /** The grammar read nothing and the notes engine answered. */
    val fromModel: Boolean,
) {
    /** Which footer the editor shows under the calendar. */
    enum class Note { MODEL, NO_DATE, DAY_ONLY, FILLED }

    val note: Note
        get() = when {
            fromModel -> Note.MODEL
            confidence == 0.0 -> Note.NO_DATE
            confidence < 1.0 -> Note.DAY_ONLY
            else -> Note.FILLED
        }

    companion object {
        /** `now` as the request sends it: local wall time, minutes, no offset. */
        val WALL: DateTimeFormatter = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss")

        fun of(draft: CalendarQuickAddDraftWire, fromModel: Boolean, zone: ZoneId, defaultDurationMinutes: Int): QuickAddPrefill {
            val start = draft.start?.let { wall(it, zone) }
            // An all-day end is the exclusive next day; the editor shows the last day (`endDate(inclusiveAllDay:)`).
            val end = draft.end?.let { raw ->
                if (draft.allDay) runCatching { LocalDate.parse(raw).minusDays(1).atStartOfDay(zone).toInstant().toEpochMilli() }.getOrNull()
                else wall(raw, zone)
            }?.let { e -> if (start != null && e < start) start else e }
                ?: start?.let { it + defaultDurationMinutes * 60_000L }
            return QuickAddPrefill(
                title = draft.title,
                start = start,
                end = end,
                allDay = draft.allDay,
                location = draft.location?.trim()?.ifEmpty { null },
                invitees = draft.invitees.flatMap { CalendarPeople.emailCandidates(it) }.distinct(),
                names = draft.invitees.filter { CalendarPeople.emailCandidates(it).isEmpty() }.map { it.trim() }.filter { it.isNotEmpty() },
                confidence = draft.confidence,
                fromModel = fromModel,
            )
        }

        /** A wall time or a day in [zone]; null when neither parses. */
        fun wall(value: String, zone: ZoneId): Long? {
            runCatching { return LocalDateTime.parse(value).atZone(zone).toInstant().toEpochMilli() }
            runCatching { return LocalDate.parse(value).atStartOfDay(zone).toInstant().toEpochMilli() }
            return null
        }
    }
}
