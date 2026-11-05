package work.starlings.android.ui

import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * iOS `accessibilityReduceMotion` on Android. Android has no switch of that
 * name: Settings › Accessibility › Remove animations sets the animator
 * duration scale to 0, and that is the one signal read here. Every place iOS
 * honours Reduce Motion reads [rememberReduceMotion]: the Home and stage grid
 * reveal, the flying reactions, the gathering dots, and the toast (ui/Toast.kt),
 * which fades in place instead of rising.
 */
object Motion {
    /** The system's animator duration scale; 1 when the setting cannot be read. */
    fun animatorScale(context: Context): Float =
        runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }.getOrDefault(1f)

    /** Remove animations is on: the scale is 0. */
    fun reduced(scale: Float): Boolean = scale == 0f

    fun reduced(context: Context): Boolean = reduced(animatorScale(context))
}

/** Read once per composition entry, as iOS reads the environment value when a view appears. */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) { Motion.reduced(context) }
}
