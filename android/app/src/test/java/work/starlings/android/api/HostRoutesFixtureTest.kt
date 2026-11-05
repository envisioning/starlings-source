package work.starlings.android.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.HostDevice
import java.io.File

/** [HostRoutes] against `fixtures/routes.json`, as [RouteFixtureTest] holds the other areas, and their bodies against Swift's. */
class HostRoutesFixtureTest {
    private val routes: List<Route<*>> = listOf(
        HostRoutes.hostSession(HostDevice.IPHONE, null),
        HostRoutes.heartbeat("rosa", "m1"),
        HostRoutes.claim("rosa", "m1", HostDevice.IPHONE, ifVacant = true),
        HostRoutes.release("rosa", "m1"),
        HostRoutes.offer("rosa", "m1", "ana+mac-m1@org.example"),
        HostRoutes.answerOffer("rosa", "m1", accept = true),
        HostRoutes.lobby("rosa"),
        HostRoutes.decide("rosa", "r1", admit = true, onBehalfOf = null),
        HostRoutes.closeSessionDoor("rosa"),
        HostRoutes.end("rosa", "m1", everyone = false),
        HostRoutes.finalize("rosa", "m1"),
        HostRoutes.stopScreenShare("rosa", "m1", "ana@org.example"),
        HostRoutes.mute("rosa", "m1", null),
        HostRoutes.remove("rosa", "m1", "ana@org.example"),
        HostRoutes.lowerAllHands("rosa", "m1"),
        HostRoutes.category("rosa", "m1"),
        HostRoutes.setCategory("rosa", "m1", work.starlings.android.host.MeetingFiling.update(work.starlings.contracts.MeetingKind.STATUS, null)),
        HostRoutes.transcript("rosa", "m1"),
    )

    @Test
    fun everyHostRouteIsOneTheWorkerAnswers() {
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
    fun bodiesFollowSwift() {
        assertEquals("""{"device":"iphone"}""", HostRoutes.hostSession(HostDevice.IPHONE, null).body)
        assertEquals("""{"device":"ipad","room":"team"}""", HostRoutes.hostSession(HostDevice.IPAD, "team").body)
        assertEquals("""{"device":"iphone","if_vacant":true}""", HostRoutes.claim("r", "m", HostDevice.IPHONE, true).body)
        assertEquals("""{"device":"iphone"}""", HostRoutes.claim("r", "m", HostDevice.IPHONE, false).body)
        assertEquals("""{"admit":true}""", HostRoutes.decide("r", "q", true, null).body)
        assertEquals("""{"admit":false,"on_behalf_of":"ana@org.example"}""", HostRoutes.decide("r", "q", false, "ana@org.example").body)
        assertEquals("{}", HostRoutes.end("r", "m", everyone = false).body)
        assertEquals("""{"everyone":true}""", HostRoutes.end("r", "m", everyone = true).body)
        assertEquals("{}", HostRoutes.heartbeat("r", "m").body)
        assertEquals("""{"target_identity":"ana+mac-m1@org.example"}""", HostRoutes.offer("r", "m", "ana+mac-m1@org.example").body)
        assertEquals("""{"accept":false}""", HostRoutes.answerOffer("r", "m", accept = false).body)
        assertNull(HostRoutes.closeSessionDoor("r").body)
        assertEquals("{}", HostRoutes.mute("r", "m", null).body)
        assertEquals("""{"identity":"guest:ana"}""", HostRoutes.mute("r", "m", "guest:ana").body)
        assertEquals("""{"identity":"guest:ana"}""", HostRoutes.remove("r", "m", "guest:ana").body)
        assertEquals("""{"identity":"guest:ana"}""", HostRoutes.stopScreenShare("r", "m", "guest:ana").body)
        assertEquals("Couldn’t mute everyone else", HostRoutes.mute("r", "m", null).operation)
        assertNull("Lower all hands sends no body, as Swift", HostRoutes.lowerAllHands("r", "m").body)
        assertEquals("DELETE", HostRoutes.lowerAllHands("r", "m").method)
        assertEquals("Couldn’t mute that person", HostRoutes.mute("r", "m", "guest:ana").operation)
        assertEquals("PUT", HostRoutes.setCategory("r", "m", work.starlings.android.host.MeetingFiling.update(work.starlings.contracts.MeetingKind.STATUS, null)).method)
        assertNull(HostRoutes.category("r", "m").body)
        assertNull("a lease, a queue and a door are never snapshots", routes.firstNotNullOfOrNull { it.snapshotKey })
    }
}
