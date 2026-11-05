import DocsKit
import Foundation
import StarlingsContracts

struct StarlingsEnvironment: Equatable, Sendable {
    let apiBaseURL: URL
    let webOrigin: String

    static func configured(defaults: UserDefaults = .standard) -> StarlingsEnvironment {
        #if DEBUG
        let override = defaults.string(forKey: "meet.development.apiEndpoint")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        #else
        let override: String? = nil
        #endif
        // The active workspace is the only source; the Debug override above
        // points its API at another server for local work.
        let workspace = StarlingsWorkspace.active
        let apiBaseURL = override?.isEmpty == false ? URL(string: override!) ?? workspace.apiBaseURL : workspace.apiBaseURL
        return StarlingsEnvironment(apiBaseURL: apiBaseURL, webOrigin: workspace.webOrigin)
    }
}

struct StarlingsAPI {
    let environment: StarlingsEnvironment
    let session: URLSession
    /// The replay on a refused owner token. The default renews the active
    /// workspace's session; a request on another workspace's session passes
    /// `.none` (`QuickNoteMove`).
    let ownerSessionRenewal: StarlingsOwnerSessionRenewal

    init(
        environment: StarlingsEnvironment = .configured(),
        session: URLSession = .shared,
        ownerSessionRenewal: StarlingsOwnerSessionRenewal = StarlingsAPI.ownerSessionRenewal
    ) {
        self.environment = environment
        self.session = session
        self.ownerSessionRenewal = ownerSessionRenewal
    }

    /// Builds and sends every request in this file.
    var httpTransport: StarlingsHTTPTransport {
        StarlingsHTTPTransport(
            baseURL: environment.apiBaseURL,
            session: session,
            webOrigin: environment.webOrigin,
            ownerSessionRenewal: ownerSessionRenewal
        )
    }

    /// The phone's half of the owner-session replay. Any surface
    /// can be the one that learns the owner token is dead: Home's agenda,
    /// Work's list, a Team poll. The app model renews (installed into
    /// `MobileOwnerSessionRenewal`), and the request goes out again with the
    /// fresh token, so the screen that asked gets its answer. A renewal that
    /// gives no token, or a second refusal, is posted, so the app can sign
    /// out instead of each screen drawing a signed-in state off a Keychain
    /// item the Worker no longer honours.
    static let ownerSessionRenewal = StarlingsOwnerSessionRenewal(
        renew: { refused in
            await MobileOwnerSessionRenewal.shared.renewedAccessToken(replacing: refused)
        },
        rejected: {
            NotificationCenter.default.post(name: StarlingsAPI.ownerSessionRejectedNotification, object: nil)
        }
    )

    /// A knock. Signed in, it carries the member session too — the room only
    /// treats a verified Envisioning identity as a call rather than a request,
    /// and without the header your own phone would queue at your own door. The
    /// browser has always sent this (its cookie rides along); this is the same
    /// fact, said out loud.
    func requestJoin(
        room: MobileRoomPath,
        identity: MobileGuestIdentity,
        presenceID: String? = nil,
        member: MobileOwnerCredentials? = nil
    ) async throws -> JoinRequestReceipt {
        let guest = identity.normalized
        let body = JoinRequest(
            name: guest.name,
            email: guest.email,
            bookingToken: room.bookingToken,
            // Clears the pre-knock row this phone has been heartbeating, so the
            // owner sees one visitor who knocked rather than a lurker beside a guest.
            presenceID: presenceID,
            client: .thisDevice
        )
        return try await call(StarlingsRoomRoutes.knock(room: room.slug, body), bearer: member)
    }

    /// Pre-knock presence, the native twin of the browser join page's heartbeat.
    /// A knock at a room whose owner is away is refused, so this is the only
    /// trace an iPhone guest can leave for an owner who is not there yet.
    func touchGuestPresence(
        room: MobileRoomPath,
        presenceID: String,
        stage: GuestPresenceStage,
        name: String?
    ) async throws {
        // Display name at most, never the email — see docs/PRIVACY.md.
        _ = try await call(StarlingsRoomRoutes.guestPresence(room: room.slug, GuestPresenceReport(
            presenceID: presenceID,
            stage: stage,
            name: name,
            bookingToken: room.bookingToken,
            client: .thisDevice
        )), bearer: nil)
    }

    func publicRoom(_ room: MobileRoomPath, member: MobileOwnerCredentials? = nil) async throws -> PublicRoomResponse {
        // Internal rooms answer only a verified member. The browser's cookie
        // does this automatically; native URLSession needs to carry the same
        // owner session explicitly, otherwise /room/team looks like a missing
        // room even when the person is signed in.
        try await call(StarlingsRoomRoutes.publicRoom(room.slug), bearer: member)
    }

    /// Invite lookup deliberately distinguishes an unknown/cancelled token
    /// from an upstream outage: 404 is an expired card, other failures fall
    /// back to the opaque room just like the browser.
    func bookingCard(_ room: MobileRoomPath) async -> MobileBookingCard? {
        await bookingProjection(room)?.card
    }

    /// The card plus the invited identity, when the host named one at mint.
    func bookingProjection(_ room: MobileRoomPath) async -> StarlingsMintedBookingProjection? {
        guard let token = room.bookingToken else { return nil }
        do {
            let request = try httpTransport.request(StarlingsRoomRoutes.booking(room: room.slug, token: token), bearer: nil)
            let (data, http) = try await httpTransport.data(for: request)
            if http.statusCode == 404 { return .expired }
            guard (200..<300).contains(http.statusCode) else { return nil }
            return try StarlingsHTTPTransport.decode(StarlingsMintedBookingProjection.self, from: data)
        } catch {
            return nil
        }
    }

    func joinStatus(room: MobileRoomPath, receipt: JoinRequestReceipt) async throws -> JoinStatusResponse {
        try await call(StarlingsRoomRoutes.joinStatus(room: room.slug, requestID: receipt.requestID), bearer: StarlingsBearerToken(receipt.lobbyToken))
    }

    func exchangeAdmission(
        room: MobileRoomPath,
        receipt: JoinRequestReceipt
    ) async throws -> ConnectionDetails {
        try await call(StarlingsRoomRoutes.exchangeAdmission(room: room.slug, requestID: receipt.requestID, lobbyToken: receipt.lobbyToken), bearer: nil)
    }

    func ownerRoom(credentials: MobileOwnerCredentials) async throws -> OwnerRoomConfiguration {
        try await call(StarlingsRoomRoutes.ownerRoom, credentials: credentials).room
    }

    /// Start or resume hosting the owner's own permanent room.
    ///
    /// With no `room`, the Worker picks the slug from `OWNER_ROOM_MAP`. `room`
    /// names another room this owner may host — the internal room, from Team —
    /// and the Worker 404s any slug outside that set. This call cannot create a
    /// room. Repeating it resumes the open meeting rather than starting a
    /// second, which is what makes it safe to call on every reconnect.
    ///
    /// `device` is what keeps this phone from evicting the owner's Mac: LiveKit
    /// drops a duplicate identity, so each device publishes under its own
    /// (`mz+iphone@…`). It authorizes nothing — the room, the lease, and every
    /// host control key on the Google `sub` that this bearer already proves.
    func ownerHostSession(
        credentials: MobileOwnerCredentials,
        device: EnvisioningIdentity.HostDevice,
        room: String? = nil
    ) async throws -> OwnerHostSessionResponse {
        try await call(StarlingsRoomRoutes.hostSession(device: device, room: room), credentials: credentials)
    }

    /// Renew the host lease. The room admits nobody once it lapses, so this is
    /// the one host call that must keep running while the app is in the
    /// background with the meeting live.
    /// Take the host: at once when nobody holds it, or by asking the current
    /// host to hand over. `ifVacant` never takes a live host.
    func claimHost(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String,
        device: EnvisioningIdentity.HostDevice,
        ifVacant: Bool = false
    ) async throws -> HostMutationResponse {
        try await call(StarlingsRoomRoutes.claimHost(room: room, meetingID: meetingID, device: device, ifVacant: ifVacant), credentials: credentials)
    }

    /// Stop hosting, after this phone's transcriber has drained and its text
    /// is uploaded. The answer says who hosts now; `host` means this phone still does.
    func releaseHost(credentials: MobileOwnerCredentials, room: String, meetingID: String) async throws -> HostMutationResponse {
        try await call(StarlingsRoomRoutes.releaseHost(room: room, meetingID: meetingID), credentials: credentials)
    }

    /// Ask one device in the call to host.
    func offerHost(credentials: MobileOwnerCredentials, room: String, meetingID: String, targetIdentity: String) async throws -> HostOfferResponse {
        try await call(StarlingsRoomRoutes.offerHost(room: room, meetingID: meetingID, targetIdentity: targetIdentity), credentials: credentials)
    }

    /// Answer an offer to host, signed in as this member.
    func answerHostOffer(credentials: MobileOwnerCredentials, room: String, meetingID: String, accept: Bool) async throws -> HostOfferAnswerResponse {
        try await call(StarlingsRoomRoutes.answerHostOffer(room: room, meetingID: meetingID, accept: accept), credentials: credentials)
    }

    func hostHeartbeat(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String
    ) async throws -> HostHeartbeatResponse {
        try await call(StarlingsRoomRoutes.hostHeartbeat(room: room, meetingID: meetingID), credentials: credentials)
    }

    /// Who is at the door. Polled while hosting rather than held open on the
    /// lobby socket, which is what the Mac does too — one refresh rule for the
    /// owner queue, two renderers of it.
    func lobby(credentials: MobileOwnerCredentials, room: String) async throws -> LobbySnapshotResponse {
        try await call(StarlingsRoomRoutes.lobby(room: room), credentials: credentials)
    }

    /// Settings › Calendar › Booking hours: the member's hours,
    /// zone and booking rules, the same row the web edits.
    func bookingSettings(credentials: MobileOwnerCredentials) async throws -> BookingSettingsResponse {
        try await call(StarlingsCalendarRoutes.bookingSettings, credentials: credentials)
    }

    func saveBookingSettings(
        credentials: MobileOwnerCredentials,
        update: BookingSettingsUpdate
    ) async throws -> BookingSettingsResponse {
        try await call(StarlingsCalendarRoutes.saveBookingSettings(update), credentials: credentials)
    }

