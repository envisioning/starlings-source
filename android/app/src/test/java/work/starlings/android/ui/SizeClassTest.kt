package work.starlings.android.ui

import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowSizeClass
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

/** The iOS `horizontalSizeClass` mapping (`SizeClasses.horizontal`), on the windows Android draws in. */
@OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
class SizeClassTest {
    private fun of(width: Int, height: Int) = SizeClasses.horizontal(WindowSizeClass.calculateFromSize(DpSize(width.dp, height.dp)))

    @Test
    fun phonesAreCompactInBothOrientations() {
        assertEquals(HorizontalSizeClass.COMPACT, of(412, 915))
        assertEquals(HorizontalSizeClass.COMPACT, of(915, 412))
        assertEquals(HorizontalSizeClass.COMPACT, of(360, 640))
        assertEquals(HorizontalSizeClass.COMPACT, of(640, 360))
    }

    @Test
    fun tabletsAndUnfoldedFoldablesAreRegular() {
        assertEquals(HorizontalSizeClass.REGULAR, of(800, 1280))
        assertEquals(HorizontalSizeClass.REGULAR, of(1280, 800))
        assertEquals(HorizontalSizeClass.REGULAR, of(673, 841))
    }

    @Test
    fun narrowAndShortWindowsAreCompact() {
        // Half of a tablet in portrait split screen, and a short free-form window.
        assertEquals(HorizontalSizeClass.COMPACT, of(400, 1280))
        assertEquals(HorizontalSizeClass.COMPACT, of(900, 470))
    }

    @Test
    fun breakpointsAreMaterials() {
        assertEquals(HorizontalSizeClass.COMPACT, of(599, 900))
        assertEquals(HorizontalSizeClass.REGULAR, of(600, 900))
        assertEquals(HorizontalSizeClass.COMPACT, of(900, 479))
        assertEquals(HorizontalSizeClass.REGULAR, of(900, 480))
    }
}
