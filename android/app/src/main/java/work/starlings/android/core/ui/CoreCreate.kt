package work.starlings.android.core.ui

import work.starlings.android.ui.toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import work.starlings.android.R
import work.starlings.android.core.coreId
import work.starlings.android.core.coreString
import work.starlings.android.core.CoreAccess
import work.starlings.android.core.CoreFields
import work.starlings.android.core.CoreRules
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkTopBar

/**
 * New <entity> (core-kit `DynamicEntityFormView` with no record): every
 * visible field of the registry's groups as its control, Save once the
 * required ones hold a value, then back to the list with "<entity> created".
 * On a contact the language follows the country until somebody picks one.
 * A task section's + and a related section's + open it with first values
 * ([CoreDoor.New.prefill]); a related one may then link the source to it.
 */
@Composable
internal fun CoreNewRecordScreen(core: CoreAccess, door: CoreDoor.New, navigation: CoreNavigation) {
    val context = LocalContext.current
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val entity = door.entity
    val contract = core.contract(entity)
    val prefill = remember(door.prefill) { CoreFields.prefill(door.prefill) }
    var values by remember(entity, contract != null) { mutableStateOf(contract?.let { CoreRules.seededValues(it, prefill) }.orEmpty()) }
    var languageEdited by remember(entity) { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }
    val options = rememberEditOptions(core, contract, null, canWrite = true)

    fun edit(change: (Map<String, JsonElement>) -> Map<String, JsonElement>) {
        val before = values
        var next = change(before)
        if (next[LANGUAGE] != before[LANGUAGE]) languageEdited = true
        if (next[COUNTRY] != before[COUNTRY] && !languageEdited && contract?.field(LANGUAGE) != null) {
            next = next + (LANGUAGE to JsonPrimitive(CoreFields.preferredLanguage(next[COUNTRY].coreString().orEmpty())))
        }
        values = next
    }

    fun save() {
        val contract = contract ?: return
        if (saving) return
        saving = true
        scope.launch {
            try {
                val saved = core.create(contract.id, CoreRules.payload(contract, values))
                // `onSaved`: the source's own relation now names the new record.
                door.link?.let { link -> core.save(link.entity, link.id, mapOf(link.field to JsonPrimitive(saved.coreId))) }
                toast(context.getString(R.string.core_created, contract.singularLabel))
                navigation.back()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                saveError = e.message
            } finally {
                saving = false
            }
        }
    }

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(contract?.let { stringResource(R.string.core_new_entity, it.singularLabel) } ?: stringResource(R.string.core_title), stringResource(R.string.core_cancel), navigation.back) {
            if (contract != null) {
                FilledButton(
                    stringResource(if (saving) R.string.core_saving else R.string.core_save),
                    ::save,
                    Modifier.padding(end = 8.dp),
                    enabled = !saving && CoreRules.requiredPresent(contract, values),
                    compact = true,
                )
            }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            if (contract == null || !contract.canCreate) {
                WorkSection { WorkErrorNotice(core.errorMessage ?: stringResource(R.string.core_not_listed)) }
                return@Column
            }
            CoreFieldGroups(
                contract, JsonObject(values), values, canWrite = true, options,
                onEdit = ::edit,
                onOpen = { target -> navigation.openRelated(target.entity, target.id, target.title) },
            )
        }
    }
    if (saving) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), color = c.secondary, strokeWidth = 2.dp) }
    }
    saveError?.let { message -> CoreSaveError(message) { saveError = null } }
}

private const val LANGUAGE = "preferred_language"
private const val COUNTRY = "country"
