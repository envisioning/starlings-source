package work.starlings.android.workspace.team

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.host.RoomHost
import work.starlings.android.workspace.home.roomLink
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.GlyphMark
import work.starlings.android.ui.HeaderCircleButton
import work.starlings.android.ui.SidebarRow
import work.starlings.android.ui.StarlingsCard
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.IncomingRing
import work.starlings.contracts.PeerWire
import work.starlings.android.workspace.FavoriteMenuItem
import work.starlings.android.workspace.FavoriteTargets
import work.starlings.contracts.RingKind

/**
 * `iOS/MobileTeamView.swift`'s list: the ring, the error, the call notice,
 * then YOU, GROUPS, PEOPLE and AGENTS in the rail table's order.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TeamList(
    store: TeamStore,
    onOpen: (ThreadAddress) -> Unit,
    onNewGroup: () -> Unit,
    onJoinRoom: (String) -> Unit,
    onTeamRoom: () -> Unit,
    onOpenOwnRoom: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val roster = store.roster
    val threads = store.threads
    val strays = TeamRail.strays(threads.directs, roster.peers, store.me?.email)
    val empty = buildSet {
        if (roster.me == null) add(TeamBlock.YOU)
        if (roster.people.isEmpty() && strays.isEmpty()) add(TeamBlock.PEOPLE)
        if (roster.agents.isEmpty()) add(TeamBlock.AGENTS)
    }
    val c = Starlings.colors
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            scope.launch {
                refreshing = true
                store.refresh()
                store.refreshThreads()
                refreshing = false
            }
        },
        modifier = Modifier.fillMaxSize().background(c.canvas),
    ) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            item("title") {
                Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(R.string.team_title),
                        Modifier.weight(1f).semantics { heading() },
                        style = StarlingsType.largeTitle,
                        color = c.primary,
                    )
                    HeaderCircleButton(Icons.Filled.Add, stringResource(R.string.team_new_group), onNewGroup)
                }
            }
            store.incomingRing?.let { ring ->
                item("ring") { RingBanner(ring, store, onJoinRoom, onOpenOwnRoom) }
            }
            store.errorMessage?.let { error ->
                item("error") {
                    Group {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(error, style = StarlingsType.callout, color = c.danger)
                            BorderedButton(stringResource(R.string.thread_try_again), { scope.launch { store.refresh() } }, compact = true)
                        }
                    }
                }
            }
            store.callNotice?.let { notice ->
                item("call") {
                    Group {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(
                                when (notice) {
                                    is CallNotice.Asking -> stringResource(R.string.team_asking, notice.name)
                                    is CallNotice.NoAnswer -> stringResource(R.string.team_no_answer, notice.name)
                                },
                                style = StarlingsType.body,
                                color = c.primary,
                            )
                            BorderedButton(stringResource(R.string.team_cancel_call), store::cancelCall, compact = true)
                        }
                    }
                }
            }
            item("team-room") { TeamRoomCard(onTeamRoom) }
            for (block in TeamBlock.visible(empty)) {
                item(block.id) {
                    when (block) {
                        TeamBlock.YOU -> roster.me?.let { YouBlock(it, store, onOpen) }
                        TeamBlock.GROUPS -> GroupsBlock(store, onOpen)
                        TeamBlock.PEOPLE -> PeopleBlock(store, strays, onOpen)
                        TeamBlock.AGENTS -> AgentsBlock(store, onOpen)
                    }
                }
            }
        }
    }
}

/** A grouped panel, radius `field`, the same rung as `ListSection`. */
@Composable
private fun Group(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Starlings.colors.panel, RoundedCornerShape(StarlingsRadius.field))) { content() }
}

@Composable
private fun RowDivider() {
    HorizontalDivider(Modifier.padding(start = 68.dp), thickness = 1.dp, color = Starlings.colors.border)
}

private fun prefs(context: Context) = context.getSharedPreferences("team", Context.MODE_PRIVATE)

/**
 * `MobileRailSection`: a header that folds the block, kept on the device
 * under the block's fold key, and the rows in one panel.
 */
