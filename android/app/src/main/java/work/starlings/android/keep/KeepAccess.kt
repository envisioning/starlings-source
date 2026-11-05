package work.starlings.android.keep

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import work.starlings.android.Account
import work.starlings.android.SealedFile
import work.starlings.android.StarlingsApp
import work.starlings.android.api.KeepRoutes
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.deviceName
import work.starlings.contracts.KeepTokenResponse
import java.time.Instant

/**
 * The token this device holds for Keep, as stored: `KeepCredential` in
 * `Sources/KeepAccess.swift`. Stamped with the Starlings API that brokered
 * it and the Keep it is for, so a token minted for another Keep is never
 * presented to this one.
 */
@Serializable
data class KeepCredential(
    val token: String,
    @SerialName("expires_at") val expiresAt: String,
    val email: String,
    @SerialName("api_endpoint") val apiEndpoint: String,
    @SerialName("keep_origin") val keepOrigin: String,
) {
    /** Renew inside the last week; an unreadable expiry renews now. */
    fun expiresSoon(nowMs: Long = System.currentTimeMillis()): Boolean {
        val expiry = runCatching { Instant.parse(expiresAt).toEpochMilli() }.getOrNull() ?: return true
        return expiry - nowMs < 7L * 24 * 60 * 60 * 1000
    }

    override fun toString(): String = "KeepCredential(email=$email, expiresAt=$expiresAt)"
}

/**
 * Where the Keep token lives: one [SealedFile],
 * `noBackupFilesDir/keep/<sha256(api)>.bin` under its own Keystore key
 * (`keep-token`), the mechanism `KeystoreSessionVault` (OwnerSession.kt)
 * uses for the owner session, which is also what carries Docs on Android.
 * The token is the only thing Keep ever writes to disk: the private key is
 * memory.
 */
class KeepTokenStore(context: Context, private val apiEndpoint: String) {
    private val file = SealedFile(context, "keep", SealedFile.nameFor(apiEndpoint), "keep-token")

    fun load(keepOrigin: String): KeepCredential? {
        val bytes = file.read() ?: return null
        return runCatching { KeepJson.decodeFromString(KeepCredential.serializer(), String(bytes)) }
            .getOrNull()?.takeIf { it.apiEndpoint == apiEndpoint && it.keepOrigin == keepOrigin }
    }

    fun save(credential: KeepCredential) {
        file.write(KeepJson.encodeToString(KeepCredential.serializer(), credential).toByteArray())
    }

    fun clear() {
        file.delete()
    }
}

/**
 * This device's standing with Keep: `Sources/KeepAccess.swift` and
 * `iOS/MobileKeepAccess.swift`. The token half is here; the key half is
 * [session], which holds the unlocked private key in memory until it locks.
 *
 * The Worker proves the owner to Keep and Keep mints a token for this
 * device; from then on the device talks to Keep directly and does every
 * cryptographic operation itself. Keep comes with the Starlings session:
 * signing in links it, signing out drops it, and there is no Connect row.
 *
 * Only where the workspace has Keep: the descriptor's
 * `services.keep` names the origin. Null hides every Keep entry and drops
 * the token. Before the descriptor is read, the build's own workspace keeps
 * KeepKit's host, as `StarlingsWorkspace.origin(of:builtInDefault:)`.
 */
