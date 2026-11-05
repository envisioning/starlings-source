package work.starlings.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import work.starlings.android.ui.LocalHorizontalSizeClass
import work.starlings.android.ui.SizeClasses
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.livekit.android.room.track.CameraPosition
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import work.starlings.contracts.StarlingsMintedBookingProjection
import kotlinx.coroutines.flow.MutableStateFlow
import work.starlings.android.host.HostSurface
import work.starlings.android.host.KnockNotifier
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticOnChange
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.ui.DeviceChooser
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.GatheringDots
import work.starlings.android.ui.GatheringDotsView
import work.starlings.android.ui.MediaButton
import work.starlings.android.ui.MenuHeader
import work.starlings.android.ui.PlainButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsCard
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsSize
import work.starlings.android.ui.StarlingsSpacing
import work.starlings.android.ui.StarlingsType
import kotlinx.coroutines.launch
import work.starlings.android.workspace.WorkspaceShell
import work.starlings.android.host.rememberHostStarter
import work.starlings.android.workspace.team.MessageNotifier
import work.starlings.android.widgets.LaunchAction
import work.starlings.android.widgets.NextMeetingDoor
import work.starlings.android.widgets.WidgetStore
import java.io.File

class MainActivity : ComponentActivity() {
    private val incomingLink = MutableStateFlow<String?>(null)
    /** A workspace web path from a notification's tap, taken once by the shell's navigator. */
    private val incomingPath = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as StarlingsApp
        route(intent, fresh = savedInstanceState == null)
        val call = app.call
        setContent {
            // iOS `horizontalSizeClass` (ui/SizeClass.kt): read again on each rotation, resize and multi-window change.
            @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
            val window = calculateWindowSizeClass(this)
            CompositionLocalProvider(LocalHorizontalSizeClass provides SizeClasses.horizontal(window)) {
                StarlingsTheme {
                    // The one canvas every screen stands on (`meetSurfaceBackground`).
                    Box(Modifier.fillMaxSize().background(Starlings.colors.canvas)) {
                        // One runtime per workspace (slice E): a switch replaces the account, and
                        // every store and screen remembered under the old one goes with it.
                        val account = app.accounts.collectAsStateWithLifecycle().value
                        key(account) {
                            LaunchedEffect(account) {
                                announceArrival(app)
                                app.workspaces.takeCarried()?.let { incomingLink.value = it }
                                app.refreshWorkspace()
                            }
                            App(app, call, account, incomingLink.collectAsStateWithLifecycle().value, incomingPath.collectAsStateWithLifecycle().value) { incomingPath.value = null }
                        }
                        LinkOfferDialog(app)
                        // The toast's host for every screen outside the tabs; the shell's own host wins inside them.
                        work.starlings.android.ui.StarlingsToastHost(work.starlings.android.ui.TOAST_DEPTH_ROOT, Modifier.safeDrawingPadding())
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        route(intent)
    }

    override fun onResume() {
        super.onResume()
        (application as StarlingsApp).resumedWithoutCallback()
        // Shares kept while offline go out when the app comes to the front (share/ShareDrain.kt).
        work.starlings.android.share.ShareDrain.drain(application as StarlingsApp)
    }

    /** A sign-in callback goes to the account; anything else is a room link. */
    private fun route(intent: Intent?, fresh: Boolean = true) {
        // A knock notification's tap opens the waiting room (host/KnockNotifier.kt).
        if (intent?.getBooleanExtra(KnockNotifier.EXTRA_WAITING_ROOM, false) == true) {
            (application as StarlingsApp).host.value?.showWaitingRoom()
            return
        }
        // A Quick Settings tile's verb (widgets/Controls.kt), as `performLaunchAction`.
        LaunchAction.from(intent?.getStringExtra(LaunchAction.EXTRA))?.let { action ->
            if (fresh) perform(action)
            return
        }
        // A message notification's tap opens the conversation (workspace/team/MessageNotifier.kt).
        // A recreated activity keeps its first intent: the conversation was opened already.
        intent?.getStringExtra(MessageNotifier.EXTRA_PATH)?.let { path ->
            if (fresh) incomingPath.value = path
            return
        }
        val link = intent?.dataString ?: return
        val app = application as StarlingsApp
        if (app.handleCallback(link)) return
        when (val route = AppLinks.route(link)) {
            // A recreated activity keeps its first intent: the path was opened already.
            is AppLinks.Route.Path -> if (fresh) incomingPath.value = route.path
            // Recreated, the join flow is still on this link: hand it back as it was, with no new offer.
            is AppLinks.Route.Link -> if (fresh) app.openLink(route.link) { incomingLink.value = it } else if (WorkspaceLinks.isActive(route.link)) incomingLink.value = route.link
            AppLinks.Route.Ignore -> Unit
        }
    }

    private fun perform(action: LaunchAction) {
        when (action) {
            LaunchAction.NEW_QUICK_NOTE -> LaunchAction.pendingQuickNote.value = true
            LaunchAction.JOIN_NEXT_MEETING -> {
                val agenda = WidgetStore.agenda(this, (application as StarlingsApp).account)
                when (val door = NextMeetingDoor.resolve(agenda, System.currentTimeMillis())) {
                    is NextMeetingDoor.Room -> incomingLink.value = door.link
                    is NextMeetingDoor.External -> runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(door.url))) }
                    is NextMeetingDoor.Event -> incomingPath.value = door.path
                    NextMeetingDoor.Calendar -> incomingPath.value = NextMeetingDoor.CALENDAR_PATH
                }
            }
        }
    }
}

