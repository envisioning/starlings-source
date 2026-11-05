@file:OptIn(ExperimentalSerializationApi::class)

package work.starlings.android.keep

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// Wire shapes for Keep, mirroring core-kit `KeepKit/KeepModels.swift` and
// `envisioning/keep` `packages/contracts/src/index.ts`. Snake case on the
// wire. Read every type with the one rule in mind: a field is plaintext only
// when the server needs it to list, route or audit. Anything a person would
// call "the secret" arrives sealed.

object KeepSuite {
    const val CURRENT = "keep-v1"
    /** Fixed PRF salt: the passkey returns the same 32 bytes on every unlock. */
    const val PRF_SALT_LABEL = work.starlings.android.Deployment.KEEP_PRF_SALT_LABEL
    /** PBKDF2 rounds for the passphrase path. The server refuses fewer. */
    const val PBKDF2_ITERATIONS = 600_000
}

/**
 * Keep's JSON. Unknown keys are read past (a newer Keep may add a field);
 * a property with a default is left out when it holds the default, so an
 * optional field the contract wants as `null` has no default.
 */
val KeepJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    explicitNulls = true
}

/** AES-256-GCM output: a 12-byte IV and ciphertext with the 16-byte tag appended. */
@Serializable
data class KeepSealed(val iv: String, val ciphertext: String)

/** A symmetric key wrapped to a P-256 public key (ECIES). */
@Serializable
data class KeepWrappedKey(
    @SerialName("ephemeral_public_key") val ephemeralPublicKey: String,
    val iv: String,
    val ciphertext: String,
)

/**
 * How the private key is wrapped: by a passkey's PRF output (`method: prf`)
 * or a passphrase (`method: passphrase`). Swift's enum, flat, so the wire
 * object is the same; [KeepSession] refuses a method it does not know.
 */
@Serializable
data class KeepWrapParams(
    val method: String,
    @SerialName("credential_id") val credentialId: String? = null,
    @SerialName("hkdf_salt") val hkdfSalt: String? = null,
    @SerialName("pbkdf2_salt") val pbkdf2Salt: String? = null,
    @SerialName("pbkdf2_iterations") val pbkdf2Iterations: Int? = null,
) {
    val isPasskey: Boolean get() = method == PRF

    companion object {
        const val PRF = "prf"
        const val PASSPHRASE = "passphrase"
        fun prf(credentialId: String, hkdfSalt: String) = KeepWrapParams(PRF, credentialId = credentialId, hkdfSalt = hkdfSalt)
        fun passphrase(salt: String, iterations: Int) = KeepWrapParams(PASSPHRASE, pbkdf2Salt = salt, pbkdf2Iterations = iterations)
    }
}

@Serializable
data class KeepEnrolInput(
    val suite: String,
    @SerialName("public_key") val publicKey: String,
    @SerialName("wrapped_private_key") val wrappedPrivateKey: KeepSealed,
    val wrap: KeepWrapParams,
)

/** One way to unwrap the private key. A person may hold several. */
@Serializable
data class KeepKeyWrap(
    @SerialName("wrapped_private_key") val wrappedPrivateKey: KeepSealed,
    val wrap: KeepWrapParams,
)

@Serializable
data class KeepStaffKey(
    val email: String,
    val name: String,
    val suite: String,
    @SerialName("public_key") val publicKey: String,
    @SerialName("wrapped_private_key") val wrappedPrivateKey: KeepSealed,
    val wrap: KeepWrapParams,
    /** Every way this key can be unwrapped, enrolment first. One per method. */
    val wraps: List<KeepKeyWrap>,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
) {
    val passkeyWrap: KeepKeyWrap? get() = wraps.firstOrNull { it.wrap.isPasskey }
    val passphraseWrap: KeepKeyWrap? get() = wraps.firstOrNull { it.wrap.method == KeepWrapParams.PASSPHRASE }
}

@Serializable
data class KeepMe(
    val email: String,
    val name: String,
    val enrolled: Boolean,
    val key: KeepStaffKey? = null,
    @SerialName("core_web_origin") val coreWebOrigin: String,
)

