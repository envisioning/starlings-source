package work.starlings.android.widgets

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import work.starlings.android.Upcoming
import work.starlings.android.UpcomingEvent
import work.starlings.android.UpcomingPlan
import work.starlings.android.UpcomingPreferences
import work.starlings.android.UpcomingTier
import work.starlings.android.workspace.home.HomeFeed
import work.starlings.contracts.CalendarEventWire
import java.time.Instant
import java.time.ZoneId

/**
 * The agenda the app writes for its widgets, and the widgets' readings of
 * it, with no Android in them so the JVM tests reach them. `iOS/AgendaFile.swift`,
 * `WatchBridgeSnapshot.Meeting` and `iOS/StarlingsGlance.swift`.
 *
 * The file holds the raw feed and the owner's Upcoming row count, so a
 * widget derives the same plan Home does, at the clock it renders with
 * (`Upcoming.classify`). Title, times, calendar, first names and the join
 * link: never a token, never a description.
 */
@Serializable
data class WidgetMeeting(
    val id: String,
    val title: String,
    /** ISO 8601, as the feed sent it. */
    val start: String,
    val end: String,
    /** The calendar's name; empty when the feed gave none. */
    val calendar: String = "",
    val allDay: Boolean = false,
    val demoted: Boolean = false,
    val calendarId: String? = null,
    val isVideo: Boolean = false,
    /** Where Join goes. Null: no link, or the owner's own room (hosting is Home's Start room). */
    val join: WidgetJoin? = null,
    /** The other people, by first name, in the feed's order. */
    val attendees: List<String> = emptyList(),
) {
    fun upcoming(): UpcomingEvent = UpcomingEvent(id, title, start, end, allDay, demoted, calendarId)
}

/** `HomeFeed.JoinTarget` on disk: a colleague's room knocks in the app, anything else opens its own app. */
@Serializable
data class WidgetJoin(val kind: Kind, val url: String) {
    @Serializable
    enum class Kind {
        @SerialName("room") ROOM,
        @SerialName("external") EXTERNAL,
    }
}

@Serializable
data class WidgetAgendaFile(
    val schema: Int = SCHEMA,
    /** The signed-in owner the file belongs to, lowercased; a widget reads it for that owner only. */
    val owner: String,
    val savedAtMs: Long,
    /** `UpcomingPreferencesWire.homeFollowingRows`; null keeps the default. */
    val homeFollowingRows: Int? = null,
    val meetings: List<WidgetMeeting>,
) {
    companion object {
        /** Bumped whenever the shape changes; anything else on disk is not read. */
        const val SCHEMA = 1
    }
}

object WidgetAgenda {
    private const val MINUTE_MS = 60_000L

    /** `StarlingsGlance.countdownLead`: ten minutes before the start the glyph surfaces swap to the number. */
    const val COUNTDOWN_LEAD_MS = 10 * MINUTE_MS

    /** Entries kept per timeline on iOS; the next refresh is the first of them. */
    private const val MAX_ENTRIES = 240

    /**
     * `WatchBridgeSnapshot.Meeting(event:now:)`: the bridge shape of one
     * event, or null once it has ended or without a readable start and end.
     */
    fun meeting(e: CalendarEventWire, ownSlug: String?, now: Long): WidgetMeeting? {
        Upcoming.parse(e.start) ?: return null
        val end = Upcoming.parse(e.end) ?: return null
        if (end <= now) return null
        val join = when (val target = HomeFeed.joinTarget(e, ownSlug)) {
            is HomeFeed.JoinTarget.Room -> WidgetJoin(WidgetJoin.Kind.ROOM, target.link)
            is HomeFeed.JoinTarget.External -> WidgetJoin(WidgetJoin.Kind.EXTERNAL, target.url)
            HomeFeed.JoinTarget.OwnRoom, null -> null
        }
        return WidgetMeeting(
            id = e.id,
            title = e.title,
            start = e.start,
            end = e.end,
            calendar = e.calendarSummary,
            allDay = e.allDay,
            demoted = e.demoted,
            calendarId = e.calendarId.ifEmpty { null },
            isVideo = HomeFeed.isVideoMeeting(e),
            join = join,
            attendees = e.attendees.filterNot { it.isSelf }.map { firstName(it.name, it.email) },
        )
    }

    /** `WatchBridgeSnapshot.Meeting.upcoming`: what is still ahead, soonest first. */
    fun meetings(raw: List<CalendarEventWire>, ownSlug: String?, now: Long): List<WidgetMeeting> =
        // The file carries no guest list, so the member rule runs here, on the
        // feed rows, before a widget classifies it.
        raw.filter { Upcoming.isMemberEvent(HomeFeed.upcoming(it)) }
            .mapNotNull { meeting(it, ownSlug, now) }
            .sortedBy { Upcoming.parse(it.start) }

