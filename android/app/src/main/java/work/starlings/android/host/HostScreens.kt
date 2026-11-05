package work.starlings.android.host

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.ManageAccounts
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.PersonSearch
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.Account
import work.starlings.android.R
import work.starlings.android.StarlingsApp
import work.starlings.android.Tile
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.CaptionLabel
import work.starlings.android.ui.CountBadge
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.GatheringDots
import work.starlings.android.ui.GatheringDotsView
import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticOnChange
import work.starlings.android.ui.HapticPulseEffect
import work.starlings.android.ui.rememberHapticPulse
import work.starlings.android.ui.HeaderCircleButton
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsCard
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.GuestPresenceRow
import work.starlings.contracts.LobbyRequestResponse
import work.starlings.contracts.PeerWire

/**
 * The hosting surface, as `MobileHostView` (iOS/MobileHostView.swift):
 * opening, the call, ending, and the one failure it shows. The call itself
 * is [call], drawn by the call screen; it opens the waiting room through the
 * lambda it is handed. [onClose] runs once the meeting has ended, and from
 * Close on the failure card.
 *
 * Leaving this screen never ends the meeting: ending belongs to the End
 * button alone. A host that vanishes without ending lapses its lease.
 */
@Composable
fun HostSurface(host: RoomHost, onClose: () -> Unit, call: @Composable (openWaitingRoom: () -> Unit) -> Unit) {
    val state by host.state.collectAsStateWithLifecycle()
    val c = Starlings.colors
    var waitingRoomOpen by rememberSaveable { mutableStateOf(false) }
    // The waiting room is only one while somebody can be let in.
    // Hosting is a success the moment the room opens; a room that would not open is the one failure this screen shows.
    HapticOnChange(state.phase) { _, phase ->
        when (phase) {
            HostPhase.HOSTING -> Haptic.SUCCESS
            HostPhase.FAILED -> Haptic.ERROR
            else -> null
        }
    }
    LaunchedEffect(state.phase) {
        if (state.phase != HostPhase.HOSTING) waitingRoomOpen = false
        if (state.phase == HostPhase.ENDED) onClose()
    }
    // A knock notification's tap: the door, not the call.
    val requested by host.waitingRoomRequested.collectAsStateWithLifecycle()
    LaunchedEffect(requested, state.phase) {
        if (requested && state.phase == HostPhase.HOSTING) {
            waitingRoomOpen = true
            host.waitingRoomShown()
        }
    }
    Box(Modifier.fillMaxSize().background(c.canvas), contentAlignment = Alignment.Center) {
        when (state.phase) {
            HostPhase.IDLE, HostPhase.STARTING -> Progress(stringResource(R.string.host_opening))
            HostPhase.HOSTING ->
                if (waitingRoomOpen) WaitingRoom(host) { waitingRoomOpen = false }
                else call { waitingRoomOpen = true }
            HostPhase.ENDING -> Progress(stringResource(R.string.host_ending))
            HostPhase.ENDED -> Unit
            HostPhase.FAILED -> Box(Modifier.padding(20.dp)) {
                StarlingsCard {
                    Text(stringResource(R.string.host_start_failed), style = StarlingsType.headline, color = c.primary)
                    state.failure?.let { Text(it, style = StarlingsType.subheadline, color = c.secondary) }
                    BorderedButton(stringResource(R.string.host_close), onClose, Modifier.padding(top = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun Progress(text: String) {
    val c = Starlings.colors
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GatheringDotsView(20.dp, c.secondary, GatheringDots.Motion.BUSY)
        Text(text, style = StarlingsType.subheadline, color = c.secondary)
    }
}

/**
 * `MobileHostChrome`: the two things only a host sees in the call header,
 * whether the room can still let people in and who is at the door. A
 * companion answers the door too (docs/IOS_HOST.md), so this draws for both.
 */
@Composable
fun HostChrome(host: RoomHost, onOpenWaitingRoom: () -> Unit, modifier: Modifier = Modifier) {
    val state by host.state.collectAsStateWithLifecycle()
    val lobby by host.lobby.state.collectAsStateWithLifecycle()
    val c = Starlings.colors
    // The door, while hosting: a knock reaches the hand before the eye finds the badge.
    HapticOnChange(Haptic.TAP, lobby.knockCount)
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        // A lapsed lease does not end the meeting, but nobody new can be admitted.
        if (state.leaseLapsed) {
            // The icon is "Room closed to new guests"; TalkBack reads what it means, as iOS.
            val label = stringResource(R.string.host_stopped_admitting)
            Icon(
                Icons.Filled.Warning, null,
                Modifier.size(16.dp).semantics { contentDescription = label },
                tint = c.danger,
            )
        }
        val count = lobby.count
        val label = if (count == 0) stringResource(R.string.host_waiting_room) else stringResource(R.string.host_waiting_room_count, count)
        Box {
            HeaderCircleButton(if (count == 0) Icons.Outlined.PersonAdd else Icons.Filled.PersonAdd, label, onOpenWaitingRoom)
            if (count > 0) CountBadge(count, Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-4).dp))
        }
    }
}

/**
 * Why the microphone is off and will not turn on, for a companion (without
 * it the rule reads as a broken button), then where the last host move
 * stands, as `MobileRoomHost.transcriptionStatus`.
 */
@Composable
fun CompanionNotice(host: RoomHost, modifier: Modifier = Modifier) {
    val state by host.state.collectAsStateWithLifecycle()
    val notice = state.notice
    // A failure or a lapsed offer is said once and goes; a move in flight stays until it lands.
    LaunchedEffect(notice) {
        if (notice != null && notice.fades) {
            delay(NOTICE_MS)
            host.dismissNotice()
        }
    }
    if (!state.isCompanion && notice == null) return
    Column(modifier.padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (state.isCompanion) Text(stringResource(R.string.host_companion), style = StarlingsType.caption, color = Starlings.colors.secondary)
        notice?.let { n ->
            Text(
                hostNoticeText(n),
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                style = StarlingsType.caption,
                color = if (n.isFailure) Starlings.colors.danger else Starlings.colors.secondary,
            )
        }
    }
}

private const val NOTICE_MS = 6_000L

private val HostNotice.isFailure: Boolean
    get() = this is HostNotice.MoveFailed || this is HostNotice.TakeFailed || this is HostNotice.HandOverFailed || this is HostNotice.FilingFailed

private val HostNotice.fades: Boolean get() = isFailure || this is HostNotice.NotTaken

@Composable
private fun hostNoticeText(notice: HostNotice): String = when (notice) {
    is HostNotice.Asked -> stringResource(R.string.host_asked, notice.name)
    is HostNotice.NotTaken -> stringResource(R.string.host_not_taken, notice.name)
    HostNotice.AwaitingHandOver -> stringResource(R.string.host_awaiting_hand_over)
    HostNotice.MoveFailed -> stringResource(R.string.host_move_failed)
    HostNotice.TakeFailed -> stringResource(R.string.host_take_failed)
    HostNotice.HandOverFailed -> stringResource(R.string.host_hand_over_failed)
    HostNotice.FilingFailed -> stringResource(R.string.host_filing_failed)
}

/**
 * The host's part of the call's More menu, as `MobileCallView`: End for
 * everyone on `/room/team` (where Leave drops nobody), then Move host… for
 * the host when another device could take it, or Take host for any device
 * that does not hold it. [onEndForEveryone] asks first.
 */
@Composable
fun HostMenuItems(host: RoomHost, tiles: List<Tile>, onEndForEveryone: () -> Unit, close: () -> Unit) {
    val state by host.state.collectAsStateWithLifecycle()
    val c = Starlings.colors
    val targets = remember(tiles) { HostTargets.from(tiles) }
    var moving by remember { mutableStateOf(false) }
    val showsMove = state.phase == HostPhase.HOSTING && state.holdsHost && targets.isNotEmpty()
    if (!state.offersEndForEveryone && !showsMove && !state.offersTakeHost) return
    HorizontalDivider(color = c.border)
    if (state.offersEndForEveryone) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.end_for_everyone), style = StarlingsType.body, color = c.danger) },
            leadingIcon = { Icon(Icons.Filled.CallEnd, null, tint = c.danger) },
            onClick = { close(); onEndForEveryone() },
        )
    }
    if (showsMove) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.host_move), style = StarlingsType.body) },
            leadingIcon = { Icon(Icons.Outlined.ManageAccounts, null) },
            trailingIcon = { Icon(if (moving) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null) },
            onClick = { moving = !moving },
        )
        if (moving) {
            targets.forEach { target ->
                DropdownMenuItem(
                    text = { Text("${target.name} · ${target.device}", style = StarlingsType.body) },
                    onClick = { close(); host.offerHost(target.identity, target.name) },
                    contentPadding = PaddingValues(start = 52.dp, end = 12.dp),
                )
            }
        }
    } else if (state.offersTakeHost) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.host_take), style = StarlingsType.body) },
            leadingIcon = { Icon(Icons.Outlined.ManageAccounts, null) },
            onClick = { close(); host.takeHost() },
        )
    }
}

