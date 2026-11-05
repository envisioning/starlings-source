package work.starlings.android

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.float
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.time.ZoneId

/** Calendar tiles, keys, meeting kinds and values, against the shared fixtures. */
class CalendarFixtureTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }
    private val JsonElement.s get() = jsonPrimitive.content
    private fun JsonElement.orNull(): String? = if (this is JsonNull) null else jsonPrimitive.content
    private fun JsonElement?.list() = this!!.jsonArray.map { it.s }
    private fun JsonObject.each(key: String, block: (JsonObject) -> Unit) = this[key]!!.jsonArray.forEach { block(it.jsonObject) }

    @Test
    fun tile() {
        val f = fixture("calendar-tile.json")
        assertEquals(1, f["version"]!!.jsonPrimitive.int)
        f.each("timeLabels") { c ->
            val label = CalendarTile.timeLabel(
                Upcoming.parse(c["start"]!!.s)!!, Upcoming.parse(c["end"]!!.s)!!,
                c["originZone"]!!.orNull(), ZoneId.of(c["viewerZone"]!!.s),
            )
            assertEquals(c["name"]!!.s, c["expect"]!!.s, label)
        }
        f.each("rows") { c ->
            val rows = CalendarTile.rows(
                c["height"]!!.jsonPrimitive.float, c["titleHeight"]!!.jsonPrimitive.float,
                c["rowHeight"]!!.jsonPrimitive.float, c["padding"]!!.jsonPrimitive.float, c["hasLocation"]!!.jsonPrimitive.boolean,
            )
            val e = c["expect"]!!.jsonObject
            assertEquals(c["name"]!!.s, CalendarTile.Rows(e["time"]!!.jsonPrimitive.boolean, e["location"]!!.jsonPrimitive.boolean), rows)
        }
        f.each("places") { c ->
            assertEquals(c["name"]!!.s, c["expect"]!!.orNull(), CalendarTile.place(c["location"]!!.s, c["platform"]!!.s))
        }
    }

    @Test
    fun keys() {
        val f = fixture("calendar-keys.json")
        assertEquals(f["subscribedAccountKey"]!!.s, CalendarKeys.SUBSCRIBED_ACCOUNT)
        val formats = f["formats"]!!.jsonObject.mapValues { it.value.s }
        assertEquals(
            formats,
            mapOf(
                "googlePrefix" to CalendarKeys.GOOGLE_PREFIX, "subscriptionPrefix" to CalendarKeys.SUBSCRIPTION_PREFIX,
                "eventKitPrefix" to CalendarKeys.EVENT_KIT_PREFIX, "eventKitSeparator" to CalendarKeys.EVENT_KIT_SEPARATOR,
                "accountPrefix" to CalendarKeys.ACCOUNT_PREFIX, "eventPrefix" to CalendarKeys.EVENT_PREFIX,
                "googleEventPrefix" to CalendarKeys.GOOGLE_EVENT_PREFIX,
            ),
        )
        f.each("google") { assertEquals(it["out"]!!.s, CalendarKeys.google(it["id"]!!.s)) }
        f.each("subscription") { assertEquals(it["out"]!!.s, CalendarKeys.subscription(it["id"]!!.s)) }
        f.each("eventKit") { assertEquals(it["out"]!!.s, CalendarKeys.eventKit(it["account"]!!.s, it["title"]!!.s)) }
        f.each("account") { assertEquals(it["out"]!!.s, CalendarKeys.account(it["title"]!!.s)) }
        f.each("accountTitle") {
            assertEquals(it["out"]!!.s, CalendarKeys.googleAccountTitle(it["email"]!!.orNull(), it["namesAccounts"]!!.jsonPrimitive.boolean))
        }
        f.each("demotion") {
            assertEquals(it["out"]!!.s, CalendarKeys.eventDemotion(it["isSubscription"]!!.jsonPrimitive.boolean, it["eventId"]!!.s))
        }
        f.each("hide") { c ->
            val cal = c["calendar"]!!.jsonObject
            val out = CalendarKeys.withCalendarHidden(
                c["keys"].list(), cal["key"]!!.s, cal["accountKey"]!!.s, cal["siblingKeys"].list(), c["hidden"]!!.jsonPrimitive.boolean,
            )
            assertEquals(c["name"]!!.s, c["out"].list(), out)
        }
        f.each("hideAccount") { c ->
            val acc = c["account"]!!.jsonObject
            val out = CalendarKeys.withAccountHidden(c["keys"].list(), acc["key"]!!.s, acc["memberKeys"].list(), c["hidden"]!!.jsonPrimitive.boolean)
            assertEquals(c["name"]!!.s, c["out"].list(), out)
        }
    }

    @Test
    fun meetingKinds() {
        val kinds = fixture("meeting-kinds.json")["kinds"]!!.jsonArray.map {
            val k = it.jsonObject
            MeetingKinds.Kind(k["kind"]!!.s, k["label"]!!.s, k["subject"]!!.orNull())
        }
        assertEquals(kinds, MeetingKinds.all)
    }

    @Test
    fun values() {
        val f = fixture("calendar-values.json")
        assertEquals(
            f["layers"]!!.jsonArray.map { val l = it.jsonObject; CalendarValues.Layer(l["kind"]!!.s, l["title"]!!.s, l["caption"]!!.s) },
            CalendarValues.layers,
        )
        assertEquals(f["travelMinutes"]!!.jsonArray.map { it.jsonPrimitive.int }, CalendarValues.travelMinutes)
        assertEquals(
            f["rsvpAnswers"]!!.jsonArray.map { val r = it.jsonObject; CalendarValues.Rsvp(r["response"]!!.s, r["title"]!!.s) },
            CalendarValues.rsvpAnswers,
        )
        assertEquals(
            f["scheduleTimeZones"]!!.jsonArray.map {
                val z = it.jsonObject
                CalendarValues.ScheduleZone(z["id"]!!.s, z["zone"]!!.s, z["city"]!!.s, z["code"]!!.s)
            },
            CalendarValues.scheduleTimeZones,
        )
    }
}