/**
 * The guest's name and email, kept on the device as iOS keeps
 * `meet.guest.name` and `meet.guest.email`: the welcome card and Continue
 * write them, the room entry reads them.
 */
private class GuestPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("guest", Context.MODE_PRIVATE)
    val name: String get() = prefs.getString("name", null).orEmpty()
    val email: String get() = prefs.getString("email", null).orEmpty()
    fun save(name: String, email: String) {
        prefs.edit()
            .putString("name", GuestEntry.normalizedName(name))
            .putString("email", GuestEntry.normalizedEmail(email))
            .apply()
    }
}

/**
 * The surfaces of iOS `JoinView`: room entry and prejoin (Idle), the waiting
 * room, the meeting, ended. Every one but the meeting stands under the
 * "Join" title bar with Close, as the iOS navigation bar.
 */
@Composable
private fun App(app: StarlingsApp, call: CallSession, account: OwnerAccount, incomingLink: String?, incomingPath: String?, onPathTaken: () -> Unit) {
    val state by call.state.collectAsStateWithLifecycle()
    // Hosting owns the screen from Start until the meeting ends (host/HostScreens.kt).
    val host = app.host.collectAsStateWithLifecycle().value
    if (host != null) {
        Box(Modifier.safeDrawingPadding()) {
            HostSurface(host, onClose = app::clearHost) { openWaitingRoom -> CallScreen(call, host, openWaitingRoom, account) }
        }
        return
    }
    // The join flow's room input while the flow is open over the tabs or the
    // welcome card; null while it is closed. A room link opens it.
    var joinLink by rememberSaveable(incomingLink) { mutableStateOf(incomingLink) }
    // `JoinView`: in is a success, every other step is just a screen. Out:
    // a closed room or a dropped line is felt, this phone's own Leave is not.
    HapticOnChange(state) { old, new ->
        when {
            new == CallState.InCall && old != CallState.InCall -> Haptic.SUCCESS
            new is CallState.Ended && old !is CallState.Ended -> when {
                new.left -> null
                new.failure -> Haptic.ERROR
                else -> Haptic.WARNING
            }
            else -> null
        }
    }
    Box(Modifier.safeDrawingPadding()) {
        when (val s = state) {
            CallState.Idle -> Idle(call, account, joinLink, incomingPath, onPathTaken) { joinLink = it }
            CallState.Knocking -> JoinFrame(call::leave) { WaitingRoom(stringResource(R.string.lobby_asking), call::leave) }
            is CallState.Waiting -> JoinFrame(call::leave) {
                WaitingRoom(
                    when {
                        s.waitingCount > 1 -> pluralStringResource(R.plurals.lobby_waiting_count, s.waitingCount, s.waitingCount)
                        s.ownerName != null -> stringResource(R.string.lobby_waiting_for, s.ownerName)
                        else -> stringResource(R.string.lobby_waiting)
                    },
                    call::leave,
                )
            }
            CallState.Connecting -> JoinFrame(call::leave) { WaitingRoom(stringResource(R.string.lobby_joining), call::leave) }
            CallState.InCall -> CallScreen(call)
            is CallState.Ended -> JoinFrame({ joinLink = null; call.reset() }) {
                Ended(
                    call, s,
                    onBackToRoom = {
                        joinLink = s.room?.let { GuestEntry.canonicalUrl(Workspaces.active.webOrigin, RoomLink.Parsed(it, null)) }.orEmpty()
                        call.reset()
                    },
                    onAnother = { joinLink = ""; call.reset() },
                )
            }
        }
    }
}

