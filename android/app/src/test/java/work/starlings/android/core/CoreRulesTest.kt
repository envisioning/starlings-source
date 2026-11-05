package work.starlings.android.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.CoreRoutes
import work.starlings.android.core.ui.CoreDoor
import work.starlings.android.workspace.docs.DocsCoreSource
import work.starlings.android.workspace.docs.DocsSubject
import work.starlings.android.workspace.docs.DocsSubjects
import work.starlings.android.workspace.work.SubjectMenuFacts
import work.starlings.android.workspace.work.WorkPage
import work.starlings.android.workspace.work.WorkRowActions
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Locale

/**
 * Core on Android against core-kit's registry fixture
 * (`src/test/resources/core/registry-v1.json`, a copy of core-kit's
 * `Tests/CoreKitTests/Fixtures/registry-v1.json`, which Core generates), and
 * against the shared fixtures the Swift and web suites read.
 */
class CoreRulesTest {
    private val registry: CoreEntityContractData by lazy {
        val text = javaClass.classLoader!!.getResource("core/registry-v1.json")!!.readText()
        CoreJson.decodeFromString(CoreEntityContractData.serializer(), text)
    }

    private fun contract(id: String) = registry.entities.first { it.id == id }

    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private fun record(vararg pairs: Pair<String, Any?>) = JsonObject(
        pairs.associate { (k, v) ->
            k to when (v) {
                null -> JsonNull
                is String -> JsonPrimitive(v)
                is Number -> JsonPrimitive(v)
                is Boolean -> JsonPrimitive(v)
                is JsonObject -> v
                is JsonArray -> v
                else -> error("value")
            }
        },
    )

    @Test
    fun decodesTheGeneratedRegistry() {
        // `decodesGeneratedCoreRegistryFixture` in core-kit's own suite.
        assertEquals("crm", registry.space)
        assertEquals(16, registry.entities.size)
        val month = contract("contacts").field("birthday_month")!!
        assertEquals("number", month.kind)
        assertEquals(1.0, month.min)
        assertEquals(12.0, month.max)
        assertNotNull(contract("contacts").field("birthday_year"))
    }

    @Test
    fun accessNarrowsCapabilities() {
        // `decodesRegistryAccessSeparatelyFromCapabilities`.
        val json = """{"space":"crm","schemaVersion":4,"grantedScopes":[],"entities":[{"id":"licenses","singularLabel":"License","pluralLabel":"Licenses","icon":"receipt","primaryField":"product","secondaryFields":[],"capabilities":{"list":true,"read":true,"create":true,"update":true,"delete":true,"search":true},"access":{"canRead":false,"canWrite":false,"missingScopes":["licenses:read","licenses:write"]},"fields":[]}]}"""
        val license = CoreJson.decodeFromString(CoreEntityContractData.serializer(), json).entities.single()
        assertTrue(license.capabilities.create)
        assertFalse(license.hasReadAccess)
        assertFalse(license.canCreate)
        assertFalse(license.canList)
        assertEquals(listOf("licenses:read", "licenses:write"), license.access?.missingScopes)
        assertTrue("an older registry has no access and reads as granted", contract("tasks").canUpdate)
    }

    @Test
    fun theBlockLeavesWorkItsOwnDoors() {
        val ids = CoreRules.blockEntities(registry.entities).map { it.id }
        assertFalse(ids.any { it in setOf("projects", "leads", "organizations", "contacts") })
        assertTrue("tasks" in ids)
        assertEquals(12, ids.size)
        assertEquals("lead", CoreRules.workSubjectKind("leads"))
        assertEquals("project", CoreRules.workSubjectKind("projects"))
        assertNull(CoreRules.workSubjectKind("organizations"))
    }

    @Test
    fun fieldsGroupByTheirSection() {
        val groups = CoreRules.fieldGroups(contract("contacts"))
        assertEquals("Basic Information", groups.first().label)
        assertTrue(groups.first().fields.any { it.name == "name" })
        assertFalse(groups.any { group -> group.fields.any { it.kind == "section" } })
        // Every field but the section markers lands in exactly one group.
        assertEquals(contract("contacts").fields.count { it.kind != "section" }, groups.sumOf { it.fields.size })
        val flat = CoreEntityContract(
            "x", "X", "Xs", "", "name", emptyList(), CoreCapabilities(true, true, true, true, true),
            fields = listOf(CoreFieldContract("name", "Name", "text"), CoreFieldContract("body", "Body", "text", section = "page_content")),
        )
        assertEquals(listOf(CoreRules.OVERVIEW, "Page Content"), CoreRules.fieldGroups(flat).map { it.label })
    }

