package work.starlings.android.widgets

import android.content.Context
import kotlinx.serialization.json.Json
import work.starlings.android.Account
import work.starlings.android.OwnerAccount
import work.starlings.android.api.WorkRoutes
import work.starlings.contracts.CalendarEventWire
import java.io.File

/**
 * What the widgets draw from, as `iOS/AgendaFile.swift`: the app writes,
 * the widgets read, and no widget makes a request.
 *
 * - Meetings: `agenda.json` in `noBackupFilesDir/widgets`, written when Home
 *   loads the feed ([publishMeetings]). The upcoming feed is not in the
 *   snapshot cache on Android (`RequestPolicy`, as iOS), so it has its own
 *   file. It names its owner; a widget reads it only while that owner is
 *   signed in, and signing out deletes it ([WidgetRefresh.watch]).
 * - Work: the Mine snapshot Home and Work already keep (`WorkRoutes.mine`),
 *   which sign-out purges with the rest.
 */
object WidgetStore {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val lock = Any()

    private fun file(context: Context) = File(context.noBackupFilesDir, "widgets/agenda.json")

    private fun signedIn(account: OwnerAccount): String? = (account.account.value as? Account.SignedIn)?.email?.lowercase()

    /**
     * `AgendaFile.writeMeetings`: the feed Home just read, and the row count
     * Home draws it with, then a redraw. Best effort: a file that failed to
     * write leaves the last one, and the widgets say what they last knew.
     */
    fun publishMeetings(context: Context, account: OwnerAccount, raw: List<CalendarEventWire>, ownSlug: String?, followingRows: Int) {
        val owner = signedIn(account) ?: return
        val now = System.currentTimeMillis()
        val agenda = WidgetAgendaFile(owner = owner, savedAtMs = now, homeFollowingRows = followingRows, meetings = WidgetAgenda.meetings(raw, ownSlug, now))
        synchronized(lock) {
            val target = file(context)
            runCatching {
                target.parentFile?.mkdirs()
                val temp = File(target.parentFile, "${target.name}.tmp")
                temp.writeText(json.encodeToString(WidgetAgendaFile.serializer(), agenda))
                if (!temp.renameTo(target)) temp.delete()
            }
        }
        WidgetRefresh.now(context)
        MeetingCountdown.synchronize(context, now)
    }

    /** Signed out: the next owner's widgets start empty. */
    fun clear(context: Context) {
        synchronized(lock) { file(context).delete() }
        MeetingCountdown.end(context)
    }

    /** The meetings for the signed-in owner, or null: none written, another owner's, or another shape. */
    fun agenda(context: Context, account: OwnerAccount): WidgetAgendaFile? {
        val owner = signedIn(account) ?: return null
        val text = synchronized(lock) { runCatching { file(context).takeIf { it.exists() }?.readText() }.getOrNull() } ?: return null
        val agenda = runCatching { json.decodeFromString(WidgetAgendaFile.serializer(), text) }.getOrNull() ?: return null
        return agenda.takeIf { it.schema == WidgetAgendaFile.SCHEMA && it.owner == owner }
    }

    /** Today's work from the last Mine answer; empty when signed out or never read. */
    fun work(account: OwnerAccount, now: Long): List<WidgetWorkRow> {
        if (signedIn(account) == null) return emptyList()
        val mine = account.client.snapshot(WorkRoutes.mine)?.value ?: return emptyList()
        return WidgetWork.rows(mine.tasks, mine.issues, now)
    }
}
