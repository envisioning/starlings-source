package work.starlings.android.workspace.work

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FilterAlt
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.FilterAlt
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkRowMenu
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.contracts.CrmGithubRepo
import work.starlings.contracts.CrmIssueCreate
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmProjectRepoCreate
import work.starlings.contracts.Patch

/**
 * `MobileSubjectIssuesView`'s state, owned by the subject page so the tab
 * reads "Issues (n)" before the pane opens: the rows, whether a repository
 * is linked, and the paging. A read that fails reads as unlinked, as iOS.
 */
internal class SubjectIssuesState(private val store: WorkStore, private val projectId: String) {
    var issues by mutableStateOf<List<CrmIssueWire>>(emptyList()); private set
    var linked by mutableStateOf(false); private set
    /** Null until the first answer: not yet known whether a repository is linked. */
    var known by mutableStateOf(false); private set
    var loading by mutableStateOf(false); private set
    var loadingMore by mutableStateOf(false); private set
    var hasMore by mutableStateOf(false); private set
    var filter by mutableStateOf(IssueFilter())
    private var page = 1

    val shown: List<CrmIssueWire> get() = issues.filter(filter::matches)

    /** A fresh question: page 1, painted from the last answer to it first (docs/CACHING.md). */
    suspend fun load() = load(1, appending = false)

    suspend fun loadMore() = load(page + 1, appending = true)

    private suspend fun load(wanted: Int, appending: Boolean) {
        val route = WorkExtraRoutes.issues(filter.query(projectId, wanted))
        if (!appending && issues.isEmpty()) {
            store.client.snapshot(route)?.value?.let { kept ->
                issues = kept.issues; linked = kept.linked; hasMore = kept.hasMore == true; known = true
            }
        }
        if (appending) loadingMore = true else loading = issues.isEmpty()
        try {
            val found = store.client.call(route)
            issues = if (appending) IssueFilter.appending(issues, found.issues) else found.issues
            page = wanted
            linked = found.linked
            hasMore = found.hasMore == true
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (!appending) { linked = false; hasMore = false }
        } finally {
            known = true
            loading = false
            loadingMore = false
        }
    }
}

/**
 * `MobileSubjectIssuesView`: the GitHub issues on a project's linked
 * repositories. The filter bar and the search field, the rows (each with
 * close or reopen on a long press), Load more, and the empty line that says
 * which filter emptied it. With no repository: the link offer.
 */
@Composable
internal fun SubjectIssuesPane(store: WorkStore, state: SubjectIssuesState, subject: SubjectRef, onOpen: (CrmIssueWire) -> Unit) {
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    var linking by remember { mutableStateOf(false) }
    // Everything but the search field is a new question for the server; typing narrows what is in hand.
    val question = state.filter.query(subject.id)
    LaunchedEffect(question) {
        delay(120)
        state.load()
    }

    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        when {
            state.linked -> {
                item {
                    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        StarlingsField(state.filter.search, { state.filter = state.filter.copy(search = it) }, r.getString(R.string.work_filter_these_issues))
                        IssueFilterBar(state.filter, state.issues) { state.filter = it }
                    }
                }
                item {
                    WorkSection(footer = r.getString(R.string.work_issues_footer)) {
                        val shown = state.shown
                        shown.forEachIndexed { index, issue ->
                            if (index > 0) WorkDivider()
                            WorkRowMenu(issueStateMenu(r, store, issue, subject.id)) { long ->
                                MineIssueRow(issue, onLongClick = long) { onOpen(issue) }
                            }
                        }
                        if (state.hasMore) {
                            if (shown.isNotEmpty()) WorkDivider()
                            WorkActionRow(
                                r.getString(if (state.loadingMore) R.string.work_loading else R.string.work_load_more_github),
                                { scope.launch { state.loadMore() } },
                                enabled = !state.loadingMore,
                                accent = true,
                            )
                        }
                        if (state.issues.isEmpty() && state.loading) WorkPlaceholderRows()
                        if (shown.isEmpty() && !state.loading) {
                            // A list a filter emptied says so, or it reads as a repository that lost its issues.
                            WorkNote(
                                if (state.issues.isEmpty()) r.getString(R.string.work_no_state_issues, stateTitle(r, state.filter.state).lowercase())
                                else r.getString(R.string.work_no_issues_match),
                            )
                        }
                    }
                }
            }
            !state.known || state.loading -> item { WorkSection { WorkPlaceholderRows() } }
            else -> item {
                WorkSection(footer = r.getString(R.string.work_link_repo_footer)) {
                    WorkNote(r.getString(R.string.work_no_repo_linked, subject.title))
                    WorkDivider()
                    WorkActionRow(r.getString(R.string.work_link_repo), { linking = true }, accent = true)
                }
            }
        }
        item { Spacer(Modifier.padding(bottom = 24.dp)) }
    }

    if (linking) {
        RepoPickerSheet(store, subject.id, onDismiss = { linking = false }) {
            linking = false
            scope.launch { state.load() }
        }
    }
}

