package work.starlings.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * A signed-in owner on one workspace: the pair `/api/auth/native/exchange`, `/redeem` and
 * `/api/auth/refresh` answer (`ownerSessionResponseSchema`). The sign-in flow
 * that first fills it is not chosen yet (docs/ANDROID_PORT_PLAN.md §3); this
 * is the part every flow needs.
 */
@Serializable
data class OwnerCredentials(
    val accessToken: String,
    /** Single-use: the Worker rotates it on every renewal. */
    val refreshToken: String?,
    val sub: String,
    val email: String,
    val name: String,
)

/** `Sources/OwnerAccessToken.swift`: the JWT's own `exp`, never an assumed lifetime. */
object OwnerAccessToken {
    /** Renew when under an hour is left. */
    const val RENEW_LEAD_S = 3_600L

    /** `exp` in Unix seconds, or null when the token cannot be read. */
    fun expiry(accessToken: String): Long? {
        val parts = accessToken.split('.')
        if (parts.size != 3) return null
        return runCatching {
            val payload = String(Base64.getUrlDecoder().decode(parts[1].trimEnd('=')))
            Json.parseToJsonElement(payload).jsonObject["exp"]?.jsonPrimitive?.let { it.longOrNull ?: it.content.toDouble().toLong() }
        }.getOrNull()
    }

    /** Under an hour left, or unreadable: renew now. */
    fun expiresSoon(accessToken: String, nowS: Long): Boolean {
        val exp = expiry(accessToken) ?: return true
        return exp - nowS < RENEW_LEAD_S
    }
}

/** Where one workspace's pair and device id live. */
interface SessionVault {
    fun load(): OwnerCredentials?
    fun save(credentials: OwnerCredentials)
    fun clear()
    /** One per install and workspace; a restored backup never carries it. */
    fun deviceId(): String
}

enum class SessionRenewal { NOTHING_TO_RENEW, STILL_VALID, RENEWED, REFUSED, UNAVAILABLE }

/** A refresh the Worker answered with a status, as opposed to never answering. */
class ServiceStatus(val status: Int) : Exception("HTTP $status")

/**
 * The renewal rules of `StarlingsAppModel.renewSessionIfNeeded` on iOS. One
 * renewal at a time. The renewed pair is saved before it is used, because
 * the spent refresh token is refused from then on. Only a 401 or 403 from the
 * Worker signs the person out; offline or a server error keeps the session.
 */
class OwnerSessionRenewer(
    private val vault: SessionVault,
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
    private val refresh: suspend (refreshToken: String, deviceId: String) -> OwnerCredentials,
) {
    private val lock = Mutex()

    suspend fun renewIfNeeded(force: Boolean = false): SessionRenewal = lock.withLock {
        val current = vault.load() ?: return SessionRenewal.NOTHING_TO_RENEW
        val token = current.refreshToken ?: return SessionRenewal.NOTHING_TO_RENEW
        if (!force && !OwnerAccessToken.expiresSoon(current.accessToken, clock())) return SessionRenewal.STILL_VALID
        val renewed = try {
            refresh(token, vault.deviceId())
        } catch (e: ServiceStatus) {
            if (isRefusal(e.status)) { vault.clear(); return SessionRenewal.REFUSED }
            return SessionRenewal.UNAVAILABLE
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            return SessionRenewal.UNAVAILABLE
        }
        vault.save(renewed)
        SessionRenewal.RENEWED
    }

    /**
     * A request was refused with the stored token: renew once before asking
     * anyone to sign in. Returns true when the person must sign in again.
     */
    suspend fun handleRejected(): Boolean = when (renewIfNeeded(force = true)) {
        SessionRenewal.NOTHING_TO_RENEW -> { vault.clear(); true }
        SessionRenewal.REFUSED -> true
        else -> false
    }

    companion object {
        /** `StarlingsError.isSessionRefusal`: the Worker refused the token, as opposed to being unreachable. */
        fun isRefusal(status: Int) = status == 401 || status == 403
    }
}

/**
 * Android Keystore storage for one workspace. The pair is AES-GCM sealed
 * under a non-exportable Keystore key and written to `noBackupFilesDir`, as
 * is the device id, so neither a cloud backup nor a device transfer can
 * clone the session onto a second install. Each workspace has its own file:
 * switching accounts never reads another workspace's pair.
 */
class KeystoreSessionVault(context: Context, workspaceOrigin: String) : SessionVault {
    private val dir = File(context.noBackupFilesDir, "sessions").apply { mkdirs() }
    private val name = sha256(workspaceOrigin)
    private val sealed = File(dir, "$name.bin")
    private val device = File(dir, "$name.device")

    override fun load(): OwnerCredentials? {
        if (!sealed.exists()) return null
        return runCatching {
            val bytes = sealed.readBytes()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
            Json.decodeFromString<OwnerCredentials>(String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES)))
        }.getOrNull()
    }

    override fun save(credentials: OwnerCredentials) {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val body = cipher.doFinal(Json.encodeToString(OwnerCredentials.serializer(), credentials).toByteArray())
        val temp = File(dir, "$name.tmp")
        temp.writeBytes(cipher.iv + body)
        if (!temp.renameTo(sealed)) error("session: could not replace the stored pair")
    }

    override fun clear() {
        sealed.delete()
    }

    override fun deviceId(): String {
        if (device.exists()) return device.readText()
        return UUID.randomUUID().toString().also { device.writeText(it) }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "owner-session"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12

        fun sha256(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
