import XCTest
@testable import Starlings
import StarlingsContracts

/// Answers the reads a source refresh makes and refuses every write. State is
/// only ever set from the test's main-actor context before a call is made.
private final class StubCalendarBackend: CalendarBackend, @unchecked Sendable {
    struct Unused: Error {}

    var status = CalendarConnectionStatus(connected: false, email: nil)
    /// Thrown by the next status reads, one each, before `status` answers.
    var statusFailures: [any Error] = []
    private(set) var statusCalls = 0
    var listed: Result<[GoogleCalendarListEntry], any Error> = .success([])
    var accounts: [CalendarAccount] = []

    func calendarStatus() async throws -> CalendarConnectionStatus {
        statusCalls += 1
        if !statusFailures.isEmpty { throw statusFailures.removeFirst() }
        return status
    }
    func listCalendars() async throws -> [GoogleCalendarListEntry] { try listed.get() }
    func calendarPreferences() async throws -> CalendarPreferences { CalendarPreferences(selectedCalendarIds: ["primary"]) }
    func setSelectedCalendarIds(_ ids: [String]) async throws -> CalendarPreferences { throw Unused() }
    func setUpcomingExcludedSubscriptionIds(_ ids: [String]) async throws -> CalendarPreferences { throw Unused() }
    func setHiddenCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences { throw Unused() }
    func setDisabledCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences { throw Unused() }
    func setDemotedEventKeys(_ keys: [String]) async throws -> CalendarPreferences { throw Unused() }
    func setIncludesLocalCalendars(_ included: Bool) async throws -> CalendarPreferences { throw Unused() }
    func setUpcomingPreferences(_ preferences: UpcomingPreferencesWire) async throws -> CalendarPreferences { throw Unused() }
    func setEventSubjects(_ subjects: [String: CrmSubject]) async throws -> CalendarPreferences { throw Unused() }
    func crmSubjects(kind: MeetingCategoryKind.SubjectKind, query: String) async throws -> [CrmSubject] { [] }
    func calendarAccounts() async throws -> [CalendarAccount] { accounts }
    func removeCalendarAccount(id: String) async throws {}
    func calendarSubscriptions() async throws -> [CalendarSubscription] { [] }
    func addCalendarSubscription(url: String, title: String?) async throws -> CalendarSubscription { throw Unused() }
    func removeCalendarSubscription(id: String) async throws { throw Unused() }
    func subscriptionEvents(from start: Date, to end: Date) async throws -> [SubscriptionEventSummary] { [] }
    func calendarEvents(from start: Date, to end: Date) async throws -> [CalendarEventSummary] { [] }
    func calendarInvitations() async throws -> [CalendarEventSummary] { [] }
    func quickAdd(_ request: CalendarQuickAddRequest) async throws -> CalendarQuickAddResponse { throw StarlingsError.authenticationRequired() }
    func pendingCalendarEvents() async throws -> [ProposedCalendarEvent] { [] }
    func addPendingCalendarEvent(id: String) async throws -> CalendarEventSummary { throw StarlingsError.authenticationRequired() }
    func discardPendingCalendarEvent(id: String) async throws {}
    func calendarWorkItems(from start: Date, to end: Date, includeDone: Bool) async throws -> [CalendarWorkItem] { [] }
    func calendarAvailability(from start: Date, to end: Date) async throws -> [CalendarAvailabilityBlock] { [] }
    func calendarFreeBusy(from start: Date, to end: Date, emails: [String]) async throws -> [CalendarFreeBusyPerson] { [] }
    func createCalendarEvent(
        title: String, start: Date, end: Date, joinURL: String?, roomSlug: String?, attendees: [String],
        description: String?, location: String?, timeZone: String?, calendarId: String?, travelTimeMinutes: Int?
    ) async throws -> CalendarEventSummary { throw Unused() }
    func patchCalendarEvent(
        calendarId: String, eventId: String, title: String, start: Date, end: Date, attendees: [String]?,
        timeZone: String?, joinURL: String?, roomSlug: String?, notes: String?, location: String?, travelTimeMinutes: Int?
    ) async throws -> CalendarEventSummary { throw Unused() }
    func deleteCalendarEvent(calendarId: String, eventId: String) async throws { throw Unused() }
    func moveCalendarEvent(calendarId: String, eventId: String, destinationId: String) async throws -> CalendarEventSummary { throw Unused() }
    func respondToCalendarEvent(calendarId: String, eventId: String, response: CalendarRSVP) async throws -> CalendarEventSummary { throw Unused() }
    func mintCalendarBooking(title: String, start: Date, end: Date, roomSlug: String, joinURL: String?) async throws -> CalendarBookingMintResponse { throw Unused() }
}

