package work.starlings.android

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import work.starlings.android.api.SnapshotCache
import work.starlings.android.host.ClientHostApi
import work.starlings.android.host.HostOfferWatch
import work.starlings.android.host.KnockNotifier
import work.starlings.android.host.RoomHost
import work.starlings.android.core.CoreAccess
import work.starlings.android.keep.KeepAccess
import work.starlings.android.keep.KeepTokenStore
import work.starlings.contracts.HostMessageWire
import java.io.File

/** Holds the call and the owner session so they outlive screens, rotation and navigation (A2 rule). */
class StarlingsApp : Application() {
    lateinit var call: CallSession
        private set

    /** The workspaces on this device and the active one (slice G). */
    lateinit var workspaces: WorkspaceStore
        private set

    /** Reads workspace descriptors: the add flow, the link offer and the current workspace's refresh. */
    val directory by lazy { WorkspaceDirectory(online = ::isOnline) }

    private lateinit var _accounts: MutableStateFlow<OwnerAccount>

    /**
     * The active workspace's session. A switch replaces it (slice E): the UI
     * keys its root by it, so every store and screen built for the old
     * workspace goes with the old account.
     */
    val accounts: StateFlow<OwnerAccount> get() = _accounts

    val account: OwnerAccount get() = _accounts.value

    /** A sign-in to a workspace that is not active yet (Add a workspace). It becomes [account] once entered. */
    private var pendingSignIn: OwnerAccount? = null

    /** A link for another workspace, waiting for Open in <name> or Cancel. */
    private val _linkOffer = MutableStateFlow<LinkOffer?>(null)
    val linkOffer: StateFlow<LinkOffer?> = _linkOffer.asStateFlow()

    data class LinkOffer(val workspace: StarlingsWorkspace, val link: String)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** The Worker's update recommendation for this build, one for the app (#1237): the shell draws its banner. */
    val upgrade by lazy { UpdateRecommendation(SharedWorkspacePrefs(this, "update")) }

    /** Every listed workspace's mark, once read: the rows and Home's switcher draw them. */
    val marks by lazy { WorkspaceMarks(directory, scope) }
    private val _host = MutableStateFlow<RoomHost?>(null)

    /** The owner's room while this device hosts it or is its companion; null otherwise. */
    val host: StateFlow<RoomHost?> = _host.asStateFlow()

    /** An offer to host a colleague's meeting, while this device is a guest in it. */
    val hostOffer = HostOfferWatch()
    private var knocks: KnockNotifier? = null
    private val guestHostMessages: (HostMessageWire) -> Unit = { hostOffer.receive(it, call.activeRoom?.localParticipant?.identity?.value) }

    /**
     * Start room on Home: opens the owner's room, or resumes its open
     * meeting. [room] is another room (the internal room, or a colleague's
     * on their offer, with [claimsHostOnJoin]); null is "my room". [filing]
     * is Meet about this: the room files itself under that subject as it opens.
     */
    fun startHosting(room: String? = null, claimsHostOnJoin: Boolean = false, filing: work.starlings.contracts.MeetingCategoryUpdate? = null) {
        if (_host.value != null) return
        val device = RoomHost.device(resources.configuration.smallestScreenWidthDp)
        val meetings = work.starlings.android.host.ClientMeetingOwnerApi(account.client)
        val next = RoomHost(
            ClientHostApi(account.client), call, scope, device, requestedRoom = room, claimsHostOnJoin = claimsHostOnJoin, filing = filing,
            onOwnMeetingEnded = { r, m -> scope.launch { work.starlings.android.host.UnfiledMeetingNotifier.deliverIfUnfiled(this@StarlingsApp, meetings, r, m) } },
        )
        call.onHostMessage = { next.receive(it) }
        hostOffer.clear()
        _host.value = next
        knocks = KnockNotifier(this, next, scope).also { it.start() }
        next.start()
    }

    /** The host surface closed: the meeting ended or failed to open. */
    fun clearHost() {
        knocks?.stop()
        knocks = null
        call.onHostMessage = guestHostMessages
        _host.value = null
    }

