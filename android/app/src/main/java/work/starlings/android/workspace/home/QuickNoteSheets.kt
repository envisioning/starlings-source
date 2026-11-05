package work.starlings.android.workspace.home

import androidx.compose.ui.platform.LocalView
import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.workspace.QuickNoteFiling
import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.MoveToInbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.QuickNote
import work.starlings.contracts.QuickNotePromotionKind

/**
 * A sheet's bar: Close (an icon, labelled) at the leading end, the title
 * centred, the confirm as the accent capsule, dimmed while it cannot run.
 */
@Composable
private fun DrawerBar(title: String, confirm: String, enabled: Boolean, onClose: () -> Unit, onConfirm: () -> Unit) {
    val c = Starlings.colors
    val closeLabel = stringResource(R.string.home_close)
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .size(36.dp)
                .background(c.elevated, CircleShape)
                .clickable(role = Role.Button, onClick = onClose)
                .clearAndSetSemantics { contentDescription = closeLabel; role = Role.Button; onClick { onClose(); true } },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Close, null, Modifier.size(18.dp), tint = c.secondary)
        }
        Text(title, Modifier.align(Alignment.Center), style = StarlingsType.headline, color = c.primary)
        Text(
            confirm,
            Modifier
                .align(Alignment.CenterEnd)
                .alpha(if (enabled) 1f else 0.4f)
                .background(c.accent, CircleShape)
                .clickable(enabled = enabled, role = Role.Button, onClick = onConfirm)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            style = StarlingsType.headline,
            color = c.accentInk,
        )
    }
}

@Composable
private fun ActionRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, danger: Boolean = false, divider: Boolean = true, onClick: () -> Unit) {
    val c = Starlings.colors
    val ink = if (danger) c.danger else c.primary
    ListRow(Modifier.clickable(role = Role.Button, onClick = onClick), divider = divider) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(18.dp), tint = ink)
            Text(title, style = StarlingsType.body, color = ink)
        }
    }
}

