package work.starlings.android.keep

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.Normalizer
import java.util.UUID

/** Keep is locked: the private key is not in memory. */
class KeepLockedError : Exception("Keep is locked.")

/**
 * The key session: the one place a private key lives while Keep is open.
 * core-kit `KeepKit/KeepSession.swift`, with the same rules:
 *
 * - The private key is a JCA key object in memory. Not in the Keystore,
 *   not on disk, not in preferences. The process ending locks. So do
 *   fifteen idle minutes, measured on the elapsed-time clock, so a phone
 *   asleep past the deadline is locked when it wakes.
 * - Vault keys are unwrapped on demand and cached only while unlocked.
 * - Locking drops every reference. Plaintext a screen still holds is the
 *   screen's to drop, which is why the item screen clears on dispose.
 *
 * Everything that touches Keep from a screen goes through here, so a screen
 * never sees a key: it asks for a [KeepItemBody] and gets one, or an error.
 * Call it from the main thread; the slow crypto moves itself off it.
 */
class KeepSession(
    val client: KeepClient,
    private val scope: CoroutineScope,
    private val idleLockMs: Long = 15 * 60 * 1000L,
    private val clock: () -> Long = { android.os.SystemClock.elapsedRealtime() },
) {
    sealed interface State {
        /** No device token yet: the app has not brokered one. */
        data object Disconnected : State
        data object Loading : State
        /** Signed in, no key on the server yet. */
        data class Unenrolled(val me: KeepMe) : State
        /** Signed in and enrolled; private key not in memory. */
        data class Locked(val me: KeepMe) : State
        data class Unlocked(val me: KeepMe) : State
        data class Failed(val message: String) : State
    }

    var state: State by mutableStateOf(State.Disconnected)
        private set
    var vaults: List<KeepVaultSummary> by mutableStateOf(emptyList())
        private set
    /** False until the first list lands. */
    var vaultsLoaded by mutableStateOf(false)
        private set
    /** A message when the last list failed. */
    var vaultsError: String? by mutableStateOf(null)
        private set
    var recoveryKey: KeepRecoveryKey? by mutableStateOf(null)
        private set
    var recoveryLoaded by mutableStateOf(false)
        private set

    private var privateKey: KeepPrivateKey? = null
    private var publicKey: String? = null
    private val vaultKeys = HashMap<String, KeepSymmetricKey>()
    private var deadline = 0L
    private var idleJob: Job? = null

    val me: KeepMe?
        get() = when (val s = state) {
            is State.Unenrolled -> s.me
            is State.Locked -> s.me
            is State.Unlocked -> s.me
            else -> null
        }

    val isUnlocked: Boolean get() = state is State.Unlocked

    // MARK: Lifecycle

    /** Ask Keep who we are. Called when the token lands and on every open. */
    suspend fun refresh() {
        if (state is State.Disconnected) state = State.Loading
        try {
            val me = client.me()
            checkIdle()
            if (privateKey != null && me.enrolled && me.key?.publicKey == publicKey) {
                state = State.Unlocked(me)
                loadVaults()
            } else if (me.enrolled && me.key != null) {
                lock()
                state = State.Locked(me)
            } else {
                lock()
                state = State.Unenrolled(me)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: KeepClientError.MissingToken) {
            state = State.Disconnected
        } catch (e: Exception) {
            state = State.Failed(e.message ?: "Keep returned an invalid response.")
        }
    }

    fun disconnect() {
        lock()
        state = State.Disconnected
        vaults = emptyList()
        vaultsLoaded = false
        vaultsError = null
        recoveryKey = null
        recoveryLoaded = false
    }

    fun lock() {
        privateKey = null
        publicKey = null
        vaultKeys.clear()
        idleJob?.cancel()
        idleJob = null
        me?.let { state = if (it.enrolled) State.Locked(it) else State.Unenrolled(it) }
    }

    /** Any interaction with a Keep screen. Cheap; call it from a screen's start and from taps. */
    fun touch() {
        if (privateKey == null) return
        if (checkIdle()) return
        armIdleTimer()
    }

    /**
     * Locks when the idle deadline passed while the timer could not run (the
     * phone slept). True when it locked. Called on foreground and before
     * every use of the key.
     */
    fun checkIdle(): Boolean {
        if (privateKey == null || clock() < deadline) return false
        lock()
        return true
    }

    private fun armIdleTimer() {
        deadline = clock() + idleLockMs
        idleJob?.cancel()
        idleJob = scope.launch {
            while (true) {
                delay((deadline - clock()).coerceAtLeast(1_000))
                if (checkIdle() || privateKey == null) break
            }
        }
    }

    private suspend fun accept(key: KeepPrivateKey, own: String, me: KeepMe) {
        privateKey = key
        publicKey = own
        vaultKeys.clear()
        armIdleTimer()
        state = State.Unlocked(me)
        loadVaults()
    }

    // MARK: Enrol and unlock

    /** Enrol with a passphrase; the key is in hand afterwards, so this unlocks too. */
    suspend fun enrol(passphrase: String, replace: Boolean = false) {
        val (pair, sealed) = withContext(Dispatchers.Default) {
            val pair = KeepCrypto.generateStaffKeypair()
            pair to KeepCrypto.wrapPrivateKey(pair, passphrase)
        }
        client.enrol(KeepEnrolInput(KeepSuite.CURRENT, pair.publicKey, sealed.first, sealed.second), replace)
        val me = client.me()
        accept(pair, pair.publicKey, me)
    }

    /** Enrol with a passkey the caller has already made ([KeepPasskey.enrol]). */
    suspend fun enrol(passkey: KeepPasskeyEnrolment, replace: Boolean = false) {
        val (pair, sealed) = withContext(Dispatchers.Default) {
            val pair = KeepCrypto.generateStaffKeypair()
            pair to KeepCrypto.wrapPrivateKey(pair, passkey.prf, passkey.credentialId)
        }
        client.enrol(KeepEnrolInput(KeepSuite.CURRENT, pair.publicKey, sealed.first, sealed.second), replace)
        val me = client.me()
        accept(pair, pair.publicKey, me)
    }

    /** Whether this key holds a passphrase wrap. */
    val hasPassphrase: Boolean get() = me?.key?.passphraseWrap != null

    /** The credential id to ask the authenticator for, when the key holds a passkey wrap. */
    val passkeyCredentialId: String? get() = me?.key?.passkeyWrap?.wrap?.credentialId

    suspend fun unlock(passphrase: String) {
        val me = me ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val staffKey = me.key ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val entry = staffKey.passphraseWrap ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val salt = entry.wrap.pbkdf2Salt ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val iterations = entry.wrap.pbkdf2Iterations ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val key = withContext(Dispatchers.Default) {
            val wrapping = KeepCrypto.wrappingKey(passphrase, KeepCrypto.data(salt), iterations)
            KeepCrypto.unwrapPrivateKey(entry.wrappedPrivateKey, wrapping)
        }
        // A wrap that opens to some other key is no unlock.
        if (key.publicKey != staffKey.publicKey) throw KeepCryptoError(KeepCryptoError.Kind.CANNOT_OPEN)
        accept(key, staffKey.publicKey, me)
    }

    /** Unlock with a passkey's PRF output, for a client that can run the ceremony. */
    suspend fun unlock(prfOutput: ByteArray) {
        val me = me ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val staffKey = me.key ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val entry = staffKey.passkeyWrap ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val salt = entry.wrap.hkdfSalt ?: throw KeepCryptoError(KeepCryptoError.Kind.BAD_KEY)
        val key = KeepCrypto.unwrapPrivateKey(entry.wrappedPrivateKey, KeepCrypto.wrappingKey(prfOutput, KeepCrypto.data(salt)))
        if (key.publicKey != staffKey.publicKey) throw KeepCryptoError(KeepCryptoError.Kind.CANNOT_OPEN)
        accept(key, staffKey.publicKey, me)
    }

    /**
     * Seal the open private key under a passphrase and add it as a way to
     * unlock. Adding a second passphrase replaces the first on the server.
     */
    suspend fun addPassphrase(passphrase: String) {
        val (privateKey, _) = requireKeys()
        val (wrapped, wrap) = withContext(Dispatchers.Default) { KeepCrypto.wrapPrivateKey(privateKey, passphrase) }
        client.addWrap(KeepKeyWrap(wrapped, wrap))
        refresh()
    }

    /** Seal the open private key under a passkey's PRF output and add it. */
    suspend fun addPasskey(passkey: KeepPasskeyEnrolment) {
        val (privateKey, _) = requireKeys()
        val (wrapped, wrap) = KeepCrypto.wrapPrivateKey(privateKey, passkey.prf, passkey.credentialId)
        client.addWrap(KeepKeyWrap(wrapped, wrap))
        refresh()
    }

    // MARK: Vault keys

    private fun requireKeys(): Pair<KeepPrivateKey, String> {
        checkIdle()
        val key = privateKey ?: throw KeepLockedError()
        val own = publicKey ?: throw KeepLockedError()
        touch()
        return key to own
    }

    /** Raw vault key bytes: needed to wrap it to a colleague. Never cached. */
    private fun vaultKeyBytes(wrapped: KeepWrappedKey): ByteArray {
        val (key, own) = requireKeys()
        return KeepCrypto.unwrapKey(wrapped, key, own)
    }

    private fun vaultKey(vaultId: String, keyVersion: Int, wrapped: KeepWrappedKey): KeepSymmetricKey {
        val cacheKey = "$vaultId:$keyVersion"
        vaultKeys[cacheKey]?.let {
            requireKeys()
            return it
        }
        return KeepCrypto.vaultKey(vaultKeyBytes(wrapped)).also { vaultKeys[cacheKey] = it }
    }

    private fun forgetVaultKeys(vaultId: String) {
        vaultKeys.keys.removeAll { it.startsWith("$vaultId:") }
    }

    // MARK: Vaults

    suspend fun loadVaults() {
        try {
            vaults = client.vaults()
            vaultsLoaded = true
            vaultsError = null
            coverUncoveredVaults()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            vaultsError = e.message
        }
    }

    suspend fun loadRecoveryKey() {
        recoveryKey = try {
            client.recoveryKey()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        recoveryLoaded = true
    }

    /**
     * The recovery rule, kept without asking: a vault made before the
     * recovery key existed gets its recovery wrap the first time a member
     * with the key open lists their vaults. Quiet; the audit row says it.
     */
    private suspend fun coverUncoveredVaults() {
        if (privateKey == null) return
        val uncovered = vaults.filter { !it.recoveryWrapped }
        if (uncovered.isEmpty()) return
        loadRecoveryKey()
        val recovery = recoveryKey ?: return
        var changed = false
        for (vault in uncovered) {
            val wrapped = runCatching { KeepCrypto.wrapKey(vaultKeyBytes(vault.wrappedKey), recovery.publicKey) }.getOrNull() ?: continue
            try {
                client.coverVault(vault.id, wrapped)
                changed = true
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
        if (changed) runCatching { client.vaults() }.getOrNull()?.let { vaults = it }
    }

    /** The two shares of a new recovery key, each shown once. */
    class RecoveryShares(val a: String, val b: String) {
        override fun toString(): String = "RecoveryShares(…)"
    }

    /**
     * The ceremony: a keypair, its private half split in two, the public
     * half published with the holders' names. The shares are returned once
     * and never kept; the private key is dropped with this call.
     */
    suspend fun createRecoveryKey(holders: List<String>): RecoveryShares {
        val pair = KeepCrypto.generateStaffKeypair()
        val pkcs8 = KeepCrypto.exportPrivateKey(pair)
        val (a, b) = KeepCrypto.splitSecret(pkcs8)
        pkcs8.fill(0)
        recoveryKey = client.setRecoveryKey(KeepSetRecoveryInput(KeepSuite.CURRENT, pair.publicKey, holders))
        recoveryLoaded = true
        coverUncoveredVaults()
        return RecoveryShares(KeepCrypto.formatShare("A", a), KeepCrypto.formatShare("B", b))
    }

    /**
     * The recovery private key from the two shares, checked against the
     * published public key so a wrong share fails here, not on a vault.
     */
    suspend fun recoveryPrivateKey(shareA: String, shareB: String): KeepPrivateKey {
        val key = recoveryKeyFromShares(shareA, shareB)
        loadRecoveryKey()
        val published = recoveryKey
        if (published == null || key.publicKey != published.publicKey) throw KeepCryptoError(KeepCryptoError.Kind.CANNOT_OPEN)
        return key
    }

    /** Every covered vault, for a person holding both shares. */
    suspend fun recoveryVaults(): List<KeepRecoveryVaultEntry> = client.recoveryVaults()

    /** Open one vault's key with the recovery private key and join it. */
    suspend fun recover(entry: KeepRecoveryVaultEntry, recoveryKey: KeepPrivateKey) {
        val staffKey = me?.key ?: throw KeepLockedError()
        val published = this.recoveryKey?.publicKey ?: recoveryKey.publicKey
        val vaultKeyBytes = KeepCrypto.unwrapKey(entry.recoveryWrappedKey, recoveryKey, published)
        val mine = KeepCrypto.wrapKey(vaultKeyBytes, staffKey.publicKey)
        vaultKeyBytes.fill(0)
        client.recoveryJoin(entry.id, mine)
        loadVaults()
    }

    /** A fresh vault key wrapped to me, the chosen colleagues, and recovery. */
    suspend fun createVault(name: String, icon: String? = null, projectId: String?, members: List<KeepDirectoryEntry>): KeepVaultDetail {
        val (_, own) = requireKeys()
        val me = me ?: throw KeepLockedError()
        val key = KeepCrypto.generateVaultKey()
        val wraps = mutableListOf(KeepMemberWrap(me.email, KeepCrypto.wrapKey(key, own)))
        for (member in members) if (member.email != me.email) wraps += KeepMemberWrap(member.email, KeepCrypto.wrapKey(key, member.publicKey))
        val recovery = client.recoveryKey()
        val recoveryWrap = recovery?.let { KeepCrypto.wrapKey(key, it.publicKey) }
        val vault = client.createVault(KeepCreateVaultInput(name = name, icon = icon, projectId = projectId, members = wraps, recoveryWrappedKey = recoveryWrap))
        loadVaults()
        return vault
    }

    /** The vault for a Core project, among the ones this person can open. */
    fun vault(forProject: String): KeepVaultSummary? = vaults.firstOrNull { it.projectId == forProject }

    /**
     * The project's vault, made if there is none: named after the project,
     * with only this person as a member. Colleagues are added from Members.
     */
    suspend fun ensureVault(forProject: String, named: String): String {
        if (!vaultsLoaded) loadVaults()
        vault(forProject)?.let { return it.id }
        return createVault(named, projectId = forProject, members = emptyList()).id
    }

    suspend fun updateVault(vault: KeepVaultDetail, name: String, icon: String?, projectId: String?): KeepVaultDetail {
        val detail = client.updateVault(vault.id, name, icon, projectId)
        loadVaults()
        return detail
    }

    suspend fun grant(vault: KeepVaultDetail, entry: KeepDirectoryEntry): KeepVaultDetail {
        val keyBytes = vaultKeyBytes(vault.wrappedKey)
        val detail = client.grant(vault.id, KeepMemberWrap(entry.email, KeepCrypto.wrapKey(keyBytes, entry.publicKey)))
        loadVaults()
        return detail
    }

    /**
     * Removing someone is a new vault key: open every item under the old
     * key, seal it under the new, wrap the new key to everyone who stays and
     * to recovery, and send it as one rotation.
     */
    suspend fun revoke(vault: KeepVaultDetail, email: String, directory: List<KeepDirectoryEntry>): KeepVaultDetail {
        val oldKey = vaultKey(vault.id, vault.keyVersion, vault.wrappedKey)
        val newKeyBytes = KeepCrypto.generateVaultKey()
        val newKey = KeepCrypto.vaultKey(newKeyBytes)
        val nextVersion = vault.keyVersion + 1

        val items = vault.items.map { summary ->
            val detail = client.reveal(vault.id, summary.id)
            val body = KeepCrypto.openItem(detail.sealed, oldKey, vault.id, summary.id, detail.keyVersion)
            KeepRotateItem(summary.id, KeepCrypto.sealItem(body, newKey, vault.id, summary.id, nextVersion))
        }

        val keys = directory.associate { it.email to it.publicKey }
        val members = vault.members.filter { it.email != email }.map { member ->
            val publicKey = keys[member.email]
                ?: throw KeepClientError.Api(400, "not_enrolled", "${member.email} is no longer enrolled; remove them first.")
            KeepMemberWrap(member.email, KeepCrypto.wrapKey(newKeyBytes, publicKey))
        }
        val recovery = client.recoveryKey()
        val recoveryWrap = recovery?.let { KeepCrypto.wrapKey(newKeyBytes, it.publicKey) }

        val detail = client.rotate(vault.id, KeepRotateInput(nextVersion, members, recoveryWrap, items))
        forgetVaultKeys(vault.id)
        loadVaults()
        return detail
    }

    suspend fun deleteVault(vault: KeepVaultDetail) {
        client.deleteVault(vault.id)
        forgetVaultKeys(vault.id)
        loadVaults()
    }

    // MARK: Items

    /** Reveal: one fetch (audited), opened here, returned as plaintext. */
    suspend fun open(item: KeepItemSummary, vault: KeepVaultDetail): KeepItemBody {
        val detail = client.reveal(vault.id, item.id)
        val key = vaultKey(vault.id, vault.keyVersion, vault.wrappedKey)
        return KeepCrypto.openItem(detail.sealed, key, vault.id, item.id, detail.keyVersion)
    }

    suspend fun createItem(name: String, kind: KeepItemKind, body: KeepItemBody, vault: KeepVaultDetail): KeepItemDetail {
        val key = vaultKey(vault.id, vault.keyVersion, vault.wrappedKey)
        val id = UUID.randomUUID().toString().lowercase()
        val sealed = KeepCrypto.sealItem(body, key, vault.id, id, vault.keyVersion)
        val detail = client.createItem(vault.id, KeepCreateItemInput(id, name, kind, sealed, vault.keyVersion))
        loadVaults()
        return detail
    }

    suspend fun updateItem(item: KeepItemSummary, name: String, kind: KeepItemKind, body: KeepItemBody, vault: KeepVaultDetail): KeepItemDetail {
        val key = vaultKey(vault.id, vault.keyVersion, vault.wrappedKey)
        val sealed = KeepCrypto.sealItem(body, key, vault.id, item.id, vault.keyVersion)
        return client.updateItem(vault.id, item.id, KeepUpdateItemInput(name, kind, sealed, vault.keyVersion))
    }

    suspend fun deleteItem(item: KeepItemSummary, vault: KeepVaultDetail) {
        client.deleteItem(vault.id, item.id)
        loadVaults()
    }

    // MARK: Releases (KeepRelease.swift)

    /**
     * The vault and the item a request names, among this person's vaults: by
     * id first, then by name (case and accents ignored).
     */
    suspend fun resolveRelease(request: KeepReleaseRequest): Pair<KeepVaultDetail, KeepItemSummary> {
        if (!vaultsLoaded) loadVaults()
        val vaultRef = request.vault.trim()
        val byVaultId = vaults.firstOrNull { it.id == vaultRef.lowercase() }
        val byVaultName = vaults.filter { sameName(it.name, vaultRef) }
        val summary = byVaultId ?: byVaultName.firstOrNull() ?: throw KeepReleaseError(KeepReleaseError.Kind.VAULT_NOT_FOUND)
        if (byVaultId == null && byVaultName.size > 1) throw KeepReleaseError(KeepReleaseError.Kind.VAULT_AMBIGUOUS)
        val vault = client.vault(summary.id)
        val itemRef = request.item.trim()
        val byItemId = vault.items.firstOrNull { it.id == itemRef.lowercase() }
        val byItemName = vault.items.filter { sameName(it.name, itemRef) }
        val item = byItemId ?: byItemName.firstOrNull() ?: throw KeepReleaseError(KeepReleaseError.Kind.ITEM_NOT_FOUND)
        if (byItemId == null && byItemName.size > 1) throw KeepReleaseError(KeepReleaseError.Kind.ITEM_AMBIGUOUS)
        return vault to item
    }

    /**
     * Approve: reveal the item (audited as this person's reveal), open it
     * here, seal it to the agent's session key, and post the release.
     */
    suspend fun release(request: KeepReleaseRequest, vault: KeepVaultDetail, item: KeepItemSummary, expiresInSeconds: Int): KeepRelease {
        val body = open(item, vault)
        val releaseId = request.requestId.lowercase()
        val (sealed, wrapped) = KeepCrypto.sealRelease(body, request.sessionPublicKey, releaseId, vault.id, item.id)
        val seconds = expiresInSeconds.coerceIn(KeepReleaseLimits.MIN_SECONDS, KeepReleaseLimits.MAX_SECONDS)
        return client.createRelease(
            vault.id,
            KeepCreateReleaseInput(releaseId, item.id, request.agent.lowercase(), request.task, request.reason, request.sessionPublicKey, seconds, sealed, wrapped),
        )
    }

    /** End a release now. Needs only the token: ending opens nothing. */
    suspend fun endRelease(vaultId: String, releaseId: String): KeepRelease = client.endRelease(vaultId, releaseId.lowercase())

    companion object {
        /** Both shares, either order, joined into the PKCS#8 they split. One share twice is refused. */
        internal fun recoveryKeyFromShares(shareA: String, shareB: String): KeepPrivateKey {
            val (labelA, bytesA) = KeepCrypto.parseShare(shareA)
            val (labelB, bytesB) = KeepCrypto.parseShare(shareB)
            if (labelA == labelB) throw KeepCryptoError(KeepCryptoError.Kind.BAD_ENCODING)
            val pkcs8 = if (labelA == "A") KeepCrypto.joinShares(bytesA, bytesB) else KeepCrypto.joinShares(bytesB, bytesA)
            return try {
                KeepCrypto.importPrivateKey(pkcs8)
            } finally {
                pkcs8.fill(0)
            }
        }

        internal fun sameName(lhs: String, rhs: String): Boolean = fold(lhs) == fold(rhs)

        private fun fold(s: String): String =
            Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase()
    }
}

class KeepReleaseError(val kind: Kind) : Exception(kind.message) {
    enum class Kind(val message: String) {
        VAULT_NOT_FOUND("None of your vaults matches this request."),
        VAULT_AMBIGUOUS("Two of your vaults have this name. The agent must name the vault by its id."),
        ITEM_NOT_FOUND("The vault has no item that matches this request."),
        ITEM_AMBIGUOUS("Two items in the vault have this name. The agent must name the item by its id."),
    }
}
