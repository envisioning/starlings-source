package work.starlings.android

import work.starlings.android.host.CompanionNotice
import work.starlings.android.host.HostChrome
import work.starlings.android.host.HostMenuItems
import work.starlings.android.host.HostOfferPrompt
import work.starlings.android.host.ClientMeetingOwnerApi
import work.starlings.android.host.MeetingFilingScreen
import work.starlings.android.host.MeetingOwnerApi
import work.starlings.android.host.TranscriptShareMenu
import work.starlings.android.host.Moderation
import work.starlings.android.host.RoomHost
import work.starlings.android.host.hostExitLabel
import android.graphics.BitmapFactory
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ClosedCaption
import androidx.compose.material.icons.filled.ConfirmationNumber
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Portrait
import work.starlings.android.background.BackgroundMenu
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.RadioButtonChecked
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.AddReaction
import androidx.compose.material.icons.outlined.DoNotTouch
import androidx.compose.material.icons.outlined.PanTool
import androidx.compose.material.icons.outlined.SentimentSatisfied
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.CallControl
import work.starlings.android.ui.ListActionRow
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.EndForEveryoneDialog
import work.starlings.android.ui.QualityBadge
import work.starlings.android.ui.StarlingsSize
import work.starlings.android.ui.CaptionLabel
import work.starlings.android.ui.HeaderCircleButton
import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticOnChange
import work.starlings.android.ui.HapticPulseEffect
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.ui.rememberHapticPulse
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.NoticeRow
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.StageGridBackground
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsSpacing
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.floatingGlass
import work.starlings.contracts.LinkPreview
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** 24-hour clock everywhere (AGENTS.md). */
private val CHAT_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

/** The black scrim iOS draws under glass below iOS 26: a tile's name, the live caption. */
private val SCRIM = Color.Black.copy(alpha = 0.7f)

/**
 * `MobileCallView`: the header ("In meeting", the count, the audio route),
 * then the stage as an elevated card on the brand lattice, with the foot
 * floating on its bottom edge: notices, the live caption, and the five
 * controls (Mute, Camera, More, Chat, Leave). Everything else is in More.
 * Chat, People and the transcript are iOS sheets; here they take the screen.
 */
