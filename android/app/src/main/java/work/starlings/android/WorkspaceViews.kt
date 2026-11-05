package work.starlings.android

import android.content.Context
import work.starlings.android.ui.toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.GatheringDots
import work.starlings.android.ui.GatheringDotsView
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkspaceDoorRow

/**
 * Add a workspace (`Sources/AddWorkspaceFlow.swift`): one address
 * field, a lookup while the person types, one button that signs in to the
 * workspace found, and a switch only once its session is in the
 * workspace's own vault. A cancelled or refused sign-in leaves the person
 * where they were, with the reason and Retry.
 */
class AddWorkspaceFlow(
    private val scope: CoroutineScope,
    private val lookUp: suspend (String) -> StarlingsWorkspace,
    private val signIn: suspend (StarlingsWorkspace) -> StarlingsApp.SignInResult,
    private val hasSession: (StarlingsWorkspace) -> Boolean,
    /** True while a switch must wait (a live call). */
    private val isLocked: () -> Boolean,
    private val current: () -> StarlingsWorkspace,
    /** The address signed in to the current workspace, or null. */
    private val signedInAddress: () -> String?,
    private val enter: (StarlingsWorkspace) -> Unit,
    private val debounceMs: Long = 400,
) {
    sealed interface Lookup {
        data object Idle : Lookup
        data object Looking : Lookup
        data class Found(val workspace: StarlingsWorkspace) : Lookup
        data class Failed(val failure: Failure) : Lookup
    }

    enum class Step { READY, SIGNING_IN, OPENING }

    enum class Failure { INVALID_ADDRESS, NOT_FOUND, NOT_INVITED, CANCELLED, NETWORK, UPDATE_REQUIRED, SIGN_IN_FAILED, LEAVE_CALL }

    sealed interface Button {
        data object SigningIn : Button
        data object Opening : Button
        data class SwitchTo(val name: String) : Button
        data object Continue : Button
    }

    sealed interface Access {
        data object ThisWorkspace : Access
        data object NeedsInvite : Access
        data class ForAccounts(val domains: List<String>) : Access
    }

    var address by mutableStateOf("")
        private set
    var lookup by mutableStateOf<Lookup>(Lookup.Idle)
        private set
    var step by mutableStateOf(Step.READY)
        private set
    /** Why the last press did not land. Cleared by an edit or Retry. */
    var failure by mutableStateOf<Failure?>(null)
        private set

    /** Runs once the workspace is entered: the sheet closes. */
    var onEntered: () -> Unit = {}
    /** The door's sign-in to the current workspace when it is signed out: its address signs in to it. */
    var onSignInCurrent: (() -> Unit)? = null

    private var lookupJob: Job? = null
    private var submitJob: Job? = null
    private var generation = 0

    /** The `.<suffix>` suffix after the field while the person types a bare name. */
    val showsSuffix: Boolean get() = !address.contains('.') && !address.contains(':') && !address.contains('/')

    val foundWorkspace: StarlingsWorkspace? get() = (lookup as? Lookup.Found)?.workspace

    val isBusy: Boolean get() = step != Step.READY

    val button: Button
        get() = when (step) {
            Step.SIGNING_IN -> Button.SigningIn
            Step.OPENING -> Button.Opening
            Step.READY -> foundWorkspace?.takeIf(hasSession)?.let { Button.SwitchTo(it.name) } ?: Button.Continue
        }

    val canSubmit: Boolean
        get() {
            if (step != Step.READY || address.isBlank()) return false
            val found = foundWorkspace
            if (found != null && found.webOrigin == current().webOrigin) return signsInToCurrent(found)
            return true
        }

    /** The line under the found workspace: who may sign in. */
    val access: Access?
        get() {
            val found = foundWorkspace ?: return null
            if (found.webOrigin == current().webOrigin && !signsInToCurrent(found)) return Access.ThisWorkspace
            val domains = found.resolvedDomains
            if (domains.isEmpty()) return null
            val email = signedInAddress()?.lowercase()
            if (email != null && domains.none { email.endsWith("@$it") }) return Access.NeedsInvite
            return Access.ForAccounts(domains)
        }

    /** Every keystroke. The lookup runs once typing rests. */
    fun updateAddress(value: String) {
        if (value == address) return
        address = value
        failure = null
        scheduleLookup(debounceMs)
    }

    /** Retry: the lookup again, or the press again when the lookup had landed. */
    fun retry() {
        failure = null
        if (foundWorkspace != null) submit() else scheduleLookup(0)
    }

    /** The button, and the keyboard's action key. */
    fun submit() {
        if (step != Step.READY || submitJob != null) return
        val input = address.trim()
        if (input.isEmpty()) {
            failure = Failure.INVALID_ADDRESS
            return
        }
        failure = null
        submitJob = scope.launch {
            try { run(input) } finally { submitJob = null }
        }
    }

    private suspend fun run(input: String) {
        var workspace = foundWorkspace
        if (workspace == null) {
            lookupJob?.cancel()
            generation++
            lookup = Lookup.Looking
            try {
                val found = lookUp(input)
                if (address.trim() != input) return
                lookup = Lookup.Found(found)
                workspace = found
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                lookup = Lookup.Failed(reading(e))
                return
            }
        }
        if (workspace.webOrigin == current().webOrigin) {
            val signInCurrent = onSignInCurrent
            if (!signsInToCurrent(workspace) || signInCurrent == null) return
            onEntered()
            signInCurrent()
            return
        }
        if (isLocked()) {
            failure = Failure.LEAVE_CALL
            return
        }
        if (!hasSession(workspace)) {
            step = Step.SIGNING_IN
            val result = signIn(workspace)
            if (result != StarlingsApp.SignInResult.SIGNED_IN) {
                step = Step.READY
                failure = when (result) {
                    StarlingsApp.SignInResult.CANCELLED -> Failure.CANCELLED
                    StarlingsApp.SignInResult.NOT_INVITED -> Failure.NOT_INVITED
                    else -> Failure.SIGN_IN_FAILED
                }
                return
            }
        }
        if (isLocked()) {
            step = Step.READY
            failure = Failure.LEAVE_CALL
            return
        }
        step = Step.OPENING
        onEntered()
        enter(workspace)
    }

    /** The current workspace, signed out, on the door: the button signs in to it. */
    private fun signsInToCurrent(workspace: StarlingsWorkspace) = onSignInCurrent != null && !hasSession(workspace)

    private fun scheduleLookup(delayMs: Long) {
        lookupJob?.cancel()
        val ticket = ++generation
        val input = address.trim()
        if (input.isEmpty() || WorkspaceAddress.origin(input) == null) {
            lookup = Lookup.Idle
            return
        }
        lookup = Lookup.Looking
        lookupJob = scope.launch {
            if (delayMs > 0) delay(delayMs)
            try {
                val found = lookUp(input)
                if (ticket == generation) lookup = Lookup.Found(found)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ticket == generation) lookup = Lookup.Failed(reading(e))
            }
        }
    }

    fun cancel() {
        lookupJob?.cancel()
        submitJob?.cancel()
    }

    companion object {
        fun reading(e: Throwable): Failure = when ((e as? WorkspaceLookupError)?.kind) {
            WorkspaceLookupError.Kind.INVALID_ADDRESS -> Failure.INVALID_ADDRESS
            WorkspaceLookupError.Kind.UNREACHABLE -> Failure.NETWORK
            WorkspaceLookupError.Kind.UPDATE_REQUIRED -> Failure.UPDATE_REQUIRED
            WorkspaceLookupError.Kind.NOT_FOUND, null -> Failure.NOT_FOUND
        }

        fun message(failure: Failure): Int = when (failure) {
            Failure.INVALID_ADDRESS -> R.string.workspace_lookup_invalid
            Failure.NOT_FOUND -> R.string.workspace_lookup_not_found
            Failure.NETWORK -> R.string.workspace_lookup_unreachable
            Failure.UPDATE_REQUIRED -> R.string.workspace_lookup_update
            Failure.NOT_INVITED -> R.string.sign_in_not_invited
            Failure.CANCELLED -> R.string.workspace_sign_in_cancelled
            Failure.SIGN_IN_FAILED -> R.string.sign_in_failed
            Failure.LEAVE_CALL -> R.string.workspaces_leave_call
        }
    }
}

