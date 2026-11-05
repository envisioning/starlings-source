package work.starlings.android.workspace.team

import work.starlings.android.ui.HapticOnChange
import work.starlings.android.ui.Haptic
import androidx.activity.compose.BackHandler
import work.starlings.android.workspace.FavoriteMenuItem
import work.starlings.android.workspace.FavoriteTargets
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.MentionMatching
import work.starlings.android.OwnerAccount
import work.starlings.android.R
import work.starlings.android.workspace.home.HomeRecents
import work.starlings.android.workspace.home.RecentRows
import work.starlings.android.StarlingsIcons
import work.starlings.android.ThreadMarkdown
import work.starlings.android.ui.CaptionLabel
import work.starlings.android.ui.GatheringDots
import work.starlings.android.ui.GatheringDotsView
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.PeerWire
import work.starlings.contracts.ThreadMessageWire
import work.starlings.contracts.ThreadReleaseAction
import work.starlings.android.keep.KeepAccess
import work.starlings.android.keep.ui.KeepReleaseSheet
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * `iOS/MobileThreadView.swift`: one conversation, named by a [ThreadAddress].
 * Delivery is polling while this screen is started; there is no push.
 */
@Composable
fun ThreadScreen(address: ThreadAddress, account: OwnerAccount, team: TeamStore, doors: ThreadRefDoors? = null, onBack: () -> Unit) {
    val store = remember(address.id) { ThreadStore(account) }
    BackHandler(onBack = onBack)
    ThreadConversation(address, account, team, store, doors = doors) { TopBar(address, store, team, onBack) }
}

/**
 * A subject's Talk pane (`MobileSubjectView.talk`): the subject's channel
 * inside its page, with no bar of its own; the page's bar carries
 * [ThreadOptionsButton]. [onInboundAddress] hears the channel's forwarding
 * address once the thread has loaded, for Overview's Email block.
 */
@Composable
fun SubjectTalk(
    address: ThreadAddress,
    account: OwnerAccount,
    team: TeamStore,
    store: ThreadStore,
    onInboundAddress: (String) -> Unit,
    /** Where the event lines' chips open (`refSubject`, `onShowOverview`). */
    doors: ThreadRefDoors? = null,
    /** A line a door named (a Board card's last line): land on it and wash it once. */
    focus: ThreadFocus? = null,
    onFocusTaken: () -> Unit = {},
) {
    val inbound = store.thread?.inboundAddress
    LaunchedEffect(inbound) { inbound?.let(onInboundAddress) }
    // The subject's page already wrote its row into the recents.
    ThreadConversation(address, account, team, store, remembersRecent = false, doors = doors, focus = focus, onFocusTaken = onFocusTaken) {}
}

/** `PendingThreadFocus` with `.message`: the conversation and the line in it. */
data class ThreadFocus(val threadId: String, val messageId: String)

