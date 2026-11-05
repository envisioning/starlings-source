package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CrmSubjectKind

/** [WorkRoute] reads the paths `web/src/work-hrefs.ts` and `inbox-rows.tsx` write. */
class WorkRouteTest {
    @Test
    fun overviewAndItsInboxDoors() {
        assertEquals(WorkRoute.Overview(WorkRoute.Focus.INBOX), WorkRoute.parse("/work"))
        assertEquals(WorkRoute.Overview(WorkRoute.Focus.INBOX), WorkRoute.parse("/work/"))
        assertEquals(WorkRoute.Overview(WorkRoute.Focus.MINE), WorkRoute.parse("/work/mine"))
        assertEquals(WorkRoute.Overview(WorkRoute.Focus.INBOX, decisionId = "d 1"), WorkRoute.parse("/work?decision=d%201"))
        assertEquals(WorkRoute.Overview(WorkRoute.Focus.INBOX, questionId = "q1"), WorkRoute.parse("/work?question=q1"))
        assertEquals(WorkRoute.Overview(WorkRoute.Focus.INBOX, followUpId = "m1"), WorkRoute.parse("/work?followup=m1"))
    }

    @Test
    fun records() {
        assertEquals(WorkRoute.Task("t/1"), WorkRoute.parse("/work/task/t%2F1"))
        assertEquals(WorkRoute.Contact("c1"), WorkRoute.parse("/work/contact/c1"))
        assertEquals(WorkRoute.Subject(CrmSubjectKind.PROJECT, "p1", "tasks", "t1"), WorkRoute.parse("/work/project/p1?pane=tasks&task=t1&edit=task"))
        assertEquals(WorkRoute.Subject(CrmSubjectKind.ORGANIZATION, "o1"), WorkRoute.parse("/work/partner/o1"))
        // Search's subject verbs (`?new=`); a stranger is dropped.
        assertEquals(WorkRoute.Subject(CrmSubjectKind.PROJECT, "p1", "tasks", create = "task"), WorkRoute.parse("/work/project/p1?pane=tasks&new=task"))
        assertEquals(WorkRoute.Subject(CrmSubjectKind.LEAD, "l1", "documents", create = "document"), WorkRoute.parse("/work/lead/l1?pane=documents&new=document"))
        assertEquals(WorkRoute.Subject(CrmSubjectKind.PROJECT, "p1"), WorkRoute.parse("/work/project/p1?new=widget"))
        assertEquals(WorkRoute.Issue("envisioning", "starlings", 42), WorkRoute.parse("/work/issue/envisioning/starlings/42"))
        assertEquals("envisioning/starlings#42", (WorkRoute.parse("/work/issue/envisioning/starlings/42") as WorkRoute.Issue).reference)
    }

    @Test
    fun viewsAndStrangers() {
        assertEquals(WorkRoute.Browse, WorkRoute.parse("/work/browse"))
        assertEquals(WorkRoute.Browse, WorkRoute.parse("/work/projects"))
        assertEquals(WorkRoute.Browse, WorkRoute.parse("/work/widget/x"))
        assertNull(WorkRoute.parse("/calendar"))
        assertNull(WorkRoute.parse("/workspace"))
        // A bad escape is not an id.
        assertEquals(WorkRoute.Browse, WorkRoute.parse("/work/task/%zz"))
    }

    @Test
    fun pathsRoundTrip() {
        val routes = listOf(
            WorkRoute.Overview(WorkRoute.Focus.INBOX),
            WorkRoute.Overview(WorkRoute.Focus.MINE),
            WorkRoute.Browse,
            WorkRoute.Task("a b/c"),
            WorkRoute.Contact("c1"),
            WorkRoute.Issue("o", "r", 7),
            WorkRoute.Subject(CrmSubjectKind.LEAD, "l1", "tasks", "t 2"),
            WorkRoute.Subject(CrmSubjectKind.EVENT, "e1"),
        )
        routes.forEach { assertEquals(it, WorkRoute.parse(WorkRoute.path(it))) }
        assertEquals("/work/task/a%20b%2Fc", WorkRoute.path(WorkRoute.Task("a b/c")))
    }
}