    @Test
    fun filtersAndDatesComeFromTheContract() {
        assertEquals(listOf("preferred_language", "signals_outreach_status"), contract("contacts").filterableFields.map { it.name }.take(2))
        assertTrue(contract("organizations").filterableFields.any { it.name == "is_partner" })
        assertEquals("due_date", contract("tasks").dateField)
        assertEquals("session_date", contract("signals_worksessions").dateField)
        assertNull(contract("organizations").dateField)
        assertEquals(CoreRules.SortOrder.NEWEST, CoreRules.SortOrder.initial("dateAscending", contract("organizations")))
        assertEquals(CoreRules.SortOrder.DATE_ASCENDING, CoreRules.SortOrder.initial("dateAscending", contract("tasks")))
        assertFalse(CoreRules.SortOrder.offered(contract("organizations")).any { it.usesDateField })
        assertTrue(CoreRules.SortOrder.entries.none { it.title.contains('—') })
    }

    @Test
    fun aListFiltersSearchesAndSorts() {
        val tasks = contract("tasks")
        val rows = listOf(
            record("id" to "1", "title" to "Écrire le plan", "status" to "pending", "due_date" to "2026-11-02", "created_at" to "2026-10-01"),
            record("id" to "2", "title" to "Call Ada", "status" to "done", "due_date" to null, "created_at" to "2026-10-03"),
            record("id" to "3", "title" to "brief Bo", "status" to "pending", "due_date" to "2026-10-30", "created_at" to "2026-10-02"),
        )
        fun ids(list: List<JsonObject>) = list.map { it.coreId }
        assertEquals(listOf("2", "3", "1"), ids(CoreRules.visibleRecords(rows, tasks, "", emptyMap(), CoreRules.SortOrder.NEWEST)))
        assertEquals(listOf("3", "1", "2"), ids(CoreRules.visibleRecords(rows, tasks, "", emptyMap(), CoreRules.SortOrder.DATE_ASCENDING)))
        assertEquals("undated stays last", listOf("1", "3", "2"), ids(CoreRules.visibleRecords(rows, tasks, "", emptyMap(), CoreRules.SortOrder.DATE_DESCENDING)))
        assertEquals(listOf("3", "2", "1"), ids(CoreRules.visibleRecords(rows, tasks, "", emptyMap(), CoreRules.SortOrder.NAME_ASCENDING, Locale.ENGLISH)))
        assertEquals("case and accents fold", listOf("1"), ids(CoreRules.visibleRecords(rows, tasks, "ecrire", emptyMap(), CoreRules.SortOrder.NEWEST)))
        assertEquals(listOf("1", "3"), ids(CoreRules.visibleRecords(rows, tasks, "", mapOf("status" to "pending"), CoreRules.SortOrder.OLDEST)))
        // A toggle reads a missing value as false; any other kind fails closed.
        assertTrue(CoreRules.matches(record("id" to "x"), "is_partner", "false", "toggle"))
        assertFalse(CoreRules.matches(record("id" to "x"), "status", "", "select"))
    }

    @Test
    fun valuesReadAsCoreKitWritesThem() {
        val orgs = contract("organizations")
        val industry = CoreFieldContract("industry", "Industry", "industry")
        assertEquals("Financial Services", CoreRules.industryLabel("ent_financial_services"))
        assertEquals("Financial Services", CoreRules.displayValue(industry, record("industry" to "ent_financial_services")))
        assertEquals("Yes", CoreRules.displayValue(CoreFieldContract("is_partner", "Partner", "toggle"), record("is_partner" to true)))
        val relation = CoreFieldContract("organization_id", "Organization", "relation", relationEntity = "organizations")
        assertEquals("Acme", CoreRules.displayValue(relation, record("organization_id" to "o1", "organization" to record("name" to "Acme"))))
        val date = CoreFieldContract("due_date", "Due", "date")
        assertEquals("October 29, 2026", CoreRules.displayValue(date, record("due_date" to "2026-10-29"), Locale.US))
        val select = contract("tasks").field("status")!!
        val option = select.options!!.first()
        assertEquals(option.label, CoreRules.displayValue(select, record("status" to option.value)))
        assertEquals("Netherlands", CoreCountries.name("nl"))
        assertEquals("Event Timeline", CoreRules.characteristicLabel("event_timeline"))
        assertEquals(listOf("a", "c"), CoreRules.characteristicNames(record("a" to true, "b" to false, "c" to true)))
        assertEquals("12", JsonPrimitive(12.0).coreString())
        assertEquals("Acme BV", CoreRules.rowDetails(orgs, record("name" to "Acme", "legal_name" to "Acme BV")).single())
        assertEquals(listOf("Acme", "CTO"), CoreRules.rowDetails(contract("contacts"), record("name" to "Ada", "organization" to record("name" to "Acme"), "company_role" to "CTO")))
        assertEquals("Acme", record("id" to "1", "organization" to record("name" to "Acme")).coreDisplayName("title"))
    }

