package work.starlings.android.core.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonObject
import work.starlings.android.R
import work.starlings.android.core.CoreEntityContract
import work.starlings.android.core.CoreTasks
import work.starlings.android.core.coreDisplayName
import work.starlings.android.core.coreId
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkIconButton
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * `taskChecklist`: tasks as a checklist, a section per project with a + that
 * starts a task there, each row led by a box that completes or reopens it in
 * place. A task just ticked off stays, crossed out, for three seconds
 * ([lingering]); done ones otherwise only with Show Completed. Nothing open
 * reads "All Caught Up". A long press holds the row's actions.
 */
@Composable
internal fun CoreTaskChecklist(
    contract: CoreEntityContract,
    records: List<JsonObject>,
    showCompleted: Boolean,
    lingering: Set<String>,
    actions: CoreRowActions,
    onToggle: (JsonObject) -> Unit,
    onOpen: (JsonObject) -> Unit,
    onCreate: (Map<String, String>) -> Unit,
) {
    val c = Starlings.colors
    val locale = LocalContext.current.resources.configuration.locales[0]
    val sections = remember(records, showCompleted, lingering, locale) { CoreTasks.sections(records, showCompleted, lingering, locale) }
    if (sections.isEmpty()) {
        Column(
            Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        ) {
            Icon(Icons.Filled.CheckCircle, null, Modifier.size(40.dp), tint = c.secondary)
            Text(stringResource(R.string.core_tasks_all_caught_up), style = StarlingsType.title3.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
            Text(stringResource(R.string.core_tasks_none), style = StarlingsType.body, color = c.secondary)
            if (contract.canCreate) BorderedButton(stringResource(R.string.core_tasks_new), { onCreate(emptyMap()) }, compact = true)
        }
        return
    }
    val noProject = stringResource(R.string.core_tasks_no_project)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
        sections.forEach { section ->
            val title = section.title ?: noProject
            item(key = "h:${section.id}") {
                Row(Modifier.fillMaxWidth().padding(start = 32.dp, end = 20.dp, top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f), style = StarlingsType.headline, color = c.primary)
                    if (contract.canCreate) {
                        WorkIconButton(Icons.Filled.Add, stringResource(R.string.core_tasks_new_in, title), { onCreate(CoreTasks.prefill(section)) })
                    }
                }
            }
            itemsIndexed(section.records, key = { index, record -> "${section.id}:${record.coreId.ifEmpty { "#$index" }}" }) { index, record ->
                Column(Modifier.padding(horizontal = 16.dp).background(c.panel, panelShape(index, section.records.size))) {
                    if (index > 0) WorkDivider()
                    CoreTaskRow(contract, record, actions, onToggle = { onToggle(record) }, onOpen = { onOpen(record) })
                }
            }
        }
        if (contract.canCreate) {
            item(key = "new") {
                Row(
                    Modifier
                        .padding(start = 16.dp, end = 16.dp, top = 18.dp)
                        .fillMaxWidth()
                        .background(c.panel, panelShape(0, 1))
                        .combinedClickable(role = Role.Button, onClick = { onCreate(emptyMap()) })
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.AddCircle, null, Modifier.size(22.dp), tint = c.primary)
                    Text(stringResource(R.string.core_tasks_new), style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary)
                }
            }
        }
    }
}

/** `taskRow`: the box, the title (struck through when done), its due day and its owner. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CoreTaskRow(contract: CoreEntityContract, record: JsonObject, actions: CoreRowActions, onToggle: () -> Unit, onOpen: () -> Unit) {
    val c = Starlings.colors
    val r = LocalContext.current.resources
    val locale = r.configuration.locales[0]
    var menu by remember { mutableStateOf(false) }
    val done = CoreTasks.isDone(record)
    val title = record.coreDisplayName(contract.primaryField, contract.singularLabel)
    val due = CoreTasks.due(record)?.let { due ->
        when (due) {
            CoreTasks.Due.Today -> r.getString(R.string.core_tasks_today)
            CoreTasks.Due.Tomorrow -> r.getString(R.string.core_tasks_tomorrow)
            CoreTasks.Due.Yesterday -> r.getString(R.string.core_tasks_yesterday)
            is CoreTasks.Due.Day -> DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(locale, "MMMd"), locale).format(due.date)
        }
    }
    val owner = CoreTasks.responsible(record)?.let { party ->
        when (party) {
            is CoreTasks.Responsible.Named -> party.name
            CoreTasks.Responsible.Envisioning -> r.getString(R.string.core_tasks_envisioning)
            CoreTasks.Responsible.Client -> r.getString(R.string.core_tasks_client)
        }
    }
    Box {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
            val boxLabel = if (done) r.getString(R.string.core_tasks_reopen, title) else r.getString(R.string.core_tasks_complete, title)
            Box(
                Modifier
                    .size(48.dp)
                    .combinedClickable(enabled = contract.canUpdate, role = Role.Checkbox, onClick = onToggle)
                    .semantics { contentDescription = boxLabel },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (done) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank,
                    null,
                    Modifier.size(26.dp),
                    tint = if (done) c.primary else c.secondary,
                )
            }
            Column(
                Modifier
                    .weight(1f)
                    .combinedClickable(role = Role.Button, onLongClick = { menu = true }, onClick = onOpen)
                    .padding(end = 16.dp, top = 8.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    title,
                    style = StarlingsType.body.copy(textDecoration = if (done) TextDecoration.LineThrough else null),
                    color = if (done) c.secondary else c.primary,
                )
                due?.let { CoreTaskLine(Icons.Filled.CalendarToday, it) }
                owner?.let { CoreTaskLine(Icons.Filled.Person, it) }
            }
        }
        CoreRowMenu(record, actions, menu) { menu = false }
    }
}

@Composable
private fun CoreTaskLine(icon: ImageVector, text: String) {
    val c = Starlings.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(12.dp), tint = c.secondary)
        Text(text, style = StarlingsType.caption, color = c.secondary)
    }
}
