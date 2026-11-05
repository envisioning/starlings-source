package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire

/** `MobilePeerTaskSubjectPicker`'s rows: one id per subject, the kind word, and the order of the three lists. */
class PeerTaskSubjectsTest {
    private fun subject(kind: CrmSubjectKind, id: String) = CrmSubjectWire(id = id, kind = kind, title = "S $id")

    @Test
    fun idsAreUniqueAcrossKinds() {
        assertEquals("project:1", PeerTaskSubjects.optionId(subject(CrmSubjectKind.PROJECT, "1")))
        assertEquals("lead:1", PeerTaskSubjects.optionId(subject(CrmSubjectKind.LEAD, "1")))
    }

    @Test
    fun theKindWordIsProjectPartnerOrLead() {
        assertEquals(PeerTaskSubjects.Context.PROJECT, PeerTaskSubjects.context(subject(CrmSubjectKind.PROJECT, "1")))
        assertEquals(PeerTaskSubjects.Context.PARTNER, PeerTaskSubjects.context(subject(CrmSubjectKind.ORGANIZATION, "1")))
        assertEquals(PeerTaskSubjects.Context.LEAD, PeerTaskSubjects.context(subject(CrmSubjectKind.LEAD, "1")))
    }

    @Test
    fun projectsThenLeadsThenPartnersAndPartnersMayFail() {
        val p = subject(CrmSubjectKind.PROJECT, "p")
        val l = subject(CrmSubjectKind.LEAD, "l")
        val o = subject(CrmSubjectKind.ORGANIZATION, "o")
        assertEquals(listOf(p, l, o), PeerTaskSubjects.merge(listOf(p), listOf(l), listOf(o)))
        assertEquals(listOf(p, l), PeerTaskSubjects.merge(listOf(p), listOf(l), null))
    }
}