@Composable
fun CallScreen(call: CallSession, host: RoomHost? = null, onOpenWaitingRoom: () -> Unit = {}, account: OwnerAccount? = null) {
    // The host's own routes: moderation, filing and the record. A guest has none.
    val meetings: MeetingOwnerApi? = remember(account, host) { if (host != null && account != null) ClientMeetingOwnerApi(account.client) else null }
    val ui by call.ui.collectAsStateWithLifecycle()
    val meeting by call.meeting.collectAsStateWithLifecycle()
    val room = call.activeRoom ?: return
    val m = meeting ?: return
    val notice by m.notice.collectAsStateWithLifecycle()
    val unread by m.unread.collectAsStateWithLifecycle()
    var chatOpen by rememberSaveable { mutableStateOf(false) }
    var captionsOn by rememberSaveable { mutableStateOf(false) }
    var peopleOpen by rememberSaveable { mutableStateOf(false) }
    var reacting by rememberSaveable { mutableStateOf(false) }
    // Hiding your tile stops drawing it, never publishing it: the room still sees you.
    var selfViewHidden by rememberSaveable { mutableStateOf(false) }
    var transcriptOpen by rememberSaveable { mutableStateOf(false) }
    var filingOpen by rememberSaveable { mutableStateOf(false) }
    // Ending drops everyone else, so with anyone in the room it is asked first.
    var confirmsEnd by rememberSaveable { mutableStateOf(false) }
    val prefs = LocalContext.current.getSharedPreferences("stage", android.content.Context.MODE_PRIVATE)
    // `meet.screenShareLayout` on iOS: a device choice that outlives the call.
    var shareLayout by remember {
        mutableStateOf(StageLayout.ScreenShareChoice.entries.firstOrNull { it.wire == prefs.getString("screenShareLayout", null) } ?: StageLayout.ScreenShareChoice.AUTOMATIC)
    }
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val handFailure = stringResource(R.string.hands_lower_failed)
    // `MobileRoomHost.lowerAllHands`: nothing is assumed here; the hands come down when the room says so.
    fun lowerAllHands(host: RoomHost, api: MeetingOwnerApi, meeting: Meeting, failure: String) {
        val state = host.state.value
        val hostRoom = state.room ?: return
        val meetingId = state.meetingId ?: return
        scope.launch {
            try {
                api.lowerAllHands(hostRoom, meetingId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                meeting.report(failure)
            }
        }
    }

    // Felt, not watched: mid-sentence the eyes are on the other person, so the
    // state changes that matter reach the hand. Driven by the session's own
    // state, so a mute from the host buzzes the same way. Above the sheets,
    // so a change while one is open still plays.
    HapticOnChange(Haptic.TOGGLE, ui.micOn)
    HapticOnChange(Haptic.TOGGLE, ui.cameraOn)
    HapticOnChange(Haptic.TOGGLE, ui.handRaised)
    HapticWhenSet(Haptic.WARNING, notice)
    val view = LocalView.current

    if (peopleOpen) {
        People(ui.tiles, ui.reconnecting, host, meetings) { peopleOpen = false }
        return
    }
    if (filingOpen && host != null && meetings != null && account != null) {
        MeetingFilingScreen(host, meetings, account) { filingOpen = false }
        return
    }
    if (transcriptOpen) {
        Transcript(m, share = if (host != null && meetings != null) { modifier -> TranscriptShareMenu(host, meetings, modifier) } else null) { transcriptOpen = false }
        return
    }
    if (chatOpen) {
        Chat(m, room.localParticipant.identity?.value) { chatOpen = false; m.chatOpen = false }
        return
    }
    val count = ui.tiles.count { !it.screenShare }
    Column(Modifier.fillMaxSize().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = StarlingsSpacing.header), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(R.string.in_meeting), style = StarlingsType.headline, color = c.primary)
                Text(pluralStringResource(R.plurals.participants, count, count), style = StarlingsType.caption, color = c.secondary)
            }
            host?.let { HostChrome(it, onOpenWaitingRoom) }
            AudioRoute(ui, call)
        }
        host?.let { CompanionNotice(it) }
        val density = LocalDensity.current
        var footHeight by remember { mutableIntStateOf(0) }
        val stageShape = RoundedCornerShape(StarlingsRadius.card)
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(start = 12.dp, end = 12.dp, bottom = 8.dp)
                .clip(stageShape)
                .background(c.elevated, stageShape),
        ) {
            StageGridBackground(Modifier.fillMaxSize())
            Stage(room, ui.tiles, Modifier.fillMaxSize(), shareLayout, selfViewHidden, reserved = with(density) { footHeight.toDp() })
            // Over the stage and deaf to taps; the foot is drawn after it, so it is on top.
            Flights(m)
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().onSizeChanged { footHeight = it.height }.padding(StarlingsSpacing.controls),
                verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.controls),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (ui.reconnecting) NoticeRow(stringResource(R.string.banner_reconnecting), icon = Icons.Filled.Sync)
                if (ui.audioTaken) NoticeRow(stringResource(R.string.banner_audio_taken), icon = Icons.Filled.VolumeUp)
                notice?.let { NoticeRow(it, dismiss = stringResource(R.string.dismiss), onDismiss = m::dismissNotice) }
                if (captionsOn) Caption(m)
                if (reacting) ReactionPalette(onClose = { reacting = false }) { emoji -> m.react(emoji); reacting = false }
                Row(horizontalArrangement = Arrangement.spacedBy(StarlingsSpacing.controls)) {
                    Box(Modifier.weight(1f)) {
                        CallControl(
                            if (ui.micOn) Icons.Filled.Mic else Icons.Filled.MicOff,
                            stringResource(if (ui.micOn) R.string.mute else R.string.unmute),
                            stringResource(if (ui.micOn) R.string.mute else R.string.unmute),
                            { call.setMic(!ui.micOn) },
                            Modifier.fillMaxWidth(),
                        )
                        MicrophoneChooser(call, StarlingsSize.callControl, Modifier.align(Alignment.TopEnd))
                    }
                    Box(Modifier.weight(1f)) {
                        CallControl(
                            if (ui.cameraOn) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                            stringResource(if (ui.cameraOn) R.string.entry_camera else R.string.camera_on),
                            stringResource(if (ui.cameraOn) R.string.camera_turn_off else R.string.camera_turn_on),
                            { call.setCamera(!ui.cameraOn) },
                            Modifier.fillMaxWidth(),
                        )
                        CameraChooser(call, StarlingsSize.callControl, Modifier.align(Alignment.TopEnd))
                    }
                    More(
                        Modifier.weight(1f),
                        call = call,
                        ui = ui,
                        count = count,
                        captionsOn = captionsOn,
                        layout = shareLayout,
                        selfViewHidden = selfViewHidden,
                        onReact = { reacting = !reacting },
                        onHand = { m.setHand(!ui.handRaised) },
                        onFlip = { call.flipCamera() },
                        onShareLayout = { shareLayout = it; prefs.edit().putString("screenShareLayout", it.wire).apply() },
                        onSelfView = { selfViewHidden = !selfViewHidden },
                        onTranscript = { transcriptOpen = true },
                        onPeople = { peopleOpen = true },
                        onCaptions = { captionsOn = !captionsOn },
                        onFiling = if (meetings != null) { { filingOpen = true } } else null,
                        onLowerHands = if (meetings != null && host != null) { { lowerAllHands(host, meetings, m, handFailure) } } else null,
                        extra = { close -> host?.let { HostMenuItems(it, ui.tiles, onEndForEveryone = { confirmsEnd = true }, close) } },
                    )
                    CallControl(
                        Icons.Filled.Forum,
                        stringResource(R.string.chat),
                        if (unread > 0) stringResource(R.string.chat_unread, unread) else stringResource(R.string.chat),
                        { chatOpen = true; m.chatOpen = true },
                        Modifier.weight(1f),
                        badge = unread,
                    )
                    // A host's End closes the room for everybody; a companion and a guest leave.
                    val hostState = host?.state?.collectAsStateWithLifecycle()?.value
                    val exit = hostState?.let { hostExitLabel(it) } ?: stringResource(R.string.leave)
                    val endsMeeting = hostState?.exitEndsMeeting == true
                    CallControl(
                        Icons.Filled.CallEnd,
                        exit,
                        exit,
                        {
                            when {
                                host == null -> { Haptic.DESTRUCTIVE.play(view); call.leave() }
                                EndConfirmation.needed(endsMeeting, count) -> confirmsEnd = true
                                else -> { Haptic.DESTRUCTIVE.play(view); host.end(everyone = endsMeeting) }
                            }
                        },
                        Modifier.weight(1f),
                        danger = true,
                    )
                }
            }
        }
    }
    if (confirmsEnd && host != null) {
        val others = EndConfirmation.others(count)
        EndForEveryoneDialog(
            title = stringResource(R.string.end_confirm_title),
            message = pluralStringResource(R.plurals.end_confirm_others, others, others),
            confirm = stringResource(R.string.end_for_everyone),
            cancel = stringResource(R.string.call_cancel),
            onConfirm = {
                confirmsEnd = false
                // Asked again at the press: the host may have moved while the dialog was open.
                if (host.state.value.holdsHost) Haptic.DESTRUCTIVE.play(view)
                host.endForEveryone()
            },
            onDismiss = { confirmsEnd = false },
        )
    }
    // A guest in a colleague's call may be asked to host it.
    if (host == null) HostOfferPrompt()
}

