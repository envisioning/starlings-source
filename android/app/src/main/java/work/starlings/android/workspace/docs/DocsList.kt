package work.starlings.android.workspace.docs

import android.text.format.DateUtils
import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.EmptyState
import work.starlings.android.ui.PlaceholderRows
import work.starlings.android.ui.PlainButton
import work.starlings.android.ui.RetryState
import work.starlings.android.ui.SmallChip
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.FavoriteMenuItem
import work.starlings.android.workspace.FavoriteTargets
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** The words a selection's list wears: its title and what it says when empty (`MobileDocsSelection.title`, `emptyMessage`). */
@Composable
fun docsSelectionTitle(selection: DocsSelection, rail: DocsRailState): String = when (selection) {
    DocsSelection.Recent -> stringResource(R.string.docs_recent)
    DocsSelection.Links -> stringResource(R.string.docs_links)
    DocsSelection.Unfiled -> stringResource(R.string.docs_unfiled)
    is DocsSelection.Category -> rail.label(selection.category)
    is DocsSelection.Subject -> selection.title
    is DocsSelection.Folder -> selection.title
    is DocsSelection.Search -> "“${selection.query}”"
}

@Composable
private fun emptyMessage(selection: DocsSelection, rail: DocsRailState): String = when (selection) {
    DocsSelection.Recent -> stringResource(R.string.docs_recent_empty)
    DocsSelection.Links -> stringResource(R.string.docs_links_empty)
    DocsSelection.Unfiled -> stringResource(R.string.docs_unfiled_empty)
    is DocsSelection.Category -> stringResource(R.string.docs_category_empty, rail.label(selection.category).lowercase())
    is DocsSelection.Subject -> stringResource(R.string.docs_subject_empty)
    is DocsSelection.Folder -> stringResource(R.string.docs_folder_empty)
    is DocsSelection.Search -> stringResource(R.string.docs_search_empty, selection.query)
}

