package work.starlings.android

import work.starlings.contracts.CalendarAttendeeStatus
import work.starlings.contracts.CalendarAttendeeWire
import work.starlings.contracts.CalendarEventReply
import work.starlings.contracts.CalendarEventSubject
import work.starlings.contracts.CalendarEventWire
import work.starlings.contracts.CalendarMeetingPlatform
import work.starlings.contracts.CalendarSemanticRole
import work.starlings.contracts.CalendarSubscription
import work.starlings.contracts.GoogleCalendarListEntry
import work.starlings.contracts.SubscriptionEventSummary
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

/**
 * The Calendar tab's rules, ported from Swift: the calendars and events as
 * `CalendarWorkspace` builds them from the wire (`googleCalendars(from:)`,
 * `googleEvent(from:)`, `subscribedEvent(from:)`), the merge of one event on
 * several calendars (`CalendarWeekMath.consolidate`), the day and agenda reads
 * (`MobileCalendarStore.groups(on:)`, `agenda(for:)`), the layouts
 * (`MobileCalendarLayout`) and the timed packer (`CalendarWeekMath.pack`).
 * No Android types here, so `CalendarAgendaTest` runs on the JVM.
 */
/** `StarlingsCalendar.Source`. [DEVICE] is iOS `.eventKit`: the phone's own calendars, through CalendarContract. */
enum class CalSource { GOOGLE, SUBSCRIPTION, DEVICE }

/** `StarlingsRGBColor`: `palette`, `fallback(at:)`, `hex(_:)`. Colours are `0xFFRRGGBB`. */
object CalendarColors {
    val palette: List<Long> = listOf(
        rgb(0.22, 0.47, 0.90), rgb(0.83, 0.18, 0.18), rgb(0.15, 0.55, 0.38), rgb(0.61, 0.35, 0.71),
        rgb(0.90, 0.49, 0.13), rgb(0.18, 0.66, 0.66), rgb(0.75, 0.22, 0.47), rgb(0.40, 0.45, 0.53),
    )

    /** `CalendarLayerPalette.globalInterest`. */
    val globalInterest: Long = rgb(0.710, 0.835, 0.208)

    fun fallback(index: Int): Long = palette[Math.floorMod(index, palette.size)]

    fun hex(value: String?): Long? {
        val hex = value?.trim()?.removePrefix("#") ?: return null
        if (hex.length != 6) return null
        val packed = hex.toLongOrNull(16) ?: return null
        return 0xFF000000L or packed
    }

    /** `luminance > 0.62`: the threshold `contrastingInk` uses. */
    fun isLight(color: Long): Boolean {
        val r = ((color shr 16) and 0xFF) / 255.0
        val g = ((color shr 8) and 0xFF) / 255.0
        val b = (color and 0xFF) / 255.0
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62
    }

    private fun rgb(r: Double, g: Double, b: Double): Long =
        0xFF000000L or ((Math.round(r * 255) shl 16) or (Math.round(g * 255) shl 8) or Math.round(b * 255))
}

