import AppKit
import DocsKit
import Foundation
import StarlingsContracts

struct MeetingContext: Equatable, Sendable {
    let room: RoomSlug
    let meetingID: String
    let artifactToken: String
    let role: MeetingRole
    let startedAt: Date?
    let ownerIdentity: String?
    let hostIdentity: String?

    init(
        room: RoomSlug,
        meetingID: String,
        artifactToken: String,
        role: MeetingRole = .host,
        startedAt: Date? = nil,
        ownerIdentity: String? = nil,
        hostIdentity: String? = nil
    ) {
        self.room = room
        self.meetingID = meetingID
        self.artifactToken = artifactToken
        self.role = role
        self.startedAt = startedAt
        self.ownerIdentity = ownerIdentity
        self.hostIdentity = hostIdentity
    }
}

enum PublicBookingLookup: Equatable, Sendable {
    case scheduled(StarlingsMintedBookingProjection)
    case expired
}

// The lobby's rows, the open meeting, the owner's room and the guest's
// receipt are generated wire types (`StarlingsContracts`): `LobbyRequestResponse`,
// `GuestPresenceRow`, `LobbySnapshotResponse`, `OwnerRoomResponse`,
// `JoinRequestReceipt`, `JoinStatusResponse`. See `ContractsExtensions.swift`.

struct MeetingControlAPI: Sendable, PersonAvatarSource, OfferClient {
    let apiBaseURL: URL
    let session: URLSession
    let ownerSessionStore: OwnerSessionStore
    let webOrigin: String
    /// Whose snapshots `snapshot(_:as:)` reads. Nil reads the Keychain's
    /// signed-in owner, as the app does; a test names one without a Keychain.
    private let snapshotOwner: (@Sendable () -> String?)?
    /// Nil renews the active workspace's session (`ownerSessionRenewal(store:)`).
    private let renewal: StarlingsOwnerSessionRenewal?

    init(
        apiBaseURL: URL = HTTPConnectionDetailsProvider.configuredAPIBase,
        session: URLSession = .shared,
        ownerSessionStore: OwnerSessionStore = OwnerSessionStore(),
        webOrigin: String = MeetingControlAPI.configuredWebOrigin,
        snapshotOwner: (@Sendable () -> String?)? = nil,
        renewal: StarlingsOwnerSessionRenewal? = nil
    ) {
        self.apiBaseURL = apiBaseURL
        self.session = session
        self.ownerSessionStore = ownerSessionStore
        self.webOrigin = webOrigin
        self.snapshotOwner = snapshotOwner
        self.renewal = renewal
    }

    /// Another workspace's API, on the session this Mac holds for it. The
    /// token is renewed first when it is near expiry, by a renewer of that
    /// workspace alone; after that a refusal is the answer. Nothing here
    /// renews or expires the active workspace's session.
    static func otherWorkspace(_ workspace: StarlingsWorkspace) async -> MeetingControlAPI {
        let store = OwnerSessionStore(scope: WorkspaceScope(workspace))
        await OwnerSessionRenewer(store: store, apiBaseURL: workspace.apiBaseURL).renewIfNeeded()
        return MeetingControlAPI(
            apiBaseURL: workspace.apiBaseURL,
            ownerSessionStore: store,
            webOrigin: workspace.webOrigin,
            renewal: .none
        )
    }

    /// The active workspace's web origin (`StarlingsWorkspace.active`).
    static var configuredWebOrigin: String { StarlingsWorkspace.active.webOrigin }

    /// Builds and sends every request in this file.
    var httpTransport: StarlingsHTTPTransport {
        StarlingsHTTPTransport(
            baseURL: apiBaseURL,
            session: session,
            webOrigin: webOrigin,
            ownerSessionRenewal: renewal ?? Self.ownerSessionRenewal(store: ownerSessionStore)
        )
    }

    /// The Mac's half of the owner-session replay. Somebody else
    /// may have renewed while the request was out; then the Keychain already
    /// holds the answer and spending another refresh token would only rotate
    /// for nothing. Otherwise `OwnerSessionRenewer` renews, and on a refusal
    /// it expires the Keychain session itself, so every surface agrees and
    /// `rejected` has nothing left to say.
    static func ownerSessionRenewal(store: OwnerSessionStore) -> StarlingsOwnerSessionRenewal {
        StarlingsOwnerSessionRenewal(
            renew: { refused in
                if let stored = try? store.load()?.accessToken, stored != refused { return stored }
                guard await OwnerSessionRenewer.shared.sessionRejected() == .renewed else { return nil }
                return try? store.load()?.accessToken
            },
            rejected: {}
        )
    }

    func requestJoin(
        room: RoomSlug,
        identity: MeetingIdentity,
        bookingToken: String? = nil,
        presenceID: String? = nil
    ) async throws -> JoinRequestReceipt {
        try await call(
            joinRoute(room: room, identity: identity, bookingToken: bookingToken, presenceID: presenceID),
            bearer: signedInMember
        )
    }

    func makeJoinRequest(
        room: RoomSlug,
        identity: MeetingIdentity,
        bookingToken: String? = nil,
        presenceID: String? = nil
    ) throws -> URLRequest {
        // A signed-in member is a caller, not a visitor. The Worker uses this
        // bearer token to admit the member directly to internal rooms such as
        // `/room/team`; guests without a session still use the public lobby.
        try httpTransport.request(
            joinRoute(room: room, identity: identity, bookingToken: bookingToken, presenceID: presenceID),
            bearer: signedInMember
        )
    }

    /// Pre-knock presence from Mac Join — the native twin of the browser join
    /// page's heartbeat.
    ///
    /// The knock itself is refused while the owner is away (neutral copy, on
    /// purpose), so without this a Mac guest leaves nothing behind: the owner
    /// opens the app later with no way to know anyone stood at the door. Same
    /// route, same ~8s cadence and same 45s TTL as the browser's.
    func touchGuestPresence(
        room: RoomSlug,
        presenceID: String,
        stage: GuestPresenceStage,
        name: String?,
        bookingToken: String? = nil
    ) async throws {
        try await perform(
            presenceRoute(room: room, presenceID: presenceID, stage: stage, name: name, bookingToken: bookingToken),
            bearer: nil
        )
    }

    func makeGuestPresenceRequest(
        room: RoomSlug,
        presenceID: String,
        stage: GuestPresenceStage,
        name: String?,
        bookingToken: String? = nil
    ) throws -> URLRequest {
        try httpTransport.request(
            presenceRoute(room: room, presenceID: presenceID, stage: stage, name: name, bookingToken: bookingToken),
            bearer: nil
        )
    }

    /// The signed-in member's session for a knock, or nil for a guest.
    private var signedInMember: StarlingsBearerToken? {
        (try? ownerSessionStore.load()).map { StarlingsBearerToken($0.accessToken, isOwnerSession: true) }
    }

