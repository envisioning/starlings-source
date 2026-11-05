package work.starlings.android.workspace.work

import android.content.res.Resources
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkSection
import work.starlings.contracts.CrmLicense

/** The words for a licence's values. */
internal object LicenseText {
    fun product(r: Resources, value: String?): String = when (value) {
        "signals" -> r.getString(R.string.work_license_product_signals)
        null, "other" -> r.getString(R.string.work_license_product_other)
        else -> value
    }

    fun plan(r: Resources, value: String): String = when (value) {
        "starter" -> r.getString(R.string.work_license_plan_starter)
        "pro" -> r.getString(R.string.work_license_plan_pro)
        "partner" -> r.getString(R.string.work_license_plan_partner)
        else -> value
    }

    fun payment(r: Resources, value: String): String = when (value) {
        "invoice" -> r.getString(R.string.work_license_payment_invoice)
        "stripe" -> r.getString(R.string.work_license_payment_stripe)
        else -> value
    }

    fun interval(r: Resources, value: String): String = when (value) {
        "month" -> r.getString(R.string.work_license_interval_month)
        "year" -> r.getString(R.string.work_license_interval_year)
        "one_time" -> r.getString(R.string.work_license_interval_one_time)
        else -> value
    }
}

/**
 * A licence on the phone (decided by MZ, 2026-11-05): read it. Editing is on the
 * web and the Mac. The row in hand is the whole record, so this reads nothing.
 */
@Composable
internal fun LicenseScreen(license: CrmLicense, onDismiss: () -> Unit) {
    val c = Starlings.colors
    val r = LocalContext.current.resources
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.canvas)) {
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp)) {
                Box(Modifier.align(Alignment.CenterStart)) { WorkIconButton(Icons.Filled.Close, stringResource(R.string.work_close), onDismiss) }
                Text(
                    OverviewText.licenseTitle(r, license),
                    Modifier.align(Alignment.Center).padding(horizontal = 56.dp),
                    style = StarlingsType.body.copy(fontWeight = FontWeight.SemiBold), color = c.primary, maxLines = 1,
                )
            }
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                WorkSection {
                    val rows = buildList {
                        add(r.getString(R.string.work_license_product) to LicenseText.product(r, license.product))
                        license.planType?.let { add(r.getString(R.string.work_license_plan) to LicenseText.plan(r, it)) }
                        license.seats?.let { add(r.getString(R.string.work_license_seats) to it.toString()) }
                        OverviewText.licenseAmount(license)?.let { add(r.getString(R.string.work_license_amount) to it) }
                        OverviewText.day(license.startDate)?.let { add(r.getString(R.string.work_license_start) to it) }
                        OverviewText.day(license.renewalDate)?.let { add(r.getString(R.string.work_license_renewal) to it) }
                        license.paymentType?.let { add(r.getString(R.string.work_license_payment) to LicenseText.payment(r, it)) }
                        license.billingInterval?.let { add(r.getString(R.string.work_license_billing) to LicenseText.interval(r, it)) }
                        add(r.getString(R.string.work_license_status) to r.getString(if (license.isActive) R.string.work_license_active else R.string.work_inactive))
                        license.signalsOrgId?.let { add(r.getString(R.string.work_license_signals_org) to it) }
                    }
                    rows.forEachIndexed { index, (label, value) ->
                        if (index > 0) WorkDivider()
                        WorkLabeledRow(label, value)
                    }
                    license.notes?.takeIf { it.isNotBlank() }?.let { WorkNote(it) }
                }
                license.usage?.let { usage ->
                    OfferFold("license.usage", r.getString(R.string.work_license_usage)) {
                        WorkSection {
                            val rows = listOfNotNull(
                                OverviewText.day(usage.snapshotAt)?.let { r.getString(R.string.work_license_usage_on) to it },
                                usage.sessionsCreated30d?.let { r.getString(R.string.work_license_sessions) to it.toString() },
                                usage.workflowRunsSucceeded30d?.let { r.getString(R.string.work_license_runs) to it.toString() },
                                usage.projectsCount?.let { r.getString(R.string.work_license_projects) to it.toString() },
                            )
                            rows.forEachIndexed { index, (label, value) ->
                                if (index > 0) WorkDivider()
                                WorkLabeledRow(label, value)
                            }
                        }
                    }
                }
            }
        }
    }
}
