package work.starlings.android.workspace.home

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.EventAvailable
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.MarkEmailUnread
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.Rsvp
import work.starlings.android.Upcoming
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.CaptionLabel
import work.starlings.android.ui.CompactMark
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.homeRow
import work.starlings.android.workspace.work.WorkFormat
import work.starlings.contracts.CalendarAttendeeStatus
import work.starlings.contracts.CalendarEventReply
import work.starlings.contracts.CalendarEventWire
import work.starlings.contracts.InboxForwardedItem
import work.starlings.contracts.InboxInvitationItem

/**
 * `CalendarConflictDetector` (Sources/CalendarModels.swift): what an
 * invitation overlaps on the agenda. Real overlaps only: adjacent events and
 * all-day events are no conflict, nor is a declined event or the same event
 * copied into a second calendar.
 */
object CalendarConflicts {
    /** `CalendarConflictEvent`: the slice two events are compared on. Times in epoch milliseconds. */
    data class Event(val id: String, val title: String, val start: Long?, val end: Long?, val allDay: Boolean, val declined: Boolean) {
        companion object {
            fun of(e: CalendarEventWire): Event = Event(
                e.id, e.title, Upcoming.parse(e.start), Upcoming.parse(e.end), e.allDay,
                e.attendees.any { it.isSelf && it.status == CalendarAttendeeStatus.DECLINED },
            )
        }
    }

    /** `CalendarConflict`; [title] is null for an untitled event ("Untitled event"). */
    data class Conflict(val id: String, val title: String?, val start: Long, val end: Long)

    fun conflicts(candidate: Event, among: List<Event>): List<Conflict> {
        val (cs, ce) = interval(candidate) ?: return emptyList()
        return among.mapNotNull { e ->
            if (e.declined || sameScheduledEvent(candidate, e)) return@mapNotNull null
            val (es, ee) = interval(e) ?: return@mapNotNull null
            if (cs < ee && es < ce) Conflict(e.id, displayTitle(e.title), es, ee) else null
        }.sortedWith(compareBy<Conflict> { it.start }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.title.orEmpty() })
    }

    private fun interval(e: Event): Pair<Long, Long>? {
        if (e.allDay) return null
        val s = e.start ?: return null
        val t = e.end ?: return null
        return if (t > s) s to t else null
    }

    /** The same event once per selected calendar is one row, not a collision with itself. */
    private fun sameScheduledEvent(a: Event, b: Event): Boolean {
        if (a.id == b.id) return true
        if (a.start == null || a.end == null || b.start == null || b.end == null) return false
        return a.start == b.start && a.end == b.end && displayTitle(a.title).orEmpty().equals(displayTitle(b.title).orEmpty(), ignoreCase = true)
    }

    private fun displayTitle(title: String): String? = title.trim().ifEmpty { null }

    /** `CalendarConflictDetector.line`: the first overlap named, the rest counted. */
    fun line(context: Context, conflicts: List<Conflict>): String? {
        val first = conflicts.firstOrNull() ?: return null
        val more = if (conflicts.size > 1) context.getString(R.string.home_invite_conflicts_more, conflicts.size - 1) else ""
        val title = first.title ?: context.getString(R.string.home_untitled_event)
        return context.getString(R.string.home_invite_conflicts, title, "${WorkFormat.time(first.start)}–${WorkFormat.time(first.end)}", more)
    }
}

/**
 * `MobileCalendarInvitationRow`: a calendar invitation answered on its INBOX
 * row. Accept wears the accent; Maybe and Decline stay neutral. One answer at
 * a time across the card ([answeringKey]); the row leaves when the write lands.
 */
@Composable
internal fun InvitationRow(item: InboxInvitationItem, detail: String, conflicts: List<CalendarConflicts.Conflict>, answeringKey: String?, respond: (CalendarEventReply) -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val event = item.event
    val title = event.title.ifEmpty { stringResource(R.string.work_calendar_invitation) }
    val conflictLine = CalendarConflicts.line(context, conflicts)
    val label = listOfNotNull(stringResource(R.string.home_invite_label, event.title), conflictLine).joinToString(", ")
    Column(Modifier.homeRow(c.elevated).semantics { contentDescription = label }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            CompactMark(Icons.Outlined.Schedule, round = true)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = StarlingsType.headline, color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (detail.isNotEmpty()) Text(detail, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                conflictLine?.let { CaptionLabel(it, Icons.Outlined.WarningAmber) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Rsvp.answers.forEach { answer ->
                val reply = answer.reply ?: return@forEach
                val text = when (answer) {
                    Rsvp.ACCEPTED -> stringResource(R.string.work_accept)
                    Rsvp.TENTATIVE -> stringResource(R.string.work_maybe)
                    Rsvp.DECLINED -> stringResource(R.string.work_decline)
                    Rsvp.NEEDS_ACTION -> stringResource(R.string.home_invite_reply)
                }
                val icon = when (answer) {
                    Rsvp.ACCEPTED -> Icons.Outlined.Check
                    Rsvp.TENTATIVE -> Icons.Outlined.HelpOutline
                    else -> Icons.Outlined.Close
                }
                if (answer == Rsvp.ACCEPTED) {
                    FilledButton(text, { respond(reply) }, enabled = answeringKey == null, icon = icon, compact = true)
                } else {
                    BorderedButton(text, { respond(reply) }, enabled = answeringKey == null, icon = icon, compact = true)
                }
            }
            if (answeringKey == item.key) CircularProgressIndicator(Modifier.size(16.dp), color = c.secondary, strokeWidth = 2.dp)
        }
    }
}

/**
 * `MobilePendingCalendarEventRow`: an event proposed from a forwarded mail
 *, with Add (the accent) and Discard. Same shape as an invitation.
 */
@Composable
internal fun ForwardedRow(item: InboxForwardedItem, detail: String, answeringKey: String?, answer: (Boolean) -> Unit) {
    val c = Starlings.colors
    val event = item.event
    val label = stringResource(R.string.home_forwarded_label, event.title, detail)
    Column(Modifier.homeRow(c.elevated).semantics { contentDescription = label }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            CompactMark(Icons.Outlined.MarkEmailUnread, round = true)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(event.title, style = StarlingsType.headline, color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(detail, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                event.location?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = StarlingsType.caption2, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            FilledButton(stringResource(R.string.work_add), { answer(true) }, enabled = answeringKey == null, icon = Icons.Outlined.EventAvailable, compact = true)
            BorderedButton(stringResource(R.string.work_discard), { answer(false) }, enabled = answeringKey == null, icon = Icons.Outlined.Close, compact = true)
            if (answeringKey == item.key) CircularProgressIndicator(Modifier.size(16.dp), color = c.secondary, strokeWidth = 2.dp)
        }
    }
}
