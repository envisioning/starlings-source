package work.starlings.android.workspace.work

import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticPulse
import work.starlings.android.ui.HapticPulseEffect
import work.starlings.android.ui.HapticWhenSet
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Circle
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.WorkStage
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkMark
import work.starlings.android.ui.WorkMeta
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkRow
import work.starlings.android.ui.WorkRowMenu
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkTopBar
import work.starlings.android.ui.isRegularWidth
import work.starlings.contracts.CrmBoardResponse
import work.starlings.contracts.CrmTaskWire
import java.time.ZoneId
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.filled.Link
import work.starlings.android.workspace.docs.DocsRailState

/**
 * `MobileSubjectView` with the panes Android draws, in the shared table's
 * order (`SubjectPanes`): Overview, Partner on an organization, Talk, Board
 * on a project, Tasks, Issues once a repository is linked, Documents. It
 * opens on Overview, as iOS. On a regular width Talk stands beside
 * Overview's groups in equal halves and has no tab (`sideBySide`). The
 * title is the subject's; the pane that creates things puts its `+` in the
 * bar, and Talk puts the conversation menu there. [request] is a path's
 * `?pane=` and `?new=`: the pane it names, and the creator it asks for,
 * opened once ([onRequestTaken]).
 */
@Composable
internal fun SubjectScreen(
    store: WorkStore,
    subject: SubjectRef,
    onBack: () -> Unit,
    onOpenIssue: (work.starlings.contracts.CrmIssueWire, String?) -> Unit,
    request: WorkRoute.Subject? = null,
    onRequestTaken: () -> Unit = {},
    onOpenSubject: (SubjectRef) -> Unit = {},
    onOpenContact: (String) -> Unit = {},
    /** An issue named by `owner/repo#n` (a Talk chip), with the project it is on, if any. */
    onOpenIssueRef: (owner: String, repo: String, number: Long, projectId: String?) -> Unit = { _, _, _, _ -> },
    /** The page now shows another subject in place: the survivor of a merge, or a rename. */
    onReplaceSubject: (SubjectRef) -> Unit = {},
    onOpenTask: (CrmTaskWire, SubjectRef) -> Unit,
) {
    val c = Starlings.colors
    var pane by rememberSaveable(subject.id) { mutableStateOf(SubjectPane.OVERVIEW) }
    var newTask by remember { mutableStateOf<TaskDraft?>(null) }
    var newIssue by remember { mutableStateOf(false) }
    var documentsSheet by remember { mutableStateOf<DocumentsSheet?>(null) }
    /** A document opened from Documents: (id, title). */
    var reading by remember(subject.id) { mutableStateOf<Pair<String, String>?>(null) }
    val tasks = remember(subject.id) { SubjectTasksState(store, subject) }
    // Owned here, not by the pane, so the tab reads "Issues (n)" before it is opened.
    val issues = remember(subject.id) { if (subject.isProject) SubjectIssuesState(store, subject.id) else null }
    val docsRail = remember(store) { DocsRailState(store.docs) }
    val overview = remember(subject.id) { SubjectOverviewState(store, subject) }
    // Owned here, not by the pane, so the tab reads "History (n)" and Overview lists the same rows.
    val history = remember(subject.id) { SubjectHistoryState(store, subject) }
    var logging by remember(subject.id) { mutableStateOf<InteractionDraft?>(null) }
    var readingInteraction by remember(subject.id) { mutableStateOf<work.starlings.contracts.CrmInteraction?>(null) }
    /** Where a new or edited interaction names the subject's organization (`CrmInteractionDraft(subject:)`). */
    val organization = overview.detail?.let { d -> d.organizationId?.takeIf { it.isNotEmpty() }?.let { Relation(it, d.organizationName ?: it) } }
    // Talk: the subject's channel, find-or-created by the Worker (`MobileThreadView(address: .subject)`).
    val team = work.starlings.android.workspace.team.LocalTeamStore.current
    val talkAddress = remember(subject.id) { work.starlings.android.workspace.team.ThreadAddress.subject(subject.kind, subject.id, subject.title) }
    val talk = remember(subject.id) { work.starlings.android.workspace.team.ThreadStore(store.owner) }
    val scope = rememberCoroutineScope()
    // A Board card's last line: Talk lands on it.
    var talkFocus by remember(subject.id) { mutableStateOf<work.starlings.android.workspace.team.ThreadFocus?>(null) }
    // `refSubject` and `onShowOverview`: a task chip opens its reader, an issue its door, a decision or goal Overview.
    val talkDoors = remember(subject.id) {
        work.starlings.android.workspace.team.ThreadRefDoors(
            openTask = { id ->
                scope.launch {
                    try {
                        onOpenTask(store.client.call(WorkRoutes.task(id)).task, subject)
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        talk.errorMessage = e.workMessage()
                    }
                }
            },
            openIssue = { owner, repo, number -> onOpenIssueRef(owner, repo, number, subject.id.takeIf { subject.isProject }) },
            showOverview = { pane = SubjectPane.OVERVIEW },
        )
    }
    // The channel's forwarding address, for Overview's Email block, once Talk has loaded.
    var inboundAddress by rememberSaveable(subject.id) { mutableStateOf<String?>(null) }
    val boardFilter = remember(subject.id) { BoardFilter() }
    val r = LocalContext.current.resources
    // A path's pane and creator (Search's subject verbs): taken once.
    LaunchedEffect(request) {
        val asked = request ?: return@LaunchedEffect
        SubjectPanes.requested(asked.pane, asked.create)?.let { pane = it }
        when (asked.create) {
            "task" -> newTask = TaskDraft(id = null)
            "issue" -> if (subject.isProject) newIssue = true
            "document" -> documentsSheet = DocumentsSheet.NEW
        }
        onRequestTaken()
    }

    var goals by remember { mutableStateOf<List<work.starlings.contracts.CrmGoal>>(emptyList()) }
    LaunchedEffect(subject.id) {
        launch { issues?.load() }
        // An event has no history (docs/EVENTS.md).
        if (subject.kind != work.starlings.contracts.CrmSubjectKind.EVENT) launch { history.loadCount() }
        tasks.load()
        store.loadTeam()
        // Goals for the editor's picker. A failure hides the row.
        if (subject.isProject) goals = store.goals(subject.id)
    }

    // A regular width takes Talk's tab away: Talk is half of Overview there (`sideBySide`, ui/SizeClass.kt).
    val narrow = !isRegularWidth() || team == null
    val tabs = SubjectPanes.shown(subject.kind, hasRepo = issues?.linked == true, hasDocs = true, narrow = narrow)
        .filter { it != SubjectPane.TALK || team != null }
    val shown = SubjectPanes.showing(pane, tabs, narrow, subject.isProject)

    readingInteraction?.let { interaction ->
        InteractionReader(store, history, interaction, organization) { readingInteraction = null }
        return
    }

    val open = reading
    if (open != null) {
        BackHandler { reading = null }
        Column(Modifier.fillMaxSize().background(c.canvas)) {
            WorkTopBar(open.second, stringResource(R.string.work_back), { reading = null })
            SubjectDocumentReader(store, docsRail, open.first)
        }
        return
    }

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(subject.title, stringResource(R.string.work_back), onBack) {
            when (shown) {
                SubjectPane.TASKS -> {
                    TaskFilterButton(tasks.due, tasks.side, { tasks.due = it }, { tasks.side = it })
                    WorkIconButton(Icons.Filled.Add, stringResource(R.string.work_new_task), { newTask = TaskDraft(id = null) }, tint = c.accent)
                }
                // History's one write, filled like Tasks' `+`; an event has no History.
                SubjectPane.INTERACTIONS -> if (subject.kind != work.starlings.contracts.CrmSubjectKind.EVENT) {
                    WorkIconButton(Icons.Filled.Add, stringResource(R.string.work_log), { logging = InteractionDraft.new(subject, organization) }, tint = c.accent)
                }
                SubjectPane.BOARD -> BoardFilterButton(store, boardFilter)
                SubjectPane.ISSUES -> if (issues?.linked == true) {
                    WorkIconButton(Icons.Filled.Add, stringResource(R.string.work_new_issue), { newIssue = true }, tint = c.accent)
                }
                SubjectPane.DOCUMENTS -> {
                    WorkIconButton(Icons.Filled.Link, stringResource(R.string.docs_save_link), { documentsSheet = DocumentsSheet.LINK })
                    WorkIconButton(Icons.Filled.Add, stringResource(R.string.docs_new_document), { documentsSheet = DocumentsSheet.NEW }, tint = c.accent)
                }
                // The conversation's own menu, wherever Talk is on screen.
                SubjectPane.TALK -> team?.let { work.starlings.android.workspace.team.ThreadOptionsButton(talkAddress, talk, it) }
                SubjectPane.OVERVIEW -> if (!narrow) team?.let { work.starlings.android.workspace.team.ThreadOptionsButton(talkAddress, talk, it) }
                else -> Unit
            }
        }
        SubjectPlanNotice(store, subject)
        if (tabs.size > 1) {
            Segmented(tabs.map { it to paneLabel(r, it, tasks.open.size, issues?.issues?.size ?: 0, history.interactions.size) }, shown) { pane = it }
        }
        val talkPane: @Composable (Modifier) -> Unit = { modifier ->
            team?.let { roster ->
                Box(modifier) {
                    work.starlings.android.workspace.team.SubjectTalk(
                        talkAddress, store.owner, roster, talk, { inboundAddress = it },
                        doors = talkDoors, focus = talkFocus, onFocusTaken = { talkFocus = null },
                    )
                }
            }
        }
        val overviewPane: @Composable (Modifier) -> Unit = { modifier ->
            SubjectOverviewPane(
                store, overview, tasks, issues, history, inboundAddress,
                onOpenPane = { pane = it },
                onNew = { asked ->
                    when (asked) {
                        SubjectPane.TASKS -> newTask = TaskDraft(id = null)
                        SubjectPane.ISSUES -> newIssue = true
                        else -> Unit
                    }
                    pane = asked
                },
                onOpenTask = { onOpenTask(it, subject) },
                // `onOpenSubject`: the page holds the other subject, on its Overview.
                onOpenSubject = onReplaceSubject,
                onOpenContact = onOpenContact,
                modifier = modifier,
            )
        }
        when (shown) {
            // On a regular width Talk and the groups share the page in equal halves, each scrolling on its own.
            SubjectPane.OVERVIEW -> if (narrow) {
                overviewPane(Modifier.fillMaxSize())
            } else {
                Row(Modifier.fillMaxSize()) {
                    talkPane(Modifier.weight(1f).fillMaxHeight())
                    androidx.compose.material3.VerticalDivider(color = c.border)
                    overviewPane(Modifier.weight(1f).fillMaxHeight())
                }
            }
            SubjectPane.TALK -> talkPane(Modifier.fillMaxSize())
            SubjectPane.BOARD -> ProjectBoardPane(
                store, subject, { onOpenTask(it, subject) }, boardFilter,
                // Talk lands on the card's last line.
                onOpenTrace = { trace ->
                    talkFocus = work.starlings.android.workspace.team.ThreadFocus(trace.threadId, trace.messageId)
                    pane = SubjectPane.TALK
                },
            ) { onOpenIssue(it, subject.id) }
            SubjectPane.ISSUES -> issues?.let { state -> SubjectIssuesPane(store, state, subject) { onOpenIssue(it, subject.id) } }
            SubjectPane.DOCUMENTS -> SubjectDocumentsPane(store, docsRail, subject, documentsSheet, { documentsSheet = it }) { id, title -> reading = id to title }
            SubjectPane.INTERACTIONS -> SubjectHistoryPane(history) { readingInteraction = it }
            SubjectPane.FIELDS -> SubjectFieldsPane(store, subject) { saved -> if (saved.title != subject.title) onReplaceSubject(subject.copy(title = saved.title)) }
            SubjectPane.EVENT -> SubjectEventPane(store, subject, onOpenSubject)
            SubjectPane.PARTNER -> PartnerPane(store, subject, onOpenSubject, onOpenContact, onReplace = onReplaceSubject, onGone = onBack)
            else -> SubjectTasksPane(store, tasks, subject) { onOpenTask(it, subject) }
        }
    }

    newTask?.let { draft ->
        TaskEditor(
            initial = draft,
            team = store.team,
            teamError = store.teamError,
            whereText = WorkFormat.where(r, null, subject, null),
            selfEmail = store.selfEmail,
            onDismiss = { newTask = null },
            goals = goals,
        ) { saved ->
            newTask = null
            scope.launch { tasks.create(saved) }
        }
    }
    logging?.let { draft ->
        InteractionEditorSheet(store, history, draft, onDismiss = { logging = null }) { logging = null }
    }
    if (newIssue) {
        NewIssueSheet(store, subject, onDismiss = { newIssue = false }) {
            newIssue = false
            // Filing changes what you owe: Mine and Home hear of it as well.
            scope.launch { issues?.load(); store.refreshMine() }
        }
    }
}

