package work.starlings.android.workspace.docs

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.util.LruCache
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.mimeTypes
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import work.starlings.android.R
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.android.workspace.team.decodeImage

// Link saves: DocsUI's `LinkHeader`, `LinkCoverImage`,
// `DocsRemoteImage`, `DocumentImagesStrip` and `DocumentImagePreview`. The
// pictures are the copies Docs keeps, fetched with the owner's token;
// nothing here calls the site.

/** `DocsImageCache`: decoded pictures for the session, by key, within a byte budget. */
private object DocsImageCache {
    private const val BUDGET_BYTES = 48 * 1024 * 1024
    val shared = object : LruCache<String, ImageBitmap>(BUDGET_BYTES) {
        override fun sizeOf(key: String, value: ImageBitmap): Int = value.asAndroidBitmap().byteCount
    }
}

/** Where a picture is cached: the cover, or one screenshot, at a draw size. */
internal object DocsImageKeys {
    fun cover(documentId: String) = "cover:$documentId"
    fun image(imageId: String) = "image:$imageId"
}

/** A thumbnail is drawn small; the preview larger. Each size decodes once. */
private const val THUMB_EDGE = 512
private const val LARGE_EDGE = 2048

/**
 * `DocsRemoteImage`: a picture Docs holds, loaded once per [key] and kept
 * for the session. Fills its frame; the caller sizes and clips it. Until it
 * loads, or when it does not, it is the [symbol] on the elevated rung.
 */
@Composable
private fun DocsRemoteImage(
    key: String,
    symbol: ImageVector,
    modifier: Modifier = Modifier,
    edge: Int = THUMB_EDGE,
    contentScale: ContentScale = ContentScale.Crop,
    load: suspend () -> ByteArray?,
) {
    val c = Starlings.colors
    val cacheKey = "$key@$edge"
    var image by remember(cacheKey) { mutableStateOf(DocsImageCache.shared.get(cacheKey)) }
    LaunchedEffect(cacheKey) {
        if (image != null) return@LaunchedEffect
        val bytes = try { load() } catch (e: CancellationException) { throw e } catch (_: Exception) { null } ?: return@LaunchedEffect
        val decoded = withContext(Dispatchers.Default) { runCatching { decodeImage(bytes, edge) }.getOrNull() } ?: return@LaunchedEffect
        DocsImageCache.shared.put(cacheKey, decoded)
        image = decoded
    }
    Box(modifier.background(c.elevated), contentAlignment = Alignment.Center) {
        val shown = image
        if (shown != null) {
            // Decorative here: the caller labels the picture.
            Image(shown, null, Modifier.fillMaxSize(), contentScale = contentScale)
        } else {
            Icon(symbol, null, Modifier.size(24.dp), tint = c.secondary)
        }
    }
}

/**
 * `LinkCoverImage`: the copy of the page's image Docs keeps, else the first
 * screenshot the person attached, else a quiet link glyph.
 */
@Composable
private fun LinkCoverImage(documentId: String, hasImage: Boolean, firstImageId: String?, data: DocsData, modifier: Modifier) {
    when {
        hasImage -> DocsRemoteImage(DocsImageKeys.cover(documentId), Icons.Outlined.Link, modifier) { data.linkImage(documentId) }
        firstImageId != null -> DocsRemoteImage(DocsImageKeys.image(firstImageId), Icons.Outlined.Link, modifier) {
            data.imageData(documentId, firstImageId)
        }
        else -> DocsRemoteImage("none:$documentId", Icons.Outlined.Link, modifier) { null }
    }
}

/**
 * `LinkHeader`: above a save's notes in the editor. The cover, the site, what
 * the page says it is, why it did not load, and Open. iOS's phone editor
 * offers no Read again (`MobileDocumentEditor` hands DocsUI no refetch), so
 * neither does this.
 */
@Composable
internal fun DocsLinkHeader(document: DocsDocumentDetail, data: DocsData) {
    val c = Starlings.colors
    val uri = LocalUriHandler.current
    val link = document.link ?: return
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        LinkCoverImage(
            document.id, link.hasImage, document.images?.firstOrNull()?.id, data,
            Modifier.size(width = 120.dp, height = 80.dp).clip(RoundedCornerShape(StarlingsRadius.field)),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(link.site, style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold), color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            link.description?.let { Text(it, style = StarlingsType.footnote, color = c.primary, maxLines = 3, overflow = TextOverflow.Ellipsis) }
            if (link.fetchStatus == DocsRules.LINK_FETCH_FAILED) {
                Text(link.fetchError ?: stringResource(R.string.docs_page_failed), style = StarlingsType.caption, color = c.danger)
            }
            Row(
                Modifier
                    .clickable(role = Role.Button) { runCatching { uri.openUri(link.url) } }
                    .padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Decorative: the word beside it says what it does.
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, null, Modifier.size(14.dp), tint = c.accentMark)
                Text(stringResource(R.string.docs_open), style = StarlingsType.footnote, color = c.accentMark)
            }
        }
    }
}

