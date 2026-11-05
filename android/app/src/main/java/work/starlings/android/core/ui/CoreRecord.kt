package work.starlings.android.core.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import work.starlings.android.ui.toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import work.starlings.android.R
import work.starlings.android.core.CoreAccess
import work.starlings.android.core.CoreDetail
import work.starlings.android.core.CoreEntityContract
import work.starlings.android.core.CoreFieldContract
import work.starlings.android.core.CoreFields
import work.starlings.android.core.CoreRelatedData
import work.starlings.android.core.CoreRelatedItem
import work.starlings.android.core.CoreRules
import work.starlings.android.core.CoreSignals
import work.starlings.android.core.CoreTarget
import work.starlings.android.core.coreBool
import work.starlings.android.core.coreDisplayName
import work.starlings.android.core.coreString
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkTopBar
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * One record (core-kit `EntityDetailView`, opened through
 * `CRMRelatedTargetLoader`): read live, then the same page for viewing and
 * editing. The record's face heads it (a contact, an organization or a
 * milestone); fields render in the registry's groups; edits stay on the page
 * and go to Core only on Save (deferred commit), with Revert beside it and
 * a question before Back throws them away. An entity this account cannot
 * update reads read-only, with its empty fields left out. Related sections
 * follow, then Delete where the account may. Notes and offers carry Copy
 * Public Link in the toolbar.
 */