    /** "Take host" or "Not now" on a colleague's offer. Yes leaves the call as a guest and opens the room again as its host. */
    fun answerHostOffer(accept: Boolean) {
        scope.launch {
            val api = (account.account.value as? Account.SignedIn)?.let { ClientHostApi(account.client) }
            val meeting = call.activeMeeting
            val room = hostOffer.answer(accept, api, meeting?.first, meeting?.second) ?: return@launch
            call.leave()
            call.reset()
            startHosting(room, claimsHostOnJoin = true)
        }
    }

    // MARK: Workspaces (docs/CENTRAL_AUTH.md "The switcher")

    /** A call, a knock or hosting is under way: no switch (`MobileCallActivity.isLive`). */
    val isCallLive: Boolean
        get() = _host.value != null || when (call.state.value) {
            CallState.Idle, is CallState.Ended -> false
            else -> true
        }

    /** The account signed in to [workspace] on this device, or null. Reads the sealed vault only. */
    fun signedInEmail(workspace: StarlingsWorkspace): String? =
        if (workspace.webOrigin == account.workspace.webOrigin) account.session.credentials()?.email
        else KeystoreSessionVault(this, workspace.webOrigin).load()?.email

    fun hasSession(workspace: StarlingsWorkspace): Boolean = signedInEmail(workspace) != null

    enum class SignInResult { SIGNED_IN, CANCELLED, NOT_INVITED, FAILED }

    /**
     * Signs in to [workspace] without making it active (`signIn(into:)`).
     * The pair goes to that workspace's own vault, so the switch that
     * follows lands signed in; a cancel or a refusal leaves the active
     * workspace as it was. The current workspace signs in as before.
     */
    suspend fun signIn(into: StarlingsWorkspace, from: Context): SignInResult {
        val workspace = into
        val current = workspace.webOrigin == account.workspace.webOrigin
        val target = if (current) account else {
            pendingSignIn?.close()
            OwnerAccount(this, workspace, ::movedAfterSignOut).also { pendingSignIn = it }
        }
        target.dismissFailure()
        target.signIn(from)
        return when (val end = target.account.first { it != Account.SigningIn }) {
            is Account.SignedIn -> SignInResult.SIGNED_IN
            is Account.Failed -> if (end.message == getString(R.string.sign_in_not_invited)) SignInResult.NOT_INVITED else SignInResult.FAILED
            Account.SignedOut -> SignInResult.CANCELLED
            Account.SigningIn -> SignInResult.FAILED
        }
    }

    /** A sign-in callback: for the add flow's attempt when it waits for one, else the active account's. */
    fun handleCallback(link: String): Boolean {
        if (!link.startsWith(OwnerSignInAttempt.CALLBACK)) return false
        pendingSignIn?.takeIf { it.awaitsCallback }?.let { return it.handleCallback(link) }
        return account.handleCallback(link)
    }

    fun resumedWithoutCallback() {
        pendingSignIn?.resumedWithoutCallback()
        account.resumedWithoutCallback()
    }

    /**
     * Makes [workspace] active and rebuilds the app on it (`enter`): "You're
     * in <name>" once it is. Refused during a call. Returns false when
     * nothing moved.
     */
    fun enter(workspace: StarlingsWorkspace, announce: Boolean = true): Boolean {
        if (isCallLive) return false
        val moved = if (announce) workspaces.enter(workspace) else workspaces.choose(workspace)
        if (moved) rebuild(workspace)
        return moved
    }

    /**
     * Sign out of a workspace that is not the current one: its Worker is
     * told first, best effort, then its session, snapshots and Keep token
     * go. The row stays, signed out.
     */
    fun signOut(of: StarlingsWorkspace) {
        if (of.webOrigin == account.workspace.webOrigin) return
        forgetSession(of)
    }

    /** Remove from this device: a sign-out when signed in, then the row goes. Not for the current workspace. */
    fun remove(workspace: StarlingsWorkspace) {
        if (workspace.webOrigin == account.workspace.webOrigin) return
        if (hasSession(workspace)) signOut(of = workspace)
        workspaces.forget(workspace)
    }

    /** Every workspace's session, each Worker told first, best effort. Every row stays, signed out; the app stays where it is. */
    fun signOutOfAllWorkspaces() {
        workspaces.known.value.filter { it.webOrigin != account.workspace.webOrigin }.forEach(::forgetSession)
        account.signOut()
    }

