package work.starlings.android.workspace.team

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import work.starlings.android.R
import work.starlings.android.api.StarlingsClient
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.PickerOption
import work.starlings.android.ui.SearchablePickerRow
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/**
 * `MobilePeerTaskSubjectPicker`: Between us' New task asks which project,
 * lead or partner the task is filed under (Core files every task on one),
 * from one searchable list of all three. A pick continues into that
 * subject's Tasks with its New task editor.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PeerTaskSubjectPicker(client: StarlingsClient, onDismiss: () -> Unit, onPick: (CrmSubjectWire) -> Unit) {
    val c = Starlings.colors
    val r = LocalContext.current.resources
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var subjects by remember { mutableStateOf<List<CrmSubjectWire>>(emptyList()) }
    // The last search's answer; the default list stays in [subjects], so a pick from either resolves.
    var searched by remember { mutableStateOf<List<CrmSubjectWire>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(attempt) {
        loading = true
        try {
            subjects = PeerTaskSubjects.read(client, "")
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.teamMessage()
        } finally {
            loading = false
        }
    }
    fun option(subject: CrmSubjectWire) = PickerOption(
        id = PeerTaskSubjects.optionId(subject),
        title = subject.title,
        context = r.getString(
            when (PeerTaskSubjects.context(subject)) {
                PeerTaskSubjects.Context.PROJECT -> R.string.team_subject_project
                PeerTaskSubjects.Context.PARTNER -> R.string.team_subject_partner
                PeerTaskSubjects.Context.LEAD -> R.string.team_subject_lead
            },
        ),
        subtitle = subject.subtitle,
    )
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = c.canvas) {
        SheetHeader(stringResource(R.string.team_file_task_under), stringResource(R.string.work_close), onDismiss)
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            ListSection(stringResource(R.string.team_file_task_under)) {
                SearchablePickerRow(
                    label = stringResource(R.string.team_task_subject_label),
                    placeholder = stringResource(R.string.team_task_subject_placeholder),
                    options = subjects.map(::option),
                    selection = "",
                    onPick = { id -> (searched + subjects).firstOrNull { PeerTaskSubjects.optionId(it) == id }?.let(onPick) },
                    emptyMessage = stringResource(R.string.team_task_subject_none),
                    search = { query ->
                        val matches = runCatching { PeerTaskSubjects.read(client, query) }
                            .onFailure { if (it is CancellationException) throw it }
                            .getOrDefault(emptyList())
                        searched = matches
                        matches.map(::option)
                    },
                    searchPrompt = stringResource(R.string.team_search),
                )
                if (loading) WorkPlaceholderRows()
                error?.let { WorkErrorNotice(it, stringResource(R.string.team_retry), { attempt += 1 }) }
            }
        }
    }
}

/** The picker's reads and rows, pure where they can be (`MobilePeerTaskSubjectPicker`). */
object PeerTaskSubjects {
    enum class Context { PROJECT, PARTNER, LEAD }

    /** One id per subject across the three lists. */
    fun optionId(subject: CrmSubjectWire): String = "${subject.kind.value}:${subject.id}"

    /** The kind word: a project, a partner (its organization), else a lead. */
    fun context(subject: CrmSubjectWire): Context = when (subject.kind) {
        CrmSubjectKind.PROJECT -> Context.PROJECT
        CrmSubjectKind.ORGANIZATION -> Context.PARTNER
        else -> Context.LEAD
    }

    /** Projects, then leads, then partners. Projects and leads must answer; partners may not. */
    fun merge(projects: List<CrmSubjectWire>, leads: List<CrmSubjectWire>, partners: List<CrmSubjectWire>?): List<CrmSubjectWire> =
        projects + leads + partners.orEmpty()

    suspend fun read(client: StarlingsClient, query: String): List<CrmSubjectWire> = coroutineScope {
        val projects = async { client.call(WorkRoutes.subjects(CrmSubjectKind.PROJECT, query, null)).subjects }
        val leads = async { client.call(WorkRoutes.subjects(CrmSubjectKind.LEAD, query, null)).subjects }
        val partners = async {
            try {
                client.call(WorkRoutes.subjects(CrmSubjectKind.ORGANIZATION, query, null)).subjects
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }
        merge(projects.await(), leads.await(), partners.await())
    }
}
