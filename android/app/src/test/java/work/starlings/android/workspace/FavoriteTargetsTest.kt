package work.starlings.android.workspace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.FavoriteRow
import work.starlings.contracts.FavoriteTarget
import work.starlings.contracts.FavoriteTargetKind

/** `FavoriteTargets` (Sources/CalendarWire.swift): the Worker's spelling of a star. */
class FavoriteTargetsTest {
    private fun row(kind: String, ref: String) = FavoriteRow(kind, ref, "2026-10-28T00:00:00Z")

    @Test
    fun aUuidKindMatchesWhateverTheCase() {
        assertTrue(FavoriteTargets.matches(row("meet.thread", "ABC-1"), FavoriteTargets.thread("abc-1")))
        assertTrue(FavoriteTargets.matches(row("docs.document", "D-1"), FavoriteTargets.document("d-1")))
        assertTrue(FavoriteTargets.matches(row("docs.folder", "f-1"), FavoriteTargets.folder("F-1")))
        assertTrue(FavoriteTargets.matches(row("crm.task", "T-1"), FavoriteTargets.task("t-1")))
    }

    @Test
    fun aPersonRefIsExact() {
        val row = row("meet.person", "Ref")
        assertTrue(FavoriteTargets.matches(row, FavoriteTarget(FavoriteTargetKind.MEET_PERSON, "Ref")))
        assertFalse(FavoriteTargets.matches(row, FavoriteTarget(FavoriteTargetKind.MEET_PERSON, "ref")))
        assertFalse(FavoriteTargets.matches(row, FavoriteTarget(FavoriteTargetKind.MEET_AGENT, "Ref")))
    }

    @Test
    fun aDocumentIsNotItsFolder() {
        assertFalse(FavoriteTargets.contains(listOf(row("docs.folder", "x")), FavoriteTargets.document("x")))
        assertTrue(FavoriteTargets.contains(listOf(row("docs.folder", "y"), row("docs.document", "x")), FavoriteTargets.document("x")))
    }

    @Test
    fun crmSubjectsByRouteKind() {
        assertEquals(FavoriteTarget(FavoriteTargetKind.CRM_PARTNER, "o1"), FavoriteTargets.crmSubject("organization", "o1"))
        assertEquals(FavoriteTarget(FavoriteTargetKind.CMS_EVENT, "e1"), FavoriteTargets.crmSubject("event", "e1"))
        assertNull(FavoriteTargets.crmSubject("person", "p1"))
    }

    @Test
    fun anIssueIsLowercasedOwnerRepoNumber() {
        assertEquals("envisioning/starlings#12", FavoriteTargets.issue("Envisioning", "Starlings", 12).targetRef)
    }
}
