package work.starlings.android.core.ui

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import work.starlings.android.R
import work.starlings.android.core.CoreCharacteristicOption
import work.starlings.android.core.CoreFieldContract
import work.starlings.android.core.CoreFields
import work.starlings.android.core.CoreMember
import work.starlings.android.core.CoreRules
import work.starlings.android.core.CoreTarget
import work.starlings.android.core.coreString
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkLabeledRow
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId

/**
 * What the editing controls read beyond the record: each relation entity's
 * records, the characteristics vocabulary and the members directory, loaded
 * by the page that draws them (`loadRelationOptions`, `loadCharacteristicOptions`,
 * `loadMemberOptions`).
 */
internal data class CoreEditOptions(
    val relations: Map<String, List<JsonObject>> = emptyMap(),
    val characteristics: List<CoreCharacteristicOption> = emptyList(),
    val members: List<CoreMember> = emptyList(),
)

/** A labeled menu row: the label, what is chosen, and the choices under a tap (SwiftUI's menu `Picker`). */
@Composable
internal fun CoreMenuRow(label: String, choices: List<Pair<String, String>>, selected: String, trailing: (@Composable () -> Unit)? = null, onPick: (String) -> Unit) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    val chosen = choices.firstOrNull { it.first == selected }?.second ?: selected
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) {
            WorkLabeledRow(label, chosen, onClick = { open = true })
            DropdownMenu(open, { open = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
                choices.forEach { (value, title) ->
                    DropdownMenuItem(
                        text = { Text(title, style = StarlingsType.body, color = c.primary) },
                        trailingIcon = { if (value == selected) Icon(Icons.Filled.Check, null, tint = c.secondary) },
                        onClick = { open = false; onPick(value) },
                    )
                }
            }
        }
        trailing?.invoke()
    }
}

/**
 * `relationOpenControl`: opens the linked record, or with several a menu of
 * them. Nothing when there is nothing to open.
 */
@Composable
internal fun CoreRelationOpen(targets: List<CoreTarget>, onOpen: (CoreTarget) -> Unit) {
    if (targets.isEmpty()) return
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    val single = targets.singleOrNull()
    val label = single?.let { stringResource(R.string.core_open_named, it.title ?: stringResource(R.string.core_record)) } ?: stringResource(R.string.core_open_linked)
    Box {
        Box(
            Modifier
                .padding(end = 8.dp)
                .size(40.dp)
                .clickable(role = Role.Button) { if (single != null) onOpen(single) else open = true }
                .semantics { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.AutoMirrored.Filled.OpenInNew, null, Modifier.size(20.dp), tint = c.secondary) }
        DropdownMenu(open, { open = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
            val record = stringResource(R.string.core_record)
            targets.forEach { target ->
                DropdownMenuItem(text = { Text(target.title ?: record, style = StarlingsType.body, color = c.primary) }, onClick = { open = false; onOpen(target) })
            }
        }
    }
}

/**
 * `TypeaheadPicker`: the label and what is chosen, a field underneath, and
 * the matches inline under it once something is typed. Used for every
 * country and multi-relation pick.
 */
@Composable
internal fun CoreTypeahead(
    label: String,
    prompt: String,
    options: List<CoreFields.Option>,
    multiple: Boolean,
    selection: List<String>,
    onSelection: (List<String>) -> Unit,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = Starlings.colors
    var query by remember { mutableStateOf("") }
    val selected = CoreFields.selected(options, selection)
    val matches = CoreFields.matches(options, selection, query)
    fun pick(option: CoreFields.Option) {
        onSelection(if (multiple) selection + option.id else listOf(option.id))
        query = ""
    }
    @Composable
    fun remove(option: CoreFields.Option) {
        val description = stringResource(R.string.core_remove_named, option.title)
        Box(
            Modifier.size(32.dp).clickable(role = Role.Button) { onSelection(selection - option.id) }.semantics { contentDescription = description },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.Cancel, null, Modifier.size(18.dp), tint = c.secondary.copy(alpha = 0.6f)) }
    }
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
            val only = selected.firstOrNull()
            when {
                !multiple && only != null -> {
                    Text(only.title, Modifier.padding(start = 8.dp), style = StarlingsType.body, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    remove(only)
                }
                selected.isEmpty() -> Text(stringResource(R.string.core_none), Modifier.padding(end = 16.dp), style = StarlingsType.body, color = c.secondary.copy(alpha = 0.6f))
            }
            trailing?.invoke()
        }
        if (multiple) {
            selected.forEach { option ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(option.title, Modifier.weight(1f), style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    remove(option)
                    Spacer(Modifier.width(8.dp))
                }
            }
        }
        Box(Modifier.padding(end = 16.dp)) {
            StarlingsField(query, { query = it }, prompt, onSearch = { matches.firstOrNull()?.let(::pick) })
        }
        if (query.isNotBlank()) {
            if (matches.isEmpty()) {
                Text(stringResource(R.string.core_no_matches), style = StarlingsType.callout, color = c.secondary)
            } else {
                Column(Modifier.padding(end = 16.dp)) {
                    matches.forEach { option ->
                        Text(
                            option.title,
                            Modifier.fillMaxWidth().clickable(role = Role.Button) { pick(option) }.padding(vertical = 8.dp),
                            style = StarlingsType.body,
                            color = c.primary,
                        )
                    }
                }
            }
        }
    }
}

