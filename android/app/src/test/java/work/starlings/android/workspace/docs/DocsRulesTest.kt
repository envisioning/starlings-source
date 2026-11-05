package work.starlings.android.workspace.docs

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

/** The Docs rules (DocsRules.kt) and models (DocsModels.kt) against DocsKit's behaviour and the shared fixtures. */
class DocsRulesTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    @Test
    fun railTableIsTheFixture() {
        val rows = fixture("rail-blocks.json")["blocks"]!!.jsonObject["docs"]!!.jsonArray.map { it.jsonObject }
        assertEquals(
            rows.map { RailBlock(it["id"]!!.jsonPrimitive.content, it["key"]!!.jsonPrimitive.content, it["hidesWhenEmpty"]!!.jsonPrimitive.boolean) },
            DocsRules.railTable,
        )
    }

    @Test
    fun blocksKeepTheTableOrderAndHideOnlyWhatMayHide() {
        assertEquals(DocsBlock.entries.toList(), DocsRules.blocks(emptySet()).map { it.first })
        val empty = DocsBlock.entries.toSet()
        // EXPLORE, WORK and LIBRARY stay while empty.
        assertEquals(listOf(DocsBlock.EXPLORE, DocsBlock.WORK, DocsBlock.LIBRARY), DocsRules.blocks(empty).map { it.first })
    }

    @Test
    fun foldersLeftOutAreTheSharedConstant() {
        val list = fixture("shared-constants.json")["lists"]!!.jsonObject["docsRailFoldersLeftOut"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(list, DocsRules.railFoldersLeftOut)
    }

    @Test
    fun selectionWordsAreTheFixture() {
        val words = fixture("docs-values.json")["selectionWords"]!!.jsonObject
        val strings = Regex("""<string name="([a-z_]+)"[^>]*>([^<]*)</string>""")
            .findAll(File("src/main/res/values/strings_docs.xml").readText())
            .associate { it.groupValues[1] to it.groupValues[2] }
        fun word(row: String, field: String) = words[row]!!.jsonObject[field]!!.jsonPrimitive.content
        assertEquals(word("recent", "title"), strings["docs_recent"])
        assertEquals(word("recent", "empty"), strings["docs_recent_empty"])
        assertEquals(word("links", "title"), strings["docs_links"])
        assertEquals(word("links", "empty"), strings["docs_links_empty"])
        assertEquals(word("unfiled", "title"), strings["docs_unfiled"])
        assertEquals(word("unfiled", "empty"), strings["docs_unfiled_empty"])
        assertEquals(word("subject", "empty"), strings["docs_subject_empty"])
        assertEquals(word("folder", "empty"), strings["docs_folder_empty"])
    }

    @Test
    fun listReadsSendDocsKitsQueries() {
        assertEquals(listOf("source" to "native"), DocsListRead.Written().filter)
        assertEquals(200, DocsListRead.Written().limit)
        assertEquals(listOf("subject" to "core:project:p1"), DocsSelection.Subject("project", "p1", "Pilot").read!!.filter)
        assertEquals(100, DocsSelection.Subject("project", "p1", "Pilot").read!!.limit)
        assertEquals(listOf("category" to "brief", "source" to "core,obsidian"), DocsSelection.Category("brief", DocsRailHalf.LIBRARY).read!!.filter)
        assertEquals(listOf("source" to "native", "source_kind" to "link"), DocsSelection.Links.read!!.filter)
        assertEquals(listOf("unfiled" to "1"), DocsSelection.Unfiled.read!!.filter)
        assertEquals(listOf("prefix" to "/clients"), DocsSelection.Folder("/clients", "Clients").read!!.filter)
        assertEquals(200, DocsSelection.Recent.read!!.limit)
        assertNull(DocsSelection.Search("x").read)
    }

    private val summaryJson = """
        {"categories":[{"category":"brief","label":"Brief","count":3},{"category":"memo","label":"Memo","count":0}],
         "by_source":[{"source":"native","category":"brief","label":"Brief","count":1},
                      {"source":"core","category":"brief","label":"Brief","count":2},
                      {"source":"obsidian","category":"case-study","label":"Case study","count":4}],
         "folders":[{"path":"/work","title":"Work","count":9},{"path":"/clients","title":"Clients","count":0},
                    {"path":"/archive","title":"Archive","count":2},{"path":"/published","title":"Published","count":5}],
         "links":2,"total":12,"future_field":true}
    """

    @Test
    fun summaryDecodesAndSplitsIntoHalves() {
        val summary = DocsJson.summary(Json.parseToJsonElement(summaryJson))
        assertEquals(0, summary.unfiled)
        assertEquals(2, summary.links)
        val work = DocsRules.categories(summary, DocsRailHalf.WORK, includeEmpty = true)
        assertEquals(listOf("brief" to 1, "memo" to 0), work.map { it.category to it.count })
        assertEquals(listOf("brief" to 1), DocsRules.categories(summary, DocsRailHalf.WORK).map { it.category to it.count })
        // A by_source category the list lacks shows last.
        val library = DocsRules.categories(summary, DocsRailHalf.LIBRARY)
        assertEquals(listOf("brief" to 2, "case-study" to 4), library.map { it.category to it.count })
        assertEquals("Case study", DocsRules.fallbackLabel("case-study"))
        assertEquals("Unknown thing", DocsRules.label(summary, "unknown-thing"))
    }

    @Test
    fun anOlderSummaryPutsEveryCategoryOnWork() {
        val summary = DocsJson.summary(Json.parseToJsonElement("""{"categories":[{"category":"brief","label":"Brief","count":3}],"folders":[],"total":3}"""))
        assertEquals(listOf("brief"), DocsRules.categories(summary, DocsRailHalf.WORK).map { it.category })
        assertTrue(DocsRules.categories(summary, DocsRailHalf.LIBRARY).isEmpty())
    }

    @Test
    fun foldersLeaveOutWorkAndPublishedAndKeepAnEmptyMoveTarget() {
        val summary = DocsJson.summary(Json.parseToJsonElement(summaryJson))
        val tree = DocsJson.tree(Json.parseToJsonElement("""
            {"folders":[{"id":"f1","path":"/clients","slug":"clients","title":"Clients","depth":0},
                        {"id":"f2","path":"/mirror","slug":"mirror","title":"Mirror","depth":0,"source_key":"vault"}]}
        """))
        assertEquals(listOf("/clients", "/archive"), DocsRules.folders(summary.folders, tree).map { it.path })
        assertEquals(listOf("/archive"), DocsRules.folders(summary.folders, emptyList()).map { it.path })
    }

    private fun document(id: String, subjects: String = "[]", extra: String = "") = """
        {"id":"$id","path":"/work/$id","slug":"$id","title":"Doc $id","kind":"markdown","visibility":"internal",
         "status":"active","source_system":"native","editable":true,"version":2,"byte_size":10,"content_hash":"h",
         "tags":[],"category":null,"subjects":$subjects,"created_at":"2026-10-01T09:00:00Z",
         "updated_at":"2026-10-03T10:00:00.000Z","updated_by":"rosa@org.example"$extra}
    """

    @Test
    fun documentsDecodeStrictlyButIgnoreNewKeys() {
        val list = DocsJson.documentList(Json.parseToJsonElement("""{"documents":[${document("a", extra = ""","shiny":1""")}],"total":1}"""))
        val row = list.documents.single()
        assertFalse(row.transcript)
        assertEquals("2026-10-01T09:00:00Z", row.written)
        // A field DocsKit requires is required here too.
        assertThrows(DocsUndecodable::class.java) {
            DocsJson.documentList(Json.parseToJsonElement("""{"documents":[{"id":"a"}],"total":1}"""))
        }
    }

    @Test
    fun aSearchHitBecomesARow() {
        val hit = DocsJson.searchHits(Json.parseToJsonElement("""
            [{"id":"d1","path":"/work/notes/plan","title":"Plan","kind":"markdown","source_system":"core","updated_at":"2026-10-01T09:00:00Z","snippet":"a <mark>plan</mark>"}]
        """)).single()
        val row = DocsDocumentSummary.of(hit)
        assertEquals("plan", row.slug)
        assertFalse(row.editable)
        assertNull(row.category)
    }

    private fun subject(id: String, title: String) = CrmSubjectWire(id = id, kind = CrmSubjectKind.PROJECT, title = title)

    @Test
    fun groupsCountMostFirstThenByTitleAndSkipUnnamedSubjects() {
        fun about(vararg ids: String) = ids.joinToString(",", "[", "]") { """{"system":"core","kind":"project","subject_id":"$it"}""" }
        val written = DocsJson.documentList(Json.parseToJsonElement("""
            {"documents":[${document("a", about("p1", "p2"))},${document("b", about("p2"))},${document("c", about("p3", "x"))},
                          ${document("d", """[{"kind":"lead","subject_id":"p1"}]""")}],"total":4}
        """)).documents
        val groups = DocsRules.groups(written, listOf(subject("p1", "beta"), subject("p2", "Zed"), subject("p3", "Alpha")), CrmSubjectKind.PROJECT)
        assertEquals(listOf("p2" to 2, "p3" to 1, "p1" to 1), groups.map { it.subject.id to it.count })
        assertEquals("project", groups.first().docsKind)
    }

    private fun annotation(id: String, thread: String, parent: String?, at: String, status: String = "open") = """
        {"id":"$id","document_id":"d1","document_version":1,"thread_id":"$thread","parent_id":${parent?.let { "\"$it\"" } ?: "null"},
         "author":"rosa@org.example","author_kind":"staff","body_md":"hi","status":"$status",
         "created_at":"$at","updated_at":"$at"}
    """

    @Test
    fun threadsAreNewestRootFirstWithRepliesInOrder() {
        val annotations = DocsJson.annotations(Json.parseToJsonElement("""[
            ${annotation("r2", "t1", "a1", "2026-10-03T00:00:00Z")},
            ${annotation("a1", "t1", null, "2026-10-01T00:00:00Z")},
            ${annotation("r1", "t1", "a1", "2026-10-02T00:00:00Z")},
            ${annotation("b1", "t2", null, "2026-10-05T00:00:00Z", status = "resolved")}
        ]"""))
        val threads = DocsRules.threads(annotations)
        assertEquals(listOf("t2", "t1"), threads.map { it.id })
        assertEquals(listOf("r1", "r2"), threads[1].replies.map { it.id })
        assertFalse(threads[0].isOpen)
        assertEquals("rosa", annotations.first().who)
    }

    @Test
    fun updatedLabelIsTwentyFourHourToday() {
        val zone = ZoneOffset.UTC
        val now = Instant.parse("2026-10-28T20:00:00Z")
        assertEquals("14:02", DocsRules.updatedLabel("2026-10-28T14:02:00.000Z", now, zone, Locale.US))
        assertEquals("12 Sep", DocsRules.updatedLabel("2026-09-12T08:00:00Z", now, zone, Locale.US))
        assertEquals("12 Sep 2025", DocsRules.updatedLabel("2025-09-12 08:00:00", now, zone, Locale.US))
        assertNull(DocsRules.updatedLabel("not a date", now, zone, Locale.US))
    }

    @Test
    fun rowFactsFollowDocumentRow() {
        val row = DocsJson.documentList(Json.parseToJsonElement("""{"documents":[${document("a")}],"total":1}""")).documents.single()
        val facts = DocsRules.rowFacts(row, ZoneId.of("UTC"))
        assertEquals(LocalDate.of(2026, 10, 1), facts.written)
        assertEquals(Instant.parse("2026-10-03T10:00:00Z"), facts.edited)
        assertEquals(2, facts.version)
        assertEquals("rosa", facts.who)
        val sameDay = row.copy(updatedAt = "2026-10-01T18:00:00Z", version = 1, updatedBy = "core@org.example")
        val quiet = DocsRules.rowFacts(sameDay, ZoneId.of("UTC"))
        assertNull(quiet.edited)
        assertNull(quiet.version)
        assertNull(quiet.who)
    }

    @Test
    fun publicLinkIsTheProductionReader() {
        assertEquals("https://docs.workers.org.example/doc/work/plan", DocsRules.publicLink("/work/plan"))
    }
}
