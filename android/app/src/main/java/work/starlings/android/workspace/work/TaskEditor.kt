package work.starlings.android.workspace.work

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkSection
import work.starlings.contracts.CrmTeamMember
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * `MobileTaskEditor`: the sheet that writes a task. Title and notes, a Due
 * date switch that only then shows the day, Status and Responsible, and the
 * Assignee while the team owes it. A new team task starts as the creator's
 * own ([selfEmail]), still changeable; a late roster never
 * overrides a hand-picked assignee.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TaskEditor(
    initial: TaskDraft,
    team: List<CrmTeamMember>,
    teamError: String?,
    whereText: String?,
    selfEmail: String?,
    onDismiss: () -> Unit,
    goals: List<work.starlings.contracts.CrmGoal> = emptyList(),
    onSave: (TaskDraft) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var draft by remember { mutableStateOf(initial) }
    var assigneeChosen by remember { mutableStateOf(false) }
    var pickingDay by remember { mutableStateOf(false) }
    LaunchedEffect(team.map { it.id }) {
        if (!assigneeChosen) draft = draft.preselectingSelf(team, selfEmail)
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.canvas).imePadding()) {
            // The bar: Close, the inline title, Save as the filled confirm.
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp)) {
                Box(Modifier.align(Alignment.CenterStart)) { WorkIconButton(Icons.Filled.Close, stringResource(R.string.work_close), onDismiss) }
                Text(
                    stringResource(if (draft.id == null) R.string.work_new_task else R.string.work_edit_task),
                    Modifier.align(Alignment.Center),
                    style = StarlingsType.headline,
                    color = c.primary,
                )
                Text(
                    stringResource(R.string.work_save),
                    Modifier
                        .align(Alignment.CenterEnd)
                        .background(c.accent.copy(alpha = if (draft.canSave) 1f else 0.45f), CircleShape)
                        .clickable(enabled = draft.canSave, role = Role.Button) { onSave(draft) }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    style = StarlingsType.headline,
                    color = c.accentInk,
                )
            }
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                whereText?.let { WorkSection { WorkLabeledRow(r.getString(R.string.work_where), it) } }
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    StarlingsField(draft.title, { draft = draft.copy(title = it) }, placeholder = stringResource(R.string.work_task_title))
                    StarlingsField(
                        draft.notes, { draft = draft.copy(notes = it) },
                        placeholder = stringResource(R.string.work_notes_optional), singleLine = false, maxLines = 4,
                    )
                }
                WorkSection {
                    Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                        StarlingsToggle(stringResource(R.string.work_due_date), draft.due != null, { on ->
                            draft = draft.copy(due = if (on) (draft.due ?: LocalDate.now()) else null)
                        })
                    }
                    draft.due?.let { day ->
                        WorkDivider()
                        WorkLabeledRow(r.getString(R.string.work_due), WorkFormat.day(day.atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()), onClick = { pickingDay = true })
                    }
                }
                WorkSection {
                    MenuPicker(
                        r.getString(R.string.work_status),
                        TaskStatus.editable.map { it to WorkFormat.status(r, it) },
                        draft.status,
                    ) { draft = draft.copy(status = it) }
                    WorkDivider()
                    MenuPicker(
                        r.getString(R.string.work_responsible),
                        TaskSide.entries.map { it to WorkFormat.sideMenu(r, it) },
                        draft.side,
                    ) { draft = draft.withSide(it) }
                    // Only the team has members: naming one of us on a client task would be a lie.
                    if (draft.side == TaskSide.TEAM) {
                        WorkDivider()
                        if (team.isEmpty()) {
                            WorkErrorNotice(teamError ?: r.getString(R.string.work_team_error))
                        } else {
                            AssigneePicker(team, draft.assignedTo) { picked ->
                                assigneeChosen = true
                                draft = draft.copy(assignedTo = picked)
                            }
                        }
                    }
                }
                // Where the work points. Only on a project with goals.
                val offered = Goals.offered(goals, draft.goalId, LocalDate.now())
                if (offered.isNotEmpty()) {
                    WorkSection {
                        MenuPicker(
                            r.getString(R.string.work_goal),
                            listOf<Pair<String?, String>>(null to r.getString(R.string.work_none)) + offered.map { it.id to it.title },
                            draft.goalId,
                        ) { draft = draft.copy(goalId = it) }
                    }
                }
            }
        }
    }

    if (pickingDay) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = (draft.due ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        )
        DatePickerDialog(
            onDismissRequest = { pickingDay = false },
            confirmButton = {
                TextButton({
                    state.selectedDateMillis?.let { ms ->
                        draft = draft.copy(due = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate())
                    }
                    pickingDay = false
                }) { Text(stringResource(R.string.work_done), color = c.primary) }
            },
            dismissButton = { TextButton({ pickingDay = false }) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
        ) {
            DatePicker(state)
        }
    }
}

