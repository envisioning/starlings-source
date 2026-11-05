package work.starlings.android.workspace.calendar

import kotlin.math.abs

/**
 * `MobileCalendarPageMotion`'s physics, as numbers: where a drag leaves the
 * strip and which way a release turns the page. Widths and travel are in
 * one unit (pixels), velocity in that unit per second.
 */
object CalendarPaging {
    /** Past a third of a page, or a throw this fast (600 points a second on iOS), the period moves. */
    const val FLING_DP_PER_SECOND = 600f

    /** 1 is the next period (dragged left), -1 the previous, 0 back to where it was. */
    fun direction(translation: Float, velocity: Float, width: Float, fling: Float): Int = when {
        translation < -width / 3 || velocity < -fling -> 1
        translation > width / 3 || velocity > fling -> -1
        else -> 0
    }

    /** Past a whole page either way there is nothing more built, so the strip resists rather than tears. */
    fun rubberBanded(translation: Float, width: Float): Float {
        if (abs(translation) <= width) return translation
        val overshoot = abs(translation) - width
        return (if (translation < 0) -1 else 1) * (width + overshoot * 0.25f)
    }
}
