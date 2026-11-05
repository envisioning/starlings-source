package work.starlings.android.api

import work.starlings.contracts.CoreMergeRequest
import work.starlings.contracts.CoreMergeResponse
import work.starlings.contracts.CrmDecisionCreate
import work.starlings.contracts.CrmDecisionResponse
import work.starlings.contracts.CrmDecisionsQuery
import work.starlings.contracts.CrmDecisionsResponse
import work.starlings.contracts.CrmGoalCreate
import work.starlings.contracts.CrmGoalResponse
import work.starlings.contracts.CrmGoalUpdate
import work.starlings.contracts.CrmInteractionCreate
import work.starlings.contracts.CrmInteractionDeleteResponse
import work.starlings.contracts.CrmInteractionResponse
import work.starlings.contracts.CrmInteractionUpdate
import work.starlings.contracts.CrmInteractionsQuery
import work.starlings.contracts.CrmLeadUpdate
import work.starlings.contracts.CrmProjectUpdate
import work.starlings.contracts.CrmInteractionsResponse
import work.starlings.contracts.CrmOrganizationDeleteResponse
import work.starlings.contracts.CrmOrganizationUpdate
import work.starlings.contracts.CrmSubjectCommercialResponse
import work.starlings.contracts.CrmSubjectDetailResponse
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.OfferDecision
import work.starlings.contracts.OfferDuplicate
import work.starlings.contracts.OfferResponse
import work.starlings.contracts.OfferVersionResponse
import work.starlings.contracts.SubjectSubmissionResponse

/**
 * One subject's page beyond its tasks: an organization's Edit, Merge and
 * Delete, and what Overview reads and writes (its
 * decisions, goals, history and a lead's form answers), as
 * `Sources/StarlingsWorkRoutes.swift` names them.
 */
