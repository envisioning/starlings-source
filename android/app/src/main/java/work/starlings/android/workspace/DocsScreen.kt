package work.starlings.android.workspace

import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Link
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.ui.ProminentIconButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.docs.DocsCreateDocument
import work.starlings.android.workspace.docs.DocsData
import work.starlings.android.workspace.docs.DocsFiling
import work.starlings.android.workspace.docs.DocsGraphPane
import work.starlings.android.workspace.docs.DocsListPage
import work.starlings.android.workspace.docs.DocsRail
import work.starlings.android.workspace.docs.DocsRailState
import work.starlings.android.workspace.docs.DocsReader
import work.starlings.android.workspace.docs.DocsRoute
import work.starlings.android.workspace.home.HomeRecents
import work.starlings.android.workspace.team.TeamMedia
import work.starlings.android.workspace.home.RecentRows
import work.starlings.android.workspace.docs.DocsSelection
import work.starlings.android.workspace.docs.LinkSaveSheet
import work.starlings.android.workspace.docs.NewDocumentSheet
import work.starlings.android.workspace.docs.docsSelectionTitle

/** One page pushed over the rail: a list, or a document. */
private sealed interface DocsPage {
    data class List(val selection: DocsSelection) : DocsPage
    data class Read(val id: String, val title: String) : DocsPage
    /** The rail's Explore row: `MobileDocsGraphScreen`. */
    data object Graph : DocsPage
}

/** Where a sheet writes: the rail (null) or the list on top. */
private data class DocsSheet(val selection: DocsSelection?, val link: Boolean)

/**
 * The Docs tab: `MobileDocsView` (iOS/MobileDocsView.swift). The rail on
 * the first screen, under the large title and the search field; a typed
 * query swaps the rail for the search's list. A row pushes its list, a
 * document pushes the editor; Back pops one page. The rail and each list
 * wear Save link and the prominent `+` (New document) where iOS does: the
 * rail files under `/work`, a list under its own folder or subject.
 */
