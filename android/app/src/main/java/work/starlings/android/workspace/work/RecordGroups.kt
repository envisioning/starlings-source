package work.starlings.android.workspace.work

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import kotlinx.coroutines.CancellationException
import work.starlings.android.R
import work.starlings.android.api.SubjectRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.contracts.CrmLicense
import work.starlings.contracts.CrmOffer

/**
 * One read-only group on Browse (decided by MZ, 2026-11-05): a fold, then its rows
 * once it opens. The keys are `BROWSE_RECORD_GROUPS` in the contracts. Editing and
 * the filters are on the web and the Mac.
 */
@Composable
private fun <T> RecordGroup(
    store: WorkStore,
    key: String,
    title: String,
    read: suspend () -> List<T>,
    rowKey: (T) -> String,
    line: (T) -> Pair<String, String>,
    onOpen: (T) -> Unit,
) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val prefs = remember { context.getSharedPreferences("work", Context.MODE_PRIVATE) }
    var folded by remember { mutableStateOf(prefs.getBoolean("fold.browse.$key", true)) }
    var rows by remember { mutableStateOf<List<T>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }

    LaunchedEffect(folded, attempt) {
        if (folded) return@LaunchedEffect
        try {
            rows = read()
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        }
    }

    WorkSection(
        header = {
            WorkFoldTitle(title, folded, r.getString(R.string.work_folded), r.getString(R.string.work_open)) {
                folded = !folded
                prefs.edit().putBoolean("fold.browse.$key", folded).apply()
            }
        },
    ) {
        if (!folded) {
            val current = rows
            val failure = error
            when {
                failure != null -> WorkErrorNotice(failure, retry = r.getString(R.string.work_retry), onRetry = { attempt++ })
                current == null -> WorkPlaceholderRows()
                current.isEmpty() -> WorkNote(stringResource(R.string.work_nothing_matches))
                else -> current.forEachIndexed { index, row ->
                    if (index > 0) WorkDivider()
                    val (name, detail) = line(row)
                    Column(
                        Modifier.fillMaxWidth().clickable(role = Role.Button) { onOpen(row) }.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(name, style = StarlingsType.body, color = c.primary, maxLines = 1)
                        if (detail.isNotEmpty()) Text(detail, style = StarlingsType.footnote, color = c.secondary, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
internal fun OffersGroup(store: WorkStore) {
    val r = LocalContext.current.resources
    var open by remember { mutableStateOf<String?>(null) }
    RecordGroup<CrmOffer>(
        store, "offers", stringResource(R.string.work_offers),
        read = { store.client.call(SubjectRoutes.offers()).offers },
        rowKey = { it.id },
        line = { offer ->
            OverviewText.offerTitle(r, offer) to listOfNotNull(offer.organizationName ?: offer.leadTitle, OverviewText.offer(r, offer).takeIf { it.isNotEmpty() }).joinToString(" · ")
        },
        onOpen = { open = it.id },
    )
    open?.let { id -> OfferScreen(store, id, onDismiss = { open = null }, onChanged = {}) }
}

@Composable
internal fun LicensesGroup(store: WorkStore) {
    val r = LocalContext.current.resources
    var open by remember { mutableStateOf<CrmLicense?>(null) }
    RecordGroup<CrmLicense>(
        store, "licenses", stringResource(R.string.work_licenses),
        read = { store.client.call(SubjectRoutes.licenses()).licenses },
        rowKey = { it.id },
        line = { license ->
            (license.organizationName ?: license.leadTitle ?: OverviewText.licenseTitle(r, license)) to OverviewText.license(r, license)
        },
        onOpen = { open = it },
    )
    open?.let { license -> LicenseScreen(license, onDismiss = { open = null }) }
}
