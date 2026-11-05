package work.starlings.android.workspace.work

import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticWhenSet
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.VerticalDivider
import androidx.compose.material.icons.filled.GridView
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Key
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.first
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import work.starlings.android.MineFilter
import work.starlings.android.MineOriginFilter
import work.starlings.android.MineSectionFilter
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.android.ui.WorkRowMenu
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import work.starlings.contracts.AttentionRequest
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmRecentlyClosedKind
import work.starlings.contracts.DecisionAsk
import work.starlings.contracts.InboxDecisionItem
import work.starlings.contracts.InboxQuestionItem
import work.starlings.contracts.QuickNote
import java.time.ZoneId

/** Mine's filter and folds, per device, as iOS keeps them in `WorkSidebarPreferences` and `@AppStorage`. */
internal class WorkPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("work", Context.MODE_PRIVATE)

    var mineFilter: MineFilter
        get() = MineFilter(
            MineSectionFilter.entries.firstOrNull { it.wire == prefs.getString("mine.section", null) } ?: MineSectionFilter.ALL,
            MineOriginFilter.entries.firstOrNull { it.wire == prefs.getString("mine.origin", null) } ?: MineOriginFilter.ALL,
        )
        set(value) { prefs.edit().putString("mine.section", value.section.wire).putString("mine.origin", value.origin.wire).apply() }

    /** INBOX's source filter (`WorkSidebarPreferences.inboxFilter`); a stored source this build does not know reads as all. */
    var inboxFilter: String
        get() = prefs.getString("inbox.filter", null)?.takeIf { it in WorkInbox.filterSources } ?: WorkInbox.ALL
        set(value) { prefs.edit().putString("inbox.filter", value).apply() }

    /** The Overview folds, under the shared registry's block names (`rail-blocks.ts`, `workOverview`). */
    fun folded(block: String): Boolean = prefs.getBoolean("fold.workOverview.$block", false)
    fun setFolded(block: String, folded: Boolean) { prefs.edit().putBoolean("fold.workOverview.$block", folded).apply() }
}

/**
 * Work on a regular width (`MobileWorkView.splitView`): [selectedSubject] is
 * the rail row the detail column shows, [onOverview] the rail's Overview
 * row, and [detail] the page pushed over Overview, or null for Overview's
 * columns.
 */
internal class WorkSplit(
    val selectedSubject: String?,
    val onOverview: () -> Unit,
    val detail: (@Composable () -> Unit)?,
)

/** The rail's width (`navigationSplitViewColumnWidth(ideal: 300)`). */
private val RAIL_WIDTH = 300.dp

/**
 * The phone's one Work list (`MobileWorkView.list`): the notice, the empty
 * line, MINE, UNOWNED, then SUBJECTS with Browse… at its foot. Three
 * separate sections, never one merged list.
 */
