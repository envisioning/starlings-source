package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.WorkSection
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.CrmTeamMember
import work.starlings.contracts.Patch
import work.starlings.contracts.WireJson
import work.starlings.contracts.CrmTaskCreate
import work.starlings.contracts.CrmTaskUpdate
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * The Work tab's pure half: subject state against `fixtures/subject-state.json`
 * (the groups and resolve tables, as `Tests/SubjectStateTests.swift` reads
 * them), and the task adapters, dates and draft the screens send.
 */
class WorkModelTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val now = Instant.parse("2026-10-28T10:00:00Z").toEpochMilli()

    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    @Test
    fun subjectGroupsFollowTheFixture() {
        val cases = fixture("subject-state.json")["groups"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val o = case.jsonObject
            val s = o["subject"]!!.jsonObject
            val group = SubjectState.group(
                s["kind"]!!.jsonPrimitive.content,
                s["title"]!!.jsonPrimitive.content,
                s["internal"]?.jsonPrimitive?.booleanOrNull,
            )
            assertEquals(o["name"]!!.jsonPrimitive.content, o["expect"]!!.jsonPrimitive.content, group.wire)
        }
    }

    @Test
    fun subjectResolveFollowsTheFixture() {
        val cases = fixture("subject-state.json")["resolve"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val o = case.jsonObject
            val s = o["subject"]!!.jsonObject
            val group = SubjectState.group(s["kind"]!!.jsonPrimitive.content, s["title"]!!.jsonPrimitive.content, s["internal"]?.jsonPrimitive?.booleanOrNull)
            val override = o["override"]?.takeIf { it !is JsonNull }?.jsonObject
            val resolved = SubjectState.resolve(
                group,
                salesEnabled = o["sales_enabled"]!!.jsonPrimitive.boolean,
                hiddenKinds = o["hidden_kinds"]?.jsonArray?.map { it.jsonPrimitive.content },
                starred = override?.get("starred")?.jsonPrimitive?.boolean,
                muted = override?.get("muted")?.jsonPrimitive?.boolean,
            )
            val e = o["expect"]!!.jsonObject
            val name = o["name"]!!.jsonPrimitive.content
            assertEquals(name, e["listed"]!!.jsonPrimitive.boolean, resolved.listed)
            assertEquals(name, e["starred"]!!.jsonPrimitive.boolean, resolved.starred)
            assertEquals(name, e["muted"]!!.jsonPrimitive.boolean, resolved.muted)
        }
    }

    @Test
    fun taskDatesReadInstantsAndDateOnlyDays() {
        assertEquals(Instant.parse("2026-10-28T09:00:00Z").toEpochMilli(), TaskDates.parse("2026-10-28T09:00:00Z", zone))
        assertEquals(Instant.parse("2026-10-28T09:00:00.250Z").toEpochMilli(), TaskDates.parse("2026-10-28T09:00:00.250Z", zone))
        // A date-only column is local midnight, never UTC midnight.
        assertEquals(LocalDate.of(2026, 10, 28).atStartOfDay(zone).toInstant().toEpochMilli(), TaskDates.parse("2026-10-28", zone))
        assertNull(TaskDates.parse("tomorrow", zone))
        assertNull(TaskDates.parse("2026-02-31", zone))
        assertNull(TaskDates.parse(null, zone))
        assertEquals("2026-10-27T23:00:00Z", TaskDates.wire(LocalDate.of(2026, 10, 28), zone))
        assertEquals(LocalDate.of(2026, 10, 28), TaskDates.day(TaskDates.wire(LocalDate.of(2026, 10, 28), zone), zone))
        assertTrue(TaskDates.isOverdue("2026-10-27", now, zone))
        // Due earlier today is due today, not late.
        assertFalse(TaskDates.isOverdue("2026-10-28T06:00:00Z", now, zone))
    }

    private fun myTask(id: String, due: String? = null, project: String? = "p1", org: String? = null, status: String = "pending", issue: Long? = null) =
        CrmMyTaskWire(
            id = id, title = "Task $id", status = status, responsibleParty = "team", dueDate = due,
            projectId = project, organizationId = org, subjectTitle = "Acme",
            githubOwner = issue?.let { "envisioning" }, githubRepo = issue?.let { "starlings" }, githubIssueNumber = issue,
        )

    private fun issue(number: Long, title: String = "Issue $number") = CrmIssueWire(
        id = "envisioning/starlings#$number", number = number, owner = "envisioning", repo = "starlings", title = title,
        state = CrmIssueState.OPEN, url = "https://github.com/envisioning/starlings-source/issues/$number", labels = emptyList(), comments = 0,
    )

    @Test
    fun minePlansThenSearchesAndAPromotedTaskClaimsItsIssue() {
        val plan = MineWork.plan(
            listOf(myTask("late", due = "2026-10-20"), myTask("loose", project = null), myTask("promoted", issue = 7), myTask("done", status = "completed")),
            listOf(issue(7), issue(8, "Pilot rollout")),
            query = "", now = now, zone = zone,
        )
        assertEquals(listOf("loose", "late"), plan.order.take(2).map { it.workId })
        assertEquals(WorkSection.INBOX, plan.sectionOf["loose"])
        assertFalse(plan.order.any { it.workId == "envisioning/starlings#7" })
        assertFalse(plan.order.any { it.workId == "done" })
        assertEquals(4, plan.openCount)
        // Search runs after the dedupe: #7 finds the task that claimed it.
        val searched = MineWork.plan(listOf(myTask("promoted", issue = 7)), listOf(issue(7)), "#7", now, zone)
        assertEquals(listOf("promoted"), searched.order.map { it.workId })
        assertEquals(listOf("envisioning/starlings#8"), MineWork.plan(emptyList(), listOf(issue(8, "Pilot rollout")), "pilot", now, zone).order.map { it.workId })
    }

    @Test
    fun anOrganizationFilesATaskOnlyWhenNothingElseDoes() {
        val partner = TaskKeys(organizationId = "o1")
        assertEquals("o1", partner.partnerOrganizationId)
        assertTrue(partner.isFiled)
        assertEquals(SubjectRef(CrmSubjectKind.ORGANIZATION, "o1", "Echos"), partner.subject("Echos"))
        val context = TaskKeys(projectId = "p1", organizationId = "o1")
        assertNull(context.partnerOrganizationId)
        assertEquals(CrmSubjectKind.PROJECT, context.subject("Acme")?.kind)
        val meeting = TaskKeys(meetingId = "m1", organizationId = "o1")
        assertFalse(meeting.isFiled)
        assertTrue(meeting.hasSubjectKey)
        assertNull(TaskKeys(projectId = "p1").subject(null))
    }

    @Test
    fun whereNamesTheKindThenTheSubject() {
        assertEquals(TaskWhereKind.PARTNER, TaskWhere.kind(TaskKeys(organizationId = "o1"), null))
        assertEquals(TaskWhereKind.MEETING, TaskWhere.kind(TaskKeys(meetingId = "m1"), null))
        assertEquals(TaskWhereKind.NO_SUBJECT, TaskWhere.kind(TaskKeys(), null))
        assertEquals(TaskWhereKind.LEAD, TaskWhere.kind(null, SubjectRef(CrmSubjectKind.LEAD, "l1", "Northwind")))
        assertEquals("Partner · Echos", TaskWhere.text("Partner", TaskWhereKind.PARTNER, " Echos "))
        assertEquals("Project", TaskWhere.text("Project", TaskWhereKind.PROJECT, null))
        assertEquals("No subject", TaskWhere.text("No subject", TaskWhereKind.NO_SUBJECT, "Ghost"))
    }

    @Test
    fun aNewTeamTaskStartsAsTheCreatorsOwn() {
        val team = listOf(CrmTeamMember("u1", "Rosa", email = "rosa@org.example"), CrmTeamMember("u2", "Ada", email = "ADA@org.example"))
        val fresh = TaskDraft(id = null)
        assertEquals(TaskStatus.PENDING, fresh.status)
        assertEquals(TaskSide.TEAM, fresh.side)
        assertEquals("u2", fresh.preselectingSelf(team, "ada@org.example").assignedTo)
        // A pick by hand, a client task, an existing task, or a stranger keep what they had.
        assertEquals("u1", fresh.copy(assignedTo = "u1").preselectingSelf(team, "ada@org.example").assignedTo)
        assertNull(fresh.withSide(TaskSide.CLIENT).preselectingSelf(team, "ada@org.example").assignedTo)
        assertNull(fresh.copy(id = "t1").preselectingSelf(team, "ada@org.example").assignedTo)
        assertNull(fresh.preselectingSelf(team, "guest@example.com").assignedTo)
        assertNull(fresh.copy(assignedTo = "u1").withSide(TaskSide.CLIENT).assignedTo)
        assertFalse(fresh.copy(title = "   ").canSave)
    }

    @Test
    fun aCreateIsFiledOnItsSubjectAndOmitsWhatIsEmpty() {
        val draft = TaskDraft(id = null, title = "  Send the deck ", notes = " ", assignedTo = "u2", due = LocalDate.of(2026, 10, 30))
        val project = draft.create(SubjectRef(CrmSubjectKind.PROJECT, "p1", "Acme"), zone)
        assertEquals("Send the deck", project.title)
        assertEquals(Patch.Value("p1"), project.projectId)
        assertEquals(Patch.Omit, project.leadId)
        assertEquals(Patch.Omit, project.notes)
        assertEquals(Patch.Value("u2"), project.assignedTo)
        val body = Json.parseToJsonElement(WireJson.encodeToString(CrmTaskCreate.serializer(), project)).jsonObject
        assertEquals("p1", body["project_id"]!!.jsonPrimitive.content)
        assertEquals("team", body["responsible_party"]!!.jsonPrimitive.content)
        assertEquals("pending", body["status"]!!.jsonPrimitive.content)
        assertEquals("2026-10-29T23:00:00Z", body["due_date"]!!.jsonPrimitive.content)
        assertFalse("lead_id" in body)
        assertFalse("notes" in body)
        val lead = TaskDraft(id = null, title = "Call").create(SubjectRef(CrmSubjectKind.LEAD, "l1", "Northwind"), zone)
        assertEquals(Patch.Value("l1"), lead.leadId)
        assertEquals(Patch.Omit, lead.projectId)
        assertEquals(Patch.Null, lead.assignedTo)
        val partner = TaskDraft(id = null, title = "Call").create(SubjectRef(CrmSubjectKind.ORGANIZATION, "o1", "Echos"), zone)
        assertEquals(Patch.Value("o1"), partner.organizationId)
    }

    @Test
    fun anEditSendsEveryFieldAndAnEmptyDateClears() {
        val task = CrmTaskWire(
            id = "t1", title = "Ship", notes = "Old", status = "in_progress", responsibleParty = "client",
            assigneeId = null, dueDate = "2026-10-30", goalId = "g1",
        )
        val draft = TaskDraft.of(task, zone)
        assertEquals(TaskStatus.IN_PROGRESS, draft.status)
        assertEquals(TaskSide.CLIENT, draft.side)
        assertEquals(LocalDate.of(2026, 10, 30), draft.due)
        val update = draft.copy(due = null, notes = "").update(zone)
        val body = Json.parseToJsonElement(WireJson.encodeToString(CrmTaskUpdate.serializer(), update)).jsonObject
        assertTrue(body["due_date"] is JsonNull)
        assertTrue(body["assigned_to"] is JsonNull)
        assertEquals("", body["notes"]!!.jsonPrimitive.content)
        assertEquals("client", body["responsible_party"]!!.jsonPrimitive.content)
        // No goal picker on Android: the goal is never sent, so it never changes.
        assertFalse("goal_id" in body)
        assertEquals("completed", TaskWrites.completion(true).status?.value)
        assertEquals("declined", TaskWrites.proposalDecision(false).status?.value)
        assertEquals("pending", TaskWrites.proposalDecision(true).status?.value)
    }

    @Test
    fun statusesReadAsTheRegistrySays() {
        assertEquals(TaskStatus.PENDING, TaskStatus.of("whatever"))
        assertFalse(TaskStatus.PROPOSED in TaskStatus.editable)
        assertFalse(TaskStatus.DECLINED in TaskStatus.editable)
        assertEquals(6, TaskStatus.editable.size)
        assertTrue(TaskStatus.DECLINED.isFinished)
        assertEquals(TaskSide.UNASSIGNED, TaskSide.of(null))
    }

    @Test
    fun theBoardPutsCardsInTheirStageColumns() {
        val tasks = listOf(
            CrmTaskWire(id = "a", title = "A", status = "in_progress", responsibleParty = "team", projectId = "p1"),
            CrmTaskWire(id = "b", title = "B", status = "completed", responsibleParty = "team", projectId = "p1", updatedAt = "2026-10-27T10:00:00Z"),
            CrmTaskWire(id = "c", title = "C", status = "completed", responsibleParty = "team", projectId = "p1", updatedAt = "2026-09-01T10:00:00Z"),
        )
        val board = BoardItem.board(tasks, listOf(issue(9)), "2026-10-21T00:00:00Z", now, zone)
        assertEquals(listOf("a"), board.items(work.starlings.android.WorkStage.DOING).map { it.workId })
        assertEquals(listOf("b"), board.items(work.starlings.android.WorkStage.DONE).map { it.workId })
        assertEquals(listOf("envisioning/starlings#9"), board.items(work.starlings.android.WorkStage.QUEUED).map { it.workId })
    }
}
