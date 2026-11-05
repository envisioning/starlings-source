package work.starlings.android.workspace.calendar

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.CalendarFreeBusyPerson
import java.time.LocalDate
import java.time.ZoneId

/**
 * The editor's Availability section (`availabilitySection`, `verdict`): one
 * day as a bar with the guests' busy time shaded and the slot in the accent,
 * then who is busy, or that everyone is free, and whose calendar could not
 * be read, said plainly and never folded into free.
 */
@Composable
fun CalendarAvailabilitySection(
    people: List<CalendarFreeBusyPerson>,
    checking: Boolean,
    slot: CalendarAvailability.Span,
    day: LocalDate,
    zone: ZoneId,
    onPick: (Long) -> Unit,
) {
    val c = Starlings.colors
    val window = CalendarAvailability.window(slot, day, zone)
    val busy = CalendarAvailability.busy(people, window, zone)
    val clashes = CalendarAvailability.conflicts(people, slot, zone)
    val unreadable = CalendarAvailability.unreadable(people)
    Column {
        Row(Modifier.padding(start = 16.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.cal_availability_title), style = StarlingsType.footnote, color = c.secondary)
            if (checking) CircularProgressIndicator(Modifier.size(10.dp), color = c.secondary, strokeWidth = 1.5.dp)
        }
        ListSection(null) {
            ListRow {
                AvailabilityBar(window, busy, slot, zone, onPick)
                when {
                    clashes.isNotEmpty() -> Verdict(stringResource(R.string.cal_busy_then, clashes.joinToString(", ")), Icons.Outlined.WarningAmber, c.danger)
                    people.isNotEmpty() -> Verdict(stringResource(R.string.cal_everyone_free), Icons.Outlined.CheckCircle, c.secondary)
                }
                if (unreadable.isNotEmpty()) {
                    Text(stringResource(R.string.cal_no_availability_for, unreadable.joinToString(", ")), style = StarlingsType.caption, color = c.secondary)
                }
            }
        }
        ListFooter(stringResource(R.string.cal_free_busy_footer))
    }
}

@Composable
private fun Verdict(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, tint: androidx.compose.ui.graphics.Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(14.dp), tint = tint)
        Text(text, style = StarlingsType.caption, color = tint)
    }
}

/** `MobileCalendarAvailabilityStrip`: tapping the bar moves the start there. */
@Composable
private fun AvailabilityBar(window: CalendarAvailability.Span, busy: List<CalendarAvailability.Span>, slot: CalendarAvailability.Span, zone: ZoneId, onPick: (Long) -> Unit) {
    val c = Starlings.colors
    val label = stringResource(R.string.cal_guest_availability)
    val value = if (busy.isEmpty()) stringResource(R.string.cal_no_busy_time) else "${busy.size}, ${CalendarChrome.time(window.start, zone)} – ${CalendarChrome.time(window.end, zone)}"
    val span = maxOf(60_000L, window.end - window.start).toFloat()
    val shade = c.secondary.copy(alpha = 0.28f)
    val accent = c.accent.copy(alpha = 0.9f)
    Column(
        Modifier.padding(vertical = 4.dp).clearAndSetSemantics { contentDescription = label; stateDescription = value },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(34.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(c.canvas)
                .pointerInput(window) {
                    detectTapGestures { point ->
                        onPick(CalendarAvailability.pick(window, point.x / size.width.coerceAtLeast(1), CalendarDisplay.DEFAULT_SNAP))
                    }
                },
        ) {
            fun x(ms: Long) = size.width * ((ms - window.start) / span).coerceIn(0f, 1f)
            busy.forEach { b ->
                drawRect(shade, Offset(x(b.start), 0f), Size(maxOf(1f, x(b.end) - x(b.start)), size.height))
            }
            drawRoundRect(accent, Offset(x(slot.start), 0f), Size(maxOf(3f, x(slot.end) - x(slot.start)), size.height), CornerRadius(4.dp.toPx()))
        }
        Row(Modifier.fillMaxWidth()) {
            Text(CalendarChrome.time(window.start, zone), style = StarlingsType.caption2, color = c.secondary)
            Spacer(Modifier.weight(1f))
            Text(CalendarChrome.time(window.end, zone), style = StarlingsType.caption2, color = c.secondary)
        }
    }
}
