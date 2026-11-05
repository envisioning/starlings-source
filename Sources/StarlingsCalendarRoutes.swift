import Foundation
import StarlingsContracts

/// The Calendar routes, each named once for the Mac and the phone:
/// the path, the query, the body, the answer, the sentence a failure is
/// titled with, and the snapshot a read keeps. `MeetingControlAPI`,
/// `StarlingsAPI` and `MobileCalendarBackend` send them; none of them names a
/// calendar path of its own.
enum StarlingsCalendarRoutes {
    static let status = StarlingsRoute<CalendarConnectionStatus>(
        method: "GET", path: ["calendar", "status"],
        operation: String(localized: "Couldn’t check Google Calendar")
    )

    static func connect(_ exchange: CalendarConnectExchangeRequest) -> StarlingsRoute<CalendarConnectionStatus> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "connect", "exchange"], body: exchange,
            operation: String(localized: "Couldn’t connect Google Calendar")
        )
    }

    static let disconnect = StarlingsRoute<CalendarConnectionStatus>(
        method: "POST", path: ["calendar", "disconnect"],
        operation: String(localized: "Couldn’t disconnect Google Calendar")
    )

    static func createEvent(_ create: CalendarEventCreateRequest) -> StarlingsRoute<CalendarEventResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "events"], body: create,
            operation: String(localized: "Couldn’t create the Calendar event")
        )
    }

    static func mintBooking(_ mint: CalendarBookingMintRequest) -> StarlingsRoute<CalendarBookingMintResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "booking-token"], body: mint,
            operation: String(localized: "Couldn’t mint the meeting link")
        )
    }

    /// The widest calendar read, so it waits 20s. A GET: the transport sends
    /// it once more after a timeout or a 5xx (`StarlingsRequestPolicy.retry`).
    static func events(from start: Date, to end: Date) -> StarlingsRoute<CalendarEventsResponse> {
        StarlingsRoute(
            method: "GET", path: ["calendar", "events"],
            query: CalendarEventsQuery(timeMin: ISODate.format(start), timeMax: ISODate.format(end)).queryItems,
            operation: String(localized: "Couldn’t load the calendar"),
            timeout: 20
        )
    }

    static let invitations = StarlingsRoute<CalendarEventsResponse>(
        method: "GET", path: ["calendar", "invitations"],
        operation: String(localized: "Couldn’t load calendar invitations"),
        snapshotKey: StarlingsSnapshotKey.calendarInvitations,
        timeout: 20
    )

    static func patchEvent(_ patch: CalendarEventPatchRequest) -> StarlingsRoute<CalendarEventResponse> {
        StarlingsRoute(
            method: "PATCH", path: ["calendar", "event"], body: patch,
            operation: String(localized: "Couldn’t update the Calendar event")
        )
    }

    static func moveEvent(_ move: CalendarEventMoveRequest) -> StarlingsRoute<CalendarEventResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "event", "move"], body: move,
            operation: String(localized: "Couldn’t move the event")
        )
    }

    /// Quick add's fallback: the sentence the grammar could not
    /// read, to the notes engine.
    static func quickAdd(_ sentence: CalendarQuickAddRequest) -> StarlingsRoute<CalendarQuickAddResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "quick-add"], body: sentence,
            operation: String(localized: "Couldn’t read that")
        )
    }

    static let pending = StarlingsRoute<PendingCalendarEventsResponse>(
        method: "GET", path: ["calendar", "pending"],
        operation: String(localized: "Couldn’t load the events from email"),
        snapshotKey: StarlingsSnapshotKey.calendarPending
    )

    static func addPending(id: String) -> StarlingsRoute<CalendarEventResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "pending", id, "add"], body: StarlingsEmptyBody(),
            operation: String(localized: "Couldn’t add the event")
        )
    }

    static func discardPending(id: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "pending", id, "discard"], body: StarlingsEmptyBody(),
            operation: String(localized: "Couldn’t discard the event")
        )
    }

    static func respond(_ reply: CalendarEventRespondRequest) -> StarlingsRoute<CalendarEventResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "event", "respond"], body: reply,
            operation: String(localized: "Couldn’t send your reply")
        )
    }

    static func deleteEvent(_ delete: CalendarEventDeleteRequest) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "DELETE", path: ["calendar", "event"], body: delete,
            operation: String(localized: "Couldn’t delete the Calendar event")
        )
    }

    /// One snapshot for upcoming whatever the hours asked: the last answer is
    /// the last answer.
    static func upcoming(hours: Int) -> StarlingsRoute<CalendarEventsResponse> {
        StarlingsRoute(
            method: "GET", path: ["calendar", "upcoming"],
            query: CalendarUpcomingQuery(hours: hours).queryItems,
            operation: String(localized: "Couldn’t load upcoming events"),
            snapshotKey: StarlingsSnapshotKey.calendarUpcoming
        )
    }

    static func freeBusy(_ ask: CalendarFreeBusyRequest) -> StarlingsRoute<CalendarFreeBusyResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "free-busy"], body: ask,
            operation: String(localized: "Couldn’t check availability")
        )
    }

    static func workItems(from start: Date, to end: Date, includeDone: Bool) -> StarlingsRoute<CalendarWorkItemsResponse> {
        StarlingsRoute(
            method: "GET", path: ["calendar", "work-items"],
            query: CalendarWorkItemsQuery(
                start: CalendarDateParsing.format(day: start),
                end: CalendarDateParsing.format(day: end),
                includeDone: includeDone ? true : nil
            ).queryItems,
            operation: String(localized: "Couldn’t load tasks and milestones")
        )
    }

    static func availability(from start: Date, to end: Date) -> StarlingsRoute<CalendarAvailabilityResponse> {
        StarlingsRoute(
            method: "GET", path: ["calendar", "availability"],
            query: CalendarAvailabilityQuery(
                start: CalendarDateParsing.format(day: start),
                end: CalendarDateParsing.format(day: end)
            ).queryItems,
            operation: String(localized: "Couldn’t load availability")
        )
    }

    static let calendars = StarlingsRoute<GoogleCalendarListResponse>(
        method: "GET", path: ["calendar", "calendars"],
        operation: String(localized: "Couldn’t list your calendars")
    )

    /// Home derives UPCOMING from the snapshot under the policy it was last
    /// drawn with, so the live answer does not reorder it.
    static let preferences = StarlingsRoute<CalendarPreferencesResponse>(
        method: "GET", path: ["calendar", "preferences"],
        operation: String(localized: "Couldn’t read your calendar choice"),
        snapshotKey: StarlingsSnapshotKey.calendarPreferences
    )

    static func savePreferences(_ update: CalendarPreferencesUpdate) -> StarlingsRoute<CalendarPreferencesResponse> {
        StarlingsRoute(
            method: "PUT", path: ["calendar", "preferences"], body: update,
            operation: String(localized: "Couldn’t save your calendar choice")
        )
    }

    static let accounts = StarlingsRoute<CalendarAccountListResponse>(
        method: "GET", path: ["calendar", "accounts"],
        operation: String(localized: "Couldn’t list your Google accounts")
    )

    /// Attach another Google account for its calendars. Not a sign-in: the
    /// owner session that authorises the call is the one that stays.
    static func connectAccount(_ exchange: CalendarConnectExchangeRequest) -> StarlingsRoute<CalendarAccountResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "accounts", "connect", "exchange"], body: exchange,
            operation: String(localized: "Couldn’t add that Google account")
        )
    }

    static func removeAccount(id: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "DELETE", path: ["calendar", "accounts", id],
            operation: String(localized: "Couldn’t remove that Google account")
        )
    }

    static let subscriptions = StarlingsRoute<CalendarSubscriptionListResponse>(
        method: "GET", path: ["calendar", "subscriptions"],
        operation: String(localized: "Couldn’t list your subscribed calendars")
    )

    static func addSubscription(url: String, title: String?) -> StarlingsRoute<CalendarSubscriptionResponse> {
        StarlingsRoute(
            method: "POST", path: ["calendar", "subscriptions"],
            body: CalendarSubscriptionCreateRequest(url: url, title: title),
            operation: String(localized: "Couldn’t subscribe to that calendar")
        )
    }

    static func removeSubscription(id: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "DELETE", path: ["calendar", "subscriptions", id],
            operation: String(localized: "Couldn’t remove that subscription")
        )
    }

    static func subscriptionEvents(from start: Date, to end: Date) -> StarlingsRoute<SubscriptionEventsResponse> {
        StarlingsRoute(
            method: "GET", path: ["calendar", "subscriptions", "events"],
            query: CalendarEventsQuery(timeMin: ISODate.format(start), timeMax: ISODate.format(end)).queryItems,
            operation: String(localized: "Couldn’t load your subscribed calendars"),
            timeout: 20
        )
    }

    /// Settings › Calendar › Booking hours: the member's hours,
    /// zone and booking rules, the same row the web edits.
    static let bookingSettings = StarlingsRoute<BookingSettingsResponse>(
        method: "GET", path: ["calendar", "booking-settings"],
        operation: BookingHours.readFailure
    )

    static func saveBookingSettings(_ update: BookingSettingsUpdate) -> StarlingsRoute<BookingSettingsResponse> {
        StarlingsRoute(
            method: "PUT", path: ["calendar", "booking-settings"], body: update,
            operation: BookingHours.saveFailure
        )
    }
}