    /** Home's plan at [now], from the file: the same classification, from the same feed. */
    fun plan(file: WidgetAgendaFile?, now: Long, zone: ZoneId = ZoneId.systemDefault()): UpcomingPlan =
        Upcoming.classify(
            file?.meetings.orEmpty().map(WidgetMeeting::upcoming), now, zone,
            UpcomingPreferences.normalize(file?.homeFollowingRows),
        )

    /** The file's meetings behind a plan's events, in the plan's order. */
    fun rows(events: List<UpcomingEvent>, file: WidgetAgendaFile?): List<WidgetMeeting> {
        val byId = file?.meetings.orEmpty().associateBy { it.id }
        return events.mapNotNull { byId[it.id] }
    }

    /** The hero, as the row draws it; null on a closed day. */
    fun focus(plan: UpcomingPlan, file: WidgetAgendaFile?): WidgetMeeting? = plan.focus?.let { rows(listOf(it), file).firstOrNull() }

    /**
     * Today's agenda: the meeting under way, then the ones still to come.
     * The plan already dropped what has ended, every placeholder, and
     * everything on another day.
     */
    fun today(plan: UpcomingPlan, file: WidgetAgendaFile?): List<WidgetMeeting> =
        rows(plan.tiered.getValue(UpcomingTier.NOW) + plan.tiered.getValue(UpcomingTier.TODAY), file)

    /** A countdown belongs to today, as on Home's following rows. */
    fun showsCountdown(m: WidgetMeeting, plan: UpcomingPlan): Boolean =
        !m.allDay && (plan.tiers[m.id] == UpcomingTier.NOW || plan.tiers[m.id] == UpcomingTier.TODAY)

    fun hasStarted(m: WidgetMeeting, now: Long): Boolean = (Upcoming.parse(m.start) ?: Long.MAX_VALUE) <= now

    /** What the number counts to: the start, then the end. Null for an all-day row. */
    fun countdownTarget(m: WidgetMeeting, now: Long): Long? {
        if (m.allDay) return null
        return if (hasStarted(m, now)) Upcoming.parse(m.end) else Upcoming.parse(m.start)
    }

    /** "Starts 14:00" or "Ends 15:00": which clock the number counts to. */
    fun clockTarget(m: WidgetMeeting, now: Long): Long? = if (hasStarted(m, now)) Upcoming.parse(m.end) else Upcoming.parse(m.start)

    /** The who line: up to two first names, then how many more. Empty when the feed named nobody. */
    fun whoLine(names: List<String>): String {
        val named = names.filter { it.isNotEmpty() }
        if (named.isEmpty()) return ""
        val shown = named.take(2).joinToString(", ")
        val more = named.size - minOf(named.size, 2)
        return if (more > 0) "$shown +$more" else shown
    }

    /** A first name from a display name, or the address's local part: a who line is names, never addresses. */
    fun firstName(name: String, email: String): String {
        val first = name.trim().split(Regex("\\s+")).firstOrNull().orEmpty()
        if (first.isNotEmpty()) return first
        return email.substringBefore('@')
    }

    /**
     * `AgendaFile.entryDates`: every moment the answer changes. Each lead,
     * start and end (the hero, the tiers), midnight (today becomes
     * yesterday), and the minutes in between at the pace the countdown
     * wording moves: each minute for an hour, every five for ten hours, then
     * hourly. A widget has no timeline on Android, so the refresh worker
     * wakes at the first of these after [now].
     */
    fun entryDates(now: Long, meetings: List<WidgetMeeting>, zone: ZoneId = ZoneId.systemDefault()): List<Long> {
        val dates = sortedSetOf(now)
        for (m in meetings) {
            val start = Upcoming.parse(m.start) ?: continue
            val end = Upcoming.parse(m.end) ?: continue
            if (end <= now) continue
            for (boundary in listOf(start - COUNTDOWN_LEAD_MS, start, end)) if (boundary > now) dates += boundary + 1_000
        }
        dates += nextMidnight(now, zone) + 1_000
        var tick = now + MINUTE_MS
        while (tick < now + 24 * 60 * MINUTE_MS) {
            dates += tick
            val ahead = tick - now
            tick += when {
                ahead < 60 * MINUTE_MS -> MINUTE_MS
                ahead < 10 * 60 * MINUTE_MS -> 5 * MINUTE_MS
                else -> 60 * MINUTE_MS
            }
        }
        return dates.take(MAX_ENTRIES)
    }

    /** When the widgets next draw something else. */
    fun nextRefresh(now: Long, meetings: List<WidgetMeeting>, zone: ZoneId = ZoneId.systemDefault()): Long =
        entryDates(now, meetings, zone).first { it > now }

    /** The first instant of tomorrow in [zone]. */
    fun nextMidnight(now: Long, zone: ZoneId = ZoneId.systemDefault()): Long =
        Instant.ofEpochMilli(now).atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
}
