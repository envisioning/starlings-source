package work.starlings.android.workspace.docs

import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Comment
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.outlined.Draw
import androidx.compose.material.icons.outlined.IosShare
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.CategoryPicker
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.LoadingState
import work.starlings.android.ui.MarkdownText
import work.starlings.android.ui.PlainButton
import work.starlings.android.ui.RetryState
import work.starlings.android.ui.SmallChip
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import java.io.File

/**
 * DocsUI's `DocumentEditorModel`: one document, its edit fields, and the
 * save cycle. Every edit lands in [drafts] at once and on the server after
 * [DocsEditing.AUTOSAVE_DELAY_MS] of quiet, carrying the hash that was read.
 * When Docs says the body moved, [conflict] holds its version and the
 * person chooses; nothing is overwritten by accident.
 */
@Stable
class DocsEditorModel(
    val documentId: String,
    private val data: DocsData,
    private val drafts: DocsDrafts,
    private val scope: CoroutineScope,
) {
    var document by mutableStateOf<DocsDocumentDetail?>(null)
        private set
    var title by mutableStateOf("")
    var body by mutableStateOf("")
    var category by mutableStateOf<String?>(null)
    var categories by mutableStateOf<List<Pair<String, String>>>(emptyList())
        private set
    var version by mutableStateOf(0)
        private set
    var saveState by mutableStateOf<DocsSaveState>(DocsSaveState.Clean)
        private set
    var loadError by mutableStateOf<String?>(null)
        private set
    /** The server's detail when a save was refused for `hash_mismatch`. */
    var conflict by mutableStateOf<DocsDocumentDetail?>(null)
        private set

    private var saved = DocsEditFields("", "", null)
    private var contentHash = ""
    private var autosave: Job? = null

    private val current get() = DocsEditFields(title, body, category)

    suspend fun load() {
        if (categories.isEmpty()) data.cachedCategories()?.let { list -> categories = list.map { it.id to it.label } }
        try {
            val detail = data.document(documentId)
            apply(detail)
            // A draft that survived a crash outranks the server body, only when it differs.
            val draft = drafts.read(documentId)
            if (DocsEditing.draftWins(draft, detail.bodyMd)) {
                body = draft.orEmpty()
                saveState = DocsSaveState.Dirty
                schedule()
            }
            loadError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            loadError = DocsData.describe(e)
        }
        // A failure keeps the last list; the picker still shows this document's own.
        try {
            categories = data.categories().map { it.id to it.label }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    /** `edited()`: called on every change of the title, the body or the category. */
    fun edited() {
        if (document == null || conflict != null) return
        if (!DocsEditing.isDirty(saved, current)) {
            if (saveState == DocsSaveState.Dirty) saveState = DocsSaveState.Clean
            return
        }
        drafts.write(documentId, body)
        saveState = DocsSaveState.Dirty
        schedule()
    }

    /** Save now, if there is anything to save: on leaving and on Retry. */
    suspend fun flush() {
        autosave?.cancel()
        save()
    }

    /** `ConflictChoice`: take the server's body, or write mine over it with its hash. */
    suspend fun resolve(keepMine: Boolean) {
        val theirs = conflict ?: return
        if (keepMine) {
            contentHash = theirs.contentHash
            conflict = null
            save()
        } else {
            apply(theirs)
            drafts.clear(documentId)
            conflict = null
        }
    }

    private fun schedule() {
        autosave?.cancel()
        autosave = scope.launch {
            delay(DocsEditing.AUTOSAVE_DELAY_MS)
            save()
        }
    }

    private suspend fun save() {
        val shown = document ?: return
        if (!shown.editable || conflict != null) return
        val sending = current
        val update = DocsEditing.update(saved, sending, contentHash)
        if (update == null) {
            saveState = DocsSaveState.Clean
            return
        }
        saveState = DocsSaveState.Saving
        try {
            val updated = data.update(documentId, update)
            contentHash = updated.contentHash
            version = updated.version
            saved = DocsEditing.savedAfter(sending)
            document = updated
            if (body == sending.body) drafts.clear(documentId)
            // Edits that landed while the request was out go on the next tick.
            saveState = if (DocsEditing.isDirty(saved, current)) DocsSaveState.Dirty else DocsSaveState.Clean
            if (saveState == DocsSaveState.Dirty) schedule()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (DocsData.isHashMismatch(e)) {
                try {
                    conflict = data.document(documentId)
                } catch (inner: CancellationException) {
                    throw inner
                } catch (_: Exception) {
                    saveState = DocsSaveState.Failed(CHANGED_ELSEWHERE)
                }
            } else {
                saveState = DocsSaveState.Failed(DocsData.describe(e))
            }
        }
    }

    /**
     * `apply(shared:)`: the Share sheet flipped the www switch. Visibility is
     * not part of the edit cycle (no hash, no draft), so only the detail is replaced.
     */
    fun applyShared(updated: DocsDocumentDetail) {
        if (updated.id != documentId) return
        document = updated
    }

    private fun apply(detail: DocsDocumentDetail) {
        document = detail
        title = detail.title
        body = detail.bodyMd.orEmpty()
        category = detail.category
        version = detail.version
        contentHash = detail.contentHash
        saved = DocsEditFields.of(detail)
        saveState = DocsSaveState.Clean
    }

    private companion object {
        /** An error, so English (AGENTS.md), as DocsUI words it. */
        const val CHANGED_ELSEWHERE = "This document changed elsewhere; couldn’t fetch the latest."
    }
}

/** Where the save on leaving runs: the editor's own scope ends with the screen. */
private val leavingSaves = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

/**
 * One document, editable: DocsUI's `DocumentEditor`, as iOS pushes it. A
 * title field over a Markdown text editor with a preview toggle, the whole
 * authoring surface on purpose. A mirrored document, and any document in
 * preview, reads as Markdown with its comments under the text.
 */
@Composable
fun DocsReader(documentId: String, data: DocsData, rail: DocsRailState, onLoaded: (DocsDocumentDetail) -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val model = remember(documentId) {
        DocsEditorModel(documentId, data, DocsDrafts(File(context.filesDir, "docs-drafts")), scope)
    }
    LaunchedEffect(model) { model.load() }
    // Leaving saves what is left (`onDisappear`): on a scope that outlives the screen.
    DisposableEffect(model) { onDispose { leavingSaves.launch { model.flush() } } }

    val shown = model.document
    // Once per document: the page names it, and it goes into the recents.
    val loadedId = shown?.id
    LaunchedEffect(loadedId) { shown?.let(onLoaded) }
    val conflict = model.conflict
    val failure = model.loadError
    when {
        conflict != null -> ConflictView(model.body, conflict) { keepMine -> scope.launch { model.resolve(keepMine) } }
        shown != null -> Editor(shown, model, data, rail)
        failure != null -> RetryState(
            stringResource(R.string.docs_open_failed), failure, stringResource(R.string.docs_retry),
            { scope.launch { model.load() } },
        )
        else -> LoadingState(stringResource(R.string.docs_opening))
    }
}

@Composable
private fun Editor(document: DocsDocumentDetail, model: DocsEditorModel, data: DocsData, rail: DocsRailState) {
    val c = Starlings.colors
    val uri = LocalUriHandler.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Core's registry names and finds the subjects once Core is linked on this device (`CoreSubjectDirectory`).
    val core = remember { work.starlings.android.core.CoreAccess.of(context) }
    val directory = remember(data, core.isLinked) { DocsSubjectDirectory(data, if (core.isLinked) CoreDocsSource(core) else null) }
    var preview by remember(document.id) { mutableStateOf(false) }
    var sharing by remember(document.id) { mutableStateOf(false) }
    var signing by remember(document.id) { mutableStateOf(false) }
    if (sharing) {
        DocsShareSheet(document.id, model.title, document.visibility, data, onVisibility = model::applyShared) { sharing = false }
    }
    if (signing) {
        DocsSignatureSheet(document.id, model.title, data) { signing = false }
    }
    fun open(url: String) = runCatching { uri.openUri(url) }
    val reading = preview || !document.editable
    val bodyFocus = remember(document.id) { FocusRequester() }
    val titleLabel = stringResource(R.string.docs_field_title)

    Column(Modifier.fillMaxSize().imePadding()) {
        // The title row: the field, the category, the preview toggle, Open in Docs.
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                value = model.title,
                onValueChange = { model.title = it; model.edited() },
                modifier = Modifier.weight(1f).semantics { contentDescription = titleLabel },
                enabled = document.editable,
                textStyle = StarlingsType.title2.copy(fontWeight = FontWeight.SemiBold, color = c.primary),
                cursorBrush = SolidColor(c.accent),
                // `onSubmit { bodyFocused = true }`: a title is one line, and Next goes to the text.
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                keyboardActions = KeyboardActions(onNext = { if (!reading) runCatching { bodyFocus.requestFocus() } }),
                decorationBox = { inner ->
                    Box {
                        if (model.title.isEmpty()) {
                            Text(stringResource(R.string.docs_field_title), style = StarlingsType.title2.copy(fontWeight = FontWeight.SemiBold), color = c.secondary.copy(alpha = 0.7f))
                        }
                        inner()
                    }
                },
            )
            if (document.editable) {
                if (!document.isLinkSave) {
                    CategoryPicker(
                        model.category, model.categories, stringResource(R.string.docs_no_category), stringResource(R.string.docs_category),
                        { model.category = it; model.edited() },
                    )
                }
                IconButton(onClick = { preview = !preview }) {
                    Icon(
                        if (preview) Icons.Filled.Visibility else Icons.Outlined.Visibility,
                        stringResource(if (preview) R.string.docs_edit else R.string.docs_preview),
                        tint = c.primary,
                    )
                }
            } else {
                document.category?.let { Text(rail.label(it), style = StarlingsType.footnote, color = c.secondary) }
            }
            // DocsUI's Share and, on a written document, Send for signature.
            IconButton(onClick = { sharing = true }) {
                Icon(Icons.Outlined.IosShare, stringResource(R.string.docs_share), tint = c.primary)
            }
            if (!document.isLinkSave) {
                IconButton(onClick = { signing = true }) {
                    Icon(Icons.Outlined.Draw, stringResource(R.string.docs_sign_title), tint = c.primary)
                }
            }
            IconButton(onClick = { open(DocsRules.publicLink(document.path)) }) {
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, stringResource(R.string.docs_open_in, stringResource(R.string.docs_title)), tint = c.primary)
            }
        }

        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // Who touched it and when: the line the web draws under the title.
            val by = document.updatedBy?.takeIf { it.isNotEmpty() }
            val label = DocsRules.updatedLabel(document.updatedAt)
            val stamp = label?.let { if (document.editable) it else stringResource(R.string.docs_synced, it) }
            val meta = listOfNotNull(by, stamp)
            if (meta.isNotEmpty()) Text(meta.joinToString(" · "), style = StarlingsType.footnote, color = c.secondary)

            if (document.isLinkSave) {
                DocsLinkHeader(document, data)
                DocsImagesStrip(document.id, document.images.orEmpty(), data, document.editable) {
                    // Images are not part of the edit cycle (no hash, no draft): only the detail is replaced.
                    scope.launch {
                        try {
                            model.applyShared(data.document(document.id))
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                        }
                    }
                }
            }

            // DocsUI's `SubjectEditor`, on the Worker's CRM (`DocsSubjectDirectory`).
            DocsSubjectEditor(
                document.id, document.subjects, data, directory,
                onChanged = model::applyShared,
                onError = { toast(it, ToastTone.DANGER) },
            )

            if (!document.editable) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    // Decorative: the sentence beside it says the same.
                    Icon(Icons.Outlined.Lock, null, Modifier.size(14.dp), tint = c.secondary)
                    Text(stringResource(R.string.docs_mirrored), Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary)
                    document.sourceUrl?.let { source ->
                        val system = document.sourceSystem.replaceFirstChar(Char::uppercaseChar)
                        PlainButton(stringResource(R.string.docs_open_in, system), { open(source) }, color = c.accentMark)
                    }
                }
            }
            Spacer(Modifier.height(0.dp))
        }
        HorizontalDivider(thickness = 1.dp, color = c.border)

        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (reading) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    MarkdownText(model.body)
                    // Comments read under the text. A comment is made on the rendered page, never beside the field.
                    HorizontalDivider(thickness = 1.dp, color = c.border)
                    DocsComments(document.id, data)
                }
            } else {
                BasicTextField(
                    value = model.body,
                    onValueChange = { model.body = it; model.edited() },
                    modifier = Modifier.fillMaxSize().focusRequester(bodyFocus).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 10.dp),
                    textStyle = StarlingsType.body.copy(fontFamily = FontFamily.Monospace, color = c.primary),
                    cursorBrush = SolidColor(c.accent),
                )
            }
        }

        HorizontalDivider(thickness = 1.dp, color = c.border)
        Footer(document, model, preview, onPreview = { preview = true }, onRetry = { scope.launch { model.flush() } })
    }
}

