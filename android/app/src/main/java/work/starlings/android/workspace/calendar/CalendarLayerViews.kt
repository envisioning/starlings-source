package work.starlings.android.workspace.calendar

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
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
import work.starlings.android.R
import work.starlings.android.ui.ListActionRow
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import java.time.ZoneId

/** Layer names and lines, from `CalendarLayerKind` and `CalendarLayerItem` (`Sources/CalendarLayer.swift`). */
object CalendarLayerChrome {
    fun title(context: Context, kind: CalendarLayerKind): String = context.getString(
        when (kind) {
            CalendarLayerKind.EVENTS -> R.string.cal_layer_events
            CalendarLayerKind.MILESTONES -> R.string.cal_layer_milestones
            CalendarLayerKind.TASKS -> R.string.cal_layer_tasks
            CalendarLayerKind.AVAILABILITY -> R.string.cal_layer_availability
        },
    )

    fun caption(context: Context, kind: CalendarLayerKind): String = context.getString(
        when (kind) {
            CalendarLayerKind.EVENTS -> R.string.cal_layer_events_caption
            CalendarLayerKind.MILESTONES -> R.string.cal_layer_milestones_caption
            CalendarLayerKind.TASKS -> R.string.cal_layer_tasks_caption
            CalendarLayerKind.AVAILABILITY -> R.string.cal_layer_availability_caption
        },
    )

    fun icon(kind: CalendarLayerKind): ImageVector = when (kind) {
        CalendarLayerKind.EVENTS -> Icons.Outlined.Campaign
        CalendarLayerKind.MILESTONES -> Icons.Outlined.Flag
        CalendarLayerKind.TASKS -> Icons.Outlined.CheckCircle
        CalendarLayerKind.AVAILABILITY -> Icons.Outlined.Schedule
    }

    /** `displayTitle`: availability says "Available"; an untitled row says its kind. */
    fun displayTitle(context: Context, item: CalendarLayerItem): String =
        if (item.kind == CalendarLayerKind.AVAILABILITY) context.getString(R.string.cal_layer_available)
        else item.shownTitle ?: title(context, item.kind)

    private fun dateTime(ms: Long, zone: ZoneId): String =
        "${CalendarChrome.date(CalendarDatesUi.day(ms, zone), "EEEEMMMMdyyyy")} ${CalendarChrome.time(ms, zone)}"

    /** `whenText`: a window for availability, a day for a dated row, a due time for a task. */
    fun whenText(context: Context, item: CalendarLayerItem, zone: ZoneId): String = when {
        item.kind == CalendarLayerKind.AVAILABILITY -> "${dateTime(item.start, zone)} – ${CalendarChrome.time(item.end, zone)}"
        item.allDay -> CalendarChrome.date(CalendarDatesUi.day(item.start, zone), "EEEEMMMMdyyyy")
        item.kind == CalendarLayerKind.TASKS -> context.getString(R.string.cal_due, dateTime(item.start, zone))
        else -> "${dateTime(item.start, zone)} – ${CalendarChrome.time(item.end, zone)}"
    }

    /** `MobileCalendarChrome.describe(_ item:)`: the spoken form. */
    fun describe(context: Context, item: CalendarLayerItem, zone: ZoneId): String {
        val parts = mutableListOf(displayTitle(context, item))
        parts += if (item.kind == CalendarLayerKind.AVAILABILITY) context.getString(R.string.cal_a11y_open_for_booking) else title(context, item.kind)
        val day = CalendarChrome.date(CalendarDatesUi.day(item.start, zone), "MMMdyyyy")
        parts += when {
            item.kind == CalendarLayerKind.AVAILABILITY ->
                context.getString(R.string.cal_a11y_range, "$day ${CalendarChrome.time(item.start, zone)}", CalendarChrome.time(item.end, zone))
            item.allDay -> day
            else -> context.getString(R.string.cal_a11y_due, "$day ${CalendarChrome.time(item.start, zone)}")
        }
        if (item.detail.isNotEmpty()) parts += item.detail
        if (item.assignee.isNotEmpty()) parts += if (item.isMine) context.getString(R.string.cal_you_title) else item.assignee
        return parts.joinToString(", ")
    }

    /** `CalendarLayerWorkLink.title`: "Open in Mine", or "Open" and the subject's name. */
    fun linkTitle(context: Context, link: CalendarLayerWorkLink): String = when (link) {
        is CalendarLayerWorkLink.Mine -> context.getString(R.string.cal_open_in_mine)
        is CalendarLayerWorkLink.Subject -> context.getString(
            R.string.cal_open_subject,
            link.name ?: context.getString(
                when (link.kind) {
                    "project" -> R.string.cal_project
                    "lead" -> R.string.cal_lead
                    "event" -> R.string.cal_event
                    else -> R.string.cal_partner
                },
            ),
        )
    }
}

/**
 * `MobileCalendarLayerBlock`: a published event, a milestone, a task, open
 * hours. Our mark rides the corner; the title starts where every title
 * starts. Someone else's task is dimmed, not hidden.
 */
