package work.starlings.android.workspace.work

import work.starlings.android.ui.Haptic
import android.content.res.Resources
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.host.MeetingFiling
import work.starlings.android.host.rememberSubjectRoomStarter
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkRowAction
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.contracts.CrmLeadWinResponse
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.SubjectStateUpdate

/** The facts a subject row's menu is decided on (`MobileWorkView.subjectMenu`). */
internal object SubjectMenuFacts {
    /** `SubjectStatusRegistry.isClosed`: the statuses `fixtures/subject-status.json` calls closed. */
    val closedLeadStatuses = setOf("Closed Won", "Closed Lost")

    fun isOpenLead(subject: CrmSubjectWire): Boolean = subject.kind == CrmSubjectKind.LEAD && subject.status.orEmpty() !in closedLeadStatuses

    /** [hasCore]: the subject has a page in the workspace's Core (`subject.coreURL != nil`). */
    fun of(subject: CrmSubjectWire, hasCore: Boolean = false): Map<String, Boolean> = mapOf(
        "isPartner" to (subject.kind == CrmSubjectKind.ORGANIZATION),
        "isEvent" to (subject.kind == CrmSubjectKind.EVENT),
        "isProject" to (subject.kind == CrmSubjectKind.PROJECT),
        "isOpenLead" to isOpenLead(subject),
        "hasRepo" to (subject.hasRepo == true),
        "hasCore" to hasCore,
    )

    fun context(subject: CrmSubjectWire): String = if (subject.kind == CrmSubjectKind.ORGANIZATION) "organization" else "row"
}

/** What a subject row's menu opens; each list screen hands in its own. */
internal class SubjectMenuDoors(
    /** The subject at a pane, with an editor up (`task`, `issue`) when [create] says so. */
    val open: (CrmSubjectWire, SubjectPane?, create: String?) -> Unit,
    val edit: (CrmSubjectWire) -> Unit,
    val rename: (CrmSubjectWire) -> Unit,
    val win: (CrmSubjectWire) -> Unit,
    val linkRepository: (CrmSubjectWire) -> Unit,
    val keep: KeepDoors?,
    /** Meet about this: host the owner's room, filed under the subject. */
    val meet: (CrmSubjectWire) -> Unit = {},
    val core: CoreDoors? = null,
)

/**
 * Open in Core (`subject.coreURL`, `openURL`): the subject's page in the
 * workspace's Core, `<core>/dashboard/<collection>/<id>`. Null where the
 * workspace has no Core, so the entry drops out.
 */
internal class CoreDoors(val url: (CrmSubjectWire) -> String?, val open: (String) -> Unit)

@Composable
internal fun rememberCoreDoors(): CoreDoors? {
    val context = LocalContext.current
    val core = remember { work.starlings.android.core.CoreAccess.of(context) }
    if (!core.isAvailable) return null
    return remember(core.origin, core.coreGroups) {
        CoreDoors(
            url = { subject -> work.starlings.android.core.CoreLinks.collection(subject.kind.value)?.let { core.dashboardUrl(it, subject.id) } },
            open = { url -> runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))) } },
        )
    }
}

/**
 * A subject row's menu: which actions, in what order, for which kind comes
 * from the shared table ([WorkRowActions], `fixtures/work-actions.json`
 * `subject`); this says what each does here, and its words. Star and Mute
 * wait for the subject state.
 */
