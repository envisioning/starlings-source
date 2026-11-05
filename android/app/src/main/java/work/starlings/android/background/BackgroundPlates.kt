package work.starlings.android.background

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * `BackgroundGalleryRenderer`: a gallery entry drawn into a plate bitmap,
 * base colour first, then the generator's cells in the module colour at each
 * cell's opacity. The flock's cells are dots; the others are rectangles.
 */
object BackgroundGalleryRenderer {
    fun bitmap(choice: BackgroundChoice, pair: TonePair, seed: Int, width: Int, height: Int): Bitmap {
        val w = max(width, 2)
        val h = max(height, 2)
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(opaque(pair.base))
        val dots = choice.generator == BackgroundGenerator.FLOCK
        val paint = Paint().apply { isAntiAlias = dots; style = Paint.Style.FILL }
        val rect = RectF()
        for (cell in GalleryField.cells(choice.generator, w, h, seed)) {
            paint.color = opaque(pair.modules)
            paint.alpha = (cell.alpha.coerceIn(0.0, 1.0) * 255).roundToInt()
            rect.set(cell.x.toFloat(), cell.y.toFloat(), (cell.x + cell.width).toFloat(), (cell.y + cell.height).toFloat())
            if (dots) canvas.drawOval(rect, paint) else canvas.drawRect(rect, paint)
        }
        return bitmap
    }

    private fun opaque(rgb: Int): Int = rgb or (0xFF shl 24)
}

/**
 * Your own picture, behind you: `CustomBackgroundStore`.
 *
 * Kept in this app's storage (`files/background.png`) and nowhere else. The
 * room only sees finished frames, a background is often a picture of
 * somebody's home, and a guest has no account to keep it against. One slot:
 * a new picture replaces the old one. The file is re-encoded as PNG at most
 * [MAX_WIDTH] wide, so nothing from the original (EXIF, GPS) is kept.
 */
class CustomBackgroundStore(context: Context) {
    private val app = context.applicationContext
    private val file = File(app.filesDir, "background.png")

    sealed class Failure(val messageRes: Int) : Exception() {
        class TooLarge : Failure(work.starlings.android.R.string.background_error_too_large)
        class Unreadable : Failure(work.starlings.android.R.string.background_error_unreadable)
        class CouldNotStore : Failure(work.starlings.android.R.string.background_error_store)
    }

    val hasImage: Boolean get() = file.exists()

    /** The picture this device holds, or null. No picture is a state, not a failure. */
    fun load(): Bitmap? = if (file.exists()) BitmapFactory.decodeFile(file.path) else null

    fun clear() {
        file.delete()
    }

    /** Decode, scale and keep one picture. Call off the main thread. */
    fun save(uri: Uri) {
        val resolver = app.contentResolver
        val type = resolver.getType(uri)
        if (type != null && type !in ALLOWED_TYPES) throw Failure.Unreadable()
        val size = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
            }
        }.getOrNull()
        if (size != null && size > MAX_BYTES) throw Failure.TooLarge()
        val bitmap = try {
            // Downsampled while decoding, so the full photo is never in memory.
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                val longest = max(info.size.width, info.size.height)
                val bound = max(MAX_WIDTH, MAX_HEIGHT)
                if (longest > bound) {
                    val scale = bound.toDouble() / longest
                    decoder.setTargetSize(
                        max(1, (info.size.width * scale).roundToInt()),
                        max(1, (info.size.height * scale).roundToInt()),
                    )
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } catch (e: Exception) {
            throw Failure.Unreadable()
        }
        val partial = File(app.filesDir, "background.png.partial")
        val written = runCatching {
            partial.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }.getOrDefault(false)
        if (!written || !partial.renameTo(file)) {
            partial.delete()
            throw Failure.CouldNotStore()
        }
    }

    companion object {
        /** `customBackgroundMaxWidth` / `MaxHeight` / `MaxBytes` in `fixtures/shared-constants.json`. */
        const val MAX_WIDTH = 1280
        const val MAX_HEIGHT = 720
        const val MAX_BYTES = 12_582_912L

        /** PNG, JPEG, HEIC and WebP, as iOS `allowedTypes`. */
        val ALLOWED_TYPES = setOf("image/png", "image/jpeg", "image/heic", "image/heif", "image/webp")
    }
}
