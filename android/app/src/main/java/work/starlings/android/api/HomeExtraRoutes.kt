package work.starlings.android.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import work.starlings.contracts.CrmIssueCreate
import work.starlings.contracts.CrmIssueResponse
import work.starlings.contracts.QuickNoteCreate
import work.starlings.contracts.QuickNotePromote
import work.starlings.contracts.QuickNoteUpdate
import work.starlings.contracts.QuickNoteDeleteResponse
import work.starlings.contracts.QuickNoteResponse
import work.starlings.contracts.QuickNoteSource
import java.time.LocalDate

/**
 * The routes Home sends that the other areas do not: the published events
 * (`Sources/PublicEventsCalendar.swift`) and the Quick Notes capture and
 * delete (`StarlingsAPI.createQuickNote`, `deleteQuickNote`).
 */
object HomeExtraRoutes {
    /** Turn the setup checklist off for the whole workspace (an admin's choice). */
    fun setSetupChecklist(on: Boolean): Route<work.starlings.contracts.SetupResponse> = Route(
        "PUT", listOf("admin", "setup"), body = json(work.starlings.contracts.SetupSettingUpdate.serializer(), work.starlings.contracts.SetupSettingUpdate(on)),
        answer = Answer.Wire(work.starlings.contracts.SetupResponse.serializer()), operation = "Couldn’t turn the checklist off",
    )

    /** Skip: this owner clears one step from their own checklist. */
    fun skipSetupStep(step: String): Route<work.starlings.contracts.SetupResponse> = Route(
        "PUT", listOf("setup", "skip"), body = json(work.starlings.contracts.SetupSkipUpdate.serializer(), work.starlings.contracts.SetupSkipUpdate(step, true)),
        answer = Answer.Wire(work.starlings.contracts.SetupResponse.serializer()), operation = "Couldn’t skip that step",
    )

    /** How far ahead the events read looks, as `PublicEventsCalendar.horizonDays`. */
    const val EVENTS_HORIZON_DAYS = 120L

    /**
     * `GET /api/public/events?startDate&endDate`: company-wide, so it needs
     * no session; the bearer it carries here does no harm. Ten seconds, as iOS.
     */
    fun publicEvents(today: LocalDate): Route<PublicEventsResponse> = Route(
        "GET", listOf("public", "events"),
        query = listOf("startDate" to RouteDates.day(today), "endDate" to RouteDates.day(today.plusDays(EVENTS_HORIZON_DAYS))),
        answer = Answer.Wire(PublicEventsResponse.serializer()),
        operation = "Couldn’t load events",
        timeoutSeconds = 10.0,
    )

    fun createQuickNote(body: String): Route<QuickNoteResponse> = Route(
        "POST", listOf("quick-notes"),
        body = json(QuickNoteCreate.serializer(), QuickNoteCreate(body = body, source = QuickNoteSource.HOME)),
        answer = Answer.Wire(QuickNoteResponse.serializer()),
        operation = "Couldn’t save the note",
        writes = listOf(SnapshotWrite.QUICK_NOTE_WRITE),
    )

    fun deleteQuickNote(id: String): Route<QuickNoteDeleteResponse> = Route(
        "DELETE", listOf("quick-notes", id),
        answer = Answer.Wire(QuickNoteDeleteResponse.serializer()),
        operation = "Couldn’t delete the note",
        writes = listOf(SnapshotWrite.QUICK_NOTE_WRITE),
    )

    /** `StarlingsWorkRoutes.updateQuickNote`: the body; the note keeps its place, state and filing. */
    fun updateQuickNote(id: String, body: String): Route<QuickNoteResponse> = Route(
        "PATCH", listOf("quick-notes", id),
        body = json(QuickNoteUpdate.serializer(), QuickNoteUpdate(body)),
        answer = Answer.Wire(QuickNoteResponse.serializer()),
        operation = "Couldn’t save Quick Note",
        writes = listOf(SnapshotWrite.QUICK_NOTE_WRITE),
    )

    /** `promoteQuickNote`: where a note went. A retry of the same promotion is a no-op. */
    fun promoteQuickNote(id: String, promote: QuickNotePromote): Route<QuickNoteResponse> = Route(
        "POST", listOf("quick-notes", id, "promote"),
        body = json(QuickNotePromote.serializer(), promote),
        answer = Answer.Wire(QuickNoteResponse.serializer()),
        operation = "Couldn’t file Quick Note",
        writes = listOf(SnapshotWrite.QUICK_NOTE_WRITE),
    )

    /** `StarlingsWorkRoutes.createIssue`: a GitHub issue on a project's repository, for filing a note. */
    fun createIssue(create: CrmIssueCreate): Route<CrmIssueResponse> = Route(
        "POST", listOf("crm", "issue"),
        body = json(CrmIssueCreate.serializer(), create),
        answer = Answer.Wire(CrmIssueResponse.serializer()),
        operation = "Couldn’t file that issue",
        writes = listOf(SnapshotWrite.ISSUE_WRITE),
    )
}

/** The events projection. Not in `wire.json`: decoded as `PublicEventsCalendar.ProjectionResponse`. */
@Serializable
data class PublicEventsResponse(val events: List<PublicEvent>)

@Serializable
data class PublicEvent(
    val id: String,
    val title: String,
    /** `yyyy-MM-dd`. */
    val date: String,
    @SerialName("starts_at") val startsAt: String? = null,
    @SerialName("ends_at") val endsAt: String? = null,
    @SerialName("is_all_day") val isAllDay: Boolean,
    val location: String? = null,
    @SerialName("signup_url") val signupUrl: String? = null,
)