@Composable
private fun RailSection(block: TeamBlock, title: String, footer: String? = null, rows: @Composable () -> Unit) {
    val context = LocalContext.current
    var folded by remember { mutableStateOf(runCatching { prefs(context).getBoolean(block.foldKey, false) }.getOrDefault(false)) }
    val c = Starlings.colors
    val state = stringResource(if (folded) R.string.team_collapsed else R.string.team_expanded)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable {
                    folded = !folded
                    runCatching { prefs(context).edit().putBoolean(block.foldKey, folded).apply() }
                }
                .semantics { heading(); stateDescription = state }
                .padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, Modifier.weight(1f), style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
            Icon(Icons.Filled.ChevronRight, null, Modifier.size(16.dp).rotate(if (folded) 0f else 90f), tint = c.secondary)
        }
        if (!folded) {
            Group { rows() }
            footer?.let { Text(it, Modifier.padding(horizontal = 16.dp), style = StarlingsType.footnote, color = c.secondary) }
        }
    }
}

/** A row with a long-press menu: the gesture iOS's context menu is. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MenuRow(
    onClick: () -> Unit,
    menu: (@Composable (dismiss: () -> Unit) -> Unit)?,
    content: @Composable () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        Box(Modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = if (menu != null) ({ open = true }) else null)) {
            content()
        }
        if (menu != null) {
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) { menu { open = false } }
        }
    }
}

/** `WorkSidebarRow.peer`; [note] (a subject's "Responsible") leads the second line. */
@Composable
internal fun PeerRow(peer: PeerWire, hasUnread: Boolean, preview: String? = null, note: String? = null) {
    val line = peerLineText(peer.line())
    val own = if (peer.isAgent && peer.presence != PeerStatus.BUSY) preview.orEmpty() else line
    val subtitle = listOfNotNull(note, own.ifEmpty { null }).joinToString(" · ")
    val described = listOf(peer.displayName, if (peer.isAgent) line else presenceLabel(peer.presence)).filter { it.isNotEmpty() }.joinToString(", ")
    val label = if (hasUnread) stringResource(R.string.team_unread_row, described) else described
    SidebarRow(peer.displayName, subtitle, hasUnread, Modifier.semantics(mergeDescendants = true) { contentDescription = label }) {
        PeerFace(peer, peer.dot())
    }
}

@Composable
private fun YouBlock(me: PeerWire, store: TeamStore, onOpen: (ThreadAddress) -> Unit) {
    val scope = rememberCoroutineScope()
    RailSection(
        TeamBlock.YOU,
        stringResource(R.string.team_block_you),
        footer = if (me.invisible) stringResource(R.string.team_appear_offline_reminder) else null,
    ) {
        MenuRow(
            onClick = { onOpen(ThreadAddress.peer(me)) },
            menu = { dismiss ->
                StatusItems(me) { option -> dismiss(); scope.launch { store.applyStatus(option) } }
                FavoriteTargets.peer(me)?.let { FavoriteMenuItem(it, dismiss) }
            },
        ) { PeerRow(me, me.email in store.threads.unreadPeerEmails) }
        RowDivider()
        StatusRow(me) { option -> scope.launch { store.applyStatus(option) } }
    }
}

/** The four answers, the current one checked: `PeerStatusOption`. */
@Composable
private fun StatusItems(me: PeerWire, onPick: (PeerStatusOption) -> Unit) {
    val current = PeerStatusOption.selected(me)
    PeerStatusOption.entries.forEach { option ->
        DropdownMenuItem(
            text = { Text(statusOptionLabel(option)) },
            onClick = { onPick(option) },
            leadingIcon = { if (option == current) Icon(Icons.Filled.Check, null) else Box(Modifier.size(24.dp)) },
        )
    }
}

