package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.WireJson

/** [WorkPage.encode] and [WorkPage.decode]: the stack comes back as it was after a rotation. */
class WorkPagesTest {
    @Test
    fun everyPageRoundTrips() {
        val task = WireJson.decodeFromString(
            CrmTaskWire.serializer(),
            """{"id":"t1","title":"Send deck","status":"pending","responsible_party":"team","project_id":"p1"}""",
        )
        val issue = WireJson.decodeFromString(
            CrmIssueWire.serializer(),
            """{"id":"o/r#7","number":7,"owner":"o","repo":"r","title":"Bug","state":"open","url":"u","labels":["bug"],"comments":2}""",
        )
        val acme = SubjectRef(CrmSubjectKind.PROJECT, "p1", "Acme")
        val pages = listOf(
            WorkPage.MineTask("t1"),
            WorkPage.Task(task, acme),
            WorkPage.Subject(acme),
            WorkPage.Subject(SubjectRef(CrmSubjectKind.ORGANIZATION, "o1", "")),
            WorkPage.Browse,
            WorkPage.Contact("c1"),
            WorkPage.Issue(issue, "p1"),
            WorkPage.Issue(issue, null),
            WorkPage.IssueRef("o", "r", 7),
        )
        pages.forEach { assertEquals(it, WorkPage.decode(WorkPage.encode(it))) }
    }

    @Test
    fun aLineThisBuildCannotReadIsDropped() {
        assertNull(WorkPage.decode("""{"page":"signals"}"""))
        assertNull(WorkPage.decode("not json"))
        assertNull(WorkPage.decode("""{"page":"mine"}"""))
    }
}