    @Test
    fun aSaveSendsOnlyWhatThePageEdits() {
        val tasks = contract("tasks")
        val seeded = CoreRules.seededValues(tasks, record("id" to "t1", "title" to "Plan"), today = LocalDate.of(2026, 10, 29))
        val payload = CoreRules.payload(tasks, seeded)
        assertFalse("hidden and read-only fields stay home", payload.keys.any { name -> tasks.field(name)?.let { it.hidden == true || it.readOnly == true } ?: false })
        assertEquals(JsonPrimitive("Plan"), payload["title"])
        // A cleared optional goes as null; the assignee clears off work that is not the team's.
        val cleared = CoreRules.payload(tasks, seeded + ("notes" to JsonPrimitive("")) + ("assigned_to" to JsonPrimitive("m1")) + ("responsible_party" to JsonPrimitive("client")))
        if (tasks.field("notes")?.required != true && tasks.field("notes") != null) assertEquals(JsonNull, cleared["notes"])
        if (tasks.field("assigned_to")?.optionsSource == "members") assertEquals(JsonNull, cleared["assigned_to"])
        assertEquals("an unchanged page is not dirty", payload, CoreRules.payload(tasks, seeded.toMap()))
        assertTrue(CoreRules.requiredPresent(tasks, seeded))
        assertFalse(CoreRules.requiredPresent(tasks, seeded + ("title" to JsonPrimitive("  "))))
        val name = contract("contacts").field("name")!!
        assertEquals(100, CoreRules.text(name, "x".repeat(140)).content.length)
    }

    @Test
    fun aReadOnlyPageLeavesEmptyFieldsOut() {
        val readOnly = contract("policies").copy(capabilities = CoreCapabilities(true, true, false, false, false))
        val field = readOnly.fields.first { it.kind == "text" }
        assertFalse(CoreRules.isFieldVisible(field, readOnly, record("id" to "p"), emptyMap()))
        assertTrue(CoreRules.isFieldVisible(field, contract("policies"), record("id" to "p"), emptyMap()))
        assertFalse(CoreRules.isEditable(field, readOnly))
        assertTrue(CoreRules.isEditable(field, contract("policies")))
        assertFalse("a directory select shows its value", CoreRules.isEditable(contract("contacts").field("source_key")!!, contract("contacts")))
        assertTrue("the members picker edits", CoreRules.isEditable(contract("tasks").field("assigned_to")!!, contract("tasks")))
        assertTrue(CoreRules.isEditable(contract("tasks").field("status")!!, contract("tasks")))
        assertTrue("a relation edits", CoreRules.isEditable(contract("contacts").field("organization_id")!!, contract("contacts")))
    }

    @Test
    fun signalsFollowTheFunnel() {
        assertEquals("notified", CoreSignals.nextStatus("to_notify"))
        assertNull("interested ends the positive path", CoreSignals.nextStatus("interested"))
        assertNull(CoreSignals.nextStatus("not_interested"))
    }

