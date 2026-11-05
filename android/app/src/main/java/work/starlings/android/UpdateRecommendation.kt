package work.starlings.android

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The Worker's advisory update answer for the shell's banner, as iOS
 * `StarlingsUpgradeRecommendation` (Sources/StarlingsUpgradeRecommendation.swift).
 *
 * - Every answer to a request that sent `x-meet-client` says whether this
 *   build is below the workspace's `MIN_RECOMMENDED_VERSION_ANDROID`:
 *   `x-meet-upgrade: recommended`, with `x-meet-update-url` when the Worker
 *   names a link. An answer without it clears the banner ([receive]).
 * - Dismiss hides the banner for [DISMISSAL_MS] (24 hours), then it comes
 *   back while the Worker still recommends.
 * - The update link is kept only when it is `https`, with a host and no
 *   user info. No link: the banner shows without Update.
 *
 * It keeps its rows in [prefs] (the `update` preferences); no secret.
 */
class UpdateRecommendation(
    private val prefs: WorkspacePrefs,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _visible = MutableStateFlow(false)
    /** True while the banner shows. */
    val visible: StateFlow<Boolean> = _visible.asStateFlow()

    private val _updateUrl = MutableStateFlow(validUpdateUrl(prefs.get(URL_KEY)))
    /** Where Update goes, or null when the Worker named no link. */
    val updateUrl: StateFlow<String?> = _updateUrl.asStateFlow()

    private val _dismissedUntil = MutableStateFlow<Long?>(null)
    /** When a dismissal ends, epoch ms, or null. The shell waits for it, then calls [refresh]. */
    val dismissedUntil: StateFlow<Long?> = _dismissedUntil.asStateFlow()

    init {
        refresh()
    }

    /**
     * One native answer. Without the recommendation, this version is
     * supported now or the Worker has no floor set.
     */
    fun receive(recommended: Boolean, updateUrl: String?) {
        prefs.set(RECOMMENDED_KEY, if (recommended) "1" else null)
        val url = if (recommended) validUpdateUrl(updateUrl) else null
        prefs.set(URL_KEY, url)
        _updateUrl.value = url
        refresh()
    }

    /** Dismiss: hidden for 24 hours. */
    fun dismiss() {
        prefs.set(DISMISSED_UNTIL_KEY, (now() + DISMISSAL_MS).toString())
        refresh()
    }

    /** Reads the rows again; a dismissal that has ended is dropped. */
    fun refresh() {
        val until = prefs.get(DISMISSED_UNTIL_KEY)?.toLongOrNull()
        val current = now()
        _visible.value = shouldShow(prefs.get(RECOMMENDED_KEY) == "1", until, current)
        if (until != null && until <= current) {
            prefs.set(DISMISSED_UNTIL_KEY, null)
            _dismissedUntil.value = null
        } else {
            _dismissedUntil.value = until
        }
    }

    companion object {
        const val UPGRADE_HEADER = "x-meet-upgrade"
        const val UPDATE_URL_HEADER = "x-meet-update-url"
        const val DISMISSAL_MS = 24L * 60 * 60 * 1_000

        private const val RECOMMENDED_KEY = "recommendedMeetUpgrade"
        private const val URL_KEY = "recommendedMeetUpgradeURL"
        private const val DISMISSED_UNTIL_KEY = "recommendedMeetUpgradeDismissedUntil"

        /** `StarlingsUpgradeRecommendation.shouldShow`. */
        fun shouldShow(recommended: Boolean, dismissedUntil: Long?, now: Long): Boolean {
            if (!recommended) return false
            return dismissedUntil == null || dismissedUntil <= now
        }

        /** The headers of one answer (names lowercase): recommended, and the link it named. */
        fun read(headers: Map<String, String>): Pair<Boolean, String?> =
            (headers[UPGRADE_HEADER] == "recommended") to headers[UPDATE_URL_HEADER]

        /** `https`, a host, no user or password; anything else is no link. */
        fun validUpdateUrl(raw: String?): String? {
            val text = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            if (!text.startsWith("https://", ignoreCase = true)) return null
            val url = text.toHttpUrlOrNull() ?: return null
            if (url.host.isEmpty() || url.username.isNotEmpty() || url.password.isNotEmpty()) return null
            return text
        }

        /** This build's marketing version: `0.0.1-a0` reads `0.0.1`, as the `x-meet-client` header sends it. */
        val installedVersion: String get() = BuildConfig.VERSION_NAME.substringBefore('-')

        /**
         * `StarlingsUpgradeRecommendation.isBelow`: true when [installed] is
         * older than [floor]. No floor, or a side that is not dotted
         * integers, sets no floor. Missing parts read as 0.
         */
        fun isBelow(floor: String?, installed: String = installedVersion): Boolean {
            val left = floor?.let(::numeric) ?: return false
            val right = numeric(installed) ?: return false
            for (index in 0 until maxOf(left.size, right.size)) {
                val a = left.getOrElse(index) { 0L }
                val b = right.getOrElse(index) { 0L }
                if (a != b) return a > b
            }
            return false
        }

        private fun numeric(version: String): List<Long>? {
            val parts = version.split('.')
            if (parts.isEmpty()) return null
            return parts.map { part -> part.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toLongOrNull() ?: return null }
        }
    }
}