@Composable
fun DocsScreen(account: OwnerAccount) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val data = remember(account) { DocsData(account.client, account.snapshots, TeamMedia(account)) { account.session.credentials()?.email } }
    val rail = remember(data) { DocsRailState(data) }
    val stack = remember { mutableStateListOf<DocsPage>() }
    var query by rememberSaveable { mutableStateOf("") }
    var sheet by remember { mutableStateOf<DocsSheet?>(null) }
    // Moves when a document was made or saved: the list under it reads again.
    var revision by remember { mutableIntStateOf(0) }

    LaunchedEffect(rail) { rail.load() }
    BackHandler(enabled = stack.isNotEmpty()) { stack.removeAt(stack.lastIndex) }

    val openDocument: (String, String) -> Unit = { id, title -> stack.add(DocsPage.Read(id, title)) }

    // A web path from Search or Home (`DocsRoute`); a folder waits for the tree that names it.
    var folderRoute by remember { mutableStateOf<DocsRoute.Folder?>(null) }
    rememberWorkspaceRoute(MemberSurface.DOCS) { path ->
        when (val route = DocsRoute.parse(path)) {
            null -> Unit
            DocsRoute.Rail -> stack.clear()
            is DocsRoute.Document -> { stack.clear(); openDocument(route.id, "") }
            is DocsRoute.Folder -> folderRoute = route
            DocsRoute.NewDocument -> { stack.clear(); sheet = DocsSheet(null, link = false) }
        }
    }
    LaunchedEffect(folderRoute, rail.tree) {
        val route = folderRoute ?: return@LaunchedEffect
        val selection = DocsRoute.folder(route, rail.tree)
        if (selection == null) {
            if (rail.tree.isNotEmpty()) folderRoute = null
            return@LaunchedEffect
        }
        folderRoute = null
        stack.clear()
        stack.add(DocsPage.List(selection))
    }
    val createdMessage = stringResource(R.string.docs_created_from)

    /** `create()`: files the document, pushes it, and refreshes what is under it. */
    fun create(selection: DocsSelection?, title: String, category: String?) {
        if (title.isEmpty()) return
        scope.launch {
            try {
                val created = data.create(
                    DocsCreateDocument(
                        title = title,
                        folderPath = selection?.let(DocsFiling::createFolder) ?: DocsFiling.RAIL_FOLDER,
                        category = category,
                        subjects = selection?.let(DocsFiling::createSubjects).orEmpty(),
                        message = createdMessage,
                    ),
                )
                openDocument(created.id, created.title)
                revision++
                if (selection == null) rail.load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                toast(DocsData.describe(e), ToastTone.DANGER)
            }
        }
    }

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        when (val top = stack.lastOrNull()) {
            null -> {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.docs_title), Modifier.weight(1f), style = StarlingsType.largeTitle, color = c.primary)
                    CreateActions(canSaveLink = true, canCreate = true, onSaveLink = { sheet = DocsSheet(null, link = true) }, onCreate = { sheet = DocsSheet(null, link = false) })
                }
                Box(Modifier.padding(horizontal = 16.dp).padding(bottom = 6.dp)) {
                    StarlingsField(query, { query = it }, stringResource(R.string.docs_search), trailingInset = if (query.isEmpty()) 0.dp else 32.dp)
                    if (query.isNotEmpty()) {
                        IconButton(onClick = { query = "" }, Modifier.align(Alignment.CenterEnd)) {
                            Icon(Icons.Filled.Close, stringResource(R.string.docs_clear), tint = c.secondary)
                        }
                    }
                }
                val trimmed = query.trim()
                if (trimmed.isNotEmpty()) {
                    DocsListPage(DocsSelection.Search(trimmed), data, rail, { openDocument(it.id, it.title) }, revision)
                } else {
                    DocsRail(rail, onGraph = { stack.add(DocsPage.Graph) }) { stack.add(DocsPage.List(it)) }
                }
            }
            is DocsPage.List -> {
                PushedBar(docsSelectionTitle(top.selection, rail), { stack.removeAt(stack.lastIndex) }) {
                    CreateActions(
                        canSaveLink = DocsFiling.canSaveLink(top.selection),
                        canCreate = DocsFiling.canCreate(top.selection),
                        onSaveLink = { sheet = DocsSheet(top.selection, link = true) },
                        onCreate = { sheet = DocsSheet(top.selection, link = false) },
                    )
                }
                DocsListPage(top.selection, data, rail, { openDocument(it.id, it.title) }, revision)
            }
            DocsPage.Graph -> {
                PushedBar(stringResource(R.string.docs_graph_title), { stack.removeAt(stack.lastIndex) })
                DocsGraphPane(data, { openDocument(it.id, it.title) })
            }
            is DocsPage.Read -> {
                // The toolbar's star (`MobileFavoriteButton`), as iOS's editor wears it.
                PushedBar(top.title, { stack.removeAt(stack.lastIndex) }) { FavoriteButton(FavoriteTargets.document(top.id)) }
                DocsReader(top.id, data, rail) { loaded ->
                    // Opened by hand: into the device's recents, the list Home's Quick Access and Search share.
                    HomeRecents.remember(context, account.session.credentials()?.email.orEmpty(), RecentRows.document(loaded.id, loaded.title))
                    // Opened by a path, the page had no title until the document answered.
                    if (top.title.isEmpty()) {
                        val at = stack.indexOf(top)
                        if (at >= 0) stack[at] = top.copy(title = loaded.title)
                    }
                }
            }
        }
    }

    when (val open = sheet) {
        null -> Unit
        else -> if (open.link) {
            val selection = open.selection
            LinkSaveSheet(
                data,
                folderPath = selection?.let(DocsFiling::linkFolder),
                subjects = selection?.let(DocsFiling::createSubjects).orEmpty(),
                onSaved = { saved ->
                    openDocument(saved.id, saved.title)
                    revision++
                    if (selection == null) scope.launch { rail.load() }
                },
                onDismiss = { sheet = null },
            )
        } else {
            val selection = open.selection
            val folder = selection?.let(DocsFiling::createFolder)
            NewDocumentSheet(
                note = if (folder == null) stringResource(R.string.docs_filed_in_work) else stringResource(R.string.docs_filed_in_folder, folder),
                categories = rail.categoryChoices,
                onCreate = { title, category -> create(selection, title, category) },
                onDismiss = { sheet = null },
            )
        }
    }
}

/** The toolbar's Save link and the prominent `+`, each only where it can act. */
@Composable
private fun CreateActions(canSaveLink: Boolean, canCreate: Boolean, onSaveLink: () -> Unit, onCreate: () -> Unit) {
    val c = Starlings.colors
    if (canSaveLink) {
        IconButton(onClick = onSaveLink) { Icon(Icons.Filled.Link, stringResource(R.string.docs_save_link), tint = c.primary) }
    }
    if (canCreate) {
        ProminentIconButton(Icons.Filled.Add, stringResource(R.string.docs_new_document), onCreate)
    }
}

/** A pushed page's bar: Back, the inline title, then the page's own actions. */
@Composable
private fun PushedBar(title: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}) {
    val c = Starlings.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back), tint = c.primary)
        }
        Text(title, Modifier.weight(1f).padding(end = 8.dp), style = StarlingsType.headline, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        actions()
        Spacer(Modifier.padding(end = 4.dp))
    }
}
