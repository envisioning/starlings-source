package work.starlings.android.workspace.work

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.WorkCard
import work.starlings.android.WorkItems
import work.starlings.android.WorkStage
import work.starlings.android.WorkStageWrite
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkMeta
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkRow
import work.starlings.android.ui.WorkRowAction
import work.starlings.android.ui.WorkRowMenu
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSwipeRow
import work.starlings.android.workspace.team.displayName
import work.starlings.contracts.CrmBoardResponse
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueUpdate
import work.starlings.contracts.CrmIssueUpdateStateReason
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmTaskStatusValue
import work.starlings.contracts.CrmTaskUpdate
import work.starlings.contracts.CrmTaskWire
import java.time.ZoneId

/** What a board card's Hand off names: the card, its issue number, and the project's channel. */
internal fun BoardMoves.handOffTarget(card: BoardItem, subject: SubjectRef): HandOffTarget = when (card) {
    is BoardItem.Task -> HandOffTarget(card.task.title, null, "task", card.task.id, subject.kind, subject.id)
    is BoardItem.Issue -> HandOffTarget(card.issue.title, card.issue.number, "issue", card.issue.id, subject.kind, subject.id)
}

/** A stage move as Core's two writes (`CrmTaskUpdate.stage`, `CrmIssueUpdate.stageMove`), from the shared `WorkItems.write`. */
object BoardMoves {
    /** The stages a card can go to from its own: every other one. */
    fun targets(from: WorkStage): List<WorkStage> = WorkStage.entries.filter { it != from }

    fun taskUpdate(write: WorkStageWrite.Task) = CrmTaskUpdate(status = CrmTaskStatusValue(write.status))

    /** The state, its reason and the whole label set, since GitHub replaces labels on PATCH. */
    fun issueUpdate(issue: CrmIssueWire, projectId: String?, write: WorkStageWrite.Issue) = CrmIssueUpdate(
        owner = issue.owner, repo = issue.repo, number = issue.number, projectId = projectId,
        state = CrmIssueState(write.state), stateReason = write.stateReason?.let(::CrmIssueUpdateStateReason), labels = write.labels,
    )
}

/**
 * `MobileProjectBoardView`: one project's tasks and issues as a
 * stage-grouped list, read down instead of across. One read, again every
 * 30 seconds while on screen; a move is the shared `WorkItems.write`.
 * DONE and DROPPED show behind Show finished. Long press moves a card or
 * deletes a task; the trailing swipe is Done. The columns the person hides
 * ([BoardColumns]) draw nothing; a note counts the cards they hold.
 */
