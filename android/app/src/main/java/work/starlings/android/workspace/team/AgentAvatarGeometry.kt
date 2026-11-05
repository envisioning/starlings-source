package work.starlings.android.workspace.team

import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.PathParser
import work.starlings.android.CalendarColors

/**
 * `MeetingPlatformMarkGeometry.agentAvatarPath` and `color(hex:)` of
 * `Sources/MeetingPlatformMarkGeometry.swift`: the Worker's agent body and
 * eyes paths are in a -120..120 view box, drawn into the art rect a 2.5%
 * inset of the circle. Compose's own SVG path reader parses them (every path
 * command, as Swift's `SVGPathParser`), so no SVG library is added.
 */
object AgentAvatarGeometry {
    const val VIEW_BOX_MIN = -120f
    const val VIEW_BOX_SIZE = 240f
    /** `rect.insetBy(dx: width * 0.025, …)`. */
    const val ART_INSET = 0.025f

    /** Scale and offset that put the view box on a square of [side], inset as iOS. */
    data class Fit(val scale: Float, val offset: Float) {
        fun x(value: Float) = offset + value * scale
    }

    fun fit(side: Float): Fit {
        val inset = side * ART_INSET
        val art = side - 2 * inset
        val scale = art / VIEW_BOX_SIZE
        return Fit(scale, inset - VIEW_BOX_MIN * scale)
    }

    /** The path's commands, or null for a path that does not parse (Swift answers nil and draws nothing). */
    fun nodes(data: String): List<PathNode>? {
        if (data.isBlank()) return null
        return runCatching { PathParser().parsePathString(data).toNodes() }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    /** `#rrggbb` as opaque ARGB, or null. */
    fun color(hex: String): Long? = CalendarColors.hex(hex)
}
