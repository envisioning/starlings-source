package work.starlings.android.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.double
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.CalendarEventReply
import work.starlings.contracts.CalendarEventRespondRequest
import work.starlings.contracts.CalendarPreferencesUpdate
import work.starlings.contracts.CrmSubjectCountsQueryKind
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmTaskUpdate
import work.starlings.contracts.SubjectStateUpdate
import work.starlings.contracts.WorkPreferencesUpdate
import java.io.File
import java.time.Instant
import java.time.LocalDate

/**
 * Every ported route against `fixtures/routes.json`, the Worker's own route
 * table: a route the Worker does not answer fails here. And the request
 * policy against `fixtures/request-policy.json`, the table the Swift and
 * web clients read.
 */
class RouteFixtureTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    /** One of each route, with stand-in arguments. A new route belongs here too. */
    private val routes: List<Route<*>> = listOf(
        CalendarRoutes.status,
        CalendarRoutes.upcoming(36),
        CalendarRoutes.events(Instant.EPOCH, Instant.EPOCH),
        CalendarRoutes.subscriptionEvents(Instant.EPOCH, Instant.EPOCH),
        CalendarRoutes.invitations,
        CalendarRoutes.pending,
        CalendarRoutes.addPending("p1"),
        CalendarRoutes.discardPending("p1"),
        CalendarRoutes.workItems(LocalDate.EPOCH, LocalDate.EPOCH, includeDone = true),
        CalendarRoutes.availability(LocalDate.EPOCH, LocalDate.EPOCH),
        CalendarRoutes.preferences,
        CalendarRoutes.savePreferences(CalendarPreferencesUpdate()),
        CalendarRoutes.respond(CalendarEventRespondRequest("c", "e", CalendarEventReply.entries.first())),
        WorkRoutes.search("pilot", "Europe/Amsterdam"),
        WorkRoutes.mine,
        WorkRoutes.unowned,
        WorkRoutes.recentlyClosed,
        WorkRoutes.work("a@org.example"),
        WorkRoutes.board(null),
        WorkRoutes.team,
        WorkRoutes.tasks(projectId = "p1"),
        WorkRoutes.task("t1"),
        WorkRoutes.updateTask("t1", CrmTaskUpdate()),
        WorkRoutes.deleteTask("t1"),
        WorkRoutes.inbox,
        WorkRoutes.quickNotes,
        WorkRoutes.subjects(CrmSubjectKind.PROJECT, "", null),
        WorkRoutes.subjectCounts(CrmSubjectCountsQueryKind.LEAD, ""),
        WorkRoutes.subjectDetail(CrmSubjectKind.LEAD, "l1"),
        WorkRoutes.subjectState,
        WorkRoutes.setSubjectState(CrmSubjectKind.PROJECT, "p1", SubjectStateUpdate(starred = true)),
        WorkRoutes.setWorkPreferences(WorkPreferencesUpdate(salesEnabled = true), "Couldn’t save that"),
        WorkRoutes.starred,
        WorkRoutes.favorites,
        WorkRoutes.commercialSummary,
        TeamRoutes.peers,
        TeamRoutes.heartbeat("Europe/Amsterdam"),
        TeamRoutes.doNotDisturb(null),
        TeamRoutes.intent(null, null),
        TeamRoutes.threads,
        TeamRoutes.open("b@org.example"),
        TeamRoutes.open(listOf("b@org.example", "c@org.example")),
        TeamRoutes.openChannel,
        TeamRoutes.openSubject(CrmSubjectKind.PROJECT, "p1"),
        TeamRoutes.messages("th1", before = "m1", limit = 50),
        TeamRoutes.send("th1", "hello"),
        TeamRoutes.react("th1", "m1", "👍"),
        TeamRoutes.edit("th1", "m1", "hello"),
        TeamRoutes.withdraw("th1", "m1"),
        TeamRoutes.mute("th1", null),
        TeamRoutes.archive("th1", true),
        TeamRoutes.markRead("th1"),
        DocsRoutes.search("pilot"),
        DocsRoutes.documents(listOf("source" to "native")),
        DocsRoutes.document("d1"),
        DocsRoutes.summary,
        DocsRoutes.tree,
        DocsRoutes.categories,
        DocsRoutes.resolveComment("a1"),
        SettingsRoutes.homeLayout,
        SettingsRoutes.setHomeLayout(emptyList()),
        SettingsRoutes.ownerRoom,
        SettingsRoutes.setup,
        SettingsRoutes.language,
        SettingsRoutes.setLanguage(null),
        SettingsRoutes.devices,
        SettingsRoutes.revokeDevice("device-1"),
        CoreRoutes.token("Pixel"),
    )

    @Test
    fun everyRouteIsOneTheWorkerAnswers() {
        val table = fixture("routes.json")["routes"]!!.jsonArray.map { it.jsonPrimitive.content }
        val patterns = table.map { line ->
            val (method, path) = line.split(' ', limit = 2)
            method to path.trim('/').split('/')
        }
        val unanswered = routes.filterNot { route ->
            val segments = listOf("api") + route.path
            patterns.any { (method, pattern) ->
                (method == "*" || method == route.method) && pattern.size == segments.size &&
                    pattern.zip(segments).all { (p, s) -> p == "{}" || p == s }
            }
        }.map { it.signature }
        assertEquals("routes the Worker does not answer", emptyList<String>(), unanswered)
    }

    @Test
    fun readsNameTheirSnapshotRow() {
        // A snapshot key always belongs to a row of the table, whoever keeps it.
        for (route in routes) {
            val key = route.snapshotKey ?: continue
            assertTrue("${route.signature} keys $key", RequestPolicy.snapshots.any { RequestPolicy.matches(key, listOf(it.key)) })
            assertEquals("${route.signature} is a read", "GET", route.method)
        }
    }

    @Test
    fun policyIsTheFixture() {
        val policy = fixture("request-policy.json")
        assertEquals(policy["timeoutSeconds"]!!.jsonPrimitive.double, RequestPolicy.TIMEOUT_SECONDS, 0.0)

        val retry = policy["retry"]!!.jsonObject
        assertEquals(retry["methods"]!!.jsonArray.map { it.jsonPrimitive.content }, RequestPolicy.retry.methods)
        assertEquals(retry["extraAttempts"]!!.jsonPrimitive.int, RequestPolicy.retry.extraAttempts)
        assertEquals(retry["delaySeconds"]!!.jsonPrimitive.double, RequestPolicy.retry.delaySeconds, 0.0)
        assertEquals(retry["statusFloor"]!!.jsonPrimitive.int, RequestPolicy.retry.statusFloor)
        assertEquals(retry["statuses"]!!.jsonArray.map { it.jsonPrimitive.int }, RequestPolicy.retry.statuses)

        val rows = policy["snapshots"]!!.jsonArray.map { it.jsonObject }
        assertEquals(rows.map { it["name"]!!.jsonPrimitive.content }, RequestPolicy.snapshots.map { it.name })
        for ((row, rule) in rows.zip(RequestPolicy.snapshots)) {
            assertEquals(row["key"]!!.jsonPrimitive.content, rule.key)
            assertEquals(row["read"]!!.jsonPrimitive.content, rule.read)
            assertEquals(rule.name, row["clients"]!!.jsonArray.map { it.jsonPrimitive.content }, rule.clients.map { it.wire })
            assertEquals(rule.name, row["invalidatedBy"]!!.jsonArray.map { it.jsonPrimitive.content }, rule.invalidatedBy.map { it.wire })
        }

        val writes = policy["writes"]!!.jsonObject
        assertEquals(writes.keys.toList(), SnapshotWrite.entries.map { it.wire })
        for (write in SnapshotWrite.entries) {
            assertEquals(write.wire, writes[write.wire]!!.jsonArray.map { it.jsonPrimitive.content }, RequestPolicy.invalidated(write))
        }
    }

    @Test
    fun androidKeepsWhatIosKeeps() {
        for (rule in RequestPolicy.snapshots) {
            for (key in listOf(rule.key, "${rule.key}?kind=project", "${rule.key}/lead/l1")) {
                assertEquals(key, RequestPolicy.keeps(key, RequestPolicy.Client.IOS), RequestPolicy.keeps(key, RequestPolicy.Client.ANDROID))
            }
        }
        assertTrue(RequestPolicy.keeps(SnapshotKey.PEERS, RequestPolicy.Client.ANDROID))
        assertTrue(RequestPolicy.keeps(SnapshotKey.tasks("p1", null), RequestPolicy.Client.ANDROID))
        assertFalse("the Mac and the web keep upcoming; the phones read it live", RequestPolicy.keeps(SnapshotKey.CALENDAR_UPCOMING, RequestPolicy.Client.ANDROID))
        assertFalse("crm/subject-counts is not under crm/subjects", RequestPolicy.matches(SnapshotKey.SUBJECT_COUNTS, listOf(SnapshotKey.SUBJECTS)))
    }

    @Test
    fun queriesFollowSwift() {
        assertEquals("crm/subjects?kind=lead&q=acme&status=open", SnapshotKey.subjects("lead", "acme", "open"))
        assertEquals("crm/tasks?project_id=p1&lead_id=&event_id=&organization_id=", SnapshotKey.tasks("p1", null))
        assertEquals(listOf("kind" to "event", "q" to "x", "status" to "open", "today" to "2026-10-28"),
            WorkRoutes.subjects(CrmSubjectKind.EVENT, " x ", " open ", LocalDate.of(2026, 10, 28)).query)
        assertEquals("an organization has no status", listOf("kind" to "organization"),
            WorkRoutes.subjects(CrmSubjectKind.ORGANIZATION, "", "open").query)
        assertEquals(listOf("time_min" to "1970-01-01T00:00:00.000Z", "time_max" to "1970-01-01T00:00:01.500Z"),
            CalendarRoutes.events(Instant.EPOCH, Instant.ofEpochMilli(1_500)).query)
        assertEquals("""{"text":"hello"}""", TeamRoutes.send("th1", "hello").body)
        assertEquals("""{"until":null}""", TeamRoutes.mute("th1", null).body)
    }
}
