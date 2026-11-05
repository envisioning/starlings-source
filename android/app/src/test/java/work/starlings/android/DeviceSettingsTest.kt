package work.starlings.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.ui.Motion
import work.starlings.android.workspace.team.MessageNotices
import java.io.File

/**
 * The device-local choices against the Swift that stores them: the same
 * keys, raw values and defaults, so one person's phone and tablet read
 * alike and the rule cannot drift from iOS.
 */
class DeviceSettingsTest {
    private val repo: File
        get() = File(System.getProperty("starlings.fixtures") ?: error("starlings.fixtures is not set")).parentFile

    private fun swift(path: String): String = File(repo, path).readText()

    @Test
    fun appearanceKeyAndDefaultAreSwifts() {
        val source = swift("Sources/StarlingsAppearance.swift")
        assertTrue(source.contains("static let key = \"${DeviceSettings.APPEARANCE_KEY}\""))
        assertTrue(source.contains("static let defaultMode: StarlingsAppearanceMode = .${AppearanceMode.DEFAULT.raw}"))
    }

    @Test
    fun homeTextureKeyAndDefaultAreSwifts() {
        val source = swift("Sources/HomeTexturePreferences.swift")
        assertTrue(source.contains("static let key = \"${DeviceSettings.HOME_TEXTURE_KEY}\""))
        assertTrue(source.contains("static let defaultValue = ${DeviceSettings.HOME_TEXTURE_DEFAULT}"))
    }

    @Test
    fun channelMessagesKeyAndDefaultAreSwifts() {
        val source = swift("Sources/MessageNotificationPreferences.swift")
        assertTrue(source.contains("static let key = \"${DeviceSettings.ALL_CHANNEL_MESSAGES_KEY}\""))
        assertTrue(source.contains("static let defaultValue = ${MessageNotices.NOTIFY_ON_ALL_CHANNEL_MESSAGES_DEFAULT}"))
    }

    @Test
    fun appearanceModes() {
        assertEquals(listOf("auto", "light", "dark"), AppearanceMode.entries.map { it.raw })
        assertEquals(AppearanceMode.LIGHT, AppearanceMode.of("light"))
        // An unknown or missing value is the default, as `StarlingsAppearanceSettings.mode`.
        assertEquals(AppearanceMode.DARK, AppearanceMode.of(null))
        assertEquals(AppearanceMode.DARK, AppearanceMode.of("sepia"))
        assertTrue(AppearanceMode.AUTO.dark(systemDark = true))
        assertFalse(AppearanceMode.AUTO.dark(systemDark = false))
        assertFalse(AppearanceMode.LIGHT.dark(systemDark = true))
        assertTrue(AppearanceMode.DARK.dark(systemDark = false))
    }

    @Test
    fun unattachedSettingsAreDefaults() {
        assertEquals(AppearanceMode.DARK, DeviceSettings.appearance.value)
        assertTrue(DeviceSettings.homeTexture.value)
        assertFalse(DeviceSettings.allChannelMessages.value)
    }

    @Test
    fun reduceMotionIsAnimatorScaleZero() {
        assertTrue(Motion.reduced(0f))
        assertFalse(Motion.reduced(0.5f))
        assertFalse(Motion.reduced(1f))
    }
}
