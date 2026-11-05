package work.starlings.android.workspace.work

import androidx.compose.ui.platform.LocalView
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.ui.Haptic
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkTopBar
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.CrmTaskWire

/** What a pushed task page starts from: Mine's summary, or a subject list's full record. */
internal sealed interface TaskSource {
    data class Summary(val summary: CrmMyTaskWire) : TaskSource
    data class Full(val task: CrmTaskWire, val subject: SubjectRef?) : TaskSource
}

/**
 * `MobileTaskView`: a task read without opening its editor. A Mine summary
 * carries no responsible party or assignee, so the full record is read by
 * id first (falling back to the subject's list) and the editor only runs on
 * that. Edit, Done and Delete write through Core; Mine reads again after.
 */
@Composable
internal fun TaskScreen(
    store: WorkStore,
    source: TaskSource,
    onBack: () -> Unit,
    onOpenSubject: (SubjectRef) -> Unit,
    onDeleted: (String) -> Unit = {},
) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val subject: SubjectRef? = when (source) {
        is TaskSource.Summary -> TaskKeys.of(source.summary).subject(source.summary.subjectTitle)
        is TaskSource.Full -> source.subject
    }
    // Core named a subject without an id Mine can resolve: said, without a link.
    val unresolvedTitle = (source as? TaskSource.Summary)?.summary?.let { if (subject == null) it.subjectTitle else null }
    var task by remember(source) {
        mutableStateOf(
            when (source) {
                is TaskSource.Summary -> source.summary.partialTask()
                is TaskSource.Full -> source.task
            },
        )
    }
    var complete by remember(source) { mutableStateOf(source is TaskSource.Full) }
    var error by remember { mutableStateOf<String?>(null) }
    HapticWhenSet(Haptic.ERROR, error)
    val view = LocalView.current
    var busy by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<TaskDraft?>(null) }
    var deleting by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    var goals by remember { mutableStateOf<List<work.starlings.contracts.CrmGoal>>(emptyList()) }
    val keys = TaskKeys.of(task)
    val whereText = WorkFormat.where(r, keys, subject, unresolvedTitle)
    val status = TaskStatus.of(task.status)

    suspend fun load() {
        try {
            task = store.readTask(task.id)
            complete = true
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (!complete) {
                // The subject's own list, when a subject key can ask for it.
                val fallback = if (keys.hasSubjectKey) runCatching { store.readFromSubjectList(task) }.getOrNull() else null
                if (fallback != null) { task = fallback; complete = true; error = null } else error = e.workMessage()
            }
        }
        store.loadTeam()
        // Goals for the editor's picker; a failure hides the row.
        task.projectId?.let { project -> store.goals(project).takeIf { it.isNotEmpty() }?.let { goals = it } }
    }

    fun write(update: work.starlings.contracts.CrmTaskUpdate, after: (Boolean) -> Unit = {}) {
        if (busy) return
        busy = true
        scope.launch {
            val ok = try {
                task = store.update(task.id, update)
                complete = true
                error = null
                true
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
                false
            } finally {
                busy = false
            }
            after(ok)
        }
    }

    LaunchedEffect(source) { load() }

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(stringResource(R.string.work_task), stringResource(R.string.work_back), onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            WorkSection {
                SelectionContainer {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(task.title, style = StarlingsType.headline, color = c.primary)
                        when {
                            complete -> Text(task.notes?.takeIf { it.isNotEmpty() } ?: r.getString(R.string.work_no_notes), style = StarlingsType.body, color = c.primary)
                            unresolvedTitle != null -> Text(r.getString(R.string.work_open_from, unresolvedTitle), style = StarlingsType.body, color = c.secondary)
                            subject == null -> Text(r.getString(R.string.work_task_no_subject), style = StarlingsType.body, color = c.secondary)
                            else -> Text(r.getString(R.string.work_details_not_loaded), style = StarlingsType.body, color = c.secondary)
                        }
                    }
                }
            }
            error?.let { message ->
                WorkSection {
                    WorkErrorNotice(message, retry = r.getString(R.string.work_retry), onRetry = { scope.launch { load() } })
                }
            }
            WorkSection(header = { work.starlings.android.ui.WorkHeaderTitle(r.getString(R.string.work_details)) }) {
                WorkLabeledRow(r.getString(R.string.work_where), whereText, onClick = subject?.let { s -> { onOpenSubject(s) } })
                WorkDivider()
                WorkLabeledRow(r.getString(R.string.work_status), WorkFormat.status(r, status))
                if (complete) {
                    WorkDivider()
                    WorkLabeledRow(r.getString(R.string.work_responsible), WorkFormat.side(r, TaskSide.of(task.responsibleParty)))
                    task.assigneeName?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_assigned_to), it) }
                    task.assigneeEmail?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_email), it) }
                task.goalId?.let { id -> goals.firstOrNull { it.id == id } }?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_goal), it.title) }
                }
                TaskDates.parse(task.dueDate)?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_due), WorkFormat.day(it)) }
                task.priority?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_priority), it) }
                task.tags?.takeIf { it.isNotEmpty() }?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_tags), it.joinToString(", ")) }
                TaskDates.parse(task.updatedAt)?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_updated), WorkFormat.dateTime(it)) }
                val owner = task.githubOwner
                val repo = task.githubRepo
                val number = task.githubIssueNumber
                if (owner != null && repo != null && number != null) {
                    WorkDivider()
                    WorkActionRow(r.getString(R.string.work_github_issue, number.toInt()), {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/$owner/$repo/issues/$number")))
                    }, accent = true)
                }
            }
            WorkSection {
                WorkActionRow(r.getString(R.string.work_edit_task), { editing = TaskDraft.of(task) }, enabled = complete && !busy)
                // Only for a project with somewhere to file, and only once: a second filing would orphan the first.
                if (subject?.isProject == true && task.githubIssueNumber == null) {
                    WorkDivider()
                    WorkActionRow(r.getString(R.string.work_file_on_github), {
                        busy = true
                        scope.launch {
                            try {
                                store.fileOnGitHub(task.id, subject.id, task.title, task.notes)
                                load()
                            } catch (e: Exception) {
                                if (e is CancellationException) throw e
                                error = e.workMessage()
                            } finally {
                                busy = false
                            }
                        }
                    }, enabled = !busy && complete)
                }
                if (status != TaskStatus.COMPLETED) {
                    WorkDivider()
                    WorkActionRow(r.getString(R.string.work_done), { write(TaskWrites.completion(true)) { ok -> if (ok) Haptic.SUCCESS.play(view) } }, enabled = !busy)
                }
                // Move to…: onto another project, lead, partner or event. The task leaves this list, so the page goes with it.
                WorkDivider()
                WorkActionRow(r.getString(R.string.work_move_to), { moving = true }, enabled = !busy)
                WorkDivider()
                WorkActionRow(r.getString(R.string.work_delete), { deleting = true }, enabled = !busy, danger = true)
            }
            // What was said about it: the hand-off, the agent's work, its questions.
            CardActivitySection(store, "task", task.id)
        }
    }

    editing?.let { draft ->
        TaskEditor(
            initial = draft,
            team = store.team,
            teamError = store.teamError,
            whereText = whereText,
            selfEmail = null,
            onDismiss = { editing = null },
            goals = goals,
        ) { saved ->
            editing = null
            write(saved.update(withGoal = goals.isNotEmpty())) { ok -> if (!ok) editing = saved }
        }
    }

    if (moving) {
        MoveTaskSheet(store, onDismiss = { moving = false }) { picked ->
            moving = false
            write(TaskWrites.move(keys, picked)) { ok -> if (ok) onBack() }
        }
    }

    if (deleting) {
        TaskDeleteDialog(task.title, onDismiss = { deleting = false }) {
            deleting = false
            busy = true
            scope.launch {
                try {
                    store.delete(task.id)
                    // The page leaves in the same beat, so it plays now.
                    Haptic.DESTRUCTIVE.play(view)
                    onDeleted(task.id)
                    onBack()
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    error = r.getString(R.string.work_delete_failure)
                } finally {
                    busy = false
                }
            }
        }
    }
}

