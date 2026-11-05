package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind
import java.io.File

/** [OrganizationFilter.query] against the organization-filter cases of `fixtures/subject-query.json`. */
class OrganizationFilterFixtureTest {
    private val cases = Json.parseToJsonElement(
        File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), "subject-query.json").readText(),
    ).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }.filter { "organizations" in it }

    private fun JsonObject.text(key: String): String? = this[key]?.jsonPrimitive?.content

    @Test
    fun everyFilterCaseSendsTheSameQuery() {
        assert(cases.isNotEmpty())
        cases.forEach { case ->
            val o = case["organizations"]!!.jsonObject
            val filter = OrganizationFilter(
                partner = o["partner"]?.jsonPrimitive?.booleanOrNull ?: true,
                agency = o["agency"]?.jsonPrimitive?.booleanOrNull == true,
                existingClient = o["existing_client"]?.jsonPrimitive?.booleanOrNull == true,
                industry = o.text("industry"),
                country = o.text("country"),
            )
            val expected = case["out"]!!.jsonArray.map { pair -> pair.jsonArray.let { it[0].jsonPrimitive.content to it[1].jsonPrimitive.content } }
            assertEquals(case.text("name"), expected, filter.query(CrmSubjectKind.of(case.text("kind")!!), case.text("query").orEmpty()).queryItems())
        }
    }

    @Test
    fun theDefaultKeepsNothing() {
        assertNull(OrganizationFilter().encoded())
        assertNull(OrganizationFilter(industry = " ").snapshotTag)
        val kept = OrganizationFilter(partner = false, agency = true, country = "Portugal")
        assertEquals("partner=false&agency=true&country=Portugal", kept.snapshotTag)
        assertEquals(kept, OrganizationFilter.decoded(kept.encoded()))
    }
}