/** The conversation under whatever bar [header] draws: transcript, composer and their sheets. */
@Composable
private fun ThreadConversation(
    address: ThreadAddress,
    account: OwnerAccount,
    team: TeamStore,
    store: ThreadStore,
    remembersRecent: Boolean = true,
    doors: ThreadRefDoors? = null,
    focus: ThreadFocus? = null,
    onFocusTaken: () -> Unit = {},
    header: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    val context = LocalContext.current
    LaunchedEffect(address.id) {
        store.open(address)
        team.setActiveThread(store.thread?.id, address.peerEmail)
        // Opened by hand: into the device's recents, the list Home's Quick Access and Search share.
        store.thread?.takeIf { remembersRecent }?.let { opened ->
            HomeRecents.remember(context, account.session.credentials()?.email.orEmpty(), RecentRows.thread(opened, RecentRows.threadLabels(context)))
        }
    }
    LaunchedEffect(address.id) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // Coming back to the foreground reads at once; in the background nothing polls.
            store.reload()
            store.poll { true }
        }
    }
    DisposableEffect(address.id) { onDispose { team.setActiveThread(null, null) } }

    val agents = team.roster.agents
    val agent = AgentTurn.addressedAgent(address.peerEmail, store.messages, agents)
    val awaiting = AgentTurn.awaiting(agent, store.messages)
    store.isAgentTurnOpen = awaiting
    // The roster's 30 s poll is too slow for an agent's turn: re-read it on the thread's cadence.
    LaunchedEffect(awaiting) {
        while (awaiting) {
            team.refresh()
            delay(TeamCadence.OPEN_THREAD_POLL_MS)
        }
    }
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val working = AgentTurn.showsWorkingRow(agent, store.messages, nowMs)
    LaunchedEffect(awaiting) {
        while (awaiting) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
        nowMs = System.currentTimeMillis()
    }

    var draft by remember(address.id) { mutableStateOf("") }
    // A reply is a relation on the next message, on a subject channel only.
    var replyDraft by remember(address.id) { mutableStateOf(ThreadReplyDraft()) }
    val noLongerReplyable = stringResource(R.string.thread_reply_gone)
    LaunchedEffect(store.messages) {
        if (!replyDraft.isValid(store.messages)) {
            replyDraft = ThreadReplyDraft()
            store.errorMessage = noLongerReplyable
        }
    }
    val decisionSubject = address.decisionSubject
    val recorded = stringResource(R.string.thread_recorded_decision)
    val savedNote = stringResource(R.string.thread_saved_quick_note)
    val noteFailed = stringResource(R.string.thread_save_quick_note_failed)
    val clipboard = LocalClipboardManager.current
    var editing by remember(address.id) { mutableStateOf<ThreadMessageWire?>(null) }
    var pendingWithdraw by remember { mutableStateOf<ThreadMessageWire?>(null) }
    // An agent's Keep request being approved; no Approve where the workspace has no Keep.
    val keep = remember { KeepAccess.of(context) }
    var approvingRelease by remember(address.id) { mutableStateOf<ThreadMessageWire?>(null) }
    val c = Starlings.colors

    HapticOnChange(Haptic.TAP, store.messages.size)
    Column(Modifier.fillMaxSize().background(c.canvas).imePadding()) {
        header()
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Transcript(
                address = address,
                store = store,
                team = team,
                agentName = agent?.shortName,
                agentSince = agent?.since,
                working = working,
                nowMs = nowMs,
                onEdit = { m -> replyDraft = ThreadReplyDraft(); editing = m; draft = m.text },
                onWithdraw = { pendingWithdraw = it },
                keep = keep,
                onApproveRelease = { approvingRelease = it },
                onReply = if (address.supportsMessageReplies) ({ m: ThreadMessageWire ->
                    ThreadReplyDraft().select(m)?.let { picked ->
                        if (editing != null) draft = ""
                        editing = null
                        replyDraft = picked
                    }
                    Unit
                }) else null,
                onMarkAsDecision = decisionSubject?.let { subject ->
                    { m: ThreadMessageWire ->
                        scope.launch {
                            try {
                                store.markAsDecision(m, subject)
                                work.starlings.android.ui.toast(recorded)
                            } catch (e: kotlinx.coroutines.CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                work.starlings.android.ui.toast(e.teamMessage(), work.starlings.android.ui.ToastTone.DANGER)
                            }
                        }
                        Unit
                    }
                },
                onSaveAsQuickNote = { m ->
                    scope.launch {
                        try {
                            store.saveAsQuickNote(m)
                            work.starlings.android.ui.toast(savedNote)
                        } catch (e: kotlinx.coroutines.CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            work.starlings.android.ui.toast((e as? work.starlings.android.api.StarlingsApiError)?.sentence ?: noteFailed, work.starlings.android.ui.ToastTone.DANGER)
                        }
                    }
                },
                doors = doors,
                focus = focus,
                onFocusTaken = onFocusTaken,
            )
            if (store.messages.isEmpty() && !store.isLoading) {
                val front = AgentManifests.cardAgent(address.peerEmail, agents)
                val manifest = front?.manifest
                if (front != null && manifest != null) {
                    // The agent's front door in place of the one empty line. Read-only.
                    AgentManifestCard(front.displayName, manifest, front.activity, Modifier.align(Alignment.Center).padding(24.dp))
                } else {
                    Text(
                        stringResource(R.string.nothing_here_yet),
                        Modifier.align(Alignment.Center).padding(32.dp),
                        style = StarlingsType.footnote,
                        color = c.secondary,
                    )
                }
            }
        }
        Composer(
            store = store,
            // An agent's own DM only: a channel that names one is still a channel.
            onPaste = if (address.peerEmail != null && agent != null && editing == null) ({
                val text = clipboard.getText()?.text
                if (text == null) store.errorMessage = "Nothing to paste."
                else {
                    val candidates = team.roster.peers.filterNot { it.isSelf }.map { it.email }
                    scope.launch { pasteAndSend(store, text, candidates) }
                }
            }) else null,
            prompt = addressPrompt(address),
            draft = draft,
            onDraft = { draft = it },
            editing = editing != null,
            error = store.errorMessage,
            sending = store.isSending,
            onCancelEdit = { editing = null; draft = ""; replyDraft = ThreadReplyDraft() },
            replyParentId = if (address.supportsMessageReplies) (editing?.replyToMessageId ?: replyDraft.parentMessageId) else null,
            editingReply = editing?.replyToMessageId != null,
            onCancelReply = { replyDraft = ThreadReplyDraft() },
            replyValid = replyDraft.isValid(store.messages),
            onSend = {
                val text = draft
                val target = editing
                if (target != null) {
                    draft = ""
                    editing = null
                    scope.launch { if (!store.edit(target, text)) { draft = text; editing = target } }
                } else if (!replyDraft.isValid(store.messages)) {
                    replyDraft = ThreadReplyDraft()
                    store.errorMessage = noLongerReplyable
                } else {
                    draft = ""
                    val candidates = team.roster.peers.filterNot { it.isSelf }.map { it.email }
                    val parent = replyDraft.parentMessageId
                    // The draft comes back if it never left.
                    scope.launch {
                        if (!store.send(text, MentionMatching.mentions(text, candidates), replyToMessageId = parent)) draft = text
                        else replyDraft = ThreadReplyDraft()
                    }
                }
            },
        )
    }

    pendingWithdraw?.let { message ->
        AlertDialog(
            onDismissRequest = { pendingWithdraw = null },
            containerColor = c.elevated,
            title = { Text(stringResource(R.string.thread_withdraw_title), color = c.primary) },
            text = { Text(stringResource(R.string.thread_withdraw_body), color = c.secondary) },
            confirmButton = {
                TextButton(onClick = { pendingWithdraw = null; scope.launch { store.withdraw(message) } }) {
                    Text(stringResource(R.string.thread_withdraw), color = c.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingWithdraw = null }) { Text(stringResource(R.string.thread_cancel), color = c.primary) }
            },
        )
    }
    approvingRelease?.let { message ->
        val request = message.releaseRequest ?: return@let
        KeepReleaseSheet(
            access = keep,
            request = ThreadReleaseCard.keepRequest(request, message.senderEmail),
            agentName = message.senderName ?: message.senderShortName,
            askedFor = ThreadReleaseCard.askedFor(request)?.let(::askedForText),
            onApproved = { store.recordRelease(message.id, ThreadReleaseAction.APPROVE) },
            onClose = { approvingRelease = null },
        )
    }
}

