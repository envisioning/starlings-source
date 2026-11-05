package work.starlings.android.keep

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
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

/**
 * Why a Keep request failed: core-kit `KeepClientError`. The message is the
 * one iOS shows; [Api] carries Keep's own sentence, as iOS shows it.
 */
sealed class KeepClientError(message: String) : Exception(message) {
    class MissingToken : KeepClientError("Connect Keep first.")
    class InvalidResponse : KeepClientError("Keep returned an invalid response.")
    class Unauthorized : KeepClientError("Keep no longer accepts this device's token. Reconnect in Settings.")
    /** The vault's key moved under the client. Reload, seal again. */
    class StaleRotation(message: String) : KeepClientError(message)
    class Api(val status: Int, val code: String?, message: String) : KeepClientError(message)
    class Offline(cause: IOException) : KeepClientError("Keep could not be reached.") {
        init { initCause(cause) }
    }
}

/**
 * The device's line to Keep: core-kit `KeepKit/KeepClient.swift`. A base
 * URL and a closure that yields the current bearer; the token itself lives
 * in [KeepTokenStore], never here.
 *
 * Every method moves ciphertext or metadata. Nothing in this file can open
 * anything; that is [KeepCrypto], driven by [KeepSession]. Nothing here logs
 * a request or a response body.
 */
