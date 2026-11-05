package work.starlings.android.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import work.starlings.android.OwnerApi
import work.starlings.android.OwnerCredentials
import work.starlings.android.UpdateRecommendation
import work.starlings.contracts.ControlErrorCodeValue
import work.starlings.contracts.WireJson
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * What [StarlingsClient] needs from the owner session (`OwnerAccount.session`):
 * the stored pair, the renewal before a request, and the replay after a
 * refusal (`StarlingsOwnerSessionRenewal` in `Sources/StarlingsHTTPTransport.swift`).
 */
interface OwnerSession {
    /** The stored pair, or null when nobody is signed in. */
    fun credentials(): OwnerCredentials?

    /** `OwnerSessionRenewer.renewIfNeeded`: renew when the JWT expires within the hour. */
    suspend fun renewIfNeeded()

    /** `OwnerAccount.handleRejected`: renew once; signs out only if the Worker refuses that too. */
    suspend fun handleRejected()

    /** The request sent again with a fresh token was refused too: sign out here (`ownerSessionRejectedNotification`). */
    fun expire()
}

/**
 * Why a request failed, typed as `StarlingsError` and `StarlingsHTTPFailure`.
 * It carries the operation, the HTTP status, the Worker's stable code and,
 * for a refusal, the Worker's own sentence ([sentence]). The exception's
 * message holds no token, body, URL or Worker prose.
 */
sealed class StarlingsApiError(val operation: String, detail: String, cause: Throwable? = null) : Exception("$operation: $detail", cause) {
    /** What a person can do about it (`StarlingsError.Recovery`). */
    enum class Recovery { NONE, RETRY, SIGN_IN, UPDATE }

    abstract val recovery: Recovery

    /**
     * What a person reads (`StarlingsError.localizedDescription` on iOS): the
     * Worker's own message for a refusal it explained ([Service.serverMessage]),
     * else the operation.
     */
    open val sentence: String get() = operation

    /** Nobody is signed in. Nothing was sent. */
    class SignedOut(operation: String) : StarlingsApiError(operation, "signed out") {
        override val recovery = Recovery.SIGN_IN
    }

    /** The Worker never answered: offline, DNS, a timeout. The session is kept. */
    class Offline(operation: String, cause: IOException) : StarlingsApiError(operation, "unreachable (${cause.javaClass.simpleName})", cause) {
        override val recovery = Recovery.RETRY
    }

    /**
     * The Worker answered with a non-2xx status. [serverCode] is the `code` of
     * its `{error, code, request_id}` body; [requestId] is only ever a UUID;
     * [serverMessage] is its `error` sentence, when it sent one.
     */
    class Service(
        operation: String,
        val status: Int,
        val serverCode: ControlErrorCodeValue?,
        val requestId: String?,
        val serverMessage: String? = null,
    ) : StarlingsApiError(operation, "HTTP $status${serverCode?.let { " $it" }.orEmpty()}") {
        override val recovery = when {
            serverCode == ControlErrorCodeValue.CLIENT_UPDATE_REQUIRED -> Recovery.UPDATE
            status >= 500 || status == 408 || status == 429 -> Recovery.RETRY
            else -> Recovery.NONE
        }

        override val sentence: String get() = refusalSentence(status, serverCode, serverMessage) ?: operation

        companion object {
            /** Codes whose iOS sentence is the app's own, not the Worker's (`StarlingsError.service`). */
            private val OWN_SENTENCE = setOf(
                ControlErrorCodeValue.OWNER_AUTH_REQUIRED,
                ControlErrorCodeValue.ROOM_NOT_FOUND,
                ControlErrorCodeValue.LOBBY_CREDENTIALS_INVALID,
                ControlErrorCodeValue.NOT_CONFIGURED,
            )

            /**
             * `StarlingsError.service`: a 4xx reads as the Worker's own message
             * (a 409 on contact delete names the records still using it). A 5xx,
             * a code iOS words itself, or a body with no message answers null,
             * and the operation stands.
             */
            fun refusalSentence(status: Int, code: ControlErrorCodeValue?, message: String?): String? {
                val text = message?.trim()?.takeIf { it.isNotEmpty() } ?: return null
                if (status >= 500 || code in OWN_SENTENCE) return null
                return text
            }
        }
    }

    /** `owner_auth_required` after the one renewal and the one resend: the person is signed out. */
    class SessionRefused(operation: String) : StarlingsApiError(operation, "owner session refused") {
        override val recovery = Recovery.SIGN_IN
    }

    /** A 2xx body that did not decode as the route's answer. */
    class Undecodable(operation: String, type: String) : StarlingsApiError(operation, "response did not decode as $type") {
        override val recovery = Recovery.NONE
    }
}

/** One request as the transport sends it. Header names are lowercase. */
class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String?,
    val timeoutSeconds: Double,
)

