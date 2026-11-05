package work.starlings.android

import work.starlings.android.workspace.home.HomeLinks
import java.net.URI
import java.net.URLDecoder

/**
 * Where a link the app was opened with goes, as iOS
 * `StarlingsAppModel.route(url:)`. `starlings://` and the `meet://` written
 * before the rename read the same. A glance link is a
 * workspace web path, so it lands where the same tap inside the app
 * lands (`WorkspaceNavigator`); anything else on `http(s)` or the app
 * schemes is a room link on its way in.
 */
object AppLinks {
    sealed interface Route {
        /** A workspace web path for the tab that owns it. */
        data class Path(val path: String) : Route
        /** A room or invite link, opened under the workspace that owns its host. */
        data class Link(val link: String) : Route
        data object Ignore : Route
    }

    val schemes = setOf(Contracts.NATIVE_LINK_SCHEME, Contracts.LEGACY_NATIVE_LINK_SCHEME)

    fun route(link: String): Route {
        val uri = runCatching { URI(link.trim()) }.getOrNull() ?: return Route.Ignore
        val scheme = uri.scheme?.lowercase() ?: return Route.Ignore
        val isAppLink = scheme in schemes
        if (scheme != "http" && scheme != "https" && !isAppLink) return Route.Ignore
        if (!isAppLink) return Route.Link(link)
        val parts = uri.rawPath.orEmpty().split('/').filter { it.isNotEmpty() }.map { URLDecoder.decode(it, "UTF-8") }
        return when (uri.host?.lowercase()) {
            // `starlings://event/<reference>`: a glance surface for a meeting with no link, on the meeting in Calendar.
            "event" -> parts.joinToString("/").takeIf { it.isNotEmpty() }?.let { Route.Path(HomeLinks.event(it)) } ?: Route.Ignore
            // `starlings://work/task/<id>` and `starlings://work/subject/<kind>/<id>?title=`: the Today's work widget's rows.
            "work" -> when {
                parts.size >= 2 && parts[0] == "task" -> Route.Path(HomeLinks.task(parts[1]))
                parts.size >= 3 && parts[0] == "subject" -> Route.Path(HomeLinks.subject(parts[1], parts[2], listOf("pane" to "tasks")))
                else -> Route.Path(HomeLinks.WORK)
            }
            "calendar" -> Route.Path(HomeLinks.CALENDAR)
            else -> Route.Link(link)
        }
    }
}