/// What a connect is allowed to outrank, and for how long. The Worker keeps
/// calendar tokens in KV, which can answer a status read from before the
/// token was written — see `CalendarSourcePreferences.googleConnectionGrace`.
@MainActor
final class CalendarConnectionTests: XCTestCase {
    private var suite = ""
    private var defaults = UserDefaults.standard

    private static let ownerEmail = "rosa@example.com"
    private static let primary = GoogleCalendarListEntry(
        id: "primary", summary: "Rosa", primary: true, selected: true,
        accountID: CalendarAccount.primaryID, accountEmail: ownerEmail
    )
    private static let personal = GoogleCalendarListEntry(
        id: "acct:abc:primary", summary: "Home", accountID: "abc", accountEmail: "casa@gmail.com"
    )
    private static let primaryAccount = CalendarAccount(id: CalendarAccount.primaryID, email: ownerEmail, primary: true)

    // The async overrides, because XCTest's synchronous ones are nonisolated
    // and this class's state is not.
    override func setUp() async throws {
        try await super.setUp()
        suite = "CalendarConnectionTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        try await super.tearDown()
    }

    private func makeWorkspace(_ backend: StubCalendarBackend, clock: @escaping () -> Date) -> CalendarWorkspace {
        let workspace = CalendarWorkspace(backend: backend, defaults: defaults)
        workspace.now = clock
        return workspace
    }

    func testAStaleStatusDoesNotUndoAConnect() async {
        let backend = StubCalendarBackend()
        backend.status = CalendarConnectionStatus(connected: false, email: nil)
        backend.listed = .failure(StarlingsError(
            code: "calendar.not_connected", title: "Not connected",
            message: "Connect Google Calendar in Settings first.", severity: .notice
        ))
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let workspace = makeWorkspace(backend) { clock }

        workspace.noteGoogleConnected(CalendarConnectionStatus(connected: true, email: Self.ownerEmail, calendars: [Self.primary]))
        XCTAssertTrue(workspace.googleConnected)
        XCTAssertEqual(workspace.calendars.map(\.id), ["g:primary"])
        XCTAssertEqual(workspace.calendars.map(\.groupTitle), ["Google"])

        await workspace.refreshSources()
        XCTAssertTrue(workspace.googleConnected, "a miss KV cached before the write is not a disconnect")
        XCTAssertEqual(workspace.calendars.map(\.id), ["g:primary"])
        XCTAssertNil(workspace.lastError, "and it is not an error worth a status line either")

        clock = clock.addingTimeInterval(CalendarSourcePreferences.googleConnectionGrace + 1)
        await workspace.refreshSources()
        XCTAssertFalse(workspace.googleConnected, "past the grace, the status is believed again")
        XCTAssertTrue(workspace.calendars.isEmpty)
    }