object SubjectRoutes {
    /** `updateOrganization`: only the fields that changed (`OrganizationDraft.patch`). Answers the stored subject. */
    fun updateOrganization(id: String, update: CrmOrganizationUpdate): Route<CrmSubjectDetailResponse> = Route(
        "PATCH", listOf("crm", "subjects", CrmSubjectKind.ORGANIZATION.value, id), body = json(CrmOrganizationUpdate.serializer(), update),
        answer = Answer.Wire(CrmSubjectDetailResponse.serializer()), operation = "Couldn’t save that organization",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** `mergeOrganizations`: the oldest stays and takes every link; the answer names it. */
    fun mergeOrganizations(ids: List<String>): Route<CoreMergeResponse> = Route(
        "POST", listOf("core", "merge", "organizations"), body = json(CoreMergeRequest.serializer(), CoreMergeRequest(ids)),
        answer = Answer.Wire(CoreMergeResponse.serializer()), operation = "Couldn’t merge those organizations",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** `deleteOrganization`: a 409 while a record still points at it, and its message names them. */
    fun deleteOrganization(id: String): Route<CrmOrganizationDeleteResponse> = Route(
        "DELETE", listOf("crm", "subjects", CrmSubjectKind.ORGANIZATION.value, id),
        answer = Answer.Wire(CrmOrganizationDeleteResponse.serializer()), operation = "Couldn’t delete that organization",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** `decisions`: what was decided on one subject, newest first. */
    fun decisions(kind: CrmSubjectKind, id: String): Route<CrmDecisionsResponse> = Route(
        "GET", listOf("crm", "decisions"), query = CrmDecisionsQuery(kind, id).queryItems(),
        answer = Answer.Wire(CrmDecisionsResponse.serializer()), operation = "Couldn’t load decisions",
    )

    fun createDecision(create: CrmDecisionCreate): Route<CrmDecisionResponse> = Route(
        "POST", listOf("crm", "decisions"), body = json(CrmDecisionCreate.serializer(), create),
        answer = Answer.Wire(CrmDecisionResponse.serializer()), operation = "Couldn’t record that decision",
    )

    fun createGoal(create: CrmGoalCreate): Route<CrmGoalResponse> = Route(
        "POST", listOf("crm", "goals"), body = json(CrmGoalCreate.serializer(), create),
        answer = Answer.Wire(CrmGoalResponse.serializer()), operation = "Couldn’t create that goal",
    )

    fun updateGoal(id: String, update: CrmGoalUpdate): Route<CrmGoalResponse> = Route(
        "PATCH", listOf("crm", "goals", id), body = json(CrmGoalUpdate.serializer(), update),
        answer = Answer.Wire(CrmGoalResponse.serializer()), operation = "Couldn’t update that goal",
    )

    /**
     * `interactions`: a subject's calls, meetings and notes, by
     * `StarlingsAPI.interactionsQuery`. An event has no history, so it asks
     * for nothing ([interactionsQuery] answers null).
     */
    fun interactions(query: CrmInteractionsQuery): Route<CrmInteractionsResponse> = Route(
        "GET", listOf("crm", "interactions"), query = query.queryItems(),
        answer = Answer.Wire(CrmInteractionsResponse.serializer()), operation = "Couldn’t load interactions",
    )

    /** `createInteraction`: a call, meeting or note logged by hand on a subject's History. */
    fun createInteraction(create: CrmInteractionCreate): Route<CrmInteractionResponse> = Route(
        "POST", listOf("crm", "interactions"), body = json(CrmInteractionCreate.serializer(), create),
        answer = Answer.Wire(CrmInteractionResponse.serializer()), operation = "Couldn’t log that interaction",
        writes = listOf(SnapshotWrite.INTERACTION_WRITE),
    )

    /** `updateInteraction`: only the fields sent change; `contact_ids` replaces the list. */
    fun updateInteraction(id: String, update: CrmInteractionUpdate): Route<CrmInteractionResponse> = Route(
        "PATCH", listOf("crm", "interactions", id), body = json(CrmInteractionUpdate.serializer(), update),
        answer = Answer.Wire(CrmInteractionResponse.serializer()), operation = "Couldn’t save that interaction",
        writes = listOf(SnapshotWrite.INTERACTION_WRITE),
    )

    /** `deleteInteraction`: its contact and subject links go with it. */
    fun deleteInteraction(id: String): Route<CrmInteractionDeleteResponse> = Route(
        "DELETE", listOf("crm", "interactions", id),
        answer = Answer.Wire(CrmInteractionDeleteResponse.serializer()), operation = "Couldn’t delete that interaction",
        writes = listOf(SnapshotWrite.INTERACTION_WRITE),
    )

    /** `updateSubject` for the Fields pane: a project's fields, only those that changed. */
    fun updateProject(id: String, update: CrmProjectUpdate): Route<CrmSubjectDetailResponse> = Route(
        "PATCH", listOf("crm", "subjects", CrmSubjectKind.PROJECT.value, id), body = json(CrmProjectUpdate.serializer(), update),
        answer = Answer.Wire(CrmSubjectDetailResponse.serializer()), operation = "Couldn’t update CRM subject",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** `updateSubject` for the Fields pane: a lead's fields, only those that changed. */
    fun updateLead(id: String, update: CrmLeadUpdate): Route<CrmSubjectDetailResponse> = Route(
        "PATCH", listOf("crm", "subjects", CrmSubjectKind.LEAD.value, id), body = json(CrmLeadUpdate.serializer(), update),
        answer = Answer.Wire(CrmSubjectDetailResponse.serializer()), operation = "Couldn’t update CRM subject",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /**
     * `setSubjectResponsible`: who answers for a project or lead, sent alone
     * (docs/OWNERSHIP.md). Null clears the choice, and is sent as null.
     */
    fun setResponsible(kind: CrmSubjectKind, id: String, email: String?): Route<CrmSubjectDetailResponse> = Route(
        "PATCH", listOf("crm", "subjects", kind.value, id),
        body = kotlinx.serialization.json.buildJsonObject {
            put("responsible_email", email?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
        }.toString(),
        answer = Answer.Wire(CrmSubjectDetailResponse.serializer()), operation = "Couldn’t change who is responsible",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** `StarlingsAPI.interactionsQuery(for:)`: Core files history under projects, leads and organizations only. */
    fun interactionsQuery(kind: CrmSubjectKind, id: String): CrmInteractionsQuery? = when (kind) {
        CrmSubjectKind.PROJECT -> CrmInteractionsQuery(projectId = id)
        CrmSubjectKind.LEAD -> CrmInteractionsQuery(leadId = id)
        CrmSubjectKind.ORGANIZATION -> CrmInteractionsQuery(organizationId = id)
        else -> null
    }

    /**
     * `subjectCommercial`: a lead's or an organization's offers and licenses,
     * newest first. A null list is a module the workspace has off.
     */
    fun commercial(kind: CrmSubjectKind, id: String): Route<CrmSubjectCommercialResponse> = Route(
        "GET", listOf("crm", "subjects", kind.value, id, "commercial"),
        answer = Answer.Wire(CrmSubjectCommercialResponse.serializer()), operation = "Couldn’t load offers and licenses",
    )

    /** Browse's Offers group: every offer, newest first. The phone reads. */
    fun offers(): Route<work.starlings.contracts.OffersResponse> = Route(
        "GET", listOf("crm", "offers"),
        answer = Answer.Wire(work.starlings.contracts.OffersResponse.serializer()), operation = "Couldn’t load offers.",
    )

    /** Browse's Licenses group: every license, newest start first. The phone reads. */
    fun licenses(): Route<work.starlings.contracts.LicensesResponse> = Route(
        "GET", listOf("crm", "licenses"),
        answer = Answer.Wire(work.starlings.contracts.LicensesResponse.serializer()), operation = "Couldn’t load licenses.",
    )

    /** `offer`: one offer with the server's lines, totals and versions. The phone reads, duplicates and records. */
    fun offer(id: String): Route<OfferResponse> = Route(
        "GET", listOf("crm", "offers", id),
        answer = Answer.Wire(OfferResponse.serializer()), operation = "Couldn’t load the offer.",
    )

    fun offerVersion(id: String, version: Int): Route<OfferVersionResponse> = Route(
        "GET", listOf("crm", "offers", id, "versions", version.toString()),
        answer = Answer.Wire(OfferVersionResponse.serializer()), operation = "Couldn’t load that version.",
    )

    fun duplicateOffer(id: String, target: OfferDuplicate): Route<OfferResponse> = Route(
        "POST", listOf("crm", "offers", id, "duplicate"), body = json(OfferDuplicate.serializer(), target),
        answer = Answer.Wire(OfferResponse.serializer()), operation = "Couldn’t duplicate the offer.",
    )

    fun recordOfferDecision(id: String, decision: OfferDecision): Route<OfferResponse> = Route(
        "POST", listOf("crm", "offers", id, "decision"), body = json(OfferDecision.serializer(), decision),
        answer = Answer.Wire(OfferResponse.serializer()), operation = "Couldn’t record the answer.",
    )

    /** `leadSubmission`: the form answers that filed a lead (docs/FORMS.md); most leads have none. */
    fun leadSubmission(id: String): Route<SubjectSubmissionResponse> = Route(
        "GET", listOf("crm", "subjects", CrmSubjectKind.LEAD.value, id, "submission"),
        answer = Answer.Wire(SubjectSubmissionResponse.serializer()), operation = "Couldn’t load the answers",
    )
}
