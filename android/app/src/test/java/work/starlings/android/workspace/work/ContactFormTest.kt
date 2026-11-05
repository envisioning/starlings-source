package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CrmContact
import work.starlings.contracts.CrmContactCreate
import work.starlings.contracts.CrmContactUpdate
import work.starlings.contracts.WireJson
import java.io.File

/**
 * The contact editor against `form-fields.json` (the contact form) and the
 * edit `MobileContactEditorView.save` sends with `ContactProfileDraft.apply`.
 */
class ContactFormTest {
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), name).readText(),
    ).jsonObject

    private fun body(update: CrmContactUpdate) = WireJson.encodeToString(CrmContactUpdate.serializer(), update)

    @Test
    fun fieldRulesFollowTheTable() {
        val forms = fixture("form-fields.json")["forms"]!!.jsonObject["contact"]!!.jsonArray.map { it.jsonObject }
        assertEquals(forms.map { it["id"]!!.jsonPrimitive.content }, listOf(ContactForm.name, ContactForm.title, ContactForm.organization, ContactForm.emails).map { it.id })
        val rows = forms.associateBy { it["id"]!!.jsonPrimitive.content }
        listOf(ContactForm.name, ContactForm.title, ContactForm.organization, ContactForm.emails).forEach { spec ->
            val row = rows.getValue(spec.id)
            assertEquals(spec.id, row["label"]!!.jsonPrimitive.content, spec.label)
            assertEquals(spec.id, row["required"]!!.jsonPrimitive.content != "none", spec.required)
            assertEquals(spec.id, row["maxLength"]?.takeIf { it != JsonNull }?.jsonPrimitive?.intOrNull, spec.maxLength)
        }
        // What an edit's blank sends: the title and organization clear, the addresses go whole.
        assertEquals("null", rows.getValue("title")["update"]!!.jsonPrimitive.content)
        assertEquals("null", rows.getValue("organization")["update"]!!.jsonPrimitive.content)
        assertEquals("send", rows.getValue("emails")["update"]!!.jsonPrimitive.content)
    }

    @Test
    fun addressesSplitLowerAndDropBlanks() {
        assertEquals(listOf("rosa@a.com", "r@b.org", "x@c.io"), ContactForm.emails(" Rosa@A.com \n\nr@b.org; X@c.io ,"))
    }

    @Test
    fun aSaveNamesTheFirstProblem() {
        assertEquals(LeadForm.Problem.Required("Name"), ContactForm.problem("  ", ""))
        assertEquals(LeadForm.Problem.TooLong("Title", 200), ContactForm.problem("Rosa", "x".repeat(201)))
        assertNull(ContactForm.problem("Rosa", ""))
    }

    @Test
    fun anUnchangedProfileSendsOnlyTheFourFields() {
        val draft = ContactProfileDraft(birthdayMonth = 3, birthdayDay = 4, characteristics = mapOf("vip" to true), preferredLanguage = "pt")
        val update = ContactForm.update(" Rosa ", "  ", null, "rosa@a.com", draft, draft)
        assertEquals("""{"name":"Rosa","title":null,"organization_id":null,"emails":["rosa@a.com"]}""", body(update))
        assertEquals(
            """{"name":"Rosa","title":"CEO","organization_id":"o1","emails":[]}""",
            body(ContactForm.update("Rosa", " CEO ", "o1", "", draft, draft)),
        )
    }

    @Test
    fun aChangedProfileSendsWhatChanged() {
        val before = ContactProfileDraft(birthdayMonth = 3, birthdayDay = 4, birthdayYear = 1980, characteristics = mapOf("vip" to true), signalsOutreachStatus = "notified")
        val after = before.withMonth(null).copy(characteristics = emptyMap(), preferredLanguage = "pt", signalsOutreachStatus = null)
        assertEquals(
            """{"name":"Rosa","title":null,"organization_id":null,"emails":[],"characteristics":null,"preferred_language":"pt",""" +
                """"signals_outreach_status":null,"birthday_month":null,"birthday_day":null,"birthday_year":null}""",
            body(ContactForm.update("Rosa", "", null, "", after, before)),
        )
    }

    private fun body(create: CrmContactCreate) = WireJson.encodeToString(CrmContactCreate.serializer(), create)

    @Test
    fun aNewContactLeavesOutWhatIsNotSet() {
        val rows = fixture("form-fields.json")["forms"]!!.jsonObject["contact"]!!.jsonArray.map { it.jsonObject }.associateBy { it["id"]!!.jsonPrimitive.content }
        // What a new contact's blank sends: the title and organization are left out, the addresses go whole.
        assertEquals("omit", rows.getValue("title")["create"]!!.jsonPrimitive.content)
        assertEquals("omit", rows.getValue("organization")["create"]!!.jsonPrimitive.content)
        assertEquals("send", rows.getValue("emails")["create"]!!.jsonPrimitive.content)
        assertEquals("""{"name":"Rosa","emails":[]}""", body(ContactForm.create(" Rosa ", "  ", null, "", ContactProfileDraft())))
        assertEquals(
            """{"name":"Rosa","title":"CEO","organization_id":"o1","emails":["rosa@a.com"]}""",
            body(ContactForm.create("Rosa", " CEO ", "o1", "Rosa@A.com", ContactProfileDraft())),
        )
    }

    @Test
    fun aNewContactSendsTheProfileItSets() {
        val draft = ContactProfileDraft(birthdayMonth = 3, birthdayDay = 4, characteristics = mapOf("vip" to true), preferredLanguage = "pt", signalsOutreachStatus = "notified")
        assertEquals(
            """{"name":"Rosa","emails":[],"characteristics":{"vip":true},"preferred_language":"pt",""" +
                """"signals_outreach_status":"notified","birthday_month":3,"birthday_day":4}""",
            body(ContactForm.create("Rosa", "", null, "", draft)),
        )
        // English is the Worker's default: a new contact does not send it.
        assertEquals("""{"name":"Rosa","emails":[]}""", body(ContactForm.create("Rosa", "", null, "", ContactProfileDraft(preferredLanguage = "en"))))
    }

    @Test
    fun aMergePicksAnotherContactAndReadsTheOneKept() {
        val rows = listOf(
            CrmContact(id = "c1", name = "Rosa", emails = emptyList()),
            CrmContact(id = "c2", name = " ", email = "r@b.org", emails = listOf("r@b.org")),
            CrmContact(id = "c3", name = "Ana", emails = emptyList()),
        )
        assertEquals(listOf("c2" to "r@b.org", "c3" to "Ana"), ContactMerge.candidates(rows, own = "c1"))
        assertNull(ContactMerge.survivor("c1", kept = "c1"))
        assertEquals("c2", ContactMerge.survivor("c1", kept = "c2"))
        val answer = work.starlings.contracts.CoreMergeResponseData(work.starlings.contracts.CoreMergeResponseDataEntity.CONTACTS, kept = "c1", merged = listOf("c2", "c1", "c2"))
        assertEquals("the kept id never leaves the recents", listOf("c2"), ContactMerge.mergedAway(answer))
    }

    @Test
    fun theBirthdayNeedsAMonthAndADay() {
        assertNull(ContactProfileDraft().birthdayProblem)
        assertEquals(ContactProfileDraft.NEEDS_MONTH_AND_DAY, ContactProfileDraft(birthdayYear = 1990).birthdayProblem)
        assertEquals(ContactProfileDraft.NEEDS_MONTH_AND_DAY, ContactProfileDraft(birthdayMonth = 2).birthdayProblem)
        assertEquals(ContactProfileDraft.NOT_A_DATE, ContactProfileDraft(birthdayMonth = 13, birthdayDay = 1).birthdayProblem)
        assertEquals(ContactProfileDraft.YEAR_RANGE, ContactProfileDraft(birthdayMonth = 2, birthdayDay = 1, birthdayYear = 1800).birthdayProblem)
        assertNull(ContactProfileDraft(birthdayMonth = 2, birthdayDay = 29).birthdayProblem)
    }

    @Test
    fun aMonthStartsTheDayAndNoMonthClearsTheBirthday() {
        assertEquals(ContactProfileDraft(birthdayMonth = 5, birthdayDay = 1), ContactProfileDraft().withMonth(5))
        assertEquals(ContactProfileDraft(), ContactProfileDraft(birthdayMonth = 5, birthdayDay = 9, birthdayYear = 2000).withMonth(null))
        assertEquals(1984, ContactProfileDraft().withYear("19a845").birthdayYear)
        assertNull(ContactProfileDraft(birthdayYear = 1).withYear("").birthdayYear)
    }

    @Test
    fun offDropsANameTheContactDidNotCarry() {
        val initial = ContactProfileDraft(characteristics = mapOf("vip" to true))
        val on = initial.withCharacteristic("board_member", true, initial)
        assertEquals(mapOf("vip" to true, "board_member" to true), on.characteristics)
        assertEquals(initial.characteristics, on.withCharacteristic("board_member", false, initial).characteristics)
        assertEquals(mapOf("vip" to false), initial.withCharacteristic("vip", false, initial).characteristics)
        assertEquals(listOf("a", "board_member", "vip"), ContactProfileDraft.characteristicNames(listOf("vip", "a"), on.characteristics))
        assertEquals("Board member", ContactFieldText.characteristic("board_member"))
    }
}
