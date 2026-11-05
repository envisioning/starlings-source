package work.starlings.android.workspace.calendar

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.CalendarExtraRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.PickerOption
import work.starlings.android.ui.SearchablePickerRow
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.contracts.BookingDayHours
import work.starlings.contracts.BookingSettingsResponse
import work.starlings.contracts.BookingSettingsUpdate

/**
 * Settings › Calendar › Booking hours (`MobileBookingHoursView`):
 * the hours and the zone are the member's profile hours, the rest is how a
 * guest books a slot inside them. Owner-synced with the Mac and the web.
 * Save writes the whole form once, as the web does.
 */
@Composable
fun CalendarBookingHours(store: CalendarStore) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var saved by remember { mutableStateOf<BookingSettingsResponse?>(null) }
    var draft by remember { mutableStateOf<BookingSettingsUpdate?>(null) }
    var saving by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val savedNotice = stringResource(R.string.booking_saved)

    LaunchedEffect(store, attempt) {
        errorMessage = null
        try {
            val loaded = store.account.client.call(CalendarExtraRoutes.bookingSettings)
            saved = loaded
            draft = BookingHours.draft(loaded)
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            errorMessage = e.sentence
        }
    }

    fun change(edit: (BookingSettingsUpdate) -> BookingSettingsUpdate) {
        draft = draft?.let(edit)
        message = null
    }

    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        ListSection(stringResource(R.string.booking_title)) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val path = BookingHours.bookingPath(saved?.room)
                Text(
                    if (path == null) stringResource(R.string.booking_note_none) else stringResource(R.string.booking_note_path, path),
                    style = StarlingsType.footnote,
                    color = c.secondary,
                )
                if (saved?.room != null && store.googleConnected == false) {
                    Text(stringResource(R.string.booking_not_taking), style = StarlingsType.callout, color = c.danger)
                }
            }
            if (draft == null) {
                val failure = errorMessage
                if (failure != null) {
                    WorkErrorNotice(failure, stringResource(R.string.work_retry), onRetry = { attempt++ })
                } else {
                    Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(20.dp), color = c.secondary, strokeWidth = 2.dp)
                    }
                }
            }
        }

        val form = draft ?: return@Column
        ListSection(null) {
            ListRow(divider = true) {
                StarlingsToggle(stringResource(R.string.booking_take), form.active, { on -> change { it.copy(active = on) } }, enabled = !saving)
            }
            val zone = stringResource(R.string.booking_time_zone)
            SearchablePickerRow(
                label = zone,
                placeholder = zone,
                options = BookingHours.timeZoneOptions(form.timezone).map { PickerOption(it, it) },
                selection = form.timezone,
                onPick = { id -> change { it.copy(timezone = id) } },
                emptyMessage = stringResource(R.string.work_no_options_match),
                enabled = !saving,
            )
        }

        ListSection(stringResource(R.string.booking_days)) {
            BookingHours.Weekday.entries.forEachIndexed { index, day ->
                if (index > 0) Divider()
                DayRow(day, BookingHours.hours(form.weeklyHours, day), enabled = !saving) { hours ->
                    change { it.copy(weeklyHours = BookingHours.replacing(it.weeklyHours, day, hours)) }
                }
            }
        }

        ListSection(null) {
            BookingHours.numberFields.forEachIndexed { index, field ->
                if (index > 0) Divider()
                NumberRow(stringResource(field.label), field.get(form), field::clamped, enabled = !saving) { value ->
                    change { field.set(it, field.clamped(value)) }
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledButton(
                stringResource(if (saving) R.string.cal_saving else R.string.booking_save),
                onClick = {
                    saving = true
                    errorMessage = null
                    message = null
                    scope.launch {
                        try {
                            val next = store.account.client.call(CalendarExtraRoutes.saveBookingSettings(form))
                            saved = next
                            draft = BookingHours.draft(next)
                            message = savedNotice
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: StarlingsApiError) {
                            errorMessage = e.sentence
                        } finally {
                            saving = false
                        }
                    }
                },
                enabled = !saving,
            )
            message?.let { Text(it, Modifier.padding(horizontal = 16.dp), style = StarlingsType.footnote, color = c.secondary) }
            errorMessage?.let { Text(it, Modifier.padding(horizontal = 16.dp), style = StarlingsType.footnote, color = c.danger) }
        }
    }
}

/** `dayRow`: the day on or off, then from and until on the quarter-hour clock. */
@Composable
private fun DayRow(day: BookingHours.Weekday, hours: BookingDayHours, enabled: Boolean, onChange: (BookingDayHours) -> Unit) {
    val c = Starlings.colors
    val label = day.label()
    Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        StarlingsToggle(label, hours.enabled, { onChange(hours.copy(enabled = it)) }, enabled = enabled)
        Row(
            Modifier.alpha(if (hours.enabled) 1f else 0.45f).padding(bottom = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ClockMenu(stringResource(R.string.booking_from, label), hours.startMinute.toInt(), enabled && hours.enabled) {
                onChange(hours.copy(startMinute = it.toLong()))
            }
            Text(stringResource(R.string.booking_to), style = StarlingsType.footnote, color = c.secondary)
            ClockMenu(stringResource(R.string.booking_until, label), hours.endMinute.toInt(), enabled && hours.enabled) {
                onChange(hours.copy(endMinute = it.toLong()))
            }
        }
    }
}

/** `clockPicker`: a menu of every quarter hour, its label for TalkBack only. */
@Composable
private fun ClockMenu(label: String, minute: Int, enabled: Boolean, onPick: (Int) -> Unit) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Text(
            BookingHours.clock(minute),
            Modifier
                .clickable(enabled = enabled, role = Role.Button) { open = true }
                .clearAndSetSemantics { contentDescription = "$label, ${BookingHours.clock(minute)}"; role = Role.Button }
                .padding(horizontal = 8.dp, vertical = 6.dp),
            style = StarlingsType.body,
            color = c.accent,
        )
        DropdownMenu(open, onDismissRequest = { open = false }) {
            BookingHours.clockMinutes.forEach { value ->
                DropdownMenuItem(text = { Text(BookingHours.clock(value)) }, onClick = { open = false; onPick(value) })
            }
        }
    }
}

/**
 * `numberRow`: the label, then a number field clamped to the range on each
 * change. What was typed stays while the field has focus; leaving it shows
 * the value in force.
 */
@Composable
private fun NumberRow(label: String, value: Long, clamp: (Long) -> Long, enabled: Boolean, onChange: (Long) -> Unit) {
    val c = Starlings.colors
    var text by remember { mutableStateOf(value.toString()) }
    var sent by remember { mutableStateOf(value) }
    if (value != sent) {
        // Changed from outside (a load or a save): show it.
        text = value.toString()
        sent = value
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.width(8.dp))
        BasicTextField(
            value = text,
            onValueChange = { next ->
                val digits = next.filter(Char::isDigit).take(4)
                text = digits
                digits.toLongOrNull()?.let { sent = clamp(it); onChange(it) }
            },
            enabled = enabled,
            singleLine = true,
            textStyle = StarlingsType.body.copy(color = c.primary, textAlign = TextAlign.End),
            cursorBrush = SolidColor(c.accent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier
                .width(88.dp)
                .onFocusChanged { if (!it.isFocused) text = value.toString() }
                .semantics { contentDescription = label },
        )
    }
}

@Composable
private fun Divider() = HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = Starlings.colors.border)
