import Foundation
import StarlingsContracts

/// The iOS half of `CalendarBackend`.
///
/// Same endpoints, same bodies, same decoders as the Mac client — the only
/// difference is where the owner token comes from, which is exactly why the
/// protocol exists. Everything above this line (`CalendarWorkspace` and the week
/// math it drives) is then literally the same code on both platforms.
struct MobileCalendarBackend: CalendarBackend {
    let environment: StarlingsEnvironment
    let credentials: MobileOwnerCredentials
    let session: URLSession

    init(
        environment: StarlingsEnvironment = .configured(),
        credentials: MobileOwnerCredentials,
        session: URLSession = .shared
    ) {
        self.environment = environment
        self.credentials = credentials
        self.session = session
    }

    func calendarStatus() async throws -> CalendarConnectionStatus {
        try await call(StarlingsCalendarRoutes.status)
    }

    func listCalendars() async throws -> [GoogleCalendarListEntry] {
        try await call(StarlingsCalendarRoutes.calendars).calendars
    }

    func calendarPreferences() async throws -> CalendarPreferences {
        CalendarPreferences(wire: try await call(StarlingsCalendarRoutes.preferences))
    }

    func setSelectedCalendarIds(_ ids: [String]) async throws -> CalendarPreferences {
        try await putPreferences(.init(selectedCalendarIDs: ids))
    }

    func setUpcomingExcludedSubscriptionIds(_ ids: [String]) async throws -> CalendarPreferences {
        try await putPreferences(.init(upcomingExcludedSubscriptionIDs: ids))
    }

    func setHiddenCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences {
        try await putPreferences(.init(hiddenCalendarKeys: keys))
    }

    func setDisabledCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences {
        try await putPreferences(.init(disabledCalendarKeys: keys))
    }

    func setDemotedEventKeys(_ keys: [String]) async throws -> CalendarPreferences {
        try await putPreferences(.init(demotedEventKeys: keys))
    }

    func setIncludesLocalCalendars(_ included: Bool) async throws -> CalendarPreferences {
        try await putPreferences(.init(includesLocalCalendars: included))
    }

    func setUpcomingPreferences(_ preferences: UpcomingPreferencesWire) async throws -> CalendarPreferences {
        try await putPreferences(.init(upcoming: preferences))
    }

    func setEventSubjects(_ subjects: [String: CrmSubject]) async throws -> CalendarPreferences {
        try await putPreferences(.init(eventSubjects: subjects.mapValues(\.calendarEventSubject)))
    }

    /// Same route Work and the filing sheet search; one client for it.
    func crmSubjects(kind: MeetingCategoryKind.SubjectKind, query: String) async throws -> [CrmSubject] {
        try await StarlingsAPI(environment: environment).crmSubjects(credentials: credentials, kind: kind, query: query)
    }

    private func putPreferences(_ update: CalendarPreferencesUpdate) async throws -> CalendarPreferences {
        CalendarPreferences(wire: try await call(StarlingsCalendarRoutes.savePreferences(update)))
    }

