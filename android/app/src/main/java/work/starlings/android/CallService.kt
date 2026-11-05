package work.starlings.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Active-call foreground service. Started from the person's own join, while the
 * app is in front, so Android allows the microphone type. It keeps audio alive
 * with the screen locked; it does not stop the OS ending the app. The camera
 * pauses in the background (CallSession.onBackground), so there is no camera type.
 *
 * The notification carries Mute or Unmute and Leave, and follows the mic state
 * the call reports. Unmute is the person's own tap; nothing else opens the mic.
 */
class CallService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watch: Job? = null
    private val call get() = (application as StarlingsApp).call

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_LEAVE -> { call.leave(); return START_NOT_STICKY }
            ACTION_MUTE -> { call.setMic(false); return START_NOT_STICKY }
            ACTION_UNMUTE -> { call.setMic(true); return START_NOT_STICKY }
        }
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, notification(call.ui.value.micOn), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        )
        if (watch == null) {
            watch = scope.launch {
                call.ui.map { it.micOn }.distinctUntilChanged().collect { micOn ->
                    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(micOn))
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun action(code: Int, action: String) = PendingIntent.getService(
        this, code, Intent(this, CallService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE,
    )

    private fun notification(micOn: Boolean): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(getString(R.string.notification_title))
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .addAction(
                0,
                getString(if (micOn) R.string.mute else R.string.unmute),
                if (micOn) action(2, ACTION_MUTE) else action(3, ACTION_UNMUTE),
            )
            .addAction(0, getString(R.string.leave), action(1, ACTION_LEAVE))
            .build()
    }

    companion object {
        private const val CHANNEL = "call"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_LEAVE = "leave"
        private const val ACTION_MUTE = "mute"
        private const val ACTION_UNMUTE = "unmute"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, CallService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallService::class.java))
        }
    }
}