    @Test
    fun linksAndGroupsFollowTheSharedConstants() {
        val groups = fixture("shared-constants.json")["maps"]!!.jsonObject["coreCollectionGroups"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(groups, CoreLinks.collectionGroups)
        assertTrue(CoreLinks.holds("projects", null))
        assertFalse(CoreLinks.holds("projects", listOf("tasks")))
        assertTrue("events are outside every group", CoreLinks.holds("events", listOf("tasks")))
        assertEquals("https://core.example.com/dashboard/projects/p%201", CoreLinks.dashboard("https://core.example.com/", "projects", "p 1"))
        assertEquals("organizations", CoreLinks.collection("organization"))
        assertTrue(CoreLinks.acceptsOrigin("https://core.example.com", debug = false))
        assertFalse(CoreLinks.acceptsOrigin("http://core.example.com", debug = true))
        assertFalse(CoreLinks.acceptsOrigin("http://localhost:3000", debug = false))
        assertTrue(CoreLinks.acceptsOrigin("http://localhost:3000", debug = true))
    }

    @Test
    fun theTokenRouteIsOneTheWorkerAnswers() {
        val table = fixture("routes.json")["routes"]!!.jsonArray.map { it.jsonPrimitive.content }
        val route = CoreRoutes.token("Pixel")
        assertTrue(route.signature in table)
        assertEquals("{\"device_name\":\"Pixel\"}", route.body)
    }

    @Test
    fun theCredentialRenewsInItsLastWeekAndNeverPrintsItsToken() {
        val base = Instant.parse("2026-10-29T00:00:00Z").toEpochMilli()
        fun credential(expires: String) = CoreCredential("pat_secret", listOf("crm"), expires, "rosa@example.com", "https://a", "https://core")
        assertFalse(credential("2026-12-30T00:00:00Z").expiresSoon(base))
        assertTrue(credential("2026-11-03T00:00:00Z").expiresSoon(base))
        assertTrue(credential("soon").expiresSoon(base))
        assertFalse(credential("2026-12-30T00:00:00Z").toString().contains("pat_secret"))
        val wire = CoreJson.encodeToString(CoreCredential.serializer(), credential("2026-12-30T00:00:00.000Z"))
        assertEquals(credential("2026-12-30T00:00:00.000Z"), CoreJson.decodeFromString(CoreCredential.serializer(), wire))
        assertEquals(LocalDate.of(2026, 12, 30), credential("2026-12-30T00:00:00.000Z").expiry?.atZone(ZoneOffset.UTC)?.toLocalDate())
    }

    @Test
    fun coreFailuresReadAsCoreKitWordsThem() {
        assertEquals("Not allowed [forbidden]", CoreClient.failure(403, """{"error":"Not allowed","code":"forbidden"}"""))
        assertEquals("Gone", CoreClient.failure(404, """{"error":"Gone"}"""))
        assertEquals("Request failed (502).", CoreClient.failure(502, "<html>"))
    }

    @Test
    fun theStackKeepsACoreDoor() {
        val doors = listOf(CoreDoor.Page, CoreDoor.Entity("tasks"), CoreDoor.Record("tasks", "t1", "Plan"), CoreDoor.Record("tasks", "t2", null), CoreDoor.Search, CoreDoor.New("tasks"))
        for (door in doors) assertEquals(WorkPage.Core(door), WorkPage.decode(WorkPage.encode(WorkPage.Core(door))))
    }

    @Test
    fun openInCoreRidesTheSubjectMenuWhenTheSubjectHasACorePage() {
        val subject = work.starlings.contracts.CrmSubjectWire(
            id = "p1", kind = work.starlings.contracts.CrmSubjectKind.PROJECT, title = "Pilot",
        )
        fun has(core: Boolean) = WorkRowActions.groups(WorkRowActions.Kind.SUBJECT, "row", SubjectMenuFacts.of(subject, hasCore = core)).flatten()
        assertTrue("open-core" in has(true))
        assertFalse("open-core" in has(false))
    }

    @Test
    fun docsAsksCoreForContactsAndOffersOnceLinked() = runBlocking {
        val hits = listOf(
            CoreSearchResult("contacts", "c1", "Ada"), CoreSearchResult("offers", "f1", "Pilot offer"),
            CoreSearchResult("tasks", "t1", "Plan"), CoreSearchResult("organizations", "o1", "Acme"),
        )
        assertEquals(listOf("contact", "offer", "organization"), DocsSubjects.coreHits(hits).map { it.subject.kind })
        val source = object : DocsCoreSource {
            var asked: Pair<String, Int>? = null
            override suspend fun name(entity: String, id: String) = if (entity == "contacts" && id == "c1") "Ada" else null
            override suspend fun search(query: String, limit: Int): List<CoreSearchResult> { asked = query to limit; return hits }
        }
        val directory = work.starlings.android.workspace.docs.CoreSubjectDirectory(source)
        assertEquals(3, directory.search("ad").size)
        assertEquals("ad" to DocsSubjects.LIMIT, source.asked)
        assertEquals(emptyList<Any>(), directory.search("a"))
        assertEquals("Ada", directory.name(DocsSubject(kind = "contact", subjectId = "c1")))
        assertNull("a kind Core does not name", directory.name(DocsSubject(kind = "event", subjectId = "e1")))
        val failing = object : DocsCoreSource {
            override suspend fun name(entity: String, id: String): String? = error("offline")
            override suspend fun search(query: String, limit: Int): List<CoreSearchResult> = error("offline")
        }
        assertEquals(emptyList<Any>(), work.starlings.android.workspace.docs.CoreSubjectDirectory(failing).search("ada"))
        assertNull(work.starlings.android.workspace.docs.CoreSubjectDirectory(failing).name(DocsSubject(kind = "contact", subjectId = "c1")))
    }
}