/**
 * The iOS `NavigationStack` bar over the join flow: "Join" inline in the
 * middle, Close as the cancellation action at the leading edge.
 */
@Composable
private fun JoinFrame(onClose: () -> Unit, content: @Composable () -> Unit) {
    val c = Starlings.colors
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
            Text(
                stringResource(R.string.join_title),
                Modifier.semantics { heading() },
                style = StarlingsType.headline, color = c.primary,
            )
            PlainButton(stringResource(R.string.close), onClose, Modifier.align(Alignment.CenterStart), color = c.primary)
        }
        Box(Modifier.weight(1f)) { content() }
    }
}

/**
 * No call: a signed-in owner gets the workspace tabs, and the join flow
 * opens over them for a room link or Join a room, with Close back to the
 * tab. Signed out it is iOS `MobileVisitorRoot`: the welcome card, and the
 * join flow once the card hands it a room.
 */
@Composable
private fun Idle(
    call: CallSession,
    account: OwnerAccount,
    joinLink: String?,
    incomingPath: String?,
    onPathTaken: () -> Unit,
    onJoinLink: (String?) -> Unit,
) {
    val signedIn = account.account.collectAsStateWithLifecycle().value is Account.SignedIn
    val startHosting = rememberHostStarter()
    val startRoom = { startHosting(null) }
    when {
        joinLink != null -> JoinFrame({ onJoinLink(null) }) { Entry(call, account, joinLink) }
        signedIn -> WorkspaceShell(account, onJoinRoom = { room -> onJoinLink(room) }, onStartRoom = startRoom, incomingPath = incomingPath, onPathTaken = onPathTaken)
        else -> Welcome(account) { onJoinLink(it) }
    }
}

/**
 * `MobileFirstRunCard` in `EnvisioningWelcomeShell`: the flock, the
 * wordmark and the line under it, then the card (the guest's name, email
 * and room, Continue, the privacy sentence, "or", the workspace to sign in
 * to, and what went wrong), then the version line. Continue checks name,
 * email and room in the Mac's order and opens the join flow on the room.
 */
