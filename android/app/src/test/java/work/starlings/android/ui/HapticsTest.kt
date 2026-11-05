package work.starlings.android.ui

import android.view.HapticFeedbackConstants
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `StarlingsHaptics`: seven names, one platform pattern each, and when a trigger plays. */
class HapticsTest {
    @Test
    fun sevenNamesAsIOS() {
        assertEquals(listOf("TAP", "TOGGLE", "DESTRUCTIVE", "STEP", "SUCCESS", "WARNING", "ERROR"), Haptic.entries.map { it.name })
    }

    @Test
    fun eachNameHasItsWeight() {
        assertEquals(HapticFeedbackConstants.KEYBOARD_TAP, Haptic.TAP.feedback)
        assertEquals(HapticFeedbackConstants.VIRTUAL_KEY, Haptic.TOGGLE.feedback)
        assertEquals(HapticFeedbackConstants.LONG_PRESS, Haptic.DESTRUCTIVE.feedback)
        assertEquals(HapticFeedbackConstants.CLOCK_TICK, Haptic.STEP.feedback)
        assertEquals(HapticFeedbackConstants.CONFIRM, Haptic.SUCCESS.feedback)
        assertEquals(HapticFeedbackConstants.REJECT, Haptic.ERROR.feedback)
        assertEquals("no warning pattern on Android", Haptic.ERROR.feedback, Haptic.WARNING.feedback)
    }

    @Test
    fun aTriggerPlaysOnAnyChange() {
        assertTrue(Haptic.onChange(3, 4))
        assertTrue(Haptic.onChange(4, 3))
        assertFalse(Haptic.onChange(4, 4))
    }

    @Test
    fun aNoticePlaysWhenItAppearsNotWhenItClears() {
        assertTrue(Haptic.whenSet(null, "Couldn’t save"))
        assertTrue("a new notice", Haptic.whenSet("Couldn’t save", "Couldn’t delete"))
        assertFalse("dismissed", Haptic.whenSet("Couldn’t save", null))
        assertFalse(Haptic.whenSet<String>(null, null))
        assertFalse(Haptic.whenSet("Couldn’t save", "Couldn’t save"))
    }

    @Test
    fun aPulseCountsEachFire() {
        val pulse = HapticPulse()
        pulse.fire(Haptic.SUCCESS)
        pulse.fire(Haptic.SUCCESS)
        assertEquals(2, pulse.count)
        assertEquals(Haptic.SUCCESS, pulse.kind)
    }
}
