package work.starlings.android

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import work.starlings.android.api.OwnerSession
import work.starlings.android.api.SnapshotCache
import work.starlings.android.api.StarlingsClient
import work.starlings.contracts.DeviceRevokeRequest
import work.starlings.contracts.NativeClient
import work.starlings.contracts.NativeSignInRedeemRequest
import work.starlings.contracts.OwnerSessionResponse
import work.starlings.contracts.SessionRefreshRequest
import work.starlings.contracts.WireJson
import java.io.File
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * One native sign-in through the workspace's own web sign-in, as
 * `Sources/WorkspaceSignIn.swift` (docs/CENTRAL_AUTH.md, "Signing in through
 * the auth host"). The app opens `startUrl` in a Custom Tab; the workspace
 * sends a single-use code back to [CALLBACK]; the app redeems it with the
 * verifier that never left this process. The attempt lives in memory only.
 */
class OwnerSignInAttempt(val origin: String, random: SecureRandom = SecureRandom()) {
    val state: String = token(random, 24)
    val verifier: String = token(random, 32)

    /** S256 of the verifier: 43 base64url characters. */
    val challenge: String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

    /** `<origin>/api/auth/native/start?code_challenge=…&state=…&callback=…`. */
    val startUrl: String
        get() = "$origin/api/auth/native/start?code_challenge=$challenge&state=$state&callback=${enc(CALLBACK)}"

    sealed interface Result {
        data class Code(val code: String) : Result
        data object Cancelled : Result
        data object Invalid : Result
    }

    /** The code a callback carries, accepted only for this attempt's `state`. */
    fun read(callback: String): Result {
        val uri = runCatching { URI(callback) }.getOrNull() ?: return Result.Invalid
        if ("${uri.scheme}:${uri.rawPath}" != CALLBACK) return Result.Invalid
        val query = uri.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
            val (k, v) = (it.split('=', limit = 2) + "").take(2)
            URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
        }
        if (query["state"] != state) return Result.Invalid
        if (query.containsKey("error")) return Result.Cancelled
        val code = query["code"]?.takeIf { it.isNotEmpty() } ?: return Result.Invalid
        return Result.Code(code)
    }

    companion object {
        /** `ANDROID_NATIVE_SIGN_IN_CALLBACK` in packages/contracts/src/native-app.ts. */
        const val CALLBACK = "work.starlings.android:/auth/callback"

        private fun token(random: SecureRandom, bytes: Int): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(bytes).also(random::nextBytes))

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
    }
}

/** The owner session routes: redeem, refresh and revoke. */
class OwnerApi(private val origin: String) {
    private val http = OkHttpClient()
    private val jsonType = "application/json".toMediaType()

    suspend fun redeem(attempt: OwnerSignInAttempt, code: String, deviceId: String, deviceName: String): OwnerCredentials =
        session(
            "/api/auth/native/redeem",
            WireJson.encodeToString(
                NativeSignInRedeemRequest.serializer(),
                NativeSignInRedeemRequest(code, attempt.verifier, NativeClient.ANDROID, deviceId, deviceName),
            ),
        )

    /** Trades the single-use refresh token for a new pair. A refusal is [ServiceStatus] 401 or 403. */
    suspend fun refresh(refreshToken: String, deviceId: String, deviceName: String): OwnerCredentials =
        session(
            "/api/auth/refresh",
            WireJson.encodeToString(
                SessionRefreshRequest.serializer(),
                SessionRefreshRequest(refreshToken, NativeClient.ANDROID, deviceId, deviceName),
            ),
        )

    /** Signs this device out on the Worker, so its tokens die at their next request. */
    suspend fun revoke(credentials: OwnerCredentials, deviceId: String) {
        post("/api/auth/devices/revoke", WireJson.encodeToString(DeviceRevokeRequest.serializer(), DeviceRevokeRequest(deviceId)), credentials.accessToken)
    }

    private suspend fun session(path: String, body: String): OwnerCredentials {
        val answer = WireJson.decodeFromString(OwnerSessionResponse.serializer(), post(path, body, bearer = null))
        return OwnerCredentials(answer.accessToken, answer.refreshToken, answer.owner.sub, answer.owner.email, answer.owner.name)
    }

    private suspend fun post(path: String, body: String, bearer: String?): String = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(origin + path)
            .header("Origin", origin)
            .header(CLIENT_HEADER, clientHeader)
            .apply { bearer?.let { header("Authorization", "Bearer $it") } }
            .post(body.toRequestBody(jsonType))
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ServiceStatus(response.code)
            text
        }
    }

    companion object {
        const val CLIENT_HEADER = "x-meet-client"

        /** `android/<semver> (<build>)`, the version telemetry `parseMeetClientVersion` reads. */
        val clientHeader = "android/${UpdateRecommendation.installedVersion} (${BuildConfig.VERSION_CODE})"
    }
}

/** Signed out, signing in, or signed in to the app's workspace. */
sealed interface Account {
    data object SignedOut : Account
    data object SigningIn : Account
    data class SignedIn(val name: String, val email: String) : Account
    data class Failed(val message: String) : Account
}