/** The add flow on [app]: its lookup, its sign-in into another workspace's vault, and the switch. */
@Composable
fun rememberAddWorkspaceFlow(app: StarlingsApp): AddWorkspaceFlow {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    return remember(app) {
        AddWorkspaceFlow(
            scope = scope,
            lookUp = { app.directory.lookUp(it) },
            signIn = { app.signIn(into = it, from = context) },
            hasSession = app::hasSession,
            isLocked = { app.isCallLive },
            current = { app.workspaces.current.value },
            signedInAddress = { app.account.session.credentials()?.email },
            enter = { app.enter(it) },
        )
    }
}

/**
 * `MobileAddWorkspaceSheet`: the heading, one address field with the
 * `.<suffix>` suffix, what the lookup found, one line on what
 * happens next, and one full-width button. [onSignInCurrent] is the
 * door's, where the current workspace is signed out.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddWorkspaceSheet(app: StarlingsApp, onDismiss: () -> Unit, onSignInCurrent: (() -> Unit)? = null) {
    val c = Starlings.colors
    val flow = rememberAddWorkspaceFlow(app)
    flow.onEntered = onDismiss
    flow.onSignInCurrent = onSignInCurrent
    DisposableEffect(flow) { onDispose { flow.cancel() } }
    ModalBottomSheet(
        onDismissRequest = { if (!flow.isBusy) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.panel,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(20.dp).navigationBarsPadding().imePadding(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.workspace_add_title), style = StarlingsType.title3, color = c.primary)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(stringResource(R.string.workspace_address), style = StarlingsType.subheadline.copy(fontWeight = FontWeight.Medium), color = c.secondary)
                Box {
                    StarlingsField(
                        flow.address, flow::updateAddress, stringResource(R.string.workspace_address_placeholder),
                        label = stringResource(R.string.workspace_address),
                        keyboardType = KeyboardType.Uri,
                        trailingInset = if (flow.showsSuffix) 110.dp else 0.dp,
                    )
                    if (flow.showsSuffix) {
                        Text(
                            ".${Contracts.WORKSPACE_HOST_SUFFIX}",
                            Modifier.align(Alignment.CenterEnd).padding(end = 14.dp),
                            style = StarlingsType.body, color = c.secondary, maxLines = 1,
                        )
                    }
                }
            }
            LookupView(flow)
            Text(stringResource(R.string.workspace_next_step), style = StarlingsType.footnote, color = c.secondary)
            FilledButton(
                when (val b = flow.button) {
                    AddWorkspaceFlow.Button.SigningIn -> stringResource(R.string.workspaces_signing_in)
                    AddWorkspaceFlow.Button.Opening -> stringResource(R.string.workspace_opening)
                    is AddWorkspaceFlow.Button.SwitchTo -> stringResource(R.string.workspace_switch_to, b.name)
                    AddWorkspaceFlow.Button.Continue -> stringResource(R.string.workspace_continue_sign_in)
                },
                flow::submit,
                enabled = flow.canSubmit,
            )
            flow.failure?.let { failure ->
                WorkErrorNotice(stringResource(AddWorkspaceFlow.message(failure)), stringResource(R.string.workspaces_retry), flow::retry)
            }
        }
    }
}

/** `AddWorkspaceLookupView`: nothing, looking, the workspace found, or the failure with Retry. */
@Composable
private fun LookupView(flow: AddWorkspaceFlow) {
    val c = Starlings.colors
    when (val lookup = flow.lookup) {
        AddWorkspaceFlow.Lookup.Idle -> Unit
        AddWorkspaceFlow.Lookup.Looking -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            GatheringDotsView(16.dp, c.secondary, GatheringDots.Motion.BUSY)
            Text(stringResource(R.string.workspace_looking_up), style = StarlingsType.footnote, color = c.secondary)
        }
        is AddWorkspaceFlow.Lookup.Found -> {
            val workspace = lookup.workspace
            val s = RoundedCornerShape(StarlingsRadius.field)
            val found = stringResource(R.string.workspace_found)
            Row(
                Modifier.fillMaxWidth().background(c.elevated, s).border(1.dp, c.border, s).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                WorkspaceMark(workspace, 32.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(workspace.name, style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.primary, maxLines = 1)
                        Icon(Icons.Filled.CheckCircle, found, Modifier.size(14.dp), tint = c.secondary)
                    }
                    Text(workspace.address, style = StarlingsType.caption, color = c.secondary, maxLines = 1)
                    when (val access = flow.access) {
                        null -> Unit
                        AddWorkspaceFlow.Access.ThisWorkspace -> Text(stringResource(R.string.workspace_youre_in_this), style = StarlingsType.caption, color = c.secondary)
                        AddWorkspaceFlow.Access.NeedsInvite -> Text(stringResource(R.string.workspace_needs_invite), style = StarlingsType.caption, color = c.secondary)
                        is AddWorkspaceFlow.Access.ForAccounts ->
                            Text(stringResource(R.string.workspace_for_accounts, access.domains.joinToString(", ")), style = StarlingsType.caption, color = c.secondary)
                    }
                }
            }
        }
        is AddWorkspaceFlow.Lookup.Failed -> WorkErrorNotice(stringResource(AddWorkspaceFlow.message(lookup.failure)), stringResource(R.string.workspaces_retry), flow::retry)
    }
}