class KeepAccess private constructor(private val app: StarlingsApp) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val prefs = app.getSharedPreferences("keep", Context.MODE_PRIVATE)

    /** One per workspace (slice E): the account, the token and the Keep origin are this workspace's. */
    private val account = app.account
    private val workspace = account.workspace
    private val originKey = workspace.scopedKey(ORIGIN_KEY)
    private val store = KeepTokenStore(app, workspace.apiOrigin)
    private var foreground: DefaultLifecycleObserver? = null

    /** Before a descriptor says, the build's own workspace keeps KeepKit's host; any other has no Keep. */
    private val builtInDefault: String? = BUILT_IN_ORIGIN.takeIf { workspace.isBuiltIn }

    /** The Keep this workspace names, or null when it has none. */
    var origin: String? by mutableStateOf(storedOrigin())
        private set

    var credential: KeepCredential? by mutableStateOf(null)
        private set
    var isLinking by mutableStateOf(false)
        private set
    var errorMessage: String? by mutableStateOf(null)
        private set

    val session = KeepSession(
        KeepClient(baseUrl = { origin?.toHttpUrlOrNull() }, tokenProvider = { credential?.token }),
        scope,
    )

    val isAvailable: Boolean get() = origin != null
    val isLinked: Boolean get() = isAvailable && credential != null

    init {
        credential = origin?.let(store::load)
    }

    /** Connect, or reconnect: mint a token for this device through the Worker, then ask Keep who we are. */
    suspend fun link() {
        val keep = origin ?: return
        if (isLinking) return
        val owner = account.session.credentials() ?: return
        isLinking = true
        errorMessage = null
        try {
            val issued: KeepTokenResponse = account.client.call(KeepRoutes.token(deviceName(app)))
            if (!issued.email.equals(owner.email, ignoreCase = true)) error("keep: the token names another person")
            val next = KeepCredential(issued.token, issued.expiresAt, issued.email, workspace.apiOrigin, keep)
            withContext(Dispatchers.IO) { store.save(next) }
            credential = next
            session.refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (e: StarlingsApiError) {
            errorMessage = e.sentence
        } catch (e: Exception) {
            errorMessage = KeepRoutes.TOKEN_OPERATION
        } finally {
            isLinking = false
        }
    }

    /** Forget the token on this device. It stays valid until Keep revokes it. */
    fun unlink() {
        store.clear()
        credential = null
        errorMessage = null
        session.disconnect()
    }

    /**
     * After sign-in, at launch and on foreground, only while an owner is
     * signed in: gets a token when there is none and renews one inside its
     * last week. The token proves who is asking; it opens nothing.
     */
    suspend fun ensureLinked() {
        if (!isAvailable) return
        val owner = account.session.credentials() ?: return
        val held = credential
        // A token for someone else (a sign-in as another person) is dropped first.
        if (held != null && !held.email.equals(owner.email, ignoreCase = true)) unlink()
        val current = credential
        if (current != null && !current.expiresSoon()) return
        link()
    }

    /** Reads `services.keep` from the workspace descriptor. A failed read keeps what was known. */
    private suspend fun refreshOrigin() {
        val descriptor = withContext(Dispatchers.IO) { runCatching { app.call.workspaceBackgrounds.readDescriptor() }.getOrNull() } ?: return
        val services = descriptor.services
        val next = if (services == null) builtInDefault else services.keep?.takeIf { it.toHttpUrlOrNull() != null }
        prefs.edit().putString(originKey, next ?: NONE).apply()
        if (next == origin) return
        // Another Keep, or none: the token and the key belong to the old one.
        if (credential != null || session.state !is KeepSession.State.Disconnected) unlink()
        origin = next
        credential = next?.let(store::load)
    }

    private fun storedOrigin(): String? = when (val saved = prefs.getString(originKey, null)) {
        null -> builtInDefault
        NONE -> null
        else -> saved
    }

    private fun start() {
        // Keep comes with the Starlings session: signing in links it, signing out drops it.
        scope.launch {
            account.account.map { it is Account.SignedIn }.distinctUntilChanged().collect { signedIn ->
                if (signedIn) {
                    refreshOrigin()
                    ensureLinked()
                } else if (credential != null || store.load(origin ?: "") != null) {
                    unlink()
                } else {
                    store.clear()
                }
            }
        }
        val observer = object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                // The idle deadline may have passed while the phone slept.
                session.checkIdle()
                if (account.account.value is Account.SignedIn) scope.launch {
                    refreshOrigin()
                    ensureLinked()
                }
            }
        }
        foreground = observer
        ProcessLifecycleOwner.get().lifecycle.addObserver(observer)
    }

    /** The app moved to another workspace: this one's key leaves memory and nothing of it runs on. */
    private fun stop() {
        foreground?.let { ProcessLifecycleOwner.get().lifecycle.removeObserver(it) }
        foreground = null
        session.disconnect()
        scope.cancel()
    }

    companion object {
        /** KeepKit's `KeepClient.productionURL`: the served origin, and the passkey relying party. */
        const val BUILT_IN_ORIGIN = "https://${work.starlings.android.Deployment.KEEP_WORKER_HOST}"
        private const val ORIGIN_KEY = "origin"
        private const val NONE = "none"

        @Volatile private var instance: KeepAccess? = null

        /** Called once from `StarlingsApp.onCreate`, so Keep links at launch as on iOS. */
        fun install(app: StarlingsApp) {
            of(app)
        }

        /** A switch of workspace (`StarlingsApp.rebuild`): the next [of] builds Keep for the new one. */
        fun reset() {
            synchronized(this) {
                instance?.stop()
                instance = null
            }
        }

        fun of(context: Context): KeepAccess {
            instance?.let { return it }
            val app = context.applicationContext as StarlingsApp
            return synchronized(this) {
                instance ?: KeepAccess(app).also {
                    instance = it
                    it.start()
                }
            }
        }
    }
}
