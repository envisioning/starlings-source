import Foundation
import StarlingsContracts

/// The CRM and work routes, each named once for the Mac and the
/// phone: subjects, contacts and organizations, tasks, issues, the board,
/// INBOX, goals and decisions, Quick Notes, search and the Core token. Each
/// says its path, its query, its body, its answer, the sentence a failure is
/// titled with, the lists a write makes stale and the snapshot a read keeps.
/// `MeetingControlAPI` and `StarlingsAPI` send them; which client keeps which
/// snapshot is the request-policy table's (`StarlingsRequestPolicy.keeps`).
enum StarlingsWorkRoutes {
    // MARK: Subjects

    /// The browse list plus whether it is all of them. An event is open where
    /// the reader is (docs/EVENTS.md): this device's day, not the Worker's.
    static func subjects(
        kind: MeetingCategoryKind.SubjectKind,
        query: String,
        status: String?,
        organizations: OrganizationListFilter? = nil,
        leadSource: String? = nil
    ) -> StarlingsRoute<CrmSubjectsResponse> {
        // A filtered organization list keeps its own snapshot, the way a status does.
        let filterTag = kind == .organization ? organizations?.snapshotTag : nil
        return StarlingsRoute(
            method: "GET", path: ["crm", "subjects"],
            query: CrmSubjectsQuery.browse(
                kind: kind, query: query, status: status, today: CrmTaskDate.civilDay(Date()), organizations: organizations, leadSource: leadSource
            ).queryItems,
            operation: String(localized: "Couldn’t load CRM subjects"),
            snapshotKey: StarlingsSnapshotKey.subjectsKey(kind: kind, query: query, status: leadSource.map { "source:\($0)" } ?? filterTag ?? status)
        )
    }

