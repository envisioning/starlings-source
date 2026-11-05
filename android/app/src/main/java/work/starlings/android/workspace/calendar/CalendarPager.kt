package work.starlings.android.workspace.calendar

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * Where a strip has been dragged to (`MobileCalendarPageMotion`). A swipe is
 * never a data swap: the neighbours are built before the finger lands, the
 * release only finishes a movement that already happened, and once it has
 * played the anchor moves and the strip re-centres in the same frame.
 */
class CalendarPageMotion(private val scope: CoroutineScope) {
    internal val drag = Animatable(0f)
    private var settling = false
    private var travel = 0f

    val offset: Float get() = drag.value

    internal fun began() {
        if (!settling) travel = 0f
    }

    internal fun dragged(amount: Float, width: Float) {
        if (settling) return
        travel += amount
        scope.launch { drag.snapTo(CalendarPaging.rubberBanded(travel, width)) }
    }

    internal fun finished(velocity: Float, width: Float, fling: Float, onSettle: (Int) -> Unit) {
        if (settling) return
        val direction = CalendarPaging.direction(travel, velocity, width, fling)
        scope.launch {
            if (direction == 0) {
                drag.animateTo(0f, spring(dampingRatio = 0.86f, stiffness = 500f))
                return@launch
            }
            settling = true
            drag.animateTo(-direction * width, spring(dampingRatio = 0.88f, stiffness = 400f))
            onSettle(direction)
            drag.snapTo(0f)
            settling = false
        }
    }
}

@Composable
fun rememberCalendarPageMotion(): CalendarPageMotion {
    val scope = rememberCoroutineScope()
    return remember { CalendarPageMotion(scope) }
}

/**
 * The page gesture: sideways only, so a vertical drag stays the grid's
 * scroll (the touch slop decides the axis). [width] is how far one step
 * travels: a page for Month and List, a column for the day grids.
 */
fun Modifier.pageDrag(motion: CalendarPageMotion, width: () -> Float, onSettle: (Int) -> Unit): Modifier = pointerInput(motion) {
    val tracker = VelocityTracker()
    val fling = CalendarPaging.FLING_DP_PER_SECOND.dp.toPx()
    detectHorizontalDragGestures(
        onDragStart = { tracker.resetTracking(); motion.began() },
        onDragEnd = { motion.finished(tracker.calculateVelocity().x, width(), fling, onSettle) },
        onDragCancel = { motion.finished(0f, width(), fling, onSettle) },
    ) { change, amount ->
        tracker.addPosition(change.uptimeMillis, change.position)
        motion.dragged(amount, width())
    }
}

/**
 * A run [visible] columns wide with one column of runway each side, pinned
 * to the leading edge and clipped: the day grids' heads, band and hours.
 */
@Composable
fun CalendarColumnStrip(motion: CalendarPageMotion, visible: Int, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Layout(content, modifier.clipToBounds()) { measurables, constraints ->
        val width = constraints.maxWidth
        val column = width.toFloat() / visible
        val total = (column * (visible + 2)).roundToInt()
        val placeable = measurables.firstOrNull()?.measure(constraints.copy(minWidth = total, maxWidth = total))
        layout(width, placeable?.height ?: 0) {
            placeable?.placeRelative((-column + motion.offset).roundToInt(), 0)
        }
    }
}

/**
 * `MobileCalendarPager`: three periods side by side, moved by the finger,
 * for Month and List. [page] builds the period `offset` steps from the
 * anchor: -1, 0 or 1.
 */
@Composable
fun CalendarPager(onSettle: (Int) -> Unit, modifier: Modifier = Modifier, page: @Composable (Int) -> Unit) {
    val motion = rememberCalendarPageMotion()
    val settle by rememberUpdatedState(onSettle)
    val widthPx = remember { floatArrayOf(1f) }
    Layout(
        content = { for (offset in -1..1) Box(Modifier.fillMaxSize()) { page(offset) } },
        modifier = modifier.clipToBounds().pageDrag(motion, { widthPx[0] }) { settle(it) },
    ) { measurables, constraints ->
        val width = constraints.maxWidth
        widthPx[0] = width.toFloat()
        val fixed = constraints.copy(minWidth = width, maxWidth = width, minHeight = constraints.maxHeight)
        val placeables = measurables.map { it.measure(fixed) }
        layout(width, constraints.maxHeight) {
            placeables.forEachIndexed { index, p -> p.placeRelative(((index - 1) * width + motion.offset).roundToInt(), 0) }
        }
    }
}
