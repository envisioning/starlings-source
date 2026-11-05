package work.starlings.android.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import work.starlings.android.R
import work.starlings.android.core.CoreAccess
import work.starlings.android.core.CoreFields
import work.starlings.android.core.CoreRules
import work.starlings.android.core.CoreSearchResult
import work.starlings.android.core.CoreSignals
import work.starlings.android.core.coreDisplayName
import work.starlings.android.core.coreId
import work.starlings.android.core.coreObject
import work.starlings.android.core.coreString
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.android.ui.WorkTopBar

/**
 * Search Core (`MobileCoreSearchScreen` over `CRMGlobalSearchView`): one
 * field, Core's `search` 250 ms after the last key, the hits whose entity
 * this account may read. "No Results" is said only once a search finished
 * for the query in the field; until then it is still Searching…. A hit
 * opens its record (a lead or a project on its Work page).
 */
@Composable
internal fun CoreSearchScreen(core: CoreAccess, navigation: CoreNavigation) {
    val c = Starlings.colors
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<CoreSearchResult>>(emptyList()) }
    var settled by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(query, attempt) {
        val q = CoreRules.searchQuery(query)
        if (q == null) { results = emptyList(); error = null; settled = ""; return@LaunchedEffect }
        delay(CoreRules.SEARCH_DEBOUNCE_MS)
        error = null
        try {
            results = CoreRules.allowed(core.search(q), core.contracts)
            settled = q
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message
        }
    }
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(stringResource(R.string.core_search_field), stringResource(R.string.back), navigation.back)
        Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            StarlingsField(query, { query = it }, stringResource(R.string.core_search_field))
        }
        val trimmed = query.trim()
        when {
            trimmed.isEmpty() -> CoreEmptyState(stringResource(R.string.core_search))
            results.isEmpty() && error != null -> Column(Modifier.padding(top = 8.dp)) {
                WorkSection(header = { WorkHeaderTitle(stringResource(R.string.core_unable_to_search)) }) {
                    WorkErrorNotice(error!!, retry = stringResource(R.string.core_retry), onRetry = { attempt++ })
                }
            }
            results.isEmpty() && settled == trimmed -> CoreEmptyState(stringResource(R.string.core_no_results, trimmed))
            results.isEmpty() -> CoreEmptyState(stringResource(R.string.core_searching))
            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
                itemsIndexed(results, key = { _, hit -> "${hit.entity}/${hit.id}" }) { index, hit ->
                    val contract = core.contract(hit.entity)
                    Column(Modifier.padding(horizontal = 16.dp).background(c.panel, panelShape(index, results.size))) {
                        if (index > 0) WorkDivider()
                        val lines = listOfNotNull(contract?.singularLabel, hit.description).filter { it.isNotEmpty() }
                        val open = { navigation.push(CoreDoor.Record(hit.entity, hit.id, hit.name)) }
                        if (CoreFields.identity(hit.entity).showsAvatar) {
                            // `CRMGlobalSearchRow`: a face for an entity that has one.
                            CoreSearchFaceRow(hit.imageUrl?.takeIf(CoreFields::secureImage), hit.name, hit.entity, contract?.icon.orEmpty(), lines.take(2), open)
                        } else {
                            WorkSidebarRow(coreIcon(contract?.icon.orEmpty()), hit.name, lines.take(2).joinToString("\n"), open, square = true)
                        }
                    }
                }
            }
        }
    }
}

/** A search hit with its face over its initials. */
@Composable
private fun CoreSearchFaceRow(url: String?, name: String, entity: String, symbol: String, lines: List<String>, onOpen: () -> Unit) {
    val c = Starlings.colors
    androidx.compose.foundation.layout.Row(
        Modifier.fillMaxWidth().clickable(role = androidx.compose.ui.semantics.Role.Button, onClick = onOpen).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CoreAvatar(url, name, entity, symbol)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(name, style = StarlingsType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = c.primary)
            lines.forEach { Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1) }
        }
    }
}

/** A quiet centred line where a list has nothing to show (`EnvisioningEmptyState`). */
@Composable
internal fun CoreEmptyState(text: String) {
    Box(Modifier.fillMaxWidth().padding(top = 48.dp, start = 32.dp, end = 32.dp), contentAlignment = Alignment.Center) {
        Text(text, style = StarlingsType.body, color = Starlings.colors.secondary)
    }
}
