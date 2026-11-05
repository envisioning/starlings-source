package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.android.api.CalendarRoutes
import work.starlings.contracts.CalendarAndroidExchangeRequest
import java.io.File

/** The Google Calendar connect's scopes and Worker requests, against the Worker's own source. */
class GoogleCalendarConnectTest {
    private val repo: File
        get() = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")).parentFile

    /**
     * `CALENDAR_OAUTH_SCOPES` in `google-scopes.ts`, read from the file: each
     * `const name = '...'` and the template that joins them with spaces.
     */
    private fun workerCalendarScopes(): List<String> {
        val source = File(repo, "services/control-plane/src/google-scopes.ts").readText()
        val constants = Regex("""const (\w+) = '([^']+)';""").findAll(source).associate { it.groupValues[1] to it.groupValues[2] }
        val template = Regex("""export const CALENDAR_OAUTH_SCOPES = `([^`]+)`;""").find(source)?.groupValues?.get(1)
            ?: error("CALENDAR_OAUTH_SCOPES is not a template literal any more")
        return template.split(' ').map { part ->
            val name = Regex("""^\$\{(\w+)\}$""").find(part)?.groupValues?.get(1)
            if (name == null) part else constants[name] ?: error("google-scopes.ts has no constant $name")
        }
    }

    @Test
    fun calendarScopesAreTheWorkersConsent() {
        assertEquals(workerCalendarScopes(), GoogleCalendarAuthorization.calendarScopes)
    }

    @Test
    fun theRequestAddsOpenIdAndEmail() {
        assertEquals(GoogleCalendarAuthorization.calendarScopes + listOf("openid", "email"), GoogleCalendarAuthorization.scopes)
    }

    @Test
    fun theExchangeSendsTheServerAuthCode() {
        val body = CalendarAndroidExchangeRequest("4/abc")
        assertEquals("""{"server_auth_code":"4/abc"}""", CalendarRoutes.connectAndroid(body).body)
        assertEquals("""{"server_auth_code":"4/abc"}""", CalendarRoutes.connectAccountAndroid(body).body)
    }

    @Test
    fun eachTargetHasItsRouteAndTitle() {
        assertEquals("GET /api/calendar/connect/android", CalendarRoutes.androidClient.signature)
        assertEquals("POST /api/calendar/connect/android", CalendarRoutes.connectAndroid(CalendarAndroidExchangeRequest("c")).signature)
        assertEquals("POST /api/calendar/accounts/connect/android", CalendarRoutes.connectAccountAndroid(CalendarAndroidExchangeRequest("c")).signature)
        assertEquals(CalendarRoutes.connectAndroid(CalendarAndroidExchangeRequest("c")).operation, GoogleCalendarTarget.OWN.failure)
        assertEquals(CalendarRoutes.connectAccountAndroid(CalendarAndroidExchangeRequest("c")).operation, GoogleCalendarTarget.ACCOUNT.failure)
    }
}
