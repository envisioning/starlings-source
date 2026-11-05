package work.starlings.android.workspace.calendar

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import work.starlings.android.R
import java.time.ZoneId
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import work.starlings.android.CalGroup
import work.starlings.android.CalendarDates
import work.starlings.android.CalendarMerge
import work.starlings.android.CalendarPacking
import work.starlings.android.CalendarTile
import work.starlings.android.TimedSpan
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import java.time.DayOfWeek
import java.time.LocalDate
import java.util.Locale
import kotlin.math.roundToInt

/**
 * `MobileCalendarTimeGrid`: the date heads and the all-day band stay put,
 * the hours scroll under them, one column per day. Tapping empty space
 * starts a new event at the snap step tapped; tapping a block opens it.
 * Two fingers pinch the hours taller or shorter, inside the range and kept
 * on the device (`zoom`); the hour at the top stays at the top.
 *
 * A sideways drag moves the days by a column (`MobileCalendarPager`'s
 * physics) with the hour gutter pinned: the heads, the band and the hours
 * carry a day of runway each side, so what arrives is the real next day.
 */
@Composable
fun CalendarTimeGrid(
    store: CalendarStore,
    onSelect: (CalGroup) -> Unit,
    onSelectLayer: (CalendarLayerItem) -> Unit,
    onCreate: ((Long) -> Unit)?,
) {
    val c = Starlings.colors
    val days = store.days
    val run = listOf(days.first().minusDays(1)) + days + listOf(days.last().plusDays(1))
    val zone = store.zone
    val now = rememberMinuteClock()
    val display = store.display
    val hour = display.hourHeight.dp
    val second = display.secondaryZone
    val gutter = CalendarChrome.gutterWidth(second != null)
    val today = LocalDate.now()
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val motion = rememberCalendarPageMotion()
    // One column's width in pixels, read by the drag when it ends.
    val column = remember { floatArrayOf(1f) }

    // Open on the working day rather than at midnight.
    LaunchedEffect(days.first()) {
        val nowHour = java.time.LocalTime.now().hour
        val start = display.dayStartHour
        val anchorHour = (if (today in days) maxOf(start, nowHour - 1) else start).coerceIn(0, 20)
        scroll.scrollTo(with(density) { (hour * anchorHour).roundToPx() })
    }

    Column(Modifier.fillMaxSize().pageDrag(motion, { column[0] }) { store.step(it) }) {
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Spacer(Modifier.width(gutter))
            CalendarColumnStrip(motion, days.size, Modifier.weight(1f).onSizeChanged { column[0] = it.width.toFloat() / days.size }) {
                Row {
                    run.forEachIndexed { index, day ->
                        val runway = if (index == 0 || index == run.lastIndex) Modifier.clearAndSetSemantics { } else Modifier
                        DayHead(day, store.weather[day.toString()], single = days.size == 1, Modifier.weight(1f).then(runway)) { store.select(day) }
                    }
                }
            }
        }
        // Milestones and dated published events share the band, so their rows cannot collide.
        Row(Modifier.fillMaxWidth()) {
            Spacer(Modifier.width(gutter))
            CalendarColumnStrip(motion, days.size, Modifier.weight(1f)) {
                AllDayBand(store, run, now, 0.dp, onSelect, onSelectLayer)
            }
        }
        HorizontalDivider(thickness = 1.dp, color = c.border)
        val zoomIn = stringResource(R.string.cal_zoom_in)
        val zoomOut = stringResource(R.string.cal_zoom_out)
        // Read by the pinch when it ends; the gesture outlives a composition.
        val viewport = remember { mutableFloatStateOf(0f) }
        BoxWithConstraints(Modifier.fillMaxSize()) {
        val height = constraints.maxHeight.toFloat()
        SideEffect { viewport.floatValue = height }
        Row(
            Modifier
                .fillMaxWidth()
                .pinchHours(store, topHour = {
                    val step = with(density) { store.display.hourHeight.dp.toPx() }
                    (scroll.value / step).toInt().coerceIn(0, 23)
                }) { anchorHour ->
                    // The hours grew or shrank under an offset in pixels: put the hour that
                    // was at the top back there, or 00:00 when the whole day now fits.
                    scope.launch {
                        withFrameNanos { }
                        val step = with(density) { store.display.hourHeight.dp.toPx() }
                        scroll.scrollTo(if (step * 24 + with(density) { 24.dp.toPx() } <= viewport.floatValue) 0 else (step * anchorHour).roundToInt())
                    }
                }
                .semantics {
                    customActions = listOf(
                        CustomAccessibilityAction(zoomIn) { store.zoomHours(1.25f); true },
                        CustomAccessibilityAction(zoomOut) { store.zoomHours(0.8f); true },
                    )
                }
                .verticalScroll(scroll)
                .padding(bottom = 24.dp),
        ) {
            Column(Modifier.width(gutter)) {
                for (h in 0 until 24) {
                    Column(Modifier.width(gutter).height(hour).padding(end = 4.dp), horizontalAlignment = Alignment.End) {
                        Text("%02d".format(h), style = StarlingsType.caption2, color = c.secondary, maxLines = 1)
                        if (second != null) {
                            val other = CalendarDisplay.secondaryHour(h, days.first(), zone, ZoneId.of(second.zone))
                            Text("%02d".format(other), style = StarlingsType.caption2, color = c.secondary.copy(alpha = 0.72f), maxLines = 1)
                        }
                    }
                }
            }
            CalendarColumnStrip(motion, days.size, Modifier.weight(1f)) {
                Row {
                    run.forEachIndexed { index, day ->
                        // The runway is off screen: TalkBack reads the days shown, and pages with Previous and Next.
                        val runway = if (index == 0 || index == run.lastIndex) Modifier.clearAndSetSemantics { } else Modifier
                        DayColumn(store, run, day, first = index == 0, now = now, hour = hour, modifier = Modifier.weight(1f).then(runway), onSelect = onSelect, onSelectLayer = onSelectLayer, onCreate = onCreate)
                    }
                }
            }
        }
        }
    }
}