/** `footer`: the open comments (in the editor), the save state, the path. */
@Composable
private fun Footer(document: DocsDocumentDetail, model: DocsEditorModel, preview: Boolean, onPreview: () -> Unit, onRetry: () -> Unit) {
    val c = Starlings.colors
    val style = StarlingsType.footnote
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (document.editable && !preview && document.openAnnotations > 0) {
            Row(
                Modifier.padding(vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.AutoMirrored.Outlined.Comment, null, Modifier.size(14.dp), tint = c.accentMark)
                PlainButton(
                    pluralStringResource(R.plurals.docs_open_comments, document.openAnnotations, document.openAnnotations),
                    onPreview, color = c.accentMark,
                )
            }
        }
        when (val state = model.saveState) {
            DocsSaveState.Clean -> Text(
                if (document.editable) stringResource(R.string.docs_saved_version, model.version) else stringResource(R.string.docs_mirrored),
                style = style, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            DocsSaveState.Dirty -> Text(stringResource(R.string.docs_unsaved), style = style, color = c.secondary)
            DocsSaveState.Saving -> {
                CircularProgressIndicator(Modifier.size(12.dp), color = c.secondary, strokeWidth = 1.5.dp)
                Text(stringResource(R.string.docs_saving), style = style, color = c.secondary)
            }
            is DocsSaveState.Failed -> {
                Icon(Icons.Outlined.WarningAmber, null, Modifier.size(14.dp), tint = c.danger)
                Text(state.message, Modifier.weight(1f, fill = false), style = style, color = c.secondary, maxLines = 2)
                PlainButton(stringResource(R.string.docs_retry), onRetry, color = c.accentMark)
            }
        }
        Spacer(Modifier.weight(1f))
        Text(document.path, style = style, color = c.secondary, maxLines = 1, overflow = TextOverflow.StartEllipsis)
    }
}