/** `StarlingsCalendar`: Google through the Worker, subscribed feeds, and the phone's own calendars. */
data class CalCalendar(
    val id: String,
    val source: CalSource,
    val rawId: String,
    val title: String,
    val groupTitle: String,
    val writable: Boolean,
    val color: Long,
    val accountEmail: String? = null,
) {
    /** `CalendarSemanticRole(calendarTitle:source:)`: the build's own workspace only. */
    val role: CalendarSemanticRole
        get() = if (source == CalSource.GOOGLE && title.trim().equals(GLOBAL_INTEREST_TITLE, ignoreCase = true)) {
            CalendarSemanticRole.GLOBAL_INTEREST
        } else {
            CalendarSemanticRole.ORDINARY
        }

    val displayColor: Long get() = if (role == CalendarSemanticRole.GLOBAL_INTEREST) CalendarColors.globalInterest else color

    /** `isMemberAccount`: only an event on a member Google account can be filed. */
    val isMemberAccount: Boolean get() = source == CalSource.GOOGLE && CalendarPeople.isMemberAddress(accountEmail.orEmpty())

    /** `canBeWriteTarget`: writable, and never the shared company calendar by default. */
    val canBeWriteTarget: Boolean get() = writable && role != CalendarSemanticRole.GLOBAL_INTEREST

    /** `canBeMoveTarget`. */
    val canBeMoveTarget: Boolean get() = writable && role != CalendarSemanticRole.GLOBAL_INTEREST

    /** `visibilityKey`. */
    val visibilityKey: String
        get() = when (source) {
            CalSource.GOOGLE -> CalendarKeys.google(rawId)
            CalSource.SUBSCRIPTION -> CalendarKeys.subscription(rawId)
            CalSource.DEVICE -> CalendarKeys.eventKit(groupTitle, title)
        }

    /** `accountVisibilityKey(groupTitle)`. */
    val accountKey: String get() = if (source == CalSource.SUBSCRIPTION) CalendarKeys.SUBSCRIBED_ACCOUNT else CalendarKeys.account(groupTitle)

    /** `CalendarSourceSettings.isHidden` / `isDisabled`: the calendar's key or its account's. */
    fun isIn(keys: Collection<String>): Boolean = visibilityKey in keys || accountKey in keys

    companion object {
        /** `CalendarSemanticRole.globalInterestCalendarTitle`: "\(orgName) Internal", matched as data. */
        const val GLOBAL_INTEREST_TITLE = "Envisioning Internal"

        /** `CalendarWorkspace.googleCalendars(from:)`: "Google" for one account, each address once there are more. */
        fun google(entries: List<GoogleCalendarListEntry>, namesAccounts: Boolean): List<CalCalendar> =
            entries.mapIndexed { index, entry ->
                CalCalendar(
                    id = CalendarKeys.google(entry.id),
                    source = CalSource.GOOGLE,
                    rawId = entry.id,
                    title = entry.summary,
                    groupTitle = CalendarKeys.googleAccountTitle(entry.accountEmail, namesAccounts),
                    writable = entry.writable,
                    color = CalendarColors.hex(entry.backgroundColor) ?: CalendarColors.fallback(index),
                    accountEmail = entry.accountEmail.ifEmpty { null },
                )
            }

        /** `refreshSubscriptions`: read-only, under the one Subscribed group. */
        fun subscriptions(list: List<CalendarSubscription>, groupTitle: String): List<CalCalendar> =
            list.mapIndexed { index, s ->
                CalCalendar(
                    id = CalendarKeys.subscription(s.id),
                    source = CalSource.SUBSCRIPTION,
                    rawId = s.id,
                    title = s.title,
                    groupTitle = groupTitle,
                    writable = false,
                    color = CalendarColors.hex(s.color) ?: CalendarColors.fallback(index + 7),
                )
            }
    }
}

/** `CalendarRSVP`: the owner's own reply. Null on an event means nothing to answer. */
enum class Rsvp(val wire: String) {
    ACCEPTED("accepted"), DECLINED("declined"), TENTATIVE("tentative"), NEEDS_ACTION("needsAction");

    /** What can be sent back; `needsAction` is a state, not an answer. */
    val reply: CalendarEventReply? get() = CalendarEventReply.entries.firstOrNull { it.value == wire }

    companion object {
        fun of(raw: String): Rsvp? = entries.firstOrNull { it.wire == raw }

        /** `CalendarRSVP.answers`, in `CalendarValues.rsvpAnswers` order. */
        val answers: List<Rsvp> = CalendarValues.rsvpAnswers.mapNotNull { of(it.response) }
    }
}

/** `CalendarAttendance`: who else is coming. The owner is never counted. */
enum class Attendance {
    CONFIRMED, PENDING, DECLINED;

    companion object {
        fun of(attendees: List<CalendarAttendeeWire>): Attendance? {
            val others = attendees.filter { !it.isSelf }
            if (others.isEmpty()) return null
            val coming = others.filter { it.status != CalendarAttendeeStatus.DECLINED }
            if (coming.isEmpty()) return DECLINED
            return if (coming.all { it.status == CalendarAttendeeStatus.ACCEPTED }) CONFIRMED else PENDING
        }
    }
}

/** `CalendarAttendeeSummary.isMemberAddress` and `emailCandidates`. */
object CalendarPeople {
    private val address = Regex("[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")

    fun emailCandidates(value: String): List<String> =
        address.findAll(value.trim()).map { it.value.lowercase() }.toList()

    fun isMemberAddress(value: String): Boolean =
        emailCandidates(value).any { it.substringAfterLast('@') in Contracts.identityDomains }
}

