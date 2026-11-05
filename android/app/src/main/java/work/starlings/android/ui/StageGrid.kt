package work.starlings.android.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import work.starlings.android.DeviceSettings
import kotlin.math.ceil
import kotlin.math.hypot

/**
 * `HomeGridLattice` (Sources/HomeGridLattice.swift): the brand lattice behind
 * Home and the meeting stage. Pitch, alpha range, seed, fades and the reveal
 * time are the Swift values, so the stage looks the same on every client.
 * Lengths are dp, as Swift's are points.
 */
object HomeGridLattice {
    const val PITCH = 32f
    const val MULTIPLIER_MIN = 0.7f
    const val MULTIPLIER_MAX = 1.0f
    const val DARK_BASE_ALPHA = 0.09f
    const val LIGHT_BASE_ALPHA = 0.10f
    const val VERTICAL_FADE = 0.10f
    const val HORIZONTAL_FADE = 0.08f
    const val BAKED_LINES = 80
    const val SEED = 0x5EED1
    const val REVEAL_MS = 600

    /** Signed line indices covering `span`, 0 the centre line, one extra each side. */
    fun indices(span: Float): IntRange {
        if (span <= 0f) return 0..0
        val reach = ceil(span / 2 / PITCH).toInt() + 1
        return -reach..reach
    }

    /** Anchored to the centre, so a resize never re-flows the lattice. */
    fun position(index: Int, span: Float) = span / 2 + index * PITCH

    fun alpha(multipliers: List<Float>, index: Int, base: Float): Float =
        (multipliers.getOrNull(index + BAKED_LINES / 2) ?: 1f) * base

    /** Columns then rows, off one LCG in the order Swift bakes them (`HomeGridNoise`). */
    val multipliers: Pair<List<Float>, List<Float>> by lazy {
        // UInt32 arithmetic: Int wraps the same way, and `ushr` reads it unsigned.
        var state = SEED
        fun next(): Double {
            state = state * 1103515245 + 12345
            return (state ushr 16) / 65536.0
        }
        fun bake() = List(BAKED_LINES) { (MULTIPLIER_MIN + next() * (MULTIPLIER_MAX - MULTIPLIER_MIN)).toFloat() }
        val columns = bake()
        columns to bake()
    }
}

/**
 * `MobileHomeGridBackground(meetingMode: true)`: neutral hairlines in the
 * secondary ink behind the meeting stage.
 */
@Composable
fun StageGridBackground(modifier: Modifier = Modifier) = HomeGridBackground(modifier, meetingMode = true)

/**
 * `MobileHomeGridBackground`: the lattice behind Home (and, with
 * [meetingMode], the stage), faded on all four sides, resolving outward
 * from the centre when the surface appears. Home draws the accent at low
 * alpha in dark and the primary ink in light; the stage stays neutral.
 * Nothing draws when Settings › Appearance › Grid texture is off, and
 * Reduce Motion ([rememberReduceMotion]) shows the field at once.
 */
@Composable
fun HomeGridBackground(modifier: Modifier = Modifier, meetingMode: Boolean = false) {
    val shows by DeviceSettings.homeTexture.collectAsState()
    if (!shows) return
    val c = Starlings.colors
    val reduceMotion = rememberReduceMotion()
    val reveal = remember { Animatable(if (reduceMotion) 1f else 0.02f) }
    LaunchedEffect(Unit) { if (!reduceMotion) reveal.animateTo(1f, tween(HomeGridLattice.REVEAL_MS, easing = FastOutSlowInEasing)) }
    val base = if (c.dark) HomeGridLattice.DARK_BASE_ALPHA else HomeGridLattice.LIGHT_BASE_ALPHA
    val ink = when {
        meetingMode -> c.secondary
        c.dark -> c.accent
        else -> c.primary
    }
    val (columns, rows) = HomeGridLattice.multipliers
    Canvas(
        modifier
            .clearAndSetSemantics { }
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen },
    ) {
        val w = size.width / density
        val h = size.height / density
        for (i in HomeGridLattice.indices(w)) {
            val x = HomeGridLattice.position(i, w) * density
            drawLine(ink.copy(alpha = HomeGridLattice.alpha(columns, i, base)), Offset(x, 0f), Offset(x, size.height), 1f)
        }
        for (i in HomeGridLattice.indices(h)) {
            val y = HomeGridLattice.position(i, h) * density
            drawLine(ink.copy(alpha = HomeGridLattice.alpha(rows, i, base)), Offset(0f, y), Offset(size.width, y), 1f)
        }
        // The fades and the reveal are masks: DstIn keeps the lines where the mask is opaque.
        val vf = HomeGridLattice.VERTICAL_FADE
        val hf = HomeGridLattice.HORIZONTAL_FADE
        drawRect(
            Brush.verticalGradient(0f to Color.Transparent, vf to Color.Black, 1 - vf to Color.Black, 1f to Color.Transparent),
            blendMode = BlendMode.DstIn,
        )
        drawRect(
            Brush.horizontalGradient(0f to Color.Transparent, hf to Color.Black, 1 - hf to Color.Black, 1f to Color.Transparent),
            blendMode = BlendMode.DstIn,
        )
        if (reveal.value < 1f) {
            val radius = (hypot(size.width, size.height) * 0.6f * reveal.value).coerceAtLeast(1f)
            drawRect(
                Brush.radialGradient(0.85f to Color.Black, 1f to Color.Transparent, center = center, radius = radius),
                blendMode = BlendMode.DstIn,
            )
        }
    }
}
