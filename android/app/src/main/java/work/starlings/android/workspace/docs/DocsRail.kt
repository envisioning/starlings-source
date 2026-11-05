package work.starlings.android.workspace.docs

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.MoveToInbox
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Work
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.LocalOffer
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.FoldingSection
import work.starlings.android.ui.NavigationRow
import work.starlings.android.ui.RetryState
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.FavoriteMenuItem
import work.starlings.android.workspace.FavoriteTargets
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/**
 * What the rail shows, held above the tab's pages so a list can label its
 * category and a return to the rail paints at once: `MobileDocsView`'s
 * state and `loadRail`.
 */
@Stable
class DocsRailState(private val data: DocsData) {
    var summary by mutableStateOf<DocsSummary?>(null)
        private set
    var tree by mutableStateOf<List<DocsFolder>>(emptyList())
        private set
    var projectGroups by mutableStateOf<List<DocsSubjectGroup>>(emptyList())
        private set
    var leadGroups by mutableStateOf<List<DocsSubjectGroup>>(emptyList())
        private set
    var partnerGroups by mutableStateOf<List<DocsSubjectGroup>>(emptyList())
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var refreshing by mutableStateOf(false)
        private set
    /** Every project, lead and partner the CRM names: what the File menu files onto. */
    private var projects by mutableStateOf<List<CrmSubjectWire>>(emptyList())
    private var leads by mutableStateOf<List<CrmSubjectWire>>(emptyList())
    private var partners by mutableStateOf<List<CrmSubjectWire>>(emptyList())

    /** `DocsSummary.label(for:)` on the last summary. */
    fun label(category: String): String = DocsRules.label(summary, category)

    /** The workspace's categories in rail order, as (id, label): what a picker offers. */
    val categoryChoices: List<Pair<String, String>> get() = summary?.categories.orEmpty().map { it.category to it.label }

    /** `filing`: what the File menu on a row files into. */
    val filing: DocsFilingChoices
        get() = DocsFiling.choices(tree, summary?.categories.orEmpty(), projects, leads, partners)

    suspend fun load() {
        // Last known first (docs/CACHING.md): the counts and the groups paint
        // from the last snapshot before Docs and the CRM answer.
        if (summary == null) data.cachedSummary()?.let { summary = it }
        if (projectGroups.isEmpty() && leadGroups.isEmpty()) {
            data.cachedDocuments(DocsListRead.Written())?.let { written ->
                data.cachedSubjects(CrmSubjectKind.PROJECT)?.let { projectGroups = DocsRules.groups(written, it, CrmSubjectKind.PROJECT) }
                data.cachedSubjects(CrmSubjectKind.LEAD)?.let { leadGroups = DocsRules.groups(written, it, CrmSubjectKind.LEAD) }
            }
        }
        refreshing = true
        try {
            try {
                summary = data.summary()
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = DocsData.describe(e)
            }
            // Best effort: without the tree, Folders lists only folders that hold something.
            tree = try { data.tree() } catch (e: CancellationException) { throw e } catch (_: Exception) { tree }
            // Best effort: a CRM that is off leaves the rail with Recent and the categories.
            try {
                coroutineScope {
                    val written = async { data.allDocuments(DocsListRead.Written()) }
                    val projectList = async { data.subjects(CrmSubjectKind.PROJECT) }
                    val leadList = async { data.subjects(CrmSubjectKind.LEAD) }
                    val documents = written.await()
                    projects = projectList.await()
                    leads = leadList.await()
                    projectGroups = DocsRules.groups(documents, projects, CrmSubjectKind.PROJECT)
                    leadGroups = DocsRules.groups(documents, leads, CrmSubjectKind.LEAD)
                    // Beside the others: a partner is filed under its organization.
                    partners = try { data.subjects(CrmSubjectKind.ORGANIZATION) } catch (e: CancellationException) { throw e } catch (_: Exception) { emptyList() }
                    partnerGroups = DocsRules.groups(documents, partners, CrmSubjectKind.ORGANIZATION)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                projectGroups = emptyList()
                leadGroups = emptyList()
                partnerGroups = emptyList()
            }
        } finally {
            refreshing = false
        }
    }
}

/** Fold state per block, saved under the table's key, as iOS's `@AppStorage`. */
private class FoldStore(context: Context) {
    private val prefs = context.getSharedPreferences("rail_folds", Context.MODE_PRIVATE)
    private val values = mutableStateMapOf<String, Boolean>()

    fun folded(key: String): Boolean = values.getOrPut(key) { prefs.getBoolean(key, false) }

