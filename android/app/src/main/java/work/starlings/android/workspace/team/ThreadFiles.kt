package work.starlings.android.workspace.team

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.contracts.ThreadMessageAttachment

/*
 * Files in a conversation, as `AttachmentView`, `attachmentTray` and the
 * composer's + menu of `iOS/MobileThreadView.swift` (Camera and Voice
 * message are `ThreadCapture.kt`). A picture is drawn;
 * anything else is named and sized. A tap saves the file to Downloads and
 * opens it in the app Android picks for its type.
 */

private val ThreadMessageAttachment.isImage: Boolean get() = contentType.startsWith("image/")

/** The box the uploader measured, so the transcript does not reflow as each picture lands. */
private val ThreadMessageAttachment.ratio: Float
    get() {
        val w = width ?: 0
        val h = height ?: 0
        return if (w > 0 && h > 0) w.toFloat() / h.toFloat() else 4f / 3f
    }

/** Decoded no larger than [edge] on its long side: a 25 MB photo is not drawn at full size in a bubble. Docs draws its screenshots with it too. */
internal fun decodeImage(bytes: ByteArray, edge: Int = 1024): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= edge) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}

@Composable
fun AttachmentView(file: ThreadMessageAttachment, store: ThreadStore, onError: (String) -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val open: () -> Unit = {
        scope.launch {
            try {
                val bytes = store.attachmentData(file)
                saveAndOpen(context, file, bytes)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onError(e.teamMessage())
            }
        }
    }
    val label = file.name
    if (file.isImage) {
        val picture by produceState<ImageBitmap?>(store.pictures.get(file.id), file.id) {
            if (value != null) return@produceState
            val bytes = runCatching { store.attachmentData(file) }.getOrNull() ?: return@produceState
            value = withContext(Dispatchers.Default) { decodeImage(bytes) }?.also { store.pictures.put(file.id, it) }
        }
        val shape = RoundedCornerShape(StarlingsRadius.card)
        Box(
            Modifier
                .padding(vertical = 2.dp)
                .widthIn(max = 260.dp)
                .fillMaxWidth()
                .aspectRatio(file.ratio)
                .clip(shape)
                .background(c.secondary.copy(alpha = 0.1f))
                .clickable(role = Role.Image, onClick = open)
                .clearAndSetSemantics { contentDescription = label; role = Role.Image },
        ) {
            picture?.let { Image(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
        }
    } else {
        val size = Formatter.formatShortFileSize(context, file.bytes)
        Row(
            Modifier
                .padding(vertical = 2.dp)
                .heightIn(min = 32.dp)
                .clickable(role = Role.Button, onClick = open)
                .clearAndSetSemantics { contentDescription = "$label, $size"; role = Role.Button },
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.AutoMirrored.Filled.InsertDriveFile, null, Modifier.size(14.dp), tint = c.secondary)
            Text("${file.name} · $size", style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * Into Downloads/Starlings (MediaStore needs no permission from Android 10),
 * then the viewer for its type. A file with no viewer stays in Downloads.
 */
private suspend fun saveAndOpen(context: Context, file: ThreadMessageAttachment, bytes: ByteArray) {
    val resolver = context.contentResolver
    val uri = withContext(Dispatchers.IO) {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
            put(MediaStore.MediaColumns.MIME_TYPE, file.contentType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Starlings")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Couldn’t save that file")
        resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("Couldn’t save that file")
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        uri
    }
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, file.contentType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(view)
    } catch (_: ActivityNotFoundException) {
        error("Saved to Downloads. No app here opens this kind of file.")
    }
}

/** What is about to be sent, each removable, and the uploads still running. */
@Composable
fun AttachmentTray(store: ThreadStore) {
    if (store.pending.isEmpty() && store.uploading == 0) return
    val c = Starlings.colors
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        store.pending.forEach { file ->
            val label = stringResource(R.string.thread_remove_file, file.name)
            val shape = RoundedCornerShape(StarlingsRadius.control)
            Row(
                Modifier
                    .heightIn(min = 32.dp)
                    .background(c.elevated, shape)
                    .border(1.dp, c.border, shape)
                    .clickable(role = Role.Button) { store.drop(file) }
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Cancel, null, Modifier.size(14.dp), tint = c.secondary)
                Text(file.name, style = StarlingsType.caption, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp))
            }
        }
        if (store.uploading > 0) Text(stringResource(R.string.thread_uploading), style = StarlingsType.caption, color = c.secondary)
    }
}

/** A picked file, read whole, as the composer stages it. */
private data class Picked(val name: String, val contentType: String, val data: ByteArray, val width: Long?, val height: Long?)

private suspend fun read(context: Context, uri: Uri): Picked = withContext(Dispatchers.IO) {
    val resolver = context.contentResolver
    var name = "file"
    var size = -1L
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            cursor.getString(0)?.let { name = it }
            if (!cursor.isNull(1)) size = cursor.getLong(1)
        }
    }
    if (size > TeamMedia.ATTACHMENT_MAX_BYTES) error("That file is over 25 MB")
    val data = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("Couldn’t read that file")
    if (data.size > TeamMedia.ATTACHMENT_MAX_BYTES) error("That file is over 25 MB")
    val type = resolver.getType(uri) ?: "application/octet-stream"
    var width: Long? = null
    var height: Long? = null
    if (type.startsWith("image/")) {
        // Measured so a transcript reserves the right box before the bytes come back.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        if (bounds.outWidth > 0 && bounds.outHeight > 0) { width = bounds.outWidth.toLong(); height = bounds.outHeight.toLong() }
    }
    Picked(name, type, data, width, height)
}