    func testAStaleListingKeepsTheAccountJustAdded() async {
        let backend = StubCalendarBackend()
        backend.status = CalendarConnectionStatus(connected: true, email: Self.ownerEmail)
        backend.listed = .success([Self.primary])
        backend.accounts = [Self.primaryAccount]
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let workspace = makeWorkspace(backend) { clock }

        workspace.noteGoogleAccountAdded(CalendarAccount(id: "abc", email: "casa@gmail.com", primary: false), calendars: [Self.personal])
        await workspace.refreshSources()
        XCTAssertEqual(Set(workspace.calendars.map(\.id)), ["g:primary", "g:acct:abc:primary"])
        XCTAssertEqual(workspace.googleAccounts.map(\.id), [CalendarAccount.primaryID, "abc"])
        // Two accounts: the sidebar tells their calendars apart by address.
        XCTAssertEqual(Set(workspace.calendars.map(\.groupTitle)), [Self.ownerEmail, "casa@gmail.com"])
        XCTAssertEqual(workspace.removableAccounts, ["casa@gmail.com": "abc"])

        // Past the grace *and* the list's own TTL, the server's answer stands
        // alone — here, a server that never learned of the account.
        clock = clock.addingTimeInterval(601)
        await workspace.refreshSources()
        XCTAssertEqual(workspace.calendars.map(\.id), ["g:primary"])
        XCTAssertEqual(workspace.calendars.map(\.groupTitle), ["Google"])
    }

    func testAnAccountWhoseTokenDiedIsListedForRepair() async {
        let backend = StubCalendarBackend()
        backend.status = CalendarConnectionStatus(connected: true, email: Self.ownerEmail)
        backend.listed = .success([Self.primary])
        backend.accounts = [
            Self.primaryAccount,
            CalendarAccount(id: "abc", email: "casa@gmail.com", primary: false, connected: false),
        ]
        let workspace = makeWorkspace(backend) { Date() }

        await workspace.refreshSources()
        XCTAssertEqual(workspace.accountsNeedingReconnect.map(\.email), ["casa@gmail.com"])
        XCTAssertEqual(workspace.removableAccounts, ["casa@gmail.com": "abc"])
    }

    func testDisconnectEndsTheGrace() async {
        let backend = StubCalendarBackend()
        backend.status = CalendarConnectionStatus(connected: false, email: nil)
        let clock = Date(timeIntervalSince1970: 1_800_000_000)
        let workspace = makeWorkspace(backend) { clock }

        workspace.noteGoogleConnected(CalendarConnectionStatus(connected: true, email: Self.ownerEmail, calendars: [Self.primary]))
        workspace.noteGoogleDisconnected()
        XCTAssertFalse(CalendarSourcePreferences.googleConnectionRecentlyAsserted(defaults: defaults, now: clock))
        XCTAssertTrue(workspace.calendars.isEmpty)

        await workspace.refreshSources()
        XCTAssertFalse(workspace.googleConnected)
        XCTAssertTrue(workspace.calendars.isEmpty)
    }

    func testAFailedListingIsSaid() async {
        let backend = StubCalendarBackend()
        backend.status = CalendarConnectionStatus(connected: true, email: Self.ownerEmail)
        backend.listed = .failure(StarlingsError(
            code: "calendar.failed", title: "Calendar", message: "Google Calendar did not answer.", severity: .notice
        ))
        let workspace = makeWorkspace(backend) { Date() }

        await workspace.refreshSources()
        XCTAssertTrue(workspace.googleConnected, "a failed listing is not a disconnect")
        XCTAssertEqual(workspace.lastError, "Google Calendar did not answer.")
    }

    // meet#613: what a wake looks like to the calendar, and what it may say.
    private func connectedBackend(failingStatusWith failures: [any Error]) -> StubCalendarBackend {
        let backend = StubCalendarBackend()
        backend.status = CalendarConnectionStatus(connected: true, email: Self.ownerEmail)
        backend.listed = .success([Self.primary])
        backend.accounts = [Self.primaryAccount]
        backend.statusFailures = failures
        return backend
    }

    func testATransientFailureRetriesQuietlyAndSaysNothingWhenARetryWorks() async {
        let backend = connectedBackend(failingStatusWith: [
            StarlingsError.transport(URLError(.networkConnectionLost), operation: "Load"),
            // A Worker that answers with no code at all, as a cancelled one did.
            StarlingsError.service(status: 500, serverCode: nil, serverMessage: "", operation: "Load"),
        ])
        let workspace = makeWorkspace(backend) { Date() }
        workspace.transientRetryDelays = [.zero, .zero, .zero]

        await workspace.refreshSources()
        XCTAssertEqual(backend.statusCalls, 3)
        XCTAssertNil(workspace.lastError, "a retry that worked leaves nothing to say")
        XCTAssertTrue(workspace.googleConnected)
    }