    private fun forgetSession(workspace: StarlingsWorkspace) {
        val vault = KeystoreSessionVault(this, workspace.webOrigin)
        vault.load()?.let { credentials ->
            val device = vault.deviceId()
            scope.launch { runCatching { OwnerApi(workspace.apiOrigin).revoke(credentials, device) } }
        }
        vault.clear()
        SnapshotCache(File(cacheDir, "snapshots"), workspace.webOrigin).purge()
        KeepTokenStore(this, workspace.apiOrigin).clear()
    }

    /** After a sign-out of the active workspace, the next signed-in one takes over. With none, the app stays on the door. */
    private fun movedAfterSignOut() {
        val next = workspaces.nextSignedIn(::hasSession) ?: return
        enter(next, announce = false)
    }

    /**
     * Opens a room or invite link only under the workspace whose host it
     * names (`StarlingsAppModel.open(link:)`): [open] for the active one,
     * the offer for another, a refusal for a host that names none.
     */
    fun openLink(link: String, open: (String) -> Unit) {
        if (WorkspaceLinks.isActive(link)) return open(link)
        scope.launch {
            when (val found = WorkspaceLinks.resolve(link, directory)) {
                WorkspaceLinks.Resolution.Active -> open(link)
                is WorkspaceLinks.Resolution.Other -> _linkOffer.value = LinkOffer(found.workspace, link)
                WorkspaceLinks.Resolution.Unknown ->
                    work.starlings.android.ui.toast(getString(R.string.workspace_link_unknown))
            }
        }
    }

    /** Open in <name>: the link is carried across the rebuild and opens there (`acceptLinkWorkspaceOffer`). */
    fun acceptLinkOffer() {
        val offer = _linkOffer.value ?: return
        _linkOffer.value = null
        if (isCallLive) {
            work.starlings.android.ui.toast(getString(R.string.workspaces_leave_call))
            return
        }
        workspaces.carry(offer.link, offer.workspace)
        enter(offer.workspace, announce = false)
    }

    fun dismissLinkOffer() {
        _linkOffer.value = null
    }

    /** Reads the current workspace's descriptor and takes its new name, mark and link hosts. Offline keeps the last answer. */
    fun refreshWorkspace() {
        val workspace = account.workspace
        scope.launch {
            val fresh = runCatching { directory.lookUp(workspace.webOrigin) }.getOrNull() ?: return@launch
            if (workspaces.current.value.webOrigin == workspace.webOrigin) workspaces.refresh(fresh)
        }
    }

    /** Everything built for the old workspace goes; the account, Keep and the call's lobby are built again for [workspace]. */
    private fun rebuild(workspace: StarlingsWorkspace) {
        val old = account
        val next = pendingSignIn?.takeIf { it.workspace.webOrigin == workspace.webOrigin }
            ?: OwnerAccount(this, workspace, ::movedAfterSignOut)
        pendingSignIn = null
        old.close()
        KeepAccess.reset()
        CoreAccess.reset()
        call.retarget(workspace)
        _accounts.value = next
        KeepAccess.install(this)
        CoreAccess.install(this)
    }

    private fun isOnline(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return true
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    override fun onCreate() {
        super.onCreate()
        // Appearance, the Home grid and channel notices: device-local, read before any screen draws.
        DeviceSettings.attach(this)
        workspaces = WorkspaceStore(SharedWorkspacePrefs(this))
        Workspaces.install(workspaces)
        val workspace = workspaces.current.value
        call = CallSession(this, LobbyApi(workspace.apiOrigin))
        _accounts = MutableStateFlow(OwnerAccount(this, workspace, ::movedAfterSignOut))
        call.onHostMessage = guestHostMessages
        work.starlings.android.lock.AppLock.install(this)
        // Keep links with the owner session at launch, as iOS (docs/KEEP.md).
        KeepAccess.install(this)
        // Core renews its token at launch and drops it at sign-out, as iOS `CoreSession.attach` (docs/CORE_REGISTRY.md).
        CoreAccess.install(this)
        // Sign-in and sign-out redraw the home-screen widgets; sign-out deletes their agenda.
        work.starlings.android.widgets.WidgetRefresh.watch(this)
    }
}
