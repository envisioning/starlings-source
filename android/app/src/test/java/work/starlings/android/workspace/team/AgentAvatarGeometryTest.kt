package work.starlings.android.workspace.team

import androidx.compose.ui.graphics.vector.PathNode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentAvatarGeometryTest {
    @Test
    fun theViewBoxFillsTheInsetArtRect() {
        val fit = AgentAvatarGeometry.fit(40f)
        // 2.5% inset: the art rect is 1..39, so -120 lands on 1 and 120 on 39.
        assertEquals(1f, fit.x(-120f), 1e-4f)
        assertEquals(39f, fit.x(120f), 1e-4f)
        assertEquals(20f, fit.x(0f), 1e-4f)
    }

    @Test
    fun workerPathsParse() {
        // The shape `pathFromRadii` writes (packages/contracts/src/agent-avatar-values.ts): absolute M, C, Z.
        val body = "M97.65 0C97.17 3.19 96.48 6.35 95.67 9.42C94.86 12.5 93.88 15.52 92.8 18.46C-2.94 89.91 -5.89 89.82 97.65 0Z"
        val nodes = AgentAvatarGeometry.nodes(body)
        assertNotNull(nodes)
        assertTrue(nodes!!.first() is PathNode.MoveTo)
        assertEquals(3, nodes.count { it is PathNode.CurveTo })
        assertTrue(nodes.last() is PathNode.Close)
        // Two eyes: two closed subpaths.
        val eyes = AgentAvatarGeometry.nodes("M0.58 -4.74C0.62 -4.44 0.66 -4.14 0.58 -4.74ZM31.41 -4.68C31.45 -4.38 31.49 -4.08 31.41 -4.68Z")!!
        assertEquals(2, eyes.count { it is PathNode.MoveTo })
        // The roster fixture's placeholder still parses.
        assertNotNull(AgentAvatarGeometry.nodes("M0 0Z"))
    }

    @Test
    fun nothingToDrawIsNull() {
        assertNull(AgentAvatarGeometry.nodes(""))
        assertNull(AgentAvatarGeometry.nodes("   "))
    }

    @Test
    fun colourIsSixHexDigits() {
        assertEquals(0xFFAACC00L, AgentAvatarGeometry.color("#aacc00"))
        assertEquals(0xFFE4572EL, AgentAvatarGeometry.color("e4572e"))
        assertNull(AgentAvatarGeometry.color("#abc"))
        assertNull(AgentAvatarGeometry.color("#zzzzzz"))
    }
}