/**
 * `DocumentImagesStrip`: the screenshots on a save, as thumbnails under its
 * header. Add picks images, Paste takes the one on the clipboard, an image
 * dropped on the strip from another app is added, a thumbnail opens large. Every image goes through [DocsImagePrep] first.
 * [onChange] reloads the document after something was added or removed.
 */
@Composable
internal fun DocsImagesStrip(documentId: String, images: List<DocsImage>, data: DocsData, editable: Boolean, onChange: () -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var uploading by remember(documentId) { mutableStateOf(false) }
    var error by remember(documentId) { mutableStateOf<String?>(null) }
    var preview by remember(documentId) { mutableStateOf<DocsImage?>(null) }
    val copyFirst = stringResource(R.string.docs_copy_image_first)

    fun attach(read: suspend () -> List<ByteArray>) {
        scope.launch {
            uploading = true
            error = null
            try {
                for (bytes in read()) {
                    try {
                        val prepared = withContext(Dispatchers.Default) { DocsImagePrep.prepare(bytes) }
                        data.uploadImage(documentId, prepared)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = DocsData.describe(e)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = DocsData.describe(e)
            } finally {
                uploading = false
            }
            onChange()
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isNotEmpty()) attach { uris.map { readImage(context, it) } }
    }
    // A drop from another app: its images, read under the drop's grant.
    val activity = LocalActivity.current
    var dropping by remember(documentId) { mutableStateOf(false) }
    val handleDrop by rememberUpdatedState { event: DragAndDropEvent ->
        val drag = event.toAndroidDragEvent()
        val clip = drag.clipData
        val resolver = context.contentResolver
        val uris = clip?.let { DocsDrop.imageUris((0 until it.itemCount).mapNotNull { i -> it.getItemAt(i).uri }) { uri -> resolver.getType(uri) } }.orEmpty()
        if (uris.isEmpty() || uploading) {
            false
        } else {
            val grant = activity?.requestDragAndDropPermissions(drag)
            attach { try { uris.map { readImage(context, it) } } finally { grant?.release() } }
            true
        }
    }
    val dropTarget = remember(documentId) {
        object : DragAndDropTarget {
            override fun onEntered(event: DragAndDropEvent) { dropping = true }
            override fun onExited(event: DragAndDropEvent) { dropping = false }
            override fun onEnded(event: DragAndDropEvent) { dropping = false }
            override fun onDrop(event: DragAndDropEvent): Boolean {
                dropping = false
                return handleDrop(event)
            }
        }
    }
    fun paste() {
        val uri = clipboardImage(context)
        if (uri == null) {
            error = copyFirst
            return
        }
        attach { listOf(readImage(context, uri)) }
    }

    val dropShape = RoundedCornerShape(StarlingsRadius.field)
    Column(
        Modifier
            .fillMaxWidth()
            .then(
                if (editable) {
                    Modifier.dragAndDropTarget(shouldStartDragAndDrop = { DocsDrop.accepts(it.mimeTypes()) }, target = dropTarget)
                } else {
                    Modifier
                },
            )
            .then(if (dropping) Modifier.border(1.5.dp, c.accentMark, dropShape) else Modifier),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.docs_screenshots), style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
            if (uploading) CircularProgressIndicator(Modifier.size(12.dp), color = c.secondary, strokeWidth = 1.5.dp)
            Spacer(Modifier.weight(1f))
            if (editable) {
                StripButton(Icons.Filled.Add, stringResource(R.string.docs_add), enabled = !uploading) { picker.launch("image/*") }
                StripButton(Icons.Outlined.ContentPaste, stringResource(R.string.docs_paste), enabled = !uploading) { paste() }
            }
        }
        if (images.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val screenshot = stringResource(R.string.docs_screenshot)
                images.forEach { image ->
                    val shape = RoundedCornerShape(StarlingsRadius.field)
                    DocsRemoteImage(
                        DocsImageKeys.image(image.id), Icons.Outlined.Image,
                        Modifier
                            .size(width = 112.dp, height = 72.dp)
                            .clip(shape)
                            .border(1.dp, c.border, shape)
                            .clickable(role = Role.Button) { preview = image }
                            .semantics { contentDescription = image.caption ?: screenshot },
                    ) { data.imageData(documentId, image.id) }
                }
            }
        } else if (editable) {
            Text(stringResource(R.string.docs_images_empty), style = StarlingsType.caption, color = c.secondary)
        }
        error?.let { Text(it, style = StarlingsType.caption, color = c.danger) }
    }

    preview?.let { image ->
        DocsImagePreview(documentId, image, data, editable, onDismiss = { preview = null }) {
            preview = null
            onChange()
        }
    }
}