@Composable
private fun Welcome(account: OwnerAccount, onJoin: (String) -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val guest = remember { GuestPrefs(context) }
    val clipboard = LocalClipboardManager.current
    val accountState by account.account.collectAsStateWithLifecycle()
    var name by rememberSaveable { mutableStateOf(guest.name) }
    var email by rememberSaveable { mutableStateOf(guest.email) }
    var room by rememberSaveable { mutableStateOf("") }
    var problem by rememberSaveable { mutableStateOf<GuestEntry.Problem?>(null) }
    val app = context.applicationContext as StarlingsApp
    val scope = rememberCoroutineScope()
    var doorBusy by remember { mutableStateOf<String?>(null) }
    var doorProblem by remember { mutableStateOf<AddWorkspaceFlow.Failure?>(null) }
    var adding by rememberSaveable { mutableStateOf(false) }
    val signingIn = accountState == Account.SigningIn
    val status = problem?.let {
        stringResource(
            when (it) {
                GuestEntry.Problem.NAME_MISSING -> R.string.guest_name_missing
                GuestEntry.Problem.EMAIL_INVALID -> R.string.guest_email_invalid
                GuestEntry.Problem.ROOM_INVALID -> R.string.guest_room_invalid
            },
        )
    } ?: doorProblem?.let { stringResource(AddWorkspaceFlow.message(it)) } ?: (accountState as? Account.Failed)?.message

    fun continueAsGuest() {
        when (val outcome = GuestEntry.check(name, email, room)) {
            is GuestEntry.Outcome.Invalid -> problem = outcome.problem
            is GuestEntry.Outcome.Ready -> {
                problem = null
                guest.save(outcome.name, outcome.email)
                // A link for another workspace opens there, with the same guest
                // details, which are kept above and read again after the change.
                if (!WorkspaceLinks.isActive(room)) {
                    app.openLink(room.trim(), onJoin)
                    return
                }
                room = outcome.room.slug
                onJoin(GuestEntry.canonicalUrl(Workspaces.active.webOrigin, outcome.room))
            }
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // 24 crowds the mark against the status bar on a phone.
        Spacer(Modifier.height(56.dp))
        Column(
            Modifier.padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            GatheringDotsView(44.dp, c.primary)
            Text(
                stringResource(R.string.welcome_product),
                Modifier.semantics { heading() },
                fontSize = 32.sp, fontWeight = FontWeight.Medium, color = c.primary,
            )
            Text(stringResource(R.string.welcome_subtitle), style = StarlingsType.callout, color = c.secondary, textAlign = TextAlign.Center)
        }
        val card = RoundedCornerShape(StarlingsRadius.card)
        Column(
            Modifier
                .widthIn(max = 520.dp)
                .fillMaxWidth()
                .background(c.panel, card)
                .border(1.dp, c.border, card)
                .padding(horizontal = 24.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            StarlingsField(
                name, { name = it; problem = null }, stringResource(R.string.join_name_field),
                capitalization = KeyboardCapitalization.Words,
            )
            StarlingsField(
                email, { email = it; problem = null }, stringResource(R.string.welcome_email),
                keyboardType = KeyboardType.Email,
            )
            Row(
                Modifier.padding(bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StarlingsField(room, { room = it; problem = null }, stringResource(R.string.welcome_room), Modifier.weight(1f))
                val paste = stringResource(R.string.welcome_paste)
                val hint = stringResource(R.string.welcome_paste_hint)
                Box(
                    Modifier
                        .size(40.dp, 48.dp)
                        .clickable(role = Role.Button) {
                            clipboard.getText()?.text?.let(GuestEntry::pasted)?.let { room = it; problem = null }
                        }
                        .clearAndSetSemantics { contentDescription = "$paste. $hint"; role = Role.Button },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.ContentPaste, null, Modifier.size(20.dp), tint = c.secondary) }
            }
            FilledButton(stringResource(R.string.join_continue), ::continueAsGuest, enabled = !signingIn)
            // Same sentences as the Mac door and the web room entry.
            Text(stringResource(R.string.welcome_privacy), style = StarlingsType.caption, color = c.secondary, textAlign = TextAlign.Center)
            Text(
                stringResource(R.string.welcome_or),
                Modifier.padding(vertical = 2.dp),
                style = StarlingsType.caption.copy(fontWeight = FontWeight.Medium), color = c.secondary,
            )
            // Every workspace this phone has signed in to, one tap from its
            // sign-in, then Enter an address.
            WorkspaceDoor(
                app,
                busyOrigin = doorBusy ?: account.workspace.webOrigin.takeIf { signingIn },
                onPick = { workspace ->
                    problem = null
                    doorProblem = null
                    doorBusy = workspace.webOrigin
                    scope.launch {
                        doorProblem = pickOnDoor(app, workspace, context)
                        doorBusy = null
                    }
                },
                onEnterAddress = {
                    problem = null
                    doorProblem = null
                    adding = true
                },
            )
            if (adding) {
                AddWorkspaceSheet(app, onDismiss = { adding = false }) {
                    account.dismissFailure()
                    account.signIn(context)
                }
            }
            status?.let {
                val unable = stringResource(R.string.welcome_unable, it)
                Text(
                    it,
                    Modifier.padding(top = 4.dp).semantics { contentDescription = unable },
                    style = StarlingsType.caption, color = c.danger, textAlign = TextAlign.Center,
                )
            }
        }
        VersionLine(Modifier.padding(top = 14.dp))
        Spacer(Modifier.height(24.dp))
    }
}

/** `EnvisioningVersionLine`: `Version 1.0.0 · Build 245 · Production`, caption, secondary. */
@Composable
private fun VersionLine(modifier: Modifier = Modifier) {
    val line = stringResource(R.string.welcome_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toString()) +
        " · " + AppEnvironment.name(BuildConfig.ORIGIN)
    Text(line, modifier, style = StarlingsType.caption, color = Starlings.colors.secondary, textAlign = TextAlign.Center)
}

/**
 * Signed in as the owner, as a `StarlingsCard` (the room entry's "Signed
 * in as" card). Signed out, the welcome card is where sign-in lives.
 */
@Composable
private fun AccountRow(account: OwnerAccount) {
    val state by account.account.collectAsStateWithLifecycle()
    val c = Starlings.colors
    val a = state as? Account.SignedIn ?: return
    StarlingsCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    // `person.crop.circle.badge.checkmark`; the line beside it says who.
                    Icon(Icons.Filled.HowToReg, null, Modifier.size(20.dp), tint = c.secondary)
                    Text(stringResource(R.string.signed_in_as, a.name), style = StarlingsType.body, color = c.secondary)
                }
                Text(a.email, Modifier.padding(start = 28.dp), style = StarlingsType.caption, color = c.secondary)
            }
            BorderedButton(stringResource(R.string.sign_out), account::signOut, compact = true)
        }
    }
}

