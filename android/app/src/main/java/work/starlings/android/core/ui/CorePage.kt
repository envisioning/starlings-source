package work.starlings.android.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.TrendingUp
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Radar
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Support
import androidx.compose.material.icons.filled.TrackChanges
import androidx.compose.material.icons.filled.ViewCarousel
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.core.CoreAccess
import work.starlings.android.core.CoreRules
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.android.ui.WorkTopBar

/**
 * Where Work's Other records page can go: the page itself, an entity's list, one
 * record and Search records. Each is a line in Work's
 * saved stack (`WorkPage.Core`), so Back and a rotation keep it.
 */
sealed interface CoreDoor {
    data object Page : CoreDoor
    data class Entity(val id: String) : CoreDoor
    data class Record(val entity: String, val id: String, val title: String?) : CoreDoor
    /**
     * New <entity> (`DynamicEntityFormView`), from the list's Add, a task
     * section's + or a related section's + (`initialValues`). [prefill] is
     * the first values as a JSON object's text; [link] is the source record
     * whose own relation is set to the new one once it is saved (`onSaved`).
     */
    data class New(val entity: String, val prefill: String? = null, val link: Link? = null) : CoreDoor {
        data class Link(val entity: String, val id: String, val field: String)
    }
    data object Search : CoreDoor

    companion object {
        fun encode(door: CoreDoor): Map<String, String?> = when (door) {
            Page -> mapOf("door" to "page")
            is Entity -> mapOf("door" to "entity", "entity" to door.id)
            is Record -> mapOf("door" to "record", "entity" to door.entity, "id" to door.id, "title" to door.title)
            is New -> mapOf(
                "door" to "new", "entity" to door.entity, "prefill" to door.prefill,
                "linkEntity" to door.link?.entity, "linkId" to door.link?.id, "linkField" to door.link?.field,
            )
            Search -> mapOf("door" to "search")
        }

        fun decode(fields: (String) -> String?): CoreDoor? = when (fields("door")) {
            "page" -> Page
            "entity" -> fields("entity")?.let(::Entity)
            "record" -> {
                val entity = fields("entity")
                val id = fields("id")
                if (entity != null && id != null) Record(entity, id, fields("title")) else null
            }
            "new" -> fields("entity")?.let { entity ->
                val linkEntity = fields("linkEntity")
                val linkId = fields("linkId")
                val linkField = fields("linkField")
                val link = if (linkEntity != null && linkId != null && linkField != null) New.Link(linkEntity, linkId, linkField) else null
                New(entity, fields("prefill"), link)
            }
            "search" -> Search
            else -> null
        }
    }
}

/**
 * What a Core screen hands back to Work: a push onto its stack, Back, and a
 * lead or a project opened on its Work page at Talk (`CRMRelatedTarget.workSubject`).
 */
class CoreNavigation(
    val push: (CoreDoor) -> Unit,
    val back: () -> Unit,
    val openWorkSubject: (kind: String, id: String, title: String) -> Unit,
) {
    /** `crmOpenRelated`: a lead or a project goes to Work; anything else is its registry detail. */
    fun openRelated(entity: String, id: String, title: String?) {
        val kind = CoreRules.workSubjectKind(entity)
        if (kind != null) openWorkSubject(kind, id, title.orEmpty()) else push(CoreDoor.Record(entity, id, title))
    }
}

/** One Core door drawn. */
@Composable
fun CoreScreen(door: CoreDoor, navigation: CoreNavigation) {
    val context = LocalContext.current
    val core = androidx.compose.runtime.remember { CoreAccess.of(context) }
    when (door) {
        CoreDoor.Page -> CorePageScreen(core, navigation)
        is CoreDoor.Entity -> CoreEntityDoor(core, door.id, navigation)
        is CoreDoor.Record -> CoreRecordScreen(core, door.entity, door.id, door.title, navigation)
        is CoreDoor.New -> CoreNewRecordScreen(core, door, navigation)
        CoreDoor.Search -> CoreSearchScreen(core, navigation)
    }
}

/** The page behind Browse's foot row (`MobileWorkView.otherRecordsList`): the section, titled Other records. */
@Composable
private fun CorePageScreen(core: CoreAccess, navigation: CoreNavigation) {
    Column(Modifier.fillMaxSize().background(Starlings.colors.canvas)) {
        WorkTopBar(stringResource(R.string.core_title), stringResource(R.string.back), navigation.back)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 8.dp, bottom = 24.dp)) {
            CoreSection(core, navigation)
        }
    }
}

