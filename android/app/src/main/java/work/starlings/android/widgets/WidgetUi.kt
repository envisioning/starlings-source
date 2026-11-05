package work.starlings.android.widgets

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.Action
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import work.starlings.android.MainActivity
import work.starlings.android.R
import work.starlings.android.StarlingsTokens
import work.starlings.android.Upcoming
import work.starlings.android.workspace.home.HomeClock
import work.starlings.android.workspace.home.HomeLinks
import work.starlings.android.workspace.home.HomeText
import work.starlings.android.workspace.team.MessageNotifier

/**
 * What every widget here draws with: `WidgetInk`, the glyphs, the header,
 * the doors and the words (iOSActivities/StarlingsGlanceRow.swift). The
 * tiles draw dark whatever the phone's appearance, as iOS: the dark rung of
 * each `StarlingsTokens` role, no colour of their own.
 */
internal object WidgetInk {
    val panel: Color = StarlingsTokens.color("panel", dark = true)
    val primary: Color = StarlingsTokens.color("ink", dark = true)
    val secondary: Color = StarlingsTokens.color("inkMuted", dark = true)
    val accent: Color = StarlingsTokens.color("accentMark", dark = true)
}

/** The sizes iOS draws, by name: caption2, caption, subheadline, headline, title. */
internal object WidgetType {
    val caption2: TextUnit = 11.sp
    val caption: TextUnit = 12.sp
    val subheadline: TextUnit = 15.sp
    val headline: TextUnit = 17.sp
    val title: TextUnit = 28.sp
}

internal fun ink(color: Color, size: TextUnit, weight: FontWeight = FontWeight.Normal, align: TextAlign = TextAlign.Start) =
    TextStyle(color = ColorProvider(color), fontSize = size, fontWeight = weight, textAlign = align)

/** The widget's panel: `containerBackground(WidgetInk.panel)`. */
internal fun GlanceModifier.widgetPanel(): GlanceModifier =
    fillMaxSize().background(WidgetInk.panel).cornerRadius(16.dp).padding(14.dp)

/** A glyph beside words, never alone: TalkBack reads the words, so the glyph is silent (`accessibilityHidden`). */
@Composable
internal fun Glyph(res: Int, tint: Color, size: Dp = 12.dp) {
    Image(ImageProvider(res), contentDescription = null, modifier = GlanceModifier.size(size), colorFilter = ColorFilter.tint(ColorProvider(tint)))
}

/** `StarlingsGlyphMark.meeting`: a call is a camera, an in-person meeting is a pin. */
internal fun meetingGlyph(isVideo: Boolean): Int = if (isVideo) R.drawable.widget_ic_video else R.drawable.widget_ic_place

/** The glyph and the word over a tile: `NOW`, `UPCOMING`, `TODAY`, `WORK`. [trailing] sits at the right. */
@Composable
internal fun WidgetHeader(glyph: Int, label: String, trailing: (@Composable () -> Unit)? = null) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Glyph(glyph, WidgetInk.accent)
        Spacer(GlanceModifier.width(4.dp))
        Text(label, style = ink(WidgetInk.secondary, WidgetType.caption2, FontWeight.Bold), maxLines = 1)
        if (trailing != null) {
            Spacer(GlanceModifier.defaultWeight())
            trailing()
        }
    }
}

/**
 * Where a tap goes (`StarlingsGlance.tapURL`): Join where there is a link,
 * else the meeting in the app. A colleague's room knocks through the app's
 * join flow; Zoom, Meet or Teams open in their own app.
 */
internal object WidgetDoors {
    fun open(context: Context, m: WidgetMeeting): Action = m.join?.let { join(context, it) } ?: path(context, event(m))

    fun join(context: Context, j: WidgetJoin): Action = when (j.kind) {
        WidgetJoin.Kind.ROOM -> actionStartActivity(
            Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse(j.url)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        WidgetJoin.Kind.EXTERNAL -> actionStartActivity(Intent(Intent.ACTION_VIEW, Uri.parse(j.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** A workspace web path, through the navigator, as a notification's tap opens one (`MessageNotifier.EXTRA_PATH`). */
    fun path(context: Context, path: String): Action = actionStartActivity(
        Intent(context, MainActivity::class.java).putExtra(MessageNotifier.EXTRA_PATH, path).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
    )

    /** `StarlingsGlance.eventURL`: the meeting, in Calendar. */
    fun event(m: WidgetMeeting): String = HomeLinks.calendarEvent(m.id, m.start)
}

/** The words of `StarlingsGlance`, from the app's strings, on Home's clock. */
internal object WidgetText {
    /** "12m", "2h 15m", "now"; "All day" for a row with no minute to count. */
    fun timer(context: Context, m: WidgetMeeting, now: Long): String =
        WidgetAgenda.countdownTarget(m, now)?.let { HomeText.span(context, HomeClock.compactDuration(it, now)) }
            ?: context.getString(R.string.widget_all_day)

    /** "to go" before the start, "left" after. */
    fun unit(context: Context, m: WidgetMeeting, now: Long): String =
        context.getString(if (WidgetAgenda.hasStarted(m, now)) R.string.widget_left else R.string.widget_to_go)

    /** "Starts 14:00" or "Ends 15:00". */
    fun clockLine(context: Context, m: WidgetMeeting, now: Long): String {
        val time = WidgetAgenda.clockTarget(m, now)?.let { HomeClock.time(it) }.orEmpty()
        return context.getString(if (WidgetAgenda.hasStarted(m, now)) R.string.widget_ends else R.string.widget_starts, time)
    }

    /** A following row's right side: "in 40m" today, "Tomorrow 09:30" after. */
    fun rowWhen(context: Context, m: WidgetMeeting, showsCountdown: Boolean, now: Long): String {
        val start = Upcoming.parse(m.start)
        return if (showsCountdown) HomeText.countdown(context, HomeClock.relativeCountdown(start, Upcoming.parse(m.end), now))
        else start?.let { HomeText.dayTime(context, it, now) }.orEmpty()
    }

    /** "2 overdue · 1 due today"; empty for no rows. */
    fun workSummary(context: Context, rows: List<WidgetWorkRow>): String {
        val (overdue, today) = WidgetWork.counts(rows)
        return listOfNotNull(
            if (overdue > 0) context.getString(R.string.home_overdue_count, overdue) else null,
            if (today > 0) context.getString(R.string.home_due_today_count, today) else null,
        ).joinToString(" · ")
    }
}
