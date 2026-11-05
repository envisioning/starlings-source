package work.starlings.android.workspace.team

import android.text.format.DateUtils
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import work.starlings.android.PresenceLabels
import work.starlings.android.R
import work.starlings.android.Reactions
import work.starlings.android.ui.PresenceDot
import work.starlings.contracts.PeerIntent
import work.starlings.contracts.PeerWire
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/*
 * The sentences Team's pure rules point at (TeamModel.kt), in the
 * reader's language: the iOS catalog's English and pt-BR.
 */

/** `meetTimeString`: the 24-hour clock, in [zone] or the reader's own. */
internal fun clock(epochMs: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    DateTimeFormatter.ofPattern("HH:mm").withZone(zone).format(Instant.ofEpochMilli(epochMs))

@Composable
fun presenceLabel(status: PeerStatus): String = stringResource(
    when (status) {
        PeerStatus.DND -> R.string.presence_dnd
        PeerStatus.IN_MEETING -> R.string.presence_in_meeting
        PeerStatus.BUSY -> R.string.presence_busy
        PeerStatus.AVAILABLE -> R.string.presence_available
        PeerStatus.ACTIVE -> R.string.presence_active
        PeerStatus.OFFLINE -> R.string.presence_offline
    },
)

/** An unknown intent shows its own id (`PresenceLabels.intentLabel`). */
@Composable
fun intentLabel(intent: PeerIntent): String = when (intent) {
    PeerIntent.AVAILABLE -> stringResource(R.string.presence_available)
    PeerIntent.FOCUSED -> stringResource(R.string.presence_focused)
    else -> PresenceLabels.intentLabel(intent.value)
}

@Composable
fun displayLabel(display: PeerDisplay): String = when (display) {
    is PeerDisplay.Status -> presenceLabel(display.status)
    is PeerDisplay.Intent -> intentLabel(display.intent)
}

@Composable
fun statusOptionLabel(option: PeerStatusOption): String = when (option) {
    PeerStatusOption.AVAILABLE -> stringResource(R.string.presence_available)
    PeerStatusOption.FOCUSED -> stringResource(R.string.presence_focused)
    PeerStatusOption.UNAVAILABLE -> stringResource(R.string.presence_dnd)
    PeerStatusOption.OFFLINE -> stringResource(R.string.presence_offline)
}

/** "Desktop (5.8.1), Mobile". */
@Composable
fun devicesLine(devices: List<PeerDevice>): String = devices.map { d ->
    val label = when (d.client) {
        "mac" -> stringResource(R.string.presence_client_mac)
        "ios" -> stringResource(R.string.presence_client_ios)
        "web" -> stringResource(R.string.presence_client_web)
        else -> PresenceLabels.client[d.client] ?: d.client
    }
    d.version?.let { "$label ($it)" } ?: label
}.joinToString(", ")

/** "Last seen 2 hours ago": clamped forward, so clock skew never says "in 3 minutes". */
@Composable
private fun relative(epochMs: Long): String {
    val now = System.currentTimeMillis()
    return DateUtils.getRelativeTimeSpanString(minOf(epochMs, now), now, DateUtils.MINUTE_IN_MILLIS).toString()
}

/** `teamPeerSubtitle`, spelled out. */
@Composable
fun peerLineText(line: PeerLine): String {
    @Composable
    fun suffix(devices: List<PeerDevice>): String = devicesLine(devices).let { if (it.isEmpty()) "" else " · $it" }
    return when (line) {
        is PeerLine.Agent -> if (line.working) stringResource(R.string.team_line_working) else ""
        is PeerLine.Intent -> intentLabel(line.intent) + suffix(line.devices)
        is PeerLine.FocusedUntil -> stringResource(R.string.team_line_focused_until, clock(line.untilMs))
        is PeerLine.Unavailable -> line.untilMs?.let { stringResource(R.string.team_line_unavailable_until, clock(it)) }
            ?: presenceLabel(PeerStatus.DND)
        is PeerLine.InMeeting -> if (line.participants > 0) {
            pluralStringResource(R.plurals.team_line_in_meeting, line.participants.toInt(), line.participants.toInt())
        } else presenceLabel(PeerStatus.IN_MEETING) + suffix(line.devices)
        is PeerLine.Busy -> line.untilMs?.let { stringResource(R.string.team_line_busy_until, clock(it)) }
            ?: (presenceLabel(PeerStatus.BUSY) + suffix(line.devices))
        is PeerLine.Available -> line.slug?.let { stringResource(R.string.team_line_available_room, it, suffix(line.devices)) }
            ?: (presenceLabel(PeerStatus.AVAILABLE) + suffix(line.devices))
        is PeerLine.Active -> devicesLine(line.devices).let {
            if (it.isEmpty()) presenceLabel(PeerStatus.ACTIVE) else stringResource(R.string.team_line_active_on, it)
        }
        is PeerLine.Offline -> line.lastSeenMs?.let { stringResource(R.string.team_line_last_seen, relative(it)) }
            ?: presenceLabel(PeerStatus.OFFLINE)
    }
}

/** The dot `PeerAvatar` draws: none on an agent or on somebody offline. */
fun PeerWire.dot(): PresenceDot = if (isAgent) PresenceDot.NONE else when (presence) {
    PeerStatus.IN_MEETING -> PresenceDot.IN_MEETING
    PeerStatus.BUSY -> PresenceDot.BUSY
    PeerStatus.AVAILABLE -> PresenceDot.AVAILABLE
    PeerStatus.ACTIVE -> PresenceDot.ACTIVE
    PeerStatus.DND -> PresenceDot.DND
    PeerStatus.OFFLINE -> PresenceDot.NONE
}

/** `Peer.conversationSubtitle`: status, title, and their clock. */
@Composable
private fun conversationSubtitle(peer: PeerWire): String {
    if (peer.isAgent) return if (peer.presence == PeerStatus.BUSY) stringResource(R.string.team_line_working) else ""
    val parts = mutableListOf(if (peer.invisible) stringResource(R.string.team_appear_offline) else displayLabel(peer.displayState))
    peer.title?.takeIf { it.isNotBlank() }?.let { parts += it }
    peer.zone?.let { zone ->
        val now = Instant.now()
        val at = clock(now.toEpochMilli(), zone)
        parts += if (peer.isWithinWorkingHours(now) == false) stringResource(R.string.team_their_time_off, at)
        else stringResource(R.string.team_their_time, at)
    }
    return parts.joinToString(" · ")
}

@Composable
fun addressTitle(address: ThreadAddress): String = when (val n = address.naming) {
    is ThreadAddress.Naming.OfPeer -> if (n.peer.isSelf) stringResource(R.string.team_notes_to_self) else n.peer.displayName
    is ThreadAddress.Naming.OfGroup -> n.names
    ThreadAddress.Naming.Everyone -> stringResource(R.string.team_everyone)
    is ThreadAddress.Naming.OfDirect -> n.title
    is ThreadAddress.Naming.OfSubject -> n.title
}

/** `ThreadKind.channelNoun`: the word "Message the … channel" uses for a subject. */
@Composable
fun channelNoun(kind: work.starlings.contracts.CrmSubjectKind): String = stringResource(
    when (kind) {
        work.starlings.contracts.CrmSubjectKind.LEAD -> R.string.team_noun_lead
        work.starlings.contracts.CrmSubjectKind.ORGANIZATION -> R.string.team_noun_partner
        work.starlings.contracts.CrmSubjectKind.EVENT -> R.string.team_noun_event
        else -> R.string.team_noun_project
    },
)

/** The composer placeholder: you ask an agent, you message a colleague. */
@Composable
fun addressPrompt(address: ThreadAddress): String = when (val n = address.naming) {
    is ThreadAddress.Naming.OfPeer -> when {
        n.peer.isSelf -> stringResource(R.string.team_write_note)
        n.peer.isAgent -> stringResource(R.string.team_ask, n.peer.shortName)
        else -> stringResource(R.string.team_message_to, n.peer.shortName)
    }
    is ThreadAddress.Naming.OfGroup -> stringResource(R.string.team_message_to, n.names)
    ThreadAddress.Naming.Everyone -> stringResource(R.string.team_message_everyone)
    is ThreadAddress.Naming.OfDirect -> stringResource(R.string.team_message_to, n.shortName)
    is ThreadAddress.Naming.OfSubject -> stringResource(R.string.team_message_channel, channelNoun(n.kind))
}

/**
 * One quiet line under the title, or null. Everyone's "Everybody at …"
 * needs the workspace name, which this client does not read yet.
 */
@Composable
fun addressSubtitle(address: ThreadAddress): String? = when (val n = address.naming) {
    is ThreadAddress.Naming.OfPeer -> if (n.peer.isSelf) stringResource(R.string.team_only_you) else conversationSubtitle(n.peer).ifEmpty { null }
    is ThreadAddress.Naming.OfGroup -> stringResource(R.string.team_people_count, n.people)
    ThreadAddress.Naming.Everyone -> null
    is ThreadAddress.Naming.OfDirect -> n.preview ?: stringResource(R.string.team_private_conversation)
    is ThreadAddress.Naming.OfSubject -> channelNoun(n.kind).replaceFirstChar { it.titlecase() }
}

/** The spoken name of a reaction; a stranger reads as its own text. */
@Composable
fun reactionName(emoji: String): String = Reactions.labelResource[emoji]?.let { stringResource(it) } ?: emoji

/** Outside composition (a snackbar), the same sentences. */
fun noticeText(context: android.content.Context, notice: TeamNotice): String = when (notice) {
    is TeamNotice.Waved -> context.getString(R.string.team_waved_at, notice.name)
    is TeamNotice.Failed -> notice.message
    is TeamNotice.Refused -> when (notice.reason) {
        CallRefusal.SELF -> context.getString(R.string.team_call_self)
        CallRefusal.AGENT -> context.getString(R.string.team_call_agent)
        CallRefusal.NO_ROOM -> context.getString(R.string.team_call_no_room, notice.name)
        CallRefusal.NOT_REACHABLE -> context.getString(R.string.team_call_unreachable, notice.name)
    }
}