/** A `Picker` row in menu style: the label, the chosen value, a menu of the choices. */
@Composable
internal fun <T> MenuPicker(label: String, options: List<Pair<T, String>>, selected: T, onPick: (T) -> Unit) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    val value = options.firstOrNull { it.first == selected }?.second.orEmpty()
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { open = true }
                .clearAndSetSemantics { contentDescription = "$label, $value"; role = Role.DropdownList }
                .padding(horizontal = 16.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = StarlingsType.body, color = c.primary)
            Spacer(Modifier.weight(1f))
            Text(value, style = StarlingsType.body, color = c.secondary)
            Icon(Icons.Filled.UnfoldMore, null, Modifier.size(18.dp), tint = c.secondary)
        }
        DropdownMenu(open, { open = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
            options.forEach { (option, title) ->
                MenuChoice(title, option == selected) { onPick(option); open = false }
            }
        }
    }
}

/**
 * `StarlingsSearchablePicker` for the assignee: Nobody yet, then the
 * roster, behind a search field once the list is long.
 */
@Composable
private fun AssigneePicker(team: List<CrmTeamMember>, selected: String?, onPick: (String?) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val nobody = r.getString(R.string.work_nobody_yet)
    val label = r.getString(R.string.work_assignee)
    val value = team.firstOrNull { it.id == selected }?.name ?: nobody
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button) { query = ""; open = true }
            .clearAndSetSemantics { contentDescription = "$label, $value"; role = Role.Button }
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.weight(1f))
        Text(value, style = StarlingsType.body, color = c.secondary)
        Icon(Icons.Filled.UnfoldMore, null, Modifier.size(18.dp), tint = c.secondary)
    }
    if (open) {
        Dialog(onDismissRequest = { open = false }) {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 520.dp).background(c.elevated, RoundedCornerShape(18.dp)).padding(vertical = 12.dp),
            ) {
                Text(label, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.headline, color = c.primary)
                Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                    StarlingsField(query, { query = it }, placeholder = r.getString(R.string.work_search))
                }
                val options = listOf<Pair<String?, String>>(null to nobody) +
                    team.sortedBy { it.name.lowercase() }.map { it.id to it.name }
                val shown = options.filter { (_, title) -> query.isBlank() || work.starlings.android.Search.matches(query, title, "") }
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    if (shown.isEmpty()) WorkNote(r.getString(R.string.work_no_options_match))
                    shown.forEach { (id, title) ->
                        Row(
                            Modifier.fillMaxWidth().clickable(role = Role.Button) { onPick(id); open = false }.padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Box(Modifier.size(20.dp)) { if (id == selected) Icon(Icons.Filled.Check, null, tint = c.primary) }
                            Text(title, style = StarlingsType.body.copy(fontWeight = if (id == selected) FontWeight.SemiBold else FontWeight.Normal), color = c.primary)
                        }
                    }
                }
            }
        }
    }
}