    fun set(key: String, folded: Boolean) {
        values[key] = folded
        prefs.edit().putBoolean(key, folded).apply()
    }
}

/**
 * The first screen: WORK and LIBRARY, with By project, By lead, By partner
 * and Folders between them (docs/DOCS.md, "The rail"). Which blocks there
 * are, their order, each fold's key and which hide while empty come from the
 * shared table (`DocsRules.blocks`).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocsRail(state: DocsRailState, onGraph: () -> Unit = {}, onOpen: (DocsSelection) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val folds = remember { FoldStore(context.applicationContext) }
    val c = Starlings.colors

    val error = state.error
    if (error != null && state.summary == null) {
        RetryState(stringResource(R.string.docs_load_failed), error, stringResource(R.string.docs_retry), { scope.launch { state.load() } })
        return
    }

    val summary = state.summary
    val work = summary?.let { DocsRules.categories(it, DocsRailHalf.WORK, includeEmpty = true) }.orEmpty()
    val library = summary?.let { DocsRules.categories(it, DocsRailHalf.LIBRARY) }.orEmpty()
    val folders = DocsRules.folders(summary?.folders.orEmpty(), state.tree)
    val empty = buildSet {
        if (state.projectGroups.isEmpty()) add(DocsBlock.PROJECTS)
        if (state.leadGroups.isEmpty()) add(DocsBlock.LEADS)
        if (state.partnerGroups.isEmpty()) add(DocsBlock.PARTNERS)
        if (folders.isEmpty()) add(DocsBlock.FOLDERS)
        if (library.isEmpty()) add(DocsBlock.LIBRARY)
    }
    val collapsed = stringResource(R.string.docs_collapsed)
    val expanded = stringResource(R.string.docs_expanded)

    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = { scope.launch { state.load() } }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            DocsRules.blocks(empty).forEach { (kind, block) ->
                item(key = block.id) {
                    val title = stringResource(
                        when (kind) {
                            DocsBlock.EXPLORE -> R.string.docs_graph_explore
                            DocsBlock.WORK -> R.string.docs_block_work
                            DocsBlock.PROJECTS -> R.string.docs_by_project
                            DocsBlock.LEADS -> R.string.docs_by_lead
                            DocsBlock.PARTNERS -> R.string.docs_by_partner
                            DocsBlock.FOLDERS -> R.string.docs_folders
                            DocsBlock.LIBRARY -> R.string.docs_library
                        },
                    )
                    FoldingSection(title, folds.folded(block.key), { folds.set(block.key, it) }, collapsed, expanded) {
                        when (kind) {
                            DocsBlock.EXPLORE -> NavigationRow(stringResource(R.string.docs_graph_title), Icons.Outlined.Hub, onGraph)
                            DocsBlock.WORK -> {
                                val unfiled = summary?.unfiled ?: 0
                                val rows = buildList<Triple<String, ImageVector, Pair<Int?, DocsSelection>>> {
                                    add(Triple(stringResource(R.string.docs_recent), Icons.Filled.Schedule, null to DocsSelection.Recent))
                                    add(Triple(stringResource(R.string.docs_links), Icons.Filled.Link, (summary?.links ?: 0) to DocsSelection.Links))
                                    // Only while something is unfiled.
                                    if (unfiled > 0) add(Triple(stringResource(R.string.docs_unfiled), Icons.Filled.MoveToInbox, unfiled to DocsSelection.Unfiled))
                                    work.forEach { add(Triple(it.label, Icons.Outlined.LocalOffer, it.count to DocsSelection.Category(it.category, DocsRailHalf.WORK))) }
                                }
                                rows.forEachIndexed { index, (label, icon, target) ->
                                    NavigationRow(label, icon, { onOpen(target.second) }, count = target.first, divider = index < rows.lastIndex)
                                }
                            }
                            DocsBlock.PROJECTS -> SubjectRows(state.projectGroups, Icons.Outlined.Folder, onOpen)
                            DocsBlock.LEADS -> SubjectRows(state.leadGroups, Icons.Filled.Work, onOpen)
                            DocsBlock.PARTNERS -> SubjectRows(state.partnerGroups, Icons.Filled.Business, onOpen)
                            DocsBlock.FOLDERS -> folders.forEachIndexed { index, folder ->
                                // Star or Unstar by the folder's stable id, so only a folder the tree names has one.
                                val stable = state.tree.firstOrNull { it.path == folder.path }
                                NavigationRow(folder.title, Icons.Filled.Folder, { onOpen(DocsSelection.Folder(folder.path, folder.title)) },
                                    count = folder.count, divider = index < folders.lastIndex,
                                    menuLabel = stringResource(R.string.more),
                                    menu = stable?.let { found -> { dismiss -> FavoriteMenuItem(FavoriteTargets.folder(found.id), dismiss) } })
                            }
                            DocsBlock.LIBRARY -> {
                                // Kept while empty (the table): a mirror that failed to load says so inside it.
                                if (library.isEmpty()) {
                                    Box(Modifier.padding(horizontal = 16.dp, vertical = 11.dp)) {
                                        Text(stringResource(R.string.docs_library_empty), style = StarlingsType.footnote, color = c.secondary)
                                    }
                                }
                                library.forEachIndexed { index, category ->
                                    NavigationRow(category.label, Icons.Outlined.LocalOffer,
                                        { onOpen(DocsSelection.Category(category.category, DocsRailHalf.LIBRARY)) },
                                        count = category.count, divider = index < library.lastIndex)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SubjectRows(groups: List<DocsSubjectGroup>, icon: ImageVector, onOpen: (DocsSelection) -> Unit) {
    groups.forEachIndexed { index, group ->
        NavigationRow(
            group.subject.title, icon,
            { onOpen(DocsSelection.Subject(group.docsKind, group.subject.id, group.subject.title)) },
            count = group.count, divider = index < groups.lastIndex,
        )
    }
}