/**
 * Two fingers on the hours: the height the pinch started from times its
 * scale, drawn live and kept when the fingers lift. Read on the initial pass
 * so a pinch never also scrolls the day or presses a card; one finger is left
 * alone. [onEnd] gets the hour that was at the top when the pinch began.
 */
private fun Modifier.pinchHours(store: CalendarStore, topHour: () -> Int, onEnd: (Int) -> Unit): Modifier = pointerInput(store) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
        var base: Float? = null
        var scale = 1f
        var anchor = 0
        do {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            val pressed = event.changes.count { it.pressed }
            if (pressed >= 2) {
                if (base == null) {
                    base = store.display.hourHeight
                    anchor = topHour()
                }
                scale *= event.calculateZoom()
                store.previewHourHeight(CalendarDisplay.zoomed(base, scale))
                event.changes.forEach { it.consume() }
            }
        } while (event.changes.any { it.pressed })
        if (base != null) {
            store.updateDisplay(store.display)
            onEnd(anchor)
        }
    }
}

/**
 * `dayHead`: the day and its sky on one line where the column is wide (a
 * single day), the sky under the date in a run of narrow columns.
 */
@Composable
private fun DayHead(day: LocalDate, forecast: DailyForecast?, single: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val date = CalendarChrome.date(day, "EEEEMMMMd")
    val spoken = forecast?.let { stringResource(R.string.cal_weather_spoken, date, stringResource(it.condition.label), it.summary) } ?: date
    val head = modifier
        .clickable(role = Role.Button, onClick = onClick)
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button }
    if (single || forecast == null) {
        Row(head, horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            DayMark(day, single)
            forecast?.let { SkyMark(it) }
        }
    } else {
        Column(head, horizontalAlignment = Alignment.CenterHorizontally) {
            DayMark(day, single)
            SkyMark(forecast)
        }
    }
}

/** `dayMark`: the weekday beside the date; the accent marks today only in a run of days. */
@Composable
private fun DayMark(day: LocalDate, single: Boolean) {
    val c = Starlings.colors
    val isToday = day == LocalDate.now()
    val marks = isToday && !single
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            CalendarChrome.date(day, "EEE").uppercase(Locale.getDefault()),
            style = StarlingsType.caption2,
            color = if (marks) c.accent else c.secondary,
            maxLines = 1,
        )
        Box(Modifier.size(22.dp).background(if (marks) c.accent else Color.Transparent, CircleShape), contentAlignment = Alignment.Center) {
            Text(
                "${day.dayOfMonth}",
                style = StarlingsType.subheadline.copy(fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal),
                color = if (marks) c.accentInk else c.primary,
            )
        }
    }
}