/**
 * `MobileQuickNoteSheet`: one Quick Note, its body to rewrite, and File…,
 * Copy and Delete. Filing is the caller's: the drawer closes first, then
 * the caller opens [FileQuickNoteSheet].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickNoteDrawer(
    note: QuickNote,
    saving: Boolean,
    error: String?,
    save: suspend (String) -> Boolean,
    file: () -> Unit,
    delete: () -> Unit,
    dismiss: () -> Unit,
) {
    val context = LocalContext.current
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var draft by rememberSaveable(note.id) { mutableStateOf(note.body) }
    val trimmed = draft.trim()
    val canSave = trimmed.isNotEmpty() && trimmed != note.body && !saving
    val view = LocalView.current
    HapticWhenSet(Haptic.ERROR, error)
    // Played directly: the sheet is gone before a trigger could fire.
    val doSave: () -> Unit = { if (canSave) scope.launch { if (save(draft)) { Haptic.SUCCESS.play(view); dismiss() } } }
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(), containerColor = c.canvas) {
        Column(Modifier.navigationBarsPadding().imePadding()) {
            DrawerBar(
                stringResource(R.string.home_note),
                stringResource(if (saving) R.string.home_saving else R.string.home_save),
                canSave, dismiss, doSave,
            )
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                StarlingsField(
                    draft, { draft = it },
                    placeholder = stringResource(R.string.home_note_prompt),
                    label = stringResource(R.string.home_note),
                    capitalization = KeyboardCapitalization.Sentences,
                    singleLine = false, maxLines = 8,
                )
                ListSection(null) {
                    ActionRow(Icons.Outlined.MoveToInbox, stringResource(R.string.home_file_note)) { dismiss(); file() }
                    ActionRow(Icons.Outlined.ContentCopy, stringResource(R.string.home_copy)) {
                        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("note", note.body))
                    }
                    ActionRow(Icons.Outlined.Delete, stringResource(R.string.home_delete), danger = true, divider = false) { delete(); dismiss() }
                }
                error?.let { Text(it, style = StarlingsType.caption, color = c.danger) }
            }
        }
    }
}

/**
 * `MobileQuickNoteTriageSheet`: where does this go? Task, Issue or Message,
 * one form that shows what the chosen kind needs and nothing else.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FileQuickNoteSheet(
    note: QuickNote,
    load: suspend () -> HomeModel.FilingOptions,
    file: suspend (QuickNotePromotionKind, CrmSubjectWire?, String, String) -> Unit,
    dismiss: () -> Unit,
) {
    val context = LocalContext.current
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf(QuickNotePromotionKind.TASK) }
    var options by remember { mutableStateOf<HomeModel.FilingOptions?>(null) }
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val view = LocalView.current
    HapticWhenSet(Haptic.ERROR, error)
    var subjectKey by remember { mutableStateOf("") }
    var threadId by remember { mutableStateOf("") }
    var title by rememberSaveable(note.id) { mutableStateOf(QuickNoteFiling.firstLine(note.body)) }
    var query by remember { mutableStateOf("") }

    LaunchedEffect(note.id) {
        try {
            options = load()
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = (e as? StarlingsApiError)?.sentence ?: e.message
        }
        loading = false
    }

    val canFile = QuickNoteFiling.canFile(kind, subjectKey, threadId, title, saving || loading)
    val action = stringResource(
        when {
            saving -> R.string.home_filing
            kind == QuickNotePromotionKind.ISSUE -> R.string.home_create_issue
            kind == QuickNotePromotionKind.MESSAGE -> R.string.home_send_message
            else -> R.string.home_create_task
        },
    )
    val doFile: () -> Unit = {
        if (canFile) scope.launch {
            saving = true
            try {
                val subject = options?.subjects?.firstOrNull { QuickNoteFiling.key(it) == subjectKey }
                file(kind, subject, threadId, title)
                // Played directly: the sheet is gone before a trigger could fire.
                Haptic.SUCCESS.play(view)
                dismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = (e as? StarlingsApiError)?.sentence ?: e.message
            } finally {
                saving = false
            }
        }
    }

    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.canvas) {
        Column(Modifier.navigationBarsPadding().imePadding()) {
            DrawerBar(stringResource(R.string.home_file_quick_note), action, canFile, dismiss, doFile)
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Text(note.body, style = StarlingsType.body, color = c.secondary, maxLines = 6, overflow = TextOverflow.Ellipsis)

                KindPicker(kind) { next ->
                    if (next != kind) { kind = next; subjectKey = ""; threadId = ""; query = "" }
                }

                if (QuickNoteFiling.needsSubject(kind)) {
                    val issue = kind == QuickNotePromotionKind.ISSUE
                    val offered = QuickNoteFiling.offered(options?.subjects.orEmpty(), kind, query)
                    ListSection(stringResource(if (issue) R.string.home_file_under_project else R.string.home_file_under)) {
                        ListRow(divider = true) {
                            StarlingsField(
                                query, { query = it },
                                placeholder = stringResource(
                                    when {
                                        loading -> R.string.home_loading
                                        issue -> R.string.home_choose_project
                                        else -> R.string.home_choose_subject
                                    },
                                ),
                                label = stringResource(R.string.home_subject),
                            )
                        }
                        if (!loading && offered.isEmpty()) {
                            ListRow { Text(stringResource(R.string.home_no_destinations), style = StarlingsType.body, color = c.secondary) }
                        }
                        offered.take(40).forEachIndexed { index, s ->
                            val key = QuickNoteFiling.key(s)
                            OptionRow(
                                title = s.title,
                                context = stringResource(
                                    when (s.kind) {
                                        CrmSubjectKind.PROJECT -> R.string.home_kind_project
                                        CrmSubjectKind.ORGANIZATION -> R.string.home_kind_partner
                                        else -> R.string.home_kind_lead
                                    },
                                ),
                                subtitle = s.subtitle.orEmpty(),
                                starred = QuickNoteFiling.stateKey(s) in options?.starred.orEmpty(),
                                selected = key == subjectKey,
                                divider = index < minOf(offered.size, 40) - 1,
                            ) { subjectKey = key }
                        }
                    }
                }

                if (kind == QuickNotePromotionKind.MESSAGE) {
                    val threads = options?.threads.orEmpty().filter {
                        query.isBlank() || work.starlings.android.Search.matches(query, HomeWorkText.threadTitle(context, it), "")
                    }
                    ListSection(stringResource(R.string.home_send_to)) {
                        ListRow(divider = true) {
                            StarlingsField(
                                query, { query = it },
                                placeholder = stringResource(if (loading) R.string.home_loading else R.string.home_choose_conversation),
                                label = stringResource(R.string.home_conversation),
                            )
                        }
                        if (!loading && threads.isEmpty()) {
                            ListRow { Text(stringResource(R.string.home_no_conversations), style = StarlingsType.body, color = c.secondary) }
                        }
                        threads.take(40).forEachIndexed { index, t ->
                            OptionRow(
                                title = HomeWorkText.threadTitle(context, t),
                                context = "",
                                subtitle = "",
                                starred = false,
                                selected = t.id == threadId,
                                divider = index < minOf(threads.size, 40) - 1,
                            ) { threadId = t.id }
                        }
                    }
                }

                if (QuickNoteFiling.needsTitle(kind)) {
                    ListSection(stringResource(if (kind == QuickNotePromotionKind.ISSUE) R.string.home_issue_title else R.string.home_task_title)) {
                        ListRow {
                            StarlingsField(title, { title = it }, placeholder = stringResource(R.string.home_title), capitalization = KeyboardCapitalization.Sentences)
                        }
                    }
                }

                error?.let { Text(it, style = StarlingsType.caption, color = c.danger) }
            }
        }
    }
}

/** The segmented Destination control: Task, Issue, Message. */
@Composable
private fun KindPicker(kind: QuickNotePromotionKind, onPick: (QuickNotePromotionKind) -> Unit) {
    val c = Starlings.colors
    val label = stringResource(R.string.home_destination)
    Row(
        Modifier.fillMaxWidth().background(c.field, RoundedCornerShape(10.dp)).padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        QuickNoteFiling.kinds.forEach { k ->
            val title = stringResource(
                when (k) {
                    QuickNotePromotionKind.ISSUE -> R.string.home_kind_issue
                    QuickNotePromotionKind.MESSAGE -> R.string.home_kind_message
                    else -> R.string.home_kind_task
                },
            )
            val on = k == kind
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 32.dp)
                    .background(if (on) c.elevated else c.field, RoundedCornerShape(8.dp))
                    .clickable(role = Role.Tab) { onPick(k) }
                    .clearAndSetSemantics { contentDescription = "$label: $title"; role = Role.Tab; selected = on; onClick { onPick(k); true } },
                contentAlignment = Alignment.Center,
            ) {
                Text(title, style = StarlingsType.subheadline.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal), color = c.primary)
            }
        }
    }
}

@Composable
private fun OptionRow(title: String, context: String, subtitle: String, starred: Boolean, selected: Boolean, divider: Boolean, onClick: () -> Unit) {
    val c = Starlings.colors
    val starredLabel = stringResource(R.string.home_starred)
    ListRow(
        Modifier
            .clickable(role = Role.RadioButton, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = listOf(title, if (starred) starredLabel else "", context, subtitle).filter { it.isNotEmpty() }.joinToString(", ")
                role = Role.RadioButton
                this.selected = selected
                onClick { onClick(); true }
            },
        divider = divider,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (starred) Icon(Icons.Filled.Star, null, Modifier.size(12.dp), tint = c.secondary)
            Column(Modifier.weight(1f)) {
                Text(title, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val line = listOf(context, subtitle).filter { it.isNotEmpty() }.joinToString(" · ")
                if (line.isNotEmpty()) Text(line, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (selected) Icon(Icons.Outlined.Check, null, Modifier.size(18.dp), tint = c.accent)
        }
    }
}