/** The live caption: the newest line, centred, on glass at radius `field`. */
@Composable
private fun Caption(m: Meeting) {
    val captions by m.captions.collectAsStateWithLifecycle()
    val last = captions.lastOrNull()
    Text(
        last?.text ?: stringResource(R.string.captions_empty),
        Modifier
            .floatingGlass(Color.Black.copy(alpha = 0.72f), RoundedCornerShape(StarlingsRadius.field))
            .padding(horizontal = 14.dp, vertical = 9.dp),
        style = StarlingsType.body.copy(fontWeight = FontWeight.Medium),
        color = if (last == null || last.final) Color.White else Color.White.copy(alpha = 0.75f),
        textAlign = TextAlign.Center,
        maxLines = 3,
    )
}

/** `MobileReactionPalette`: the four reactions, 48 targets in a glass capsule. Sending closes it. */
@Composable
private fun ReactionPalette(onClose: () -> Unit, onSend: (String) -> Unit) {
    val c = Starlings.colors
    val view = LocalView.current
    Row(
        Modifier.floatingGlass(c.panel, CircleShape).padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Played directly: the palette closes in the same beat.
        Reactions.palette.forEach { emoji -> ReactionButton(emoji) { Haptic.TAP.play(view); onSend(emoji) } }
        val close = stringResource(R.string.close)
        Box(
            Modifier.size(36.dp).clickable(role = Role.Button, onClick = onClose).semantics { contentDescription = close },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.Close, null, Modifier.size(18.dp), tint = c.secondary) }
    }
}

/**
 * `MobileChatView`: bubbles, yours pushed to the trailing side on an accent
 * tint, everyone else's on the elevated rung, radius `field`; the composer
 * is one well with the send circle inset at its end.
 */
@Composable
private fun Chat(m: Meeting, me: String?, onClose: () -> Unit) {
    val c = Starlings.colors
    val messages by m.chat.collectAsStateWithLifecycle()
    var draft by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val tooLong = stringResource(R.string.chat_too_long)
    val list = rememberLazyListState()
    LaunchedEffect(messages.size) { if (messages.isNotEmpty()) list.animateScrollToItem(messages.size - 1) }
    Column(Modifier.fillMaxSize()) {
        SheetHeader(stringResource(R.string.chat), stringResource(R.string.done), onClose)
        Text(
            stringResource(R.string.chat_not_kept),
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            style = StarlingsType.caption, color = c.secondary, textAlign = TextAlign.Center,
        )
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = list,
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (messages.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.chat_empty),
                        Modifier.fillMaxWidth().padding(top = 40.dp),
                        style = StarlingsType.body, color = c.secondary, textAlign = TextAlign.Center,
                    )
                }
            }
            items(messages, key = { it.id }) { message -> ChatRow(m, message, me) }
        }
        error?.let { Text(it, Modifier.padding(horizontal = 16.dp), style = StarlingsType.subheadline, color = c.danger) }
        val empty = draft.isBlank()
        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.CenterEnd) {
            StarlingsField(
                draft, { draft = it; error = null }, stringResource(R.string.chat_placeholder),
                singleLine = false, maxLines = 4, trailingInset = 34.dp,
            )
            val send = stringResource(R.string.chat_send)
            Box(
                Modifier
                    .padding(end = 10.dp)
                    .size(26.dp)
                    .alpha(if (empty) 0.4f else 1f)
                    .background(c.accent, CircleShape)
                    .clickable(enabled = !empty, role = Role.Button) { if (m.send(draft)) draft = "" else error = tooLong }
                    .clearAndSetSemantics { contentDescription = send; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.ArrowUpward, null, Modifier.size(15.dp), tint = c.accentInk) }
        }
    }
}

@Composable
private fun ChatRow(m: Meeting, message: ChatMessage, me: String?) {
    val c = Starlings.colors
    // Yours are pushed over rather than stretched: a bubble that fills the width is a paragraph.
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (message.isLocal) Arrangement.End else Arrangement.Start) {
        if (message.isLocal) Spacer(Modifier.size(40.dp))
        Column(
            Modifier
                .weight(1f, fill = false)
                .background(if (message.isLocal) c.accent.copy(alpha = 0.18f) else c.elevated, RoundedCornerShape(StarlingsRadius.field))
                .padding(10.dp),
            horizontalAlignment = if (message.isLocal) Alignment.End else Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                "${if (message.isLocal) stringResource(R.string.you) else message.from} · ${CHAT_TIME.format(Instant.ofEpochMilli(message.atMs))}",
                style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = c.secondary,
            )
            Text(message.text, style = StarlingsType.body, color = c.primary)
            LinkPreviewCard(m, message.text)
            ChatReactions(m, message, me)
        }
        if (!message.isLocal) Spacer(Modifier.size(40.dp))
    }
}

