package work.starlings.android.workspace.work

import android.content.res.Resources
import work.starlings.android.R
import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticPulse
import work.starlings.android.ui.WorkRowAction
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.PeerWire

/**
 * The menus Work's rows draw (`WorkRowActionMenu` over
 * `CrmMyTask.rowActions`, `CrmTask.rowActions`, `CrmIssue.stateActions`):
 * the ids come from [WorkRowActions], in its groups; this file says what
 * each does here. Facts Android cannot honour yet (Core links, stars)
 * are false, so the registry leaves those entries out. Hand off to lists
 * the roster's agents; with none it drops out.
 */
internal class TaskMenuDoors(
    val openSubject: (SubjectRef) -> Unit,
    val openTask: (String) -> Unit,
    val confirmDelete: (id: String, title: String) -> Unit,
    val agents: List<PeerWire> = emptyList(),
    val handOff: (HandOffRequest) -> Unit = {},
)

/** Turn the registry's groups into rows: a group's first entry starts a divider; Assign to is a caption and the names. */
private fun build(groups: List<List<String>>, entry: (String) -> List<WorkRowAction>): List<WorkRowAction> = buildList {
    groups.forEach { group ->
        val made = group.flatMap(entry)
        made.forEachIndexed { index, action ->
            add(if (index == 0) WorkRowAction(action.title, action.danger, startsGroup = true, header = action.header, run = action.run) else action)
        }
    }
}

/** One of your own tasks on MINE (`mine`), or one nobody holds (`unowned`, with Assign to). */
internal fun mineTaskMenu(r: Resources, store: WorkStore, task: CrmMyTaskWire, unowned: Boolean, doors: TaskMenuDoors): List<WorkRowAction> {
    val keys = TaskKeys.of(task)
    val subject = keys.subject(task.subjectTitle)
    val people = if (unowned) store.assignable(r.getString(R.string.work_me)) else emptyList()
    val projectId = keys.projectId
    val groups = WorkRowActions.groups(
        WorkRowActions.Kind.TASK, if (unowned) "unowned" else "mine",
        mapOf(
            "hasSubject" to (subject != null),
            "hasCore" to false,
            "canFileOnGitHub" to (projectId != null && task.githubIssueNumber == null),
            "canAssign" to people.isNotEmpty(),
            "canHandOff" to doors.agents.isNotEmpty(),
            "canDelete" to true,
        ),
    )
    return build(groups) { id ->
        when (id) {
            "complete" -> listOf(WorkRowAction(r.getString(R.string.work_done)) { store.complete(task) })
            "cancel" -> listOf(WorkRowAction(r.getString(R.string.work_cancel_task)) { store.cancelTask(task.id) })
            "assign" -> listOf(WorkRowAction(r.getString(R.string.work_assign_to), header = true)) +
                people.map { member -> WorkRowAction(member.name) { store.assignTask(task.id, member) } }
            "open-subject" -> subject?.let { listOf(WorkRowAction(r.getString(R.string.work_open_named, it.title)) { doors.openSubject(it) }) }.orEmpty()
            "open-mine" -> listOf(WorkRowAction(r.getString(R.string.work_open_in_mine)) { doors.openTask(task.id) })
            "hand-off" -> handOffActions(r, HandOffTarget.task(task.id, task.title, subject), doors.agents, doors.handOff)
            "file-github" -> projectId?.let { project ->
                listOf(WorkRowAction(r.getString(R.string.work_file_on_github)) { store.act { store.fileOnGitHub(task.id, project, task.title, null) } })
            }.orEmpty()
            "delete" -> listOf(WorkRowAction(r.getString(R.string.work_delete), danger = true) { doors.confirmDelete(task.id, task.title) })
            else -> emptyList()
        }
    }
}

/**
 * A subject's open task (`subject_open`). [reload] reads the subject's list again after a write.
 * [landed] is the pane's pulse (`MobileSubjectTasksView.haptic`): Done is felt as success, Cancel
 * as destructive, File on GitHub as success. The overview passes none: iOS is quiet there.
 */
internal fun subjectTaskMenu(
    r: Resources,
    store: WorkStore,
    task: CrmTaskWire,
    subject: SubjectRef,
    reload: () -> Unit,
    agents: List<PeerWire> = emptyList(),
    handOff: (HandOffRequest) -> Unit = {},
    landed: HapticPulse? = null,
    confirmDelete: (id: String, title: String) -> Unit,
): List<WorkRowAction> {
    val groups = WorkRowActions.groups(
        WorkRowActions.Kind.TASK, "subject_open",
        mapOf(
            "hasSubject" to true,
            "hasCore" to false,
            "canFileOnGitHub" to (task.projectId != null && task.githubIssueNumber == null),
            "canHandOff" to agents.isNotEmpty(),
            "canDelete" to true,
        ),
    )
    fun after(kind: Haptic, write: suspend () -> Unit) = store.act { write(); landed?.fire(kind); reload() }
    return build(groups) { id ->
        when (id) {
            "complete" -> listOf(WorkRowAction(r.getString(R.string.work_done)) { after(Haptic.SUCCESS) { store.update(task.id, TaskWrites.completion(true)) } })
            "cancel" -> listOf(WorkRowAction(r.getString(R.string.work_cancel_task)) { after(Haptic.DESTRUCTIVE) { store.update(task.id, TaskWrites.cancellation) } })
            "file-github" -> listOf(
                WorkRowAction(r.getString(R.string.work_file_on_github)) {
                    after(Haptic.SUCCESS) { store.fileOnGitHub(task.id, task.projectId ?: subject.id, task.title, task.notes) }
                },
            )
            "hand-off" -> handOffActions(r, HandOffTarget.task(task.id, task.title, subject), agents, handOff)
            "delete" -> listOf(WorkRowAction(r.getString(R.string.work_delete), danger = true) { confirmDelete(task.id, task.title) })
            else -> emptyList()
        }
    }
}

