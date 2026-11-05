package work.starlings.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The generated wire types (Wire.kt) against the bodies the Worker's route
 * tests recorded in fixtures/responses/, the same files
 * Tests/ResponseFixtureTests.swift decodes through the Swift types.
 */
class WireDecodeTest {
    private fun fixture(name: String): String {
        val dir = System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")
        return File(dir, name).readText()
    }

    private fun arrayLength(body: String, key: String): Int =
        WireJson.parseToJsonElement(body).jsonObject.getValue(key).jsonArray.size

    private val reads: Map<String, (String) -> Unit> = mapOf(
        "workspace-descriptor" to { body ->
            val descriptor = WireJson.decodeFromString(WorkspaceDescriptor.serializer(), body)
            assertEquals(1L, descriptor.version)
            assertTrue(descriptor.identity.domains.isNotEmpty())
        },
        "owner-room" to { body ->
            assertTrue(WireJson.decodeFromString(OwnerRoomResponse.serializer(), body).room.slug.isNotEmpty())
        },
        "crm-subjects" to { body ->
            val response = WireJson.decodeFromString(CrmSubjectsResponse.serializer(), body)
            assertEquals(arrayLength(body, "subjects"), response.subjects.size)
        },
        "crm-subject-project" to { body -> WireJson.decodeFromString(CrmSubjectDetailResponse.serializer(), body) },
        "crm-mine" to { body -> WireJson.decodeFromString(CrmMyWorkResponse.serializer(), body) },
        "crm-board" to { body -> WireJson.decodeFromString(CrmBoardResponse.serializer(), body) },
        "threads" to { body ->
            val response = WireJson.decodeFromString(ThreadsResponse.serializer(), body)
            assertEquals(arrayLength(body, "threads"), response.threads.size)
        },
        "thread-messages" to { body -> WireJson.decodeFromString(ThreadMessagesResponse.serializer(), body) },
        "peers" to { body ->
            val response = WireJson.decodeFromString(PeersResponse.serializer(), body)
            assertEquals(arrayLength(body, "peers"), response.peers.size)
        },
        "calendar-upcoming" to { body -> WireJson.decodeFromString(CalendarEventsResponse.serializer(), body) },
        "crm-inbox" to { body ->
            val response = WireJson.decodeFromString(InboxResponse.serializer(), body)
            assertEquals(arrayLength(body, "items"), response.items.size)
            assertTrue("every recorded row is a member this build knows", response.items.none { it is InboxItem.Other })
        },
        "search" to { body -> WireJson.decodeFromString(SearchResponseWire.serializer(), body) },
        "favorites" to { body -> WireJson.decodeFromString(FavoritesResponseWire.serializer(), body) },
        "crm-starred" to { body -> WireJson.decodeFromString(SearchResponseWire.serializer(), body) },
        "decision-asks" to { body ->
            val response = WireJson.decodeFromString(DecisionAsksResponse.serializer(), body)
            assertEquals(arrayLength(body, "asks"), response.asks.size)
        },
        "meeting-category" to { body -> WireJson.decodeFromString(MeetingCategoryResponse.serializer(), body) },
    )

    @Test
    fun everyRecordedResponseDecodes() {
        val dir = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set"), "responses")
        val names = dir.listFiles { f -> f.extension == "json" }!!.map { it.nameWithoutExtension }.toSet()
        assertEquals("a decode per recorded file, and a file per decode", names, reads.keys)
        for (name in names.sorted()) {
            try {
                reads.getValue(name)(fixture("responses/$name.json"))
            } catch (error: Exception) {
                throw AssertionError("fixtures/responses/$name.json does not decode: $error", error)
            }
        }
    }

    @Test
    fun cliWireDecodes() {
        val cli = WireJson.parseToJsonElement(fixture("cli-wire.json")).jsonObject
        val request = WireJson.decodeFromJsonElement(StarlingsCLIRequest.serializer(), cli.getValue("request"))
        assertEquals("status", request.command)
        val success = WireJson.decodeFromJsonElement(StarlingsCLIResponse.serializer(), cli.getValue("success_response"))
        assertTrue(success.ok)
        val failure = WireJson.decodeFromJsonElement(StarlingsCLIResponse.serializer(), cli.getValue("failure_response"))
        assertTrue(!failure.ok && failure.error != null)
    }

    private fun <T> roundTrip(serializer: KSerializer<T>, value: T): T =
        WireJson.decodeFromString(serializer, WireJson.encodeToString(serializer, value))

    @Test
    fun aTaggedUnionRoundTrips() {
        val items = WireJson.decodeFromString(InboxResponse.serializer(), fixture("responses/crm-inbox.json")).items
        assertTrue(items.any { it is InboxDecisionItem })
        assertEquals(items, roundTrip(ListSerializer(InboxItem.serializer()), items))
        assertEquals(listOf("decision", "task", "task"), items.map { it.source }.take(3))
    }

    @Test
    fun anUnknownUnionMemberIsKeptWhole() {
        val body = """{"source":"carrier_pigeon","key":"x","at":1,"feathers":3}"""
        val item = WireJson.decodeFromString(InboxItem.serializer(), body)
        assertTrue(item is InboxItem.Other)
        assertEquals("carrier_pigeon", item.source)
        assertEquals(WireJson.parseToJsonElement(body), WireJson.parseToJsonElement(WireJson.encodeToString(InboxItem.serializer(), item)))
        assertEquals(item, roundTrip(InboxItem.serializer(), item))
        assertTrue((item as InboxItem.Other).raw is JsonObject)
    }

    @Test
    fun anUnknownOpenEnumValueDecodes() {
        val body = fixture("responses/threads.json").replaceFirst("\"kind\": \"dm\"", "\"kind\": \"carrier_pigeon\"")
        val thread = WireJson.decodeFromString(ThreadsResponse.serializer(), body).threads.first()
        assertEquals(ThreadKind("carrier_pigeon"), thread.kind)
        assertTrue(thread.kind !in ThreadKind.known)
        // A read alias (ADR 0006): a cached `partner` reads as `organization`.
        assertEquals(ThreadKind.ORGANIZATION, WireJson.decodeFromString(ThreadKind.serializer(), "\"partner\""))
    }

    @Test
    fun aRequestBodySaysOmitNullAndValueApart() {
        val update = CrmTaskUpdate(title = "Ship", notes = Patch.Null, dueDate = Patch.Value("2026-11-01"))
        val json = WireJson.encodeToString(CrmTaskUpdate.serializer(), update)
        assertEquals("""{"title":"Ship","notes":null,"due_date":"2026-11-01"}""", json)
        val back = WireJson.decodeFromString(CrmTaskUpdate.serializer(), json)
        assertEquals(update, back)
        assertEquals(Patch.Omit, back.assignedTo)
    }
}