/** The inline title, the one quiet line under it, and the conversation menu. */
@Composable
private fun TopBar(address: ThreadAddress, store: ThreadStore, team: TeamStore, onBack: () -> Unit) {
    val c = Starlings.colors
    Column {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconControl(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back), onBack)
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(addressTitle(address), style = StarlingsType.headline, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                addressSubtitle(address)?.let {
                    Text(it, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            ThreadOptionsButton(address, store, team)
        }
        HorizontalDivider(thickness = 1.dp, color = c.border)
    }
}

/**
 * The conversation menu: About (a one-to-one), Mute, Archive (a DM), the
 * star, and the channel's forwarding address, which a tap copies
 *. A subject's page puts it in its own bar while Talk shows.
 */
@Composable
fun ThreadOptionsButton(address: ThreadAddress, store: ThreadStore, team: TeamStore) {
    val scope = rememberCoroutineScope()
    val c = Starlings.colors
    val clipboard = LocalClipboardManager.current
    var menu by remember { mutableStateOf(false) }
    var about by remember { mutableStateOf<work.starlings.contracts.PeerWire?>(null) }
    // A one-to-one conversation with somebody the roster lists has an About.
    val infoPeer = address.peerEmail?.let { email -> team.roster.peers.firstOrNull { it.email == email } }
    about?.let { PeerAboutSheet(it, team) { about = null } }
    Box {
        IconControl(if (store.isMuted) Icons.Filled.NotificationsOff else Icons.Filled.MoreHoriz, stringResource(R.string.thread_options)) { menu = true }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            infoPeer?.let { peer ->
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.team_about_peer, peer.shortName)) },
                    leadingIcon = { Icon(Icons.Outlined.Info, null) },
                    onClick = { menu = false; about = peer },
                )
                HorizontalDivider(color = c.border)
            }
            DropdownMenuItem(
                text = { Text(stringResource(if (store.isMuted) R.string.thread_unmute else R.string.thread_mute)) },
                enabled = store.thread != null,
                onClick = { menu = false; scope.launch { store.toggleMute() } },
            )
            if (store.canArchive) {
                DropdownMenuItem(
                    text = { Text(stringResource(if (store.isArchived) R.string.thread_keep else R.string.thread_archive)) },
                    onClick = { menu = false; scope.launch { store.toggleArchive() } },
                )
            }
            store.thread?.id?.takeIf { it.isNotEmpty() }?.let { id ->
                HorizontalDivider(color = c.border)
                FavoriteMenuItem(FavoriteTargets.thread(id)) { menu = false }
            }
            store.thread?.inboundAddress?.let { inbound ->
                HorizontalDivider(color = c.border)
                // The address is the label, so it reads without copying; the tap copies.
                DropdownMenuItem(
                    text = { Text(inbound) },
                    leadingIcon = { Icon(Icons.Outlined.Email, null) },
                    onClick = { menu = false; clipboard.setText(AnnotatedString(inbound)) },
                )
            }
        }
    }
}