/** One answer, whatever its status. Header names are lowercase. */
class HttpResponse(val status: Int, val headers: Map<String, String>, val body: String)

/** Sends one request. Throws [IOException] when no HTTP answer came back. */
fun interface HttpTransport {
    suspend fun send(request: HttpRequest): HttpResponse
}

/** The device's transport. No HTTP cache: every read is live or revalidated through a snapshot's ETag. */
class OkHttpTransport(private val http: OkHttpClient = OkHttpClient()) : HttpTransport {
    private val jsonType = "application/json".toMediaType()

    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        val millis = (request.timeoutSeconds * 1_000).toLong()
        // The timeout is the idle interval, as URLSession's: time without data.
        val client = http.newBuilder().readTimeout(millis, TimeUnit.MILLISECONDS).writeTimeout(millis, TimeUnit.MILLISECONDS).build()
        val built = Request.Builder()
            .url(request.url)
            .apply { request.headers.forEach { (name, value) -> header(name, value) } }
            .method(request.method, request.body?.toRequestBody(jsonType))
            .build()
        client.newCall(built).execute().use { response ->
            HttpResponse(
                response.code,
                response.headers.associate { (name, value) -> name.lowercase() to value },
                response.body?.string().orEmpty(),
            )
        }
    }
}

/**
 * The signed-in API layer every workspace screen uses: `StarlingsAPI` on
 * iOS (`iOS/StarlingsAPI.swift`) over the shared transport rules of
 * `Sources/StarlingsHTTPTransport.swift`.
 *
 * - The owner's bearer token in the header, never the URL, and
 *   `x-meet-client: android/<version> (<code>)` on every request.
 * - Renews before sending when the JWT expires within the hour.
 * - `owner_auth_required` (a 401, or a 403 from older capability gates):
 *   [OwnerSession.handleRejected] once, then the request once more with the
 *   fresh token. A second refusal signs out ([OwnerSession.expire]). A renewal
 *   that could not reach the Worker keeps the session.
 * - An idempotent request that fails on the network, or gets a 5xx, 408 or
 *   429, is sent once more after a pause ([RequestPolicy.retry]).
 * - A read the policy table says Android keeps goes out with the snapshot's
 *   ETag as `If-None-Match`; a 304 answers with the stored body, and a body
 *   that decoded becomes the snapshot. A 2xx write marks its lists stale.
 *
 * Nothing here logs a token, a body or a URL.
 */
