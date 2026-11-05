package work.starlings.android.workspace

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.People
import androidx.compose.ui.graphics.vector.ImageVector
import work.starlings.android.R

/**
 * The member surfaces, in tab order: `MEMBER_SURFACES`
 * (fixtures/member-surfaces.json), the tabs of iOS `StarlingsAppModel.Tab`.
 * The icons are the Material counterparts of the iOS tab symbols.
 */
enum class MemberSurface(val id: String, val title: String, val titleResource: Int, val icon: ImageVector) {
    HOME("home", "Home", R.string.tab_home, Icons.Filled.Home),
    CALENDAR("calendar", "Calendar", R.string.tab_calendar, Icons.Filled.CalendarToday),
    WORK("work", "Work", R.string.tab_work, Icons.Filled.Inbox),
    TEAM("team", "Team", R.string.tab_team, Icons.Filled.People),
    DOCS("docs", "Docs", R.string.tab_docs, Icons.Filled.Description),
}

/** `Sources/SurfaceVisibility.swift`, held to fixtures/surface-visibility.json. */
object SurfaceVisibility {
    /** Unknown calendar sources show Calendar; no source hides it. Docs shows only where the workspace has it. */
    fun isVisible(surface: MemberSurface, calendarSources: Boolean?, docs: Boolean): Boolean = when (surface) {
        MemberSurface.CALENDAR -> calendarSources != false
        MemberSurface.DOCS -> docs
        MemberSurface.HOME, MemberSurface.WORK, MemberSurface.TEAM -> true
    }

    fun visible(calendarSources: Boolean?, docs: Boolean): List<MemberSurface> =
        MemberSurface.entries.filter { isVisible(it, calendarSources, docs) }
}