/** `ConflictView`: the server said the body moved. Both are shown whole; the person picks. */
@Composable
private fun ConflictView(mine: String, theirs: DocsDocumentDetail, choose: (keepMine: Boolean) -> Unit) {
    val c = Starlings.colors
    Column(Modifier.fillMaxSize().padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.AutoMirrored.Outlined.CallSplit, null, Modifier.size(18.dp), tint = c.primary)
                Text(stringResource(R.string.docs_changed_elsewhere), style = StarlingsType.headline, color = c.primary)
            }
            Text(
                stringResource(R.string.docs_changed_elsewhere_detail, theirs.updatedBy ?: stringResource(R.string.docs_someone), theirs.version),
                style = StarlingsType.footnote, color = c.secondary,
            )
        }
        // Side by side on iOS; stacked here, where a phone is narrow.
        Column(Modifier.weight(1f).fillMaxWidth()) {
            ConflictColumn(stringResource(R.string.docs_mine), mine, Modifier.weight(1f))
            HorizontalDivider(thickness = 1.dp, color = c.border)
            ConflictColumn(stringResource(R.string.docs_theirs, theirs.version), theirs.bodyMd.orEmpty(), Modifier.weight(1f))
        }
        HorizontalDivider(thickness = 1.dp, color = c.border)
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
        ) {
            BorderedButton(stringResource(R.string.docs_use_theirs), { choose(false) }, compact = true)
            FilledButton(stringResource(R.string.docs_keep_mine), { choose(true) }, compact = true)
        }
    }
}

