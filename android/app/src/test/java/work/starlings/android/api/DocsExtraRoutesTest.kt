package work.starlings.android.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** The Docs comment routes against `fixtures/routes.json`, as `RouteFixtureTest` holds the others. */
class DocsExtraRoutesTest {
    private val routes: List<Route<*>> = listOf(
        DocsExtraRoutes.annotations("d1"),
        DocsExtraRoutes.createAnnotation("d1", "hello", null),
        DocsExtraRoutes.setAnnotationStatus("a1", "resolved"),
        DocsRoutes.documents(listOf("source" to "native"), 200, 200),
        DocsRoutes.categories,
        DocsRoutes.saveLink(work.starlings.contracts.DocsCreateDocumentRequest(url = "https://example.com")),
        DocsExtraRoutes.create(work.starlings.android.workspace.docs.DocsCreateDocument("Plan")),
        DocsExtraRoutes.update("d1", work.starlings.android.workspace.docs.DocsUpdateDocument(title = "Plan")),
        DocsExtraRoutes.move("d1", "/work"),
        DocsExtraRoutes.setSubjects("d1", emptyList()),
        DocsShareRoutes.grants("d1"),
        DocsShareRoutes.createGrant("d1", work.starlings.android.workspace.docs.DocsCreateGrant("viewer")),
        DocsShareRoutes.revokeGrant("g1"),
        DocsShareRoutes.setVisibility("d1", "link"),
        DocsShareRoutes.createSignatureRequest("d1", work.starlings.android.workspace.docs.DocsShare.signatureRequest("a@b.co", "", "")),
        DocsImageRoutes.linkImage("d1"),
        DocsImageRoutes.image("d1", "i1"),
        DocsImageRoutes.upload("d1"),
        DocsImageRoutes.delete("d1", "i1"),
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
    fun bodiesAreDocsSnakeCaseWithoutNulls() {
        assertEquals("""{"body_md":"hello"}""", DocsExtraRoutes.createAnnotation("d1", "hello", null).body)
        assertEquals("""{"body_md":"hi","parent_id":"a1"}""", DocsExtraRoutes.createAnnotation("d1", "hi", "a1").body)
        assertEquals("""{"status":"open"}""", DocsExtraRoutes.setAnnotationStatus("a1", "open").body)
        assertEquals(listOf(SnapshotWrite.COMMENT_RESOLVE), DocsExtraRoutes.setAnnotationStatus("a1", "resolved").writes)
        assertEquals(listOf("source" to "native", "limit" to "200", "offset" to "200"), DocsRoutes.documents(listOf("source" to "native"), 200, 200).query)
    }
}
