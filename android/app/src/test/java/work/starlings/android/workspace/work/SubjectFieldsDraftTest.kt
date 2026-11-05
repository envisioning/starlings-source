package work.starlings.android.workspace.work

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.SubjectRoutes
import work.starlings.contracts.CrmSubjectDetailResponse
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.WireJson
import java.io.File
import java.time.LocalDate

/** The Fields pane's draft (`SubjectFieldsDraft`) over the shared project detail and the status table. */
class SubjectFieldsDraftTest {
    private val dir = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"))
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    private val project = WireJson.decodeFromString(CrmSubjectDetailResponse.serializer(), File(dir, "responses/crm-subject-project.json").readText()).subject

    @Test
    fun theDraftReadsTheDetail() {
        val draft = SubjectFieldsDraft.of(project)
        assertEquals("Pilot programme", draft.title)
        assertEquals(LocalDate.of(2026, 9, 1), draft.startDate)
        assertEquals(LocalDate.of(2026, 11, 30), draft.endDate)
        assertEquals("", draft.evid)
        assertNull("nothing changed", draft.update(draft, CrmSubjectKind.PROJECT))
    }

    @Test
    fun aProjectSendsOnlyWhatChanged() {
        val saved = SubjectFieldsDraft.of(project)
        val edited = saved.copy(description = "  ", evid = " EV-1 ", endDate = null, status = "Paused", isInternal = true)
        val update = edited.update(saved, CrmSubjectKind.PROJECT) as SubjectFieldsDraft.Update.Project
        assertEquals(
            """{"description":null,"evid":"EV-1","end_date":null,"status":"Paused","is_internal":true}""",
            SubjectRoutes.updateProject(project.id, update.update).body,
        )
        // A title is never blanked.
        val blank = saved.copy(title = " ").update(saved, CrmSubjectKind.PROJECT) as SubjectFieldsDraft.Update.Project
        assertNull(blank.update.title)
        assertFalse(saved.copy(title = " ").canSave(CrmSubjectKind.PROJECT))
    }

    @Test
    fun aLeadSendsItsOwnShape() {
        val saved = SubjectFieldsDraft(title = "Deal", status = "Conversations", startDate = LocalDate.of(2026, 10, 1))
        val edited = saved.copy(status = "Proposal Out", characteristics = mapOf("project_fit" to true), notes = "Call back")
        val update = edited.update(saved, CrmSubjectKind.LEAD) as SubjectFieldsDraft.Update.Lead
        assertEquals(
            """{"status":"Proposal Out","notes":"Call back","characteristics":{"project_fit":true}}""",
            SubjectRoutes.updateLead("l1", update.update).body,
        )
        assertFalse(saved.copy(startDate = null).canSave(CrmSubjectKind.LEAD))
        assertTrue(saved.canSave(CrmSubjectKind.LEAD))
        assertNull("an organization is read-only", edited.update(saved, CrmSubjectKind.ORGANIZATION))
    }

    @Test
    fun statusChoicesFollowTheTable() {
        val kinds = fixture("subject-status.json")["kinds"]!!.jsonObject
        fun statuses(kind: String) = kinds[kind]!!.jsonObject["statuses"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(statuses("project"), SubjectFieldsDraft.statusChoices(CrmSubjectKind.PROJECT, "Active"))
        assertEquals(statuses("lead"), SubjectFieldsDraft.statusChoices(CrmSubjectKind.LEAD, ""))
        // The record's own status leads when the table does not name it.
        assertEquals(listOf("Qualified") + statuses("lead"), SubjectFieldsDraft.statusChoices(CrmSubjectKind.LEAD, "Qualified"))
    }
}
