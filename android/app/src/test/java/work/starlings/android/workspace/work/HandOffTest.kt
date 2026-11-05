package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind

/** [HandOffTarget] and [HandOffText] as `Sources/WorkItems.swift` makes them, and the registry's Hand off gate. */
class HandOffTest {
    @Test
    fun aTaskIsHandedOffInItsSubjectsChannel() {
        val target = HandOffTarget.task("t1", "Fix the login", SubjectRef(CrmSubjectKind.PROJECT, "p1", "Acme"))
        assertTrue(target.inChannel)
        assertEquals("task" to "t1", target.refKind to target.refId)
        assertFalse(HandOffTarget.task("t1", "Fix the login", null).inChannel)
    }

    @Test
    fun anIssueIsSaidInItsProjectsChannel() {
        val target = HandOffTarget.issue("i1", 142, "Fix the login", "p1")
        assertEquals(CrmSubjectKind.PROJECT, target.subjectKind)
        assertTrue(target.inChannel)
        assertFalse(HandOffTarget.issue("i1", 142, "Fix the login", null).inChannel)
    }

    @Test
    fun theTextAddressesTheAgentByItsHandle() {
        assertEquals("@claude Take #142: Fix", HandOffText.addressed("Take #142: Fix", "claude@org.example"))
    }

    @Test
    fun handOffNeedsAnAgent() {
        val without = WorkRowActions.groups(WorkRowActions.Kind.TASK, "subject_open", mapOf("canDelete" to true))
        assertFalse(without.flatten().contains("hand-off"))
        val with = WorkRowActions.groups(WorkRowActions.Kind.TASK, "subject_open", mapOf("canHandOff" to true, "canDelete" to true))
        assertEquals(listOf(listOf("complete", "cancel"), listOf("hand-off"), listOf("delete")), with)
        // An issue hands off only while it is open.
        val closed = WorkRowActions.groups(WorkRowActions.Kind.ISSUE, "unowned", mapOf("canHandOff" to true, "isOpen" to false))
        assertFalse(closed.flatten().contains("hand-off"))
    }
}