/** "Status … Available ⌄": the current answer is the row's value, so it reads before it opens. */
@Composable
private fun StatusRow(me: PeerWire, onPick: (PeerStatusOption) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val c = Starlings.colors
    val current = statusOptionLabel(PeerStatusOption.selected(me))
    val label = stringResource(R.string.team_status_value, current)
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { open = true }
                .semantics(mergeDescendants = true) { contentDescription = label }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(stringResource(R.string.team_status), Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
            Text(current, style = StarlingsType.body, color = c.secondary)
            Icon(Icons.Filled.UnfoldMore, null, Modifier.size(16.dp), tint = c.secondary)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            StatusItems(me) { option -> open = false; onPick(option) }
        }
    }
}

@Composable
private fun GroupsBlock(store: TeamStore, onOpen: (ThreadAddress) -> Unit) {
    val unread = store.threads.unreadThreadIds
    RailSection(TeamBlock.GROUPS, stringResource(R.string.team_block_groups)) {
        ChannelRow(stringResource(R.string.team_everyone), "", ThreadAddress.TEAM_THREAD_ID in unread, store, ThreadAddress.TEAM_THREAD_ID) { onOpen(ThreadAddress.team) }
        store.threads.groups.forEach { group ->
            val address = ThreadAddress.group(group) ?: return@forEach
            RowDivider()
            ChannelRow(addressTitle(address), addressSubtitle(address) ?: stringResource(R.string.team_private), group.id in unread, store, group.id) { onOpen(address) }
        }
    }
}

/** `WorkSidebarRow.channel`: the workspace mark, a title, a line. */
@Composable
private fun ChannelRow(title: String, subtitle: String, hasUnread: Boolean, store: TeamStore, threadId: String, onClick: () -> Unit) {
    val label = if (hasUnread) stringResource(R.string.team_unread_row, title) else title
    MenuRow(onClick = onClick, menu = { dismiss -> FavoriteMenuItem(FavoriteTargets.thread(threadId), dismiss) }) {
        SidebarRow(title, subtitle, hasUnread, Modifier.semantics(mergeDescendants = true) { contentDescription = label }) {
            GlyphMark(Icons.Filled.Groups)
        }
    }
}

/** Whoever you have talked to, latest first, then the rest; strays trail. */
@Composable
private fun PeopleBlock(store: TeamStore, strays: List<work.starlings.contracts.ThreadSummaryWire>, onOpen: (ThreadAddress) -> Unit) {
    val scope = rememberCoroutineScope()
    val unread = store.threads.unreadPeerEmails
    val people = TeamRail.order(store.roster.people, store.threads.directs)
    RailSection(TeamBlock.PEOPLE, stringResource(R.string.team_block_people)) {
        people.forEachIndexed { index, peer ->
            if (index > 0) RowDivider()
            val star = favoriteTarget(store, peer)
            val actions = peer.isRingable || peer.joinRoomSlug != null || peer.isCallable || star != null
            MenuRow(
                onClick = { onOpen(ThreadAddress.peer(peer)) },
                menu = if (!actions) null else { dismiss ->
                    if (peer.isRingable) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.team_wave)) }, onClick = { dismiss(); scope.launch { store.ring(peer) } })
                    }
                    if (peer.joinRoomSlug != null) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.team_join_room)) }, onClick = { dismiss(); store.joinRoom(peer) })
                    } else if (peer.isCallable) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.team_call)) }, onClick = { dismiss(); scope.launch { store.call(peer) } })
                    }
                    star?.let { FavoriteMenuItem(it, dismiss) }
                },
            ) { PeerRow(peer, peer.email in unread) }
        }
        strays.forEachIndexed { index, stray ->
            val address = ThreadAddress.direct(stray) ?: return@forEachIndexed
            if (people.isNotEmpty() || index > 0) RowDivider()
            val email = address.peerEmail.orEmpty()
            val title = addressTitle(address)
            val hasUnread = email in unread
            val label = if (hasUnread) stringResource(R.string.team_unread_row, title) else title
            Box(Modifier.fillMaxWidth().clickable { onOpen(address) }) {
                SidebarRow(title, addressSubtitle(address).orEmpty(), hasUnread, Modifier.semantics(mergeDescendants = true) { contentDescription = label }) {
                    GlyphMark(Icons.Filled.Person)
                }
            }
        }
    }
}

