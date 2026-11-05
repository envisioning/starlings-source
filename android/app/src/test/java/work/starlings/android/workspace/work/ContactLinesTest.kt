package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CrmContactDetail
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.WireJson

/** [ContactLines], as `CrmContact.displayName` and `.context` read. */
class ContactLinesTest {
    @Test
    fun nameContextAndOrganization() {
        assertEquals("Rosa", ContactLines.name(" Rosa ", "rosa@example.com"))
        assertEquals("rosa@example.com", ContactLines.name("  ", "rosa@example.com"))
        assertNull(ContactLines.name(null, null))
        assertEquals("CEO · Echos", ContactLines.context(" CEO ", "Echos"))
        assertEquals("Echos", ContactLines.context("", "Echos"))
        assertEquals("50+", ContactLines.count(50, true))
        assertEquals("3", ContactLines.count(3, false))
        val detail = WireJson.decodeFromString(
            CrmContactDetail.serializer(),
            """{"id":"c1","name":"Rosa","organization_id":"o1","organization_name":"Echos","emails":[],"projects":[],"leads":[],"interactions":[],"met_by":[]}""",
        )
        assertEquals(SubjectRef(CrmSubjectKind.ORGANIZATION, "o1", "Echos"), ContactLines.organization(detail))
    }
}