/** A 44 touch target with one symbol and its TalkBack label. */
@Composable
private fun IconControl(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(44.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, Modifier.size(22.dp), tint = Starlings.colors.primary) }
}

@Composable
private fun Transcript(
    address: ThreadAddress,
    store: ThreadStore,
    team: TeamStore,
    agentName: String?,
    agentSince: Long?,
    working: Boolean,
    nowMs: Long,
    onEdit: (ThreadMessageWire) -> Unit,
    onWithdraw: (ThreadMessageWire) -> Unit,
    keep: KeepAccess,
    onApproveRelease: (ThreadMessageWire) -> Unit,
    onReply: ((ThreadMessageWire) -> Unit)? = null,
    onMarkAsDecision: ((ThreadMessageWire) -> Unit)? = null,
    onSaveAsQuickNote: (ThreadMessageWire) -> Unit = {},
    doors: ThreadRefDoors? = null,
    focus: ThreadFocus? = null,
    onFocusTaken: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val agents = team.roster.agents
    val agentEmails = agents.map { it.email }.toSet()
    val rows = remember(store.messages, store.unreadBoundaryMs, agentEmails) {
        ThreadTranscript.rows(store.messages, store.unreadBoundaryMs, agentEmails)
    }
    val persistent = AgentTurn.persistentReactionMessageId(address.peerEmail, store.messages, agents)
    // A DM or a group hides a lone count: there it can only be the other person.
    val hideSingleCount = address.target is ThreadTarget.Peer || address.target is ThreadTarget.Group
    var openTrails by remember { mutableStateOf(setOf<String>()) }
    // The live trail is the working row's own second line, not a row.
    val liveTrail = if (!working) null else rows.indices.lastOrNull()?.let { last ->
        when {
            rows[last] is TranscriptRow.Trail -> last
            last > 0 && (rows[last] as? TranscriptRow.Message)?.message?.isPartial == true && rows[last - 1] is TranscriptRow.Trail -> last - 1
            else -> null
        }
    }
    val list = rememberLazyListState()
    val lastText = store.messages.lastOrNull { it.isPartial }?.text
    // While a jump brings older pages in, the newest line does not pull the reader back down.
    var jumping by remember(address.id) { mutableStateOf(false) }
    // The line a door landed on, washed in the accent for a moment.
    var flashed by remember(address.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(store.messages.size, working, lastText) {
        if (jumping) return@LaunchedEffect
        val count = list.layoutInfo.totalItemsCount
        if (count > 0) list.animateScrollToItem(count - 1)
    }
    val goneEarlier = stringResource(R.string.thread_earlier_gone)
    // Older pages until the line is loaded, then the line itself in view. False when history ran out first.
    suspend fun land(id: String): Boolean {
        jumping = true
        try {
            if (!store.loadOlder(until = id)) {
                store.errorMessage = goneEarlier
                return false
            }
            val rowsNow = ThreadTranscript.rows(store.messages, store.unreadBoundaryMs, agentEmails)
            val at = rowsNow.indexOfFirst { (it as? TranscriptRow.Message)?.message?.id == id || (it as? TranscriptRow.Event)?.message?.id == id }
            if (at >= 0) list.animateScrollToItem(at + if (store.canLoadOlder) 1 else 0)
            return true
        } finally {
            jumping = false
        }
    }
    val jumpToParent: ((String) -> Unit)? = if (address.supportsMessageReplies) ({ id: String -> scope.launch { land(id) }; Unit }) else null
    // `applyPendingFocus`: once this conversation and its lines are here. The wash runs on its own,
    // so taking the focus (which restarts this effect) does not cut it short.
    var washing by remember(address.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(focus, store.thread?.id, store.messages.isEmpty()) {
        val asked = focus ?: return@LaunchedEffect
        if (store.thread?.id != asked.threadId || store.messages.isEmpty()) return@LaunchedEffect
        val found = land(asked.messageId)
        if (found) washing = asked.messageId
        onFocusTaken()
    }
    LaunchedEffect(washing) {
        val id = washing ?: return@LaunchedEffect
        delay(250)
        flashed = id
        delay(1_800)
        flashed = null
        washing = null
    }
    val today = LocalDate.now()
    LazyColumn(
        Modifier.fillMaxSize(),
        state = list,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 12.dp),
    ) {
        if (store.canLoadOlder) {
            item("older") {
                Text(
                    stringResource(R.string.thread_load_earlier),
                    Modifier
                        .fillMaxWidth()
                        .clickable(role = Role.Button) { scope.launch { store.loadOlder() } }
                        .padding(vertical = 8.dp),
                    style = StarlingsType.footnote,
                    color = Starlings.colors.accentMark,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
        itemsIndexed(rows) { index, row ->
            when (row) {
                is TranscriptRow.Day -> DayDivider(row.date, today)
                TranscriptRow.UnreadMark -> UnreadDivider()
                is TranscriptRow.Trail -> {
                    if (index != liveTrail) {
                        val key = row.steps.first().id
                        TrailRow(row.steps, key in openTrails) { openTrails = if (key in openTrails) openTrails - key else openTrails + key }
                    }
                }
                is TranscriptRow.Event -> EventLine(row.message, doors)
                is TranscriptRow.Message -> MessageRow(
                    message = row.message,
                    grouped = row.grouped,
                    sender = team.roster.peers.firstOrNull { it.email.equals(row.message.senderEmail, ignoreCase = true) },
                    fromAgent = row.message.senderEmail in agentEmails,
                    showPersistentReactions = row.message.id == persistent,
                    hideSingleCount = hideSingleCount,
                    replyParent = row.message.replyToMessageId?.let { parent -> store.messages.firstOrNull { it.id == parent } },
                    flashed = flashed == row.message.id,
                    onJumpToParent = row.message.replyToMessageId?.let { parent -> jumpToParent?.let { jump -> { jump(parent) } } },
                    onReply = onReply?.takeIf { row.message.isReplyable }?.let { reply -> { reply(row.message) } },
                    onMarkAsDecision = onMarkAsDecision?.takeIf { row.message.text.isNotEmpty() && !row.message.isEvent }?.let { mark -> { mark(row.message) } },
                    onSaveAsQuickNote = { onSaveAsQuickNote(row.message) },
                    question = {
                        val m = row.message
                        val q = m.question
                        if (q != null && !m.isWithdrawn) {
                            QuestionCard(
                                question = q,
                                askedBy = m.senderName ?: m.senderShortName,
                                answer = QuestionSelection.answer(m.id, store.messages),
                                selected = store.questionSelections[m.id].orEmpty(),
                                submitting = m.id in store.submittingQuestionIds,
                                error = store.questionErrors[m.id],
                                onSelect = { option, on -> store.selectQuestionOption(m, option, on) },
                                onSubmit = { scope.launch { store.answerQuestion(m) } },
                            )
                        }
                        val release = m.releaseRequest
                        if (release != null && !m.isWithdrawn) {
                            ReleaseRequestCard(
                                request = release,
                                state = m.releaseState,
                                askedBy = m.senderName ?: m.senderShortName,
                                busy = m.id in store.releaseBusyIds,
                                error = store.releaseErrors[m.id],
                                onApprove = if (keep.isAvailable) ({ onApproveRelease(m) }) else null,
                                onEnd = if (keep.isAvailable) ({ scope.launch { store.endRelease(m, keep.session) } }) else null,
                            )
                        }
                    },
                    attachment = { file -> AttachmentView(file, store) { store.errorMessage = it } },
                    linkCard = { MessageLinkCard(row.message.text, store) },
                    onReact = { emoji -> scope.launch { store.react(row.message, emoji) } },
                    onEdit = { onEdit(row.message) },
                    onWithdraw = { onWithdraw(row.message) },
                )
            }
        }
        if (working && agentName != null) {
            item("working") {
                val step = liveTrail?.let { (rows[it] as? TranscriptRow.Trail)?.steps?.lastOrNull()?.text }
                val since = agentSince ?: store.messages.lastOrNull { !it.isEvent }?.sentAt ?: nowMs
                WorkingRow(agentName, ThreadTranscript.elapsedLabel(since, nowMs), step)
            }
        }
    }
}

private val TIME = DateTimeFormatter.ofPattern("HH:mm")

private fun time(ms: Long): String = TIME.withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(ms))

/** A day boundary: Today, Yesterday, a weekday inside the week, else the date. */
@Composable
private fun DayDivider(date: LocalDate, today: LocalDate) {
    val c = Starlings.colors
    val title = when (val label = ThreadTranscript.dayLabel(date, today)) {
        DayLabel.Today -> stringResource(R.string.thread_today)
        DayLabel.Yesterday -> stringResource(R.string.thread_yesterday)
        is DayLabel.Weekday -> label.date.dayOfWeek.getDisplayName(java.time.format.TextStyle.FULL, java.util.Locale.getDefault())
        is DayLabel.Date -> DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).format(label.date)
    }
    Row(
        Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 6.dp).semantics(mergeDescendants = true) { },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
        HorizontalDivider(Modifier.weight(1f), thickness = 1.dp, color = c.secondary.copy(alpha = 0.2f))
    }
}

/** Where you left off: loud on purpose, in neutral ink. */
@Composable
private fun UnreadDivider() {
    val c = Starlings.colors
    val label = stringResource(R.string.thread_new_below)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp).clearAndSetSemantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        HorizontalDivider(Modifier.weight(1f), thickness = 1.dp, color = c.primary)
        Text(stringResource(R.string.thread_new), style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
    }
}

