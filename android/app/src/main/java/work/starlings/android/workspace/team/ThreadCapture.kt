package work.starlings.android.workspace.team

import androidx.compose.ui.platform.LocalView
import work.starlings.android.ui.HapticWhenSet
import work.starlings.android.ui.Haptic
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.media.MediaRecorder
import android.net.Uri
import android.os.SystemClock
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import work.starlings.android.R
import work.starlings.android.ui.SheetHeader
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import java.io.File
import java.util.UUID

/*
 * What the composer's + can make on the phone itself, as
 * `iOS/MobileComposerCapture.swift`: a photo or a clip from the camera
 * and a voice message. Each hands back bytes the thread stages like any other file.
 * The files live in cache/capture/ only until they are read.
 *
 * iOS transcribes a voice message on the device and puts the words in the
 * draft. Android has no on-device transcription yet, so the message is the
 * audio alone.
 */

/** One captured file, as `ComposerCapture`. */
class ComposerCapture(val name: String, val contentType: String, val data: ByteArray, val width: Long? = null, val height: Long? = null)

internal object CaptureFiles {
    private fun dir(context: Context) = File(context.cacheDir, "capture").apply { mkdirs() }

    fun create(context: Context, extension: String): File = File(dir(context), "${UUID.randomUUID()}.$extension")

    /** Shared with the camera app through the app's one FileProvider (`res/xml/shared_files.xml`). */
    fun uri(context: Context, file: File): Uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)

    /** Read whole, then gone. Null when nothing was written or it is over the attachment cap. */
    suspend fun take(file: File): ByteArray? = withContext(Dispatchers.IO) {
        try {
            if (!file.exists() || file.length() == 0L || file.length() > TeamMedia.ATTACHMENT_MAX_BYTES) null else file.readBytes()
        } finally {
            file.delete()
        }
    }
}

/** `CameraCapture.isAvailable`. */
fun hasCamera(context: Context): Boolean = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

/**
 * The system camera for a still, returned as the JPEG it wrote. The app
 * declares CAMERA (calls), so Android asks for it before the camera app opens.
 * Call the returned function to start.
 */
@Composable
fun rememberCameraCapture(onCapture: (ComposerCapture) -> Unit, onError: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val cameraOff = stringResource(R.string.thread_camera_off)
    var pending by remember { mutableStateOf<File?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val file = pending ?: return@rememberLauncherForActivityResult
        pending = null
        scope.launch {
            val data = CaptureFiles.take(file)
            if (!saved || data == null) return@launch
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
            val measured = bounds.outWidth > 0 && bounds.outHeight > 0
            onCapture(
                ComposerCapture(
                    "photo.jpg", "image/jpeg", data,
                    if (measured) bounds.outWidth.toLong() else null,
                    if (measured) bounds.outHeight.toLong() else null,
                ),
            )
        }
    }
    fun open() {
        val file = CaptureFiles.create(context, "jpg")
        pending = file
        camera.launch(CaptureFiles.uri(context, file))
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) open() else onError(cameraOff)
    }
    return {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) open()
        else permission.launch(Manifest.permission.CAMERA)
    }
}

/**
 * The clip half of iOS `CameraCapture`: `UIImagePickerController` with
 * `videoQuality = .typeHigh` and its default ten-minute
 * `videoMaximumDuration`. The attachment cap bounds the file, so the camera
 * stops at 25 MB instead of the upload refusing it. iOS sends the QuickTime
 * the camera wrote; an Android camera writes MPEG-4, which goes as it is,
 * with no second pass.
 */
internal object CameraClip {
    const val MAX_SECONDS = 600
    /** `MediaStore.EXTRA_VIDEO_QUALITY`: 1 is high. */
    const val QUALITY_HIGH = 1
    const val MAX_BYTES = TeamMedia.ATTACHMENT_MAX_BYTES
    const val NAME = "video.mp4"
    const val CONTENT_TYPE = "video/mp4"

    fun capture(data: ByteArray) = ComposerCapture(NAME, CONTENT_TYPE, data)
}

/** `CaptureVideo` with the iOS limits on the intent. */
private class RecordClip : ActivityResultContracts.CaptureVideo() {
    override fun createIntent(context: Context, input: Uri): Intent =
        super.createIntent(context, input)
            .putExtra(MediaStore.EXTRA_DURATION_LIMIT, CameraClip.MAX_SECONDS)
            .putExtra(MediaStore.EXTRA_SIZE_LIMIT, CameraClip.MAX_BYTES)
            .putExtra(MediaStore.EXTRA_VIDEO_QUALITY, CameraClip.QUALITY_HIGH)
}

/**
 * The system camera for a clip, returned as the MPEG-4 it wrote. The same
 * CAMERA rule as a still. Android splits the camera's photo and video
 * intents, so the composer's + has Camera and Video where iOS has one
 * "Take photo or video".
 */
