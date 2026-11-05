package work.starlings.android.workspace.calendar

import android.content.Context
import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.PersonOutline
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.VideoCall
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import work.starlings.android.Attendance
import work.starlings.android.CalEvent
import work.starlings.android.CalGroup
import work.starlings.android.CalendarColors
import work.starlings.android.CalendarTravel
import work.starlings.android.R
import work.starlings.android.Rsvp
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.CalendarMeetingPlatform
import work.starlings.contracts.CalendarSemanticRole
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * `iOS/MobileCalendarChrome.swift`: the metrics, formats and event looks the
 * agenda, month and day grids share, so they cannot drift apart. The clock is
 * 24-hour everywhere (`meetTimeString`).
 */
object CalendarChrome {
    const val PAST_ALPHA = 0.72f
    const val DEMOTED_ALPHA = 0.4f
    val stripeWidth = 3.dp
    val cornerRadius = 6.dp
    /** `gutterWidth(hasSecondaryTimeZone:)`: wider when a second clock rides beside the hours. */
    fun gutterWidth(hasSecondaryZone: Boolean) = if (hasSecondaryZone) 48.dp else 32.dp

    private val clock = DateTimeFormatter.ofPattern("HH:mm")

    fun time(ms: Long, zone: ZoneId): String = clock.format(Instant.ofEpochMilli(ms).atZone(zone))

    /** A localized date from a skeleton ("EEEEMMMMd"), as `Date.formatted(.dateTime…)`. */
    fun date(day: LocalDate, skeleton: String, locale: Locale = Locale.getDefault()): String =
        DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale).format(day)

    fun fillAlpha(response: Rsvp?, selected: Boolean = false): Float = when {
        selected -> 0.32f
        response == Rsvp.DECLINED -> 0.07f
        else -> 0.18f
    }

    fun fade(event: CalEvent, now: Long): Float =
        (if (event.demoted) DEMOTED_ALPHA else 1f) * (if (event.isPast(now)) PAST_ALPHA else 1f)

    fun color(argb: Long): Color = Color(argb.toInt())

    fun rsvpLabel(context: Context, rsvp: Rsvp): String = context.getString(
        when (rsvp) {
            Rsvp.ACCEPTED -> R.string.cal_rsvp_accepted
            Rsvp.DECLINED -> R.string.cal_rsvp_declined
            Rsvp.TENTATIVE -> R.string.cal_rsvp_tentative
            Rsvp.NEEDS_ACTION -> R.string.cal_rsvp_pending
        },
    )

    fun title(context: Context, event: CalEvent): String = event.shownTitle ?: context.getString(R.string.cal_new_event)

    /** `timeRangeLabel`: "All day", or `09:00 – 10:00`. */
    fun timeRange(context: Context, event: CalEvent, zone: ZoneId): String =
        if (event.allDay) context.getString(R.string.cal_all_day) else "${time(event.start, zone)} – ${time(event.end, zone)}"

    fun travel(context: Context, minutes: Int?): String? =
        CalendarTravel.validMinutes(minutes)?.let { context.getString(R.string.cal_travel_minutes, it) }

    /** `CalendarMeetingPlatform.displayName`: brand names, the same in every language. */
    fun platformName(platform: CalendarMeetingPlatform): String = when (platform) {
        CalendarMeetingPlatform.STARLINGS -> "Starlings"
        CalendarMeetingPlatform.GOOGLE_MEET -> "Google Meet"
        CalendarMeetingPlatform.ZOOM -> "Zoom"
        CalendarMeetingPlatform.TEAMS -> "Teams"
        CalendarMeetingPlatform.WEBEX -> "Webex"
        CalendarMeetingPlatform.OTHER -> "Link"
        else -> "Calendar"
    }

    /** `CalendarAccessibility.describe`: the same phrasing in the list and the grids. */
    fun describe(context: Context, event: CalEvent, calendarName: String?, zone: ZoneId): String {
        val parts = mutableListOf(title(context, event))
        if (event.role == CalendarSemanticRole.GLOBAL_INTEREST) parts += context.getString(R.string.cal_a11y_global)
        if (event.demoted) parts += context.getString(R.string.cal_a11y_hidden)
        parts += if (event.allDay) context.getString(R.string.cal_a11y_all_day)
        else context.getString(R.string.cal_a11y_range, time(event.start, zone), time(event.end, zone))
        parts += date(CalendarDatesUi.day(event.start, zone), "EEEEdMMMM")
        if (!calendarName.isNullOrEmpty()) parts += calendarName
        if (event.location.isNotEmpty()) parts += context.getString(R.string.cal_a11y_at, event.location)
        travel(context, event.travelTimeMinutes)?.let { parts += it }
        event.myResponse?.let { parts += rsvpLabel(context, it) }
        event.attendance?.let {
            parts += context.getString(
                when (it) {
                    Attendance.CONFIRMED -> R.string.cal_a11y_guests_confirmed
                    Attendance.PENDING -> R.string.cal_a11y_guests_pending
                    Attendance.DECLINED -> R.string.cal_a11y_guests_declined
                },
            )
        }
        if (event.recurring) parts += context.getString(R.string.cal_a11y_repeating)
        if (event.platform != CalendarMeetingPlatform.NONE) parts += platformName(event.platform)
        if (event.joinUrl.isNotEmpty()) parts += context.getString(R.string.cal_a11y_link)
        if (!event.writable) parts += context.getString(R.string.cal_a11y_read_only)
        return parts.joinToString(", ")
    }
}

