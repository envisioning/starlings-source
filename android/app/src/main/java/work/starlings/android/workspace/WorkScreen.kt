package work.starlings.android.workspace

import work.starlings.android.ui.HapticPulseEffect
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.platform.LocalContext
import work.starlings.android.workspace.home.HomeRecents
import work.starlings.android.workspace.home.RecentRows
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import work.starlings.android.OwnerAccount
import work.starlings.android.workspace.work.BrowseScreen
import work.starlings.android.workspace.work.ContactScreen
import work.starlings.android.workspace.work.InboxDoors
import work.starlings.android.workspace.work.IssueDoor
import work.starlings.android.workspace.work.IssueScreen
import work.starlings.contracts.CrmIssueWire
import work.starlings.android.workspace.work.MineTaskDestination
import work.starlings.android.workspace.work.SubjectRef
import work.starlings.android.workspace.work.SubjectScreen
import work.starlings.android.workspace.work.TaskScreen
import work.starlings.android.workspace.work.TaskSource
import work.starlings.android.workspace.work.WorkOverview
import work.starlings.android.workspace.work.WorkRoute
import work.starlings.android.workspace.work.WorkStore
import work.starlings.android.workspace.work.WorkPage
import work.starlings.android.workspace.work.WorkSplit
import work.starlings.android.ui.isRegularWidth
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.snapshots.SnapshotStateList
import work.starlings.contracts.CrmTaskWire

/**
 * The Work tab: `iOS/MobileWorkView.swift`. On a phone, Overview's one list
 * (INBOX, MINE, UNOWNED, SUBJECTS) at the root, and a stack for a task, a
 * subject and Browse over it. On a regular width, the rail (Overview, then
 * SUBJECTS) beside the same stack, with Overview's columns at its root.
 * Back pops the stack before it leaves the tab.
 *
 * Another tab opens Work at a web path (`WorkRoute`), as iOS
 * `app.pendingWork`: Overview without a record is a pop to the root, a
 * record replaces the stack. The stack, the search and the rail order
 * are saved, so a rotation keeps the page that was open.
 */
