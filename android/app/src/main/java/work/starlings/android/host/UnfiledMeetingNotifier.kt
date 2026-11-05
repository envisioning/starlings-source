package work.starlings.android.host

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import work.starlings.android.MainActivity
import work.starlings.android.R

/**
 * `UnfiledMeetingNotice`: "Meeting not filed", once, when a meeting this
 * device hosted in the owner's room ended uncategorized ([MeetingFiling.nudges]).
 * The artifact already goes to Core as uncategorized; nothing here changes
 * that. Quiet, with no actions: filing needs the subject search, a screen.
 * A second ended meeting replaces the first nudge.
 */
object UnfiledMeetingNotifier {
    private const val CHANNEL = "meetings.unfiled"
    private const val TAG = "meet.unfiled"

    suspend fun deliverIfUnfiled(context: Context, api: MeetingOwnerApi, room: String, meetingId: String) {
        // Best effort, like every CRM read.
        val category = try {
            api.category(room, meetingId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        if (!MeetingFiling.nudges(category)) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.unfiled_title), NotificationManager.IMPORTANCE_LOW))
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val tap = PendingIntent.getActivity(context, TAG.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(
            TAG, 0,
            NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(context.getString(R.string.unfiled_title))
                .setContentText(context.getString(R.string.unfiled_body))
                .setSilent(true)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build(),
        )
    }
}
