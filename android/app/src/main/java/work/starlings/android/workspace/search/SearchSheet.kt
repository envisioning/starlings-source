package work.starlings.android.workspace.search

import work.starlings.android.host.RoomHost
import work.starlings.android.host.rememberHostStarter
import work.starlings.android.host.MeetingFiling
import work.starlings.android.host.rememberSubjectRoomStarter
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.SearchDestination
import work.starlings.android.SearchDoor
import work.starlings.android.SearchKind
import work.starlings.android.SearchPersonVerb
import work.starlings.android.SearchRow
import work.starlings.android.SearchRowVerb
import work.starlings.android.SearchSubjectVerb
import work.starlings.android.SearchVerb
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.LocalWorkspaceNavigator
import work.starlings.android.workspace.MemberSurface
import work.starlings.android.workspace.docs.DocsData
import work.starlings.android.workspace.docs.DocsSearchHit
import work.starlings.android.workspace.home.HomeRecents
import java.util.Locale
import java.util.TimeZone

/**
 * Opens the search sheet over whichever tab asks (iOS `isSearchPresented`).
 * The shell provides it; Home's magnifier calls it.
 */
val LocalSearchOpener = staticCompositionLocalOf<(() -> Unit)?> { null }

/**
 * Search on the phone: `MobileSearchView` (iOS/MobileSearchView.swift). One
 * list to find anything and jump anywhere. Hits come from `GET /api/search`;
 * doors and recents are this device's ([SearchPalette.ranked]). Document
 * titles are in the first answer; full text (Docs search) arrives after a
 * pause, below. A person is one row; its verbs sit behind a chevron.
 *
 * A row opens its place through the workspace navigator by web path, and is
 * written to [HomeRecents], the one recents list Home's Quick Access reads.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchSheet(account: OwnerAccount, tabs: List<MemberSurface>, onStartRoom: () -> Unit, dismiss: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val navigator = LocalWorkspaceNavigator.current
    val owner = remember(account) { account.session.credentials()?.email.orEmpty() }
    val docs = remember(account) { DocsData(account.client) }
    val hasDocs = MemberSurface.DOCS in tabs

    var query by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<SearchRow>>(emptyList()) }
    // The last hits came back without every source.
    var hitsPartial by remember { mutableStateOf(false) }
    var docHits by remember { mutableStateOf<List<DocsSearchHit>>(emptyList()) }
    val recents = remember(owner) { HomeRecents.load(context, owner) }
    var verbsFor by remember { mutableStateOf<SearchRow?>(null) }

    val doorTitles = doorTitles()
    val doors = remember(tabs, doorTitles) { SearchPalette.doorRows(tabs).map { row -> doorTitles[row.door]?.let { row.copy(title = it) } ?: row } }
    // The registry's tables as rows (`MobileSearchView.coreRows`), while linked on this phone.
    val core = remember { work.starlings.android.core.CoreAccess.of(context) }
    val coreTitle = stringResource(R.string.search_kind_core)
    val coreRows = SearchPalette.coreRows(
        core.isLinked,
        core.entities.map { SearchPalette.CoreEntry(it.id, it.pluralLabel, core.recordCounts[it.id]) },
    ) { count -> if (count == null) coreTitle else context.getString(R.string.core_search_row_count, count) }
    val ranked = SearchPalette.ranked(hits, recents, doors, query, coreRows)
    val emptyQuery = SearchPalette.isEmptyQuery(query)

    LaunchedEffect(query) {
        val trimmed = query.trim(' ')
        if (trimmed.isEmpty()) {
            hits = emptyList()
            hitsPartial = false
            return@LaunchedEffect
        }
        // The Worker fan-out is eight upstream reads; a keystroke should not fire it.
        delay(150)
        val found = runCatching { account.client.call(WorkRoutes.search(trimmed, TimeZone.getDefault().id)) }.getOrNull()
        hits = found?.rows.orEmpty().mapNotNull { SearchRow.fromWire(it.kind.value, it.id, it.title, it.subtitle, it.door, it.image) }
        hitsPartial = !found?.partial.isNullOrEmpty()
    }
    LaunchedEffect(query) {
        val trimmed = query.trim(' ')
        if (trimmed.length < 2 || !hasDocs) {
            docHits = emptyList()
            return@LaunchedEffect
        }
        // Titles answer on the first keystroke; this is the wait before full text.
        delay(400)
        docHits = runCatching { docs.search(trimmed, limit = 20) }.getOrDefault(emptyList())
    }

    // Open Team Room hosts the internal room, behind the microphone permission (host/HostStart.kt).
    val startHost = rememberHostStarter()
    val meetAbout = rememberSubjectRoomStarter()

    fun open(row: SearchRow, verb: SearchRowVerb?) {
        HomeRecents.remember(context, owner, row)
        verbsFor = null
        dismiss()
        when (val target = SearchPalette.target(row, verb)) {
            is SearchPalette.Target.Path -> navigator?.open(target.surface, target.path)
            SearchPalette.Target.StartRoom -> onStartRoom()
            SearchPalette.Target.OpenTeamRoom -> startHost(RoomHost.INTERNAL_ROOM)
            is SearchPalette.Target.MeetAbout -> meetAbout(MeetingFiling.about(target.kind, target.id, target.title))
            null -> Unit
        }
    }

    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.canvas) {
        Column(Modifier.fillMaxHeight().navigationBarsPadding().imePadding()) {
            SheetHeader(stringResource(R.string.search_title), stringResource(R.string.search_done), dismiss)
            StarlingsField(
                query, { query = it }, stringResource(R.string.search_title),
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp).focusRequester(focus),
            )
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                if (emptyQuery) {
                    val sections = SearchPalette.emptySections(ranked, recents)
                    if (sections.recent.isNotEmpty()) item("recent") { RowSection(stringResource(R.string.search_recent), sections.recent, ::open) { verbsFor = it } }
                    item("goto") { RowSection(stringResource(R.string.search_go_to), sections.goTo, ::open) { verbsFor = it } }
                    if (sections.verbs.isNotEmpty()) item("do") { RowSection(stringResource(R.string.search_do), sections.verbs, ::open) { verbsFor = it } }
                } else {
                    val tail = SearchPalette.docTail(ranked, docHits) { it.id }
                    if (ranked.isEmpty() && tail.isEmpty()) {
                        item("empty") {
                            Text(
                                stringResource(if (hitsPartial) R.string.search_partial else R.string.search_nothing),
                                Modifier.padding(horizontal = 16.dp),
                                style = StarlingsType.body, color = c.secondary,
                            )
                        }
                    } else {
                        if (ranked.isNotEmpty()) item("rows") { RowSection(null, ranked, ::open) { verbsFor = it } }
                        if (tail.isNotEmpty()) {
                            item("docs") {
                                ListSection(stringResource(R.string.search_docs)) {
                                    tail.forEachIndexed { index, hit ->
                                        DocHitRow(hit, divider = index < tail.lastIndex) { open(SearchPalette.documentRow(hit.id, hit.title), null) }
                                    }
                                }
                            }
                        }
                        if (hitsPartial) {
                            item("partial") {
                                Text(stringResource(R.string.search_partial), Modifier.padding(horizontal = 16.dp), style = StarlingsType.body, color = c.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    verbsFor?.let { row ->
        val verbs = SearchPalette.verbs(row)
        AlertDialog(
            onDismissRequest = { verbsFor = null },
            title = { Text(row.title, style = StarlingsType.headline, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            text = {
                Column {
                    verbs.forEach { verb ->
                        TextButton({ open(row, verb) }, Modifier.fillMaxWidth()) {
                            Text(verbTitle(verb), style = StarlingsType.body, color = c.accent)
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton({ verbsFor = null }) { Text(stringResource(R.string.search_cancel), color = c.primary) } },
            containerColor = c.elevated,
            titleContentColor = c.primary,
        )
    }
}

@Composable
private fun RowSection(header: String?, rows: List<SearchRow>, open: (SearchRow, SearchRowVerb?) -> Unit, showVerbs: (SearchRow) -> Unit) {
    ListSection(header) {
        rows.forEachIndexed { index, row ->
            ResultRow(row, divider = index < rows.lastIndex, open = { open(row, null) }, showVerbs = { showVerbs(row) })
        }
    }
}

/** `searchRow`: title over subtitle, the kind in small capitals, and the verbs' chevron. */
@Composable
private fun ResultRow(row: SearchRow, divider: Boolean, open: () -> Unit, showVerbs: () -> Unit) {
    val c = Starlings.colors
    val hasVerbs = SearchPalette.verbs(row).isNotEmpty()
    ListRow(Modifier.clickable(role = Role.Button, onClick = open), divider = divider) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(row.title, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (row.subtitle.isNotEmpty()) {
                    Text(row.subtitle, style = StarlingsType.footnote, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.width(8.dp))
            Text(kindLabel(row.kind).uppercase(Locale.getDefault()), style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
            if (hasVerbs) {
                val label = stringResource(R.string.search_row_verbs)
                Box(
                    Modifier
                        .padding(start = 6.dp)
                        .size(32.dp)
                        .clickable(role = Role.Button, onClick = showVerbs)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(18.dp), tint = c.secondary)
                }
            }
        }
    }
}