/** A label over a multi-line editor (`labeledStack`). */
@Composable
internal fun CoreStack(label: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = StarlingsType.footnote, color = Starlings.colors.secondary)
        content()
    }
}

/**
 * `stringListBinding`: one value per line. The text stays as typed while the
 * field has it, so a comma or a new line does not vanish under the cursor;
 * the stored list is the parse of it.
 */
@Composable
internal fun CoreStringListField(field: CoreFieldContract, value: JsonElement?, onChange: (JsonElement) -> Unit) {
    val stored = CoreFields.listText(value)
    var text by remember(field.name) { mutableStateOf(stored) }
    if (CoreFields.listText(CoreFields.listValue(text)) != stored) text = stored
    CoreStack(field.label) {
        StarlingsField(text, { text = it; onChange(CoreFields.listValue(it)) }, field.placeholder.orEmpty(), label = field.label, singleLine = false, maxLines = 8)
    }
}

/**
 * `CharacteristicPillPicker`: a pill per name of the vocabulary (and any
 * "on" name it lost); a tap turns it on or off.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CoreCharacteristicPills(field: CoreFieldContract, value: JsonElement?, options: List<CoreCharacteristicOption>, onChange: (JsonElement) -> Unit) {
    val c = Starlings.colors
    val names = CoreFields.pillNames(options, value)
    CoreStack(field.label) {
        if (names.isEmpty()) {
            Text(stringResource(R.string.core_no_characteristics), style = StarlingsType.callout, color = c.secondary)
        } else {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                names.forEach { name ->
                    val on = CoreFields.isOn(value, name)
                    Text(
                        CoreRules.characteristicLabel(name),
                        Modifier
                            .background(if (on) c.accent else c.elevated, CircleShape)
                            .clickable(role = Role.Checkbox) { onChange(CoreFields.toggle(value, name)) }
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                        style = StarlingsType.callout,
                        color = if (on) c.accentInk else c.primary,
                    )
                }
            }
        }
    }
}

/** `TagChips`: the "on" characteristics, read only. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CoreTagChips(label: String, tags: List<String>) {
    val c = Starlings.colors
    CoreStack(label) {
        // An empty set reads as nothing under its label (iOS's dash is not drawn here).
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            tags.forEach { Text(it, Modifier.background(c.elevated, CircleShape).padding(horizontal = 10.dp, vertical = 5.dp), style = StarlingsType.callout, color = c.primary) }
        }
    }
}

/** The `datetime` picker: the day, then the time, in this device's zone; stored as UTC to the second. */
@Composable
internal fun CoreDateTimeField(field: CoreFieldContract, value: JsonElement?, onChange: (JsonElement) -> Unit) {
    val zone = ZoneId.systemDefault()
    var step by remember { mutableStateOf(0) }
    var day by remember { mutableStateOf<LocalDate?>(null) }
    val current = CoreFields.instant(value.coreString()) ?: Instant.now()
    val local = current.atZone(zone)
    val shown = value.coreString()?.takeIf { it.isNotEmpty() }?.let { CoreRules.displayValue(field, JsonObject(mapOf(field.name to JsonPrimitive(it)))) }.orEmpty()
    WorkLabeledRow(field.label, shown, onClick = { step = 1 })
    if (step == 1) CoreDayDialog(local.toLocalDate(), { step = 0 }) { picked -> day = picked; step = 2 }
    if (step == 2) {
        CoreTimeDialog(local.toLocalTime(), { step = 0 }) { time ->
            step = 0
            val at = LocalDateTime.of(day ?: local.toLocalDate(), time).atZone(zone).toInstant()
            onChange(JsonPrimitive(CoreFields.iso(at)))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CoreTimeDialog(initial: LocalTime, onDismiss: () -> Unit, onPick: (LocalTime) -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val state = rememberTimePickerState(initial.hour, initial.minute, is24Hour = DateFormat.is24HourFormat(context))
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        confirmButton = { TextButton({ onPick(LocalTime.of(state.hour, state.minute)) }) { Text(stringResource(R.string.done), color = c.primary) } },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.core_cancel), color = c.primary) } },
        text = { TimePicker(state) },
    )
}

