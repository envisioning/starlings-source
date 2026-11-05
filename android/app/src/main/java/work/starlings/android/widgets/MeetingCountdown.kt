package work.starlings.android.widgets

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import work.starlings.android.MainActivity
import work.starlings.android.MeetingWarnings
import work.starlings.android.R
import work.starlings.android.StarlingsApp
import work.starlings.android.Upcoming
import work.starlings.android.workspace.team.MessageNotifier
import java.time.ZoneId

/**
 * The rules of the countdown to the focus meeting, as `iOS/MeetingLiveActivity.swift`.
 * No Android here, so the JVM tests reach them.
 */
object MeetingCountdownRules {
    private const val MINUTE_MS = 60_000L

    /** `MeetingAlertSettings.countdownLeadChoices`, in minutes. */
    val leadChoices = listOf(15, 30, 60, 120, 240)

    /** `MeetingAlertSettings.countdownLead`'s default. */
    const val DEFAULT_LEAD_MINUTES = 60

    /** What the notification shows, or nothing. */
    sealed interface Plan {
        data object None : Plan

        /** [target] is what the chronometer counts to: the start, then the end. */
        data class Show(val meeting: WidgetMeeting, val start: Long, val end: Long, val started: Boolean) : Plan {
            val target: Long get() = if (started) end else start
        }
    }

    /**
     * `MeetingLiveActivity.ineligibilityReason`: why there is no countdown,
     * or null when there is one. Every focus meeting counts, a link or not.
     */
    fun ineligibilityReason(meeting: WidgetMeeting?, now: Long, enabled: Boolean, leadMs: Long): String? {
        if (!enabled) return "alerts off in Settings"
        meeting ?: return "no focus meeting"
        val start = Upcoming.parse(meeting.start)
        val end = Upcoming.parse(meeting.end)
        if (start == null || end == null) return "focus has no start or end"
        if (end <= now) return "focus already ended"
        if (start > now + leadMs) return "focus starts in ${(start - now) / MINUTE_MS} min, lead is ${leadMs / MINUTE_MS} min"
        return null
    }

    /** The countdown follows the hero (`applyAlerts`): the file's focus at [now]. */
    fun plan(file: WidgetAgendaFile?, now: Long, enabled: Boolean, leadMs: Long, zone: ZoneId = ZoneId.systemDefault()): Plan {
        val focus = WidgetAgenda.focus(WidgetAgenda.plan(file, now, zone), file)
        if (ineligibilityReason(focus, now, enabled, leadMs) != null) return Plan.None
        val m = focus ?: return Plan.None
        val start = Upcoming.parse(m.start) ?: return Plan.None
        val end = Upcoming.parse(m.end) ?: return Plan.None
        return Plan.Show(m, start, end, started = start <= now)
    }

    /**
     * When the answer can next change: a meeting entering the lead window,
     * starting (the number flips to the end) or ending (the next focus),
     * or midnight (another day's hero). iOS needs the app to run for each
     * of these; Android's alarm runs it with the app closed.
     */
    fun nextChange(file: WidgetAgendaFile?, now: Long, leadMs: Long, zone: ZoneId = ZoneId.systemDefault()): Long {
        var next = WidgetAgenda.nextMidnight(now, zone)
        for (m in file?.meetings.orEmpty()) {
            val start = Upcoming.parse(m.start) ?: continue
            val end = Upcoming.parse(m.end) ?: continue
            for (boundary in listOf(start - leadMs, start, end)) if (boundary > now && boundary < next) next = boundary
        }
        return next + 1_000
    }
}

/**
 * The Lock Screen countdown: iOS's Live Activity (`MeetingLiveActivity`,
 * `MeetingActivityWidget`) as one ongoing notification. The chronometer
 * counts down to the focus meeting's start, then to its end, with Join when
 * the meeting has a link. On Android 16 it asks to be a Live Update
 * (promoted ongoing), so it shows as a chip in the status bar and at the top
 * of the Lock Screen; below that it is a plain ongoing notification.
 *
 * It reads the agenda file the widgets read ([WidgetStore]), so Home's
 * every read, a settings change, the boot and its own alarm keep it right.
 * The alarm runs at the next moment the answer changes
 * ([MeetingCountdownRules.nextChange]); the notification also times itself
 * out at the meeting's end, as iOS's dismissal at the end.
 */