/** A subject's proposed task (`subject_proposed`, `proposedRowActions`): Accept or Decline. [reload] reads the list again after; [landed] feels Accept as success, Decline as destructive (`decide`). */
internal fun subjectProposedTaskMenu(r: Resources, store: WorkStore, task: CrmTaskWire, reload: () -> Unit, landed: HapticPulse? = null): List<WorkRowAction> {
    val groups = WorkRowActions.groups(WorkRowActions.Kind.TASK, "subject_proposed", mapOf("hasCore" to false))
    fun after(kind: Haptic, write: suspend () -> Unit) = store.act { write(); landed?.fire(kind); reload() }
    return build(groups) { id ->
        when (id) {
            "accept" -> listOf(WorkRowAction(r.getString(R.string.work_accept)) { after(Haptic.SUCCESS) { store.update(task.id, TaskWrites.proposalDecision(true)) } })
            "decline" -> listOf(WorkRowAction(r.getString(R.string.work_decline), danger = true) { after(Haptic.DESTRUCTIVE) { store.update(task.id, TaskWrites.proposalDecision(false)) } })
            else -> emptyList()
        }
    }
}

/** An issue row's close or reopen (`stateActions`): an open issue can be finished or decided against; a closed one can only come back. */
internal fun issueStateMenu(r: Resources, store: WorkStore, issue: CrmIssueWire, projectId: String?, after: suspend () -> Unit = {}): List<WorkRowAction> {
    val groups = WorkRowActions.groups(WorkRowActions.Kind.ISSUE, "row", mapOf("isOpen" to (issue.state == CrmIssueState.OPEN)))
        .map { group -> group.filter { it == "close-issue" || it == "close-not-planned" || it == "reopen-issue" } }
        .filter { it.isNotEmpty() }
    return build(groups) { id ->
        when (id) {
            "close-issue" -> listOf(WorkRowAction(r.getString(R.string.work_close_issue)) { store.setIssueState(issue, IssueStateChange.CLOSE, projectId, after) })
            "close-not-planned" -> listOf(WorkRowAction(r.getString(R.string.work_close_not_planned), danger = true) { store.setIssueState(issue, IssueStateChange.CLOSE_NOT_PLANNED, projectId, after) })
            "reopen-issue" -> listOf(WorkRowAction(r.getString(R.string.work_reopen_issue)) { store.setIssueState(issue, IssueStateChange.REOPEN, projectId, after) })
            else -> emptyList()
        }
    }
}

/**
 * An UNOWNED issue (`unowned`, filtered to Assign to, the state changes and
 * Hand off, as iOS `MobileWorkView.mineRow`): Assign to the team members
 * with a GitHub login, close or reopen, then Hand off to.
 */
internal fun unownedIssueMenu(r: Resources, store: WorkStore, issue: CrmIssueWire, agents: List<PeerWire>, handOff: (HandOffRequest) -> Unit): List<WorkRowAction> {
    val people = store.assignable(r.getString(R.string.work_me), needsGithub = true)
    val groups = WorkRowActions.groups(
        WorkRowActions.Kind.ISSUE, "unowned",
        mapOf("isOpen" to (issue.state == CrmIssueState.OPEN), "canAssign" to people.isNotEmpty(), "canHandOff" to agents.isNotEmpty()),
    )
        .map { group -> group.filter { it in setOf("assign", "close-issue", "close-not-planned", "reopen-issue", "hand-off") } }
        .filter { it.isNotEmpty() }
    val target = HandOffTarget.issue(issue.id, issue.number, issue.title, null)
    return build(groups) { id ->
        when (id) {
            "assign" -> listOf(WorkRowAction(r.getString(R.string.work_assign_to), header = true)) +
                people.map { member -> WorkRowAction(member.name) { store.assignIssue(issue, member) } }
            "close-issue" -> listOf(WorkRowAction(r.getString(R.string.work_close_issue)) { store.setIssueState(issue, IssueStateChange.CLOSE, null) })
            "close-not-planned" -> listOf(WorkRowAction(r.getString(R.string.work_close_not_planned), danger = true) { store.setIssueState(issue, IssueStateChange.CLOSE_NOT_PLANNED, null) })
            "reopen-issue" -> listOf(WorkRowAction(r.getString(R.string.work_reopen_issue)) { store.setIssueState(issue, IssueStateChange.REOPEN, null) })
            "hand-off" -> handOffActions(r, target, agents, handOff)
            else -> emptyList()
        }
    }
}

/**
 * A commercial INBOX row (`inbox_commercial`): open the lead or organization,
 * then Dismiss. INBOX never draws a dismissed row, so `isDismissed` is false
 * and the registry leaves Undo dismiss out.
 */
internal fun commercialInboxMenu(r: Resources, store: WorkStore, key: String, subject: SubjectRef, openSubject: (SubjectRef) -> Unit): List<WorkRowAction> {
    val groups = WorkRowActions.groups(WorkRowActions.Kind.INBOX_COMMERCIAL, "row", mapOf("isDismissed" to false))
    return build(groups) { id ->
        when (id) {
            "open-subject" -> listOf(WorkRowAction(r.getString(R.string.work_open_named, subject.title)) { openSubject(subject) })
            "dismiss" -> listOf(WorkRowAction(r.getString(R.string.work_dismiss), danger = true) { store.dismiss(key) })
            else -> emptyList()
        }
    }
}