/** `taskDeleteConfirmation`: the title, the line that it can't be undone, a destructive Delete and Cancel. */
@Composable
internal fun TaskDeleteDialog(title: String, onDismiss: () -> Unit, onDelete: () -> Unit) {
    val c = Starlings.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(stringResource(R.string.work_delete_title, title), style = StarlingsType.headline, color = c.primary) },
        text = { Text(stringResource(R.string.work_delete_message), style = StarlingsType.body, color = c.secondary) },
        confirmButton = { TextButton(onDelete) { Text(stringResource(R.string.work_delete), color = c.danger) } },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
    )
}

/** `mineDestination`: Mine's own row by id; said rather than drawn blank when Mine no longer holds it. */
@Composable
internal fun MineTaskDestination(store: WorkStore, id: String, onBack: () -> Unit, onOpenSubject: (SubjectRef) -> Unit) {
    val c = Starlings.colors
    val summary = store.findTask(id)
    if (summary != null) {
        TaskScreen(store, remember(id) { TaskSource.Summary(summary) }, onBack, onOpenSubject)
        return
    }
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(stringResource(R.string.work_task), stringResource(R.string.work_back), onBack)
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            if (store.isLoading) {
                Text(stringResource(R.string.work_loading), style = StarlingsType.body, color = c.secondary)
            } else {
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Filled.CheckCircle, null, tint = c.secondary)
                    Text(stringResource(R.string.work_not_on_list), style = StarlingsType.title3.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = c.primary)
                    Text(stringResource(R.string.work_not_assigned_any_more), style = StarlingsType.body, color = c.secondary)
                }
            }
        }
    }
}