@Serializable
data class KeepDirectoryEntry(
    val email: String,
    val name: String,
    @SerialName("public_key") val publicKey: String,
    @SerialName("enrolled_at") val enrolledAt: String,
)

@Serializable
data class KeepRecoveryKey(
    @SerialName("public_key") val publicKey: String,
    val holders: List<String>,
    @SerialName("created_by") val createdBy: String,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class KeepSetRecoveryInput(
    val suite: String,
    @SerialName("public_key") val publicKey: String,
    val holders: List<String>,
)

/** A vault as a recovering person sees it: name and members in the clear, the key sealed to the recovery key. */
@Serializable
data class KeepRecoveryVaultEntry(
    val id: String,
    val name: String,
    val icon: String? = null,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("key_version") val keyVersion: Int,
    @SerialName("member_count") val memberCount: Int,
    val members: List<String>,
    @SerialName("recovery_wrapped_key") val recoveryWrappedKey: KeepWrappedKey,
)

@Serializable
data class KeepMemberWrap(
    val email: String,
    @SerialName("wrapped_key") val wrappedKey: KeepWrappedKey,
)

/** `recovery_wrapped_key` and `project_id` go as null when absent: the server tells "none" from "missing". */
@Serializable
data class KeepCreateVaultInput(
    val name: String,
    val icon: String? = null,
    @SerialName("project_id") val projectId: String?,
    val members: List<KeepMemberWrap>,
    @SerialName("recovery_wrapped_key") val recoveryWrappedKey: KeepWrappedKey?,
)

@Serializable
data class KeepUpdateVaultInput(
    val name: String,
    val icon: String?,
    @SerialName("project_id") val projectId: String?,
)

@Serializable
data class KeepRotateItem(val id: String, val sealed: KeepSealed)

@Serializable
data class KeepRotateInput(
    @SerialName("key_version") val keyVersion: Int,
    val members: List<KeepMemberWrap>,
    @SerialName("recovery_wrapped_key") val recoveryWrappedKey: KeepWrappedKey?,
    val items: List<KeepRotateItem>,
)

/** The glyphs a vault can wear: core-kit's names, so every client draws the same set. */
object KeepVaultIcon {
    const val DEFAULT = "lock.square.stack"
    val choices: List<String> = listOf(
        "lock.square.stack", "folder", "building.2", "person.2", "globe", "server.rack",
        "cloud", "creditcard", "envelope", "key", "terminal", "antenna.radiowaves.left.and.right",
        "megaphone", "cart", "banknote", "shippingbox",
    )

    fun symbol(icon: String?): String = if (icon.isNullOrEmpty()) DEFAULT else icon
}

@Serializable
data class KeepVaultSummary(
    val id: String,
    val name: String,
    val icon: String? = null,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("key_version") val keyVersion: Int,
    /** This caller's wrapped copy of the current vault key. */
    @SerialName("wrapped_key") val wrappedKey: KeepWrappedKey,
    @SerialName("recovery_wrapped") val recoveryWrapped: Boolean,
    @SerialName("member_count") val memberCount: Int,
    @SerialName("item_count") val itemCount: Int,
    @SerialName("created_by") val createdBy: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
data class KeepVaultMember(
    val email: String,
    val name: String,
    @SerialName("granted_by") val grantedBy: String,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
enum class KeepItemKind(val label: String) {
    @SerialName("login") LOGIN("Login"),
    @SerialName("api_key") API_KEY("API key"),
    @SerialName("note") NOTE("Note"),
    @SerialName("database") DATABASE("Database"),
    @SerialName("ssh_key") SSH_KEY("SSH key"),
    @SerialName("other") OTHER("Other"),
}

@Serializable
data class KeepItemSummary(
    val id: String,
    @SerialName("vault_id") val vaultId: String,
    val name: String,
    val kind: KeepItemKind,
    @SerialName("key_version") val keyVersion: Int,
    @SerialName("created_by") val createdBy: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
    @SerialName("rotated_at") val rotatedAt: String? = null,
)

@Serializable
data class KeepItemDetail(
    val id: String,
    @SerialName("vault_id") val vaultId: String,
    val name: String,
    val kind: KeepItemKind,
    @SerialName("key_version") val keyVersion: Int,
    val sealed: KeepSealed,
)

@Serializable
data class KeepVaultDetail(
    val id: String,
    val name: String,
    val icon: String? = null,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("key_version") val keyVersion: Int,
    @SerialName("wrapped_key") val wrappedKey: KeepWrappedKey,
    @SerialName("member_count") val memberCount: Int,
    @SerialName("item_count") val itemCount: Int,
    @SerialName("created_by") val createdBy: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
    val members: List<KeepVaultMember>,
    @SerialName("recovery_wrapped") val recoveryWrapped: Boolean,
    val items: List<KeepItemSummary>,
)

/**
 * The plaintext inside a sealed item. Never sent to the server as such.
 * Field names and order are the contract's; every field defaults to empty,
 * as the contract's zod schema does, and is always written.
 */
@Serializable
data class KeepItemBody(
    @EncodeDefault val username: String = "",
    @EncodeDefault val password: String = "",
    @EncodeDefault val url: String = "",
    @EncodeDefault val notes: String = "",
    @EncodeDefault val totp: String = "",
) {
    override fun toString(): String = "KeepItemBody(…)"
}

@Serializable
data class KeepCreateItemInput(
    val id: String,
    val name: String,
    val kind: KeepItemKind,
    val sealed: KeepSealed,
    @SerialName("key_version") val keyVersion: Int,
)

@Serializable
data class KeepUpdateItemInput(
    val name: String? = null,
    val kind: KeepItemKind? = null,
    val sealed: KeepSealed? = null,
    @SerialName("key_version") val keyVersion: Int? = null,
)

@Serializable
data class KeepAuditEvent(
    val id: String,
    @SerialName("vault_id") val vaultId: String? = null,
    @SerialName("item_id") val itemId: String? = null,
    @SerialName("item_name") val itemName: String? = null,
    val actor: String,
    val kind: String,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class KeepDeviceToken(
    val id: String,
    val name: String,
    @SerialName("device_name") val deviceName: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("last_used_at") val lastUsedAt: String? = null,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("revoked_at") val revokedAt: String? = null,
)

// MARK: Releases (KeepRelease.swift)

/** How long a release may live. The approver picks; Keep refuses outside these. */
object KeepReleaseLimits {
    const val MIN_SECONDS = 60
    const val MAX_SECONDS = 24 * 60 * 60
    /** ADR 0007 decision 11. */
    const val DEFAULT_SECONDS = 15 * 60
}

@Serializable
data class KeepCreateReleaseInput(
    val id: String,
    @SerialName("item_id") val itemId: String,
    val agent: String,
    val task: String,
    val reason: String?,
    @SerialName("session_public_key") val sessionPublicKey: String,
    @SerialName("expires_in_seconds") val expiresInSeconds: Int,
    val sealed: KeepSealed,
    @SerialName("wrapped_key") val wrappedKey: KeepWrappedKey,
)

/** One release as a person sees it. Never the sealed body, never the wrap. */
@Serializable
data class KeepRelease(
    val id: String,
    @SerialName("vault_id") val vaultId: String,
    @SerialName("item_id") val itemId: String,
    @SerialName("item_name") val itemName: String,
    val agent: Agent,
    val approver: String,
    val task: String,
    val reason: String? = null,
    /** `live`, `used`, `ended` or `expired`. Open: a newer Keep may add one. */
    val status: String,
    @SerialName("created_at") val createdAt: String,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("fetched_at") val fetchedAt: String? = null,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("ended_by") val endedBy: String? = null,
) {
    @Serializable
    data class Agent(val address: String, val name: String)
}

/** What an agent asked for, as its card says it. The item is named, never valued. */
data class KeepReleaseRequest(
    /** The agent's request id: becomes the release id. Lowercase UUID. */
    val requestId: String,
    /** A vault id or name. */
    val vault: String,
    /** An item id or name. */
    val item: String,
    /** The agent's roster address. */
    val agent: String,
    val task: String,
    val reason: String?,
    /** Raw P-256 public key, base64url, the agent made for this request. */
    val sessionPublicKey: String,
)
