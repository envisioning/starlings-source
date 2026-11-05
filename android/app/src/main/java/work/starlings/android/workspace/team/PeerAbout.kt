package work.starlings.android.workspace.team

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.LocalWorkspaceNavigator
import work.starlings.contracts.PeerWire
import java.time.Instant

/**
 * `MobilePeerInfoView`, the parts Team holds: who they are, how to reach
 * them, and for an agent what it says it does; for a colleague, today's
 * schedule, what is between you and the work you share
 * (`PeerAboutSections.kt`). Read from the live roster row, so the sheet
 * follows each poll.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PeerAboutSheet(peer: PeerWire, store: TeamStore, onDismiss: () -> Unit) {
    val c = Starlings.colors
    val current = store.roster.peers.firstOrNull { it.email.equals(peer.email, ignoreCase = true) } ?: peer
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val details = rememberPeerDetails(store, current)
    val navigator = LocalWorkspaceNavigator.current
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = c.canvas) {
        SheetHeader(stringResource(R.string.team_about), stringResource(R.string.team_done), onDismiss)
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            ListSection(null) {
                ListRow {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        PeerFace(current, current.dot())
                        Column(Modifier.semantics(mergeDescendants = true) { }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(current.displayName, style = StarlingsType.headline, color = c.primary)
                            Text(current.email, style = StarlingsType.footnote, color = c.secondary)
                        }
                    }
                }
                current.title?.takeIf { it.isNotBlank() }?.let { Labeled(stringResource(R.string.team_role), it.trim()) }
                current.pronouns?.takeIf { it.isNotBlank() }?.let { Labeled(stringResource(R.string.team_pronouns), it.trim()) }
            }
            if (current.isAgent) {
                AgentAboutSections(current)
            } else {
                ListSection(stringResource(R.string.team_reaching_them)) {
                    Labeled(stringResource(R.string.team_status), if (current.invisible) stringResource(R.string.team_appear_offline) else displayLabel(current.displayState))
                    devicesLine(current.devices).takeIf { it.isNotEmpty() }?.let { Labeled(stringResource(R.string.team_devices), it) }
                    current.zone?.let { zone ->
                        val now = Instant.now()
                        val at = clock(now.toEpochMilli(), zone)
                        val off = if (current.isWithinWorkingHours(now) == false) stringResource(R.string.team_outside_hours) else ""
                        Labeled(stringResource(R.string.team_local_time), stringResource(R.string.team_their_time, at) + off)
                    }
                    if (current.presence == PeerStatus.OFFLINE && current.lastSeenAt > 0) {
                        val now = System.currentTimeMillis()
                        Labeled(stringResource(R.string.team_last_seen_label), DateUtils.getRelativeTimeSpanString(minOf(current.lastSeenAt, now), now, DateUtils.MINUTE_IN_MILLIS).toString())
                    }
                }
                if (!current.isSelf) {
                    TodayScheduleSection(details)
                    BetweenUsSection(current, details, navigator, onDismiss)
                    SharedWorkSection(details, navigator, onDismiss)
                }
            }
        }
    }
}

/** `LabeledContent`: the label, and its value trailing in secondary ink. A row with [onClick] opens something. */
@Composable
internal fun Labeled(label: String, value: String, divider: Boolean = false, onClick: (() -> Unit)? = null) {
    val c = Starlings.colors
    ListRow(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier, divider = divider) {
        Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { }, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(label, Modifier.weight(1f), style = StarlingsType.body.copy(fontWeight = FontWeight.Normal), color = c.primary)
            Text(value, style = StarlingsType.body, color = c.secondary)
        }
    }
}