/**
 * `JoinView.ended`: the glyph, the large title, the reason in secondary
 * headline, then "Lasted", the room and where the transcript is in
 * subheadline, then Back to this room and Join another room at most 360
 * wide. Android adds the A0 call log under them.
 */
@Composable
private fun Ended(call: CallSession, ended: CallState.Ended, onBackToRoom: () -> Unit, onAnother: () -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val failed = ended.reason == stringResource(R.string.ended_disconnected)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(StarlingsSpacing.screenCentred),
        verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.stack, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(if (failed) Icons.Filled.Warning else Icons.Filled.CheckCircle, null, Modifier.size(48.dp), tint = c.secondary)
        Text(
            stringResource(if (failed) R.string.ended_failed else R.string.ended_title),
            style = StarlingsType.largeTitle, color = c.primary, textAlign = TextAlign.Center,
        )
        Text(ended.reason, style = StarlingsType.headline, color = c.secondary, textAlign = TextAlign.Center)
        if (ended.room != null) {
            Column(verticalArrangement = Arrangement.spacedBy(7.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                ended.connectedMs?.let { ms ->
                    val d = EndedFacts.duration(ms)
                    val label = if (d.minutes > 0) stringResource(R.string.duration_minutes, d.minutes, d.seconds)
                    else stringResource(R.string.duration_seconds, d.seconds)
                    Text(stringResource(R.string.ended_lasted, label), style = StarlingsType.subheadline, color = c.secondary)
                }
                Text(stringResource(R.string.ended_room, ended.room), style = StarlingsType.subheadline, color = c.secondary)
                if (!failed) Text(stringResource(R.string.ended_transcript), style = StarlingsType.subheadline, color = c.secondary)
            }
        }
        FilledButton(stringResource(R.string.ended_back_to_room), onBackToRoom, Modifier.widthIn(max = 360.dp))
        BorderedButton(stringResource(R.string.ended_join_another), onAnother, Modifier.widthIn(max = 360.dp))
        call.logFile?.takeIf { it.exists() }?.let { file ->
            PlainButton(stringResource(R.string.share_log), { shareLog(context, file) })
        }
    }
}

private fun shareLog(context: Context, file: File) {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val send = Intent(Intent.ACTION_SEND)
        .setType("application/json")
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(send, context.getString(R.string.share_log)))
}

/**
 * `JoinView.roomEntry`, then `JoinView.prejoin`: the room and who you are,
 * Continue, then the camera, the microphone and Ask to join. The step is
 * this screen's own; the call only starts on Ask to join, as before.
 */
