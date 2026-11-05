package work.starlings.android.workspace.work

import work.starlings.android.ui.ToastTone
import work.starlings.android.ui.toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Description
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.EmptyState
import work.starlings.android.ui.FilledButton
import work.starlings.android.workspace.docs.DocsCreateDocument
import work.starlings.android.workspace.docs.DocsData
import work.starlings.android.workspace.docs.DocsFiling
import work.starlings.android.workspace.docs.DocsListPage
import work.starlings.android.workspace.docs.DocsRailState
import work.starlings.android.workspace.docs.DocsSelection
import work.starlings.android.workspace.docs.LinkSaveSheet
import work.starlings.android.workspace.docs.NewDocumentSheet
import work.starlings.contracts.CrmSubjectKind

/** The subject's Docs list: its Docs kind (`organization` for a partner) and id (`subject.docsSubject`). */
internal fun SubjectRef.docsSelection(): DocsSelection.Subject = DocsSelection.Subject(
    kind = if (kind == CrmSubjectKind.ORGANIZATION) "organization" else kind.value,
    id = id,
    title = title,
)

/** Which sheet the Documents pane has open. */
internal enum class DocumentsSheet { NEW, LINK }

/**
 * `MobileSubjectDocumentsView`: DocsUI's `DocumentsPane` for one subject.
 * The documents about it, New document and Save link (in the subject's
 * bar, [sheet]), both filed in the subject's folder and about it; a row
 * opens the editor ([onRead]). `?new=document` opens New document once.
 */
@Composable
internal fun SubjectDocumentsPane(
    store: WorkStore,
    rail: DocsRailState,
    subject: SubjectRef,
    sheet: DocumentsSheet?,
    onSheet: (DocumentsSheet?) -> Unit,
    onRead: (id: String, title: String) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val data: DocsData = store.docs
    val selection = remember(subject.id, subject.title) { subject.docsSelection() }
    // Moves when a document was made or saved here: the list reads again.
    var revision by remember { mutableIntStateOf(0) }
    LaunchedEffect(rail) { if (rail.summary == null) rail.load() }
    val createdMessage = stringResource(R.string.docs_created_from)

    // DocumentsPane's count over the rows, and its own empty state with New document.
    DocsListPage(selection, data, rail, { onRead(it.id, it.title) }, revision, counted = true) {
        Column(
            Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            EmptyState(
                stringResource(R.string.docs_pane_empty),
                Icons.Outlined.Description,
                stringResource(R.string.docs_pane_empty_detail, selection.kind),
                Modifier.heightIn(max = 220.dp),
            )
            FilledButton(stringResource(R.string.docs_new_document), { onSheet(DocumentsSheet.NEW) }, icon = Icons.Filled.Add, compact = true)
        }
    }

    when (sheet) {
        null -> Unit
        DocumentsSheet.LINK -> LinkSaveSheet(
            data,
            folderPath = DocsFiling.linkFolder(selection),
            subjects = DocsFiling.createSubjects(selection),
            onSaved = { saved -> revision++; onRead(saved.id, saved.title) },
            onDismiss = { onSheet(null) },
        )
        DocumentsSheet.NEW -> NewDocumentSheet(
            note = stringResource(R.string.docs_filed_in_folder, DocsFiling.createFolder(selection)),
            categories = rail.categoryChoices,
            onCreate = { title, category ->
                if (title.isNotEmpty()) {
                    scope.launch {
                        try {
                            val created = data.create(
                                DocsCreateDocument(
                                    title = title,
                                    folderPath = DocsFiling.createFolder(selection),
                                    category = category,
                                    subjects = DocsFiling.createSubjects(selection),
                                    message = createdMessage,
                                ),
                            )
                            revision++
                            onRead(created.id, created.title)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            toast(DocsData.describe(e), ToastTone.DANGER)
                        }
                    }
                }
            },
            onDismiss = { onSheet(null) },
        )
    }
}

/** A document opened from the pane: the Docs editor under the subject's own bar. */
@Composable
internal fun SubjectDocumentReader(store: WorkStore, rail: DocsRailState, id: String) {
    LaunchedEffect(rail) { if (rail.summary == null) rail.load() }
    work.starlings.android.workspace.docs.DocsReader(id, store.docs, rail)
}
