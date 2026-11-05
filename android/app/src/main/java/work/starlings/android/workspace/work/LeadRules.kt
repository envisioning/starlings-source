package work.starlings.android.workspace.work

import work.starlings.contracts.CrmLeadCreate
import work.starlings.contracts.CrmLeadUpdate
import work.starlings.contracts.CrmProjectCreate
import work.starlings.contracts.CrmProjectStatus
import work.starlings.contracts.CrmProjectUpdate
import work.starlings.contracts.CrmSubjectCreate
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmLeadStatus
import work.starlings.contracts.Patch
import work.starlings.contracts.UntriagedTouchPrefill
import work.starlings.contracts.UntriagedTouchWire
import java.text.Normalizer
import java.time.LocalDate

/**
 * `Sources/LeadQualification.swift`, held to `fixtures/lead-qualification.json`:
 * the five checks of a lead's Qualification. Only these keys are
 * written; every other characteristic stays as it was read.
 */
object LeadQualification {
    val keys = listOf("budget_availability", "event_timeline", "previous_engagement", "project_fit", "stakeholder_buy_in")

    fun isSet(key: String, characteristics: Map<String, Boolean>?): Boolean = characteristics?.get(key) == true

    fun count(characteristics: Map<String, Boolean>?): Int = keys.count { isSet(it, characteristics) }

    fun merged(existing: Map<String, Boolean>?, key: String, value: Boolean): Map<String, Boolean> {
        val record = existing.orEmpty().toMutableMap()
        if (key in keys) record[key] = value
        return record
    }
}

/**
 * The subject editor's rules (`MobileSubjectEditorView`, `SubjectFormFields`):
 * a lead's or a project's statuses (`fixtures/subject-status.json`), the
 * field rules a save checks (`FormFieldRegistry.lead` and `.project`,
 * `fixtures/form-fields.json`), and the create or the edit it sends. A blank
 * goes as the table says: left out on a create, null on an edit where the
 * table says so. [LeadForm] is the lead's half, kept by name.
 */
object SubjectForm {
    /** One field's rule: its id, the label a problem names (English, as an error), whether a save needs it, and how long it may be. */
    data class Spec(val id: String, val required: Boolean, val maxLength: Int?, val label: String = "")

    /** The fields the editor checks: `text` is a lead's notes and a project's description. */
    data class Fields(val title: Spec, val organization: Spec, val text: Spec, val startDate: Spec)

    val lead = Fields(
        title = Spec("title", required = true, maxLength = 100, label = "Name"),
        organization = Spec("organization", required = true, maxLength = null, label = "Organization"),
        text = Spec("notes", required = false, maxLength = 10_000, label = "Notes"),
        startDate = Spec("startDate", required = true, maxLength = 30, label = "Start date"),
    )
    val project = Fields(
        title = Spec("title", required = true, maxLength = 200, label = "Name"),
        organization = Spec("organization", required = false, maxLength = null, label = "Organization"),
        text = Spec("description", required = false, maxLength = 2000, label = "Description"),
        startDate = Spec("startDate", required = false, maxLength = 30, label = "Start date"),
    )

    /** A project's end date, for the table test. */
    val projectEndDate = Spec("endDate", required = false, maxLength = 30, label = "End date")

    fun fields(kind: CrmSubjectKind): Fields = if (kind == CrmSubjectKind.LEAD) lead else project

    val projectStatuses = listOf("Active", "Paused", "Archived")
    const val PROJECT_DEFAULT_STATUS = "Active"

    /** `CrmSubjectStatusOption.editable(for:)`. */
    fun statuses(kind: CrmSubjectKind): List<String> = if (kind == CrmSubjectKind.LEAD) LeadForm.statuses else projectStatuses

    /** `defaultStatus`: what a new subject starts as, a wire value. */
    fun defaultStatus(kind: CrmSubjectKind): String = if (kind == CrmSubjectKind.LEAD) LeadForm.DEFAULT_STATUS else PROJECT_DEFAULT_STATUS

    /** Why a save cannot go yet: the first required field left blank, then the first one too long. */
    sealed interface Problem {
        val field: String
        data class Required(override val field: String) : Problem
        data class TooLong(override val field: String, val max: Int) : Problem
    }

    /**
     * `FormFieldRegistry.problem` over the title, the organization and the
     * text. [lacking] holds the ids the stored record already has blank: an
     * edit does not ask for those.
     */
    fun problem(kind: CrmSubjectKind, title: String, organizationId: String?, text: String, lacking: Set<String> = emptySet()): Problem? {
        val f = fields(kind)
        val values = listOf(f.title to title, f.organization to organizationId, f.text to text)
        values.firstOrNull { (spec, value) -> spec.required && spec.id !in lacking && value?.trim().isNullOrEmpty() }?.let { return Problem.Required(it.first.id) }
        values.firstOrNull { (spec, value) -> spec.maxLength != null && (value?.trim()?.length ?: 0) > spec.maxLength }
            ?.let { return Problem.TooLong(it.first.id, it.first.maxLength!!) }
        return null
    }