/** A tab's title: Tasks and Issues say how much is behind them (`label(for:)`). */
private fun paneLabel(r: android.content.res.Resources, pane: SubjectPane, openTasks: Int, issues: Int, interactions: Int): String {
    fun counted(title: Int, count: Int) = if (count > 0) r.getString(R.string.work_counted, r.getString(title), count) else r.getString(title)
    return when (pane) {
        SubjectPane.TASKS -> counted(R.string.work_tasks, openTasks)
        SubjectPane.ISSUES -> counted(R.string.work_issues, issues)
        SubjectPane.BOARD -> r.getString(R.string.work_board)
        SubjectPane.DOCUMENTS -> r.getString(R.string.work_documents)
        SubjectPane.PARTNER -> r.getString(R.string.work_partner)
        SubjectPane.OVERVIEW -> r.getString(R.string.work_overview)
        SubjectPane.TALK -> r.getString(R.string.work_talk)
        SubjectPane.INTERACTIONS -> counted(R.string.work_history, interactions)
        SubjectPane.FIELDS -> r.getString(R.string.work_fields)
        SubjectPane.EVENT -> r.getString(R.string.work_kind_event)
    }
}

/** The pane switch (`Picker("View").pickerStyle(.segmented)`). */
@Composable
internal fun <T> Segmented(options: List<Pair<T, String>>, selected: T, padded: Boolean = true, onPick: (T) -> Unit) {
    val c = Starlings.colors
    val shape = RoundedCornerShape(StarlingsRadius.field)
    Row(
        Modifier.fillMaxWidth().then(if (padded) Modifier.padding(horizontal = 16.dp, vertical = 8.dp) else Modifier).background(c.field, shape).border(1.dp, c.border, shape).padding(2.dp),
    ) {
        options.forEach { (option, title) ->
            val on = option == selected
            Box(
                Modifier
                    .weight(1f)
                    .background(if (on) c.elevated else c.field, RoundedCornerShape(StarlingsRadius.field - 2.dp))
                    .clickable(role = Role.Tab) { onPick(option) }
                    .clearAndSetSemantics { contentDescription = title; role = Role.Tab; this.selected = on }
                    .padding(vertical = 7.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(title, style = StarlingsType.subheadline.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal), color = c.primary)
            }
        }
    }
}

