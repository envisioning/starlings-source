package work.starlings.android.workspace.settings

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.lock.AppLock
import work.starlings.android.lock.AppLockRules
import work.starlings.android.ui.ListFooter
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType

/**
 * Settings › App Lock (`EnvisioningAppLockSection` from iOS/MobileSettingsView.swift):
 * one switch, which answers only after the device does. The switch shows
 * what the device agreed to, not what was asked.
 */
@Composable
internal fun AppLockPage() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var enabled by remember { mutableStateOf(AppLock.isEnabled) }
    var changing by remember { mutableStateOf(false) }
    val biometry = AppLock.biometry
    val title = AppLock.title(context, biometry)
    val failure = AppLock.failure
    Column {
        ListSection(stringResource(R.string.lock_title)) {
            ListRow {
                StarlingsToggle(
                    stringResource(R.string.lock_require, title),
                    enabled,
                    { requested ->
                        val activity = context.activity() ?: return@StarlingsToggle
                        if (changing || requested == AppLock.isEnabled) return@StarlingsToggle
                        changing = true
                        scope.launch {
                            enabled = AppLock.setEnabled(activity, requested)
                            changing = false
                        }
                    },
                    enabled = !changing && biometry.isAvailable,
                )
                if (failure != null) {
                    val spoken = stringResource(R.string.lock_error, failure)
                    Text(failure, Modifier.semantics { contentDescription = spoken }, style = StarlingsType.footnote, color = Starlings.colors.danger)
                }
            }
        }
        ListFooter(
            if (biometry.isAvailable) {
                stringResource(R.string.lock_footer, title, AppLockRules.GRACE_SECONDS)
            } else {
                stringResource(R.string.lock_unavailable)
            },
        )
    }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}
