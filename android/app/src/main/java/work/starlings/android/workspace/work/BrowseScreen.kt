package work.starlings.android.workspace.work

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GridView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.android.ui.WorkTopBar
import work.starlings.contracts.CrmSubjectCountsQueryKind
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/**
 * Browse's own reads (`MobileWorkView.loadAll`): the workspace's projects,
 * client projects and Sales, each at its own status filter, and the status
 * badges ("Open (16)"). Each half of the projects is the whole set at its
 * filter with only its own rows kept: Core has no internal flag to ask for
 * one half. A sort is a reorder here, never a new read.
 */
internal class BrowseLists(private val store: WorkStore, context: Context) {
    private val prefs = context.getSharedPreferences("work", Context.MODE_PRIVATE)

    /** One group's filter, sort, rows and badges. [sortKey] is `WorkSidebarPreferences`' key. */
    inner class Group(val kind: CrmSubjectKind, val sortKey: String, private val keep: (CrmSubjectWire) -> Boolean) {
        var status by mutableStateOf(SubjectStatusFilter.DEFAULT)
        var sort by mutableStateOf(SubjectSort.of(prefs.getString("sort.$sortKey", null))); private set
        var rows by mutableStateOf<List<CrmSubjectWire>?>(null); private set
        var hasMore by mutableStateOf(false); private set
        var counts by mutableStateOf<Map<String, Int>>(emptyMap())
        var error by mutableStateOf<String?>(null); private set

        fun choose(next: SubjectSort) {
            sort = next
            prefs.edit().putString("sort.$sortKey", next.id).apply()
        }

        /** The rows shown: the read at this filter, or the store's open list until it lands. */
        fun shown(fallback: List<CrmSubjectWire>, fallbackHasMore: Boolean): Pair<List<CrmSubjectWire>, Boolean> {
            val read = rows
            return if (read != null) sort.sorted(read) to hasMore
            else if (status == SubjectStatusFilter.DEFAULT) sort.sorted(fallback.filter(keep)) to fallbackHasMore
            else emptyList<CrmSubjectWire>() to false
        }

        suspend fun load(query: String) {
            try {
                val page = store.client.call(WorkRoutes.subjects(kind, query, status))
                rows = page.subjects.filter(keep)
                hasMore = page.hasMore
                error = null
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            }
        }
    }

    private fun isOwn(subject: CrmSubjectWire) = SubjectState.group(subject.kind.value, subject.title, subject.isInternal) == SubjectGroup.ENVISIONING

    val envisioning = Group(CrmSubjectKind.PROJECT, "work.envisioning") { isOwn(it) }
    val clients = Group(CrmSubjectKind.PROJECT, "work.projects") { !isOwn(it) }
    val sales = Group(CrmSubjectKind.LEAD, "work.leads") { true }

    /** The badges: projects ignore the search box and come split by Core's internal flag; Sales follows it. A failed count keeps the last. */
    suspend fun loadCounts(query: String) {
        runCatching { store.client.call(WorkRoutes.subjectCounts(CrmSubjectCountsQueryKind.PROJECT, "")) }.onSuccess {
            envisioning.counts = SubjectStatusFilter.internal(it)
            clients.counts = SubjectStatusFilter.client(it)
        }
        if (store.salesVisible) {
            runCatching { store.client.call(WorkRoutes.subjectCounts(CrmSubjectCountsQueryKind.LEAD, query.trim())) }.onSuccess { sales.counts = SubjectStatusFilter.leads(it) }
        }
    }
}

/**
 * Browse (`MobileWorkView.browseList`): the directory, one folding group
 * per relationship, starred first in each, bucketed by organization, with
 * the cap line when Core holds more. Projects and Sales carry a Status
 * filter with counts and a Sort. Sales off draws Turn Sales on.
 */
