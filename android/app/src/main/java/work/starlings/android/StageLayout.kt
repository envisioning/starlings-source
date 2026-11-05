package work.starlings.android

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/** A rectangle with a top-left origin, in dp. */
data class StageRect(val x: Float, val y: Float, val width: Float, val height: Float) {
    val maxX get() = x + width
    val maxY get() = y + height
    val midX get() = x + width / 2
    val midY get() = y + height / 2

    fun intersects(o: StageRect) = x < o.maxX && o.x < maxX && y < o.maxY && o.y < maxY
    fun offset(dx: Float, dy: Float) = copy(x = x + dx, y = y + dy)
    fun inset(d: Float) = StageRect(x + d, y + d, width - 2 * d, height - 2 * d)

    companion object {
        val ZERO = StageRect(0f, 0f, 0f, 0f)
    }
}

/**
 * The stage plans of `Sources/StageGridLayout.swift`, which the Mac and iOS
 * stages draw from: an equal square-cell peer grid, and a screen share with
 * a participant rail. The local camera is a separate square inset.
 */
object StageLayout {
    enum class ScreenShareChoice(val wire: String) { AUTOMATIC("automatic"), OVERLAY("overlay"), RAIL("rail") }
    enum class RailMode { NONE, OVERLAY, HORIZONTAL, VERTICAL }

    data class ScreenSharePlan(
        val share: StageRect,
        val rail: StageRect,
        val railContentWidth: Float,
        val railContentHeight: Float,
        val participants: List<StageRect>,
        val railMode: RailMode,
    )

    data class GridPlan(val columns: Int, val rows: Int, val cell: Float)

    private const val OVERLAY_TILE = 76f
    private const val DOCKED_HORIZONTAL_TILE = 76f
    private const val DOCKED_VERTICAL_TILE = 112f
    private const val DOCKED_VERTICAL_RAIL_WIDTH = 144f
    private const val DOCKED_HORIZONTAL_RAIL_HEIGHT = 100f
    private const val MAX_OVERLAY_PARTICIPANTS = 4
    private const val MIN_SHARE_WIDTH_BESIDE_RAIL = 480f

    /** Gap between tiles, as the Mac stage's `tileSpacing`. */
    const val TILE_SPACING = 12f

    /** The local camera's square inset: a fifth of the stage, 76 to 128. */
    fun selfInsetSide(stageWidth: Float): Float = min(max(stageWidth * 0.2f, 76f), 128f)

    /**
     * The square-cell grid shape that gives every tile the most area. The
     * stage shape and head count decide the columns; no camera aspect does.
     */
    fun equalGrid(tileCount: Int, width: Float, height: Float, spacing: Float): GridPlan {
        val count = max(tileCount, 1)
        var best = GridPlan(count, 1, 0f)
        for (columns in 1..count) {
            val rows = ceil(count.toDouble() / columns).toInt()
            val slotW = (width - (columns - 1) * spacing) / columns
            val slotH = (height - (rows - 1) * spacing) / rows
            if (slotW <= 0 || slotH <= 0) continue
            val side = min(slotW, slotH)
            if (side > best.cell) best = GridPlan(columns, rows, side)
        }
        // A stage too small for any grid: one row of the largest cells left.
        if (best.cell <= 0) return GridPlan(count, 1, max(1f, min(width / count, height)))
        return best
    }

