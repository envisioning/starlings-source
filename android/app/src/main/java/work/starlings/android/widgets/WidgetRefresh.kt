package work.starlings.android.widgets

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.launch
import work.starlings.android.Account
import work.starlings.android.StarlingsApp
import java.util.concurrent.TimeUnit

/**
 * When the widgets draw again. iOS hands WidgetKit a timeline of every
 * moment the answer changes (`AgendaFile.entryDates`); Android has none, so
 * one WorkManager job redraws every placed widget and books itself for the
 * next of those moments ([WidgetAgenda.nextRefresh]): each lead, start and
 * end, midnight, and the countdown's own pace. Nothing here needs the app
 * on screen, and nothing makes a request.
 *
 * The app asks for a redraw now when Home loads the feed ([now]); placing
 * a widget starts the chain ([ensure]); no placed widget ends it.
 */
object WidgetRefresh {
    private const val WORK = "work.starlings.android.widgets.refresh"

    private fun widgets(): List<GlanceAppWidget> = listOf(NextMeetingWidget(), TodayAgendaWidget(), TodayWorkWidget())

    /** Redraw now, replacing whatever was booked: the agenda just changed. */
    fun now(context: Context) = enqueue(context, 0, ExistingWorkPolicy.REPLACE)

    /** A widget was placed or the system asked: draw now unless a redraw is booked already. */
    fun ensure(context: Context) = enqueue(context, 0, ExistingWorkPolicy.KEEP)

    private fun enqueue(context: Context, delayMs: Long, policy: ExistingWorkPolicy) {
        val request = OneTimeWorkRequestBuilder<WidgetRefreshWorker>().setInitialDelay(delayMs, TimeUnit.MILLISECONDS).build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(WORK, policy, request)
    }

    /** Every placed widget, redrawn; then the next redraw, booked after this one ends. */
    internal suspend fun run(context: Context) {
        val manager = GlanceAppWidgetManager(context)
        val placed = widgets().filter { manager.getGlanceIds(it.javaClass).isNotEmpty() }
        if (placed.isEmpty()) return
        val now = System.currentTimeMillis()
        // The clock goes into each widget's state: a session still open from the last draw recomposes at it.
        for (widget in placed) {
            for (id in manager.getGlanceIds(widget.javaClass)) {
                updateAppWidgetState(context, id) { it[WIDGET_TICK] = now }
                widget.update(context, id)
            }
        }
        val app = context.applicationContext as StarlingsApp
        val meetings = WidgetStore.agenda(context, app.account)?.meetings.orEmpty()
        enqueue(context, WidgetAgenda.nextRefresh(now, meetings) - now, ExistingWorkPolicy.APPEND_OR_REPLACE)
    }

    /**
     * Signing in or out redraws the widgets; signing out deletes the
     * agenda first, so the next owner never sees it. Called once, from
     * `StarlingsApp.onCreate`.
     */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun watch(app: StarlingsApp) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        scope.launch {
            app.accounts.flatMapLatest { it.account }
                .distinctUntilChanged { a, b -> (a is Account.SignedIn) == (b is Account.SignedIn) }.drop(1).collect { state ->
                    if (state !is Account.SignedIn) WidgetStore.clear(app)
                    now(app)
                }
        }
        // Another workspace: the agenda was the old one's, so it goes before the new one is drawn.
        scope.launch {
            app.accounts.drop(1).collect {
                WidgetStore.clear(app)
                now(app)
            }
        }
    }
}

class WidgetRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        WidgetRefresh.run(applicationContext)
        return Result.success()
    }
}
