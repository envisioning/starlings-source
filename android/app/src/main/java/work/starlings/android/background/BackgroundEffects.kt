package work.starlings.android.background

import android.content.Context
import android.graphics.Bitmap
import android.util.Size
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.lifecycle.ProcessLifecycleOwner
import io.livekit.android.room.Room
import io.livekit.android.room.track.video.CameraCapturerUtils
import io.livekit.android.track.processing.video.VirtualBackgroundVideoProcessor
import kotlinx.coroutines.Dispatchers
import livekit.org.webrtc.CameraXHelper
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.random.Random

/**
 * Background effects on the camera track: blur, a gallery plate or a picture
 * behind the person, as iOS `MeetingBackgroundEffect.makeProcessor`.
 *
 * Segmentation runs on this device. ML Kit's selfie segmenter
 * (`com.google.mlkit:segmentation-selfie`, bundled, no download) reads the
 * camera through a CameraX `ImageAnalysis` use case, and LiveKit's
 * [VirtualBackgroundVideoProcessor] composites the person over the blur or
 * the plate on the GPU before the encoder. The room, and every other
 * participant, only ever receives the composited frames: no mask, no raw
 * frame and no background picture leaves the phone.
 *
 * The processor exposes no timing, so the call log records which effect is
 * on (`background` event) and not its cost.
 *
 * The camera therefore opens through CameraX: this registers LiveKit's
 * CameraX provider once, bound to the process lifecycle, so every camera
 * track ([io.livekit.android.room.participant.LocalParticipant.createVideoTrack])
 * carries the analysis use case. One processor belongs to one track.
 */
class BackgroundEffects(context: Context) {
    private val app = context.applicationContext
    private val analysisThread = Executors.newSingleThreadExecutor { Thread(it, "background-segmentation") }

    /** Small frames are enough for a mask; the composite stays at camera size. */
    private val analysis = ImageAnalysis.Builder()
        .setResolutionSelector(
            ResolutionSelector.Builder()
                .setResolutionStrategy(ResolutionStrategy(Size(256, 256), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                .build(),
        )
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()

    /** False when CameraX cannot drive this camera: tracks then open without a processor. */
    val supported: Boolean

    init {
        val provider = CameraXHelper.createCameraProvider(ProcessLifecycleOwner.get(), arrayOf(analysis))
        supported = runCatching { provider.isSupported(app) }.getOrDefault(false)
        if (supported) CameraCapturerUtils.registerCameraProvider(provider)
    }

    /** A processor for the next camera track of [room]; the analysis now feeds it. */
    fun makeProcessor(room: Room): VirtualBackgroundVideoProcessor? {
        if (!supported) return null
        val processor = VirtualBackgroundVideoProcessor(room.lkObjects.eglBase, Dispatchers.Default)
        processor.enabled = false
        analysis.setAnalyzer(analysisThread, processor.imageAnalyzer)
        return processor
    }

    fun release(processor: VirtualBackgroundVideoProcessor?) {
        processor ?: return
        processor.enabled = false
        runCatching { processor.dispose() }
    }

    /** None turns the processor off; Blur has no picture; the rest composite over [plate]. */
    fun apply(processor: VirtualBackgroundVideoProcessor?, effect: BackgroundEffect, plate: Bitmap?) {
        processor ?: return
        when (effect) {
            BackgroundEffect.None -> processor.enabled = false
            BackgroundEffect.Blur -> {
                processor.backgroundImage = null
                processor.enabled = true
            }
            else -> {
                processor.backgroundImage = plate
                processor.enabled = plate != null
            }
        }
    }

    /**
     * The plate an effect draws, or null for None and Blur. A gallery entry is
     * drawn fresh from a new seed, at the screen's aspect (the camera frame is
     * upright on the phone), 960 on the long side as iOS. Call off the main thread.
     */
    fun plate(effect: BackgroundEffect, workspace: WorkspaceBackgrounds, custom: CustomBackgroundStore): Bitmap? = when (effect) {
        BackgroundEffect.None, BackgroundEffect.Blur -> null
        BackgroundEffect.CustomImage -> custom.load()
        BackgroundEffect.WorkspaceImage -> workspace.image
        is BackgroundEffect.Generated -> {
            val metrics = app.resources.displayMetrics
            val long = 960
            val short = (long * minOf(metrics.widthPixels, metrics.heightPixels).toDouble() / max(1, maxOf(metrics.widthPixels, metrics.heightPixels))).roundToInt()
            val portrait = metrics.heightPixels >= metrics.widthPixels
            BackgroundGalleryRenderer.bitmap(
                effect.choice,
                workspace.tonePair(effect.choice.tone),
                Random.nextInt(),
                if (portrait) short else long,
                if (portrait) long else short,
            )
        }
    }
}
