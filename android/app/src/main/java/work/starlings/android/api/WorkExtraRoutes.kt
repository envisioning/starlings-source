package work.starlings.android.api

import work.starlings.contracts.AttentionRequest
import work.starlings.contracts.AttentionResolveInput
import work.starlings.contracts.AttentionResolveResponse
import work.starlings.contracts.DecisionAskAnswerRequest
import work.starlings.contracts.DecisionAskResponse
import work.starlings.contracts.CrmIssueCreate
import work.starlings.contracts.CrmIssueResponse
import work.starlings.contracts.CrmIssueDetailResponse
import work.starlings.contracts.CrmIssueUpdate
import work.starlings.contracts.CoreMergeRequest
import work.starlings.contracts.CoreMergeResponse
import work.starlings.contracts.CrmContactCreate
import work.starlings.contracts.CrmContactDeleteResponse
import work.starlings.contracts.CrmContactOptionsResponse
import work.starlings.contracts.CrmContactResponse
import work.starlings.contracts.CrmContactUpdate
import work.starlings.contracts.CrmContactsQuery
import work.starlings.contracts.CrmContactsResponse
import work.starlings.contracts.CrmIssueRefQuery
import work.starlings.contracts.CrmGoalsQuery
import work.starlings.contracts.CrmGoalsResponse
import work.starlings.contracts.CrmGithubReposQuery
import work.starlings.contracts.CrmGithubReposResponse
import work.starlings.contracts.CrmIssueFacetsResponse
import work.starlings.contracts.CrmIssuesResponse
import work.starlings.contracts.CrmProjectQuery
import work.starlings.contracts.CrmProjectRepoCreate
import work.starlings.contracts.CrmProjectRepoResponse
import work.starlings.contracts.CrmRepoQuery
import work.starlings.contracts.CrmIssueQuery
import work.starlings.contracts.InboxFollowUpItem
import work.starlings.contracts.IssueImageResponse
import work.starlings.contracts.CrmOrganizationCreate
import work.starlings.contracts.CrmOrganizationResponse
import work.starlings.contracts.CrmOrganizationsResponse
import work.starlings.contracts.CrmSubjectCreate
import work.starlings.contracts.CrmSubjectDetailResponse
import work.starlings.contracts.MeetingFollowUpApprove
import work.starlings.contracts.MeetingFollowUpApproveResponse
import work.starlings.contracts.Patch
import work.starlings.contracts.QuickNoteCreate
import work.starlings.contracts.QuickNotePromote
import work.starlings.contracts.QuickNoteResponse
import work.starlings.contracts.QuickNoteSource

/**
 * The Work routes `WorkRoutes` does not hold yet, as
 * `Sources/StarlingsWorkRoutes.swift` names them: INBOX's answers and
 * dismissals, Quick Notes, a project's issues and repositories, and filing
 * an issue. The Work area owns this file.
 */
object WorkExtraRoutes {
    // INBOX

    /** Answer a decision waiting on you. The same answer again is safe: it only retries the Core record. */
    fun answerDecision(id: String, answer: String, note: String?): Route<DecisionAskResponse> {
        val trimmed = note?.trim().orEmpty()
        return Route(
            "POST", listOf("decision-asks", id, "answer"),
            body = json(
                DecisionAskAnswerRequest.serializer(),
                DecisionAskAnswerRequest(answer = answer, note = if (trimmed.isEmpty()) Patch.Omit else Patch.Value(trimmed)),
            ),
            answer = Answer.Wire(DecisionAskResponse.serializer()),
            operation = "Couldn’t answer that decision",
        )
    }

    /** The canonical request with its source permissions. */
    fun attentionRequest(id: String): Route<AttentionRequest> = Route(
        "GET", listOf("attention", id), answer = Answer.Wire(AttentionRequest.serializer()),
        operation = "Couldn’t load this question.",
    )

    fun resolveAttention(id: String, command: AttentionResolveInput): Route<AttentionResolveResponse> = Route(
        "POST", listOf("attention", id, "resolve"), body = json(AttentionResolveInput.serializer(), command),
        answer = Answer.Wire(AttentionResolveResponse.serializer()), operation = "Couldn’t submit this answer.",
        writes = listOf(SnapshotWrite.ATTENTION_RESOLVE),
    )

    /** An INBOX item with no other resolution (`booking:*`, interest, a form): dismiss (POST) or undo (DELETE). */
    fun setInboxItemDismissed(key: String, dismissed: Boolean): Route<Unit> = Route(
        if (dismissed) "POST" else "DELETE", listOf("crm", "inbox", key, "dismiss"), answer = Answer.None,
        operation = if (dismissed) "Couldn’t dismiss that" else "Couldn’t undo that",
    )

