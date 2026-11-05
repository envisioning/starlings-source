package work.starlings.android

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * What "upcoming" means: `packages/contracts/src/upcoming.ts` and
 * `Sources/MeetingFocus.swift`, held to `fixtures/upcoming-tiers.json`. The
 * knobs are `packages/contracts/src/upcoming-config.json`, which
 * `UpcomingFixtureTest` holds these constants to.
 */
object UpcomingConfig {
    const val VERSION = 1
    const val SECTION_TITLE = "UPCOMING"
    const val HORIZON_DAYS = 2
    const val REQUEST_SLACK_DAYS = 1
    const val HOME_FOLLOWING_ROWS = 2
    const val JOIN_WINDOW_MINUTES = 10
    const val SHOW_TOMORROW = true
    const val MAX_AGENDA_EVENTS = 40
    val placeholderTitles = listOf("", "block", "blank", "(no title)")

    const val REQUEST_HOURS = (HORIZON_DAYS + REQUEST_SLACK_DAYS) * 24
}

enum class UpcomingTier(val wire: String) { NOW("now"), TODAY("today"), TOMORROW("tomorrow"), AHEAD("ahead"), UNSCHEDULED("unscheduled") }

/** The little a calendar row has to expose to be placed. Not the wire type. */
data class UpcomingEvent(
    val id: String,
    val title: String,
    /** ISO 8601. Unparseable or absent means `unscheduled`. */
    val start: String?,
    /** ISO 8601. Without a readable end an event is never on the agenda. */
    val end: String?,
    val allDay: Boolean,
    /** Owner-wide Hide from Next. */
    val demoted: Boolean,
    /** Shared source identity, to collapse copies on several calendars. */
    val calendarId: String? = null,
    /**
     * The guest list as the feed sent it, empty when the event has no guests.
     * Null: the source carries no participation facts, and `isMemberEvent`
     * does not judge it.
     */
    val attendees: List<UpcomingAttendee>? = null,
)

/** What the member rule reads of one guest. `isSelf` marks the member's own row. */
data class UpcomingAttendee(val status: String, val isSelf: Boolean)

data class UpcomingPreferences(
    val horizonDays: Int = UpcomingConfig.HORIZON_DAYS,
    val homeFollowingRows: Int = UpcomingConfig.HOME_FOLLOWING_ROWS,
    val showTomorrow: Boolean = UpcomingConfig.SHOW_TOMORROW,
) {
    companion object {
        /**
         * `normalizeUpcomingPreferences`: Home is fixed to today and tomorrow,
         * so only the row count is the owner's, clamped to 0..5.
         */
        fun normalize(homeFollowingRows: Int?): UpcomingPreferences =
            UpcomingPreferences(homeFollowingRows = homeFollowingRows?.coerceIn(0, 5) ?: UpcomingConfig.HOME_FOLLOWING_ROWS)
    }
}

data class UpcomingPlan(
    /** Everything still relevant, soonest first. */
    val agenda: List<UpcomingEvent>,
    val tiers: Map<String, UpcomingTier>,
    val tiered: Map<UpcomingTier, List<UpcomingEvent>>,
    /** The hero. Null is a closed day: it never falls through to tomorrow. */
    val focus: UpcomingEvent?,
    val preferences: UpcomingPreferences,
    /** The compact Home rows after the hero. */
    val homeRows: List<UpcomingEvent>,
    /** Today-tier events behind the compact Home foldout. */
    val remainingToday: List<UpcomingEvent>,
) {
    fun count(tier: UpcomingTier): Int = tiered[tier]?.size ?: 0
}

/** What a closed day's summary is written from. The sentence is the surface's. */
sealed interface ClosedDay {
    data object Empty : ClosedDay
    data object Today : ClosedDay
    data class Tomorrow(val count: Int, val time: String?) : ClosedDay
}

object Upcoming {
    private const val DAY_MS = 24L * 60 * 60 * 1000
    private const val JOIN_WINDOW_MS = UpcomingConfig.JOIN_WINDOW_MINUTES * 60L * 1000
    private val placeholders = UpcomingConfig.placeholderTitles.toSet()
    private val clock = DateTimeFormatter.ofPattern("HH:mm")

