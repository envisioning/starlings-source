package work.starlings.android.lock

import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.ui.Haptic
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.withResumed
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.StarlingsTheme
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType

/**
 * The cover (`StarlingsLockScreen`): quiet, because the system prompt
 * carries the explanation; it only keeps Unlock in reach without showing
 * the app under it. It asks on arrival, so the common case is one look at
 * the phone and nothing to tap. Back leaves the app instead of the cover.
 */
class LockActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })
        setContent {
            StarlingsTheme { LockScreen(this) }
        }
    }

    @Suppress("DEPRECATION")
    override fun finish() {
        super.finish()
        overridePendingTransition(0, 0)
    }
}

@Composable
private fun LockScreen(activity: LockActivity) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val locked = AppLock.isLocked
    LaunchedEffect(locked) {
        if (!locked) {
            activity.finish()
        } else {
            // The prompt needs the cover in front.
            activity.lifecycle.withResumed { }
            AppLock.unlock(activity)
        }
    }
    // A biometric plays its own feedback on success; only a refusal needs one.
    val failure = AppLock.failure
    HapticWhenSet(Haptic.ERROR, failure)
    Box(Modifier.fillMaxSize().background(c.canvas), contentAlignment = Alignment.Center) {
        Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Icon(
                when (AppLock.biometry) {
                    AppLockRules.Biometry.FINGERPRINT, AppLockRules.Biometry.BIOMETRIC -> Icons.Filled.Fingerprint
                    AppLockRules.Biometry.FACE -> Icons.Filled.Face
                    else -> Icons.Filled.Lock
                },
                contentDescription = null,
                modifier = Modifier.size(30.dp),
                tint = c.secondary,
            )
            BorderedButton(
                stringResource(if (AppLock.isAuthenticating) R.string.lock_unlocking else R.string.lock_unlock),
                onClick = { scope.launch { AppLock.unlock(activity) } },
                modifier = Modifier.widthIn(min = 112.dp),
                enabled = !AppLock.isAuthenticating,
            )
            if (failure != null) {
                val spoken = stringResource(R.string.lock_unlock_error, failure)
                Text(
                    failure,
                    Modifier.widthIn(max = 280.dp).semantics { contentDescription = spoken },
                    style = StarlingsType.footnote,
                    color = c.danger,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}
