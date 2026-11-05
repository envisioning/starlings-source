package work.starlings.android.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowCircleDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import work.starlings.android.R
import work.starlings.android.UpdateRecommendation
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType

/**
 * The newer-version banner over the tabs, as the iOS workspace's top inset
 * (`StarlingsIOSApp.workspace`): the arrow, "A newer version of Starlings is
 * available", Update when the Worker named a link, and Dismiss for 24 hours.
 */
@Composable
fun UpdateBanner(upgrade: UpdateRecommendation) {
    val visible by upgrade.visible.collectAsStateWithLifecycle()
    val link by upgrade.updateUrl.collectAsStateWithLifecycle()
    val until by upgrade.dismissedUntil.collectAsStateWithLifecycle()
    // A dismissal ends after 24 hours; the banner comes back while the Worker still recommends.
    LaunchedEffect(until) {
        val end = until ?: return@LaunchedEffect
        delay((end - System.currentTimeMillis()).coerceAtLeast(0))
        upgrade.refresh()
    }
    if (!visible) return
    val c = Starlings.colors
    val uri = LocalUriHandler.current
    Row(
        Modifier.fillMaxWidth().background(c.panel).padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Filled.ArrowCircleDown, null, Modifier.size(20.dp), tint = c.primary)
        Text(
            stringResource(R.string.update_banner_message),
            style = StarlingsType.callout,
            color = c.primary,
            modifier = Modifier.weight(1f).padding(vertical = 8.dp),
        )
        link?.let { url ->
            TextButton({ runCatching { uri.openUri(url) } }) {
                Text(stringResource(R.string.update_banner_action), color = c.primary)
            }
        }
        IconButton(upgrade::dismiss) {
            Icon(Icons.Filled.Close, stringResource(R.string.dismiss), Modifier.size(18.dp), tint = c.secondary)
        }
    }
}