@Composable
fun LayerBlock(item: CalendarLayerItem, now: Long, zone: ZoneId, compact: Boolean, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val c = Starlings.colors
    val context = LocalContext.current
    val tint = CalendarChrome.color(item.kind.color)
    val emphasis = if (item.kind == CalendarLayerKind.TASKS && !item.isMine) 0.55f else 1f
    val eventLike = item.kind == CalendarLayerKind.EVENTS
    val showsTime = eventLike || item.kind == CalendarLayerKind.AVAILABILITY
    val shape = RoundedCornerShape(CalendarChrome.cornerRadius)
    val label = CalendarLayerChrome.describe(context, item, zone)
    Row(
        modifier
            .alpha(if (item.isPast(now)) CalendarChrome.PAST_ALPHA else 1f)
            .clip(shape)
            .background(c.canvas)
            .background(tint.copy(alpha = if (compact) 0.10f else 0.13f))
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .clearAndSetSemantics { contentDescription = label; if (onClick != null) role = Role.Button },
    ) {
        Box(Modifier.width(CalendarChrome.stripeWidth).fillMaxHeight().background(tint.copy(alpha = emphasis)))
        Row(
            Modifier.weight(1f).padding(horizontal = 5.dp, vertical = if (compact) 1.dp else 3.dp),
            verticalAlignment = if (compact) Alignment.CenterVertically else Alignment.Top,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    val style = when {
                        compact -> StarlingsType.caption2.copy(fontSize = 10.sp)
                        eventLike -> StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold)
                        else -> StarlingsType.caption
                    }
                    Text(
                        CalendarLayerChrome.displayTitle(context, item),
                        Modifier.weight(1f, fill = false),
                        style = style.copy(textDecoration = if (item.isFinished) TextDecoration.LineThrough else null),
                        color = c.primary.copy(alpha = emphasis),
                        maxLines = if (compact || !eventLike) 1 else 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (!compact && !eventLike && item.assignee.isNotEmpty() && !item.isMine) {
                        Text(item.assignee, style = StarlingsType.caption2, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (!compact && showsTime && !item.allDay) {
                    val time = if (item.kind == CalendarLayerKind.AVAILABILITY) {
                        "${CalendarChrome.time(item.start, zone)} – ${CalendarChrome.time(item.end, zone)}"
                    } else {
                        CalendarChrome.time(item.start, zone)
                    }
                    Text(time, style = StarlingsType.caption2.copy(fontSize = 10.sp), color = c.secondary, maxLines = 1)
                }
            }
            Spacer(Modifier.width(2.dp))
            WorkspaceMark(c.primary.copy(alpha = emphasis), if (compact) 9 else 11)
        }
    }
}

/** `MobileCalendarLayerRow`: the agenda row's bones, our mark in the corner, whose task in the second line. */
@Composable
fun LayerRow(item: CalendarLayerItem, now: Long, zone: ZoneId, onClick: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val shape = RoundedCornerShape(StarlingsRadius.control)
    val label = CalendarLayerChrome.describe(context, item, zone)
    val subtitle = listOfNotNull(
        if (item.allDay) null else CalendarChrome.time(item.start, zone),
        item.detail.ifEmpty { null },
        item.assignee.ifEmpty { null }?.let { if (item.isMine) context.getString(R.string.cal_you_title) else it },
    ).joinToString(" · ")
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (item.isPast(now)) CalendarChrome.PAST_ALPHA else 1f)
            .clip(shape)
            .background(c.elevated, shape)
            .border(1.dp, c.border, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.width(3.dp).height(if (subtitle.isEmpty()) 22.dp else 40.dp).background(CalendarChrome.color(item.kind.color), RoundedCornerShape(2.dp)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                CalendarLayerChrome.displayTitle(context, item),
                style = StarlingsType.headline.copy(textDecoration = if (item.isFinished) TextDecoration.LineThrough else null),
                color = c.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotEmpty()) Text(subtitle, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        WorkspaceMark(c.primary)
    }
}

/**
 * `MobileCalendarLayerDetail`: what a milestone, task or published event
 * says when opened. No Save and no Delete: these come from Core and the
 * events feed, so the sheet reads them and leads to where they live.
 */
@Composable
fun CalendarLayerDetail(item: CalendarLayerItem, zone: ZoneId, onDone: () -> Unit, onOpenWork: (String) -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val tint = CalendarChrome.color(item.kind.color)
    Column(Modifier.fillMaxSize()) {
        SheetHeader(CalendarLayerChrome.title(context, item.kind), stringResource(R.string.cal_done), onDone)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            ListSection(null) {
                ListRow {
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                        WorkspaceMark(tint, 12)
                        Text(CalendarLayerChrome.title(context, item.kind), style = StarlingsType.caption, color = tint)
                    }
                    Text(CalendarLayerChrome.displayTitle(context, item), style = StarlingsType.title3.copy(fontWeight = FontWeight.Bold), color = c.primary)
                    Text(CalendarLayerChrome.whenText(context, item, zone), style = StarlingsType.subheadline, color = c.secondary)
                }
            }
            val rows = buildList {
                if (item.detail.isNotEmpty()) {
                    add(context.getString(if (item.kind == CalendarLayerKind.EVENTS) R.string.cal_location else R.string.cal_project) to item.detail)
                }
                if (item.assignee.isNotEmpty()) {
                    add(context.getString(if (item.isMine) R.string.cal_assigned_to_you else R.string.cal_assigned_to) to item.assignee)
                }
                if (item.status.isNotEmpty()) add(context.getString(R.string.cal_status) to item.statusText)
                if (item.notes.isNotEmpty()) add(context.getString(R.string.cal_notes) to item.notes)
            }
            Column {
                if (rows.isNotEmpty()) ListSection(null) { rows.forEach { (label, value) -> DetailRow(label, value) } }
                ListFooter(CalendarLayerChrome.caption(context, item.kind))
            }
            if (item.workLinks.isNotEmpty() || item.url.isNotEmpty()) {
                ListSection(null) {
                    item.workLinks.forEach { link ->
                        ListActionRow(CalendarLayerChrome.linkTitle(context, link), Icons.AutoMirrored.Outlined.ArrowForward, onClick = { onOpenWork(link.path) })
                    }
                    if (item.url.isNotEmpty()) {
                        ListActionRow(stringResource(R.string.cal_open_link), Icons.AutoMirrored.Outlined.OpenInNew, onClick = { openLink(context, item.url) })
                    }
                }
            }
        }
    }
}
