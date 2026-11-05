package work.starlings.android.api

import work.starlings.contracts.CalendarAccountResponse
import work.starlings.contracts.CalendarAndroidClient
import work.starlings.contracts.CalendarAndroidExchangeRequest
import work.starlings.contracts.CalendarAvailabilityQuery
import work.starlings.contracts.CalendarAvailabilityResponse
import work.starlings.contracts.CalendarEventCreateRequest
import work.starlings.contracts.CalendarEventDeleteRequest
import work.starlings.contracts.CalendarEventPatchRequest
import work.starlings.contracts.CalendarEventRespondRequest
import work.starlings.contracts.CalendarEventResponse
import work.starlings.contracts.CalendarEventsQuery
import work.starlings.contracts.CalendarEventsResponse
import work.starlings.contracts.CalendarPreferencesResponse
import work.starlings.contracts.CalendarPreferencesUpdate
import work.starlings.contracts.CalendarStatus
import work.starlings.contracts.CalendarUpcomingQuery
import work.starlings.contracts.CalendarWorkItemsQuery
import work.starlings.contracts.CalendarWorkItemsResponse
import work.starlings.contracts.PendingCalendarEventsResponse
import work.starlings.contracts.SubscriptionEventsResponse
import java.time.Instant
import java.time.LocalDate

/**
 * The Calendar routes the phone sends, as `Sources/StarlingsCalendarRoutes.swift`:
 * Home's UPCOMING, the Calendar screen's events, invitations and events from
 * email, the display preferences, and a reply to an invitation.
 */
object CalendarRoutes {
    val status = Route(
        "GET", listOf("calendar", "status"), answer = Answer.Wire(CalendarStatus.serializer()),
        operation = "Couldn’t check Google Calendar",
    )

    /**
     * One snapshot for upcoming whatever the hours asked. The table keeps it
     * on the Mac and the web only, so Android reads it live, as iOS does.
     */
    fun upcoming(hours: Long): Route<CalendarEventsResponse> = Route(
        "GET", listOf("calendar", "upcoming"),
        query = CalendarUpcomingQuery(hours).queryItems(),
        answer = Answer.Wire(CalendarEventsResponse.serializer()),
        operation = "Couldn’t load upcoming events",
        snapshotKey = SnapshotKey.CALENDAR_UPCOMING,
    )

    /** The widest calendar read, so it waits 20 s. */
    fun events(from: Instant, to: Instant): Route<CalendarEventsResponse> = Route(
        "GET", listOf("calendar", "events"),
        query = CalendarEventsQuery(RouteDates.instant(from), RouteDates.instant(to)).queryItems(),
        answer = Answer.Wire(CalendarEventsResponse.serializer()),
        operation = "Couldn’t load the calendar",
        timeoutSeconds = 20.0,
    )

    fun subscriptionEvents(from: Instant, to: Instant): Route<SubscriptionEventsResponse> = Route(
        "GET", listOf("calendar", "subscriptions", "events"),
        query = CalendarEventsQuery(RouteDates.instant(from), RouteDates.instant(to)).queryItems(),
        answer = Answer.Wire(SubscriptionEventsResponse.serializer()),
        operation = "Couldn’t load your subscribed calendars",
        timeoutSeconds = 20.0,
    )

    val invitations = Route(
        "GET", listOf("calendar", "invitations"), answer = Answer.Wire(CalendarEventsResponse.serializer()),
        operation = "Couldn’t load calendar invitations",
        snapshotKey = SnapshotKey.CALENDAR_INVITATIONS,
        timeoutSeconds = 20.0,
    )

    val pending = Route(
        "GET", listOf("calendar", "pending"), answer = Answer.Wire(PendingCalendarEventsResponse.serializer()),
        operation = "Couldn’t load the events from email",
        snapshotKey = SnapshotKey.CALENDAR_PENDING,
    )

    fun addPending(id: String): Route<CalendarEventResponse> = Route(
        "POST", listOf("calendar", "pending", id, "add"), body = EMPTY_BODY,
        answer = Answer.Wire(CalendarEventResponse.serializer()),
        operation = "Couldn’t add the event",
    )

    fun discardPending(id: String): Route<Unit> = Route(
        "POST", listOf("calendar", "pending", id, "discard"), body = EMPTY_BODY,
        answer = Answer.None, operation = "Couldn’t discard the event",
    )