/** `CalendarMeetingPlatform.inferred`: one provider answer for every calendar surface. */
object MeetingPlatforms {
    private val teams = Regex("^(?:microsoft\\s+teams|teams)(?:\\s+meeting)?$")
    private val googleMeet = Regex("^(?:google\\s+meet)(?:\\s+meeting)?$")
    private val zoom = Regex("^(?:zoom)(?:\\s+meeting)?$")
    private val webex = Regex("^(?:webex)(?:\\s+meeting)?$")
    private val http = Regex("https?://")

    /** [ownHosts]: the workspace's own hosts, lowercase; our room only there. */
    fun inferred(joinUrl: String, location: String, roomSlug: String, ownHosts: List<String>): CalendarMeetingPlatform {
        if (roomSlug.isNotBlank()) return CalendarMeetingPlatform.STARLINGS
        val haystack = "$joinUrl\n$location".lowercase()
        if (ownHosts.any { haystack.contains("$it/room/") }) return CalendarMeetingPlatform.STARLINGS
        if (haystack.contains("meet.google.com") || haystack.contains("hangouts.google.com")) return CalendarMeetingPlatform.GOOGLE_MEET
        if (haystack.contains("zoom.us") || haystack.contains("zoom.com")) return CalendarMeetingPlatform.ZOOM
        if (haystack.contains("teams.microsoft.com") || haystack.contains("teams.live.com")) return CalendarMeetingPlatform.TEAMS
        if (haystack.contains("webex.com")) return CalendarMeetingPlatform.WEBEX
        val label = location.trim().lowercase()
        if (teams.matches(label)) return CalendarMeetingPlatform.TEAMS
        if (googleMeet.matches(label)) return CalendarMeetingPlatform.GOOGLE_MEET
        if (zoom.matches(label)) return CalendarMeetingPlatform.ZOOM
        if (webex.matches(label)) return CalendarMeetingPlatform.WEBEX
        return if (http.containsMatchIn(haystack)) CalendarMeetingPlatform.OTHER else CalendarMeetingPlatform.NONE
    }

    /** `MeetingInvite.roomSlug(fromJoinURL:)`, for a feed row's link. */
    fun roomSlug(url: String): String? = if (url.contains("://")) RoomLink.parse(url)?.slug else null
}

/** `CalendarTravelTime`. */
object CalendarTravel {
    fun validMinutes(minutes: Int?): Int? = minutes?.takeIf { it in 1..(24 * 60) }
}

/** `CalendarDateParsing`: an instant, else a bare `yyyy-MM-dd` at local midnight. */
object CalendarDates {
    fun parse(value: String, zone: ZoneId): Long? {
        runCatching { return OffsetDateTime.parse(value).toInstant().toEpochMilli() }
        runCatching { return Instant.parse(value).toEpochMilli() }
        if (value.length < 10) return null
        val day = runCatching { LocalDate.parse(value.take(10)) }.getOrNull() ?: return null
        return day.atStartOfDay(zone).toInstant().toEpochMilli()
    }

    fun isAllDay(value: String, flagged: Boolean): Boolean =
        flagged || (value.length == 10 && value.all { it.isDigit() || it == '-' })

    fun day(ms: Long, zone: ZoneId): LocalDate = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()

    fun startOfDay(day: LocalDate, zone: ZoneId): Long = day.atStartOfDay(zone).toInstant().toEpochMilli()
}