/**
 * `StarlingsWorkspaceMarkView`: the workspace's mark, always one
 * colour, [ink]: an uploaded SVG as its outline, a PNG as a template. Without
 * a mark, signed out draws the flock; signed in, the initial on a quiet
 * tile. No workspace's mark is built in: Envisioning's is its upload too.
 * The mark is read once per process (`StarlingsApp.marks`).
 */
@Composable
fun WorkspaceMark(workspace: StarlingsWorkspace, size: Dp, signedOut: Boolean = false, ink: Color = Starlings.colors.primary) {
    val app = LocalContext.current.applicationContext as? StarlingsApp
    LaunchedEffect(workspace.webOrigin, workspace.markUrl) { app?.marks?.load(workspace) }
    val data = app?.marks?.mark(workspace)
    val picture = remember(data) { data?.let(WorkspaceMarkPicture::of) }
    Box(Modifier.size(size).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        when {
            picture != null -> WorkspaceMarkPictureView(picture, size, ink)
            signedOut -> GatheringDotsView(size, ink)
            else -> {
                val s = RoundedCornerShape(size * 0.22f)
                val fontSize = with(LocalDensity.current) { (size * 0.58f).toSp() }
                Box(Modifier.size(size).background(ink.copy(alpha = 0.12f), s), contentAlignment = Alignment.Center) {
                    Text(workspace.initial, style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold, fontSize = fontSize), color = ink)
                }
            }
        }
    }
}

