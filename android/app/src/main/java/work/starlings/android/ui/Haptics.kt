package work.starlings.android.ui

import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.Stable
import androidx.compose.ui.platform.LocalView

/**
 * The one vocabulary for touch feedback (`iOS/StarlingsHaptics.swift`).
 * Every haptic in the app is one of these seven, so a light tap means the
 * same on a reaction as on a knock, and nothing picks its own weight. A
 * haptic says what happened, not what was pressed: [HapticOnChange] plays
 * when a value changes, [HapticWhenSet] when a notice appears, and a
 * [HapticPulse] for an outcome no value says on its own.
 *
 * Each plays through [View.performHapticFeedback], so the person's own
 * touch-feedback setting is honoured. Android has no warning pattern of
 * its own: warning and error share the reject one.
 */
enum class Haptic {
    /** Something small arrived or was sent: a reaction, a message, a knock. */
    TAP,
    /** A control changed state under the finger: mic, camera, hand, record. */
    TOGGLE,
    /** Something left or was taken away: a note deleted, a call ended, a proposal declined. */
    DESTRUCTIVE,
    /** One step of a drag snapping to its grid. */
    STEP,
    SUCCESS,
    WARNING,
    ERROR,
    ;

    /** The platform pattern: light, medium and rigid impacts, a tick, confirm and reject. */
    val feedback: Int
        get() = when (this) {
            TAP -> HapticFeedbackConstants.KEYBOARD_TAP
            TOGGLE -> HapticFeedbackConstants.VIRTUAL_KEY
            DESTRUCTIVE -> HapticFeedbackConstants.LONG_PRESS
            STEP -> HapticFeedbackConstants.CLOCK_TICK
            SUCCESS -> HapticFeedbackConstants.CONFIRM
            WARNING, ERROR -> HapticFeedbackConstants.REJECT
        }

    /** Fire now, outside the state model: for a sheet that closes in the same beat (`play(in:)`). */
    fun play(view: View) {
        view.performHapticFeedback(feedback)
    }

    companion object {
        /** `meetHaptic(_:trigger:)`: any change plays; the first value does not. */
        fun <T> onChange(old: T, new: T): Boolean = old != new

        /** `meetHaptic(_:whenSet:)`: a value appearing or changing plays; clearing stays quiet. */
        fun <T> whenSet(old: T?, new: T?): Boolean = new != null && old != new
    }
}

/**
 * `StarlingsHapticPulse`: a haptic fired from code, carried as state so
 * [HapticPulseEffect] plays it. For "the write landed" when no published
 * value says so.
 */
@Stable
class HapticPulse {
    var count by mutableStateOf(0); private set
    var kind by mutableStateOf<Haptic?>(null); private set

    fun fire(kind: Haptic) {
        this.kind = kind
        count += 1
    }
}

@Composable
fun rememberHapticPulse(): HapticPulse = remember { HapticPulse() }

/**
 * `meetHaptics(_:)`: plays whatever [pulse] last fired. Like
 * `sensoryFeedback(trigger:)`, only a fire while this is on screen plays:
 * a pulse that outlives the screen (a store's) is quiet when it returns.
 */
@Composable
fun HapticPulseEffect(pulse: HapticPulse) {
    val view = LocalView.current
    val count = pulse.count
    val last = remember(pulse) { intArrayOf(count) }
    LaunchedEffect(count) {
        if (count != last[0]) pulse.kind?.play(view)
        last[0] = count
    }
}

/** `meetHaptic(trigger:_:)`: plays what [choose] picks for a change of [trigger], or nothing. The first value is quiet. */
@Composable
fun <T> HapticOnChange(trigger: T, choose: (old: T, new: T) -> Haptic?) {
    val view = LocalView.current
    val last = remember { arrayOf<Any?>(trigger) }
    LaunchedEffect(trigger) {
        @Suppress("UNCHECKED_CAST")
        val old = last[0] as T
        last[0] = trigger
        if (Haptic.onChange(old, trigger)) choose(old, trigger)?.play(view)
    }
}

/** `meetHaptic(_:trigger:)`: [kind] every time [trigger] changes. */
@Composable
fun <T> HapticOnChange(kind: Haptic, trigger: T) = HapticOnChange(trigger) { _, _ -> kind }

/** `meetHaptic(_:whenSet:)`: [kind] when [trigger] appears or changes; dismissing it is quiet. */
@Composable
fun <T> HapticWhenSet(kind: Haptic, trigger: T?) {
    val view = LocalView.current
    val last = remember { arrayOf<Any?>(trigger) }
    LaunchedEffect(trigger) {
        @Suppress("UNCHECKED_CAST")
        val old = last[0] as T?
        last[0] = trigger
        if (Haptic.whenSet(old, trigger)) kind.play(view)
    }
}