@Composable
internal fun BrowseScreen(
    store: WorkStore,
    searching: Boolean,
    onBack: () -> Unit,
    onOpenContact: (String) -> Unit = {},
    /** The foot row, Other records (#1262); null where the workspace has none. */
    onOtherRecords: (() -> Unit)? = null,
    keep: KeepDoors? = null,
    /** The search box, which every group's read follows. */
    query: String = "",
    /** A subject at a pane, with an editor up when [create] says so. */
    onOpenSubjectAt: (SubjectRef, SubjectPane?, create: String?) -> Unit = { _, _, _ -> },
    onOpenSubject: (CrmSubjectWire) -> Unit,
) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences("work", Context.MODE_PRIVATE) }
    val sheets = remember { SubjectSheets() }
    val subjectDoors = sheets.doors(open = { subject, pane, create -> onOpenSubjectAt(SubjectRef.of(subject), pane, create) }, keep = keep, core = rememberCoreDoors())
    var notice by remember { mutableStateOf<String?>(null) }
    SubjectSheetsHost(store, sheets, onCreated = { onOpenSubjectAt(it, SubjectPane.TALK, null) }) { notice = it }
    val lists = remember(store) { BrowseLists(store, context) }
    val salesOn = store.salesVisible
    // A beat of quiet before asking, so typing a name is one request.
    LaunchedEffect(query, lists.envisioning.status) { delay(250); lists.envisioning.load(query) }
    LaunchedEffect(query, lists.clients.status) { delay(250); lists.clients.load(query) }
    LaunchedEffect(query, lists.sales.status, salesOn) { if (salesOn) { delay(250); lists.sales.load(query) } }
    LaunchedEffect(query, salesOn) { lists.loadCounts(query) }
    val now = System.currentTimeMillis()

    /** One group: what it holds, and its filter when it has one. */
    class Shown(val key: String, val title: String, val rows: List<CrmSubjectWire>, val hasMore: Boolean, val group: BrowseLists.Group? = null)
    val groups = buildList {
        val (own, ownMore) = lists.envisioning.shown(store.projects, store.projectsHasMore)
        add(Shown("envisioning", SubjectState.PROJECT_GROUP_NAME, own, ownMore, lists.envisioning))
        val (clients, clientsMore) = lists.clients.shown(store.projects, store.projectsHasMore)
        add(Shown("projects", r.getString(R.string.work_group_projects), clients, clientsMore, lists.clients))
        add(Shown("partners", r.getString(R.string.work_group_partners), store.partners, store.partnersHasMore))
        add(Shown("events", r.getString(R.string.work_group_events), store.events, store.eventsHasMore))
        if (salesOn) {
            val (leads, leadsMore) = lists.sales.shown(store.leads, store.leadsHasMore)
            add(Shown("sales", r.getString(R.string.work_group_sales), leads, leadsMore, lists.sales))
        }
    }
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(stringResource(R.string.work_browse), stringResource(R.string.work_back), onBack)
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            notice?.let { message -> item("notice") { WorkSection { WorkErrorNotice(message) } } }
            groups.forEach { shown ->
                item(shown.key) {
                    var folded by remember { mutableStateOf(prefs.getBoolean("fold.browse.${shown.key}", false)) }
                    val subjects = shown.rows
                    val ordered = subjects.filter { store.states.resolved(it).starred } + subjects.filter { !store.states.resolved(it).starred }
                    WorkSection(header = {
                        WorkFoldTitle(shown.title, folded, r.getString(R.string.work_folded), r.getString(R.string.work_open)) {
                            folded = !folded
                            prefs.edit().putBoolean("fold.browse.${shown.key}", folded).apply()
                        }
                        if (shown.key == "partners") {
                            Spacer(Modifier.weight(1f))
                            OrganizationFilterButton(store.organizationFilter, store.organizationFacets) { next ->
                                prefs.edit().apply { next.encoded()?.let { putString(OrganizationFilter.KEY, it) } ?: remove(OrganizationFilter.KEY) }.apply()
                                store.applyOrganizationFilter(next)
                            }
                        }
                    }) {
                        // A search opens every group: a match inside a folded one is no match at all.
                        if (!folded || searching) {
                            shown.group?.let { group ->
                                ChoiceMenuRow(
                                    r.getString(R.string.work_status),
                                    statusLabel(r, group.status, group.counts),
                                    SubjectStatusFilter.options(group.kind).map { option ->
                                        MenuChoice(statusLabel(r, option, group.counts), checked = option == group.status) { group.status = option }
                                    },
                                )
                                WorkDivider()
                                ChoiceMenuRow(
                                    r.getString(R.string.work_sort),
                                    sortTitle(r, group.sort),
                                    SubjectSort.entries.map { option -> MenuChoice(sortTitle(r, option), checked = option == group.sort) { group.choose(option) } },
                                )
                                group.error?.let { WorkErrorNotice(it, retry = r.getString(R.string.work_retry), onRetry = { scope.launch { group.load(query) } }) }
                                WorkDivider()
                            }
                            if (subjects.isEmpty() && store.isLoading) WorkPlaceholderRows()
                            if (subjects.isEmpty() && !store.isLoading) {
                                WorkNote(
                                    r.getString(
                                        when {
                                            searching -> R.string.work_nothing_matches
                                            shown.key == "partners" && !store.organizationFilter.isDefault -> R.string.work_nothing_matches
                                            shown.key == "partners" -> R.string.work_no_partners
                                            else -> R.string.nothing_here_yet
                                        },
                                    ),
                                )
                            }
                            val buckets = OrganizationBuckets.of(ordered)
                            var first = true
                            buckets.forEach { bucket ->
                                if (bucket.named && buckets.size > 1) BucketLine(bucket.name ?: r.getString(R.string.work_no_organization))
                                bucket.rows.forEach { subject ->
                                    if (!first) WorkDivider()
                                    first = false
                                    SubjectRow(subject, store.states.resolved(subject), WorkFormat.subjectDetail(r, subject, now), hasUnread = false, menu = subjectRowMenu(r, store, subject, subjectDoors)) {
                                        onOpenSubject(subject)
                                    }
                                }
                            }
                            if (shown.hasMore) WorkNote(r.getString(R.string.work_first_n, subjects.size))
                        }
                    }
                }
                // Contacts sit under the organizations they work at.
                if (shown.key == "partners") item("contacts") { ContactsGroup(store, onOpenContact) }
            }
            // The records with no subject page (decided by MZ, 2026-11-05): the phone reads them.
            val modules = store.subjectState?.workModules?.map { it.value }
            if (modules == null || "offers" in modules) item("offers") { OffersGroup(store) }
            if (modules == null || "licenses" in modules) item("licenses") { LicensesGroup(store) }
            // Sales off: the one door that turns it on, and what it brings.
            if (!salesOn) {
                item("sales-off") {
                    WorkSection(footer = r.getString(R.string.work_turn_sales_on_footer)) {
                        WorkActionRow(r.getString(R.string.work_turn_sales_on), { store.act { store.setSalesEnabled(true) } }, accent = true)
                    }
                }
            }
            onOtherRecords?.let { open ->
                item("other-records") {
                    WorkSection { WorkSidebarRow(Icons.Filled.GridView, stringResource(R.string.core_title), "", open, square = true) }
                }
            }
            item { Spacer(Modifier.padding(bottom = 24.dp)) }
        }
    }
}

/** "Open (16)": the option and its badge, when the badges are in. */
private fun statusLabel(r: android.content.res.Resources, option: String, counts: Map<String, Int>): String {
    val title = SubjectStatusFilter.title(r, option)
    return counts[option]?.let { r.getString(R.string.work_counted, title, it) } ?: title
}

private fun sortTitle(r: android.content.res.Resources, sort: SubjectSort): String =
    r.getString(if (sort == SubjectSort.ALPHABETICAL) R.string.work_sort_alphabetical else R.string.work_sort_busiest)