    fun hasRealMeetingTitle(title: String): Boolean = title.trim().lowercase() !in placeholders

    /** Whether the hero shows a button: from ten minutes before until the end. */
    fun canJoin(event: UpcomingEvent, now: Long): Boolean {
        val start = parse(event.start) ?: return false
        val end = parse(event.end) ?: return false
        return start - JOIN_WINDOW_MS <= now && now < end
    }

    /** `classifyUpcoming`. A null zone is the device's own, which is what the app wants. */
    fun classify(
        events: List<UpcomingEvent>,
        now: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        preferences: UpcomingPreferences = UpcomingPreferences(),
    ): UpcomingPlan {
        val horizonMs = preferences.horizonDays * DAY_MS
        val today = civilDay(now, zone)
        // Judge each copy before copies collapse, so the copy that survives is
        // one on the member's own calendar.
        val agenda = consolidate(events.filter(::isMemberEvent))
            .filter { onAgenda(it, now, horizonMs) }
            .sortedWith(::compareByStart)
            .filter { tierOf(it, now, today, zone) in setOf(UpcomingTier.NOW, UpcomingTier.TODAY, UpcomingTier.TOMORROW) }

        val tiers = agenda.associate { it.id to tierOf(it, now, today, zone) }
        val tiered = UpcomingTier.entries.associateWith { tier -> agenda.filter { tiers[it.id] == tier } }
        val isToday = { e: UpcomingEvent -> tiers[e.id] == UpcomingTier.NOW || tiers[e.id] == UpcomingTier.TODAY }

        val focus = agenda.firstOrNull { isToday(it) && !it.demoted && !it.allDay }
        val homeRows = agenda
            .filter { it.id != focus?.id }
            // While today is active the card is about today; once it is closed,
            // the same rows become tomorrow's summary.
            .filter { if (focus != null) isToday(it) else tiers[it.id] == UpcomingTier.TOMORROW }
            .take(preferences.homeFollowingRows)
        val shown = (listOfNotNull(focus) + homeRows).filter(isToday).map { it.id }.toSet()
        val remainingToday = (tiered.getValue(UpcomingTier.NOW) + tiered.getValue(UpcomingTier.TODAY)).filter { it.id !in shown }

        return UpcomingPlan(agenda, tiers, tiered, focus, preferences, homeRows, remainingToday)
    }

    /** "NOW" once the hero's meeting has started; the section title before. */
    fun heroLabel(plan: UpcomingPlan): String =
        if (plan.focus != null && plan.tiers[plan.focus.id] == UpcomingTier.NOW) "NOW" else UpcomingConfig.SECTION_TITLE

    fun closedDay(plan: UpcomingPlan, zone: ZoneId = ZoneId.systemDefault()): ClosedDay {
        if (plan.agenda.isEmpty()) return ClosedDay.Empty
        if (!plan.preferences.showTomorrow) return ClosedDay.Today
        val tomorrow = plan.tiered.getValue(UpcomingTier.TOMORROW)
        val first = tomorrow.firstOrNull() ?: return ClosedDay.Today
        val time = parse(first.start)?.let { clock.format(Instant.ofEpochMilli(it).atZone(zone)) }
        return ClosedDay.Tomorrow(tomorrow.size, time)
    }

    /**
     * `isMemberEvent` in packages/contracts/src/upcoming.ts, which gives the
     * reasons: Home shows an event only when the member organizes or attends
     * it and has not declined. Own calendar (`primary`, `acct:<account>:primary`):
     * stays unless the member's `self` row is declined. Subscribed feed: stays.
     * Any other calendar: dropped. No calendar id or no guest list: stays.
     */
    fun isMemberEvent(e: UpcomingEvent): Boolean {
        val attendees = e.attendees ?: return true
        val calendar = e.calendarId?.trim().orEmpty()
        if (calendar.isEmpty()) return true
        if (calendar.startsWith(CalendarKeys.SUBSCRIPTION_PREFIX)) return true
        if (calendar.replace(secondAccountCalendar, "") != "primary") return false
        return attendees.none { it.isSelf && it.status == "declined" }
    }