@Composable
internal fun CoreRecordScreen(core: CoreAccess, entity: String, id: String, title: String?, navigation: CoreNavigation) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val contract = core.contract(entity)
    var record by remember(entity, id) { mutableStateOf<JsonObject?>(null) }
    var values by remember(entity, id) { mutableStateOf<Map<String, JsonElement>>(emptyMap()) }
    var originalValues by remember(entity, id) { mutableStateOf<Map<String, JsonElement>>(emptyMap()) }
    var original by remember(entity, id) { mutableStateOf<Map<String, JsonElement>>(emptyMap()) }
    var loadError by remember(entity, id) { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    var askingDelete by remember { mutableStateOf(false) }
    var askingDiscard by remember { mutableStateOf(false) }
    val options = rememberEditOptions(core, contract, record, contract?.canUpdate == true)

    fun apply(loaded: JsonObject) {
        record = loaded
        val seeded = contract?.let { CoreRules.seededValues(it, loaded) } ?: loaded
        values = seeded
        originalValues = seeded
        original = contract?.let { CoreRules.payload(it, seeded) } ?: emptyMap()
    }
    val dirty = contract != null && record != null && CoreRules.payload(contract, values) != original

    // The registry may still be on its way (a page restored from the saved stack): wait for it.
    LaunchedEffect(entity, id, attempt, contract != null, core.isLoading) {
        if (contract == null) {
            loadError = if (core.isLoading) null else "This account can’t see $entity."
            return@LaunchedEffect
        }
        // `loadFullRecord` bails while the record is dirty.
        if (dirty) return@LaunchedEffect
        try {
            apply(core.record(entity, id))
            loadError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (record == null) loadError = e.message
        }
    }
    val requestBack: () -> Unit = { if (dirty) askingDiscard = true else navigation.back() }
    BackHandler(enabled = dirty) { askingDiscard = true }

    fun save() {
        val contract = contract ?: return
        val read = record ?: return
        if (saving) return
        saving = true
        scope.launch {
            try {
                apply(core.save(contract.id, id, CoreRules.payload(contract, values)))
                toast(r.getString(R.string.core_updated, contract.singularLabel))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                saveError = e.message
                record = read
            } finally {
                saving = false
            }
        }
    }

    val read = record
    val identity = contract?.let(CoreFields::identity)
    // A license reads by its organization (`title`).
    val licensed = read?.let { rec -> contract?.let { CoreDetail.licenseOrganization(it, rec) } }
    val name = licensed?.let { r.getString(R.string.core_license_title, it) }
        ?: read?.let { rec -> contract?.let { rec.coreDisplayName(it.primaryField, it.singularLabel) } } ?: title ?: contract?.singularLabel.orEmpty()
    // A centered face names the record under it; the bar then says what it is (`navigationTitle`).
    val heading = if (identity?.centeredHeader == true && read != null) contract.singularLabel else name
    val publicUrl = read?.let { CoreFields.publicShareUrl(entity, id) }
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(heading, stringResource(R.string.back), requestBack) {
            if (publicUrl != null) {
                WorkIconButton(Icons.Filled.ContentCopy, stringResource(R.string.core_copy_public_link), {
                    copyToClipboard(context, publicUrl)
                    toast(r.getString(R.string.core_public_link_copied))
                })
            }
        }
        if (contract != null && contract.canUpdate && dirty) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                BorderedButton(stringResource(R.string.core_revert), { values = originalValues }, enabled = !saving, compact = true)
                FilledButton(
                    stringResource(if (saving) R.string.core_saving else R.string.core_save),
                    ::save,
                    enabled = !saving && CoreRules.requiredPresent(contract, values),
                    compact = true,
                )
            }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (read == null || contract == null) {
                loadError?.let { message ->
                    WorkSection(header = { WorkHeaderTitle(stringResource(R.string.core_load_failed)) }) {
                        WorkErrorNotice(message, retry = stringResource(R.string.core_retry), onRetry = { attempt++ })
                    }
                } ?: WorkSection { WorkPlaceholderRows() }
                return@Column
            }
            CoreRecordHeader(contract, read, values, name)
            if (contract.id == CoreDetail.LICENSES) CoreLicenseOverview(read)
            if (contract.id == "contacts" && CoreSignals.status(read).isNotEmpty()) {
                CoreSignalsSection(core, read) { attempt++ }
            }
            if (contract.id == CoreDetail.SUPPORT_CASES) CoreReplyToCustomer(values, read)
            val open: (CoreTarget) -> Unit = { target -> navigation.openRelated(target.entity, target.id, target.title) }
            val carded = CoreDetail.contextRelationFields(contract, core.contracts)
            carded.forEach { field -> CoreRelationContextCard(core, field, read, open) }
            CoreFieldGroups(
                contract, read, values, contract.canUpdate, options,
                onEdit = { change -> values = change(values) },
                onOpen = open,
                carded = carded.map { it.name }.toSet(),
            )
            contract.related.orEmpty().forEach { section -> CoreRelatedSection(core, contract, read, section, navigation) }
            if (contract.canUpdate && contract.canDelete) {
                WorkSection { WorkActionRow(stringResource(R.string.core_delete_entity, contract.singularLabel), { askingDelete = true }, danger = true, enabled = !saving) }
            }
            CoreRecordFooter(contract, read)
        }
    }
    if (saving) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), color = c.secondary, strokeWidth = 2.dp) }
    }
    if (askingDelete && contract != null) {
        CoreAsk(
            title = stringResource(R.string.core_delete_ask, contract.singularLabel.lowercase()),
            message = null,
            confirm = stringResource(R.string.core_delete),
            onDismiss = { askingDelete = false },
        ) {
            askingDelete = false
            saving = true
            scope.launch {
                try {
                    core.delete(contract.id, id)
                    toast(r.getString(R.string.core_deleted, contract.singularLabel))
                    navigation.back()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    saveError = e.message
                } finally {
                    saving = false
                }
            }
        }
    }
    if (askingDiscard && contract != null) {
        CoreAsk(
            title = stringResource(R.string.core_discard_ask),
            message = stringResource(R.string.core_discard_message, contract.singularLabel.lowercase()),
            confirm = stringResource(R.string.core_discard),
            onDismiss = { askingDiscard = false },
        ) {
            askingDiscard = false
            values = originalValues
            navigation.back()
        }
    }
    saveError?.let { message ->
        CoreSaveError(message) { saveError = null }
    }
}

/** `Unable to Save`, with Core's sentence. */
@Composable
internal fun CoreSaveError(message: String, onDismiss: () -> Unit) {
    val c = Starlings.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(stringResource(R.string.core_unable_to_save), style = StarlingsType.headline, color = c.primary) },
        text = { Text(message, style = StarlingsType.body, color = c.secondary) },
        confirmButton = { TextButton(onDismiss) { Text(stringResource(R.string.core_ok), color = c.primary) } },
    )
}