internal fun stateTitle(r: android.content.res.Resources, state: IssueFilter.State): String = when (state) {
    IssueFilter.State.OPEN -> r.getString(R.string.work_open)
    IssueFilter.State.CLOSED -> r.getString(R.string.work_closed)
    IssueFilter.State.ALL -> r.getString(R.string.work_all)
}

/**
 * `MobileIssueFilterBar`: the state as a segmented picker, everything else
 * behind one menu so the list keeps its room. Labels, assignees and
 * milestones come from what came back.
 */
@Composable
internal fun IssueFilterBar(filter: IssueFilter, issues: List<CrmIssueWire>, onChange: (IssueFilter) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var menu by remember { mutableStateOf<String?>(null) }
    val choices = filter.choices(issues)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.weight(1f)) {
            Segmented(IssueFilter.State.entries.map { it to stateTitle(r, it) }, filter.state, padded = false) { onChange(filter.copy(state = it)) }
        }
        val label = r.getString(R.string.work_filter_issues_label)
        Box {
            Box(
                Modifier
                    .size(40.dp)
                    .clickable(role = Role.Button) { menu = "root" }
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (filter.isNarrowed) Icons.Filled.FilterAlt else Icons.Outlined.FilterAlt, null, tint = if (filter.isNarrowed) c.accent else c.primary)
            }
            val any = r.getString(R.string.work_anyone)
            val entries: List<MenuChoice> = when (menu) {
                "root" -> buildList {
                    IssueFilter.Sort.entries.forEach { sort ->
                        add(MenuChoice(sortTitle(r, sort), checked = filter.sort == sort) { onChange(filter.copy(sort = sort)) })
                    }
                    val sorts = size
                    if (choices.labels.isNotEmpty()) add(MenuChoice(r.getString(R.string.work_label_menu), startsGroup = size == sorts) { menu = "labels" })
                    if (choices.logins.isNotEmpty()) add(MenuChoice(r.getString(R.string.work_assignee_menu), startsGroup = size == sorts) { menu = "assignees" })
                    if (choices.milestones.isNotEmpty()) add(MenuChoice(r.getString(R.string.work_milestone), startsGroup = size == sorts) { menu = "milestones" })
                    if (filter.isNarrowed) add(MenuChoice(r.getString(R.string.work_clear_filters), startsGroup = true, danger = true) { onChange(IssueFilter()) })
                }
                "labels" -> listOf(MenuChoice(r.getString(R.string.work_all_labels), checked = filter.labels.isEmpty()) { onChange(filter.copy(labels = emptyList())) }) +
                    choices.labels.mapIndexed { i, l -> MenuChoice(l, checked = filter.labels == listOf(l), startsGroup = i == 0) { onChange(filter.copy(labels = listOf(l))) } }
                "assignees" -> listOf(
                    MenuChoice(any, checked = filter.assignee == null) { onChange(filter.copy(assignee = null)) },
                    MenuChoice(r.getString(R.string.work_nobody), checked = filter.assignee == "none") { onChange(filter.copy(assignee = "none")) },
                ) + choices.logins.mapIndexed { i, l -> MenuChoice(l, checked = filter.assignee == l, startsGroup = i == 0) { onChange(filter.copy(assignee = l)) } }
                "milestones" -> listOf(
                    MenuChoice(r.getString(R.string.work_any_milestone), checked = filter.milestone == null) { onChange(filter.copy(milestone = null)) },
                    MenuChoice(r.getString(R.string.work_no_milestone), checked = filter.milestone == "none") { onChange(filter.copy(milestone = "none")) },
                ) + choices.milestones.mapIndexed { i, (title, number) -> MenuChoice(title, checked = filter.milestone == number, startsGroup = i == 0) { onChange(filter.copy(milestone = number)) } }
                else -> emptyList()
            }
            // A submenu replaces the root: the entry's tap closes the menu, then opens the next one.
            ChoiceMenu(menu != null, { menu = null }, entries)
        }
    }
}

