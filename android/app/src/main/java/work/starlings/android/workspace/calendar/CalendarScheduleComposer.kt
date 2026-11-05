package work.starlings.android.workspace.calendar

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.EditCalendar
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.CalEvent
import work.starlings.android.CalendarDates
import work.starlings.android.R
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.FormSheetBar
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.home.roomLink
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

/**
 * `MobileScheduleComposer`: a meeting in the owner's room. The agenda strip
 * shows what is already on each day, published events marked with a globe;
 * then the title, when (start, a duration, the zone), the guests and the
 * room's join link. Add writes it to the calendar with the guests invited.
 */
@Composable
fun CalendarScheduleComposer(store: CalendarStore, onClose: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences("calendar", Context.MODE_PRIVATE) }
    val defaultTitle = stringResource(R.string.cal_default_meeting_title)
    var title by remember { mutableStateOf(defaultTitle) }
    var start by remember { mutableStateOf(CalendarSchedule.nextQuarterHour(System.currentTimeMillis())) }
    var duration by remember { mutableStateOf(CalendarDisplay.DEFAULT_DURATION) }
    // The workspace's shortlist only (`StarlingsScheduleTimeZone.offered`).
    val zones = store.offeredZones
    var zone by remember(zones) {
        mutableStateOf(CalendarSchedule.preferred(prefs.getString(ZONE_KEY, null), ZoneId.systemDefault().id, offered = zones))
    }
    var guests by remember { mutableStateOf<List<String>>(emptyList()) }
    var typed by remember { mutableStateOf("") }
    var weekends by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf<Boolean?>(null) }
    var agenda by remember { mutableStateOf<Pair<List<CalEvent>, List<CalendarLayerItem>>>(emptyList<CalEvent>() to emptyList()) }
    val zoneId = ZoneId.of(zone.zone)
    val end = start + duration * 60_000L
    val room = store.room
    val canAdd = !creating && title.isNotBlank() && room != null

    LaunchedEffect(Unit) { agenda = store.scheduleAgenda(50) }
    val contacts by rememberDeviceContacts()

    fun create() {
        guests = CalendarSchedule.addGuest(guests, typed).also { if (it != guests) typed = "" }
        if (!canAdd) return
        creating = true
        scope.launch {
            val ok = store.schedule(title, start, end, guests, zone.zone)
            creating = false
            if (ok) onClose()
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        FormSheetBar(
            title = stringResource(R.string.cal_schedule_title),
            closeLabel = stringResource(R.string.cal_close),
            onClose = onClose,
            confirm = stringResource(if (creating) R.string.cal_adding else R.string.cal_add),
            confirmEnabled = canAdd,
            onConfirm = ::create,
        )
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Caps(stringResource(R.string.cal_agenda_caps), Modifier.weight(1f))
                    if (agenda.second.isNotEmpty()) {
                        Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Public, null, Modifier.size(12.dp), tint = c.secondary)
                            Text(stringResource(R.string.cal_public), style = StarlingsType.caption, color = c.secondary)
                        }
                    }
                    val weekendsLabel = stringResource(R.string.cal_weekends)
                    Switch(weekends, { weekends = it }, Modifier.semantics { contentDescription = weekendsLabel })
                    Text(weekendsLabel, style = StarlingsType.caption, color = c.primary)
                }
                AgendaStrip(start, zoneId, agenda.first, agenda.second, weekends) { day ->
                    val time = Instant.ofEpochMilli(start).atZone(zoneId).toLocalTime()
                    start = LocalDateTime.of(day, time).atZone(zoneId).toInstant().toEpochMilli()
                }
            }

            Labeled(stringResource(R.string.cal_title).uppercase(Locale.getDefault())) {
                StarlingsField(title, { title = it }, stringResource(R.string.cal_meeting_title))
            }

            Card {
                Caps(stringResource(R.string.cal_when_caps))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.cal_starts), Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
                    val day = CalendarDates.day(start, zoneId)
                    Pill(CalendarChrome.date(day, "dMMMyyyy"), selected = false) { picking = false }
                    Spacer(Modifier.width(8.dp))
                    Pill(CalendarChrome.time(start, zoneId), selected = false) { picking = true }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CalendarSchedule.durations.forEach { minutes ->
                        Pill(stringResource(R.string.cal_duration_minutes, minutes), selected = duration == minutes, Modifier.weight(1f)) { duration = minutes }
                    }
                }
                Text(stringResource(R.string.cal_ends_at, CalendarChrome.time(end, zoneId)), style = StarlingsType.caption, color = c.secondary)
                Caps(stringResource(R.string.cal_timezone_caps))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    zones.forEach { option ->
                        Pill(option.code, selected = option == zone, spoken = option.city) {
                            zone = option
                            prefs.edit().putString(ZONE_KEY, option.id).apply()
                        }
                    }
                }
            }

            Labeled(stringResource(R.string.cal_guests).uppercase(Locale.getDefault())) {
                guests.forEach { email ->
                    val remove = stringResource(R.string.cal_remove_named, email)
                    Row(
                        Modifier.fillMaxWidth().background(c.elevated, RoundedCornerShape(StarlingsRadius.field)).padding(10.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Person, null, Modifier.size(16.dp), tint = c.primary)
                        Text(email, Modifier.weight(1f), style = StarlingsType.subheadline, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Icon(
                            Icons.Filled.Cancel, null,
                            Modifier
                                .size(20.dp)
                                .clickable(role = Role.Button) { guests = guests - email }
                                .clearAndSetSemantics { contentDescription = remove; role = Role.Button },
                            tint = c.secondary,
                        )
                    }
                }
                StarlingsField(
                    typed,
                    { value ->
                        // A comma, a space or a return ends an address.
                        if (value.endsWith(",") || value.endsWith(" ") || value.endsWith("\n")) {
                            guests = CalendarSchedule.addGuest(guests, value.dropLast(1))
                            typed = ""
                        } else {
                            typed = value
                        }
                    },
                    stringResource(R.string.cal_type_name_or_email),
                    keyboardType = KeyboardType.Email,
                )
                DeviceContacts.matching(contacts, typed, guests).forEach { contact ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(StarlingsRadius.field))
                            .clickable(role = Role.Button) {
                                guests = CalendarSchedule.addGuest(guests, contact.email)
                                typed = ""
                            }
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(contact.name.ifEmpty { contact.email }, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (contact.name.isNotEmpty()) {
                                Text(contact.email, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        Icon(Icons.Outlined.AddCircleOutline, null, Modifier.size(20.dp), tint = c.primary)
                    }
                }
            }

            room?.let { owned ->
                Card {
                    Caps(stringResource(R.string.cal_join_link_caps))
                    Text(roomLink(owned.slug), style = StarlingsType.footnote.copy(fontFamily = FontFamily.Monospace), color = c.primary)
                }
            }

            FilledButton(
                stringResource(if (creating) R.string.cal_adding_to_calendar else R.string.cal_add_to_calendar),
                ::create,
                Modifier.fillMaxWidth(),
                enabled = canAdd,
                icon = Icons.Filled.EditCalendar,
            )
        }
    }

    picking?.let { time ->
        if (time) ScheduleTimeDialog(start, zoneId, onDismiss = { picking = null }) { start = it; picking = null }
        else ScheduleDateDialog(start, zoneId, onDismiss = { picking = null }) { start = it; picking = null }
    }
}

