package work.starlings.android.workspace.home

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.Route
import work.starlings.android.workspace.settings.SettingsPages
import work.starlings.android.workspace.work.WorkspacePlanNotice
import work.starlings.contracts.SetupBlocker
import work.starlings.contracts.SetupBlockerBy
import work.starlings.contracts.SetupResponse
import work.starlings.contracts.SetupStepState
import work.starlings.contracts.WorkspacePlanResponse
import work.starlings.contracts.WorkspacePlanResponsePlan
import java.io.File

/**
 * Home's setup checklist (`SetupChecklist`), the invitation conflicts
 * (`CalendarConflictDetector`) and the plan notice (`WorkspacePlanNotice`),
 * against the shared tables and the Swift rules.
 */
class HomeSetupTest {
    private val fixtures = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"))
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(File(fixtures, name).readText()).jsonObject
    private val englishStrings: String get() = File(fixtures.parentFile, "android/app/src/main/res/values/strings_home_setup.xml").readText()

    @Test
    fun stepsAreTheTable() {
        val steps = fixture("setup-steps.json")["steps"]!!.jsonArray.map { it.jsonObject }
        assertEquals(steps.map { it["id"]!!.jsonPrimitive.content }, SetupStep.entries.map { it.id })
        assertEquals(steps.map { it["route"]!!.jsonPrimitive.content }, SetupStep.entries.map { it.route })
        val xml = englishStrings
        for (step in steps) {
            val title = step["title"]!!.jsonPrimitive.content
            assertTrue("$title is a string", xml.contains(">$title</string>"))
        }
    }

    private fun state(id: String, done: Boolean = false, required: Boolean = true, blocked: SetupBlocker? = null) = SetupStepState(id, done, required, blocked)

    private fun response(steps: List<SetupStepState>, next: String? = null, complete: Boolean = false, on: Boolean = true) =
        SetupResponse(steps, next, complete, on, canTurnOff = false)

    @Test
    fun cardRules() {
        assertEquals(SetupChecklist.Card.None, SetupChecklist.card(null, hidden = false, doneSaid = false))
        assertEquals(SetupChecklist.Card.None, SetupChecklist.card(response(listOf(state("profile")), on = false), false, false))
        assertEquals(SetupChecklist.Card.None, SetupChecklist.card(response(listOf(state("profile"))), hidden = true, doneSaid = false))
        assertEquals(SetupChecklist.Card.Done, SetupChecklist.card(response(emptyList(), complete = true), false, doneSaid = false))
        assertEquals(SetupChecklist.Card.None, SetupChecklist.card(response(emptyList(), complete = true), false, doneSaid = true))
        // A step this build does not know is left out; nothing known is no card.
        assertEquals(SetupChecklist.Card.None, SetupChecklist.card(response(listOf(state("teleport"))), false, false))
        val card = SetupChecklist.card(
            response(listOf(state("profile", done = true), state("teleport"), state("calendar", blocked = SetupBlocker("Ask an admin", SetupBlockerBy.ADMIN))), next = "calendar"),
            false, false,
        ) as SetupChecklist.Card.Steps
        assertEquals(listOf(SetupStep.PROFILE, SetupStep.CALENDAR), card.rows.map { it.step })
        assertEquals(listOf(false, true), card.rows.map { it.isNext })
        assertFalse(card.rows[0].opens)
        assertFalse(card.rows[0].skippable)
        assertFalse(card.rows[1].opens)
        assertTrue(card.rows[1].skippable)
    }

    @Test
    fun destinations() {
        val origin = "https://hq.example/"
        assertEquals(SetupChecklist.Destination.Settings(SettingsPages.Page.ACCOUNT), SetupChecklist.destination(SetupStep.PROFILE, origin))
        assertEquals(SetupChecklist.Destination.Settings(SettingsPages.Page.ACCOUNT), SetupChecklist.destination(SetupStep.ASSISTANT, origin))
        assertEquals(SetupChecklist.Destination.Settings(SettingsPages.Page.CALENDAR), SetupChecklist.destination(SetupStep.CALENDAR, origin))
        assertEquals(SetupChecklist.Destination.Work, SetupChecklist.destination(SetupStep.PROJECT, origin))
        assertEquals(SetupChecklist.Destination.Room, SetupChecklist.destination(SetupStep.CALL, origin))
        assertEquals(SetupChecklist.Destination.Web("https://hq.example/admin/people"), SetupChecklist.destination(SetupStep.INVITE, origin))
        assertEquals(SetupChecklist.Destination.Web("https://site.example/download"), SetupChecklist.destination(SetupStep.APPS, origin))
        assertEquals("setup.doneSaid.https://hq.example|rosa@example.com", SetupChecklist.doneSaidKey("https://hq.example", "Rosa@Example.com"))
    }

    private fun event(id: String, start: Long?, end: Long?, title: String = "Standup", allDay: Boolean = false, declined: Boolean = false) =
        CalendarConflicts.Event(id, title, start, end, allDay, declined)

    @Test
    fun conflicts() {
        val hour = 3_600_000L
        val invite = event("i", 10 * hour, 11 * hour, "Invite")
        val among = listOf(
            event("a", 9 * hour, 10 * hour), // adjacent: no conflict
            event("b", 10 * hour + 1, 12 * hour, "Review"),
            event("c", 9 * hour, 13 * hour, "Offsite", allDay = true),
            event("d", 10 * hour, 11 * hour, "Declined", declined = true),
            event("e", 10 * hour, 11 * hour, "invite"), // the same event in a second calendar
            event("f", 9 * hour, 10 * hour + 30, ""),
        )
        val found = CalendarConflicts.conflicts(invite, among)
        assertEquals(listOf("f", "b"), found.map { it.id })
        assertEquals(null, found[0].title)
        assertEquals(emptyList<CalendarConflicts.Conflict>(), CalendarConflicts.conflicts(event("x", 10 * hour, 11 * hour, allDay = true), among))
    }

    @Test
    fun planNoticeIsTheTable() {
        val f = fixture("workspace-plans.json")
        val codes = f["errorCodes"]!!.jsonObject
        assertTrue(WorkspacePlanNotice.isProjectLimit(codes["projectLimit"]!!.jsonPrimitive.content))
        assertTrue(WorkspacePlanNotice.isProjectFrozen(codes["projectFrozen"]!!.jsonPrimitive.content))
        assertEquals(f["upgradeURL"]!!.jsonPrimitive.content, WorkspacePlanNotice.UPGRADE_URL)
        val xml = englishStrings
        f["words"]!!.jsonObject.values.forEach { assertTrue(xml.contains(">${it.jsonPrimitive.content}</string>")) }

        val free = WorkspacePlanResponse(WorkspacePlanResponsePlan.FREE, projectLimit = 1, keptProjectId = "p1", keptProjectPicked = true)
        assertFalse(WorkspacePlanNotice.isFrozen("p1", free))
        assertTrue(WorkspacePlanNotice.isFrozen("p2", free))
        assertFalse(WorkspacePlanNotice.isFrozen("p2", free.copy(projectLimit = null)))
        assertFalse(WorkspacePlanNotice.isFrozen("p2", free.copy(keptProjectId = null)))
        assertFalse(WorkspacePlanNotice.isFrozen("p2", null))

        val table = fixture("routes.json")["routes"]!!.jsonArray.map { it.jsonPrimitive.content }
        val route: Route<*> = WorkspacePlanNotice.route
        assertTrue(table.contains(route.signature))
    }
}