/** `StarlingsCalendarEvent`, as the phone reads it from the Worker. Times are epoch ms. */
data class CalEvent(
    val id: String,
    val calendarId: String,
    val rawEventId: String,
    val title: String,
    val start: Long,
    val end: Long,
    val allDay: Boolean,
    val writable: Boolean,
    val recurring: Boolean,
    val joinUrl: String,
    val roomSlug: String,
    val attendeeEmails: List<String>,
    val attendees: List<CalendarAttendeeWire>,
    val source: CalSource,
    val recurringEventId: String = "",
    val notes: String = "",
    val location: String = "",
    val startTimeZone: String? = null,
    val travelTimeMinutes: Int? = null,
    val myResponse: Rsvp? = null,
    val demoted: Boolean = false,
    val role: CalendarSemanticRole = CalendarSemanticRole.ORDINARY,
    val subject: CalendarEventSubject? = null,
    val platform: CalendarMeetingPlatform = CalendarMeetingPlatform.NONE,
) {
    /** The trimmed title, or null where the screen says "New Event". */
    val shownTitle: String? get() = title.trim().ifEmpty { null }

    val attendance: Attendance? get() = Attendance.of(attendees)

    /** EventKit has no reply API; Android reads Google only, so a Google invitee can reply. */
    val canRespond: Boolean get() = source == CalSource.GOOGLE && myResponse != null && rawEventId.isNotEmpty()

    val canMoveBetweenCalendars: Boolean
        get() = writable && source != CalSource.SUBSCRIPTION && role != CalendarSemanticRole.GLOBAL_INTEREST

    /** `demotionKey`: Google as `event:g:<calendar>:<raw>`, a feed or device row as `event:<id>`. */
    val demotionKey: String
        get() = when (source) {
            CalSource.GOOGLE -> CalendarKeys.eventDemotion(false, "${calendarId.removePrefix(CalendarKeys.GOOGLE_PREFIX)}:$rawEventId")
            CalSource.SUBSCRIPTION, CalSource.DEVICE -> "${CalendarKeys.EVENT_PREFIX}$id"
        }

    fun isPast(now: Long): Boolean = end <= now

    /** The Google calendar id the write routes take (`calendarID.dropFirst(2)`). */
    val googleCalendarId: String get() = calendarId.removePrefix(CalendarKeys.GOOGLE_PREFIX)

    /** `googleTarget`: the series id when the whole series is meant. */
    fun googleTarget(wholeSeries: Boolean): String =
        if (wholeSeries && recurringEventId.isNotEmpty()) recurringEventId else rawEventId

    companion object {
        private const val HOUR = 3_600_000L
        private const val MINUTE = 60_000L

        /** `googleEvent(from:calendars:)`: null when its calendar is not listed or the start does not parse. */
        fun google(wire: CalendarEventWire, calendars: List<CalCalendar>, ownHosts: List<String>, zone: ZoneId): CalEvent? {
            val calendarId = CalendarKeys.google(wire.calendarId)
            val calendar = calendars.firstOrNull { it.id == calendarId } ?: return null
            val start = CalendarDates.parse(wire.start, zone) ?: return null
            val end = CalendarDates.parse(wire.end, zone) ?: (start + HOUR)
            val prefix = "${wire.calendarId}:"
            val raw = if (wire.id.startsWith(prefix)) wire.id.removePrefix(prefix) else wire.id
            // `launchURL`: the conference first, then Meet's own room field.
            val join = wire.conferenceUrl.ifEmpty { wire.joinUrl }
            val self = wire.attendees.firstOrNull { it.isSelf }
            return CalEvent(
                id = "g:${wire.calendarId}:$raw",
                calendarId = calendar.id,
                rawEventId = raw,
                title = wire.title,
                start = start,
                end = maxOf(end, start + MINUTE),
                allDay = CalendarDates.isAllDay(wire.start, wire.allDay),
                writable = calendar.writable,
                recurring = wire.recurring,
                joinUrl = join,
                roomSlug = wire.roomSlug,
                attendeeEmails = wire.attendees.map { it.email.trim() }.filter { it.isNotEmpty() },
                attendees = wire.attendees,
                source = CalSource.GOOGLE,
                recurringEventId = wire.recurringEventId,
                notes = wire.description,
                location = wire.location,
                startTimeZone = wire.startTimeZone,
                travelTimeMinutes = wire.travelTimeMinutes?.toInt(),
                myResponse = self?.let { Rsvp.of(it.status.value) },
                demoted = wire.demoted,
                role = if (wire.calendarRole == CalendarSemanticRole.ORDINARY) calendar.role else wire.calendarRole,
                subject = wire.subject,
                platform = MeetingPlatforms.inferred(join, wire.location, wire.roomSlug, ownHosts),
            )
        }

        /** `subscribedEvent(from:calendars:)`: read-only, no guests, no reply. */
        fun subscription(
            summary: SubscriptionEventSummary,
            calendars: List<CalCalendar>,
            demotedKeys: Set<String>,
            ownHosts: List<String>,
            zone: ZoneId,
        ): CalEvent? {
            val calendarId = CalendarKeys.subscription(summary.subscriptionId)
            if (calendars.none { it.id == calendarId }) return null
            val start = CalendarDates.parse(summary.start, zone) ?: return null
            val end = CalendarDates.parse(summary.end, zone) ?: (start + HOUR)
            val join = if (summary.url.startsWith("http")) summary.url else ""
            val slug = MeetingPlatforms.roomSlug(summary.url).orEmpty()
            val event = CalEvent(
                id = summary.id,
                calendarId = calendarId,
                rawEventId = summary.id,
                title = summary.title,
                start = start,
                end = maxOf(end, start + MINUTE),
                allDay = summary.allDay,
                writable = false,
                recurring = summary.recurring,
                joinUrl = join,
                roomSlug = slug,
                attendeeEmails = emptyList(),
                attendees = emptyList(),
                source = CalSource.SUBSCRIPTION,
                notes = summary.description,
                location = summary.location,
                platform = MeetingPlatforms.inferred(join, summary.location, slug, ownHosts),
            )
            return event.copy(demoted = event.demotionKey in demotedKeys)
        }
    }
}

