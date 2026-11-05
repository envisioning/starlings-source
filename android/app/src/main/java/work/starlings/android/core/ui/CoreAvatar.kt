package work.starlings.android.core.ui

import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import work.starlings.android.core.CoreFields
import work.starlings.android.ui.Starlings
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * core-kit's `CRMRemoteImageCache`: a record's picture by its address, 300
 * in memory and every one on disk (`cacheDir/CRMAvatars/<sha256 of the
 * address>`, as iOS keeps `Caches/CRMAvatars`), so a list draws its faces
 * before the network answers. https only, two megabytes at most, never
 * through a redirect to plain http. A failed load reads as no picture, so
 * the initials stay. Disconnecting Core empties the folder.
 */
internal object CorePictures {
    private const val MAX_BYTES = 2L * 1024 * 1024
    private val memory = LruCache<String, ImageBitmap>(300)
    private val http = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).followSslRedirects(false).build()

    /** Set by [work.starlings.android.core.CoreAccess]; null keeps pictures in memory only. */
    @Volatile var directory: File? = null

    fun cached(url: String): ImageBitmap? = memory.get(url)

    /** `cacheKey(for:)`: the address's SHA-256, in hex. */
    fun key(url: String): String =
        MessageDigest.getInstance("SHA-256").digest(url.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    suspend fun load(url: String): ImageBitmap? {
        if (!CoreFields.secureImage(url)) return null
        memory.get(url)?.let { return it }
        val file = directory?.let { File(it, key(url)) }
        val bitmap = withContext(Dispatchers.IO) {
            file?.takeIf { it.isFile && it.length() in 1..MAX_BYTES }?.let { kept ->
                runCatching { kept.readBytes() }.getOrNull()?.let { decode(it) }
            } ?: runCatching {
                http.newCall(Request.Builder().url(url.trim()).build()).execute().use { response ->
                    val body = response.body ?: return@use null
                    if (!response.isSuccessful || body.contentLength() > MAX_BYTES) return@use null
                    val stream = body.source()
                    stream.request(MAX_BYTES + 1)
                    if (stream.buffer.size > MAX_BYTES) return@use null
                    val bytes = stream.buffer.readByteArray()
                    decode(bytes)?.also { if (file != null) keep(file, bytes) }
                }
            }.getOrNull()
        } ?: return null
        memory.put(url, bitmap)
        return bitmap
    }

    private fun decode(bytes: ByteArray): ImageBitmap? = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()

    /** `data.write(to:options: .atomic)`: a temporary file, then a rename. */
    private fun keep(file: File, bytes: ByteArray) {
        runCatching {
            file.parentFile?.mkdirs()
            val temp = File(file.parentFile, "${file.name}.tmp")
            temp.writeBytes(bytes)
            if (!temp.renameTo(file)) temp.delete()
        }
    }

    /** Forget every picture: on Disconnect and sign-out. */
    fun clear() {
        memory.evictAll()
        directory?.let { dir -> runCatching { dir.listFiles()?.forEach { it.delete() } } }
    }
}

/** `CRMAvatarShape`: a circle, or the app-icon squircle for an organization. */
internal fun coreAvatarShape(entity: String?): Shape =
    if (CoreFields.squareAvatar(entity)) RoundedCornerShape(22) else CircleShape

/**
 * `CachedRemoteAvatar`: the picture over the record's initials, else the
 * entity's mark. Decorative: the row's name says who it is.
 */
@Composable
internal fun CoreAvatar(url: String?, name: String, entity: String?, symbol: String, size: Dp = 40.dp) {
    val c = Starlings.colors
    val shape = coreAvatarShape(entity)
    val picture by produceState(url?.let(CorePictures::cached), url) { value = url?.let { CorePictures.load(it) } }
    val initials = CoreFields.initials(name)
    Box(Modifier.size(size).clip(shape).background(c.elevated, shape).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        val image = picture
        when {
            image != null -> Image(image, null, Modifier.size(size), contentScale = ContentScale.Crop)
            initials.isNotEmpty() -> Text(initials, fontSize = (size.value * 0.34f).sp, fontWeight = FontWeight.SemiBold, color = c.secondary)
            else -> Icon(coreIcon(symbol), null, Modifier.size(size * 0.38f), tint = c.secondary)
        }
    }
}

/** `CachedRemoteImage`: an `image` field's picture, fitted; a plain field until it loads. */
@Composable
internal fun CoreRemoteImage(url: String, modifier: Modifier = Modifier, crop: Boolean = false) {
    val c = Starlings.colors
    val picture by produceState(CorePictures.cached(url), url) { value = CorePictures.load(url) }
    val image = picture
    if (image != null) {
        Image(image, null, modifier, contentScale = if (crop) ContentScale.Crop else ContentScale.Fit)
    } else {
        Box(modifier.background(c.elevated, RoundedCornerShape(8.dp)))
    }
}
