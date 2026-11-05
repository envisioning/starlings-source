package work.starlings.android

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import work.starlings.android.widgets.MeetingCountdown
import work.starlings.android.widgets.MeetingCountdownRules
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The meeting warning: `iOS/MeetingNotices.swift` on Android.
 * [MeetingAlertPlan] decides which meetings warn and when; this hands each
 * one to AlarmManager, which posts the notification even with the app
 * closed, as the iPhone's pending notifications do. The switches are the
 * device-local `MeetingAlertSettings` of iOS: on by default, a lead of one
 * minute, nothing synced.
 */
object MeetingWarnings {
    private const val PREFS = "alerts"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_LEAD = "leadMinutes"
    private const val KEY_COUNTDOWN_LEAD = "countdownLeadMinutes"
    private const val KEY_PENDING = "pending"
    private const val CHANNEL = "meeting-warning"
    private const val EXTRA = "notice"
    const val DEFAULT_LEAD_MINUTES = 1

    /** What a scheduled warning carries: enough to post it after a reboot. */
    @Serializable
    data class Pending(val id: String, val title: String, val startMs: Long, val fireAtMs: Long, val link: String? = null)

    private val json = Json { ignoreUnknownKeys = true }
    private val clock = DateTimeFormatter.ofPattern("HH:mm")

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enabled(context: Context) = prefs(context).getBoolean(KEY_ENABLED, true)
    fun setEnabled(context: Context, on: Boolean) = prefs(context).edit().putBoolean(KEY_ENABLED, on).apply()

    /** A stored lead outside the choices reads as the default. */
    fun leadMinutes(context: Context): Int =
        prefs(context).getInt(KEY_LEAD, DEFAULT_LEAD_MINUTES).takeIf { it in MeetingAlertPlan.leadChoices } ?: DEFAULT_LEAD_MINUTES

    fun setLeadMinutes(context: Context, minutes: Int) {
        require(minutes in MeetingAlertPlan.leadChoices)
        prefs(context).edit().putInt(KEY_LEAD, minutes).apply()
    }

    /** `MeetingAlertSettings.countdownLead`: how early the Lock Screen countdown appears; outside the choices reads as the default. */
    fun countdownLeadMinutes(context: Context): Int =
        prefs(context).getInt(KEY_COUNTDOWN_LEAD, MeetingCountdownRules.DEFAULT_LEAD_MINUTES).takeIf { it in MeetingCountdownRules.leadChoices }
            ?: MeetingCountdownRules.DEFAULT_LEAD_MINUTES

    fun setCountdownLeadMinutes(context: Context, minutes: Int) {
        require(minutes in MeetingCountdownRules.leadChoices)
        prefs(context).edit().putInt(KEY_COUNTDOWN_LEAD, minutes).apply()
    }

    /**
     * Rewrite the pending set to exactly match [meetings]. Idempotent, so it
     * is safe on every refresh, every foreground and every clock change.
     * [link] gives the room link a tap on a warning opens.
     */
    fun synchronize(context: Context, meetings: List<UpcomingEvent>, link: (UpcomingEvent) -> String? = { null }, nowMs: Long = System.currentTimeMillis()) {
        cancelAll(context)
        if (!enabled(context)) return
        val byId = meetings.associateBy { it.id }
        val notices = MeetingAlertPlan.plan(meetings, nowMs, leadMinutes(context) * 60_000L)
            .map { Pending(it.eventId, it.title, it.start, it.fireAt, byId[it.eventId]?.let(link)) }
        notices.forEach { schedule(context, it) }
        prefs(context).edit().putString(KEY_PENDING, json.encodeToString(ListSerializer(Pending.serializer()), notices)).apply()
    }

    fun cancelAll(context: Context) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        pending(context).forEach { alarms.cancel(alarm(context, it)) }
        prefs(context).edit().remove(KEY_PENDING).apply()
    }

    /** After a reboot: put back the warnings still ahead. */
    fun reschedule(context: Context, nowMs: Long = System.currentTimeMillis()) {
        pending(context).filter { it.fireAtMs > nowMs }.forEach { schedule(context, it) }
    }

    private fun pending(context: Context): List<Pending> =
        prefs(context).getString(KEY_PENDING, null)
            ?.let { runCatching { json.decodeFromString(ListSerializer(Pending.serializer()), it) }.getOrNull() }
            .orEmpty()

    /**
     * Exact when the person allowed exact alarms, otherwise Android's
     * nearest window: a warning late by a minute beats none.
     */
    private fun schedule(context: Context, notice: Pending) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        val intent = alarm(context, notice)
        if (alarms.canScheduleExactAlarms()) {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, notice.fireAtMs, intent)
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, notice.fireAtMs, intent)
        }
    }

    private fun alarm(context: Context, notice: Pending): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            notice.id.hashCode(),
            Intent(context, MeetingWarningReceiver::class.java)
                .setAction("warning:${notice.id}")
                .putExtra(EXTRA, json.encodeToString(Pending.serializer(), notice)),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    /** `MeetingAlertPlan.body`: "Starting · 14:05", the same on every platform. */
    fun body(startMs: Long, zone: ZoneId = ZoneId.systemDefault()) = "Starting · " + clock.format(Instant.ofEpochMilli(startMs).atZone(zone))

    internal fun post(context: Context, intent: Intent) {
        val notice = intent.getStringExtra(EXTRA)?.let { runCatching { json.decodeFromString(Pending.serializer(), it) }.getOrNull() } ?: return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.meeting_warning), NotificationManager.IMPORTANCE_HIGH),
        )
        val open = Intent(context, MainActivity::class.java).apply {
            notice.link?.let { data = Uri.parse(it); action = Intent.ACTION_VIEW }
        }
        val tap = PendingIntent.getActivity(context, notice.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(
            notice.id.hashCode(),
            NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(notice.title)
                .setContentText(body(notice.startMs))
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build(),
        )
    }
}

/** Posts a due warning, and after a reboot puts the pending ones and the countdown back. */
class MeetingWarningReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            MeetingWarnings.reschedule(context)
            MeetingCountdown.synchronize(context)
        } else {
            MeetingWarnings.post(context, intent)
        }
    }
}
