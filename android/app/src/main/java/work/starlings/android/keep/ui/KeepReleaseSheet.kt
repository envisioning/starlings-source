package work.starlings.android.keep.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.keep.KeepAccess
import work.starlings.android.keep.KeepItemSummary
import work.starlings.android.keep.KeepRelease
import work.starlings.android.keep.KeepReleaseRequest
import work.starlings.android.keep.KeepVaultDetail
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkSheet

// An agent's request for one Keep item (ADR 0007 decisions 5 and 10 to 12,
//): `Sources/KeepReleaseSheet.swift`. A member of the
// item's vault approves here. Keep unlocks on this device (the gates), this
// device opens the item and seals it to the agent's key
// (`KeepSession.release`), and Keep stores only that. Then the card in
// Starlings records who approved and until when. Starlings never sees the value.

/** The choices the approver has. ADR 0007 decision 11: 15 minutes by default, up to 24 hours. */
enum class KeepReleaseDuration(val seconds: Int, val label: Int) {
    QUARTER_HOUR(900, R.string.keep_release_15_minutes),
    HOUR(3600, R.string.keep_release_1_hour),
    FOUR_HOURS(14_400, R.string.keep_release_4_hours),
    DAY(86_400, R.string.keep_release_24_hours),
}

/**
 * Approve: unlock Keep, find the item, choose how long, seal it to the
 * agent. [onApproved] asks the card to record the release; Keep has it
 * already, so a retry after the card failed only tells the card.
 */
@Composable
fun KeepReleaseSheet(
    access: KeepAccess,
    request: KeepReleaseRequest,
    agentName: String,
    askedFor: String?,
    onApproved: suspend (KeepRelease) -> Unit,
    onClose: () -> Unit,
) {
    val c = Starlings.colors
    val session = access.session
    val scope = rememberCoroutineScope()
    var duration by remember { mutableStateOf(KeepReleaseDuration.QUARTER_HOUR) }
    var picker by remember { mutableStateOf(false) }
    var vault by remember { mutableStateOf<KeepVaultDetail?>(null) }
    var item by remember { mutableStateOf<KeepItemSummary?>(null) }
    var resolveError by remember { mutableStateOf<String?>(null) }
    var approveError by remember { mutableStateOf<String?>(null) }
    var approving by remember { mutableStateOf(false) }
    // Keep made it, the card has not heard yet: a retry only tells the card.
    var released by remember { mutableStateOf<KeepRelease?>(null) }
    val cardFailed = stringResource(R.string.keep_release_card_failed)

    LaunchedEffect(session) { session.refresh() }
    val unlocked = session.isUnlocked
    LaunchedEffect(unlocked) {
        if (!unlocked || vault != null) return@LaunchedEffect
        try {
            val (v, i) = session.resolveRelease(request)
            vault = v
            item = i
            resolveError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            resolveError = e.message
        }
    }

    fun approve() {
        val v = vault ?: return
        val i = item ?: return
        if (approving) return
        approving = true
        approveError = null
        scope.launch {
            try {
                val release = released ?: session.release(request, v, i, duration.seconds).also { released = it }
                onApproved(release)
                onClose()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                approveError = if (released == null) e.message else cardFailed
            } finally {
                approving = false
            }
        }
    }

    WorkSheet(
        title = stringResource(R.string.keep_release_approve),
        closeLabel = stringResource(R.string.keep_cancel),
        onDismiss = onClose,
        confirm = if (unlocked) stringResource(if (approving) R.string.keep_release_approving else R.string.keep_release_approve) else null,
        confirmEnabled = !approving && vault != null && item != null,
        onConfirm = { approve() },
        scrolls = unlocked,
    ) {
        if (!unlocked) {
            KeepGates(access, session.state)
            return@WorkSheet
        }
        ListSection(null, Modifier.padding(horizontal = 16.dp)) {
            WorkLabeledRow(stringResource(R.string.keep_release_agent), agentName)
            WorkDivider()
            WorkLabeledRow(stringResource(R.string.keep_release_item), item?.name ?: request.item)
            WorkDivider()
            WorkLabeledRow(stringResource(R.string.keep_release_vault), vault?.name ?: request.vault)
            WorkDivider()
            WorkLabeledRow(stringResource(R.string.keep_release_task), request.task)
            WorkDivider()
            WorkLabeledRow(stringResource(R.string.keep_release_why), request.reason.orEmpty())
            askedFor?.let {
                WorkDivider()
                WorkLabeledRow(stringResource(R.string.keep_release_asked_for), it)
            }
        }
        ListSection(null, Modifier.padding(horizontal = 16.dp)) {
            Box {
                WorkLabeledRow(stringResource(R.string.keep_release_ends_in), stringResource(duration.label)) { picker = true }
                DropdownMenu(picker, { picker = false }, containerColor = c.elevated) {
                    KeepReleaseDuration.entries.forEach { choice ->
                        DropdownMenuItem(
                            text = { Text(stringResource(choice.label), style = StarlingsType.body, color = c.primary) },
                            trailingIcon = if (choice == duration) ({ Icon(Icons.Filled.Check, null, tint = c.accent) }) else null,
                            onClick = { duration = choice; picker = false },
                        )
                    }
                }
            }
        }
        (resolveError ?: approveError)?.let { Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp)) { KeepErrorText(it) } }
    }
}

