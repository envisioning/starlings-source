package work.starlings.android.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.AttachmentStageRequest
import work.starlings.contracts.FavoriteTarget
import work.starlings.contracts.FavoriteTargetKind
import work.starlings.contracts.ThreadReleaseAction
import java.io.File

/** Team's picture, file, link and question routes against `fixtures/routes.json`. */
class TeamMediaRoutesTest {
    private val routes: List<Route<*>> = listOf(
        TeamMediaRoutes.avatar("a@b.c", 1),
        TeamMediaRoutes.attachment("t", "a"),
        TeamMediaRoutes.stageAttachment("t", AttachmentStageRequest("n", "image/png", 1)),
        TeamMediaRoutes.uploadAttachment("/api/threads/t/attachments/a"),
        TeamMediaRoutes.linkPreview("https://example.com"),
        TeamMediaRoutes.answerQuestion("t", "m", listOf("o")),
        TeamMediaRoutes.updateRelease("t", "m", ThreadReleaseAction.APPROVE),
        TeamMediaRoutes.addFavorite(FavoriteTarget(FavoriteTargetKind.MEET_THREAD, "t")),
        TeamMediaRoutes.removeFavorite(FavoriteTarget(FavoriteTargetKind.MEET_THREAD, "t")),
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
    fun uploadPathDropsTheApiPrefix() {
        assertEquals(listOf("threads", "t", "attachments", "a"), TeamMediaRoutes.uploadAttachment("/api/threads/t/attachments/a").path)
    }

    @Test
    fun avatarSendsTheVersionInMilliseconds() {
        assertEquals(listOf("email" to "a@b.c", "v" to "1700000000000"), TeamMediaRoutes.avatar("a@b.c", 1_700_000_000_000).query)
    }

    @Test
    fun unstarNamesTheTargetInTheQuery() {
        assertEquals(listOf("kind" to "meet.thread", "target_ref" to "t"), TeamMediaRoutes.removeFavorite(FavoriteTarget(FavoriteTargetKind.MEET_THREAD, "t")).query)
    }

    @Test
    fun answerSendsTheOptionIds() {
        assertEquals("""{"option_ids":["o","p"]}""", TeamMediaRoutes.answerQuestion("t", "m", listOf("o", "p")).body)
    }

    @Test
    fun aReleaseUpdateSendsOnlyTheAction() {
        assertEquals("""{"action":"end"}""", TeamMediaRoutes.updateRelease("t", "m", ThreadReleaseAction.END).body)
    }
}
