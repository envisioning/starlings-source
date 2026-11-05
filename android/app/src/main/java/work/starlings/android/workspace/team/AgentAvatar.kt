package work.starlings.android.workspace.team

import android.graphics.Matrix
import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.vector.toPath
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import work.starlings.android.ui.Starlings
import work.starlings.contracts.AgentAvatarIdentityWire

/**
 * `AgentAvatarImage` of `iOS/MobileAvatars.swift`: an agent's seeded
 * identity, drawn from the Worker's canonical paths so every client shows
 * one body silhouette and one white eye pose. Depth is a soft cast shadow
 * under a flat colour. Decorative: the row says who it is.
 */
@Composable
fun AgentAvatarImage(identity: AgentAvatarIdentityWire, modifier: Modifier = Modifier, diameter: Dp = 40.dp) {
    val c = Starlings.colors
    val body = remember(identity.bodyPath) { AgentAvatarGeometry.nodes(identity.bodyPath) }
    val eyes = remember(identity.eyesPath) { AgentAvatarGeometry.nodes(identity.eyesPath) }
    val color = remember(identity.color) { AgentAvatarGeometry.color(identity.color) }
    Box(
        modifier
            .size(diameter)
            .background(c.elevated, CircleShape)
            .border(0.5.dp, c.border, CircleShape)
            .clearAndSetSemantics { },
    ) {
        Canvas(Modifier.size(diameter)) {
            val shape = body ?: return@Canvas
            val fill = color ?: return@Canvas
            val fit = AgentAvatarGeometry.fit(size.minDimension)
            val matrix = Matrix().apply {
                setScale(fit.scale, fit.scale)
                postTranslate(fit.offset, fit.offset)
            }
            val radius = maxOf(1.dp.toPx(), diameter.toPx() * 0.045f)
            val bodyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                this.color = fill.toInt()
                setShadowLayer(radius, 0f, 2.dp.toPx(), android.graphics.Color.argb(46, 0, 0, 0))
            }
            val eyePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = android.graphics.Color.WHITE }
            drawIntoCanvas { canvas ->
                val bodyPath = shape.toPath().asAndroidPath().apply { transform(matrix) }
                canvas.nativeCanvas.drawPath(bodyPath, bodyPaint)
                eyes?.let { canvas.nativeCanvas.drawPath(it.toPath().asAndroidPath().apply { transform(matrix) }, eyePaint) }
            }
        }
    }
}
