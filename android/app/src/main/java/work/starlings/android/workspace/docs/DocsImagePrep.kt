package work.starlings.android.workspace.docs

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * DocsKit's `DocsImagePrep` ( slice 2): what an image becomes
 * before it goes to Docs. Docs takes PNG, JPEG, WebP or GIF up to
 * [MAX_BYTES] and has no image service, so the device does the work. A PNG
 * or JPEG that is small enough goes as it is, so a screenshot of text stays
 * a sharp PNG. Anything else the platform reads (HEIC from the camera, WebP,
 * GIF) is decoded with its orientation, brought to [MAX_PIXELS] on the long
 * edge and sent as JPEG at 0.85.
 */
object DocsImagePrep {
    /** `IMAGE_MAX_BYTES` in envisioning/docs. */
    const val MAX_BYTES = 10 * 1024 * 1024
    const val MAX_PIXELS = 2560
    /** `kCGImageDestinationLossyCompressionQuality: 0.85`. */
    const val JPEG_QUALITY = 85

    /** A file read from the phone larger than this is not read at all: it would not fit after any re-encode. */
    const val MAX_INPUT_BYTES = 4 * MAX_BYTES

    class Prepared(val data: ByteArray, val contentType: String)

    /** `DocsImagePrep.Failure`. Errors stay English (AGENTS.md), as DocsKit words them. */
    class Failure(message: String) : Exception(message) {
        companion object {
            const val UNREADABLE = "That file is not an image."
            const val TOO_LARGE = "That image is too large."
        }
    }

    /** What happens to one image, from its measured type, size and byte count. */
    sealed interface Plan {
        /** Sent as it is, with this content type. */
        data class Keep(val contentType: String) : Plan

        /** Decoded, scaled to [width] by [height] and sent as JPEG. */
        data class Jpeg(val width: Int, val height: Int) : Plan
    }

    private val passthrough = mapOf("image/png" to "image/png", "image/jpeg" to "image/jpeg")

    /** The plan for an image the platform measured; null when it could not measure it (not an image). */
    fun plan(mimeType: String?, width: Int, height: Int, byteCount: Int): Plan? {
        if (mimeType == null || width <= 0 || height <= 0) return null
        val keep = passthrough[mimeType.lowercase()]
        if (keep != null && max(width, height) <= MAX_PIXELS && byteCount <= MAX_BYTES) return Plan.Keep(keep)
        val (w, h) = fit(width, height)
        return Plan.Jpeg(w, h)
    }

    /** The long edge brought to [MAX_PIXELS], the aspect kept. Never upscales. */
    fun fit(width: Int, height: Int): Pair<Int, Int> {
        val edge = max(width, height)
        if (edge <= MAX_PIXELS) return width to height
        val scale = MAX_PIXELS.toDouble() / edge
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }

    /** `prepare`: throws [Failure] for a file that is not an image or too large after encoding. */
    fun prepare(data: ByteArray): Prepared {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        return when (val plan = plan(bounds.outMimeType, bounds.outWidth, bounds.outHeight, data.size)) {
            null -> throw Failure(Failure.UNREADABLE)
            is Plan.Keep -> Prepared(data, plan.contentType)
            is Plan.Jpeg -> {
                // ImageDecoder applies the EXIF orientation as it decodes; the size it
                // reports is the one it scales from, so the fit is taken from it.
                val bitmap = try {
                    ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(data))) { decoder, info, _ ->
                        val (w, h) = fit(info.size.width, info.size.height)
                        decoder.setTargetSize(w, h)
                        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    }
                } catch (e: Exception) {
                    throw Failure(Failure.UNREADABLE)
                }
                val out = ByteArrayOutputStream()
                val written = bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                bitmap.recycle()
                if (!written) throw Failure(Failure.UNREADABLE)
                if (out.size() > MAX_BYTES) throw Failure(Failure.TOO_LARGE)
                Prepared(out.toByteArray(), "image/jpeg")
            }
        }
    }
}
