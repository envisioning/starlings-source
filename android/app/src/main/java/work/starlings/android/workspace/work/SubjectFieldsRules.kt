package work.starlings.android.workspace.work

import work.starlings.contracts.CrmLeadStatus
import work.starlings.contracts.CrmLeadUpdate
import work.starlings.contracts.CrmProjectStatus
import work.starlings.contracts.CrmProjectUpdate
import work.starlings.contracts.CrmSubjectDetailWire
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.Patch
import java.time.LocalDate

/**
 * `SubjectFieldsDraft` (Sources/SubjectFieldsView.swift): what
 * the Fields pane edits, as the form holds it. Text is the empty string
 * for none; a day is null for none. [update] sends only what changed since
 * the last read, so a field another person changed meanwhile stays theirs.
 */
data class SubjectFieldsDraft(
    val title: String = "",
    val status: String = "",
    val description: String = "",
    val url: String = "",
    val evid: String = "",
    val isInternal: Boolean = false,
    val startDate: LocalDate? = null,
    val endDate: LocalDate? = null,
    val notes: String = "",
    val characteristics: Map<String, Boolean>? = null,
    val specs: String = "",
    val technical: String = "",
    val research: String = "",
    val design: String = "",
    val contract: String = "",
    val analytics: String = "",
    val authentication: String = "",
) {
    /** The write, by kind. */
    sealed interface Update {
        data class Project(val update: CrmProjectUpdate) : Update
        data class Lead(val update: CrmLeadUpdate) : Update
    }

    /** A project needs a title; a lead needs a start date. An organization or an event is read-only. */
    fun canSave(kind: CrmSubjectKind): Boolean = when (kind) {
        CrmSubjectKind.PROJECT -> title.trim().isNotEmpty()
        CrmSubjectKind.LEAD -> startDate != null
        else -> false
    }

    /** The PATCH body: only the fields that changed since [saved]. Null when nothing changed. */
    fun update(saved: SubjectFieldsDraft, kind: CrmSubjectKind): Update? {
        if (this == saved) return null
        fun text(now: String, was: String): Patch<String> {
            if (now == was) return Patch.Omit
            val value = now.trim()
            return if (value.isEmpty()) Patch.Null else Patch.Value(value)
        }
        fun day(now: LocalDate?, was: LocalDate?): Patch<String> = if (now == was) Patch.Omit else Patch.of(now?.toString())
        val trimmedTitle = title.trim()
        val titleChanged = title != saved.title && trimmedTitle.isNotEmpty()
        val statusChanged = status != saved.status
        return when (kind) {
            CrmSubjectKind.LEAD -> Update.Lead(
                CrmLeadUpdate(
                    title = if (titleChanged) Patch.Value(trimmedTitle) else Patch.Omit,
                    status = if (statusChanged) CrmLeadStatus(status) else null,
                    startDate = if (startDate != saved.startDate) startDate?.toString() else null,
                    notes = text(notes, saved.notes),
                    characteristics = if (characteristics != saved.characteristics) Patch.of(characteristics) else Patch.Omit,
                ),
            )
            CrmSubjectKind.PROJECT -> Update.Project(
                CrmProjectUpdate(
                    title = if (titleChanged) trimmedTitle else null,
                    description = text(description, saved.description),
                    url = text(url, saved.url),
                    specs = text(specs, saved.specs),
                    technical = text(technical, saved.technical),
                    research = text(research, saved.research),
                    design = text(design, saved.design),
                    contract = text(contract, saved.contract),
                    analytics = text(analytics, saved.analytics),
                    authentication = text(authentication, saved.authentication),
                    evid = text(evid, saved.evid),
                    startDate = day(startDate, saved.startDate),
                    endDate = day(endDate, saved.endDate),
                    status = if (statusChanged) CrmProjectStatus(status) else null,
                    isInternal = if (isInternal != saved.isInternal) isInternal else null,
                ),
            )
            else -> null
        }
    }

    companion object {
        /** `CrmTaskDate.date`: a civil day, or the day a stamp names. */
        private fun day(wire: String?): LocalDate? = wire?.trim()?.takeIf { it.length >= 10 }?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() }

        fun of(detail: CrmSubjectDetailWire) = SubjectFieldsDraft(
            title = detail.title,
            status = detail.status,
            description = detail.description.orEmpty(),
            url = detail.url.orEmpty(),
            evid = detail.evid.orEmpty(),
            isInternal = detail.isInternal == true,
            startDate = day(detail.startDate),
            endDate = day(detail.endDate),
            notes = detail.notes.orEmpty(),
            characteristics = detail.characteristics,
            specs = detail.specs.orEmpty(),
            technical = detail.technical.orEmpty(),
            research = detail.research.orEmpty(),
            design = detail.design.orEmpty(),
            contract = detail.contract.orEmpty(),
            analytics = detail.analytics.orEmpty(),
            authentication = detail.authentication.orEmpty(),
        )

        /** `statusChoices`: the registry's statuses, plus the record's own when it is not one of them. */
        fun statusChoices(kind: CrmSubjectKind, current: String): List<String> {
            val known = when (kind) {
                CrmSubjectKind.PROJECT -> CrmProjectStatus.known.map { it.value }
                CrmSubjectKind.LEAD -> LeadForm.statuses
                else -> emptyList()
            }
            return if (current.isEmpty() || current in known) known else listOf(current) + known
        }
    }
}