/**
 * `JoinView`'s "<Name> asked you to host." for a signed-in member in a
 * colleague's call as a guest. Take host needs the microphone,
 * as Start room does: without it the answer is no.
 */
@Composable
fun HostOfferPrompt() {
    val app = LocalContext.current.applicationContext as? StarlingsApp ?: return
    val offer by app.hostOffer.state.collectAsStateWithLifecycle()
    val signedIn = app.account.account.collectAsStateWithLifecycle().value is Account.SignedIn
    val context = LocalContext.current
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        app.answerHostOffer(accept = granted)
    }
    val c = Starlings.colors
    val from = offer.from
    if (from != null && signedIn) {
        val name = from.ifBlank { stringResource(R.string.host_someone) }
        AlertDialog(
            onDismissRequest = { app.answerHostOffer(accept = false) },
            title = { Text(stringResource(R.string.host_offer_from, name), style = StarlingsType.headline, textAlign = TextAlign.Center) },
            confirmButton = {
                TextButton({
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        app.answerHostOffer(accept = true)
                    } else {
                        askMic.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }) { Text(stringResource(R.string.host_take), color = c.primary) }
            },
            dismissButton = { TextButton({ app.answerHostOffer(accept = false) }) { Text(stringResource(R.string.host_not_now), color = c.primary) } },
            containerColor = c.elevated,
            titleContentColor = c.primary,
        )
    }
    offer.failure?.let { failure ->
        AlertDialog(
            onDismissRequest = app.hostOffer::dismissFailure,
            title = { Text(failure, style = StarlingsType.headline, textAlign = TextAlign.Center) },
            confirmButton = { TextButton(app.hostOffer::dismissFailure) { Text(stringResource(R.string.host_close), color = c.primary) } },
            containerColor = c.elevated,
            titleContentColor = c.primary,
        )
    }
}

