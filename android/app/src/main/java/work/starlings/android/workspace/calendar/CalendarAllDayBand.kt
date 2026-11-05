package work.starlings.android.workspace.calendar

import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.launch
import work.starlings.android.CalEvent
import work.starlings.android.CalGroup
import work.starlings.android.CalSource
import work.starlings.android.CalendarDates
import work.starlings.android.CalendarMerge
import work.starlings.android.ui.Haptic
import java.time.LocalDate

/** `canMove`: a writable event, not a subscribed feed's. */
fun canMove(event: CalEvent): Boolean = event.writable && event.source != CalSource.SUBSCRIPTION

/**
 * A long press picks a card up; the drag carries it, and letting go asks
 * [onDrop] with the travel in pixels. An ordinary drag still scrolls and
 * pages, because nothing is armed until the press holds.
 *
 * Felt as iOS `MobileCalendarTimeGrid`: the lift toggles (the card is now
 * yours to place), each change of [snap]'s answer ticks a step, so a
 * quarter hour is counted rather than read, and a drop that moves the
 * card ([onDrop] true) taps.
 */
@Composable
fun Modifier.longPressMove(enabled: Boolean, key: Any, snap: (Offset) -> Any?, onDrop: (Offset) -> Boolean): Modifier {
    if (!enabled) return this
    var travel by remember(key) { mutableStateOf<Offset?>(null) }
    // The gesture outlives a composition: drop with the hour height and times drawn now.
    val drop by androidx.compose.runtime.rememberUpdatedState(onDrop)
    val snapped by androidx.compose.runtime.rememberUpdatedState(snap)
    val view = LocalView.current
    val step = remember(key) { arrayOf<Any?>(null) }
    return this
        .zIndex(if (travel != null) 1_000f else 0f)
        .graphicsLayer {
            val t = travel ?: Offset.Zero
            translationX = t.x
            translationY = t.y
            alpha = if (travel != null) 0.85f else 1f
        }
        .pointerInput(key) {
            detectDragGesturesAfterLongPress(
                onDragStart = {
                    travel = Offset.Zero
                    step[0] = snapped(Offset.Zero)
                    Haptic.TOGGLE.play(view)
                },
                onDragEnd = { travel?.let { if (drop(it)) Haptic.TAP.play(view) }; travel = null },
                onDragCancel = { travel = null },
            ) { change, amount ->
                change.consume()
                val next = (travel ?: Offset.Zero) + amount
                travel = next
                val now = snapped(next)
                if (now != step[0]) {
                    step[0] = now
                    Haptic.STEP.play(view)
                }
            }
        }
}

/**
 * The all-day band: all-day events, milestones and dated published events
 * packed in one pass (`allDayLayout(for:)`), so a span over several days on
 * screen is one bar and overlapping bars take separate rows. A writable
 * event moves by days on a long press.
 */
@Composable
fun AllDayBand(
    store: CalendarStore,
    days: List<LocalDate>,
    now: Long,
    gutter: Dp,
    onSelect: (CalGroup) -> Unit,
    onSelectLayer: (CalendarLayerItem) -> Unit,
) {
    val zone = store.zone
    val scope = rememberCoroutineScope()
    val groups = CalendarMerge.consolidate(store.events.filter { it.allDay }, zone)
    val layers = store.visibleLayers.filter { it.allDay }
    val groupsById = groups.associateBy { it.id }
    val layersById = layers.associateBy { it.id }
    val spans = groups.map { CalendarAllDay.Span(it.id, it.event.start, it.event.end) } + layers.map { CalendarAllDay.Span(it.id, it.start, it.end) }
    val layout = CalendarAllDay.pack(spans, days, zone)
    if (layout.isEmpty()) return
    val rowHeight = 24.dp
    val rows = (layout.maxOf { it.row }) + 1
    Row(Modifier.fillMaxWidth().padding(bottom = 2.dp)) {
        Spacer(Modifier.width(gutter))
        BoxWithConstraints(Modifier.weight(1f).height(rowHeight * rows)) {
            val column = maxWidth / days.size
            val columnPx = constraints.maxWidth.toFloat() / days.size
            layout.forEach { bar ->
                val place = Modifier
                    .offset(x = column * bar.startIndex + 1.dp, y = rowHeight * bar.row)
                    .width(column * (bar.endIndex - bar.startIndex + 1) - 2.dp)
                    .height(rowHeight - 2.dp)
                val group = groupsById[bar.id]
                val item = layersById[bar.id]
                when {
                    group != null -> {
                        val event = group.event
                        val movable = canMove(event)
                        EventBlock(
                            group, store.colors(group), now, zone, compact = true,
                            // Whole days, clamped to the days shown; the bar's first day is where the drag began.
                            modifier = place.longPressMove(
                                movable, event.id,
                                snap = { travel -> CalendarAllDay.move(event.start, event.end, true, days, bar.startIndex, travel.x / columnPx, 0f, zone, store.display.snapMinutes).dayDelta },
                            ) { travel ->
                                val delta = CalendarAllDay.move(event.start, event.end, true, days, bar.startIndex, travel.x / columnPx, 0f, zone, store.display.snapMinutes).dayDelta
                                if (delta != 0) {
                                    val start = CalendarDates.startOfDay(CalendarDates.day(event.start, zone).plusDays(delta.toLong()), zone)
                                    scope.launch { store.reschedule(event, start, start + (event.end - event.start)) }
                                }
                                delta != 0
                            },
                        ) { onSelect(group) }
                    }
                    item != null -> LayerBlock(item, now, zone, compact = true, modifier = place) { onSelectLayer(item) }
                }
            }
        }
    }
}