/**
 * The work graph reporting itself: quiet and unattributed. Its refs sit
 * under it as chips; one that opens something reads as a link.
 */
@Composable
private fun EventLine(message: ThreadMessageWire, doors: ThreadRefDoors?) {
    val c = Starlings.colors
    val label = stringResource(R.string.thread_event, message.text)
    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
        Row(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = label }, verticalAlignment = Alignment.CenterVertically) {
            Text(message.text, Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary)
            Spacer(Modifier.width(8.dp))
            Text(time(message.sentAt), style = StarlingsType.caption2, color = c.secondary.copy(alpha = 0.7f))
        }
        val refs = message.refs.orEmpty()
        if (refs.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) { refs.forEach { RefChip(it, doors) } }
        }
    }
}

/** An agent's steps, folded to one row; a tap unfolds them and the choice survives a poll. */
@Composable
private fun TrailRow(steps: List<ThreadMessageWire>, open: Boolean, onToggle: () -> Unit) {
    val c = Starlings.colors
    val label = stringResource(if (open) R.string.thread_hide_steps else R.string.thread_show_steps)
    Column(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier.clickable(role = Role.Button, onClick = onToggle).clearAndSetSemantics { contentDescription = label; role = Role.Button },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(if (open) Icons.Filled.ExpandMore else Icons.Filled.ChevronRight, null, Modifier.size(14.dp), tint = c.secondary)
            Text(pluralStringResource(R.plurals.thread_steps, steps.size, steps.size), style = StarlingsType.footnote, color = c.secondary)
        }
        if (open) {
            steps.forEach { step ->
                Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(step.text, Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary)
                    Spacer(Modifier.width(8.dp))
                    Text(time(step.sentAt), style = StarlingsType.caption2, color = c.secondary.copy(alpha = 0.7f))
                }
            }
        }
    }
}

