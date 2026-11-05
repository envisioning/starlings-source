package work.starlings.android.workspace.work

import androidx.compose.ui.platform.LocalView
import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.workspace.QuickNoteFiling
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.Search
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkRowAction
import work.starlings.android.ui.WorkRowMenu
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.android.ui.WorkSwipeRow
import work.starlings.android.workspace.home.HomeText
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.QuickNote
import work.starlings.contracts.QuickNotePromotionKind
import work.starlings.android.workspace.team.displayTitle

/**
 * `quickNotesSection`: the unfiled notes, directly under INBOX, absent when
 * there are none. A tap files the note; the swipe deletes it; the menu has
 * both. A capture this phone has not sent yet says so.
 */
@Composable
internal fun QuickNotesBlock(store: WorkStore, query: String, folded: Boolean, onFold: () -> Unit, onFile: (QuickNote) -> Unit) {
    val r = LocalContext.current.resources
    val all = store.quickNotes
    val wanted = query.trim()
    val notes = all.filter { Search.matches(wanted, it.body, "") || wanted.isEmpty() }
    val now = System.currentTimeMillis()
    val sending = store.sendingNotes.map { it.id }.toSet()
    WorkSection(
        header = { WorkFoldTitle(stringResource(R.string.work_quick_notes), folded, stringResource(R.string.work_folded), stringResource(R.string.work_open), onFold) },
    ) {
        if (!folded) {
            if (notes.isEmpty()) WorkNote(stringResource(R.string.work_nothing_matches))
            notes.forEachIndexed { index, note ->
                if (index > 0) WorkDivider()
                val title = QuickNoteFiling.firstLine(note.body)
                val detail = if (note.id in sending) r.getString(R.string.work_not_sent_yet) else HomeText.noteAge(note.createdAt, now)
                val delete = WorkRowAction(r.getString(R.string.work_delete), danger = true) { store.deleteNote(note) }
                val file = WorkRowAction(r.getString(R.string.work_file_ellipsis)) { onFile(note) }
                WorkSwipeRow(delete.title, Icons.Filled.Delete, delete.run, danger = true) {
                    WorkRowMenu(listOf(file, delete)) { long ->
                        WorkSidebarRow(
                            Icons.Filled.Edit, title, detail, { onFile(note) }, square = true, onLongClick = long,
                            label = r.getString(R.string.work_file_note_label, title, detail),
                        )
                    }
                }
            }
        }
    }
}

/** The capture alert (`New Quick Note`): one field, Add and Cancel. */
@Composable
internal fun NewQuickNoteDialog(onDismiss: () -> Unit, onAdd: (String) -> Unit) {
    val c = Starlings.colors
    var draft by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(stringResource(R.string.work_new_quick_note), style = StarlingsType.headline, color = c.primary) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(stringResource(R.string.work_capture_later), style = StarlingsType.footnote, color = c.secondary)
                StarlingsField(draft, { draft = it }, placeholder = stringResource(R.string.work_what_remember))
            }
        },
        confirmButton = {
            TextButton(onClick = { onAdd(draft); onDismiss() }, enabled = draft.isNotBlank()) {
                Text(stringResource(R.string.work_add), color = c.primary)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
    )
}

/**
 * `MobileQuickNoteTriageSheet`: where does this go? The note, the
 * destination switch (Task, Issue, Message, Doc), the subject it files
 * under (a project for an issue) or the conversation it is sent to, and
 * the title, first line by default (none for a message). The confirm makes
 * the record, then points the note at it.
 */
