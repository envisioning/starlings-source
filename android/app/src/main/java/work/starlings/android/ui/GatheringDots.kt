package work.starlings.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min

/**
 * The flock: the Starlings mark's 4 × 4 dots and how they move, from
 * `packages/contracts/src/gathering-dots.ts`. `GatheringDotsTest` holds the
 * dots and the motion to `fixtures/gathering-dots.json`. It is the only
 * animated loader (docs/DESIGN.md, "Waiting"); each motion is one meaning.
 */
object GatheringDots {
    const val VIEW_BOX = 28.0

    data class Dot(val x: Double, val y: Double, val radius: Double, val phase: Double, val driftPhase: Double, val driftFactor: Double)

    enum class Motion(val sweepSeconds: Double?) {
        STILL(null),
        /** The brand at rest, or nothing to show: camera off at prejoin. */
        DRIFT(null),
        /** Connecting, or waiting at the door. */
        MURMURATION(12.0),
        THINKING(4.8),
        /** A short wait on a control. */
        BUSY(1.4),
    }

    const val DRIFT_SECONDS = 4.2
    const val DRIFT_LOW = 0.0
    const val DRIFT_HIGH = 1.14

    val dots: List<Dot> = listOf(
        Dot(4.4, 4.4, 1.87, 0.0, 0.183, 0.716),
        Dot(10.8, 4.4, 2.18, 0.13, 0.74, 0.744),
        Dot(17.2, 4.4, 2.5, 0.26, 0.564, 0.919),
        Dot(23.6, 4.4, 2.5, 0.39, 0.455, 0.901),
        Dot(4.4, 10.8, 1.55, 0.245, 0.272, 1.264),
        Dot(10.8, 10.8, 2.18, 0.375, 0.823, 1.023),
        Dot(17.2, 10.8, 2.5, 0.505, 0.753, 1.041),
        Dot(23.6, 10.8, 2.18, 0.635, 0.504, 1.04),
        Dot(4.4, 17.2, 1.55, 0.394, 0.523, 1.045),
        Dot(10.8, 17.2, 1.87, 0.524, 0.522, 1.041),
        Dot(17.2, 17.2, 2.18, 0.654, 0.02, 0.927),
        Dot(23.6, 17.2, 1.87, 0.784, 0.592, 1.25),
        Dot(4.4, 23.6, 1.55, 0.475, 0.611, 1.187),
        Dot(10.8, 23.6, 1.55, 0.605, 0.401, 0.819),
        Dot(17.2, 23.6, 1.87, 0.735, 0.849, 1.149),
        Dot(23.6, 23.6, 1.55, 0.865, 0.341, 1.099),
    )

    private val resting = dots.map { it.radius }.distinct().sorted()

    /** A dot's radius at `seconds`, in the 28-unit square; null time is the rest. */
    fun radius(dot: Dot, motion: Motion, seconds: Double?): Double {
        if (seconds == null) return dot.radius
        motion.sweepSeconds?.let { return sweep(dot, seconds, it) }
        if (motion != Motion.DRIFT) return dot.radius
        val period = DRIFT_SECONDS * dot.driftFactor
        val progress = (seconds / period + dot.driftPhase) % 1.0
        val eased = 0.5 - 0.5 * cos(2 * PI * progress)
        return dot.radius * (DRIFT_LOW + (DRIFT_HIGH - DRIFT_LOW) * eased)
    }

    /** `GatheringDotsRegistry.sweepRadius` in Sources/StarlingsGlyph.swift. */
    private fun sweep(dot: Dot, seconds: Double, period: Double): Double {
        val r = resting
        val stops = listOf(0.0 to r[0], 0.24 to r[1], 0.49 to r[3], 0.74 to r[2], 1.0 to r[0])
        val progress = (seconds / period + dot.phase) % 1.0
        val next = stops.indexOfFirst { it.first >= progress }
        if (next <= 0) return r[0]
        val (fromAt, fromR) = stops[next - 1]
        val (toAt, toR) = stops[next]
        val local = (progress - fromAt) / (toAt - fromAt)
        val eased = 0.5 - 0.5 * cos(PI * local)
        return fromR + (toR - fromR) * eased
    }
}

/**
 * `GatheringDotsView`: the flock at `side`, in `ink`. With `label` it is the
 * wait TalkBack names; without one it is decoration. Animator duration scale
 * at 0 (the system's Remove animations, ui/Motion.kt) stops it at rest, as
 * Reduce Motion does on iOS.
 */
@Composable
fun GatheringDotsView(
    side: Dp,
    ink: Color,
    motion: GatheringDots.Motion = GatheringDots.Motion.DRIFT,
    label: String? = null,
    modifier: Modifier = Modifier,
) {
    val reduceMotion = rememberReduceMotion()
    val still = motion == GatheringDots.Motion.STILL || reduceMotion
    var millis by remember { mutableLongStateOf(0L) }
    if (!still) {
        LaunchedEffect(motion) {
            while (true) withFrameMillis { millis = it }
        }
    }
    val semantics = if (label != null) Modifier.semantics { contentDescription = label } else Modifier.clearAndSetSemantics { }
    Canvas(modifier.size(side).then(semantics)) {
        val scale = min(size.width, size.height) / GatheringDots.VIEW_BOX.toFloat()
        val seconds = if (still) null else millis / 1000.0
        GatheringDots.dots.forEach { dot ->
            val r = GatheringDots.radius(dot, motion, seconds).toFloat() * scale
            if (r > 0f) drawCircle(ink, r, Offset(dot.x.toFloat() * scale, dot.y.toFloat() * scale))
        }
    }
}
