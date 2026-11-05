package work.starlings.android.workspace.work

import work.starlings.android.workspace.QuickNoteFiling
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmTaskCreate
import work.starlings.contracts.QuickNotePromotionKind
import work.starlings.contracts.WireJson
import java.io.File

/** [QuickNoteFiling] against `fixtures/quick-note-values.json` and `MobileQuickNoteTriageSheet`. */
class QuickNoteFilingTest {
    private fun subject(kind: CrmSubjectKind, id: String, title: String) = CrmSubjectWire(kind = kind, id = id, title = title)

    @Test
    fun theKindsAreTheRegistrysSubjectDestinationsInOrder() {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        val triage = Json.parseToJsonElement(File(dir, "quick-note-values.json").readText()).jsonObject["triage"]!!.jsonArray
            .map { it.jsonObject["kind"]!!.jsonPrimitive.content }
        assertEquals(listOf("task", "issue"), triage.take(2))
        assertEquals(triage.take(2), QuickNoteFiling.kinds.filter(QuickNoteFiling::needsSubject).map { it.value })
        // Work's sheet, where the workspace has Docs: every destination the registry names, in its order.
        assertEquals(triage, QuickNoteFiling.withDocs.map { it.value })
        assertTrue(QuickNoteFiling.canFile(QuickNotePromotionKind.DOC, "", "", "Notes", busy = false))
        assertTrue(QuickNoteFiling.canFile(QuickNotePromotionKind.MESSAGE, "", "t1", "", busy = false))
    }

    @Test
    fun firstLineAndOffers() {
        assertEquals("Call Rosa", QuickNoteFiling.firstLine("  Call Rosa \nabout the deck"))
        val p = subject(CrmSubjectKind.PROJECT, "p1", "beta")
        val l = subject(CrmSubjectKind.LEAD, "l1", "Alpha")
        val o = subject(CrmSubjectKind.ORGANIZATION, "o1", "Gamma")
        assertEquals(listOf(p), QuickNoteFiling.offered(listOf(p, l, o), QuickNotePromotionKind.ISSUE))
        assertEquals(listOf(l, p, o), QuickNoteFiling.sorted(listOf(p, l, o, p), emptySet()))
        assertEquals(listOf(o, l, p), QuickNoteFiling.sorted(listOf(p, l, o), setOf("organization:o1")))
        assertFalse(QuickNoteFiling.canFile(QuickNotePromotionKind.TASK, "", "", "x", busy = false))
        assertFalse(QuickNoteFiling.canFile(QuickNotePromotionKind.TASK, QuickNoteFiling.key(p), "", "  ", busy = false))
        assertTrue(QuickNoteFiling.canFile(QuickNotePromotionKind.TASK, QuickNoteFiling.key(p), "", "x", busy = false))
        assertFalse(QuickNoteFiling.canFile(QuickNotePromotionKind.MESSAGE, QuickNoteFiling.key(p), "", "x", busy = false))
    }

    @Test
    fun theTaskAndIssueBodies() {
        val partner = subject(CrmSubjectKind.ORGANIZATION, "o1", "Echos")
        val sameTitle = WireJson.encodeToString(CrmTaskCreate.serializer(), QuickNoteFiling.task("Call Rosa", " Call Rosa ", partner))
        assertEquals("""{"title":"Call Rosa","status":"pending","responsible_party":"team","organization_id":"o1"}""", sameTitle)
        val project = subject(CrmSubjectKind.PROJECT, "p1", "Acme")
        val withNotes = WireJson.encodeToString(CrmTaskCreate.serializer(), QuickNoteFiling.task("Call Rosa\nabout it", "Call Rosa", project))
        assertEquals("""{"title":"Call Rosa","notes":"Call Rosa\nabout it","status":"pending","responsible_party":"team","project_id":"p1"}""", withNotes)
        val issue = QuickNoteFiling.issue("body", " Title ", project)
        assertEquals("p1", issue.projectId)
        assertEquals("Title", issue.title)
    }
}
