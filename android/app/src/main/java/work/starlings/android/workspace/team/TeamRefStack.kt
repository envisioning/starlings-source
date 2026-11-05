package work.starlings.android.workspace.team

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import kotlinx.coroutines.CancellationException
import work.starlings.android.R
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkTopBar
import work.starlings.android.workspace.work.IssueDoor
import work.starlings.android.workspace.work.IssueScreen
import work.starlings.android.workspace.work.SubjectRef
import work.starlings.android.workspace.work.SubjectScreen
import work.starlings.android.workspace.work.TaskScreen
import work.starlings.android.workspace.work.TaskSource
import work.starlings.android.workspace.work.WorkStore
import work.starlings.android.workspace.work.workMessage
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmTaskWire

/**
 * What a Team conversation pushes over itself from an event line's chip, as
 * iOS pushes in Team's own stack: a task (`MobileTaskDoor` with no subject),
 * an issue (`MobileIssueDoor`), and what those pages open in turn.
 */
sealed interface TeamRefPage {
    data class TaskRef(val id: String) : TeamRefPage
    data class Task(val task: CrmTaskWire, val subject: SubjectRef?) : TeamRefPage
    data class IssueRef(val owner: String, val repo: String, val number: Long) : TeamRefPage
    data class Issue(val issue: CrmIssueWire, val projectId: String?) : TeamRefPage
    data class Subject(val ref: SubjectRef) : TeamRefPage
    data class Contact(val id: String) : TeamRefPage
}

/**
 * The doors a Team conversation's chips use: a task and an issue open, as
 * iOS. A decision or a goal has no Overview outside its subject's page, so
 * those chips stay labels, as iOS (`onShowOverview` is nil there).
 */
fun teamRefDoors(stack: SnapshotStateList<TeamRefPage>) = ThreadRefDoors(
    openTask = { id -> stack.add(TeamRefPage.TaskRef(id)) },
    openIssue = { owner, repo, number -> stack.add(TeamRefPage.IssueRef(owner, repo, number)) },
    showOverview = null,
)

/** The top page of [stack], over the conversation; Back pops it. */
@Composable
fun TeamRefStack(store: WorkStore, stack: SnapshotStateList<TeamRefPage>) {
    val page = stack.lastOrNull() ?: return
    val pop: () -> Unit = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) }
    val openSubject: (SubjectRef) -> Unit = { stack.add(TeamRefPage.Subject(it)) }
    BackHandler(onBack = pop)
    when (page) {
        is TeamRefPage.TaskRef -> TaskDoor(store, page.id, pop) { task -> stack[stack.lastIndex] = TeamRefPage.Task(task, null) }
        is TeamRefPage.Task -> TaskScreen(store, remember(page) { TaskSource.Full(page.task, page.subject) }, pop, openSubject)
        is TeamRefPage.IssueRef -> IssueDoor(store, page.owner, page.repo, page.number, null, pop)
        is TeamRefPage.Issue -> IssueScreen(store, page.issue, page.projectId, pop)
        is TeamRefPage.Subject -> SubjectScreen(
            store, page.ref, pop, { issue, project -> stack.add(TeamRefPage.Issue(issue, project)) },
            onOpenSubject = openSubject,
            onOpenContact = { stack.add(TeamRefPage.Contact(it)) },
            onOpenIssueRef = { owner, repo, number, _ -> stack.add(TeamRefPage.IssueRef(owner, repo, number)) },
            onReplaceSubject = { next -> stack.indexOf(page).takeIf { it >= 0 }?.let { stack[it] = TeamRefPage.Subject(next) } },
        ) { task, ref -> stack.add(TeamRefPage.Task(task, ref)) }
        is TeamRefPage.Contact -> work.starlings.android.workspace.work.ContactScreen(store, page.id, pop, openSubject)
    }
}

/** `MobileTaskDoor`: the task read by id, then its page in place of this one. */
@Composable
private fun TaskDoor(store: WorkStore, id: String, onBack: () -> Unit, onLoaded: (CrmTaskWire) -> Unit) {
    var error by remember(id) { mutableStateOf<String?>(null) }
    LaunchedEffect(id) {
        try {
            onLoaded(store.client.call(WorkRoutes.task(id)).task)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        }
    }
    Column(Modifier.fillMaxSize().background(Starlings.colors.canvas)) {
        WorkTopBar(stringResource(R.string.work_task), stringResource(R.string.work_back), onBack)
        WorkSection { error?.let { WorkErrorNotice(it) } ?: WorkPlaceholderRows() }
    }
}
