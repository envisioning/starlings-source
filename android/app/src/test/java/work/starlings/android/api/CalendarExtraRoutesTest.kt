package work.starlings.android.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.CalendarEventCreateRequest
import work.starlings.contracts.CalendarEventDeleteRequest
import work.starlings.contracts.CalendarEventMoveRequest
import work.starlings.contracts.CalendarEventPatchRequest
import java.io.File

/** The Calendar screen's routes against `fixtures/routes.json`, as `RouteFixtureTest` holds the shared ones. */
class CalendarExtraRoutesTest {
    private val routes: List<Route<*>> = listOf(
        CalendarExtraRoutes.calendars,
        CalendarExtraRoutes.accounts,
        CalendarExtraRoutes.subscriptions,
        CalendarExtraRoutes.addSubscription(work.starlings.contracts.CalendarSubscriptionCreateRequest("webcal://x")),
        CalendarExtraRoutes.removeSubscription("s"),
        CalendarExtraRoutes.removeAccount("a"),
        CalendarExtraRoutes.moveEvent(CalendarEventMoveRequest("c", "e", "d")),
        CalendarExtraRoutes.mintBooking(work.starlings.contracts.CalendarBookingMintRequest("t", roomSlug = "r")),
        CalendarExtraRoutes.freeBusy(work.starlings.contracts.CalendarFreeBusyRequest("a", "b", listOf("c@d.e"))),
        CalendarExtraRoutes.quickAdd(work.starlings.contracts.CalendarQuickAddRequest("s", "n", "z")),
        // Settings › Calendar › Booking hours.
        CalendarExtraRoutes.bookingSettings,
        CalendarExtraRoutes.saveBookingSettings(
            work.starlings.contracts.BookingSettingsUpdate(
                true, 30, 0, 0, 30, 15, "UTC", work.starlings.android.workspace.calendar.BookingHours.defaultWeek,
            ),
        ),
        // Show in Upcoming and Include local calendars.
        CalendarRoutes.savePreferences(work.starlings.contracts.CalendarPreferencesUpdate(includesLocalCalendars = true)),
        // The writes the event sheet and the editor send through CalendarRoutes.
        CalendarRoutes.createEvent(CalendarEventCreateRequest(start = "s", end = "e")),
        CalendarRoutes.patchEvent(CalendarEventPatchRequest("c", "e")),
        CalendarRoutes.deleteEvent(CalendarEventDeleteRequest("c", "e")),
        // Google Calendar connect (GoogleCalendarConnect).
        CalendarRoutes.androidClient,
        CalendarRoutes.connectAndroid(work.starlings.contracts.CalendarAndroidExchangeRequest("c")),
        CalendarRoutes.connectAccountAndroid(work.starlings.contracts.CalendarAndroidExchangeRequest("c")),
    )

    @Test
    fun everyRouteIsOneTheWorkerAnswers() {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val table = Json.parseToJsonElement(File(dir, "routes.json").readText()).jsonObject["routes"]!!.jsonArray.map { it.jsonPrimitive.content }
        val patterns = table.map { line ->
            val (method, path) = line.split(' ', limit = 2)
            method to path.trim('/').split('/')
        }
        val unanswered = routes.filterNot { route ->
            val segments = listOf("api") + route.path
            patterns.any { (method, pattern) ->
                (method == "*" || method == route.method) && pattern.size == segments.size &&
                    pattern.zip(segments).all { (p, s) -> p == "{}" || p == s }
            }
        }.map { it.signature }
        assertEquals("routes the Worker does not answer", emptyList<String>(), unanswered)
    }

    @Test
    fun moveSendsTheDestination() {
        assertEquals(
            """{"calendar_id":"c","event_id":"e","destination_id":"d"}""",
            CalendarExtraRoutes.moveEvent(CalendarEventMoveRequest("c", "e", "d")).body,
        )
    }
}