    /** The English label a problem names, as `FormFieldRegistry.problem` says it. */
    fun label(kind: CrmSubjectKind, id: String): String =
        fields(kind).let { listOf(it.title, it.organization, it.text, it.startDate) }.firstOrNull { it.id == id }?.label ?: id

    /** What the editor holds when it saves (`CrmSubjectDraft` and `CrmSubjectUpdate`'s arguments). */
    data class Draft(
        val kind: CrmSubjectKind,
        val title: String,
        val status: String,
        /** A lead always has one; a project only while Has a start date is on. */
        val startDate: LocalDate?,
        val endDate: LocalDate? = null,
        val description: String = "",
        val url: String = "",
        val notes: String = "",
        val organizationId: String? = null,
        /** A lead's one contact, or a project's contacts. */
        val contactIds: List<String> = emptyList(),
        /** A lead's characteristics as read, the five checks changed. */
        val characteristics: Map<String, Boolean> = emptyMap(),
    )

    private fun clean(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }
    private fun omitBlank(value: String?): Patch<String> = clean(value)?.let { Patch.Value(it) } ?: Patch.Omit
    private fun nullBlank(value: String?): Patch<String> = clean(value)?.let { Patch.Value(it) } ?: Patch.Null
    private fun url(value: String): String? = clean(value)?.let { OrganizationDraft.normalizedUrl(it) }

    /** The create: blanks left out; a lead starts on a day (today when none), a project's contacts only when some are chosen. */
    fun create(draft: Draft): CrmSubjectCreate = when (draft.kind) {
        CrmSubjectKind.LEAD -> CrmLeadCreate(
            title = omitBlank(draft.title),
            organizationId = omitBlank(draft.organizationId),
            contactId = omitBlank(draft.contactIds.firstOrNull()),
            status = CrmLeadStatus(draft.status),
            startDate = (draft.startDate ?: LocalDate.now()).toString(),
            notes = omitBlank(draft.notes),
            characteristics = Patch.Value(draft.characteristics),
        )
        else -> CrmProjectCreate(
            title = draft.title.trim(),
            description = omitBlank(draft.description),
            url = url(draft.url)?.let { Patch.Value(it) } ?: Patch.Omit,
            organizationId = omitBlank(draft.organizationId),
            contactIds = draft.contactIds.ifEmpty { null },
            startDate = omitBlank(draft.startDate?.toString()),
            endDate = omitBlank(draft.endDate?.toString()),
            status = CrmProjectStatus(draft.status),
        )
    }

    /** A lead's edit, the whole state: a cleared organization, contact or notes is sent as null. */
    fun leadUpdate(draft: Draft): CrmLeadUpdate = CrmLeadUpdate(
        title = omitBlank(draft.title),
        organizationId = nullBlank(draft.organizationId),
        contactId = nullBlank(draft.contactIds.firstOrNull()),
        status = CrmLeadStatus(draft.status),
        startDate = draft.startDate?.toString(),
        notes = nullBlank(draft.notes),
        characteristics = Patch.Value(draft.characteristics),
    )

    /** A project's edit, the whole state: the contacts are sent even when none, a cleared field as null. */
    fun projectUpdate(draft: Draft): CrmProjectUpdate = CrmProjectUpdate(
        title = clean(draft.title),
        description = nullBlank(draft.description),
        url = url(draft.url)?.let { Patch.Value(it) } ?: Patch.Null,
        organizationId = nullBlank(draft.organizationId),
        contactIds = draft.contactIds,
        startDate = nullBlank(draft.startDate?.toString()),
        endDate = nullBlank(draft.endDate?.toString()),
        status = CrmProjectStatus(draft.status),
    )

    /** `CrmSubjectUpdate.rename`: the title alone, so nothing the editor never showed moves. */
    fun renameLead(title: String) = CrmLeadUpdate(title = Patch.Value(title.trim()))
    fun renameProject(title: String) = CrmProjectUpdate(title = title.trim())

    /** The record's `yyyy-MM-dd` prefix as a day, or null. */
    fun day(wire: String?): LocalDate? = wire?.takeIf { it.length >= 10 }?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() }
}

