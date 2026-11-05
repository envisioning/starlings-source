package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.CrmLeadUpdate
import work.starlings.contracts.CrmProjectCreate
import work.starlings.contracts.CrmProjectUpdate
import work.starlings.contracts.CrmSubjectCreate
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.WireJson
import java.io.File
import java.time.LocalDate

/**
 * The subject editor against `form-fields.json` and `subject-status.json`,
 * the subject row menu against `work-actions.json` `subject`, and Win's
 * task rule (`MobileLeadWinView.movable`).
 */
class SubjectEditorTest {
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), name).readText(),
    ).jsonObject

    @Test
    fun fieldRulesFollowTheTable() {
        val forms = fixture("form-fields.json")["forms"]!!.jsonObject
        listOf("lead" to SubjectForm.lead, "project" to SubjectForm.project).forEach { (kind, fields) ->
            val rows = forms[kind]!!.jsonArray.associateBy { it.jsonObject["id"]!!.jsonPrimitive.content }
            listOf(fields.title, fields.organization, fields.text, fields.startDate).forEach { spec ->
                val row = rows.getValue(spec.id).jsonObject
                assertEquals("$kind ${spec.id}", row["required"]!!.jsonPrimitive.content != "none", spec.required)
                assertEquals("$kind ${spec.id}", row["maxLength"]?.takeIf { it != JsonNull }?.jsonPrimitive?.intOrNull, spec.maxLength)
                assertEquals("$kind ${spec.id}", row["label"]!!.jsonPrimitive.content, spec.label)
            }
        }
        val end = forms["project"]!!.jsonArray.first { it.jsonObject["id"]!!.jsonPrimitive.content == "endDate" }.jsonObject
        assertEquals(end["maxLength"]!!.jsonPrimitive.intOrNull, SubjectForm.projectEndDate.maxLength)
    }

    @Test
    fun statusesFollowTheTable() {
        val kinds = fixture("subject-status.json")["kinds"]!!.jsonObject
        val project = kinds["project"]!!.jsonObject
        assertEquals(project["statuses"]!!.jsonArray.map { it.jsonPrimitive.content }, SubjectForm.statuses(CrmSubjectKind.PROJECT))
        assertEquals(project["defaultStatus"]!!.jsonPrimitive.content, SubjectForm.defaultStatus(CrmSubjectKind.PROJECT))
        val lead = kinds["lead"]!!.jsonObject
        assertEquals(lead["closed"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet(), SubjectMenuFacts.closedLeadStatuses)
    }

    @Test
    fun anEditDoesNotAskForWhatTheRecordLacks() {
        assertEquals(SubjectForm.Problem.Required("organization"), SubjectForm.problem(CrmSubjectKind.LEAD, "Atlas", null, ""))
        assertNull(SubjectForm.problem(CrmSubjectKind.LEAD, "Atlas", null, "", lacking = setOf("organization")))
        assertNull(SubjectForm.problem(CrmSubjectKind.PROJECT, "Atlas", null, ""))
        assertEquals(SubjectForm.Problem.TooLong("description", 2000), SubjectForm.problem(CrmSubjectKind.PROJECT, "Atlas", null, "x".repeat(2001)))
    }

    @Test
    fun aNewProjectLeavesBlanksOut() {
        val draft = SubjectForm.Draft(CrmSubjectKind.PROJECT, " Atlas ", "Active", startDate = LocalDate.of(2026, 10, 29), url = "atlas.test")
        assertEquals(
            """{"title":"Atlas","url":"https://atlas.test","start_date":"2026-10-29","status":"Active","kind":"project"}""",
            WireJson.encodeToString(CrmSubjectCreate.serializer(), SubjectForm.create(draft)),
        )
        assertTrue(SubjectForm.create(draft) is CrmProjectCreate)
    }

    @Test
    fun anEditSendsTheWholeState() {
        val project = SubjectForm.Draft(CrmSubjectKind.PROJECT, "Atlas", "Paused", startDate = null)
        assertEquals(
            """{"title":"Atlas","description":null,"url":null,"organization_id":null,"contact_ids":[],"start_date":null,"end_date":null,"status":"Paused"}""",
            WireJson.encodeToString(CrmProjectUpdate.serializer(), SubjectForm.projectUpdate(project)),
        )
        val lead = SubjectForm.Draft(
            CrmSubjectKind.LEAD, "Atlas", "Proposal Out", LocalDate.of(2026, 10, 1),
            organizationId = "o1", characteristics = mapOf("project_fit" to true, "other" to false),
        )
        assertEquals(
            """{"title":"Atlas","organization_id":"o1","contact_id":null,"status":"Proposal Out","start_date":"2026-10-01","notes":null,"characteristics":{"project_fit":true,"other":false}}""",
            WireJson.encodeToString(CrmLeadUpdate.serializer(), SubjectForm.leadUpdate(lead)),
        )
        assertEquals("""{"title":"New"}""", WireJson.encodeToString(CrmProjectUpdate.serializer(), SubjectForm.renameProject(" New ")))
    }

    @Test
    fun theRowMenuFollowsTheTable() {
        fun subject(kind: CrmSubjectKind, status: String? = null, hasRepo: Boolean? = null) =
            CrmSubjectWire(id = "s", kind = kind, title = "S", status = status, hasRepo = hasRepo)
        fun groups(subject: CrmSubjectWire) = WorkRowActions.groups(WorkRowActions.Kind.SUBJECT, SubjectMenuFacts.context(subject), SubjectMenuFacts.of(subject))
        assertEquals(
            listOf(listOf("star", "mute"), listOf("open", "edit-details", "rename"), listOf("open-tasks", "new-task"), listOf("start-room", "link-repository", "keep-vault")),
            groups(subject(CrmSubjectKind.PROJECT)),
        )
        assertEquals(
            listOf(listOf("open-tasks", "open-issues", "new-task", "new-issue")),
            groups(subject(CrmSubjectKind.PROJECT, hasRepo = true)).filter { "open-tasks" in it },
        )
        assertTrue("win-lead" in groups(subject(CrmSubjectKind.LEAD, "Proposal Out")).flatten())
        assertFalse("win-lead" in groups(subject(CrmSubjectKind.LEAD, "Closed Won")).flatten())
        assertEquals(
            listOf(listOf("star", "mute"), listOf("open", "open-talk", "open-history", "start-room"), listOf("open-tasks", "new-task")),
            groups(subject(CrmSubjectKind.ORGANIZATION)),
        )
        // An event is not edited or renamed here, and has no room of its own.
        assertEquals(listOf(listOf("star", "mute"), listOf("open"), listOf("open-tasks", "new-task")), groups(subject(CrmSubjectKind.EVENT)))
    }

    @Test
    fun aWinMovesOpenWorkOnly() {
        fun task(id: String, status: String) = CrmTaskWire(id = id, title = id, status = status, responsibleParty = "us")
        val tasks = listOf(task("a", "pending"), task("b", "proposed"), task("c", "blocked"), task("d", "completed"))
        val movable = WinLead.movable(tasks)
        assertEquals(listOf("a", "c"), movable.map { it.id })
        assertEquals(listOf("a", "c"), WinLead.taskIds(movable, setOf("c", "a")))
    }
}
