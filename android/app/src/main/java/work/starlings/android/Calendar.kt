package work.starlings.android

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.abs

/**
 * What a timed calendar tile says under its title:
 * `web/src/calendar-tile.ts` and Swift `CalendarTileDetail`, held to
 * `fixtures/calendar-tile.json`. Row order is title, location, time; rows
 * appear as the tile grows, time first, and a row that does not fit whole is
 * not drawn.
 */
object CalendarTile {
    private val clock = DateTimeFormatter.ofPattern("HH:mm")

    /** `GMT`, `GMT+2`, `GMT-5`, `GMT+5:30`: written from the offset, never asked of the platform. */
    fun offsetName(seconds: Int): String {
        if (seconds == 0) return "GMT"
        val sign = if (seconds < 0) "-" else "+"
        val minutes = abs(seconds) / 60
        val rest = minutes % 60
        return if (rest == 0) "GMT$sign${minutes / 60}" else "GMT$sign${minutes / 60}:${"%02d".format(rest)}"
    }

    /** `start – end` in the viewer's zone, then `(HH:mm ZONE)` when the event's zone had another offset that day. */
    fun timeLabel(startMs: Long, endMs: Long, originZone: String?, viewer: ZoneId = ZoneId.systemDefault()): String {
        val start = Instant.ofEpochMilli(startMs)
        var label = "${clock.format(start.atZone(viewer))} – ${clock.format(Instant.ofEpochMilli(endMs).atZone(viewer))}"
        val origin = originZone?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: return label
        val originOffset = origin.rules.getOffset(start).totalSeconds
        if (originOffset != viewer.rules.getOffset(start).totalSeconds) {
            label += " (${clock.format(start.atZone(origin))} ${offsetName(originOffset)})"
        }
        return label
    }

    data class Rows(val time: Boolean, val location: Boolean)

    /** Which rows a tile of `height` holds. The title keeps one line when a row shows. */
    fun rows(height: Float, titleHeight: Float, rowHeight: Float, padding: Float, hasLocation: Boolean): Rows {
        var remaining = height - padding - titleHeight
        val time = remaining >= rowHeight
        if (time) remaining -= rowHeight
        return Rows(time, hasLocation && time && remaining >= rowHeight)
    }

    /** The meeting platform's name, for an event that has only a link. Null for none. */
    fun platformLabel(platform: String): String? = when (platform) {
        "zoom" -> "Zoom"
        "google_meet" -> "Google Meet"
        "envisioning" -> "Starlings"
        "teams" -> "Teams"
        "none" -> null
        else -> "Meeting link"
    }

    /** The place, or the platform's name when the event has only a link. */
    fun place(location: String?, platform: String): String? =
        location?.trim()?.ifEmpty { null } ?: platformLabel(platform)
}

/**
 * The keys calendar choices are stored under: `packages/contracts/src/calendar-keys.ts`
 * and `Sources/CalendarKeys.swift`, held to `fixtures/calendar-keys.json`.
 * `hidden_calendar_keys` and `disabled_calendar_keys` are owner-wide.
 */
object CalendarKeys {
    const val GOOGLE_PREFIX = "g:"
    const val SUBSCRIPTION_PREFIX = "sub:"
    const val EVENT_KIT_PREFIX = "ek:"
    const val EVENT_KIT_SEPARATOR = "/"
    const val ACCOUNT_PREFIX = "account:"
    const val EVENT_PREFIX = "event:"
    const val GOOGLE_EVENT_PREFIX = "event:g:"

    /** Every subscribed feed at once; never derived from the localized group title. */
    const val SUBSCRIBED_ACCOUNT = "${ACCOUNT_PREFIX}subscribed"

    fun google(calendarId: String) = GOOGLE_PREFIX + calendarId
    fun subscription(id: String) = SUBSCRIPTION_PREFIX + id
    fun eventKit(account: String, title: String) = EVENT_KIT_PREFIX + account.lowercase() + EVENT_KIT_SEPARATOR + title.lowercase()
    fun account(title: String) = ACCOUNT_PREFIX + title.lowercase()

    /** "Google" for one account, its address once there are two or more. */
    fun googleAccountTitle(email: String?, namesAccounts: Boolean) = if (namesAccounts && !email.isNullOrEmpty()) email else "Google"

    /** An event hidden from Next: a feed's row by its own id, a Google row as `event:g:` and its id. */
    fun eventDemotion(isSubscription: Boolean, eventId: String) = (if (isSubscription) EVENT_PREFIX else GOOGLE_EVENT_PREFIX) + eventId

    /** Show or hide one calendar. Showing one inside a hidden account expands the account key into its siblings. */
    fun withCalendarHidden(keys: List<String>, key: String, accountKey: String, siblingKeys: List<String>, hidden: Boolean): List<String> {
        val next = keys.toMutableSet()
        if (hidden) {
            next += key
        } else {
            if (next.remove(accountKey)) next += siblingKeys.filter { it != key }
            next -= key
        }
        return next.sorted()
    }

    /** Show or hide a whole account: its own key stands for every calendar, present and future. */
    fun withAccountHidden(keys: List<String>, key: String, memberKeys: List<String>, hidden: Boolean): List<String> {
        val next = keys.toMutableSet()
        next -= memberKeys.toSet()
        if (hidden) next += key else next -= key
        return next.sorted()
    }
}

/** `fixtures/meeting-kinds.json`: how a meeting is filed, and the subject kind it files under. */
object MeetingKinds {
    data class Kind(val kind: String, val label: String, val subject: String?)

    val all = listOf(
        Kind("uncategorized", "Unfiled", null),
        Kind("status", "Status", null),
        Kind("lead", "Lead", "lead"),
        Kind("project", "Project", "project"),
        Kind("internal", "Internal", null),
        Kind("partner", "Partner", "organization"),
        Kind("event", "Event", "event"),
        Kind("personal", "Personal", null),
    )
}

/** `fixtures/calendar-values.json`: the Calendar surface's fixed choices. */
object CalendarValues {
    data class Layer(val kind: String, val title: String, val caption: String)
    data class Rsvp(val response: String, val title: String)
    data class ScheduleZone(val id: String, val zone: String, val city: String, val code: String)

    val layers = listOf(
        Layer("events", "Events", "Published company events"),
        Layer("milestones", "Milestones", "Project milestones"),
        Layer("tasks", "Tasks", "Dated tasks"),
        Layer("availability", "Availability", "When guests can book you"),
    )
    val travelMinutes = listOf(0, 15, 30, 45, 60)
    val rsvpAnswers = listOf(Rsvp("accepted", "Accept"), Rsvp("tentative", "Maybe"), Rsvp("declined", "Decline"))
    val scheduleTimeZones = listOf(
        ScheduleZone("losAngeles", "America/Los_Angeles", "Los Angeles", "LAX"),
        ScheduleZone("newYork", "America/New_York", "New York", "NYC"),
        ScheduleZone("saoPaulo", "America/Sao_Paulo", "São Paulo", "SAO"),
        ScheduleZone("lisbon", "Europe/Lisbon", "Lisbon", "LIS"),
        ScheduleZone("london", "Europe/London", "London", "LON"),
        ScheduleZone("amsterdam", "Europe/Amsterdam", "Amsterdam", "AMS"),
        ScheduleZone("riyadh", "Asia/Riyadh", "Riyadh", "RUH"),
        ScheduleZone("dubai", "Asia/Dubai", "Dubai", "DXB"),
        ScheduleZone("mumbai", "Asia/Kolkata", "Mumbai", "BOM"),
        ScheduleZone("tokyo", "Asia/Tokyo", "Tokyo", "TYO"),
    )
}