/**
 * One view, folder, subject or search as a list: `MobileDocsListView`.
 * The row's last list first (a snapshot), placeholder rows while the first
 * answer is out with none kept, Retry on a failure, the selection's own
 * empty line, and pull to refresh. [revision] moves when a document was
 * made or saved over this list, and the list reads again. A subject's pane
 * (`DocumentsPane`) passes [counted], for the count over the rows, and
 * [empty], its own empty state.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocsListPage(
    selection: DocsSelection,
    data: DocsData,
    rail: DocsRailState,
    onOpen: (DocsDocumentSummary) -> Unit,
    revision: Int = 0,
    counted: Boolean = false,
    empty: (@Composable () -> Unit)? = null,
) {
    val context = LocalContext.current
    var documents by remember(selection) { mutableStateOf<List<DocsDocumentSummary>>(emptyList()) }
    var loaded by remember(selection) { mutableStateOf(false) }
    var error by remember(selection) { mutableStateOf<String?>(null) }
    var refreshing by remember(selection) { mutableStateOf(false) }
    var renaming by remember(selection) { mutableStateOf<DocsDocumentSummary?>(null) }
    val scope = rememberCoroutineScope()
    val filing = rail.filing
    val words = FiledWords.of()

    suspend fun load() {
        // Last known first (docs/CACHING.md): the row's last list paints before Docs answers.
        val read = selection.read
        if (!loaded && read != null) {
            data.cachedDocuments(read)?.let { documents = it; loaded = true }
        }
        try {
            documents = if (selection is DocsSelection.Search) {
                data.search(selection.query).map(DocsDocumentSummary::of)
            } else if (read != null) {
                data.allDocuments(read)
            } else {
                emptyList()
            }
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = DocsData.describe(e)
        }
        loaded = true
    }

    fun toast(text: String, tone: ToastTone = ToastTone.NEUTRAL) = work.starlings.android.ui.toast(text, tone)

    // A row's write: a failure says so in a toast, as iOS's danger toast.
    fun attempt(block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                toast(DocsData.describe(e), ToastTone.DANGER)
            }
        }
    }

    val actions = DocsRowActions(
        onOpen = onOpen,
        onCopied = { toast(it) },
        filing = filing,
        onFile = { document, act ->
            attempt {
                val changed = data.file(listOf(document), act)
                if (changed > 0) {
                    toast(words.say(DocsFiling.filedMessage(act, changed, filing)))
                    load()
                }
            }
        },
        onRename = { renaming = it },
        onArchive = { document ->
            attempt {
                data.archive(document.id)
                documents = documents.filterNot { it.id == document.id }
            }
        },
    )

    LaunchedEffect(selection, revision) {
        // A search waits for the typing to settle; the next key cancels this one.
        if (selection is DocsSelection.Search) delay(250)
        load()
    }

    renaming?.let { document ->
        RenameDialog(document.title, onDismiss = { renaming = null }) { title ->
            renaming = null
            if (title.isNotEmpty() && title != document.title) {
                attempt {
                    data.update(document.id, DocsUpdateDocument(title = title))
                    load()
                }
            }
        }
    }

    val failure = error
    when {
        failure != null -> RetryState(
            stringResource(R.string.docs_list_failed), failure, stringResource(R.string.docs_retry),
            { error = null; loaded = false; scope.launch { load() } },
        )
        !loaded -> PlaceholderRows(5, stringResource(R.string.docs_loading))
        documents.isEmpty() -> if (empty != null) empty() else EmptyState(stringResource(R.string.docs_nothing_here), Icons.Outlined.Description, emptyMessage(selection, rail))
        else -> PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)) {
                if (counted) {
                    item(key = "count") {
                        Text(
                            pluralStringResource(R.plurals.docs_document_count, documents.size, documents.size),
                            Modifier.padding(bottom = 8.dp),
                            style = StarlingsType.footnote, color = Starlings.colors.secondary,
                        )
                    }
                }
                itemsIndexed(documents, key = { _, document -> document.id }) { index, document ->
                    val shape = RoundedCornerShape(
                        topStart = if (index == 0) StarlingsRadius.field else 0.dp,
                        topEnd = if (index == 0) StarlingsRadius.field else 0.dp,
                        bottomStart = if (index == documents.lastIndex) StarlingsRadius.field else 0.dp,
                        bottomEnd = if (index == documents.lastIndex) StarlingsRadius.field else 0.dp,
                    )
                    Column(Modifier.fillMaxWidth().background(Starlings.colors.panel, shape)) {
                        DocumentRow(document, rail, actions)
                        if (index < documents.lastIndex) {
                            HorizontalDivider(Modifier.padding(start = 44.dp), thickness = 1.dp, color = Starlings.colors.border)
                        }
                    }
                }
            }
        }
    }
}

/** What a row's long press can do: `DocumentRowMenu`'s callbacks. */
class DocsRowActions(
    val onOpen: (DocsDocumentSummary) -> Unit,
    val onCopied: (String) -> Unit,
    val filing: DocsFilingChoices,
    val onFile: (DocsDocumentSummary, DocsFilingAct) -> Unit,
    val onRename: (DocsDocumentSummary) -> Unit,
    val onArchive: (DocsDocumentSummary) -> Unit,
)

/** The filing toast's words (`DocsRailGroups.filedMessage`), read once per composition. */
private class FiledWords(
    private val takenOff: String,
    private val tookOff: String,
    private val cleared: String,
    private val clearedOn: String,
    private val filedIn: String,
    private val filedCount: String,
) {
    fun say(message: DocsFiledMessage): String = when (message) {
        is DocsFiledMessage.TakenOff -> if (message.changed == 1) takenOff.format(message.place) else tookOff.format(message.changed, message.place)
        is DocsFiledMessage.CategoryCleared -> if (message.changed == 1) cleared else clearedOn.format(message.changed)
        is DocsFiledMessage.FiledIn -> if (message.changed == 1) filedIn.format(message.place) else filedCount.format(message.changed, message.place)
    }

    companion object {
        @Composable
        fun of() = FiledWords(
            stringResource(R.string.docs_taken_off), stringResource(R.string.docs_took_off),
            stringResource(R.string.docs_category_cleared), stringResource(R.string.docs_category_cleared_on),
            stringResource(R.string.docs_filed_in), stringResource(R.string.docs_filed_count),
        )
    }
}

