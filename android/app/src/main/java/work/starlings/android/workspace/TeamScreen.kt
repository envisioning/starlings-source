package work.starlings.android.workspace

import androidx.compose.ui.platform.LocalView
import work.starlings.android.workspace.team.callerDisplayName
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.ui.Haptic
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import work.starlings.android.OwnerAccount
import work.starlings.android.host.RoomHost
import work.starlings.android.host.rememberHostStarter
import work.starlings.android.workspace.team.GroupPicker
import work.starlings.android.workspace.team.LocalTeamMedia
import work.starlings.android.workspace.team.LocalTeamStore
import work.starlings.android.workspace.team.rememberTeamStore
import work.starlings.android.workspace.team.TeamList
import work.starlings.android.workspace.team.TeamStore
import work.starlings.android.workspace.team.ThreadAddress
import work.starlings.android.workspace.team.ThreadScreen
import work.starlings.android.workspace.team.ThreadTarget
import work.starlings.android.workspace.team.TeamRoute
import work.starlings.android.workspace.team.TeamRefPage
import work.starlings.android.workspace.team.TeamRefStack
import work.starlings.android.workspace.team.teamRefDoors
import work.starlings.android.workspace.work.WorkStore
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.semantics.clearAndSetSemantics
import work.starlings.android.workspace.team.TeamThreads
import work.starlings.android.workspace.team.isAgent
import work.starlings.android.workspace.team.isCallable
import work.starlings.android.workspace.team.noticeText

/**
 * The Team tab: `iOS/MobileTeamView.swift`. The roster and conversation
 * list, and one conversation pushed over it. The roster is the shell's
 * session store ([LocalTeamStore]), which polls on every tab.
 */
@Composable
fun TeamScreen(account: OwnerAccount, onJoinRoom: (String?) -> Unit) {
    // The shell's session store; a Team screen drawn outside the shell starts its own.
    val store = LocalTeamStore.current ?: rememberTeamStore(account) { slug -> onJoinRoom(slug) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val startHosting = rememberHostStarter()
    val view = LocalView.current
    store.onNotice = { notice ->
        // A landed wave has no row of its own to answer on: the toast and this.
        if (notice is work.starlings.android.workspace.team.TeamNotice.Waved) Haptic.SUCCESS.play(view)
        // A refusal or a failure is a danger toast, as `MobileTeamStore`; a wave is neutral.
        work.starlings.android.ui.toast(
            noticeText(context, notice),
            if (notice is work.starlings.android.workspace.team.TeamNotice.Waved) work.starlings.android.ui.ToastTone.NEUTRAL else work.starlings.android.ui.ToastTone.DANGER,
        )
    }

    // The open conversation survives rotation by its address id; its naming comes back from the roster.
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    var opened by remember { mutableStateOf<ThreadAddress?>(null) }
    var gathering by rememberSaveable { mutableStateOf(false) }

    // A chip's pages, over the open conversation; leaving the conversation drops them.
    val refStack = remember { mutableStateListOf<TeamRefPage>() }
    val refDoors = remember(refStack) { teamRefDoors(refStack) }
    val refWork = remember(account) { WorkStore(account, scope) }
    // Work's reads start with the first chip a person opens, not with the tab.
    var refWorkStarted by remember(refWork) { mutableStateOf(false) }
    LaunchedEffect(refStack.isNotEmpty()) {
        if (refStack.isNotEmpty() && !refWorkStarted) { refWorkStarted = true; refWork.start() }
    }

    fun show(address: ThreadAddress?) {
        refStack.clear()
        opened = address
        openId = address?.id
    }

    // A web path from Search or Home (`TeamRoute`), held until the roster or the list can name it.
    var route by remember { mutableStateOf<TeamRoute?>(null) }
    rememberWorkspaceRoute(MemberSurface.TEAM) { path -> route = TeamRoute.parse(path) }
    LaunchedEffect(route, store.roster, store.threads) {
        when (val r = route) {
            null -> Unit
            TeamRoute.Roster -> { show(null); route = null }
            is TeamRoute.Peer -> {
                val peer = TeamRoute.peer(r, store.roster.peers)
                if (peer == null) {
                    // Nobody by that name once the roster has answered: the list, as a plain tap would leave it.
                    if (store.roster.peers.isNotEmpty()) route = null
                    return@LaunchedEffect
                }
                route = null
                show(ThreadAddress.peer(peer))
                when {
                    r.verb == "wave" && !peer.isAgent -> store.ring(peer)
                    r.verb == "call" && peer.isCallable -> store.call(peer)
                }
            }
            is TeamRoute.Thread -> {
                val address = TeamRoute.address(r, store.threads, store.roster.peers)
                if (address == null) {
                    if (store.threads != TeamThreads.EMPTY) route = null
                    return@LaunchedEffect
                }
                route = null
                show(address)
            }
        }
    }

    HapticWhenSet(Haptic.TAP, store.incomingRing?.callerDisplayName)
    CompositionLocalProvider(LocalTeamMedia provides store.media) {
    Box(Modifier.fillMaxSize()) {
        // Named from the live roster first, so the header's presence line follows each poll.
        val current = openId?.let { id -> restore(id, store) ?: opened?.takeIf { it.id == id } }
        if (current != null) {
            // A chip's task or issue is pushed over the conversation, as iOS pushes it in Team's stack.
            // The conversation stays composed under them, so Back finds it where it was; it is hidden from TalkBack meanwhile.
            Box(if (refStack.isEmpty()) Modifier else Modifier.clearAndSetSemantics { }) {
                ThreadScreen(current, account, store, doors = refDoors, onBack = { show(null) })
            }
            if (refStack.isNotEmpty()) {
                Box(Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { }) {
                    TeamRefStack(refWork, refStack)
                }
            }
        } else {
            TeamList(
                store = store,
                onOpen = ::show,
                onNewGroup = { gathering = true },
                onJoinRoom = { slug -> onJoinRoom(slug) },
                onTeamRoom = { startHosting(RoomHost.INTERNAL_ROOM) },
                onOpenOwnRoom = { startHosting(null) },
            )
        }
    }
    }

    if (gathering) {
        GroupPicker(
            candidates = store.roster.people,
            maximum = ThreadAddress.GROUP_MAXIMUM_OTHERS,
            onDismiss = { gathering = false },
        ) { chosen ->
            gathering = false
            if (chosen.size >= 2) show(ThreadAddress.group(chosen))
        }
    }
}

/** An address from its id, named from the roster or the conversation list; null when neither knows it yet. */
private fun restore(id: String, store: TeamStore): ThreadAddress? {
    if (id == ThreadAddress.team.id) return ThreadAddress.team
    if (id.startsWith("peer:")) {
        val email = id.removePrefix("peer:")
        store.roster.peers.firstOrNull { it.email == email }?.let { return ThreadAddress.peer(it) }
        return store.threads.directs.firstOrNull { it.peerEmail == email }?.let { ThreadAddress.direct(it) }
    }
    if (id.startsWith("group:")) {
        val emails = id.removePrefix("group:").split(',')
        return store.threads.groups.mapNotNull { ThreadAddress.group(it) }
            .firstOrNull { (it.target as? ThreadTarget.Group)?.emails == emails }
            ?: store.roster.peers.filter { it.email in emails }.takeIf { it.size == emails.size }?.let { ThreadAddress.group(it) }
    }
    return null
}