@Composable
private fun Entry(call: CallSession, account: OwnerAccount, incomingLink: String?) {
    val context = LocalContext.current
    val guest = remember { GuestPrefs(context) }
    var link by rememberSaveable(incomingLink) { mutableStateOf(incomingLink.orEmpty()) }
    var name by rememberSaveable { mutableStateOf(guest.name) }
    var email by rememberSaveable { mutableStateOf(guest.email) }
    var mic by rememberSaveable { mutableStateOf(true) }
    var camera by rememberSaveable { mutableStateOf(false) }
    var blocked by rememberSaveable { mutableStateOf<Int?>(null) }
    var prejoin by rememberSaveable { mutableStateOf(false) }
    val parsed = RoomLink.parse(link)
    // The room check, as the web: whose room it is, or that there is none,
    // and with a booking token the invite (`roomInputChanged`).
    var room by remember { mutableStateOf<PublicRoom?>(null) }
    var missing by remember { mutableStateOf(false) }
    var invite by remember { mutableStateOf<StarlingsMintedBookingProjection?>(null) }
    var loadingContext by remember { mutableStateOf(false) }
    // A signed-in member's owner token: an internal room answers only a verified member.
    var member by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(parsed) {
        room = null
        missing = false
        invite = null
        val p = parsed ?: run { loadingContext = false; return@LaunchedEffect }
        loadingContext = true
        delay(300)
        member = memberToken(account)
        coroutineScope {
            val publicRoom = async { runCatching { call.api.room(p.slug, member) } }
            val booking = async { p.bookingToken?.let { call.api.booking(p.slug, it) } }
            publicRoom.await().onSuccess { room = it; missing = it == null }
            invite = booking.await()
        }
        // The member's own name and address, then the invite's: it names the person, wins, and stays editable.
        room?.you?.let { you -> BookingInvite.applied(name, email, BookingInvite.Identity(you.name, you.email)).let { (n, e) -> name = n; email = e } }
        invite?.let(BookingInvite::invitedIdentity)?.let { who -> BookingInvite.applied(name, email, who).let { (n, e) -> name = n; email = e } }
        loadingContext = false
    }

    fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) call.startPreview() else { camera = false; blocked = R.string.permission_camera }
    }
    // As iOS: a wanted microphone or camera without access stops the join and
    // says where to allow it; the person can also switch it off and join.
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        blocked = when {
            mic && result[Manifest.permission.RECORD_AUDIO] != true -> R.string.permission_mic
            camera && result[Manifest.permission.CAMERA] != true -> R.string.permission_camera
            else -> null
        }
        if (blocked == null && parsed != null) {
            call.join(parsed, GuestEntry.normalizedName(name), GuestEntry.normalizedEmail(email), mic, camera, room?.ownerName, member)
        }
    }
    // The preview belongs to the prejoin, as on iOS.
    LaunchedEffect(camera, prejoin) {
        if (prejoin && camera && granted(Manifest.permission.CAMERA)) call.startPreview() else call.stopPreview()
    }
    DisposableEffect(Unit) { onDispose { call.stopPreview() } }

    val ready = parsed != null && !missing && GuestEntry.isValid(name, email)
    if (!prejoin || !ready) {
        RoomEntry(
            link, { link = it }, name, { name = it }, email, { email = it },
            ownerName = room?.ownerName,
            missingSlug = parsed?.slug?.takeIf { missing },
            ready = ready,
            account = account,
            internalName = room?.takeIf { it.internal == true }?.you?.name,
            invite = invite?.let { BookingInvite.card(it, System.currentTimeMillis()) },
            inviteLoading = loadingContext && parsed?.bookingToken != null,
        ) {
            // `continueToPrejoin` keeps the guest's details for next time.
            guest.save(name, email)
            prejoin = true
        }
    } else {
        Prejoin(
            call, mic, camera, blocked,
            onMic = { mic = !mic; blocked = null },
            onCamera = {
                blocked = null
                camera = !camera
                if (camera && !granted(Manifest.permission.CAMERA)) cameraPermission.launch(Manifest.permission.CAMERA)
            },
            onSettings = {
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                )
            },
            onAsk = {
                permissions.launch(
                    arrayOf(
                        Manifest.permission.RECORD_AUDIO,
                        Manifest.permission.CAMERA,
                        Manifest.permission.BLUETOOTH_CONNECT,
                        Manifest.permission.POST_NOTIFICATIONS,
                    ),
                )
            },
            onBack = { camera = false; prejoin = false },
        )
    }
}

/** `JoinView.roomEntry`: the large title, the line under it, three wells, Continue. */
@Composable
private fun RoomEntry(
    link: String, onLink: (String) -> Unit,
    name: String, onName: (String) -> Unit,
    email: String, onEmail: (String) -> Unit,
    ownerName: String?,
    missingSlug: String?,
    ready: Boolean,
    account: OwnerAccount,
    /** An internal room names the signed-in member: a card, not the name and email wells. */
    internalName: String? = null,
    invite: BookingInvite.Card? = null,
    inviteLoading: Boolean = false,
    onContinue: () -> Unit,
) {
    val c = Starlings.colors
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(StarlingsSpacing.screen),
        verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.section),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.titleGap)) {
            Text(stringResource(R.string.join_room_title), style = StarlingsType.largeTitle, color = c.primary)
            Text(
                ownerName?.let { stringResource(R.string.entry_owner_room, it) } ?: stringResource(R.string.join_room_hint),
                style = StarlingsType.body, color = c.secondary,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.fields)) {
            StarlingsField(
                link, onLink, stringResource(R.string.join_room_field),
                label = stringResource(R.string.entry_link), keyboardType = KeyboardType.Uri,
            )
            HapticWhenSet(Haptic.ERROR, missingSlug)
            missingSlug?.let { Text(stringResource(R.string.entry_no_room, it), style = StarlingsType.subheadline, color = c.danger) }
            if (internalName != null) {
                StarlingsCard {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.HowToReg, null, Modifier.size(20.dp), tint = c.secondary)
                        Text(stringResource(R.string.signed_in_as, internalName), style = StarlingsType.body, color = c.secondary)
                    }
                }
            } else {
                StarlingsField(
                    name, onName, stringResource(R.string.join_name_field),
                    label = stringResource(R.string.entry_name), capitalization = KeyboardCapitalization.Words,
                )
                StarlingsField(
                    email, onEmail, stringResource(R.string.join_email_field),
                    label = stringResource(R.string.entry_email), keyboardType = KeyboardType.Email,
                )
            }
        }
        InviteContext(invite, inviteLoading)
        FilledButton(
            stringResource(R.string.join_continue), onContinue,
            enabled = ready, icon = Icons.AutoMirrored.Filled.ArrowForward,
        )
        AccountRow(account)
    }
}