/** The Rename alert: the title in a field, Rename and Cancel. */
@Composable
private fun RenameDialog(current: String, onDismiss: () -> Unit, onRename: (String) -> Unit) {
    val c = Starlings.colors
    var title by remember { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(stringResource(R.string.docs_rename), style = StarlingsType.headline, color = c.primary) },
        text = { StarlingsField(title, { title = it }, stringResource(R.string.docs_field_title)) },
        confirmButton = { PlainButton(stringResource(R.string.docs_rename), { onRename(title.trim()) }, color = c.accentMark) },
        dismissButton = { PlainButton(stringResource(R.string.docs_cancel), onDismiss, color = c.primary) },
    )
}

/** Which page of the row menu shows: the root, File, or one of File's lists (iOS's submenus). */
private enum class MenuPage { ROOT, FILE, FOLDER, CATEGORY, PROJECT, LEAD, PARTNER }

/**
 * DocsUI's `DocumentRow`: the kind's symbol, the title, the category (or a
 * link's site) and the written, edited, version and editor line, the
 * subject chips, and a lock on a mirrored document. A long press opens
 * `DocumentRowMenu`: Open and Copy link, and on a document Starlings can
 * change File (`DocumentFileMenu`), Rename… and Archive.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DocumentRow(document: DocsDocumentSummary, rail: DocsRailState, actions: DocsRowActions) {
    val c = Starlings.colors
    val clipboard = LocalClipboardManager.current
    var menu by remember { mutableStateOf(false) }
    var page by remember { mutableStateOf(MenuPage.ROOT) }
    val copied = stringResource(R.string.docs_link_copied)
    val icon = when {
        document.isLinkSave -> Icons.Outlined.Link
        document.kind == "pdf" -> Icons.Outlined.PictureAsPdf
        document.transcript -> Icons.Outlined.FormatQuote
        else -> Icons.Outlined.Description
    }
    fun close() {
        menu = false
        page = MenuPage.ROOT
    }
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClickLabel = stringResource(R.string.docs_open),
                    onLongClickLabel = stringResource(R.string.more),
                    onLongClick = { page = MenuPage.ROOT; menu = true },
                    onClick = { actions.onOpen(document) },
                )
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Decorative: the title and the line under it say what the document is.
            Icon(icon, null, Modifier.padding(top = 2.dp).size(18.dp), tint = c.secondary)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(document.title, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    val lead = document.category?.let(rail::label) ?: document.link?.site
                    lead?.let { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    Text(rowSubtitle(document), style = StarlingsType.footnote, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (document.subjects.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        // Without the CRM's names a chip says the kind, as iOS without a directory.
                        document.subjects.forEach { SmallChip(it.kind.replaceFirstChar(Char::uppercaseChar)) }
                    }
                }
            }
            if (!document.editable) {
                val label = stringResource(R.string.docs_mirrored)
                Icon(Icons.Outlined.Lock, label, Modifier.size(14.dp), tint = c.secondary.copy(alpha = 0.6f))
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { close() }) {
            val choices = actions.filing
            when (page) {
                MenuPage.ROOT -> {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.docs_open)) },
                        leadingIcon = { Icon(Icons.Outlined.Description, null) },
                        onClick = { close(); actions.onOpen(document) },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.docs_copy_link)) },
                        leadingIcon = { Icon(Icons.Outlined.Link, null) },
                        onClick = {
                            close()
                            clipboard.setText(AnnotatedString(DocsRules.publicLink(document.path)))
                            actions.onCopied(copied)
                        },
                    )
                    if (document.editable) {
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.docs_file)) },
                            leadingIcon = { Icon(Icons.Outlined.Folder, null) },
                            trailingIcon = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) },
                            onClick = { page = MenuPage.FILE },
                        )
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.docs_rename_menu)) },
                            leadingIcon = { Icon(Icons.Outlined.Edit, null) },
                            onClick = { close(); actions.onRename(document) },
                        )
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.docs_archive), color = c.danger) },
                            leadingIcon = { Icon(Icons.Outlined.Archive, null, tint = c.danger) },
                            onClick = { close(); actions.onArchive(document) },
                        )
                    }
                    // `MobileFavoriteAction` after the row menu, on every document, as iOS.
                    HorizontalDivider()
                    FavoriteMenuItem(FavoriteTargets.document(document.id)) { close() }
                }
                MenuPage.FILE -> {
                    if (choices.folders.isNotEmpty()) MenuGroup(stringResource(R.string.docs_folder)) { page = MenuPage.FOLDER }
                    MenuGroup(stringResource(R.string.docs_category)) { page = MenuPage.CATEGORY }
                    if (choices.projects.isNotEmpty()) MenuGroup(stringResource(R.string.docs_project)) { page = MenuPage.PROJECT }
                    if (choices.leads.isNotEmpty()) MenuGroup(stringResource(R.string.docs_lead)) { page = MenuPage.LEAD }
                    if (choices.partners.isNotEmpty()) MenuGroup(stringResource(R.string.docs_partner)) { page = MenuPage.PARTNER }
                }
                MenuPage.FOLDER -> {
                    val here = DocsFiling.folderOf(document.path)
                    FolderItems(choices.folders, null, 0, here) { path -> close(); actions.onFile(document, DocsFilingAct.Folder(path)) }
                }
                MenuPage.CATEGORY -> {
                    Tick(stringResource(R.string.docs_no_category), document.category == null) {
                        close(); actions.onFile(document, DocsFilingAct.Category(null))
                    }
                    if (choices.categories.isNotEmpty()) HorizontalDivider()
                    choices.categories.forEach { category ->
                        Tick(category.label, document.category == category.category) {
                            close(); actions.onFile(document, DocsFilingAct.Category(category.category))
                        }
                    }
                }
                MenuPage.PROJECT, MenuPage.LEAD, MenuPage.PARTNER -> {
                    val subjects = when (page) {
                        MenuPage.PROJECT -> choices.projects
                        MenuPage.LEAD -> choices.leads
                        else -> choices.partners
                    }
                    subjects.forEach { choice ->
                        val about = DocsFiling.isAbout(document, choice.subject)
                        Tick(choice.title, about) {
                            close()
                            actions.onFile(document, if (about) DocsFilingAct.RemoveSubject(choice.subject) else DocsFilingAct.AddSubject(choice.subject))
                        }
                    }
                }
            }
        }
    }
}

/** One of File's groups: opens its list, as an iOS submenu. */
@Composable
private fun MenuGroup(title: String, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(title) },
        trailingIcon = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) },
        onClick = onClick,
    )
}