/**
 * The owner's session on one [workspace], owned by the Application so a
 * rotation or a closed screen keeps it. The app builds one per workspace
 * and builds it again on a switch (slice E); [close] ends the old one.
 * [onSignedOut] runs after a sign-out of this account: the app moves to the
 * next signed-in workspace, as iOS `WorkspaceSignOut.moveToNextWorkspace`.
 */
class OwnerAccount(
    private val context: Context,
    val workspace: StarlingsWorkspace = Workspaces.active,
    private val onSignedOut: () -> Unit = {},
) {
    private val origin = workspace.apiOrigin
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val api = OwnerApi(origin)
    private val vault = KeystoreSessionVault(context, workspace.webOrigin)
    private val renewer = OwnerSessionRenewer(vault) { token, device -> api.refresh(token, device, deviceName()) }
    private var attempt: OwnerSignInAttempt? = null

    private val _account = MutableStateFlow(current())
    val account: StateFlow<Account> = _account.asStateFlow()

    /** This workspace's list snapshots (api/SnapshotCache.kt), in `cacheDir`. Sign-out empties them. */
    val snapshots = SnapshotCache(File(context.cacheDir, "snapshots"), workspace.webOrigin)

    /** What the API client reads and calls: the pair, the renewal and the refusal. */
    val session: OwnerSession = object : OwnerSession {
        override fun credentials() = vault.load()
        override suspend fun renewIfNeeded() { renewer.renewIfNeeded(); settle() }
        override suspend fun handleRejected() = this@OwnerAccount.handleRejected()
        override fun expire() { vault.clear(); settle() }
    }

    /** For a store with no screen of its own to tell the system something (a widget redraw). */
    internal val appContext: Context get() = context.applicationContext

    /** The signed-in API layer every workspace screen uses (api/StarlingsClient.kt). */
    val client by lazy {
        val upgrade = (context.applicationContext as? StarlingsApp)?.upgrade
        StarlingsClient(origin, session, snapshots, onUpgrade = { recommended, url -> upgrade?.receive(recommended, url) })
    }

    init {
        // A session near expiry renews on launch; a refusal signs out, network loss does not.
        scope.launch { renewer.renewIfNeeded(); settle() }
    }

    /** True while a sign-in waits for its callback. */
    val awaitsCallback: Boolean get() = attempt != null

    /** The runtime moved to another workspace: no renewal or sign-in of this one runs on. */
    fun close() {
        attempt = null
        scope.cancel()
    }

    /** Opens the workspace sign-in in a Custom Tab. The result comes back through [handleCallback]. */
    fun signIn(from: Context) {
        val next = OwnerSignInAttempt(origin)
        attempt = next
        _account.value = Account.SigningIn
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(from, Uri.parse(next.startUrl))
    }

    /** True when [link] is this app's sign-in callback, handled or not. */
    fun handleCallback(link: String): Boolean {
        if (!link.startsWith(OwnerSignInAttempt.CALLBACK)) return false
        val pending = attempt ?: run { _account.value = current(); return true }
        attempt = null
        when (val result = pending.read(link)) {
            is OwnerSignInAttempt.Result.Code -> scope.launch {
                _account.value = runCatching {
                    vault.save(api.redeem(pending, result.code, vault.deviceId(), deviceName()))
                    current()
                }.getOrElse { e ->
                    Account.Failed(
                        context.getString(if (e is ServiceStatus && e.status == 403) R.string.sign_in_not_invited else R.string.sign_in_failed),
                    )
                }
            }
            OwnerSignInAttempt.Result.Cancelled -> _account.value = current()
            OwnerSignInAttempt.Result.Invalid -> _account.value = Account.Failed(context.getString(R.string.sign_in_invalid))
        }
        return true
    }

    /** The person came back from the Custom Tab without finishing. */
    fun resumedWithoutCallback() {
        if (_account.value == Account.SigningIn && attempt != null) {
            attempt = null
            _account.value = current()
        }
    }

    /** Tells the Worker first, best effort, then forgets the pair here. Offline still signs out. */
    fun signOut() {
        vault.load()?.let { credentials ->
            val device = vault.deviceId()
            // Not the account's scope: a sign-out moves to the next workspace, which closes this account.
            CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { runCatching { api.revoke(credentials, device) } }
        }
        vault.clear()
        snapshots.purge()
        work.starlings.android.workspace.settings.LanguageLaunch.reset(context)
        _account.value = Account.SignedOut
        onSignedOut()
    }

    /** A request was refused: renew once, and sign out only if the Worker refuses that too. */
    suspend fun handleRejected() {
        if (renewer.handleRejected()) settle()
    }

    /**
     * After a renewal or a refusal, for a signed-in account only (a sign-in
     * in progress or its failure stays on screen): a cleared vault is a
     * sign-out, and takes the snapshots with it.
     */
    private fun settle() {
        if (_account.value !is Account.SignedIn) return
        val now = current()
        if (now == Account.SignedOut) snapshots.purge()
        _account.value = now
    }

    fun dismissFailure() {
        if (_account.value is Account.Failed) _account.value = current()
    }

    private fun current(): Account = vault.load()?.let { Account.SignedIn(it.name, it.email) } ?: Account.SignedOut

    /** What the device calls itself, as the Devices list shows it. */
    private fun deviceName(): String =
        Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}"
}