    /** Dismiss (POST) or undo (DELETE) one Sales touch: same row, same id. */
    fun setSalesInboxDismissed(id: String, dismissed: Boolean): Route<Unit> = Route(
        if (dismissed) "POST" else "DELETE", listOf("crm", "sales-inbox", id, "dismiss"), answer = Answer.None,
        operation = if (dismissed) "Couldn’t dismiss that" else "Couldn’t undo that",
    )

    // Subjects

    /** A new lead or project; the answer is its detail. */
    fun createSubject(create: CrmSubjectCreate): Route<CrmSubjectDetailResponse> = Route(
        "POST", listOf("crm", "subjects"), body = json(CrmSubjectCreate.serializer(), create),
        answer = Answer.Wire(CrmSubjectDetailResponse.serializer()), operation = "Couldn’t create CRM subject",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** Who you are on GitHub, so MINE finds the issues assigned to you. Null clears it. */
    fun setGithubLogin(login: String?): Route<work.starlings.contracts.CrmGithubLoginResponse> = Route(
        "PATCH", listOf("crm", "mine"), body = json(work.starlings.contracts.CrmGithubLoginUpdate.serializer(), work.starlings.contracts.CrmGithubLoginUpdate(login)),
        answer = Answer.Wire(work.starlings.contracts.CrmGithubLoginResponse.serializer()), operation = "Couldn’t save that username",
        writes = listOf(SnapshotWrite.GITHUB_LOGIN_SET),
    )

    /** Win on an open lead (ADR 0008): a project from it, the checked tasks moved, then the lead closed. */
    fun winLead(id: String, win: work.starlings.contracts.CrmLeadWin): Route<work.starlings.contracts.CrmLeadWinResponse> = Route(
        "POST", listOf("crm", "subjects", "lead", id, "win"), body = json(work.starlings.contracts.CrmLeadWin.serializer(), win),
        answer = Answer.Wire(work.starlings.contracts.CrmLeadWinResponse.serializer()), operation = "Couldn’t win the lead",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE, SnapshotWrite.TASK_UPDATE),
    )

    /**
     * The Organizations group's page under its filter (`OrganizationFilter.query`,
     *). [tag] is the filter's snapshot tag, so a filtered page keeps its own snapshot.
     */
    fun organizationList(query: work.starlings.contracts.CrmSubjectsQuery, tag: String?): Route<work.starlings.contracts.CrmSubjectsResponse> = Route(
        "GET", listOf("crm", "subjects"), query = query.queryItems(),
        answer = Answer.Wire(work.starlings.contracts.CrmSubjectsResponse.serializer()), operation = "Couldn’t load CRM subjects",
        snapshotKey = SnapshotKey.subjects(query.kind.value, query.q.orEmpty(), tag),
    )

    /** The Worker's organization search: Core while the subjects group is there, D1 after. */
    fun organizations(query: String): Route<CrmOrganizationsResponse> = Route(
        "GET", listOf("crm", "organizations"), query = listOf("q" to query),
        answer = Answer.Wire(CrmOrganizationsResponse.serializer()), operation = "Couldn’t search organizations",
    )

