package work.starlings.android.workspace.work

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.SubjectRoutes
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.contracts.OfferDecision
import work.starlings.contracts.OfferDecisionAccept
import work.starlings.contracts.OfferDecisionReject
import work.starlings.contracts.OfferDuplicate
import work.starlings.contracts.OfferHeaderNextSend
import work.starlings.contracts.OfferLine
import work.starlings.contracts.OfferResponse
import work.starlings.contracts.OfferVersionResponse

/**
 * An offer on the phone (decided by MZ, 2026-11-04): read it, share
 * its link, duplicate it, record the buyer's answer. Editing is on the web and
 * the Mac. Every figure comes from the server.
 */
@Composable
internal fun OfferScreen(store: WorkStore, offerId: String, onDismiss: () -> Unit, onChanged: () -> Unit) {
    val c = Starlings.colors
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    var id by remember { mutableStateOf(offerId) }
    var data by remember { mutableStateOf<OfferResponse?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }

    LaunchedEffect(id, attempt) {
        loadError = null
        try {
            data = store.client.call(SubjectRoutes.offer(id))
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            loadError = e.workMessage()
        }
    }

    /** One change: busy while it runs, its answer replaces the page, its failure shows here. */
    fun change(action: suspend () -> OfferResponse) {
        busy = true
        error = null
        scope.launch {
            try {
                val answer = action()
                data = answer
                id = answer.offer.id
                onChanged()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                busy = false
            }
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.canvas).imePadding()) {
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp)) {
                Box(Modifier.align(Alignment.CenterStart)) { WorkIconButton(Icons.Filled.Close, stringResource(R.string.work_close), onDismiss) }
                Text(
                    data?.offer?.title?.takeIf { it.isNotBlank() } ?: r.getString(R.string.work_untitled_offer),
                    Modifier.align(Alignment.Center).padding(horizontal = 56.dp),
                    style = StarlingsType.body.copy(fontWeight = FontWeight.SemiBold), color = c.primary, maxLines = 1,
                )
            }
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                val current = data
                when {
                    current != null -> OfferBody(store, current, busy, error,
                        onDuplicate = { change { store.client.call(SubjectRoutes.duplicateOffer(id, OfferDuplicate())) } },
                        onDecide = { decision -> change { store.client.call(SubjectRoutes.recordOfferDecision(id, decision)) } },
                    )
                    loadError != null -> WorkErrorNotice(loadError.orEmpty(), stringResource(R.string.work_retry), { attempt += 1 })
                    else -> WorkPlaceholderRows()
                }
            }
        }
    }
}

@Composable
private fun OfferBody(
    store: WorkStore,
    data: OfferResponse,
    busy: Boolean,
    error: String?,
    onDuplicate: () -> Unit,
    onDecide: (OfferDecision) -> Unit,
) {
    val context = LocalContext.current
    val r = context.resources
    val offer = data.offer
    WorkSection {
        OfferValue(r.getString(R.string.work_offer_status), OfferValues.statusLabel(r, offer.shownStatus))
        if (offer.hasUnsentChanges) WorkNote(r.getString(R.string.work_offer_unsent))
        offer.recipientEmail?.takeIf { it.isNotBlank() }?.let { OfferValue(r.getString(R.string.work_offer_for), it) }
        OverviewText.day(offer.validUntil)?.let { OfferValue(r.getString(R.string.work_offer_valid_until), it) }
    }
    OfferFold("lines", r.getString(R.string.work_offer_lines)) {
        if (data.lines.isEmpty()) WorkNote(r.getString(R.string.work_offer_no_lines))
        data.lines.forEachIndexed { index, line ->
            if (index > 0) WorkDivider()
            OfferLineRow(line, data.totals.currency)
        }
    }
    OfferFold("totals", r.getString(R.string.work_offer_totals)) {
        OfferTotals(data)
    }
    if (data.versions.isNotEmpty()) {
        OfferFold("versions", r.getString(R.string.work_offer_versions)) {
            OfferVersions(store, data)
        }
    }
    OfferFold("actions", r.getString(R.string.work_offer_actions)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            offer.link?.let { link ->
                BorderedButton(r.getString(R.string.work_offer_share_link), {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
                    runCatching { context.startActivity(Intent.createChooser(send, null)) }
                }, Modifier.fillMaxWidth())
            }
            BorderedButton(r.getString(R.string.work_offer_duplicate), onDuplicate, Modifier.fillMaxWidth(), enabled = !busy)
            OfferDecisionControls(data, busy, onDecide)
            error?.let { WorkErrorNotice(it) }
        }
    }
}