    private val secondAccountCalendar = Regex("^acct:[^:]+:")

    /** Collapse one event copied onto several calendars; keep real copies on one. */
    private fun consolidate(events: List<UpcomingEvent>): List<UpcomingEvent> =
        events.groupBy(::fingerprint).values.flatMap { members ->
            val source = members.firstNotNullOfOrNull { it.calendarId?.trim()?.ifEmpty { null } }
            members.filter { m ->
                val calendar = m.calendarId?.trim()?.ifEmpty { null }
                source == null || calendar == null || calendar == source
            }
        }

    private fun fingerprint(e: UpcomingEvent): String {
        val calendar = e.calendarId?.trim()
        val start = parse(e.start)
        val end = parse(e.end)
        if (calendar.isNullOrEmpty() || start == null || end == null) return "unparseable|${calendar ?: ""}|${e.id}"
        return listOf(e.title.trim().lowercase(), start, end, e.allDay).joinToString("|")
    }

    private fun onAgenda(e: UpcomingEvent, now: Long, horizonMs: Long): Boolean {
        if (e.demoted || e.allDay) return false
        val end = parse(e.end) ?: return false
        if (end <= now || !hasRealMeetingTitle(e.title)) return false
        val start = parse(e.start)
        return start == null || start <= now + horizonMs
    }

    private fun tierOf(e: UpcomingEvent, now: Long, today: Long, zone: ZoneId): UpcomingTier {
        val start = parse(e.start) ?: return UpcomingTier.UNSCHEDULED
        if (!e.allDay && start <= now) return UpcomingTier.NOW
        val offset = civilDay(start, zone) - today
        return when {
            offset <= 0 -> UpcomingTier.TODAY
            offset == 1L -> UpcomingTier.TOMORROW
            else -> UpcomingTier.AHEAD
        }
    }

    /** Soonest first, undated last, ties on id so every client keeps one order. */
    private fun compareByStart(left: UpcomingEvent, right: UpcomingEvent): Int {
        val l = parse(left.start)
        val r = parse(right.start)
        if (l == null || r == null) {
            if (l != null) return -1
            if (r != null) return 1
            val byEnd = (parse(left.end) ?: 0).compareTo(parse(right.end) ?: 0)
            if (byEnd != 0) return byEnd
        } else if (l != r) {
            return l.compareTo(r)
        }
        return left.id.compareTo(right.id)
    }

    /** The civil date at an instant in the viewer's zone, as a day number. */
    fun civilDay(ms: Long, zone: ZoneId): Long = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toEpochDay()

    fun parse(value: String?): Long? {
        if (value.isNullOrEmpty()) return null
        return runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
    }
}

/** One meeting's warning, decided before any notification type exists. */
data class MeetingNotice(val eventId: String, val title: String, val start: Long, val fireAt: Long)

/** `Sources/MeetingAlertPlan.swift`, held to `fixtures/meeting-alerts.json`. */
object MeetingAlertPlan {
    /** The nearest thirty-two win, as on iOS and the Mac. */
    const val MAX_SCHEDULED = 32
    val leadChoices = listOf(1, 2, 5, 10, 15)

    /**
     * A demoted row never warns, an all-day block has no minute to warn at,
     * and a meeting already inside the lead window is skipped.
     */
    fun plan(meetings: List<UpcomingEvent>, now: Long, leadMs: Long): List<MeetingNotice> =
        meetings.mapNotNull { e ->
            if (e.demoted || e.allDay) return@mapNotNull null
            val start = Upcoming.parse(e.start) ?: return@mapNotNull null
            val fireAt = start - leadMs
            if (fireAt <= now) null else MeetingNotice(e.id, e.title, start, fireAt)
        }.sortedBy { it.fireAt }.take(MAX_SCHEDULED)
}
