package work.starlings.android.workspace.work

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.contracts.CrmOrganizationUpdate
import work.starlings.contracts.CrmSubjectDetailWire
import work.starlings.contracts.Patch

/**
 * `OrganizationDraft` (Sources/OrganizationDraft.swift): Edit
 * organization's name, the eight fields the Core form edits most, and the
 * three flags. [patch] sends only what changed.
 */
data class OrganizationDraft(
    val name: String,
    val text: Map<Field, String>,
    val flags: Map<Flag, Boolean>,
) {
    enum class Field(val label: Int) {
        URL(R.string.work_website),
        INDUSTRY(R.string.work_industry),
        LEGAL_NAME(R.string.work_legal_name),
        CITY(R.string.work_city),
        COUNTRY(R.string.work_country),
        LINKEDIN_URL(R.string.work_linkedin),
        DOMAIN(R.string.work_domain),
        NOTES(R.string.work_field_notes),
        ;

        val isUrl: Boolean get() = this == URL || this == LINKEDIN_URL
        val isLong: Boolean get() = this == NOTES
    }

    enum class Flag(val label: Int) {
        PARTNER(R.string.work_partner),
        AGENCY(R.string.work_agency),
        EXISTING_CLIENT(R.string.work_existing_client),
    }

    val trimmedName: String get() = name.trim()
    val canSave: Boolean get() = trimmedName.isNotEmpty() && trimmedName.length <= NAME_LIMIT

    fun value(field: Field): String = text[field].orEmpty()
    fun flag(flag: Flag): Boolean = flags[flag] == true

    fun with(field: Field, value: String) = copy(text = text + (field to value))
    fun with(flag: Flag, on: Boolean) = copy(flags = flags + (flag to on))

    /** The fields that changed since [before]: a blank text clears, a name is never blanked. Null when nothing changed. */
    fun patch(before: OrganizationDraft): CrmOrganizationUpdate? {
        var changed = false
        val name = trimmedName.takeIf { it.isNotEmpty() && it != before.trimmedName }?.also { changed = true }
        val sent = Field.entries.associateWith { field ->
            val after = value(field).trim()
            if (after == before.value(field).trim()) return@associateWith Patch.Omit
            changed = true
            val clean = if (field.isUrl) normalizedUrl(after) else after
            if (clean.isEmpty()) Patch.Null else Patch.Value(clean)
        }
        fun flagged(flag: Flag): Boolean? = flag(flag).takeIf { it != before.flag(flag) }?.also { changed = true }
        val partner = flagged(Flag.PARTNER)
        val agency = flagged(Flag.AGENCY)
        val existingClient = flagged(Flag.EXISTING_CLIENT)
        if (!changed) return null
        return CrmOrganizationUpdate(
            name = name,
            url = sent.getValue(Field.URL),
            industry = sent.getValue(Field.INDUSTRY),
            legalName = sent.getValue(Field.LEGAL_NAME),
            city = sent.getValue(Field.CITY),
            country = sent.getValue(Field.COUNTRY),
            linkedinUrl = sent.getValue(Field.LINKEDIN_URL),
            domain = sent.getValue(Field.DOMAIN),
            notes = sent.getValue(Field.NOTES),
            isPartner = partner,
            isAgency = agency,
            isExistingClient = existingClient,
        )
    }

    companion object {
        /** The cap the Worker puts on a name. */
        const val NAME_LIMIT = 200

        fun of(detail: CrmSubjectDetailWire) = OrganizationDraft(
            name = detail.title,
            text = mapOf(
                Field.URL to detail.url.orEmpty(),
                Field.INDUSTRY to detail.industry.orEmpty(),
                Field.LEGAL_NAME to detail.legalName.orEmpty(),
                Field.CITY to detail.city.orEmpty(),
                Field.COUNTRY to detail.country.orEmpty(),
                Field.LINKEDIN_URL to detail.linkedinUrl.orEmpty(),
                Field.DOMAIN to detail.domain.orEmpty(),
                Field.NOTES to detail.notes.orEmpty(),
            ),
            flags = mapOf(
                Flag.PARTNER to (detail.isPartner == true),
                Flag.AGENCY to (detail.isAgency == true),
                Flag.EXISTING_CLIENT to (detail.isExistingClient == true),
            ),
        )

        private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

        /** `FormFieldRegistry.normalizedURL`: a bare host gets `https://`; a value with a scheme stays as typed. */
        fun normalizedUrl(value: String): String {
            val trimmed = value.trim()
            if (trimmed.isEmpty()) return ""
            return if (SCHEME.containsMatchIn(trimmed)) trimmed else "https://$trimmed"
        }
    }
}

/** `MobileOrganizationEditorView`: Name, the draft's fields, the three flags. Save sends only what changed. */
@Composable
internal fun OrganizationEditorSheet(store: WorkStore, detail: CrmSubjectDetailWire, onDismiss: () -> Unit, onSaved: (CrmSubjectDetailWire) -> Unit) {
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    val initial = remember(detail.id) { OrganizationDraft.of(detail) }
    var draft by remember(detail.id) { mutableStateOf(initial) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun save() {
        if (saving || !draft.canSave) return
        val patch = draft.patch(initial) ?: return onDismiss()
        saving = true
        scope.launch {
            try {
                onSaved(store.updateOrganization(detail.id, patch))
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                saving = false
            }
        }
    }
    WorkSheet(
        r.getString(R.string.work_edit_organization), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(if (saving) R.string.work_saving else R.string.work_save),
        confirmEnabled = !saving && draft.canSave, onConfirm = ::save,
    ) {
        WorkSection {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(draft.name, { draft = draft.copy(name = it.replace('\n', ' ')) }, r.getString(R.string.work_field_name) + " *", capitalization = KeyboardCapitalization.Words)
            }
        }
        WorkSection {
            OrganizationDraft.Field.entries.forEachIndexed { index, field ->
                if (index > 0) WorkDivider()
                Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    val plain = field.isUrl || field == OrganizationDraft.Field.DOMAIN
                    StarlingsField(
                        draft.value(field), { draft = draft.with(field, if (field.isLong) it else it.replace('\n', ' ')) }, r.getString(field.label),
                        keyboardType = if (field.isUrl) KeyboardType.Uri else KeyboardType.Text,
                        capitalization = if (plain) KeyboardCapitalization.None else KeyboardCapitalization.Words,
                        singleLine = !field.isLong, maxLines = if (field.isLong) 6 else 1,
                    )
                }
            }
        }
        WorkSection {
            OrganizationDraft.Flag.entries.forEachIndexed { index, flag ->
                if (index > 0) WorkDivider()
                StarlingsToggle(r.getString(flag.label), draft.flag(flag), { draft = draft.with(flag, it) }, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
        }
        error?.let { WorkSection { WorkErrorNotice(it) } }
    }
}

/** The organization's delete question: its name, that it can't be undone, a destructive Delete and Cancel. */
@Composable
internal fun OrganizationDeleteDialog(name: String, onDismiss: () -> Unit, onDelete: () -> Unit) {
    val c = Starlings.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(stringResource(R.string.work_delete_title, name), style = StarlingsType.headline, color = c.primary) },
        text = { Text(stringResource(R.string.work_organization_delete_message), style = StarlingsType.body, color = c.secondary) },
        confirmButton = { TextButton(onDelete) { Text(stringResource(R.string.work_delete), color = c.danger) } },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
    )
}