private fun sortTitle(r: android.content.res.Resources, sort: IssueFilter.Sort): String = when (sort) {
    IssueFilter.Sort.UPDATED -> r.getString(R.string.work_sort_updated)
    IssueFilter.Sort.CREATED -> r.getString(R.string.work_sort_newest)
    IssueFilter.Sort.COMMENTS -> r.getString(R.string.work_sort_comments)
}

/**
 * `MobileNewIssueView`: file a new issue on the project's primary
 * repository, in your name. Title and description, then labels, assignees
 * and milestone where the repository says what it accepts.
 */
@Composable
internal fun NewIssueSheet(store: WorkStore, subject: SubjectRef, onDismiss: () -> Unit, onFiled: () -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var details by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var facets by remember { mutableStateOf(IssueFacets.NONE) }
    var labels by remember { mutableStateOf<List<String>>(emptyList()) }
    var assignees by remember { mutableStateOf<List<String>>(emptyList()) }
    var milestone by remember { mutableStateOf<Long?>(null) }
    var pickingPeople by remember { mutableStateOf(false) }
    var attaching by remember { mutableStateOf(false) }
    LaunchedEffect(subject.id) { facets = store.primaryFacets(subject.id) }
    val context = LocalContext.current

    // The picture goes to the Worker and the body takes its link, appended:
    // the picker took focus, so there is no caret left to insert at.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val picked = try {
                IssueImage.read(context, uri)
            } catch (e: IllegalStateException) {
                error = e.message
                return@launch
            }
            attaching = true
            try {
                val url = store.uploadIssueImage(picked.data, picked.contentType)
                details = IssueImage.appending(IssueImage.markdown(picked.name, url), details)
                error = null
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                attaching = false
            }
        }
    }

    fun file() {
        if (working || title.isBlank()) return
        working = true
        scope.launch {
            try {
                store.client.call(
                    WorkExtraRoutes.createIssue(
                        CrmIssueCreate(
                            projectId = subject.id,
                            title = title.trim(),
                            body = details.takeIf { it.isNotEmpty() },
                            labels = labels.takeIf { it.isNotEmpty() },
                            assignees = assignees.takeIf { it.isNotEmpty() },
                            milestone = milestone,
                        ),
                    ),
                )
                onFiled()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                working = false
            }
        }
    }

    WorkSheet(
        r.getString(R.string.work_new_issue), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(R.string.work_file), confirmEnabled = title.isNotBlank() && !working, onConfirm = ::file,
    ) {
        WorkSection(footer = r.getString(R.string.work_new_issue_footer)) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                StarlingsField(title, { title = it.replace('\n', ' ') }, r.getString(R.string.work_title_field))
                StarlingsField(details, { details = it }, r.getString(R.string.work_description), singleLine = false, maxLines = 12)
            }
            WorkDivider()
            val canAttach = !working && !attaching
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(enabled = canAttach, role = Role.Button) { picker.launch(IssueImage.allowedTypes.toTypedArray()) }
                    .alpha(if (canAttach) 1f else 0.45f)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.AddPhotoAlternate, null, Modifier.size(20.dp), tint = c.accent)
                Text(stringResource(if (attaching) R.string.work_attaching else R.string.work_attach_image), style = StarlingsType.body, color = c.accent)
            }
        }
        if (!facets.isEmpty) {
            WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_give_it_to_somebody)) }) {
                var first = true
                fun divider() { first = false }
                if (facets.labels.isNotEmpty()) {
                    LabelsMenuRow(facets, labels, enabled = true, summary = labels.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: r.getString(R.string.work_none)) { labels = it }
                    divider()
                }
                if (facets.assignees.isNotEmpty()) {
                    if (!first) WorkDivider()
                    work.starlings.android.ui.WorkLabeledRow(
                        r.getString(R.string.work_assignees),
                        assignees.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: r.getString(R.string.work_nobody),
                    ) { pickingPeople = true }
                    divider()
                }
                if (facets.milestones.isNotEmpty()) {
                    if (!first) WorkDivider()
                    MilestoneMenuRow(
                        facets, milestone, enabled = true,
                        summary = facets.numbered.firstOrNull { it.first == milestone }?.second ?: r.getString(R.string.work_none),
                        noneTitle = r.getString(R.string.work_no_milestone),
                    ) { milestone = it }
                }
            }
        }
        error?.let { WorkSection { WorkErrorNotice(it) } }
        if (working) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), color = c.secondary, strokeWidth = 2.dp) }
    }
    if (pickingPeople) {
        AssigneePickerSheet(facets.assignees, assignees) { chosen ->
            pickingPeople = false
            assignees = chosen
        }
    }
}

