package work.starlings.android.widgets

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
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
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import work.starlings.android.R
import work.starlings.android.StarlingsApp
import work.starlings.android.workspace.home.HomeLinks

/**
 * `TodayWorkWidget` (iOSActivities/TodayWidgets.swift): what is overdue
 * and due today, the block Home's WORK card shows, from the last Mine
 * answer. Each row opens its subject on Tasks, or the task. Small lists
 * three, medium (250 dp wide and up) five with the count line and the
 * subject under each title. The tile itself opens Mine.
 */
class TodayWorkWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, MEDIUM))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { TodayWorkContent() }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val MEDIUM = DpSize(250.dp, 110.dp)
    }
}

class TodayWorkWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWorkWidget()

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        WidgetRefresh.ensure(context)
    }
}

@Composable
private fun TodayWorkContent() {
    val context = LocalContext.current
    val now = rememberWidgetNow()
    val rows = remember(now) { WidgetStore.work((context.applicationContext as StarlingsApp).account, now) }
    val small = LocalSize.current.width < TodayWorkWidget.MEDIUM.width
    val limit = if (small) 3 else 5
    val summary = WidgetText.workSummary(context, rows)

    Column(GlanceModifier.widgetPanel().clickable(WidgetDoors.path(context, HomeLinks.MINE))) {
        WidgetHeader(R.drawable.widget_ic_check, context.getString(R.string.widget_work)) {
            // The word "overdue" is already in the string: no tint on top of it (docs/DESIGN.md, "The accent budget").
            if (!small && summary.isNotEmpty()) {
                Text(summary, style = ink(WidgetInk.primary, WidgetType.caption2, FontWeight.Bold), maxLines = 1)
            }
        }
        Spacer(GlanceModifier.height(6.dp))
        if (rows.isEmpty()) {
            Spacer(GlanceModifier.defaultWeight())
            Text(context.getString(R.string.widget_nothing_due), style = ink(WidgetInk.secondary, WidgetType.subheadline), maxLines = 2)
        } else {
            rows.take(limit).forEach { row -> WorkRow(context, row, small) }
            if (rows.size > limit) {
                Text(context.getString(R.string.widget_more_in_work, rows.size - limit), style = ink(WidgetInk.secondary, WidgetType.caption2), maxLines = 1)
            }
        }
    }
}

/** `TodayWorkRow`: glyph, title (and subject when there is room), Overdue or Today; TalkBack reads it as one line. */
@Composable
private fun WorkRow(context: Context, row: WidgetWorkRow, compact: Boolean) {
    val label = listOfNotNull(
        row.title, row.subjectTitle?.ifEmpty { null },
        context.getString(if (row.overdue) R.string.widget_overdue else R.string.widget_due_today),
    ).joinToString(", ")
    Row(
        GlanceModifier.fillMaxWidth().padding(vertical = 3.dp).clickable(WidgetDoors.path(context, row.path)).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Glyph(R.drawable.widget_ic_check, if (row.overdue) WidgetInk.primary else WidgetInk.secondary)
        Spacer(GlanceModifier.width(8.dp))
        Column(GlanceModifier.defaultWeight()) {
            Text(row.title, style = ink(WidgetInk.primary, WidgetType.subheadline), maxLines = 1)
            val subject = row.subjectTitle
            if (!compact && !subject.isNullOrEmpty()) {
                Text(subject, style = ink(WidgetInk.secondary, WidgetType.caption2), maxLines = 1)
            }
        }
        Spacer(GlanceModifier.width(4.dp))
        Text(
            context.getString(if (row.overdue) R.string.home_overdue else R.string.home_today),
            style = ink(WidgetInk.secondary, WidgetType.caption2), maxLines = 1,
        )
    }
}