internal fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    clipboard.setPrimaryClip(ClipData.newPlainText(null, text))
}

/**
 * The editing options a page needs (`loadRelationOptions`,
 * `loadCharacteristicOptions`, `loadMemberOptions`), only while it can
 * write; the members directory also names a read-only assignee.
 */
@Composable
internal fun rememberEditOptions(core: CoreAccess, contract: CoreEntityContract?, record: JsonObject?, canWrite: Boolean): CoreEditOptions {
    var options by remember(contract?.id) { mutableStateOf(CoreEditOptions()) }
    LaunchedEffect(contract?.id, canWrite) {
        val contract = contract ?: return@LaunchedEffect
        if (contract.fields.any { it.optionsSource == "members" }) options = options.copy(members = core.members())
        if (!canWrite) return@LaunchedEffect
        if (contract.fields.any { it.kind == "characteristics" && it.readOnly != true }) {
            options = options.copy(characteristics = core.characteristics(contract.id))
        }
        contract.fields.mapNotNull { it.relationEntity }.distinct().forEach { related ->
            options = options.copy(relations = options.relations + (related to core.relationOptions(related)))
        }
    }
    return options
}

/**
 * The record's face (`centeredHeader`, `contentHeroHeader`, or the avatar
 * beside the name): a contact, an organization or a milestone always; any
 * other record only when it carries a picture of its own.
 */
@Composable
private fun CoreRecordHeader(contract: CoreEntityContract, record: JsonObject, values: Map<String, JsonElement>, name: String) {
    val c = Starlings.colors
    val identity = CoreFields.identity(contract)
    val subtitle = CoreFields.headerSubtitle(contract, record)
    when {
        identity.heroLayout -> Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val image = CoreFields.imageUrl(JsonObject(values), contract)
            val shape = RoundedCornerShape(14.dp)
            if (image != null) {
                CoreRemoteImage(image, Modifier.fillMaxWidth().height(220.dp).clip(shape), crop = true)
            } else {
                Box(Modifier.fillMaxWidth().height(220.dp).background(c.elevated, shape), contentAlignment = Alignment.Center) {
                    Icon(coreIcon(contract.icon), null, Modifier.size(36.dp), tint = c.secondary)
                }
            }
            Text(JsonObject(values).coreDisplayName(contract.primaryField, name), style = StarlingsType.title2, color = c.primary, textAlign = TextAlign.Center)
            subtitle?.let { Text(it, style = StarlingsType.subheadline, color = c.secondary, textAlign = TextAlign.Center) }
        }
        identity.centeredHeader -> Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            CoreAvatar(CoreFields.avatarUrl(record), name, contract.id, contract.icon, size = 96.dp)
            Text(name, style = StarlingsType.title2, color = c.primary, textAlign = TextAlign.Center)
            subtitle?.let { Text(it, style = StarlingsType.subheadline, color = c.secondary, textAlign = TextAlign.Center) }
        }
        CoreFields.avatarUrl(record) != null -> Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            CoreAvatar(CoreFields.avatarUrl(record), name, contract.id, contract.icon, size = 64.dp)
            Text(name, style = StarlingsType.title2, color = c.primary, maxLines = 2)
        }
    }
}

/** A confirmation with a destructive button (`confirmationDialog`). */
@Composable
internal fun CoreAsk(title: String, message: String?, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val c = Starlings.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(title, style = StarlingsType.headline, color = c.primary) },
        text = message?.let { { Text(it, style = StarlingsType.body, color = c.secondary) } },
        confirmButton = { TextButton(onConfirm) { Text(confirm, color = c.danger) } },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.core_cancel), color = c.primary) } },
    )
}

/**
 * The registry's groups, each field as its row (`fieldGroups` and
 * `fieldRow`), for a record's page and for a new record alike. [onEdit]
 * takes a change of the page's values, so the birthday editor can set its
 * three parts at once.
 */