/**
 * `MobileProjectRepoPicker`: the repositories already linked, then the ones
 * the Core GitHub App can reach, searched as you type. The first one linked
 * is the primary, where a new issue lands.
 */
@Composable
internal fun RepoPickerSheet(store: WorkStore, projectId: String, onDismiss: () -> Unit, onLinked: (CrmGithubRepo) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<CrmGithubRepo>>(emptyList()) }
    var linked by remember { mutableStateOf<List<CrmGithubRepo>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(projectId) {
        linked = runCatching { store.client.call(WorkExtraRoutes.projectRepos(projectId)).repos }.getOrDefault(emptyList())
    }
    LaunchedEffect(query) {
        delay(180)
        loading = true
        try {
            results = store.client.call(WorkExtraRoutes.githubRepos(query)).repos
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            results = emptyList()
            error = e.workMessage()
        } finally {
            loading = false
        }
    }

    fun link(repo: CrmGithubRepo) {
        if (saving != null) return
        saving = repo.id
        scope.launch {
            try {
                val saved = store.client.call(
                    WorkExtraRoutes.addProjectRepo(
                        CrmProjectRepoCreate(
                            projectId = projectId, owner = repo.owner, repo = repo.repo,
                            label = repo.label?.let { Patch.Value(it) } ?: Patch.Omit,
                            milestone = repo.milestone?.let { Patch.Value(it) } ?: Patch.Omit,
                            isPrimary = linked.isEmpty(),
                        ),
                    ),
                ).repo
                onLinked(saved)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                saving = null
            }
        }
    }

    WorkSheet(r.getString(R.string.work_link_github), r.getString(R.string.work_cancel), onDismiss) {
        Box(Modifier.padding(horizontal = 16.dp)) { StarlingsField(query, { query = it }, r.getString(R.string.work_search)) }
        error?.let { WorkSection { WorkErrorNotice(it) } }
        if (linked.isNotEmpty()) {
            WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_already_linked)) }) {
                linked.forEachIndexed { index, repo ->
                    if (index > 0) WorkDivider()
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 11.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (repo.isPrimary) Icons.Filled.Star else Icons.Filled.Link, null, Modifier.size(18.dp), tint = c.secondary)
                        Text("${repo.owner}/${repo.repo}", style = StarlingsType.body, color = c.primary)
                    }
                }
            }
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_available_repos)) }) {
            results.forEachIndexed { index, repo ->
                if (index > 0) WorkDivider()
                val taken = linked.any { it.owner == repo.owner && it.repo == repo.repo }
                val enabled = saving == null && !taken
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = enabled, role = Role.Button) { link(repo) }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("${repo.owner}/${repo.repo}", style = StarlingsType.body, color = c.primary.copy(alpha = if (enabled) 1f else 0.45f))
                        repo.label?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
                    }
                    if (saving == repo.id) CircularProgressIndicator(Modifier.size(16.dp), color = c.secondary, strokeWidth = 2.dp)
                }
            }
            if (results.isEmpty() && loading) WorkPlaceholderRows()
            if (results.isEmpty() && !loading) WorkNote(r.getString(if (query.isEmpty()) R.string.work_no_repos_available else R.string.work_no_repos_match))
        }
    }
}