@Composable
private fun DayColumn(
    store: CalendarStore,
    days: List<LocalDate>,
    day: LocalDate,
    first: Boolean,
    now: Long,
    hour: Dp,
    modifier: Modifier,
    onSelect: (CalGroup) -> Unit,
    onSelectLayer: (CalendarLayerItem) -> Unit,
    onCreate: ((Long) -> Unit)?,
) {
    val c = Starlings.colors
    val zone = store.zone
    val scope = rememberCoroutineScope()
    val originIndex = days.indexOf(day).coerceAtLeast(0)
    val dayStart = CalendarDates.startOfDay(day, zone)
    val groups = CalendarMerge.consolidate(store.events.filter { !it.allDay }, zone)
    val byId = groups.associateBy { it.id }
    val dayEnd = CalendarDates.startOfDay(day.plusDays(1), zone)
    // A task due at 15:00 and a meeting at 15:00 share the width: one packing pass for both.
    val timedLayers = store.layersOn(day).filter { !it.allDay }
    val layersById = timedLayers.associateBy { it.id }
    val spans = groups.mapNotNull { CalendarPacking.daySegment(it.event, day, zone) } +
        timedLayers.map { TimedSpan(it.id, maxOf(it.start, dayStart), minOf(it.end, dayEnd)) }
    val packs = CalendarPacking.pack(spans).associateBy { it.id }
    val weekend = day.dayOfWeek == DayOfWeek.SATURDAY || day.dayOfWeek == DayOfWeek.SUNDAY
    val border = c.border
    val accent = c.accent
    BoxWithConstraints(
        modifier
            .height(hour * 24)
            .background(if (weekend) c.panel.copy(alpha = 0.5f) else Color.Transparent)
            .then(
                if (onCreate == null) Modifier else Modifier.pointerInput(day, hour, store.display.snapMinutes) {
                    detectTapGestures { offset ->
                        val minutes = (offset.y / hour.toPx() * 60).toInt()
                        val snap = store.display.snapMinutes
                        val snapped = (minutes / snap) * snap
                        onCreate(dayStart + snapped * 60_000L)
                    }
                },
            ),
    ) {
        val width = maxWidth
        val columnPx = constraints.maxWidth.toFloat()
        val hourPx = with(LocalDensity.current) { hour.toPx() }
        spans.forEach { span ->
            val pack = packs[span.id] ?: return@forEach
            val group = byId[span.id]
            val top = hour * ((span.start - dayStart) / 3_600_000f)
            val height = maxOf(18.dp, hour * ((span.end - span.start) / 3_600_000f) - 2.dp)
            val usable = maxOf(0.dp, width - 2.dp)
            val blockWidth = minOf(usable, maxOf(24.dp, usable * pack.widthFraction.toFloat()))
            val x = minOf(1.dp + usable * pack.leadingFraction.toFloat(), maxOf(1.dp, width - 1.dp - blockWidth))
            val layer = layersById[span.id]
            if (group == null) {
                if (layer != null) {
                    LayerBlock(layer, now, zone, compact = false, modifier = Modifier.offset(x = x, y = top).width(blockWidth).height(height)) { onSelectLayer(layer) }
                }
                return@forEach
            }
            val rows = CalendarTile.rows(height.value, 15f, 12f, 4f, hasLocation = false)
            val event = group.event
            fun moveOf(travel: Offset) = CalendarAllDay.move(
                event.start, event.end, false, days, originIndex,
                travel.x / maxOf(1f, columnPx), travel.y / hourPx * 60f, zone, store.display.snapMinutes,
            )
            EventBlock(
                group, store.colors(group), now, zone, compact = false,
                // A long press picks the card up: columns sideways, snapped minutes down, the length kept.
                modifier = Modifier.offset(x = x, y = top).width(blockWidth).height(height).longPressMove(
                    canMove(event), event.id,
                    snap = { travel -> moveOf(travel).start },
                ) { travel ->
                    val move = moveOf(travel)
                    val moved = move.start != event.start || move.end != event.end
                    if (moved) scope.launch { store.reschedule(event, move.start, move.end) }
                    moved
                },
                showsTime = rows.time,
            ) { onSelect(group) }
        }
        // Over the cards, so a start and an end stay legible through a block.
        Canvas(Modifier.fillMaxSize()) {
            val step = hour.toPx()
            // Half hours only where an hour is tall enough to carry them (`drawsHalfHours`).
            val halves = hour >= 40.dp
            for (h in 0 until 24) {
                drawLine(border, Offset(0f, step * h), Offset(size.width, step * h), strokeWidth = 1f)
                if (halves) drawLine(border.copy(alpha = border.alpha * 0.5f), Offset(0f, step * h + step / 2), Offset(size.width, step * h + step / 2), strokeWidth = 0.5f)
            }
            if (!first) drawLine(border, Offset(0f, 0f), Offset(0f, size.height), strokeWidth = 1f)
            if (day == CalendarDates.day(now, zone)) {
                val y = (now - dayStart) / 3_600_000f * step
                drawLine(accent, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
            }
        }
    }
}
