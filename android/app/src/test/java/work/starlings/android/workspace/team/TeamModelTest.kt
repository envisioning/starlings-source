package work.starlings.android.workspace.team

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.api.Route
import work.starlings.android.api.TeamExtraRoutes
import work.starlings.contracts.PeerIntent
import work.starlings.contracts.PeerKindValue
import work.starlings.contracts.PeerStatusValue
import work.starlings.contracts.PeerWire
import work.starlings.contracts.PeerWorkingHours
import work.starlings.contracts.ThreadMessageType
import work.starlings.contracts.ThreadMessageWire
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime

/**
 * Team's rules: the rail order and strays (fixtures/team-rail.json), the
 * rail blocks (fixtures/rail-blocks.json), the thread cadences
 * (fixtures/shared-constants.json), the extra routes (fixtures/routes.json),
 * and the presence and transcript rules ported from Swift.
 */
class TeamModelTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private fun direct(o: JsonObject) = TeamRailRules.Direct(
        o["kind"]!!.jsonPrimitive.content,
        o["isGroup"]!!.jsonPrimitive.boolean,
        o["peerEmail"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content,
        o["lastMessageAt"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.double,
    )

    @Test
    fun railOrderIsTheFixture() {
        val f = fixture("team-rail.json")
        assertEquals(f["directKind"]!!.jsonPrimitive.content, TeamRailRules.DIRECT_KIND)
        for (case in f["order"]!!.jsonArray.map { it.jsonObject }) {
            val name = case["name"]!!.jsonPrimitive.content
            val emails = case["emails"]!!.jsonArray.map { it.jsonPrimitive.content }
            val directs = case["directs"]!!.jsonArray.map { direct(it.jsonObject) }
            assertEquals(name, case["out"]!!.jsonArray.map { it.jsonPrimitive.content }, TeamRailRules.order(emails, directs))
        }
        for (case in f["stray"]!!.jsonArray.map { it.jsonObject }) {
            val name = case["name"]!!.jsonPrimitive.content
            val roster = case["roster"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet()
            val self = case["selfEmail"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
            assertEquals(name, case["out"]!!.jsonPrimitive.boolean, TeamRailRules.isStray(direct(case["direct"]!!.jsonObject), roster, self))
        }
    }

    @Test
    fun railBlocksAreTheTable() {
        val rows = fixture("rail-blocks.json")["blocks"]!!.jsonObject["team"]!!.jsonArray.map { it.jsonObject }
        assertEquals(rows.map { it["id"]!!.jsonPrimitive.content }, TeamBlock.entries.map { it.id })
        assertEquals(rows.map { it["key"]!!.jsonPrimitive.content }, TeamBlock.entries.map { it.key })
        assertEquals(rows.map { it["hidesWhenEmpty"]!!.jsonPrimitive.boolean }, TeamBlock.entries.map { it.hidesWhenEmpty })
        assertEquals("meet.sidebarFold.team.you", TeamBlock.YOU.foldKey)
        assertEquals(listOf(TeamBlock.GROUPS, TeamBlock.AGENTS), TeamBlock.visible(setOf(TeamBlock.YOU, TeamBlock.PEOPLE)))
    }

    @Test
    fun cadencesAreTheContract() {
        val numbers = fixture("shared-constants.json")["numbers"]!!.jsonObject
        assertEquals(numbers["threadGroupingWindowMs"]!!.jsonPrimitive.long, ThreadTranscript.GROUPING_WINDOW_MS)
        assertEquals(numbers["agentTurnPollSeconds"]!!.jsonPrimitive.long * 1000, TeamCadence.AGENT_TURN_POLL_MS)
        assertEquals(numbers["threadBackgroundPollSeconds"]!!.jsonPrimitive.long * 1000, TeamCadence.BACKGROUND_THREAD_POLL_MS)
    }

    @Test
    fun extraRoutesAreOnesTheWorkerAnswers() {
        val table = fixture("routes.json")["routes"]!!.jsonArray.map { it.jsonPrimitive.content }.map { line ->
            val (method, path) = line.split(' ', limit = 2)
            method to path.trim('/').split('/')
        }
        val routes: List<Route<*>> = listOf(
            TeamExtraRoutes.ring("b@org.example"),
            TeamExtraRoutes.call("b@org.example"),
            TeamExtraRoutes.clearRing,
            TeamExtraRoutes.appearOffline(true),
        )
        val unanswered = routes.filterNot { route ->
            val segments = listOf("api") + route.path
            table.any { (method, pattern) ->
                (method == "*" || method == route.method) && pattern.size == segments.size &&
                    pattern.zip(segments).all { (p, s) -> p == "{}" || p == s }
            }
        }.map { it.signature }
        assertEquals(emptyList<String>(), unanswered)
        assertEquals("""{"peer_email":"b@org.example"}""", TeamExtraRoutes.ring("b@org.example").body)
        assertEquals("""{"invisible":true}""", TeamExtraRoutes.appearOffline(true).body)
    }

    private fun peer(
        email: String,
        status: String = "available",
        kind: PeerKindValue = PeerKindValue.HUMAN,
        roomSlug: String? = "room",
        inRoomSlug: String? = null,
        intent: PeerIntent? = null,
        intentUntil: Long? = null,
        invisible: Boolean = false,
        isSelf: Boolean = false,
        name: String? = null,
        participants: Long = 0,
        busyUntil: Long? = null,
    ) = PeerWire(
        email = email, name = name, kind = kind, roomSlug = roomSlug, inRoomSlug = inRoomSlug, status = PeerStatusValue(status),
        lastSeenAt = 1_000, clients = emptyList(), intent = intent, intentUntil = intentUntil, invisible = invisible,
        participants = participants, isSelf = isSelf, busyUntil = busyUntil,
    )

    @Test
    fun displayStateFollowsTheLadder() {
        assertEquals(PeerDisplay.Intent(PeerIntent.FOCUSED), peer("a@x", "busy", intent = PeerIntent.FOCUSED).displayState)
        assertEquals(PeerDisplay.Status(PeerStatus.IN_MEETING), peer("a@x", "in_meeting", intent = PeerIntent.FOCUSED).displayState)
        assertEquals(PeerDisplay.Status(PeerStatus.OFFLINE), peer("a@x", "available", invisible = true).displayState)
        assertEquals("an unknown status reads offline", PeerStatus.OFFLINE, peer("a@x", "napping").presence)
        assertEquals("an unknown intent reads as none", PeerDisplay.Status(PeerStatus.AVAILABLE), peer("a@x", intent = PeerIntent("snoozing")).displayState)
        assertEquals(PeerStatus.BUSY, PeerDisplay.Intent(PeerIntent.FOCUSED).dot)
    }

    @Test
    fun callPlanEndsSomewhere() {
        assertEquals(CallPlan.Unavailable(CallRefusal.SELF), peer("a@x", isSelf = true).callPlan)
        assertEquals(CallPlan.Unavailable(CallRefusal.AGENT), peer("a@x", kind = PeerKindValue.AGENT).callPlan)
        assertEquals(CallPlan.Join("theirs"), peer("a@x", "in_meeting", inRoomSlug = "theirs").callPlan)
        assertEquals(CallPlan.Join("room"), peer("a@x", "in_meeting").callPlan)
        assertEquals(CallPlan.Unavailable(CallRefusal.NO_ROOM), peer("a@x", roomSlug = null).callPlan)
        assertEquals(CallPlan.Unavailable(CallRefusal.NOT_REACHABLE), peer("a@x", "active").callPlan)
        assertEquals(CallPlan.Ask("room"), peer("a@x").callPlan)
        assertFalse(peer("a@x", "dnd").isRingable)
        assertTrue(peer("a@x", "active").isRingable)
    }

    @Test
    fun lineSaysTheWinner() {
        assertEquals(PeerLine.FocusedUntil(5), peer("a@x", "busy", intent = PeerIntent.FOCUSED, intentUntil = 5).line())
        assertEquals(PeerLine.InMeeting(3, emptyList()), peer("a@x", "in_meeting", participants = 3).line())
        assertEquals(PeerLine.Busy(9, emptyList()), peer("a@x", "busy", busyUntil = 9).line())
        assertEquals(PeerLine.Available("room", emptyList()), peer("a@x").line())
        assertEquals(PeerLine.Offline(1_000), peer("a@x", "offline").line())
        assertEquals(PeerLine.Agent(true), peer("a@x", "busy", kind = PeerKindValue.AGENT).line())
        assertEquals(PeerLine.Offline(null), peer("a@x", "available").withoutPresence().line())
    }

    @Test
    fun statusOptionsResolveToTheEndOfToday() {
        val now = ZonedDateTime.of(2026, 10, 28, 9, 0, 0, 0, ZoneOffset.UTC)
        val end = ZonedDateTime.of(2026, 10, 28, 23, 59, 59, 0, ZoneOffset.UTC).toInstant()
        assertEquals(PeerStatusOption.Resolved(PeerIntent.FOCUSED, end, null, true), PeerStatusOption.FOCUSED.resolve(now))
        assertEquals(PeerStatusOption.Resolved(null, null, end, true), PeerStatusOption.UNAVAILABLE.resolve(now))
        assertEquals(PeerStatusOption.Resolved(null, null, null, false), PeerStatusOption.OFFLINE.resolve(now))
        assertEquals(PeerStatusOption.OFFLINE, PeerStatusOption.selected(peer("a@x", "dnd", invisible = true)))
        assertEquals(PeerStatusOption.UNAVAILABLE, PeerStatusOption.selected(peer("a@x", "dnd")))
        assertEquals(PeerStatusOption.FOCUSED, PeerStatusOption.selected(peer("a@x", intent = PeerIntent.FOCUSED)))
    }

    @Test
    fun workingHoursCrossMidnight() {
        val nights = PeerWorkingHours(startMinute = 22 * 60, endMinute = 6 * 60, days = 0b1111111)
        assertTrue(nights.contains(23 * 60, 3))
        assertTrue(nights.contains(60, 3))
        assertFalse(nights.contains(12 * 60, 3))
        val weekdays = PeerWorkingHours(startMinute = 9 * 60, endMinute = 17 * 60, days = 0b0011111)
        assertTrue(weekdays.contains(10 * 60, 1))
        assertFalse("Sunday is bit 6", weekdays.contains(10 * 60, 7))
    }

    @Test
    fun groupsAreAddressedInEmailOrder() {
        val address = ThreadAddress.group(listOf(peer("c@x", name = "Cy Doe"), peer("a@x", name = "Ana Silva")))
        assertEquals("group:a@x,c@x", address.id)
        assertEquals(ThreadAddress.Naming.OfGroup("Ana, Cy", 3), address.naming)
        assertEquals("peer:b@x", ThreadAddress.peer(peer("b@x")).id)
        assertNull(ThreadAddress.team.peerEmail)
    }

    private fun message(id: String, at: Long, from: String = "a@x", mine: Boolean = false, event: Boolean = false, via: String? = null, deleted: Long? = null) =
        ThreadMessageWire(
            id = id, threadId = "t", sentAt = at, senderEmail = from, text = id, isMine = mine,
            type = if (event) ThreadMessageType.EVENT else ThreadMessageType.TEXT, via = via, deletedAt = deleted,
        )

    @Test
    fun transcriptGroupsTurnsAndMarksWhereYouLeftOff() {
        val zone = ZoneId.of("UTC")
        val day = 1_800_000_000_000L
        val rows = ThreadTranscript.rows(
            listOf(
                message("1", day),
                message("2", day + 60_000),
                message("3", day + 60_000 + ThreadTranscript.GROUPING_WINDOW_MS + 1),
                message("4", day + 700_000, from = "bot@x", event = true),
                message("5", day + 701_000, from = "bot@x", event = true),
                message("6", day + 702_000, via = "claude.ai"),
            ),
            unreadBoundaryMs = day + 30_000,
            agentEmails = setOf("bot@x"),
            zone = zone,
        )
        val date = java.time.Instant.ofEpochMilli(day).atZone(zone).toLocalDate()
        assertEquals(TranscriptRow.Day(date), rows[0])
        assertEquals(TranscriptRow.Message(message("1", day), false), rows[1])
        assertEquals(TranscriptRow.UnreadMark, rows[2])
        assertEquals("the mark breaks the turn", false, (rows[3] as TranscriptRow.Message).grouped)
        assertEquals("past the window is a new turn", false, (rows[4] as TranscriptRow.Message).grouped)
        assertEquals(2, (rows[5] as TranscriptRow.Trail).steps.size)
        assertEquals("another hand is a new turn", false, (rows[6] as TranscriptRow.Message).grouped)
        assertEquals(7, rows.size)
    }

    @Test
    fun ownLinesNeverCarryTheMarkAndMergeKeepsOrder() {
        val rows = ThreadTranscript.rows(listOf(message("1", 10, mine = true), message("2", 20)), unreadBoundaryMs = 5)
        assertEquals(TranscriptRow.UnreadMark, rows[2])
        val merged = ThreadTranscript.merge(listOf(message("b", 20), message("a", 10)), listOf(message("a", 10), message("c", 20)))
        assertEquals(listOf("a", "b", "c"), merged.map { it.id })
        assertEquals("0:07", ThreadTranscript.elapsedLabel(0, 7_000))
        assertEquals("12:05", ThreadTranscript.elapsedLabel(0, 725_000))
    }

    @Test
    fun dayLabels() {
        val today = LocalDate.of(2026, 10, 28)
        assertEquals(DayLabel.Today, ThreadTranscript.dayLabel(today, today))
        assertEquals(DayLabel.Yesterday, ThreadTranscript.dayLabel(today.minusDays(1), today))
        assertEquals(DayLabel.Weekday(today.minusDays(5)), ThreadTranscript.dayLabel(today.minusDays(5), today))
        assertEquals(DayLabel.Date(today.minusDays(6)), ThreadTranscript.dayLabel(today.minusDays(6), today))
    }

    @Test
    fun agentTurn() {
        val bot = peer("bot@x", "busy", kind = PeerKindValue.AGENT, busyUntil = 10_000)
        val mine = listOf(message("1", 1_000, mine = true))
        assertEquals(bot, AgentTurn.addressedAgent("bot@x", mine, listOf(bot)))
        assertTrue(AgentTurn.awaiting(bot, mine))
        assertTrue(AgentTurn.showsWorkingRow(bot, mine, 5_000))
        assertFalse("an elapsed busy and no grace", AgentTurn.showsWorkingRow(bot, mine, 30_000))
        val answered = mine + message("2", 2_000, from = "bot@x")
        assertFalse(AgentTurn.awaiting(bot, answered))
        assertEquals("2", AgentTurn.persistentReactionMessageId("bot@x", answered, listOf(bot)))
        assertEquals(listOf("👍"), ThreadTranscript.quickReactions(fromAgent = true))
    }
}
