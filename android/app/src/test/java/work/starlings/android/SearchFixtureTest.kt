package work.starlings.android

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * `Search.kt` against `fixtures/search-rows.json` and `search-values.json`,
 * as `Tests/SearchFixtureTests.swift` holds the Swift. A failure is a
 * question about the fixture first.
 */
class SearchFixtureTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private val table by lazy { fixture("search-rows.json") }
    private val JsonElement.string get() = jsonPrimitive.content
    private fun JsonElement?.strings(): List<String> = (this as? JsonArray)?.map { it.string }.orEmpty()
    private fun JsonObject.stringMap(key: String): Map<String, String> =
        this[key]!!.jsonObject.mapValues { it.value.string }
    private fun JsonObject.listMap(key: String): Map<String, List<String>> =
        this[key]!!.jsonObject.mapValues { it.value.strings() }

    private fun row(o: JsonObject): SearchRow? = SearchRow.fromWire(
        kind = o["kind"]!!.string,
        id = o["id"]!!.string,
        title = o["title"]!!.string,
        subtitle = o["subtitle"]!!.string,
        door = o["door"]!!.string,
        image = o["image"]?.string,
    )

    private val rows by lazy {
        table["rows"]!!.jsonArray.map { requireNotNull(row(it.jsonObject)) { "not a row: $it" } }
    }

    /** The fixture spells a parsed door as the TypeScript union does. */
    private fun parsed(o: JsonObject): SearchDoor = when (val to = o["to"]!!.string) {
        "destination" -> SearchDoor.Destination(SearchDestination.read(o["destination"]!!.string)!!)
        "settings" -> SearchDoor.Settings(SearchSettingsPage.read(o["page"]!!.string)!!)
        "verb" -> SearchDoor.Verb(SearchVerb.read(o["verb"]!!.string)!!)
        "subject" -> SearchDoor.Subject(SearchSubjectKind.read(o["subjectKind"]!!.string)!!, o["id"]!!.string)
        else -> SearchDoor.Thing(SearchKind.read(to)!!, o["id"]!!.string)
    }

    @Test
    fun tablesMatchTheCode() {
        assertEquals("The fixture changed shape; re-read its rules.", 1, table["version"]!!.jsonPrimitive.int)
        assertEquals(table["kinds"].strings(), Search.kinds.map { it.wire })
        assertEquals(table["hitKinds"].strings(), Search.hitKinds.map { it.wire })
        assertEquals(table["doorKinds"].strings(), Search.doorKinds.map { it.wire })
        assertEquals(table["destinations"].strings(), SearchDestination.entries.map { it.wire })
        assertEquals(table["settingsPages"].strings(), SearchSettingsPage.entries.map { it.wire })
        assertEquals(table["verbs"].strings(), SearchVerb.entries.map { it.wire })
        val personVerbs = table.listMap("personVerbs")
        assertEquals(personVerbs["person"], SearchPersonVerb.entries.map { it.wire })
        for (kind in SearchKind.entries) {
            assertEquals(kind.wire, personVerbs[kind.wire].orEmpty(), Search.personVerbs(kind).map { it.wire })
        }
        val subjectVerbs = table.listMap("subjectVerbs")
        assertEquals(subjectVerbs["project"], SearchSubjectVerb.entries.map { it.wire })
        for (kind in SearchSubjectKind.entries) {
            assertEquals(kind.wire, subjectVerbs[kind.wire].orEmpty(), Search.subjectVerbs(kind).map { it.wire })
        }
        val scopes = table.listMap("scopes")
        assertEquals(scopes.keys, Search.Scope.entries.map { it.wire }.toSet())
        for (scope in Search.Scope.entries) {
            assertEquals(scope.wire, scopes[scope.wire], scope.kinds.map { it.wire })
        }
    }

    @Test
    fun wordsMatchTheValues() {
        val values = fixture("search-values.json")
        assertEquals(1, values["version"]!!.jsonPrimitive.int)
        assertEquals(values.stringMap("kindLabels"), SearchKind.entries.associate { it.wire to it.label })
        assertEquals(values.stringMap("settingsTitles"), SearchSettingsPage.entries.associate { it.wire to it.title })
        assertEquals(values.stringMap("verbTitles"), SearchVerb.entries.associate { it.wire to it.title })
        assertEquals(values.stringMap("personVerbTitles"), SearchPersonVerb.entries.associate { it.wire to it.title })
        assertEquals(values.stringMap("subjectVerbTitles"), SearchSubjectVerb.entries.associate { it.wire to it.title })
        // The Go to doors are the member surfaces, titles and order.
        val surfaces = fixture("member-surfaces.json")["surfaces"]!!.jsonArray.map { it.jsonObject }
        assertEquals(
            surfaces.map { it["id"]!!.string to it["title"]!!.string },
            SearchDestination.entries.map { it.wire to it.title },
        )
    }

    @Test
    fun everyRowInTheCorpusIsARow() {
        assertFalse(rows.isEmpty())
        assertEquals("row keys are unique", rows.size, rows.map { it.key }.toSet().size)
        table["rows"]!!.jsonArray.zip(rows).forEach { (raw, row) ->
            assertEquals(row.key, raw.jsonObject["door"]!!.string, row.door.string)
        }
    }

    @Test
    fun everyDoorReadsAndWrites() {
        for (raw in table["doors"]!!.jsonArray) {
            val entry = raw.jsonObject
            val text = entry["door"]!!.string
            val door = SearchDoor.parse(text)
            assertNotNull(text, door)
            assertEquals(text, door!!.string)
            assertEquals(text, parsed(entry["parsed"]!!.jsonObject), door)
        }
        for (bad in table["badDoors"].strings()) {
            assertNull("\"$bad\" parsed", SearchDoor.parse(bad))
            assertNull("\"$bad\" read as a row", SearchRow.fromWire("verb", "x", "x", "", bad))
        }
    }

    @Test
    fun everyFixtureCase() {
        val cases = table["cases"]!!.jsonArray.map { it.jsonObject }
        assertFalse(cases.isEmpty())
        for (c in cases) {
            val name = c["name"]!!.string
            val scope = requireNotNull(Search.Scope.read(c["scope"]!!.string)) { name }
            val order = requireNotNull(Search.Order.read(c["order"]!!.string)) { name }
            val found = Search.run(rows, c["query"]!!.string, scope.kinds, order, c["recents"].strings())
            assertEquals(name, c["expect"].strings(), found.map { it.key })
        }
    }

    @Test
    fun recentsRememberOnceNewestFirstAndNeverADoor() {
        val nadia = rows.first { it.id == "nadia@example.com" }
        val doc = rows.first { it.id == "doc_42" }
        val door = rows.first { it.kind == SearchKind.DESTINATION }
        var recents = Search.remember(emptyList(), doc)
        recents = Search.remember(recents, nadia)
        recents = Search.remember(recents, doc)
        recents = Search.remember(recents, door)
        assertEquals(listOf("document:doc_42", "person:nadia@example.com"), recents)
        assertEquals(listOf("document:doc_42", "a:1"), Search.remember(listOf("a:1", "b:2"), doc, limit = 2))
    }

    @Test
    fun doorRowsAreDoorsAndNoDocsDropsNewDocument() {
        val all = Search.doorRows()
        assertEquals(
            table["destinations"].strings().map { "destination:$it" } +
                table["settingsPages"].strings().map { "settings:$it" } +
                table["verbs"].strings().map { "verb:$it" },
            all.map { it.key },
        )
        all.forEach { assertEquals(it.key, it.key, it.doorString) }
        assertFalse(Search.doorRows(hasDocs = false).any { it.door == SearchDoor.Verb(SearchVerb.NEW_DOCUMENT) })
    }
}