@Composable
private fun ConflictColumn(heading: String, text: String, modifier: Modifier) {
    val c = Starlings.colors
    Column(modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(heading, Modifier.padding(horizontal = 16.dp), style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
        Text(
            text,
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            style = StarlingsType.body.copy(fontFamily = FontFamily.Monospace), color = c.primary,
        )
    }
}

/**
 * DocsUI's `CommentsPane`: the threads, a reply, resolve and reopen by any
 * member, and a new thread on the whole document. A comment written here
 * has no anchor, as on iOS; one written on the web shows its quote. Open
 * threads show; resolved ones wait behind "N resolved".
 */
@Composable
private fun DocsComments(documentId: String, data: DocsData) {
    val c = Starlings.colors
    var annotations by remember(documentId) { mutableStateOf<List<DocsAnnotation>>(emptyList()) }
    var loaded by remember(documentId) { mutableStateOf(false) }
    var error by remember(documentId) { mutableStateOf<String?>(null) }
    var composing by remember(documentId) { mutableStateOf(false) }
    var showResolved by remember(documentId) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun attempt(block: suspend () -> Unit) {
        try {
            block()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = DocsData.describe(e)
        }
    }

    LaunchedEffect(documentId) {
        attempt { annotations = data.annotations(documentId) }
        loaded = true
    }

    val threads = DocsRules.threads(annotations)
    val open = threads.filter { it.isOpen }
    val resolved = threads.filterNot { it.isOpen }

    suspend fun post(body: String, parentId: String?) = attempt { annotations = annotations + data.post(documentId, body, parentId) }
    fun setStatus(thread: DocsThread, status: String) {
        scope.launch {
            attempt {
                val updated = data.setStatus(thread.root.id, status)
                annotations = annotations.map { if (it.id == updated.id) updated else it }
            }
        }
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                stringResource(R.string.docs_comments).uppercase(),
                style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold), color = c.secondary,
            )
            if (open.isNotEmpty()) Text("${open.size}", style = StarlingsType.footnote, color = c.secondary)
            Spacer(Modifier.weight(1f))
            if (resolved.isNotEmpty()) {
                Text(
                    if (showResolved) stringResource(R.string.docs_hide_resolved) else stringResource(R.string.docs_resolved_count, resolved.size),
                    Modifier
                        .clickable(role = Role.Button) { showResolved = !showResolved }
                        .padding(horizontal = 4.dp, vertical = 8.dp),
                    style = StarlingsType.footnote, color = c.accentMark,
                )
            }
            IconButton(onClick = { composing = true }, enabled = !composing) {
                Icon(Icons.Outlined.AddComment, stringResource(R.string.docs_new_comment), tint = c.primary)
            }
        }
        error?.let { Text(it, style = StarlingsType.footnote, color = c.danger) }
        if (composing) {
            Composer(
                stringResource(R.string.docs_comment_placeholder), stringResource(R.string.docs_comment_submit),
                onSubmit = { post(it, null); composing = false }, onCancel = { composing = false },
            )
        }
        if (loaded && threads.isEmpty() && !composing) {
            Text(stringResource(R.string.docs_no_comments), style = StarlingsType.footnote, color = c.secondary)
        }
        open.forEach { thread ->
            ThreadView(thread, onReply = { body -> post(body, thread.root.id) }, onStatus = { setStatus(thread, it) })
        }
        if (showResolved) {
            resolved.forEach { thread ->
                ThreadView(thread, onReply = { body -> post(body, thread.root.id) }, onStatus = { setStatus(thread, it) })
            }
        }
    }
}