internal object CalendarDatesUi {
    fun day(ms: Long, zone: ZoneId): LocalDate = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
}

/** The minute clock past rows recede on (`TimelineView(.periodic(by: 60))`). */
@Composable
fun rememberMinuteClock(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000 - System.currentTimeMillis() % 60_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

/** `MobileMeetingPlatformMark`: where the meeting is. Decorative; the row's label names it. */
@Composable
fun PlatformMark(platform: CalendarMeetingPlatform, tint: Color, size: Int = 14) {
    val icon: ImageVector = when (platform) {
        CalendarMeetingPlatform.STARLINGS -> Icons.Filled.Videocam
        CalendarMeetingPlatform.GOOGLE_MEET -> Icons.Outlined.VideoCall
        CalendarMeetingPlatform.ZOOM -> Icons.Outlined.Videocam
        CalendarMeetingPlatform.TEAMS -> Icons.Outlined.Groups
        CalendarMeetingPlatform.WEBEX -> Icons.Outlined.Call
        else -> Icons.Outlined.Link
    }
    Icon(icon, null, Modifier.size(size.dp), tint = tint)
}

/** The company's own mark, for a Global interest event (the Starlings glyph on iOS). */
@Composable
fun WorkspaceMark(tint: Color, size: Int = 14) {
    Icon(Icons.Filled.Business, null, Modifier.size(size.dp), tint = tint)
}

/** `MobileCalendarAttendanceMark`: who is coming. */
@Composable
fun AttendanceMark(attendance: Attendance, declined: Boolean, size: Int = 14) {
    val c = Starlings.colors
    val icon = when (attendance) {
        Attendance.CONFIRMED -> Icons.Filled.HowToReg
        Attendance.PENDING -> Icons.Filled.PersonOutline
        Attendance.DECLINED -> Icons.Filled.PersonOff
    }
    Icon(icon, null, Modifier.size(size.dp), tint = if (declined || attendance != Attendance.CONFIRMED) c.secondary else c.primary)
}

/** `MobileCalendarDayDivider`: TODAY in the accent, TOMORROW, then the weekday and date. */
@Composable
fun DayDivider(day: LocalDate) {
    val c = Starlings.colors
    val today = LocalDate.now()
    val title = when (day) {
        today -> stringResource(R.string.cal_today_caps)
        today.plusDays(1) -> stringResource(R.string.cal_tomorrow_caps)
        else -> CalendarChrome.date(day, "EEEEMMMMd").uppercase(Locale.getDefault())
    }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = if (day == today) c.accent else c.secondary)
        HorizontalDivider(Modifier.weight(1f), thickness = 1.dp, color = c.border)
    }
}

/**
 * `MobileCalendarAgendaRow`: colour bar, title, time, then the place (or
 * the calendar) and travel; the platform and guest marks at the end.
 */