/** A section whose fold this device remembers. */
@Composable
internal fun OfferFold(key: String, title: String, content: @Composable ColumnScope.() -> Unit) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("work", Context.MODE_PRIVATE) }
    var folded by remember(key) { mutableStateOf(prefs.getBoolean("offer.fold.$key", false)) }
    WorkSection(header = {
        WorkFoldTitle(title, folded, stringResource(R.string.work_folded), stringResource(R.string.work_open)) {
            folded = !folded
            prefs.edit().putBoolean("offer.fold.$key", folded).apply()
        }
    }) {
        if (!folded) content()
    }
}

@Composable
private fun OfferValue(label: String, value: String, strong: Boolean = false) {
    val c = Starlings.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f), style = StarlingsType.footnote, color = c.secondary)
        Text(value, style = StarlingsType.footnote.copy(fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal), color = c.primary)
    }
}

@Composable
private fun OfferLineRow(line: OfferLine, currency: String) {
    val c = Starlings.colors
    val r = LocalContext.current.resources
    val name = line.name?.takeIf { it.isNotBlank() } ?: r.getString(R.string.work_offer_untitled_line)
    val counted = if (line.quantity == 1.0) name else "${line.quantity.toLong()} × $name"
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (line.isOptional) r.getString(R.string.work_offer_line_optional, counted) else counted, Modifier.weight(1f), style = StarlingsType.footnote, color = c.primary)
            Text(OverviewText.offerMoney(line.price, "EUR"), style = StarlingsType.footnote, color = c.primary)
        }
        if (currency != "EUR") Text(OverviewText.offerMoney(line.displayPrice, currency), style = StarlingsType.footnote, color = c.secondary)
        line.description?.takeIf { it.isNotBlank() && !line.hideDescription }?.let {
            Text(it, style = StarlingsType.footnote, color = c.secondary, maxLines = 3)
        }
    }
}

/** The server's totals. No client adds a line. */
@Composable
private fun OfferTotals(data: OfferResponse) {
    val r = LocalContext.current.resources
    val totals = data.totals
    val eur = { value: Double -> OverviewText.offerMoney(value, "EUR") }
    val percent = { value: Double -> if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString() }
    OfferValue(r.getString(R.string.work_offer_subtotal), eur(totals.subtotalEur))
    if (totals.discountEur > 0) OfferValue(r.getString(R.string.work_offer_discount, percent(totals.discountPct)), "-" + eur(totals.discountEur))
    OfferValue(r.getString(R.string.work_offer_total), eur(totals.totalEur), strong = true)
    if (totals.taxEur > 0) OfferValue(r.getString(R.string.work_offer_tax, percent(totals.taxPct)), eur(totals.taxEur))
    if (totals.optionalTotalEur > 0) OfferValue(r.getString(R.string.work_offer_optional), eur(totals.optionalTotalEur))
    if (totals.recurringTotalEur > 0) OfferValue(r.getString(R.string.work_offer_recurring), eur(totals.recurringTotalEur))
    if (totals.indicative) {
        OfferValue(r.getString(R.string.work_offer_indicative, totals.currency), OverviewText.offerMoney(totals.total, totals.currency))
        WorkNote(r.getString(R.string.work_offer_eur_binding))
    }
    if (totals.rateMissing) WorkErrorNotice(r.getString(R.string.work_offer_no_rate, data.offer.currency))
}