@Composable
internal fun CoreFieldGroups(
    contract: CoreEntityContract,
    record: JsonObject,
    values: Map<String, JsonElement>,
    canWrite: Boolean,
    options: CoreEditOptions,
    onEdit: ((Map<String, JsonElement>) -> Map<String, JsonElement>) -> Unit,
    onOpen: (CoreTarget) -> Unit,
    carded: Set<String> = emptySet(),
) {
    CoreRules.fieldGroups(contract).forEach { group ->
        val shown = group.fields.filter { CoreRules.isFieldVisible(it, contract, record, values, canWrite, carded) }
        if (shown.isEmpty()) return@forEach
        val label = if (group.label == CoreRules.OVERVIEW) stringResource(R.string.core_overview) else group.label
        WorkSection(header = { WorkHeaderTitle(label) }) {
            shown.forEachIndexed { index, field ->
                if (index > 0) WorkDivider()
                CoreFieldRow(field, contract, record, values, canWrite, options, onEdit, onOpen)
            }
        }
    }
}

/**
 * `EntityFieldRow`: one field, as its control where the page can write it,
 * else as its value. A relation with a value opens its record; a URL opens
 * in the browser and an email in the mail app.
 */
@Composable
private fun CoreFieldRow(
    field: CoreFieldContract,
    contract: CoreEntityContract,
    record: JsonObject,
    values: Map<String, JsonElement>,
    canWrite: Boolean,
    options: CoreEditOptions,
    onEdit: ((Map<String, JsonElement>) -> Map<String, JsonElement>) -> Unit,
    onOpen: (CoreTarget) -> Unit,
) {
    val value = values[field.name]
    val onChange: (JsonElement) -> Unit = { next -> onEdit { it + (field.name to next) } }
    if (field.name == CoreFields.BIRTHDAY_MONTH) {
        if (canWrite) {
            CoreBirthdayEditor(values) { next -> onEdit { next } }
        } else {
            val locale = LocalContext.current.resources.configuration.locales[0]
            CoreFields.birthday(record)?.let { WorkLabeledRow(stringResource(R.string.core_birthday), birthdayText(it, locale)) }
        }
        return
    }
    if (!CoreRules.isEditable(field, contract, canWrite)) {
        CoreReadOnlyRow(field, record, value, options, onOpen)
        return
    }
    val c = Starlings.colors
    val text = value.coreString().orEmpty()
    when (field.kind) {
        "toggle" -> Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            StarlingsToggle(field.label, value.coreBool() ?: false, { onChange(JsonPrimitive(it)) })
        }
        "select" -> if (field.optionsSource == "members") {
            // Members come from the directory; Unassigned is the empty choice, so team work can be unassigned.
            val members = CoreFields.memberOptions(options.members, record)
            CoreMenuRow(field.label, listOf("" to stringResource(R.string.core_unassigned)) + members.map { it.id to it.displayLabel }, text) { onChange(JsonPrimitive(it)) }
        } else {
            CoreMenuRow(field.label, field.options.orEmpty().map { it.value to it.label }, text) { onChange(JsonPrimitive(it)) }
        }
        "industry" -> CoreMenuRow(field.label, listOf("" to stringResource(R.string.core_none)) + field.options.orEmpty().map { it.value to it.label }, text) { onChange(JsonPrimitive(it)) }
        "country" -> CoreTypeahead(
            field.label,
            field.placeholder ?: stringResource(R.string.core_search_countries),
            CoreFields.countryOptions,
            multiple = false,
            selection = CoreFields.countrySelection(text),
            onSelection = { onChange(JsonPrimitive(it.firstOrNull().orEmpty())) },
        )
        "relation" -> {
            val choices = CoreFields.relationOptions(options.relations[field.relationEntity].orEmpty()).map { it.id to it.title }
            // A stored id the options do not hold yet still reads as its name.
            val current = if (text.isNotEmpty() && choices.none { it.first == text }) listOf(text to (CoreRules.displayValue(field, record) ?: text)) else emptyList()
            CoreMenuRow(
                field.label,
                listOf("" to stringResource(R.string.core_none)) + current + choices,
                text,
                trailing = { CoreRelationOpen(CoreFields.relationTargets(field, value, record), onOpen) },
            ) { onChange(JsonPrimitive(it)) }
        }
        "multiRelation" -> CoreTypeahead(
            field.label,
            stringResource(R.string.core_search_field),
            CoreFields.relationOptions(options.relations[field.relationEntity].orEmpty()),
            multiple = true,
            selection = CoreFields.ids(value),
            onSelection = { onChange(CoreFields.idsValue(it)) },
            trailing = { CoreRelationOpen(CoreFields.relationTargets(field, value, record), onOpen) },
        )
        "stringList" -> CoreStringListField(field, value, onChange)
        "characteristics" -> CoreCharacteristicPills(field, value, options.characteristics, onChange)
        "date" -> {
            var picking by remember { mutableStateOf(false) }
            val day = runCatching { LocalDate.parse(text) }.getOrNull()
            WorkLabeledRow(field.label, CoreRules.displayValue(field, JsonObject(mapOf(field.name to JsonPrimitive(text)))).orEmpty(), onClick = { picking = true })
            if (picking) CoreDayDialog(day ?: LocalDate.now(), { picking = false }) { picked -> picking = false; onChange(JsonPrimitive(picked.toString())) }
        }
        "datetime" -> CoreDateTimeField(field, value, onChange)
        "image" -> CoreImageField(field, value, onChange)
        "svg" -> CoreSvgField(field, value, onChange)
        "markdown" -> CoreMarkdownField(field, text) { onChange(CoreRules.text(field, it)) }
        else -> {
            val long = field.kind == "textarea" || field.kind == "markdown"
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(field.label, style = StarlingsType.footnote, color = c.secondary)
                StarlingsField(
                    text,
                    { onChange(CoreRules.text(field, it)) },
                    field.placeholder.orEmpty(),
                    label = field.label,
                    keyboardType = when (field.kind) {
                        "email" -> KeyboardType.Email
                        "url" -> KeyboardType.Uri
                        "number" -> KeyboardType.Decimal
                        else -> KeyboardType.Text
                    },
                    singleLine = !long,
                    maxLines = if (long) 12 else 1,
                )
            }
        }
    }
}