/** `JoinView.roomContext`: "Loading invite…" while a booking token is read, then the invite's card. */
@Composable
private fun InviteContext(invite: BookingInvite.Card?, loading: Boolean) {
    val c = Starlings.colors
    if (loading) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            GatheringDotsView(20.dp, c.secondary, GatheringDots.Motion.MURMURATION)
            Text(stringResource(R.string.invite_loading), style = StarlingsType.body, color = c.secondary)
        }
        return
    }
    when (invite) {
        null -> Unit
        BookingInvite.Card.Expired -> StarlingsCard {
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(stringResource(R.string.invite_expired), style = StarlingsType.headline, color = c.primary)
                Text(stringResource(R.string.invite_still_ask), style = StarlingsType.body, color = c.secondary)
            }
        }
        is BookingInvite.Card.Scheduled -> StarlingsCard {
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                invite.title?.let { Text(it, style = StarlingsType.headline, color = c.primary) }
                invite.startsAtMs?.let { start ->
                    Text(inviteRange(start, invite.endsAtMs), style = StarlingsType.subheadline.copy(fontWeight = FontWeight.Medium), color = c.primary)
                }
                invite.subject?.let { Text(it, style = StarlingsType.subheadline, color = c.secondary, maxLines = 3) }
            }
        }
    }
}

/** `inviteRange`: the weekday, month and day in the reader's language, then a 24-hour range (AGENTS.md). */
@Composable
private fun inviteRange(startMs: Long, endMs: Long?): String {
    val locale = LocalConfiguration.current.locales[0]
    val zone = java.time.ZoneId.systemDefault()
    val day = java.time.format.DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(locale, "EEEEMMMMd"), locale)
    val time = java.time.format.DateTimeFormatter.ofPattern("HH:mm")
    val start = java.time.Instant.ofEpochMilli(startMs).atZone(zone)
    val end = endMs?.let { java.time.Instant.ofEpochMilli(it).atZone(zone) }
    return if (end == null) stringResource(R.string.invite_day_time, day.format(start), time.format(start))
    else stringResource(R.string.invite_range, day.format(start), time.format(start), time.format(end))
}

/** The signed-in member's owner token, renewed first; null for a guest. */
private suspend fun memberToken(account: OwnerAccount): String? {
    if (account.account.value !is Account.SignedIn) return null
    account.session.renewIfNeeded()
    return account.session.credentials()?.accessToken
}

/**
 * `JoinView.prejoin`: the camera in a 16:10 elevated card (the flock in
 * drift, "Camera off", while it is off), the media buttons (Mute and
 * Camera with their device chevrons, then Flip), Ask to join, Back.
 */
