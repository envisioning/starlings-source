package work.starlings.android.workspace.team

import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import work.starlings.android.R
import work.starlings.android.keep.KeepReleaseRequest
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.ThreadReleaseRequest
import work.starlings.contracts.ThreadReleaseState
import work.starlings.contracts.ThreadReleaseStatus
import java.util.Locale

/**
 * What a Keep release card says (`ThreadReleaseCard` in
 * `Sources/KeepReleaseSheet.swift`), as rules a test can hold. An agent asks
 * for one item; a member approves on this device; the card is only a
 * record of what Keep did. Starlings never sees the value.
 */
object ThreadReleaseCard {
    /** The fact under the card. No state: the request waits. */
    sealed interface Status {
        data class Ended(val by: String) : Status
        data class UsedUntil(val approver: String, val untilMs: Long) : Status
        data class Used(val approver: String) : Status
        data class Expired(val approver: String) : Status
        data class ApprovedUntil(val approver: String, val untilMs: Long) : Status
    }

    fun status(state: ThreadReleaseState?, nowMs: Long): Status? {
        state ?: return null
        val approver = state.approverName ?: state.approverEmail
        val live = state.expiresAt > nowMs
        return when {
            state.status == ThreadReleaseStatus.ENDED -> Status.Ended(state.endedByEmail ?: approver)
            state.status == ThreadReleaseStatus.USED && live -> Status.UsedUntil(approver, state.expiresAt)
            state.status == ThreadReleaseStatus.USED -> Status.Used(approver)
            !live -> Status.Expired(approver)
            else -> Status.ApprovedUntil(approver, state.expiresAt)
        }
    }

    /** Approved or used and not past its expiry: End now is offered. */
    fun isLive(state: ThreadReleaseState?, nowMs: Long): Boolean =
        state != null && (state.status == ThreadReleaseStatus.APPROVED || state.status == ThreadReleaseStatus.USED) && state.expiresAt > nowMs

    /**
     * How long the agent asked for, as hours and minutes: minutes alone
     * under an hour, as iOS's formatter is set. Null when it did not say.
     */
    fun askedFor(request: ThreadReleaseRequest): Pair<Long, Long>? {
        val seconds = request.expiresInSeconds ?: return null
        return if (seconds >= 3600) (seconds / 3600) to (seconds % 3600) / 60 else 0L to seconds / 60
    }

    /** The request as [work.starlings.android.keep.KeepSession] takes it. */
    fun keepRequest(request: ThreadReleaseRequest, agentEmail: String) = KeepReleaseRequest(
        requestId = request.requestId,
        vault = request.vault,
        item = request.item,
        agent = agentEmail,
        task = request.task,
        reason = request.reason,
        sessionPublicKey = request.sessionPublicKey,
    )
}

/** "15 minutes", "1 hour, 30 minutes": the system's words, as `DateComponentsFormatter` with `.full`. */
internal fun askedForText(hoursMinutes: Pair<Long, Long>): String {
    val (h, m) = hoursMinutes
    val parts = buildList {
        if (h > 0) add(Measure(h, MeasureUnit.HOUR))
        if (m > 0 || h == 0L) add(Measure(m, MeasureUnit.MINUTE))
    }
    return MeasureFormat.getInstance(Locale.getDefault(), MeasureFormat.FormatWidth.WIDE).formatMeasures(*parts.toTypedArray())
}

@Composable
internal fun ThreadReleaseCard.Status.text(): String = when (this) {
    is ThreadReleaseCard.Status.Ended -> stringResource(R.string.keep_release_ended_by, by)
    is ThreadReleaseCard.Status.UsedUntil -> stringResource(R.string.keep_release_used_until, approver, clock(untilMs))
    is ThreadReleaseCard.Status.Used -> stringResource(R.string.keep_release_used, approver)
    is ThreadReleaseCard.Status.Expired -> stringResource(R.string.keep_release_expired, approver)
    is ThreadReleaseCard.Status.ApprovedUntil -> stringResource(R.string.keep_release_approved_until, approver, clock(untilMs))
}

/**
 * `ReleaseRequestCard`: an agent's request for one Keep item. The
 * item, the task, why, and Approve while it waits; who approved and End now
 * once it is live. Re-read every 30 s, so an expiry shows without a poll.
 * [onApprove] and [onEnd] are null where the workspace has no Keep.
 */
@Composable
fun ReleaseRequestCard(
    request: ThreadReleaseRequest,
    state: ThreadReleaseState?,
    askedBy: String,
    busy: Boolean,
    error: String?,
    onApprove: (() -> Unit)?,
    onEnd: (() -> Unit)?,
) {
    val c = Starlings.colors
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }
    val label = stringResource(R.string.keep_release_card)
    Column(
        Modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .background(c.panel, RoundedCornerShape(StarlingsRadius.card))
            .semantics { contentDescription = label }
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Key, null, Modifier.size(16.dp), tint = c.primary)
            Text(
                stringResource(R.string.keep_release_title, askedBy, state?.itemName ?: request.item),
                style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold),
                color = c.primary,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ReleaseLine(stringResource(R.string.keep_release_vault), request.vault)
            ReleaseLine(stringResource(R.string.keep_release_task), request.task)
            ReleaseLine(stringResource(R.string.keep_release_why), request.reason)
            ThreadReleaseCard.askedFor(request)?.let { ReleaseLine(stringResource(R.string.keep_release_asked_for), askedForText(it)) }
        }
        ThreadReleaseCard.status(state, now)?.let { Text(it.text(), style = StarlingsType.footnote, color = c.secondary) }
        error?.let { Text(it, style = StarlingsType.footnote, color = c.danger) }
        if (state == null && onApprove != null) {
            FilledButton(stringResource(R.string.keep_release_approve), onApprove, enabled = !busy, compact = true)
        } else if (ThreadReleaseCard.isLive(state, now) && onEnd != null) {
            BorderedButton(
                stringResource(if (busy) R.string.keep_release_ending else R.string.keep_release_end_now),
                onEnd,
                enabled = !busy,
                compact = true,
                foreground = c.danger,
            )
        }
    }
}

@Composable
private fun ReleaseLine(label: String, value: String) {
    val c = Starlings.colors
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, Modifier.widthIn(min = 64.dp), style = StarlingsType.footnote, color = c.secondary)
        Text(value, style = StarlingsType.footnote, color = c.primary)
    }
}
