package work.starlings.android

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * `StarlingsAppearanceMode` (EnvisioningUI `EnvisioningAppearanceMode`):
 * Auto follows the device, Light and Dark hold. [raw] is the stored value,
 * the same raw values iOS stores under the same key.
 */
enum class AppearanceMode(val raw: String) {
    AUTO("auto"), LIGHT("light"), DARK("dark");

    /** Whether the app draws dark, given the device's own appearance. */
    fun dark(systemDark: Boolean): Boolean = when (this) {
        AUTO -> systemDark
        LIGHT -> false
        DARK -> true
    }

    companion object {
        /**
         * `StarlingsAppearanceSettings.defaultMode`: Starlings is a dark
         * product with a light mode, so a new install opens dark.
         */
        val DEFAULT = DARK

        fun of(raw: String?): AppearanceMode = entries.firstOrNull { it.raw == raw } ?: DEFAULT
    }
}

/**
 * The choices iOS keeps per device in `@AppStorage`, under the same keys:
 * the appearance (`StarlingsAppearanceSettings`), the Home grid
 * (`HomeTexturePreferences`) and every channel message
 * (`MessageNotificationPreferences`). Nothing here is synced: iOS says
 * "This phone only." under the first two.
 *
 * One process-wide copy, loaded by [attach] from `StarlingsApp.onCreate`.
 * Until then (a JVM test) each value is its default.
 */
object DeviceSettings {
    const val PREFS = "device_settings"
    const val APPEARANCE_KEY = "meet.appearance.mode"
    const val HOME_TEXTURE_KEY = "meet.home.showsTexture"
    const val ALL_CHANNEL_MESSAGES_KEY = "meet.notifications.allChannelMessages"

    /** `HomeTexturePreferences.defaultValue`: on. */
    const val HOME_TEXTURE_DEFAULT = true

    private var prefs: SharedPreferences? = null
    private val _appearance = MutableStateFlow(AppearanceMode.DEFAULT)
    private val _homeTexture = MutableStateFlow(HOME_TEXTURE_DEFAULT)
    private val _allChannelMessages = MutableStateFlow(work.starlings.android.workspace.team.MessageNotices.NOTIFY_ON_ALL_CHANNEL_MESSAGES_DEFAULT)

    val appearance: StateFlow<AppearanceMode> = _appearance.asStateFlow()
    val homeTexture: StateFlow<Boolean> = _homeTexture.asStateFlow()
    val allChannelMessages: StateFlow<Boolean> = _allChannelMessages.asStateFlow()

    fun attach(context: Context) {
        val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        _appearance.value = AppearanceMode.of(p.getString(APPEARANCE_KEY, null))
        _homeTexture.value = p.getBoolean(HOME_TEXTURE_KEY, HOME_TEXTURE_DEFAULT)
        _allChannelMessages.value = p.getBoolean(ALL_CHANNEL_MESSAGES_KEY, _allChannelMessages.value)
    }

    fun setAppearance(mode: AppearanceMode) {
        _appearance.value = mode
        prefs?.edit()?.putString(APPEARANCE_KEY, mode.raw)?.apply()
    }

    fun setHomeTexture(on: Boolean) {
        _homeTexture.value = on
        prefs?.edit()?.putBoolean(HOME_TEXTURE_KEY, on)?.apply()
    }

    fun setAllChannelMessages(on: Boolean) {
        _allChannelMessages.value = on
        prefs?.edit()?.putBoolean(ALL_CHANNEL_MESSAGES_KEY, on)?.apply()
    }
}
