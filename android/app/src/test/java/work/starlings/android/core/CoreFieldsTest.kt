package work.starlings.android.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/**
 * The editing, create, board and face rules (core-kit
 * `EntityFieldRow`, `TypeaheadPicker`, `CountryCatalog`,
 * `CharacteristicPillPicker`, `ContactBirthdayEditor`, `DynamicEntityFormView`,
 * `CRMBoardView`, `CRMEntityIdentity`, `ServerConfig.publicShareURL`) against
 * core-kit's registry fixture.
 */
class CoreFieldsTest {
    private val registry: CoreEntityContractData by lazy {
        val text = javaClass.classLoader!!.getResource("core/registry-v1.json")!!.readText()
        CoreJson.decodeFromString(CoreEntityContractData.serializer(), text)
    }

    private fun contract(id: String) = registry.entities.first { it.id == id }

    private fun json(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(
        pairs.associate { (k, v) ->
            k to when (v) {
                null -> JsonNull
                is String -> JsonPrimitive(v)
                is Number -> JsonPrimitive(v)
                is Boolean -> JsonPrimitive(v)
                is JsonElement -> v
                else -> error("value")
            }
        },
    )

    @Test
    fun everyKindTheRowEditsHasAControl() {
        val contacts = contract("contacts")
        assertTrue(CoreRules.isEditable(contacts.field("country")!!, contacts))
        assertTrue(CoreRules.isEditable(contacts.field("characteristics")!!, contacts))
        assertTrue(CoreRules.isEditable(contract("projects").field("contact_ids")!!, contract("projects")))
        assertTrue(CoreRules.isEditable(contract("interactions").field("occurred_at")!!, contract("interactions")))
        assertFalse("a read-only date-time shows its value", CoreRules.isEditable(contract("projects").field("last_viewed_at")!!, contract("projects")))
        assertFalse("an industry with no options shows its label", CoreRules.isEditable(contract("organizations").field("industry")!!, contract("organizations")))
        val industry = contract("organizations").field("industry")!!.copy(options = listOf(CoreFieldOption("ent_media", "Media")))
        assertTrue(CoreRules.isEditable(industry, contract("organizations")))
        val readOnly = contacts.copy(capabilities = contacts.capabilities.copy(update = false))
        assertFalse(CoreRules.isEditable(contacts.field("country")!!, readOnly))
        assertTrue("a new record writes what update would not", CoreRules.isEditable(contacts.field("country")!!, readOnly, canWrite = true))
    }

    @Test
    fun theTypeaheadPutsPrefixesFirstAndStopsAtEight() {
        val options = listOf("Ada Lovelace", "Grace Hopper", "Adam Smith", "Linda Adams").mapIndexed { i, t -> CoreFields.Option("c$i", t) }
        assertEquals(emptyList<CoreFields.Option>(), CoreFields.matches(options, emptyList(), " "))
        assertEquals(listOf("c0", "c2", "c3"), CoreFields.matches(options, emptyList(), "ad").map { it.id })
        assertEquals("what is chosen is not offered again", listOf("c2", "c3"), CoreFields.matches(options, listOf("c0"), "ad").map { it.id })
        val many = (1..20).map { CoreFields.Option("$it", "Item $it") }
        assertEquals(CoreFields.MAX_MATCHES, CoreFields.matches(many, emptyList(), "item").size)
        assertEquals(listOf(CoreFields.Option("gone", "gone")), CoreFields.selected(options, listOf("gone")))
    }

    @Test
    fun countriesStoreTheCodeAndReadEither() {
        assertEquals("NL", CoreFields.country("netherlands")!!.code)
        assertEquals("Netherlands", CoreFields.country("nl")!!.name)
        assertNull(CoreFields.country(" "))
        assertEquals(listOf("BR"), CoreFields.countrySelection("Brazil"))
        assertEquals("a legacy free-form value still shows", listOf("Atlantis"), CoreFields.countrySelection("Atlantis"))
        assertEquals("pt", CoreFields.preferredLanguage("BR"))
        assertEquals("pt", CoreFields.preferredLanguage("Portugal"))
        assertEquals("en", CoreFields.preferredLanguage("NL"))
    }

    @Test
    fun aStringListSplitsAtLinesAndCommas() {
        assertEquals(JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b"), JsonPrimitive("c"))), CoreFields.listValue("a, b\n\n c,"))
        assertEquals("a\nb", CoreFields.listText(JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b")))))
        assertEquals("", CoreFields.listText(null))
    }

    @Test
    fun characteristicPillsKeepANameTheVocabularyLost() {
        val vocabulary = listOf(CoreCharacteristicOption("1", "event_timeline"), CoreCharacteristicOption("2", "budget"))
        val value = json("legacy" to true, "budget" to false)
        assertEquals(listOf("event_timeline", "budget", "legacy"), CoreFields.pillNames(vocabulary, value))
        val on = CoreFields.toggle(value, "budget")
        assertTrue(CoreFields.isOn(on, "budget"))
        assertTrue(CoreFields.isOn(on, "legacy"))
        assertFalse(CoreFields.isOn(CoreFields.toggle(on, "budget"), "budget"))
        assertEquals(listOf("budget"), CoreFields.pillNames(listOf(CoreCharacteristicOption("2", "budget")), null))
    }

    @Test
    fun theMembersPickerNamesADepartedAssignee() {
        val members = listOf(CoreMember("m1", "Ada", "ada@x"), CoreMember("m2", null, "grace@x"), CoreMember("m3"))
        assertEquals(listOf("Ada", "grace@x", "m3"), members.map { it.displayLabel })
        val record = json("assigned_to" to "m9", "assignee" to json("id" to "m9", "name" to "Linus"))
        assertEquals(listOf("m9", "m1", "m2", "m3"), CoreFields.memberOptions(members, record).map { it.id })
        assertEquals(members, CoreFields.memberOptions(members, json("assignee" to json("id" to "m1"))))
        assertEquals("Linus", CoreFields.memberName("m9", members, record))
        assertEquals("Ada", CoreFields.memberName("m1", members, record))
        assertEquals("Old", CoreFields.memberName("m7", members, json("assignee_name" to "Old")))
        assertNull(CoreFields.memberName("", members, record))
    }

    @Test
    fun dateTimesGoAsUtcToTheSecond() {
        assertEquals("2026-10-29T09:30:15Z", CoreFields.iso(Instant.parse("2026-10-29T09:30:15.987Z")))
        assertEquals(Instant.parse("2026-10-29T08:00:00Z"), CoreFields.instant("2026-10-29T10:00:00+02:00"))
        assertNull(CoreFields.instant("tomorrow"))
        val interactions = contract("interactions")
        val seeded = CoreRules.seededValues(interactions, emptyMap(), LocalDate.of(2026, 10, 29), Instant.parse("2026-10-29T09:30:15.5Z"))
        assertEquals("a required date-time starts now", JsonPrimitive("2026-10-29T09:30:15Z"), seeded["occurred_at"])
    }

    @Test
    fun theBirthdayEditorKeepsADayThatExists() {
        assertEquals(CoreFields.Birthday(2, 29, null), CoreFields.birthday(json("birthday_month" to 2, "birthday_day" to 29)))
        assertNull("no February 29 in 2025", CoreFields.birthday(json("birthday_month" to 2, "birthday_day" to 29, "birthday_year" to 2025)))
        assertNull(CoreFields.birthday(json("birthday_month" to 13, "birthday_day" to 1)))
        val march31 = json("birthday_month" to 3, "birthday_day" to 31)
        assertEquals("a shorter month clears the day", JsonNull, CoreFields.setMonth(march31, 4)["birthday_day"])
        assertEquals(JsonNull, CoreFields.setMonth(march31, 0)["birthday_year"])
        val feb29 = json("birthday_month" to 2, "birthday_day" to 29)
        assertEquals(JsonNull, CoreFields.setYear(feb29, "2025")["birthday_day"])
        assertEquals(JsonPrimitive(2024.0), CoreFields.setYear(feb29, "20a24x")["birthday_year"])
        assertEquals(JsonNull, CoreFields.setYear(feb29, "")["birthday_year"])
        assertEquals(31, CoreFields.maximumDay(null, null))
        assertEquals(29, CoreFields.maximumDay(2, null))
        val contacts = contract("contacts")
        assertFalse("the day folds into the birthday row", CoreRules.isFieldVisible(contacts.field("birthday_day")!!, contacts, json("id" to "c"), emptyMap()))
        assertTrue(CoreRules.isFieldVisible(contacts.field("birthday_month")!!, contacts, json("id" to "c"), emptyMap()))
    }

    @Test
    fun relationTargetsOpenWhatTheRecordNames() {
        val projects = contract("projects")
        val field = projects.field("contact_ids")!!
        val record = json("contacts" to JsonArray(listOf(json("id" to "c1", "name" to "Ada"))))
        val targets = CoreFields.relationTargets(field, JsonArray(listOf(JsonPrimitive("c1"), JsonPrimitive("c2"))), record)
        assertEquals(listOf(CoreTarget("contacts", "c1", "Ada"), CoreTarget("contacts", "c2", null)), targets)
        val org = contract("contacts").field("organization_id")!!
        assertEquals(listOf(CoreTarget("organizations", "o1", "Acme")), CoreFields.relationTargets(org, JsonPrimitive("o1"), json("organization" to json("name" to "Acme"))))
        assertEquals(emptyList<CoreTarget>(), CoreFields.relationTargets(org, JsonPrimitive(""), json()))
        assertEquals("Plan", CoreFields.optionTitle(json("id" to "t1", "title" to "Plan")))
        assertEquals("t2", CoreFields.optionTitle(json("id" to "t2")))
    }

    @Test
    fun aNewRecordSendsItsSeededFields() {
        val tasks = contract("tasks")
        val values = CoreRules.seededValues(tasks, emptyMap()) + ("title" to JsonPrimitive("Plan"))
        val payload = CoreRules.payload(tasks, values)
        assertEquals(JsonPrimitive("Plan"), payload["title"])
        assertEquals("a select starts at its first option", JsonPrimitive(tasks.field("status")!!.options!!.first().value), payload["status"])
        assertTrue(tasks.canCreate)
        assertFalse(contract("support_cases").canCreate)
    }

    @Test
    fun theBoardIsTheRegistrysField() {
        val tasks = contract("tasks")
        assertEquals("status", tasks.board!!.field)
        assertNull(contract("contacts").board)
        val columns = CoreFields.boardColumns(tasks)
        assertEquals(tasks.field("status")!!.options, columns)
        assertEquals(emptyList<CoreFieldOption>(), CoreFields.boardColumns(contract("contacts")))
        val first = columns.first().value
        val second = columns[1].value
        val records = listOf(json("id" to "a", "status" to first), json("id" to "b", "status" to second))
        assertEquals(listOf("a"), CoreFields.boardRecords(records, "status", first).map { it.coreId })
        val moved = CoreFields.moved(records, "a", "status", second)
        assertEquals(listOf("a", "b"), CoreFields.boardRecords(moved, "status", second).map { it.coreId })
        assertEquals(records[1], moved[1])
    }

    @Test
    fun aFaceIsTheRecordsOwnAndHttpsOnly() {
        assertTrue(CoreFields.identity(contract("contacts")).centeredHeader)
        assertTrue(CoreFields.identity(contract("organizations")).showsAvatar)
        assertFalse(CoreFields.identity(contract("tasks")).showsAvatar)
        assertEquals("https://x/p.png", CoreFields.avatarUrl(json("profile_image_url" to "https://x/p.png")))
        assertNull("plain http does not load", CoreFields.avatarUrl(json("logo_image_url" to "http://x/l.png")))
        assertNull("a related record's picture is not this record's", CoreFields.avatarUrl(json("organization" to json("logo_image_url" to "https://x/l.png"))))
        assertEquals("AL", CoreFields.initials("ada  lovelace byron"))
        assertEquals("", CoreFields.initials(" "))
        assertTrue(CoreFields.squareAvatar("organizations"))
        assertEquals("Financial Services", CoreFields.headerSubtitle(contract("organizations"), json("industry" to "ent_financial_services")))
        val readOnly = contract("contacts").copy(capabilities = contract("contacts").capabilities.copy(update = false))
        assertTrue("a read-only face page names the record once", contract("contacts").primaryField in CoreFields.hiddenFieldNames(readOnly, canWrite = false))
    }

    @Test
    fun onlyNotesAndOffersHaveAPublicLink() {
        assertEquals("https://www.org.example/private/offer/o%201", CoreFields.publicShareUrl("offers", "o 1"))
        assertEquals("https://www.org.example/private/docs/n1", CoreFields.publicShareUrl("notes", "n1"))
        assertNull(CoreFields.publicShareUrl("tasks", "t1"))
        assertNull(CoreFields.publicShareUrl("offers", ""))
        assertEquals("mailto:ada@x", CoreFields.mailto(json("email" to "ada@x")))
        assertEquals("https://acme.example", CoreFields.link(json("url" to "https://acme.example")))
    }
}
