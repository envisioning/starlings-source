package work.starlings.android.share

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.ShareRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.share.ShareIntake.Shared
import java.io.File
import java.io.IOException
import java.nio.file.Files

class ShareTest {
    // Intake

    @Test
    fun aBareLinkIsALinkTitledBySubject() {
        assertEquals(Shared.Link("https://example.com/a", "A page"), ShareIntake.read(" https://example.com/a ", "A page"))
        assertEquals(Shared.Link("https://example.com/a", ""), ShareIntake.read("https://example.com/a", null))
    }

    @Test
    fun oneLineAroundTheLinkIsItsTitle() {
        assertEquals(Shared.Link("https://example.com/a?b=1", "Read this"), ShareIntake.read("Read this https://example.com/a?b=1.", ""))
    }

    @Test
    fun moreTextIsAQuickNote() {
        val text = "Call Rosa\nabout https://example.com/a"
        assertEquals(Shared.Note(text), ShareIntake.read(text, "ignored"))
        assertEquals(Shared.Note("Buy milk"), ShareIntake.read("  Buy milk ", null))
    }

    @Test
    fun plainHttpIsNotAPage() {
        assertEquals(Shared.Note("http://example.com"), ShareIntake.read("http://example.com", null))
    }

    @Test
    fun emptyIsNothing() {
        assertEquals(Shared.Empty, ShareIntake.read("  ", "x"))
        assertEquals(Shared.Empty, ShareIntake.read(null, null))
    }

    @Test
    fun aLongNoteIsCutAtTheWorkersLimit() {
        val body = (ShareIntake.read("x".repeat(6_000), null) as Shared.Note).body
        assertEquals(ShareIntake.NOTE_MAX_CHARS, body.length)
    }

    // Outbox

    private fun item(id: String, at: Long, origin: String = "https://w.example") =
        ShareOutboxItem(id, at, origin, ShareOutboxItem.Kind.NOTE, body = "n $id")

    private fun temp(): File = Files.createTempDirectory("share").toFile()

    @Test
    fun eachOwnerHasTheirOwnShares() {
        val root = temp()
        ShareOutbox(root, "https://w.example", "a@x.com").write(item("1", 1))
        assertEquals(listOf("1"), ShareOutbox(root, "https://w.example", "A@X.com").pending().map { it.id })
        assertEquals(emptyList<String>(), ShareOutbox(root, "https://w.example", "b@x.com").pending().map { it.id })
    }

    @Test
    fun aFileThatDoesNotReadIsRemoved() {
        val root = temp()
        val outbox = ShareOutbox(root, "https://w.example", "a@x.com")
        outbox.write(item("1", 1))
        val folder = root.listFiles()!!.single()
        File(folder, "bad.json").writeText("{")
        assertEquals(listOf("1"), outbox.pending().map { it.id })
        assertTrue(!File(folder, "bad.json").exists())
    }

    @Test
    fun drainGoesOldestFirstAndStopsWhenOffline() = runBlocking {
        val outbox = ShareOutbox(temp(), "https://w.example", "a@x.com")
        outbox.write(item("late", 3))
        outbox.write(item("early", 1))
        outbox.write(item("refused", 2))
        val sent = mutableListOf<String>()
        val result = outbox.drain {
            sent += it.id
            when (it.id) {
                "refused" -> throw StarlingsApiError.Service("op", 422, null, null)
                "late" -> throw StarlingsApiError.Offline("op", IOException())
            }
        }
        assertEquals(listOf("early", "refused", "late"), sent)
        assertEquals(
            mapOf("early" to ShareOutbox.Outcome.SENT, "refused" to ShareOutbox.Outcome.REFUSED, "late" to ShareOutbox.Outcome.KEPT),
            result,
        )
        assertEquals(listOf("late"), outbox.pending().map { it.id })
    }

    @Test
    fun whatWaitsAndWhatIsDropped() {
        assertEquals(ShareOutbox.Outcome.KEPT, ShareOutbox.outcome(StarlingsApiError.Service("op", 429, null, null)))
        assertEquals(ShareOutbox.Outcome.KEPT, ShareOutbox.outcome(StarlingsApiError.Service("op", 503, null, null)))
        assertEquals(ShareOutbox.Outcome.KEPT, ShareOutbox.outcome(StarlingsApiError.SessionRefused("op")))
        assertEquals(ShareOutbox.Outcome.KEPT, ShareOutbox.outcome(StarlingsApiError.SignedOut("op")))
        assertEquals(ShareOutbox.Outcome.REFUSED, ShareOutbox.outcome(StarlingsApiError.Service("op", 400, null, null)))
        assertEquals(ShareOutbox.Outcome.SENT, ShareOutbox.outcome(StarlingsApiError.Undecodable("op", "T")))
    }

    @Test
    fun anotherWorkspacesSharesWait() {
        val root = temp()
        ShareOutbox(root, "https://other.example", "a@x.com").write(item("o", 1, "https://other.example"))
        assertEquals(emptyList<String>(), ShareOutbox(root, "https://w.example", "a@x.com").pending())
    }

    // Route

    @Test
    fun theNoteRouteIsOneTheWorkerAnswers() {
        val route = ShareRoutes.createQuickNote("Call Rosa", "n1", 1)
        assertEquals("""{"body":"Call Rosa","source":"home","id":"n1","captured_at":1}""", route.body)
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val table = Json.parseToJsonElement(File(dir, "routes.json").readText()).jsonObject["routes"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertTrue(route.signature in table)
    }
}
