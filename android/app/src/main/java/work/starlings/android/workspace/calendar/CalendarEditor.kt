package work.starlings.android.workspace.calendar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.CalEvent
import work.starlings.android.CalSource
import work.starlings.android.CalendarDates
import work.starlings.android.CalendarPeople
import work.starlings.android.CalendarValues
import work.starlings.android.R
import work.starlings.android.ui.FormSheetBar
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SegmentedChoice
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.CalendarFreeBusyPerson
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneOffset

/**
 * `MobileCalendarEditorForm`: create and edit are one form; only the title
 * and the save differ. Writes go to Google or the phone's own calendars. A new event lands on
 * the slot it was opened for, or the next quarter hour.
 */
@Composable
fun CalendarEditor(
    store: CalendarStore,
    editing: CalEvent?,
    initialStart: Long?,
    initialEnd: Long?,
    onClose: () -> Unit,
    onSaved: () -> Unit,
    prefill: QuickAddPrefill? = null,
) {
    val c = Starlings.colors
    val zone = store.zone
    val scope = rememberCoroutineScope()
    val self = editing?.attendees?.firstOrNull { it.isSelf }?.email?.lowercase()
    var draft by remember {
        mutableStateOf(
            if (editing != null) {
                CalendarDraft(
                    title = editing.title,
                    start = editing.start,
                    end = editing.end,
                    allDay = editing.allDay,
                    calendarId = editing.calendarId,
                    location = editing.location,
                    notes = editing.notes,
                    attendees = editing.attendeeEmails,
                    joinUrl = editing.joinUrl.ifEmpty { null },
                    roomSlug = editing.roomSlug.ifEmpty { null },
                    travelTimeMinutes = editing.travelTimeMinutes ?: 0,
                )
            } else {
                val start = prefill?.start ?: initialStart ?: work.starlings.android.CalendarPacking.snapUp(System.currentTimeMillis(), store.display.snapMinutes)
                CalendarDraft(
                    title = prefill?.title.orEmpty(),
                    start = start,
                    end = prefill?.end?.takeIf { prefill.start != null }
                        ?: initialEnd ?: (start + store.display.durationMinutes * 60_000L),
                    allDay = prefill?.start != null && prefill.allDay,
                    calendarId = store.defaultWriteCalendar?.id ?: store.writableCalendars.firstOrNull()?.id.orEmpty(),
                    location = prefill?.location.orEmpty(),
                )
            },
        )
    }
    // Everyone but you: the list the save writes.
    var attendees by remember { mutableStateOf(editing?.attendeeEmails?.map { it.lowercase() }?.filter { it != self } ?: prefill?.invitees.orEmpty()) }
    var invitee by remember { mutableStateOf("") }
    var wholeSeries by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var calendarMenu by remember { mutableStateOf(false) }
    var travelMenu by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf<Picking?>(null) }
    var addsRoomLink by remember { mutableStateOf(false) }
    var suggestions by remember { mutableStateOf<List<CalendarAvailability.Suggestion>>(emptyList()) }
    var availability by remember { mutableStateOf<List<CalendarFreeBusyPerson>>(emptyList()) }
    var checking by remember { mutableStateOf(false) }
    // Contacts, once per editor, for Add invitee's completions: the roster
    // first (it knows names), then whoever Contacts knows by address.
    val contacts by rememberDeviceContacts()
    var roster by remember { mutableStateOf<List<CalendarAvailability.Suggestion>>(emptyList()) }
    LaunchedEffect(Unit) { roster = store.inviteeSuggestions() }
    LaunchedEffect(roster, contacts) {
        val seen = roster.map { it.email }.toMutableSet()
        suggestions = roster + contacts.filter { seen.add(it.email) }.map { CalendarAvailability.Suggestion(it.email, it.name.ifEmpty { it.email }) }
    }
    // Names Quick add read after "with", matched once contacts load.
    var pendingNames by remember { mutableStateOf(prefill?.names.orEmpty()) }
    LaunchedEffect(contacts) {
        if (pendingNames.isEmpty() || contacts.isEmpty()) return@LaunchedEffect
        attendees = DeviceContacts.matchNames(contacts, pendingNames, attendees).filter { it != self }
        pendingNames = emptyList()
    }
    // Only for timed events with guests, on the Google account the owner connected.
    val wantsAvailability = !draft.allDay && attendees.isNotEmpty() && store.googleConnected == true
    val availabilityDay = CalendarDates.day(draft.start, zone)
    // Re-asks when the guests or the day change, after a pause so typing is one request.
    LaunchedEffect(wantsAvailability, attendees.sorted().joinToString(","), availabilityDay) {
        if (!wantsAvailability) { availability = emptyList(); return@LaunchedEffect }
        kotlinx.coroutines.delay(450)
        checking = true
        availability = store.freeBusy(attendees, availabilityDay)
        checking = false
    }
    val room = store.room
    // The call link, whole: the link the event has, or the room a new one will carry.
    val callLink = draft.joinUrl?.ifEmpty { null } ?: room?.takeIf { addsRoomLink }?.let { work.starlings.android.workspace.home.roomLink(it.slug) }

    val choices = editing?.let { store.calendarChoices(it) } ?: store.writableCalendars
    val travelAllowed = editing?.let { it.source == CalSource.GOOGLE && it.writable }
        ?: (store.calendar(draft.calendarId)?.source == CalSource.GOOGLE)
    val valid = draft.isValid && !saving

    fun addInvitee() {
        val found = CalendarPeople.emailCandidates(invitee).filter { it !in attendees && it != self }
        if (found.isNotEmpty()) attendees = attendees + found
        invitee = ""
    }

    fun save() {
        addInvitee()
        var payload = draft.copy(
            attendees = attendees,
            attendeesChanged = attendees != (editing?.attendeeEmails?.map { it.lowercase() }?.filter { it != self } ?: emptyList<String>()),
        )
        if (payload.allDay) {
            // All-day ends are the exclusive next midnight.
            val first = CalendarDates.day(payload.start, zone)
            val last = CalendarDates.day(payload.end, zone)
            payload = payload.copy(start = CalendarDates.startOfDay(first, zone), end = CalendarDates.startOfDay(last.plusDays(1), zone))
        }
        if (editing != null && self != null) payload = payload.copy(attendees = payload.attendees + self)
        if (addsRoomLink && room != null) payload = payload.copy(roomSlug = room.slug, joinUrl = work.starlings.android.workspace.home.roomLink(room.slug))
        saving = true
        scope.launch {
            val ok = if (editing != null) store.update(editing, payload, wholeSeries) else store.create(payload)
            saving = false
            if (ok) {
                val moved = editing != null && (editing.start != payload.start || editing.end != payload.end)
                store.noticeInvites(attendees.size, isNew = editing == null, moved = moved, calendarId = editing?.calendarId ?: payload.calendarId)
                onSaved()
            }
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        FormSheetBar(
            title = stringResource(if (editing == null) R.string.cal_new_event else R.string.cal_edit_event),
            closeLabel = stringResource(R.string.cal_close),
            onClose = onClose,
            confirm = stringResource(if (saving) R.string.cal_saving else R.string.cal_save),
            confirmEnabled = valid,
            onConfirm = ::save,
        )
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            ListSection(null) {
                ListRow(divider = true) {
                    StarlingsField(draft.title, { draft = draft.copy(title = it) }, stringResource(R.string.cal_title))
                }
                Box {
                    val chosen = store.calendar(draft.calendarId)
                    val movable = editing?.canMoveBetweenCalendars != false
                    PickerRow(
                        stringResource(R.string.cal_calendar),
                        chosen?.title ?: stringResource(R.string.cal_choose_calendar),
                        enabled = movable,
                    ) { calendarMenu = true }
                    DropdownMenu(calendarMenu, onDismissRequest = { calendarMenu = false }) {
                        choices.forEach { calendar ->
                            DropdownMenuItem(text = { Text(calendar.title) }, onClick = {
                                calendarMenu = false
                                draft = draft.copy(calendarId = calendar.id)
                            })
                        }
                    }
                }
            }
            // What quick add read from the sentence (`describedNote`).
            prefill?.let { read ->
                ListFooter(
                    stringResource(
                        when (read.note) {
                            QuickAddPrefill.Note.MODEL -> R.string.cal_quick_note_model
                            QuickAddPrefill.Note.NO_DATE -> R.string.cal_quick_note_no_date
                            QuickAddPrefill.Note.DAY_ONLY -> R.string.cal_quick_note_day
                            QuickAddPrefill.Note.FILLED -> R.string.cal_quick_note_filled
                        },
                    ),
                    Modifier.padding(top = 0.dp),
                )
            }

            ListSection(null) {
                ListRow(divider = true) {
                    StarlingsToggle(stringResource(R.string.cal_all_day), draft.allDay, { draft = draft.copy(allDay = it) })
                }
                DateTimeRow(stringResource(R.string.cal_starts), draft.start, draft.allDay, store, { picking = Picking(true, false) }, { picking = Picking(true, true) })
                DateTimeRow(stringResource(R.string.cal_ends), draft.end, draft.allDay, store, { picking = Picking(false, false) }, { picking = Picking(false, true) })
            }

            Column {
                SectionTitle(stringResource(R.string.cal_where))
                ListSection(null) {
                    ListRow {
                        StarlingsField(
                            draft.location,
                            { draft = draft.copy(location = it) },
                            stringResource(if (callLink == null) R.string.cal_location else R.string.cal_location_or_link),
                        )
                    }
                    if (travelAllowed && (draft.location.isNotBlank() || draft.travelTimeMinutes > 0)) {
                        Box {
                            val off = stringResource(R.string.cal_off)
                            val minutes = draft.travelTimeMinutes
                            PickerRow(stringResource(R.string.cal_travel_time), if (minutes == 0) off else stringResource(R.string.cal_minutes, minutes)) { travelMenu = true }
                            DropdownMenu(travelMenu, onDismissRequest = { travelMenu = false }) {
                                CalendarValues.travelMinutes.forEach { m ->
                                    DropdownMenuItem(
                                        text = { Text(if (m == 0) off else stringResource(R.string.cal_minutes, m)) },
                                        onClick = { travelMenu = false; draft = draft.copy(travelTimeMinutes = m) },
                                    )
                                }
                            }
                        }
                    }
                    if (room != null && editing?.joinUrl.isNullOrEmpty()) {
                        ListRow(divider = callLink != null) {
                            StarlingsToggle(stringResource(R.string.cal_add_room_link), addsRoomLink, { addsRoomLink = it })
                        }
                    }
                    callLink?.let { CallLinkRow(it) }
                }
            }

            Column {
                SectionTitle(stringResource(R.string.cal_invitees))
                ListSection(null) {
                    if (self != null) {
                        ListRow(divider = true) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                val you = editing?.attendees?.firstOrNull { it.isSelf }
                                Text(you?.name?.ifEmpty { null } ?: self, style = StarlingsType.body, color = c.primary)
                                Text(stringResource(R.string.cal_you), style = StarlingsType.body, color = c.secondary)
                            }
                        }
                    }
                    attendees.forEach { address ->
                        val name = editing?.attendees?.firstOrNull { it.email.lowercase() == address }?.name?.ifEmpty { null }
                            ?: suggestions.firstOrNull { it.email == address }?.name ?: address
                        val remove = stringResource(R.string.cal_remove)
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(name, Modifier.weight(1f), style = StarlingsType.body, color = c.primary, maxLines = 1)
                            Box(
                                Modifier
                                    .size(36.dp)
                                    .clickable(role = Role.Button) { attendees = attendees - address }
                                    .clearAndSetSemantics { contentDescription = "$remove, $name"; role = Role.Button },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(Icons.Filled.Close, null, Modifier.size(18.dp), tint = c.secondary)
                            }
                        }
                    }
                    ListRow {
                        StarlingsField(
                            invitee,
                            { value ->
                                // A comma or a space ends an address, as typing a list does.
                                if (value.endsWith(",") || value.endsWith(" ")) { invitee = value.dropLast(1); addInvitee() } else invitee = value
                            },
                            stringResource(R.string.cal_add_invitee),
                            keyboardType = KeyboardType.Email,
                        )
                    }
                    CalendarAvailability.matches(suggestions, invitee, attendees, self).forEach { match ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable(role = Role.Button) { attendees = attendees + match.email; invitee = "" }
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(match.name, style = StarlingsType.body, color = c.primary, maxLines = 1)
                            if (match.name != match.email) Text(match.email, style = StarlingsType.footnote, color = c.secondary, maxLines = 1)
                        }
                    }
                }
            }

            if (wantsAvailability) {
                CalendarAvailabilitySection(
                    availability,
                    checking,
                    slot = CalendarAvailability.Span(draft.start, maxOf(draft.end, draft.start + 60_000L)),
                    day = availabilityDay,
                    zone = zone,
                ) { picked ->
                    // Tapping the bar picks the time; the length is kept.
                    val length = draft.end - draft.start
                    draft = draft.copy(start = picked, end = picked + maxOf(60_000L, length))
                }
            }

            Column {
                SectionTitle(stringResource(R.string.cal_notes))
                ListSection(null) {
                    ListRow {
                        StarlingsField(draft.notes, { draft = draft.copy(notes = it) }, stringResource(R.string.cal_notes), singleLine = false, maxLines = 8)
                    }
                }
            }

            if (editing?.recurring == true) {
                Column {
                    SectionTitle(stringResource(R.string.cal_apply_to))
                    SegmentedChoice(
                        listOf(stringResource(R.string.cal_this_event), stringResource(R.string.cal_all_events)),
                        if (wholeSeries) 1 else 0,
                        onSelect = { wholeSeries = it == 1 },
                    )
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    picking?.let { pick ->
        val current = if (pick.start) draft.start else draft.end
        val apply: (Long) -> Unit = { value ->
            draft = if (pick.start) {
                // The length is kept when the start moves.
                val length = draft.end - draft.start
                draft.copy(start = value, end = value + maxOf(60_000L, length))
            } else {
                draft.copy(end = value)
            }
            picking = null
        }
        if (pick.time) TimeDialog(current, store, onDismiss = { picking = null }, onPick = apply)
        else DateDialog(current, store, onDismiss = { picking = null }, onPick = apply)
    }
}

private data class Picking(val start: Boolean, val time: Boolean)

@Composable
private fun SectionTitle(text: String) {
    Text(text, Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

@Composable
private fun PickerRow(label: String, value: String, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
        Text(value, style = StarlingsType.body, color = if (enabled) c.secondary else c.secondary.copy(alpha = 0.6f), maxLines = 1)
    }
}

/** `DatePicker("Starts", …)`: the date, and the 24-hour time unless the event is all day. */
@Composable
private fun DateTimeRow(label: String, ms: Long, allDay: Boolean, store: CalendarStore, onDate: () -> Unit, onTime: () -> Unit) {
    val c = Starlings.colors
    val day = CalendarDates.day(ms, store.zone)
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
        Chip(CalendarChrome.date(day, "dMMMyyyy"), "$label, ${CalendarChrome.date(day, "dMMMMyyyy")}", onDate)
        if (!allDay) {
            Spacer(Modifier.size(8.dp))
            val time = CalendarChrome.time(ms, store.zone)
            Chip(time, "$label, $time", onTime)
        }
    }
}

@Composable
private fun Chip(text: String, spoken: String, onClick: () -> Unit) {
    val c = Starlings.colors
    Text(
        text,
        Modifier
            .background(c.field, RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button }
            .padding(horizontal = 10.dp, vertical = 6.dp),
        style = StarlingsType.body,
        color = c.primary,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateDialog(ms: Long, store: CalendarStore, onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val zone = store.zone
    val local = Instant.ofEpochMilli(ms).atZone(zone)
    // The Material picker speaks UTC midnights.
    val state = rememberDatePickerState(initialSelectedDateMillis = local.toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton({
                val picked = state.selectedDateMillis?.let { Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }
                if (picked == null) onDismiss()
                else onPick(LocalDateTime.of(picked, local.toLocalTime()).atZone(zone).toInstant().toEpochMilli())
            }) { Text(stringResource(R.string.cal_ok)) }
        },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.cal_cancel)) } },
    ) {
        DatePicker(state)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeDialog(ms: Long, store: CalendarStore, onDismiss: () -> Unit, onPick: (Long) -> Unit) {
    val zone = store.zone
    val local = Instant.ofEpochMilli(ms).atZone(zone)
    val state = rememberTimePickerState(local.hour, local.minute, is24Hour = true)
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton({
                val day: LocalDate = local.toLocalDate()
                onPick(LocalDateTime.of(day, LocalTime.of(state.hour, state.minute)).atZone(zone).toInstant().toEpochMilli())
            }) { Text(stringResource(R.string.cal_ok)) }
        },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.cal_cancel)) } },
        text = { TimePicker(state) },
    )
}
