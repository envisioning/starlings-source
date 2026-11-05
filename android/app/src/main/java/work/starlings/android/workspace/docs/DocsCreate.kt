package work.starlings.android.workspace.docs

import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.CategoryPicker
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType

/**
 * DocsUI's `NewDocumentSheet` in iOS's drawer: "New document", the title,
 * the category, where it files, Cancel and Create. Create closes the sheet
 * and [onCreate] makes the document; an empty title cannot be created.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewDocumentSheet(
    note: String,
    categories: List<Pair<String, String>>,
    onCreate: (title: String, category: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Starlings.colors
    var title by remember { mutableStateOf("") }
    var category by remember { mutableStateOf<String?>(null) }
    val canCreate = title.isNotBlank()
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.canvas) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(stringResource(R.string.docs_new_document), style = StarlingsType.headline, color = c.primary)
            StarlingsField(title, { title = it }, stringResource(R.string.docs_field_title))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.docs_category), style = StarlingsType.body, color = c.secondary)
                CategoryPicker(category, categories, stringResource(R.string.docs_no_category), stringResource(R.string.docs_category), { category = it })
            }
            Text(note, style = StarlingsType.footnote, color = c.secondary)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                BorderedButton(stringResource(R.string.docs_cancel), onDismiss, compact = true)
                FilledButton(
                    stringResource(R.string.docs_create),
                    { onCreate(title.trim(), category); onDismiss() },
                    enabled = canCreate, compact = true,
                )
            }
        }
    }
}

/**
 * `MobileDocsLinkSaveSheet`: a short, explicit capture flow for an https
 * link. The Worker reads the page's metadata and cover; the saved document
 * keeps the member's notes, not page text. Saved into [folderPath] (Docs'
 * link folder when null), about [subjects]; [onSaved] gets the new row.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LinkSaveSheet(
    data: DocsData,
    folderPath: String?,
    subjects: List<DocsSubject>,
    onSaved: (DocsDocumentSummary) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Starlings.colors
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val url = DocsFiling.httpsLink(address)
    val invalid = stringResource(R.string.docs_invalid_url)
    val savedText = stringResource(R.string.docs_link_saved)
    val notLoaded = stringResource(R.string.docs_link_not_loaded)
    val message = stringResource(R.string.docs_saved_from)

    fun save() {
        val link = url ?: run { error = invalid; return }
        saving = true
        scope.launch {
            try {
                val saved = data.saveLink(link, folderPath, subjects, message)
                val failed = saved.link?.fetchStatus == DocsRules.LINK_FETCH_FAILED
                // "Saved. The page did not load." is a danger toast on iOS.
                if (failed) toast(notLoaded, ToastTone.DANGER) else toast(savedText)
                onSaved(saved.summary())
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = DocsData.describe(e)
            } finally {
                saving = false
            }
        }
    }

    ModalBottomSheet(onDismissRequest = { if (!saving) onDismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.canvas) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(bottom = 20.dp)) {
            // The inline bar: Cancel, the title, Save (a spinner while it saves).
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text(
                    stringResource(R.string.docs_cancel),
                    Modifier.align(Alignment.CenterStart).clickable(enabled = !saving, role = Role.Button, onClick = onDismiss).padding(vertical = 8.dp),
                    style = StarlingsType.body, color = c.primary,
                )
                Text(stringResource(R.string.docs_save_link), Modifier.align(Alignment.Center), style = StarlingsType.headline, color = c.primary)
                Box(Modifier.align(Alignment.CenterEnd)) {
                    if (saving) {
                        CircularProgressIndicator(Modifier.size(20.dp), color = c.secondary, strokeWidth = 2.dp)
                    } else {
                        Text(
                            stringResource(R.string.docs_save),
                            Modifier
                                .alpha(if (url == null) 0.4f else 1f)
                                .clickable(enabled = url != null, role = Role.Button) { save() }
                                .padding(vertical = 8.dp),
                            style = StarlingsType.headline, color = c.accentMark,
                        )
                    }
                }
            }
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ListSection(stringResource(R.string.docs_link_header)) {
                    Row(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) {
                            StarlingsField(
                                address, { address = it; error = null }, stringResource(R.string.docs_link_placeholder),
                                label = stringResource(R.string.docs_link_url), keyboardType = KeyboardType.Uri,
                            )
                        }
                        IconButton(onClick = { clipboard.getText()?.text?.let { address = it; error = null } }, enabled = !saving) {
                            Icon(Icons.Outlined.ContentPaste, stringResource(R.string.docs_paste_link), tint = c.accentMark)
                        }
                    }
                }
                Text(
                    stringResource(R.string.docs_link_footer), Modifier.padding(horizontal = 16.dp),
                    style = StarlingsType.footnote, color = c.secondary,
                )
                error?.let {
                    Spacer(Modifier.size(8.dp))
                    Text(it, Modifier.padding(horizontal = 16.dp), style = StarlingsType.footnote, color = c.danger)
                }
            }
        }
    }
}