/** `MobileChatReactionsRow`: a capsule per reaction (yours on the accent tint), then the palette behind a face. */
@Composable
private fun ChatReactions(m: Meeting, message: ChatMessage, me: String?) {
    val c = Starlings.colors
    var picking by remember { mutableStateOf(false) }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        message.reactions.forEach { (emoji, who) ->
            val label = Reactions.labelResource[emoji]?.let { stringResource(it) } ?: emoji
            val mine = me != null && me in who
            val ink = if (mine) c.accentMark else c.secondary
            Row(
                Modifier
                    .background(if (mine) c.accent.copy(alpha = 0.18f) else c.secondary.copy(alpha = 0.14f), CircleShape)
                    .clickable(role = Role.Button) { m.toggleChatReaction(message.id, emoji) }
                    .clearAndSetSemantics { contentDescription = "$label, ${who.size}"; role = Role.Button }
                    .padding(horizontal = 6.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ReactionGlyph(emoji, 14.dp, decorative = true, tint = ink)
                Text("${who.size}", style = StarlingsType.caption, color = ink)
            }
        }
        Box {
            val react = stringResource(R.string.chat_react)
            Box(
                Modifier.size(28.dp).clickable(role = Role.Button) { picking = true }.semantics { contentDescription = react },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Outlined.AddReaction, null, Modifier.size(16.dp), tint = c.secondary) }
            DropdownMenu(picking, { picking = false }) {
                Reactions.palette.forEach { emoji ->
                    val mine = me != null && me in message.reactions[emoji].orEmpty()
                    DropdownMenuItem(
                        text = { Text(Reactions.labelResource[emoji]?.let { stringResource(it) } ?: emoji) },
                        leadingIcon = { ReactionGlyph(emoji, 20.dp, decorative = true) },
                        trailingIcon = { if (mine) Icon(Icons.Filled.Check, null) },
                        onClick = { m.toggleChatReaction(message.id, emoji); picking = false },
                    )
                }
            }
        }
    }
}

/**
 * `MobileParticipantsSheet`: "In the room", one row a person, the facts in
 * caption lines under the name. Raised hands first, in the order they went
 * up, then everyone else. While reconnecting it says so first. A host gets
 * Mute everyone else, and Mute, Remove… and Stop share on everyone else's
 * row; the Worker checks the room and the lease again, so each is a request.
 */