    fun workItems(from: LocalDate, to: LocalDate, includeDone: Boolean): Route<CalendarWorkItemsResponse> = Route(
        "GET", listOf("calendar", "work-items"),
        query = CalendarWorkItemsQuery(RouteDates.day(from), RouteDates.day(to), if (includeDone) true else null).queryItems(),
        answer = Answer.Wire(CalendarWorkItemsResponse.serializer()),
        operation = "Couldn’t load tasks and milestones",
    )

    fun availability(from: LocalDate, to: LocalDate): Route<CalendarAvailabilityResponse> = Route(
        "GET", listOf("calendar", "availability"),
        query = CalendarAvailabilityQuery(RouteDates.day(from), RouteDates.day(to)).queryItems(),
        answer = Answer.Wire(CalendarAvailabilityResponse.serializer()),
        operation = "Couldn’t load availability",
    )

    /** Home derives UPCOMING under the policy it was last drawn with. */
    val preferences = Route(
        "GET", listOf("calendar", "preferences"), answer = Answer.Wire(CalendarPreferencesResponse.serializer()),
        operation = "Couldn’t read your calendar choice",
        snapshotKey = SnapshotKey.CALENDAR_PREFERENCES,
    )

    fun savePreferences(update: CalendarPreferencesUpdate): Route<CalendarPreferencesResponse> = Route(
        "PUT", listOf("calendar", "preferences"), body = json(CalendarPreferencesUpdate.serializer(), update),
        answer = Answer.Wire(CalendarPreferencesResponse.serializer()),
        operation = "Couldn’t save your calendar choice",
    )

    fun createEvent(create: CalendarEventCreateRequest): Route<CalendarEventResponse> = Route(
        "POST", listOf("calendar", "events"), body = json(CalendarEventCreateRequest.serializer(), create),
        answer = Answer.Wire(CalendarEventResponse.serializer()),
        operation = "Couldn’t create the Calendar event",
    )

    fun patchEvent(patch: CalendarEventPatchRequest): Route<CalendarEventResponse> = Route(
        "PATCH", listOf("calendar", "event"), body = json(CalendarEventPatchRequest.serializer(), patch),
        answer = Answer.Wire(CalendarEventResponse.serializer()),
        operation = "Couldn’t update the Calendar event",
    )

    fun respond(reply: CalendarEventRespondRequest): Route<CalendarEventResponse> = Route(
        "POST", listOf("calendar", "event", "respond"), body = json(CalendarEventRespondRequest.serializer(), reply),
        answer = Answer.Wire(CalendarEventResponse.serializer()),
        operation = "Couldn’t send your reply",
    )

    fun deleteEvent(delete: CalendarEventDeleteRequest): Route<Unit> = Route(
        "DELETE", listOf("calendar", "event"), body = json(CalendarEventDeleteRequest.serializer(), delete),
        answer = Answer.None, operation = "Couldn’t delete the Calendar event",
    )

    /** The title of a failed connect, the Worker's and Google's side alike (iOS `connect`). */
    const val CONNECT_FAILED = "Couldn’t connect Google Calendar"

    /** The title of a failed extra account (iOS `connectAccount`). */
    const val ADD_ACCOUNT_FAILED = "Couldn’t add that Google account"

    /** The Worker's server client id, which Play services' `requestOfflineAccess` names. */
    val androidClient = Route(
        "GET", listOf("calendar", "connect", "android"), answer = Answer.Wire(CalendarAndroidClient.serializer()),
        operation = CONNECT_FAILED,
    )

    /**
     * The owner's own calendar from a Play services `serverAuthCode`. The
     * code is single-use, so this POST is never sent twice.
     */
    fun connectAndroid(exchange: CalendarAndroidExchangeRequest): Route<CalendarStatus> = Route(
        "POST", listOf("calendar", "connect", "android"), body = json(CalendarAndroidExchangeRequest.serializer(), exchange),
        answer = Answer.Wire(CalendarStatus.serializer()),
        operation = CONNECT_FAILED,
    )

    /** One more Google account for its calendars. Not a sign-in: the owner session stays. */
    fun connectAccountAndroid(exchange: CalendarAndroidExchangeRequest): Route<CalendarAccountResponse> = Route(
        "POST", listOf("calendar", "accounts", "connect", "android"), body = json(CalendarAndroidExchangeRequest.serializer(), exchange),
        answer = Answer.Wire(CalendarAccountResponse.serializer()),
        operation = ADD_ACCOUNT_FAILED,
    )
}