@Composable
fun rememberVideoCapture(onCapture: (ComposerCapture) -> Unit, onError: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val cameraOff = stringResource(R.string.thread_camera_off)
    var pending by remember { mutableStateOf<File?>(null) }
    val camera = rememberLauncherForActivityResult(RecordClip()) { saved ->
        val file = pending ?: return@rememberLauncherForActivityResult
        pending = null
        scope.launch {
            val data = CaptureFiles.take(file)
            if (saved && data != null) onCapture(CameraClip.capture(data))
        }
    }
    fun open() {
        val file = CaptureFiles.create(context, "mp4")
        pending = file
        camera.launch(CaptureFiles.uri(context, file))
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) open() else onError(cameraOff)
    }
    return {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) open()
        else permission.launch(Manifest.permission.CAMERA)
    }
}

/** `VoiceMemoRecorder`: AAC in MPEG-4, mono, 44.1 kHz, as iOS records it. */
private class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    var startedAt = 0L
        private set

    val isRecording: Boolean get() = recorder != null

    fun start() {
        val target = CaptureFiles.create(context, "m4a")
        val media = MediaRecorder(context)
        try {
            media.setAudioSource(MediaRecorder.AudioSource.MIC)
            media.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            media.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            media.setAudioSamplingRate(44_100)
            media.setAudioChannels(1)
            media.setAudioEncodingBitRate(128_000)
            media.setOutputFile(target)
            media.prepare()
            media.start()
        } catch (e: Exception) {
            media.release()
            target.delete()
            throw e
        }
        recorder = media
        file = target
        startedAt = SystemClock.elapsedRealtime()
    }

    /** The recording, or null when it was too short to hold anything. */
    suspend fun stop(): ByteArray? {
        val media = recorder ?: return null
        val target = file
        recorder = null
        file = null
        val finished = runCatching { media.stop() }.isSuccess
        media.release()
        if (target == null) return null
        if (!finished) {
            target.delete()
            return null
        }
        return CaptureFiles.take(target)
    }

    fun cancel() {
        recorder?.let { media ->
            runCatching { media.stop() }
            media.release()
        }
        recorder = null
        file?.delete()
        file = null
    }
}

/** `VoiceMemoSheet`: recording starts as it opens; the one big button stops it and stages the audio. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceMemoSheet(onCapture: (ComposerCapture) -> Unit, onDismiss: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val recorder = remember { VoiceRecorder(context.applicationContext) }
    var recording by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    HapticWhenSet(Haptic.ERROR, failure)
    var elapsed by remember { mutableLongStateOf(0L) }
    val micOff = stringResource(R.string.thread_microphone_off)
    val failed = stringResource(R.string.thread_recording_failed)

    fun begin() {
        failure = null
        try {
            recorder.start()
            elapsed = 0
            recording = true
            Haptic.TOGGLE.play(view)
        } catch (_: Exception) {
            failure = failed
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) begin() else failure = micOff
    }
    fun start() {
        if (recording) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) begin()
        else permission.launch(Manifest.permission.RECORD_AUDIO)
    }
    fun finish() {
        recording = false
        Haptic.DESTRUCTIVE.play(view)
        scope.launch {
            val data = recorder.stop()
            if (data == null) {
                failure = failed
                return@launch
            }
            onCapture(ComposerCapture("voice.m4a", "audio/mp4", data))
            onDismiss()
        }
    }
    fun close() {
        recorder.cancel()
        recording = false
        onDismiss()
    }

    LaunchedEffect(Unit) { start() }
    LaunchedEffect(recording) {
        while (recording) {
            elapsed = SystemClock.elapsedRealtime() - recorder.startedAt
            delay(250)
        }
    }
    DisposableEffect(Unit) { onDispose { recorder.cancel() } }

    // A swipe does not throw a recording away: Close does (`interactiveDismissDisabled`).
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { it != SheetValue.Hidden || !recorder.isRecording })
    ModalBottomSheet(onDismissRequest = { if (!recorder.isRecording) close() }, sheetState = sheet, containerColor = c.canvas) {
        SheetHeader(stringResource(R.string.thread_voice_message), stringResource(R.string.close), ::close)
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            val seconds = elapsed / 1000
            Text(
                "%d:%02d".format(seconds / 60, seconds % 60),
                style = StarlingsType.body.copy(fontSize = 44.sp, fontWeight = FontWeight.Light, fontFeatureSettings = "tnum"),
                color = c.primary,
            )
            val label = stringResource(if (recording) R.string.thread_stop else R.string.thread_record)
            Box(
                Modifier
                    .size(76.dp)
                    .background(if (recording) c.danger else c.accent, CircleShape)
                    .clickable(role = Role.Button) { if (recording) finish() else start() }
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Icon(if (recording) Icons.Filled.Stop else Icons.Filled.Mic, null, Modifier.size(32.dp), tint = c.accentInk)
            }
            failure?.let { Text(it, style = StarlingsType.footnote, color = c.danger) }
        }
    }
}
