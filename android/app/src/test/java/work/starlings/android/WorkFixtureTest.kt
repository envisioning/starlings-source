package work.starlings.android

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.ZoneId

/**
 * Mine, the board, Unowned, Focus and event phases against
 * `fixtures/work-items.json`, the subject row against `fixtures/work-rows.json`,
 * and the rail ranker against `fixtures/work-ranker.json`. Ports
 * `Tests/WorkItemFixtureTests.swift`, `Tests/WorkRowFixtureTests.swift` and
 * `Tests/WorkRankerFixtureTests.swift`.
 */
class WorkFixtureTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private val JsonElement.string get() = jsonPrimitive.content
    private fun JsonElement?.stringOrNull(): String? = if (this == null || this is JsonNull) null else jsonPrimitive.content
    private fun JsonElement?.strings(): List<String>? = (this as? JsonArray)?.map { it.string }
    private fun JsonObject.bool(key: String): Boolean? = this[key]?.jsonPrimitive?.booleanOrNull

    /** The neutral shape the table is written in, adapted the way a surface adapts its own. */
    private data class Card(
        override val workId: String,
        override val workOrigin: WorkItemOrigin,
        override val workIsDone: Boolean = false,
        override val workIsFiled: Boolean = true,
        override val workDueDate: Long? = null,
        override val workUpdatedAt: Long? = null,
        override val workGithubRef: String? = null,
        override val workTaskStatus: String? = null,
        override val workIssueState: String? = null,
        override val workIssueStateReason: String? = null,
        override val workLabels: List<String> = emptyList(),
        override val workAssignee: String? = null,
        override val workResponsibleParty: String? = null,
        override val workAssignees: List<String> = emptyList(),
    ) : WorkCard

    private fun card(e: JsonElement): Card {
        val o = e.jsonObject
        return Card(
            workId = o["id"]!!.string,
            workOrigin = if (o["origin"]!!.string == "issue") WorkItemOrigin.ISSUE else WorkItemOrigin.TASK,
            workIsDone = o.bool("done") ?: false,
            workIsFiled = o.bool("filed") ?: true,
            workDueDate = Upcoming.parse(o["dueDate"].stringOrNull()),
            workUpdatedAt = Upcoming.parse(o["updatedAt"].stringOrNull()),
            workGithubRef = o["githubRef"].stringOrNull(),
            workTaskStatus = o["status"].stringOrNull(),
            workIssueState = o["state"].stringOrNull(),
            workIssueStateReason = o["stateReason"].stringOrNull(),
            workLabels = o["labels"].strings() ?: emptyList(),
            workAssignee = o["assignee"].stringOrNull(),
            workResponsibleParty = o["responsibleParty"].stringOrNull(),
            workAssignees = o["assignees"].strings() ?: emptyList(),
        )
    }

    private val table by lazy { fixture("work-items.json") }
    private fun JsonObject.cases(key: String) = this[key]!!.jsonArray.map { it.jsonObject }
    private fun JsonObject.items() = this["items"]!!.jsonArray.map(::card)
    private fun JsonObject.now() = Upcoming.parse(this["now"]!!.string)!!
    private fun JsonObject.zone() = ZoneId.of(this["timeZone"]!!.string)
    private fun JsonObject.name() = this["name"]!!.string
    private fun choices(key: String) = table[key]!!.jsonArray.map { it.jsonObject["value"]!!.string to it.jsonObject["title"]!!.string }

    @Test
    fun registries() {
        assertEquals("work-items", table["contract"]!!.string)
        assertEquals(2, table["version"]!!.jsonPrimitive.int)
        assertEquals(choices("mineSections"), MineSectionFilter.entries.map { it.wire to it.title })
        assertEquals(choices("mineOrigins"), MineOriginFilter.entries.map { it.wire to it.title })
        assertEquals(choices("stageTitles"), WorkStage.entries.map { it.wire to it.title })
        assertEquals(choices("holderChoices"), WorkHolderChoice.entries.map { it.wire to it.title })
        assertEquals(choices("dueChoices"), WorkDueFilter.entries.map { it.wire to it.title })
        assertEquals(choices("sideChoices"), WorkSideFilter.entries.map { it.wire to it.title })
        assertEquals(table["stages"]!!.jsonObject["vocabulary"].strings(), WorkStage.entries.map { it.wire })
        assertEquals(table["events"]!!.jsonObject["vocabulary"].strings(), EventPhase.entries.map { it.wire })
    }

    @Test
    fun everyPlanCase() {
        val cases = table.cases("cases")
        assertTrue(cases.isNotEmpty())
        cases.forEach { c ->
            val name = c.name()
            val plan = WorkItems.plan(c.items(), c.now(), c.zone())
            val expect = c["expect"]!!.jsonObject
            assertEquals("order: $name", expect["order"].strings(), plan.order.map { it.workId })
            val sections = expect["sections"]!!.jsonObject
            WorkSection.entries.forEach { s ->
                assertEquals("${s.wire}: $name", sections[s.wire].strings() ?: emptyList<String>(), plan.items(s).map { it.workId })
            }
            assertEquals("open: $name", expect["open"]!!.jsonPrimitive.int, plan.openCount)
            assertEquals("late: $name", expect["late"]!!.jsonPrimitive.int, plan.lateCount)
        }
    }

    @Test
    fun sectionsPartitionTheOrder() {
        table.cases("cases").forEach { c ->
            val plan = WorkItems.plan(c.items(), c.now(), c.zone())
            assertEquals(c.name(), plan.order.map { it.workId }, WorkSection.entries.flatMap { s -> plan.items(s).map { it.workId } })
            WorkSection.entries.forEach { s -> plan.items(s).forEach { assertEquals(c.name(), s, plan.sectionOf[it.workId]) } }
        }
    }

    @Test
    fun filteringPreservesThePlan() {
        val now = Upcoming.parse("2026-09-10T12:00:00Z")!!
        val utc = ZoneId.of("UTC")
        val items = listOf(
            Card("late-task", WorkItemOrigin.TASK, workDueDate = Upcoming.parse("2026-09-09T10:00:00Z")),
            Card("today-task", WorkItemOrigin.TASK, workDueDate = Upcoming.parse("2026-09-10T10:00:00Z")),
            Card("today-issue", WorkItemOrigin.ISSUE, workUpdatedAt = Upcoming.parse("2026-09-10T11:00:00Z")),
        )
        val filtered = WorkItems.plan(items, now, utc).filtered { it.workId == "today-task" }
        assertEquals(listOf("today-task"), filtered.order.map { it.workId })
        assertEquals(listOf("today-task"), filtered.items(WorkSection.TODAY).map { it.workId })
        assertTrue(filtered.items(WorkSection.LATE).isEmpty())
        assertEquals(mapOf("today-task" to WorkSection.TODAY), filtered.sectionOf)

        val mine = WorkItems.plan(items, now, utc).filtered(MineFilter(MineSectionFilter.TODAY, MineOriginFilter.TASK), now, utc)
        assertEquals(listOf("today-task"), mine.order.map { it.workId })
        assertEquals(mapOf("today-task" to WorkSection.TODAY), mine.sectionOf)
    }

    private val stages by lazy { table["stages"]!!.jsonObject }

    @Test
    fun everyStageCase() {
        stages.cases("stageCases").forEach { c ->
            assertEquals(c.name(), c["expect"]!!.string, WorkItems.stage(card(c["item"]!!)).wire)
        }
    }

    @Test
    fun everyWriteCase() {
        stages.cases("writeCases").forEach { c ->
            val item = card(c["item"]!!)
            val stage = WorkStage.entries.firstOrNull { it.wire == c["stage"]!!.string }
            assertNotNull(c.name(), stage)
            val expect = c["expect"]!!.jsonObject
            when (val w = WorkItems.write(stage!!, item)) {
                is WorkStageWrite.Task -> {
                    assertEquals(c.name(), WorkItemOrigin.TASK, item.workOrigin)
                    assertEquals(c.name(), expect["status"].stringOrNull(), w.status)
                }
                is WorkStageWrite.Issue -> {
                    assertEquals(c.name(), WorkItemOrigin.ISSUE, item.workOrigin)
                    assertEquals(c.name(), expect["state"].stringOrNull(), w.state)
                    assertEquals(c.name(), expect["state_reason"].stringOrNull(), w.stateReason)
                    assertEquals(c.name(), expect["labels"].strings(), w.labels)
                }
            }
        }
    }

    @Test
    fun everyHolderCase() {
        stages.cases("holderCases").forEach { c ->
            assertEquals(
                c.name(), c["expect"]!!.jsonPrimitive.boolean,
                WorkItems.passesHolderFilter(card(c["item"]!!), c["filter"]!!.string, c["agentEmail"].stringOrNull()),
            )
        }
    }

    @Test
    fun everyTaskFilterCase() {
        stages.cases("taskFilterCases").forEach { c ->
            val f = c["filter"]!!.jsonObject
            val due = WorkDueFilter.entries.first { it.wire == f["due"]!!.string }
            val side = WorkSideFilter.entries.first { it.wire == f["side"]!!.string }
            assertEquals(c.name(), c["expect"]!!.jsonPrimitive.boolean, WorkItems.passesTaskFilter(card(c["item"]!!), due, side, c.now(), c.zone()))
        }
    }

    @Test
    fun everyBoardCase() {
        stages.cases("boardCases").forEach { c ->
            val since = c["finishedSince"].stringOrNull()?.let { assertNotNull(c.name(), Upcoming.parse(it)); Upcoming.parse(it) }
            val board = WorkItems.board(c.items(), c.now(), c.zone(), since)
            val columns = c["expect"]!!.jsonObject["columns"]!!.jsonObject
            WorkStage.entries.forEach { s ->
                assertEquals("${s.wire}: ${c.name()}", columns[s.wire].strings() ?: emptyList<String>(), board.items(s).map { it.workId })
                board.items(s).forEach { assertEquals(c.name(), s, board.stageOf[it.workId]) }
            }
        }
    }

    @Test
    fun everyUnownedCase() {
        table["unowned"]!!.jsonObject.cases("cases").forEach { c ->
            assertEquals(c.name(), c["expect"].strings(), WorkItems.unowned(c.items(), c.now(), c.zone()).map { it.workId })
        }
    }

    @Test
    fun everyFocusCase() {
        table["focus"]!!.jsonObject.cases("cases").forEach { c ->
            val now = c.now()
            val zone = c.zone()
            val plan = WorkItems.plan(c.items(), now, zone)
            val focus = WorkItems.focus(plan, now, zone)
            val expect = c["expect"]!!.jsonObject
            assertEquals(c.name(), expect["rows"].strings(), focus.rows.map { it.workId })
            assertEquals(c.name(), expect["next"]!!.jsonPrimitive.boolean, focus.next)
            assertEquals(c.name(), expect["lateCount"]!!.jsonPrimitive.int, focus.lateCount)
            assertEquals(c.name(), expect["todayCount"]!!.jsonPrimitive.int, focus.todayCount)
            val filtered = plan.filtered(MineFilter(MineSectionFilter.FOCUS, MineOriginFilter.ALL), now, zone)
            assertEquals(c.name(), expect["mineFilter"].strings(), filtered.order.map { it.workId })
        }
    }

    @Test
    fun everyPhaseCase() {
        table["events"]!!.jsonObject.cases("phaseCases").forEach { c ->
            val date = c["eventDate"].stringOrNull()
            assertEquals(c.name(), c["expect"]!!.string, WorkItems.eventPhase(date, c.now(), c.zone()).wire)
            assertEquals(c.name(), c["daysUntil"]?.jsonPrimitive?.intOrNull, WorkItems.eventDaysUntil(date, c.now(), c.zone()))
        }
    }

    @Test
    fun everyRowCase() {
        val rows = fixture("work-rows.json")
        assertEquals(2, rows["version"]!!.jsonPrimitive.int)
        val cases = rows.cases("cases")
        assertTrue(cases.isNotEmpty())
        cases.forEach { c ->
            val spec = WorkSubjectRowSpec.of(
                c["title"]!!.string, c.bool("hasUnread")!!, c.bool("isStarred")!!, c.bool("isMuted")!!, c.bool("isSubdued")!!,
            )
            val e = c["expect"]!!.jsonObject
            val name = c.name()
            assertEquals("showsUnread: $name", e.bool("showsUnread"), spec.showsUnread)
            assertEquals("showsStarBadge: $name", e.bool("showsStarBadge"), spec.showsStarBadge)
            assertEquals("weight: $name", e["weight"]!!.string, spec.weight.wire)
            assertEquals("ink: $name", e["ink"]!!.string, spec.ink.wire)
            assertEquals("trailing: $name", e["trailing"]!!.string, spec.trailing.wire)
            assertEquals("label: $name", e["accessibilityLabel"]!!.string, spec.accessibilityLabel)
        }
    }

    private val ranker by lazy { fixture("work-ranker.json") }

    @Test
    fun rankerCriteria() {
        val e = ranker["criteria"]!!.jsonObject
        val c = WorkRankCriteria.DEFAULT
        fun d(key: String) = e[key]!!.jsonPrimitive.double
        fun i(key: String) = e[key]!!.jsonPrimitive.int
        assertEquals(i("railLimit"), c.railLimit)
        assertEquals(d("starred"), c.starred, 0.0)
        assertEquals(d("directAttention"), c.directAttention, 0.0)
        assertEquals(d("unread"), c.unread, 0.0)
        assertEquals(d("overduePerTask"), c.overduePerTask, 0.0)
        assertEquals(i("overdueCap"), c.overdueCap)
        assertEquals(d("eventToday"), c.eventToday, 0.0)
        assertEquals(d("eventSoonBase"), c.eventSoonBase, 0.0)
        assertEquals(d("eventSoonDecayPerDay"), c.eventSoonDecayPerDay, 0.0)
        assertEquals(i("eventHorizonDays"), c.eventHorizonDays)
        assertEquals(d("openWorkPerTask"), c.openWorkPerTask, 0.0)
        assertEquals(i("openWorkCap"), c.openWorkCap)
        assertEquals(d("recentActivityMax"), c.recentActivityMax, 0.0)
        assertEquals(e["activityHalfLifeMs"]!!.jsonPrimitive.long, c.activityHalfLifeMs)
        assertEquals(e["staleAfterMs"]!!.jsonPrimitive.long, c.staleAfterMs)
        assertEquals(d("staleWork"), c.staleWork, 0.0)
    }

    @Test
    fun rankerCases() {
        val now = Upcoming.parse(ranker["now"]!!.string)!!
        ranker.cases("cases").forEach { c ->
            val name = c.name()
            val subjects = c["subjects"]!!.jsonArray.map {
                val s = it.jsonObject
                WorkRankSubject(
                    id = s["id"]!!.string,
                    title = s["title"]!!.string,
                    kind = s["kind"]!!.string,
                    openTasks = s["open_tasks"]?.jsonPrimitive?.intOrNull ?: 0,
                    overdueTasks = s["overdue_tasks"]?.jsonPrimitive?.intOrNull ?: 0,
                    lastActivityAt = s["last_activity_at"].stringOrNull(),
                    eventDate = s["event_date"].stringOrNull(),
                )
            }
            val signals = c["signals"]!!.jsonObject.mapValues { (_, v) ->
                val s = v.jsonObject
                WorkRankSignals(s.bool("starred") ?: false, s.bool("direct_attention") ?: false, s.bool("unread") ?: false)
            }
            val ranked = WorkSubjectRanker.rank(subjects, signals, now)
            assertEquals(name, c["order"].strings(), ranked.map { it.subject.id })
            assertEquals(name, c["rail"].strings(), WorkSubjectRanker.rail(subjects, signals, now).map { it.subject.id })
            val scores = c["scores"]!!.jsonObject
            ranked.forEach { r ->
                assertEquals("$name: ${r.subject.id}", scores[r.subject.id]!!.jsonPrimitive.double, r.score, 0.001)
            }
        }
    }

    @Test
    fun rankerHoldsTheOpenSubject() {
        val subjects = listOf(WorkRankSubject("a", "A", "project"), WorkRankSubject("b", "B", "project"))
        val now = Upcoming.parse("2026-09-30T12:00:00Z")!!
        val rail = WorkSubjectRanker.rail(subjects, mapOf("b" to WorkRankSignals(unread = true)), now, holding = "a", previous = listOf("a", "b"))
        assertEquals(listOf("a", "b"), rail.map { it.subject.id })
    }
}