/** `MobileSubjectTasksView`'s state: the subject's tasks, the rows ticked off here, and its writes. */
internal class SubjectTasksState(private val store: WorkStore, private val subject: SubjectRef) {
    private val client = store.client
    private val route = WorkRoutes.tasks(
        projectId = subject.id.takeIf { subject.isProject },
        leadId = subject.id.takeIf { subject.kind == work.starlings.contracts.CrmSubjectKind.LEAD },
        eventId = subject.id.takeIf { subject.kind == work.starlings.contracts.CrmSubjectKind.EVENT },
        organizationId = subject.id.takeIf { subject.isPartner },
    )
    var tasks by mutableStateOf<List<CrmTaskWire>>(emptyList()); private set
    var isLoading by mutableStateOf(false); private set
    var errorMessage by mutableStateOf<String?>(null)
    var refreshError by mutableStateOf<String?>(null); private set
    /** A write that landed, felt by the pane ([HapticPulseEffect]). */
    val haptic = HapticPulse()
    private var closing by mutableStateOf<Set<String>>(emptySet())
    /** The Tasks pane's filters (`passesTaskFilter`). They last the session. */
    var due by mutableStateOf(work.starlings.android.WorkDueFilter.ANY)
    var side by mutableStateOf(work.starlings.android.WorkSideFilter.ANY)