internal fun subjectRowMenu(r: Resources, store: WorkStore, subject: CrmSubjectWire, doors: SubjectMenuDoors): List<WorkRowAction> {
    val state = store.states.resolved(subject)
    val known = store.states.known
    val coreUrl = doors.core?.url?.invoke(subject)
    val groups = WorkRowActions.groups(WorkRowActions.Kind.SUBJECT, SubjectMenuFacts.context(subject), SubjectMenuFacts.of(subject, hasCore = coreUrl != null))
    fun stateWrite(update: SubjectStateUpdate) = store.act { store.setSubjectState(subject, update) }
    val rows = groups.map { group ->
        group.mapNotNull { id ->
            when (id) {
                "star" -> if (!known) null else WorkRowAction(r.getString(if (state.starred) R.string.work_unstar else R.string.work_star)) {
                    stateWrite(SubjectStateUpdate(starred = !state.starred))
                }
                "mute" -> if (!known) null else WorkRowAction(r.getString(if (state.muted) R.string.work_unmute else R.string.work_mute)) {
                    stateWrite(SubjectStateUpdate(muted = !state.muted))
                }
                // A partner's Open lands on its Overview; anything else on its Talk.
                "open" -> WorkRowAction(r.getString(R.string.work_open_menu)) {
                    doors.open(subject, if (subject.kind == CrmSubjectKind.ORGANIZATION) SubjectPane.OVERVIEW else SubjectPane.TALK, null)
                }
                "open-talk" -> WorkRowAction(r.getString(R.string.work_open_talk)) { doors.open(subject, SubjectPane.TALK, null) }
                "open-history" -> WorkRowAction(r.getString(R.string.work_open_history)) { doors.open(subject, SubjectPane.INTERACTIONS, null) }
                "open-tasks" -> WorkRowAction(r.getString(R.string.work_open_tasks)) { doors.open(subject, SubjectPane.TASKS, null) }
                "new-task" -> WorkRowAction(r.getString(R.string.work_new_task_menu)) { doors.open(subject, SubjectPane.TASKS, "task") }
                "open-issues" -> WorkRowAction(r.getString(R.string.work_open_issues)) { doors.open(subject, SubjectPane.ISSUES, null) }
                "new-issue" -> WorkRowAction(r.getString(R.string.work_new_issue_menu)) { doors.open(subject, SubjectPane.ISSUES, "issue") }
                "edit-details" -> WorkRowAction(r.getString(R.string.work_edit_details)) { doors.edit(subject) }
                "rename" -> WorkRowAction(r.getString(R.string.work_rename_menu)) { doors.rename(subject) }
                "win-lead" -> WorkRowAction(r.getString(R.string.work_win_menu)) { doors.win(subject) }
                // The room files itself under this subject the moment it is up.
                "start-room" -> WorkRowAction(r.getString(R.string.work_meet_about_this)) { doors.meet(subject) }
                "link-repository" -> WorkRowAction(r.getString(R.string.work_link_github_repository)) { doors.linkRepository(subject) }
                // The project's vault in Keep, made on first open (docs/KEEP.md); only where the workspace has Keep.
                "keep-vault" -> doors.keep?.let { keep -> WorkRowAction(r.getString(R.string.keep_vault_menu)) { keep.openProject(subject.id, WorkFormat.displayTitle(subject)) } }
                "open-core" -> coreUrl?.let { url -> doors.core?.let { core -> WorkRowAction(r.getString(R.string.core_open_in_core)) { core.open(url) } } }
                else -> null
            }
        }
    }.filter { it.isNotEmpty() }
    return rows.flatMap { group -> group.mapIndexed { index, action -> if (index == 0) WorkRowAction(action.title, action.danger, startsGroup = true, run = action.run) else action } }
}

/**
 * The sheets a subject menu opens over a list (`MobileWorkView`'s
 * `editorTarget`, `renameTarget`, `winTarget`, `repoTarget`), and the New
 * project… and New lead… editor. [onCreated] opens a new subject or a won
 * lead's project at Talk; [onFailure] says a refusal where the list shows one.
 */
internal class SubjectSheets {
    var editing by mutableStateOf<SubjectEditorTarget?>(null)
    var renaming by mutableStateOf<CrmSubjectWire?>(null)
    var winning by mutableStateOf<CrmSubjectWire?>(null)
    var linking by mutableStateOf<CrmSubjectWire?>(null)
    var meetingAbout by mutableStateOf<CrmSubjectWire?>(null)

    fun doors(open: (CrmSubjectWire, SubjectPane?, String?) -> Unit, keep: KeepDoors?, core: CoreDoors? = null) = SubjectMenuDoors(
        open = open,
        edit = { subject -> editing = SubjectEditorTarget(subject.kind, SubjectRef.of(subject)) },
        rename = { renaming = it },
        win = { winning = it },
        linkRepository = { linking = it },
        keep = keep,
        meet = { meetingAbout = it },
        core = core,
    )
}

@Composable
internal fun SubjectSheetsHost(
    store: WorkStore,
    sheets: SubjectSheets,
    onCreated: (SubjectRef) -> Unit,
    onFailure: (String?) -> Unit,
) {
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    val meet = rememberSubjectRoomStarter()
    sheets.meetingAbout?.let { subject ->
        LaunchedEffect(subject) {
            sheets.meetingAbout = null
            meet(MeetingFiling.about(subject.kind, subject.id, subject.title))
        }
    }
    sheets.editing?.let { target ->
        SubjectEditorSheet(store, target, onDismiss = { sheets.editing = null }) { saved ->
            sheets.editing = null
            onFailure(null)
            if (target.subject == null) onCreated(SubjectRef(target.kind, saved.id, saved.title))
        }
    }
    sheets.renaming?.let { subject ->
        RenameSubjectDialog(subject, onDismiss = { sheets.renaming = null }) { title ->
            sheets.renaming = null
            if (title.isBlank()) { onFailure(r.getString(R.string.work_add_a_name_first)); return@RenameSubjectDialog }
            scope.launch {
                try {
                    store.renameSubject(subject.kind, subject.id, title)
                    onFailure(null)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    onFailure(e.workMessage())
                }
            }
        }
    }
    sheets.winning?.let { lead ->
        WinLeadSheet(store, lead, onDismiss = { sheets.winning = null }) { won ->
            sheets.winning = null
            onCreated(SubjectRef(CrmSubjectKind.PROJECT, won.project.id, won.project.title))
            val notice = WinLead.notice(r, won)
            onFailure(notice)
            // A clean win is the one that is felt; a notice says the rest.
            if (notice == null) store.haptic.fire(Haptic.SUCCESS)
        }
    }
    sheets.linking?.let { subject ->
        RepoPickerSheet(store, subject.id, onDismiss = { sheets.linking = null }) {
            sheets.linking = null
            scope.launch { store.loadAll(refreshMine = false) }
        }
    }
}

