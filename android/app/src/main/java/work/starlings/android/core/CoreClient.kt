package work.starlings.android.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Why a Core request failed: core-kit `CoreAgentClientError`, in its words. Errors stay English. */
sealed class CoreClientError(message: String) : Exception(message) {
    class MissingToken : CoreClientError("Connect records in Settings.")
    class InvalidResponse : CoreClientError("The server returned an invalid response.")
    class Api(val status: Int, message: String) : CoreClientError(message)
    class Offline(cause: IOException) : CoreClientError("The server could not be reached.") {
        init { initCause(cause) }
    }
}

/**
 * The device's line to Core: core-kit `CoreAgentClient` over the CRM space
 * (`/api/agent`). A base URL and a closure that yields the current bearer;
 * the token itself lives in [CoreTokenStore], never here, so a disconnect
 * takes effect on the very next request.
 *
 * iOS reads the registry from `meta/entities`, which names no operations, so
 * core-kit takes record paths by its legacy rule: `/api/agent/<entity>`,
 * `/<id>`, and `/entities/<entity>/<id>/related/<relation>`. This client
 * calls the same paths. Nothing here logs a token or a body.
 */
class CoreClient(
    private val baseUrl: () -> HttpUrl?,
    private val tokenProvider: () -> String?,
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).followRedirects(false).build(),
) {
    suspend fun entityContracts(): CoreEntityContractData =
        request("GET", "$PREFIX/meta/entities", answer = CoreDataEnvelope.serializer(CoreEntityContractData.serializer())).data

    suspend fun list(entity: String, limit: Int = 100, offset: Int = 0): Pair<List<JsonObject>, Int> {
        val page = request("GET", "$PREFIX/${seg(entity)}", listOf("limit" to "$limit", "offset" to "$offset"), answer = CoreListEnvelope.serializer())
        return page.data to page.meta.count
    }

    suspend fun get(entity: String, id: String): JsonObject =
        request("GET", "$PREFIX/${seg(entity)}/${seg(id)}", answer = CoreDataEnvelope.serializer(JsonObject.serializer())).data

    suspend fun related(entity: String, id: String, relation: String): CoreRelatedData =
        request("GET", "$PREFIX/entities/${seg(entity)}/${seg(id)}/related/${seg(relation)}", answer = CoreDataEnvelope.serializer(CoreRelatedData.serializer())).data

    suspend fun update(entity: String, id: String, values: Map<String, JsonElement>): JsonObject =
        request("PATCH", "$PREFIX/${seg(entity)}/${seg(id)}", body = JsonObject(values).toString(), answer = CoreDataEnvelope.serializer(JsonObject.serializer())).data

    /** `save(entity:id: nil)`: `POST /api/agent/<entity>`, core-kit's legacy `<entity>.create` path. */
    suspend fun create(entity: String, values: Map<String, JsonElement>): JsonObject =
        request("POST", "$PREFIX/${seg(entity)}", body = JsonObject(values).toString(), answer = CoreDataEnvelope.serializer(JsonObject.serializer())).data

    /** `members()`: who a `members` picker offers. Core gates it on `tasks:read`. */
    suspend fun members(): List<CoreMember> =
        request("GET", "$PREFIX/members", answer = CoreDataEnvelope.serializer(ListSerializer(CoreMember.serializer()))).data

    /** `characteristics()`: each entity's characteristics vocabulary, by entity id. */
    suspend fun characteristics(): Map<String, List<CoreCharacteristicOption>> =
        request("GET", "$PREFIX/meta/characteristics", answer = CoreDataEnvelope.serializer(MapSerializer(String.serializer(), ListSerializer(CoreCharacteristicOption.serializer())))).data

    suspend fun delete(entity: String, id: String) {
        request("DELETE", "$PREFIX/${seg(entity)}/${seg(id)}", answer = CoreDataEnvelope.serializer(JsonElement.serializer()))
    }

    suspend fun search(query: String, limit: Int = 8): List<CoreSearchResult> =
        request("GET", "$PREFIX/search", listOf("q" to query, "limit" to "$limit"), answer = CoreSearchEnvelope.serializer()).data

    private fun seg(value: String): String = HttpUrl.Builder().scheme("https").host("x").addPathSegment(value).build().encodedPath.removePrefix("/")

    private suspend fun <A> request(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
        answer: KSerializer<A>,
    ): A {
        val token = tokenProvider()?.trim()?.takeIf { it.isNotEmpty() } ?: throw CoreClientError.MissingToken()
        val base = baseUrl() ?: throw CoreClientError.MissingToken()
        val url = (base.toString().trimEnd('/') + path).toHttpUrlOrNull()?.newBuilder()?.apply {
            query.forEach { (k, v) -> addQueryParameter(k, v) }
        }?.build() ?: throw CoreClientError.InvalidResponse()
        val json = "application/json".toMediaType()
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header(INTEGRATION_HEADER, INTEGRATION)
            .header("Accept", "application/json")
            .method(method, body?.toRequestBody(json) ?: if (method == "POST" || method == "PATCH") "{}".toRequestBody(json) else null)
            .build()
        val (status, text) = withContext(Dispatchers.IO) {
            try {
                http.newCall(request).execute().use { it.code to (it.body?.string() ?: "") }
            } catch (e: IOException) {
                throw CoreClientError.Offline(e)
            }
        }
        if (status !in 200..299) throw CoreClientError.Api(status, failure(status, text))
        return try {
            CoreJson.decodeFromString(answer, text)
        } catch (_: Exception) {
            throw CoreClientError.InvalidResponse()
        }
    }

    companion object {
        const val PREFIX = "/api/agent"
        const val INTEGRATION_HEADER = "X-Envisioning-Integration"

        /** What this client calls itself to Core. Core's `parseIntegration` reads a name it does not list as `unknown`. */
        const val INTEGRATION = "android"

        /** core-kit's message: `<error> [<code>]`, the error alone, or "Request failed (<status>)." */
        fun failure(status: Int, body: String): String {
            val parsed = runCatching { CoreJson.parseToJsonElement(body).jsonObject }.getOrNull()
            val error = runCatching { parsed?.get("error")?.jsonPrimitive?.takeIf { it.isString }?.content }.getOrNull()
            val code = runCatching { parsed?.get("code")?.jsonPrimitive?.takeIf { it.isString }?.content }.getOrNull()
            return when {
                error == null -> "Request failed ($status)."
                code != null -> "$error [$code]"
                else -> error
            }
        }
    }
}