@Composable
private fun StripButton(icon: ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Decorative: the word beside it says what it does.
        Icon(icon, null, Modifier.size(14.dp), tint = if (enabled) c.accentMark else c.secondary)
        Text(label, style = StarlingsType.footnote, color = if (enabled) c.accentMark else c.secondary)
    }
}

/** `DocumentImagePreview`: one image, large, with Remove on a document the person can edit. */
@Composable
private fun DocsImagePreview(documentId: String, image: DocsImage, data: DocsData, editable: Boolean, onDismiss: () -> Unit, onRemoved: () -> Unit) {
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var removing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().background(c.canvas, RoundedCornerShape(StarlingsRadius.control)).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            DocsRemoteImage(
                DocsImageKeys.image(image.id), Icons.Outlined.Image,
                Modifier.fillMaxWidth().heightIn(min = 160.dp, max = 480.dp).aspectRatio(4f / 3f, matchHeightConstraintsFirst = false)
                    .clip(RoundedCornerShape(StarlingsRadius.control))
                    .semantics { contentDescription = image.caption.orEmpty() },
                edge = LARGE_EDGE, contentScale = ContentScale.Fit,
            ) { data.imageData(documentId, image.id) }
            image.caption?.let { Text(it, style = StarlingsType.footnote, color = c.secondary) }
            error?.let { Text(it, style = StarlingsType.caption, color = c.danger) }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (editable) {
                    BorderedButton(
                        stringResource(R.string.docs_remove),
                        {
                            removing = true
                            scope.launch {
                                try {
                                    data.deleteImage(documentId, image.id)
                                    listOf(THUMB_EDGE, LARGE_EDGE).forEach { DocsImageCache.shared.remove("${DocsImageKeys.image(image.id)}@$it") }
                                    onRemoved()
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    error = DocsData.describe(e)
                                } finally {
                                    removing = false
                                }
                            }
                        },
                        enabled = !removing, compact = true, foreground = c.danger,
                    )
                }
                Spacer(Modifier.weight(1f))
                FilledButton(stringResource(R.string.docs_done), onDismiss, compact = true)
            }
        }
    }
}

/** What a drop on the screenshots strip takes: images only, as DocsUI's image drop. */
internal object DocsDrop {
    /** A drag offers something the strip takes when any of its types is an image. */
    fun accepts(mimeTypes: Collection<String>): Boolean = mimeTypes.any { it.lowercase().startsWith("image/") }

    /** The dropped items that are images, in order; [typeOf] is the resolver's type for one. */
    fun <T> imageUris(items: List<T>, typeOf: (T) -> String?): List<T> =
        items.filter { item -> typeOf(item)?.lowercase()?.startsWith("image/") == true }
}

/** The first image on the clipboard, or null. Android holds a copied picture as a content URI. */
private fun clipboardImage(context: Context): Uri? {
    val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip ?: return null
    val resolver = context.contentResolver
    return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.firstOrNull { resolver.getType(it)?.startsWith("image/") == true }
}

/** The bytes behind [uri], refused past [DocsImagePrep.MAX_INPUT_BYTES] before they are all read. */
private suspend fun readImage(context: Context, uri: Uri): ByteArray = withContext(Dispatchers.IO) {
    val stream = context.contentResolver.openInputStream(uri) ?: throw DocsImagePrep.Failure(DocsImagePrep.Failure.UNREADABLE)
    stream.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > DocsImagePrep.MAX_INPUT_BYTES) throw DocsImagePrep.Failure(DocsImagePrep.Failure.TOO_LARGE)
        }
        out.toByteArray()
    }
}
