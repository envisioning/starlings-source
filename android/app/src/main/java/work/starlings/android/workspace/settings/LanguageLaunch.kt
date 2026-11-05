package work.starlings.android.workspace.settings

import android.app.LocaleManager
import android.content.Context
import android.os.Build
import android.os.LocaleList
import kotlinx.coroutines.CancellationException
import work.starlings.android.OwnerAccount
import work.starlings.android.api.SettingsRoutes
import work.starlings.contracts.InterfaceLanguage

/**
 * The language saved on the Worker, applied once per launch, as
 * iOS `MobileLanguageStore.refresh` does on sign-in. Android keeps the
 * per-app locale across launches itself, so it is the local cache; the
 * Worker's answer replaces it only when they differ. Android 13 and later
 * (`LocaleManager`); a failed read keeps what the device has.
 */
object LanguageLaunch {
    private var done = false

    /** Whether the saved [remote] choice differs from the app's applied locale tags. A language this build does not draw stays out. */
    fun needsApply(appliedTags: String, remote: InterfaceLanguage?): Boolean =
        (remote == null || remote in InterfaceLanguage.known) && LanguageChoice.fromTags(appliedTags) != remote

    /**
     * Signing out drops the account's language, as iOS clears its cached
     * one: the app follows the system again, and the next sign-in reads the
     * saved choice afresh.
     */
    fun reset(context: Context) {
        done = false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val locales = context.getSystemService(LocaleManager::class.java) ?: return
        if (!locales.applicationLocales.isEmpty) locales.applicationLocales = LocaleList.getEmptyLocaleList()
    }

    suspend fun apply(context: Context, account: OwnerAccount) {
        if (done || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val remote = try {
            account.client.call(SettingsRoutes.language).language
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return
        }
        done = true
        val locales = context.getSystemService(LocaleManager::class.java) ?: return
        if (!needsApply(locales.applicationLocales.toLanguageTags(), remote)) return
        val tag = LanguageChoice.tag(remote)
        // Recreates the activity in the new language.
        locales.applicationLocales = if (tag.isEmpty()) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(tag)
    }
}
