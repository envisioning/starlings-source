package work.starlings.android.workspace.calendar

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import work.starlings.android.StarlingsApp

/**
 * The workspace's time-zone shortlist, `StarlingsWorkspace.workspaceDefaults?.timeZones`:
 * the descriptor's presentation `defaults` (`GET /.well-known/meet`,
 * docs/CENTRAL_AUTH.md). Saved with the workspace so the composer offers
 * the same zones offline. A descriptor without `defaults` clears it, as iOS
 * does, and then every preset is offered ([CalendarSchedule.offered]).
 */
object CalendarWorkspaceZones {
    private val key get() = "meet.workspace.${work.starlings.android.Workspaces.active.webOrigin}.timeZones"

    fun cached(prefs: SharedPreferences): List<String>? =
        prefs.getString(key, null)?.split(',')?.filter { it.isNotEmpty() }

    /** Reads the descriptor again; an unreachable or unreadable one keeps what was saved. */
    suspend fun refresh(context: Context, prefs: SharedPreferences): List<String>? {
        val app = context.applicationContext as? StarlingsApp ?: return cached(prefs)
        val descriptor = withContext(Dispatchers.IO) {
            runCatching { app.call.workspaceBackgrounds.readDescriptor() }.getOrNull()
        } ?: return cached(prefs)
        val zones = descriptor.defaults?.timeZones?.map { it.value }
        prefs.edit().apply { if (zones == null) remove(key) else putString(key, zones.joinToString(",")) }.apply()
        return zones
    }
}