    func testATransientFailureIsSaidOnlyAfterEveryRetryFailed() async {
        let offline = StarlingsError.transport(URLError(.notConnectedToInternet), operation: "Load")
        let backend = connectedBackend(failingStatusWith: [offline, offline, offline, offline])
        let workspace = makeWorkspace(backend) { Date() }
        workspace.transientRetryDelays = [.zero, .zero, .zero]

        await workspace.refreshSources()
        XCTAssertEqual(backend.statusCalls, 4, "the first try and three retries")
        XCTAssertNotNil(workspace.lastError)
        XCTAssertNotNil(workspace.lastErrorDetail)
    }

    func testAFailureThatNeedsThePersonIsSaidWithoutARetry() async {
        var expired = StarlingsError.service(
            status: 401, serverCode: ControlErrorCodeValue.calendarExpired.rawValue,
            serverMessage: "Google Calendar access expired. Reconnect Calendar in Settings.", operation: "Load"
        )
        expired.serverCode = ControlErrorCodeValue.calendarExpired.rawValue
        let backend = connectedBackend(failingStatusWith: [expired])
        let workspace = makeWorkspace(backend) { Date() }
        workspace.transientRetryDelays = [.zero, .zero, .zero]

        await workspace.refreshSources()
        XCTAssertEqual(backend.statusCalls, 1)
        XCTAssertEqual(workspace.lastError, "Google Calendar access expired. Reconnect Calendar in Settings.")
    }

