package work.starlings.android.workspace.docs

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** The filing, create and save rules (DocsFiling.kt, DocsEditing.kt, DocsDrafts.kt) against DocsKit and the shared fixtures. */
class DocsFilingTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private fun document(path: String = "/work/acme/brief", category: String? = null, subjects: List<DocsSubject> = emptyList(), editable: Boolean = true) =
        DocsDocumentSummary(
            id = "d1", path = path, slug = path.substringAfterLast('/'), title = "Brief", kind = "markdown", visibility = "internal",
            status = "active", sourceSystem = "native", editable = editable, version = 1, byteSize = 0, contentHash = "h",
            tags = emptyList(), category = category, subjects = subjects, createdAt = "2026-10-01T09:00:00Z", updatedAt = "2026-10-01T09:00:00Z",
        )

    @Test
    fun slugIsTheFixture() {
        val slug = fixture("docs-slug.json")
        for (case in slug["cases"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(case["name"]!!.jsonPrimitive.content, case["slug"]!!.jsonPrimitive.content, DocsFiling.slug(case["title"]!!.jsonPrimitive.content))
        }
        for (case in slug["folders"]!!.jsonArray.map { it.jsonObject }) {
            assertEquals(
                case["name"]!!.jsonPrimitive.content, case["path"]!!.jsonPrimitive.content,
                DocsFiling.folderPath(case["kind"]!!.jsonPrimitive.content, case["title"]!!.jsonPrimitive.content),
            )
        }
    }

    @Test
    fun folderOfDropsTheLastSegment() {
        assertEquals("/work/acme", DocsFiling.folderOf("/work/acme/brief"))
        assertEquals("/", DocsFiling.folderOf("/brief"))
    }

    @Test
    fun aFilingWritesOnlyWhatChanges() {
        val acme = DocsSubject(kind = "project", subjectId = "p1")
        assertNull(DocsFiling.write(document(), DocsFilingAct.Folder("/work/acme")))
        assertEquals(DocsFilingWrite.Move("/work/other"), DocsFiling.write(document(), DocsFilingAct.Folder("/work/other")))
        assertNull(DocsFiling.write(document(category = "brief"), DocsFilingAct.Category("brief")))
        assertEquals(DocsFilingWrite.SetCategory(null), DocsFiling.write(document(category = "brief"), DocsFilingAct.Category(null)))
        assertEquals(DocsFilingWrite.SetSubjects(listOf(acme)), DocsFiling.write(document(), DocsFilingAct.AddSubject(acme)))
        assertNull(DocsFiling.write(document(subjects = listOf(acme)), DocsFilingAct.AddSubject(acme)))
        assertEquals(DocsFilingWrite.SetSubjects(emptyList()), DocsFiling.write(document(subjects = listOf(acme)), DocsFilingAct.RemoveSubject(acme)))
        // A mirrored document is never filed.
        assertNull(DocsFiling.write(document(editable = false), DocsFilingAct.Folder("/work/other")))
    }

    @Test
    fun theToastNamesThePlaceTheMenuShowed() {
        val acme = DocsSubject(kind = "project", subjectId = "p1")
        val choices = DocsFilingChoices(
            folders = listOf(DocsFolder("f1", "/clients", "clients", "Clients", null, 0)),
            categories = listOf(DocsSummary.CategoryCount("brief", "Brief", 2)),
            projects = listOf(DocsFilingChoices.Subject(acme, "Acme")),
        )
        assertEquals(DocsFiledMessage.FiledIn("Clients", 1), DocsFiling.filedMessage(DocsFilingAct.Folder("/clients"), 1, choices))
        assertEquals(DocsFiledMessage.FiledIn("/elsewhere", 1), DocsFiling.filedMessage(DocsFilingAct.Folder("/elsewhere"), 1, choices))
        assertEquals(DocsFiledMessage.FiledIn("Brief", 1), DocsFiling.filedMessage(DocsFilingAct.Category("brief"), 1, choices))
        assertEquals(DocsFiledMessage.CategoryCleared(1), DocsFiling.filedMessage(DocsFilingAct.Category(null), 1, choices))
        assertEquals(DocsFiledMessage.TakenOff("Acme", 1), DocsFiling.filedMessage(DocsFilingAct.RemoveSubject(acme), 1, choices))
        assertEquals(DocsFiledMessage.FiledIn("Lead", 1), DocsFiling.filedMessage(DocsFilingAct.AddSubject(DocsSubject(kind = "lead", subjectId = "x")), 1, choices))
    }

    @Test
    fun theFolderTreeNestsUnderChoicesOnly() {
        val top = DocsFolder("a", "/clients", "clients", "Clients", null, 0)
        val child = DocsFolder("b", "/clients/acme", "acme", "Acme", "a", 1)
        // Its parent is a mirrored shelf, not a choice: it sits at the top.
        val orphan = DocsFolder("c", "/notes/x", "x", "X", "mirror", 1)
        val folders = listOf(child, orphan, top)
        assertEquals(listOf(top, orphan), DocsFiling.children(folders, null))
        assertEquals(listOf(child), DocsFiling.children(folders, "a"))
    }

    @Test
    fun aListCreatesWhereIOSCreates() {
        val subject = DocsSelection.Subject("project", "p1", "Acme Corp.")
        assertEquals("/work/project/acme-corp", DocsFiling.createFolder(subject))
        assertEquals(listOf(DocsSubject(kind = "project", subjectId = "p1")), DocsFiling.createSubjects(subject))
        assertEquals("/clients", DocsFiling.createFolder(DocsSelection.Folder("/clients", "Clients")))
        assertEquals("/work", DocsFiling.createFolder(DocsSelection.Recent))
        assertEquals("/work/project/acme-corp", DocsFiling.linkFolder(subject))
        assertNull(DocsFiling.linkFolder(DocsSelection.Folder("/clients", "Clients")))
        assertFalse(DocsFiling.canCreate(DocsSelection.Search("x")))
        assertFalse(DocsFiling.canCreate(DocsSelection.Links))
        assertFalse(DocsFiling.canCreate(DocsSelection.Category("brief", DocsRailHalf.LIBRARY)))
        assertTrue(DocsFiling.canCreate(DocsSelection.Category("brief", DocsRailHalf.WORK)))
        assertFalse(DocsFiling.canSaveLink(DocsSelection.Category("brief", DocsRailHalf.LIBRARY)))
        assertTrue(DocsFiling.canSaveLink(DocsSelection.Links))
    }

    @Test
    fun onlyOneHttpsLinkSaves() {
        assertEquals("https://example.com/a", DocsFiling.httpsLink("  https://example.com/a \n"))
        assertNull(DocsFiling.httpsLink("http://example.com"))
        assertNull(DocsFiling.httpsLink("see https://example.com"))
        assertNull(DocsFiling.httpsLink("https://"))
        assertNull(DocsFiling.httpsLink(""))
        assertNull(DocsFiling.httpsLink("https://example.com/" + "a".repeat(2048)))
    }

    @Test
    fun aSaveSendsOnlyWhatChangedWithTheHash() {
        val saved = DocsEditFields("Brief", "body", "brief")
        assertNull(DocsEditing.update(saved, saved.copy(title = "Brief  "), "h"))
        assertEquals(
            """{"title":"New","if_content_hash":"h"}""",
            DocsEditing.update(saved, saved.copy(title = " New "), "h")!!.encode(),
        )
        assertEquals(
            """{"body_md":"more","category":null,"if_content_hash":"h"}""",
            DocsEditing.update(saved, saved.copy(body = "more", category = null), "h")!!.encode(),
        )
        assertEquals("""{"category":"memo","if_content_hash":"h"}""", DocsEditing.update(saved, saved.copy(category = "memo"), "h")!!.encode())
        assertTrue(DocsEditing.isDirty(saved, saved.copy(title = "Brief ")))
        assertEquals(saved, DocsEditing.savedAfter(saved.copy(title = " Brief ")))
    }

    @Test
    fun aCrashDraftWinsOnlyWhenItDiffers() {
        assertTrue(DocsEditing.draftWins("mine", "theirs"))
        assertFalse(DocsEditing.draftWins("same", "same"))
        assertFalse(DocsEditing.draftWins(null, "theirs"))
        assertFalse(DocsEditing.draftWins("", null))
    }

    @Test
    fun writeBodiesAreDocsKits() {
        assertEquals("""{"status":"archived"}""", DocsUpdateDocument(status = "archived").encode())
        assertEquals(
            """{"title":"Plan","folder_path":"/work","body_md":"","subjects":[{"system":"core","kind":"project","subject_id":"p1"}],"tags":[],"message":"Created from Starlings"}""",
            DocsJson.json.encodeToString(
                DocsCreateDocument.serializer(),
                DocsCreateDocument("Plan", "/work", subjects = listOf(DocsSubject(kind = "project", subjectId = "p1")), message = "Created from Starlings"),
            ),
        )
    }

    @Test
    fun draftsRoundTripAndClear() {
        val dir = Files.createTempDirectory("drafts").toFile()
        val drafts = DocsDrafts(dir)
        assertNull(drafts.read("d1"))
        drafts.write("d1", "hello")
        assertEquals("hello", drafts.read("d1"))
        drafts.clear("d1")
        assertNull(drafts.read("d1"))
        assertEquals("new_core_project_p1", DocsDrafts.safe("new:core:project:p1"))
        dir.deleteRecursively()
    }

    @Test
    fun snapshotKeysAreDocsKits() {
        assertEquals("docs/written", DocsListRead.Written().snapshotKey)
        assertEquals("docs/documents?limit=200", DocsSelection.Recent.read!!.snapshotKey)
        assertEquals("docs/documents?subject=core:project:p1&limit=100", DocsSelection.Subject("project", "p1", "Acme").read!!.snapshotKey)
    }
}
