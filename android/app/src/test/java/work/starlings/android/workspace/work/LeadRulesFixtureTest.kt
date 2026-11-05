package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.UntriagedTouchPrefill
import work.starlings.contracts.WireJson
import java.io.File
import java.time.LocalDate

/**
 * The New Lead rules against `lead-qualification.json`, `subject-status.json`,
 * `form-fields.json` and `sales-values.json`, the tables the Swift and web
 * editors are generated from.
 */
class LeadRulesFixtureTest {
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), name).readText(),
    ).jsonObject

    @Test
    fun qualificationKeysFollowTheTable() {
        assertEquals(fixture("lead-qualification.json")["keys"]!!.jsonArray.map { it.jsonPrimitive.content }, LeadQualification.keys)
        val merged = LeadQualification.merged(mapOf("other" to true), "project_fit", true)
        assertEquals(mapOf("other" to true, "project_fit" to true), merged)
        assertEquals(merged, LeadQualification.merged(merged, "unknown", true))
        assertEquals(1, LeadQualification.count(merged))
    }

    @Test
    fun leadStatusesFollowTheTable() {
        val lead = fixture("subject-status.json")["kinds"]!!.jsonObject["lead"]!!.jsonObject
        assertEquals(lead["statuses"]!!.jsonArray.map { it.jsonPrimitive.content }, LeadForm.statuses)
        assertEquals(lead["defaultStatus"]!!.jsonPrimitive.content, LeadForm.DEFAULT_STATUS)
    }

    @Test
    fun leadFieldRulesFollowTheTable() {
        val fields = fixture("form-fields.json")["forms"]!!.jsonObject["lead"]!!.jsonArray.associateBy { it.jsonObject["id"]!!.jsonPrimitive.content }
        listOf(LeadForm.title, LeadForm.organization, LeadForm.contact, LeadForm.startDate, LeadForm.notes).forEach { spec ->
            val row = fields.getValue(spec.id).jsonObject
            assertEquals(spec.id, row["required"]!!.jsonPrimitive.content != "none", spec.required)
            val max = row["maxLength"]?.takeIf { it != JsonNull }?.jsonPrimitive?.intOrNull
            assertEquals(spec.id, max, spec.maxLength)
        }
    }

    @Test
    fun aSaveNamesTheFirstProblem() {
        assertEquals(LeadForm.Problem.Required("title"), LeadForm.problem("  ", null, ""))
        assertEquals(LeadForm.Problem.Required("organization"), LeadForm.problem("Atlas", null, ""))
        assertEquals(LeadForm.Problem.TooLong("title", 100), LeadForm.problem("x".repeat(101), "o1", ""))
        assertNull(LeadForm.problem("Atlas", "o1", ""))
    }

    @Test
    fun theCreateSendsWhatWasSet() {
        val create = LeadForm.create(" Atlas ", "Conversations", LocalDate.of(2026, 10, 28), "  ", "o1", null, mapOf("project_fit" to true))
        assertEquals(
            """{"title":"Atlas","organization_id":"o1","status":"Conversations","start_date":"2026-10-28","characteristics":{"project_fit":true},"kind":"lead"}""",
            WireJson.encodeToString(work.starlings.contracts.CrmLeadCreate.serializer(), create),
        )
    }

    @Test
    fun sourceLabelsAndDraftNotesFollowSwift() {
        val labels = fixture("sales-values.json")["labels"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(labels, SalesTouch.labels)
        val prefill = UntriagedTouchPrefill(title = "Rosa", notes = "Wants pricing", organizationName = "Acme", contactName = "Rosa", contactEmail = "rosa@acme.test")
        assertEquals("Wants pricing\nOrganization: Acme\nContact: Rosa · rosa@acme.test", SalesTouch.draftNotes(prefill))
        assertEquals("Contact: x@y.test", SalesTouch.draftNotes(UntriagedTouchPrefill(title = "", notes = "", contactEmail = "x@y.test")))
    }

    @Test
    fun createIsOfferedForANewNameOnly() {
        assertTrue(RelationSearch.canCreate("Acmé", "acme", listOf("Acme Labs"), searching = false, failed = false))
        assertFalse(RelationSearch.canCreate("Acme", "Acme", listOf("ACME"), searching = false, failed = false))
        assertFalse(RelationSearch.canCreate("A", "A", emptyList(), searching = false, failed = false))
        assertFalse(RelationSearch.canCreate("Acme", "Acm", emptyList(), searching = false, failed = false))
        assertFalse(RelationSearch.canCreate("Acme", "Acme", emptyList(), searching = false, failed = true))
    }
}
