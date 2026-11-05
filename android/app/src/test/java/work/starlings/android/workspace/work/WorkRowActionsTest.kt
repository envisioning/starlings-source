package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.CrmGoal
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmTaskUpdate
import work.starlings.contracts.WireJson
import java.io.File
import java.time.LocalDate

/** [WorkRowActions] against `fixtures/work-actions.json`, [Goals] against `goals-decisions.json`, and the menu writes. */
class WorkRowActionsTest {
    private val dir = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"))
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(File(dir, name).readText()).jsonObject

    @Test
    fun theTablesAreTheRegistrys() {
        val table = fixture("work-actions.json")
        WorkRowActions.Kind.entries.forEach { kind ->
            val contexts = table["contexts"]!!.jsonObject[kind.wire]!!.jsonObject.mapValues { (_, groups) ->
                groups.jsonArray.map { group -> group.jsonArray.map { it.jsonPrimitive.content } }
            }
            assertEquals("contexts of ${kind.wire}", contexts, WorkRowActions.contexts[kind])
            val phone = table["clients"]!!.jsonObject[kind.wire]!!.jsonObject
                .filter { (_, clients) -> clients.jsonObject["ios"]!!.jsonPrimitive.boolean }.keys
            assertEquals("the phone's ${kind.wire}", phone, WorkRowActions.phone[kind])
        }
        val destructive = table["actions"]!!.jsonObject.filter { (_, spec) -> spec.jsonObject["destructive"]!!.jsonPrimitive.boolean }.keys
        assertEquals(destructive, WorkRowActions.destructive)
    }

    @Test
    fun factsGateTheMenu() {
        val mine = WorkRowActions.groups(
            WorkRowActions.Kind.TASK, "mine",
            mapOf("hasSubject" to true, "canFileOnGitHub" to true, "canDelete" to true),
        )
        assertEquals(listOf(listOf("complete", "cancel"), listOf("open-subject"), listOf("file-github"), listOf("delete")), mine)
        val loose = WorkRowActions.groups(WorkRowActions.Kind.TASK, "mine", mapOf("hasSubject" to false))
        assertEquals(listOf(listOf("complete", "cancel"), listOf("open-mine")), loose)
        val open = WorkRowActions.groups(WorkRowActions.Kind.ISSUE, "row", mapOf("isOpen" to true))
        // An issue's star has no fact behind it in Swift: it stays.
        assertEquals(listOf(listOf("close-issue", "close-not-planned"), listOf("star")), open)
        val closed = WorkRowActions.groups(WorkRowActions.Kind.ISSUE, "row", mapOf("isOpen" to false))
        assertEquals(listOf(listOf("reopen-issue"), listOf("star")), closed)
        assertEquals(listOf(listOf("file-note"), listOf("delete")), WorkRowActions.groups(WorkRowActions.Kind.QUICK_NOTE, "inbox"))
        val commercial = WorkRowActions.Kind.INBOX_COMMERCIAL
        assertEquals(listOf(listOf("open-subject"), listOf("dismiss")), WorkRowActions.groups(commercial, "row", mapOf("isDismissed" to false)))
        assertEquals(listOf(listOf("open-subject"), listOf("undo-dismiss")), WorkRowActions.groups(commercial, "row", mapOf("isDismissed" to true)))
    }

    @Test
    fun goalsFollowTheFixture() {
        val table = fixture("goals-decisions.json")
        val today = LocalDate.parse(table["today"]!!.jsonPrimitive.content.take(10))
        fun goal(raw: JsonObject, id: String = "g") = WireJson.decodeFromString(
            CrmGoal.serializer(),
            JsonObject(mapOf("id" to Json.parseToJsonElement("\"$id\""), "project_id" to Json.parseToJsonElement("\"p\""), "title" to Json.parseToJsonElement("\"t\""), "created_at" to Json.parseToJsonElement("\"2026-09-01T00:00:00Z\"")) + raw).toString(),
        )
        table["late"]!!.jsonArray.forEach { case ->
            val c = case.jsonObject
            assertEquals(c["name"]!!.jsonPrimitive.content, c["expect"]!!.jsonPrimitive.boolean, Goals.isLate(goal(c["goal"]!!.jsonObject), today))
        }
        table["live"]!!.jsonArray.forEach { case ->
            val c = case.jsonObject
            assertEquals(c["name"]!!.jsonPrimitive.content, c["expect"]!!.jsonPrimitive.boolean, Goals.isLive(goal(c["goal"]!!.jsonObject)))
        }
        table["order"]!!.jsonArray.forEach { case ->
            val c = case.jsonObject
            val goals = c["goals"]!!.jsonArray.map { WireJson.decodeFromString(CrmGoal.serializer(), JsonObject(it.jsonObject + mapOf("project_id" to Json.parseToJsonElement("\"p\""))).toString()) }
            val expect = c["expect"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(c["name"]!!.jsonPrimitive.content, expect, Goals.sorted(goals, today).map { it.id })
        }
    }

    @Test
    fun aMoveNamesWhereTheTaskWas() {
        val update = TaskWrites.move(TaskKeys(projectId = "p1", organizationId = "o1"), SubjectRef(CrmSubjectKind.LEAD, "l1", "Acme"))
        assertEquals(
            """{"lead_id":"l1","moved_from":{"project_id":"p1"}}""",
            WireJson.encodeToString(CrmTaskUpdate.serializer(), update),
        )
        assertEquals(
            """{"responsible_party":"team","assigned_to":"m1"}""",
            WireJson.encodeToString(CrmTaskUpdate.serializer(), TaskWrites.assignment("m1")),
        )
        assertEquals("""{"status":"cancelled"}""", WireJson.encodeToString(CrmTaskUpdate.serializer(), TaskWrites.cancellation))
    }
}