    /** Open, not ticked off here, and through the task filters. */
    val visible: List<CrmTaskWire> get() = tasks.filter {
        !TaskStatus.of(it.status).isFinished && it.id !in closing &&
            work.starlings.android.WorkItems.passesTaskFilter(BoardItem.Task(it, TaskDates.parse(it.dueDate), null), due, side, System.currentTimeMillis(), ZoneId.systemDefault())
    }
    val proposed: List<CrmTaskWire> get() = visible.filter { TaskStatus.of(it.status).isProposed }
    val open: List<CrmTaskWire> get() = visible.filter { !TaskStatus.of(it.status).isProposed }

    /** Last known first (docs/CACHING.md), then Core. */
    suspend fun load() {
        if (tasks.isEmpty()) client.snapshot(route)?.let { tasks = it.value.tasks }
        isLoading = visible.isEmpty()
        try {
            tasks = client.call(route).tasks
            refreshError = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            refreshError = e.workMessage()
        } finally {
            isLoading = false
        }
    }

    /** Done from the row: the one edit worth a single tap. The row leaves at once and comes back on a refusal. */
    suspend fun close(task: CrmTaskWire) {
        if (task.id in closing) return
        closing = closing + task.id
        try {
            store.update(task.id, TaskWrites.completion(true))
            errorMessage = null
            haptic.fire(Haptic.SUCCESS)
            load()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            errorMessage = e.workMessage()
        } finally {
            closing = closing - task.id
        }
    }

