package work.starlings.android.widgets

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import kotlinx.coroutines.flow.MutableStateFlow
import work.starlings.android.MainActivity
import work.starlings.android.workspace.home.HomeLinks
import java.time.ZoneId

/*
 * `iOSActivities/StarlingsControls.swift` on Android: the Join meeting and
 * Quick note controls are Quick Settings tiles. Each tile is one press that
 * opens the app on one verb, as a ControlWidgetButton does. The tile has no
 * session and no navigation: it starts MainActivity with the verb
 * ([LaunchAction.EXTRA]), and the activity performs it
 * (`StarlingsAppModel.performLaunchAction`).
 */

/** `LaunchAction`: the verb a control hands the app. */
enum class LaunchAction(val raw: String) {
    /** Open the next meeting's link, the way a tap on the Upcoming widget does. */
    JOIN_NEXT_MEETING("joinNextMeeting"),

    /** Home, with the quick-note field open. */
    NEW_QUICK_NOTE("newQuickNote");

    fun intent(context: Context): Intent =
        Intent(context, MainActivity::class.java)
            .putExtra(EXTRA, raw)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    companion object {
        const val EXTRA = "work.starlings.android.extra.LAUNCH_ACTION"

        fun from(raw: String?): LaunchAction? = entries.firstOrNull { it.raw == raw }

        /**
         * `StarlingsAppModel.pendingQuickNote`: set by the Quick note tile,
         * taken once by Home's Quick Notes card, which opens its field.
         */
        val pendingQuickNote = MutableStateFlow(false)
    }
}

/** Where Join meeting goes, as `performLaunchAction`'s `.joinNextMeeting` branch. */
sealed interface NextMeetingDoor {
    /** A colleague's room: the app's join flow. */
    data class Room(val link: String) : NextMeetingDoor

    /** Zoom, Meet, Teams and the rest: their own app. */
    data class External(val url: String) : NextMeetingDoor

    /** No link: the meeting in Calendar, by web path. */
    data class Event(val path: String) : NextMeetingDoor

    /** No meeting ahead: the Calendar tab. */
    data object Calendar : NextMeetingDoor

    companion object {
        const val CALENDAR_PATH = "/calendar"

        /**
         * The agenda file, not a store: on a cold launch nothing has answered
         * yet, and the file is what the widget showed. The meeting is the
         * file's focus, as `AgendaFile.next` (`MeetingFocus.classify(...).focus`).
         */
        fun resolve(file: WidgetAgendaFile?, now: Long, zone: ZoneId = ZoneId.systemDefault()): NextMeetingDoor {
            val next = WidgetAgenda.focus(WidgetAgenda.plan(file, now, zone), file) ?: return Calendar
            val join = next.join ?: return Event(HomeLinks.calendarEvent(next.id, next.start, zone))
            return when (join.kind) {
                WidgetJoin.Kind.ROOM -> Room(join.url)
                WidgetJoin.Kind.EXTERNAL -> External(join.url)
            }
        }
    }
}

/** One Quick Settings tile that opens the app on [action]. */
abstract class LaunchActionTile(private val action: LaunchAction) : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        // A locked phone asks for the unlock first, as iOS opens the app only after Face ID.
        if (isLocked) unlockAndRun(::open) else open()
    }

    private fun open() {
        val intent = action.intent(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(
                PendingIntent.getActivity(this, action.ordinal, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}

/** `JoinNextMeetingControl`. */
class JoinMeetingTile : LaunchActionTile(LaunchAction.JOIN_NEXT_MEETING)

/** `NewQuickNoteControl`. */
class QuickNoteTile : LaunchActionTile(LaunchAction.NEW_QUICK_NOTE)
