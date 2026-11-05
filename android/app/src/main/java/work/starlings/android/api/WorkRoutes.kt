package work.starlings.android.api

import work.starlings.contracts.CommercialSummary
import work.starlings.contracts.CrmBoardResponse
import work.starlings.contracts.CrmMyWorkQuery
import work.starlings.contracts.CrmMyWorkResponse
import work.starlings.contracts.CrmRecentlyClosedWorkResponse
import work.starlings.contracts.CrmSubjectCountsQuery
import work.starlings.contracts.CrmSubjectCountsQueryKind
import work.starlings.contracts.CrmSubjectCountsResponse
import work.starlings.contracts.CrmSubjectDetailResponse
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectsQuery
import work.starlings.contracts.CrmSubjectsResponse
import work.starlings.contracts.CrmTaskCreate
import work.starlings.contracts.CrmTaskDeleteResponse
import work.starlings.contracts.CrmTaskResponse
import work.starlings.contracts.CrmTaskUpdate
import work.starlings.contracts.CrmTasksQuery
import work.starlings.contracts.CrmTasksResponse
import work.starlings.contracts.CrmTeamResponse
import work.starlings.contracts.CrmUnownedWorkResponse
import work.starlings.contracts.FavoritesResponseWire
import work.starlings.contracts.InboxQuery
import work.starlings.contracts.InboxResponse
import work.starlings.contracts.QuickNotesResponse
import work.starlings.contracts.SearchQuery
import work.starlings.contracts.SearchResponseWire
import work.starlings.contracts.SubjectStateResponseWire
import work.starlings.contracts.SubjectStateUpdate
import work.starlings.contracts.SubjectStateUpdateResponseWire
import work.starlings.contracts.WorkPreferencesUpdate
import java.time.LocalDate

/**
 * The work routes the phone sends, as `Sources/StarlingsWorkRoutes.swift`:
 * Mine and a colleague's work, tasks, INBOX, the board, the subject lists
 * and their badges, a subject's detail, the Work preferences, search, the
 * team, and Home's STARRED, favourites and COMMERCIAL.
 */
object WorkRoutes {
    // Search and work

    /** One search. [timeZone] is this device's, for the clock on an event row. */
    fun search(query: String, timeZone: String): Route<SearchResponseWire> = Route(
        "GET", listOf("search"), query = SearchQuery(query, timeZone).queryItems(),
        answer = Answer.Wire(SearchResponseWire.serializer()), operation = "Couldn’t search",
    )

    /** Everything you owe, across every subject. */
    val mine = Route(
        "GET", listOf("crm", "mine"), answer = Answer.Wire(CrmMyWorkResponse.serializer()),
        operation = "Couldn’t load your work", snapshotKey = SnapshotKey.MINE,
    )

    val unowned = Route(
        "GET", listOf("crm", "unowned"), answer = Answer.Wire(CrmUnownedWorkResponse.serializer()),
        operation = "Couldn’t load unowned work",
    )

    /** Your own task completions and closed GitHub issues from the last week. */
    val recentlyClosed = Route(
        "GET", listOf("crm", "recently-closed"), answer = Answer.Wire(CrmRecentlyClosedWorkResponse.serializer()),
        operation = "Couldn’t load recently finished work",
    )

    /** What one colleague owes. The Worker checks the address is on the team. */
    fun work(assigneeEmail: String): Route<CrmMyWorkResponse> = Route(
        "GET", listOf("crm", "work"), query = CrmMyWorkQuery(assigneeEmail).queryItems(),
        answer = Answer.Wire(CrmMyWorkResponse.serializer()), operation = "Couldn’t load their work",
    )

    /** The card board (docs/BOARD.md): every open card, or one project's. */
    fun board(projectId: String?): Route<CrmBoardResponse> = Route(
        "GET", listOf("crm", "board"), query = listOfNotNull(projectId?.let { "project_id" to it }),
        answer = Answer.Wire(CrmBoardResponse.serializer()), operation = "Couldn’t load the board",
    )

    /** Who work can be assigned to. Core is the roster, not the presence list. */
    val team = Route(
        "GET", listOf("crm", "team"), answer = Answer.Wire(CrmTeamResponse.serializer()),
        operation = "Couldn’t load the team",
    )

    // Tasks

    /** One subject's tasks, or a meeting's, kept under the meeting's own snapshot. */
    fun tasks(
        projectId: String? = null,
        leadId: String? = null,
        eventId: String? = null,
        organizationId: String? = null,
        meetingId: String? = null,
    ): Route<CrmTasksResponse> = Route(
        "GET", listOf("crm", "tasks"),
        query = CrmTasksQuery(projectId, leadId, eventId, organizationId, meetingId).queryItems(),
        answer = Answer.Wire(CrmTasksResponse.serializer()), operation = "Couldn’t load tasks",
        snapshotKey = SnapshotKey.tasks(projectId, leadId, eventId ?: meetingId, organizationId),
    )

    /** One task's full record by id, whatever it is filed on. */
    fun task(id: String): Route<CrmTaskResponse> = Route(
        "GET", listOf("crm", "tasks", id), answer = Answer.Wire(CrmTaskResponse.serializer()),
        operation = "Couldn’t load that task",
    )

    fun createTask(create: CrmTaskCreate): Route<CrmTaskResponse> = Route(
        "POST", listOf("crm", "tasks"), body = json(CrmTaskCreate.serializer(), create),
        answer = Answer.Wire(CrmTaskResponse.serializer()), operation = "Couldn’t create that task",
        writes = listOf(SnapshotWrite.TASK_CREATE),
    )

