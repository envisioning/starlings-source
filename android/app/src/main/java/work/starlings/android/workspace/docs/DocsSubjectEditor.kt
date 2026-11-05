package work.starlings.android.workspace.docs

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType

/**
 * DocsUI's `SubjectEditor`: a document's subjects as chips with a way to add
 * and remove. Writes go straight to Docs (replace-all): this is a relation,
 * not text, so it does not ride the autosave. A refused write puts the
 * chips back and says why in [onError]. [onChanged] gets the detail Docs
 * kept after it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DocsSubjectEditor(
    documentId: String,
    subjects: List<DocsSubject>,
    data: DocsData,
    directory: DocsSubjectDirectory,
    onChanged: (DocsDocumentDetail) -> Unit,
    onError: (String) -> Unit,
) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var shown by remember(documentId, subjects) { mutableStateOf(subjects) }
    val names = remember(documentId) { mutableStateMapOf<String, String>() }
    var adding by remember { mutableStateOf(false) }
    val removeLabel = stringResource(R.string.docs_remove)

    LaunchedEffect(shown.joinToString { it.ref }) {
        for (subject in shown) {
            if (names[subject.ref] != null) continue
            val name = try { directory.name(subject) } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
            name?.let { names[subject.ref] = it }
        }
    }

    fun write(next: List<DocsSubject>) {
        val before = shown
        shown = next
        scope.launch {
            try {
                val detail = data.setSubjects(documentId, next)
                shown = detail.subjects
                onChanged(detail)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                shown = before
                onError(DocsData.describe(e))
            }
        }
    }

    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        shown.forEach { subject ->
            Row(
                Modifier.background(c.secondary.copy(alpha = 0.14f), CircleShape).padding(start = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(DocsSubjects.label(subject, names), style = StarlingsType.caption, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(
                    Icons.Filled.Close, "$removeLabel ${DocsSubjects.label(subject, names)}",
                    Modifier
                        .clickable(role = Role.Button) { write(DocsSubjects.removing(shown, subject)) }
                        .padding(6.dp)
                        .size(10.dp),
                    tint = c.secondary,
                )
            }
        }
        Row(
            Modifier.clickable(role = Role.Button) { adding = true }.padding(horizontal = 4.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Decorative: the word beside it says what it does.
            Icon(Icons.Filled.Add, null, Modifier.size(12.dp), tint = c.accentMark)
            Text(stringResource(R.string.docs_subject), style = StarlingsType.caption, color = c.accentMark)
        }
    }

    if (adding) {
        SubjectPicker(directory, shown, onDismiss = { adding = false }) { hit ->
            names[hit.subject.ref] = hit.name
            adding = false
            write(DocsSubjects.adding(shown, hit.subject))
        }
    }
}

/** The `+ Subject` popover, as a drawer: search the CRM, pick one. A subject already on the document is dimmed. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SubjectPicker(directory: DocsSubjectDirectory, current: List<DocsSubject>, onDismiss: () -> Unit, onPick: (DocsSubjectHit) -> Unit) {
    val c = Starlings.colors
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<DocsSubjectHit>>(emptyList()) }
    LaunchedEffect(query) {
        delay(DocsSubjects.DEBOUNCE_MS)
        results = try { directory.search(query) } catch (e: CancellationException) { throw e } catch (_: Exception) { emptyList() }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.canvas) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            StarlingsField(query, { query = it }, stringResource(R.string.docs_subject_search))
            if (results.isEmpty()) {
                Text(
                    stringResource(if (query.isEmpty()) R.string.docs_subject_type else R.string.docs_subject_none),
                    style = StarlingsType.footnote, color = c.secondary,
                )
            } else {
                results.forEach { hit ->
                    val taken = current.any { it.ref == hit.subject.ref }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .alpha(if (taken) 0.5f else 1f)
                            .clickable(enabled = !taken, role = Role.Button) { onPick(hit) }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(hit.name, Modifier.weight(1f), style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(hit.subject.kind.replaceFirstChar(Char::uppercaseChar), style = StarlingsType.caption, color = c.secondary)
                    }
                }
            }
        }
    }
}
