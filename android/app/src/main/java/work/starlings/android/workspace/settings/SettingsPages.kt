package work.starlings.android.workspace.settings

import work.starlings.contracts.InterfaceLanguage
import work.starlings.contracts.NativeClient
import work.starlings.contracts.OwnerDeviceSummary
import work.starlings.contracts.OwnerDeviceSummaryPlatform

/**
 * The Settings index on Android: the iOS pages (`fixtures/settings-pages.json`,
 * `clients` holds `ios`) this app draws, in the shared table's order and under
 * its groups, as `StarlingsSettingsRegistry.groups(for: .iosSettings)`.
 * Captions is the iOS speech model and transcription languages: Android
 * receives captions and transcribes nothing, so it has no page. Development
 * Server is a debug page of the iOS build.
 */
object SettingsPages {
    enum class Group(val id: String) { ACCOUNT("account"), PREFERENCES("preferences"), SECURITY("security"), SYSTEM("system") }

    /** Declared in the fixture's page order. */
    enum class Page(val id: String, val group: Group) {
        ACCOUNT("account", Group.ACCOUNT),
        HOME("home", Group.PREFERENCES),
        WORK("work", Group.PREFERENCES),
        CALENDAR("calendar", Group.PREFERENCES),
        ROOM("room", Group.PREFERENCES),
        NOTIFICATIONS("notifications", Group.PREFERENCES),
        CALLS("calls", Group.PREFERENCES),
        APPEARANCE("appearance", Group.PREFERENCES),
        APP_LOCK("appLock", Group.SECURITY),
        ABOUT("about", Group.SYSTEM),
    }

    /**
     * The groups with at least one page, in order. Appearance holds only the
     * language here, so it is left out where Android has no per-app language
     * (before Android 13).
     */
    fun groups(languageAvailable: Boolean): List<Pair<Group, List<Page>>> {
        val pages = Page.entries.filter { it != Page.APPEARANCE || languageAvailable }
        return Group.entries.mapNotNull { group -> pages.filter { it.group == group }.takeIf { it.isNotEmpty() }?.let { group to it } }
    }

    fun page(id: String?): Page? = Page.entries.firstOrNull { it.id == id }
}

/** What a Devices row says about a device, as `Sources/OwnerDevices.swift`. */
object DeviceRows {
    enum class Kind { ANDROID, IPHONE, MAC }

    /** An Android row arrives as `client: ios`; its `platform` says what it is. */
    fun kind(device: OwnerDeviceSummary): Kind = when {
        device.platform == OwnerDeviceSummaryPlatform.ANDROID || device.client == NativeClient.ANDROID -> Kind.ANDROID
        device.client == NativeClient.IOS -> Kind.IPHONE
        else -> Kind.MAC
    }

    /** The device's own name, or null when it has not renewed since names existed. */
    fun label(device: OwnerDeviceSummary): String? = device.label?.takeIf { it.isNotEmpty() }

    /** The renewal, never in the future: clock skew never says "in 3 minutes". */
    fun renewedMs(device: OwnerDeviceSummary, nowMs: Long): Long = minOf(device.renewedAt, nowMs)
}

/**
 * The interface language choice (`StarlingsLanguageChoice`): System, then the
 * contract's languages. Android draws it through the per-app locale, so the
 * locale tag is the bridge both ways.
 */
object LanguageChoice {
    val offered: List<InterfaceLanguage?> = listOf(null) + InterfaceLanguage.known

    /** The tag `LocaleList.forLanguageTags` takes; empty follows the device. */
    fun tag(language: InterfaceLanguage?): String = language?.value.orEmpty()

    /** The app's applied locales (`LocaleList.toLanguageTags()`) as a choice; anything else is System. */
    fun fromTags(tags: String): InterfaceLanguage? {
        val first = tags.split(',').firstOrNull()?.trim()?.lowercase().orEmpty()
        return when {
            first.isEmpty() -> null
            first == "pt" || first.startsWith("pt-") -> InterfaceLanguage.PT_BR
            first == "en" || first.startsWith("en-") -> InterfaceLanguage.EN
            else -> null
        }
    }
}
