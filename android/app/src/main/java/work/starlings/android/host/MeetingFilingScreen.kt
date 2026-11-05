package work.starlings.android.host

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.ui.FormSheetBar
import work.starlings.android.ui.ListActionRow
import work.starlings.android.ui.ListMenuRow
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.MenuChoice
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsSpacing
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.work.IssueScreen
import work.starlings.android.workspace.work.SubjectRef
import work.starlings.android.workspace.work.SubjectScreen
import work.starlings.android.workspace.work.TaskScreen
import work.starlings.android.workspace.work.TaskSource
import work.starlings.android.workspace.work.WorkStore
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.MeetingKind

/** `MeetingCategoryKind.menuTitle`. */
internal fun meetingKindTitle(kind: MeetingKind): Int = when (kind) {
    MeetingKind.STATUS -> R.string.meeting_kind_status
    MeetingKind.LEAD -> R.string.meeting_kind_lead
    MeetingKind.PROJECT -> R.string.meeting_kind_project
    MeetingKind.INTERNAL -> R.string.meeting_kind_internal
    MeetingKind.PARTNER -> R.string.meeting_kind_partner
    MeetingKind.EVENT -> R.string.meeting_kind_event
    MeetingKind.PERSONAL -> R.string.meeting_kind_personal
    else -> R.string.meeting_kind_uncategorized
}

/**
 * `MobileMeetingFilingView`: how this meeting is filed in Core. Filed as (the
 * kind), then for a kind with a subject the one chosen, with Open in Work and
 * Choose a different one, or a search over Core. Save writes it. Filing early
 * matters more than filing perfectly: the CRM row opens when the meeting
 * starts. Open in Work opens the subject here, over the call: leaving the
 * call for the Work tab would end the meeting.
 */