    /**
     * A small room's rail floats over the share; a crowded one gets its own
     * edge, beside a landscape share or opposite the local inset. Content
     * past the edge scrolls at a fixed tile size.
     */
    fun screenShare(
        width: Float,
        height: Float,
        participantCount: Int,
        localInset: StageRect? = null,
        choice: ScreenShareChoice = ScreenShareChoice.AUTOMATIC,
        spacing: Float = TILE_SPACING,
    ): ScreenSharePlan {
        val bounds = StageRect(0f, 0f, width, height)
        if (width <= 0 || height <= 0 || participantCount <= 0) {
            return ScreenSharePlan(bounds, StageRect.ZERO, 0f, 0f, emptyList(), RailMode.NONE)
        }
        val tryOverlay = choice == ScreenShareChoice.OVERLAY ||
            (choice == ScreenShareChoice.AUTOMATIC && participantCount <= MAX_OVERLAY_PARTICIPANTS)
        if (tryOverlay && height >= OVERLAY_TILE + spacing) {
            overlay(participantCount, width, height, localInset, spacing, choice == ScreenShareChoice.OVERLAY)?.let { (y, contentWidth, frames) ->
                val railHeight = OVERLAY_TILE + spacing
                return ScreenSharePlan(bounds, StageRect(0f, y, width, railHeight), contentWidth, railHeight, frames, RailMode.OVERLAY)
            }
        }
        val canDockBeside = width >= height * 1.25f &&
            width - DOCKED_VERTICAL_RAIL_WIDTH - spacing >= MIN_SHARE_WIDTH_BESIDE_RAIL
        if (canDockBeside) {
            val railLeading = localInset?.let { it.midX > width * 0.7f } ?: false
            val shareWidth = width - DOCKED_VERTICAL_RAIL_WIDTH - spacing
            val rail = StageRect(if (railLeading) 0f else shareWidth + spacing, 0f, DOCKED_VERTICAL_RAIL_WIDTH, height)
            val share = StageRect(if (railLeading) DOCKED_VERTICAL_RAIL_WIDTH + spacing else 0f, 0f, shareWidth, height)
            val side = min(DOCKED_VERTICAL_TILE, DOCKED_VERTICAL_RAIL_WIDTH - spacing * 2)
            val contentHeight = max(height, participantCount * side + (participantCount + 1) * spacing)
            val frames = (0 until participantCount).map { i ->
                StageRect((DOCKED_VERTICAL_RAIL_WIDTH - side) / 2, spacing + i * (side + spacing), side, side)
            }
            return ScreenSharePlan(share, rail, DOCKED_VERTICAL_RAIL_WIDTH, contentHeight, frames, RailMode.VERTICAL)
        }
        val railHeight = min(DOCKED_HORIZONTAL_RAIL_HEIGHT, max(1f, height - spacing - 1))
        val shareHeight = max(1f, height - railHeight - spacing)
        val railTop = localInset?.let { it.midY > height * 0.7f } ?: false
        val rail = StageRect(0f, if (railTop) 0f else shareHeight + spacing, width, railHeight)
        val share = StageRect(0f, if (railTop) railHeight + spacing else 0f, width, shareHeight)
        val side = max(1f, min(DOCKED_HORIZONTAL_TILE, railHeight - spacing))
        val contentWidth = max(width, participantCount * side + (participantCount + 1) * spacing)
        val frames = (0 until participantCount).map { i ->
            StageRect(spacing + i * (side + spacing), (railHeight - side) / 2, side, side)
        }
        return ScreenSharePlan(share, rail, contentWidth, railHeight, frames, RailMode.HORIZONTAL)
    }

    /** Top first, then bottom: the first rail position that fits and clears the inset. */
    private fun overlay(
        count: Int,
        width: Float,
        height: Float,
        localInset: StageRect?,
        spacing: Float,
        allowsOverflow: Boolean,
    ): Triple<Float, Float, List<StageRect>>? {
        val side = OVERLAY_TILE
        val exclusion = localInset?.inset(-spacing / 2)
        val contentWidth = max(width, count * side + (count + 1) * spacing)
        val rowWidth = count * side + (count - 1) * spacing
        val firstX = if (contentWidth <= width) max(spacing, (width - rowWidth) / 2) else spacing
        val railHeight = side + spacing
        val frames = (0 until count).map { i -> StageRect(firstX + i * (side + spacing), spacing / 2, side, side) }
        val ys = listOf(0f, max(0f, height - railHeight))
        fun overlaps(y: Float) = frames.count { f -> exclusion?.offset(0f, -y)?.intersects(f) == true }
        ys.firstOrNull { y ->
            (allowsOverflow || contentWidth <= width) && y + railHeight <= height && overlaps(y) == 0
        }?.let { return Triple(it, contentWidth, frames) }
        if (!allowsOverflow) return null
        val least = ys.minBy(::overlaps)
        return Triple(least, contentWidth, frames)
    }
}