private const val ZONE_KEY = "meet.schedule.timeZone"

@Composable
private fun Caps(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = Starlings.colors.secondary)
}

@Composable
private fun Labeled(label: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Caps(label)
        content()
    }
}

/** `StarlingsCard`: the elevated rung with the hairline. */
@Composable
private fun Card(content: @Composable ColumnScope.() -> Unit) {
    val c = Starlings.colors
    val shape = RoundedCornerShape(StarlingsRadius.control)
    Column(
        Modifier.fillMaxWidth().background(c.elevated, shape).border(1.dp, c.border, shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        content = content,
    )
}

/** A duration or zone chip: the accent when chosen, the elevated rung otherwise. */
@Composable
private fun Pill(text: String, selected: Boolean, modifier: Modifier = Modifier, spoken: String = text, onClick: () -> Unit) {
    val c = Starlings.colors
    Text(
        text,
        modifier
            .heightIn(min = 34.dp)
            .background(if (selected) c.accent else c.field, RoundedCornerShape(StarlingsRadius.field))
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; this.selected = selected }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold, textAlign = androidx.compose.ui.text.style.TextAlign.Center),
        color = if (selected) c.accentInk else c.primary,
    )
}

/** `MobileAgendaStrip`: one card per day; tapping a day keeps the time and moves the date. */
@Composable
private fun AgendaStrip(start: Long, zone: ZoneId, events: List<CalEvent>, published: List<CalendarLayerItem>, weekends: Boolean, onPick: (LocalDate) -> Unit) {
    val c = Starlings.colors
    val days = CalendarSchedule.stripDays(LocalDate.now(zone), weekends)
    val chosen = CalendarDates.day(start, zone)
    val state = rememberLazyListState()
    LaunchedEffect(chosen, weekends) {
        val index = days.indexOf(chosen)
        if (index >= 0) state.animateScrollToItem(maxOf(0, index - 1))
    }
    LazyRow(state = state, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(days, key = { it.toString() }) { day ->
            val selected = day == chosen
            val shape = RoundedCornerShape(StarlingsRadius.control)
            val own = events.filter { !it.allDay && CalendarDates.day(it.start, zone) == day }.sortedBy { it.start }
            val public = published.filter { CalendarDates.day(it.start, zone) == day }
            val label = CalendarChrome.date(day, "EEEEMMMMd")
            Column(
                Modifier
                    .width(132.dp)
                    .height(205.dp)
                    .background(if (selected) c.selected else c.elevated, shape)
                    .border(1.dp, if (selected) c.secondary.copy(alpha = 0.55f) else c.border, shape)
                    .clickable(role = Role.Button) { onPick(day) }
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button; this.selected = selected }
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Text(CalendarChrome.date(day, "EEE"), style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = c.primary)
                Text(CalendarChrome.date(day, "MMMd"), style = StarlingsType.headline, color = c.primary)
                HorizontalDivider(thickness = 1.dp, color = c.border)
                if (own.isEmpty() && public.isEmpty()) {
                    Text(stringResource(R.string.cal_open_day), style = StarlingsType.caption, color = c.secondary)
                } else {
                    val context = LocalContext.current
                    val rows = own.map { Triple(it.shownTitle ?: context.getString(R.string.cal_new_event), it.start, false) } +
                        public.map { Triple(CalendarLayerChrome.displayTitle(context, it), if (it.allDay) null else it.start, true) }
                    rows.sortedBy { it.second ?: CalendarDates.startOfDay(day, zone) }.take(5).forEach { (name, at, isPublic) ->
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .background(if (isPublic) c.panel else c.canvas, RoundedCornerShape(StarlingsRadius.field))
                                .then(if (isPublic) Modifier.border(1.dp, c.secondary.copy(alpha = 0.5f), RoundedCornerShape(StarlingsRadius.field)) else Modifier)
                                .padding(7.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (isPublic) Icon(Icons.Outlined.Public, null, Modifier.size(11.dp), tint = c.primary)
                                Text(name, style = StarlingsType.caption.copy(fontWeight = FontWeight.Medium), color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                            at?.let { Text(CalendarChrome.time(it, zone), style = StarlingsType.caption2, color = c.secondary) }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScheduleDateDialog(ms: Long, zone: ZoneId, onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val local = Instant.ofEpochMilli(ms).atZone(zone)
    // The Material picker speaks UTC midnights.
    val state = rememberDatePickerState(initialSelectedDateMillis = local.toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton({
                val picked = state.selectedDateMillis?.let { Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }
                if (picked == null) onDismiss() else onPick(LocalDateTime.of(picked, local.toLocalTime()).atZone(zone).toInstant().toEpochMilli())
            }) { Text(stringResource(R.string.cal_ok)) }
        },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.cal_cancel)) } },
    ) { DatePicker(state) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScheduleTimeDialog(ms: Long, zone: ZoneId, onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val local = Instant.ofEpochMilli(ms).atZone(zone)
    val state = rememberTimePickerState(local.hour, local.minute, is24Hour = true)
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton({ onPick(LocalDateTime.of(local.toLocalDate(), LocalTime.of(state.hour, state.minute)).atZone(zone).toInstant().toEpochMilli()) }) {
                Text(stringResource(R.string.cal_ok))
            }
        },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.cal_cancel)) } },
        text = { TimePicker(state) },
    )
}