/** The folders as the tree they are: each under its parent, indented by depth. */
@Composable
private fun FolderItems(folders: List<DocsFolder>, parent: String?, depth: Int, here: String, onPick: (String) -> Unit) {
    DocsFiling.children(folders, parent).forEach { folder ->
        Tick(folder.title, here == folder.path, Modifier.padding(start = (depth * 12).dp)) { onPick(folder.path) }
        FolderItems(folders, folder.id, depth + 1, here, onPick)
    }
}

/** A menu item with the platform's tick when it is so. */
@Composable
private fun Tick(title: String, on: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(title, modifier) },
        trailingIcon = { if (on) Icon(Icons.Filled.Check, null) },
        modifier = Modifier.semantics { selected = on },
        onClick = onClick,
    )
}

/** `DocumentRow.subtitle`: written day · edited when · vN · who, in the reader's locale. */
@Composable
private fun rowSubtitle(document: DocsDocumentSummary): String {
    val facts = DocsRules.rowFacts(document, ZoneId.systemDefault())
    val edited = stringResource(R.string.docs_edited)
    val parts = mutableListOf<String>()
    facts.written?.let { parts += DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).format(it) }
    facts.edited?.let {
        val relative = DateUtils.getRelativeTimeSpanString(it.toEpochMilli(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
        parts += "$edited $relative"
    }
    facts.version?.let { parts += "v$it" }
    facts.who?.let { parts += it }
    return parts.joinToString(" · ")
}
