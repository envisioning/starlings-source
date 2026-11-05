package work.starlings.android.workspace.docs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.android.api.DocsImageRoutes
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/** The editor's link-save pictures (DocsKit `DocsImagePrep`, `DocsLinkSave`) and subject chips (DocsUI `SubjectEditor`). */
class DocsEditorPartsTest {
    @Test
    fun aSmallPngOrJpegGoesAsItIs() {
        assertEquals(DocsImagePrep.Plan.Keep("image/png"), DocsImagePrep.plan("image/png", 1440, 900, 400_000))
        assertEquals(DocsImagePrep.Plan.Keep("image/jpeg"), DocsImagePrep.plan("image/jpeg", 2560, 1920, DocsImagePrep.MAX_BYTES))
    }

    @Test
    fun anythingElseIsAJpegNoLongerThanTheEdge() {
        // A phone's HEIC at its own size: not a type Docs keeps as is, never upscaled.
        assertEquals(DocsImagePrep.Plan.Jpeg(2000, 1500), DocsImagePrep.plan("image/heif", 2000, 1500, 900_000))
        // A large PNG and a heavy small JPEG are both re-encoded.
        assertEquals(DocsImagePrep.Plan.Jpeg(2560, 1600), DocsImagePrep.plan("image/png", 5120, 3200, 4_000_000))
        assertEquals(DocsImagePrep.Plan.Jpeg(1000, 1000), DocsImagePrep.plan("image/jpeg", 1000, 1000, DocsImagePrep.MAX_BYTES + 1))
        assertEquals(DocsImagePrep.Plan.Jpeg(1920, 2560), DocsImagePrep.plan("image/webp", 3024, 4032, 2_000_000))
    }

    @Test
    fun whatThePlatformCannotMeasureIsNoImage() {
        assertNull(DocsImagePrep.plan(null, 100, 100, 10))
        assertNull(DocsImagePrep.plan("image/png", 0, 0, 10))
        assertEquals(DocsImagePrep.Failure.UNREADABLE, DocsImagePrep.Failure(DocsImagePrep.Failure.UNREADABLE).message)
    }

    @Test
    fun fitKeepsTheAspectAndNeverUpscales() {
        assertEquals(800 to 600, DocsImagePrep.fit(800, 600))
        assertEquals(2560 to 1, DocsImagePrep.fit(10_000, 3))
        assertEquals(1440 to 2560, DocsImagePrep.fit(2160, 3840))
    }

    @Test
    fun aLinkSaveDecodesItsPicturesAndWhyItFailed() {
        val link = DocsJson.json.decodeFromString(
            DocsLinkSave.serializer(),
            """{"url":"https://a.co/x","canonical_url":"https://www.a.co/x","has_image":false,"image_count":2,"first_image_id":"i1",
               "fetch_status":"failed","fetch_error":"Timed out","fetched_at":"2026-10-29T10:00:00Z"}""",
        )
        assertEquals(2, link.imageCount)
        assertEquals("i1", link.firstImageId)
        assertEquals(DocsRules.LINK_FETCH_FAILED, link.fetchStatus)
        assertEquals("Timed out", link.fetchError)
        assertEquals("a.co", link.site)
        // A Docs older than slice 2 leaves the picture fields out.
        val old = DocsJson.json.decodeFromString(DocsLinkSave.serializer(), """{"url":"u","canonical_url":"u","has_image":true,"fetch_status":"ok"}""")
        assertNull(old.imageCount)
        assertNull(old.firstImageId)
        val image = DocsJson.json.decodeFromString(
            DocsImage.serializer(),
            """{"id":"i1","content_type":"image/png","byte_size":12,"created_by":"rosa@org.example","created_at":"2026-10-29T10:00:00Z"}""",
        )
        assertEquals(DocsImage("i1", "image/png", 12, null, "rosa@org.example", "2026-10-29T10:00:00Z"), image)
    }

    @Test
    fun imageRoutesAreDocsOwnPaths() {
        assertEquals("GET /api/docs-service/api/docs/d1/link-image", DocsImageRoutes.linkImage("d1").signature)
        assertEquals("GET /api/docs-service/api/docs/d1/images/i1", DocsImageRoutes.image("d1", "i1").signature)
        assertEquals("POST /api/docs-service/api/docs/d1/images", DocsImageRoutes.upload("d1").signature)
        assertEquals(emptyList<Pair<String, String>>(), DocsImageRoutes.upload("d1", "").query)
        assertEquals(listOf("caption" to "Front page"), DocsImageRoutes.upload("d1", "Front page").query)
        assertEquals("DELETE /api/docs-service/api/docs/d1/images/i1", DocsImageRoutes.delete("d1", "i1").signature)
    }

    private fun row(id: String, kind: CrmSubjectKind, title: String) = CrmSubjectWire(id = id, kind = kind, title = title)

    @Test
    fun searchNeedsTwoCharacters() {
        assertNull(DocsSubjects.query(""))
        assertNull(DocsSubjects.query(" a "))
        assertEquals("ac", DocsSubjects.query(" ac "))
    }

    @Test
    fun hitsPutNamesThatStartWithTheQueryFirstOncePerSubject() {
        val rows = listOf(
            row("p1", CrmSubjectKind.PROJECT, "Zeta for Acme"),
            row("o1", CrmSubjectKind.ORGANIZATION, "acme"),
            row("l1", CrmSubjectKind.LEAD, "Acme renewal"),
            row("o1", CrmSubjectKind.ORGANIZATION, "acme"),
            row("p2", CrmSubjectKind.PROJECT, "Acme"),
        )
        val hits = DocsSubjects.rank(rows, "Acme")
        assertEquals(listOf("o1", "p2", "l1", "p1"), hits.map { it.subject.subjectId })
        assertEquals(DocsSubject(kind = "organization", subjectId = "o1"), hits.first().subject)
        assertEquals("core:organization:o1", hits.first().subject.ref)
        val many = (1..20).map { row("p$it", CrmSubjectKind.PROJECT, "Acme $it") }
        assertEquals(DocsSubjects.LIMIT, DocsSubjects.rank(many, "acme").size)
    }

    @Test
    fun chipsAddOnceRemoveByRefAndFallBackToTheKind() {
        val acme = DocsSubject(kind = "organization", subjectId = "o1")
        val plan = DocsSubject(kind = "project", subjectId = "p1")
        assertEquals(listOf(acme, plan), DocsSubjects.adding(listOf(acme), plan))
        assertEquals(listOf(acme), DocsSubjects.adding(listOf(acme), acme))
        assertEquals(listOf(plan), DocsSubjects.removing(listOf(acme, plan), acme))
        assertEquals("Acme", DocsSubjects.label(acme, mapOf(acme.ref to "Acme")))
        assertEquals("Project", DocsSubjects.label(plan, emptyMap()))
        assertEquals(CrmSubjectKind.ORGANIZATION, DocsSubjects.crmKind(acme))
        assertNull(DocsSubjects.crmKind(DocsSubject(kind = "contact", subjectId = "c1")))
    }
}