    suspend fun decide(task: CrmTaskWire, accepted: Boolean) {
        try {
            val updated = store.update(task.id, TaskWrites.proposalDecision(accepted))
            tasks = if (accepted) tasks.map { if (it.id == task.id) updated else it } else tasks.filter { it.id != task.id }
            errorMessage = null
            haptic.fire(if (accepted) Haptic.SUCCESS else Haptic.DESTRUCTIVE)
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            errorMessage = e.workMessage()
        }
    }

    /** A new task is filed on this subject: Core needs a project, lead, event or organization. */
    suspend fun create(draft: TaskDraft) {
        if (!draft.canSave) return
        try {
            client.call(WorkRoutes.createTask(draft.create(subject, ZoneId.systemDefault())))
            errorMessage = null
            load()
            store.refreshMine()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            errorMessage = e.workMessage()
        }
    }
}

@Composable
private fun SubjectTasksPane(store: WorkStore, state: SubjectTasksState, subject: SubjectRef, onOpen: (CrmTaskWire) -> Unit) {
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    val now = System.currentTimeMillis()
    var deleting by remember { mutableStateOf<Pair<String, String>?>(null) }
    deleting?.let { (id, title) ->
        TaskDeleteDialog(title, onDismiss = { deleting = null }) {
            deleting = null
            store.act { store.delete(id); state.haptic.fire(Haptic.DESTRUCTIVE); state.load() }
        }
    }
    // The agents a task row can be handed to.
    val agents = work.starlings.android.workspace.team.LocalTeamStore.current?.roster?.agents.orEmpty()
    var handingOff by remember { mutableStateOf<HandOffRequest?>(null) }
    HandOffHost(store, handingOff, agents, onDismiss = { handingOff = null }) { _, failure -> state.errorMessage = failure }
    HapticPulseEffect(state.haptic)
    HapticWhenSet(Haptic.ERROR, state.errorMessage)
    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        val notice = state.errorMessage ?: state.refreshError
        if (notice != null) {
            item {
                WorkSection { WorkErrorNotice(notice, retry = r.getString(R.string.work_retry), onRetry = { scope.launch { state.load() } }) }
            }
        }
        // Proposals first, apart from the open list: questions Core is asking.
        val proposed = state.proposed
        if (proposed.isNotEmpty()) {
            item {
                WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_proposed)) }, footer = r.getString(R.string.work_proposed_footer)) {
                    proposed.forEachIndexed { index, task ->
                        if (index > 0) WorkDivider()
                        ProposedTaskRow(
                            task,
                            onAccept = { scope.launch { state.decide(task, true) } },
                            onDecline = { scope.launch { state.decide(task, false) } },
                        )
                    }
                }
            }
        }
        item {
            val open = state.open
            val header = if (state.visible.isEmpty()) r.getString(R.string.work_tasks) else r.getString(R.string.work_n_open, state.visible.size)
            WorkSection(header = { WorkHeaderTitle(header) }) {
                open.forEachIndexed { index, task ->
                    if (index > 0) WorkDivider()
                    // `MobileFavoriteAction` after the row's own actions, as iOS.
                    val star = work.starlings.android.workspace.favoriteRowAction(work.starlings.android.workspace.FavoriteTargets.task(task.id))
                    val menu = subjectTaskMenu(r, store, task, subject, reload = { scope.launch { state.load() } }, agents = agents, handOff = { handingOff = it }, landed = state.haptic) { id, title -> deleting = id to title } + listOfNotNull(star)
                    WorkRowMenu(menu) { long ->
                        SubjectTaskRow(task, now, onOpen = { onOpen(task) }, onComplete = { scope.launch { state.close(task) } }, onLongClick = long)
                    }
                }
                if (state.visible.isEmpty() && state.isLoading) WorkPlaceholderRows()
                if (state.visible.isEmpty() && !state.isLoading) WorkNote(r.getString(R.string.work_no_open_tasks_for, subject.title))
            }
        }
        item { Spacer(Modifier.padding(bottom = 24.dp)) }
    }
}

