package work.starlings.android.workspace.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import work.starlings.android.CalGroup
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

/** `MobileCalendarAgendaList`: the period's days, empty days left out. */
@Composable
fun CalendarAgendaList(store: CalendarStore, days: List<LocalDate>, onSelect: (CalGroup) -> Unit, onSelectLayer: (CalendarLayerItem) -> Unit) {
    val agenda = store.agenda(days)
    val now = rememberMinuteClock()
    val c = Starlings.colors
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (agenda.isEmpty()) {
            item {
                Text(stringResource(R.string.cal_nothing_this_week), Modifier.padding(top = 24.dp), style = StarlingsType.subheadline, color = c.secondary)
            }
        }
        agenda.forEach { section ->
            item(key = "day-${section.day}") { DayDivider(section.day) }
            items(store.layersOn(section.day), key = { "${section.day}-${it.id}" }) { item ->
                LayerRow(item, now, store.zone) { onSelectLayer(item) }
            }
            items(section.groups, key = { "${section.day}-${it.id}" }) { group ->
                AgendaRow(group, store.colors(group), store.calendarTitle(group.event.calendarId), now, store.zone) { onSelect(group) }
            }
        }
    }
}

/**
 * `MobileCalendarMonthGrid`: six weeks of cells with the selected day's
 * events listed underneath. Two chips while they fit, then a count.
 */
@Composable
fun CalendarMonthGrid(
    store: CalendarStore,
    days: List<LocalDate>,
    onSelect: (CalGroup) -> Unit,
    onSelectLayer: (CalendarLayerItem) -> Unit,
    /** The pager's neighbours draw their own month, its selected day the anchor's day there. */
    anchor: LocalDate = store.anchor,
) {
    val c = Starlings.colors
    val now = rememberMinuteClock()
    val today = LocalDate.now()
    val month = anchor.withDayOfMonth(1)
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            days.take(7).forEach { day ->
                Text(
                    day.dayOfWeek.getDisplayName(TextStyle.NARROW, Locale.getDefault()),
                    Modifier.weight(1f),
                    style = StarlingsType.caption2.copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center),
                    color = c.secondary,
                )
            }
        }
        days.chunked(7).forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { day ->
                    val groups = store.groupsOn(day)
                    val inMonth = day.month == month.month && day.year == month.year
                    val isToday = day == today
                    val selected = day == anchor
                    val layers = store.layersOn(day)
                    // One layer chip, then events while they fit, then a count.
                    val shownLayers = layers.take(1)
                    val shown = groups.take(if (layers.isEmpty()) 2 else 1)
                    val overflow = groups.size + layers.size - shown.size - shownLayers.size
                    val label = stringResource(R.string.cal_a11y_day_events, CalendarChrome.date(day, "EEEEMMMMd"), groups.size + layers.size)
                    Column(
                        Modifier
                            .weight(1f)
                            .height(84.dp)
                            .background(if (selected) c.elevated else Color.Transparent)
                            .clickable(role = Role.Button) { store.select(day) }
                            .clearAndSetSemantics { contentDescription = label; role = Role.Button; this.selected = selected },
                    ) {
                        HorizontalDivider(thickness = 1.dp, color = c.border)
                        Column(
                            Modifier.padding(horizontal = 2.dp, vertical = 3.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Box(
                                Modifier.size(22.dp).background(if (isToday) c.accent else Color.Transparent, CircleShape),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    "${day.dayOfMonth}",
                                    style = StarlingsType.caption.copy(fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal),
                                    color = when {
                                        isToday -> c.accentInk
                                        inMonth -> c.primary
                                        else -> c.secondary
                                    },
                                )
                            }
                            shownLayers.forEach { item ->
                                LayerBlock(item, now, store.zone, compact = true, modifier = Modifier.fillMaxWidth().height(13.dp))
                            }
                            shown.forEach { group ->
                                EventBlock(group, store.colors(group), now, store.zone, compact = true, modifier = Modifier.fillMaxWidth().height(13.dp))
                            }
                            if (overflow > 0) {
                                Text("+$overflow", style = StarlingsType.caption2, color = c.secondary)
                            }
                        }
                    }
                }
            }
        }
        HorizontalDivider(thickness = 1.dp, color = c.border)
        val groups = store.groupsOn(anchor)
        val layers = store.layersOn(anchor)
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(layers, key = { it.id }) { item ->
                LayerRow(item, now, store.zone) { onSelectLayer(item) }
            }
            if (groups.isEmpty() && layers.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.cal_nothing_this_day),
                        Modifier.fillMaxWidth().padding(top = 18.dp),
                        style = StarlingsType.subheadline,
                        color = c.secondary,
                    )
                }
            } else {
                items(groups, key = { it.id }) { group ->
                    AgendaRow(group, store.colors(group), store.calendarTitle(group.event.calendarId), now, store.zone) { onSelect(group) }
                }
            }
        }
    }
}
