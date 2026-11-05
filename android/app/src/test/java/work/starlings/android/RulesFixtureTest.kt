package work.starlings.android

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** The Kotlin rules against the repository's `fixtures/`, as Swift and web are. */
class RulesFixtureTest {
    private fun fixture(name: String): JsonObject {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    @Test
    fun participantInitials() {
        fixture("participant-initials.json")["cases"]!!.jsonArray.forEach { case ->
            val c = case.jsonObject
            assertEquals(
                c["name"]!!.jsonPrimitive.content,
                c["out"]!!.jsonPrimitive.content,
                ParticipantInitials.make(c["in"]!!.jsonPrimitive.content),
            )
        }
    }

    @Test
    fun sharedConstants() {
        val f = fixture("shared-constants.json")
        val strings = f["strings"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(strings["captionDataTopic"], Contracts.CAPTION_TOPIC)
        assertEquals(strings["moderationDataTopic"], Contracts.MODERATION_TOPIC)
        assertEquals(strings["reactionDataTopic"], Contracts.REACTION_TOPIC)
        assertEquals(strings["chatReactionDataTopic"], Contracts.CHAT_REACTION_TOPIC)
        assertEquals(strings["reactionDataTopic"], Reactions.TOPIC)
        assertEquals(strings["publicWebOrigin"], BuildConfig.ORIGIN)
        assertEquals(
            f["lists"]!!.jsonObject["identityDomains"]!!.jsonArray.map { it.jsonPrimitive.content },
            Contracts.identityDomains,
        )
        assertEquals(
            f["numbers"]!!.jsonObject["liveTranscriptHistoryLines"]!!.jsonPrimitive.int,
            Contracts.LIVE_TRANSCRIPT_HISTORY_LINES,
        )
        assertEquals(
            f["numbers"]!!.jsonObject["workspaceMarkMaxBytes"]!!.jsonPrimitive.int,
            Contracts.WORKSPACE_MARK_MAX_BYTES,
        )
    }

    /** `CaptionMessage.acceptsPublisherIdentity` cases, as the Swift suite states them. */
    @Test
    fun captionPublisher() {
        assertEquals(true, Contracts.acceptsCaptionPublisher("rosa@org.example"))
        assertEquals(true, Contracts.acceptsCaptionPublisher("mz+mac-1a2b@org.example"))
        assertEquals(true, Contracts.acceptsCaptionPublisher("Ana@Org-alt.Example"))
        assertEquals(false, Contracts.acceptsCaptionPublisher("guest:abc123def456"))
        assertEquals(false, Contracts.acceptsCaptionPublisher("mz@example.com"))
        assertEquals(false, Contracts.acceptsCaptionPublisher("@org.example"))
        assertEquals(false, Contracts.acceptsCaptionPublisher(null))
    }

    /** Every role iOS draws, both appearances, alpha rounded as `0..255`. */
    @Test
    fun colorTokens() {
        val roles = fixture("color-tokens.json")["roles"]!!.jsonObject
        fun argb(paint: kotlinx.serialization.json.JsonElement): Long {
            val (hex, alpha) = if (paint is JsonObject) {
                paint["rgb"]!!.jsonPrimitive.content to paint["alpha"]!!.jsonPrimitive.content.toDouble()
            } else {
                paint.jsonPrimitive.content to 1.0
            }
            return (Math.round(alpha * 255).toLong() shl 24) or hex.removePrefix("#").toLong(16)
        }
        val mobile = roles.filterValues { (it.jsonObject["ios"] as? kotlinx.serialization.json.JsonPrimitive)?.isString == true }
        assertEquals(mobile.keys, StarlingsTokens.roles.keys)
        mobile.forEach { (role, value) ->
            val v = value.jsonObject
            assertEquals("$role dark", argb(v["dark"]!!), StarlingsTokens.roles.getValue(role).first)
            assertEquals("$role light", argb(v["light"]!!), StarlingsTokens.roles.getValue(role).second)
        }
    }

    /** `GuestClient.badge` and the tolerant metadata read, as Swift. */
    @Test
    fun participantClient() {
        assertEquals("Android app", ParticipantClient.badge(GuestClient("android", "mobile")))
        assertEquals("iPad app", ParticipantClient.badge(GuestClient("ios", "tablet")))
        assertEquals("visionos", ParticipantClient.badge(GuestClient("visionos", "desktop")))
        val facts = ParticipantClient.facts(
            """{"owner":false,"client":{"app":"web","device":"mobile"},"recording":true,"later":1}""",
        )
        assertEquals(ParticipantFacts("Web", notetaker = true, registered = false, app = GuestClient("web", "mobile")), facts)
        assertEquals(ParticipantFacts(null, false, false), ParticipantClient.facts("not json"))
        assertEquals(ParticipantFacts(null, false, false), ParticipantClient.facts(null))
    }

    /** `publicRoomResponseSchema` cases: valid ones decode, invalid ones do not. */
    @Test
    fun publicRoom() {
        fixture("room-entry.json")["public_rooms"]!!.jsonArray.forEach { case ->
            val c = case.jsonObject
            val decoded = PublicRoom.decode(c["value"]!!.toString())
            assertEquals(c["name"]!!.jsonPrimitive.content, c["valid"]!!.jsonPrimitive.content.toBoolean(), decoded != null)
        }
    }

    @Test
    fun reactions() {
        val f = fixture("reactions.json")
        assertEquals(f["palette"]!!.jsonArray.map { it.jsonPrimitive.content }, Reactions.palette)
        assertEquals(f["labels"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }, Reactions.labels)
        val timing = f["timing"]!!.jsonObject
        assertEquals(timing["minimumIntervalMs"]!!.jsonPrimitive.long, Reactions.MIN_INTERVAL_MS)
        assertEquals(timing["flightMs"]!!.jsonPrimitive.long, Reactions.FLIGHT_MS)
        assertEquals(timing["flightJitterMs"]!!.jsonPrimitive.long, Reactions.FLIGHT_JITTER_MS)
        assertEquals(timing["maximumOnscreen"]!!.jsonPrimitive.int, Reactions.MAX_ONSCREEN)
    }
}