    func calendarAccounts() async throws -> [CalendarAccount] {
        try await call(StarlingsCalendarRoutes.accounts).accounts
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

    func calendarEvents(from start: Date, to end: Date) async throws -> [CalendarEventSummary] {
        try await call(StarlingsCalendarRoutes.events(from: start, to: end)).summaries
    }

    func calendarInvitations() async throws -> [CalendarEventSummary] {
        try await call(StarlingsCalendarRoutes.invitations).summaries
    }

    func quickAdd(_ request: CalendarQuickAddRequest) async throws -> CalendarQuickAddResponse {
        try await call(StarlingsCalendarRoutes.quickAdd(request))
    }

    func pendingCalendarEvents() async throws -> [ProposedCalendarEvent] {
        try await call(StarlingsCalendarRoutes.pending).events
    }

    func addPendingCalendarEvent(id: String) async throws -> CalendarEventSummary {
        try await call(StarlingsCalendarRoutes.addPending(id: id)).summary
    }

    func discardPendingCalendarEvent(id: String) async throws {
        try await perform(StarlingsCalendarRoutes.discardPending(id: id))
    }

    func calendarWorkItems(
        from start: Date,
        to end: Date,
        includeDone: Bool
    ) async throws -> [CalendarWorkItem] {
        try await call(StarlingsCalendarRoutes.workItems(from: start, to: end, includeDone: includeDone)).items
    }

    func calendarAvailability(from start: Date, to end: Date) async throws -> [CalendarAvailabilityBlock] {
        try await call(StarlingsCalendarRoutes.availability(from: start, to: end)).blocks
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

    func createCalendarEvent(
        title: String,
        start: Date,
        end: Date,
        joinURL: String?,
        roomSlug: String?,
        attendees: [String],
        description: String?,
        location: String?,
        timeZone: String?,
        calendarId: String?,
        travelTimeMinutes: Int?
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

    func patchCalendarEvent(
        calendarId: String,
        eventId: String,
        title: String,
        start: Date,
        end: Date,
        attendees: [String]?,
        timeZone: String?,
        joinURL: String?,
        roomSlug: String?,
        notes: String?,
        location: String?,
        travelTimeMinutes: Int?
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

    func deleteCalendarEvent(calendarId: String, eventId: String) async throws {
        try await perform(StarlingsCalendarRoutes.deleteEvent(CalendarEventDeleteRequest(calendarID: calendarId, eventID: eventId)))
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

    func mintCalendarBooking(
        title: String,
        start: Date,
        end: Date,
        roomSlug: String,
        joinURL: String?
    ) async throws -> CalendarBookingMintResponse {
        try await call(StarlingsCalendarRoutes.mintBooking(CalendarBookingMintRequest(
            title: title,
            start: start,
            end: end,
            roomSlug: roomSlug,
            joinURL: joinURL
        )))
    }

    /// The request for a shared route. The calendar reads a month at a time
    /// and the writes are one round trip, so every request here waits 20s
    /// unless the route names another time. It reads live: the phone keeps
    /// no calendar snapshot of its own here.
    private func request<Answer>(_ route: StarlingsRoute<Answer>) throws -> URLRequest {
        try StarlingsHTTPTransport(baseURL: environment.apiBaseURL, session: session, webOrigin: environment.webOrigin)
            .request(route, bearer: credentials, timeout: 20)
    }

    private func call<Answer: Decodable>(_ route: StarlingsRoute<Answer>) async throws -> Answer {
        try await send(request(route), as: Answer.self, operation: route.operation)
    }

    private func perform<Answer>(_ route: StarlingsRoute<Answer>) async throws {
        _ = try await sendWithoutResponse(request(route), operation: route.operation)
    }

    private func send<Response: Decodable>(
        _ request: URLRequest,
        as type: Response.Type,
        operation: String
    ) async throws -> Response {
        let data = try await sendWithoutResponse(request, operation: operation)
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw StarlingsError.local(String(localized: "\(operation). The response couldn’t be read."))
        }
    }

    @discardableResult
    private func sendWithoutResponse(_ request: URLRequest, operation: String) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let cancelled as URLError where cancelled.code == .cancelled {
            // Not a failure: the app moved on. The calendar tab going away or a
            // token changing under `.task(id:)` cancels whatever it was loading,
            // and URLSession reports that the same way it reports being offline.
            // Flattening the two is what put "Google events didn't refresh" in
            // front of owners whose calendar had in fact just drawn.
            throw CancellationError()
        } catch {
            throw StarlingsError.unreachable(error, operation: operation)
        }
        guard let http = response as? HTTPURLResponse else {
            throw StarlingsError.local(String(localized: "\(operation). The service returned an invalid response."))
        }
        StarlingsHTTPTransport.observeUpgradeRecommendation(for: request, response: http)
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(MobileCalendarErrorResponse.self, from: data)
            // Only a refused Meet sign-in is "sign in again". A 401 that says
            // `calendar_expired` or `calendar_failed` is Google's refusal, and
            // reads as the Worker wrote it.
            if body?.code == ControlErrorCodeValue.ownerAuthRequired.rawValue || (http.statusCode == 401 && body?.code == nil) {
                throw CalendarAuthenticationRequiredError()
            }
            throw StarlingsError.refusal(
                status: http.statusCode,
                serverCode: body?.code,
                serverMessage: body?.error,
                requestID: body?.requestID.flatMap(UUID.init(uuidString:))?.uuidString.lowercased(),
                operation: operation
            )
        }
        return data
    }
}

/// Stands in until the owner signs in or connects Google.
///
/// The calendar is still worth showing at that point — iCloud and on-device
/// calendars come from EventKit and owe the network nothing — so the workspace
/// gets a backend that answers "not connected" instead of one that fails.
struct DisconnectedCalendarBackend: CalendarBackend {
    /// Written for the person reading the alert, since the UI only offers these
    /// actions once the calendar is writable — reaching one means something got
    /// out of step, not that they did something wrong.
    private var signedOut: StarlingsError {
        StarlingsError.local(String(localized: "Connect Google Calendar to change events on it."))
    }

    func calendarStatus() async throws -> CalendarConnectionStatus {
        CalendarConnectionStatus(connected: false, email: nil)
    }

    func listCalendars() async throws -> [GoogleCalendarListEntry] { [] }

    /// Signed out, so there is no owner to have a preference. Throwing rather
    /// than answering empty is deliberate: an empty answer would read as "you
    /// hid nothing" and wipe the local copy, which is the one still deciding
    /// what the EventKit calendars do while signed out.
    func calendarPreferences() async throws -> CalendarPreferences {
        throw signedOut
    }

    func setSelectedCalendarIds(_ ids: [String]) async throws -> CalendarPreferences {
        throw signedOut
    }

    func setUpcomingExcludedSubscriptionIds(_ ids: [String]) async throws -> CalendarPreferences {
        throw signedOut
    }

    func setHiddenCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences {
        throw signedOut
    }

    func setDisabledCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences {
        throw signedOut
    }

    func setDemotedEventKeys(_ keys: [String]) async throws -> CalendarPreferences {
        throw signedOut
    }

    func setIncludesLocalCalendars(_ included: Bool) async throws -> CalendarPreferences {
        throw signedOut
    }

    func setUpcomingPreferences(_ preferences: UpcomingPreferencesWire) async throws -> CalendarPreferences {
        throw signedOut
    }

    func setEventSubjects(_ subjects: [String: CrmSubject]) async throws -> CalendarPreferences {
        throw signedOut
    }

    func crmSubjects(kind: MeetingCategoryKind.SubjectKind, query: String) async throws -> [CrmSubject] { [] }

    func calendarAccounts() async throws -> [CalendarAccount] { [] }

    func removeCalendarAccount(id: String) async throws { throw signedOut }

    func calendarSubscriptions() async throws -> [CalendarSubscription] { [] }

    func addCalendarSubscription(url: String, title: String?) async throws -> CalendarSubscription {
        throw signedOut
    }

    func removeCalendarSubscription(id: String) async throws { throw signedOut }

    func subscriptionEvents(from start: Date, to end: Date) async throws -> [SubscriptionEventSummary] { [] }

    func calendarEvents(from start: Date, to end: Date) async throws -> [CalendarEventSummary] { [] }

    func calendarInvitations() async throws -> [CalendarEventSummary] { [] }
    func quickAdd(_ request: CalendarQuickAddRequest) async throws -> CalendarQuickAddResponse { throw signedOut }
    func pendingCalendarEvents() async throws -> [ProposedCalendarEvent] { [] }
    func addPendingCalendarEvent(id: String) async throws -> CalendarEventSummary { throw signedOut }
    func discardPendingCalendarEvent(id: String) async throws { throw signedOut }

    func calendarWorkItems(
        from start: Date, to end: Date, includeDone: Bool
    ) async throws -> [CalendarWorkItem] { [] }

    func calendarAvailability(from start: Date, to end: Date) async throws -> [CalendarAvailabilityBlock] { [] }

    func calendarFreeBusy(
        from start: Date, to end: Date, emails: [String]
    ) async throws -> [CalendarFreeBusyPerson] { [] }

    func createCalendarEvent(
        title: String, start: Date, end: Date, joinURL: String?, roomSlug: String?,
        attendees: [String], description: String?, location: String?,
        timeZone: String?, calendarId: String?, travelTimeMinutes: Int?
    ) async throws -> CalendarEventSummary { throw signedOut }

    func patchCalendarEvent(
        calendarId: String, eventId: String, title: String, start: Date, end: Date,
        attendees: [String]?, timeZone: String?, joinURL: String?, roomSlug: String?,
        notes: String?, location: String?, travelTimeMinutes: Int?
    ) async throws -> CalendarEventSummary { throw signedOut }

    func deleteCalendarEvent(calendarId: String, eventId: String) async throws { throw signedOut }

    func moveCalendarEvent(
        calendarId: String, eventId: String, destinationId: String
    ) async throws -> CalendarEventSummary { throw signedOut }

    func respondToCalendarEvent(
        calendarId: String, eventId: String, response: CalendarRSVP
    ) async throws -> CalendarEventSummary { throw signedOut }

    func mintCalendarBooking(
        title: String, start: Date, end: Date, roomSlug: String, joinURL: String?
    ) async throws -> CalendarBookingMintResponse { throw signedOut }
}

private struct MobileCalendarErrorResponse: Decodable {
    let error: String?
    let code: String?
    let requestID: String?

    enum CodingKeys: String, CodingKey {
        case error
        case code
        case requestID = "request_id"
    }
}