@Composable
internal fun WorkOverview(
    store: WorkStore,
    query: String,
    onQuery: (String) -> Unit,
    railOrder: List<String>,
    onRailOrder: (List<String>) -> Unit,
    route: WorkRoute.Overview?,
    onRouteTaken: () -> Unit,
    onOpenTask: (String) -> Unit,
    onOpenIssue: (CrmIssueWire) -> Unit,
    onOpenSubject: (CrmSubjectWire) -> Unit,
    /** A subject at a pane, with an editor up when [create] says so: a row menu's Open tasks, New issue… */
    onOpenSubjectAt: (SubjectRef, SubjectPane?, create: String?) -> Unit,
    onBrowse: () -> Unit,
    doors: InboxDoors,
    keep: KeepDoors? = null,
    split: WorkSplit? = null,
) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val prefs = remember { WorkPrefs(context) }
    var mineFilter by remember { mutableStateOf(prefs.mineFilter) }
    var mineFolded by rememberSaveable { mutableStateOf(prefs.folded("mine")) }
    var unownedFolded by rememberSaveable { mutableStateOf(prefs.folded("unowned")) }
    var activityFolded by rememberSaveable { mutableStateOf(prefs.folded("activity")) }
    // UNOWNED's Type and hidden subjects, kept on this device as iOS does.
    val unownedPrefs = remember { UnownedPrefs(context) }
    var unownedOrigin by remember { mutableStateOf(unownedPrefs.origin) }
    var unownedHidden by remember { mutableStateOf(unownedPrefs.hidden) }
    var askingLogin by remember { mutableStateOf(false) }
    var inboxFolded by rememberSaveable { mutableStateOf(prefs.folded("inbox")) }
    var inboxFilter by remember { mutableStateOf(prefs.inboxFilter) }
    var openDecision by remember { mutableStateOf<DecisionAsk?>(null) }
    var openQuestion by remember { mutableStateOf<AttentionRequest?>(null) }
    var openFollowUp by remember { mutableStateOf<work.starlings.contracts.InboxFollowUpItem?>(null) }
    // The subject editor (Start a lead, New project…, New lead…, Edit details), Rename, Win and Link repository.
    val sheets = remember { SubjectSheets() }
    val inboxDoors = remember(doors) {
        InboxDoors(doors.openSubject, doors.openIssue, openFollowUp = { openFollowUp = it }, startLead = {
            sheets.editing = SubjectEditorTarget(CrmSubjectKind.LEAD, prefill = LeadPrefill.of(it.touch))
        })
    }
    val subjectDoors = sheets.doors(open = { subject, pane, create -> onOpenSubjectAt(SubjectRef.of(subject), pane, create) }, keep = keep, core = rememberCoreDoors())
    // MINE on Recently finished: a choice in its Due menu, this screen only.
    var mineShowsFinished by rememberSaveable { mutableStateOf(false) }
    var notesFolded by rememberSaveable { mutableStateOf(prefs.folded("quickNotes")) }
    var filingNote by remember { mutableStateOf<QuickNote?>(null) }
    var capturing by rememberSaveable { mutableStateOf(false) }
    var addMenu by remember { mutableStateOf(false) }
    // A row's Delete, while the question is up.
    var deleting by remember { mutableStateOf<Pair<String, String>?>(null) }
    HapticWhenSet(Haptic.ERROR, store.errorMessage)
    val fileLabel = stringResource(R.string.work_file_on_github)
    // A row's "Hand off to …" waiting for its brief; the roster's agents take it.
    var handingOff by remember { mutableStateOf<HandOffRequest?>(null) }
    val agents = work.starlings.android.workspace.team.LocalTeamStore.current?.roster?.agents.orEmpty()
    val menuDoors = TaskMenuDoors(
        openSubject = { doors.openSubject(it) },
        openTask = onOpenTask,
        confirmDelete = { id, title -> deleting = id to title },
        agents = agents,
        handOff = { handingOff = it },
    )
    HandOffHost(store, handingOff, agents, onDismiss = { handingOff = null }) { _, failure -> store.errorMessage = failure }
    // UNOWNED's Assign to names the team.
    LaunchedEffect(store) { store.loadTeam() }
    // `/work?decision=<id>` and `?question=<id>`: opened once INBOX holds the row.
    var wantedDecision by rememberSaveable { mutableStateOf<String?>(null) }
    var wantedQuestion by rememberSaveable { mutableStateOf<String?>(null) }
    var wantedFollowUp by rememberSaveable { mutableStateOf<String?>(null) }
    val now = System.currentTimeMillis()
    val zone = ZoneId.systemDefault()
    val wanted = query.trim()
    val allPlan = store.minePlan(query, now)
    val plan = allPlan.filtered(mineFilter, now, zone)
    val unownedPlan = store.unownedPlan(query, now)
    val unownedShown = UnownedSubjects.shown(unownedPlan, unownedHidden, store.unownedIssueSubjects)
        .filtered(MineFilter(MineSectionFilter.ALL, unownedOrigin), now, zone)
    val foldedLabel = stringResource(R.string.work_folded)
    val openLabel = stringResource(R.string.work_open)
    val doneLabel = stringResource(R.string.work_done)
    val listState = rememberLazyListState()
    // A regular width's rail, and Overview's MINE column.
    val railState = rememberLazyListState()
    val rightState = rememberLazyListState()
    // Where each section sits in the list, filled as the list is laid out, for a route's focus.
    val sectionIndex = remember { mutableMapOf<String, Int>() }

    LaunchedEffect(route) {
        val wanted = route ?: return@LaunchedEffect
        wanted.decisionId?.let { wantedDecision = it }
        wanted.questionId?.let { wantedQuestion = it }
        wanted.followUpId?.let { wantedFollowUp = it }
        if (wanted.focus == WorkRoute.Focus.INBOX) { inboxFolded = false; prefs.setFolded("inbox", false) }
        snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it > 0 }
        val key = if (wanted.focus == WorkRoute.Focus.MINE) "mine" else "inbox"
        if (wanted.focus == WorkRoute.Focus.MINE) { mineFolded = false; prefs.setFolded("mine", false) }
        (if (split != null && key == "mine") rightState else listState).animateScrollToItem(sectionIndex[key] ?: 0)
        onRouteTaken()
    }

    val inboxItems = store.inbox?.items
    LaunchedEffect(inboxItems, wantedDecision, wantedQuestion, wantedFollowUp) {
        val items = inboxItems ?: return@LaunchedEffect
        wantedDecision?.let { id ->
            items.filterIsInstance<InboxDecisionItem>().firstOrNull { it.ask.id == id }?.let { openDecision = it.ask }
            wantedDecision = null
        }
        wantedQuestion?.let { id ->
            items.filterIsInstance<InboxQuestionItem>().firstOrNull { it.request.id == id }?.let { openQuestion = it.request }
            wantedQuestion = null
        }
        // `?followup=<meeting id>`, as Home's link writes it.
        wantedFollowUp?.let { id ->
            items.filterIsInstance<work.starlings.contracts.InboxFollowUpItem>().firstOrNull { it.meeting.id == id || it.key == id }?.let { openFollowUp = it }
            wantedFollowUp = null
        }
    }
    openFollowUp?.let { item -> FollowUpSheet(store, item) { openFollowUp = null } }
    // A new subject, or a won lead's project, opens at Talk once it is saved.
    SubjectSheetsHost(store, sheets, onCreated = { onOpenSubjectAt(it, SubjectPane.TALK, null) }) { store.errorMessage = it }

    openDecision?.let { ask ->
        DecisionSheet(ask, onDismiss = { openDecision = null }) { option, note ->
            store.inbox?.items?.filterIsInstance<InboxDecisionItem>()?.firstOrNull { it.ask.id == ask.id }?.let { store.answerDecision(it, option, note) }
        }
    }
    openQuestion?.let { request -> QuestionSheet(store, request) { openQuestion = null } }
    deleting?.let { (id, title) ->
        TaskDeleteDialog(title, onDismiss = { deleting = null }) {
            deleting = null
            store.act(Haptic.DESTRUCTIVE) { store.delete(id) }
        }
    }
    filingNote?.let { note -> QuickNoteTriageSheet(store, note) { filingNote = null } }
    if (capturing) NewQuickNoteDialog({ capturing = false }) { store.createNote(it) }
    if (askingLogin) GithubLoginDialog({ askingLogin = false }) { login -> store.act { store.setGithubLogin(login) } }

    // Each block once; the phone stacks them in one list, a regular width splits them (`splitView`).
    val headerBlock: @Composable () -> Unit = {
        Column(Modifier.padding(horizontal = 16.dp).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.work_title), Modifier.weight(1f), style = StarlingsType.largeTitle, color = c.primary)
                // `MobileSurfaceMenu`'s option: Keep, only where the workspace has it.
                if (keep != null) {
                    Box {
                        var surfaceMenu by remember { mutableStateOf(false) }
                        WorkIconButton(Icons.Filled.MoreHoriz, stringResource(R.string.more), { surfaceMenu = true })
                        DropdownMenu(surfaceMenu, { surfaceMenu = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.keep_menu), style = StarlingsType.body, color = c.primary) },
                                leadingIcon = { Icon(Icons.Filled.Key, null, tint = c.secondary) },
                                onClick = { surfaceMenu = false; keep.open() },
                            )
                        }
                    }
                }
                // `MobileSurfaceAddMenu`: what Work can add on the phone.
                Box {
                    WorkIconButton(Icons.Filled.Add, stringResource(R.string.work_add_menu), { addMenu = true }, tint = c.accent)
                    DropdownMenu(addMenu, { addMenu = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.work_new_project_menu), style = StarlingsType.body, color = c.primary) },
                            onClick = { addMenu = false; sheets.editing = SubjectEditorTarget(CrmSubjectKind.PROJECT) },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.work_new_lead_menu), style = StarlingsType.body, color = c.primary) },
                            onClick = {
                                addMenu = false
                                // A lead is sales work: filing one turns Sales on.
                                if (!store.salesVisible) store.act { store.setSalesEnabled(true) }
                                sheets.editing = SubjectEditorTarget(CrmSubjectKind.LEAD)
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.work_new_quick_note_menu), style = StarlingsType.body, color = c.primary) },
                            onClick = { addMenu = false; capturing = true },
                        )
                    }
                }
            }
            Box {
                StarlingsField(query, onQuery, placeholder = stringResource(R.string.work_search), trailingInset = 28.dp)
                Icon(Icons.Filled.Search, null, Modifier.align(Alignment.CenterEnd).padding(end = 14.dp), tint = c.secondary)
            }
        }
    }

    // A failed write, a failed Mine read, or a stale subject list: one notice.
    val notice = store.errorMessage ?: store.refreshFailure ?: store.subjectsError
    val noticeBlock: (@Composable () -> Unit)? = notice?.let { message ->
        {
            WorkSection {
                WorkErrorNotice(message, retry = r.getString(R.string.work_retry), onRetry = {
                    store.errorMessage = null
                    store.start()
                })
            }
        }
    }

    val inboxEmpty = store.inbox?.let { WorkInbox.drawn(it).isEmpty() && WorkInbox.notes(it).isEmpty() } ?: true
    val emptyBlock: (@Composable () -> Unit)? =
        if (wanted.isEmpty() && inboxEmpty && store.mineAnswered && allPlan.openCount == 0 && unownedPlan.openCount == 0 && !store.isLoading) {
            {
                WorkSection {
                    WorkNote(stringResource(R.string.work_nothing_needs_you))
                    WorkDivider()
                    WorkActionRow(stringResource(R.string.work_browse_subjects), onBrowse)
                }
            }
        } else null

    // INBOX: what needs you, newest first (the Worker's order).
    val inboxBlock: @Composable () -> Unit = {
        InboxBlock(
            store, query, inboxFilter, { inboxFilter = it; prefs.inboxFilter = it },
            inboxFolded, { inboxFolded = !inboxFolded; prefs.setFolded("inbox", inboxFolded) },
            inboxDoors, { openDecision = it }, { openQuestion = it },
        )
    }

    // Quick Notes: the captures to file, directly under INBOX; absent when there are none.
    val notesBlock: (@Composable () -> Unit)? = if (store.quickNotes.isNotEmpty()) {
        { QuickNotesBlock(store, query, notesFolded, { notesFolded = !notesFolded; prefs.setFolded("quickNotes", notesFolded) }) { filingNote = it } }
    } else null

    // Activity: what happened on listed subjects this week; a row opens its History.
    val activityBlock: @Composable () -> Unit = {
        ActivityBlock(store, query, activityFolded, { activityFolded = !activityFolded; prefs.setFolded("activity", activityFolded) }) { subject ->
            onOpenSubjectAt(subject, SubjectPane.INTERACTIONS, null)
        }
    }

    // MINE: one list in the order it is owed (fixtures/work-items.json), no date headers.
    val mineBlock: @Composable () -> Unit = {
        WorkSection(
            header = {
                WorkFoldTitle(stringResource(R.string.work_mine), mineFolded, foldedLabel, openLabel) {
                    mineFolded = !mineFolded; prefs.setFolded("mine", mineFolded)
                }
                Spacer(Modifier.weight(1f))
                MineFilterMenu(store, query, mineFilter, mineShowsFinished, { mineShowsFinished = it }) { mineFilter = it; prefs.mineFilter = it }
            },
            footer = store.githubLogin?.let { r.getString(R.string.work_matched_github, it) } ?: r.getString(R.string.work_github_usernames),
        ) {
            if (!mineFolded && mineShowsFinished) {
                FinishedRows(store, mineFilter.origin)
            } else if (!mineFolded) {
                if (!store.mineAnswered && plan.openCount == 0) WorkPlaceholderRows()
                plan.order.forEachIndexed { index, item ->
                    if (index > 0) WorkDivider()
                    when (item) {
                        is MineItem.Task -> {
                            // File on GitHub on the leading swipe: only for a project, and only once.
                            val project = item.keys.projectId?.takeIf { item.task.githubIssueNumber == null }
                            val file = project?.let { p ->
                                work.starlings.android.ui.WorkRowAction(fileLabel) { store.act(Haptic.SUCCESS) { store.fileOnGitHub(item.task.id, p, item.task.title, null) } }
                            }
                            SwipeDoneRow(doneLabel, { store.complete(item.task) }, leading = file, leadingIcon = Icons.AutoMirrored.Filled.OpenInNew) {
                                WorkRowMenu(mineTaskMenu(r, store, item.task, unowned = false, menuDoors)) { long ->
                                    MineTaskRow(item, now, long) { onOpenTask(item.task.id) }
                                }
                            }
                        }
                        is MineItem.Issue -> WorkRowMenu(issueStateMenu(r, store, item.issue, null)) { long ->
                            MineIssueRow(item.issue, long) { onOpenIssue(item.issue) }
                        }
                    }
                }
                if (plan.openCount == 0 && store.mineAnswered) {
                    WorkNote(
                        stringResource(
                            if (allPlan.openCount > 0 || wanted.isNotEmpty()) R.string.work_nothing_matches else R.string.work_nothing_assigned,
                        ),
                    )
                }
            }
            // The honest reason the half is missing, and the fix, where it is noticed.
            if (!mineFolded && store.mineAnswered && store.githubLogin == null) {
                WorkActionRow(stringResource(R.string.work_set_github_username), { askingLogin = true }, accent = true)
            }
        }
    }

    // UNOWNED: open work nobody on our side holds; absent when there is none.
    val unownedFailure = store.unownedError
    val unownedBlock: (@Composable () -> Unit)? = if (unownedPlan.openCount > 0 || unownedFailure != null) {
        {
            WorkSection(
                header = {
                    WorkFoldTitle(stringResource(R.string.work_unowned), unownedFolded, foldedLabel, openLabel) {
                        unownedFolded = !unownedFolded; prefs.setFolded("unowned", unownedFolded)
                    }
                    if (unownedPlan.openCount > 0) {
                        Spacer(Modifier.weight(1f))
                        UnownedFilterMenu(
                            unownedPlan, unownedOrigin, unownedHidden, store.unownedIssueSubjects,
                            onOrigin = { unownedOrigin = it; unownedPrefs.origin = it },
                            onHidden = { unownedHidden = it; unownedPrefs.hidden = it },
                        )
                    }
                },
                footer = stringResource(R.string.work_unowned_footer),
            ) {
                if (!unownedFolded) {
                    unownedFailure?.let { WorkErrorNotice(it, retry = r.getString(R.string.work_retry), onRetry = { store.start() }) }
                    unownedShown.order.forEachIndexed { index, item ->
                        if (index > 0) WorkDivider()
                        when (item) {
                            is MineItem.Task -> WorkRowMenu(mineTaskMenu(r, store, item.task, unowned = true, menuDoors)) { long ->
                                MineTaskRow(item, now, long) { onOpenTask(item.task.id) }
                            }
                            is MineItem.Issue -> WorkRowMenu(unownedIssueMenu(r, store, item.issue, agents) { handingOff = it }) { long ->
                                MineIssueRow(item.issue, long) { onOpenIssue(item.issue) }
                            }
                        }
                    }
                    if (unownedShown.openCount == 0 && unownedPlan.openCount > 0) WorkNote(stringResource(R.string.work_nothing_matches))
                }
            }
        }
    } else null

    // SUBJECTS: one bounded wall, floated by the ranker; Browse is the directory.
    val subjectsBlock: @Composable () -> Unit = {
        val searching = wanted.isNotEmpty()
        val ordered = SubjectRail.rail(store.allSubjects, store.states, searching, emptySet(), now, holding = null, previous = railOrder)
        val ids = ordered.map { it.id }
        LaunchedEffect(ids) { if (ids != railOrder) onRailOrder(ids) }
        WorkSection(header = { WorkHeaderTitle(stringResource(R.string.work_subjects)) }) {
            if (store.isLoading && store.allSubjects.isEmpty()) WorkPlaceholderRows()
            if (ordered.isEmpty() && !store.isLoading) {
                WorkNote(stringResource(if (searching) R.string.work_nothing_matches else R.string.work_no_active_subjects))
            }
            ordered.forEach { subject ->
                SubjectRow(subject, store.states.resolved(subject), WorkFormat.subjectDetail(r, subject, now), hasUnread = false, selected = split?.selectedSubject == subject.id, menu = subjectRowMenu(r, store, subject, subjectDoors)) {
                    onOpenSubject(subject)
                }
                WorkDivider()
            }
            WorkSidebarRow(
                icon = Icons.AutoMirrored.Filled.List,
                title = stringResource(R.string.work_browse_row),
                subtitle = stringResource(R.string.work_browse_row_subtitle),
                onClick = onBrowse,
                weight = FontWeight.Normal,
                subdued = true,
                label = stringResource(R.string.work_browse_row_label),
            )
        }
    }
    val footBlock: @Composable () -> Unit = { Spacer(Modifier.padding(bottom = 24.dp)) }

    /** One list of blocks; a keyed block notes its place for a route's focus. */
    @Composable
    fun BlockList(state: androidx.compose.foundation.lazy.LazyListState, blocks: List<Pair<String?, @Composable () -> Unit>>, modifier: Modifier = Modifier) {
        LazyColumn(modifier.fillMaxSize().background(c.canvas), state = state, verticalArrangement = Arrangement.spacedBy(18.dp)) {
            blocks.forEachIndexed { index, (key, content) ->
                if (key != null) sectionIndex[key] = index
                item(key = key) { content() }
            }
        }
    }
    fun block(content: (@Composable () -> Unit)?, key: String? = null): Pair<String?, @Composable () -> Unit>? = content?.let { key to it }

    if (split == null) {
        BlockList(
            listState,
            listOfNotNull(
                block(headerBlock), block(noticeBlock), block(emptyBlock), block(inboxBlock, "inbox"), block(notesBlock, "notes"),
                block(activityBlock, "activity"), block(mineBlock, "mine"), block(unownedBlock), block(subjectsBlock), block(footBlock),
            ),
        )
        return
    }

    // The rail's first row: Overview, marked while the detail column shows it.
    val overviewRow: @Composable () -> Unit = {
        val title = stringResource(R.string.work_overview)
        WorkSection {
            WorkSidebarRow(
                icon = Icons.Filled.GridView,
                title = title,
                subtitle = "",
                onClick = split.onOverview,
                modifier = if (split.selectedSubject == null && split.detail == null) Modifier.background(c.selected) else Modifier,
                label = "$title. ${stringResource(R.string.work_overview_hint)}",
                square = true,
            )
        }
    }

    // A regular width: the Mac rail (Overview, then SUBJECTS with Browse… at its foot) beside the detail column.
    Row(Modifier.fillMaxSize().background(c.canvas)) {
        BlockList(
            railState,
            listOfNotNull(
                block(headerBlock),
                block(overviewRow),
                block(subjectsBlock), block(footBlock),
            ),
            Modifier.width(RAIL_WIDTH),
        )
        VerticalDivider(color = c.border)
        Box(Modifier.weight(1f)) {
            val detail = split.detail
            if (detail != null) {
                detail()
            } else {
                // `overviewColumns`: INBOX with Quick Notes in one column, MINE in the other, each scrolling on its own.
                Column(Modifier.fillMaxSize()) {
                    Text(
                        stringResource(R.string.work_overview),
                        Modifier.padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 8.dp),
                        style = StarlingsType.largeTitle,
                        color = c.primary,
                    )
                    Row(Modifier.fillMaxSize()) {
                        BlockList(
                            listState,
                            listOfNotNull(block(noticeBlock), block(emptyBlock), block(inboxBlock, "inbox"), block(notesBlock, "notes"), block(activityBlock, "activity"), block(footBlock)),
                            Modifier.weight(1f),
                        )
                        VerticalDivider(color = c.border)
                        BlockList(rightState, listOfNotNull(block(mineBlock, "mine"), block(unownedBlock), block(footBlock)), Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

/**
 * `mineFilterMenu`: Due then Type, each row with its count, Reset when
 * either is off its default. The icon is the accent while filtered.
 */
@Composable
private fun MineFilterMenu(
    store: WorkStore,
    query: String,
    filter: MineFilter,
    showsFinished: Boolean,
    onShowsFinished: (Boolean) -> Unit,
    onChange: (MineFilter) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    val now = System.currentTimeMillis()
    val zone = ZoneId.systemDefault()
    val counted = store.minePlan(query, now)
    Box {
        WorkIconButton(
            Icons.Filled.FilterList,
            stringResource(R.string.work_filter_mine),
            { open = true },
            tint = if (filter.isDefault && !showsFinished) c.secondary else c.accent,
        )
        DropdownMenu(open, { open = false }, containerColor = c.elevated, shape = RoundedCornerShape(14.dp)) {
            MenuHeader(r.getString(R.string.work_due))
            MineSectionFilter.entries.forEach { option ->
                val count = counted.count(MineFilter(option, filter.origin), now, zone)
                MenuChoice(r.getString(R.string.work_counted, sectionTitle(r, option), count), !showsFinished && option == filter.section) {
                    onShowsFinished(false); onChange(filter.copy(section = option)); open = false
                }
            }
            // Recently finished: the open list gives way to it.
            MenuChoice(r.getString(R.string.work_recently_finished_count, RecentlyFinished.shown(store.recentlyClosed, filter.origin).size), showsFinished) {
                onShowsFinished(true); open = false
            }
            HorizontalDivider(color = c.border)
            MenuHeader(r.getString(R.string.work_type))
            MineOriginFilter.entries.forEach { option ->
                val count = if (showsFinished) RecentlyFinished.shown(store.recentlyClosed, option).size else counted.count(MineFilter(filter.section, option), now, zone)
                MenuChoice(r.getString(R.string.work_counted, originTitle(r, option), count), option == filter.origin) {
                    onChange(filter.copy(origin = option)); open = false
                }
            }
            if (!filter.isDefault || showsFinished) {
                HorizontalDivider(color = c.border)
                DropdownMenuItem(
                    text = { Text(r.getString(R.string.work_reset), style = StarlingsType.body, color = c.primary) },
                    onClick = { onShowsFinished(false); onChange(MineFilter()); open = false },
                )
            }
        }
    }
}

/** `finishedRows`: newest first as the Worker sends them, each with Reopen. */
@Composable
private fun FinishedRows(store: WorkStore, origin: MineOriginFilter) {
    val c = Starlings.colors
    val r = LocalContext.current.resources
    store.recentlyClosedError?.let { WorkErrorNotice(it) }
    val items = RecentlyFinished.shown(store.recentlyClosed, origin)
    if (items.isEmpty() && store.recentlyClosedError == null) WorkNote(stringResource(R.string.work_nothing_finished))
    items.forEachIndexed { index, item ->
        if (index > 0) WorkDivider()
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (item.kind == CrmRecentlyClosedKind.TASK) Icons.Filled.CheckCircle else Icons.Filled.ErrorOutline, null, tint = c.secondary)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(item.title, style = StarlingsType.body, color = c.primary)
                Text(
                    item.subjectTitle ?: item.issue?.let { "${it.repo} #${it.number}" } ?: r.getString(R.string.work_task),
                    style = StarlingsType.footnote, color = c.secondary,
                )
            }
            Text(
                stringResource(R.string.work_reopen),
                Modifier.clickable(role = Role.Button) { store.reopen(item) }.padding(8.dp),
                style = StarlingsType.body, color = c.accent,
            )
        }
    }
}

@Composable
internal fun MenuHeader(text: String) {
    Text(text, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

@Composable
internal fun MenuChoice(text: String, selected: Boolean, onClick: () -> Unit) {
    val c = Starlings.colors
    DropdownMenuItem(
        text = { Text(text, style = StarlingsType.body, color = c.primary) },
        onClick = onClick,
        leadingIcon = { if (selected) Icon(Icons.Filled.Check, null, tint = c.primary) else Spacer(Modifier.size(24.dp)) },
    )
}

private fun sectionTitle(r: android.content.res.Resources, filter: MineSectionFilter): String = r.getString(
    when (filter) {
        MineSectionFilter.ALL -> R.string.work_filter_all_open
        MineSectionFilter.FOCUS -> R.string.work_filter_focus
        MineSectionFilter.INBOX -> R.string.work_filter_unfiled
        MineSectionFilter.LATE -> R.string.work_filter_late
        MineSectionFilter.TODAY -> R.string.work_filter_today
        MineSectionFilter.SOON -> R.string.work_filter_soon
        MineSectionFilter.UNDATED -> R.string.work_filter_undated
    },
)
