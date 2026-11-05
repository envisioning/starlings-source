package work.starlings.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** [UpdateRecommendation] held to iOS `StarlingsUpgradeRecommendation`. */
class UpdateRecommendationTest {
    private class MapPrefs : WorkspacePrefs {
        val values = mutableMapOf<String, String>()
        override fun get(key: String) = values[key]
        override fun set(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    private var clock = 1_800_000_000_000L
    private val prefs = MapPrefs()
    private fun store() = UpdateRecommendation(prefs) { clock }

    @Test
    fun aRecommendationShowsTheBannerWithItsLink() {
        val upgrade = store()
        assertFalse(upgrade.visible.value)
        upgrade.receive(true, "https://starlings.example/android")
        assertTrue(upgrade.visible.value)
        assertEquals("https://starlings.example/android", upgrade.updateUrl.value)
    }

    @Test
    fun anAnswerWithoutItClearsTheBannerAndTheLink() {
        val upgrade = store()
        upgrade.receive(true, "https://starlings.example/android")
        upgrade.receive(false, null)
        assertFalse(upgrade.visible.value)
        assertNull(upgrade.updateUrl.value)
    }

    @Test
    fun noLinkStillShowsTheBanner() {
        val upgrade = store()
        upgrade.receive(true, null)
        assertTrue(upgrade.visible.value)
        assertNull(upgrade.updateUrl.value)
    }

    @Test
    fun onlyAnHttpsLinkWithAHostAndNoUserIsKept() {
        assertEquals("https://starlings.example/android", UpdateRecommendation.validUpdateUrl(" https://starlings.example/android "))
        assertNull(UpdateRecommendation.validUpdateUrl(""))
        assertNull(UpdateRecommendation.validUpdateUrl("http://starlings.example/android"))
        assertNull(UpdateRecommendation.validUpdateUrl("javascript:alert(1)"))
        assertNull(UpdateRecommendation.validUpdateUrl("https://user:pass@starlings.example/a"))
        assertNull(UpdateRecommendation.validUpdateUrl("https://"))
        val upgrade = store()
        upgrade.receive(true, "http://starlings.example/android")
        assertTrue(upgrade.visible.value)
        assertNull(upgrade.updateUrl.value)
    }

    @Test
    fun dismissHidesItFor24Hours() {
        val upgrade = store()
        upgrade.receive(true, null)
        upgrade.dismiss()
        assertFalse(upgrade.visible.value)
        assertEquals(clock + UpdateRecommendation.DISMISSAL_MS, upgrade.dismissedUntil.value)
        // A fresh recommendation inside the 24 hours stays hidden.
        clock += UpdateRecommendation.DISMISSAL_MS - 1
        upgrade.receive(true, null)
        assertFalse(upgrade.visible.value)
        clock += 1
        upgrade.refresh()
        assertTrue(upgrade.visible.value)
        assertNull(upgrade.dismissedUntil.value)
    }

    @Test
    fun theRowsOutliveTheProcess() {
        store().apply { receive(true, "https://starlings.example/android"); dismiss() }
        val again = store()
        assertFalse(again.visible.value)
        assertEquals("https://starlings.example/android", again.updateUrl.value)
        clock += UpdateRecommendation.DISMISSAL_MS
        assertTrue(store().visible.value)
    }

    @Test
    fun shouldShowIsTheIOSRule() {
        assertFalse(UpdateRecommendation.shouldShow(false, null, clock))
        assertTrue(UpdateRecommendation.shouldShow(true, null, clock))
        assertFalse(UpdateRecommendation.shouldShow(true, clock + 1, clock))
        assertTrue(UpdateRecommendation.shouldShow(true, clock, clock))
    }

    @Test
    fun theHeadersAreReadLowercase() {
        assertEquals(true to "https://x.example/a", UpdateRecommendation.read(mapOf("x-meet-upgrade" to "recommended", "x-meet-update-url" to "https://x.example/a")))
        assertEquals(false to null, UpdateRecommendation.read(emptyMap()))
        assertEquals(false to null, UpdateRecommendation.read(mapOf("x-meet-upgrade" to "required")))
    }

    @Test
    fun isBelowComparesDottedIntegers() {
        assertTrue(UpdateRecommendation.isBelow("0.2.0", "0.1.9"))
        assertTrue(UpdateRecommendation.isBelow("1.0", "0.9.9"))
        assertFalse(UpdateRecommendation.isBelow("0.2.0", "0.2.0"))
        assertFalse(UpdateRecommendation.isBelow("0.2.0", "0.10.0"))
        assertFalse(UpdateRecommendation.isBelow(null, "0.0.1"))
        assertFalse(UpdateRecommendation.isBelow("soon", "0.0.1"))
        assertFalse(UpdateRecommendation.isBelow("1.0.0", "0.0.1-a0"))
    }
}