/**
 * `readOnlyRow`: the value a person reads; a long text under its label; a
 * member by name; a relation, a URL or an email that opens; a picture.
 */
@Composable
private fun CoreReadOnlyRow(field: CoreFieldContract, record: JsonObject, value: JsonElement?, options: CoreEditOptions, onOpen: (CoreTarget) -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val display = CoreRules.displayValue(field, record).orEmpty()
    fun view(uri: String) = runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri))) }
    val targets = CoreFields.relationTargets(field, value ?: record[field.name], record)
    when {
        field.optionsSource == "members" -> WorkLabeledRow(field.label, CoreFields.memberName(record[field.name].coreString().orEmpty(), options.members, record).orEmpty())
        field.kind == "relation" && targets.size == 1 -> WorkLabeledRow(field.label, display, onClick = { onOpen(targets.single()) })
        field.kind == "multiRelation" && targets.isNotEmpty() -> Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { WorkLabeledRow(field.label, display) }
            CoreRelationOpen(targets, onOpen)
        }
        field.kind == "url" && display.isNotEmpty() -> WorkLabeledRow(field.label, display, onClick = { view(display) })
        field.kind == "email" && display.isNotEmpty() -> WorkLabeledRow(field.label, display, onClick = { view("mailto:$display") })
        field.kind == "markdown" && display.isNotEmpty() -> SelectionContainer {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(field.label, style = StarlingsType.caption, color = c.secondary)
                CoreMarkdownText(display)
            }
        }
        field.kind == "textarea" || field.kind == "markdown" -> Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(field.label, style = StarlingsType.caption, color = c.secondary)
            Text(display, style = StarlingsType.body, color = c.primary)
        }
        field.kind == "characteristics" -> CoreTagChips(field.label, CoreRules.characteristicNames(record[field.name]).map { CoreRules.characteristicLabel(it) })
        field.kind == "image" && CoreFields.secureImage(display) -> CoreStack(field.label) { CoreRemoteImage(display, Modifier.fillMaxWidth().height(160.dp)) }
        else -> WorkLabeledRow(field.label, display)
    }
}