    func updateRoomSettings(
        credentials: MobileOwnerCredentials,
        room: String,
        settings: RoomSettingsUpdate
    ) async throws -> RoomSettings {
        try await call(StarlingsRoomRoutes.updateRoomSettings(room: room, settings), credentials: credentials)
    }

    /// Close the second door of an event session (docs/SESSIONS.md §7):
    /// registration links stop admitting, and those guests knock again.
    func closeSessionDoor(credentials: MobileOwnerCredentials, room: String) async throws -> SessionDoorResponse {
        try await call(StarlingsRoomRoutes.closeSessionDoor(room: room), credentials: credentials)
    }

    /// Admit or decline one knock. The Worker re-checks room ownership and the
    /// host lease before it mints anything, so a stale client cannot admit into
    /// a room it walked away from.
    func decideWaitingGuest(
        credentials: MobileOwnerCredentials,
        room: String,
        requestID: String,
        admit: Bool,
        onBehalfOf: String? = nil
    ) async throws {
        _ = try await call(StarlingsRoomRoutes.decide(room: room, requestID: requestID, admit: admit, onBehalfOf: onBehalfOf), credentials: credentials)
    }

    // MARK: CRM filing and tasks

    /// How this meeting is filed in Core. Envisioning-only: guests never see
    /// it, and it rides on the owner session rather than the artifact token.
    func meetingCategory(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String
    ) async throws -> MeetingCategory {
        try await call(StarlingsRoomRoutes.category(room: room, meetingID: meetingID), credentials: credentials)
    }

    /// The meeting's record as its page reads it, for a share or a
    /// copy. The owner reads it while the meeting runs; anyone else once it is
    /// filed and over, the page's own gate.
    func meetingTranscript(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String
    ) async throws -> TranscriptViewResponse {
        try await call(StarlingsRoomRoutes.transcript(room: room, meetingID: meetingID), credentials: credentials)
    }

    func setMeetingCategory(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String,
        update: MeetingCategoryUpdate
    ) async throws -> MeetingCategory {
        try await call(StarlingsRoomRoutes.setCategory(room: room, meetingID: meetingID, update), credentials: credentials)
    }

    /// Leads or projects matching what the owner typed. The Worker holds the
    /// Core credentials; this client never talks to Core directly.
    func crmSubjects(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        query: String
    ) async throws -> [CrmSubject] {
        try await crmSubjectPage(credentials: credentials, kind: kind, query: query).subjects
    }

    /// The browse list plus whether it is all of them.
    func crmSubjectPage(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        query: String,
        status: String? = nil,
        organizations: OrganizationListFilter? = nil
    ) async throws -> CrmSubjectsResponse {
        try await call(StarlingsWorkRoutes.subjects(kind: kind, query: query, status: status, organizations: organizations), credentials: credentials)
    }

    /// The Work tab's status badges for one kind, in one request, exact.
    /// `query` narrows the same way the visible list does; see docs/WORK.md.
    /// Mirrors `MeetingControlAPI.crmSubjectCounts` on the Mac.
    func crmSubjectCounts(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        query: String
    ) async throws -> CrmSubjectCountsResponse {
        try await call(StarlingsWorkRoutes.subjectCounts(kind: kind, query: query), credentials: credentials)
    }

