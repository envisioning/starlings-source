package work.starlings.android.workspace.work

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.contracts.CrmContactDetail
import work.starlings.contracts.CrmContactOptionsResponse
import java.time.Month
import java.time.format.TextStyle
import java.util.Locale

/**
 * `MobileContactEditorView`: Add contact when
 * [contact] is null, Edit contact otherwise. Name and title, the
 * organization (a search that can create one; Add contact on a partner's
 * page starts on [organization]), the addresses one per line with the
 * primary first, the birthday, the language, the Signals status and the
 * characteristics. An edit sends only what changed in the profile
 * ([ContactProfileDraft.apply]); a new contact sends only what is set
 * ([ContactForm.create]). [onSaved] hands back the stored contact.
 */
@Composable
internal fun ContactEditorSheet(
    store: WorkStore,
    contact: CrmContactDetail?,
    onDismiss: () -> Unit,
    organization: Relation? = null,
    onSaved: (CrmContactDetail) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val key = contact?.id
    // What the contact carried when the editor opened; null for a new contact.
    val initial = remember(key) { contact?.let { ContactProfileDraft.of(it) } }
    var name by remember(key) { mutableStateOf(contact?.name.orEmpty()) }
    var title by remember(key) { mutableStateOf(contact?.title.orEmpty()) }
    var addresses by remember(key) { mutableStateOf(contact?.emails.orEmpty().joinToString("\n")) }
    var picked by remember(key) {
        mutableStateOf(
            contact?.organizationId?.let { listOf(Relation(it, contact.organizationName ?: it)) }
                ?: listOfNotNull(organization.takeIf { contact == null }),
        )
    }
    var profile by remember(key) { mutableStateOf(initial ?: ContactProfileDraft()) }
    var options by remember { mutableStateOf<CrmContactOptionsResponse?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { options = store.contactOptions() }

    fun save() {
        if (saving || name.isBlank()) return
        ContactForm.problem(name, title)?.let { problem ->
            error = when (problem) {
                is LeadForm.Problem.Required -> r.getString(R.string.work_error_required, problem.field)
                is LeadForm.Problem.TooLong -> r.getString(R.string.work_error_too_long, problem.field, problem.max)
            }
            return
        }
        profile.birthdayProblem?.let { error = it; return }
        saving = true
        scope.launch {
            try {
                val organizationId = picked.firstOrNull()?.id
                onSaved(
                    if (contact == null) store.createContact(ContactForm.create(name, title, organizationId, addresses, profile))
                    else store.updateContact(contact.id, ContactForm.update(name, title, organizationId, addresses, profile, initial)),
                )
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                saving = false
            }
        }
    }

    val locale = Locale.getDefault()
    val languages = (options?.languages.orEmpty().toSet() + profile.preferredLanguage)
        .sortedBy { ContactFilter.languageName(it).lowercase(locale) }
    // The five Signals states, and a state this build does not know when the contact carries one.
    val outreach = ContactFilter.outreach + listOfNotNull(profile.signalsOutreachStatus?.takeIf { it !in ContactFilter.outreach })
    val characteristicNames = ContactProfileDraft.characteristicNames(options?.characteristics.orEmpty(), initial?.characteristics.orEmpty() + profile.characteristics)

    WorkSheet(
        r.getString(if (contact == null) R.string.work_add_contact else R.string.work_edit_contact), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(if (saving) R.string.work_saving else R.string.work_save),
        confirmEnabled = !saving && name.isNotBlank(), onConfirm = ::save,
    ) {
        WorkSection {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(name, { name = it.replace('\n', ' ') }, r.getString(R.string.work_field_name) + " *", capitalization = KeyboardCapitalization.Words)
            }
            WorkDivider()
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(title, { title = it.replace('\n', ' ') }, r.getString(R.string.work_title_field))
            }
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_field_organization)) }) {
            RelationPicker(
                placeholder = r.getString(R.string.work_search_organizations),
                emptyText = r.getString(R.string.work_no_organizations_match),
                selected = picked, onSelected = { picked = it },
                search = store::searchOrganizations, create = store::createOrganization,
            )
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_field_addresses)) }) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(
                    addresses, { addresses = it }, r.getString(R.string.work_email_placeholder),
                    label = r.getString(R.string.work_field_addresses), keyboardType = KeyboardType.Email, singleLine = false, maxLines = 6,
                )
            }
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_birthday)) }) {
            val months = listOf<Pair<Int?, String>>(null to r.getString(R.string.work_none)) +
                Month.entries.map { it.value to it.getDisplayName(TextStyle.FULL_STANDALONE, locale).replaceFirstChar { ch -> ch.titlecase(locale) } }
            MenuPicker(r.getString(R.string.work_month), months, profile.birthdayMonth) { profile = profile.withMonth(it) }
            if (profile.birthdayMonth != null) {
                WorkDivider()
                MenuPicker(r.getString(R.string.work_day), (1..31).map<Int, Pair<Int?, String>> { it to "$it" }, profile.birthdayDay) { profile = profile.copy(birthdayDay = it) }
                WorkDivider()
                Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    StarlingsField(profile.birthdayYear?.toString().orEmpty(), { profile = profile.withYear(it) }, r.getString(R.string.work_year), keyboardType = KeyboardType.Number)
                }
            }
        }
        WorkSection {
            MenuPicker(r.getString(R.string.work_language), languages.map { it to ContactFilter.languageName(it) }, profile.preferredLanguage) {
                profile = profile.copy(preferredLanguage = it)
            }
            WorkDivider()
            MenuPicker(
                r.getString(R.string.work_signals_status),
                listOf<Pair<String?, String>>(null to r.getString(R.string.work_none)) + outreach.map { it to outreachTitle(r, it) },
                profile.signalsOutreachStatus,
            ) { profile = profile.copy(signalsOutreachStatus = it) }
        }
        if (characteristicNames.isNotEmpty()) {
            WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_characteristics)) }) {
                characteristicNames.forEachIndexed { index, key ->
                    if (index > 0) WorkDivider()
                    StarlingsToggle(
                        ContactFieldText.characteristic(key), profile.characteristics[key] == true,
                        { profile = profile.withCharacteristic(key, it, initial) },
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
            }
        }
        error?.let { WorkSection { WorkErrorNotice(it) } }
        if (saving) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), color = c.secondary, strokeWidth = 2.dp) }
    }
}