/**
 * An editable `markdown` field: rendered until tapped, then its source in a
 * text field until it loses focus (deferred commit still applies).
 */
@Composable
private fun CoreMarkdownField(field: CoreFieldContract, text: String, onChange: (String) -> Unit) {
    val c = Starlings.colors
    var editing by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(field.label, style = StarlingsType.subheadline, color = c.secondary)
        if (editing) {
            var focused by remember { mutableStateOf(false) }
            StarlingsField(
                text, onChange, field.placeholder.orEmpty(),
                Modifier.focusRequester(focus).onFocusChanged { state ->
                    if (focused && !state.isFocused) editing = false
                    focused = state.isFocused
                },
                label = field.label, singleLine = false, maxLines = 12,
            )
            LaunchedEffect(Unit) { focus.requestFocus() }
        } else {
            Box(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = field.label) { editing = true }) {
                if (text.isEmpty()) {
                    Text(field.placeholder ?: stringResource(R.string.core_tap_to_edit), style = StarlingsType.body, color = c.secondary.copy(alpha = 0.6f))
                } else {
                    CoreMarkdownText(text)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CoreDayDialog(initial: LocalDate, onDismiss: () -> Unit, onPick: (LocalDate) -> Unit) {
    val c = Starlings.colors
    val state = rememberDatePickerState(initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton({ state.selectedDateMillis?.let { onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) } ?: onDismiss() }) {
                Text(stringResource(R.string.done), color = c.primary)
            }
        },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.core_cancel), color = c.primary) } },
    ) { DatePicker(state) }
}

/**
 * One related section (`CRMRelatedSectionsView`): its records, each opening
 * its own page when Core says it can and the registry has its entity;
 * "No access", a failure, or the section's empty sentence otherwise. A +
 * in the header adds one where the section can be written
 * (`creation(for:)`): New <entity> with the link back filled in, or Core's
 * web page when the registry cannot make it here. No Remove: iOS offers it
 * only for an unlink operation in `meta/registry`, which Starlings never reads.
 */
@Composable
private fun CoreRelatedSection(core: CoreAccess, contract: CoreEntityContract, record: JsonObject, section: work.starlings.android.core.CoreRelatedSection, navigation: CoreNavigation) {
    val c = Starlings.colors
    val recordId = record["id"].coreString().orEmpty()
    var data by remember(recordId, section.id) { mutableStateOf<CoreRelatedData?>(null) }
    var error by remember(recordId, section.id) { mutableStateOf<String?>(null) }
    val denied = section.access?.canRead == false
    LaunchedEffect(recordId, section.id) {
        if (denied) return@LaunchedEffect
        try {
            data = core.related(contract.id, recordId, section.id)
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        }
    }
    val canOpen = core.contracts.any { it.id == section.entity }
    val context = LocalContext.current
    val creation = CoreDetail.creation(section, contract, recordId, core.contracts, data?.createDefaults.orEmpty(), core.origin)
    val addLabel = section.create?.label ?: stringResource(R.string.core_related_add, CoreDetail.createEntityName(section, core.contracts))
    WorkSection(header = {
        WorkHeaderTitle(section.label)
        if (creation != null) {
            Spacer(Modifier.weight(1f))
            WorkIconButton(Icons.Filled.Add, addLabel, {
                when (creation) {
                    is CoreDetail.Creation.Form -> navigation.push(
                        CoreDoor.New(
                            creation.target.id,
                            CoreFields.prefillText(creation.initialValues),
                            creation.linkField?.let { CoreDoor.New.Link(contract.id, recordId, it) },
                        ),
                    )
                    is CoreDetail.Creation.Web -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(creation.url))) }
                }
            })
        }
    }) {
        val items = data?.items
        when {
            denied -> WorkNote(stringResource(R.string.core_no_access))
            error != null && items.isNullOrEmpty() -> WorkNote(error!!)
            items == null -> WorkPlaceholderRows()
            items.isEmpty() -> WorkNote(section.emptyMessage)
            else -> items.forEachIndexed { index, item ->
                val presentation = CoreDetail.relatedPresentation(section)
                if (index > 0) WorkDivider()
                val opens = item.navigable != false && canOpen
                Row(
                    Modifier
                        .fillMaxWidth()
                        .then(if (opens) Modifier.clickable(role = Role.Button) { navigation.openRelated(section.entity, item.id, item.name) } else Modifier)
                        .padding(horizontal = 16.dp, vertical = 9.dp),
                    verticalAlignment = if (presentation == CoreDetail.RelatedPresentation.List || presentation == CoreDetail.RelatedPresentation.Compact) Alignment.CenterVertically else Alignment.Top,
                ) {
                    Box(Modifier.weight(1f)) { CoreRelatedItemRow(item, section.icon, presentation) }
                    if (opens) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = c.secondary)
                }
            }
        }
    }
}

