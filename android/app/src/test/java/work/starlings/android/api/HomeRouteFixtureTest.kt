package work.starlings.android.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.WireJson
import java.io.File
import java.time.LocalDate

/** [HomeExtraRoutes] against `fixtures/routes.json`, the way `RouteFixtureTest` holds the other areas. */
class HomeRouteFixtureTest {
    private val routes: List<Route<*>> = listOf(
        HomeExtraRoutes.publicEvents(LocalDate.EPOCH),
        HomeExtraRoutes.setSetupChecklist(false),
        HomeExtraRoutes.skipSetupStep("profile"),
        HomeExtraRoutes.createQuickNote("Call Rosa"),
        HomeExtraRoutes.deleteQuickNote("n1"),
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
    fun queryAndBodyFollowSwift() {
        assertEquals(listOf("startDate" to "1970-01-01", "endDate" to "1970-05-01"), HomeExtraRoutes.publicEvents(LocalDate.EPOCH).query)
        assertEquals("""{"body":"Call Rosa","source":"home"}""", HomeExtraRoutes.createQuickNote("Call Rosa").body)
    }

    @Test
    fun theProjectionDecodes() {
        val body = """{"events":[{"id":"e1","title":"Open day","date":"2026-11-02","starts_at":"2026-11-02T14:00:00.000Z","ends_at":null,"is_all_day":false,"location":null,"signup_url":"https://example.com/e1","extra":1}]}"""
        val event = WireJson.decodeFromString(PublicEventsResponse.serializer(), body).events.single()
        assertEquals("2026-11-02T14:00:00.000Z", event.startsAt)
        assertEquals("https://example.com/e1", event.signupUrl)
    }
}