@Composable
private fun People(tiles: List<Tile>, reconnecting: Boolean, host: RoomHost?, meetings: MeetingOwnerApi?, onClose: () -> Unit) {
    val c = Starlings.colors
    val people = tiles.filter { !it.screenShare }
    val hands = people.filter { it.handRaisedAt != null }.sortedBy { it.handRaisedAt }
    val rest = people.filter { it.handRaisedAt == null }
    val rows = hands + rest
    val shareKeys = tiles.filter { it.screenShare }.map { it.key }
    val hostState = host?.state?.collectAsStateWithLifecycle()?.value
    val moderates = host != null && meetings != null
    val scope = rememberCoroutineScope()
    var failure by remember { mutableStateOf<String?>(null) }
    var moderating by remember { mutableStateOf(false) }
    var stopping by remember { mutableStateOf(emptySet<String>()) }
    var removing by remember { mutableStateOf<Tile?>(null) }
    val pulse = rememberHapticPulse()
    HapticPulseEffect(pulse)
    HapticWhenSet(Haptic.ERROR, failure)

    // Taking somebody out is the heavier act; a mute is a confirmation.
    fun send(landed: Haptic, block: suspend MeetingOwnerApi.(room: String, meetingId: String) -> Unit, onDone: () -> Unit = {}) {
        val api = meetings ?: return
        val room = hostState?.room ?: return
        val meetingId = hostState.meetingId ?: return
        scope.launch {
            try {
                api.block(room, meetingId)
                failure = null
                pulse.fire(landed)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = RoomHost.describe(e)
            } finally {
                onDone()
            }
        }
    }
    fun moderate(identity: String?, remove: Boolean = false) {
        if (moderating) return
        moderating = true
        send(if (remove) Haptic.DESTRUCTIVE else Haptic.SUCCESS, { room, meetingId ->
            if (remove) identity?.let { remove(room, meetingId, it) } else mute(room, meetingId, identity)
        }) { moderating = false }
    }
    fun stopShare(identity: String) {
        stopping = stopping + identity
        send(Haptic.DESTRUCTIVE, { room, meetingId -> stopScreenShare(room, meetingId, identity) }) { stopping = stopping - identity }
    }

    Column(Modifier.fillMaxSize()) {
        SheetHeader(stringResource(R.string.people), stringResource(R.string.done), onClose)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.section)) {
            if (reconnecting) {
                Column {
                    ListSection(null) { ListRow { CaptionLabel(stringResource(R.string.people_reconnecting), Icons.Filled.Sync) } }
                    ListFooter(stringResource(R.string.people_reconnecting_footer))
                }
            }
            failure?.let { Text(it, Modifier.padding(horizontal = 16.dp), style = StarlingsType.body, color = c.danger) }
            if (moderates) {
                Column {
                    ListSection(null) {
                        ListActionRow(stringResource(R.string.people_mute_everyone), null, onClick = { moderate(null) }, enabled = !moderating)
                    }
                    ListFooter(stringResource(R.string.people_mute_everyone_footer))
                }
            }
            ListSection(stringResource(R.string.people_in_room)) {
                rows.forEachIndexed { i, p ->
                    ListRow(divider = i < rows.lastIndex) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(p.name, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
                            Text(stringResource(p.quality.labelResource), style = StarlingsType.caption, color = if (p.quality.isWeak) c.danger else c.secondary)
                        }
                        if (p.host) CaptionLabel(stringResource(R.string.role_host), Icons.Filled.Star)
                        // Which app they are on, as the lobby shows it before admission.
                        p.facts.client?.let { CaptionLabel(it, p.facts.app?.let(StarlingsIcons::client)) }
                        val place = hands.indexOf(p) + 1
                        if (place > 0) {
                            CaptionLabel(
                                if (place == 1) stringResource(R.string.hand_raised) else stringResource(R.string.hand_raised_number, place),
                                StarlingsIcons.hand,
                            )
                        }
                        if (p.facts.registered) CaptionLabel(stringResource(R.string.role_registered), Icons.Filled.ConfirmationNumber)
                        if (p.facts.notetaker) CaptionLabel(stringResource(R.string.role_notetaker), Icons.Filled.FiberManualRecord, c.danger)
                        val canModerate = Moderation.canModerate(moderates, p.isLocal)
                        if (canModerate) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                BorderedButton(stringResource(R.string.people_mute), { moderate(p.key) }, enabled = !moderating, compact = true)
                                BorderedButton(stringResource(R.string.people_remove_ellipsis), { removing = p }, enabled = !moderating, compact = true, foreground = c.danger)
                            }
                        }
                        if (Moderation.isSharing(p.key, shareKeys)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.weight(1f)) { CaptionLabel(stringResource(R.string.people_sharing), Icons.AutoMirrored.Filled.ScreenShare) }
                                if (canModerate) {
                                    BorderedButton(stringResource(R.string.people_stop_share), { stopShare(p.key) }, enabled = p.key !in stopping, compact = true)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    removing?.let { p ->
        EndForEveryoneDialog(
            title = stringResource(R.string.people_remove_title, p.name.ifBlank { stringResource(R.string.people_this_person) }),
            message = stringResource(R.string.people_remove_message),
            confirm = stringResource(R.string.people_remove),
            cancel = stringResource(R.string.people_cancel),
            onConfirm = { removing = null; moderate(p.key, remove = true) },
            onDismiss = { removing = null },
        )
    }
}

/**
 * Each reaction rises across the stage, captioned with its sender. Under
 * Reduce Motion (ui/Motion.kt) it still appears, captioned, and
 * fades in place near the bottom instead of climbing. That fade is timed
 * by the frame clock, not the animator, so Remove animations does not
 * skip it.
 */
@Composable
private fun Flights(m: Meeting) {
    val flying by m.flying.collectAsStateWithLifecycle()
    val c = Starlings.colors
    val reduceMotion = work.starlings.android.ui.rememberReduceMotion()
    BoxWithConstraints(Modifier.fillMaxSize().clearAndSetSemantics { }) {
        val height = maxHeight
        flying.forEach { f ->
            key(f.key) {
                val progress = remember { Animatable(0f) }
                LaunchedEffect(Unit) {
                    if (reduceMotion) {
                        val start = androidx.compose.runtime.withFrameMillis { it }
                        while (progress.value < 1f) {
                            val now = androidx.compose.runtime.withFrameMillis { it }
                            progress.snapTo(((now - start).toFloat() / Reactions.FLIGHT_MS).coerceAtMost(1f))
                        }
                    } else {
                        progress.animateTo(1f, tween(Reactions.FLIGHT_MS.toInt(), easing = LinearEasing))
                    }
                }
                val lane = (f.key % 5).toInt()
                Column(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .offset(x = (-16 - lane * 24).dp, y = if (reduceMotion) 0.dp else -(height * progress.value * 0.8f))
                        .alpha(1f - progress.value),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    ReactionGlyph(f.emoji, 36.dp, decorative = true)
                    Text(
                        f.from,
                        Modifier.floatingGlass(SCRIM, CircleShape).padding(horizontal = 6.dp, vertical = 2.dp),
                        style = StarlingsType.caption2, color = Color.White,
                    )
                }
            }
        }
    }
}

/**
 * `MobileTranscriptPanel`: the received captions this call holds in memory,
 * newest at the bottom, following the conversation. Nothing is kept.
 */
@Composable
private fun Transcript(m: Meeting, share: (@Composable (Modifier) -> Unit)?, onClose: () -> Unit) {
    val c = Starlings.colors
    val captions by m.captions.collectAsStateWithLifecycle()
    val list = rememberLazyListState()
    LaunchedEffect(captions.size) { if (captions.isNotEmpty()) list.animateScrollToItem(captions.lastIndex) }
    Column(Modifier.fillMaxSize()) {
        Box {
            SheetHeader(stringResource(R.string.transcript), stringResource(R.string.done), onClose)
            // While this device hosts, the record leaves through the leading menu.
            share?.invoke(Modifier.align(Alignment.CenterStart).padding(start = 16.dp))
        }
        if (captions.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(Icons.Filled.Subtitles, null, Modifier.size(40.dp), tint = c.secondary)
                Text(stringResource(R.string.transcript_empty), style = StarlingsType.title3.copy(fontWeight = FontWeight.Bold), color = c.primary)
                Text(stringResource(R.string.captions_empty), style = StarlingsType.body, color = c.secondary, textAlign = TextAlign.Center)
            }
        } else {
            LazyColumn(
                state = list,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(captions, key = { it.id }) { cap ->
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(cap.speaker, style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = c.secondary)
                        Text(cap.text, style = StarlingsType.body, color = if (cap.final) c.primary else c.secondary)
                    }
                }
            }
        }
    }
}

