package work.starlings.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import work.starlings.contracts.LinkPreview
import work.starlings.contracts.LinkPreviewResponse
import work.starlings.contracts.StarlingsMintedBookingProjection
import work.starlings.contracts.WireJson
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * `parsePublicRoomPath` in packages/contracts/src/paths.ts: the slug matched
 * without case and lowercased, the booking token decoded, trimmed and kept as
 * written (a token is case-sensitive), at most 128 characters.
 */
object RoomLink {
    private val path = Regex("^/room/([a-z0-9-]{2,40})(?:/([^/]+))?/?$", RegexOption.IGNORE_CASE)

    data class Parsed(val slug: String, val bookingToken: String?)

    fun parse(link: String): Parsed? {
        val trimmed = link.trim()
        val pathPart = if (trimmed.contains("://")) {
            runCatching { java.net.URI(trimmed).rawPath }.getOrNull() ?: return null
        } else {
            "/room/" + trimmed.removePrefix("/").removePrefix("room/")
        }
        val m = path.matchEntire(pathPart) ?: return null
        return Parsed(m.groupValues[1].lowercase(), bookingToken(m.groupValues[2]))
    }

    /** `sanitizeBookingToken`. */
    private fun bookingToken(raw: String): String? {
        if (raw.isEmpty()) return null
        val value = runCatching { java.net.URLDecoder.decode(raw.replace("+", "%2B"), Charsets.UTF_8) }.getOrDefault(raw).trim()
        return value.takeIf { it.isNotEmpty() && it.length <= 128 }
    }
}

/** `guestClientSchema`: what the host's lobby shows next to the name. */
@Serializable
data class GuestClient(val app: String, val device: String)

@Serializable
data class JoinRequestBody(
    val name: String,
    val email: String,
    @SerialName("booking_token") val bookingToken: String? = null,
    val client: GuestClient? = null,
)

/**
 * `publicRoomResponseSchema`: `GET /api/rooms/{slug}`, decoded strictly at the
 * boundary and held to `fixtures/room-entry.json`. Unknown keys pass, as zod's
 * default object does; a wrong type or a missing required key does not.
 */
@Serializable
data class PublicRoom(
    val slug: String,
    val kind: String,
    val internal: Boolean? = null,
    @SerialName("owner_name") val ownerName: String?,
    val you: Member? = null,
) {
    @Serializable
    data class Member(val name: String, val email: String)

    companion object {
        private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = false }

        fun decode(text: String): PublicRoom? =
            runCatching { json.decodeFromString(serializer(), text) }.getOrNull()?.takeIf { it.kind == "permanent" }
    }
}

/** The knock and status responses are camelCase (`index.ts`). */
@Serializable
data class Knock(
    val requestId: String,
    val lobbyToken: String,
    val status: String,
    val waitingCount: Int = 0,
)

@Serializable
data class LobbyStatus(val status: String, val waitingCount: Int = 0)

@Serializable
data class ExchangeBody(@SerialName("lobby_token") val lobbyToken: String)

/** `connectionDetailsSchema`, snake_case. */
@Serializable
data class ConnectionDetails(
    @SerialName("server_url") val serverUrl: String,
    @SerialName("participant_token") val participantToken: String,
    @SerialName("meeting_id") val meetingId: String? = null,
    /** The meeting's guest credential for Worker routes such as the hand. */
    @SerialName("artifact_token") val artifactToken: String? = null,
    @SerialName("livekit_room") val livekitRoom: String? = null,
)

class ApiError(val status: Int, val code: String?) : Exception("HTTP $status ${code ?: ""}".trim())

/**
 * Guest lobby: knock, poll, exchange. No media token before admission.
 * The Worker gates knock and exchange on an exact `Origin` (`assertWebOrigin`).
 */
private const val MAX_IMAGE_BYTES = 2L * 1024 * 1024

class LobbyApi(private val origin: String) {
    private val http = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val jsonType = "application/json".toMediaType()

    /**
     * The room before a knock: null when there is no such room. An internal
     * room answers only a verified member, so a signed-in caller sends its
     * owner token as [member] (`publicRoom(_:member:)`); `you` then names them.
     */
    suspend fun room(slug: String, member: String? = null): PublicRoom? = try {
        PublicRoom.decode(send(Request.Builder().url("$origin/api/rooms/$slug").bearer(member).get().build()))
    } catch (e: ApiError) {
        if (e.status == 404) null else throw e
    }

    /**
     * `bookingProjection`: the invite a booking token names. A 404 is an
     * invite this room does not know ([BookingInvite.EXPIRED]); any other
     * failure is null, and the room stays opaque, as the browser.
     */
    suspend fun booking(slug: String, token: String): StarlingsMintedBookingProjection? = try {
        val url = "$origin/api/rooms/$slug/bookings/${java.net.URLEncoder.encode(token, Charsets.UTF_8).replace("+", "%20")}"
        WireJson.decodeFromString(StarlingsMintedBookingProjection.serializer(), send(Request.Builder().url(url).get().build()))
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: ApiError) {
        if (e.status == 404) BookingInvite.EXPIRED else null
    } catch (_: Exception) {
        null
    }