@Composable
fun WorkScreen(account: OwnerAccount) {
    val scope = rememberCoroutineScope()
    val store = remember(account) { WorkStore(account, scope) }
    // Here, not on one page: a row's write lands after its page may have gone.
    HapticPulseEffect(store.haptic)
    // The stack survives a rotation and a process death: each page kept as its line (`WorkPage.encode`).
    val stack = rememberSaveable(saver = WorkStackSaver) { mutableStateListOf<WorkPage>() }
    var query by rememberSaveable { mutableStateOf("") }
    var railOrder by rememberSaveable { mutableStateOf<List<String>>(emptyList()) }
    /** The Overview route last asked for, read once by the list. */
    var overviewRoute by remember { mutableStateOf<WorkRoute.Overview?>(null) }
    /** A subject path's `?pane=` and `?new=`, taken once by that subject's page. */
    var subjectRequest by remember { mutableStateOf<WorkRoute.Subject?>(null) }

    val context = LocalContext.current
    LaunchedEffect(store) {
        // The Organizations filter kept on this device (`OrganizationListFilter.saved`), before the first read.
        store.organizationFilter = work.starlings.android.workspace.work.OrganizationFilter.decoded(
            context.getSharedPreferences("work", android.content.Context.MODE_PRIVATE).getString(work.starlings.android.workspace.work.OrganizationFilter.KEY, null),
        )
        store.start()
    }
    BackHandler(enabled = stack.isNotEmpty()) { stack.removeAt(stack.lastIndex) }

    rememberWorkspaceRoute(MemberSurface.WORK) { path ->
        when (val route = WorkRoute.parse(path)) {
            null -> Unit
            is WorkRoute.Overview -> { stack.clear(); overviewRoute = route }
            WorkRoute.Browse -> { stack.clear(); stack.add(WorkPage.Browse) }
            is WorkRoute.Task -> { stack.clear(); stack.add(WorkPage.MineTask(route.id)) }
            is WorkRoute.Subject -> {
                stack.clear()
                stack.add(WorkPage.Subject(store.subjectRef(route.kind, route.id)))
                subjectRequest = route.takeIf { it.pane != null || it.create != null }
            }
            is WorkRoute.Issue -> { stack.clear(); stack.add(WorkPage.IssueRef(route.owner, route.repo, route.number)) }
            is WorkRoute.Contact -> { stack.clear(); stack.add(WorkPage.Contact(route.id)) }
            // A Core row of the search sheet: that entity's list (`pendingWork = .coreEntity`).
            is WorkRoute.CoreEntity -> { stack.clear(); stack.add(WorkPage.Core(work.starlings.android.core.ui.CoreDoor.Entity(route.id))) }
        }
    }

    val pop: () -> Unit = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) }
    // Keep, only where the workspace has it (docs/KEEP.md).
    val keep = remember { work.starlings.android.keep.KeepAccess.of(context) }
    val keepDoors = if (keep.isAvailable) {
        work.starlings.android.workspace.work.KeepDoors(
            open = { stack.add(WorkPage.Keep()) },
            openProject = { id, name -> stack.add(WorkPage.Keep(id, name)) },
        )
    } else {
        null
    }
    val openSubject: (SubjectRef) -> Unit = { stack.add(WorkPage.Subject(it)) }
    // A row menu's Open tasks, New issue…: the page, and its pane and editor taken once (`subjectRequest`).
    val openSubjectAt: (SubjectRef, work.starlings.android.workspace.work.SubjectPane?, String?) -> Unit = { subject, pane, create ->
        stack.add(WorkPage.Subject(subject))
        if (pane != null || create != null) subjectRequest = WorkRoute.Subject(subject.kind, subject.id, pane?.id, create = create)
    }
    // Other records sits at the foot of Browse, only where the workspace has it (docs/CORE_REGISTRY.md).
    val core = remember { work.starlings.android.core.CoreAccess.of(context) }
    val coreNavigation = work.starlings.android.core.ui.CoreNavigation(
        push = { stack.add(WorkPage.Core(it)) },
        back = pop,
        // A lead or a project opens on its Work page at Talk (`app.openWork(subject:pane: .talk)`).
        openWorkSubject = { kind, id, title ->
            openSubjectAt(SubjectRef(work.starlings.contracts.CrmSubjectKind.of(kind), id, title), work.starlings.android.workspace.work.SubjectPane.TALK, null)
        },
    )

    // A subject opened by path names no title until Core answers.
    val top = stack.lastOrNull()

    // A subject pushed, whichever door it came through, goes into the device's recents (Home's
    // Quick Access); a pop leaves nothing. One opened by path waits for its title.
    var depth by remember { mutableIntStateOf(stack.size) }
    var untitled by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(stack.size, top) {
        val pushed = stack.size > depth
        depth = stack.size
        val subject = (top as? WorkPage.Subject)?.subject ?: return@LaunchedEffect
        if (!pushed && untitled != subject.id) return@LaunchedEffect
        if (subject.title.isEmpty()) { untitled = subject.id; return@LaunchedEffect }
        untitled = null
        val owner = account.session.credentials()?.email.orEmpty()
        RecentRows.subject(subject.kind.value, subject.id, subject.title)?.let { HomeRecents.remember(context, owner, it) }
    }
    if (top is WorkPage.Subject && top.subject.title.isEmpty()) {
        LaunchedEffect(top) {
            val titled = store.resolveTitle(top.subject) ?: return@LaunchedEffect
            val at = stack.indexOf(top)
            if (at >= 0) stack[at] = WorkPage.Subject(titled)
        }
    }

    // A regular width (ui/SizeClass.kt): the Mac rail beside one detail stack, Overview's columns at its root.
    val split = isRegularWidth()
    val overview: @Composable (WorkSplit?) -> Unit = { splitView ->
        WorkOverview(
            store = store,
            query = query,
            onQuery = { query = it; store.search(it) },
            railOrder = railOrder,
            onRailOrder = { railOrder = it },
            route = overviewRoute,
            onRouteTaken = { overviewRoute = null },
            onOpenTask = { stack.add(WorkPage.MineTask(it)) },
            onOpenIssue = { stack.add(WorkPage.Issue(it, null)) },
            onOpenSubject = { subject ->
                val ref = SubjectRef.of(subject)
                // A rail row is a selection: the detail stack becomes that subject, as iOS `path = [next]`.
                if (splitView == null) openSubject(ref)
                else if ((stack.firstOrNull() as? WorkPage.Subject)?.subject?.id != ref.id) { stack.clear(); openSubject(ref) }
            },
            onOpenSubjectAt = { subject, pane, create -> if (splitView != null) stack.clear(); openSubjectAt(subject, pane, create) },
            onBrowse = { if (splitView != null) stack.clear(); stack.add(WorkPage.Browse) },
            doors = InboxDoors(openSubject = openSubject, openIssue = { owner, repo, number, _ -> stack.add(WorkPage.IssueRef(owner, repo, number)) }),
            keep = keepDoors,
            split = splitView,
        )
    }
    val pageView: @Composable (WorkPage) -> Unit = { page ->
        when (page) {
            is WorkPage.MineTask -> MineTaskDestination(store, page.id, pop, openSubject)
            is WorkPage.Task -> TaskScreen(store, remember(page) { TaskSource.Full(page.task, page.subject) }, pop, openSubject)
            is WorkPage.Subject -> SubjectScreen(
                store, page.subject, pop, { issue, project -> stack.add(WorkPage.Issue(issue, project)) },
                request = subjectRequest?.takeIf { it.id == page.subject.id },
                onRequestTaken = { subjectRequest = null },
                onOpenSubject = openSubject,
                onOpenContact = { stack.add(WorkPage.Contact(it)) },
                // A Talk chip's issue (`MobileIssueDoor`), on the subject's project.
                onOpenIssueRef = { owner, repo, number, project -> stack.add(WorkPage.IssueRef(owner, repo, number, project)) },
                // `currentSubject = survivor`: the page swaps in place, in the saved stack too.
                onReplaceSubject = { next -> stack.indexOf(page).takeIf { it >= 0 }?.let { stack[it] = WorkPage.Subject(next) } },
            ) { task, subject -> stack.add(WorkPage.Task(task, subject)) }
            is WorkPage.Issue -> IssueScreen(store, page.issue, page.projectId, pop)
            is WorkPage.IssueRef -> IssueDoor(store, page.owner, page.repo, page.number, page.projectId, pop)
            WorkPage.Browse -> BrowseScreen(store, searching = query.isNotBlank(), onBack = pop, onOtherRecords = if (core.isAvailable) ({ stack.add(WorkPage.Core(work.starlings.android.core.ui.CoreDoor.Page)) }) else null, onOpenContact = { stack.add(WorkPage.Contact(it)) }, keep = keepDoors, query = query, onOpenSubjectAt = openSubjectAt) { openSubject(SubjectRef.of(it)) }
            is WorkPage.Contact -> ContactScreen(store, page.id, pop, openSubject)
            is WorkPage.Keep -> work.starlings.android.keep.ui.KeepScreen(
                keep,
                if (page.projectId != null) work.starlings.android.keep.ui.KeepLanding.Project(page.projectId, page.projectName.orEmpty()) else work.starlings.android.keep.ui.KeepLanding.Vaults,
                pop,
            )
            is WorkPage.Core -> work.starlings.android.core.ui.CoreScreen(page.door, coreNavigation)
        }
    }

    if (split) {
        overview(
            WorkSplit(
                // The rail marks a subject only while it is the stack's root; a task opened from Overview marks nothing.
                selectedSubject = (stack.firstOrNull() as? WorkPage.Subject)?.subject?.id,
                onOverview = { stack.clear() },
                detail = top?.let { page -> @Composable { pageView(page) } },
            ),
        )
    } else {
        when (val page = top) {
            null -> overview(null)
            else -> pageView(page)
        }
    }
}

/** The stack as a list of lines; a line this build cannot read is dropped. */
private val WorkStackSaver: Saver<SnapshotStateList<WorkPage>, ArrayList<String>> = Saver(
    save = { stack -> ArrayList(stack.map(WorkPage::encode)) },
    restore = { lines -> mutableStateListOf<WorkPage>().apply { addAll(lines.mapNotNull(WorkPage::decode)) } },
)
