package work.starlings.android.lock

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** [AppLockRules], as `iOS/MobileAppLock.swift` behaves. */
class AppLockRulesTest {
    @Test
    fun aShortTripOutIsNotANewVisit() {
        assertFalse(AppLockRules.locksOnReturn(true, 1_000, 1_000 + AppLockRules.GRACE_MS - 1))
        assertTrue(AppLockRules.locksOnReturn(true, 1_000, 1_000 + AppLockRules.GRACE_MS))
        assertFalse(AppLockRules.locksOnReturn(false, 1_000, 1_000_000))
        // Never backgrounded: nothing to measure.
        assertFalse(AppLockRules.locksOnReturn(true, null, 1_000_000))
        assertEquals(15, AppLockRules.GRACE_SECONDS)
        assertEquals("meet.appLock.enabled", AppLockRules.ENABLED_KEY)
    }

    @Test
    fun theDeviceSaysWhatItCanAskFor() {
        assertEquals(AppLockRules.Biometry.UNAVAILABLE, AppLockRules.biometry(false, true, true, false))
        assertEquals(AppLockRules.Biometry.SCREEN_LOCK, AppLockRules.biometry(true, false, true, true))
        assertEquals(AppLockRules.Biometry.FINGERPRINT, AppLockRules.biometry(true, true, true, false))
        assertEquals(AppLockRules.Biometry.FACE, AppLockRules.biometry(true, true, false, true))
        assertEquals(AppLockRules.Biometry.BIOMETRIC, AppLockRules.biometry(true, true, true, true))
        assertFalse(AppLockRules.Biometry.UNAVAILABLE.isAvailable)
        assertTrue(AppLockRules.Biometry.SCREEN_LOCK.isAvailable)
    }

    @Test
    fun aDismissedPromptSaysNothing() {
        listOf(AppLockRules.ERROR_CANCELED, AppLockRules.ERROR_USER_CANCELED, AppLockRules.ERROR_NEGATIVE_BUTTON).forEach {
            assertEquals(AppLockRules.Outcome.Cancelled, AppLockRules.outcome(it, "x"))
        }
        assertEquals(AppLockRules.Outcome.Failed("Too many attempts"), AppLockRules.outcome(7, "Too many attempts"))
    }
}