@Composable
private fun Prejoin(
    call: CallSession,
    mic: Boolean,
    camera: Boolean,
    blocked: Int?,
    onMic: () -> Unit,
    onCamera: () -> Unit,
    onSettings: () -> Unit,
    onAsk: () -> Unit,
    onBack: () -> Unit,
) {
    val c = Starlings.colors
    val preview by call.preview.collectAsStateWithLifecycle()
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(StarlingsSpacing.screen),
        verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.stack),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            stringResource(R.string.prejoin_title),
            Modifier.fillMaxWidth(), style = StarlingsType.largeTitle, color = c.primary,
        )
        val track = preview
        val previewRoom = call.previewRenderRoom
        val shape = RoundedCornerShape(StarlingsRadius.card)
        Box(
            Modifier.fillMaxWidth().aspectRatio(16f / 10f).clip(shape).background(c.elevated, shape),
            contentAlignment = Alignment.Center,
        ) {
            if (camera && track != null && previewRoom != null) {
                val label = stringResource(R.string.camera_preview)
                Box(Modifier.fillMaxSize().semantics { contentDescription = label }) { Video(previewRoom, track) }
            } else {
                GatheringDotsView(128.dp, c.secondary, GatheringDots.Motion.DRIFT, label = stringResource(R.string.camera_off))
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(StarlingsSpacing.fields)) {
            Box(Modifier.weight(1f)) {
                MediaButton(
                    if (mic) Icons.Filled.Mic else Icons.Filled.MicOff,
                    stringResource(if (mic) R.string.mute else R.string.unmute),
                    onMic, Modifier.fillMaxWidth(),
                )
                MicrophoneChooser(call, StarlingsSize.mediaButton, Modifier.align(Alignment.TopEnd))
            }
            Box(Modifier.weight(1f)) {
                MediaButton(
                    if (camera) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                    stringResource(if (camera) R.string.camera_off else R.string.camera_on),
                    onCamera, Modifier.fillMaxWidth(),
                )
                CameraChooser(call, StarlingsSize.mediaButton, Modifier.align(Alignment.TopEnd))
            }
            MediaButton(Icons.Filled.Cameraswitch, stringResource(R.string.prejoin_flip), call::flipCamera, Modifier.weight(1f))
        }
        HapticWhenSet(Haptic.ERROR, blocked)
        blocked?.let { message ->
            Text(stringResource(message), Modifier.fillMaxWidth(), style = StarlingsType.subheadline, color = c.danger)
            BorderedButton(stringResource(R.string.open_settings), onSettings)
        }
        FilledButton(stringResource(R.string.entry_ask), onAsk, icon = Icons.Filled.Videocam)
        PlainButton(stringResource(R.string.back), onBack)
    }
}

/**
 * `MobileMicrophoneMenu` behind the Mute chevron: the routes the call can
 * hear you through (each brings its own microphone), the one in use
 * checked. Before the call has audio the list is empty, and it says so.
 */
@Composable
fun MicrophoneChooser(call: CallSession, height: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    val ui by call.ui.collectAsStateWithLifecycle()
    val microphone = stringResource(R.string.entry_microphone)
    DeviceChooser(stringResource(R.string.device_options, microphone), height, modifier) { close ->
        if (ui.audioDevices.isEmpty()) {
            DropdownMenuItem(text = { Text(stringResource(R.string.device_mics_later), style = StarlingsType.body) }, onClick = close, enabled = false)
        } else {
            MenuHeader(microphone)
            ui.audioDevices.forEach { device ->
                DropdownMenuItem(
                    text = { Text(device.name, style = StarlingsType.body) },
                    trailingIcon = { if (device == ui.audioDevice) Icon(Icons.Filled.Check, null) },
                    onClick = { call.selectAudio(device); close() },
                )
            }
        }
    }
}

/** `MobileCameraMenu` behind the Camera chevron: front or back, named rather than flipped-and-checked. */
@Composable
fun CameraChooser(call: CallSession, height: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    val position by call.cameraPosition.collectAsStateWithLifecycle()
    val camera = stringResource(R.string.entry_camera)
    DeviceChooser(stringResource(R.string.device_options, camera), height, modifier) { close ->
        MenuHeader(camera)
        listOf(CameraPosition.FRONT to R.string.device_front_camera, CameraPosition.BACK to R.string.device_back_camera).forEach { (side, title) ->
            DropdownMenuItem(
                text = { Text(stringResource(title), style = StarlingsType.body) },
                trailingIcon = { if (side == position) Icon(Icons.Filled.Check, null) },
                onClick = { call.selectCamera(side); close() },
            )
        }
    }
}

/**
 * `JoinView.waitingRoom`: the murmuring flock in a 96 box, the large title,
 * the status in secondary ink, and Cancel request at most 320 wide. Knocking
 * and joining draw the same screen with their own status line.
 */
@Composable
private fun WaitingRoom(status: String, onCancel: () -> Unit) {
    val c = Starlings.colors
    Column(
        Modifier.fillMaxSize().padding(StarlingsSpacing.screenCentred),
        verticalArrangement = Arrangement.spacedBy(StarlingsSpacing.section, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(96.dp), contentAlignment = Alignment.Center) {
            GatheringDotsView(64.dp, c.secondary, GatheringDots.Motion.MURMURATION)
        }
        Text(stringResource(R.string.waiting_room), style = StarlingsType.largeTitle, color = c.primary)
        Text(status, style = StarlingsType.body, color = c.secondary, textAlign = TextAlign.Center)
        BorderedButton(stringResource(R.string.cancel_request), onCancel, Modifier.widthIn(max = 320.dp))
    }
}