/** `docRow`: a full-text hit, its snippet in two lines under the title. */
@Composable
private fun DocHitRow(hit: DocsSearchHit, divider: Boolean, open: () -> Unit) {
    val c = Starlings.colors
    ListRow(Modifier.clickable(role = Role.Button, onClick = open), divider = divider) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(hit.title, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(SearchPalette.snippetText(hit.snippet), style = StarlingsType.footnote, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** The door rows' titles in this device's language, so the matcher reads what the person sees, as on iOS. */
@Composable
private fun doorTitles(): Map<SearchDoor, String> {
    val map = mutableMapOf<SearchDoor, String>()
    MemberSurface.entries.forEach { surface ->
        SearchDestination.read(surface.id)?.let { map[SearchDoor.Destination(it)] = stringResource(surface.titleResource) }
    }
    map[SearchDoor.Verb(SearchVerb.START_ROOM)] = stringResource(R.string.search_verb_start_room)
    map[SearchDoor.Verb(SearchVerb.OPEN_INTERNAL_ROOM)] = stringResource(R.string.search_verb_open_team_room)
    return map
}

@Composable
private fun kindLabel(kind: SearchKind): String = stringResource(
    when (kind) {
        SearchKind.SUBJECT -> R.string.search_kind_subject
        SearchKind.PERSON -> R.string.search_kind_person
        SearchKind.AGENT -> R.string.search_kind_agent
        SearchKind.CONTACT -> R.string.search_kind_contact
        SearchKind.THREAD -> R.string.search_kind_thread
        SearchKind.DOCUMENT -> R.string.search_kind_document
        SearchKind.FOLDER -> R.string.search_kind_folder
        SearchKind.EVENT -> R.string.search_kind_event
        SearchKind.TASK -> R.string.search_kind_task
        SearchKind.ISSUE -> R.string.search_kind_issue
        SearchKind.GOAL -> R.string.search_kind_goal
        SearchKind.DECISION -> R.string.search_kind_decision
        SearchKind.MILESTONE -> R.string.search_kind_milestone
        SearchKind.CALL -> R.string.search_kind_call
        SearchKind.CORE -> R.string.search_kind_core
        SearchKind.DESTINATION -> R.string.search_go_to
        SearchKind.SETTINGS -> R.string.search_kind_settings
        SearchKind.VERB -> R.string.search_do
    },
)

@Composable
private fun verbTitle(verb: SearchRowVerb): String = stringResource(
    when (verb) {
        is SearchRowVerb.Person -> when (verb.verb) {
            SearchPersonVerb.MESSAGE -> R.string.search_verb_message
            SearchPersonVerb.WAVE -> R.string.search_verb_wave
            SearchPersonVerb.CALL -> R.string.search_verb_call
        }
        is SearchRowVerb.Subject -> when (verb.verb) {
            SearchSubjectVerb.NEW_TASK -> R.string.search_verb_new_task
            SearchSubjectVerb.NEW_ISSUE -> R.string.search_verb_new_issue
            SearchSubjectVerb.NEW_DOCUMENT -> R.string.search_verb_new_document
            SearchSubjectVerb.START_ROOM -> R.string.search_verb_meet_about
        }
    },
)
