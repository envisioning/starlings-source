package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Locale

/** [ContactFilter.query] against `fixtures/contact-query.json`, as `CrmContactsQuery.list` and `contactListSearchParams`. */
class ContactFilterFixtureTest {
    private val cases = Json.parseToJsonElement(
        File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), "contact-query.json").readText(),
    ).jsonObject["cases"]!!.jsonArray

    private fun JsonObject.text(key: String): String? = this[key]?.jsonPrimitive?.content

    @Test
    fun everyCaseSendsTheSameQuery() {
        cases.forEach { element ->
            val case = element.jsonObject
            val f = case["filter"]!!.jsonObject
            val filter = ContactFilter(
                organizationId = f.text("organization_id"),
                country = f.text("country"),
                partner = f["partner"]?.jsonPrimitive?.booleanOrNull == true,
                existingClient = f["existing_client"]?.jsonPrimitive?.booleanOrNull == true,
                signalsOutreachStatus = f.text("signals_outreach_status"),
                preferredLanguage = f.text("preferred_language"),
            )
            val expected = case["out"]!!.jsonArray.map { pair -> pair.jsonArray.let { it[0].jsonPrimitive.content to it[1].jsonPrimitive.content } }
            assertEquals(case.text("name"), expected, filter.query(case.text("query")!!).queryItems())
        }
    }

    @Test
    fun theDefaultIsForgottenAndASavedFilterComesBack() {
        assertTrue(ContactFilter(country = "  ").isDefault)
        assertEquals(null, ContactFilter().encoded())
        val kept = ContactFilter(organizationId = "o1", organizationName = "Acme", partner = true, signalsOutreachStatus = "replied")
        assertFalse(kept.isDefault)
        assertEquals(kept, ContactFilter.decoded(kept.encoded()))
        assertEquals(ContactFilter(), ContactFilter.decoded("not json"))
        assertEquals("Netherlands", ContactFilter.countryName("nl", Locale.ENGLISH))
        assertEquals("Portuguese", ContactFilter.languageName("pt", Locale.ENGLISH))
    }
}