/** `CalendarEventGroup`: one drawn block, wearing every calendar it came from. */
data class CalGroup(val event: CalEvent, val calendarIds: List<String>) {
    val id: String get() = event.id
}

object CalendarMerge {
    /** `CalendarWeekMath.consolidate`: same title, same slot; one copy per calendar merges. */
    fun consolidate(events: List<CalEvent>, zone: ZoneId): List<CalGroup> {
        val byKey = LinkedHashMap<String, MutableList<CalEvent>>()
        for (e in events) byKey.getOrPut(fingerprint(e, zone)) { mutableListOf() }.add(e)
        return byKey.values.flatMap { members ->
            val seen = mutableSetOf<String>()
            val merged = mutableListOf<CalEvent>()
            val separate = mutableListOf<CalEvent>()
            for (m in members) if (seen.add(m.calendarId)) merged += m else separate += m
            val lead = representative(merged)
            listOfNotNull(lead?.let { CalGroup(it, merged.map(CalEvent::calendarId)) }) +
                separate.map { CalGroup(it, listOf(it.calendarId)) }
        }
    }

    /** All-day copies key on days: sources disagree about an all-day end as an instant. */
    fun fingerprint(e: CalEvent, zone: ZoneId): String {
        val title = (e.shownTitle ?: "").lowercase()
        if (e.allDay) {
            val last = maxOf(e.start, e.end - 1_000)
            return listOf(title, "all-day", CalendarDates.day(e.start, zone).toString(), CalendarDates.day(last, zone).toString()).joinToString("|")
        }
        return listOf(title, e.start.toString(), e.end.toString(), "false").joinToString("|")
    }

    /** Prefer a copy that can be replied to, then one that can be edited. */
    private fun representative(events: List<CalEvent>): CalEvent? =
        events.firstOrNull { it.canRespond && it.writable }
            ?: events.firstOrNull { it.canRespond }
            ?: events.firstOrNull { it.writable }
            ?: events.firstOrNull()

    /** Whether an all-day event covers [day]: its first day through the day before its exclusive end. */
    fun allDayCovers(e: CalEvent, day: LocalDate, zone: ZoneId): Boolean {
        val first = CalendarDates.day(e.start, zone)
        val last = CalendarDates.day(maxOf(e.start, e.end - 1_000), zone)
        return !day.isBefore(first) && !day.isAfter(last)
    }

    /** `groups(on:)`: everything touching the day, all-day first, then by start. */
    fun groupsOn(day: LocalDate, events: List<CalEvent>, zone: ZoneId): List<CalGroup> {
        val dayStart = CalendarDates.startOfDay(day, zone)
        val dayEnd = CalendarDates.startOfDay(day.plusDays(1), zone)
        val touching = events.filter { e -> if (e.allDay) allDayCovers(e, day, zone) else e.start < dayEnd && e.end > dayStart }
        return consolidate(touching, zone).sortedWith(compareBy<CalGroup> { !it.event.allDay }.thenBy { it.event.start })
    }

    data class DaySection(val day: LocalDate, val groups: List<CalGroup>)

    /** `agenda(for:)`: by day, empty days left out. */
    fun agenda(days: List<LocalDate>, events: List<CalEvent>, zone: ZoneId): List<DaySection> =
        days.map { DaySection(it, groupsOn(it, events, zone)) }.filter { it.groups.isNotEmpty() }

    /** `displayedEvents` with the defaults: declined shown, hidden from Next left out. */
    fun displayed(events: List<CalEvent>, showsDeclined: Boolean = true, showsHidden: Boolean = false): List<CalEvent> =
        events.filter { (showsDeclined || it.myResponse != Rsvp.DECLINED) && (showsHidden || !it.demoted) }
}

