package work.starlings.android.workspace.work

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import work.starlings.android.R
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/** The kinds a task can live on (`SubjectKind.kinds(with: .tasks)`), in the registry's order. */
private val TASK_KINDS = listOf(CrmSubjectKind.PROJECT, CrmSubjectKind.LEAD, CrmSubjectKind.ORGANIZATION, CrmSubjectKind.EVENT)

/**
 * `MobileSubjectPicker` for a task's Move to…: the kind, then
 * Core's search for it, a beat after the last keystroke. A tap picks and closes.
 */
@Composable
internal fun MoveTaskSheet(store: WorkStore, onDismiss: () -> Unit, onPick: (SubjectRef) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var kind by remember { mutableStateOf(CrmSubjectKind.PROJECT) }
    var query by remember { mutableStateOf("") }
    var matches by remember { mutableStateOf<List<CrmSubjectWire>>(emptyList()) }
    var searching by remember { mutableStateOf(true) }

    LaunchedEffect(kind, query) {
        searching = true
        if (query.isNotEmpty()) delay(250)
        matches = runCatching { store.client.call(WorkRoutes.subjects(kind, query.trim(), null)).subjects }.getOrDefault(emptyList())
        searching = false
    }

    WorkSheet(stringResource(R.string.work_file_under), stringResource(R.string.work_close), onDismiss) {
        Segmented(TASK_KINDS.map { it to kindTitle(r, it) }, kind) { kind = it }
        Box(Modifier.padding(horizontal = 16.dp)) {
            StarlingsField(query, { query = it }, placeholder = stringResource(R.string.work_search))
        }
        WorkSection {
            matches.forEachIndexed { index, match ->
                if (index > 0) WorkDivider()
                Column(
                    Modifier.fillMaxWidth().clickable(role = Role.Button) { onPick(SubjectRef.of(match)) }.padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(match.title, style = StarlingsType.body, color = c.primary)
                    match.subtitle?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
                }
            }
            if (searching && matches.isEmpty()) WorkPlaceholderRows()
            if (!searching && matches.isEmpty()) {
                WorkNote(stringResource(if (query.isEmpty()) R.string.work_nothing_here_yet else R.string.work_nothing_in_core))
            }
        }
    }
}

private fun kindTitle(r: android.content.res.Resources, kind: CrmSubjectKind): String = r.getString(
    when (kind) {
        CrmSubjectKind.PROJECT -> R.string.work_kind_project
        CrmSubjectKind.LEAD -> R.string.work_kind_lead
        CrmSubjectKind.ORGANIZATION -> R.string.work_kind_partner
        else -> R.string.work_kind_event
    },
)
