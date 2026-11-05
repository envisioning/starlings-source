package work.starlings.android.workspace.home

import work.starlings.android.CalendarKeys
import work.starlings.android.CalendarPeople
import work.starlings.android.ui.AttendeeFace
import work.starlings.android.ui.AttendeeReply
import work.starlings.android.RoomLink
import work.starlings.android.Upcoming
import work.starlings.android.UpcomingAttendee
import work.starlings.android.UpcomingEvent
import work.starlings.android.UpcomingPlan
import work.starlings.contracts.CalendarAttendeeStatus
import work.starlings.contracts.CalendarAttendeeWire
import work.starlings.contracts.CalendarEventWire
import work.starlings.contracts.CalendarMeetingPlatform
import work.starlings.contracts.QuickNote
import work.starlings.contracts.QuickNoteState
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Home's readings of the calendar feed, the clock and the notes, with no
 * Android in them so the JVM tests reach them. Each names the Swift it
 * mirrors. The tiers and the hero are `Upcoming` (Upcoming.kt); this only
 * reads one event the way the phone's rows do.
 */
object HomeFeed {
    /** `CalendarEventSummary.launchURL`: the conference link first, then the room link. */
    fun launchUrl(e: CalendarEventWire): String = e.conferenceUrl.ifEmpty { e.joinUrl }

    /** `isVideoMeeting`: a platform and an explicit link. A map URL in `location` never counts. */
    fun isVideoMeeting(e: CalendarEventWire): Boolean = e.platform != CalendarMeetingPlatform.NONE && launchUrl(e).isNotEmpty()

    /** Ours, so the action and the mark get the accent. */
    fun isStarlingsRoom(e: CalendarEventWire): Boolean = e.platform == CalendarMeetingPlatform.STARLINGS

    /** `demotionKey`: the owner-wide Hide from Next key. */
    fun demotionKey(e: CalendarEventWire): String =
        CalendarKeys.eventDemotion(isSubscription = e.calendarId.startsWith(CalendarKeys.SUBSCRIPTION_PREFIX), eventId = e.id)

    /** The little `Upcoming.classify` reads. */
    fun upcoming(e: CalendarEventWire): UpcomingEvent =
        UpcomingEvent(
            e.id, e.title, e.start, e.end, e.allDay, e.demoted, e.calendarId,
            attendees = e.attendees.map { UpcomingAttendee(it.status.value, it.isSelf) },
        )

    /** The wire rows behind a plan's events, in the plan's order. */
    fun rows(events: List<UpcomingEvent>, raw: List<CalendarEventWire>): List<CalendarEventWire> {
        val byId = raw.associateBy { it.id }
        return events.mapNotNull { byId[it.id] }
    }

    /**
     * `MeetingFeed.alertableMeetings`: the agenda's joinable meetings with a
     * start, less the demoted ones. Not day-bound: tomorrow's standup warns.
     */
    fun alertable(plan: UpcomingPlan, raw: List<CalendarEventWire>): List<CalendarEventWire> =
        rows(plan.agenda, raw).filter { isVideoMeeting(it) && Upcoming.parse(it.start) != null && !it.demoted }

    /** Where a Join goes (`MobileHomeView.join`). Null: the event has nothing to join. */
    sealed interface JoinTarget {
        /** Another member's Starlings room: the knock, through the join flow. */
        data class Room(val link: String) : JoinTarget
        /** The owner's own room: that is hosting, not a knock. */
        data object OwnRoom : JoinTarget
        /** Zoom, Meet, Teams: the app that owns the link. */
        data class External(val url: String) : JoinTarget
    }

    fun joinTarget(e: CalendarEventWire, ownSlug: String?): JoinTarget? {
        if (!isVideoMeeting(e)) return null
        val url = launchUrl(e)
        val path = if (isStarlingsRoom(e)) RoomLink.parse(url) else null
        return when {
            path == null -> JoinTarget.External(url)
            ownSlug != null && path.slug == ownSlug -> JoinTarget.OwnRoom
            else -> JoinTarget.Room(url)
        }
    }

    /** `Platform.actionTitle`. English on iOS too: the literal is not in the catalog. */
    fun actionTitle(platform: CalendarMeetingPlatform): String = when (platform) {
        CalendarMeetingPlatform.STARLINGS -> "Join"
        CalendarMeetingPlatform.GOOGLE_MEET -> "Open Google Meet"
        CalendarMeetingPlatform.ZOOM -> "Open Zoom"
        CalendarMeetingPlatform.TEAMS -> "Open Teams"
        CalendarMeetingPlatform.WEBEX -> "Open Webex"
        CalendarMeetingPlatform.OTHER -> "Open link"
        else -> "Open"
    }