    /** The knock. A member at an internal room sends their owner token as [member], as iOS `requestJoin(member:)`. */
    suspend fun knock(slug: String, body: JoinRequestBody, member: String? = null): Knock =
        post("/api/rooms/$slug/join-requests", json.encodeToString(JoinRequestBody.serializer(), body), member)
            .let { json.decodeFromString(Knock.serializer(), it) }

    private fun Request.Builder.bearer(token: String?): Request.Builder =
        if (token == null) this else header("Authorization", "Bearer $token")

    suspend fun status(slug: String, knock: Knock): LobbyStatus =
        send(
            Request.Builder()
                .url("$origin/api/rooms/$slug/join-requests/${knock.requestId}")
                .header("Authorization", "Bearer ${knock.lobbyToken}")
                .get()
                .build(),
        ).let { json.decodeFromString(LobbyStatus.serializer(), it) }

    suspend fun exchange(slug: String, knock: Knock): ConnectionDetails =
        post(
            "/api/rooms/$slug/join-requests/${knock.requestId}/exchange",
            json.encodeToString(ExchangeBody.serializer(), ExchangeBody(knock.lobbyToken)),
        ).let { json.decodeFromString(ConnectionDetails.serializer(), it) }

    /**
     * The lobby socket: `lobby.status` and `lobby.waiting` pushes, so the wait
     * loop wakes at once. Polling stays the source of truth (`awaitAdmission`).
     */
    fun socket(slug: String, knock: Knock, onStatus: (String?, Int?) -> Unit, onClosed: () -> Unit): WebSocket {
        val wsOrigin = origin.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        val request = Request.Builder()
            .url("$wsOrigin/api/rooms/$slug/lobby/socket?request_id=${knock.requestId}&token=${knock.lobbyToken}")
            .header("Origin", origin)
            .build()
        return http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = runCatching { json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return
                when (message["type"]?.jsonPrimitive?.content) {
                    "lobby.status" -> onStatus(message["status"]?.jsonPrimitive?.content, null)
                    "lobby.waiting" -> onStatus(null, message["waiting_count"]?.jsonPrimitive?.content?.toIntOrNull())
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onClosed()
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onClosed()
        })
    }

    /** `POST /api/rooms/{slug}/meetings/{id}/hand`: only ever the caller's own hand. */
    suspend fun setHand(slug: String, meetingId: String, artifactToken: String, raised: Boolean) {
        send(
            Request.Builder()
                .url("$origin/api/rooms/$slug/meetings/$meetingId/hand")
                .header("Authorization", "Bearer $artifactToken")
                .post("{\"raised\":$raised}".toRequestBody(jsonType))
                .build(),
        )
    }

    /** The meeting's own unfurl, on its artifact token: a guest has no account. */
    suspend fun linkPreview(slug: String, meetingId: String, artifactToken: String, link: String): LinkPreview {
        val url = "$origin/api/rooms/$slug/meetings/$meetingId/link-preview".toHttpUrl().newBuilder()
            .addQueryParameter("url", link).build()
        val body = send(Request.Builder().url(url).header("Authorization", "Bearer $artifactToken").get().build())
        return WireJson.decodeFromString(LinkPreviewResponse.serializer(), body).preview
    }

    /**
     * A preview's picture. Only the Worker's own signed address is fetched,
     * never the publisher's, and at most [MAX_IMAGE_BYTES].
     */
    suspend fun previewImage(imageUrl: String): ByteArray? = withContext(Dispatchers.IO) {
        if (!imageUrl.startsWith("$origin/")) return@withContext null
        runCatching {
            http.newCall(Request.Builder().url(imageUrl).build()).execute().use { r ->
                val body = r.body ?: return@use null
                if (!r.isSuccessful || body.contentLength() > MAX_IMAGE_BYTES) return@use null
                body.source().let { src -> src.request(MAX_IMAGE_BYTES + 1); if (src.buffer.size > MAX_IMAGE_BYTES) null else src.readByteArray() }
            }
        }.getOrNull()
    }

    private suspend fun post(path: String, body: String, bearer: String? = null): String =
        send(
            Request.Builder()
                .url(origin + path)
                .header("Origin", origin)
                .bearer(bearer)
                .post(body.toRequestBody(jsonType))
                .build(),
        )

    private suspend fun send(request: Request): String = withContext(Dispatchers.IO) {
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ApiError(response.code, errorCode(text))
            text
        }
    }

    private fun errorCode(text: String): String? = runCatching {
        json.parseToJsonElement(text).let { it as JsonObject }["error"]?.jsonPrimitive?.content
    }.getOrNull()
}