    func testStatusCarriesTheCalendarsOnlyOnAConnect() throws {
        let status = try JSONDecoder().decode(
            CalendarConnectionStatus.self,
            from: Data(#"{"connected":true,"email":"rosa@example.com","calendars":[{"id":"primary","summary":"Rosa","primary":true,"selected":true,"writable":true,"accountId":"primary-account","accountEmail":"rosa@example.com"}]}"#.utf8)
        )
        XCTAssertEqual(status.calendars?.map(\.id), ["primary"])
        XCTAssertNil(try JSONDecoder().decode(CalendarConnectionStatus.self, from: Data(#"{"connected":false}"#.utf8)).calendars)
    }
}

final class CalendarAttendeeDecodeTests: XCTestCase {
    /// The Worker's event shape, as `listCalendarEventsInRange` writes it:
    /// rich attendee objects with `self` on the owner. Both the invitee list
    /// and "Your reply" hang off this decode, so a regression here blanks
    /// both at once.
    func testRichAttendeesAndSelfReplySurviveDecode() throws {
        let json = #"""
        {"events":[{"id":"cal1:evt1","calendarId":"cal1","calendarSummary":"Envisioning","htmlLink":"","title":"I2037","start":"2026-09-14T15:00:00+02:00","end":"2026-09-14T16:00:00+02:00","joinUrl":"","roomSlug":"","isMeetEvent":false,"attendees":[{"name":"Joana Costa","email":"jcosta@university.edu","status":"accepted","optional":false,"self":false},{"name":"guest.person@gmail.com","email":"guest.person@gmail.com","status":"needsAction","optional":false,"self":false},{"name":"Rosa Ortiz","email":"rosa@example.com","inCrm":true,"crmUrl":null,"status":"accepted","optional":false,"self":true}],"organizerSelf":false,"platform":"google_meet","conferenceUrl":"https://meet.google.com/abc","allDay":false,"recurringEventId":"","recurring":false,"description":"","location":"","travelTimeMinutes":null,"demoted":false,"calendarRole":"ordinary","subject":null}]}
        """#
        let response = try JSONDecoder().decode(CalendarEventsResponse.self, from: Data(json.utf8))
        let summary = try XCTUnwrap(response.summaries.first)
        XCTAssertEqual(summary.attendees.map(\.email), ["jcosta@university.edu", "guest.person@gmail.com", "rosa@example.com"])
        XCTAssertEqual(summary.myResponse, .accepted)

        let event = try XCTUnwrap(StarlingsCalendarEvent(summary: summary))
        XCTAssertEqual(event.attendeeEmails.count, 3)
        XCTAssertEqual(event.attendees.count, 3)
        XCTAssertEqual(event.myResponse, .accepted)

        // The disk snapshot leaves the rich list out and still round-trips.
        let data = try JSONEncoder().encode(event)
        let restored = try JSONDecoder().decode(StarlingsCalendarEvent.self, from: data)
        XCTAssertEqual(restored.attendeeEmails, event.attendeeEmails)
        XCTAssertEqual(restored.myResponse, .accepted)
        XCTAssertTrue(restored.attendees.isEmpty)
    }
}

final class CalendarInviteesEditorTests: XCTestCase {
    /// Rendering rows into a live window: a constraint activated before its
    /// views share a superview raises an NSException that AppKit swallows on
    /// the run loop — invisible in the app (the inspector just stops
    /// drawing), fatal here.
    @MainActor
    func testRendersRowsInsideAWindowAndReportsAddresses() {
        let editor = CalendarInviteesEditorView()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView?.addSubview(editor)
        editor.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            editor.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            editor.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            editor.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
        ])
        editor.setAttendees(
            [
                CalendarAttendeeSummary(name: "Ines", email: "jc@university.edu", status: "accepted", optional: false, isSelf: false),
                CalendarAttendeeSummary(name: "Rosa", email: "rosa@example.com", status: "accepted", optional: false, isSelf: true),
            ],
            emails: ["jc@university.edu", "rosa@example.com", "extra@example.net"]
        )
        window.contentView?.layoutSubtreeIfNeeded()
        // Everyone but you; the plain email with no summary still counts.
        XCTAssertEqual(editor.addresses, ["jc@university.edu", "extra@example.net"])
        XCTAssertGreaterThan(editor.fittingSize.height, 24 * 3)
    }
}

/// What a failed Google read means (meet#613): only a real, retried failure
/// earns the "didn't refresh" banner, and each cause says its own sentence.
final class CalendarRefreshFailureTests: XCTestCase {
    func testAbandonedLoadsAreNotFailures() {
        XCTAssertEqual(CalendarRefreshFailure.classify(CancellationError()), .cancelled)
        XCTAssertEqual(CalendarRefreshFailure.classify(URLError(.cancelled)), .cancelled)
        XCTAssertEqual(
            CalendarRefreshFailure.classify(StarlingsError.transport(URLError(.cancelled), operation: "Load")),
            .cancelled
        )
    }

    func testNetworkWakeFailuresAreTransientSoTheyRetryFirst() {
        for code in [URLError.Code.notConnectedToInternet, .networkConnectionLost, .timedOut, .dnsLookupFailed] {
            XCTAssertEqual(CalendarRefreshFailure.classify(URLError(code)), .transient, "\(code)")
        }
        XCTAssertEqual(
            CalendarRefreshFailure.classify(StarlingsError.transport(URLError(.notConnectedToInternet), operation: "Load")),
            .transient
        )
        XCTAssertEqual(
            CalendarRefreshFailure.classify(StarlingsError.service(status: 503, serverCode: nil, serverMessage: "", operation: "Load")),
            .transient
        )
    }

    func testExpiredSessionsAreNamedNotDressedAsARefreshFailure() {
        XCTAssertEqual(CalendarRefreshFailure.classify(CalendarAuthenticationRequiredError()), .signInExpired)
        XCTAssertEqual(CalendarRefreshFailure.classify(StarlingsError.authenticationRequired()), .signInExpired)
        XCTAssertEqual(
            CalendarRefreshFailure.classify(
                StarlingsError(
                    code: "service.rejected", title: "Load", message: "x",
                    diagnostic: "HTTP 401", serverCode: ControlErrorCodeValue.calendarExpired.rawValue
                )
            ),
            .googleExpired
        )
    }

    func testAWorkerRefusalIsNotRetried() {
        XCTAssertEqual(
            CalendarRefreshFailure.classify(StarlingsError.service(status: 400, serverCode: nil, serverMessage: "bad", operation: "Load")),
            .other
        )
    }

    func testGoogleBeingBusyIsRetriedOnTheMacToo() {
        // The Worker answers a Google rate limit as 429 `calendar_failed`. The
        // Mac read that as a refusal and alarmed at once; iOS retried.
        var busy = StarlingsError.service(
            status: 429, serverCode: "calendar_failed",
            serverMessage: "Google Calendar is busy. Try again in a moment.", operation: "Load"
        )
        busy.serverCode = "calendar_failed"
        XCTAssertEqual(CalendarRefreshFailure.classify(busy), .transient)
    }

    func testTheRetryRuleWaitsOnlyForATransientFailure() {
        let offline = URLError(.notConnectedToInternet)
        XCTAssertEqual(
            (0..<4).map { CalendarRefreshRetry.delay(after: offline, attempt: $0) },
            [.seconds(1), .seconds(3), .seconds(8), nil]
        )
        XCTAssertNil(CalendarRefreshRetry.delay(after: CancellationError(), attempt: 0))
        XCTAssertNil(CalendarRefreshRetry.delay(after: CalendarAuthenticationRequiredError(), attempt: 0))
        XCTAssertNil(CalendarRefreshRetry.delay(
            after: StarlingsError(code: "service.rejected", title: "Load", message: "x", serverCode: ControlErrorCodeValue.calendarExpired.rawValue),
            attempt: 0
        ))
        XCTAssertNil(CalendarRefreshRetry.delay(
            after: StarlingsError.service(status: 400, serverCode: nil, serverMessage: "bad", operation: "Load"),
            attempt: 0
        ))
        XCTAssertNil(CalendarRefreshRetry.delay(after: offline, attempt: 0, delays: []), "a speculative read never waits")
    }
}

/// What a teammate's schedule says when it is not a list of blocks (meet#594).
final class PeerScheduleNoteTests: XCTestCase {
    func testAnUnsharedCalendarIsAStateNotAnError() {
        XCTAssertEqual(PeerScheduleNote.unreadable("not_shared"), "Their calendar isn’t shared with you.")
        XCTAssertEqual(PeerScheduleNote.unreadable("notFound"), "Their calendar isn’t shared with you.")
        XCTAssertEqual(PeerScheduleNote.unreadable("unavailable"), "Their calendar isn’t available to you.")
    }

    func testEachCauseOfAFailedReadSaysItsOwnSentence() {
        // The transport stamps the code on after `service` builds the error.
        func service(_ status: Int, _ code: String?) -> Error {
            var error = StarlingsError.service(status: status, serverCode: code, serverMessage: "x", operation: "Load")
            error.serverCode = code
            return error
        }
        XCTAssertEqual(PeerScheduleNote.Failure.classify(service(409, "calendar_not_connected")), .notConnected)
        XCTAssertEqual(PeerScheduleNote.Failure.classify(service(401, "calendar_expired")), .googleExpired)
        XCTAssertEqual(PeerScheduleNote.Failure.classify(CalendarAuthenticationRequiredError()), .signInExpired)
    }

    func testARealFailureKeepsItsClassifiedCauseForCopy() {
        var error = StarlingsError.service(status: 502, serverCode: "calendar_failed", serverMessage: "x", operation: "Load")
        error.serverCode = "calendar_failed"
        let failure = PeerScheduleNote.Failure.classify(error)
        guard case .failed(let detail) = failure else { return XCTFail("expected .failed, got \(failure)") }
        XCTAssertTrue(detail.contains("cause: transient"), detail)
        XCTAssertTrue(detail.contains("calendar_failed"), detail)
    }
}