    private func joinRoute(
        room: RoomSlug,
        identity: MeetingIdentity,
        bookingToken: String?,
        presenceID: String?
    ) -> StarlingsRoute<JoinRequestReceipt> {
        StarlingsRoomRoutes.knock(room: room.rawValue, JoinRequest(
            name: identity.name.trimmingCharacters(in: .whitespacesAndNewlines),
            email: identity.email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines),
            bookingToken: bookingToken,
            // Clears the pre-knock row this Mac has been heartbeating, so the
            // owner sees one visitor who knocked, not a lurker and a guest.
            presenceID: presenceID,
            client: .mac
        ))
    }

    /// Never the email: the pre-knock row carries a display name at most,
    /// and only once the guest has typed one. See docs/PRIVACY.md.
    private func presenceRoute(
        room: RoomSlug,
        presenceID: String,
        stage: GuestPresenceStage,
        name: String?,
        bookingToken: String?
    ) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoomRoutes.guestPresence(room: room.rawValue, GuestPresenceReport(
            presenceID: presenceID,
            stage: stage,
            name: name,
            bookingToken: bookingToken,
            client: .mac
        ))
    }

    func publicBooking(room: RoomSlug, token: String) async throws -> PublicBookingLookup {
        let route = StarlingsRoomRoutes.booking(room: room.rawValue, token: token)
        let request = try httpTransport.request(route, bearer: nil)
        let (data, response) = try await exchange(request, operation: route.operation)
        guard let http = response as? HTTPURLResponse else {
            throw StarlingsError.invalidResponse(operation: route.operation)
        }
        if http.statusCode == 404 { return .expired }
        let projection = try decoded(
            StarlingsMintedBookingProjection.self,
            response: response,
            data: data,
            operation: route.operation,
            request: request
        )
        return projection.status.rawValue == "scheduled" ? .scheduled(projection) : .expired
    }

    func joinStatus(room: RoomSlug, receipt: JoinRequestReceipt) async throws -> JoinStatusResponse {
        try await call(StarlingsRoomRoutes.joinStatus(room: room.rawValue, requestID: receipt.requestID), bearer: StarlingsBearerToken(receipt.lobbyToken))
    }

    func exchangeAdmission(room: RoomSlug, receipt: JoinRequestReceipt) async throws -> ConnectionDetails {
        try await call(StarlingsRoomRoutes.exchangeAdmission(room: room.rawValue, requestID: receipt.requestID, lobbyToken: receipt.lobbyToken), bearer: nil)
    }

    func lobby(room: RoomSlug) async throws -> LobbySnapshotResponse {
        try await call(StarlingsRoomRoutes.lobby(room: room.rawValue))
    }

    func updateRoomSettings(room: RoomSlug, settings: RoomSettingsUpdate) async throws -> RoomSettings {
        try await call(StarlingsRoomRoutes.updateRoomSettings(room: room.rawValue, settings))
    }

    func ownerRoom() async throws -> OwnerRoomResponse {
        try await call(StarlingsRoomRoutes.ownerRoom)
    }

    /// Who else at Envisioning is around. Members only — there is no
    /// unauthenticated form of this call and there must never be one.
    func peers() async throws -> PeerRoster {
        try await call(StarlingsPeerRoutes.peers)
    }

    /// Ring a colleague. No push and no APNs: this writes one row that their
    /// next roster poll reads, and it expires on its own. A running client
    /// announces it with a notification; a closed one never learns it happened.
    /// Never present it as proof somebody was reached.
    func ring(peerEmail: String) async throws {
        _ = try await call(StarlingsPeerRoutes.ring(peerEmail: peerEmail))
    }

    /// Answered, dismissed, or simply seen — either way it stops being pending.
    func clearRing() async throws {
        _ = try await call(StarlingsPeerRoutes.clearRing)
    }

    /// Unavailable (`dnd_until` at the Worker). `until` is absolute; nil turns
    /// it off. There is no open-ended form — an unavailable nobody clears is a
    /// person who has quietly left the team.
    func setDoNotDisturb(until: Date?) async throws {
        _ = try await call(StarlingsPeerRoutes.doNotDisturb(until: until))
    }

    /// Ask somebody to open their room and talk now. Same row and same
    /// 45-second life as a wave — it is the *ask* that differs, and only a call
    /// has something to accept. The caller joins the ordinary way once that
    /// room goes live; a verified member skips the queue by itself.
    func callPeer(peerEmail: String) async throws {
        _ = try await call(StarlingsPeerRoutes.call(peerEmail: peerEmail))
    }

    /// What the person says about themselves, alongside what their devices
    /// prove. `until` is absolute; focused requires one and nothing else takes
    /// one — the Worker refuses any other shape rather than dropping the
    /// deadline, so passing the wrong pair here is a programming error.
    func setIntent(_ intent: PeerIntent?, until: Date? = nil) async throws {
        _ = try await call(StarlingsPeerRoutes.intent(intent, until: until))
    }

    /// Appear offline, or stop. Sticky at the Worker; no deadline to pass.
    func setAppearOffline(_ invisible: Bool) async throws {
        _ = try await call(StarlingsPeerRoutes.appearOffline(invisible))
    }

    /// "This Mac has Starlings open." Best-effort: a dropped beat costs one status
    /// for one minute, so callers swallow the error rather than alerting.
    func heartbeat() async throws {
        _ = try await call(StarlingsPeerRoutes.heartbeat(client: .mac))
    }

    // MARK: Direct messages

    /// Snapshotted (docs/CACHING.md): Home's MESSAGES paints the last list
    /// before the first poll answers.
    static let threadsSnapshotKey = StarlingsSnapshotKey.threads

    func threads() async throws -> [ThreadSummary] {
        try await call(StarlingsThreadRoutes.threads).threads
    }

    /// Find-or-create the DM with one peer. Idempotent at the Worker — the id
    /// is derived from both subjects, so asking twice is the same conversation.
    func openThread(peerEmail: String) async throws -> ThreadSummary {
        try await call(StarlingsThreadRoutes.open(peerEmail: peerEmail)).thread
    }

    /// Find-or-create the private conversation with these people.
    ///
    /// Idempotent the same way and for the same reason: the id is derived from
    /// the members, so naming the same people twice is one conversation. Two
    /// addresses derive exactly what `openThread(peerEmail:)` derives, which is
    /// why a group is not a different kind of thing.
    func openThread(peerEmails: [String]) async throws -> ThreadSummary {
        try await call(StarlingsThreadRoutes.open(peerEmails: peerEmails)).thread
    }

    /// Find-or-create a channel. Idempotent at the Worker in the same way a DM
    /// is: the id is fixed, so the first person to ask is the one who creates it.
    func openChannelThread() async throws -> ThreadSummary {
        try await call(StarlingsThreadRoutes.openChannel).thread
    }

    /// Find-or-create the channel on one CRM subject. Core decides whether the
    /// subject exists and what it is called; this sends an id and nothing else.
    func openSubjectThread(kind: String, subjectID: String) async throws -> ThreadSummary {
        try await call(StarlingsThreadRoutes.openSubject(kind: kind, subjectID: subjectID)).thread
    }

    /// Open whatever the screen is showing. The one place that turns an address
    /// into a request body, so a channel is a case here rather than a branch in
    /// every conversation surface.
    func openThread(_ address: ThreadAddress) async throws -> ThreadSummary {
        switch address.target {
        case let .peer(email): try await openThread(peerEmail: email)
        case let .group(emails): try await openThread(peerEmails: emails)
        case .team: try await openChannelThread()
        case let .subject(kind, id): try await openSubjectThread(kind: kind.rawValue, subjectID: id)
        case let .thread(id): try await messages(threadID: id, limit: 1).thread
        }
    }

    func messages(threadID: String, before: String? = nil, limit: Int? = nil) async throws -> ThreadMessagesPage {
        try await call(StarlingsThreadRoutes.messages(threadID: threadID, before: before, limit: limit))
    }

    /// What was said about one task or issue, across the threads the member
    /// can read, oldest first.
    func cardLines(kind: String, id: String) async throws -> [ThreadMessage] {
        try await call(StarlingsThreadRoutes.cardLines(kind: kind, id: id)).lines.map(ThreadMessage.init(wire:))
    }

    func sendMessage(
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
        )).message
    }

    /// Submit one explicit selection on an agent-authored question. Meet
    /// returns the committed winner when another member answered first.
    func answerQuestion(
        threadID: String,
        messageID: String,
        optionIDs: [String]
    ) async throws -> (message: ThreadMessage, accepted: Bool) {
        let response = try await call(StarlingsThreadRoutes.answerQuestion(threadID: threadID, messageID: messageID, optionIDs: optionIDs))
        return (ThreadMessage(wire: response.message), response.accepted)
    }

    /// Record on an agent's Keep release card what this device did in Keep:
    /// approved the release, or ended it. Keep acted first.
    func updateRelease(
        threadID: String,
        messageID: String,
        _ update: ThreadReleaseUpdateRequest
    ) async throws -> ThreadMessage {
        ThreadMessage(wire: try await call(StarlingsThreadRoutes.updateRelease(threadID: threadID, messageID: messageID, update)).message)
    }

    /// Reserve somewhere to put one file, then put it there.
    ///
    /// Two steps because the writes are different animals: the metadata is
    /// small and transactional, the bytes can be twenty-five megabytes and can
    /// fail halfway. A staged upload nobody sends is inert — no message carries
    /// it, so nobody but the uploader can see it exists.
    func uploadAttachment(
        threadID: String,
        name: String,
        contentType: String,
        data: Data,
        pixelSize: CGSize? = nil
    ) async throws -> ThreadMessageAttachment {
        let staged = try await call(StarlingsThreadRoutes.stageAttachment(
            threadID: threadID, name: name, contentType: contentType, bytes: data.count, pixelSize: pixelSize
        ))
        _ = try await call(StarlingsThreadRoutes.uploadAttachment(uploadPath: staged.uploadPath, contentType: contentType, data: data))
        return staged.attachment
    }

    /// Keep one picture for a GitHub issue and answer where it lives.
    ///
    /// One request, not the thread attachment's two: there is no row to reserve
    /// here, only bytes to keep. The address it answers with is readable
    /// without a session — github.com renders an issue body for whoever is
    /// looking at it — so what comes back goes straight into the body as a
    /// markdown image link. See `services/control-plane/src/issue-images.ts`.
    func uploadIssueImage(contentType: String, data: Data) async throws -> IssueImageAnswer {
        try await call(StarlingsWorkRoutes.uploadIssueImage(contentType: contentType, data: data))
    }

    /// The bytes of one attachment, for drawing it. Authenticated like every
    /// other read here — an object key is never a link somebody can pass on.
    func attachmentData(threadID: String, attachmentID: String) async throws -> Data {
        let request = try authorizedRequest(StarlingsThreadRoutes.attachment(threadID: threadID, attachmentID: attachmentID))
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

    /// Add or remove one emoji — the same call either way, because the surface
    /// is one pill you press and two routes would only be two ways to disagree
    /// about whether it is lit.
    @discardableResult
    func react(threadID: String, messageID: String, emoji: String) async throws -> [ThreadMessageReaction] {
        try await call(StarlingsThreadRoutes.react(threadID: threadID, messageID: messageID, emoji: emoji)).reactions
    }

    /// Rewrite your own message. The Worker refuses somebody else's with the
    /// same 404 a missing one gets, and one past the edit window with
    /// `message_not_editable` — "too late" rather than "gone".
    func editMessage(threadID: String, messageID: String, text: String) async throws {
        _ = try await call(StarlingsThreadRoutes.edit(threadID: threadID, messageID: messageID, text: text))
    }

    /// Withdraw your own message. The row stays and keeps its place; the text
    /// and any files on it are gone.
    func withdrawMessage(threadID: String, messageID: String) async throws {
        _ = try await call(StarlingsThreadRoutes.withdraw(threadID: threadID, messageID: messageID))
    }

    /// Silence one conversation, or let it speak again. Per member: a channel
    /// you have heard enough of is still the channel everybody else works in.
    func muteThread(threadID: String, until: Date?) async throws {
        _ = try await call(StarlingsThreadRoutes.mute(threadID: threadID, until: until))
    }

    /// Put a conversation away, or take it back out. Per-member: the other
    /// person's list is untouched, and anything said from now on brings the
    /// row back without anybody unarchiving it.
    func archiveThread(threadID: String, archived: Bool) async throws {
        _ = try await call(StarlingsThreadRoutes.archive(threadID: threadID, archived: archived))
    }

    /// A link save. The Worker reads the page with the reader
    /// behind every chat link card and files the save in Docs with what it
    /// found and the page's picture; Docs never fetches a URL. On a
    /// subject's list the save lands in that subject's folder, filed on it.
    func saveDocsLink(url: URL, folderPath: String?, subjects: [DocsSubject]) async throws -> DocsDocumentDetail {
        let route = StarlingsDocsRoutes.saveLink(DocsCreateDocumentRequest(
            url: url.absoluteString,
            folderPath: folderPath,
            subjects: StarlingsDocsRoutes.subjects(subjects),
            message: String(localized: "Saved from Starlings")
        ))
        return try await docsDetail(try authorizedRequest(route), operation: route.operation)
    }

    /// Read a saved link again, through the same reader: the title stays,
    /// the page's description, site and picture are replaced.
    func refetchDocsLink(documentID: String) async throws -> DocsDocumentDetail {
        let route = StarlingsDocsRoutes.refetchLink(documentID: documentID)
        return try await docsDetail(try authorizedRequest(route), operation: route.operation)
    }

    /// Docs' document, as the Worker passes it through: snake case in
    /// Docs' own shape, so DocsKit's decoder reads it, not the wire one.
    private func docsDetail(_ request: URLRequest, operation: String) async throws -> DocsDocumentDetail {
        let (data, response) = try await exchange(request, operation: operation)
        try validate(response, data: data, operation: operation)
        struct Envelope: Decodable { let document: DocsDocumentDetail }
        do {
            return try DocsCoding.decoder.decode(Envelope.self, from: data).document
        } catch {
            throw StarlingsError.http(.undecodable(type: "DocsDocumentDetail"), operation: operation)
        }
    }

    /// Close a comment thread on a document (`PATCH /api/docs/annotations/:id`,
    ///). The thread leaves INBOX with it.
    func resolveComment(threadID: String) async throws {
        try await perform(StarlingsDocsRoutes.resolveComment(threadID: threadID))
    }

    /// Best-effort: a missed read receipt costs one unread dot.
    func markThreadRead(threadID: String) async throws {
        _ = try await call(StarlingsThreadRoutes.markRead(threadID: threadID))
    }

    func calendarStatus() async throws -> CalendarConnectionStatus {
        try await call(StarlingsCalendarRoutes.status)
    }

    func exchangeCalendarConnect(
        code: String,
        codeVerifier: String,
        redirectURI: String,
        nonce: String
    ) async throws -> CalendarConnectionStatus {
        try await call(StarlingsCalendarRoutes.connect(CalendarConnectExchangeRequest(
            code: code,
            codeVerifier: codeVerifier,
            redirectURI: redirectURI,
            nonce: nonce
        )))
    }

    func disconnectCalendar() async throws -> CalendarConnectionStatus {
        try await call(StarlingsCalendarRoutes.disconnect)
    }

    func createCalendarEvent(
        title: String,
        start: Date,
        end: Date,
        joinURL: String? = nil,
        roomSlug: String? = nil,
        attendees: [String] = [],
        description: String? = nil,
        location: String? = nil,
        timeZone: String? = nil,
        calendarId: String? = nil,
        travelTimeMinutes: Int? = nil
    ) async throws -> CalendarEventSummary {
        try await call(StarlingsCalendarRoutes.createEvent(CalendarEventCreateRequest(
            title: title,
            start: start,
            end: end,
            joinURL: joinURL,
            roomSlug: roomSlug,
            attendees: attendees,
            description: description,
            location: location,
            timeZone: timeZone,
            calendarID: calendarId,
            travelTimeMinutes: travelTimeMinutes
        ))).summary
    }

    func mintCalendarBooking(
        title: String,
        start: Date,
        end: Date,
        roomSlug: String,
        joinURL: String? = nil
    ) async throws -> CalendarBookingMintResponse {
        try await call(StarlingsCalendarRoutes.mintBooking(CalendarBookingMintRequest(
            title: title,
            start: start,
            end: end,
            roomSlug: roomSlug,
            joinURL: joinURL
        )))
    }

    func calendarEvents(from start: Date, to end: Date) async throws -> [CalendarEventSummary] {
        try await call(StarlingsCalendarRoutes.events(from: start, to: end)).summaries
    }

    func calendarInvitations() async throws -> [CalendarEventSummary] {
        try await call(StarlingsCalendarRoutes.invitations).summaries
    }

    /// Snapshotted (docs/CACHING.md): Home's UPCOMING paints the last answer
    /// before the calendar answers.
    static let upcomingSnapshotKey = StarlingsSnapshotKey.calendarUpcoming
    static let invitationsSnapshotKey = StarlingsSnapshotKey.calendarInvitations

    func patchCalendarEvent(
        calendarId: String,
        eventId: String,
        title: String,
        start: Date,
        end: Date,
        /// `nil` leaves the stored guest list untouched. Sending an echo of the
        /// current attendees is not free: it makes the server re-write the list.
        attendees: [String]? = nil,
        timeZone: String? = nil,
        joinURL: String? = nil,
        roomSlug: String? = nil,
        notes: String? = nil,
        location: String? = nil,
        travelTimeMinutes: Int? = nil
    ) async throws -> CalendarEventSummary {
        try await call(StarlingsCalendarRoutes.patchEvent(CalendarEventPatchRequest(
            calendarID: calendarId,
            eventID: eventId,
            title: title,
            start: start,
            end: end,
            attendees: attendees,
            timeZone: timeZone,
            joinURL: joinURL,
            roomSlug: roomSlug,
            notes: notes,
            location: location,
            travelTimeMinutes: travelTimeMinutes
        ))).summary
    }

    func moveCalendarEvent(
        calendarId: String,
        eventId: String,
        destinationId: String
    ) async throws -> CalendarEventSummary {
        try await call(StarlingsCalendarRoutes.moveEvent(CalendarEventMoveRequest(
            calendarID: calendarId,
            eventID: eventId,
            destinationID: destinationId
        ))).summary
    }

    /// Quick add's fallback: the sentence the grammar could not read, to the notes engine.
    func quickAdd(_ body: CalendarQuickAddRequest) async throws -> CalendarQuickAddResponse {
        try await call(StarlingsCalendarRoutes.quickAdd(body))
    }

    /// Snapshotted (docs/CACHING.md): the last answer paints first.
    static let pendingCalendarSnapshotKey = StarlingsSnapshotKey.calendarPending

    func pendingCalendarEvents() async throws -> [ProposedCalendarEvent] {
        try await call(StarlingsCalendarRoutes.pending).events
    }

    func addPendingCalendarEvent(id: String) async throws -> CalendarEventSummary {
        try await call(StarlingsCalendarRoutes.addPending(id: id)).summary
    }

    func discardPendingCalendarEvent(id: String) async throws {
        try await perform(StarlingsCalendarRoutes.discardPending(id: id))
    }

    func respondToCalendarEvent(
        calendarId: String,
        eventId: String,
        response: CalendarRSVP
    ) async throws -> CalendarEventSummary {
        guard let body = CalendarEventRespondRequest(calendarID: calendarId, eventID: eventId, response: response) else {
            throw StarlingsError.invalidResponse(operation: String(localized: "Couldn’t send your reply"))
        }
        return try await call(StarlingsCalendarRoutes.respond(body)).summary
    }

    func deleteCalendarEvent(calendarId: String, eventId: String) async throws {
        try await perform(StarlingsCalendarRoutes.deleteEvent(CalendarEventDeleteRequest(calendarID: calendarId, eventID: eventId)))
    }

    func upcomingCalendarEvents(hours: Int = MeetingFocus.requestHours) async throws -> [CalendarEventSummary] {
        try await call(StarlingsCalendarRoutes.upcoming(hours: hours)).summaries
    }

    func calendarFreeBusy(
        from start: Date,
        to end: Date,
        emails: [String]
    ) async throws -> [CalendarFreeBusyPerson] {
        guard !emails.isEmpty else { return [] }
        return try await call(StarlingsCalendarRoutes.freeBusy(CalendarFreeBusyRequest(
            timeMin: start,
            timeMax: end,
            emails: emails
        ))).people
    }

    func calendarWorkItems(
        from start: Date,
        to end: Date,
        includeDone: Bool = false
    ) async throws -> [CalendarWorkItem] {
        try await call(StarlingsCalendarRoutes.workItems(from: start, to: end, includeDone: includeDone)).items
    }

    func calendarAvailability(from start: Date, to end: Date) async throws -> [CalendarAvailabilityBlock] {
        try await call(StarlingsCalendarRoutes.availability(from: start, to: end)).blocks
    }

    func listCalendars() async throws -> [GoogleCalendarListEntry] {
        try await call(StarlingsCalendarRoutes.calendars).calendars
    }

    /// Snapshotted: Home derives UPCOMING from the snapshot under
    /// the policy it was last drawn with, so the live answer does not reorder it.
    static let calendarPreferencesSnapshotKey = StarlingsSnapshotKey.calendarPreferences

    func calendarPreferences() async throws -> CalendarPreferences {
        CalendarPreferences(wire: try await call(StarlingsCalendarRoutes.preferences))
    }

    func setSelectedCalendarIds(_ ids: [String]) async throws -> CalendarPreferences {
        try await setCalendarPreferences(selectedCalendarIds: ids)
    }

    func setUpcomingExcludedSubscriptionIds(_ ids: [String]) async throws -> CalendarPreferences {
        try await putCalendarPreferences(.init(upcomingExcludedSubscriptionIDs: ids))
    }

    func setCalendarPreferences(selectedCalendarIds: [String]) async throws -> CalendarPreferences {
        try await putCalendarPreferences(.init(selectedCalendarIDs: selectedCalendarIds))
    }

    func setHiddenCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences {
        try await putCalendarPreferences(.init(hiddenCalendarKeys: keys))
    }

    func setDisabledCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences {
        try await putCalendarPreferences(.init(disabledCalendarKeys: keys))
    }

    func setDemotedEventKeys(_ keys: [String]) async throws -> CalendarPreferences {
        try await putCalendarPreferences(.init(demotedEventKeys: keys))
    }

    func setEventSubjects(_ subjects: [String: CrmSubject]) async throws -> CalendarPreferences {
        try await putCalendarPreferences(.init(eventSubjects: subjects.mapValues(\.calendarEventSubject)))
    }

    func setIncludesLocalCalendars(_ included: Bool) async throws -> CalendarPreferences {
        try await putCalendarPreferences(.init(includesLocalCalendars: included))
    }

    func setUpcomingPreferences(_ preferences: UpcomingPreferencesWire) async throws -> CalendarPreferences {
        try await putCalendarPreferences(.init(upcoming: preferences))
    }

    /// What Home is made of, for this owner — the same list the phone and the
    /// browser read (`fixtures/home-layout.json`).
    func homeLayout() async throws -> HomePreferencesResponse {
        try await call(StarlingsSettingsRoutes.homeLayout)
    }

    func setHomeLayout(_ layout: [HomeModuleSetting]) async throws -> HomePreferencesResponse {
        try await call(StarlingsSettingsRoutes.setHomeLayout(layout))
    }

    /// This owner's setup steps, each done when the thing exists — the same
    /// answer the phone and the browser read (docs/ONBOARDING.md).
    func setup() async throws -> SetupResponse {
        try await call(StarlingsSettingsRoutes.setup)
    }

    /// An admin turns the checklist off, or on, for the whole workspace.
    func setSetupChecklist(on: Bool) async throws -> SetupResponse {
        try await call(StarlingsSettingsRoutes.setSetupChecklist(on: on))
    }

    /// Skip: clear one step from this owner's checklist, on every client.
    func skipSetupStep(_ step: SetupStep) async throws -> SetupResponse {
        try await call(StarlingsSettingsRoutes.skipSetupStep(step))
    }

    /// Snapshotted (docs/CACHING.md): Home's COMMERCIAL card paints
    /// the last summary before Core answers.
    static let commercialSnapshotKey = StarlingsSnapshotKey.commercialSummary

    func commercialSummary() async throws -> CommercialSummary {
        try await call(StarlingsWorkRoutes.commercialSummary)
    }

    /// The language the interface is drawn in, for this owner — the same
    /// choice the phone and the browser read.
    func language() async throws -> LanguagePreferenceResponse {
        try await call(StarlingsSettingsRoutes.language)
    }

    func setLanguage(_ language: StarlingsLanguage?) async throws -> LanguagePreferenceResponse {
        try await call(StarlingsSettingsRoutes.setLanguage(language))
    }

    func calendarAccounts() async throws -> [CalendarAccount] {
        try await call(StarlingsCalendarRoutes.accounts).accounts
    }

    /// Attach another Google account for its calendars. This is not a sign-in:
    /// the owner session that authorises the call is the one that stays.
    func exchangeCalendarAccountConnect(
        code: String,
        codeVerifier: String,
        redirectURI: String,
        nonce: String
    ) async throws -> CalendarAccountResponse {
        try await call(StarlingsCalendarRoutes.connectAccount(CalendarConnectExchangeRequest(
            code: code,
            codeVerifier: codeVerifier,
            redirectURI: redirectURI,
            nonce: nonce
        )))
    }

    func removeCalendarAccount(id: String) async throws {
        try await perform(StarlingsCalendarRoutes.removeAccount(id: id))
    }

    func calendarSubscriptions() async throws -> [CalendarSubscription] {
        try await call(StarlingsCalendarRoutes.subscriptions).subscriptions
    }

    func addCalendarSubscription(url: String, title: String?) async throws -> CalendarSubscription {
        try await call(StarlingsCalendarRoutes.addSubscription(url: url, title: title)).subscription
    }

    func removeCalendarSubscription(id: String) async throws {
        try await perform(StarlingsCalendarRoutes.removeSubscription(id: id))
    }

    func subscriptionEvents(from start: Date, to end: Date) async throws -> [SubscriptionEventSummary] {
        try await call(StarlingsCalendarRoutes.subscriptionEvents(from: start, to: end)).events
    }

    /// Settings › Calendar › Booking hours.
    func bookingSettings() async throws -> BookingSettingsResponse {
        try await call(StarlingsCalendarRoutes.bookingSettings)
    }

    func saveBookingSettings(_ update: BookingSettingsUpdate) async throws -> BookingSettingsResponse {
        try await call(StarlingsCalendarRoutes.saveBookingSettings(update))
    }

    private func putCalendarPreferences(_ update: CalendarPreferencesUpdate) async throws -> CalendarPreferences {
        CalendarPreferences(wire: try await call(StarlingsCalendarRoutes.savePreferences(update)))
    }

    func decide(room: RoomSlug, requestID: String, admit: Bool, onBehalfOf: String? = nil) async throws {
        try await perform(StarlingsRoomRoutes.decide(room: room.rawValue, requestID: requestID, admit: admit, onBehalfOf: onBehalfOf))
    }

    /// Close the second door of an event session (docs/SESSIONS.md §7):
    /// registration links stop admitting, and those guests knock again.
    func closeSessionDoor(room: RoomSlug) async throws -> SessionDoorResponse {
        try await call(StarlingsRoomRoutes.closeSessionDoor(room: room.rawValue))
    }

    /// Close a lurker's connection: drops them off the waiting page and blocks
    /// their tab from re-announcing for a cooldown. There is no live socket to
    /// a pre-knock visitor, so this is the strongest thing the host can do —
    /// see `removeGuestPresence` in the room coordinator.
    func removeGuestPresence(room: RoomSlug, presenceID: String) async throws {
        try await perform(StarlingsRoomRoutes.removeGuestPresence(room: room.rawValue, presenceID: presenceID))
    }

    /// Stop one participant's screen share. Owner-only server-side: the Worker
    /// re-checks room ownership and the host lease before it touches the SFU,
    /// so a stale client cannot moderate a room it walked away from.
    func stopScreenShare(context: MeetingContext, identity: String) async throws {
        try await perform(StarlingsRoomRoutes.stopScreenShare(room: context.room.rawValue, meetingID: context.meetingID, identity: identity))
    }

    /// Close one participant's microphone, or everyone's but this Mac's.
    ///
    /// Owner-only server-side, checked the same way stopping a share is. There
    /// is deliberately no unmute counterpart: a host may take the floor back,
    /// but re-opening a microphone belongs to the person behind it.
    /// Answers how many microphones it closed.
    func muteParticipant(context: MeetingContext, identity: String?) async throws -> Int {
        try await call(StarlingsRoomRoutes.muteParticipant(room: context.room.rawValue, meetingID: context.meetingID, identity: identity)).muted
    }

    /// Disconnect one participant and spend their admission, so coming back
    /// means knocking again rather than reconnecting.
    func removeParticipant(context: MeetingContext, identity: String) async throws {
        try await perform(StarlingsRoomRoutes.removeParticipant(room: context.room.rawValue, meetingID: context.meetingID, identity: identity))
    }

    func heartbeat(context: MeetingContext) async throws {
        guard context.role == .host else { return }
        try await perform(StarlingsRoomRoutes.hostHeartbeat(room: context.room.rawValue, meetingID: context.meetingID))
    }

    /// `ifVacant` takes the host only when nobody holds it: a companion's
    /// automatic claim after the host leaves, never a takeover.
    func claimHost(context: MeetingContext, ifVacant: Bool = false) async throws -> HostMutationResponse {
        guard context.role == .host else { throw StarlingsError.invalidEntry }
        return try await call(StarlingsRoomRoutes.claimHost(room: context.room.rawValue, meetingID: context.meetingID, device: .mac, ifVacant: ifVacant))
    }

    /// Ask one device in the call to host. Another device of this
    /// person claims on the message; another member is asked and answers.
    func offerHost(context: MeetingContext, targetIdentity: String) async throws -> HostOfferResponse {
        guard context.role == .host else { throw StarlingsError.invalidEntry }
        return try await call(StarlingsRoomRoutes.offerHost(room: context.room.rawValue, meetingID: context.meetingID, targetIdentity: targetIdentity))
    }

    /// Answer an offer to host, signed in as this member. The room is not
    /// theirs, so this takes the room and meeting rather than a host context.
    func answerHostOffer(room: RoomSlug, meetingID: String, accept: Bool) async throws -> HostOfferAnswerResponse {
        try await call(StarlingsRoomRoutes.answerHostOffer(room: room.rawValue, meetingID: meetingID, accept: accept))
    }

    func releaseHost(context: MeetingContext) async throws -> HostMutationResponse {
        guard context.role == .host else { throw StarlingsError.invalidEntry }
        return try await call(StarlingsRoomRoutes.releaseHost(room: context.room.rawValue, meetingID: context.meetingID))
    }

    /// Soft host presence while idle on the owner launch clock (no meeting yet).
    func touchPresence(room: RoomSlug) async throws {
        try await perform(StarlingsRoomRoutes.touchPresence(room: room.rawValue))
    }

    func appendTranscript(context: MeetingContext, segments: [TranscriptSegment]) async throws {
        guard !segments.isEmpty else { return }
        try await perform(StarlingsRoomRoutes.appendTranscript(room: context.room.rawValue, meetingID: context.meetingID, segments: segments))
    }

    /// A meeting the Mac captured outside any room, created over on the
    /// owner's room with its roster; the transcript and finalize follow
    /// through the ordinary routes (docs/AMBIENT_CAPTURE.md).
    func createAmbientMeeting(room: String, startedAt: Date, endedAt: Date, title: String?, attendees: [AmbientAttendee]) async throws -> String {
        try await call(StarlingsRoomRoutes.createAmbientMeeting(room: room, AmbientMeetingRequest(
            startedAt: startedAt.formatted(.iso8601),
            endedAt: endedAt.formatted(.iso8601),
            title: Patch(title),
            attendees: attendees
        ))).meetingID
    }

    func finalize(context: MeetingContext) async throws {
        try await perform(StarlingsRoomRoutes.finalize(room: context.room.rawValue, meetingID: context.meetingID))
    }

    /// Mark the meeting ended without waiting on transcript upload; `finalize`
    /// still runs afterward for the artifact. On a personal room this closes
    /// the SFU and guests drop at once. On `/room/team` the record ends but
    /// the call stays up for whoever is still in it, unless `everyone` — any
    /// member may end it for everyone.
    func endMeeting(context: MeetingContext, everyone: Bool = false) async throws {
        guard context.role == .host || everyone else { return }
        try await perform(StarlingsRoomRoutes.end(room: context.room.rawValue, meetingID: context.meetingID, everyone: everyone))
    }

    /// Close a meeting this client never joined — the one a crash or force-quit
    /// left open, which the launch screen offers to clear. There is no artifact
    /// to finalize (this app instance has no transcript for it) and no host
    /// lease to renew; the owner session alone authorizes the route.
    func closeOpenMeeting(room: RoomSlug, meetingID: String) async throws {
        try await perform(StarlingsRoomRoutes.closeOpenMeeting(room: room.rawValue, meetingID: meetingID))
    }

    /// Posts this client's own call quality. Authorized with the artifact token
    /// so guests can report too; the server takes identity and role from that
    /// token rather than the body.
    func reportQuality(context: MeetingContext, report: MeetingQualityReport) async throws {
        try await perform(StarlingsRoomRoutes.reportQuality(room: context.room.rawValue, meetingID: context.meetingID, report), bearer: StarlingsBearerToken(context.artifactToken))
    }

    /// Posts this client's cumulative LiveKit receiver-byte estimate.
    func reportDownstreamUsage(context: MeetingContext, report: DownstreamUsageReport) async throws {
        try await perform(StarlingsRoomRoutes.reportDownstreamUsage(room: context.room.rawValue, meetingID: context.meetingID, report), bearer: StarlingsBearerToken(context.artifactToken))
    }

    /// What a pasted link in the meeting's chat points at.
    ///
    /// Same answer as `linkPreview(url:)` and the same reason nobody fetches
    /// the page themselves; different door. This one is authorized by the
    /// meeting rather than by an account, because a guest in Join mode has no
    /// account — the artifact token asserts one thing, that you are in this
    /// meeting, which is exactly the right thing to ask for here.
    func meetingLinkPreview(context: MeetingContext, url link: String) async throws -> LinkPreview {
        try await call(StarlingsRoomRoutes.linkPreview(room: context.room.rawValue, meetingID: context.meetingID, url: link), bearer: StarlingsBearerToken(context.artifactToken)).preview
    }

    /// Put this client's own hand up or down.
    ///
    /// Authorized with the artifact token, like the quality report, and for the
    /// same reason: the server takes the identity from that token rather than
    /// the body, so this can only ever move the caller's own hand. The Worker
    /// writes the participant attribute — see `MeetingHands` for why no client
    /// writes it itself.
    func setOwnHand(context: MeetingContext, raised: Bool) async throws {
        try await perform(StarlingsRoomRoutes.setOwnHand(room: context.room.rawValue, meetingID: context.meetingID, raised: raised), bearer: StarlingsBearerToken(context.artifactToken))
    }

    /// Lower every hand in the room. Owner-only, checked server-side the same
    /// way muting everyone else is: clearing the queue is a moderation act.
    @discardableResult
    func lowerAllHands(context: MeetingContext) async throws -> Int {
        try await call(StarlingsRoomRoutes.lowerAllHands(room: context.room.rawValue, meetingID: context.meetingID)).lowered
    }

    /// Envisioning-only CRM filing for the live meeting.
    func meetingCategory(context: MeetingContext) async throws -> MeetingCategory {
        try await call(StarlingsRoomRoutes.category(room: context.room.rawValue, meetingID: context.meetingID))
    }

    /// The meeting's record as its page reads it: what a copy or a
    /// download formats. The owner reads it live; anyone else once it is
    /// filed and over, the same gate as the page.
    func meetingTranscript(context: MeetingContext) async throws -> TranscriptViewResponse {
        try await call(StarlingsRoomRoutes.transcript(room: context.room.rawValue, meetingID: context.meetingID))
    }

    func setMeetingCategory(context: MeetingContext, update: MeetingCategoryUpdate) async throws -> MeetingCategory {
        try await call(StarlingsRoomRoutes.setCategory(room: context.room.rawValue, meetingID: context.meetingID, update))
    }

    /// Just the rows, for the in-meeting picker that only ever searches.
    /// A chunk of live transcript in, proposed commitments out. Stateless on
    /// the Worker side; the Mac keeps the suggestions and verifies the quotes.
    func proposeTaskCandidates(
        context: MeetingContext,
        excerpt: String,
        knownTitles: [String]
    ) async throws -> TaskCandidatesResponse {
        try await call(StarlingsRoomRoutes.proposeTaskCandidates(room: context.room.rawValue, meetingID: context.meetingID, excerpt: excerpt, knownTitles: knownTitles))
    }

    func crmSubjects(kind: MeetingCategoryKind.SubjectKind, query: String) async throws -> [CrmSubject] {
        try await crmSubjectPage(kind: kind, query: query).subjects
    }

    /// The browse list plus whether it is all of them.
    func crmSubjectPage(
        kind: MeetingCategoryKind.SubjectKind,
        query: String,
        status: String? = nil,
        organizations: OrganizationListFilter? = nil,
        leadSource: String? = nil
    ) async throws -> CrmSubjectsResponse {
        try await call(StarlingsWorkRoutes.subjects(kind: kind, query: query, status: status, organizations: organizations, leadSource: leadSource))
    }

    /// Organizations matching `query`, from the Worker's owner-scoped Core
    /// search (`GET /api/crm/organizations`). The Worker asks Core for
    /// organizations only and retries a rate limit, so the New Lead typeahead
    /// does not depend on decoding every kind of hit Core's global search
    /// returns.
    func crmOrganizations(matching query: String) async throws -> [SubjectRelationOption] {
        try await call(StarlingsWorkRoutes.organizations(matching: query)).organizations.map { SubjectRelationOption(id: $0.id, name: $0.name) }
    }

    /// Creates an organization by name (`POST /api/crm/organizations`): in
    /// Core on a Core workspace, in the workspace's D1 otherwise.
    func crmCreateOrganization(named name: String) async throws -> SubjectRelationOption {
        let created = try await call(StarlingsWorkRoutes.createOrganization(named: name)).organization
        return SubjectRelationOption(id: created.id, name: created.name)
    }

    /// Edit an organization: the fields that changed only.
    func updateCrmOrganization(id: String, _ update: CrmOrganizationUpdate) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.updateOrganization(id: id, update)).subject
    }

    /// Delete an organization. A 409 says which records still point at it.
    func deleteCrmOrganization(id: String) async throws {
        _ = try await call(StarlingsWorkRoutes.deleteOrganization(id: id))
    }

    /// Merges organizations and answers which one stayed.
    func mergeCrmOrganizations(ids: [String]) async throws -> CoreMergeResponseData {
        try await call(StarlingsWorkRoutes.mergeOrganizations(ids: ids)).data
    }

    // MARK: Contacts

    /// Contacts matching `query` (name, title, address, organization), the
    /// contacts named by `ids`, or the contacts that hold any of `emails`
    ///, from `GET /api/crm/contacts`: the workspace's own on D1,
    /// Core's as the member on Core. The subject editor's picker reads this,
    /// so it works without Core linked on this Mac.
    func crmContacts(matching query: String? = nil, ids: [String]? = nil, organizationID: String? = nil, emails: [String]? = nil) async throws -> [CrmContact] {
        try await call(StarlingsWorkRoutes.contacts(matching: query, ids: ids, organizationID: organizationID, emails: emails)).contacts
    }

    /// One contact's page: addresses, projects, leads, calls, who met them.
    func crmContact(id: String) async throws -> CrmContactDetail {
        try await call(StarlingsWorkRoutes.contact(id: id)).contact
    }

    func createCrmContact(_ body: CrmContactCreate) async throws -> CrmContactDetail {
        try await call(StarlingsWorkRoutes.createContact(body)).contact
    }

    func updateCrmContact(id: String, _ body: CrmContactUpdate) async throws -> CrmContactDetail {
        try await call(StarlingsWorkRoutes.updateContact(id: id, body)).contact
    }

    /// The Contacts group's page: the search, the filters, and the facets for the menu.
    func crmContactList(query: String, filter: ContactListFilter) async throws -> CrmContactsResponse {
        try await call(StarlingsWorkRoutes.contactList(query: query, filter: filter))
    }

    /// What the contact editor offers: characteristic names and languages.
    func crmContactOptions() async throws -> CrmContactOptionsResponse {
        try await call(StarlingsWorkRoutes.contactOptions)
    }

    /// Merges contacts and answers which one stayed.
    func mergeCrmContacts(ids: [String]) async throws -> CoreMergeResponseData {
        try await call(StarlingsWorkRoutes.mergeContacts(ids: ids)).data
    }

    /// Delete a contact. A 409 says which calls or tasks still reference it.
    func deleteCrmContact(id: String) async throws {
        _ = try await call(StarlingsWorkRoutes.deleteContact(id: id))
    }

    /// Delete a task. 404 when it is gone; 403 without the write right on its subject.
    func deleteCrmTask(id: String) async throws {
        _ = try await call(StarlingsWorkRoutes.deleteTask(id: id))
    }

    /// An organization's Tasks By project.
    func crmOrganizationProjectTasks(organizationID: String) async throws -> CrmOrganizationProjectTaskGroups {
        CrmOrganizationProjectTaskGroups(try await call(StarlingsWorkRoutes.organizationProjectTasks(id: organizationID)))
    }

    /// The Work sidebar's status badges for one kind, in one request, exact.
    /// `query` narrows the same way the visible list does; see docs/WORK.md.
    func crmSubjectCounts(
        kind: MeetingCategoryKind.SubjectKind,
        query: String
    ) async throws -> CrmSubjectCountsResponse {
        try await call(StarlingsWorkRoutes.subjectCounts(kind: kind, query: query))
    }

    func crmSubjectDetail(
        kind: MeetingCategoryKind.SubjectKind,
        id: String
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.subjectDetail(kind: kind, id: id)).subject
    }

    /// The form answers that filed a lead, or nil for a lead a member made
    /// (docs/FORMS.md).
    func leadSubmission(id: String) async throws -> FormSubmission? {
        try await call(StarlingsWorkRoutes.leadSubmission(id: id)).submission
    }

    /// A lead's or an organization's offers and licenses; a nil list is a
    /// module the workspace has off.
    func crmSubjectCommercial(kind: MeetingCategoryKind.SubjectKind, id: String) async throws -> CrmSubjectCommercialResponse {
        try await call(StarlingsWorkRoutes.subjectCommercial(kind: kind, id: id))
    }

    // MARK: Offers and the catalog

    func offerOptions() async throws -> OfferOptionsResponse { try await call(StarlingsWorkRoutes.offerOptions()) }
    func licenses(product: String?, active: Bool?) async throws -> [CrmLicense] { try await call(StarlingsWorkRoutes.licenses(product: product, active: active)).licenses }
    func offers(status: String?) async throws -> [CrmOffer] { try await call(StarlingsWorkRoutes.offers(status: status)).offers }
    func createLicense(_ create: LicenseCreate) async throws -> CrmLicense { try await call(StarlingsWorkRoutes.createLicense(create)).license }
    func patchLicense(id: String, _ patch: LicensePatch) async throws -> CrmLicense { try await call(StarlingsWorkRoutes.patchLicense(id: id, patch)).license }
    func endLicense(id: String) async throws -> CrmLicense { try await call(StarlingsWorkRoutes.endLicense(id: id)).license }
    func createOffer(_ create: OfferCreate) async throws -> OfferResponse { try await call(StarlingsWorkRoutes.createOffer(create)) }
    func patchOffer(id: String, _ patch: OfferPatch) async throws -> OfferResponse { try await call(StarlingsWorkRoutes.patchOffer(id: id, patch)) }
    func addOfferLine(offerID: String, _ line: OfferLineCreate) async throws -> OfferResponse {
        try await call(StarlingsWorkRoutes.addOfferLine(offerID: offerID, line))
    }
    func patchOfferLine(offerID: String, lineID: String, _ patch: OfferLinePatch) async throws -> OfferResponse {
        try await call(StarlingsWorkRoutes.patchOfferLine(offerID: offerID, lineID: lineID, patch))
    }
    func removeOfferLine(offerID: String, lineID: String) async throws -> OfferResponse {
        try await call(StarlingsWorkRoutes.removeOfferLine(offerID: offerID, lineID: lineID))
    }
    func sendOffer(id: String, update: Bool) async throws -> OfferSendResponse { try await call(StarlingsWorkRoutes.sendOffer(id: id, update: update)) }
    func readOffer(id: String) async throws -> OfferResponse { try await call(StarlingsWorkRoutes.offer(id: id)) }
    func readOfferVersion(id: String, version: Int) async throws -> OfferVersionResponse {
        try await call(StarlingsWorkRoutes.offerVersion(id: id, version: version))
    }
    func duplicateOffer(id: String, to target: OfferDuplicate) async throws -> OfferResponse {
        try await call(StarlingsWorkRoutes.duplicateOffer(id: id, to: target))
    }
    func recordOfferDecision(id: String, decision: OfferDecision) async throws -> OfferResponse {
        try await call(StarlingsWorkRoutes.recordOfferDecision(id: id, decision))
    }
    func organizationDiscount(id: String) async throws -> OrganizationDiscountResponse { try await call(StarlingsWorkRoutes.organizationDiscount(id: id)) }
    func setOrganizationDiscount(id: String, _ discount: OrganizationDiscount) async throws -> OrganizationDiscountResponse {
        try await call(StarlingsWorkRoutes.setOrganizationDiscount(id: id, discount))
    }
    func catalog() async throws -> [CatalogService] { try await call(StarlingsWorkRoutes.catalog()).services }
    func createService(_ create: ServiceCreate) async throws -> CatalogService { try await call(StarlingsWorkRoutes.createService(create)).service }
    func patchService(id: String, _ patch: ServicePatch) async throws -> CatalogService { try await call(StarlingsWorkRoutes.patchService(id: id, patch)).service }

    func createCrmSubject(_ draft: CrmSubjectDraft) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.createSubject(draft.create)).subject
    }

    /// Win a lead (ADR 0008 decisions 6-7): the Worker creates the project,
    /// moves the named open tasks, then closes the lead as won.
    func winLead(id: String, body: CrmLeadWin) async throws -> CrmLeadWinResponse {
        try await call(StarlingsWorkRoutes.winLead(id: id, body))
    }

    // MARK: - Workspace plan

    /// The workspace's plan, its project limit and the kept project. Any
    /// member reads it; Work draws the limit line and the read-only project
    /// from it.
    func workspacePlan() async throws -> WorkspacePlanResponse {
        try await call(StarlingsWorkRoutes.workspacePlan)
    }

    /// Root admins only, until billing sets the plan. meetctl's `plan set`.
    func setWorkspacePlan(_ plan: WorkspacePlanUpdateRequestPlan) async throws -> WorkspacePlanResponse {
        try await call(StarlingsWorkRoutes.setWorkspacePlan(plan))
    }

    /// An admin picks the one writable project on Free, once. meetctl's `plan keep`.
    func keepWorkspaceProject(id: String) async throws -> WorkspacePlanResponse {
        try await call(StarlingsWorkRoutes.keepWorkspaceProject(id: id))
    }

    func updateCrmSubject(
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        update: CrmSubjectUpdate
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.updateSubject(kind: kind, id: id, update)).subject
    }

    /// Choose who answers for a project or lead, or nil to clear the choice
    /// (docs/OWNERSHIP.md). Sends nothing else.
    func setCrmSubjectResponsible(
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        email: String?
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.setSubjectResponsible(kind: kind, id: id, email: email)).subject
    }

    /// Quick rename from a row menu. The narrow payload preserves metadata
    /// that the focused editor does not display.
    func renameCrmSubject(
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        title: String
    ) async throws -> CrmSubjectDetail {
        try await call(StarlingsWorkRoutes.renameSubject(kind: kind, id: id, title: title)).subject
    }

    /// A card dropped into another column of the Work board. As narrow as
    /// Rename, and for the same reason: the board shows a status, so a status
    /// is all it is allowed to write.
     /// Who work can be assigned to. Core is the roster, not the presence list —
    /// a colleague who has never opened Meet is still assignable work.
    func crmTeam() async throws -> [CrmTeamMember] {
        try await call(StarlingsWorkRoutes.team).members
    }

    /// Repositories available through Core's GitHub App, for the Work project
    /// link picker. Meet never receives a GitHub credential.
    func crmGithubRepos(query: String) async throws -> [CrmGithubRepo] {
        try await call(StarlingsWorkRoutes.githubRepos(query: query)).repos
    }

    /// The exact repository addresses linked to a project. The list is loaded
    /// when the project is opened so its header can name the real scope.
    func crmProjectRepos(projectID: String) async throws -> [CrmGithubRepo] {
        try await call(StarlingsWorkRoutes.projectRepos(projectID: projectID)).repos
    }

    func addCrmProjectRepo(_ create: CrmProjectRepoCreate) async throws -> CrmGithubRepo {
        try await call(StarlingsWorkRoutes.addProjectRepo(create)).repo
    }

    /// A project's GitHub issues, through the Worker and Core. Meet never holds
    /// a GitHub credential.
    /// `page` is per repository, which is the honest unit for a list merged
    /// from several of them: page two asks each linked repository for its
    /// second page, and the answers are merged the same way page one's were.
    func crmIssues(
        projectID: String,
        filter: CrmIssueFilter = CrmIssueFilter(),
        page: Int = 1
    ) async throws -> CrmIssuesResponse {
        try await call(StarlingsWorkRoutes.issues(projectID: projectID, filter: filter, page: page))
    }

    func crmIssue(owner: String, repo: String, number: Int) async throws -> CrmIssueDetail {
        try await call(StarlingsWorkRoutes.issue(owner: owner, repo: repo, number: number)).issue
    }

    /// One colleague's profile picture.
    ///
    /// Member-gated at the Worker, exactly like the roster it is drawn beside,
    /// and cached by version rather than by clock: `version` is that person's
    /// `avatarUpdatedAt`, so a URL either means the same bytes forever or is a
    /// different URL. A 404 is the ordinary answer for somebody who has no
    /// picture — `PersonAvatarStore` remembers it and draws initials.
    func personAvatar(email: String, version: Date) async throws -> Data {
        let route = StarlingsPeerRoutes.avatar(email: email, version: version)
        let request = try authorizedRequest(route)
        let (data, response) = try await exchange(request, operation: route.operation)
        try validate(response, data: data, operation: route.operation)
        return data
    }

    /// Your own picture, and only ever your own — the route takes no address.
    /// The bytes are already a square JPEG by the time they get here (see
    /// `StarlingsProfilePicture`), because the Worker stores what it is given.
    func uploadProfileAvatar(_ data: Data) async throws -> Date? {
        try await call(StarlingsSettingsRoutes.uploadAvatar(data)).updatedDate
    }

    func removeProfileAvatar() async throws {
        try await perform(StarlingsSettingsRoutes.removeAvatar)
    }

    /// Somebody's GitHub picture, through the Worker rather than from the CDN.
    ///
    /// The bytes are public; who asks for them is not. Fetching directly would
    /// tell `avatars.githubusercontent.com` this Mac's address and, from the
    /// pattern of requests, roughly which issues are being read. Every other
    /// GitHub call in this app already goes through the Worker.
    func githubAvatar(url: String, size: Int) async throws -> Data {
        let route = StarlingsWorkRoutes.githubAvatar(url: url, size: size)
        let request = try authorizedRequest(route)
        let (data, response) = try await exchange(request, operation: route.operation)
        try validate(response, data: data, operation: route.operation)
        return data
    }

    /// What an issue in this repository could be set to. Asked once per
    /// repository and reused, so opening issue after issue costs nothing.
    func crmIssueFacets(owner: String, repo: String) async throws -> CrmIssueFacets {
        try await call(StarlingsWorkRoutes.issueFacets(owner: owner, repo: repo))
    }

    func createCrmIssue(_ create: CrmIssueCreate) async throws -> CrmIssue {
        try await call(StarlingsWorkRoutes.createIssue(create)).issue
    }

    func updateCrmIssue(_ update: CrmIssueUpdate) async throws -> CrmIssueDetail {
        try await call(StarlingsWorkRoutes.updateIssue(update)).issue
    }

    /// Everything you owe, across every subject.
    static let mineSnapshotKey = StarlingsSnapshotKey.mine
    /// INBOX ( slice 2b). Per person, like `crm/mine`.
    static let inboxSnapshotKey = StarlingsSnapshotKey.inbox
    /// Every filtered subjects page invalidates together: a rename or a status
    /// change moves a row between pages, and there is no telling which.
    static let subjectsSnapshotPrefix = StarlingsSnapshotKey.subjects
    /// One subject's task list and history, per subject. A task write
    /// invalidates every `crm/tasks` page: a task can move between subjects.
    static let tasksSnapshotPrefix = StarlingsSnapshotKey.tasks
    static let interactionsSnapshotPrefix = StarlingsSnapshotKey.interactions

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

    /// One search: every hit the Worker can see, in the contract's
    /// order. `timeZone` is this device's, for the clock on an event row.
    func search(query: String, timeZone: String) async throws -> SearchAnswer {
        SearchAnswer(try await call(StarlingsWorkRoutes.search(query: query, timeZone: timeZone)))
    }

    func crmMyWork() async throws -> CrmMyWorkResponse {
        try await call(StarlingsWorkRoutes.mine)
    }

    /// Your own task completions and closed GitHub issues from the last week.
    func crmUnownedWork() async throws -> CrmUnownedWorkResponse {
        try await call(StarlingsWorkRoutes.unowned)
    }

    func crmRecentlyClosedWork() async throws -> CrmRecentlyClosedWorkResponse {
        try await call(StarlingsWorkRoutes.recentlyClosed)
    }

    /// What one colleague owes, across every subject.
    ///
    /// The same read as `crmMyWork`, pointed at somebody else. The Worker
    /// checks the address is on the team before it asks Core — a task in the
    /// company CRM is company work, and "who owes what" is exactly the
    /// question a person surface exists to answer.
    func crmWork(assigneeEmail: String) async throws -> CrmMyWorkResponse {
        try await call(StarlingsWorkRoutes.work(assigneeEmail: assigneeEmail))
    }

    /// Say who you are on GitHub. Only ever your own record — the Worker takes
    /// the address from the session.
    @discardableResult
    func setCrmGithubLogin(_ login: String?) async throws -> String? {
        try await call(StarlingsWorkRoutes.setGithubLogin(login)).githubLogin
    }

    /// Tell an agent to stop working a card taken back on the board. The
    /// card moved anyway; the outcome is what the runtime knows.
    func cancelAgent(email: String, ref: ThreadMessageRef) async throws -> AgentCancelOutcome {
        let response = try await call(StarlingsThreadRoutes.cancelAgent(email: email, ref: ref))
        switch response.delivery {
        case "accepted": return .accepted
        case "failed": return .failed
        case "no_runtime": return .noRuntime
        default: return response.told ? .accepted : .noRuntime
        }
    }

    /// Every open card on every subject, for the board. One read; the Worker
    /// does the fan-out and names what it could not reach. `projectID` reads
    /// one project's board instead.
    func crmBoard(projectID: String? = nil) async throws -> CrmBoardResponse {
        try await call(StarlingsWorkRoutes.board(projectID: projectID))
    }

    func crmTasks(projectID: String?, leadID: String?, eventID: String? = nil, organizationID: String? = nil, meetingID: String? = nil) async throws -> [CrmTask] {
        try await call(StarlingsWorkRoutes.tasks(
            projectID: projectID, leadID: leadID, eventID: eventID, organizationID: organizationID, meetingID: meetingID
        )).tasks
    }

    /// A task selected from a cross-subject list, where its summary is all the
    /// reader has. The Worker resolves the full row by id so the inspector can
    /// edit the same record without first opening its subject.
    func crmTask(id: String) async throws -> CrmTask {
        CrmTask(wire: try await call(StarlingsWorkRoutes.task(id: id)).task)
    }

    /// The Sales inbox: CRM touches with no Meet subject yet (docs/WORK.md,
    ///). Dismissed rows are left out unless asked for.
    func crmSalesInbox(includeDismissed: Bool = false) async throws -> SalesInboxResponse {
        try await call(StarlingsWorkRoutes.salesInbox(includeDismissed: includeDismissed))
    }

    /// An INBOX item with no other resolution (`booking:*`): dismiss (POST)
    /// or undo (DELETE).
    func setInboxItemDismissed(key: String, dismissed: Bool) async throws {
        try await perform(StarlingsWorkRoutes.setInboxItemDismissed(key: key, dismissed: dismissed))
    }

    /// Dismiss (POST) or undo (DELETE) one touch — same row, same id.
    func setSalesInboxDismissed(id: String, dismissed: Bool) async throws {
        try await perform(StarlingsWorkRoutes.setSalesInboxDismissed(id: id, dismissed: dismissed))
    }

    /// What happened recently across every open subject — docs/TIMELINE.md
    /// Phase 3. Members only, same fan-out the board makes; `partial` names
    /// the subjects the Worker could not read rather than failing the whole
    /// list.
     /// INBOX: things with a resolution, merged across sources, and the tail of
    /// what happened on the subjects you follow ( slice 2b).
    /// After the call: approve one draft revision. The ticked tasks
    /// are accepted, the rest declined; the answer is the mail draft.
    func approveFollowUp(_ item: InboxFollowUpItem, accept: [String], decline: [String]) async throws -> MeetingFollowUpApproveResponse {
        try await call(StarlingsWorkRoutes.approveFollowUp(item, accept: accept, decline: decline))
    }

    /// The host does not want the follow-up; its tasks stay in INBOX.
    func dismissFollowUp(_ item: InboxFollowUpItem) async throws {
        try await perform(StarlingsWorkRoutes.dismissFollowUp(item))
    }

    /// Read the canonical request with its source permissions.
    func attentionRequest(id: String) async throws -> AttentionRequest {
        try await call(StarlingsWorkRoutes.attentionRequest(id: id))
    }

    func resolveAttention(id: String, command: AttentionResolveInput) async throws -> AttentionResolveResponse {
        try await call(StarlingsWorkRoutes.resolveAttention(id: id, command))
    }

    /// INBOX: one owner queue, with native question controls enabled.
    func crmInbox() async throws -> WorkInboxResponse {
        try await call(StarlingsWorkRoutes.inbox)
    }

    /// Per-user subject state — star, mute, and the SALES opt-in (
    /// decision 5). Overrides plus this person's Sales opt-in.
    func crmSubjectState() async throws -> SubjectStateResponse {
        try await call(StarlingsWorkRoutes.subjectState)
    }

    static let subjectStateSnapshotKey = StarlingsSnapshotKey.subjectState

    /// The things this person starred, as search rows, newest star first —
    /// Home's QUICK ACCESS list. The Worker resolves each one through its owning
    /// service. Snapshotted: a cold Home draws the last answer first.
    func crmStarred() async throws -> SearchAnswer {
        SearchAnswer(try await call(StarlingsWorkRoutes.starred))
    }

    static let starredSnapshotKey = StarlingsSnapshotKey.starred

    func crmFavorites() async throws -> [FavoriteRow] {
        try await call(StarlingsWorkRoutes.favorites).favorites
    }

    func crmSetFavorite(_ target: FavoriteTarget, starred: Bool) async throws {
        if starred {
            _ = try await call(StarlingsWorkRoutes.addFavorite(target))
        } else {
            _ = try await call(StarlingsWorkRoutes.removeFavorite(target))
        }
    }

    /// Only the keys sent change. The Worker answers with the row as stored,
    /// or nil when it now says nothing the default would not.
    func crmSetSubjectState(
        kind: MeetingCategoryKind.SubjectKind,
        id: String,
        update: SubjectStateUpdate
    ) async throws -> SubjectStateRow? {
        try await call(StarlingsWorkRoutes.setSubjectState(kind: kind, id: id, update)).state
    }

    /// The SALES opt-in. Answers with the whole state, because turning Sales
    /// on changes which leads are listed.
    func crmSetWorkPreferences(salesEnabled: Bool) async throws -> SubjectStateResponse {
        try await crmSetWorkPreferences(WorkPreferencesUpdate(salesEnabled: salesEnabled), operation: String(localized: "Couldn’t change Sales"))
    }

    /// Which subject kinds you hide in Work, sent whole.
    func crmSetWorkPreferences(hiddenKinds: [String]) async throws -> SubjectStateResponse {
        try await crmSetWorkPreferences(
            WorkPreferencesUpdate(hiddenKinds: hiddenKinds.map(WorkPreferencesUpdateHiddenKindsItem.init(rawValue:))),
            operation: String(localized: "Couldn’t change Work")
        )
    }

    /// How the SUBJECTS list reads, for every surface at once.
    func crmSetWorkPreferences(workList: WorkListPreferences) async throws -> SubjectStateResponse {
        try await crmSetWorkPreferences(WorkPreferencesUpdate(workList: workList.wire), operation: String(localized: "Couldn’t change the list"))
    }

    /// Which INBOX sources you want, sent whole.
    func crmSetWorkPreferences(inboxSources: [String: Bool]) async throws -> SubjectStateResponse {
        try await crmSetWorkPreferences(WorkPreferencesUpdate(inboxSources: inboxSources), operation: String(localized: "Couldn’t change Inbox"))
    }

    /// The Board columns you hide, sent whole.
    func crmSetWorkPreferences(boardHiddenStages: Set<WorkStage>) async throws -> SubjectStateResponse {
        try await crmSetWorkPreferences(
            WorkPreferencesUpdate(boardHiddenStages: WorkStage.allCases.filter(boardHiddenStages.contains).map { WorkPreferencesUpdateBoardHiddenStagesItem(rawValue: $0.rawValue) }),
            operation: String(localized: "Couldn’t change the board")
        )
    }

    private func crmSetWorkPreferences(_ update: WorkPreferencesUpdate, operation: String) async throws -> SubjectStateResponse {
        try await call(StarlingsWorkRoutes.setWorkPreferences(update, operation: operation))
    }

    /// Durable CRM interactions filed under one project or lead. The Worker
    /// returns a compact projection; the full Core record stays behind the
    /// owner-authenticated boundary.
    /// Exactly one of the three: a partner's history is everything filed under
    /// its organization (PARTNERS (HQ Docs)).
    func crmInteractions(projectID: String?, leadID: String?, organizationID: String? = nil) async throws -> [CrmInteraction] {
        try await call(StarlingsWorkRoutes.interactions(projectID: projectID, leadID: leadID, organizationID: organizationID)).interactions
    }

    /// Log a call, meeting or note by hand.
    func createInteraction(_ create: CrmInteractionCreate) async throws -> CrmInteraction {
        try await call(StarlingsWorkRoutes.createInteraction(create)).interaction
    }

    func updateInteraction(id: String, update: CrmInteractionUpdate) async throws -> CrmInteraction {
        try await call(StarlingsWorkRoutes.updateInteraction(id: id, update)).interaction
    }

    /// 404 when it is gone; 403 without the write right on its subject.
    func deleteInteraction(id: String) async throws {
        _ = try await call(StarlingsWorkRoutes.deleteInteraction(id: id))
    }

    /// What a pasted link points at, read by the Worker rather than by this
    /// Mac. The privacy reason is in `LinkPreview`; the short version is that a
    /// client fetching its own links tells every site anybody pastes the
    /// address of everyone who was in the room.
    func linkPreview(url link: String) async throws -> LinkPreview {
        try await call(StarlingsThreadRoutes.linkPreview(url: link)).preview
    }

    // Goals and decisions (#262). Read live, like issues: a
    // subject's list is short and read on open.

    func crmGoals(projectID: String, includeClosed: Bool = false) async throws -> [CrmGoal] {
        try await call(StarlingsWorkRoutes.goals(projectID: projectID, includeClosed: includeClosed)).goals
    }

    func createCrmGoal(_ create: CrmGoalCreate) async throws -> CrmGoal {
        try await call(StarlingsWorkRoutes.createGoal(create)).goal
    }

    func updateCrmGoal(id: String, update: CrmGoalUpdate) async throws -> CrmGoal {
        try await call(StarlingsWorkRoutes.updateGoal(id: id, update)).goal
    }

    func crmDecisions(subjectKind: String, subjectID: String) async throws -> [CrmDecision] {
        try await call(StarlingsWorkRoutes.decisions(subjectKind: subjectKind, subjectID: subjectID)).decisions
    }

    /// Answer a decision waiting on you (docs/help/howto/answer-a-decision.md).
    /// The same answer again is safe: it only retries the Core record.
    func answerDecisionAsk(id: String, answer: String, note: String?) async throws -> DecisionAsk {
        try await call(StarlingsWorkRoutes.answerDecisionAsk(id: id, answer: answer, note: note)).ask
    }

    func createCrmDecision(_ create: CrmDecisionCreate) async throws -> CrmDecision {
        try await call(StarlingsWorkRoutes.createDecision(create)).decision
    }

    func createCrmTask(_ create: CrmTaskCreate) async throws -> CrmTask {
        try await call(StarlingsWorkRoutes.createTask(create)).task
    }

    /// Quick Notes are private, owner-scoped capture until Work triage gives
    /// one a subject and promotes it to a Core task, GitHub issue, or note.
    /// Snapshotted (docs/CACHING.md): Home's QUICK NOTES paints the last
    /// list before the first poll answers. A create or delete invalidates.
    static let quickNotesSnapshotKey = StarlingsSnapshotKey.quickNotes

    func quickNotes() async throws -> [QuickNote] {
        try await call(StarlingsWorkRoutes.quickNotes).notes
    }

    func createQuickNote(_ create: QuickNoteCreate) async throws -> QuickNote {
        try await call(StarlingsWorkRoutes.createQuickNote(create)).note
    }

    /// Rewrite the body; the note keeps its place, state and filing.
    func updateQuickNote(id: String, body: String) async throws -> QuickNote {
        try await call(StarlingsWorkRoutes.updateQuickNote(id: id, body: body)).note
    }

    // MARK: - Connected agents (docs/MCP.md)

    /// The person's own live pairings.
    func mcpGrants() async throws -> [McpGrant] {
        try await call(StarlingsSettingsRoutes.mcpGrants).grants
    }

    /// One pairing's record, newest first.
    func mcpGrantCalls(id: String) async throws -> [McpCallEntry] {
        try await call(StarlingsSettingsRoutes.mcpGrantCalls(id: id)).calls
    }

    /// Revoke in place; answers the pairings that remain.
    func revokeMcpGrant(id: String) async throws -> [McpGrant] {
        try await call(StarlingsSettingsRoutes.revokeMcpGrant(id: id)).grants
    }

    /// Pause or resume one pairing; answers the live pairings.
    func setMcpGrantPaused(id: String, paused: Bool) async throws -> [McpGrant] {
        try await call(StarlingsSettingsRoutes.setMcpGrantPaused(id: id, paused: paused)).grants
    }

    // MARK: - Devices (docs/ADMIN.md §5a)

    /// The person's signed-in Macs and phones, this one marked.
    func ownerDevices() async throws -> [OwnerDevice] {
        try await call(StarlingsSettingsRoutes.devices).devices
    }

    /// Sign one device out. Its row goes, so its tokens are refused from its
    /// next request. Answers the devices that remain.
    func revokeOwnerDevice(deviceID: String) async throws -> [OwnerDevice] {
        try await call(StarlingsSettingsRoutes.revokeDevice(deviceID: deviceID)).devices
    }

    /// Sign-out's first step: drop this Mac's row before the Keychain is
    /// cleared. The request is built now, while the session is still there,
    /// and sent without waiting — a Mac that is offline still signs out.
    func revokeOwnDeviceBestEffort(deviceID: String) {
        guard let request = try? authorizedRequest(StarlingsSettingsRoutes.revokeDevice(deviceID: deviceID)) else { return }
        let transport = httpTransport
        Task.detached(priority: .utility) {
            _ = try? await transport.data(for: request)
        }
    }

    func deleteQuickNote(id: String) async throws {
        try await perform(StarlingsWorkRoutes.deleteQuickNote(id: id))
    }

    /// Record where a note went. The thing it points at already exists; a
    /// retry of the same promotion is a no-op on the Worker.
    func promoteQuickNote(id: String, _ promote: QuickNotePromote) async throws -> QuickNote {
        try await call(StarlingsWorkRoutes.promoteQuickNote(id: id, promote)).note
    }

    /// One MetricKit payload for `POST /api/diagnostics`. Owner
    /// session only: a Mac nobody signed in to sends nothing.
    func sendDiagnosticReport(_ report: DiagnosticReport) async throws {
        try await perform(StarlingsSettingsRoutes.diagnosticReport(report))
    }

    func updateCrmTask(id: String, update: CrmTaskUpdate) async throws -> CrmTask {
        try await call(StarlingsWorkRoutes.updateTask(id: id, update)).task
    }

    /// A Core personal access token for the signed-in owner, brokered by the
    /// Worker (`POST /api/core/token`). What lets this Mac read Core's
    /// registry directly — everything in Core, not only the projects and leads
    /// the Worker projects. Keychain only; never logged.
    func coreToken(deviceName: String) async throws -> CoreToken {
        try await call(StarlingsWorkRoutes.coreToken(deviceName: deviceName))
    }

    /// A Keep device token for the signed-in owner, brokered the same way.
    func keepToken(deviceName: String) async throws -> KeepToken {
        try await call(StarlingsDocsRoutes.keepToken(deviceName: deviceName))
    }



    /// A signed-out Keychain reads as "Sign in first", as it did before the
    /// transport built these requests.
    private func ownerRequest(_ build: () throws -> URLRequest) throws -> URLRequest {
        do {
            return try build()
        } catch let failure as StarlingsHTTPFailure {
            throw StarlingsError.http(failure, operation: "")
        }
    }

    /// A shared route (`StarlingsRoute`) as an owner-session request. A write
    /// that names no body sends `{}`, as every Mac write always has.
    private func authorizedRequest<Answer>(_ route: StarlingsRoute<Answer>) throws -> URLRequest {
        try ownerRequest {
            try httpTransport.request(route, bearer: ownerSessionStore, emptyWriteBody: true)
        }
    }

    /// Sends a shared route and decodes its answer: through the snapshot when
    /// the policy table says the Mac keeps the route's, otherwise live,
    /// marking what a write made stale.
    private func call<Answer: Decodable & Sendable>(_ route: StarlingsRoute<Answer>) async throws -> Answer {
        let request = try authorizedRequest(route)
        if let key = route.snapshotKey, StarlingsRequestPolicy.keeps(key, client: .mac) {
            return try await sendSnapshotting(request, as: Answer.self, operation: route.operation, key: key)
        }
        return try await send(request, as: Answer.self, operation: route.operation, stale: staleSnapshots(route.writes))
    }

    /// A shared route sent with another bearer than the owner session: a
    /// lobby token, a meeting's artifact token, or none for a guest.
    private func call<Answer: Decodable & Sendable>(
        _ route: StarlingsRoute<Answer>,
        bearer: (any StarlingsBearerSource)?
    ) async throws -> Answer {
        let request = try httpTransport.request(route, bearer: bearer, emptyWriteBody: true)
        return try await send(request, as: Answer.self, operation: route.operation, stale: staleSnapshots(route.writes))
    }

    private func perform<Answer>(_ route: StarlingsRoute<Answer>, bearer: (any StarlingsBearerSource)?) async throws {
        let request = try httpTransport.request(route, bearer: bearer, emptyWriteBody: true)
        try await sendWithoutResponse(request, operation: route.operation, stale: staleSnapshots(route.writes))
    }

    /// Sends a shared route whose answer this client does not read.
    private func perform<Answer>(_ route: StarlingsRoute<Answer>) async throws {
        try await sendWithoutResponse(try authorizedRequest(route), operation: route.operation, stale: staleSnapshots(route.writes))
    }

    /// `operation` is the sentence the user reads as the title when this call
    /// fails — "Couldn't admit that guest", not the URL or the status code.
    // MARK: - Snapshots (docs/CACHING.md)

    /// The signed-in owner's address, for stores keyed per owner on this
    /// device. Nil when nobody is signed in.
    var signedInOwnerEmail: String? {
        (try? ownerSessionStore.load())?.owner.email
    }

    /// The last good copy of a list read, decoded, or nil when none is usable.
    /// Callers paint this first and refresh behind it. Keyed by the signed-in
    /// owner, so a different sign-in never sees the previous person's work.
    func snapshot<T: Decodable>(_ key: String, as type: T.Type) -> (value: T, savedAt: Date)? {
        guard let owner = snapshotOwner?() ?? (try? ownerSessionStore.load())?.owner.email,
              let snapshot = SnapshotStore.load(key: key, owner: owner),
              let value = try? JSONDecoder().decode(T.self, from: snapshot.data)
        else { return nil }
        return (value, snapshot.savedAt)
    }

    /// The lists a write made stale, for the signed-in owner. The call names
    /// the write (`StarlingsSnapshotWrite`), the policy table says which lists it
    /// clears, and the transport marks them after a 2xx answer, so no screen
    /// and no API method has to remember which lists a task edit touches; see
    /// docs/CACHING.md §Invalidation and `StarlingsRequestPolicy`.
    private func staleSnapshots(_ write: StarlingsSnapshotWrite?) -> StarlingsStaleSnapshots? {
        StarlingsStaleSnapshots(owner: signedInOwnerEmail, write: write)
    }

    private func staleSnapshots(_ writes: [StarlingsSnapshotWrite]) -> StarlingsStaleSnapshots? {
        StarlingsStaleSnapshots(owner: signedInOwnerEmail, writes: writes)
    }

    /// `send`, plus: the raw body is kept as the snapshot for `key`, and two
    /// concurrent reads of the same key share one request. The mechanics are
    /// `StarlingsHTTPTransport.readSnapshotting`, the same on the phone; this side
    /// supplies the send, with its session renewal and its error words.
    private func sendSnapshotting<T: Decodable & Sendable>(
        _ request: URLRequest,
        as type: T.Type,
        operation: String,
        key: String
    ) async throws -> T {
        let owner = (try? ownerSessionStore.load())?.owner.email ?? ""
        return try await StarlingsHTTPTransport.readSnapshotting(
            request: request,
            key: key,
            owner: owner,
            fetch: { [self] request in
                let (data, response) = try await exchange(request, operation: operation)
                guard let http = response as? HTTPURLResponse else {
                    throw StarlingsError.invalidResponse(operation: operation)
                }
                // A 304 answers the validator this request sent; it is no failure.
                if http.statusCode != 304 { try validate(response, data: data, operation: operation) }
                return (data, http)
            },
            decode: { data in try decode(T.self, from: data, operation: operation, request: request) }
        )
    }

    private func send<T: Decodable & Sendable>(
        _ request: URLRequest,
        as type: T.Type,
        operation: String,
        invalidating write: StarlingsSnapshotWrite? = nil,
        stale: StarlingsStaleSnapshots? = nil
    ) async throws -> T {
        try await decoded(
            type,
            sending: request,
            operation: operation,
            invalidating: write,
            stale: stale
        )
    }

    private func decoded<T: Decodable>(
        _ type: T.Type,
        sending request: URLRequest,
        operation: String,
        invalidating write: StarlingsSnapshotWrite? = nil,
        stale: StarlingsStaleSnapshots? = nil
    ) async throws -> T {
        let (data, response) = try await exchange(request, operation: operation)
        return try decoded(type, response: response, data: data, operation: operation, request: request, invalidating: write, stale: stale)
    }

    /// Checks the status, marks what the write made stale, then decodes.
    private func decoded<T: Decodable>(
        _ type: T.Type,
        response: URLResponse,
        data: Data,
        operation: String,
        request: URLRequest,
        invalidating write: StarlingsSnapshotWrite? = nil,
        stale: StarlingsStaleSnapshots? = nil
    ) throws -> T {
        try validate(response, data: data, operation: operation, invalidating: write, stale: stale)
        return try decode(type, from: data, operation: operation, request: request)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data, operation: String, request: URLRequest? = nil) throws -> T {
        do {
            return try StarlingsHTTPTransport.decode(type, from: data)
        } catch let failure as StarlingsHTTPFailure {
            if let request { StarlingsDiagnosticsLog.captureDecodeFailure(request: request, using: httpTransport) }
            throw StarlingsError.http(failure, operation: operation)
        }
    }

    private func sendWithoutResponse(
        _ request: URLRequest,
        operation: String,
        invalidating write: StarlingsSnapshotWrite? = nil,
        stale: StarlingsStaleSnapshots? = nil
    ) async throws {
        let (data, response) = try await exchange(request, operation: operation)
        try validate(response, data: data, operation: operation, invalidating: write, stale: stale)
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

    /// `transport`, plus the owner-session replay the shared transport does
    /// (`StarlingsHTTPTransport.ownerData`): a stale owner JWT is renewed and
    /// the request sent once more. Only a renewal the Worker refuses reaches
    /// the caller, as "Sign in again".
    private func exchange(_ request: URLRequest, operation: String) async throws -> (Data, URLResponse) {
        do {
            let answer = try await httpTransport.ownerData(for: request)
            return (answer.data, answer.http)
        } catch let failure as StarlingsHTTPFailure {
            throw StarlingsError.http(failure, operation: operation)
        }
    }

    private func validate(
        _ response: URLResponse,
        data: Data,
        operation: String,
        invalidating write: StarlingsSnapshotWrite? = nil,
        stale: StarlingsStaleSnapshots? = nil
    ) throws {
        guard let http = response as? HTTPURLResponse else {
            throw StarlingsError.invalidResponse(operation: operation)
        }
        do {
            try httpTransport.accept(http, data: data, stale: stale ?? staleSnapshots(write))
        } catch let failure as StarlingsHTTPFailure {
            throw StarlingsError.http(failure, operation: operation)
        }
    }
}