/** `image`: the picture over its address, which is the field. */
@Composable
internal fun CoreImageField(field: CoreFieldContract, value: JsonElement?, onChange: (JsonElement) -> Unit) {
    val text = value.coreString().orEmpty()
    CoreStack(field.label) {
        if (CoreFields.secureImage(text)) CoreRemoteImage(text, Modifier.fillMaxWidth().height(160.dp))
        StarlingsField(text, { onChange(CoreRules.text(field, it)) }, field.placeholder ?: stringResource(R.string.core_image_url), label = field.label, keyboardType = KeyboardType.Uri)
    }
}

/** `svg`: the markup in a monospaced editor. Android draws no preview of it. */
@Composable
internal fun CoreSvgField(field: CoreFieldContract, value: JsonElement?, onChange: (JsonElement) -> Unit) {
    CoreStack(field.label) {
        StarlingsField(value.coreString().orEmpty(), { onChange(CoreRules.text(field, it)) }, field.placeholder.orEmpty(), label = field.label, singleLine = false, maxLines = 12)
    }
}

/**
 * `ContactBirthdayEditor`: Month, Day (once there is a month), Year
 * (optional, once there is a day), what it reads as, and Clear Birthday.
 */
@Composable
internal fun CoreBirthdayEditor(values: Map<String, JsonElement>, onValues: (Map<String, JsonElement>) -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val month = CoreFields.integer(values[CoreFields.BIRTHDAY_MONTH])
    val day = CoreFields.integer(values[CoreFields.BIRTHDAY_DAY])
    val year = CoreFields.integer(values[CoreFields.BIRTHDAY_YEAR])
    val notSet = stringResource(R.string.core_not_set)
    val locale = context.resources.configuration.locales[0]
    val months = (1..12).map { m -> "$m" to java.time.Month.of(m).getDisplayName(java.time.format.TextStyle.FULL_STANDALONE, locale) }
    CoreMenuRow(stringResource(R.string.core_month), listOf("0" to notSet) + months, (month ?: 0).toString()) { onValues(CoreFields.setMonth(values, it.toInt())) }
    if (month != null) {
        val days = (1..CoreFields.maximumDay(month, year)).map { "$it" to "$it" }
        CoreMenuRow(stringResource(R.string.core_day), listOf("0" to notSet) + days, (day ?: 0).toString()) { onValues(CoreFields.setDay(values, it.toInt())) }
    } else {
        WorkLabeledRow(stringResource(R.string.core_day), notSet)
    }
    if (day != null) {
        Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            StarlingsField(year?.toString().orEmpty(), { onValues(CoreFields.setYear(values, it)) }, stringResource(R.string.core_year_optional), keyboardType = KeyboardType.Number)
        }
    }
    CoreFields.birthday(values)?.let { WorkLabeledRow(stringResource(R.string.core_saved_as), birthdayText(it, locale)) }
    if (month != null) {
        Text(
            stringResource(R.string.core_clear_birthday),
            Modifier.fillMaxWidth().clickable(role = Role.Button) { onValues(CoreFields.clearBirthday(values)) }.padding(horizontal = 16.dp, vertical = 12.dp),
            style = StarlingsType.body,
            color = c.danger,
        )
    }
}

/** `CRMContactBirthday.formatted`: month and day, with the year when there is one, in the reader's words. */
internal fun birthdayText(birthday: CoreFields.Birthday, locale: java.util.Locale): String {
    val pattern = DateFormat.getBestDateTimePattern(locale, if (birthday.year == null) "MMMMd" else "yMMMMd")
    val date = LocalDate.of(birthday.year ?: 2000, birthday.month, birthday.day)
    return java.time.format.DateTimeFormatter.ofPattern(pattern, locale).format(date)
}