/** A turn in flight: "<name> is working · 0:42", and its latest step. */
@Composable
private fun WorkingRow(name: String, elapsed: String, step: String?) {
    val c = Starlings.colors
    val label = stringResource(R.string.thread_is_working, name)
    Row(
        Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp).clearAndSetSemantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        GatheringDotsView(side = 20.dp, ink = c.secondary, motion = GatheringDots.Motion.THINKING)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("$label · $elapsed", style = StarlingsType.footnote, color = c.secondary)
            step?.let {
                Text(ThreadMarkdown.plainText(it), style = StarlingsType.caption, color = c.secondary.copy(alpha = 0.7f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/**
 * A turn: theirs on the left behind a face, yours on the right with none.
 * The name and time print once per turn. A long press holds the actions.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(
    message: ThreadMessageWire,
    grouped: Boolean,
    sender: PeerWire?,
    fromAgent: Boolean,
    showPersistentReactions: Boolean,
    hideSingleCount: Boolean,
    replyParent: ThreadMessageWire?,
    flashed: Boolean = false,
    onJumpToParent: (() -> Unit)? = null,
    onReply: (() -> Unit)? = null,
    onMarkAsDecision: (() -> Unit)? = null,
    onSaveAsQuickNote: () -> Unit = {},
    question: @Composable () -> Unit,
    attachment: @Composable (work.starlings.contracts.ThreadMessageAttachment) -> Unit,
    linkCard: @Composable () -> Unit,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onWithdraw: () -> Unit,
) {
    val c = Starlings.colors
    val clipboard = LocalClipboardManager.current
    var menu by remember { mutableStateOf(false) }
    val actionable = !message.isWithdrawn && !message.isPartial
    val wash = c.accent.copy(alpha = if (flashed) 0.28f else 0f)
    Box(Modifier.fillMaxWidth().padding(top = if (grouped) 5.dp else 16.dp).background(wash, RoundedCornerShape(10.dp))) {
        Row(
            Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = {}, onLongClick = if (actionable) ({ menu = true }) else null),
            horizontalArrangement = if (message.isMine) Arrangement.End else Arrangement.Start,
        ) {
            if (message.isMine) Spacer(Modifier.width(48.dp))
            if (!message.isMine) {
                if (grouped) Spacer(Modifier.width(30.dp)) else PersonFace(message.senderEmail, message.senderName ?: message.senderShortName, sender?.avatarUpdatedAt, modifier = Modifier.padding(top = 1.dp), diameter = 30.dp, agent = sender?.agentAvatar)
                Spacer(Modifier.width(8.dp))
            }
            Column(
                Modifier.weight(1f, fill = false),
                horizontalAlignment = if (message.isMine) Alignment.End else Alignment.Start,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (!grouped) Header(message)
                if (message.replyToMessageId != null) ReplyLine(replyParent, onJumpToParent)
                Bubble(message)
                question()
                if (!message.isWithdrawn) linkCard()
                if (!message.isWithdrawn) {
                    message.attachments.orEmpty().forEach { attachment(it) }
                }
                if (showPersistentReactions && !message.isWithdrawn) {
                    val rail = stringResource(R.string.thread_reactions)
                    Row(Modifier.semantics { contentDescription = rail }, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        ThreadTranscript.quickReactions(fromAgent).forEach { emoji ->
                            ReactionPill(emoji, null, false, stringResource(R.string.thread_react_with, reactionName(emoji))) { onReact(emoji) }
                        }
                    }
                }
                val reactions = message.reactions.orEmpty()
                if (reactions.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        reactions.forEach { r ->
                            val count = r.count.toInt()
                            ReactionPill(
                                r.emoji,
                                if (!hideSingleCount || count > 1) "$count" else null,
                                r.isMine,
                                stringResource(R.string.thread_reaction_count, reactionName(r.emoji), count),
                            ) { onReact(r.emoji) }
                        }
                    }
                }
            }
            if (!message.isMine) Spacer(Modifier.width(48.dp))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            ThreadTranscript.quickReactions(fromAgent).forEach { emoji ->
                DropdownMenuItem(
                    text = { Text(reactionName(emoji)) },
                    leadingIcon = { StarlingsIcons.reaction(emoji)?.let { Icon(it, null) } ?: Text(emoji) },
                    onClick = { menu = false; onReact(emoji) },
                )
            }
            HorizontalDivider(color = c.border)
            if (message.text.isNotEmpty()) {
                DropdownMenuItem(text = { Text(stringResource(R.string.thread_copy)) }, onClick = { menu = false; clipboard.setText(AnnotatedString(message.text)) })
            }
            onReply?.let { reply ->
                DropdownMenuItem(text = { Text(stringResource(R.string.thread_reply)) }, onClick = { menu = false; reply() })
            }
            onMarkAsDecision?.let { mark ->
                DropdownMenuItem(text = { Text(stringResource(R.string.thread_mark_as_decision)) }, onClick = { menu = false; mark() })
            }
            if (message.isMine && !message.isEvent) {
                if (message.offersSaveAsQuickNote) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.thread_save_as_quick_note)) }, onClick = { menu = false; onSaveAsQuickNote() })
                }
                DropdownMenuItem(text = { Text(stringResource(R.string.thread_edit)) }, onClick = { menu = false; onEdit() })
                DropdownMenuItem(text = { Text(stringResource(R.string.thread_withdraw), color = c.danger) }, onClick = { menu = false; onWithdraw() })
            }
        }
    }
}

/** Your own turns carry the time alone. */
@Composable
private fun Header(message: ThreadMessageWire) {
    val c = Starlings.colors
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (!message.isMine) Text(message.senderShortName, style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
        Text(time(message.sentAt), style = StarlingsType.caption2, color = c.secondary)
        if (message.editedAt != null && !message.isWithdrawn) Text(stringResource(R.string.thread_edited), style = StarlingsType.caption2, color = c.secondary)
        message.via?.let { Text(stringResource(R.string.thread_via, it), style = StarlingsType.caption2, color = c.secondary) }
    }
}

/** A tombstone, or the Markdown somebody wrote. A line still being written has a draft's edge. */
@Composable
private fun Bubble(message: ThreadMessageWire) {
    val c = Starlings.colors
    val shape = RoundedCornerShape(StarlingsRadius.control)
    Box(
        Modifier
            .background(if (message.isMine) c.accent.copy(alpha = 0.18f) else c.panel, shape)
            .then(if (message.isPartial) Modifier.border(1.dp, c.secondary.copy(alpha = 0.5f), shape) else Modifier)
            .padding(horizontal = 11.dp, vertical = 8.dp),
    ) {
        if (message.isWithdrawn) {
            Text(stringResource(R.string.thread_withdrawn), style = StarlingsType.body.copy(fontStyle = FontStyle.Italic), color = c.secondary)
        } else {
            MarkdownText(message.text, message.mentions.orEmpty())
        }
    }
}

/** One reaction: its icon (a stranger draws as its own text), and the count where it says something. */
@Composable
private fun ReactionPill(emoji: String, count: String?, mine: Boolean, label: String, onClick: () -> Unit) {
    val c = Starlings.colors
    val ink = if (mine) c.accentMark else c.secondary
    val shape = RoundedCornerShape(StarlingsRadius.control)
    Row(
        Modifier
            .heightIn(min = 28.dp)
            .background(c.elevated, shape)
            .border(1.dp, c.border, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
            .padding(horizontal = 9.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        StarlingsIcons.reaction(emoji)?.let { Icon(it, null, Modifier.size(14.dp), tint = ink) } ?: Text(emoji, style = StarlingsType.caption)
        count?.let { Text(it, style = StarlingsType.caption, color = ink) }
    }
}

/** The field and the send button, siblings, so the field gets the width the button leaves. */
@Composable
private fun Composer(
    store: ThreadStore,
    onPaste: (() -> Unit)?,
    prompt: String,
    draft: String,
    onDraft: (String) -> Unit,
    editing: Boolean,
    error: String?,
    sending: Boolean,
    onCancelEdit: () -> Unit,
    /** The parent the next message, or the one being edited, replies to. */
    replyParentId: String? = null,
    editingReply: Boolean = false,
    onCancelReply: () -> Unit = {},
    replyValid: Boolean = true,
    onSend: () -> Unit,
) {
    val c = Starlings.colors
    val trimmed = draft.trim()
    val hasSomething = trimmed.isNotEmpty() || (store.pending.isNotEmpty() && !editing)
    val canSend = hasSomething && replyValid && trimmed.length <= TeamCadence.MAX_CHARACTERS && !sending
    val fieldLabel = stringResource(if (editing) R.string.thread_edit_message else R.string.thread_message)
    val sendLabel = stringResource(if (editing) R.string.thread_save else R.string.thread_send)
    // The field keeps its selection here, for the format menu; the text is the screen's draft.
    var field by remember { mutableStateOf(TextFieldValue(draft, TextRange(draft.length))) }
    if (field.text != draft) field = TextFieldValue(draft, TextRange(draft.length))
    Column(
        Modifier.fillMaxWidth().background(c.panel).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        error?.let { Text(it, style = StarlingsType.caption, color = c.danger) }
        if (editing) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.thread_editing), Modifier.weight(1f), style = StarlingsType.caption, color = c.secondary)
                Text(
                    stringResource(R.string.thread_cancel),
                    Modifier.clickable(role = Role.Button, onClick = onCancelEdit).padding(4.dp),
                    style = StarlingsType.caption,
                    color = c.primary,
                )
            }
        }
        replyParentId?.let { parentId -> ReplyContext(store.messages.firstOrNull { it.id == parentId }, editingReply, onCancelReply) }
        if (!editing) AttachmentTray(store)
        val pill = RoundedCornerShape(24.dp)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (!editing) AttachButton(store, onPaste) { store.errorMessage = it }
        FormatButton(field) { edited -> field = edited; onDraft(edited.text) }
        Row(
            Modifier.weight(1f).heightIn(min = 44.dp).background(c.field, pill).border(1.dp, c.border, pill).padding(start = 14.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = field,
                onValueChange = { field = it; if (it.text != draft) onDraft(it.text) },
                modifier = Modifier.weight(1f).padding(vertical = 10.dp).semantics { contentDescription = fieldLabel },
                textStyle = StarlingsType.body.copy(color = c.primary),
                cursorBrush = SolidColor(c.accent),
                maxLines = 6,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                decorationBox = { inner ->
                    Box {
                        if (draft.isEmpty()) Text(prompt, style = StarlingsType.body, color = c.secondary.copy(alpha = 0.7f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        inner()
                    }
                },
            )
            Spacer(Modifier.width(8.dp))
            Box(
                Modifier
                    .size(32.dp)
                    .alpha(if (canSend) 1f else 0.4f)
                    .background(c.accent, CircleShape)
                    .clickable(enabled = canSend, role = Role.Button, onClick = onSend)
                    .clearAndSetSemantics { contentDescription = sendLabel; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.ArrowUpward, null, Modifier.size(18.dp), tint = c.accentInk) }
        }
        }
    }
}

/** A hand-off carries text only, so over the limit there is nothing to send. It leaves the draft and staged files alone. */
private suspend fun pasteAndSend(store: ThreadStore, text: String, candidates: List<String>) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) {
        store.errorMessage = "Nothing to paste."
        return
    }
    if (trimmed.length > TeamCadence.MAX_CHARACTERS) {
        store.errorMessage = "That is %,d characters; the limit is %,d.".format(trimmed.length, TeamCadence.MAX_CHARACTERS)
        return
    }
    store.send(trimmed, MentionMatching.mentions(trimmed, candidates), alone = true)
}