/**
 * The composer's +: everything a message can carry. [onPaste] is the agent
 * DM's Paste and send, first so a press-and-release lands on it; null hides it.
 */
@Composable
fun AttachButton(store: ThreadStore, onPaste: (() -> Unit)?, onError: (String) -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    fun stage(uris: List<Uri>) {
        scope.launch {
            for (uri in uris.take(10)) {
                val picked = try {
                    read(context, uri)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    onError(e.message ?: "Couldn’t read that file")
                    continue
                }
                store.attach(picked.name, picked.contentType, picked.data, picked.width, picked.height)
            }
        }
    }
    fun stageCapture(capture: ComposerCapture) {
        scope.launch { store.attach(capture.name, capture.contentType, capture.data, capture.width, capture.height) }
    }
    var voice by remember { mutableStateOf(false) }
    val camera = rememberCameraCapture(::stageCapture, onError)
    val video = rememberVideoCapture(::stageCapture, onError)
    val canPhotograph = remember(context) { hasCamera(context) }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { stage(it) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { stage(it) }
    val label = stringResource(R.string.thread_attach)
    Box {
        Box(
            Modifier
                .size(32.dp)
                .background(c.panel, CircleShape)
                .border(1.dp, c.border, CircleShape)
                .clickable(role = Role.Button) { menu = true }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) { Icon(Icons.Filled.Add, null, Modifier.size(18.dp), tint = c.secondary) }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (onPaste != null) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.thread_paste_and_send)) },
                    leadingIcon = { Icon(Icons.Filled.ContentPaste, null) },
                    onClick = { menu = false; onPaste() },
                )
                HorizontalDivider(color = c.border)
            }
            if (canPhotograph) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.thread_camera)) },
                    leadingIcon = { Icon(Icons.Filled.PhotoCamera, null) },
                    onClick = { menu = false; camera() },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.thread_video)) },
                    leadingIcon = { Icon(Icons.Filled.Videocam, null) },
                    onClick = { menu = false; video() },
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.thread_photo_library)) },
                leadingIcon = { Icon(Icons.Filled.PhotoLibrary, null) },
                onClick = { menu = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.thread_files)) },
                leadingIcon = { Icon(Icons.Filled.Folder, null) },
                onClick = { menu = false; files.launch(arrayOf("*/*")) },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.thread_voice_message)) },
                leadingIcon = { Icon(Icons.Filled.Mic, null) },
                onClick = { menu = false; voice = true },
            )
        }
    }
    if (voice) VoiceMemoSheet(::stageCapture) { voice = false }
}
