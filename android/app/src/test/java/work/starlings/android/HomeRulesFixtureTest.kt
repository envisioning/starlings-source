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
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.ZoneId

/** Upcoming, the meeting warning and Home's layout, against the shared fixtures. */
class HomeRulesFixtureTest {
    private fun read(property: String, name: String): JsonObject {
        val dir = System.getProperty(property) ?: error("$property is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private fun fixture(name: String) = read("starlings.fixtures", name)
    private val JsonElement.string get() = jsonPrimitive.content
    private fun JsonElement?.strings(): List<String>? = (this as? JsonArray)?.map { it.string }
    private fun JsonElement.stringOrNull(): String? = if (this is JsonNull) null else jsonPrimitive.content

    @Test
    fun upcomingConfig() {
        val c = read("starlings.contracts", "upcoming-config.json")
        assertEquals(c["version"]!!.jsonPrimitive.int, UpcomingConfig.VERSION)
        assertEquals(c["sectionTitle"]!!.string, UpcomingConfig.SECTION_TITLE)
        assertEquals(c["horizonDays"]!!.jsonPrimitive.int, UpcomingConfig.HORIZON_DAYS)
        assertEquals(c["requestSlackDays"]!!.jsonPrimitive.int, UpcomingConfig.REQUEST_SLACK_DAYS)
        assertEquals(c["homeFollowingRows"]!!.jsonPrimitive.int, UpcomingConfig.HOME_FOLLOWING_ROWS)
        assertEquals(c["joinWindowMinutes"]!!.jsonPrimitive.int, UpcomingConfig.JOIN_WINDOW_MINUTES)
        assertEquals(c["showTomorrow"]!!.jsonPrimitive.boolean, UpcomingConfig.SHOW_TOMORROW)
        assertEquals(c["maxAgendaEvents"]!!.jsonPrimitive.int, UpcomingConfig.MAX_AGENDA_EVENTS)
        assertEquals(c["placeholderTitles"].strings(), UpcomingConfig.placeholderTitles)
    }

    private fun event(e: JsonObject) = UpcomingEvent(
        id = e["id"]!!.string,
        title = e["title"]!!.string,
        start = e["start"]?.stringOrNull(),
        end = e["end"]?.stringOrNull(),
        allDay = e["allDay"]!!.jsonPrimitive.boolean,
        demoted = e["demoted"]!!.jsonPrimitive.boolean,
        calendarId = e["calendarId"]?.stringOrNull(),
        attendees = (e["attendees"] as? JsonArray)?.map {
            UpcomingAttendee(it.jsonObject["status"]!!.string, it.jsonObject["self"]!!.jsonPrimitive.boolean)
        },
    )

    @Test
    fun upcomingTiers() {
        val table = fixture("upcoming-tiers.json")
        assertEquals(1, table["version"]!!.jsonPrimitive.int)
        table["cases"]!!.jsonArray.forEach { raw ->
            val c = raw.jsonObject
            val name = c["name"]!!.string
            val now = Upcoming.parse(c["now"]!!.string)!!
            val events = c["events"]!!.jsonArray.map { event(it.jsonObject) }
            val plan = Upcoming.classify(events, now, ZoneId.of(c["timeZone"]!!.string))
            val expect = c["expect"]!!.jsonObject

            assertEquals("agenda: $name", expect["agenda"].strings(), plan.agenda.map { it.id })
            assertEquals("tiers: $name", expect["tiers"]!!.jsonObject.mapValues { it.value.string }, plan.tiers.mapValues { it.value.wire })
            assertEquals("focus: $name", expect["focus"]!!.stringOrNull(), plan.focus?.id)
            val counts = UpcomingTier.entries.associate { it.wire to plan.count(it) } + ("agenda" to plan.agenda.size)
            assertEquals("counts: $name", expect["counts"]!!.jsonObject.mapValues { it.value.jsonPrimitive.int }, counts)
            (expect["canJoin"] as? JsonObject)?.forEach { (id, want) ->
                assertEquals("canJoin $id: $name", want.jsonPrimitive.boolean, Upcoming.canJoin(events.first { it.id == id }, now))
            }

            // The rules the table cannot state: the hero is always today's, and tiers partition the agenda.
            plan.focus?.let { f ->
                assertTrue(name, plan.tiers[f.id] == UpcomingTier.NOW || plan.tiers[f.id] == UpcomingTier.TODAY)
                assertTrue(name, !f.demoted && !f.allDay)
            }
            assertEquals(name, plan.agenda.map { it.id }.toSet(), plan.tiered.values.flatten().map { it.id }.toSet())
            assertEquals(name, plan.agenda.size, plan.tiered.values.sumOf { it.size })
        }
    }

    @Test
    fun closedDaySummary() {
        val utc = ZoneId.of("UTC")
        val later = UpcomingEvent("next-week", "Planning", "2026-08-25T09:00:00Z", "2026-08-25T10:00:00Z", false, false)
        val tomorrow = UpcomingEvent("t", "Standup", "2026-08-20T09:00:00Z", "2026-08-20T09:15:00Z", false, false)
        val now = Upcoming.parse("2026-08-19T19:00:00Z")!!
        assertEquals(ClosedDay.Empty, Upcoming.closedDay(Upcoming.classify(listOf(later), now, utc), utc))
        assertEquals(ClosedDay.Tomorrow(1, "09:00"), Upcoming.closedDay(Upcoming.classify(listOf(tomorrow, later), now, utc), utc))
    }

    @Test
    fun meetingAlerts() {
        val table = fixture("meeting-alerts.json")
        assertEquals(1, table["version"]!!.jsonPrimitive.int)
        val now = 1_800_000_000_000L
        fun iso(ms: Long) = java.time.Instant.ofEpochMilli(ms).toString()
        table["cases"]!!.jsonArray.forEach { raw ->
            val c = raw.jsonObject
            val name = c["name"]!!.string
            val meetings = when (val m = c["meetings"]!!) {
                is JsonArray -> m.map { row ->
                    val r = row.jsonObject
                    val start = now + r["startsIn"]!!.jsonPrimitive.long * 1000
                    UpcomingEvent(
                        r["id"]!!.string, r["id"]!!.string, iso(start), iso(start + r["minutes"]!!.jsonPrimitive.long * 60_000),
                        allDay = r["allDay"]?.jsonPrimitive?.booleanOrNull ?: false,
                        demoted = r["demoted"]?.jsonPrimitive?.booleanOrNull ?: false,
                    )
                }
                else -> {
                    val g = m.jsonObject
                    (0 until g["count"]!!.jsonPrimitive.int).map { i ->
                        val start = now + (i + 1) * g["everyMinutes"]!!.jsonPrimitive.long * 60_000
                        UpcomingEvent("e$i", "Sync $i", iso(start), iso(start + g["minutes"]!!.jsonPrimitive.long * 60_000), false, false)
                    }
                }
            }
            val planned = MeetingAlertPlan.plan(meetings, now, c["lead"]!!.jsonPrimitive.long * 60_000)
            (c["expect"] as? JsonArray)?.let { expect ->
                assertEquals(name, expect.map { it.jsonObject["id"]!!.string }, planned.map { it.eventId })
                expect.zip(planned).forEach { (e, p) ->
                    assertEquals(name, now + e.jsonObject["firesIn"]!!.jsonPrimitive.long * 1000, p.fireAt)
                }
            }
            c["expectCount"]?.let { assertEquals(name, it.jsonPrimitive.int, planned.size) }
            c["expectFirst"]?.let { assertEquals(name, it.string, planned.first().eventId) }
        }
    }

    private val home by lazy { fixture("home-layout.json") }
    private fun settings(e: JsonElement?): List<HomeModuleSetting>? = (e as? JsonArray)?.map {
        HomeModuleSetting(it.jsonObject["id"]!!.string, it.jsonObject["enabled"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun homeModules() {
        assertEquals(1, home["version"]!!.jsonPrimitive.int)
        val modules = home["modules"]!!.jsonArray.map {
            val m = it.jsonObject
            HomeModule(
                m["id"]!!.string, m["title"]!!.string, m["detail"]!!.string,
                m["enabledByDefault"]!!.jsonPrimitive.boolean, m["rows"]!!.jsonPrimitive.intOrNull,
                m["canHide"]!!.jsonPrimitive.boolean, m["showsEmpty"]!!.jsonPrimitive.boolean,
            )
        }
        assertEquals(modules, HomeLayout.modules)
        assertEquals(home["workModules"]!!.jsonObject.mapValues { it.value.strings() }, HomeLayout.workModules)
    }

    @Test
    fun homeResolve() {
        home["cases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            assertEquals(c["name"]!!.string, settings(c["expect"]), HomeLayout.resolve(settings(c["stored"])))
        }
    }

    @Test
    fun homeVisibleOfferedShow() {
        home["visibleCases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            assertEquals(c["name"]!!.string, c["expect"].strings(), HomeLayout.visible(HomeLayout.defaults, c["workModules"].strings()))
        }
        home["offeredCases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            val layout = HomeLayout.resolve(settings(c["stored"]))
            assertEquals(c["name"]!!.string, c["expect"].strings(), HomeLayout.offered(layout, c["workModules"].strings()).map { r -> r.id })
        }
        home["showCases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            val content = c["content"].strings()!!.toSet()
            val drawn = HomeLayout.visible(HomeLayout.defaults, null).filter { id -> HomeLayout.draws(id, id in content) }
            assertEquals(c["name"]!!.string, c["expect"].strings(), drawn)
        }
    }

    @Test
    fun homeMove() {
        home["moveCases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            val layout = HomeLayout.resolve(settings(c["layout"]))
            val moved = HomeLayout.move(layout, c["id"]!!.string, c["direction"]!!.string == "up", c["workModules"].strings())
            assertEquals(c["name"]!!.string, c["expect"].strings(), moved.map { r -> r.id })
        }
    }

    @Test
    fun homeColumns() {
        fun heights(e: JsonElement) = e.jsonObject.mapValues { it.value.jsonPrimitive.double }
        home["packCases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            val modules = c["modules"].strings()!!
            val packed = HomeLayout.packColumns(modules, heights(c["heights"]!!), c["gap"]!!.jsonPrimitive.double)
            assertEquals(c["name"]!!.string, c["expectRight"].strings(), modules.filter { m -> packed[m] == true })
        }
        home["lopsidedCases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            val h = heights(c["heights"]!!)
            val assignment = c["left"].strings()!!.associateWith { false } + c["right"].strings()!!.associateWith { true }
            assertEquals(c["name"]!!.string, c["expect"]!!.jsonPrimitive.boolean, HomeLayout.columnsLopsided(h.keys.toList(), h, assignment, c["gap"]!!.jsonPrimitive.double))
        }
    }

    @Test
    fun homeLists() {
        home["recentMergeCases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            fun keys(e: JsonElement?) = e!!.jsonArray.map { r -> "${r.jsonObject["kind"]!!.string}:${r.jsonObject["id"]!!.string}" }
            assertEquals(c["name"]!!.string, keys(c["expect"]), HomeLayout.mergeRecent(keys(c["recent"]), keys(c["starred"])) { k -> k })
        }
        home["inboxOrderCases"]!!.jsonArray.forEach {
            val c = it.jsonObject
            val rows = c["rows"]!!.jsonArray.map { r -> r.jsonObject }
            val ordered = HomeLayout.orderInbox(rows, { r -> r["pinned"]!!.jsonPrimitive.boolean }, { r -> r["at"]!!.jsonPrimitive.double })
            assertEquals(c["name"]!!.string, c["expect"].strings(), ordered.map { r -> r["id"]!!.string })
        }
    }
}
