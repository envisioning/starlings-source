package work.starlings.android.core.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.core.CoreAccess
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkLabeledRow
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * Settings › Account › Core (`MobileCoreSettingsSection`): the account the
 * token is for and when it expires, Reconnect and Disconnect; or Connect
 * Core. Nothing where the workspace has no Core.
 */
@Composable
fun CoreSettingsSection() {
    val context = LocalContext.current
    val core = remember { CoreAccess.of(context) }
    if (!core.isAvailable) return
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    ListSection(stringResource(R.string.core_title)) {
        val credential = core.credential
        if (credential != null) {
            WorkLabeledRow(stringResource(R.string.core_account), credential.email)
            credential.expiry?.let { expiry ->
                WorkDivider()
                WorkLabeledRow(
                    stringResource(R.string.core_expires),
                    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(ZoneId.systemDefault()).format(expiry),
                )
            }
            WorkDivider()
            WorkActionRow(stringResource(R.string.core_reconnect), { scope.launch { core.link() } }, enabled = !core.isLinking)
            WorkDivider()
            WorkActionRow(stringResource(R.string.core_disconnect), { core.unlink() }, enabled = !core.isLinking, danger = true)
        } else if (core.isLinking) {
            Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(20.dp), color = c.secondary, strokeWidth = 2.dp)
            }
        } else {
            WorkActionRow(stringResource(R.string.core_connect), { scope.launch { core.link() } })
        }
        core.errorMessage?.let { message ->
            WorkDivider()
            if (core.needsCoreAccount) {
                ListRow { Text(message, style = StarlingsType.footnote, color = c.secondary) }
            } else {
                WorkErrorNotice(message)
            }
        }
    }
    Text(stringResource(R.string.core_settings_footer), Modifier.padding(start = 16.dp, top = 6.dp), style = StarlingsType.footnote, color = c.secondary)
}