    /** A proposal answered here leaves INBOX too. */
    fun updateTask(id: String, update: CrmTaskUpdate): Route<CrmTaskResponse> = Route(
        "PATCH", listOf("crm", "tasks", id), body = json(CrmTaskUpdate.serializer(), update),
        answer = Answer.Wire(CrmTaskResponse.serializer()), operation = "Couldn’t update that task",
        writes = listOf(SnapshotWrite.TASK_UPDATE),
    )

    fun deleteTask(id: String): Route<CrmTaskDeleteResponse> = Route(
        "DELETE", listOf("crm", "tasks", id), answer = Answer.Wire(CrmTaskDeleteResponse.serializer()),
        operation = "Couldn’t delete that task.", writes = listOf(SnapshotWrite.TASK_UPDATE),
    )

    // INBOX

    /** One owner queue: questions, agent cards, follow-ups and calendar answers. */
    val inbox = Route(
        "GET", listOf("crm", "inbox"),
        query = InboxQuery(questions = true, cards = true, followups = true, calendar = true).queryItems(),
        answer = Answer.Wire(InboxResponse.serializer()),
        operation = "Couldn’t load your inbox", snapshotKey = SnapshotKey.INBOX,
    )

    val quickNotes = Route(
        "GET", listOf("quick-notes"), answer = Answer.Wire(QuickNotesResponse.serializer()),
        operation = "Couldn’t load Quick Notes", snapshotKey = SnapshotKey.QUICK_NOTES,
    )

    // Subjects

    /**
     * The browse list (`CrmSubjectsQuery.browse`): the query and status
     * trimmed and left out when empty, no status for an organization, and
     * [today] for an event, the reader's own day.
     */
    fun subjects(kind: CrmSubjectKind, query: String, status: String?, today: LocalDate = LocalDate.now()): Route<CrmSubjectsResponse> {
        val q = query.trim()
        val s = status?.trim().orEmpty()
        return Route(
            "GET", listOf("crm", "subjects"),
            query = CrmSubjectsQuery(
                kind = kind,
                q = q.ifEmpty { null },
                status = s.takeIf { kind != CrmSubjectKind.ORGANIZATION && it.isNotEmpty() },
                today = if (kind == CrmSubjectKind.EVENT) RouteDates.day(today) else null,
            ).queryItems(),
            answer = Answer.Wire(CrmSubjectsResponse.serializer()),
            operation = "Couldn’t load CRM subjects",
            snapshotKey = SnapshotKey.subjects(kind.value, query, status),
        )
    }

    /** The status badges for one kind, exact. */
    fun subjectCounts(kind: CrmSubjectCountsQueryKind, query: String): Route<CrmSubjectCountsResponse> = Route(
        "GET", listOf("crm", "subject-counts"),
        query = CrmSubjectCountsQuery(kind, query.ifEmpty { null }).queryItems(),
        answer = Answer.Wire(CrmSubjectCountsResponse.serializer()),
        operation = "Couldn’t count CRM subjects",
        snapshotKey = SnapshotKey.subjectCounts(kind.value, query),
    )

    /** [snapshotted] keeps it for a read-only page; an editor reads live, because a stale field is a stale write. */
    fun subjectDetail(kind: CrmSubjectKind, id: String, snapshotted: Boolean = false): Route<CrmSubjectDetailResponse> = Route(
        "GET", listOf("crm", "subjects", kind.value, id), answer = Answer.Wire(CrmSubjectDetailResponse.serializer()),
        operation = "Couldn’t load CRM subject",
        snapshotKey = if (snapshotted) SnapshotKey.subjectDetail(kind.value, id) else null,
    )

    // Subject state, preferences and favourites

    /** Star, mute and the SALES opt-in, per person. Android reads it live, as iOS. */
    val subjectState = Route(
        "GET", listOf("crm", "subject-state"), answer = Answer.Wire(SubjectStateResponseWire.serializer()),
        operation = "Couldn’t read your subjects", snapshotKey = SnapshotKey.SUBJECT_STATE,
    )

    fun setSubjectState(kind: CrmSubjectKind, id: String, update: SubjectStateUpdate): Route<SubjectStateUpdateResponseWire> = Route(
        "PUT", listOf("crm", "subject-state", kind.value, id), body = json(SubjectStateUpdate.serializer(), update),
        answer = Answer.Wire(SubjectStateUpdateResponseWire.serializer()), operation = "Couldn’t change that",
        writes = listOf(SnapshotWrite.SUBJECT_STATE_SET),
    )

    /** One field of the Work preferences, sent whole. [operation] names the field. */
    fun setWorkPreferences(update: WorkPreferencesUpdate, operation: String): Route<SubjectStateResponseWire> = Route(
        "PATCH", listOf("crm", "subject-state"), body = json(WorkPreferencesUpdate.serializer(), update),
        answer = Answer.Wire(SubjectStateResponseWire.serializer()), operation = operation,
        writes = listOf(SnapshotWrite.WORK_PREFERENCES_SET),
    )

    /** Home's QUICK ACCESS: the starred things as search rows, newest star first. */
    val starred = Route(
        "GET", listOf("crm", "starred"), answer = Answer.Wire(SearchResponseWire.serializer()),
        operation = "Couldn’t load favorites.", snapshotKey = SnapshotKey.STARRED,
    )

    val favorites = Route(
        "GET", listOf("crm", "favorites"), answer = Answer.Wire(FavoritesResponseWire.serializer()),
        operation = "Couldn’t load favorites", snapshotKey = SnapshotKey.FAVORITES,
    )

    /** Home's COMMERCIAL card paints the last summary before Core answers. */
    val commercialSummary = Route(
        "GET", listOf("crm", "commercial-summary"), answer = Answer.Wire(CommercialSummary.serializer()),
        operation = "Couldn’t load commercial history", snapshotKey = SnapshotKey.COMMERCIAL_SUMMARY,
    )
}
