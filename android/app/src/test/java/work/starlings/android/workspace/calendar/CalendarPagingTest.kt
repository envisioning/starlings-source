package work.starlings.android.workspace.calendar

import org.junit.Assert.assertEquals
import org.junit.Test

/** `MobileCalendarPageMotion.finished` and `rubberBanded`, case by case. */
class CalendarPagingTest {
    private val width = 300f
    private val fling = 600f

    @Test
    fun aThirdOfAPageTurnsIt() {
        assertEquals(1, CalendarPaging.direction(-101f, 0f, width, fling))
        assertEquals(-1, CalendarPaging.direction(101f, 0f, width, fling))
        assertEquals(0, CalendarPaging.direction(-99f, 0f, width, fling))
    }

    @Test
    fun aThrowTurnsItFromAnywhere() {
        assertEquals(1, CalendarPaging.direction(-10f, -700f, width, fling))
        assertEquals(-1, CalendarPaging.direction(10f, 700f, width, fling))
        assertEquals(0, CalendarPaging.direction(10f, 500f, width, fling))
    }

    @Test
    fun pastAPageItResists() {
        assertEquals(200f, CalendarPaging.rubberBanded(200f, width))
        assertEquals(325f, CalendarPaging.rubberBanded(400f, width))
        assertEquals(-325f, CalendarPaging.rubberBanded(-400f, width))
    }
}
