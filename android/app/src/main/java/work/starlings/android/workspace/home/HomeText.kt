package work.starlings.android.workspace.home

import android.content.Context
import android.text.format.DateUtils
import work.starlings.android.CalendarTravel
import work.starlings.android.ClosedDay
import work.starlings.android.R
import work.starlings.android.Upcoming
import work.starlings.android.UpcomingConfig
import work.starlings.android.UpcomingPlan
import work.starlings.android.api.PublicEvent
import work.starlings.contracts.CalendarEventWire
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The words for [HomeFeed]'s readings, from the app's strings. Dates follow
 * the language the app draws in, as `StarlingsDateFormatting.locale`: pt-BR
 * when it draws Portuguese, en-GB otherwise; both on a 24-hour clock.
 */
object HomeText {
    fun locale(context: Context): Locale =
        if (context.resources.configuration.locales[0].language == "pt") Locale.forLanguageTag("pt-BR") else Locale.forLanguageTag("en-GB")

    private fun portuguese(locale: Locale) = locale.language == "pt"

    /** `homeDate`: "Wednesday 28 October", "quarta-feira, 28 de outubro". */
    fun homeDate(context: Context, date: LocalDate): String {
        val l = locale(context)
        val pattern = if (portuguese(l)) "EEEE, d 'de' MMMM" else "EEEE d MMMM"
        return DateTimeFormatter.ofPattern(pattern, l).format(date)
    }

    fun span(context: Context, span: Span): String = when (span) {
        Span.Now -> context.getString(R.string.home_span_now)
        is Span.Minutes -> context.getString(R.string.home_minutes, span.minutes)
        is Span.Hours -> context.getString(R.string.home_hours, span.hours)
        is Span.HoursMinutes -> context.getString(R.string.home_hours_minutes, span.hours, span.minutes)
    }

    fun countdown(context: Context, countdown: Countdown): String = when (countdown) {
        is Countdown.Until -> context.getString(R.string.home_in, span(context, countdown.span))
        is Countdown.EndsIn -> context.getString(R.string.home_ends_in, span(context, countdown.span))
        Countdown.Ended -> context.getString(R.string.home_ended)
    }

    fun countdown(context: Context, e: CalendarEventWire, nowMs: Long): String =
        countdown(context, HomeClock.relativeCountdown(Upcoming.parse(e.start), Upcoming.parse(e.end), nowMs))

    /** `dayTime`: "Today 15:00", "Tomorrow 09:30", "Mon 12 Aug 09:30". */
    fun dayTime(context: Context, atMs: Long, nowMs: Long): String {
        val d = HomeClock.dayTime(atMs, nowMs)
        return when (d.day) {
            DayTime.Day.TODAY -> context.getString(R.string.home_today_at, d.clock)
            DayTime.Day.TOMORROW -> context.getString(R.string.home_tomorrow_at, d.clock)
            DayTime.Day.OTHER -> {
                val l = locale(context)
                val pattern = if (portuguese(l)) "EEE, d 'de' MMM" else "EEE d MMM"
                "${DateTimeFormatter.ofPattern(pattern, l).format(d.date)} ${d.clock}"
            }
        }
    }

    /** `MobileMeetingCountdown.schedule`: the start, the calendar and the subject on the hero, then the travel time. */
    fun schedule(context: Context, e: CalendarEventWire, nowMs: Long, withContext: Boolean): String {
        val parts = mutableListOf<String>()
        Upcoming.parse(e.start)?.let { parts += dayTime(context, it, nowMs) }
        if (withContext) {
            if (e.calendarSummary.isNotEmpty()) parts += e.calendarSummary
            e.subject?.let { parts += it.title }
        }
        CalendarTravel.validMinutes(e.travelTimeMinutes?.toInt())?.let { parts += context.getString(R.string.home_travel, it) }
        return parts.joinToString(" · ")
    }

    /** `MeetingFocus.joinTitle`: the action and the countdown, so the reason for the button is on it. */
    fun joinTitle(context: Context, e: CalendarEventWire, nowMs: Long): String =
        "${HomeFeed.actionTitle(e.platform)} · ${countdown(context, e, nowMs)}"

    /** `plan.heroLabel`. */
    fun heroLabel(context: Context, plan: UpcomingPlan): String =
        if (Upcoming.heroLabel(plan) == UpcomingConfig.SECTION_TITLE) context.getString(R.string.home_upcoming) else context.getString(R.string.home_now)

    /** `closedDaySummary`. */
    fun closedDay(context: Context, plan: UpcomingPlan): String = when (val day = Upcoming.closedDay(plan)) {
        ClosedDay.Empty -> context.getString(R.string.home_closed_empty)
        ClosedDay.Today -> context.getString(R.string.home_closed_today)
        is ClosedDay.Tomorrow -> when {
            day.time != null && day.count == 1 -> context.getString(R.string.home_closed_one_at, day.time)
            day.time != null -> context.getString(R.string.home_closed_many_at, day.count, day.time)
            day.count == 1 -> context.getString(R.string.home_closed_one)
            else -> context.getString(R.string.home_closed_many, day.count)
        }
    }

    /** `MobileHomeEventsCard.eventSchedule`: the day (and time, for a timed one) and the place. */
    fun eventSchedule(context: Context, e: PublicEvent, nowMs: Long): String {
        val l = locale(context)
        val whenText = if (e.isAllDay) {
            runCatching { LocalDate.parse(e.date) }.getOrNull()?.let {
                DateTimeFormatter.ofPattern(if (portuguese(l)) "d 'de' MMM 'de' yyyy" else "d MMM yyyy", l).format(it)
            }
        } else {
            Upcoming.parse(e.startsAt ?: e.date)?.let { dayTime(context, it, nowMs) }
        }
        val place = e.location?.trim().orEmpty()
        return listOfNotNull(whenText, place.ifEmpty { null }).joinToString(" · ")
    }

    /** `QuickNote.detailLabel`: "5 minutes ago", clamped so skew never reads as the future. */
    fun noteAge(createdAt: String, nowMs: Long): String {
        val at = Upcoming.parse(createdAt) ?: return ""
        return DateUtils.getRelativeTimeSpanString(minOf(at, nowMs), nowMs, DateUtils.MINUTE_IN_MILLIS).toString()
    }

    /** `CalendarAttendeeSummary.statusLabel`: English on iOS too. */
    fun reply(context: Context, a: work.starlings.contracts.CalendarAttendeeWire): String = context.getString(
        when (a.status) {
            work.starlings.contracts.CalendarAttendeeStatus.ACCEPTED -> R.string.home_rsvp_accepted
            work.starlings.contracts.CalendarAttendeeStatus.DECLINED -> R.string.home_rsvp_declined
            work.starlings.contracts.CalendarAttendeeStatus.TENTATIVE -> R.string.home_rsvp_tentative
            work.starlings.contracts.CalendarAttendeeStatus.NEEDS_ACTION -> R.string.home_rsvp_pending
            else -> R.string.home_rsvp_unknown
        },
    )

    fun today(zone: ZoneId = ZoneId.systemDefault()): LocalDate = Instant.now().atZone(zone).toLocalDate()
}
