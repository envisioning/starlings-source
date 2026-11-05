package work.starlings.android.workspace.calendar

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

/**
 * The `CalendarContract` values [DeviceCalendars] writes, as
 * `EventKitCalendarStore` sets an `EKEvent`. No Android types, so the
 * mapping runs on the JVM (`DeviceCalendarWritesTest`).
 *
 * - A timed event is two instants and the zone it was made in.
 * - An all-day event is UTC midnights with the zone `UTC`, as the provider
 *   requires; the dates are the ones the phone's zone shows.
 * - A series row carries `duration`, not `dtend`, and the rule stays as it
 *   is: Starlings edits no recurrence, as iOS edits none.
 */
object DeviceCalendarWrites {
    /** What an edit says about the event. A null [location] or [notes] leaves the stored value alone. */
    data class Values(
        val title: String,
        val start: Long,
        val end: Long,
        val allDay: Boolean,
        val location: String?,
        val notes: String?,
    )

    // `CalendarContract` column names, spelled out so the rules run on the JVM.
    const val CALENDAR_ID = "calendar_id"
    const val EVENT_ID = "event_id"
    const val TITLE = "title"
    const val DTSTART = "dtstart"
    const val DTEND = "dtend"
    const val DURATION = "duration"
    const val EVENT_TIMEZONE = "eventTimezone"
    const val EVENT_END_TIMEZONE = "eventEndTimezone"
    const val ALL_DAY = "allDay"
    const val RRULE = "rrule"
    const val RDATE = "rdate"
    const val EXRULE = "exrule"
    const val EXDATE = "exdate"
    const val EVENT_LOCATION = "eventLocation"
    const val DESCRIPTION = "description"
    const val AVAILABILITY = "availability"
    const val ACCESS_LEVEL = "accessLevel"
    const val HAS_ALARM = "hasAlarm"
    const val ORIGINAL_INSTANCE_TIME = "originalInstanceTime"
    const val STATUS = "eventStatus"
    /** `Events.STATUS_CANCELED`. */
    const val STATUS_CANCELED = 2
    const val UTC = "UTC"

    /** What a move copies to the other calendar: the event as stored, its rule included. */
    val MOVED_COLUMNS = listOf(
        TITLE, DTSTART, DTEND, DURATION, EVENT_TIMEZONE, EVENT_END_TIMEZONE, ALL_DAY,
        RRULE, RDATE, EXRULE, EXDATE, EVENT_LOCATION, DESCRIPTION, AVAILABILITY, ACCESS_LEVEL, HAS_ALARM,
    )
    val ATTENDEE_COLUMNS = listOf("attendeeName", "attendeeEmail", "attendeeRelationship", "attendeeType", "attendeeStatus")
    val REMINDER_COLUMNS = listOf("minutes", "method")

    /** The stored start, end and zone. An all-day event covers at least one date. */
    data class Times(val start: Long, val end: Long, val timeZone: String)

    fun times(values: Values, zone: ZoneId): Times {
        if (!values.allDay) return Times(values.start, maxOf(values.end, values.start + 60_000L), zone.id)
        val (first, after) = dates(values, zone)
        return Times(utcMidnight(first), utcMidnight(after), UTC)
    }

    /** The first date and the date after the last, in the phone's zone. The end is exclusive. */
    private fun dates(values: Values, zone: ZoneId): Pair<LocalDate, LocalDate> {
        val first = local(values.start, zone)
        val after = local(values.end, zone)
        return first to (if (after.isAfter(first)) after else first.plusDays(1))
    }

    /**
     * `storedLocation(_:link:)`: a typed place wins; with none, the link takes
     * the slot so the phone's calendar shows it. Null stays null: the caller
     * left it alone. The provider has no URL column, so the link lives here.
     */
    fun storedLocation(location: String?, link: String?): String? {
        location ?: return null
        if (location.isNotBlank()) return location
        return link?.ifEmpty { null } ?: location
    }

    /** One event, not a series: create, or edit in place. */
    fun eventRow(values: Values, zone: ZoneId): Map<String, Any?> {
        val times = times(values, zone)
        return buildMap {
            put(TITLE, values.title)
            put(DTSTART, times.start)
            put(DTEND, times.end)
            put(EVENT_TIMEZONE, times.timeZone)
            put(EVENT_END_TIMEZONE, null)
            put(ALL_DAY, if (values.allDay) 1 else 0)
            putFields(values)
        }
    }

    /**
     * The whole series, from one occurrence. The first start moves by the
     * days the occurrence moved and takes its new time of day; the length is
     * the occurrence's. [seriesStart] is the series row's `dtstart`;
     * [originalTime] is the occurrence's [instanceTime].
     */
    fun seriesRow(
        values: Values,
        seriesStart: Long,
        seriesAllDay: Boolean,
        originalTime: Long,
        occurrenceAllDay: Boolean,
        zone: ZoneId,
    ): Map<String, Any?> {
        val wasOn = if (occurrenceAllDay) utc(originalTime) else local(originalTime, zone)
        val shift = ChronoUnit.DAYS.between(wasOn, local(values.start, zone))
        val firstDate = (if (seriesAllDay) utc(seriesStart) else local(seriesStart, zone)).plusDays(shift)
        return buildMap {
            put(TITLE, values.title)
            if (values.allDay) {
                val (first, after) = dates(values, zone)
                put(DTSTART, utcMidnight(firstDate))
                put(DURATION, "P${ChronoUnit.DAYS.between(first, after)}D")
                put(EVENT_TIMEZONE, UTC)
            } else {
                val time = Instant.ofEpochMilli(values.start).atZone(zone).toLocalTime()
                put(DTSTART, firstDate.atTime(time).atZone(zone).toInstant().toEpochMilli())
                put(DURATION, "P${maxOf(60L, (values.end - values.start) / 1000)}S")
                put(EVENT_TIMEZONE, zone.id)
            }
            put(DTEND, null)
            put(EVENT_END_TIMEZONE, null)
            put(ALL_DAY, if (values.allDay) 1 else 0)
            putFields(values)
        }
    }

    /** This occurrence only: an exception row at its original time. */
    fun exceptionRow(values: Values, originalTime: Long, zone: ZoneId): Map<String, Any?> =
        eventRow(values, zone) + (ORIGINAL_INSTANCE_TIME to originalTime)

    /** This occurrence deleted: a cancelled exception at its original time. */
    fun cancelledRow(originalTime: Long): Map<String, Any?> =
        mapOf(ORIGINAL_INSTANCE_TIME to originalTime, STATUS to STATUS_CANCELED)

    /**
     * The occurrence's time as the provider stores it: the start for a timed
     * one; for an all-day one, the UTC midnight of the date the phone shows
     * (the read turned that midnight into the phone's, [DeviceCalendarRules.allDaySpan]).
     */
    fun instanceTime(start: Long, allDay: Boolean, zone: ZoneId): Long =
        if (allDay) utcMidnight(local(start, zone)) else start

    private fun MutableMap<String, Any?>.putFields(values: Values) {
        values.location?.let { put(EVENT_LOCATION, it) }
        values.notes?.let { put(DESCRIPTION, it) }
    }

    private fun local(ms: Long, zone: ZoneId): LocalDate = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
    private fun utc(ms: Long): LocalDate = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()
    private fun utcMidnight(day: LocalDate): Long = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
}
