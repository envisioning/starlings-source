package work.starlings.android.workspace.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.AccountRoutes
import work.starlings.android.api.Route
import work.starlings.contracts.McpCallEntry
import work.starlings.contracts.McpCallMethod
import work.starlings.contracts.McpCallOutcome
import work.starlings.contracts.McpCallPrincipal
import work.starlings.contracts.McpGrant
import work.starlings.contracts.McpScope
import java.io.File

/** Settings › Account's picture and connected agents: routes, constants and the lines iOS reads. */
class AccountSectionsTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private val routes: List<Route<*>> = listOf(
        AccountRoutes.uploadAvatar,
        AccountRoutes.removeAvatar,
        AccountRoutes.mcpGrants,
        AccountRoutes.mcpGrantCalls("g"),
        AccountRoutes.revokeMcpGrant("g"),
        AccountRoutes.setMcpGrantPaused("g", true),
        AccountRoutes.setMcpGrantPaused("g", false),
    )

    @Test
    fun everyRouteIsOneTheWorkerAnswers() {
        val patterns = fixture("routes.json")["routes"]!!.jsonArray.map { it.jsonPrimitive.content }.map { line ->
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
        assertEquals(emptyList<String>(), unanswered)
        assertTrue(AccountRoutes.uploadAvatar.origin && AccountRoutes.removeAvatar.origin)
    }

    @Test
    fun constantsAreTheSharedOnes() {
        val f = fixture("shared-constants.json")
        val strings = f["strings"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(strings["mcpPath"], McpConnector.PATH)
        assertEquals(strings["mcpConnectHelpPath"], McpConnector.HELP_PATH)
        assertEquals(strings["mcpServerNamePrefix"], McpConnector.SERVER_NAME_PREFIX)
        assertEquals(f["numbers"]!!.jsonObject["avatarEdgePixels"]!!.jsonPrimitive.int, ProfilePicture.EDGE)
        assertEquals("Starlings · Envisioning", McpConnector.name())
        assertEquals("https://example.com/mcp", McpConnector.address("https://example.com/"))
        assertEquals("https://example.com/help/howto/connect-claude", McpConnector.helpUrl("https://example.com"))
    }

    @Test
    fun squareIsCentred() {
        assertEquals(Triple(100, 0, 600), ProfilePicture.square(800, 600))
        assertEquals(Triple(0, 50, 300), ProfilePicture.square(300, 400))
        assertEquals(Triple(0, 0, 512), ProfilePicture.square(512, 512))
    }

    private fun grant(scopes: List<McpScope>, paused: Long? = null) = McpGrant("g", "c", "Claude", scopes, 1, pausedAt = paused)

    private fun call(outcome: McpCallOutcome, detail: String? = null) =
        McpCallEntry("1", 1, McpCallPrincipal("member"), "a@b.c", null, McpCallMethod("tools/call"), "search", null, outcome, detail, 3)

    @Test
    fun grantLines() {
        assertTrue(McpGrantLines.writes(grant(listOf(McpScope.READ, McpScope.WRITE))))
        assertFalse(McpGrantLines.writes(grant(listOf(McpScope.READ))))
        assertTrue(McpGrantLines.paused(grant(listOf(McpScope.READ), paused = 5)))
        assertNull(McpGrantLines.refusal(call(McpCallOutcome.OK)))
        assertEquals("refused", McpGrantLines.refusal(call(McpCallOutcome.REFUSED)))
        assertEquals("failed · timeout", McpGrantLines.refusal(call(McpCallOutcome.FAILED, "timeout")))
        assertEquals("failed", McpGrantLines.refusal(call(McpCallOutcome.FAILED, "")))
    }
}
