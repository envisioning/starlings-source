package work.starlings.android.widgets

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import work.starlings.android.R
import work.starlings.android.Upcoming
import work.starlings.android.workspace.home.HomeClock
import work.starlings.android.workspace.home.HomeLinks
import work.starlings.android.workspace.home.HomeText

/**
 * `TodayAgendaWidget` (iOSActivities/TodayWidgets.swift): what is left of
 * today, the meeting under way then the ones still to come, each row its
 * own door (its link, or the meeting in Calendar). Medium lists three,
 * large (250 dp tall and up) eight; more says "+N". The tile itself opens
 * Calendar, where iOS's row fallback goes.
 */
class TodayAgendaWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(MEDIUM, LARGE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { TodayAgendaContent() }
    }

    companion object {
        val MEDIUM = DpSize(250.dp, 110.dp)
        val LARGE = DpSize(250.dp, 250.dp)
    }
}

class TodayAgendaWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayAgendaWidget()

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        WidgetRefresh.ensure(context)
    }
}

@Composable
private fun TodayAgendaContent() {
    val context = LocalContext.current
    val now = rememberWidgetNow()
    val agenda = rememberAgenda(now)
    val plan = WidgetAgenda.plan(agenda, now)
    val rows = WidgetAgenda.today(plan, agenda)
    val limit = if (LocalSize.current.height >= TodayAgendaWidget.LARGE.height) 8 else 3

    Column(GlanceModifier.widgetPanel().clickable(WidgetDoors.path(context, HomeLinks.CALENDAR))) {
        WidgetHeader(R.drawable.widget_ic_calendar, context.getString(R.string.widget_today)) {
            if (rows.size > limit) {
                Text(context.getString(R.string.widget_more, rows.size - limit), style = ink(WidgetInk.secondary, WidgetType.caption2), maxLines = 1)
            }
        }
        Spacer(GlanceModifier.height(6.dp))
        if (rows.isEmpty()) {
            Spacer(GlanceModifier.defaultWeight())
            Text(HomeText.closedDay(context, plan), style = ink(WidgetInk.secondary, WidgetType.subheadline), maxLines = 2)
        } else {
            rows.take(limit).forEach { m -> AgendaRow(context, m, now) }
        }
    }
}

/** `TodayAgendaRow`: glyph, title, the start; the meeting under way in the accent and bolder. */
@Composable
private fun AgendaRow(context: Context, m: WidgetMeeting, now: Long) {
    val started = WidgetAgenda.hasStarted(m, now)
    Row(
        GlanceModifier.fillMaxWidth().padding(vertical = 3.dp).clickable(WidgetDoors.open(context, m)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Glyph(meetingGlyph(m.isVideo), if (started) WidgetInk.accent else WidgetInk.secondary)
        Spacer(GlanceModifier.width(8.dp))
        Text(
            m.title, GlanceModifier.defaultWeight(),
            style = ink(WidgetInk.primary, WidgetType.subheadline, if (started) FontWeight.Bold else FontWeight.Normal), maxLines = 1,
        )
        Spacer(GlanceModifier.width(4.dp))
        Text(
            if (m.allDay) context.getString(R.string.widget_all_day) else Upcoming.parse(m.start)?.let { HomeClock.time(it) }.orEmpty(),
            style = ink(WidgetInk.secondary, WidgetType.caption), maxLines = 1,
        )
    }
}