extension OwnerSessionStore: StarlingsBearerSource {
    var isMeetOwnerSession: Bool { true }

    func meetBearerToken() throws -> String? {
        try load()?.accessToken
    }
}

/// What the runtime knows after a cancel. The card moved in every
/// case; only the second says the run may still be going.
enum AgentCancelOutcome {
    case accepted
    case failed
    case noRuntime
}

/// What one message's reaction rail became after a toggle. Read back rather
/// than guessed: whether a press added or removed is the server's answer, and
/// a client that assumed would drift the moment two people pressed at once.

/// Every requirement is already implemented above, with the same signatures the
/// protocol declares — the default arguments the Mac call sites rely on do not
/// change what it satisfies.
extension MeetingControlAPI: CalendarBackend {}

/// The artifact outbox is shared with the phone, so it speaks in room and
/// meeting strings. `MeetingContext` carries an artifact token and a role that
/// neither upload needs — both routes authorize on the owner session.
extension MeetingControlAPI: TranscriptUploading {
    func appendTranscript(room: String, meetingID: String, segments: [TranscriptSegment]) async throws {
        guard let slug = RoomSlug(rawValue: room) else { return }
        try await appendTranscript(
            context: MeetingContext(room: slug, meetingID: meetingID, artifactToken: ""),
            segments: segments
        )
    }

    func finalizeMeeting(room: String, meetingID: String) async throws {
        guard let slug = RoomSlug(rawValue: room) else { return }
        try await finalize(context: MeetingContext(room: slug, meetingID: meetingID, artifactToken: ""))
    }
}
