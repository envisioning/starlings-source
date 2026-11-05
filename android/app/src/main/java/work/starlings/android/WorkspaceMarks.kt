package work.starlings.android

import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Each listed workspace's mark, once read (`StarlingsWorkspaceStore.marks`
 * and `markData`). Kept for the process, by web origin and mark URL, so a
 * new upload reads again. A failed read is tried again the next time a row
 * asks.
 */
class WorkspaceMarks(private val directory: WorkspaceDirectory, private val scope: CoroutineScope) {
    private val read = mutableStateMapOf<String, ByteArray>()
    private val asked = mutableSetOf<String>()

    private fun key(workspace: StarlingsWorkspace) = "${workspace.webOrigin} ${workspace.markUrl}"

    /** The mark a row draws for [workspace], once read. */
    fun mark(workspace: StarlingsWorkspace): ByteArray? = if (workspace.markUrl == null) null else read[key(workspace)]

    /** Reads [workspace]'s mark when it has one and it is not read yet. */
    fun load(workspace: StarlingsWorkspace) {
        if (workspace.markUrl == null) return
        val key = key(workspace)
        if (key in read || !asked.add(key)) return
        scope.launch {
            val data = directory.markData(workspace)
            if (data != null) read[key] = data else asked.remove(key)
        }
    }
}

/** A mark's bytes as something to draw: the SVG's outline, or the PNG as a template. */
sealed interface WorkspaceMarkPicture {
    data class Vector(val outline: WorkspaceMarkVector.Outline) : WorkspaceMarkPicture
    data class Raster(val image: ImageBitmap) : WorkspaceMarkPicture

    companion object {
        fun of(data: ByteArray): WorkspaceMarkPicture? {
            if (WorkspaceMarkVector.isSvg(data)) {
                WorkspaceMarkVector.outline(data)?.let { return Vector(it) }
            }
            return runCatching { BitmapFactory.decodeByteArray(data, 0, data.size) }.getOrNull()?.let { Raster(it.asImageBitmap()) }
        }
    }
}

/** The picture in one colour, [ink], fitted to a [size] square. */
@Composable
internal fun WorkspaceMarkPictureView(picture: WorkspaceMarkPicture, size: Dp, ink: Color, modifier: Modifier = Modifier) {
    when (picture) {
        is WorkspaceMarkPicture.Raster -> Image(
            picture.image, null, modifier.size(size), contentScale = ContentScale.Fit, colorFilter = ColorFilter.tint(ink),
        )
        is WorkspaceMarkPicture.Vector -> Canvas(modifier.size(size)) {
            drawPath(WorkspaceMarkDrawing.path(picture.outline, this.size.width, this.size.height).asComposePath(), ink)
        }
    }
}

/** The outline as one platform path in a frame, as `WorkspaceMarkVector.path(_:in:)` and the Swift reader build it. */
internal object WorkspaceMarkDrawing {
    fun path(outline: WorkspaceMarkVector.Outline, width: Float, height: Float): Path {
        val result = Path().apply { fillType = if (outline.evenOdd) Path.FillType.EVEN_ODD else Path.FillType.WINDING }
        for (part in outline.parts) {
            val shape = shape(part.shape) ?: continue
            shape.transform(matrix(part.transform))
            val width = part.strokeWidth
            if (width == null) {
                result.addPath(shape)
            } else {
                val stroke = Paint().apply {
                    style = Paint.Style.STROKE
                    strokeWidth = width.toFloat()
                    strokeCap = Paint.Cap.ROUND
                    strokeJoin = Paint.Join.ROUND
                    strokeMiter = 4f
                }
                val outlined = Path()
                stroke.getFillPath(shape, outlined)
                result.addPath(outlined)
            }
        }
        result.transform(matrix(WorkspaceMarkVector.fit(outline.viewBox, width.toDouble(), height.toDouble())))
        return result
    }

    private fun matrix(t: WorkspaceMarkVector.Affine) = Matrix().apply {
        setValues(floatArrayOf(t.a.toFloat(), t.c.toFloat(), t.tx.toFloat(), t.b.toFloat(), t.d.toFloat(), t.ty.toFloat(), 0f, 0f, 1f))
    }

    private fun shape(shape: WorkspaceMarkVector.Shape): Path? = when (shape) {
        is WorkspaceMarkVector.Shape.Path -> runCatching { PathParser().parsePathString(shape.d).toPath().asAndroidPath() }.getOrNull()
        is WorkspaceMarkVector.Shape.Rect -> Path().apply {
            addRoundRect(
                RectF(shape.x.toFloat(), shape.y.toFloat(), (shape.x + shape.width).toFloat(), (shape.y + shape.height).toFloat()),
                shape.rx.toFloat(), shape.ry.toFloat(), Path.Direction.CW,
            )
        }
        is WorkspaceMarkVector.Shape.Ellipse -> Path().apply {
            addOval(
                RectF((shape.cx - shape.rx).toFloat(), (shape.cy - shape.ry).toFloat(), (shape.cx + shape.rx).toFloat(), (shape.cy + shape.ry).toFloat()),
                Path.Direction.CW,
            )
        }
        is WorkspaceMarkVector.Shape.Poly -> Path().apply {
            moveTo(shape.points[0].toFloat(), shape.points[1].toFloat())
            var i = 2
            while (i + 1 < shape.points.size) {
                lineTo(shape.points[i].toFloat(), shape.points[i + 1].toFloat())
                i += 2
            }
            if (shape.closed) close()
        }
        is WorkspaceMarkVector.Shape.Line -> Path().apply {
            moveTo(shape.x1.toFloat(), shape.y1.toFloat())
            lineTo(shape.x2.toFloat(), shape.y2.toFloat())
        }
    }
}