/**
 * `MobileCoreSection`: Search records, then one row per entity this account
 * may list (minus Work's own), each with its count, or whether it can be
 * edited. Not connected yet, it is one button.
 */
@Composable
internal fun CoreSection(core: CoreAccess, navigation: CoreNavigation) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    LaunchedEffect(core.isLinked) { if (core.isLinked) core.refreshIfNeeded() }
    val linked = core.isLinked
    WorkSection {
        if (linked) {
            WorkSidebarRow(Icons.Filled.Search, stringResource(R.string.core_search), stringResource(R.string.core_search_subtitle), { navigation.push(CoreDoor.Search) }, square = true)
            core.entities.forEach { contract ->
                WorkDivider()
                val count = core.recordCounts[contract.id]
                val subtitle = when {
                    count != null -> pluralStringResource(R.plurals.core_entries, count, CoreRules.count(count))
                    contract.canUpdate -> stringResource(R.string.core_read_and_edit)
                    else -> stringResource(R.string.core_read_only)
                }
                WorkSidebarRow(coreIcon(contract.icon), contract.pluralLabel, subtitle, { navigation.push(CoreDoor.Entity(contract.id)) }, square = true)
            }
            if (core.entities.isEmpty() && core.isLoading) WorkPlaceholderRows()
            core.errorMessage?.let { WorkErrorNotice(it) }
        } else {
            if (core.isLinking) {
                Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = c.secondary, strokeWidth = 2.dp)
                }
            } else {
                WorkActionRow(stringResource(R.string.core_connect), { scope.launch { core.link() } })
            }
            core.errorMessage?.let { message ->
                if (core.needsCoreAccount) {
                    Text(message, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = StarlingsType.footnote, color = c.secondary)
                } else {
                    WorkErrorNotice(message)
                }
            }
        }
    }
}

/**
 * `MobileCoreEntityDoor`: one entity by id. The registry may still be
 * loading, so the door waits rather than answering "not here" to a list
 * that has not arrived; an id the registry does not list is said plainly.
 */
@Composable
private fun CoreEntityDoor(core: CoreAccess, id: String, navigation: CoreNavigation) {
    val contract = core.entities.firstOrNull { it.id == id } ?: core.contract(id)?.takeIf { it.canList }
    if (contract != null) {
        CoreEntityListScreen(core, contract, navigation)
        return
    }
    Column(Modifier.fillMaxSize().background(Starlings.colors.canvas)) {
        WorkTopBar(stringResource(R.string.core_title), stringResource(R.string.back), navigation.back)
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            when {
                !core.isLinked -> CoreSection(core, navigation)
                core.isLoading && core.contracts.isEmpty() -> WorkSection { WorkPlaceholderRows() }
                else -> WorkSection { WorkErrorNotice(core.errorMessage ?: stringResource(R.string.core_not_listed)) }
            }
        }
    }
}

/** `SFSymbolResolver` for the symbols Core's registry names, as Material icons; the grid when unknown. */
internal fun coreIcon(symbol: String): ImageVector = when (symbol) {
    "building.2" -> Icons.Filled.Business
    "person.2" -> Icons.Filled.People
    "folder" -> Icons.Filled.Folder
    "flag" -> Icons.Filled.Flag
    "target" -> Icons.Filled.TrackChanges
    "checkmark.square" -> Icons.Filled.CheckBox
    "doc.text" -> Icons.Filled.Description
    "envelope" -> Icons.Filled.Email
    "receipt" -> Icons.Filled.Receipt
    "shield" -> Icons.Filled.Shield
    "lifepreserver" -> Icons.Filled.Support
    "radar" -> Icons.Filled.Radar
    "chart.line.uptrend.xyaxis" -> Icons.AutoMirrored.Filled.TrendingUp
    "bubble.left.and.bubble.right" -> Icons.AutoMirrored.Filled.Chat
    "square.stack.3d.up" -> Icons.Filled.Layers
    "rectangle.on.rectangle" -> Icons.Filled.ViewCarousel
    "person" -> Icons.Filled.Person
    "calendar" -> Icons.Filled.Event
    "arrow.triangle.branch" -> Icons.Filled.AccountTree
    "shippingbox" -> Icons.Filled.Inventory2
    "note.text" -> Icons.Filled.EditNote
    "phone" -> Icons.Filled.Phone
    "globe" -> Icons.Filled.Public
    else -> Icons.Filled.GridView
}
