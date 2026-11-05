package work.starlings.android.api

import work.starlings.contracts.BookingSettingsResponse
import work.starlings.contracts.BookingSettingsUpdate
import work.starlings.contracts.CalendarAccountListResponse
import work.starlings.contracts.CalendarBookingMintRequest
import work.starlings.contracts.CalendarBookingMintResponse
import work.starlings.contracts.CalendarEventMoveRequest
import work.starlings.contracts.CalendarEventResponse
import work.starlings.contracts.CalendarFreeBusyRequest
import work.starlings.contracts.CalendarFreeBusyResponse
import work.starlings.contracts.CalendarQuickAddRequest
import work.starlings.contracts.CalendarQuickAddResponse
import work.starlings.contracts.CalendarSubscriptionCreateRequest
import work.starlings.contracts.CalendarSubscriptionListResponse
import work.starlings.contracts.CalendarSubscriptionResponse
import work.starlings.contracts.GoogleCalendarListResponse

/**
 * The Calendar screen's routes that [CalendarRoutes] does not carry yet, as
 * `Sources/StarlingsCalendarRoutes.swift` names them: the Google calendar
 * list, the connected accounts (one account reads "Google", more name each
 * address), removing an extra account, the subscribed feeds with subscribe
 * and unsubscribe, Move to calendar, and the booking hours. Held to
 * `fixtures/routes.json` by `CalendarExtraRoutesTest`.
 */
object CalendarExtraRoutes {
    val calendars = Route(
        "GET", listOf("calendar", "calendars"), answer = Answer.Wire(GoogleCalendarListResponse.serializer()),
        operation = "Couldn’t list your calendars",
    )

    val accounts = Route(
        "GET", listOf("calendar", "accounts"), answer = Answer.Wire(CalendarAccountListResponse.serializer()),
        operation = "Couldn’t list your Google accounts",
    )

    val subscriptions = Route(
        "GET", listOf("calendar", "subscriptions"), answer = Answer.Wire(CalendarSubscriptionListResponse.serializer()),
        operation = "Couldn’t list your subscribed calendars",
    )

    /** Takes an extra Google account and its calendars out of Starlings. The primary one stays. */
    fun removeAccount(id: String): Route<Unit> = Route(
        "DELETE", listOf("calendar", "accounts", id), answer = Answer.None,
        operation = "Couldn’t remove that Google account",
    )

    /** `addSubscription`: a published feed by its address; the Worker checks it and names it. */
    fun addSubscription(create: CalendarSubscriptionCreateRequest): Route<CalendarSubscriptionResponse> = Route(
        "POST", listOf("calendar", "subscriptions"), body = json(CalendarSubscriptionCreateRequest.serializer(), create),
        answer = Answer.Wire(CalendarSubscriptionResponse.serializer()),
        operation = "Couldn’t subscribe to that calendar",
    )

    fun removeSubscription(id: String): Route<Unit> = Route(
        "DELETE", listOf("calendar", "subscriptions", id), answer = Answer.None,
        operation = "Couldn’t remove that subscription",
    )

    /**
     * A booking link for an event in a room (`mintBooking`): the room's link
     * with a token, so the guests who follow it are let in for that slot.
     */
    fun mintBooking(mint: CalendarBookingMintRequest): Route<CalendarBookingMintResponse> = Route(
        "POST", listOf("calendar", "booking-token"), body = json(CalendarBookingMintRequest.serializer(), mint),
        answer = Answer.Wire(CalendarBookingMintResponse.serializer()),
        operation = "Couldn’t mint the meeting link",
    )

    /** The guests' busy time, free/busy only: no event details travel. */
    fun freeBusy(ask: CalendarFreeBusyRequest): Route<CalendarFreeBusyResponse> = Route(
        "POST", listOf("calendar", "free-busy"), body = json(CalendarFreeBusyRequest.serializer(), ask),
        answer = Answer.Wire(CalendarFreeBusyResponse.serializer()),
        operation = "Couldn’t check availability",
    )

    fun moveEvent(move: CalendarEventMoveRequest): Route<CalendarEventResponse> = Route(
        "POST", listOf("calendar", "event", "move"), body = json(CalendarEventMoveRequest.serializer(), move),
        answer = Answer.Wire(CalendarEventResponse.serializer()),
        operation = "Couldn’t move the event",
    )

    /**
     * Quick add: the Worker reads the sentence with the shared
     * grammar (`packages/contracts/src/quick-add.ts`) and, with `allow_model`,
     * asks the notes engine when the grammar read no date. Android sends
     * every sentence here rather than keep a third copy of the grammar.
     */
    fun quickAdd(request: CalendarQuickAddRequest): Route<CalendarQuickAddResponse> = Route(
        "POST", listOf("calendar", "quick-add"), body = json(CalendarQuickAddRequest.serializer(), request),
        answer = Answer.Wire(CalendarQuickAddResponse.serializer()),
        operation = "Couldn’t read that",
    )

    /**
     * Settings › Calendar › Booking hours: the member's hours,
     * zone and booking rules, the same row the web edits.
     */
    val bookingSettings = Route(
        "GET", listOf("calendar", "booking-settings"), answer = Answer.Wire(BookingSettingsResponse.serializer()),
        operation = "Couldn’t read your booking hours.",
    )

    /** Save writes the whole form once, as the web does. */
    fun saveBookingSettings(update: BookingSettingsUpdate): Route<BookingSettingsResponse> = Route(
        "PUT", listOf("calendar", "booking-settings"), body = json(BookingSettingsUpdate.serializer(), update),
        answer = Answer.Wire(BookingSettingsResponse.serializer()),
        operation = "Couldn’t save your booking hours.",
    )
}
