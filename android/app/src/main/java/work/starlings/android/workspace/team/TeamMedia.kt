package work.starlings.android.workspace.team

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import work.starlings.android.OwnerAccount
import work.starlings.android.OwnerApi
import work.starlings.android.api.Route
import work.starlings.android.api.StarlingsApiError
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The byte half of Team's API: pictures and files, which [work.starlings.android.api.StarlingsClient]
 * cannot carry because it reads every body as text. The same rules: the
 * owner's bearer in the header, `x-meet-client`, renewal before sending and
 * one replay after a refusal. Only the Worker's own origin is ever asked,
 * and a body over its cap is dropped before it is decoded.
 */
class TeamMedia(private val account: OwnerAccount, private val origin: String = work.starlings.android.Workspaces.active.apiOrigin) {
    /** A byte read: null for a 404, a refusal, an oversize body or no network. Pictures draw initials then. */
    suspend fun bytes(route: Route<Unit>, maxBytes: Long): ByteArray? = runCatching {
        send(route, null, null).use { r -> if (r.isSuccessful) bounded(r, maxBytes) else null }
    }.getOrNull()

    /** A byte read that says why it failed, for a file the person asked to open. */
    suspend fun bytesOrThrow(route: Route<Unit>, maxBytes: Long): ByteArray =
        send(route, null, null).use { r ->
            if (!r.isSuccessful) throw StarlingsApiError.Service(route.operation, r.code, null, r.header("x-request-id"))
            bounded(r, maxBytes) ?: throw StarlingsApiError.Service(route.operation, r.code, null, null)
        }

    /** A byte write (an attachment's upload). Throws [StarlingsApiError] on a refusal. */
    suspend fun upload(route: Route<Unit>, data: ByteArray, contentType: String) {
        send(route, data, contentType).use { r ->
            if (!r.isSuccessful) throw StarlingsApiError.Service(route.operation, r.code, null, r.header("x-request-id"))
        }
    }

    /**
     * A byte write whose answer is JSON (an issue picture's stored address),
     * decoded with [WireJson]. Throws [StarlingsApiError] on a refusal, with
     * the Worker's error code, or on an answer that does not decode.
     */
    suspend fun <A> upload(route: Route<A>, answer: kotlinx.serialization.KSerializer<A>, data: ByteArray, contentType: String): A =
        send(route, data, contentType).use { r ->
            val body = withContext(Dispatchers.IO) { r.body?.string().orEmpty() }
            if (!r.isSuccessful) {
                throw StarlingsApiError.Service(route.operation, r.code, work.starlings.android.api.StarlingsClient.errorCode(body), r.header("x-request-id"), work.starlings.android.api.StarlingsClient.errorMessage(body))
            }
            try {
                work.starlings.contracts.WireJson.decodeFromString(answer, body)
            } catch (e: IllegalArgumentException) {
                throw StarlingsApiError.Undecodable(route.operation, answer.descriptor.serialName.substringAfterLast('.'))
            }
        }

    /**
     * A link card's picture. The Worker signs it, so it goes without the
     * bearer, and only when it is the Worker's own address, never the publisher's.
     */
    suspend fun previewImage(url: String): ByteArray? = withContext(Dispatchers.IO) {
        if (!url.startsWith("$origin/")) return@withContext null
        runCatching { http.newCall(Request.Builder().url(url).build()).execute().use { r -> if (r.isSuccessful) bounded(r, PREVIEW_MAX_BYTES) else null } }.getOrNull()
    }

    private suspend fun send(route: Route<*>, data: ByteArray?, contentType: String?): Response {
        val session = account.session
        session.renewIfNeeded()
        val token = session.credentials()?.accessToken ?: throw StarlingsApiError.SignedOut(route.operation)
        val first = execute(route, token, data, contentType)
        if (first.code != 401) return first
        first.close()
        session.handleRejected()
        val fresh = session.credentials()?.accessToken
        if (fresh == null || fresh == token) throw StarlingsApiError.SessionRefused(route.operation)
        return execute(route, fresh, data, contentType)
    }

    private suspend fun execute(route: Route<*>, token: String, data: ByteArray?, contentType: String?): Response = withContext(Dispatchers.IO) {
        val url = origin.toHttpUrl().newBuilder()
            .addPathSegment("api")
            .apply { route.path.forEach { addPathSegment(it) } }
            .apply { route.query.forEach { (name, value) -> addQueryParameter(name, value) } }
            .build()
        val millis = ((route.timeoutSeconds ?: 30.0) * 1_000).toLong()
        val client = http.newBuilder().readTimeout(millis, TimeUnit.MILLISECONDS).writeTimeout(millis, TimeUnit.MILLISECONDS).build()
        val request = Request.Builder()
            .url(url)
            .header(OwnerApi.CLIENT_HEADER, OwnerApi.clientHeader)
            .header("Authorization", "Bearer $token")
            .apply { if (route.origin) header("Origin", origin) }
            .method(route.method, data?.toRequestBody((contentType ?: "application/octet-stream").toMediaType()))
            .build()
        try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw StarlingsApiError.Offline(route.operation, e)
        }
    }

    private fun bounded(r: Response, maxBytes: Long): ByteArray? {
        val body = r.body ?: return null
        if (body.contentLength() > maxBytes) return null
        val source = body.source()
        source.request(maxBytes + 1)
        if (source.buffer.size > maxBytes) return null
        return source.readByteArray()
    }

    companion object {
        /** A 512 px JPEG is tens of kilobytes; anything near this is not a face. */
        const val AVATAR_MAX_BYTES = 2L * 1_048_576
        /** `ATTACHMENT_MAX_BYTES` (packages/contracts/src/limits.ts). */
        const val ATTACHMENT_MAX_BYTES = 25L * 1_048_576
        /** As the meeting's link cards (`LobbyApi.MAX_IMAGE_BYTES`). */
        const val PREVIEW_MAX_BYTES = 2L * 1_048_576

        private val http = OkHttpClient()
    }
}