    /// The status badges for one kind, in one request, exact. `query` narrows
    /// the same way the visible list does; see docs/WORK.md.
    static func subjectCounts(kind: MeetingCategoryKind.SubjectKind, query: String) -> StarlingsRoute<CrmSubjectCountsResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "subject-counts"],
            query: CrmSubjectCountsQuery(kind: .init(rawValue: kind.rawValue), q: query.isEmpty ? nil : query).queryItems,
            operation: String(localized: "Couldn’t count CRM subjects"),
            snapshotKey: StarlingsSnapshotKey.subjectCountsKey(kind: kind, query: query)
        )
    }

    /// `snapshotted` keeps the body under `crm/subjects/<kind>/<id>` for a
    /// read-only page to paint first. An editor reads live: its fields are
    /// about to be written, and a stale field is a stale write.
    static func subjectDetail(kind: MeetingCategoryKind.SubjectKind, id: String, snapshotted: Bool = false) -> StarlingsRoute<CrmSubjectDetailResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "subjects", kind.rawValue, id],
            operation: String(localized: "Couldn’t load CRM subject"),
            snapshotKey: snapshotted ? StarlingsSnapshotKey.subjectDetailKey(kind: kind, id: id) : nil
        )
    }

    /// The form answers that filed a lead, or nil for a lead a member made
    /// (docs/FORMS.md).
    static func leadSubmission(id: String) -> StarlingsRoute<SubjectSubmissionResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "subjects", "lead", id, "submission"],
            operation: String(localized: "Couldn’t load the answers")
        )
    }

    /// A lead's or an organization's offers and licenses, newest first. A
    /// nil list is a module the workspace has off.
    static func subjectCommercial(kind: MeetingCategoryKind.SubjectKind, id: String) -> StarlingsRoute<CrmSubjectCommercialResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "subjects", kind.rawValue, id, "commercial"],
            operation: String(localized: "Couldn’t load offers and licenses")
        )
    }

    // MARK: Offers and the catalog

    static func offer(id: String) -> StarlingsRoute<OfferResponse> {
        StarlingsRoute(method: "GET", path: ["crm", "offers", id], operation: String(localized: "Couldn’t load the offer."))
    }

    static func offerVersion(id: String, version: Int) -> StarlingsRoute<OfferVersionResponse> {
        StarlingsRoute(method: "GET", path: ["crm", "offers", id, "versions", String(version)], operation: String(localized: "Couldn’t load that version."))
    }

    static func offerOptions() -> StarlingsRoute<OfferOptionsResponse> {
        StarlingsRoute(method: "GET", path: ["crm", "offer-options"], operation: String(localized: "Couldn’t load the offer."))
    }

    /// Every licence, newest start first, narrowed by product (decided by MZ, 2026-11-05).
    static func licenses(product: String? = nil, active: Bool? = nil) -> StarlingsRoute<LicensesResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "licenses"],
            query: (product.map { [URLQueryItem(name: "product", value: $0)] } ?? [])
                + (active.map { [URLQueryItem(name: "active", value: $0 ? "true" : "false")] } ?? []),
            operation: String(localized: "Couldn’t load licenses.")
        )
    }

    /// Every offer, newest first, by the status a reader sees.
    static func offers(status: String? = nil) -> StarlingsRoute<OffersResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "offers"],
            query: status.map { [URLQueryItem(name: "status", value: $0)] } ?? [],
            operation: String(localized: "Couldn’t load offers.")
        )
    }

    static func createLicense(_ create: LicenseCreate) -> StarlingsRoute<LicenseResponse> {
        StarlingsRoute(method: "POST", path: ["crm", "licenses"], body: create, operation: String(localized: "Couldn’t save the license."))
    }

    static func patchLicense(id: String, _ patch: LicensePatch) -> StarlingsRoute<LicenseResponse> {
        StarlingsRoute(method: "PATCH", path: ["crm", "licenses", id], body: patch, operation: String(localized: "Couldn’t save the license."))
    }

    static func endLicense(id: String) -> StarlingsRoute<LicenseResponse> {
        StarlingsRoute(method: "POST", path: ["crm", "licenses", id, "end"], operation: String(localized: "Couldn’t save the license."))
    }

    static func createOffer(_ create: OfferCreate) -> StarlingsRoute<OfferResponse> {
        StarlingsRoute(method: "POST", path: ["crm", "offers"], body: create, operation: String(localized: "Couldn’t create the offer."))
    }

    static func patchOffer(id: String, _ patch: OfferPatch) -> StarlingsRoute<OfferResponse> {
        StarlingsRoute(method: "PATCH", path: ["crm", "offers", id], body: patch, operation: String(localized: "Couldn’t save the offer."))
    }

    static func addOfferLine(offerID: String, _ line: OfferLineCreate) -> StarlingsRoute<OfferResponse> {
        StarlingsRoute(method: "POST", path: ["crm", "offers", offerID, "lines"], body: line, operation: String(localized: "Couldn’t save the offer."))
    }

    static func patchOfferLine(offerID: String, lineID: String, _ patch: OfferLinePatch) -> StarlingsRoute<OfferResponse> {
        StarlingsRoute(method: "PATCH", path: ["crm", "offers", offerID, "lines", lineID], body: patch, operation: String(localized: "Couldn’t save the offer."))
    }

    static func removeOfferLine(offerID: String, lineID: String) -> StarlingsRoute<OfferResponse> {
        StarlingsRoute(method: "DELETE", path: ["crm", "offers", offerID, "lines", lineID], operation: String(localized: "Couldn’t save the offer."))
    }

    /// `update` is Send update: the same link, a new version.
    static func sendOffer(id: String, update: Bool) -> StarlingsRoute<OfferSendResponse> {
        StarlingsRoute(method: "POST", path: ["crm", "offers", id, update ? "send-update" : "send"], operation: String(localized: "Couldn’t send the offer."))
    }

    static func duplicateOffer(id: String, to target: OfferDuplicate) -> StarlingsRoute<OfferResponse> {
        StarlingsRoute(method: "POST", path: ["crm", "offers", id, "duplicate"], body: target, operation: String(localized: "Couldn’t duplicate the offer."))
    }

    static func recordOfferDecision(id: String, _ decision: OfferDecision) -> StarlingsRoute<OfferResponse> {
        StarlingsRoute(method: "POST", path: ["crm", "offers", id, "decision"], body: decision, operation: String(localized: "Couldn’t record the answer."))
    }

    static func organizationDiscount(id: String) -> StarlingsRoute<OrganizationDiscountResponse> {
        StarlingsRoute(method: "GET", path: ["crm", "organizations", id, "default-discount"], operation: String(localized: "Couldn’t load the partner discount."))
    }

    static func setOrganizationDiscount(id: String, _ discount: OrganizationDiscount) -> StarlingsRoute<OrganizationDiscountResponse> {
        StarlingsRoute(method: "PATCH", path: ["crm", "organizations", id, "default-discount"], body: discount, operation: String(localized: "Couldn’t save the partner discount."))
    }

    static func catalog() -> StarlingsRoute<CatalogResponse> {
        StarlingsRoute(method: "GET", path: ["crm", "services"], operation: String(localized: "Couldn’t load the catalog."))
    }

    static func createService(_ create: ServiceCreate) -> StarlingsRoute<CatalogServiceResponse> {
        StarlingsRoute(method: "POST", path: ["crm", "services"], body: create, operation: String(localized: "Couldn’t save the service."))
    }

    static func patchService(id: String, _ patch: ServicePatch) -> StarlingsRoute<CatalogServiceResponse> {
        StarlingsRoute(method: "PATCH", path: ["crm", "services", id], body: patch, operation: String(localized: "Couldn’t save the service."))
    }

    static func createSubject(_ create: CrmSubjectCreate) -> StarlingsRoute<CrmSubjectMutationResponse> {
        StarlingsRoute(
            method: "POST", path: ["crm", "subjects"], body: create,
            operation: String(localized: "Couldn’t create CRM subject"),
            writes: [.subjectWrite]
        )
    }

    /// Win an open lead (ADR 0008): the Worker creates the project, moves the
    /// named open tasks, then closes the lead as won. It writes subjects and
    /// tasks, so both snapshot sets go stale.
    static func winLead(id: String, _ win: CrmLeadWin) -> StarlingsRoute<CrmLeadWinResponse> {
        StarlingsRoute(
            method: "POST", path: ["crm", "subjects", "lead", id, "win"], body: win,
            operation: String(localized: "Couldn’t win the lead"),
            writes: [.subjectWrite, .taskUpdate]
        )
    }

    static func updateSubject(kind: MeetingCategoryKind.SubjectKind, id: String, _ update: CrmSubjectUpdate) -> StarlingsRoute<CrmSubjectMutationResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "subjects", kind.rawValue, id], body: update,
            operation: String(localized: "Couldn’t update CRM subject"),
            writes: [.subjectWrite]
        )
    }

    /// Choose who answers for a project or lead, or nil to clear the choice
    /// (docs/OWNERSHIP.md). Sends nothing else.
    static func setSubjectResponsible(kind: MeetingCategoryKind.SubjectKind, id: String, email: String?) -> StarlingsRoute<CrmSubjectMutationResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "subjects", kind.rawValue, id],
            body: CrmSubjectResponsibleUpdate(responsibleEmail: email),
            operation: String(localized: "Couldn’t change who is responsible"),
            writes: [.subjectWrite]
        )
    }

    /// A quick rename sends the title alone, so it cannot clear metadata the
    /// focused editor does not show.
    static func renameSubject(kind: MeetingCategoryKind.SubjectKind, id: String, title: String) -> StarlingsRoute<CrmSubjectMutationResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "subjects", kind.rawValue, id],
            body: CrmSubjectUpdate.rename(kind: kind, title: title),
            operation: String(localized: "Couldn’t rename CRM subject"),
            writes: [.subjectWrite]
        )
    }

    // MARK: Organizations and contacts

    /// Organizations matching `query`, from the Worker's owner-scoped search,
    /// which asks Core for organizations only.
    static func organizations(matching query: String) -> StarlingsRoute<StarlingsContracts.CrmOrganizationsResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "organizations"],
            query: [URLQueryItem(name: "q", value: query)],
            operation: String(localized: "Couldn’t search organizations")
        )
    }

    /// Creates an organization by name: in Core on a Core workspace, in the
    /// workspace's D1 otherwise.
    static func createOrganization(named name: String) -> StarlingsRoute<StarlingsContracts.CrmOrganizationResponse> {
        StarlingsRoute(
            method: "POST", path: ["crm", "organizations"],
            body: StarlingsContracts.CrmOrganizationCreate(
                name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(CoreSession.organizationNameLimit))
            ),
            operation: String(localized: "Couldn’t create CRM subject"),
            writes: [.subjectWrite]
        )
    }

    /// Edit an organization: Core while the subjects group is
    /// there, D1 once it has moved. Sends only the fields that changed.
    static func updateOrganization(id: String, _ update: CrmOrganizationUpdate) -> StarlingsRoute<CrmSubjectDetailResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "subjects", MeetingCategoryKind.SubjectKind.organization.rawValue, id], body: update,
            operation: String(localized: "Couldn’t save that organization"),
            writes: [.subjectWrite]
        )
    }

    /// Merge organizations: the oldest stays and takes every
    /// link; the others are deleted. Core merges while the subjects group is
    /// there, the Worker on D1 after, with the same answer.
    static func mergeOrganizations(ids: [String]) -> StarlingsRoute<CoreMergeResponse> {
        StarlingsRoute(
            method: "POST", path: ["core", "merge", "organizations"], body: CoreMergeRequest(ids: ids),
            operation: String(localized: "Couldn’t merge those organizations"),
            writes: [.subjectWrite]
        )
    }

    /// Delete an organization. The Worker answers 409 while a
    /// record still points at it, and the message names those records.
    static func deleteOrganization(id: String) -> StarlingsRoute<CrmOrganizationDeleteResponse> {
        StarlingsRoute(
            method: "DELETE", path: ["crm", "subjects", MeetingCategoryKind.SubjectKind.organization.rawValue, id],
            operation: String(localized: "Couldn’t delete that organization"),
            writes: [.subjectWrite]
        )
    }

    /// Contacts matching `query`, the contacts named by `ids`, or the
    /// contacts that hold any of `emails` (; lower-cased, at most
    /// 25), the workspace's own on D1 or Core's as the member.
    static func contacts(matching query: String?, ids: [String]?, organizationID: String? = nil, emails: [String]? = nil) -> StarlingsRoute<CrmContactsResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "contacts"],
            query: CrmContactsQuery(
                q: query.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 },
                organizationID: organizationID,
                ids: ids.map { $0.joined(separator: ",") },
                emails: emails.map { $0.prefix(CrmContact.attendeeLookupLimit).map { $0.lowercased() }.joined(separator: ",") },
                limit: 50
            ).queryItems,
            operation: String(localized: "Couldn’t load contacts")
        )
    }

    /// The Contacts group's page: a search and its filters, with
    /// the facets for the filter menu.
    static func contactList(query: String, filter: ContactListFilter) -> StarlingsRoute<CrmContactsResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "contacts"],
            query: CrmContactsQuery.list(query: query, filter: filter).queryItems,
            operation: String(localized: "Couldn’t load contacts")
        )
    }

    /// What the contact editor offers: characteristic names and languages.
    static let contactOptions = StarlingsRoute<CrmContactOptionsResponse>(
        method: "GET", path: ["crm", "contact-options"],
        operation: String(localized: "Couldn’t load contact options")
    )

    /// Merge contacts: the oldest stays and takes every link and
    /// address; the others are deleted. The answer is the same from Core and D1.
    static func mergeContacts(ids: [String]) -> StarlingsRoute<CoreMergeResponse> {
        StarlingsRoute(
            method: "POST", path: ["core", "merge", "contacts"], body: CoreMergeRequest(ids: ids),
            operation: String(localized: "Couldn’t merge those contacts"),
            writes: [.subjectWrite]
        )
    }

    /// Delete a contact. The Worker answers 409 while a call or a
    /// task references it, and the message names them.
    static func deleteContact(id: String) -> StarlingsRoute<CrmContactDeleteResponse> {
        StarlingsRoute(
            method: "DELETE", path: ["crm", "contacts", id],
            operation: String(localized: "Couldn’t delete that contact"),
            writes: [.subjectWrite]
        )
    }

    /// Delete a task from the store that holds the tasks group.
    /// The Worker answers 404 when it is gone and 403 without the write right
    /// on the task's subject.
    static func deleteTask(id: String) -> StarlingsRoute<CrmTaskDeleteResponse> {
        StarlingsRoute(
            method: "DELETE", path: ["crm", "tasks", id],
            operation: String(localized: "Couldn’t delete that task."),
            writes: [.taskUpdate]
        )
    }

    /// An organization's Tasks By project: its projects with open
    /// tasks, each with its tasks. Projects with no open task are left out.
    static func organizationProjectTasks(id: String) -> StarlingsRoute<CrmOrganizationProjectTasksResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "subjects", "organization", id, "project-tasks"],
            operation: String(localized: "Couldn’t load tasks")
        )
    }

    static func contact(id: String) -> StarlingsRoute<CrmContactResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "contacts", id],
            operation: String(localized: "Couldn’t load that contact")
        )
    }

    static func createContact(_ create: CrmContactCreate) -> StarlingsRoute<CrmContactResponse> {
        StarlingsRoute(
            method: "POST", path: ["crm", "contacts"], body: create,
            operation: String(localized: "Couldn’t add that contact"),
            writes: [.subjectWrite]
        )
    }

    static func updateContact(id: String, _ update: CrmContactUpdate) -> StarlingsRoute<CrmContactResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "contacts", id], body: update,
            operation: String(localized: "Couldn’t save that contact"),
            writes: [.subjectWrite]
        )
    }

    // MARK: Workspace plan

    /// The plan, its project limit and the kept project. Any member reads it.
    static let workspacePlan = StarlingsRoute<WorkspacePlanResponse>(
        method: "GET", path: ["workspace", "plan"],
        operation: String(localized: "Couldn’t read the plan")
    )

    /// Root admins only, until billing sets the plan.
    static func setWorkspacePlan(_ plan: WorkspacePlanUpdateRequestPlan) -> StarlingsRoute<WorkspacePlanResponse> {
        StarlingsRoute(
            method: "PUT", path: ["admin", "plan"], body: WorkspacePlanUpdateRequest(plan: plan),
            operation: String(localized: "Couldn’t change the plan")
        )
    }

    /// An admin picks the one writable project on Free, once.
    static func keepWorkspaceProject(id: String) -> StarlingsRoute<WorkspacePlanResponse> {
        StarlingsRoute(
            method: "PUT", path: ["admin", "plan", "kept-project"],
            body: WorkspaceKeptProjectUpdateRequest(projectID: id),
            operation: String(localized: "Couldn’t keep that project")
        )
    }

    // MARK: Team and GitHub

    /// Who work can be assigned to. Core is the roster, not the presence list.
    static let team = StarlingsRoute<CrmTeamResponse>(
        method: "GET", path: ["crm", "team"],
        operation: String(localized: "Couldn’t load the team")
    )

    /// Repositories the Core GitHub App can link to a project. Meet never
    /// receives a GitHub credential.
    static func githubRepos(query: String) -> StarlingsRoute<CrmGithubReposResponse> {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return StarlingsRoute(
            method: "GET", path: ["crm", "github-repos"],
            query: CrmGithubReposQuery(q: trimmed.isEmpty ? nil : trimmed).queryItems,
            operation: String(localized: "Couldn’t search GitHub repositories")
        )
    }

    /// The repositories linked to a project; the primary one is where a new
    /// issue lands.
    static func projectRepos(projectID: String) -> StarlingsRoute<CrmGithubReposResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "project-repos"],
            query: CrmProjectQuery(projectID: projectID).queryItems,
            operation: String(localized: "Couldn’t load project repositories")
        )
    }

    static func addProjectRepo(_ create: CrmProjectRepoCreate) -> StarlingsRoute<CrmProjectRepoResponse> {
        StarlingsRoute(
            method: "POST", path: ["crm", "project-repos"], body: create,
            operation: String(localized: "Couldn’t link that repository")
        )
    }

    /// A project's GitHub issues, through the Worker and Core. `page` is per
    /// repository, the honest unit for a list merged from several.
    static func issues(projectID: String, filter: CrmIssueFilter, page: Int) -> StarlingsRoute<CrmIssuesResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "issues"],
            query: filter.query(projectID: projectID, page: page).queryItems,
            operation: String(localized: "Couldn’t load issues"),
            snapshotKey: StarlingsSnapshotKey.issuesKey(projectID: projectID, filter: filter, page: page)
        )
    }

    static func issue(owner: String, repo: String, number: Int) -> StarlingsRoute<CrmIssueDetailEnvelope> {
        StarlingsRoute(
            method: "GET", path: ["crm", "issue"],
            query: CrmIssueRefQuery(owner: owner, repo: repo, number: number).queryItems,
            operation: String(localized: "Couldn’t load that issue")
        )
    }

    /// What an issue in this repository could be set to. Asked once per
    /// repository and reused.
    static func issueFacets(owner: String, repo: String) -> StarlingsRoute<CrmIssueFacets> {
        StarlingsRoute(
            method: "GET", path: ["crm", "issue-facets"],
            query: CrmRepoQuery(owner: owner, repo: repo).queryItems,
            operation: String(localized: "Couldn’t read that repository")
        )
    }

    static func createIssue(_ create: CrmIssueCreate) -> StarlingsRoute<CrmIssueEnvelope> {
        StarlingsRoute(
            method: "POST", path: ["crm", "issue"], body: create,
            operation: String(localized: "Couldn’t file that issue"),
            writes: [.issueWrite]
        )
    }

    static func updateIssue(_ update: CrmIssueUpdate) -> StarlingsRoute<CrmIssueDetailEnvelope> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "issue"], body: update,
            operation: String(localized: "Couldn’t update that issue"),
            writes: [.issueWrite]
        )
    }

    /// One picture for a GitHub issue, and where it lives. One request: there
    /// is no row to reserve, only bytes to keep. The answer is readable
    /// without a session, because github.com renders an issue body for
    /// whoever is looking. Generous on time: it carries megabytes.
    static func uploadIssueImage(contentType: String, data: Data) -> StarlingsRoute<IssueImageAnswer> {
        StarlingsRoute(
            method: "PUT", path: ["issue-images"],
            upload: StarlingsUpload(data: data, contentType: contentType),
            operation: String(localized: "Couldn’t attach that image"),
            timeout: 120,
            origin: true
        )
    }

    /// Somebody's GitHub picture, through the Worker rather than from the
    /// CDN: the bytes are public, who asks for them is not. A face is
    /// immutable, so this is the one read that keeps its answer in the URL
    /// cache.
    static func githubAvatar(url: String, size: Int) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "GET", path: ["crm", "avatar"],
            query: CrmAvatarQuery(url: url, size: size).queryItems,
            operation: String(localized: "Couldn’t load that picture"),
            accept: "image/*",
            cachesAnswer: true
        )
    }

    // MARK: Search and work

    /// One search: every hit the Worker can see, in the contract's
    /// order. `timeZone` is this device's, for the clock on an event row.
    static func search(query: String, timeZone: String) -> StarlingsRoute<SearchResponse> {
        StarlingsRoute(
            method: "GET", path: ["search"],
            query: SearchQuery(q: query, tz: timeZone).queryItems,
            operation: String(localized: "Couldn’t search")
        )
    }

    /// Everything you owe, across every subject.
    static let mine = StarlingsRoute<CrmMyWorkResponse>(
        method: "GET", path: ["crm", "mine"],
        operation: String(localized: "Couldn’t load your work"),
        snapshotKey: StarlingsSnapshotKey.mine
    )

    static let unowned = StarlingsRoute<CrmUnownedWorkResponse>(
        method: "GET", path: ["crm", "unowned"],
        operation: String(localized: "Couldn’t load unowned work")
    )

    /// Your own task completions and closed GitHub issues from the last week.
    static let recentlyClosed = StarlingsRoute<CrmRecentlyClosedWorkResponse>(
        method: "GET", path: ["crm", "recently-closed"],
        operation: String(localized: "Couldn’t load recently finished work")
    )

    /// What one colleague owes, across every subject. The Worker checks the
    /// address is on the team before it asks Core.
    static func work(assigneeEmail: String) -> StarlingsRoute<CrmMyWorkResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "work"],
            query: CrmMyWorkQuery(assigneeEmail: assigneeEmail).queryItems,
            operation: String(localized: "Couldn’t load their work")
        )
    }

    /// Say who you are on GitHub. Only ever your own record: the Worker takes
    /// the address from the session.
    static func setGithubLogin(_ login: String?) -> StarlingsRoute<CrmGithubLoginResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "mine"], body: CrmGithubLoginUpdate(githubLogin: login),
            operation: String(localized: "Couldn’t save that username"),
            writes: [.githubLoginSet]
        )
    }

    /// The card board (docs/BOARD.md): every open card, or one project's
    ///. One read; the Worker does the fan-out.
    static func board(projectID: String?) -> StarlingsRoute<CrmBoardResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "board"],
            query: projectID.map { [URLQueryItem(name: "project_id", value: $0)] } ?? [],
            operation: String(localized: "Couldn’t load the board")
        )
    }

    // MARK: Tasks

    /// One subject's tasks, or a meeting's. A meeting's list is kept under
    /// its own snapshot, never the list with no subject.
    static func tasks(
        projectID: String?, leadID: String?, eventID: String?, organizationID: String?, meetingID: String?
    ) -> StarlingsRoute<CrmTasksResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "tasks"],
            query: CrmTasksQuery(
                projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID, meetingID: meetingID
            ).queryItems,
            operation: String(localized: "Couldn’t load tasks"),
            snapshotKey: StarlingsSnapshotKey.tasksKey(
                projectID: projectID, leadID: leadID, eventID: eventID ?? meetingID, organizationID: organizationID
            )
        )
    }

    /// One task's full record by id, whatever it is filed on.
    static func task(id: String) -> StarlingsRoute<StarlingsContracts.CrmTaskResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "tasks", id],
            operation: String(localized: "Couldn’t load that task")
        )
    }

    static func createTask(_ create: CrmTaskCreate) -> StarlingsRoute<CrmTaskEnvelope> {
        StarlingsRoute(
            method: "POST", path: ["crm", "tasks"], body: create,
            operation: String(localized: "Couldn’t create that task"),
            writes: [.taskCreate]
        )
    }

    /// A proposal answered here leaves INBOX too ( slice 2b).
    static func updateTask(id: String, _ update: CrmTaskUpdate) -> StarlingsRoute<CrmTaskEnvelope> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "tasks", id], body: update,
            operation: String(localized: "Couldn’t update that task"),
            writes: [.taskUpdate]
        )
    }

    // MARK: INBOX

    /// The Sales inbox: CRM touches with no subject yet (docs/WORK.md,
    ///). Dismissed rows are left out unless asked for.
    static func salesInbox(includeDismissed: Bool) -> StarlingsRoute<SalesInboxResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "sales-inbox"],
            query: SalesInboxQuery(includeDismissed: includeDismissed ? true : nil).queryItems,
            operation: String(localized: "Couldn’t load the sales inbox"),
            timeout: 20
        )
    }

    /// An INBOX item with no other resolution (`booking:*`): dismiss (POST)
    /// or undo (DELETE).
    static func setInboxItemDismissed(key: String, dismissed: Bool) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: dismissed ? "POST" : "DELETE", path: ["crm", "inbox", key, "dismiss"],
            operation: dismissed ? String(localized: "Couldn’t dismiss that") : String(localized: "Couldn’t undo that")
        )
    }

    /// Dismiss (POST) or undo (DELETE) one Sales touch: same row, same id.
    static func setSalesInboxDismissed(id: String, dismissed: Bool) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: dismissed ? "POST" : "DELETE", path: ["crm", "sales-inbox", id, "dismiss"],
            operation: dismissed ? String(localized: "Couldn’t dismiss that") : String(localized: "Couldn’t undo that")
        )
    }

    /// After the call: approve one draft revision. The ticked
    /// tasks are accepted, the rest declined; the answer is the mail draft.
    static func approveFollowUp(_ item: InboxFollowUpItem, accept: [String], decline: [String]) -> StarlingsRoute<MeetingFollowUpApproveResponse> {
        StarlingsRoute(
            method: "POST", path: ["rooms", item.meeting.roomSlug, "meetings", item.meeting.id, "follow-up"],
            body: MeetingFollowUpApprove(
                revision: item.revision, subject: item.draft.subject, body: item.draft.body,
                acceptTaskIDs: accept, declineTaskIDs: decline
            ),
            operation: String(localized: "Couldn’t approve that follow-up"),
            writes: [.taskUpdate]
        )
    }

    /// The host does not want the follow-up; its tasks stay in INBOX.
    static func dismissFollowUp(_ item: InboxFollowUpItem) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "DELETE", path: ["rooms", item.meeting.roomSlug, "meetings", item.meeting.id, "follow-up"],
            operation: String(localized: "Couldn’t dismiss that follow-up")
        )
    }

    /// The canonical request with its source permissions.
    static func attentionRequest(id: String) -> StarlingsRoute<AttentionRequest> {
        StarlingsRoute(
            method: "GET", path: ["attention", id],
            operation: String(localized: "Couldn’t load this question.")
        )
    }

    static func resolveAttention(id: String, _ command: AttentionResolveInput) -> StarlingsRoute<AttentionResolveResponse> {
        StarlingsRoute(
            method: "POST", path: ["attention", id, "resolve"], body: command,
            operation: String(localized: "Couldn’t submit this answer."),
            writes: [.attentionResolve]
        )
    }

    /// INBOX: one owner queue. `questions`: assigned agent questions
    ///. `cards`: agent work waiting on you (docs/OWNERSHIP.md
    /// decision 12). `followups`: a drafted follow-up after a call.
    /// `calendar`: invitations and events from email waiting on an answer.
    static let inbox = StarlingsRoute<WorkInboxResponse>(
        method: "GET", path: ["crm", "inbox"],
        query: InboxQuery(questions: true, cards: true, followups: true, calendar: true).queryItems,
        operation: String(localized: "Couldn’t load your inbox"),
        snapshotKey: StarlingsSnapshotKey.inbox
    )

    // MARK: Subject state and favorites

    /// Star, mute and the SALES opt-in, per person ( decision 5).
    static let subjectState = StarlingsRoute<SubjectStateResponse>(
        method: "GET", path: ["crm", "subject-state"],
        operation: String(localized: "Couldn’t read your subjects"),
        snapshotKey: StarlingsSnapshotKey.subjectState
    )

    /// Only the keys sent change. The Worker answers with the row as stored,
    /// or nil when it now says nothing the default would not.
    static func setSubjectState(kind: MeetingCategoryKind.SubjectKind, id: String, _ update: SubjectStateUpdate) -> StarlingsRoute<SubjectStateUpdateResponse> {
        StarlingsRoute(
            method: "PUT", path: ["crm", "subject-state", kind.rawValue, id], body: update,
            operation: String(localized: "Couldn’t change that"),
            writes: [.subjectStateSet]
        )
    }

    /// One field of the Work preferences, sent whole. `operation` names the
    /// field: Sales, Work, the list, Inbox or the board.
    static func setWorkPreferences(_ update: WorkPreferencesUpdate, operation: String) -> StarlingsRoute<SubjectStateResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "subject-state"], body: update,
            operation: operation,
            writes: [.workPreferencesSet]
        )
    }

    /// The things this person starred, as search rows, newest star first:
    /// Home's QUICK ACCESS list.
    static let starred = StarlingsRoute<SearchResponse>(
        method: "GET", path: ["crm", "starred"],
        operation: String(localized: "Couldn’t load favorites."),
        snapshotKey: StarlingsSnapshotKey.starred
    )

    static let favorites = StarlingsRoute<FavoritesResponseWire>(
        method: "GET", path: ["crm", "favorites"],
        operation: String(localized: "Couldn’t load favorites"),
        snapshotKey: StarlingsSnapshotKey.favorites
    )

    static func addFavorite(_ target: FavoriteTarget) -> StarlingsRoute<FavoriteMutationResponseWire> {
        StarlingsRoute(
            method: "POST", path: ["crm", "favorites"], body: target,
            operation: String(localized: "Couldn’t update favorites"),
            writes: [.favoriteSet]
        )
    }

    static func removeFavorite(_ target: FavoriteTarget) -> StarlingsRoute<FavoriteRemoveResponseWire> {
        StarlingsRoute(
            method: "DELETE", path: ["crm", "favorites"],
            query: FavoriteTargetQuery(kind: .init(rawValue: target.kind.rawValue), targetRef: target.targetRef).queryItems,
            operation: String(localized: "Couldn’t update favorites"),
            writes: [.favoriteSet]
        )
    }

    // MARK: History, goals and decisions

    /// Durable CRM interactions filed under one project, lead or
    /// organization: exactly one of the three.
    static func interactions(projectID: String?, leadID: String?, organizationID: String?) -> StarlingsRoute<CrmInteractionsResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "interactions"],
            query: CrmInteractionsQuery(projectID: projectID, leadID: leadID, organizationID: organizationID).queryItems,
            operation: String(localized: "Couldn’t load interactions"),
            snapshotKey: StarlingsSnapshotKey.interactionsKey(projectID: projectID, leadID: leadID, organizationID: organizationID)
        )
    }

    /// A call, meeting or note logged by hand on a subject's History
    ///. Filed on an organization, a lead or a project.
    static func createInteraction(_ create: CrmInteractionCreate) -> StarlingsRoute<CrmInteractionResponse> {
        StarlingsRoute(
            method: "POST", path: ["crm", "interactions"], body: create,
            operation: String(localized: "Couldn’t log that interaction"),
            writes: [.interactionWrite]
        )
    }

    /// Only the fields sent change; `contact_ids` replaces the list.
    static func updateInteraction(id: String, _ update: CrmInteractionUpdate) -> StarlingsRoute<CrmInteractionResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "interactions", id], body: update,
            operation: String(localized: "Couldn’t save that interaction"),
            writes: [.interactionWrite]
        )
    }

    /// Its contact and subject links go with it.
    static func deleteInteraction(id: String) -> StarlingsRoute<CrmInteractionDeleteResponse> {
        StarlingsRoute(
            method: "DELETE", path: ["crm", "interactions", id],
            operation: String(localized: "Couldn’t delete that interaction"),
            writes: [.interactionWrite]
        )
    }

    static func goals(projectID: String, includeClosed: Bool) -> StarlingsRoute<CrmGoalsResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "goals"],
            query: CrmGoalsQuery(projectID: projectID, includeClosed: includeClosed ? true : nil).queryItems,
            operation: String(localized: "Couldn’t load goals")
        )
    }

    static func createGoal(_ create: CrmGoalCreate) -> StarlingsRoute<CrmGoalResponse> {
        StarlingsRoute(
            method: "POST", path: ["crm", "goals"], body: create,
            operation: String(localized: "Couldn’t create that goal")
        )
    }

    static func updateGoal(id: String, _ update: CrmGoalUpdate) -> StarlingsRoute<CrmGoalResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["crm", "goals", id], body: update,
            operation: String(localized: "Couldn’t update that goal")
        )
    }

    static func decisions(subjectKind: String, subjectID: String) -> StarlingsRoute<CrmDecisionsResponse> {
        StarlingsRoute(
            method: "GET", path: ["crm", "decisions"],
            query: CrmDecisionsQuery(subjectKind: .init(rawValue: subjectKind), subjectID: subjectID).queryItems,
            operation: String(localized: "Couldn’t load decisions")
        )
    }

    static func createDecision(_ create: CrmDecisionCreate) -> StarlingsRoute<CrmDecisionResponse> {
        StarlingsRoute(
            method: "POST", path: ["crm", "decisions"], body: create,
            operation: String(localized: "Couldn’t record that decision")
        )
    }

    /// Answer a decision waiting on you (docs/help/howto/answer-a-decision.md).
    /// The same answer again is safe: it only retries the Core record.
    static func answerDecisionAsk(id: String, answer: String, note: String?) -> StarlingsRoute<DecisionAskResponse> {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return StarlingsRoute(
            method: "POST", path: ["decision-asks", id, "answer"],
            body: DecisionAskAnswerRequest(answer: answer, note: trimmed.isEmpty ? .omit : .value(trimmed)),
            operation: String(localized: "Couldn’t answer that decision")
        )
    }

    // MARK: Quick Notes

    static let quickNotes = StarlingsRoute<QuickNotesResponse>(
        method: "GET", path: ["quick-notes"],
        operation: String(localized: "Couldn’t load Quick Notes"),
        snapshotKey: StarlingsSnapshotKey.quickNotes
    )

    /// The create carries the client's id: a repeat answers the
    /// note the first one made, so an outbox can retry without a duplicate.
    static func createQuickNote(_ create: QuickNoteCreate) -> StarlingsRoute<QuickNoteResponse> {
        StarlingsRoute(
            method: "POST", path: ["quick-notes"], body: create,
            operation: String(localized: "Couldn’t save Quick Note"),
            writes: [.quickNoteWrite]
        )
    }

    /// Rewrite the body; the note keeps its place, state and filing.
    static func updateQuickNote(id: String, body: String) -> StarlingsRoute<QuickNoteResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["quick-notes", id], body: QuickNoteUpdate(body: body),
            operation: String(localized: "Couldn’t save Quick Note"),
            writes: [.quickNoteWrite]
        )
    }

    static func deleteQuickNote(id: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "DELETE", path: ["quick-notes", id],
            operation: String(localized: "Couldn’t delete Quick Note"),
            writes: [.quickNoteWrite]
        )
    }

    /// Record where a note went. A retry of the same promotion is a no-op.
    static func promoteQuickNote(id: String, _ promote: QuickNotePromote) -> StarlingsRoute<QuickNoteResponse> {
        StarlingsRoute(
            method: "POST", path: ["quick-notes", id, "promote"], body: promote,
            operation: String(localized: "Couldn’t file Quick Note"),
            writes: [.quickNoteWrite]
        )
    }

    // MARK: Home and Core

    /// Home's COMMERCIAL card paints the last summary before Core answers.
    static let commercialSummary = StarlingsRoute<CommercialSummary>(
        method: "GET", path: ["crm", "commercial-summary"],
        operation: String(localized: "Couldn’t load commercial history"),
        snapshotKey: StarlingsSnapshotKey.commercialSummary
    )

    /// A Core personal access token for the signed-in owner, brokered by the
    /// Worker. Keychain only; never logged.
    static func coreToken(deviceName: String) -> StarlingsRoute<CoreToken> {
        StarlingsRoute(
            method: "POST", path: ["core", "token"], body: CoreTokenRequest(deviceName: deviceName),
            operation: String(localized: "Couldn’t connect records")
        )
    }
}
