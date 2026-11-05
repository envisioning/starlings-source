package work.starlings.android.workspace.team

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import work.starlings.android.MainActivity
import work.starlings.android.R

/**
 * `RingNotices.deliver` and `withdraw`: one notification for every ring, so
 * a second caller replaces the first, as the roster carries one. A call or an
 * agent's ask opens the app, where Team answers it; a wave with a room opens
 * the join flow on that room. Only while the app runs and polls; never push.
 */
object RingNotifier {
    private const val CHANNEL = "rings"
    private const val TAG = "meet.ring"

    fun deliver(context: Context, notice: RingNotice) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.tab_team), NotificationManager.IMPORTANCE_HIGH))
        val title = when {
            notice.isAgentAsk -> context.getString(R.string.team_ring_agent_start, notice.callerName)
            notice.isCall -> context.getString(R.string.team_ring_call, notice.callerName)
            else -> context.getString(R.string.team_ring_wave, notice.callerName)
        }
        val body = when {
            notice.isAgentAsk || notice.isCall -> context.getString(R.string.ring_answer_in_team)
            notice.roomSlug != null -> context.getString(R.string.ring_their_room, notice.roomSlug)
            else -> context.getString(R.string.ring_asked_in_team)
        }
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        notice.joinUrl?.let { open.setAction(Intent.ACTION_VIEW).setData(Uri.parse(it)) }
        val tap = PendingIntent.getActivity(context, TAG.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(
            TAG, 0,
            NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(body)
                .setCategory(if (notice.isCall || notice.isAgentAsk) NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build(),
        )
    }

    /** The ring expired, was answered, or was dismissed on another device. */
    fun withdraw(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(TAG, 0)
    }
}