    /// `snapshotted` keeps the body under `crm/subjects/<kind>/<id>` for a
    /// read-only page to paint first (the partner page). The editor reads
    /// live — its fields are about to be written, and a stale field is a
    /// stale write (docs/CACHING.md §Not yet).
    func crmSubjectDetail(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        snapshotted: Bool = false
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.subjectDetail(kind: kind, id: id, snapshotted: snapshotted), credentials: credentials).subject
    }

    /// The form answers that filed a lead, or nil for a lead a member made
    /// (docs/FORMS.md).
    func leadSubmission(credentials: MobileOwnerCredentials, id: String) async throws -> FormSubmission? {
        try await call(StarlingsWorkRoutes.leadSubmission(id: id), credentials: credentials).submission
    }

    /// A lead's or an organization's offers and licenses; a nil list is a
    /// module the workspace has off.
    func crmSubjectCommercial(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        id: String
    ) async throws -> CrmSubjectCommercialResponse {
        try await call(StarlingsWorkRoutes.subjectCommercial(kind: kind, id: id), credentials: credentials)
    }

    // MARK: Offers: read, duplicate and record. The phone does not edit.

    func offers(credentials: MobileOwnerCredentials) async throws -> [CrmOffer] {
        try await call(StarlingsWorkRoutes.offers(), credentials: credentials).offers
    }

    func licenses(credentials: MobileOwnerCredentials) async throws -> [CrmLicense] {
        try await call(StarlingsWorkRoutes.licenses(), credentials: credentials).licenses
    }

    func readOffer(credentials: MobileOwnerCredentials, id: String) async throws -> OfferResponse {
        try await call(StarlingsWorkRoutes.offer(id: id), credentials: credentials)
    }

    func readOfferVersion(credentials: MobileOwnerCredentials, id: String, version: Int) async throws -> OfferVersionResponse {
        try await call(StarlingsWorkRoutes.offerVersion(id: id, version: version), credentials: credentials)
    }

    func duplicateOffer(credentials: MobileOwnerCredentials, id: String, to target: OfferDuplicate) async throws -> OfferResponse {
        try await call(StarlingsWorkRoutes.duplicateOffer(id: id, to: target), credentials: credentials)
    }

    func recordOfferDecision(credentials: MobileOwnerCredentials, id: String, decision: OfferDecision) async throws -> OfferResponse {
        try await call(StarlingsWorkRoutes.recordOfferDecision(id: id, decision), credentials: credentials)
    }

    /// Organizations matching `query`, from the Worker's owner-scoped Core
    /// search (`GET /api/crm/organizations`), the route the Mac and the web
    /// use. It works before Core is linked on this phone.
    func crmOrganizations(
        credentials: MobileOwnerCredentials,
        matching query: String
    ) async throws -> [SubjectRelationOption] {
        try await call(StarlingsWorkRoutes.organizations(matching: query), credentials: credentials).organizations.map { SubjectRelationOption(id: $0.id, name: $0.name) }
    }

    // MARK: Contacts

    /// Contacts matching `query`, the contacts named by `ids`, an
    /// organization's contacts, or the contacts that hold any of `emails`
    ///, from `GET /api/crm/contacts`, the route the Mac and the
    /// web use. It works without Core linked on this phone.
    func crmContacts(
        credentials: MobileOwnerCredentials,
        matching query: String? = nil,
        ids: [String]? = nil,
        organizationID: String? = nil,
        emails: [String]? = nil
    ) async throws -> [CrmContact] {
        try await call(StarlingsWorkRoutes.contacts(matching: query, ids: ids, organizationID: organizationID, emails: emails), credentials: credentials).contacts
    }

    func crmContact(credentials: MobileOwnerCredentials, id: String) async throws -> CrmContactDetail {
        try await call(StarlingsWorkRoutes.contact(id: id), credentials: credentials).contact
    }

    func createCrmContact(credentials: MobileOwnerCredentials, body: CrmContactCreate) async throws -> CrmContactDetail {
        try await call(StarlingsWorkRoutes.createContact(body), credentials: credentials).contact
    }

    func updateCrmContact(credentials: MobileOwnerCredentials, id: String, body: CrmContactUpdate) async throws -> CrmContactDetail {
        try await call(StarlingsWorkRoutes.updateContact(id: id, body), credentials: credentials).contact
    }

    /// The Contacts group's page: a search and its filters, with the facets.
    func crmContactList(
        credentials: MobileOwnerCredentials,
        query: String,
        filter: ContactListFilter
    ) async throws -> CrmContactsResponse {
        try await call(StarlingsWorkRoutes.contactList(query: query, filter: filter), credentials: credentials)
    }

    /// What the contact editor offers: characteristic names and languages.
    func crmContactOptions(credentials: MobileOwnerCredentials) async throws -> CrmContactOptionsResponse {
        try await call(StarlingsWorkRoutes.contactOptions, credentials: credentials)
    }

    /// Delete a contact. A 409 names the calls and tasks that still reference it.
    func deleteCrmContact(credentials: MobileOwnerCredentials, id: String) async throws {
        _ = try await call(StarlingsWorkRoutes.deleteContact(id: id), credentials: credentials)
    }

    /// Delete a task. 404 when it is gone; 403 without the write right on its subject.
    func deleteCrmTask(credentials: MobileOwnerCredentials, id: String) async throws {
        _ = try await call(StarlingsWorkRoutes.deleteTask(id: id), credentials: credentials)
    }

    /// An organization's Tasks By project.
    func crmOrganizationProjectTasks(
        credentials: MobileOwnerCredentials,
        organizationID: String
    ) async throws -> CrmOrganizationProjectTaskGroups {
        CrmOrganizationProjectTaskGroups(try await call(
            StarlingsWorkRoutes.organizationProjectTasks(id: organizationID), credentials: credentials
        ))
    }

    /// Merge contacts. The answer names the one that stayed.
    func mergeCrmContacts(credentials: MobileOwnerCredentials, ids: [String]) async throws -> CoreMergeResponseData {
        try await call(StarlingsWorkRoutes.mergeContacts(ids: ids), credentials: credentials).data
    }

    /// Creates an organization by name (`POST /api/crm/organizations`): in
    /// Core on a Core workspace, in the workspace's D1 otherwise.
    func crmCreateOrganization(
        credentials: MobileOwnerCredentials,
        named name: String
    ) async throws -> SubjectRelationOption {
        let created = try await call(StarlingsWorkRoutes.createOrganization(named: name), credentials: credentials).organization
        return SubjectRelationOption(id: created.id, name: created.name)
    }

    /// Edit an organization: the fields that changed only.
    func updateCrmOrganization(
        credentials: MobileOwnerCredentials,
        id: String,
        update: CrmOrganizationUpdate
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.updateOrganization(id: id, update), credentials: credentials).subject
    }

    /// Delete an organization. A 409 says which records still point at it.
    func deleteCrmOrganization(credentials: MobileOwnerCredentials, id: String) async throws {
        _ = try await call(StarlingsWorkRoutes.deleteOrganization(id: id), credentials: credentials)
    }

    /// Merge organizations. The answer names the one that stayed.
    func mergeCrmOrganizations(credentials: MobileOwnerCredentials, ids: [String]) async throws -> CoreMergeResponseData {
        try await call(StarlingsWorkRoutes.mergeOrganizations(ids: ids), credentials: credentials).data
    }

    func createCrmSubject(
        credentials: MobileOwnerCredentials,
        draft: CrmSubjectDraft
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.createSubject(draft.create), credentials: credentials).subject
    }

    /// Win an open lead (ADR 0008): the Worker creates the project, moves the
    /// named open tasks, then sets the lead to Closed Won. It writes subjects
    /// and tasks, so both snapshot sets go stale.
    func winLead(
        credentials: MobileOwnerCredentials,
        id: String,
        body: CrmLeadWin
    ) async throws -> CrmLeadWinResponse {
        try await call(StarlingsWorkRoutes.winLead(id: id, body), credentials: credentials)
    }

    /// The workspace's plan, its project limit and the kept project
    ///. Any member reads it; plan changes stay on web Admin.
    func workspacePlan(credentials: MobileOwnerCredentials) async throws -> WorkspacePlanResponse {
        try await call(StarlingsWorkRoutes.workspacePlan, credentials: credentials)
    }

    func updateCrmSubject(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        update: CrmSubjectUpdate
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.updateSubject(kind: kind, id: id, update), credentials: credentials).subject
    }

    /// Choose who answers for a project or lead, or nil to clear the choice
    /// (docs/OWNERSHIP.md). Sends nothing else.
    func setCrmSubjectResponsible(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        email: String?
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.setSubjectResponsible(kind: kind, id: id, email: email), credentials: credentials).subject
    }

    /// Rename without sending the rest of the editable projection. A quick
    /// rename must not clear metadata that Core owns but this client does not
    /// expose in its focused editor.
    func renameCrmSubject(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        title: String
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.renameSubject(kind: kind, id: id, title: title), credentials: credentials).subject
    }

    /// Who work can be assigned to. Core is the roster, not the presence list —
    /// a colleague who has never opened Meet is still assignable work.
    func crmTeam(credentials: MobileOwnerCredentials) async throws -> [CrmTeamMember] {
        try await call(StarlingsWorkRoutes.team, credentials: credentials).members
    }

    /// A project's GitHub issues, through the Worker and Core. Meet never holds
    /// a GitHub credential.
    /// `page` is per repository, which is the honest unit for a list merged
    /// from several of them.
    func crmIssues(
        credentials: MobileOwnerCredentials,
        projectID: String,
        filter: CrmIssueFilter = CrmIssueFilter(),
        page: Int = 1
    ) async throws -> CrmIssuesResponse {
        try await call(StarlingsWorkRoutes.issues(projectID: projectID, filter: filter, page: page), credentials: credentials)
    }

    /// Which repositories a project's work lives in. The primary one is where
    /// a new issue lands, and what its pickers can offer.
    func crmProjectRepos(
        credentials: MobileOwnerCredentials,
        projectID: String
    ) async throws -> [CrmGithubRepo] {
        try await call(StarlingsWorkRoutes.projectRepos(projectID: projectID), credentials: credentials).repos
    }

    /// Repositories the Core GitHub App can link to a project. Meet never
    /// receives a GitHub credential; it only presents Core's approved choices.
    func crmGithubRepos(
        credentials: MobileOwnerCredentials,
        query: String
    ) async throws -> [CrmGithubRepo] {
        try await call(StarlingsWorkRoutes.githubRepos(query: query), credentials: credentials).repos
    }

    func addCrmProjectRepo(
        credentials: MobileOwnerCredentials,
        create: CrmProjectRepoCreate
    ) async throws -> CrmGithubRepo {
        try await call(StarlingsWorkRoutes.addProjectRepo(create), credentials: credentials).repo
    }

    /// Somebody's GitHub picture, through the Worker rather than from the CDN.
    ///
    /// The bytes are public; who asks for them is not. Fetching directly would
    /// tell `avatars.githubusercontent.com` this device's address and, from the
    /// pattern of requests, roughly which issues are being read.
    func githubAvatar(
        credentials: MobileOwnerCredentials,
        url avatar: String,
        size: Int
    ) async throws -> Data {
        let request = try httpTransport.request(StarlingsWorkRoutes.githubAvatar(url: avatar, size: size), bearer: credentials)
        let (data, response) = try await rawData(for: request)
        StarlingsDiagnosticsLog.captureResponseFailure(request: request, response: response, data: data, retryCount: 0, using: httpTransport)
        guard (200..<300).contains(response.statusCode) else {
            throw StarlingsError.invalidResponse(operation: String(localized: "Couldn’t load that picture"))
        }
        return data
    }

    /// What an issue in this repository could be set to. Asked once per
    /// repository and reused, so opening issue after issue costs nothing.
    func crmIssueFacets(
        credentials: MobileOwnerCredentials,
        owner: String,
        repo: String
    ) async throws -> CrmIssueFacets {
        try await call(StarlingsWorkRoutes.issueFacets(owner: owner, repo: repo), credentials: credentials)
    }

    func crmIssue(
        credentials: MobileOwnerCredentials,
        owner: String,
        repo: String,
        number: Int
    ) async throws -> CrmIssueDetail {
        try await call(StarlingsWorkRoutes.issue(owner: owner, repo: repo, number: number), credentials: credentials).issue
    }

    func createCrmIssue(
        credentials: MobileOwnerCredentials,
        _ create: CrmIssueCreate
    ) async throws -> CrmIssue {
        try await call(StarlingsWorkRoutes.createIssue(create), credentials: credentials).issue
    }

    func updateCrmIssue(
        credentials: MobileOwnerCredentials,
        _ update: CrmIssueUpdate
    ) async throws -> CrmIssueDetail {
        try await call(StarlingsWorkRoutes.updateIssue(update), credentials: credentials).issue
    }

    /// Quick Notes are the unfiled capture layer. They stay separate from
    /// Core until the owner chooses a subject and promotes one during triage.
    /// What Home is made of, for this owner — the same list the Mac and the
    /// browser read (`fixtures/home-layout.json`).
    func homeLayout(credentials: MobileOwnerCredentials) async throws -> HomePreferencesResponse {
        try await call(StarlingsSettingsRoutes.homeLayout, credentials: credentials)
    }

    func setHomeLayout(credentials: MobileOwnerCredentials, _ layout: [HomeModuleSetting]) async throws -> HomePreferencesResponse {
        try await call(StarlingsSettingsRoutes.setHomeLayout(layout), credentials: credentials)
    }

    /// This owner's setup steps — the same answer the Mac and the browser
    /// read (docs/ONBOARDING.md).
    func setup(credentials: MobileOwnerCredentials) async throws -> SetupResponse {
        try await call(StarlingsSettingsRoutes.setup, credentials: credentials)
    }

    /// An admin turns the checklist off, or on, for the whole workspace.
    func setSetupChecklist(credentials: MobileOwnerCredentials, on: Bool) async throws -> SetupResponse {
        try await call(StarlingsSettingsRoutes.setSetupChecklist(on: on), credentials: credentials)
    }

    /// Skip: clear one step from this owner's checklist, on every client.
    func skipSetupStep(credentials: MobileOwnerCredentials, _ step: SetupStep) async throws -> SetupResponse {
        try await call(StarlingsSettingsRoutes.skipSetupStep(step), credentials: credentials)
    }

    func commercialSummary(credentials: MobileOwnerCredentials) async throws -> CommercialSummary {
        try await call(StarlingsWorkRoutes.commercialSummary, credentials: credentials)
    }

    /// The language the interface is drawn in, for this owner — the same
    /// choice the Mac and the browser read.
    func language(credentials: MobileOwnerCredentials) async throws -> LanguagePreferenceResponse {
        try await call(StarlingsSettingsRoutes.language, credentials: credentials)
    }

    func setLanguage(credentials: MobileOwnerCredentials, _ language: StarlingsLanguage?) async throws -> LanguagePreferenceResponse {
        try await call(StarlingsSettingsRoutes.setLanguage(language), credentials: credentials)
    }

    func quickNotes(credentials: MobileOwnerCredentials) async throws -> [QuickNote] {
        try await call(StarlingsWorkRoutes.quickNotes, credentials: credentials).notes
    }

    /// The create carries the client's id: a repeat answers the
    /// note the first one made, so the outbox can retry without a duplicate.
    func createQuickNote(credentials: MobileOwnerCredentials, _ create: QuickNoteCreate) async throws -> QuickNote {
        try await call(StarlingsWorkRoutes.createQuickNote(create), credentials: credentials).note
    }

    /// Rewrite the body; the note keeps its place, state and filing.
    func updateQuickNote(credentials: MobileOwnerCredentials, id: String, body: String) async throws -> QuickNote {
        try await call(StarlingsWorkRoutes.updateQuickNote(id: id, body: body), credentials: credentials).note
    }

    // MARK: - Connected agents (docs/MCP.md)

    func mcpGrants(credentials: MobileOwnerCredentials) async throws -> [McpGrant] {
        try await call(StarlingsSettingsRoutes.mcpGrants, credentials: credentials).grants
    }

    func mcpGrantCalls(credentials: MobileOwnerCredentials, id: String) async throws -> [McpCallEntry] {
        try await call(StarlingsSettingsRoutes.mcpGrantCalls(id: id), credentials: credentials).calls
    }

    func revokeMcpGrant(credentials: MobileOwnerCredentials, id: String) async throws -> [McpGrant] {
        try await call(StarlingsSettingsRoutes.revokeMcpGrant(id: id), credentials: credentials).grants
    }

    func setMcpGrantPaused(credentials: MobileOwnerCredentials, id: String, paused: Bool) async throws -> [McpGrant] {
        try await call(StarlingsSettingsRoutes.setMcpGrantPaused(id: id, paused: paused), credentials: credentials).grants
    }

    // MARK: - Devices (docs/ADMIN.md §5a)

    /// The person's signed-in Macs and phones, this one marked.
    func ownerDevices(credentials: MobileOwnerCredentials) async throws -> [OwnerDevice] {
        try await call(StarlingsSettingsRoutes.devices, credentials: credentials).devices
    }

    /// Sign one device out. Its row goes, so its tokens are refused from its
    /// next request. Answers the devices that remain.
    func revokeOwnerDevice(credentials: MobileOwnerCredentials, deviceID: String) async throws -> [OwnerDevice] {
        try await call(StarlingsSettingsRoutes.revokeDevice(deviceID: deviceID), credentials: credentials).devices
    }

    func deleteQuickNote(credentials: MobileOwnerCredentials, id: String) async throws {
        try await perform(StarlingsWorkRoutes.deleteQuickNote(id: id), credentials: credentials)
    }

    /// Record where a note went. The thing it points at already exists; a
    /// retry of the same promotion is a no-op on the Worker.
    func promoteQuickNote(
        credentials: MobileOwnerCredentials,
        id: String,
        _ promote: QuickNotePromote
    ) async throws -> QuickNote {
        try await call(StarlingsWorkRoutes.promoteQuickNote(id: id, promote), credentials: credentials).note
    }

    /// Everything you owe, across every subject.
    func crmMyWork(credentials: MobileOwnerCredentials) async throws -> CrmMyWorkResponse {
        try await call(StarlingsWorkRoutes.mine, credentials: credentials)
    }

    /// Your own task completions and closed GitHub issues from the last week.
    func crmUnownedWork(credentials: MobileOwnerCredentials) async throws -> CrmUnownedWorkResponse {
        try await call(StarlingsWorkRoutes.unowned, credentials: credentials)
    }

    func crmRecentlyClosedWork(credentials: MobileOwnerCredentials) async throws -> CrmRecentlyClosedWorkResponse {
        try await call(StarlingsWorkRoutes.recentlyClosed, credentials: credentials)
    }

    /// What one colleague owes, across every subject.
    ///
    /// The Worker checks that the address is an Envisioning member before it
    /// asks Core. This is the read behind Team's person information surface;
    /// it is company work, not a private credential or a device detail.
    func crmWork(
        credentials: MobileOwnerCredentials,
        assigneeEmail: String
    ) async throws -> CrmMyWorkResponse {
        try await call(StarlingsWorkRoutes.work(assigneeEmail: assigneeEmail), credentials: credentials)
    }

    /// Say who you are on GitHub. Only ever your own record — the Worker takes
    /// the address from the session.
    @discardableResult
    func setCrmGithubLogin(
        credentials: MobileOwnerCredentials,
        login: String?
    ) async throws -> String? {
        try await call(StarlingsWorkRoutes.setGithubLogin(login), credentials: credentials).githubLogin
    }

    /// Put this phone's own hand up or down.
    ///
    /// Authorized with the meeting's artifact token: the server takes the
    /// identity from that token rather than the body, so this can only ever
    /// move the caller's own hand. See `MeetingHands` for why the Worker writes
    /// the attribute and no client does.
    func setOwnHand(
        room: String,
        meetingID: String,
        artifactToken: String,
        raised: Bool
    ) async throws {
        _ = try await call(StarlingsRoomRoutes.setOwnHand(room: room, meetingID: meetingID, raised: raised), bearer: StarlingsBearerToken(artifactToken))
    }

    /// Posts this client's cumulative LiveKit receiver-byte estimate.
    func reportDownstreamUsage(
        room: String,
        meetingID: String,
        artifactToken: String,
        report: DownstreamUsageReport
    ) async throws {
        _ = try await call(StarlingsRoomRoutes.reportDownstreamUsage(room: room, meetingID: meetingID, report), bearer: StarlingsBearerToken(artifactToken))
    }

    /// What a pasted link in the meeting's chat points at.
    ///
    /// Same answer as `linkPreview(credentials:url:)` and the same reason no
    /// client fetches the page itself; different door. This one is authorized
    /// by the meeting rather than by an account, because a guest has no
    /// account — the artifact token asserts exactly one thing, that you are in
    /// this meeting, which is the right thing to ask for here.
    func meetingLinkPreview(
        room: String,
        meetingID: String,
        artifactToken: String,
        url link: String
    ) async throws -> LinkPreview {
        try await call(StarlingsRoomRoutes.linkPreview(room: room, meetingID: meetingID, url: link), bearer: StarlingsBearerToken(artifactToken)).preview
    }

    /// Lower every hand in the room.
    ///
    /// Owner-only, checked server-side the same way muting everyone else is:
    /// clearing the queue is a moderation act, and a guest who could do it
    /// could silence the room's questions without saying anything. Answers how
    /// many were actually up.
    @discardableResult
    func lowerAllHands(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String
    ) async throws -> Int {
        try await call(StarlingsRoomRoutes.lowerAllHands(room: room, meetingID: meetingID), credentials: credentials).lowered
    }

    /// Keep one picture for a GitHub issue and answer where it lives.
    ///
    /// One request rather than the thread attachment's two: there is no row to
    /// reserve, only bytes to keep. What comes back is an address readable
    /// without a session, because github.com renders an issue body for whoever
    /// is looking at it — see `CrmIssueImage`.
    func uploadIssueImage(
        credentials: MobileOwnerCredentials,
        contentType: String,
        data: Data
    ) async throws -> IssueImageAnswer {
        try await call(StarlingsWorkRoutes.uploadIssueImage(contentType: contentType, data: data), credentials: credentials)
    }

    /// What a pasted link points at, read by the Worker rather than by this
    /// phone — see `LinkPreview` for why no client fetches a link itself.
    func linkPreview(
        credentials: MobileOwnerCredentials,
        url link: String
    ) async throws -> LinkPreview {
        try await call(StarlingsThreadRoutes.linkPreview(url: link), credentials: credentials).preview
    }

    func crmTasks(
        credentials: MobileOwnerCredentials,
        projectID: String?,
        leadID: String?,
        eventID: String? = nil,
        organizationID: String? = nil,
        meetingID: String? = nil
    ) async throws -> [CrmTask] {
        try await call(StarlingsWorkRoutes.tasks(
            projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID, meetingID: meetingID
        ), credentials: credentials).tasks
    }

    /// One task's full record by id — responsible party, assignee, notes —
    /// whatever it is filed on (or nothing). Mine's rows are summaries; this is
    /// how the reader and editor get the record they must not guess at.
    func crmTask(credentials: MobileOwnerCredentials, id: String) async throws -> CrmTask {
        CrmTask(wire: try await call(StarlingsWorkRoutes.task(id: id), credentials: credentials).task)
    }

    /// The Sales inbox: CRM touches with no Meet subject yet (docs/WORK.md).
    func crmSalesInbox(credentials: MobileOwnerCredentials, includeDismissed: Bool = false) async throws -> SalesInboxResponse {
        try await call(StarlingsWorkRoutes.salesInbox(includeDismissed: includeDismissed), credentials: credentials)
    }

    /// Dismiss (POST) or undo (DELETE) one touch — same row, same id.
    /// An INBOX item with no other resolution (`booking:*`): dismiss or undo.
    func setInboxItemDismissed(credentials: MobileOwnerCredentials, key: String, dismissed: Bool) async throws {
        try await perform(StarlingsWorkRoutes.setInboxItemDismissed(key: key, dismissed: dismissed), credentials: credentials)
    }

    func setSalesInboxDismissed(credentials: MobileOwnerCredentials, id: String, dismissed: Bool) async throws {
        try await perform(StarlingsWorkRoutes.setSalesInboxDismissed(id: id, dismissed: dismissed), credentials: credentials)
    }

    /// INBOX: what needs you, merged across sources, and the folded RECENT
    /// tail of the subjects you follow. The same list the Mac
    /// rail and Home draw.
    /// The card board (docs/BOARD.md): one project's open tasks and issues
    /// and its recently finished ones, one read.
    func crmBoard(credentials: MobileOwnerCredentials, projectID: String) async throws -> CrmBoardResponse {
        try await call(StarlingsWorkRoutes.board(projectID: projectID), credentials: credentials)
    }

    /// After the call: approve one draft revision; the answer is the mail draft.
    func approveFollowUp(credentials: MobileOwnerCredentials, _ item: InboxFollowUpItem, accept: [String], decline: [String]) async throws -> MeetingFollowUpApproveResponse {
        try await call(StarlingsWorkRoutes.approveFollowUp(item, accept: accept, decline: decline), credentials: credentials)
    }

    /// The host does not want the follow-up; its tasks stay in INBOX.
    func dismissFollowUp(credentials: MobileOwnerCredentials, _ item: InboxFollowUpItem) async throws {
        try await perform(StarlingsWorkRoutes.dismissFollowUp(item), credentials: credentials)
    }

    func attentionRequest(credentials: MobileOwnerCredentials, id: String) async throws -> AttentionRequest {
        try await call(StarlingsWorkRoutes.attentionRequest(id: id), credentials: credentials)
    }

    func resolveAttention(credentials: MobileOwnerCredentials, id: String, command: AttentionResolveInput) async throws -> AttentionResolveResponse {
        try await call(StarlingsWorkRoutes.resolveAttention(id: id, command), credentials: credentials)
    }

    func crmInbox(credentials: MobileOwnerCredentials) async throws -> WorkInboxResponse {
        try await call(StarlingsWorkRoutes.inbox, credentials: credentials)
    }

    /// Star / mute and the SALES opt-in, per person ( decision 5).
    func crmSubjectState(credentials: MobileOwnerCredentials) async throws -> SubjectStateResponse {
        try await call(StarlingsWorkRoutes.subjectState, credentials: credentials)
    }

    /// The things this person starred, as search rows, newest star first —
    /// Home's QUICK ACCESS list. The Worker resolves each one through its owning
    /// service.
    func crmStarred(credentials: MobileOwnerCredentials) async throws -> SearchAnswer {
        SearchAnswer(try await call(StarlingsWorkRoutes.starred, credentials: credentials))
    }

    func crmFavorites(credentials: MobileOwnerCredentials) async throws -> [FavoriteRow] {
        try await call(StarlingsWorkRoutes.favorites, credentials: credentials).favorites
    }

    func crmSetFavorite(credentials: MobileOwnerCredentials, target: FavoriteTarget, starred: Bool) async throws {
        if starred {
            _ = try await call(StarlingsWorkRoutes.addFavorite(target), credentials: credentials)
        } else {
            _ = try await call(StarlingsWorkRoutes.removeFavorite(target), credentials: credentials)
        }
    }

    func crmSetSubjectState(
        credentials: MobileOwnerCredentials,
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        update: SubjectStateUpdate
    ) async throws -> SubjectStateRow? {
        try await call(StarlingsWorkRoutes.setSubjectState(kind: kind, id: id, update), credentials: credentials).state
    }

    func crmSetWorkPreferences(credentials: MobileOwnerCredentials, salesEnabled: Bool) async throws -> SubjectStateResponse {
        try await call(StarlingsWorkRoutes.setWorkPreferences(WorkPreferencesUpdate(salesEnabled: salesEnabled), operation: String(localized: "Couldn’t change Sales")), credentials: credentials)
    }

    /// Which INBOX sources you want, sent whole.
    func crmSetWorkPreferences(credentials: MobileOwnerCredentials, hiddenKinds: [String]) async throws -> SubjectStateResponse {
        try await call(StarlingsWorkRoutes.setWorkPreferences(
            WorkPreferencesUpdate(hiddenKinds: hiddenKinds.map(WorkPreferencesUpdateHiddenKindsItem.init(rawValue:))),
            operation: String(localized: "Couldn’t change Work")
        ), credentials: credentials)
    }

    func crmSetWorkPreferences(credentials: MobileOwnerCredentials, inboxSources: [String: Bool]) async throws -> SubjectStateResponse {
        try await call(StarlingsWorkRoutes.setWorkPreferences(WorkPreferencesUpdate(inboxSources: inboxSources), operation: String(localized: "Couldn’t change Inbox")), credentials: credentials)
    }

    /// The Board columns you hide, sent whole.
    func crmSetWorkPreferences(credentials: MobileOwnerCredentials, boardHiddenStages: Set<WorkStage>) async throws -> SubjectStateResponse {
        try await call(StarlingsWorkRoutes.setWorkPreferences(
            WorkPreferencesUpdate(boardHiddenStages: WorkStage.allCases.filter(boardHiddenStages.contains).map { WorkPreferencesUpdateBoardHiddenStagesItem(rawValue: $0.rawValue) }),
            operation: String(localized: "Couldn’t change the board")
        ), credentials: credentials)
    }

    /// How the SUBJECTS list reads, for every surface at once.
    func crmSetWorkPreferences(credentials: MobileOwnerCredentials, workList: WorkListPreferences) async throws -> SubjectStateResponse {
        try await call(StarlingsWorkRoutes.setWorkPreferences(WorkPreferencesUpdate(workList: workList.wire), operation: String(localized: "Couldn’t change the list")), credentials: credentials)
    }

    /// What happened recently across every open subject — docs/TIMELINE.md
    /// Phase 3. Members only; `partial` names subjects the Worker could not
    /// read rather than failing the list.
     /// Durable CRM interactions filed under one project or lead. The Worker
    /// returns a compact projection; the full Core record stays behind the
    /// owner-authenticated boundary.
    /// Exactly one of the three: a partner's history is everything filed under
    /// its organization (PARTNERS (HQ Docs)).
    func crmInteractions(
        credentials: MobileOwnerCredentials,
        projectID: String?,
        leadID: String?,
        organizationID: String? = nil
    ) async throws -> [CrmInteraction] {
        try await call(StarlingsWorkRoutes.interactions(projectID: projectID, leadID: leadID, organizationID: organizationID), credentials: credentials).interactions
    }

    /// Log a call, meeting or note by hand, as the Mac does.
    func createInteraction(credentials: MobileOwnerCredentials, _ create: CrmInteractionCreate) async throws -> CrmInteraction {
        try await call(StarlingsWorkRoutes.createInteraction(create), credentials: credentials).interaction
    }

    func updateInteraction(credentials: MobileOwnerCredentials, id: String, update: CrmInteractionUpdate) async throws -> CrmInteraction {
        try await call(StarlingsWorkRoutes.updateInteraction(id: id, update), credentials: credentials).interaction
    }

    /// 404 when it is gone; 403 without the write right on its subject.
    func deleteInteraction(credentials: MobileOwnerCredentials, id: String) async throws {
        _ = try await call(StarlingsWorkRoutes.deleteInteraction(id: id), credentials: credentials)
    }

    /// A chunk of live transcript in, proposed commitments out. Stateless on
    /// the Worker side; the phone keeps the suggestions and verifies the quotes.
    func proposeTaskCandidates(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String,
        excerpt: String,
        knownTitles: [String]
    ) async throws -> TaskCandidatesResponse {
        try await call(StarlingsRoomRoutes.proposeTaskCandidates(room: room, meetingID: meetingID, excerpt: excerpt, knownTitles: knownTitles), credentials: credentials)
    }

    /// The one write. A suggestion becomes a CRM row only here, through the
    /// same path a hand-typed task takes — see docs/TASK_SUGGESTIONS.md.
    // Goals and decisions (#262). Read live, like issues.

    func crmGoals(credentials: MobileOwnerCredentials, projectID: String, includeClosed: Bool = false) async throws -> [CrmGoal] {
        try await call(StarlingsWorkRoutes.goals(projectID: projectID, includeClosed: includeClosed), credentials: credentials).goals
    }

    func createCrmGoal(credentials: MobileOwnerCredentials, _ create: CrmGoalCreate) async throws -> CrmGoal {
        try await call(StarlingsWorkRoutes.createGoal(create), credentials: credentials).goal
    }

    func updateCrmGoal(credentials: MobileOwnerCredentials, id: String, update: CrmGoalUpdate) async throws -> CrmGoal {
        try await call(StarlingsWorkRoutes.updateGoal(id: id, update), credentials: credentials).goal
    }

    func crmDecisions(credentials: MobileOwnerCredentials, subjectKind: String, subjectID: String) async throws -> [CrmDecision] {
        try await call(StarlingsWorkRoutes.decisions(subjectKind: subjectKind, subjectID: subjectID), credentials: credentials).decisions
    }

    /// Answer a decision waiting on you (docs/help/howto/answer-a-decision.md).
    /// The same answer again is safe: it only retries the Core record.
    func answerDecisionAsk(credentials: MobileOwnerCredentials, id: String, answer: String, note: String?) async throws -> DecisionAsk {
        try await call(StarlingsWorkRoutes.answerDecisionAsk(id: id, answer: answer, note: note), credentials: credentials).ask
    }

    func createCrmDecision(credentials: MobileOwnerCredentials, _ create: CrmDecisionCreate) async throws -> CrmDecision {
        try await call(StarlingsWorkRoutes.createDecision(create), credentials: credentials).decision
    }

    func createCrmTask(
        credentials: MobileOwnerCredentials,
        _ create: CrmTaskCreate
    ) async throws -> CrmTask {
        try await call(StarlingsWorkRoutes.createTask(create), credentials: credentials).task
    }

    /// One MetricKit payload for `POST /api/diagnostics`. The
    /// body answered (`{ id }`) is not read.
    func sendDiagnosticReport(credentials: MobileOwnerCredentials, _ report: DiagnosticReport) async throws {
        try await perform(StarlingsSettingsRoutes.diagnosticReport(report), credentials: credentials)
    }

    func updateCrmTask(
        credentials: MobileOwnerCredentials,
        id: String,
        update: CrmTaskUpdate
    ) async throws -> CrmTask {
        try await call(StarlingsWorkRoutes.updateTask(id: id, update), credentials: credentials).task
    }

    /// Stop one participant's screen share. The Worker re-checks room ownership
    /// and the host lease before it touches the SFU, so a stale client cannot
    /// moderate a room it walked away from. It stops the share in flight; it
    /// does not revoke the right to share again.
    func stopScreenShare(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String,
        identity: String
    ) async throws {
        _ = try await call(StarlingsRoomRoutes.stopScreenShare(room: room, meetingID: meetingID, identity: identity), credentials: credentials)
    }

    /// The same owner/lease-gated moderation routes as the Mac. Nil identity
    /// mutes everyone else; only the participant can reopen their microphone.
    /// A mute answers how many microphones it closed; a removal answers nil.
    @discardableResult
    func moderateParticipant(credentials: MobileOwnerCredentials, room: String,
                             meetingID: String, identity: String?, remove: Bool = false) async throws -> Int? {
        if remove {
            guard let identity else { return nil }
            _ = try await call(StarlingsRoomRoutes.removeParticipant(room: room, meetingID: meetingID, identity: identity), credentials: credentials)
            return nil
        }
        return try await call(StarlingsRoomRoutes.muteParticipant(room: room, meetingID: meetingID, identity: identity), credentials: credentials).muted
    }

    /// Finalized transcript text, in batches. Never audio, and never a partial
    /// segment: what leaves this device is what the recognizer settled on.
    /// Idempotent by segment UUID, which is what makes the outbox's retry safe.
    func appendTranscript(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String,
        segments: [TranscriptSegment]
    ) async throws {
        guard !segments.isEmpty else { return }
        _ = try await call(StarlingsRoomRoutes.appendTranscript(room: room, meetingID: meetingID, segments: segments), credentials: credentials)
    }

    /// Mark the meeting ended now; `finalizeHostedMeeting` still runs
    /// afterwards for the artifact. On a personal room the SFU closes and
    /// guests are not stranded. On `/room/team` the record ends but the call
    /// stays up for whoever remains unless `everyone`.
    func endHostedMeeting(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String,
        everyone: Bool = false
    ) async throws {
        _ = try await call(StarlingsRoomRoutes.end(room: room, meetingID: meetingID, everyone: everyone), credentials: credentials)
    }

    /// Hand the meeting to the artifact queue. Separate from `end` on purpose:
    /// media teardown must not wait on it, and it must still run if it does not.
    func finalizeHostedMeeting(
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String
    ) async throws {
        _ = try await call(StarlingsRoomRoutes.finalize(room: room, meetingID: meetingID), credentials: credentials)
    }

    /// Who else at Envisioning is around. Member-gated at the Worker; there is
    /// no unauthenticated form of this call and there must never be one.
    ///
    /// Snapshotted for the roster's *identity* only: a cold start paints who
    /// is on the team through `PeerRoster.withoutPresence`, never who is
    /// around (docs/CACHING.md §Never cached).
    func peers(credentials: MobileOwnerCredentials) async throws -> PeerRoster {
        try await call(StarlingsPeerRoutes.peers, credentials: credentials)
    }

    /// One colleague's profile picture, member-gated exactly like the roster
    /// it is drawn beside. `version` is that person's `avatarUpdatedAt`, so a
    /// request either means the same bytes forever or is a different request —
    /// which is what makes `returnCacheDataElseLoad` safe here.
    func personAvatar(
        credentials: MobileOwnerCredentials,
        email: String,
        version: Date
    ) async throws -> Data {
        let request = try httpTransport.request(StarlingsPeerRoutes.avatar(email: email, version: version), bearer: credentials)
        let (data, response) = try await rawData(for: request)
        StarlingsDiagnosticsLog.captureResponseFailure(request: request, response: response, data: data, retryCount: 0, using: httpTransport)
        guard (200..<300).contains(response.statusCode) else {
            // A 404 is the ordinary answer for somebody without a picture.
            throw StarlingsError.local(String(localized: "Couldn’t load that picture."))
        }
        return data
    }

    /// Your own picture, and only ever your own — the route takes no address.
    /// The bytes are already a square JPEG (`MobileProfilePicture`), because
    /// the Worker stores what it is given.
    func uploadProfileAvatar(
        credentials: MobileOwnerCredentials,
        data: Data
    ) async throws -> Date? {
        try await call(StarlingsSettingsRoutes.uploadAvatar(data), credentials: credentials).updatedDate
    }

    func removeProfileAvatar(credentials: MobileOwnerCredentials) async throws {
        _ = try await call(StarlingsSettingsRoutes.removeAvatar, credentials: credentials)
    }

    /// Ring a colleague. No push and no APNs: this writes one row that
    /// their next roster poll reads, and it expires on its own. It reaches a
    /// client that is running and in front of them, and nothing else — never
    /// present it as proof that somebody was reached.
    func ring(credentials: MobileOwnerCredentials, peerEmail: String) async throws {
        _ = try await call(StarlingsPeerRoutes.ring(peerEmail: peerEmail), credentials: credentials)
    }

    func callPeer(credentials: MobileOwnerCredentials, peerEmail: String) async throws {
        _ = try await call(StarlingsPeerRoutes.call(peerEmail: peerEmail), credentials: credentials)
    }

    /// Answered, dismissed, or simply seen — either way it stops being pending.
    func clearRing(credentials: MobileOwnerCredentials) async throws {
        _ = try await call(StarlingsPeerRoutes.clearRing, credentials: credentials)
    }

    /// Unavailable (`dnd_until` at the Worker). `until` is absolute; nil turns
    /// it off. There is no open-ended form — an unavailable nobody clears is a
    /// person who has quietly left the team.
    func setDoNotDisturb(credentials: MobileOwnerCredentials, until: Date?) async throws {
        _ = try await call(StarlingsPeerRoutes.doNotDisturb(until: until), credentials: credentials)
    }

    /// What you say about yourself beside what your devices prove. `until` is
    /// required on focused and refused on anything else.
    func setIntent(credentials: MobileOwnerCredentials, intent: PeerIntent?, until: Date?) async throws {
        _ = try await call(StarlingsPeerRoutes.intent(intent, until: until), credentials: credentials)
    }

    /// Appear offline, or stop. Sticky at the Worker.
    func setAppearOffline(credentials: MobileOwnerCredentials, invisible: Bool) async throws {
        _ = try await call(StarlingsPeerRoutes.appearOffline(invisible), credentials: credentials)
    }

    /// "This phone has Starlings open." Best-effort by design — a missed beat costs
    /// one status, so the caller swallows the error rather than alerting.
    func heartbeat(credentials: MobileOwnerCredentials) async throws {
        _ = try await call(StarlingsPeerRoutes.heartbeat(client: .ios), credentials: credentials)
    }

    // MARK: Direct messages

    /// One search: every hit the Worker can see, in the contract's
    /// order. `timeZone` is this device's, for the clock on an event row.
    func search(query: String, timeZone: String, credentials: MobileOwnerCredentials) async throws -> SearchAnswer {
        SearchAnswer(try await call(StarlingsWorkRoutes.search(query: query, timeZone: timeZone), credentials: credentials))
    }

    func threads(credentials: MobileOwnerCredentials) async throws -> [ThreadSummary] {
        try await call(StarlingsThreadRoutes.threads, credentials: credentials).threads
    }

    /// Find-or-create the DM with one peer. Idempotent at the Worker — the id
    /// is derived from both subjects, so asking twice is the same conversation.
    func openThread(
        credentials: MobileOwnerCredentials,
        peerEmail: String
    ) async throws -> ThreadSummary {
        try await call(StarlingsThreadRoutes.open(peerEmail: peerEmail), credentials: credentials).thread
    }

    /// Find-or-create the private conversation with these people.
    ///
    /// Idempotent the same way and for the same reason: the id is derived from
    /// the members, so naming the same people twice is one conversation. Two
    /// addresses derive exactly what one address derives, which is why a group
    /// is not a different kind of thing.
    func openThread(
        credentials: MobileOwnerCredentials,
        peerEmails: [String]
    ) async throws -> ThreadSummary {
        try await call(StarlingsThreadRoutes.open(peerEmails: peerEmails), credentials: credentials).thread
    }

    /// Find-or-create a channel. Idempotent at the Worker in the same way a DM
    /// is: the id is fixed, so the first person to ask is the one who creates it.
    func openChannelThread(credentials: MobileOwnerCredentials) async throws -> ThreadSummary {
        try await call(StarlingsThreadRoutes.openChannel, credentials: credentials).thread
    }

    /// Find-or-create the channel on one CRM subject. Core decides whether the
    /// subject exists and what it is called; this sends an id and nothing else.
    func openSubjectThread(
        credentials: MobileOwnerCredentials,
        kind: String,
        subjectID: String
    ) async throws -> ThreadSummary {
        try await call(StarlingsThreadRoutes.openSubject(kind: kind, subjectID: subjectID), credentials: credentials).thread
    }

    /// Open whatever the screen is showing. The one place that turns an address
    /// into a request body, so a channel is a case here rather than a branch in
    /// every conversation surface.
    func openThread(
        credentials: MobileOwnerCredentials,
        address: ThreadAddress
    ) async throws -> ThreadSummary {
        switch address.target {
        case let .peer(email): try await openThread(credentials: credentials, peerEmail: email)
        case let .group(emails): try await openThread(credentials: credentials, peerEmails: emails)
        case .team: try await openChannelThread(credentials: credentials)
        case let .subject(kind, id):
            try await openSubjectThread(credentials: credentials, kind: kind.rawValue, subjectID: id)
        case let .thread(id):
            try await messages(credentials: credentials, threadID: id, limit: 1).thread
        }
    }

    func messages(
        credentials: MobileOwnerCredentials,
        threadID: String,
        before: String? = nil,
        limit: Int? = nil
    ) async throws -> ThreadMessagesPage {
        try await call(StarlingsThreadRoutes.messages(threadID: threadID, before: before, limit: limit), credentials: credentials)
    }

    /// What was said about one task or issue, across the threads the member
    /// can read, oldest first.
    func cardLines(credentials: MobileOwnerCredentials, kind: String, id: String) async throws -> [ThreadMessage] {
        try await call(StarlingsThreadRoutes.cardLines(kind: kind, id: id), credentials: credentials).lines.map(ThreadMessage.init(wire:))
    }

    func sendMessage(
        credentials: MobileOwnerCredentials,
        threadID: String,
        text: String,
        refs: [ThreadMessageRef] = [],
        mentions: [String] = [],
        attachments: [String] = [],
        replyToMessageID: String? = nil,
        handoff: ThreadHandoff? = nil
    ) async throws -> ThreadMessage {
        try await call(StarlingsThreadRoutes.send(
            threadID: threadID, text: text, refs: refs, mentions: mentions, attachments: attachments,
            replyToMessageID: replyToMessageID, handoff: handoff
        ), credentials: credentials).message
    }

    func answerQuestion(
        credentials: MobileOwnerCredentials,
        threadID: String,
        messageID: String,
        optionIDs: [String]
    ) async throws -> (message: ThreadMessage, accepted: Bool) {
        let response = try await call(StarlingsThreadRoutes.answerQuestion(threadID: threadID, messageID: messageID, optionIDs: optionIDs), credentials: credentials)
        return (ThreadMessage(wire: response.message), response.accepted)
    }

    /// Record on an agent's Keep release card what this device did in Keep
    ///. Keep acted first.
    func updateRelease(
        credentials: MobileOwnerCredentials,
        threadID: String,
        messageID: String,
        _ update: ThreadReleaseUpdateRequest
    ) async throws -> ThreadMessage {
        ThreadMessage(wire: try await call(StarlingsThreadRoutes.updateRelease(threadID: threadID, messageID: messageID, update), credentials: credentials).message)
    }

    /// Add or remove one emoji — the same call either way, because the surface
    /// is one pill you press and two routes would only be two ways to disagree
    /// about whether it is lit.
    @discardableResult
    func react(
        credentials: MobileOwnerCredentials,
        threadID: String,
        messageID: String,
        emoji: String
    ) async throws -> [ThreadMessageReaction] {
        try await call(StarlingsThreadRoutes.react(threadID: threadID, messageID: messageID, emoji: emoji), credentials: credentials).reactions
    }

    /// Rewrite your own message. The Worker refuses somebody else's with the
    /// same 404 a missing one gets, and one past the window with
    /// `message_not_editable` — "too late" rather than "gone".
    func editMessage(
        credentials: MobileOwnerCredentials,
        threadID: String,
        messageID: String,
        text: String
    ) async throws {
        _ = try await call(StarlingsThreadRoutes.edit(threadID: threadID, messageID: messageID, text: text), credentials: credentials)
    }

    /// Withdraw your own message. The row keeps its place; the text and any
    /// files on it are gone.
    func withdrawMessage(
        credentials: MobileOwnerCredentials,
        threadID: String,
        messageID: String
    ) async throws {
        _ = try await call(StarlingsThreadRoutes.withdraw(threadID: threadID, messageID: messageID), credentials: credentials)
    }

    /// Silence one conversation, or let it speak again. Per member: a channel
    /// you have heard enough of is still the channel everybody else works in.
    func muteThread(
        credentials: MobileOwnerCredentials,
        threadID: String,
        until: Date?
    ) async throws {
        _ = try await call(StarlingsThreadRoutes.mute(threadID: threadID, until: until), credentials: credentials)
    }

    /// Put a conversation away, or take it back out. Per-member: the other
    /// person's list is untouched, and anything said from now on brings the
    /// row back without anybody unarchiving it.
    func archiveThread(
        credentials: MobileOwnerCredentials,
        threadID: String,
        archived: Bool
    ) async throws {
        _ = try await call(StarlingsThreadRoutes.archive(threadID: threadID, archived: archived), credentials: credentials)
    }

    /// Reserve somewhere to put one file, then put it there. Two steps because
    /// the writes are different animals: the metadata is small and
    /// transactional, the bytes can be twenty-five megabytes and fail halfway.
    func uploadAttachment(
        credentials: MobileOwnerCredentials,
        threadID: String,
        name: String,
        contentType: String,
        data: Data,
        pixelSize: CGSize?
    ) async throws -> ThreadMessageAttachment {
        let staged = try await call(StarlingsThreadRoutes.stageAttachment(
            threadID: threadID, name: name, contentType: contentType, bytes: data.count, pixelSize: pixelSize
        ), credentials: credentials)
        _ = try await call(StarlingsThreadRoutes.uploadAttachment(uploadPath: staged.uploadPath, contentType: contentType, data: data), credentials: credentials)
        return staged.attachment
    }

    /// The bytes of one attachment. Authenticated like every other read here —
    /// an object key is never a link somebody can pass on.
    func attachmentData(
        credentials: MobileOwnerCredentials,
        threadID: String,
        attachmentID: String
    ) async throws -> Data {
        let request = try httpTransport.request(StarlingsThreadRoutes.attachment(threadID: threadID, attachmentID: attachmentID), bearer: credentials)
        let (data, response) = try await rawData(for: request)
        StarlingsDiagnosticsLog.captureResponseFailure(request: request, response: response, data: data, retryCount: 0, using: httpTransport)
        guard (200..<300).contains(response.statusCode) else {
            throw StarlingsError(
                code: "thread.attachment_unreadable",
                title: String(localized: "Couldn’t open that file"),
                message: String(localized: "The file couldn’t be read. It may have been withdrawn with its message."),
                recovery: .none
            )
        }
        return data
    }

    /// Best-effort: a missed read receipt costs one unread dot.
    /// Close a comment thread on a document (`PATCH /api/docs/annotations/:id`,
    ///). The thread leaves INBOX with it.
    func resolveComment(credentials: MobileOwnerCredentials, threadID: String) async throws {
        try await perform(StarlingsDocsRoutes.resolveComment(threadID: threadID), credentials: credentials)
    }

    func markThreadRead(credentials: MobileOwnerCredentials, threadID: String) async throws {
        _ = try await call(StarlingsThreadRoutes.markRead(threadID: threadID), credentials: credentials)
    }

    func calendarStatus(credentials: MobileOwnerCredentials) async throws -> CalendarStatus {
        try await call(StarlingsCalendarRoutes.status, credentials: credentials)
    }

    func connectCalendar(
        credentials: MobileOwnerCredentials,
        code: String,
        verifier: String,
        redirectURI: String,
        nonce: String
    ) async throws -> CalendarStatus {
        try await call(StarlingsCalendarRoutes.connect(CalendarConnectExchangeRequest(
            code: code, codeVerifier: verifier, redirectURI: redirectURI, nonce: nonce
        )), credentials: credentials)
    }

    func connectAdditionalCalendar(
        credentials: MobileOwnerCredentials,
        code: String,
        verifier: String,
        redirectURI: String,
        nonce: String
    ) async throws -> CalendarAccount {
        try await call(StarlingsCalendarRoutes.connectAccount(CalendarConnectExchangeRequest(
            code: code, codeVerifier: verifier, redirectURI: redirectURI, nonce: nonce
        )), credentials: credentials).account
    }

    func upcoming(credentials: MobileOwnerCredentials, hours: Int = MeetingFocus.requestHours) async throws -> [MobileCalendarEvent] {
        try await call(StarlingsCalendarRoutes.upcoming(hours: hours), credentials: credentials).summaries
    }

    func createEvent(
        draft: MobileScheduleDraft,
        room: OwnerRoomConfiguration,
        credentials: MobileOwnerCredentials
    ) async throws -> MobileCalendarEvent {
        let body = CalendarEventCreateRequest(
            title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
            start: ISODate.format(draft.start),
            end: ISODate.format(draft.end),
            joinURL: MeetingInvite.absoluteURL(slug: room.slug),
            roomSlug: room.slug,
            attendees: draft.attendees,
            timeZone: draft.timeZone.identifier
        )
        return try await call(StarlingsCalendarRoutes.createEvent(body), credentials: credentials).summary
    }

    func exchangeOwnerCode(
        code: String,
        verifier: String,
        redirectURI: String,
        nonce: String,
        deviceID: String,
        deviceName: String
    ) async throws -> MobileOwnerCredentials {
        MobileOwnerCredentials(wire: try await call(StarlingsSettingsRoutes.exchangeOwnerCode(NativeExchangeRequest(
            code: code, codeVerifier: verifier, redirectURI: redirectURI, nonce: nonce,
            client: .ios, deviceID: deviceID, deviceName: deviceName
        )), bearer: nil))
    }

    /// Redeem a workspace sign-in's single-use code (slice D).
    func redeemNativeSignIn(_ body: NativeSignInRedeemRequest) async throws -> MobileOwnerCredentials {
        MobileOwnerCredentials(wire: try await call(StarlingsSettingsRoutes.redeemSignIn(body), bearer: nil))
    }

    /// Trade the refresh token for a fresh pair. The Worker re-checks the
    /// domain and the revocation column, so this can fail permanently — that is
    /// the case where signing in again is genuinely required.
    func refreshSession(
        refreshToken: String,
        deviceID: String,
        deviceName: String,
        client: NativeClient = .ios
    ) async throws -> MobileOwnerCredentials {
        // `deviceName` on every renewal, so a row from before the field is
        // named the first time this build renews.
        MobileOwnerCredentials(wire: try await call(StarlingsSettingsRoutes.refresh(SessionRefreshRequest(
            refreshToken: refreshToken, client: client, deviceID: deviceID, deviceName: deviceName
        )), bearer: nil))
    }

    /// A Core personal access token for the signed-in owner, brokered by the
    /// Worker (`POST /api/core/token`). The token is what lets this device read
    /// Core's registry directly — everything in Core, not only the projects and
    /// leads the Worker projects. Keychain only; it is never logged.
    func coreToken(credentials: MobileOwnerCredentials, deviceName: String) async throws -> CoreToken {
        try await call(StarlingsWorkRoutes.coreToken(deviceName: deviceName), credentials: credentials)
    }

    /// Save a URL as a Docs link. Meet's Worker reads the page with
    /// the same guarded reader used for chat previews, then files the metadata
    /// and cover in Docs. Docs never fetches arbitrary URLs itself.
    ///
    /// `pageHTML` is the page as Safari drew it (the share extension): the
    /// Worker reads the article from it instead of fetching, and a page behind
    /// a sign-in or a subscription saves whole. `note` goes above the article.
    func saveDocsLink(
        url: URL,
        folderPath: String?,
        subjects: [DocsSubject],
        title: String? = nil,
        note: String = "",
        pageHTML: String? = nil,
        credentials: MobileOwnerCredentials
    ) async throws -> DocsDocumentDetail {
        let route = StarlingsDocsRoutes.saveLink(DocsCreateDocumentRequest(
            title: title,
            url: url.absoluteString,
            pageHtml: pageHTML,
            bodyMd: note.isEmpty ? nil : note,
            folderPath: folderPath,
            subjects: StarlingsDocsRoutes.subjects(subjects),
            message: String(localized: "Saved from Starlings")
        ))
        let data = try await sendRaw(request: try httpTransport.request(route, bearer: credentials), operation: route.operation)
        struct Envelope: Decodable { let document: DocsDocumentDetail }
        do {
            return try DocsCoding.decoder.decode(Envelope.self, from: data).document
        } catch {
            throw StarlingsError.local(String(localized: "Couldn’t read the saved link."))
        }
    }

    /// A Keep device token for the signed-in owner, brokered the same way.
    func keepToken(credentials: MobileOwnerCredentials, deviceName: String) async throws -> KeepToken {
        try await call(StarlingsDocsRoutes.keepToken(deviceName: deviceName), credentials: credentials)
    }

    /// Sends a shared route (`StarlingsRoute`) as this owner: through the
    /// snapshot when the policy table says the phone keeps the route's,
    /// otherwise live, marking what a write made stale.
    private func call<Answer: Decodable>(_ route: StarlingsRoute<Answer>, credentials: MobileOwnerCredentials) async throws -> Answer {
        let request = try httpTransport.request(route, bearer: credentials)
        if let key = route.snapshotKey, StarlingsRequestPolicy.keeps(key, client: .ios) {
            return try await sendSnapshotting(
                request: request, as: Answer.self, operation: route.operation,
                key: key, owner: credentials.owner.email
            )
        }
        return try await send(
            request: request, as: Answer.self, operation: route.operation,
            stale: StarlingsStaleSnapshots(owner: credentials.owner.email, writes: route.writes)
        )
    }

    /// A shared route sent with another bearer than the owner session: a
    /// member's session on a knock, a lobby token, a meeting's artifact
    /// token, or none for a guest.
    private func call<Answer: Decodable>(_ route: StarlingsRoute<Answer>, bearer: (any StarlingsBearerSource)?) async throws -> Answer {
        let request = try httpTransport.request(route, bearer: bearer)
        return try await send(request: request, as: Answer.self, operation: route.operation)
    }

    /// Sends a shared route whose answer this client does not read.
    private func perform<Answer>(_ route: StarlingsRoute<Answer>, credentials: MobileOwnerCredentials) async throws {
        let request = try httpTransport.request(route, bearer: credentials)
        _ = try await sendRaw(
            request: request, operation: route.operation,
            stale: StarlingsStaleSnapshots(owner: credentials.owner.email, writes: route.writes)
        )
    }




    private func send<Response: Decodable>(
        request: URLRequest,
        as type: Response.Type,
        operation: String,
        stale: StarlingsStaleSnapshots? = nil
    ) async throws -> Response {
        let data = try await sendRaw(request: request, operation: operation, stale: stale)
        do {
            return try decode(type, from: data, operation: operation)
        } catch {
            StarlingsDiagnosticsLog.captureDecodeFailure(request: request, using: httpTransport)
            throw error
        }
    }

    private func decode<Response: Decodable>(_ type: Response.Type, from data: Data, operation: String) throws -> Response {
        do {
            return try StarlingsHTTPTransport.decode(type, from: data)
        } catch {
            throw StarlingsError.local(String(localized: "\(operation). The response couldn’t be read."))
        }
    }

    /// The transport half of `send`: status checked, body returned undecoded.
    private func sendRaw(request: URLRequest, operation: String, stale: StarlingsStaleSnapshots? = nil) async throws -> Data {
        try await sendRawWithResponse(request: request, operation: operation, stale: stale).data
    }

    /// The bytes and the status, for a caller that says its own failure.
    /// A URLSession failure is thrown as URLSession threw it.
    private func rawData(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await httpTransport.data(for: request)
        } catch StarlingsHTTPFailure.transport(let error) {
            throw error
        } catch {
            throw URLError(.badServerResponse)
        }
    }

    /// `sendRaw`, keeping the response: `sendSnapshotting` reads the status
    /// (a 304 is not a failure there) and the ETag off it. A refused owner
    /// session is renewed and the request sent once more by the transport
    /// (`StarlingsHTTPTransport.ownerData`).
    private func sendRawWithResponse(
        request: URLRequest,
        operation: String,
        stale: StarlingsStaleSnapshots? = nil
    ) async throws -> (data: Data, http: HTTPURLResponse) {
        let data: Data
        let http: HTTPURLResponse
        do {
            (data, http) = try await httpTransport.ownerData(for: request)
        } catch StarlingsHTTPFailure.notHTTP {
            throw StarlingsError.local(String(localized: "\(operation). The service returned an invalid response."))
        } catch {
            // The person reads "check your connection"; the log and Copy keep
            // what URLSession actually said. The path and the
            // error only: never the body or the token.
            var underlying: any Error = error
            if let failure = error as? StarlingsHTTPFailure, case .transport(let cause) = failure { underlying = cause }
            let unreachable = StarlingsError.unreachable(underlying, operation: operation)
            if unreachable.severity != .silent {
                StarlingsDiagnosticsLog.shared.record(unreachable, context: "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")")
            }
            throw unreachable
        }
        if http.statusCode == 304, request.value(forHTTPHeaderField: "If-None-Match") != nil {
            return (data, http)
        }
        do {
            try httpTransport.accept(http, data: data, stale: stale)
        } catch StarlingsHTTPFailure.status(let status, let code, let message, let requestID) {
            throw StarlingsError.refusal(
                status: status, serverCode: code, serverMessage: message, requestID: requestID, operation: operation
            )
        }
        return (data, http)
    }

    /// Posted from whatever thread the request finished on, whenever the Worker
    /// answers `owner_auth_required` to a bearer request and renewing did not
    /// produce a token to retry with, or the retry was refused too.
    static let ownerSessionRejectedNotification = Notification.Name("MeetOwnerSessionRejected")

    // MARK: - Snapshots (docs/CACHING.md)

    static let mineSnapshotKey = StarlingsSnapshotKey.mine
    static let inboxSnapshotKey = StarlingsSnapshotKey.inbox
    static let quickNotesSnapshotKey = StarlingsSnapshotKey.quickNotes
    static let threadsSnapshotKey = StarlingsSnapshotKey.threads
    static let peersSnapshotKey = StarlingsSnapshotKey.peers
    /// Home's other rows: the room card, COMMERCIAL and STARRED. Each paints on a cold start from the last answer,
    /// the way the lists above do. The module order has its own local copy,
    /// `HomeLayoutCache`.
    static let roomSnapshotKey = StarlingsSnapshotKey.ownerRoom
    static let commercialSnapshotKey = StarlingsSnapshotKey.commercialSummary
    static let favoritesSnapshotKey = StarlingsSnapshotKey.favorites
    static let starredSnapshotKey = StarlingsSnapshotKey.starred
    /// Every filtered subjects page invalidates together: a rename or a status
    /// change moves a row between pages, and there is no telling which.
    static let subjectsSnapshotPrefix = StarlingsSnapshotKey.subjects
    /// One subject's task list and history, per subject. A task write
    /// invalidates every `crm/tasks` page: a task can move between subjects.
    static let tasksSnapshotPrefix = StarlingsSnapshotKey.tasks
    static let interactionsSnapshotPrefix = StarlingsSnapshotKey.interactions
    /// A project's GitHub issues, per exact filter and page. An issue filed or
    /// updated from here invalidates every page: the write can land on any.
    static let issuesSnapshotPrefix = StarlingsSnapshotKey.issues

    static func issuesSnapshotKey(projectID: String, filter: CrmIssueFilter, page: Int) -> String {
        StarlingsSnapshotKey.issuesKey(projectID: projectID, filter: filter, page: page)
    }

    /// One subject's detail, for the read-only pages. Under `crm/subjects`
    /// on purpose: a subject write invalidates the lists and this with them.
    static func subjectDetailSnapshotKey(kind: MeetingCategoryKind.SubjectKind, id: String) -> String {
        StarlingsSnapshotKey.subjectDetailKey(kind: kind, id: id)
    }

    static func tasksSnapshotKey(projectID: String?, leadID: String?, eventID: String? = nil, organizationID: String? = nil) -> String {
        StarlingsSnapshotKey.tasksKey(projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID)
    }

    static func interactionsSnapshotKey(projectID: String?, leadID: String?, organizationID: String? = nil) -> String {
        StarlingsSnapshotKey.interactionsKey(projectID: projectID, leadID: leadID, organizationID: organizationID)
    }

    /// The interactions query for a subject of any kind — partners read by
    /// their organization, which is the subject id.
    static func interactionsQuery(for subject: CrmSubject) -> (projectID: String?, leadID: String?, organizationID: String?) {
        switch subject.subjectKind {
        case .project: (subject.id, nil, nil)
        case .lead: (nil, subject.id, nil)
        case .organization: (nil, nil, subject.id)
        // Core files meetings under projects, leads and organizations; an
        // event has no history yet (docs/EVENTS.md slice 3).
        case .event: (nil, nil, nil)
        }
    }

    /// The badges follow the pages: a subject write invalidates both.
    static let subjectCountsSnapshotPrefix = StarlingsSnapshotKey.subjectCounts

    static func subjectCountsSnapshotKey(kind: MeetingCategoryKind.SubjectKind, query: String) -> String {
        StarlingsSnapshotKey.subjectCountsKey(kind: kind, query: query)
    }

    static func subjectsSnapshotKey(kind: MeetingCategoryKind.SubjectKind, query: String, status: String?) -> String {
        StarlingsSnapshotKey.subjectsKey(kind: kind, query: query, status: status)
    }

    /// The last good copy of a list read, decoded, or nil when none is usable.
    /// Callers paint this first and refresh behind it.
    func snapshot<T: Decodable>(_ key: String, credentials: MobileOwnerCredentials, as type: T.Type) -> (value: T, savedAt: Date)? {
        guard let snapshot = SnapshotStore.load(key: key, owner: credentials.owner.email),
              let value = try? JSONDecoder().decode(T.self, from: snapshot.data)
        else { return nil }
        return (value, snapshot.savedAt)
    }


    /// `send`, plus: the raw body becomes the snapshot for `key`, and two
    /// concurrent reads of the same key share one request. The mechanics are
    /// `StarlingsHTTPTransport.readSnapshotting`, the same on the Mac; this side
    /// supplies the send, with its session renewal and its error words.
    private func sendSnapshotting<Response: Decodable>(
        request: URLRequest,
        as type: Response.Type,
        operation: String,
        key: String,
        owner: String
    ) async throws -> Response {
        try await StarlingsHTTPTransport.readSnapshotting(
            request: request,
            key: key,
            owner: owner,
            fetch: { [self] request in
                try await sendRawWithResponse(request: request, operation: operation)
            },
            decode: { data in
                do {
                    return try decode(type, from: data, operation: operation)
                } catch {
                    StarlingsDiagnosticsLog.captureDecodeFailure(request: request, using: httpTransport)
                    throw error
                }
            }
        )
    }
}

