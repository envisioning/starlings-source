package work.starlings.android.workspace.calendar

import android.Manifest
import android.content.Intent
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

/**
 * The calendar prompt, where iOS puts EventKit's full-access one: the first read with
 * Include local calendars on and access never decided asks, on whichever
 * screen reads (the Calendar tab, its Calendars sheet, Settings › Calendar).
 * It asks `READ_CALENDAR` and `WRITE_CALENDAR` together: one permission
 * group, so one system dialog, as iOS asks once for read and write.
 * Nothing asks while the switch is off. Coming back to the app reads access
 * again, so a grant made in system Settings shows at once. While access is
 * granted, a change another app makes to the phone's calendars reads the
 * week again (`EKEventStoreChanged`).
 */
@Composable
fun rememberDeviceCalendarAccess(store: CalendarStore) {
    val context = LocalContext.current
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { store.noteDeviceAccessAnswered() }
    val needsPrompt = store.needsDeviceAccessPrompt
    LaunchedEffect(needsPrompt) {
        if (needsPrompt) ask.launch(arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR))
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, store) {
        val watch = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && store.includesLocalCalendars && store.deviceAccess != DeviceCalendars.Access.GRANTED) {
                store.reload(force = true)
            }
        }
        lifecycle.addObserver(watch)
        onDispose { lifecycle.removeObserver(watch) }
    }
    val watching = store.includesLocalCalendars && store.deviceAccess == DeviceCalendars.Access.GRANTED
    DisposableEffect(watching, store) {
        val resolver = context.contentResolver
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) = store.reload()
        }
        if (watching) resolver.registerContentObserver(CalendarContract.CONTENT_URI, true, observer)
        onDispose { if (watching) resolver.unregisterContentObserver(observer) }
    }
}

/** `Allow calendar access in Settings`: this app's page in system Settings. */
fun openAppSettings(context: android.content.Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
}
