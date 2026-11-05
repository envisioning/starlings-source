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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import work.starlings.android.MainActivity
import work.starlings.android.R

/**
 * Posts the [KnockNoticeGate] decisions for one hosted meeting. The tap
 * opens the app on the waiting room ([EXTRA_WAITING_ROOM]); the
 * notification has no actions.
 */
class KnockNotifier(private val context: Context, private val host: RoomHost, private val scope: CoroutineScope) {
    private val gate = KnockNoticeGate()
    private var job: Job? = null

    fun start() {
        if (job != null) return
        val foreground = ProcessLifecycleOwner.get().lifecycle.currentStateFlow.map { it.isAtLeast(Lifecycle.State.STARTED) }
        job = scope.launch {
            combine(host.state, host.lobby.state, foreground) { h, l, f -> gate.step(h, l, f) }
                .collect(::apply)
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        apply(gate.reset())
    }

    private fun apply(action: KnockNoticeGate.Action) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        when (action) {
            KnockNoticeGate.Action.Keep -> Unit
            KnockNoticeGate.Action.Withdraw -> manager.cancel(NOTIFICATION_ID)
            is KnockNoticeGate.Action.Post -> post(manager, action)
        }
    }

    private fun post(manager: NotificationManager, knock: KnockNoticeGate.Action.Post) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.host_waiting_room), NotificationManager.IMPORTANCE_HIGH),
        )
        val open = Intent(context, MainActivity::class.java)
            .setAction(ACTION_WAITING_ROOM)
            .putExtra(EXTRA_WAITING_ROOM, true)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val tap = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(context.getString(R.string.host_knock_title, knock.name))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(tap)
            .setAutoCancel(true)
        if (knock.waiting > 1) {
            builder.setContentText(context.resources.getQuantityString(R.plurals.host_knock_at_door, knock.waiting, knock.waiting))
        }
        // One id: a second knock replaces the notification rather than stacking.
        manager.notify(NOTIFICATION_ID, builder.build())
    }

    companion object {
        const val ACTION_WAITING_ROOM = "work.starlings.android.WAITING_ROOM"
        const val EXTRA_WAITING_ROOM = "waiting_room"
        private const val CHANNEL = "knocks"
        private const val NOTIFICATION_ID = 0x6b6e
    }
}