extension MobileOwnerCredentials: StarlingsBearerSource {
    var isMeetOwnerSession: Bool { true }

    func meetBearerToken() -> String? { accessToken }
}

extension GuestClient {
    /// So the host's waiting room can say "iPhone app" rather than assuming
    /// browser.
    ///
    /// Hardware family from `uname`, not `UIDevice.userInterfaceIdiom`: the
    /// join request is built off the main actor, and this is worth neither a
    /// hop nor a stored copy threaded through `StarlingsAPI`. Anything unrecognised
    /// (the Simulator reports its host architecture) reads as a phone, which is
    /// the right guess for an iOS build and only ever costs the host a glyph.
    static var thisDevice: GuestClient {
        var info = utsname()
        uname(&info)
        // Size read before the pointer is taken: reading `info.machine` inside
        // the closure is a second access to storage already borrowed
        // exclusively, which Swift 6 rejects.
        let capacity = MemoryLayout.size(ofValue: info.machine)
        let machine = withUnsafePointer(to: &info.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) {
                String(cString: $0)
            }
        }
        return GuestClient(app: .ios, device: machine.hasPrefix("iPad") ? .tablet : .mobile)
    }
}

/// The one place a request can ask for a fresh owner access token.
///
/// `StarlingsAPI` is a value built per call site and knows nothing about the app
/// model that owns the session; the model installs a handler here at start.
/// The handler renews (coalesced with every other renewal in flight) and
/// answers with the access token now in the Keychain, or nil when the Worker
/// refused, there was nothing to renew, or the Worker could not be asked.
actor MobileOwnerSessionRenewal {
    static let shared = MobileOwnerSessionRenewal()

    private var handler: (@Sendable () async -> String?)?

    func install(_ handler: @escaping @Sendable () async -> String?) {
        self.handler = handler
    }

    /// A token to retry with, or nil. Never the token that was just refused:
    /// a renewal that did not move the Keychain is no reason to send the
    /// same request twice.
    func renewedAccessToken(replacing stale: String) async -> String? {
        guard let handler, let fresh = await handler(), fresh != stale else { return nil }
        return fresh
    }
}