    /** Home is the capture surface: what is still unfiled. Filed notes live in Work. */
    fun openNotes(notes: List<QuickNote>): List<QuickNote> = notes.filter { it.state == QuickNoteState.OPEN }

    /** Notes per page of the card. iOS cuts the page by measured row heights; Android by count. */
    const val NOTES_PER_PAGE = 5

    /** The hero's guests: everyone but you, at most twenty (`MobileNextMeetingCard`). */
    fun guests(e: CalendarEventWire): List<CalendarAttendeeWire> = e.attendees.filterNot { it.isSelf }.take(20)

    /** `StarlingsMobileModels.displayName`: the name, else the address. */
    fun displayName(a: CalendarAttendeeWire): String = a.name.ifEmpty { a.email }

    /** `normalizedEmail`: the first address in `email`, else in `name`. */
    fun normalizedEmail(a: CalendarAttendeeWire): String? =
        CalendarPeople.emailCandidates(a.email).firstOrNull() ?: CalendarPeople.emailCandidates(a.name).firstOrNull()

    fun face(a: CalendarAttendeeWire): AttendeeFace = AttendeeFace(
        displayName(a),
        when (a.status) {
            CalendarAttendeeStatus.ACCEPTED -> AttendeeReply.ACCEPTED
            CalendarAttendeeStatus.DECLINED -> AttendeeReply.DECLINED
            CalendarAttendeeStatus.TENTATIVE -> AttendeeReply.TENTATIVE
            else -> AttendeeReply.PENDING
        },
        isMember = CalendarPeople.isMemberAddress(a.email) || CalendarPeople.isMemberAddress(a.name),
    )

    /** How many rows a list module shows: `HomeLayout.rows(for:)`. */
    fun shown(total: Int, cap: Int): Int = minOf(total, cap)
}

/** `StarlingsDateFormatting.compactDuration`: minutes when close, five-minute steps within ten hours, whole hours after. */
sealed interface Span {
    data object Now : Span
    data class Minutes(val minutes: Int) : Span
    data class Hours(val hours: Int) : Span
    data class HoursMinutes(val hours: Int, val minutes: Int) : Span
}

/** `relativeCountdown`: "in 2h 15m" before, "ends in 40m" during, "ended" after. */
sealed interface Countdown {
    data class Until(val span: Span) : Countdown
    data class EndsIn(val span: Span) : Countdown
    data object Ended : Countdown
}

/** `StarlingsDateFormatting.dayTime`: which day word leads, and the 24-hour clock. */
data class DayTime(val day: Day, val date: LocalDate, val clock: String) {
    enum class Day { TODAY, TOMORROW, OTHER }
}

object HomeClock {
    private val clock = DateTimeFormatter.ofPattern("HH:mm")

    /** Swift's `.rounded()` on a positive value: half away from zero, as `Math.round`. */
    private fun round(x: Double): Int = Math.round(x).toInt()

    fun compactDuration(targetMs: Long, nowMs: Long): Span {
        val total = round(maxOf(0L, targetMs - nowMs) / 60_000.0)
        if (total < 1) return Span.Now
        if (total < 60) return Span.Minutes(total)
        val hours = total / 60
        val minutes = total % 60
        if (hours >= 10) return Span.Hours(maxOf(hours, round(total / 60.0)))
        if (minutes < 8) return Span.Hours(hours)
        val snapped = round(minutes / 5.0) * 5
        if (snapped >= 60) return Span.Hours(hours + 1)
        return Span.HoursMinutes(hours, snapped)
    }

    fun relativeCountdown(startMs: Long?, endMs: Long?, nowMs: Long): Countdown = when {
        startMs != null && startMs > nowMs -> Countdown.Until(compactDuration(startMs, nowMs))
        endMs != null && endMs > nowMs -> Countdown.EndsIn(compactDuration(endMs, nowMs))
        else -> Countdown.Ended
    }

    fun dayTime(atMs: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): DayTime {
        val at = Instant.ofEpochMilli(atMs).atZone(zone)
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val day = when (at.toLocalDate()) {
            today -> DayTime.Day.TODAY
            today.plusDays(1) -> DayTime.Day.TOMORROW
            else -> DayTime.Day.OTHER
        }
        return DayTime(day, at.toLocalDate(), clock.format(at))
    }

    fun time(atMs: Long, zone: ZoneId = ZoneId.systemDefault()): String = clock.format(Instant.ofEpochMilli(atMs).atZone(zone))
}