@Composable
private fun ThreadView(thread: DocsThread, onReply: suspend (String) -> Unit, onStatus: (String) -> Unit) {
    val c = Starlings.colors
    var replying by remember(thread.id) { mutableStateOf(false) }
    val orphaned = thread.root.orphaned == true
    Column(
        Modifier
            .fillMaxWidth()
            .alpha(if (thread.isOpen) 1f else 0.7f)
            .background(c.panel, RoundedCornerShape(10.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        thread.root.anchor?.quote?.takeIf { it.isNotEmpty() }?.let { quote ->
            Row(Modifier.height(IntrinsicSize.Min)) {
                Box(Modifier.width(2.dp).fillMaxHeight().background(if (orphaned) c.secondary.copy(alpha = 0.3f) else c.accent))
                Spacer(Modifier.width(8.dp))
                Text(
                    quote, maxLines = 3,
                    style = StarlingsType.footnote.copy(textDecoration = if (orphaned) TextDecoration.LineThrough else null),
                    color = c.secondary,
                )
            }
        }
        if (orphaned) Text(stringResource(R.string.docs_passage_gone), style = StarlingsType.caption, color = c.secondary)
        CommentView(thread.root)
        thread.replies.forEach { CommentView(it, Modifier.padding(start = 12.dp)) }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (!replying) PlainButton(stringResource(R.string.docs_reply), { replying = true }, color = c.accentMark)
            if (thread.isOpen) {
                PlainButton(stringResource(R.string.docs_resolve), { onStatus("resolved") }, color = c.accentMark)
            } else {
                PlainButton(stringResource(R.string.docs_reopen), { onStatus("open") }, color = c.accentMark)
            }
        }
        if (replying) {
            Composer(
                stringResource(R.string.docs_reply_placeholder), stringResource(R.string.docs_reply_submit),
                onSubmit = { onReply(it); replying = false }, onCancel = { replying = false },
            )
        }
    }
}

@Composable
private fun CommentView(annotation: DocsAnnotation, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(annotation.who, style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
            if (annotation.authorKind == "agent") SmallChip(stringResource(R.string.docs_agent))
            DocsRules.updatedLabel(annotation.createdAt)?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
        }
        MarkdownText(annotation.bodyMd, base = StarlingsType.footnote)
    }
}

/** DocsUI's comment composer: a field that grows to six lines, the submit and Cancel. */
@Composable
private fun Composer(placeholder: String, submit: String, onSubmit: suspend (String) -> Unit, onCancel: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val body = text.trim()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        StarlingsField(text, { text = it }, placeholder, singleLine = false, maxLines = 6)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            FilledButton(
                submit,
                {
                    busy = true
                    scope.launch {
                        try { onSubmit(body); text = "" } finally { busy = false }
                    }
                },
                enabled = !busy && body.isNotEmpty(),
                compact = true,
            )
            PlainButton(stringResource(R.string.docs_cancel), onCancel)
        }
    }
}