class StarlingsClient(
    private val origin: String,
    private val session: OwnerSession,
    private val snapshots: SnapshotCache?,
    private val transport: HttpTransport = OkHttpTransport(),
    private val retry: RequestPolicy.Retry = RequestPolicy.retry,
    private val clientHeader: String = OwnerApi.clientHeader,
    /**
     * Each HTTP answer's update recommendation (`x-meet-upgrade`,
     * `x-meet-update-url`), as iOS `observeUpgradeRecommendation`: the app's
     * [UpdateRecommendation] keeps it. Every request here sends
     * `x-meet-client`, so every answer speaks for this build.
     */
    private val onUpgrade: (recommended: Boolean, updateUrl: String?) -> Unit = { _, _ -> },
) {
    /** A stored answer, decoded, and when it was saved: what a screen paints before the live read. */
    data class Snapshot<A>(val value: A, val savedAtMs: Long)

    /** Sends [route] as the signed-in owner and answers its decoded body. Throws [StarlingsApiError]. */
    suspend fun <A> call(route: Route<A>): A {
        session.renewIfNeeded()
        val credentials = session.credentials() ?: throw StarlingsApiError.SignedOut(route.operation)
        val owner = credentials.email
        val key = route.snapshotKey?.takeIf { snapshots != null && RequestPolicy.keeps(it, RequestPolicy.Client.ANDROID) }
        val known = key?.let { snapshots?.load(owner, it) }

        val request = build(route, credentials.accessToken, known?.etag)
        var response = send(request, route.operation)
        if (isOwnerSessionRefusal(response)) {
            session.handleRejected()
            val fresh = session.credentials()?.accessToken
            // Signed out by the renewal, or a renewal that never reached the Worker: no resend.
            if (fresh == null) throw StarlingsApiError.SessionRefused(route.operation)
            if (fresh == credentials.accessToken) throw failure(response, route.operation)
            response = send(build(route, fresh, known?.etag), route.operation)
            if (isOwnerSessionRefusal(response)) {
                session.expire()
                throw StarlingsApiError.SessionRefused(route.operation)
            }
        }

        val body: String
        val etag: String?
        if (response.status == 304 && known != null) {
            // Only ever answered to a validator this request sent.
            body = known.body
            etag = response.headers["etag"] ?: known.etag
        } else {
            if (response.status !in 200..299) throw failure(response, route.operation)
            body = response.body
            etag = response.headers["etag"]
        }

        val value = decode(route, body)
        if (key != null) snapshots?.save(owner, key, body, etag)
        if (route.writes.isNotEmpty()) snapshots?.invalidate(owner, route.writes.flatMap(RequestPolicy::invalidated))
        return value
    }

    /**
     * The last good answer of [route] for the signed-in owner, decoded, or
     * null when none is usable or Android does not keep it. No request.
     */
    fun <A> snapshot(route: Route<A>): Snapshot<A>? {
        val key = route.snapshotKey?.takeIf { RequestPolicy.keeps(it, RequestPolicy.Client.ANDROID) } ?: return null
        val owner = session.credentials()?.email ?: return null
        val entry = snapshots?.load(owner, key) ?: return null
        val value = runCatching { decode(route, entry.body) }.getOrNull() ?: return null
        return Snapshot(value, entry.savedAtMs)
    }

    private fun build(route: Route<*>, token: String, etag: String?): HttpRequest {
        val url = origin.toHttpUrl().newBuilder()
            .addPathSegment("api")
            .apply { route.path.forEach { addPathSegment(it) } }
            .apply { route.query.forEach { (name, value) -> addQueryParameter(name, value) } }
            .build()
        val headers = buildMap {
            put("accept", "application/json")
            put(OwnerApi.CLIENT_HEADER, clientHeader)
            put("authorization", "Bearer $token")
            if (route.body != null) put("content-type", "application/json")
            if (route.origin) put("origin", origin)
            if (etag != null) put("if-none-match", etag)
        }
        return HttpRequest(route.method, url.toString(), headers, route.body, route.timeoutSeconds ?: RequestPolicy.TIMEOUT_SECONDS)
    }

    /** One send, plus the policy's one retry of an idempotent request. */
    private suspend fun send(request: HttpRequest, operation: String): HttpResponse {
        var retriesLeft = if (retry.appliesTo(request.method)) retry.extraAttempts else 0
        while (true) {
            val response = try {
                transport.send(request)
            } catch (e: IOException) {
                if (retriesLeft > 0) { retriesLeft--; pause(); continue }
                throw StarlingsApiError.Offline(operation, e)
            }
            val (recommended, updateUrl) = UpdateRecommendation.read(response.headers)
            onUpgrade(recommended, updateUrl)
            if (retriesLeft > 0 && retry.retries(response.status)) { retriesLeft--; pause(); continue }
            return response
        }
    }

    private suspend fun pause() {
        if (retry.delaySeconds > 0) delay((retry.delaySeconds * 1_000).toLong())
    }

    @Suppress("UNCHECKED_CAST")
    private fun <A> decode(route: Route<A>, body: String): A = try {
        when (val answer = route.answer) {
            is Answer.Wire -> WireJson.decodeFromString(answer.serializer, body)
            is Answer.None -> Unit as A
            is Answer.Json -> Json.parseToJsonElement(body) as A
        }
    } catch (e: IllegalArgumentException) {
        // kotlinx's SerializationException is an IllegalArgumentException.
        val type = (route.answer as? Answer.Wire)?.serializer?.descriptor?.serialName?.substringAfterLast('.') ?: "JSON"
        throw StarlingsApiError.Undecodable(route.operation, type)
    }

    companion object {
        /** `isOwnerSessionRefusal`: a 401 or 403 whose body names `owner_auth_required`. Keyed off the code, never the prose. */
        fun isOwnerSessionRefusal(response: HttpResponse): Boolean =
            (response.status == 401 || response.status == 403) && errorCode(response.body) == ControlErrorCodeValue.OWNER_AUTH_REQUIRED

        /** The `code` of the Worker's `{error, code}` body, when it has one. */
        fun errorCode(body: String): ControlErrorCodeValue? =
            errorField(body, "code")?.let(::ControlErrorCodeValue)

        /** The `error` sentence of the Worker's `{error, code}` body (`StarlingsHTTPTransport.errorBody`). */
        fun errorMessage(body: String): String? = errorField(body, "error")

        /** Only a UUID request id leaves this client: the header first, then the body. */
        fun requestId(response: HttpResponse): String? =
            listOfNotNull(response.headers["x-meet-request-id"], errorField(response.body, "request_id"))
                .firstOrNull { UUID_SHAPE.matches(it) }?.lowercase()

        private val UUID_SHAPE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        private fun failure(response: HttpResponse, operation: String) =
            StarlingsApiError.Service(operation, response.status, errorCode(response.body), requestId(response), errorMessage(response.body))

        private fun errorField(body: String, name: String): String? = runCatching {
            val element: JsonElement = Json.parseToJsonElement(body)
            element.jsonObject[name]?.jsonPrimitive?.takeIf { it.isString }?.content
        }.getOrNull()
    }
}