/** End closes the room for everybody, so it never wears the word for stepping out (`MobileCallView`). */
@Composable
fun hostExitLabel(state: HostState): String =
    stringResource(if (state.exitEndsMeeting) R.string.host_end else R.string.host_leave)

/**
 * `MobileWaitingRoomView`: the door, one row per person in the order they
 * knocked. Admit and decline are only here, never on a notification:
 * deciding from a banner is deciding without seeing who asks.
 */
@Composable
fun WaitingRoom(host: RoomHost, onDone: () -> Unit) {
    val lobby by host.lobby.state.collectAsStateWithLifecycle()
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val senders = remember { mutableStateMapOf<String, String>() }
    val pulse = rememberHapticPulse()
    HapticPulseEffect(pulse)
    Column(Modifier.fillMaxSize()) {
        SheetHeader(stringResource(R.string.host_waiting_room), stringResource(R.string.host_done), onDone)
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            // "Nobody is waiting" and "I couldn’t look" are different answers; only one is safe to act on.
            lobby.unavailable?.let { message ->
                ListSection(null) {
                    ListRow { Text(message, style = StarlingsType.subheadline, color = c.secondary) }
                }
            }
            if (lobby.sessionDoorOpen) {
                BorderedButton(
                    stringResource(R.string.host_session_door),
                    { scope.launch { pulse.fire(if (host.lobby.closeSessionDoor()) Haptic.SUCCESS else Haptic.ERROR) } },
                    compact = true,
                    enabled = !lobby.closingSessionDoor,
                )
            }
            if (lobby.waiting.isEmpty() && lobby.lurking.isEmpty() && lobby.unavailable == null) {
                ListSection(null) {
                    ListRow { Text(stringResource(R.string.host_nobody_waiting), style = StarlingsType.body, color = c.secondary) }
                }
            }
            if (lobby.lurking.isNotEmpty()) {
                ListSection(stringResource(R.string.host_on_the_page)) {
                    lobby.lurking.forEachIndexed { i, lurker -> LurkerRow(lurker, divider = i < lobby.lurking.lastIndex) }
                }
            }
            if (lobby.waiting.isNotEmpty()) {
                ListSection(stringResource(R.string.host_waiting_to_join)) {
                    lobby.waiting.forEachIndexed { i, guest ->
                        GuestRow(
                            guest,
                            people = lobby.people,
                            chosen = senders[guest.id],
                            deciding = guest.id in lobby.deciding,
                            divider = i < lobby.waiting.lastIndex,
                            onChoose = { senders[guest.id] = it },
                            onAdmit = { scope.launch { pulse.fire(if (host.admit(guest.id, senders[guest.id]).await()) Haptic.SUCCESS else Haptic.ERROR) } },
                            onDecline = { scope.launch { pulse.fire(if (host.deny(guest.id).await()) Haptic.DESTRUCTIVE else Haptic.ERROR) } },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun GuestRow(
    guest: LobbyRequestResponse,
    people: List<PeerWire>,
    chosen: String?,
    deciding: Boolean,
    divider: Boolean,
    onChoose: (String) -> Unit,
    onAdmit: () -> Unit,
    onDecline: () -> Unit,
) {
    val c = Starlings.colors
    val sender = chosen ?: guest.onBehalfOf
    ListRow(divider = divider) {
        Text(guest.name, style = StarlingsType.headline, color = c.primary)
        if (guest.email.isNotEmpty()) Text(guest.email, style = StarlingsType.caption, color = c.secondary)
        if (guest.recording == true) {
            CaptionLabel(stringResource(R.string.host_recording), Icons.Filled.FiberManualRecord, c.danger)
            if (sender != null) {
                val name = people.firstOrNull { it.email.equals(sender, ignoreCase = true) }?.let(::displayName) ?: sender
                CaptionLabel(stringResource(R.string.host_for, name), Icons.Outlined.AccountCircle)
            } else if (people.isNotEmpty()) {
                SenderMenu(people, onChoose)
            }
        }
        Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilledButton(
                stringResource(R.string.host_admit), onAdmit,
                enabled = !deciding && LobbyWatch.canAdmit(guest, chosen), compact = true,
            )
            BorderedButton(stringResource(R.string.host_decline), onDecline, enabled = !deciding, compact = true)
        }
    }
}

/** An unbooked recording notetaker is attributed to a teammate before it can be admitted. */
@Composable
private fun SenderMenu(people: List<PeerWire>, onChoose: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val label = stringResource(R.string.host_choose_sender)
    Box {
        Row(
            Modifier
                .clickable(role = Role.Button) { open = true }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button }
                .padding(vertical = 4.dp),
        ) {
            CaptionLabel(label, Icons.Outlined.PersonSearch, Starlings.colors.primary)
        }
        DropdownMenu(open, { open = false }) {
            people.forEach { person ->
                DropdownMenuItem(
                    text = { Text(displayName(person), style = StarlingsType.body) },
                    onClick = { open = false; onChoose(person.email) },
                )
            }
        }
    }
}

@Composable
private fun LurkerRow(lurker: GuestPresenceRow, divider: Boolean) {
    val c = Starlings.colors
    val name = lurker.name?.trim()?.takeIf { it.isNotEmpty() } ?: stringResource(R.string.host_guest)
    // The country is a flag on iOS; its two-letter code is not repeated in the location line.
    val city = lurker.city?.trim()?.takeIf { it.isNotEmpty() }
    ListRow(Modifier.semantics(mergeDescendants = true) {}, divider = divider) {
        Text(name, style = StarlingsType.headline, color = c.primary)
        city?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
        Text(stringResource(R.string.host_on_join_page), style = StarlingsType.caption2, color = c.secondary)
    }
}

private fun displayName(person: PeerWire): String = person.name?.trim()?.takeIf { it.isNotEmpty() } ?: person.email