/**
 * `CRMRelatedItemPresentation`: one related record in the section's style.
 * List is the icon, the name and the tag or subtitle; Compact the icon and
 * the name on one line; Timeline the interaction's type mark (or a dot) with
 * the name, the type and the date; Cards the icon, the name in medium weight
 * with the tag in a capsule, and the subtitle on two lines.
 */
@Composable
private fun CoreRelatedItemRow(item: CoreRelatedItem, icon: String, presentation: CoreDetail.RelatedPresentation) {
    val c = Starlings.colors
    when (presentation) {
        CoreDetail.RelatedPresentation.List -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CoreRelatedMark(icon, c.secondary)
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(item.name, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                CoreDetail.listDetail(item)?.let { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        CoreDetail.RelatedPresentation.Compact -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CoreRelatedMark(icon, c.accent)
            Text(item.name, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        CoreDetail.RelatedPresentation.Timeline -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.width(16.dp).padding(top = 3.dp), contentAlignment = Alignment.Center) {
                val symbol = CoreDetail.interactionSymbol(item.tag)
                if (symbol != null) {
                    Icon(coreIcon(symbol), null, Modifier.size(14.dp), tint = c.secondary)
                } else {
                    Box(Modifier.padding(top = 4.dp).size(8.dp).background(c.secondary, CircleShape))
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(item.name, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                CoreDetail.timelineLines(item).forEach { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        CoreDetail.RelatedPresentation.Cards -> Row(Modifier.padding(vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CoreRelatedMark(icon, c.secondary)
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(item.name, Modifier.weight(1f), style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.width(8.dp))
                    item.tag?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, Modifier.background(c.elevated, CircleShape).padding(horizontal = 7.dp, vertical = 3.dp), style = StarlingsType.caption2, color = c.secondary)
                    }
                }
                item.subtitle?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
        }
    }
}

/** A related row's mark: the section's symbol, as `Label`'s icon column. */
@Composable
private fun CoreRelatedMark(icon: String, tint: androidx.compose.ui.graphics.Color) {
    Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) { Icon(coreIcon(icon), null, Modifier.size(18.dp), tint = tint) }
}

/**
 * On a contact in the funnel: the stage and Mark <next stage>.
 */
@Composable
private fun CoreSignalsSection(core: CoreAccess, record: JsonObject, onChanged: () -> Unit) {
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val status = CoreSignals.status(record)
    WorkSection(header = { WorkHeaderTitle(stringResource(R.string.core_signals_section)) }) {
        WorkLabeledRow(stringResource(R.string.core_signals_status), CoreSignals.statusLabel(status))
        CoreSignals.nextStatus(status)?.let { next ->
            WorkDivider()
            WorkActionRow(stringResource(R.string.core_signals_mark, CoreSignals.statusLabel(next)), {
                busy = true
                scope.launch {
                    try {
                        core.save("contacts", record["id"].coreString().orEmpty(), mapOf("signals_outreach_status" to JsonPrimitive(next)))
                        toast(r.getString(R.string.core_signals_moved, CoreSignals.statusLabel(next)))
                        onChanged()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        toast(r.getString(R.string.core_signals_failed))
                    } finally {
                        busy = false
                    }
                }
            }, enabled = !busy)
        }
    }
}