@Composable
internal fun QuickNoteTriageSheet(store: WorkStore, note: QuickNote, onDismiss: () -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf(QuickNotePromotionKind.TASK) }
    var subjectKey by remember { mutableStateOf<String?>(null) }
    var threadId by remember { mutableStateOf("") }
    var title by remember { mutableStateOf(QuickNoteFiling.firstLine(note.body)) }
    var organizations by remember { mutableStateOf<List<CrmSubjectWire>>(emptyList()) }
    var threads by remember { mutableStateOf<List<work.starlings.contracts.ThreadSummaryWire>>(emptyList()) }
    var searched by remember { mutableStateOf<List<CrmSubjectWire>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val view = LocalView.current
    HapticWhenSet(Haptic.ERROR, error)

    LaunchedEffect(note.id) {
        // A partner takes a task by its organization; a failed read must not blank the projects and leads.
        organizations = runCatching { store.organizations() }.getOrDefault(emptyList())
        threads = runCatching { store.conversations() }.getOrDefault(emptyList())
        loading = false
    }

    val known = store.projects + (if (store.salesVisible) store.leads else emptyList()) + organizations + searched
    val subjects = QuickNoteFiling.sorted(QuickNoteFiling.offered(known, kind), store.starredKeys)
    val chosen = subjects.firstOrNull { QuickNoteFiling.key(it) == subjectKey }
    val canFile = !saving && !loading && QuickNoteFiling.canFile(kind, chosen?.let(QuickNoteFiling::key).orEmpty(), threadId, title, busy = false)
    val docMessage = r.getString(R.string.work_filed_from_note)

    fun file() {
        if (!canFile) return
        saving = true
        scope.launch {
            try {
                store.fileNote(note, kind, chosen, threadId, title, docMessage)
                error = null
                // Played directly: the sheet is gone before a trigger could fire.
                Haptic.SUCCESS.play(view)
                onDismiss()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                error = e.workMessage()
            } finally {
                saving = false
            }
        }
    }

    WorkSheet(
        stringResource(R.string.work_file_quick_note), stringResource(R.string.work_close), onDismiss,
        confirm = if (saving) r.getString(R.string.work_filing) else triageAction(r, kind),
        confirmEnabled = canFile,
        onConfirm = ::file,
    ) {
        WorkSection {
            Text(note.body, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), style = StarlingsType.body, color = c.secondary, maxLines = 6, overflow = TextOverflow.Ellipsis)
        }
        Segmented(QuickNoteFiling.withDocs.map { it to triageLabel(r, it) }, kind) { next ->
            if (next != kind) { kind = next; subjectKey = null; threadId = "" }
        }
        if (QuickNoteFiling.needsSubject(kind)) {
            WorkSection(header = { WorkHeaderTitle(stringResource(if (kind == QuickNotePromotionKind.ISSUE) R.string.work_file_under_project else R.string.work_file_under)) }) {
                SubjectPicker(
                    subjects = subjects,
                    selected = subjectKey,
                    placeholder = r.getString(
                        when {
                            loading -> R.string.work_loading
                            kind == QuickNotePromotionKind.ISSUE -> R.string.work_choose_project
                            else -> R.string.work_choose_subject
                        },
                    ),
                    starred = store.starredKeys,
                    enabled = !loading && !saving,
                    search = { query ->
                        val found = runCatching {
                            val projects = store.client.call(work.starlings.android.api.WorkRoutes.subjects(CrmSubjectKind.PROJECT, query, null)).subjects
                            if (kind == QuickNotePromotionKind.ISSUE) projects
                            else projects + store.client.call(work.starlings.android.api.WorkRoutes.subjects(CrmSubjectKind.LEAD, query, null)).subjects +
                                runCatching { store.organizations(query) }.getOrDefault(emptyList())
                        }.getOrDefault(emptyList())
                        searched = (searched + found).distinctBy(QuickNoteFiling::key)
                    },
                    onPick = { subjectKey = it },
                )
            }
        }
        if (kind == QuickNotePromotionKind.MESSAGE) {
            WorkSection(header = { WorkHeaderTitle(stringResource(R.string.work_send_to)) }) {
                ThreadPicker(
                    threads = threads,
                    selected = threadId,
                    placeholder = r.getString(if (loading) R.string.work_loading else R.string.work_choose_conversation),
                    enabled = !loading && !saving && threads.isNotEmpty(),
                    onPick = { threadId = it },
                )
            }
        }
        if (QuickNoteFiling.needsTitle(kind)) {
            val caption = titleCaption(r, kind)
            WorkSection(header = { WorkHeaderTitle(caption) }) {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                    StarlingsField(title, { title = it }, placeholder = r.getString(R.string.work_title_field), label = caption)
                }
            }
        }
        error?.let { WorkSection { WorkErrorNotice(it) } }
    }
}

/** `QuickNotePromotionKind.triageLabel` (`quick-note-values.json`). */
private fun triageLabel(r: android.content.res.Resources, kind: QuickNotePromotionKind): String = r.getString(
    when (kind) {
        QuickNotePromotionKind.ISSUE -> R.string.work_issue
        QuickNotePromotionKind.MESSAGE -> R.string.work_triage_message
        QuickNotePromotionKind.DOC -> R.string.work_triage_doc
        else -> R.string.work_task
    },
)

/** `triageTitleCaption`. */
private fun titleCaption(r: android.content.res.Resources, kind: QuickNotePromotionKind): String = r.getString(
    when (kind) {
        QuickNotePromotionKind.ISSUE -> R.string.work_issue_title
        QuickNotePromotionKind.DOC -> R.string.work_document_title
        else -> R.string.work_task_title
    },
)

/** `triageAction`. */
private fun triageAction(r: android.content.res.Resources, kind: QuickNotePromotionKind): String = r.getString(
    when (kind) {
        QuickNotePromotionKind.ISSUE -> R.string.work_create_issue
        QuickNotePromotionKind.MESSAGE -> R.string.work_send_message
        QuickNotePromotionKind.DOC -> R.string.work_create_document
        else -> R.string.work_create_task
    },
)