class KeepClient(
    private val baseUrl: () -> HttpUrl?,
    private val tokenProvider: () -> String?,
    private val http: OkHttpClient = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).followRedirects(false).build(),
) {
    /** KeepKit's `relyingPartyIdentifier`: the Keep host, which is the passkey relying party. */
    val relyingPartyIdentifier: String get() = baseUrl()?.host ?: work.starlings.android.Deployment.KEEP_WORKER_HOST

    // MARK: Identity and keys

    suspend fun me(): KeepMe = request("GET", "/api/me", answer = KeepMe.serializer())

    suspend fun enrol(input: KeepEnrolInput, replace: Boolean = false): KeepStaffKey =
        request("PUT", "/api/keys/me", if (replace) listOf("replace" to "1") else emptyList(), body(KeepEnrolInput.serializer(), input), KeepStaffKey.serializer())

    /** Add a way to unwrap: the same private key, sealed under another method. */
    suspend fun addWrap(wrap: KeepKeyWrap): KeepStaffKey =
        request("POST", "/api/keys/me/wraps", body = body(KeepKeyWrap.serializer(), wrap), answer = KeepStaffKey.serializer())

    suspend fun directory(): List<KeepDirectoryEntry> =
        request("GET", "/api/keys/directory", answer = DirectoryEnvelope.serializer()).entries

    suspend fun recoveryKey(): KeepRecoveryKey? =
        request("GET", "/api/recovery", answer = RecoveryEnvelope.serializer()).recovery

    /** A member adds the recovery wrap a vault made before the key existed is missing. */
    suspend fun coverVault(vaultId: String, recoveryWrappedKey: KeepWrappedKey): KeepVaultDetail =
        request("POST", "/api/vaults/${seg(vaultId)}/recovery", body = body(CoverBody.serializer(), CoverBody(recoveryWrappedKey)), answer = KeepVaultDetail.serializer())

    suspend fun setRecoveryKey(input: KeepSetRecoveryInput): KeepRecoveryKey =
        request("PUT", "/api/recovery", body = body(KeepSetRecoveryInput.serializer(), input), answer = KeepRecoveryKey.serializer())

    /** Every covered vault with its recovery wrap. Audited server-side. */
    suspend fun recoveryVaults(): List<KeepRecoveryVaultEntry> =
        request("GET", "/api/recovery/vaults", answer = RecoveryVaultsEnvelope.serializer()).vaults

    /** Join a vault opened through recovery. Audited server-side, loudly. */
    suspend fun recoveryJoin(vaultId: String, wrappedKey: KeepWrappedKey) {
        request<Unit>("POST", "/api/recovery/vaults/${seg(vaultId)}/join", body = body(JoinBody.serializer(), JoinBody(wrappedKey)), answer = null)
    }

    // MARK: Vaults

    suspend fun vaults(): List<KeepVaultSummary> = request("GET", "/api/vaults", answer = VaultsEnvelope.serializer()).vaults

    suspend fun vault(id: String): KeepVaultDetail = request("GET", "/api/vaults/${seg(id)}", answer = KeepVaultDetail.serializer())

    suspend fun createVault(input: KeepCreateVaultInput): KeepVaultDetail =
        request("POST", "/api/vaults", body = body(KeepCreateVaultInput.serializer(), input), answer = KeepVaultDetail.serializer())

    suspend fun updateVault(id: String, name: String, icon: String?, projectId: String?): KeepVaultDetail =
        request("PATCH", "/api/vaults/${seg(id)}", body = body(KeepUpdateVaultInput.serializer(), KeepUpdateVaultInput(name, icon, projectId)), answer = KeepVaultDetail.serializer())

    suspend fun deleteVault(id: String) {
        request<Unit>("DELETE", "/api/vaults/${seg(id)}", answer = null)
    }

    suspend fun grant(vaultId: String, member: KeepMemberWrap): KeepVaultDetail =
        request("POST", "/api/vaults/${seg(vaultId)}/members", body = body(KeepMemberWrap.serializer(), member), answer = KeepVaultDetail.serializer())

    suspend fun rotate(vaultId: String, input: KeepRotateInput): KeepVaultDetail =
        request("POST", "/api/vaults/${seg(vaultId)}/rotate", body = body(KeepRotateInput.serializer(), input), answer = KeepVaultDetail.serializer())

    suspend fun audit(vaultId: String): List<KeepAuditEvent> =
        request("GET", "/api/vaults/${seg(vaultId)}/audit", answer = EventsEnvelope.serializer()).events

    suspend fun recentAudit(): List<KeepAuditEvent> = request("GET", "/api/audit", answer = EventsEnvelope.serializer()).events

    // MARK: Items

    suspend fun createItem(vaultId: String, input: KeepCreateItemInput): KeepItemDetail =
        request("POST", "/api/vaults/${seg(vaultId)}/items", body = body(KeepCreateItemInput.serializer(), input), answer = KeepItemDetail.serializer())

    /** The reveal: one ciphertext, one audit row under this person's name. */
    suspend fun reveal(vaultId: String, itemId: String): KeepItemDetail =
        request("GET", "/api/vaults/${seg(vaultId)}/items/${seg(itemId)}", answer = KeepItemDetail.serializer())

    suspend fun updateItem(vaultId: String, itemId: String, input: KeepUpdateItemInput): KeepItemDetail =
        request("PATCH", "/api/vaults/${seg(vaultId)}/items/${seg(itemId)}", body = body(KeepUpdateItemInput.serializer(), input), answer = KeepItemDetail.serializer())

    suspend fun deleteItem(vaultId: String, itemId: String) {
        request<Unit>("DELETE", "/api/vaults/${seg(vaultId)}/items/${seg(itemId)}", answer = null)
    }

    // MARK: Devices

    suspend fun deviceTokens(): List<KeepDeviceToken> = request("GET", "/api/tokens", answer = TokensEnvelope.serializer()).tokens

    suspend fun revokeDeviceToken(id: String) {
        request<Unit>("DELETE", "/api/tokens/${seg(id)}", answer = null)
    }

    // MARK: Releases (KeepRelease.swift)

    suspend fun createRelease(vaultId: String, input: KeepCreateReleaseInput): KeepRelease =
        request("POST", "/api/vaults/${seg(vaultId)}/releases", body = body(KeepCreateReleaseInput.serializer(), input), answer = KeepRelease.serializer())

    /** One release's state. Never its payload. */
    suspend fun release(vaultId: String, releaseId: String): KeepRelease =
        request("GET", "/api/vaults/${seg(vaultId)}/releases/${seg(releaseId)}", answer = KeepRelease.serializer())

    /** End now. Any member may; ending a closed release changes nothing. */
    suspend fun endRelease(vaultId: String, releaseId: String): KeepRelease =
        request("POST", "/api/vaults/${seg(vaultId)}/releases/${seg(releaseId)}/end", answer = KeepRelease.serializer())

    // MARK: Plumbing

    @Serializable private data class DirectoryEnvelope(val entries: List<KeepDirectoryEntry>)
    @Serializable private data class RecoveryEnvelope(val recovery: KeepRecoveryKey? = null)
    @Serializable private data class VaultsEnvelope(val vaults: List<KeepVaultSummary>)
    @Serializable private data class EventsEnvelope(val events: List<KeepAuditEvent>)
    @Serializable private data class TokensEnvelope(val tokens: List<KeepDeviceToken>)
    @Serializable private data class RecoveryVaultsEnvelope(val vaults: List<KeepRecoveryVaultEntry>)
    @Serializable private data class JoinBody(@kotlinx.serialization.SerialName("wrapped_key") val wrappedKey: KeepWrappedKey)
    @Serializable private data class CoverBody(@kotlinx.serialization.SerialName("recovery_wrapped_key") val recoveryWrappedKey: KeepWrappedKey)

    private fun <T> body(serializer: KSerializer<T>, value: T): String = KeepJson.encodeToString(serializer, value)

    /** One path segment, percent-encoded on its own. */
    private fun seg(value: String): String = HttpUrl.Builder().scheme("https").host("x").addPathSegment(value).build().encodedPath.removePrefix("/")

    private suspend fun <A> request(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
        answer: KSerializer<A>?,
    ): A {
        val token = tokenProvider()?.takeIf { it.isNotEmpty() } ?: throw KeepClientError.MissingToken()
        val base = baseUrl() ?: throw KeepClientError.MissingToken()
        val url = (base.toString().trimEnd('/') + path).toHttpUrlOrNull()?.newBuilder()?.apply {
            query.forEach { (k, v) -> addQueryParameter(k, v) }
        }?.build() ?: throw KeepClientError.InvalidResponse()
        val json = "application/json".toMediaType()
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .method(method, body?.toRequestBody(json) ?: if (method == "POST" || method == "PUT" || method == "PATCH") "".toRequestBody(json) else null)
            .build()
        val (status, text) = withContext(Dispatchers.IO) {
            try {
                http.newCall(request).execute().use { it.code to (it.body?.string() ?: "") }
            } catch (e: IOException) {
                throw KeepClientError.Offline(e)
            }
        }
        if (status !in 200..299) {
            val parsed = runCatching { KeepJson.parseToJsonElement(text).jsonObject }.getOrNull()
            val code = parsed.field("code")
            val error = parsed.field("error")
            throw when {
                status == 401 -> KeepClientError.Unauthorized()
                status == 409 && code == "stale_rotation" -> KeepClientError.StaleRotation(error ?: "The vault changed; reload.")
                else -> KeepClientError.Api(status, code, error ?: "Keep answered $status.")
            }
        }
        @Suppress("UNCHECKED_CAST")
        if (answer == null) return Unit as A
        return try {
            KeepJson.decodeFromString(answer, text)
        } catch (_: Exception) {
            throw KeepClientError.InvalidResponse()
        }
    }

    private fun JsonObject?.field(name: String): String? =
        runCatching { this?.get(name)?.jsonPrimitive?.takeIf { it.isString }?.content }.getOrNull()
}