@Composable
fun AgendaRow(group: CalGroup, colors: List<Long>, calendarTitle: String, now: Long, zone: ZoneId, onClick: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val event = group.event
    val declined = event.myResponse == Rsvp.DECLINED
    val shape = RoundedCornerShape(StarlingsRadius.control)
    val label = CalendarChrome.describe(context, event, calendarTitle, zone)
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(CalendarChrome.fade(event, now))
            .clip(shape)
            .background(c.elevated, shape)
            .border(1.dp, c.border, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(44.dp).background(CalendarChrome.color(colors.firstOrNull() ?: CalendarColors.fallback(0)), RoundedCornerShape(2.dp)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                CalendarChrome.title(context, event),
                style = StarlingsType.headline.copy(textDecoration = if (declined) TextDecoration.LineThrough else null),
                color = c.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(CalendarChrome.timeRange(context, event, zone), style = StarlingsType.caption, color = c.secondary)
            val detail = listOfNotNull(event.location.ifEmpty { calendarTitle }, CalendarChrome.travel(context, event.travelTimeMinutes))
                .filter { it.isNotEmpty() }
                .joinToString(" · ")
            if (detail.isNotEmpty()) {
                Text(detail, style = StarlingsType.caption2, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (event.platform != CalendarMeetingPlatform.NONE) {
            PlatformMark(event.platform, if (event.platform == CalendarMeetingPlatform.STARLINGS) c.accent else c.secondary)
        }
        event.attendance?.let { AttendanceMark(it, declined) }
        if (event.role == CalendarSemanticRole.GLOBAL_INTEREST && event.platform == CalendarMeetingPlatform.NONE) {
            Box(Modifier.fillMaxHeight(), contentAlignment = Alignment.TopCenter) { WorkspaceMark(c.primary) }
        }
    }
}

/**
 * `MobileCalendarEventBlock` as a one-line chip (the month cells) or a
 * block (the day grid): a light tint so the hour rules read through it, the
 * calendar's colour in a leading stripe, an unanswered invitation outlined.
 */
@Composable
fun EventBlock(group: CalGroup, colors: List<Long>, now: Long, zone: ZoneId, compact: Boolean, modifier: Modifier = Modifier, showsTime: Boolean = !compact, onClick: (() -> Unit)? = null) {
    val c = Starlings.colors
    val context = LocalContext.current
    val event = group.event
    val declined = event.myResponse == Rsvp.DECLINED
    val primary = CalendarChrome.color(colors.firstOrNull() ?: CalendarColors.fallback(0))
    val shape = RoundedCornerShape(CalendarChrome.cornerRadius)
    val label = CalendarChrome.describe(context, event, null, zone)
    Row(
        modifier
            .alpha(CalendarChrome.fade(event, now))
            .clip(shape)
            .background(c.canvas)
            .background(primary.copy(alpha = CalendarChrome.fillAlpha(event.myResponse)))
            .then(if (event.myResponse == Rsvp.NEEDS_ACTION) Modifier.border(1.dp, primary.copy(alpha = 0.8f), shape) else Modifier)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .clearAndSetSemantics { contentDescription = label; if (onClick != null) role = Role.Button },
    ) {
        // Split between every calendar carrying this event.
        Column(Modifier.width(CalendarChrome.stripeWidth).fillMaxHeight()) {
            val painted = colors.ifEmpty { listOf(CalendarColors.fallback(0)) }
            painted.forEach { Box(Modifier.weight(1f).fillMaxWidth().background(CalendarChrome.color(it).copy(alpha = if (declined) 0.45f else 1f))) }
        }
        Column(Modifier.weight(1f).padding(start = 5.dp, end = 4.dp, top = if (compact) 1.dp else 3.dp, bottom = if (compact) 1.dp else 3.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Text(
                    CalendarChrome.title(context, event),
                    Modifier.weight(1f),
                    style = (if (compact) StarlingsType.caption2.copy(fontSize = 10.sp) else StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold))
                        .copy(textDecoration = if (declined) TextDecoration.LineThrough else null),
                    color = if (declined) c.secondary else c.primary,
                    maxLines = if (compact || showsTime) 1 else 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!compact) {
                    if (event.platform != CalendarMeetingPlatform.NONE) {
                        Spacer(Modifier.width(2.dp))
                        PlatformMark(event.platform, if (event.platform == CalendarMeetingPlatform.STARLINGS && !declined) c.accent else c.secondary)
                    } else if (event.role == CalendarSemanticRole.GLOBAL_INTEREST) {
                        Spacer(Modifier.width(2.dp))
                        WorkspaceMark(if (declined) c.secondary else c.primary)
                    }
                    event.attendance?.let { Spacer(Modifier.width(2.dp)); AttendanceMark(it, declined) }
                }
            }
            if (showsTime && !compact && !event.allDay) {
                Text(
                    work.starlings.android.CalendarTile.timeLabel(event.start, event.end, event.startTimeZone, zone),
                    style = StarlingsType.caption2.copy(fontSize = 10.sp),
                    color = c.secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
