package work.starlings.android.core.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import work.starlings.android.ui.toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.ViewColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import work.starlings.android.R
import work.starlings.android.core.CoreAccess
import work.starlings.android.core.CoreEntityContract
import work.starlings.android.core.CoreFieldOption
import work.starlings.android.core.CoreFields
import work.starlings.android.core.CoreRules
import work.starlings.android.core.CoreTasks
import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticPulseEffect
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.ui.rememberHapticPulse
import work.starlings.android.core.coreDisplayName
import work.starlings.android.core.coreId
import work.starlings.android.core.coreString
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkMark
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkTopBar

/**
 * One entity's list (core-kit `EntityListView`): its own search over every
 * value, a Sort menu kept per entity on the device (`crm.list.sort.<id>`),
 * a Filter menu over the fields with a closed set of values (not kept), a
 * Presentation menu (List, Board) where the registry names a board, Add
 * where the account may create, and a row per record that opens its detail;
 * a long press holds the row's actions. The kept list draws first and Core
 * is asked when it is older than five minutes; pull to ask now. A phone has
 * no table: core-kit draws it only in a regular width.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CoreEntityListScreen(core: CoreAccess, contract: CoreEntityContract, navigation: CoreNavigation) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences("core", Context.MODE_PRIVATE) }
    val sortKey = "crm.list.sort.${contract.id}"
    var order by remember(contract.id) { mutableStateOf(CoreRules.SortOrder.initial(prefs.getString(sortKey, null), contract)) }
    var filters by remember(contract.id) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var query by rememberSaveable(contract.id) { mutableStateOf("") }
    var board by rememberSaveable(contract.id) { mutableStateOf(false) }
    val cached = remember(contract.id) { core.cachedRecords(contract.id) }
    var records by remember(contract.id) { mutableStateOf(cached?.first.orEmpty()) }
    var loading by remember(contract.id) { mutableStateOf(cached == null) }
    var showingCached by remember(contract.id) { mutableStateOf(false) }
    var error by remember(contract.id) { mutableStateOf<String?>(null) }
    var moveError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var sortMenu by remember { mutableStateOf(false) }
    var filterMenu by remember { mutableStateOf(false) }
    var presentationMenu by remember { mutableStateOf(false) }
    val columns = CoreFields.boardColumns(contract)
    val showsBoard = board && columns.isNotEmpty()
    val isTasks = contract.id == "tasks"
    var showCompleted by remember { mutableStateOf(prefs.getBoolean(CoreTasks.SHOW_COMPLETED_KEY, false)) }
    var lingering by remember(contract.id) { mutableStateOf<Set<String>>(emptySet()) }
    val tick = rememberHapticPulse()
    HapticPulseEffect(tick)
    HapticWhenSet(Haptic.ERROR, moveError)

    suspend fun load(force: Boolean) {
        if (!force && cached?.second == true && records.isNotEmpty()) { loading = false; return }
        loading = records.isEmpty()
        try {
            records = core.refreshRecords(contract.id)
            showingCached = false
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (records.isEmpty()) error = e.message else showingCached = true
        } finally {
            loading = false
        }
    }
    LaunchedEffect(contract.id) { load(force = false) }

    /** `EntityListModel.move`: the value changes at once; a failure puts it back and says why. */
    fun write(record: JsonObject, field: String, value: String, landed: String, failed: () -> Unit = {}) {
        val before = records
        records = CoreFields.moved(records, record.coreId, field, value)
        scope.launch {
            try {
                core.save(contract.id, record.coreId, mapOf(field to JsonPrimitive(value)))
                toast(landed)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                records = before
                moveError = e.message
                failed()
            }
        }
    }

    fun move(record: JsonObject, field: String, option: CoreFieldOption) =
        write(record, field, option.value, r.getString(R.string.core_signals_moved, option.label))

    /** `toggleTask`: complete or reopen; a completed task lingers, crossed out, before it leaves. */
    fun toggleTask(record: JsonObject) {
        if (!contract.canUpdate) return
        tick.fire(Haptic.STEP)
        val id = record.coreId
        val name = record.coreDisplayName(contract.primaryField, contract.singularLabel)
        val done = CoreTasks.isDone(record)
        if (done) {
            lingering = lingering - id
        } else {
            lingering = lingering + id
            scope.launch {
                kotlinx.coroutines.delay(CoreTasks.LINGER_MS)
                lingering = lingering - id
            }
        }
        write(
            record, "status", CoreTasks.toggledStatus(record),
            r.getString(if (done) R.string.core_tasks_reopened else R.string.core_tasks_completed, name),
            failed = { lingering = lingering - id },
        )
    }

    val visible = remember(records, query, filters, order) { CoreRules.visibleRecords(records, contract, query, filters, order) }
    val actions = CoreRowActions(contract, columns, onMove = ::move)
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(contract.pluralLabel, stringResource(R.string.back), navigation.back) {
            if (contract.filterableFields.isNotEmpty()) {
                Box {
                    WorkIconButton(Icons.Filled.FilterList, stringResource(R.string.core_filter), { filterMenu = true }, tint = if (filters.isEmpty()) c.primary else c.accent)
                    DropdownMenu(filterMenu, { filterMenu = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
                        contract.filterableFields.forEachIndexed { index, field ->
                            if (index > 0) HorizontalDivider(color = c.border)
                            Text(field.label, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = c.secondary)
                            val choices = if (field.kind == "toggle") {
                                listOf("true" to stringResource(R.string.core_yes), "false" to stringResource(R.string.core_no))
                            } else {
                                field.options.orEmpty().map { it.value to it.label }
                            }
                            (listOf("" to stringResource(R.string.core_any)) + choices).forEach { (value, label) ->
                                val chosen = (filters[field.name] ?: "") == value
                                DropdownMenuItem(
                                    text = { Text(label, style = StarlingsType.body, color = c.primary) },
                                    trailingIcon = { if (chosen) Icon(Icons.Filled.Check, null, tint = c.secondary) },
                                    onClick = { filters = if (value.isEmpty()) filters - field.name else filters + (field.name to value) },
                                )
                            }
                        }
                        if (filters.isNotEmpty()) {
                            HorizontalDivider(color = c.border)
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.core_clear_filters), style = StarlingsType.body, color = c.primary) },
                                onClick = { filters = emptyMap(); filterMenu = false },
                            )
                        }
                    }
                }
            }
            Box {
                WorkIconButton(Icons.AutoMirrored.Filled.Sort, stringResource(R.string.core_sort), { sortMenu = true })
                DropdownMenu(sortMenu, { sortMenu = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
                    CoreRules.SortOrder.offered(contract).forEach { option ->
                        DropdownMenuItem(
                            text = { Text(option.title, style = StarlingsType.body, color = c.primary) },
                            trailingIcon = { if (option == order) Icon(Icons.Filled.Check, null, tint = c.secondary) },
                            onClick = {
                                sortMenu = false
                                order = option
                                prefs.edit().putString(sortKey, option.id).apply()
                            },
                        )
                    }
                }
            }
            if (columns.isNotEmpty()) {
                Box {
                    WorkIconButton(Icons.Filled.ViewColumn, stringResource(R.string.core_presentation), { presentationMenu = true })
                    DropdownMenu(presentationMenu, { presentationMenu = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
                        listOf(false to stringResource(R.string.core_list), true to stringResource(R.string.core_board)).forEach { (isBoard, label) ->
                            DropdownMenuItem(
                                text = { Text(label, style = StarlingsType.body, color = c.primary) },
                                trailingIcon = { if (board == isBoard) Icon(Icons.Filled.Check, null, tint = c.secondary) },
                                onClick = { presentationMenu = false; board = isBoard },
                            )
                        }
                    }
                }
            }
            if (isTasks) {
                WorkIconButton(
                    if (showCompleted) Icons.Filled.CheckCircle else Icons.Outlined.CheckCircle,
                    stringResource(R.string.core_tasks_show_completed),
                    {
                        showCompleted = !showCompleted
                        prefs.edit().putBoolean(CoreTasks.SHOW_COMPLETED_KEY, showCompleted).apply()
                    },
                    tint = if (showCompleted) c.accent else c.primary,
                )
            }
            if (contract.canCreate) {
                WorkIconButton(Icons.Filled.Add, stringResource(R.string.core_add), { navigation.push(CoreDoor.New(contract.id)) })
            }
        }
        Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            StarlingsField(query, { query = it }, stringResource(R.string.core_search_entity, contract.pluralLabel.lowercase()))
        }
        val open: (JsonObject) -> Unit = { record ->
            navigation.openRelated(contract.id, record.coreId, record.coreDisplayName(contract.primaryField, contract.singularLabel))
        }
        when {
            loading && records.isEmpty() -> WorkSection(Modifier.padding(top = 8.dp)) { WorkPlaceholderRows() }
            error != null && records.isEmpty() -> WorkSection(Modifier.padding(top = 8.dp)) {
                WorkErrorNotice(error!!, retry = stringResource(R.string.core_retry), onRetry = { scope.launch { load(force = true) } })
            }
            else -> PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; load(force = true); refreshing = false } },
                modifier = Modifier.fillMaxSize(),
            ) {
                if (showsBoard) {
                    CoreBoard(contract, columns, visible, actions, open)
                } else if (isTasks && visible.isNotEmpty()) {
                    CoreTaskChecklist(
                        contract, visible, showCompleted, lingering, actions,
                        onToggle = ::toggleTask,
                        onOpen = open,
                        onCreate = { prefill ->
                            navigation.push(CoreDoor.New(contract.id, CoreFields.prefillText(prefill.mapValues { JsonPrimitive(it.value) })))
                        },
                    )
                } else {
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
                        if (showingCached) item(key = "cached") { WorkNote(stringResource(R.string.core_showing_cached)) }
                        if (visible.isEmpty()) {
                            item(key = "empty") { WorkSection { WorkNote(stringResource(R.string.core_no_records, contract.pluralLabel.lowercase())) } }
                        } else {
                            // One panel, row by row, so a list of thousands stays lazy.
                            itemsIndexed(visible, key = { index, record -> record.coreId.ifEmpty { "#$index" } }) { index, record ->
                                Column(Modifier.padding(horizontal = 16.dp).background(c.panel, panelShape(index, visible.size))) {
                                    if (index > 0) WorkDivider()
                                    CoreRecordRow(contract, record, actions) { open(record) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    moveError?.let { message ->
        AlertDialog(
            onDismissRequest = { moveError = null },
            containerColor = c.elevated,
            title = { Text(stringResource(R.string.core_unable_to_load), style = StarlingsType.headline, color = c.primary) },
            text = { Text(message, style = StarlingsType.body, color = c.secondary) },
            confirmButton = { TextButton({ moveError = null }) { Text(stringResource(R.string.core_ok), color = c.primary) } },
        )
    }
}

/** What a long press on a row offers (`recordContextMenu`), and the board's moves. */
internal class CoreRowActions(
    val contract: CoreEntityContract,
    val columns: List<CoreFieldOption>,
    val onMove: (JsonObject, String, CoreFieldOption) -> Unit,
) {
    val boardField: String? get() = contract.board?.field?.takeIf { columns.isNotEmpty() && contract.canUpdate }
}

/**
 * `CoreRecordRow`'s menu: Copy name, Copy Public Link, Email, Open link, and
 * on a board entity the stages to move to.
 */
@Composable
internal fun CoreRowMenu(record: JsonObject, actions: CoreRowActions, expanded: Boolean, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val contract = actions.contract
    fun item(label: String, run: () -> Unit): @Composable () -> Unit = {
        DropdownMenuItem(text = { Text(label, style = StarlingsType.body, color = c.primary) }, onClick = { onDismiss(); run() })
    }
    fun view(uri: String) = runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri))) }
    DropdownMenu(expanded, onDismiss, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
        item(stringResource(R.string.core_copy_name)) {
            copyToClipboard(context, record.coreDisplayName(contract.primaryField))
            toast(r.getString(R.string.core_name_copied))
        }()
        CoreFields.publicShareUrl(contract.id, record.coreId)?.let { url ->
            item(stringResource(R.string.core_copy_public_link)) {
                copyToClipboard(context, url)
                toast(r.getString(R.string.core_public_link_copied))
            }()
        }
        CoreFields.mailto(record)?.let { item(stringResource(R.string.core_email)) { view(it) }() }
        CoreFields.link(record)?.let { item(stringResource(R.string.core_open_link)) { view(it) }() }
        val field = actions.boardField
        if (field != null) {
            val current = record[field].coreString()
            val destinations = actions.columns.filter { it.value != current }
            if (destinations.isNotEmpty()) {
                HorizontalDivider(color = c.border)
                destinations.forEach { option -> item(r.getString(R.string.core_move_to, option.label)) { actions.onMove(record, field, option) }() }
            }
        }
    }
}

/**
 * `CRMRecordRow`: the record's face (a picture over its initials) where the
 * entity has one or the record carries one, else the entity's mark; the
 * name, and its detail lines under it. A long press holds its actions.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun CoreRecordRow(contract: CoreEntityContract, record: JsonObject, actions: CoreRowActions? = null, modifier: Modifier = Modifier, onOpen: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box(modifier) {
        CoreRecordRowContent(contract, record, Modifier.combinedClickable(role = Role.Button, onLongClick = actions?.let { { menu = true } }, onClick = onOpen))
        if (actions != null) CoreRowMenu(record, actions, menu, { menu = false })
    }
}

/** The row itself, without its gestures: the board's cards and their lifted copy draw it too. */
@Composable
internal fun CoreRecordRowContent(contract: CoreEntityContract, record: JsonObject, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    val name = record.coreDisplayName(contract.primaryField, contract.singularLabel)
    val details = CoreRules.rowDetails(contract, record).take(2)
    val avatar = CoreFields.avatarUrl(record)
    Row(
        Modifier
            .fillMaxWidth()
            .then(modifier)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (CoreFields.identity(contract).showsAvatar || avatar != null) {
            CoreAvatar(avatar, name, contract.id, contract.icon)
        } else {
            WorkMark(coreIcon(contract.icon), size = 40.dp, square = true, glyphScale = 0.42f)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(name, style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary)
            details.forEach { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

/** A row of a lazy panel: the first rounds its top, the last its bottom, as one `WorkSection`. */
internal fun panelShape(index: Int, count: Int): RoundedCornerShape {
    val r = StarlingsRadius.field
    val top = if (index == 0) r else 0.dp
    val bottom = if (index == count - 1) r else 0.dp
    return RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom)
}
