package work.starlings.android.workspace.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.workspace.work.WorkStore
import work.starlings.android.workspace.work.inboxSourceTitle
import work.starlings.android.workspace.work.workMessage

/**
 * Settings › Work (`MobileWorkSettingsSection` in iOS/MobileSettingsView.swift):
 * which subject kinds show in Work, and what Inbox carries. Both are the
 * Worker's subject state, so they follow the account to the Mac and the web.
 * The state is [WorkStore]'s: the page reads and writes through it.
 */
@Composable
internal fun WorkSettingsPage(account: OwnerAccount) {
    val scope = rememberCoroutineScope()
    val store = remember(account) { WorkStore(account, scope) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(store) {
        try {
            store.loadSubjectState()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.workMessage()
        }
    }
    fun write(change: suspend () -> Unit) {
        scope.launch {
            try {
                change()
                error = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.workMessage()
            }
        }
    }

    val state = store.subjectState
    if (state == null) {
        ListSection(stringResource(R.string.settings_show_in_work)) {
            if (error == null) WorkPlaceholderRows()
            error?.let { WorkErrorNotice(it) }
        }
        return
    }
    val hidden = WorkSettingsRows.hiddenKinds(state.hiddenKinds?.map { it.value }, state.salesEnabled)
    val kinds = WorkSettingsRows.offered(state.workModules?.map { it.value })
    Column {
        ListSection(stringResource(R.string.settings_show_in_work)) {
            kinds.forEachIndexed { index, row ->
                val shown = row.kind !in hidden
                ListRow(divider = index < kinds.lastIndex) {
                    StarlingsToggle(stringResource(kindTitle(row)), shown, { on ->
                        write { store.setHiddenKinds(WorkSettingsRows.toggled(hidden, row.kind, on)) }
                    })
                    Detail(stringResource(kindDetail(row)))
                }
            }
            error?.let { WorkErrorNotice(it) }
        }
        ListFooter(stringResource(R.string.settings_show_in_work_footer))
    }
    val r = LocalContext.current.resources
    val sources = WorkSettingsRows.inboxSources(state.inboxAvailableSources.map { it.value })
    if (sources.isEmpty()) return
    Column {
        ListSection(stringResource(R.string.settings_inbox)) {
            sources.forEachIndexed { index, source ->
                ListRow(divider = index < sources.lastIndex) {
                    StarlingsToggle(
                        inboxSourceTitle(r, source),
                        WorkSettingsRows.isOn(state.inboxSources, source),
                        { on -> write { store.setInboxSource(source, on) } },
                        enabled = WorkSettingsRows.isEnabled(source, state.salesEnabled),
                    )
                    inboxDetail(source)?.let { Detail(stringResource(it)) }
                }
            }
        }
        ListFooter(stringResource(R.string.settings_inbox_footer))
    }
}

@Composable
private fun Detail(text: String) {
    Text(text, style = StarlingsType.footnote, color = Starlings.colors.secondary)
}

private fun kindTitle(row: WorkSettingsRows.ShownKind): Int = when (row) {
    WorkSettingsRows.ShownKind.PROJECT -> R.string.settings_kind_projects
    WorkSettingsRows.ShownKind.LEAD -> R.string.settings_kind_leads
    WorkSettingsRows.ShownKind.ORGANIZATION -> R.string.settings_kind_organizations
    WorkSettingsRows.ShownKind.EVENT -> R.string.settings_kind_events
}

private fun kindDetail(row: WorkSettingsRows.ShownKind): Int = when (row) {
    WorkSettingsRows.ShownKind.PROJECT -> R.string.settings_kind_projects_detail
    WorkSettingsRows.ShownKind.LEAD -> R.string.settings_kind_leads_detail
    WorkSettingsRows.ShownKind.ORGANIZATION -> R.string.settings_kind_organizations_detail
    WorkSettingsRows.ShownKind.EVENT -> R.string.settings_kind_events_detail
}

/** `InboxSourceSpec.detail`: what arrives, and what makes it leave. */
private fun inboxDetail(source: String): Int? = when (source) {
    "decision" -> R.string.settings_inbox_decision
    "question" -> R.string.settings_inbox_question
    "card" -> R.string.settings_inbox_card
    "followup" -> R.string.settings_inbox_followup
    "talk" -> R.string.settings_inbox_talk
    "guest" -> R.string.settings_inbox_guest
    "support" -> R.string.settings_inbox_support
    "task" -> R.string.settings_inbox_task
    "note" -> R.string.settings_inbox_note
    "sales" -> R.string.settings_inbox_sales
    "comment" -> R.string.settings_inbox_comment
    "booking" -> R.string.settings_inbox_booking
    "invitation" -> R.string.settings_inbox_invitation
    "forwarded" -> R.string.settings_inbox_forwarded
    "interest" -> R.string.settings_inbox_interest
    "submission" -> R.string.settings_inbox_submission
    "commercial" -> R.string.settings_inbox_commercial
    else -> null
}