/** Rename: the name alone, Cancel and Rename. */
@Composable
private fun RenameSubjectDialog(subject: CrmSubjectWire, onDismiss: () -> Unit, onRename: (String) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var draft by remember(subject.id) { mutableStateOf(subject.title) }
    val word = r.getString(if (subject.kind == CrmSubjectKind.LEAD) R.string.work_kind_lead else R.string.work_kind_project).lowercase()
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(r.getString(R.string.work_rename_kind, word), style = StarlingsType.headline, color = c.primary) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                StarlingsField(draft, { draft = it.replace('\n', ' ') }, placeholder = r.getString(R.string.work_field_name))
            }
        },
        confirmButton = { TextButton({ onRename(draft) }) { Text(r.getString(R.string.work_rename), color = c.primary) } },
        dismissButton = { TextButton(onDismiss) { Text(r.getString(R.string.work_cancel), color = c.primary) } },
    )
}

/** Win's rules (`MobileLeadWinView`): which tasks move, and what the answer says. */
internal object WinLead {
    /** The statuses that move with a win: proposed work is not yet accepted, and finished work stays where it was done. */
    val movable = setOf(TaskStatus.PENDING, TaskStatus.IN_PROGRESS, TaskStatus.REVIEW, TaskStatus.BLOCKED)

    fun movable(tasks: List<CrmTaskWire>): List<CrmTaskWire> = tasks.filter { TaskStatus.of(it.status) in movable }

    /** The checked ids in list order, so the request reads the way the sheet does. */
    fun taskIds(tasks: List<CrmTaskWire>, moving: Set<String>): List<String> = tasks.map { it.id }.filter { it in moving }

    /** `won`: the lead still open, or tasks left behind, is said; a clean win says nothing. */
    fun notice(r: Resources, won: CrmLeadWinResponse): String? = when {
        !won.leadClosed -> r.getString(R.string.work_project_started_lead_open)
        won.unmovedTaskIds.isNotEmpty() -> r.getQuantityString(R.plurals.work_n_tasks_stayed_on_lead, won.unmovedTaskIds.size, won.unmovedTaskIds.size)
        else -> null
    }
}

/**
 * `MobileLeadWinView` (ADR 0008): the project's name, and which of the
 * lead's open tasks move, all checked. The Worker creates the project,
 * moves the checked tasks, then closes the lead.
 */
@Composable
internal fun WinLeadSheet(store: WorkStore, lead: CrmSubjectWire, onDismiss: () -> Unit, onWon: (CrmLeadWinResponse) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var title by remember(lead.id) { mutableStateOf(lead.title) }
    var tasks by remember(lead.id) { mutableStateOf<List<CrmTaskWire>>(emptyList()) }
    var moving by remember(lead.id) { mutableStateOf<Set<String>>(emptySet()) }
    var loading by remember(lead.id) { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(lead.id) {
        try {
            val open = WinLead.movable(store.leadTasks(lead.id))
            tasks = open
            moving = open.map { it.id }.toSet()
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        } finally {
            loading = false
        }
    }
    fun win() {
        if (saving || loading || title.isBlank()) return
        saving = true
        scope.launch {
            try {
                onWon(store.winLead(lead.id, title, WinLead.taskIds(tasks, moving)))
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                saving = false
            }
        }
    }
    WorkSheet(
        r.getString(R.string.work_win_lead), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(if (saving) R.string.work_winning else R.string.work_win),
        confirmEnabled = !saving && !loading && title.isNotBlank(), onConfirm = ::win,
    ) {
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_kind_project)) }) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(title, { title = it.replace('\n', ' ') }, r.getString(R.string.work_field_name))
            }
        }
        if (tasks.isNotEmpty()) {
            WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_open_tasks_header)) }) {
                tasks.forEachIndexed { index, task ->
                    if (index > 0) WorkDivider()
                    StarlingsToggle(
                        task.title, task.id in moving,
                        { on -> moving = if (on) moving + task.id else moving - task.id },
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        enabled = !saving,
                    )
                }
            }
        }
        error?.let { WorkSection { WorkErrorNotice(it) } }
        if (loading || saving) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), color = c.secondary, strokeWidth = 2.dp) }
        }
    }
}
