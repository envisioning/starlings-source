package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.contracts.CrmIssueMilestone
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueUser
import work.starlings.contracts.CrmIssueWire

/** [IssueFilter] and [IssueLabels], as `CrmIssueFilter` and `MobileIssueChrome.swift` decide them. */
class IssueFilterTest {
    private fun issue(number: Long, title: String, labels: List<String> = emptyList(), assignee: String? = null, milestone: CrmIssueMilestone? = null) = CrmIssueWire(
        id = "o/r#$number", number = number, owner = "o", repo = "r", title = title, state = CrmIssueState.OPEN,
        url = "https://example.test/$number", labels = labels, assignees = assignee?.let { listOf(CrmIssueUser(it)) },
        milestoneDetail = milestone, comments = 0,
    )

    @Test
    fun theDefaultAsksForOpenRecentlyUpdated() {
        val query = IssueFilter().query("p1").queryItems()
        assertEquals(listOf("project_id" to "p1", "state" to "open", "sort" to "updated", "direction" to "desc"), query)
        assertFalse(IssueFilter().isNarrowed)
    }

    @Test
    fun narrowingIsAskedOfTheServer() {
        val filter = IssueFilter(state = IssueFilter.State.ALL, labels = listOf("bug", "ui"), assignee = "none", milestone = "3", sort = IssueFilter.Sort.COMMENTS, ascending = true)
        assertEquals(
            listOf("project_id" to "p1", "state" to "all", "labels" to "bug,ui", "assignee" to "none", "milestone" to "3", "sort" to "comments", "direction" to "asc", "page" to "2"),
            filter.query("p1", page = 2).queryItems(),
        )
        assertTrue(filter.isNarrowed)
    }

    @Test
    fun searchNeverLeaves() {
        val typed = IssueFilter(search = "276")
        assertFalse(typed.asksServerDifferently(IssueFilter()))
        assertTrue(typed.isNarrowed)
        assertTrue(typed.matches(issue(276, "Anything")))
        assertTrue(IssueFilter(search = "#27").matches(issue(276, "Anything")))
        assertTrue(IssueFilter(search = "crash").matches(issue(1, "App CRASHES on launch")))
        assertTrue(IssueFilter(search = "ui").matches(issue(1, "Nothing", labels = listOf("UI"))))
        assertFalse(IssueFilter(search = "zzz").matches(issue(1, "Nothing")))
    }

    @Test
    fun theMenuOffersWhatCameBack() {
        val issues = listOf(
            issue(1, "a", labels = listOf("ui", "bug"), assignee = "rosa", milestone = CrmIssueMilestone("Beta", 4)),
            issue(2, "b", labels = listOf("bug"), assignee = "ada", milestone = CrmIssueMilestone("Alpha", 2)),
            issue(3, "c", milestone = CrmIssueMilestone("Unnumbered")),
        )
        val choices = IssueFilter(labels = listOf("docs")).choices(issues)
        assertEquals(listOf("bug", "docs", "ui"), choices.labels)
        assertEquals(listOf("ada", "rosa"), choices.logins)
        assertEquals(listOf("Alpha" to "2", "Beta" to "4"), choices.milestones)
    }

    @Test
    fun aRepeatedRowAcrossPagesIsKeptOnce() {
        val merged = IssueFilter.appending(listOf(issue(1, "a"), issue(2, "b")), listOf(issue(2, "b"), issue(3, "c")))
        assertEquals(listOf(1L, 2L, 3L), merged.map { it.number })
        assertEquals(listOf("a", "b"), IssueFilter.toggled("b", listOf("a")))
        assertEquals(listOf("a"), IssueFilter.toggled("b", listOf("b", "a")))
    }

    @Test
    fun theRouteKeepsOneSnapshotPerQuestion() {
        val route = WorkExtraRoutes.issues(IssueFilter(labels = listOf("a b")).query("p1"))
        assertEquals("crm/issues?project_id=p1&state=open&labels=a+b&sort=updated&direction=desc", route.snapshotKey)
    }

    @Test
    fun labelColoursAndInitials() {
        assertEquals(0xFFD73A4AL, IssueLabels.colour("#D73A4A"))
        assertEquals(0xFFD73A4AL, IssueLabels.colour(" d73a4a "))
        assertNull(IssueLabels.colour("red"))
        assertNull(IssueLabels.colour(null))
        assertEquals("EC", IssueLabels.initials("envisioning-core[bot]"))
        assertEquals("M", IssueLabels.initials("mz"))
        assertEquals("?", IssueLabels.initials("--"))
        assertEquals(listOf("x"), IssueLabels.drawable(issue(1, "t", labels = listOf("x"))).map { it.name })
    }
}