/** The lead's half of [SubjectForm], by the names the New Lead rules always had. */
object LeadForm {
    val statuses = listOf("Conversations", "Opportunity Identified", "Proposal Out", "Active Negotiation", "Waiting on External Factor", "Closed Won", "Closed Lost")
    const val DEFAULT_STATUS = "Conversations"

    /** One field's rule: its id, whether a save needs it, and how long it may be. */
    data class Spec(val id: String, val required: Boolean, val maxLength: Int?)

    val title = Spec("title", required = true, maxLength = 100)
    val organization = Spec("organization", required = true, maxLength = null)
    val contact = Spec("contact", required = false, maxLength = null)
    val startDate = Spec("startDate", required = true, maxLength = 30)
    val notes = Spec("notes", required = false, maxLength = 10_000)

    /** Why a save cannot go yet, as [SubjectForm.problem] answers for a lead. */
    sealed interface Problem {
        val field: String
        data class Required(override val field: String) : Problem
        data class TooLong(override val field: String, val max: Int) : Problem
    }

    fun problem(title: String, organizationId: String?, notes: String): Problem? =
        when (val found = SubjectForm.problem(CrmSubjectKind.LEAD, title, organizationId, notes)) {
            null -> null
            is SubjectForm.Problem.Required -> Problem.Required(found.field)
            is SubjectForm.Problem.TooLong -> Problem.TooLong(found.field, found.max)
        }

    /** A new lead, through [SubjectForm.create]. */
    fun create(
        title: String,
        status: String,
        startDate: LocalDate,
        notes: String,
        organizationId: String?,
        contactId: String?,
        characteristics: Map<String, Boolean>,
    ): CrmLeadCreate = SubjectForm.create(
        SubjectForm.Draft(
            CrmSubjectKind.LEAD, title, status, startDate, notes = notes, organizationId = organizationId,
            contactIds = listOfNotNull(contactId), characteristics = characteristics,
        ),
    ) as CrmLeadCreate
}

/**
 * A Sales touch as INBOX reads it (`Sources/SalesInbox.swift`): what the
 * row says, and what Start a lead hands the New Lead editor.
 */
object SalesTouch {
    /** `UNTRIAGED_TOUCH_SOURCE_LABELS` (`fixtures/sales-values.json`); a source this build has not heard of reads as a contact form. */
    val labels = mapOf(
        "contact" to "Contact form",
        "support_case" to "Support case",
        "pricing_request" to "Pricing request",
        "readiness_assessment" to "Readiness assessment",
    )

    /** The source's key for its label: an unknown one is `contact`. */
    fun sourceKey(touch: UntriagedTouchWire): String = touch.source.value.takeIf { it in labels } ?: "contact"

    /** The preview, or the source's label when it says nothing. */
    fun displayTitle(touch: UntriagedTouchWire, sourceLabel: String): String = touch.preview.trim().ifEmpty { sourceLabel }

    /** The notes the editor opens with: what Core proposed, then the organization and contact by name. */
    fun draftNotes(prefill: UntriagedTouchPrefill): String {
        val lines = mutableListOf(prefill.notes)
        prefill.organizationName?.takeIf { it.isNotEmpty() }?.let { lines.add("Organization: $it") }
        val contact = listOfNotNull(prefill.contactName, prefill.contactEmail).filter { it.isNotEmpty() }
        if (contact.isNotEmpty()) lines.add("Contact: ${contact.joinToString(" · ")}")
        return lines.filter { it.isNotEmpty() }.joinToString("\n")
    }
}

/** What a New Lead editor opens with when Start a lead knows part of the answer. */
data class LeadPrefill(
    val title: String,
    val notes: String,
    val organizationId: String?,
    val organizationName: String?,
    val contactId: String?,
    val contactName: String?,
) {
    companion object {
        fun of(touch: UntriagedTouchWire) = LeadPrefill(
            title = touch.prefill.title,
            notes = SalesTouch.draftNotes(touch.prefill),
            organizationId = touch.prefill.organizationId,
            organizationName = touch.prefill.organizationName,
            contactId = touch.prefill.contactId,
            contactName = touch.prefill.contactName,
        )
    }
}

/** `MobileRelationPicker`'s rules: when a search runs, and when Create organization is offered. */
object RelationSearch {
    const val MIN_QUERY = 2

    fun fold(value: String): String =
        Normalizer.normalize(value.trim(), Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase()

    /** Offered once the typed name was searched, nothing failed, and no hit has that name. */
    fun canCreate(query: String, searched: String, hits: List<String>, searching: Boolean, failed: Boolean): Boolean {
        val folded = fold(query)
        if (folded.length < MIN_QUERY || searching || failed || fold(searched) != folded) return false
        return hits.none { fold(it) == folded }
    }
}