/** The versions sent so far; each one opens as the buyer saw it. */
@Composable
private fun OfferVersions(store: WorkStore, data: OfferResponse) {
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf<OfferVersionResponse?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    data.versions.forEach { version ->
        val isOpen = open?.version?.version == version.version
        val day = OverviewText.day(version.sentAt) ?: version.sentAt
        val accepted = if (data.offer.acceptedVersion == version.version) " · " + r.getString(R.string.work_offer_accepted) else ""
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(r.getString(R.string.work_offer_version, version.version.toInt()) + " · " + day + accepted, Modifier.weight(1f), style = StarlingsType.footnote, color = Starlings.colors.primary)
            BorderedButton(r.getString(if (isOpen) R.string.work_close else R.string.work_offer_read), {
                if (isOpen) {
                    open = null
                } else {
                    error = null
                    scope.launch {
                        try {
                            open = store.client.call(SubjectRoutes.offerVersion(data.offer.id, version.version.toInt()))
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            error = e.workMessage()
                        }
                    }
                }
            }, compact = true)
        }
        if (isOpen) {
            open?.let { read ->
                read.lines.forEach { OfferLineRow(it, version.currency) }
                read.version.totalEur?.let { OfferValue(r.getString(R.string.work_offer_total), OverviewText.offerMoney(it, "EUR"), strong = true) }
            }
        }
    }
    error?.let { WorkErrorNotice(it) }
}

/** Record accept and Record reject. An accept names who accepted and the optional lines they took. */
@Composable
private fun OfferDecisionControls(data: OfferResponse, busy: Boolean, onDecide: (OfferDecision) -> Unit) {
    val r = LocalContext.current.resources
    val offer = data.offer
    var recording by remember { mutableStateOf(false) }
    var signer by remember { mutableStateOf("") }
    var signerEmail by remember { mutableStateOf("") }
    var chosen by remember { mutableStateOf(setOf<String>()) }
    if (!offer.locked && offer.nextSend != OfferHeaderNextSend.SEND) {
        if (recording) {
            StarlingsField(signer, { signer = it }, r.getString(R.string.work_offer_accepted_by), Modifier.fillMaxWidth())
            StarlingsField(signerEmail, { signerEmail = it }, r.getString(R.string.work_offer_email), Modifier.fillMaxWidth())
            data.lines.filter { it.isOptional }.forEach { line ->
                StarlingsToggle(line.name ?: r.getString(R.string.work_offer_untitled_line), line.id in chosen, { on ->
                    chosen = if (on) chosen + line.id else chosen - line.id
                })
            }
            FilledButton(r.getString(R.string.work_offer_record_accept), {
                onDecide(OfferDecisionAccept(
                    acceptedByName = signer.trim().takeIf { it.isNotEmpty() },
                    acceptedByEmail = signerEmail.trim().takeIf { it.isNotEmpty() },
                    selectedOptionalIds = chosen.toList().takeIf { it.isNotEmpty() },
                ))
            }, Modifier.fillMaxWidth(), enabled = !busy)
            BorderedButton(r.getString(R.string.work_cancel), { recording = false }, Modifier.fillMaxWidth(), enabled = !busy)
        } else {
            BorderedButton(r.getString(R.string.work_offer_record_accept), { recording = true }, Modifier.fillMaxWidth(), enabled = !busy)
            BorderedButton(r.getString(R.string.work_offer_record_reject), { onDecide(OfferDecisionReject()) }, Modifier.fillMaxWidth(), enabled = !busy)
        }
    }
    if (offer.isAccepted) {
        offer.acceptedAt?.let { at ->
            val day = OverviewText.day(at) ?: at
            WorkNote(listOfNotNull(r.getString(R.string.work_offer_accepted_on, day), offer.acceptedByName).joinToString(" · "))
        }
    }
}

/** The offer's status words: `fixtures/offer-values.json`, spelled in this client's strings. */
internal object OfferValues {
    fun statusLabel(r: android.content.res.Resources, status: String): String = when (status) {
        "draft" -> r.getString(R.string.work_offer_status_draft)
        "sent" -> r.getString(R.string.work_offer_status_sent)
        "viewed" -> r.getString(R.string.work_offer_status_viewed)
        "accepted" -> r.getString(R.string.work_offer_status_accepted)
        "declined" -> r.getString(R.string.work_offer_status_declined)
        "expired" -> r.getString(R.string.work_offer_status_expired)
        "rejected" -> r.getString(R.string.work_offer_status_rejected)
        else -> status.replace('_', ' ').replaceFirstChar { it.titlecase() }
    }
}