    /** An organization by name, at most 200 characters (`FormFieldRegistry.organization.name`). */
    fun createOrganization(name: String): Route<CrmOrganizationResponse> = Route(
        "POST", listOf("crm", "organizations"),
        body = json(CrmOrganizationCreate.serializer(), CrmOrganizationCreate(name.trim().take(200))),
        answer = Answer.Wire(CrmOrganizationResponse.serializer()), operation = "Couldn’t create CRM subject",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    // Follow-up

    /** Approve one draft revision: the ticked tasks are accepted, the rest declined; the answer is the mail draft. */
    fun approveFollowUp(item: InboxFollowUpItem, accept: List<String>, decline: List<String>): Route<MeetingFollowUpApproveResponse> = Route(
        "POST", listOf("rooms", item.meeting.roomSlug, "meetings", item.meeting.id, "follow-up"),
        body = json(
            MeetingFollowUpApprove.serializer(),
            MeetingFollowUpApprove(item.revision, item.draft.subject, item.draft.body, acceptTaskIds = accept, declineTaskIds = decline),
        ),
        answer = Answer.Wire(MeetingFollowUpApproveResponse.serializer()), operation = "Couldn’t approve that follow-up",
        writes = listOf(SnapshotWrite.TASK_UPDATE),
    )

    /** The host does not want the follow-up; its tasks stay in INBOX. */
    fun dismissFollowUp(item: InboxFollowUpItem): Route<Unit> = Route(
        "DELETE", listOf("rooms", item.meeting.roomSlug, "meetings", item.meeting.id, "follow-up"),
        answer = Answer.None, operation = "Couldn’t dismiss that follow-up",
    )

    // Quick Notes

    /** The create carries the client's id: a repeat answers the note the first one made. */
    fun createQuickNote(body: String, id: String, capturedAt: Long): Route<QuickNoteResponse> = Route(
        "POST", listOf("quick-notes"),
        body = json(QuickNoteCreate.serializer(), QuickNoteCreate(body = body, source = QuickNoteSource.WORK, id = id, capturedAt = capturedAt)),
        answer = Answer.Wire(QuickNoteResponse.serializer()), operation = "Couldn’t save Quick Note",
        writes = listOf(SnapshotWrite.QUICK_NOTE_WRITE),
    )

    fun deleteQuickNote(id: String): Route<Unit> = Route(
        "DELETE", listOf("quick-notes", id), answer = Answer.None, operation = "Couldn’t delete Quick Note",
        writes = listOf(SnapshotWrite.QUICK_NOTE_WRITE),
    )

    /** Record where a note went. A retry of the same promotion is a no-op. */
    fun promoteQuickNote(id: String, promote: QuickNotePromote): Route<QuickNoteResponse> = Route(
        "POST", listOf("quick-notes", id, "promote"), body = json(QuickNotePromote.serializer(), promote),
        answer = Answer.Wire(QuickNoteResponse.serializer()), operation = "Couldn’t file Quick Note",
        writes = listOf(SnapshotWrite.QUICK_NOTE_WRITE),
    )

    // Goals

    /** A project's goals, closed ones too: the picker keeps the one a task already cites. */
    fun goals(projectId: String, includeClosed: Boolean): Route<CrmGoalsResponse> = Route(
        "GET", listOf("crm", "goals"), query = CrmGoalsQuery(projectId, if (includeClosed) true else null).queryItems(),
        answer = Answer.Wire(CrmGoalsResponse.serializer()), operation = "Couldn’t load goals",
    )

    // Contacts

    /** The Contacts group's page: a search, with the facets for a filter menu. */
    fun contactList(query: String): Route<CrmContactsResponse> = contactList(CrmContactsQuery(q = query.trim().ifEmpty { null }, facets = true))

    /** The Contacts group's page under its filter (`CrmContactsQuery.list`, `ContactFilter.query`). */
    fun contactList(query: CrmContactsQuery): Route<CrmContactsResponse> = Route(
        "GET", listOf("crm", "contacts"),
        query = query.queryItems(),
        answer = Answer.Wire(CrmContactsResponse.serializer()), operation = "Couldn’t load contacts",
    )

    /** A relation picker's contact search: 50 at most, no facets. */
    fun contactSearch(query: String): Route<CrmContactsResponse> = Route(
        "GET", listOf("crm", "contacts"),
        query = CrmContactsQuery(q = query.trim().ifEmpty { null }, limit = 50).queryItems(),
        answer = Answer.Wire(CrmContactsResponse.serializer()), operation = "Couldn’t load contacts",
    )

    fun contact(id: String): Route<CrmContactResponse> = Route(
        "GET", listOf("crm", "contacts", id), answer = Answer.Wire(CrmContactResponse.serializer()),
        operation = "Couldn’t load that contact",
    )

    /** One contact's edit. Only the fields that changed go out. */
    fun updateContact(id: String, update: CrmContactUpdate): Route<CrmContactResponse> = Route(
        "PATCH", listOf("crm", "contacts", id), body = json(CrmContactUpdate.serializer(), update),
        answer = Answer.Wire(CrmContactResponse.serializer()), operation = "Couldn’t save that contact",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** A new contact: the name, and only what the form says a new one sends. */
    fun createContact(create: CrmContactCreate): Route<CrmContactResponse> = Route(
        "POST", listOf("crm", "contacts"), body = json(CrmContactCreate.serializer(), create),
        answer = Answer.Wire(CrmContactResponse.serializer()), operation = "Couldn’t add that contact",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** Delete a contact. The Worker answers 409 while a call or a task references it. */
    fun deleteContact(id: String): Route<CrmContactDeleteResponse> = Route(
        "DELETE", listOf("crm", "contacts", id), answer = Answer.Wire(CrmContactDeleteResponse.serializer()),
        operation = "Couldn’t delete that contact",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** Merge contacts: the Worker keeps the older one and answers its id. */
    fun mergeContacts(ids: List<String>): Route<CoreMergeResponse> = Route(
        "POST", listOf("core", "merge", "contacts"), body = json(CoreMergeRequest.serializer(), CoreMergeRequest(ids)),
        answer = Answer.Wire(CoreMergeResponse.serializer()), operation = "Couldn’t merge those contacts",
        writes = listOf(SnapshotWrite.SUBJECT_WRITE),
    )

    /** The characteristic names and languages the workspace offers a contact. */
    fun contactOptions(): Route<CrmContactOptionsResponse> = Route(
        "GET", listOf("crm", "contact-options"), answer = Answer.Wire(CrmContactOptionsResponse.serializer()),
        operation = "Couldn’t load contact options",
    )

    // Issues

    /**
     * A picture for an issue body (`StarlingsWorkRoutes.uploadIssueImage`):
     * the bytes go as the body, through `TeamMedia.upload`, because the
     * client reads every body as text. The Worker sniffs them and answers
     * an absolute address github.com can render.
     */
    fun uploadIssueImage(): Route<IssueImageResponse> = Route(
        "PUT", listOf("issue-images"), answer = Answer.Wire(IssueImageResponse.serializer()),
        operation = "Couldn’t attach that image", timeoutSeconds = 120.0, origin = true,
    )

    fun issue(owner: String, repo: String, number: Long): Route<CrmIssueDetailResponse> = Route(
        "GET", listOf("crm", "issue"), query = CrmIssueRefQuery(owner, repo, number).queryItems(),
        answer = Answer.Wire(CrmIssueDetailResponse.serializer()), operation = "Couldn’t load that issue",
    )

    fun updateIssue(update: CrmIssueUpdate): Route<CrmIssueDetailResponse> = Route(
        "PATCH", listOf("crm", "issue"), body = json(CrmIssueUpdate.serializer(), update),
        answer = Answer.Wire(CrmIssueDetailResponse.serializer()), operation = "Couldn’t update that issue",
        writes = listOf(SnapshotWrite.ISSUE_WRITE),
    )

    fun createIssue(create: CrmIssueCreate): Route<CrmIssueResponse> = Route(
        "POST", listOf("crm", "issue"), body = json(CrmIssueCreate.serializer(), create),
        answer = Answer.Wire(CrmIssueResponse.serializer()), operation = "Couldn’t file that issue",
        writes = listOf(SnapshotWrite.ISSUE_WRITE),
    )

    /**
     * A project's GitHub issues through the Worker and Core (`IssueFilter.query`).
     * `page` is per repository. The snapshot is one per question and page.
     */
    fun issues(query: CrmIssueQuery): Route<CrmIssuesResponse> {
        val items = query.queryItems()
        return Route(
            "GET", listOf("crm", "issues"), query = items,
            answer = Answer.Wire(CrmIssuesResponse.serializer()), operation = "Couldn’t load issues",
            snapshotKey = SnapshotKey.ISSUES + "?" + items.joinToString("&") { (k, v) -> k + "=" + java.net.URLEncoder.encode(v, "UTF-8") },
        )
    }

    /** What an issue in this repository could be set to: labels, milestones, assignees. */
    fun issueFacets(owner: String, repo: String): Route<CrmIssueFacetsResponse> = Route(
        "GET", listOf("crm", "issue-facets"), query = CrmRepoQuery(owner, repo).queryItems(),
        answer = Answer.Wire(CrmIssueFacetsResponse.serializer()), operation = "Couldn’t read that repository",
    )

    // Repositories

    /** The repositories linked to a project; the primary one is where a new issue lands. */
    fun projectRepos(projectId: String): Route<CrmGithubReposResponse> = Route(
        "GET", listOf("crm", "project-repos"), query = CrmProjectQuery(projectId).queryItems(),
        answer = Answer.Wire(CrmGithubReposResponse.serializer()), operation = "Couldn’t load project repositories",
    )

    /** Repositories the Core GitHub App can link. The device never holds a GitHub credential. */
    fun githubRepos(query: String): Route<CrmGithubReposResponse> = Route(
        "GET", listOf("crm", "github-repos"), query = CrmGithubReposQuery(q = query.trim().ifEmpty { null }).queryItems(),
        answer = Answer.Wire(CrmGithubReposResponse.serializer()), operation = "Couldn’t search GitHub repositories",
    )

    fun addProjectRepo(create: CrmProjectRepoCreate): Route<CrmProjectRepoResponse> = Route(
        "POST", listOf("crm", "project-repos"), body = json(CrmProjectRepoCreate.serializer(), create),
        answer = Answer.Wire(CrmProjectRepoResponse.serializer()), operation = "Couldn’t link that repository",
    )
}