/**
 * `LinkPreviewCard` on iOS: the publisher's name, title and two lines of
 * description, with the picture in a fixed 1.91 box so the list never
 * reflows. Draws nothing when the page offered no title and no description.
 */
@Composable
private fun LinkPreviewCard(m: Meeting, text: String) {
    val c = Starlings.colors
    val preview by produceState<LinkPreview?>(null, text) { value = m.linkPreview(text) }
    val p = preview ?: return
    if (p.title.isNullOrEmpty() && p.description.isNullOrEmpty()) return
    val uri = LocalUriHandler.current
    val image by produceState<ImageBitmap?>(null, p.imageUrl) {
        value = p.imageUrl?.takeIf { it.isNotEmpty() }?.let { m.previewImage(it) }
            ?.let { bytes -> runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }.getOrNull() }
    }
    val shape = RoundedCornerShape(StarlingsRadius.field)
    Column(
        Modifier.padding(top = 4.dp).widthIn(max = 420.dp).fillMaxWidth()
            .clip(shape)
            .background(c.panel, shape)
            .border(1.dp, c.border, shape)
            .clickable { if (p.url.startsWith("https://")) runCatching { uri.openUri(p.url) } },
    ) {
        if (!p.imageUrl.isNullOrEmpty()) {
            Box(Modifier.fillMaxWidth().aspectRatio(1.91f).background(c.field)) {
                image?.let {
                    Image(it, p.imageAlt?.takeIf { alt -> alt.isNotEmpty() }, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                }
            }
        }
        Column(Modifier.padding(horizontal = 10.dp, vertical = 7.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(p.siteName?.takeIf { it.isNotEmpty() } ?: p.domain, style = StarlingsType.caption, color = c.secondary)
            p.title?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.primary, maxLines = 2) }
            p.description?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = StarlingsType.footnote, color = c.secondary, maxLines = 2)
            }
        }
    }
}

/**
 * The More control and its menu, as iOS: React, the hand, Flip camera, the
 * screen-share layout, then Hide my tile, Live transcript, People and
 * Captions. Five controls fit a phone's width; the rest live here.
 */
@Composable
private fun More(
    modifier: Modifier,
    call: CallSession,
    ui: CallUi,
    count: Int,
    captionsOn: Boolean,
    layout: StageLayout.ScreenShareChoice,
    selfViewHidden: Boolean,
    onReact: () -> Unit,
    onHand: () -> Unit,
    onFlip: () -> Unit,
    onShareLayout: (StageLayout.ScreenShareChoice) -> Unit,
    onSelfView: () -> Unit,
    onTranscript: () -> Unit,
    onPeople: () -> Unit,
    onCaptions: () -> Unit,
    /** File this meeting: the host's only; null for a guest. */
    onFiling: (() -> Unit)? = null,
    /** Lower all hands: the host's only, and shown only while a hand is up. */
    onLowerHands: (() -> Unit)? = null,
    extra: @Composable (close: () -> Unit) -> Unit = {},
) {
    val c = Starlings.colors
    var open by remember { mutableStateOf(false) }
    var backgroundOpen by remember { mutableStateOf(false) }
    Box(modifier) {
        CallControl(Icons.Filled.MoreHoriz, stringResource(R.string.more), stringResource(R.string.more), { open = true }, Modifier.fillMaxWidth())
        DropdownMenu(open, { open = false }) {
            @Composable
            fun item(text: String, icon: ImageVector, onClick: () -> Unit) = DropdownMenuItem(
                text = { Text(text, style = StarlingsType.body) },
                leadingIcon = { Icon(icon, null) },
                onClick = { onClick(); open = false },
            )
            item(stringResource(R.string.react), Icons.Outlined.SentimentSatisfied, onReact)
            item(
                stringResource(if (ui.handRaised) R.string.hand_lower else R.string.hand_raise),
                if (ui.handRaised) StarlingsIcons.hand else Icons.Outlined.PanTool,
                onHand,
            )
            if (ui.cameraOn) item(stringResource(R.string.camera_flip), Icons.Filled.Cameraswitch, onFlip)
            Text(
                stringResource(R.string.share_layout),
                Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                style = StarlingsType.footnote, color = c.secondary,
            )
            StageLayout.ScreenShareChoice.entries.forEach { choice ->
                item(
                    stringResource(choice.titleResource),
                    if (choice == layout) Icons.Filled.RadioButtonChecked else Icons.Filled.RadioButtonUnchecked,
                ) { onShareLayout(choice) }
            }
            HorizontalDivider(color = c.border)
            item(
                stringResource(if (selfViewHidden) R.string.tile_show else R.string.tile_hide),
                if (selfViewHidden) Icons.Filled.PersonOff else Icons.Filled.Person,
                onSelfView,
            )
            item(stringResource(R.string.transcript), Icons.Filled.Subtitles, onTranscript)
            item(stringResource(R.string.people_count, count), Icons.Filled.Groups, onPeople)
            // An item that would do nothing teaches people to stop reading the menu: none with no hand up.
            val raised = ui.tiles.count { !it.screenShare && it.handRaisedAt != null }
            if (raised > 0) onLowerHands?.let { item(pluralStringResource(R.plurals.hands_lower_all, raised, raised), Icons.Outlined.DoNotTouch, it) }
            onFiling?.let { item(stringResource(R.string.filing_title), Icons.Filled.Inventory2, it) }
            item(stringResource(if (captionsOn) R.string.captions_hide else R.string.captions), Icons.Filled.ClosedCaption, onCaptions)
            extra { open = false }
            if (call.backgroundEffectsSupported) {
                HorizontalDivider(color = c.border)
                item(stringResource(R.string.background), Icons.Filled.Portrait) { backgroundOpen = true }
            }
        }
        BackgroundMenu(call, backgroundOpen) { backgroundOpen = false }
    }
}

