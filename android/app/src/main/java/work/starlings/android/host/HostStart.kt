package work.starlings.android.host

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import work.starlings.android.StarlingsApp
import work.starlings.contracts.MeetingCategoryUpdate

/**
 * Starts hosting a room on this device: Start room on Home (null, "my
 * room"), Join Team Room on Team ([RoomHost.INTERNAL_ROOM]) and Meet about
 * this on a Work subject row or a Search subject row. Hosting
 * opens the microphone without a prejoin, so it asks first; no access, no
 * start.
 */
@Composable
fun rememberHostStarter(): (room: String?) -> Unit {
    val start = rememberHostLauncher()
    return remember(start) { { room -> start(room, null) } }
}

/**
 * Meet about this (`StarlingsAppModel.startRoom(about:)`): the owner's
 * room, filed under the subject the moment the meeting exists.
 */
@Composable
fun rememberSubjectRoomStarter(): (filing: MeetingCategoryUpdate) -> Unit {
    val start = rememberHostLauncher()
    return remember(start) { { filing -> start(null, filing) } }
}

/** The one permission-then-host path behind both starters. */
@Composable
private fun rememberHostLauncher(): (room: String?, filing: MeetingCategoryUpdate?) -> Unit {
    val context = LocalContext.current
    val app = context.applicationContext as StarlingsApp
    // The room and filing asked for while the permission prompt is open.
    val asked = remember { arrayOfNulls<Any>(2) }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) app.startHosting(asked[0] as String?, filing = asked[1] as MeetingCategoryUpdate?)
    }
    return remember(app) {
        { room, filing ->
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                app.startHosting(room, filing = filing)
            } else {
                asked[0] = room
                asked[1] = filing
                askMic.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }
}
