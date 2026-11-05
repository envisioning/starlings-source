package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.MineOriginFilter
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.CrmSubjectCountsResponse
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmUnownedSubject
import work.starlings.contracts.InboxRecentEntry
import work.starlings.contracts.InboxRecentEntrySubject
import work.starlings.contracts.InboxRecentEntrySubjectGroup
import java.io.File
import java.time.ZoneOffset

/** Filter Unowned, Browse's status filter, sort and buckets, and Activity's search, as `MobileWorkView` draws them. */
class WorkListsTest {
    private val zone = ZoneOffset.UTC

    private fun task(id: String, project: String?, title: String) =
        CrmMyTaskWire(id = id, title = id, status = "pending", responsibleParty = "us", projectId = project, subjectTitle = title)

    private fun issue(id: String) = CrmIssueWire(
        id = id, number = 1, owner = "o", repo = "r", title = id, state = CrmIssueState.OPEN, url = "https://github.com/o/r/issues/1",
        labels = emptyList(), comments = 0,
    )

    @Test
    fun unownedHidesASubjectsRowsOnly() {
        val plan = MineWork.plan(listOf(task("a", "p1", "Acme"), task("b", "p2", "Beta"), task("c", null, "")), listOf(issue("i")), "", 0, zone)
        val subjects = mapOf("i" to CrmUnownedSubject(CrmSubjectKind.PROJECT, "p1", "Acme"))
        val shown = UnownedSubjects.shown(plan, setOf("project:p1"), subjects)
        assertEquals(setOf("b", "c"), shown.order.map { it.workId }.toSet())
        val choices = UnownedSubjects.choices(plan, MineOriginFilter.ALL, subjects)
        assertEquals(listOf(UnownedSubjects.Choice("project:p1", "Acme", 2), UnownedSubjects.Choice("project:p2", "Beta", 1)), choices)
        assertEquals(listOf(1, 1), UnownedSubjects.choices(plan, MineOriginFilter.TASK, subjects).map { it.count })
        assertEquals(MineOriginFilter.TASK, UnownedSubjects.defaultOrigin)
    }

    @Test
    fun statusFiltersFollowTheTable() {
        val kinds = Json.parseToJsonElement(
            File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), "subject-status.json").readText(),
        ).jsonObject["kinds"]!!.jsonObject
        listOf(CrmSubjectKind.PROJECT to "project", CrmSubjectKind.LEAD to "lead").forEach { (kind, key) ->
            val table = kinds[key]!!.jsonObject
            assertEquals(table["filter"]!!.jsonArray.map { it.jsonPrimitive.content }, SubjectStatusFilter.options(kind))
            assertEquals(table["defaultFilter"]!!.jsonPrimitive.content, SubjectStatusFilter.DEFAULT)
        }
        val counts = CrmSubjectCountsResponse(counts = mapOf("open" to 3), isInternal = mapOf("open" to 2, "all" to 5), client = null)
        assertEquals(2, SubjectStatusFilter.internal(counts)["open"])
        assertEquals(0, SubjectStatusFilter.client(counts)["open"])
        assertEquals(3, SubjectStatusFilter.leads(counts)["open"])
    }

    @Test
    fun sortAndBucketsFollowSwift() {
        fun subject(id: String, overdue: Long = 0, open: Long = 0, org: String? = null, orgName: String? = null) =
            CrmSubjectWire(id = id, kind = CrmSubjectKind.PROJECT, title = id, overdueTasks = overdue, openTasks = open, organizationId = org, organizationName = orgName)
        val rows = listOf(subject("b", open = 1), subject("a"), subject("c", overdue = 1))
        assertEquals(listOf("c", "b", "a"), SubjectSort.BUSIEST.sorted(rows).map { it.id })
        assertEquals(listOf("a", "b", "c"), SubjectSort.ALPHABETICAL.sorted(rows).map { it.id })
        assertEquals(SubjectSort.BUSIEST, SubjectSort.of("unknown"))

        val buckets = OrganizationBuckets.of(listOf(subject("x", org = "o1", orgName = "Acme"), subject("y"), subject("z", org = "o1", orgName = "Acme"), subject("w", org = "o2", orgName = "Beta")))
        assertEquals(listOf("o1", "o2", "none"), buckets.map { it.key })
        assertEquals(listOf(true, false, true), buckets.map { it.named })
        assertEquals(listOf("x", "z"), buckets.first().rows.map { it.id })
        assertFalse(OrganizationBuckets.of(listOf(subject("y"))).single().named)
    }

    @Test
    fun activityMatchesTheTitleOrTheSubject() {
        val entry = InboxRecentEntry(
            subject = InboxRecentEntrySubject(CrmSubjectKind.PROJECT, "p", "Acme", InboxRecentEntrySubjectGroup.CLIENTS),
            id = "e", title = "Call with Rosa", type = "interaction", date = "2026-10-28T10:00:00Z",
        )
        assertTrue(WorkActivity.matches(entry, ""))
        assertTrue(WorkActivity.matches(entry, "rosa"))
        assertTrue(WorkActivity.matches(entry, "acme"))
        assertFalse(WorkActivity.matches(entry, "zebra"))
    }
}
