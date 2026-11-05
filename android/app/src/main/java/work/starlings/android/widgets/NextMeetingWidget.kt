package work.starlings.android.widgets

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import work.starlings.android.MainActivity
import work.starlings.android.R
import work.starlings.android.StarlingsApp
import work.starlings.android.UpcomingPlan
import work.starlings.android.workspace.home.HomeText

/** The clock a redraw renders at, written by [WidgetRefresh.run]; absent on the first draw. */
internal val WIDGET_TICK = longPreferencesKey("widget.tick")

@Composable
internal fun rememberWidgetNow(): Long = currentState(WIDGET_TICK) ?: System.currentTimeMillis()

@Composable
internal fun rememberAgenda(now: Long): WidgetAgendaFile? {
    val context = LocalContext.current
    return remember(now) { WidgetStore.agenda(context, (context.applicationContext as StarlingsApp).account) }
}

/**
 * `NextMeetingWidget` (iOSActivities/NextMeetingWidget.swift): Home's
 * UPCOMING card on the home screen, read from the agenda the app wrote. The
 * hero is the plan's focus and nothing else; a closed day says so, the way
 * Home does, and never counts down to tomorrow. A tap lands on the meeting:
 * its link, or the meeting in Calendar when it has none.
 *
 * Small is the hero alone; medium (250 dp wide and up) is the hero and
 * Home's following rows. The Lock Screen families have no Android home.
 */
class NextMeetingWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, MEDIUM))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { NextMeetingContent() }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val MEDIUM = DpSize(250.dp, 110.dp)
    }
}

class NextMeetingWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NextMeetingWidget()

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        WidgetRefresh.ensure(context)
    }
}

@Composable
private fun NextMeetingContent() {
    val context = LocalContext.current
    val now = rememberWidgetNow()
    val agenda = rememberAgenda(now)
    val plan = WidgetAgenda.plan(agenda, now)
    val focus = WidgetAgenda.focus(plan, agenda)
    val medium = LocalSize.current.width >= NextMeetingWidget.MEDIUM.width
    val tap = focus?.let { WidgetDoors.open(context, it) } ?: actionStartActivity(Intent(context, MainActivity::class.java))

    Column(GlanceModifier.widgetPanel().clickable(tap)) {
        if (medium) {
            if (focus != null) WideHero(context, focus, plan, now) else ClosedDay(context, plan)
            plan.homeRows.let { WidgetAgenda.rows(it, agenda) }.forEach { m ->
                Spacer(GlanceModifier.height(6.dp))
                Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(m.title, GlanceModifier.defaultWeight(), style = ink(WidgetInk.primary, WidgetType.subheadline), maxLines = 1)
                    Spacer(GlanceModifier.width(4.dp))
                    Text(
                        WidgetText.rowWhen(context, m, WidgetAgenda.showsCountdown(m, plan), now),
                        style = ink(WidgetInk.secondary, WidgetType.caption), maxLines = 1,
                    )
                }
            }
        } else if (focus != null) {
            SmallHero(context, focus, plan, now)
        } else {
            ClosedDay(context, plan)
        }
    }
}

/** Never empty: a closed day says so and shows what is next, as Home does. */
@Composable
private fun ClosedDay(context: Context, plan: UpcomingPlan) {
    Column(GlanceModifier.fillMaxWidth()) {
        WidgetHeader(R.drawable.widget_ic_video, HomeText.heroLabel(context, plan))
        Spacer(GlanceModifier.height(8.dp))
        Text(HomeText.closedDay(context, plan), style = ink(WidgetInk.secondary, WidgetType.subheadline), maxLines = 2)
    }
}

/** `StarlingsGlanceState`: the state word over the title. */
@Composable
private fun GlanceState(context: Context, m: WidgetMeeting, plan: UpcomingPlan) =
    WidgetHeader(meetingGlyph(m.isVideo), HomeText.heroLabel(context, plan))

/** `StarlingsGlanceRow.small`: state, title, clock; the timer beside the clock. */
@Composable
private fun SmallHero(context: Context, m: WidgetMeeting, plan: UpcomingPlan, now: Long) {
    Column(GlanceModifier.fillMaxSize()) {
        GlanceState(context, m, plan)
        Spacer(GlanceModifier.defaultWeight())
        Text(m.title, style = ink(WidgetInk.primary, WidgetType.headline, FontWeight.Medium), maxLines = 2)
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(WidgetText.clockLine(context, m, now), GlanceModifier.defaultWeight(), style = ink(WidgetInk.secondary, WidgetType.caption), maxLines = 1)
            Spacer(GlanceModifier.width(4.dp))
            Text(WidgetText.timer(context, m, now), style = ink(WidgetInk.accent, WidgetType.caption, FontWeight.Bold, TextAlign.End), maxLines = 1)
        }
    }
}

/**
 * `StarlingsGlanceRow.wide`: state, title, the detail line with the one
 * action, who; the timer and its unit at the right, in a bounded column.
 */
@Composable
private fun WideHero(context: Context, m: WidgetMeeting, plan: UpcomingPlan, now: Long) {
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(GlanceModifier.defaultWeight()) {
            GlanceState(context, m, plan)
            Spacer(GlanceModifier.height(4.dp))
            Text(m.title, style = ink(WidgetInk.primary, WidgetType.headline, FontWeight.Medium), maxLines = 2)
            Spacer(GlanceModifier.height(4.dp))
            GlanceDetail(context, m, now)
            val who = WidgetAgenda.whoLine(m.attendees)
            if (who.isNotEmpty()) {
                Spacer(GlanceModifier.height(4.dp))
                Text(who, style = ink(WidgetInk.secondary, WidgetType.caption2), maxLines = 1)
            }
        }
        Spacer(GlanceModifier.width(8.dp))
        Column(GlanceModifier.width(104.dp), horizontalAlignment = Alignment.End) {
            Text(WidgetText.timer(context, m, now), style = ink(WidgetInk.accent, WidgetType.title, FontWeight.Bold, TextAlign.End), maxLines = 1)
            Text(WidgetText.unit(context, m, now), style = ink(WidgetInk.secondary, WidgetType.caption2, align = TextAlign.End), maxLines = 1)
        }
    }
}

/**
 * `StarlingsGlanceDetail`: the clock, the calendar and the one action on
 * one line. The calendar gives way first (it ellipsizes); Join never does.
 */
@Composable
private fun GlanceDetail(context: Context, m: WidgetMeeting, now: Long) {
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        val clock = WidgetText.clockLine(context, m, now)
        val line = if (m.calendar.isEmpty()) clock else "$clock · ${m.calendar}"
        Text(line, if (m.join != null) GlanceModifier.defaultWeight() else GlanceModifier, style = ink(WidgetInk.secondary, WidgetType.caption2), maxLines = 1)
        m.join?.let { join ->
            Text(" · ", style = ink(WidgetInk.secondary, WidgetType.caption2), maxLines = 1)
            Text(
                context.getString(R.string.widget_join),
                GlanceModifier.clickable(WidgetDoors.join(context, join)),
                style = ink(WidgetInk.accent, WidgetType.caption2, FontWeight.Bold), maxLines = 1,
            )
        }
    }
}
