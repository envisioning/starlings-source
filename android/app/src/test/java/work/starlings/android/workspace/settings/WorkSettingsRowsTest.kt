package work.starlings.android.workspace.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** [WorkSettingsRows] against `fixtures/work-modules.json` (the gates) and `fixtures/inbox-values.json` (order, defaults). */
class WorkSettingsRowsTest {
    private val fixtures = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"))
    private fun fixture(name: String) = Json.parseToJsonElement(File(fixtures, name).readText()).jsonObject

    @Test
    fun theKindGatesAreTheWorkModulesTable() {
        val gates = fixture("work-modules.json")["gates"]!!.jsonArray.map { it.jsonObject }
        assertEquals(gates.map { it["kind"]!!.jsonPrimitive.content }, WorkSettingsRows.ShownKind.entries.map { it.kind })
        assertEquals(gates.map { it["module"]!!.jsonPrimitive.contentOrNull }, WorkSettingsRows.ShownKind.entries.map { it.module })
    }

    @Test
    fun aWorkspaceOffersTheKindsItsModulesHave() {
        assertEquals(WorkSettingsRows.ShownKind.entries, WorkSettingsRows.offered(null))
        assertEquals(listOf("project", "event"), WorkSettingsRows.offered(listOf("events")).map { it.kind })
        assertEquals(listOf("project", "lead", "organization"), WorkSettingsRows.offered(listOf("sales", "partners")).map { it.kind })
    }

    @Test
    fun anOlderWorkerHidesOnlySales() {
        assertEquals(listOf("lead"), WorkSettingsRows.hiddenKinds(null, salesEnabled = false))
        assertEquals(emptyList<String>(), WorkSettingsRows.hiddenKinds(null, salesEnabled = true))
        assertEquals(listOf("event"), WorkSettingsRows.hiddenKinds(listOf("event"), salesEnabled = false))
    }

    @Test
    fun oneSwitchSendsTheWholeList() {
        assertEquals(listOf("event", "lead"), WorkSettingsRows.toggled(listOf("event"), "lead", shown = false))
        assertEquals(listOf("event"), WorkSettingsRows.toggled(listOf("lead", "event"), "lead", shown = true))
        assertEquals(listOf("lead"), WorkSettingsRows.toggled(listOf("lead"), "lead", shown = false))
    }

    @Test
    fun inboxSwitchesKeepTheRegistryOrderAndDefaults() {
        val table = fixture("inbox-values.json")["sources"]!!.jsonArray.map { it.jsonObject }
        val all = table.map { it["source"]!!.jsonPrimitive.content }
        assertEquals(all, WorkSettingsRows.inboxSources(all.reversed()))
        assertEquals(listOf("decision", "sales"), WorkSettingsRows.inboxSources(listOf("sales", "decision", "mention")))
        table.forEach { row ->
            val source = row["source"]!!.jsonPrimitive.content
            assertEquals(source, row["default_on"]!!.jsonPrimitive.boolean, WorkSettingsRows.isOn(emptyMap(), source))
        }
        assertFalse(WorkSettingsRows.isOn(mapOf("talk" to false), "talk"))
        assertFalse(WorkSettingsRows.isEnabled("sales", salesEnabled = false))
        assertTrue(WorkSettingsRows.isEnabled("talk", salesEnabled = false))
    }
}