@Composable
private fun AgentsBlock(store: TeamStore, onOpen: (ThreadAddress) -> Unit) {
    val unread = store.threads.unreadPeerEmails
    val agents = TeamRail.order(store.roster.agents, store.threads.directs)
    RailSection(TeamBlock.AGENTS, stringResource(R.string.team_block_agents)) {
        agents.forEachIndexed { index, agent ->
            if (index > 0) RowDivider()
            val preview = store.threads.directs.firstOrNull { !it.isGroup && it.peerEmail == agent.email }?.lastMessagePreview
            val star = favoriteTarget(store, agent)
            MenuRow(
                onClick = { onOpen(ThreadAddress.peer(agent)) },
                menu = star?.let { target -> { dismiss -> FavoriteMenuItem(target, dismiss) } },
            ) {
                PeerRow(agent, agent.email in unread, preview)
            }
        }
    }
}

/**
 * The same card Home uses for your own room: "Team Room", its link, and
 * Join Team Room, which hosts the internal room on this device rather than
 * knocking (a knock at a room nobody opened is refused).
 */
@Composable
private fun TeamRoomCard(onJoin: () -> Unit) {
    val c = Starlings.colors
    StarlingsCard {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(stringResource(R.string.team_room), style = StarlingsType.title2.copy(fontWeight = FontWeight.Bold), color = c.primary)
                    Text(roomLink(RoomHost.INTERNAL_ROOM), style = StarlingsType.caption, color = c.secondary)
                }
                Icon(Icons.Filled.Groups, null, Modifier.size(26.dp), tint = c.secondary)
            }
            FilledButton(stringResource(R.string.team_room_join), onJoin, icon = Icons.Filled.Videocam)
        }
    }
}

/**
 * `RingBanner`, one rung up from a row. A wave with a room joins it; a call
 * or an agent's ask opens your own room on this device (`answerCall`,
 * `answerAgentAsk`). Android has no transcriber, so an agent's ask opens
 * the room as a call does.
 */
@Composable
private fun RingBanner(ring: IncomingRing, store: TeamStore, onJoinRoom: (String) -> Unit, onOpenOwnRoom: () -> Unit) {
    val scope = rememberCoroutineScope()
    val c = Starlings.colors
    val name = ring.callerDisplayName
    val kind = ring.ringKind
    Column(
        Modifier.fillMaxWidth().background(c.elevated, RoundedCornerShape(StarlingsRadius.field)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            when (kind) {
                RingKind.CALL -> stringResource(R.string.team_ring_call, name)
                RingKind.AGENT_START -> stringResource(R.string.team_ring_agent_start, name)
                else -> stringResource(R.string.team_ring_wave, name)
            },
            style = StarlingsType.body.copy(fontWeight = FontWeight.SemiBold),
            color = c.primary,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val slug = ring.roomSlug
            if (kind == RingKind.CALL || kind == RingKind.AGENT_START) {
                BorderedButton(stringResource(R.string.team_ring_open_room), {
                    scope.launch { if (store.answerRing(kind)) onOpenOwnRoom() }
                }, compact = true)
            }
            if (kind == RingKind.WAVE && slug != null) {
                FilledButton(stringResource(R.string.team_ring_join), {
                    scope.launch { store.clearRing() }
                    onJoinRoom(slug)
                }, compact = true)
            }
            BorderedButton(
                stringResource(if (kind == RingKind.WAVE) R.string.team_ring_dismiss else R.string.team_ring_not_now),
                { scope.launch { store.clearRing() } },
                compact = true,
                foreground = c.secondary,
            )
        }
    }
}

/** A person's own star, or their conversation's when the roster gave no reference. */
private fun favoriteTarget(store: TeamStore, peer: PeerWire): work.starlings.contracts.FavoriteTarget? =
    FavoriteTargets.peer(peer)
        ?: store.threads.directs.firstOrNull { it.peerEmail.equals(peer.email, ignoreCase = true) }?.let { FavoriteTargets.thread(it.id) }