/** `TaskRow`: the completion circle, the title, then due, status, who owes it, and the issue number. */
@Composable
private fun SubjectTaskRow(task: CrmTaskWire, now: Long, onOpen: () -> Unit, onComplete: () -> Unit, onLongClick: (() -> Unit)? = null) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    WorkRow(
        task.title,
        onClick = onOpen,
        onLongClick = onLongClick,
        leading = {
            Box(
                Modifier
                    .size(24.dp)
                    .clickable(role = Role.Button, onClick = onComplete)
                    .clearAndSetSemantics { contentDescription = r.getString(R.string.work_complete_task, task.title); role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.Circle, null, Modifier.size(18.dp), tint = c.secondary)
            }
        },
    ) {
        TaskDates.parse(task.dueDate)?.let { WorkMeta(WorkFormat.day(it), strong = TaskDates.isOverdue(task.dueDate, now)); WorkMeta("·") }
        WorkMeta(WorkFormat.status(r, TaskStatus.of(task.status)))
        WorkMeta("·")
        WorkMeta(task.assigneeName ?: WorkFormat.side(r, TaskSide.of(task.responsibleParty)))
        task.githubIssueNumber?.let { WorkMeta("·"); WorkMeta("#$it") }
    }
}

/** `ProposedTaskRow`: the PROPOSED capsule and title, notes, the due day, Decline and Accept. */
@Composable
private fun ProposedTaskRow(task: CrmTaskWire, onAccept: () -> Unit, onDecline: () -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                r.getString(R.string.work_proposed_badge),
                Modifier.background(c.accent.copy(alpha = 0.18f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
                style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold),
                color = c.primary,
            )
            Text(task.title, style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary)
        }
        task.notes?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 3) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            TaskDates.parse(task.dueDate)?.let { Text(r.getString(R.string.work_due_on, WorkFormat.day(it)), style = StarlingsType.caption, color = c.secondary) }
            Spacer(Modifier.weight(1f))
            BorderedButton(r.getString(R.string.work_decline), onDecline, compact = true)
            FilledButton(r.getString(R.string.work_accept), onAccept, compact = true)
        }
    }
}
