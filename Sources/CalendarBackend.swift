import Foundation
import StarlingsContracts

/// What `CalendarWorkspace` needs from a control-plane client.
///
/// Google lives behind the OAuth proxy on both platforms, so the wire calls are
/// identical — only the token store differs. Naming that as a protocol is what
/// lets one workspace drive the Mac window and the iOS calendar without either
/// knowing which client it is holding. `MeetingControlAPI` conforms on Mac;
/// `MobileCalendarBackend` wraps `StarlingsAPI` on iOS.
protocol CalendarBackend: Sendable {
    func calendarStatus() async throws -> CalendarConnectionStatus
    func listCalendars() async throws -> [GoogleCalendarListEntry]

    /// Calendar choices that belong to the owner rather than to a device, so the
    /// Mac and the phone show the same list.
    func calendarPreferences() async throws -> CalendarPreferences
    func setSelectedCalendarIds(_ ids: [String]) async throws -> CalendarPreferences
    func setUpcomingExcludedSubscriptionIds(_ ids: [String]) async throws -> CalendarPreferences
    func setHiddenCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences
    /// Calendars and accounts the owner has taken out of the app altogether.
    /// Owner-wide for the same reason hiding is: a device account switched off
    /// on the Mac has no business reappearing on the phone.
    func setDisabledCalendarKeys(_ keys: [String]) async throws -> CalendarPreferences
    func setDemotedEventKeys(_ keys: [String]) async throws -> CalendarPreferences
    func setIncludesLocalCalendars(_ included: Bool) async throws -> CalendarPreferences
    func setUpcomingPreferences(_ preferences: UpcomingPreferencesWire) async throws -> CalendarPreferences
    /// The project or lead each event is about, by the demotion key. Owner-wide
    /// so a room started from the event is filed the same on both devices.
    func setEventSubjects(_ subjects: [String: CrmSubject]) async throws -> CalendarPreferences
    /// Projects or leads to file an event under, from Core through the Worker.
    func crmSubjects(kind: MeetingCategoryKind.SubjectKind, query: String) async throws -> [CrmSubject]

    /// Connected Google accounts, the owner's own first.
    func calendarAccounts() async throws -> [CalendarAccount]
    func removeCalendarAccount(id: String) async throws

    /// Subscribed `.ics` feeds. Owner-wide like the preferences above, and for
    /// the same reason: a feed added on one device is meant to be on both.
    func calendarSubscriptions() async throws -> [CalendarSubscription]
    func addCalendarSubscription(url: String, title: String?) async throws -> CalendarSubscription
    func removeCalendarSubscription(id: String) async throws
    func subscriptionEvents(from start: Date, to end: Date) async throws -> [SubscriptionEventSummary]
    func calendarEvents(from start: Date, to end: Date) async throws -> [CalendarEventSummary]
    /// Incoming Google invitations, independent of the period currently on screen.
    /// The response is provider-owned state, so every device reads the same list.
    func calendarInvitations() async throws -> [CalendarEventSummary]

    /// Quick add's fallback: a sentence the grammar could not read,
    /// to the notes engine. Only the sentence is sent.
    func quickAdd(_ request: CalendarQuickAddRequest) async throws -> CalendarQuickAddResponse

    /// Events proposed from mail forwarded to `calendar@`, and the
    /// two answers. Add writes to the owner's primary calendar and returns the
    /// event; both answers remove the row.
    func pendingCalendarEvents() async throws -> [ProposedCalendarEvent]
    func addPendingCalendarEvent(id: String) async throws -> CalendarEventSummary
    func discardPendingCalendarEvent(id: String) async throws

    /// Dated tasks and milestones from Core, drawn as a read-only layer. Takes
    /// plain `YYYY-MM-DD` bounds because that is what the endpoint accepts, and
    /// because a milestone has a date rather than an instant.
    func calendarWorkItems(from start: Date, to end: Date, includeDone: Bool) async throws -> [CalendarWorkItem]

    /// When Core would let a guest book the owner, drawn as a read-only layer.
    /// Same plain-date bounds as work items; the Worker picks the room.
    func calendarAvailability(from start: Date, to end: Date) async throws -> [CalendarAvailabilityBlock]

