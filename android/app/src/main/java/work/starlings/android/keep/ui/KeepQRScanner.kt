package work.starlings.android.keep.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkIconButton
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Getting an `otpauth://` URI in without typing it (core-kit
 * `KeepUI/KeepQRScan.swift`): the camera, or a photo of the code. Both hand
 * back the text and nothing else; the editor decides what it means. ZXing
 * reads the code on the device; no frame and no text leaves it.
 */
internal object KeepQR {
    private val hints = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.TRY_HARDER to true,
    )

    private fun read(source: LuminanceSource): String? {
        val reader = MultiFormatReader().apply { setHints(hints) }
        return try {
            reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text
        } catch (_: NotFoundException) {
            null
        } catch (_: Exception) {
            null
        } finally {
            reader.reset()
        }
    }

    /** A QR code in a picture, or null. Large pictures are scaled down first. */
    fun decode(context: Context, uri: Uri): String? {
        val bitmap = runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val longest = maxOf(info.size.width, info.size.height)
                if (longest > 2048) {
                    val scale = 2048.0 / longest
                    decoder.setTargetSize((info.size.width * scale).toInt(), (info.size.height * scale).toInt())
                }
            }
        }.getOrNull() ?: return null
        return decode(bitmap)
    }

    fun decode(bitmap: Bitmap): String? {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return read(RGBLuminanceSource(bitmap.width, bitmap.height, pixels))
    }

    /** One camera frame: the luminance plane is all a QR needs. */
    fun decode(image: ImageProxy): String? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
        val width = image.width
        val height = image.height
        val stride = plane.rowStride
        if (bytes.size < stride * (height - 1) + width) return null
        return read(PlanarYUVLuminanceSource(bytes, stride, height, 0, 0, width, height, false))
    }
}

/**
 * The camera, looking for a QR (`KeepQRCameraScanner`): a full-screen
 * preview that stops on the first code it reads. The caller has the camera
 * permission already.
 */
@Composable
internal fun KeepQRScanner(onDismiss: () -> Unit, onFound: (String) -> Unit) {
    val c = Starlings.colors
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val delivered = remember { AtomicBoolean(false) }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }

    DisposableEffect(lifecycle) {
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            val bound = runCatching { future.get() }.getOrNull() ?: return@addListener
            provider = bound
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(executor) { frame ->
                val text = frame.use { KeepQR.decode(it) }
                if (text != null && delivered.compareAndSet(false, true)) {
                    ContextCompat.getMainExecutor(context).execute { onFound(text) }
                }
            }
            runCatching {
                bound.unbindAll()
                bound.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            provider?.unbindAll()
            executor.shutdown()
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.canvas)) {
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp)) {
                Box(Modifier.align(Alignment.CenterStart)) { WorkIconButton(Icons.Filled.Close, stringResource(R.string.keep_cancel), onDismiss) }
                Text(stringResource(R.string.keep_scan_title), Modifier.align(Alignment.Center), style = StarlingsType.headline, color = c.primary)
            }
            AndroidView({ previewView }, Modifier.fillMaxSize())
        }
    }
}