/** `MobileCalendarLayout`: how the period on screen is drawn. */
enum class CalendarLayout(val wire: String) {
    DAY("day"), TWO_DAY("twoDay"), THREE_DAY("threeDay"), MONTH("month"), AGENDA("agenda");

    val isTimeGrid: Boolean get() = this == DAY || this == TWO_DAY || this == THREE_DAY

    fun days(anchor: LocalDate, firstDayOfWeek: DayOfWeek): List<LocalDate> = when (this) {
        DAY -> run(anchor, 1)
        TWO_DAY -> run(anchor, 2)
        THREE_DAY -> run(anchor, 3)
        // The 42 cells: whole weeks around the month.
        MONTH -> run(anchor.withDayOfMonth(1).with(TemporalAdjusters.previousOrSame(firstDayOfWeek)), 42)
        // The same rolling seven days the Mac grid and the web page show.
        AGENDA -> run(anchor, 7)
    }

    /** One day for the day grids (any day can lead a window), a month, a week for the list. */
    fun step(anchor: LocalDate, direction: Int): LocalDate = when (this) {
        DAY, TWO_DAY, THREE_DAY -> anchor.plusDays(direction.toLong())
        MONTH -> anchor.plusMonths(direction.toLong())
        AGENDA -> anchor.plusWeeks(direction.toLong())
    }

    private fun run(start: LocalDate, count: Int) = (0 until count).map { start.plusDays(it.toLong()) }

    companion object {
        fun of(raw: String?): CalendarLayout? = entries.firstOrNull { it.wire == raw }
    }
}

/** `CalendarTimedSpan` / `CalendarPackedSpan` and `CalendarWeekMath.pack`. */
data class TimedSpan(val id: String, val start: Long, val end: Long)

data class PackedSpan(val id: String, val column: Int, val columnCount: Int) {
    /** Colliding cards cascade: each lane a fixed step further right, running to the day's edge. */
    val leadingFraction: Double
        get() = if (columnCount <= 1 || column <= 0) 0.0 else minOf(0.34, 0.8 / columnCount) * column

    val widthFraction: Double get() = 1 - leadingFraction
}

object CalendarPacking {
    /** The part of a timed event inside one day, or null when it misses the day. */
    fun daySegment(e: CalEvent, day: LocalDate, zone: ZoneId): TimedSpan? {
        if (e.allDay) return null
        val dayStart = CalendarDates.startOfDay(day, zone)
        val dayEnd = CalendarDates.startOfDay(day.plusDays(1), zone)
        if (e.start >= dayEnd || e.end <= dayStart) return null
        return TimedSpan(e.id, maxOf(e.start, dayStart), minOf(e.end, dayEnd))
    }

    fun pack(spans: List<TimedSpan>): List<PackedSpan> {
        val ordered = spans.sortedWith(compareBy<TimedSpan> { it.start }.thenByDescending { it.end })
        val columnById = HashMap<String, Int>()
        val active = mutableListOf<Pair<TimedSpan, Int>>()
        val clusters = mutableListOf<List<String>>()
        var current = mutableListOf<String>()
        var clusterEnd = Long.MIN_VALUE
        for (span in ordered) {
            active.removeAll { it.first.end <= span.start }
            if (span.start >= clusterEnd) {
                if (current.isNotEmpty()) clusters += current
                current = mutableListOf()
                clusterEnd = span.end
            } else {
                clusterEnd = maxOf(clusterEnd, span.end)
            }
            current += span.id
            val used = active.map { it.second }.toSet()
            var column = 0
            while (column in used) column++
            columnById[span.id] = column
            active += span to column
        }
        if (current.isNotEmpty()) clusters += current
        val countById = HashMap<String, Int>()
        for (cluster in clusters) {
            val width = (cluster.mapNotNull { columnById[it] }.maxOrNull() ?: 0) + 1
            cluster.forEach { countById[it] = width }
        }
        return ordered.map { PackedSpan(it.id, columnById[it.id] ?: 0, maxOf(1, countById[it.id] ?: 1)) }
    }

    /** `snapUp`: the next slot of [minutes], never already past. */
    fun snapUp(ms: Long, minutes: Int): Long {
        val step = minutes * 60_000L
        return ((ms + step - 1) / step) * step
    }
}
