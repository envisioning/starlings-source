package work.starlings.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** `StarlingsToastCenter`: one toast at a time, its duration, and the host ladder. */
class ToastTest {
    @Test
    fun aLineIsTrimmedAndAnEmptyOneSaysNothing() {
        val center = StarlingsToastCenter()
        center.show("  Link copied \n")
        assertEquals("Link copied", center.current.value?.text)
        val first = center.current.value
        center.show("   ")
        assertEquals(first, center.current.value)
    }

    @Test
    fun aSecondToastReplacesTheFirst() {
        val center = StarlingsToastCenter()
        center.show("Saved")
        val first = center.current.value!!
        center.show("Saved")
        val second = center.current.value!!
        // The same words twice are two toasts.
        assertNotEquals(first, second)
        center.dismiss(first)
        assertEquals(second, center.current.value)
        center.dismiss(second)
        assertNull(center.current.value)
    }

    @Test
    fun durationsFollowTheTone() {
        val center = StarlingsToastCenter()
        center.show("Saved")
        assertEquals(3_000L, StarlingsToastCenter.duration(center.current.value!!))
        center.show("Sent to Vocab", action = StarlingsToastCenter.Action("Open") {})
        assertEquals(6_000L, StarlingsToastCenter.duration(center.current.value!!))
        center.show("Couldn't save", ToastTone.DANGER, StarlingsToastCenter.Action("Open") {})
        assertEquals(8_000L, StarlingsToastCenter.duration(center.current.value!!))
    }

    @Test
    fun theDeepestHostPresents() {
        val center = StarlingsToastCenter()
        assertNull(center.topHostDepth)
        center.registerHost(TOAST_DEPTH_ROOT)
        assertEquals(TOAST_DEPTH_ROOT, center.topHostDepth)
        center.registerHost(TOAST_DEPTH_SHELL)
        center.registerHost(TOAST_DEPTH_SHELL)
        assertEquals(TOAST_DEPTH_SHELL, center.topHostDepth)
        center.unregisterHost(TOAST_DEPTH_SHELL)
        assertEquals(TOAST_DEPTH_SHELL, center.topHostDepth)
        center.unregisterHost(TOAST_DEPTH_SHELL)
        assertEquals(TOAST_DEPTH_ROOT, center.topHostDepth)
        center.unregisterHost(TOAST_DEPTH_SHELL)
        assertEquals(TOAST_DEPTH_ROOT, center.topHostDepth)
    }
}
