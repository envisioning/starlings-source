package work.starlings.android.workspace.team

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import work.starlings.android.MainActivity
import work.starlings.android.R

/**
 * `MessageNotices.deliver`: each notice now, grouped per conversation as
 * Messages does. Only while the app runs and polls; never called push.
 * Without the notification permission nothing posts (the app asks for it at
 * the first call, as the meeting warnings do). The tap opens the
 * conversation ([EXTRA_PATH]).
 */
object MessageNotifier {
    private const val CHANNEL = "messages"
    private const val GROUP_PREFIX = "meet.message."

    /** The conversation's web path on the tap's intent; MainActivity hands it to the workspace navigator. */
    const val EXTRA_PATH = "work.starlings.android.extra.WORKSPACE_PATH"

    fun deliver(context: Context, notices: List<MessageNotice>) {
        if (notices.isEmpty()) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.team_messages), NotificationManager.IMPORTANCE_HIGH))
        for (notice in notices) {
            val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_PATH, notice.path)
            val tap = PendingIntent.getActivity(context, notice.threadId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            manager.notify(
                GROUP_PREFIX + notice.threadId,
                (notice.sentAtMs / 1000).toInt(),
                NotificationCompat.Builder(context, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(notice.title ?: context.getString(R.string.team_conversation))
                    .setContentText(notice.body ?: context.getString(R.string.team_new_message))
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setGroup(GROUP_PREFIX + notice.threadId)
                    .setWhen(notice.sentAtMs)
                    .setShowWhen(true)
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build(),
            )
        }
    }
}