/** `MeetingConnectionQuality.label`. */
private val CallQuality.labelResource get() = when (this) {
    CallQuality.EXCELLENT -> R.string.quality_excellent
    CallQuality.GOOD -> R.string.quality_good
    CallQuality.POOR -> R.string.quality_poor
    CallQuality.LOST -> R.string.quality_lost
    CallQuality.UNKNOWN -> R.string.quality_measuring
}

private val StageLayout.ScreenShareChoice.titleResource get() = when (this) {
    StageLayout.ScreenShareChoice.AUTOMATIC -> R.string.layout_automatic
    StageLayout.ScreenShareChoice.OVERLAY -> R.string.layout_overlay
    StageLayout.ScreenShareChoice.RAIL -> R.string.layout_rail
}

@Composable
private fun ReactionButton(emoji: String, onClick: () -> Unit) {
    val label = Reactions.labelResource[emoji]?.let { stringResource(it) } ?: emoji
    Box(
        Modifier.size(48.dp).clickable(role = Role.Button, onClick = onClick).clearAndSetSemantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) { ReactionGlyph(emoji, 24.dp, decorative = true) }
}

/** The semantic icon for a wire emoji; an unknown one draws as its text. */
@Composable
private fun ReactionGlyph(emoji: String, size: Dp, decorative: Boolean = false, tint: Color = Starlings.colors.primary) {
    val icon = StarlingsIcons.reaction(emoji)
    if (icon != null) {
        val label = Reactions.labelResource[emoji]?.let { stringResource(it) }
        Icon(icon, if (decorative) null else label, Modifier.size(size), tint = tint)
    } else {
        Text(emoji, fontSize = (size.value * 0.8f).sp)
    }
}

/** The header's audio-route circle (`SwiftUIAudioRoutePickerButton` in a 42 well); TalkBack says the route. */
@Composable
private fun AudioRoute(ui: CallUi, call: CallSession) {
    var open by remember { mutableStateOf(false) }
    Box {
        HeaderCircleButton(Icons.Filled.VolumeUp, ui.audioDevice?.name ?: stringResource(R.string.audio), { open = true })
        DropdownMenu(open, { open = false }) {
            ui.audioDevices.forEach { device ->
                DropdownMenuItem(
                    text = { Text(device.name, style = StarlingsType.body) },
                    trailingIcon = { if (device == ui.audioDevice) Icon(Icons.Filled.Check, null) },
                    onClick = { call.selectAudio(device); open = false },
                )
            }
        }
    }
}

/**
 * The iOS stage: a screen share takes the stage with a participant rail;
 * otherwise peers fill an equal square grid. The local camera is a separate
 * square inset at the top, so joins and shares never move it. `reserved` is
 * the foot floating on the stage's bottom edge; the grid stops above it.
 */