/** `StarlingsSearchablePicker` over conversations: the title, then the last line, filtered as you type. */
@Composable
private fun ThreadPicker(
    threads: List<work.starlings.contracts.ThreadSummaryWire>,
    selected: String,
    placeholder: String,
    enabled: Boolean,
    onPick: (String) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val label = r.getString(R.string.work_conversation_label)
    fun name(t: work.starlings.contracts.ThreadSummaryWire) = t.displayTitle ?: r.getString(R.string.work_conversation_label)
    val value = threads.firstOrNull { it.id == selected }?.let(::name) ?: placeholder
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Button) { query = ""; open = true }
            .clearAndSetSemantics { contentDescription = "$label, $value"; role = Role.Button }
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.weight(1f))
        Text(value, style = StarlingsType.body, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Icon(Icons.Filled.UnfoldMore, null, Modifier.size(18.dp), tint = c.secondary)
    }
    if (!open) return
    Dialog(onDismissRequest = { open = false }) {
        Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).background(c.elevated, RoundedCornerShape(18.dp)).padding(vertical = 12.dp)) {
            Text(label, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.headline, color = c.primary)
            Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                StarlingsField(query, { query = it }, placeholder = r.getString(R.string.work_search))
            }
            val shown = threads.filter { query.isBlank() || Search.matches(query, name(it), it.lastMessagePreview.orEmpty()) }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (shown.isEmpty()) WorkNote(r.getString(R.string.work_no_conversations_match))
                shown.forEach { thread ->
                    val on = thread.id == selected
                    Row(
                        Modifier.fillMaxWidth().clickable(role = Role.Button) { onPick(thread.id); open = false }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(Modifier.size(20.dp)) { if (on) Icon(Icons.Filled.Check, null, tint = c.primary) }
                        Column(Modifier.weight(1f)) {
                            Text(name(thread), style = StarlingsType.body.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal), color = c.primary, maxLines = 1)
                            thread.lastMessagePreview?.takeIf { it.isNotEmpty() }?.let {
                                Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** What a subject is called in a picker row: Project, Partner or Lead. */
private fun pickerContext(r: android.content.res.Resources, subject: CrmSubjectWire): String = r.getString(
    when (subject.kind) {
        CrmSubjectKind.PROJECT -> R.string.work_kind_project
        CrmSubjectKind.ORGANIZATION -> R.string.work_kind_partner
        else -> R.string.work_kind_lead
    },
)

/**
 * `StarlingsSearchablePicker` over subjects: the row shows the choice or
 * the placeholder; the dialog filters as you type and, after a beat, asks
 * Core for the rest ([search]).
 */
@Composable
private fun SubjectPicker(
    subjects: List<CrmSubjectWire>,
    selected: String?,
    placeholder: String,
    starred: Set<String>,
    enabled: Boolean,
    search: suspend (String) -> Unit,
    onPick: (String) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val label = r.getString(R.string.work_subject)
    val value = subjects.firstOrNull { QuickNoteFiling.key(it) == selected }?.title ?: placeholder
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Button) { query = ""; open = true }
            .clearAndSetSemantics { contentDescription = "$label, $value"; role = Role.Button }
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.weight(1f))
        Text(value, style = StarlingsType.body, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Icon(Icons.Filled.UnfoldMore, null, Modifier.size(18.dp), tint = c.secondary)
    }
    if (!open) return
    LaunchedEffect(query) {
        if (query.isBlank()) return@LaunchedEffect
        delay(250)
        search(query.trim())
    }
    Dialog(onDismissRequest = { open = false }) {
        Column(Modifier.fillMaxWidth().heightIn(max = 520.dp).background(c.elevated, RoundedCornerShape(18.dp)).padding(vertical = 12.dp)) {
            Text(label, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = StarlingsType.headline, color = c.primary)
            Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                StarlingsField(query, { query = it }, placeholder = r.getString(R.string.work_search))
            }
            val shown = subjects.filter { query.isBlank() || Search.matches(query, it.title, it.subtitle.orEmpty()) }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (shown.isEmpty()) WorkNote(r.getString(R.string.work_no_destinations))
                shown.forEach { subject ->
                    val key = QuickNoteFiling.key(subject)
                    val on = key == selected
                    Row(
                        Modifier.fillMaxWidth().clickable(role = Role.Button) { onPick(key); open = false }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(Modifier.size(20.dp)) { if (on) Icon(Icons.Filled.Check, null, tint = c.primary) }
                        Column(Modifier.weight(1f)) {
                            Text(subject.title, style = StarlingsType.body.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal), color = c.primary)
                            val meta = listOfNotNull(pickerContext(r, subject), subject.subtitle?.takeIf { it.isNotEmpty() }).joinToString(" · ")
                            Text(meta, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (key in starred) Icon(Icons.Filled.Star, null, Modifier.size(14.dp), tint = c.secondary)
                    }
                }
            }
        }
    }
}
