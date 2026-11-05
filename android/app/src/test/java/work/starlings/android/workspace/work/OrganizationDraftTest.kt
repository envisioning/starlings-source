package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.SubjectRoutes
import work.starlings.contracts.CrmSubjectDetailWire
import work.starlings.contracts.CrmSubjectKind

/** [OrganizationDraft], as `Sources/OrganizationDraft.swift`: what Edit organization sends. */
class OrganizationDraftTest {
    private val detail = CrmSubjectDetailWire(
        id = "o1", kind = CrmSubjectKind.ORGANIZATION, title = "Acme", status = "",
        url = "https://acme.test", industry = "Retail", city = "Porto", isPartner = true,
    )

    private fun body(draft: OrganizationDraft, before: OrganizationDraft): String? =
        draft.patch(before)?.let { SubjectRoutes.updateOrganization("o1", it).body }

    @Test
    fun nothingChangedSendsNothing() {
        val draft = OrganizationDraft.of(detail)
        assertNull(draft.patch(draft))
        assertNull("spaces are not a change", draft.with(OrganizationDraft.Field.CITY, " Porto ").patch(draft))
    }

    @Test
    fun onlyWhatChangedGoesOut() {
        val before = OrganizationDraft.of(detail)
        val after = before.copy(name = " Acme Ltd ")
            .with(OrganizationDraft.Field.CITY, "")
            .with(OrganizationDraft.Field.DOMAIN, "acme.test")
            .with(OrganizationDraft.Flag.AGENCY, true)
        assertEquals("""{"name":"Acme Ltd","city":null,"domain":"acme.test","is_agency":true}""", body(after, before))
    }

    @Test
    fun aBareHostGetsHttps() {
        val before = OrganizationDraft.of(detail)
        assertEquals("""{"url":"https://acme.org"}""", body(before.with(OrganizationDraft.Field.URL, "acme.org"), before))
        assertEquals("""{"linkedin_url":"http://x.test/a"}""", body(before.with(OrganizationDraft.Field.LINKEDIN_URL, "http://x.test/a"), before))
        assertEquals("", OrganizationDraft.normalizedUrl("  "))
        assertEquals("mailto:a@b.test", OrganizationDraft.normalizedUrl("mailto:a@b.test"))
    }

    @Test
    fun aNameIsNeverBlankedAndHasACap() {
        val before = OrganizationDraft.of(detail)
        val blank = before.copy(name = "  ")
        assertFalse(blank.canSave)
        assertNull("a blank name is not sent", blank.patch(before))
        assertFalse(before.copy(name = "x".repeat(OrganizationDraft.NAME_LIMIT + 1)).canSave)
        assertTrue(before.copy(name = "x".repeat(OrganizationDraft.NAME_LIMIT)).canSave)
        assertEquals("""{"is_partner":false}""", body(before.with(OrganizationDraft.Flag.PARTNER, false), before))
    }

    @Test
    fun theOrganizationRoutesAreTheWorkers() {
        assertEquals("PATCH", SubjectRoutes.updateOrganization("o1", work.starlings.contracts.CrmOrganizationUpdate(name = "A")).method)
        assertEquals(listOf("crm", "subjects", "organization", "o1"), SubjectRoutes.deleteOrganization("o1").path)
        assertEquals("DELETE", SubjectRoutes.deleteOrganization("o1").method)
        val merge = SubjectRoutes.mergeOrganizations(listOf("o1", "o2"))
        assertEquals(listOf("core", "merge", "organizations"), merge.path)
        assertEquals("""{"ids":["o1","o2"]}""", merge.body)
    }
}