@Composable
internal fun ProjectBoardPane(
    store: WorkStore,
    subject: SubjectRef,
    onOpenTask: (CrmTaskWire) -> Unit,
    filter: BoardFilter = remember(subject.id) { BoardFilter() },
    /** A card's last line (`CardTrace`): a door into Talk at that line. */
    onOpenTrace: ((work.starlings.contracts.CardTrace) -> Unit)? = null,
    onOpenIssue: (CrmIssueWire) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var board by remember(subject.id) { mutableStateOf<CrmBoardResponse?>(null) }
    var error by remember(subject.id) { mutableStateOf<String?>(null) }
    var showsFinished by rememberSaveable(subject.id) { mutableStateOf(false) }
    var moving by remember { mutableStateOf<Set<String>>(emptySet()) }
    var deleting by remember { mutableStateOf<Pair<String, String>?>(null) }
    // Hand off…: the card waiting for its brief, and what the send did.
    var handingOff by remember { mutableStateOf<HandOffRequest?>(null) }
    var notice by remember(subject.id) { mutableStateOf<String?>(null) }
    val agents = work.starlings.android.workspace.team.LocalTeamStore.current?.roster?.agents.orEmpty()
    HandOffHost(store, handingOff, agents, onDismiss = { handingOff = null }) { agent, failure ->
        error = failure
        notice = if (failure == null) r.getString(R.string.work_handed_off_to, agent.displayName) else null
    }

    suspend fun load() {
        try {
            board = store.client.call(WorkRoutes.board(subject.id))
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        }
    }

    // The project's own agent, for the holder filter's `agent:<email>`. A failed read leaves it unset.
    LaunchedEffect(subject.id) {
        filter.agentEmail = runCatching { store.client.call(WorkRoutes.subjectDetail(subject.kind, subject.id)).subject.agentEmail }.getOrNull()
    }

    LaunchedEffect(subject.id) {
        // An agent's move mid-run has to show without a pull; the loop ends when the board leaves the screen.
        while (true) {
            load()
            delay(30_000)
        }
    }

    fun move(card: BoardItem, to: WorkStage) {
        if (card.workId in moving) return
        moving = moving + card.workId
        scope.launch {
            try {
                when (val write = WorkItems.write(to, card)) {
                    is WorkStageWrite.Task -> store.update(card.workId, BoardMoves.taskUpdate(write))
                    is WorkStageWrite.Issue -> {
                        val issue = (card as? BoardItem.Issue)?.issue ?: return@launch
                        store.client.call(WorkExtraRoutes.updateIssue(BoardMoves.issueUpdate(issue, subject.id, write)))
                        store.refreshMine()
                    }
                }
                error = null
                load()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                moving = moving - card.workId
            }
        }
    }

    deleting?.let { (id, title) ->
        TaskDeleteDialog(title, onDismiss = { deleting = null }) {
            deleting = null
            scope.launch {
                try {
                    store.delete(id)
                    error = null
                    load()
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    error = r.getString(R.string.work_delete_failure)
                }
            }
        }
    }

    val read = board
    val traces = read?.traces.orEmpty().associateBy { "${it.refKind.value}:${it.refId}" }
    val now = System.currentTimeMillis()
    val columns = read?.let { BoardItem.board(it.tasks, it.issues, it.finishedSince, now, ZoneId.systemDefault()) }
    val offered = WorkStage.entries.filter { !it.isFinished || showsFinished }
    val hidden = store.boardHiddenStages
    fun shownCards(stage: WorkStage) = columns?.items(stage).orEmpty().filter { filter.passes(it, now, ZoneId.systemDefault()) }

    LazyColumn(Modifier.fillMaxSize().background(c.canvas), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        error?.let { message ->
            item { WorkSection { WorkErrorNotice(message, retry = r.getString(R.string.work_retry), onRetry = { scope.launch { load() } }) } }
        }
        filter.error?.let { message -> item { WorkSection { WorkErrorNotice(message) } } }
        notice?.let { message -> item { WorkSection { WorkNote(message) } } }
        if (columns == null) {
            if (error == null) item { WorkSection { WorkPlaceholderRows() } }
            return@LazyColumn
        }
        // The cards a hidden column holds are still counted, so nothing reads as gone.
        val hiddenCount = BoardColumns.hiddenCount(offered, hidden) { shownCards(it).size }
        if (hiddenCount > 0) {
            item { WorkSection { WorkNote(r.getQuantityString(R.plurals.work_cards_in_hidden_columns, hiddenCount, hiddenCount)) } }
        }
        offered.filter { it !in hidden }.forEach { stage ->
            val cards = shownCards(stage)
            item(key = stage.wire) {
                WorkSection(
                    header = {
                        WorkHeaderTitle(WorkFormat.stage(r, stage))
                        Spacer(Modifier.weight(1f))
                        if (cards.isNotEmpty()) WorkHeaderTitle("${cards.size}")
                    },
                ) {
                    if (cards.isEmpty()) WorkNote(stringResource(R.string.work_nothing_here))
                    cards.forEachIndexed { index, card ->
                        if (index > 0) WorkDivider()
                        val actions = buildList {
                            add(WorkRowAction(r.getString(R.string.work_move_to_stage), header = true))
                            BoardMoves.targets(stage).forEach { target -> add(WorkRowAction(WorkFormat.stageTitle(r, target)) { move(card, target) }) }
                            if (agents.isNotEmpty() && !stage.isFinished) {
                                add(
                                    WorkRowAction(r.getString(R.string.work_hand_off_menu), startsGroup = true) {
                                        handingOff = HandOffRequest(BoardMoves.handOffTarget(card, subject), null)
                                    },
                                )
                            }
                            (card as? BoardItem.Task)?.let { task ->
                                // A task only; an issue is GitHub's to close.
                                add(WorkRowAction(r.getString(R.string.work_delete), danger = true, startsGroup = true) { deleting = task.task.id to task.task.title })
                            }
                        }
                        val trace = traces[
                            when (card) {
                                is BoardItem.Task -> "task:${card.task.id}"
                                is BoardItem.Issue -> "issue:${card.issue.id}"
                            },
                        ]
                        val row: @Composable () -> Unit = {
                            WorkRowMenu(actions) { long ->
                                Column {
                                    BoardCardRow(card, busy = card.workId in moving, onLongClick = long) {
                                        when (card) {
                                            is BoardItem.Task -> onOpenTask(card.task)
                                            is BoardItem.Issue -> onOpenIssue(card.issue)
                                        }
                                    }
                                    // The last thing that happened: a door into Talk, at that line.
                                    if (trace != null && onOpenTrace != null) {
                                        Text(
                                            trace.text,
                                            Modifier.fillMaxWidth().clickable(role = Role.Button) { onOpenTrace(trace) }.padding(start = 42.dp, end = 16.dp, bottom = 8.dp),
                                            style = StarlingsType.caption, color = c.secondary, maxLines = 1,
                                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                        }
                        if (stage != WorkStage.DONE) {
                            WorkSwipeRow(r.getString(R.string.work_done), Icons.Filled.CheckCircle, { move(card, WorkStage.DONE) }) { row() }
                        } else {
                            row()
                        }
                    }
                }
            }
        }
        item {
            WorkSection {
                WorkActionRow(stringResource(if (showsFinished) R.string.work_hide_finished else R.string.work_show_finished), { showsFinished = !showsFinished })
            }
        }
        item { Spacer(Modifier.padding(bottom = 24.dp)) }
    }
}

/** A board row: the issue or task mark, the title on two lines, then "Task · Due 18 Sep" or "meet #147". */
@Composable
private fun BoardCardRow(card: BoardItem, busy: Boolean, onLongClick: (() -> Unit)?, onOpen: () -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val title = when (card) {
        is BoardItem.Task -> card.task.title
        is BoardItem.Issue -> card.issue.title
    }
    WorkRow(
        title,
        onClick = onOpen,
        onLongClick = onLongClick,
        leading = {
            Icon(if (card is BoardItem.Issue) Icons.Filled.RadioButtonChecked else Icons.Outlined.Circle, null, Modifier.size(18.dp), tint = c.secondary)
        },
    ) {
        WorkMeta(boardDetail(r, card))
        if (busy) {
            Spacer(Modifier.weight(1f))
            Box(Modifier.size(14.dp)) { CircularProgressIndicator(strokeWidth = 2.dp, color = c.secondary) }
        }
    }
}

/** `MobileBoardCard.detail`. */
private fun boardDetail(r: android.content.res.Resources, card: BoardItem): String = when (card) {
    is BoardItem.Task -> listOfNotNull(
        card.task.githubIssueNumber?.let { r.getString(R.string.work_board_task_number, it.toInt()) } ?: r.getString(R.string.work_task),
        card.task.assigneeName,
        card.workDueDate?.let { r.getString(R.string.work_due_on, WorkFormat.day(it)) },
    ).joinToString(" · ")
    is BoardItem.Issue -> listOfNotNull("${card.issue.repo} #${card.issue.number}", card.issue.assigneeLogin).joinToString(" · ")
}