/**
 * `WorkspaceDoorView`: every workspace this device has signed in to, one
 * tap from its sign-in, then **Enter an address**. [busyOrigin] is the row
 * whose sign-in is under way; every row waits while one is.
 */
@Composable
fun WorkspaceDoor(app: StarlingsApp, busyOrigin: String?, onPick: (StarlingsWorkspace) -> Unit, onEnterAddress: () -> Unit) {
    val c = Starlings.colors
    val known by app.workspaces.known.collectAsStateWithLifecycle()
    val signIn = stringResource(R.string.sign_in)
    val open = stringResource(R.string.workspaces_open)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        known.forEach { workspace ->
            val email = remember(workspace, busyOrigin) { app.signedInEmail(workspace) }
            WorkspaceDoorRow(
                name = workspace.name,
                detail = workspace.rowDetail(email),
                action = if (email == null) signIn else open,
                busy = busyOrigin == workspace.webOrigin,
                enabled = busyOrigin == null,
                onClick = { onPick(workspace) },
                mark = { WorkspaceMark(workspace, 24.dp, signedOut = email == null) },
            )
        }
        val enter = stringResource(R.string.workspace_enter_address)
        Text(
            enter,
            Modifier
                .clickable(enabled = busyOrigin == null, role = Role.Button, onClick = onEnterAddress)
                .semantics { contentDescription = enter }
                .alpha(if (busyOrigin == null) 1f else 0.5f)
                .padding(top = 2.dp, bottom = 2.dp, start = 8.dp, end = 8.dp),
            style = StarlingsType.footnote.copy(fontWeight = FontWeight.Medium),
            color = c.secondary,
        )
    }
}

/** A row on the door (`MobileFirstRunCard.pick`): the current workspace signs in; one with a session opens; any other signs in first. */
suspend fun pickOnDoor(app: StarlingsApp, workspace: StarlingsWorkspace, from: Context): AddWorkspaceFlow.Failure? {
    if (workspace.webOrigin == app.workspaces.current.value.webOrigin) {
        app.account.dismissFailure()
        app.account.signIn(from)
        return null
    }
    if (!app.hasSession(workspace)) {
        when (app.signIn(into = workspace, from = from)) {
            StarlingsApp.SignInResult.SIGNED_IN -> Unit
            StarlingsApp.SignInResult.CANCELLED -> return null
            StarlingsApp.SignInResult.NOT_INVITED -> return AddWorkspaceFlow.Failure.NOT_INVITED
            StarlingsApp.SignInResult.FAILED -> return AddWorkspaceFlow.Failure.SIGN_IN_FAILED
        }
    }
    if (!app.enter(workspace) && app.isCallLive) return AddWorkspaceFlow.Failure.LEAVE_CALL
    return null
}

/**
 * The answer to a link for another workspace (`LinkWorkspaceOffer`): name
 * the workspace and offer to open the link there.
 */
@Composable
fun LinkOfferDialog(app: StarlingsApp) {
    val offer = app.linkOffer.collectAsStateWithLifecycle().value ?: return
    val c = Starlings.colors
    AlertDialog(
        onDismissRequest = app::dismissLinkOffer,
        title = { Text(stringResource(R.string.workspace_link_for, offer.workspace.name), style = StarlingsType.headline) },
        confirmButton = { TextButton(app::acceptLinkOffer) { Text(stringResource(R.string.workspace_link_open_in, offer.workspace.name), color = c.primary) } },
        dismissButton = { TextButton(app::dismissLinkOffer) { Text(stringResource(R.string.workspaces_cancel), color = c.primary) } },
        containerColor = c.elevated,
        titleContentColor = c.primary,
    )
}

/** "You're in <name>", once, on the runtime built for the workspace entered (`takeArrival`). */
fun announceArrival(app: StarlingsApp) {
    val name = app.workspaces.takeArrival() ?: return
    toast(app.getString(R.string.workspaces_arrived, name))
}