object MeetingCountdown {
    private const val CHANNEL = "meeting-countdown"
    private const val NOTIFICATION_ID = 0x5747
    private const val ACTION_WAKE = "work.starlings.android.countdown.WAKE"

    /** `Notification.EXTRA_REQUEST_PROMOTED_ONGOING`: public from API 36.1; the key is the same on 36. */
    private const val EXTRA_REQUEST_PROMOTED = "android.requestPromotedOngoing"

    /** Post, update or end the countdown for the signed-in owner's agenda; book the next look. */
    fun synchronize(context: Context, now: Long = System.currentTimeMillis()) {
        val app = context.applicationContext as StarlingsApp
        val file = WidgetStore.agenda(app, app.account)
        val leadMs = MeetingWarnings.countdownLeadMinutes(app) * 60_000L
        when (val plan = MeetingCountdownRules.plan(file, now, MeetingWarnings.enabled(app), leadMs)) {
            MeetingCountdownRules.Plan.None -> cancelNotification(app)
            is MeetingCountdownRules.Plan.Show -> post(app, plan, now)
        }
        if (file == null) cancelAlarm(app) else book(app, MeetingCountdownRules.nextChange(file, now, leadMs))
    }

    /** Signed out, or the switch went off: no countdown and no alarm. */
    fun end(context: Context) {
        cancelNotification(context)
        cancelAlarm(context)
    }

    private fun cancelNotification(context: Context) =
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)

    private fun wake(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context, NOTIFICATION_ID,
            Intent(context, MeetingCountdownReceiver::class.java).setAction(ACTION_WAKE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private fun cancelAlarm(context: Context) = context.getSystemService(AlarmManager::class.java).cancel(wake(context))

    /** Exact when the person allowed exact alarms, as the warnings; else Android's nearest window. */
    private fun book(context: Context, atMs: Long) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        if (alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, wake(context))
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, wake(context))
    }

    private fun post(context: Context, plan: MeetingCountdownRules.Plan.Show, now: Long) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        // Low: the countdown is there to be seen, not heard; a Live Update needs more than Min.
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.settings_countdown), NotificationManager.IMPORTANCE_LOW),
        )
        val m = plan.meeting
        val clock = WidgetText.clockLine(context, m, now)
        val builder = Notification.Builder(context, CHANNEL)
            .setSmallIcon(meetingGlyph(m.isVideo))
            .setContentTitle(m.title)
            .setContentText(if (m.calendar.isEmpty()) clock else "$clock · ${m.calendar}")
            .setCategory(Notification.CATEGORY_EVENT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setWhen(plan.target)
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setTimeoutAfter(plan.end - now)
            .setContentIntent(tap(context, m))
        WidgetAgenda.whoLine(m.attendees).takeIf { it.isNotEmpty() }?.let { builder.setSubText(it) }
        m.join?.let { join ->
            builder.addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(context, meetingGlyph(m.isVideo)),
                    context.getString(R.string.widget_join),
                    activity(context, 1, joinIntent(context, join)),
                ).build(),
            )
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) {
            builder.addExtras(android.os.Bundle().apply { putBoolean(EXTRA_REQUEST_PROMOTED, true) })
        }
        manager.notify(NOTIFICATION_ID, builder.build())
    }

    /** `StarlingsGlance.tapURL`: the link, else the meeting in Calendar. */
    private fun tap(context: Context, m: WidgetMeeting): PendingIntent {
        val intent = m.join?.let { joinIntent(context, it) }
            ?: Intent(context, MainActivity::class.java).putExtra(MessageNotifier.EXTRA_PATH, WidgetDoors.event(m)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return activity(context, 0, intent)
    }

    /** As the widgets' Join ([WidgetDoors.join]): a colleague's room through the join flow, any other link in its own app. */
    private fun joinIntent(context: Context, j: WidgetJoin): Intent = when (j.kind) {
        WidgetJoin.Kind.ROOM -> Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse(j.url)).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        WidgetJoin.Kind.EXTERNAL -> Intent(Intent.ACTION_VIEW, Uri.parse(j.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    private fun activity(context: Context, code: Int, intent: Intent): PendingIntent =
        PendingIntent.getActivity(context, NOTIFICATION_ID + code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
}

/** The countdown's own alarm: look again at the next boundary. */
class MeetingCountdownReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = MeetingCountdown.synchronize(context)
}
