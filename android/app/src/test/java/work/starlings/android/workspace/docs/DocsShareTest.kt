package work.starlings.android.workspace.docs

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.DocsShareRoutes

/** DocsUI's `ShareSheet` and `SignatureSheet` rules, and DocsKit's snake-case bodies for them. */
class DocsShareTest {
    @Test
    fun publicCountsAsSharedAndOffIsInternal() {
        assertTrue(DocsShare.isShared("link"))
        assertTrue(DocsShare.isShared("public"))
        assertFalse(DocsShare.isShared("internal"))
        assertEquals("link", DocsShare.visibility(true))
        assertEquals("internal", DocsShare.visibility(false))
        assertEquals("https://www.org.example/private/docs/d1", DocsShare.www("d1"))
    }

    @Test
    fun anAddressBindsTheLinkAndAsksForTheCode() {
        assertEquals("""{"role":"viewer"}""", DocsShareRoutes.createGrant("d1", DocsShare.grant("viewer", "  ")).body)
        assertEquals(
            """{"role":"commenter","email":"ana@example.com","require_verification":true}""",
            DocsShareRoutes.createGrant("d1", DocsShare.grant("commenter", " ana@example.com ")).body,
        )
        assertEquals("""{"visibility":"link"}""", DocsShareRoutes.setVisibility("d1", "link").body)
    }

    @Test
    fun signersSplitOnLinesCommasSemicolonsAndSpaces() {
        val parties = DocsShare.signers("a@x.co\nb@x.co, c@x.co;d@x.co e@x.co not-an-address")
        assertEquals(listOf("a@x.co", "b@x.co", "c@x.co", "d@x.co", "e@x.co"), parties.map { it.email })
        assertTrue(DocsShare.signers("nobody").isEmpty())
    }

    @Test
    fun anEmptySubjectOrNoteIsLeftOff() {
        assertEquals(
            """{"parties":[{"email":"a@x.co"}]}""",
            DocsShareRoutes.createSignatureRequest("d1", DocsShare.signatureRequest("a@x.co", "", "")).body,
        )
        assertEquals(
            """{"subject":"NDA","message":"Hi","parties":[{"email":"a@x.co"}]}""",
            DocsShareRoutes.createSignatureRequest("d1", DocsShare.signatureRequest("a@x.co", "NDA", "Hi")).body,
        )
    }

    @Test
    fun grantsDecodeAndRevokedOnesLeaveTheList() {
        val body = """
            {"grants":[
              {"id":"g1","document_id":"d1","url":"https://docs/g1","email":null,"role":"viewer","require_verification":false,
               "created_by":"a@x.co","created_at":"2026-10-01T00:00:00Z","use_count":3},
              {"id":"g2","document_id":"d1","url":"https://docs/g2","email":"b@x.co","role":"commenter","require_verification":true,
               "created_by":"a@x.co","created_at":"2026-10-02T00:00:00Z","revoked_at":"2026-10-03T00:00:00Z","use_count":0,"extra":1}
            ]}
        """.trimIndent()
        val grants = DocsShare.grants(Json.parseToJsonElement(body))
        assertEquals(listOf("g1"), DocsShare.live(grants).map { it.id })
        assertEquals(3, grants[0].useCount)
        assertEquals("Commenter", DocsShare.roleWord(grants[1].role))
    }

    @Test
    fun aSignatureRequestNamesItsExpiryDay() {
        val body = """
            {"id":"s1","document_id":"d1","document_title":"NDA","document_version":4,"requested_by":"a@x.co",
             "status":"pending","created_at":"2026-10-01T00:00:00Z","expires_at":"2026-10-31T12:00:00Z",
             "parties":[{"id":"p1","email":"b@x.co","role":"signer","sequence":1,"status":"pending"}]}
        """.trimIndent()
        val request = DocsShare.signatureOf(Json.parseToJsonElement(body))
        assertEquals("2026-10-31", DocsShare.expiryDay(request))
        assertEquals("Pending", DocsShare.statusWord(request.parties.single().status))
        assertNull(DocsShare.expiryDay(request.copy(expiresAt = null)))
    }
}