@Composable
private fun Stage(
    room: Room,
    tiles: List<Tile>,
    modifier: Modifier,
    choice: StageLayout.ScreenShareChoice,
    selfViewHidden: Boolean,
    reserved: Dp,
) {
    val c = Starlings.colors
    BoxWithConstraints(modifier) {
        val w = maxWidth.value
        val h = (maxHeight - reserved).value.coerceAtLeast(1f)
        if (w <= 0 || maxHeight.value <= 0) return@BoxWithConstraints
        val gap = StageLayout.TILE_SPACING
        val localTile = tiles.firstOrNull { it.isLocal && !it.screenShare }
        val peers = tiles.filter { it !== localTile }
        val local = localTile.takeIf { !selfViewHidden }
        val inset = local?.let { StageLayout.selfInsetSide(w).let { side -> StageRect((w - side) / 2, gap, side, side) } }
        val share = peers.firstOrNull { it.screenShare }
        Box(Modifier.size(w.dp, h.dp)) {
            when {
                share != null -> {
                    val strip = peers.filter { it !== share }
                    val plan = StageLayout.screenShare(w, h, strip.size, inset, choice)
                    TileView(room, share, Modifier.place(plan.share))
                    if (plan.railMode != StageLayout.RailMode.NONE) {
                        val scroll = rememberScrollState()
                        val rail = Modifier.place(plan.rail).let {
                            if (plan.railMode == StageLayout.RailMode.VERTICAL) it.verticalScroll(scroll) else it.horizontalScroll(scroll)
                        }
                        Box(rail) {
                            Box(Modifier.size(plan.railContentWidth.dp, plan.railContentHeight.dp)) {
                                strip.forEachIndexed { i, tile -> key(tile.key) { TileView(room, tile, Modifier.place(plan.participants[i]), rail = true) } }
                            }
                        }
                    }
                }
                peers.isNotEmpty() -> {
                    val plan = StageLayout.equalGrid(peers.size, w, h, gap)
                    Column(
                        Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(gap.dp, Alignment.CenterVertically),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        peers.chunked(plan.columns).forEach { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(gap.dp)) {
                                row.forEach { tile -> key(tile.key) { TileView(room, tile, Modifier.size(plan.cell.dp)) } }
                            }
                        }
                    }
                }
                else -> Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(Icons.Filled.People, null, Modifier.size(36.dp), tint = c.secondary)
                    Text(stringResource(R.string.stage_waiting), style = StarlingsType.body, color = c.secondary)
                }
            }
            if (local != null && inset != null) TileView(room, local, Modifier.place(inset), selfInset = true)
        }
    }
}

private fun Modifier.place(r: StageRect) = offset(r.x.dp, r.y.dp).size(r.width.dp, r.height.dp)

/**
 * `MobileVideoTile`: video or the initials avatar, clipped at 16 (12 for the
 * self inset); the name capsule on glass at the bottom leading corner, the
 * accent hand badge at the top leading corner, and the outline: a share in
 * primary ink, a speaker in the accent, everyone else the hairline. The self
 * inset drops the name and keeps the hand and the ring; a rail tile drops the
 * name unless it is the share.
 */
@Composable
private fun TileView(room: Room, tile: Tile, modifier: Modifier, selfInset: Boolean = false, rail: Boolean = false) {
    val c = Starlings.colors
    val radius = if (selfInset) StarlingsRadius.selfInset else StarlingsRadius.tile
    val shape = RoundedCornerShape(radius)
    val (outline, width) = when {
        tile.screenShare -> c.primary to 3.dp
        tile.speaking -> c.accent to 3.dp
        else -> c.border to 1.dp
    }
    Box(
        modifier
            .then(if (selfInset) Modifier.shadow(8.dp, shape, ambientColor = Color.Black.copy(alpha = 0.35f), spotColor = Color.Black.copy(alpha = 0.35f)) else Modifier)
            .clip(shape)
            .background(c.panel),
    ) {
        val video = tile.video
        if (video != null) {
            Box(Modifier.fillMaxSize().background(Color.Black)) { Video(room, video) }
        } else {
            Avatar(tile.initialsOf)
        }
        if (!selfInset && (!rail || tile.screenShare)) {
            Text(
                if (tile.host) stringResource(R.string.tile_host, tile.name) else tile.name,
                Modifier
                    .align(Alignment.BottomStart)
                    .padding(8.dp)
                    .floatingGlass(SCRIM, CircleShape)
                    .padding(horizontal = 8.dp, vertical = 5.dp),
                style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold),
                color = Color.White,
                maxLines = 1,
            )
        }
        // Rail thumbnails drop the bars, as iOS; a share is the sharer's own line.
        if (!rail) {
            QualityBadge(
                tile.quality,
                stringResource(R.string.quality_label, stringResource(tile.quality.labelResource)),
                Modifier.align(Alignment.BottomEnd).padding(if (selfInset) 4.dp else 8.dp),
                small = selfInset,
            )
        }
        // A screen has no hand: the badge belongs to the person's camera tile.
        if (tile.handRaisedAt != null && !tile.screenShare) {
            val side = if (selfInset) 20.dp else 26.dp
            Box(
                Modifier.align(Alignment.TopStart).padding(if (selfInset) 4.dp else 8.dp).size(side).background(c.accent, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(StarlingsIcons.hand, stringResource(R.string.hand_raised), Modifier.size(if (selfInset) 10.dp else 13.dp), tint = c.accentInk)
            }
        }
        Box(Modifier.fillMaxSize().border(width, outline, shape))
    }
}

/** `MobileParticipantAvatar`: initials in a circle at 46% of the short side, at most 128, on the panel rung. */
@Composable
private fun Avatar(initialsOf: String) {
    val c = Starlings.colors
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val d = (minOf(maxWidth, maxHeight) * 0.46f).coerceAtMost(128.dp)
        Box(
            Modifier.size(d).background(c.elevated, CircleShape).border(1.dp, c.border, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                ParticipantInitials.make(initialsOf),
                fontSize = maxOf(11f, d.value * 0.34f).sp,
                fontWeight = FontWeight.SemiBold,
                color = c.primary,
            )
        }
    }
}

@Composable
fun Video(room: Room, track: VideoTrack) {
    key(track) {
        AndroidView(
            factory = { context ->
                TextureViewRenderer(context).also {
                    room.initVideoRenderer(it)
                    track.addRenderer(it)
                }
            },
            onRelease = {
                track.removeRenderer(it)
                it.release()
            },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