    /// When the given people are busy, for picking a time they can all make.
    func calendarFreeBusy(
        from start: Date,
        to end: Date,
        emails: [String]
    ) async throws -> [CalendarFreeBusyPerson]

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
    ) async throws -> CalendarEventSummary

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
    ) async throws -> CalendarEventSummary

    func deleteCalendarEvent(calendarId: String, eventId: String) async throws

    func moveCalendarEvent(
        calendarId: String,
        eventId: String,
        destinationId: String
    ) async throws -> CalendarEventSummary

    func respondToCalendarEvent(
        calendarId: String,
        eventId: String,
        response: CalendarRSVP
    ) async throws -> CalendarEventSummary

    func mintCalendarBooking(
        title: String,
        start: Date,
        end: Date,
        roomSlug: String,
        joinURL: String?
    ) async throws -> CalendarBookingMintResponse
}

/// The owner JWT is separate from the Google Calendar refresh token. A device
/// can therefore still look signed in after its short-lived Meet session has
/// expired; clients use this typed failure to clear that stale state instead
/// of rendering an empty calendar.
struct CalendarAuthenticationRequiredError: Error, Equatable, Sendable {}

/// A calendar failure the Worker named: its stable code and its
/// request id, for the sentence a person reads and for Copy diagnostics.
/// `StarlingsError` answers it on both clients.
protocol CalendarServiceFailure: Error {
    var calendarServerCode: String? { get }
    var calendarRequestID: String? { get }
    /// One line for Copy: code, status and request id, whichever are known.
    var calendarDiagnostic: String { get }
    /// The request never got a real answer, or the answer says "not now": the
    /// network was away, timed out, or the service was briefly unavailable. A
    /// second try can succeed, so nothing should be said before it has failed.
    var calendarIsTransient: Bool { get }
}

extension StarlingsError: CalendarServiceFailure {
    var calendarServerCode: String? { serverCode }
    var calendarRequestID: String? { requestID }
    var calendarDiagnostic: String { logLine }
    /// A 408 is "not now" too, on both clients (the phone's rule before).
    var calendarIsTransient: Bool {
        ["service.offline", "service.timeout", "service.unreachable", "service.unavailable", "service.rate_limited"]
            .contains(code) || status == 408
    }
}

/// The quiet retry before a calendar read may say anything, one
/// rule for Mac and iOS. A transient failure waits and tries again; a failure
/// that needs the person (reconnect Google, sign in) or that a second try
/// cannot fix goes to them at once. The waits cover a device that just woke:
/// Wi-Fi rejoins in a few seconds, rarely in more than ten.
enum CalendarRefreshRetry {
    static let delays: [Duration] = [.seconds(1), .seconds(3), .seconds(8)]

    /// The wait before try number `attempt + 1`, or nil when `error` goes to
    /// the person now. `attempt` counts the retries already made.
    static func delay(after error: Error, attempt: Int, delays: [Duration] = delays) -> Duration? {
        guard CalendarRefreshFailure.classify(error) == .transient, delays.indices.contains(attempt) else { return nil }
        return delays[attempt]
    }
}

/// What a failed Google read means, decided once for both clients.
/// The calendar banner used to say one sentence for all of these; only the
/// last two deserve it, and only after a quiet retry has also failed.
enum CalendarRefreshFailure: Equatable {
    /// The load was abandoned (view gone, token changed). Not a failure.
    case cancelled
    /// The Meet owner session was refused. Sign in again, not "didn't refresh".
    case signInExpired
    /// Google refused the stored token. Reconnect in Settings.
    case googleExpired
    /// The network was away or the service briefly unavailable. Retry first.
    case transient
    /// Anything else the Worker or transport reported.
    case other

    static func classify(_ error: Error) -> CalendarRefreshFailure {
        if error is CancellationError { return .cancelled }
        if error is CalendarAuthenticationRequiredError { return .signInExpired }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled: return .cancelled
            case .timedOut, .notConnectedToInternet, .networkConnectionLost, .cannotFindHost,
                 .cannotConnectToHost, .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff,
                 .secureConnectionFailed:
                return .transient
            default: return .other
            }
        }
        if let meetError = error as? StarlingsError {
            if meetError.severity == .silent { return .cancelled }
            if meetError.serverCode == ControlErrorCodeValue.ownerAuthRequired.rawValue || meetError.code.hasPrefix("auth.") { return .signInExpired }
        }
        if let failure = error as? CalendarServiceFailure {
            if failure.calendarServerCode == ControlErrorCodeValue.calendarExpired.rawValue { return .googleExpired }
            if failure.calendarServerCode == ControlErrorCodeValue.ownerAuthRequired.rawValue { return .signInExpired }
            if failure.calendarIsTransient { return .transient }
        }
        return .other
    }
}
