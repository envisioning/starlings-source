package work.starlings.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The stage-grid cases of `Tests/StarlingsEnvisioningTests.swift`, plus the share rail. */
class StageLayoutTest {
    @Test
    fun gridShapeFollowsTheStage() {
        val wide = StageLayout.equalGrid(3, 1400f, 300f, 8f)
        assertEquals(3 to 1, wide.columns to wide.rows)

        val tall = StageLayout.equalGrid(5, 1440f, 1160f, 8f)
        assertEquals(3 to 2, tall.columns to tall.rows)
        val used = tall.rows * tall.cell + (tall.rows - 1) * 8f
        assertTrue(used <= 1160.001f && used > 900f)

        val pair = StageLayout.equalGrid(2, 900f, 1200f, 8f)
        assertEquals(1 to 2, pair.columns to pair.rows)
    }

    @Test
    fun gridCellsNeverOverflow() {
        for (count in 1..9) {
            val plan = StageLayout.equalGrid(count, 1180f, 640f, 8f)
            assertTrue("$count wide", plan.columns * plan.cell + (plan.columns - 1) * 8f <= 1180.001f)
            assertTrue("$count tall", plan.rows * plan.cell + (plan.rows - 1) * 8f <= 640.001f)
            assertTrue("$count fits", plan.columns * plan.rows >= count)
        }
    }

    @Test
    fun shareRail() {
        // A small room floats its rail over the share, clear of the local inset at the top.
        val inset = StageRect((390f - 78f) / 2, 12f, 78f, 78f)
        val small = StageLayout.screenShare(390f, 700f, 3, inset)
        assertEquals(StageLayout.RailMode.OVERLAY, small.railMode)
        assertTrue(small.participants.none { inset.offset(0f, -small.rail.y).intersects(it) })
        assertEquals(StageRect(0f, 0f, 390f, 700f), small.share)

        // A crowded portrait room docks a scrolling rail below the share.
        val crowded = StageLayout.screenShare(390f, 700f, 8, inset)
        assertEquals(StageLayout.RailMode.HORIZONTAL, crowded.railMode)
        assertTrue(crowded.share.maxY <= crowded.rail.y)
        assertTrue(crowded.railContentWidth > 390f)

        // A crowded landscape room docks the rail beside the share.
        val wide = StageLayout.screenShare(1000f, 600f, 8)
        assertEquals(StageLayout.RailMode.VERTICAL, wide.railMode)
        assertTrue(wide.share.maxX <= wide.rail.x)

        // The rail choice docks even a small room.
        val rail = StageLayout.screenShare(390f, 700f, 2, choice = StageLayout.ScreenShareChoice.RAIL)
        assertEquals(StageLayout.RailMode.HORIZONTAL, rail.railMode)

        assertEquals(StageLayout.RailMode.NONE, StageLayout.screenShare(390f, 700f, 0).railMode)
    }

    @Test
    fun selfInset() {
        assertEquals(76f, StageLayout.selfInsetSide(300f))
        assertEquals(128f, StageLayout.selfInsetSide(1000f))
    }
}