@Composable
fun MeetingFilingScreen(host: RoomHost, api: MeetingOwnerApi, account: OwnerAccount, onClose: () -> Unit) {
    val c = Starlings.colors
    val state by host.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf(MeetingKind.UNCATEGORIZED) }
    var subject by remember { mutableStateOf<MeetingFiling.Subject?>(null) }
    var query by remember { mutableStateOf("") }
    var matches by remember { mutableStateOf<List<CrmSubjectWire>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var opened by remember { mutableStateOf<SubjectRef?>(null) }
    val room = state.room
    val meetingId = state.meetingId

    LaunchedEffect(room, meetingId) {
        if (room == null || meetingId == null) return@LaunchedEffect
        try {
            val category = api.category(room, meetingId)
            kind = category.meetingKind
            subject = MeetingFiling.subject(category)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = RoomHost.describe(e)
        }
    }
    // Debounced: this is a network search against Core, not a typeahead cache.
    LaunchedEffect(kind, query) {
        val subjectKind = MeetingFiling.subjectKind(kind)
        if (subjectKind == null || query.length < MeetingFiling.MIN_QUERY) {
            matches = emptyList()
            return@LaunchedEffect
        }
        delay(MeetingFiling.SEARCH_DEBOUNCE_MS)
        searching = true
        try {
            matches = api.subjects(subjectKind, query)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = RoomHost.describe(e)
        } finally {
            searching = false
        }
    }

    opened?.let { ref ->
        MeetingSubjectStack(account, ref) { opened = null }
        return
    }
    BackHandler(onBack = onClose)

    Column(Modifier.fillMaxSize().background(c.canvas).imePadding()) {
        FormSheetBar(
            stringResource(R.string.filing_title),
            stringResource(R.string.filing_close), onClose,
            stringResource(R.string.filing_save),
            confirmEnabled = MeetingFiling.canSave(kind, subject, saving),
            onConfirm = {
                if (room == null || meetingId == null) return@FormSheetBar
                saving = true
                scope.launch {
                    try {
                        api.setCategory(room, meetingId, MeetingFiling.update(kind, subject))
                        onClose()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        failure = RoomHost.describe(e)
                    } finally {
                        saving = false
                    }
                }
            },
        )
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.section),
        ) {
            ListSection(stringResource(R.string.filing_filed_as)) {
                ListMenuRow(
                    stringResource(R.string.filing_kind),
                    stringResource(meetingKindTitle(kind)),
                    MeetingFiling.menu(kind).map { option ->
                        val title = stringResource(meetingKindTitle(option))
                        MenuChoice(title, option == kind) {
                            if (option != kind) {
                                kind = option
                                subject = null
                                matches = emptyList()
                                query = ""
                            }
                        }
                    },
                )
            }
            if (MeetingFiling.needsSubject(kind)) {
                ListSection(stringResource(meetingKindTitle(kind))) {
                    val chosen = subject
                    if (chosen != null) {
                        ListRow(divider = true) {
                            Row {
                                Text(chosen.title, Modifier.weight(1f), style = StarlingsType.body, color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(stringResource(R.string.filing_selected), style = StarlingsType.body, color = c.secondary)
                            }
                        }
                        ListActionRow(
                            stringResource(R.string.filing_open_in_work), Icons.AutoMirrored.Outlined.ArrowForward,
                            onClick = { opened = SubjectRef(chosen.kind, chosen.id, chosen.title) },
                        )
                        HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = c.border)
                        ListActionRow(stringResource(R.string.filing_choose_another), null, onClick = { subject = null })
                    } else {
                        Column(Modifier.padding(12.dp)) {
                            StarlingsField(query, { query = it }, stringResource(R.string.filing_search))
                        }
                        if (searching && matches.isEmpty()) {
                            repeat(2) {
                                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
                                    Text("", Modifier.fillMaxWidth(0.6f).height(14.dp).background(c.field, RoundedCornerShape(StarlingsRadius.field)))
                                }
                            }
                        }
                        matches.forEachIndexed { index, match ->
                            Column(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable(role = Role.Button) { subject = MeetingFiling.Subject(match.id, match.kind, match.title) }
                                    .padding(horizontal = 16.dp, vertical = 10.dp),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Text(match.title, style = StarlingsType.body, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                match.subtitle?.takeIf { it.isNotEmpty() }?.let {
                                    Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                            if (index < matches.lastIndex) HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = c.border)
                        }
                        if (!searching && matches.isEmpty() && query.isNotEmpty()) {
                            Text(
                                stringResource(R.string.filing_no_match),
                                Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                                style = StarlingsType.body, color = c.secondary,
                            )
                        }
                    }
                }
            }
            failure?.let { Text(it, Modifier.padding(horizontal = 16.dp), style = StarlingsType.body, color = c.danger) }
        }
    }
}

private sealed interface FiledPage {
    data class Subject(val ref: SubjectRef) : FiledPage
    data class Task(val task: CrmTaskWire, val subject: SubjectRef?) : FiledPage
    data class Issue(val issue: CrmIssueWire, val projectId: String?) : FiledPage
}

/**
 * The filed subject's page in Work, pushed over the filing screen as iOS
 * pushes `MobileSubjectView` inside the sheet: its own stack of the subject,
 * its tasks and its issues. Back pops it, then closes it.
 */
@Composable
private fun MeetingSubjectStack(account: OwnerAccount, subject: SubjectRef, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val store = remember(account) { WorkStore(account, scope) }
    LaunchedEffect(store) { store.start() }
    val stack = remember { mutableStateListOf<FiledPage>(FiledPage.Subject(subject)) }
    val pop: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) else onClose() }
    val openSubject: (SubjectRef) -> Unit = { stack.add(FiledPage.Subject(it)) }
    BackHandler(onBack = pop)
    when (val page = stack.last()) {
        is FiledPage.Subject -> SubjectScreen(
            store, page.ref, pop, { issue, project -> stack.add(FiledPage.Issue(issue, project)) },
            onOpenSubject = openSubject,
            onReplaceSubject = { next -> stack.indexOf(page).takeIf { it >= 0 }?.let { stack[it] = FiledPage.Subject(next) } },
        ) { task, ref -> stack.add(FiledPage.Task(task, ref)) }
        is FiledPage.Task -> TaskScreen(store, remember(page) { TaskSource.Full(page.task, page.subject) }, pop, openSubject)
        is FiledPage.Issue -> IssueScreen(store, page.issue, page.projectId, pop)
    }
}
