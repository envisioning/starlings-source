package work.starlings.android.ui

import androidx.compose.material3.windowsizeclass.WindowHeightSizeClass
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf

/**
 * iOS `horizontalSizeClass`, read from the Android window. Every iOS
 * adaptation tests only `.regular` against everything else, so two values
 * are enough.
 */
enum class HorizontalSizeClass { COMPACT, REGULAR }

object SizeClasses {
    /**
     * The mapping (docs/agents/areas/android.md, "Large screens"):
     *
     * - Regular: the window is Medium or Expanded wide (600 dp or more) and
     *   not Compact high (480 dp or more). That is a tablet in either
     *   orientation, an unfolded foldable, and a large free-form or split
     *   window: where iOS says `.regular` on an iPad.
     * - Compact: everything else. A phone in portrait is Compact wide. A
     *   phone in landscape is Medium wide but Compact high, so it stays
     *   compact, as iOS on every iPhone but the Plus and Max class. A narrow
     *   split or free-form window on a tablet is compact, as iPad Split View
     *   at its narrow sizes and Slide Over.
     */
    fun horizontal(window: WindowSizeClass): HorizontalSizeClass =
        horizontal(window.widthSizeClass, window.heightSizeClass)

    fun horizontal(width: WindowWidthSizeClass, height: WindowHeightSizeClass): HorizontalSizeClass =
        if (width != WindowWidthSizeClass.Compact && height != WindowHeightSizeClass.Compact) HorizontalSizeClass.REGULAR
        else HorizontalSizeClass.COMPACT
}

/** Provided by `MainActivity` from the activity's window; anything outside it reads compact, the phone layout. */
val LocalHorizontalSizeClass = compositionLocalOf { HorizontalSizeClass.COMPACT }

/** `horizontalSizeClass == .regular`. */
@Composable
fun isRegularWidth(): Boolean = LocalHorizontalSizeClass.current == HorizontalSizeClass.REGULAR
