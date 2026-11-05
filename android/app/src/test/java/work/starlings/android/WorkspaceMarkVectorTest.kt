package work.starlings.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.android.WorkspaceMarkVector.Affine
import work.starlings.android.WorkspaceMarkVector.Shape

/** `WorkspaceMarkVector` (Sources/WorkspaceMarkVector.swift) and the mark answer the app keeps. */
class WorkspaceMarkVectorTest {
    private fun svg(body: String, root: String = """viewBox="0 0 24 24"""") =
        """<svg xmlns="http://www.w3.org/2000/svg" $root>$body</svg>""".toByteArray()

    private fun close(expected: Pair<Double, Double>, actual: Pair<Double, Double>) {
        assertEquals(expected.first, actual.first, 1e-9)
        assertEquals(expected.second, actual.second, 1e-9)
    }

    @Test
    fun svgIsToldFromARasterByItsHead() {
        assertTrue(WorkspaceMarkVector.isSvg("<?xml version=\"1.0\"?>\n<SVG viewBox=\"0 0 1 1\"/>".toByteArray()))
        assertFalse(WorkspaceMarkVector.isSvg(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)))
    }

    @Test
    fun theShapesAMarkIsMadeOf() {
        val outline = WorkspaceMarkVector.outline(
            svg(
                """<path d="M0 0h4v4z"/><rect x="1" y="2" width="3" height="4" rx="9"/><circle cx="5" cy="5" r="2"/>""" +
                    """<ellipse cx="1" cy="1" rx="0" ry="2"/><polygon points="0,0 4,0 4,4 9"/><line x1="0" y1="0" x2="1" y2="1" stroke="#000"/>""",
            ),
        )!!
        assertEquals(WorkspaceMarkVector.Box(0.0, 0.0, 24.0, 24.0), outline.viewBox)
        val shapes = outline.parts.map { it.shape }
        assertEquals(Shape.Path("M0 0h4v4z"), shapes[0])
        assertEquals(Shape.Rect(1.0, 2.0, 3.0, 4.0, 1.5, 1.5), shapes[1])
        assertEquals(Shape.Ellipse(5.0, 5.0, 2.0, 2.0), shapes[2])
        assertEquals(Shape.Poly(listOf(0.0, 0.0, 4.0, 0.0, 4.0, 4.0), closed = true), shapes[3])
        assertEquals(Shape.Line(0.0, 0.0, 1.0, 1.0), shapes[4])
        assertEquals(5, shapes.size)
        assertFalse(outline.evenOdd)
    }

    @Test
    fun unfilledShapesCountOnlyAsTheirStroke() {
        val outline = WorkspaceMarkVector.outline(
            svg("""<path d="M0 0L1 1" fill="none" stroke="#000" stroke-width="2px"/><path d="M0 0L1 1" fill="NONE"/><path d="M0 0" fill="none" stroke="red"/>"""),
        )!!
        assertEquals(listOf(2.0, 1.0), outline.parts.map { it.strokeWidth })
    }

    @Test
    fun hiddenElementsAndTheirChildrenAreNotDrawn() {
        val outline = WorkspaceMarkVector.outline(
            svg("""<defs><path d="M0 0h1"/></defs><clipPath><g><rect width="1" height="1"/></g></clipPath><title>x</title><path d="M1 1h1" fill-rule="evenodd"/>"""),
        )!!
        assertEquals(listOf<Shape>(Shape.Path("M1 1h1")), outline.parts.map { it.shape })
        assertTrue(outline.evenOdd)
    }

    @Test
    fun aFileWithNoBoxOrNoShapeHasNoOutline() {
        assertNull(WorkspaceMarkVector.outline(svg("""<path d="M0 0h1"/>""", root = "")))
        assertNull(WorkspaceMarkVector.outline(svg("<text>Hi</text>")))
        assertNull(WorkspaceMarkVector.outline("not xml".toByteArray()))
        val sized = WorkspaceMarkVector.outline(svg("""<path d="M0 0h1"/>""", root = """width="32px" height="16""""))!!
        assertEquals(WorkspaceMarkVector.Box(0.0, 0.0, 32.0, 16.0), sized.viewBox)
    }

    @Test
    fun transformsApplyTheLastOneFirstAndGroupsNest() {
        // translate(10) scale(2): the point is scaled, then moved.
        close(12.0 to 4.0, WorkspaceMarkVector.transform("translate(10) scale(2)").apply(1.0, 2.0))
        close(-2.0 to 1.0, WorkspaceMarkVector.transform("rotate(90)").apply(1.0, 2.0))
        close(2.0 to 0.0, WorkspaceMarkVector.transform("rotate(180 1 0)").apply(0.0, 0.0))
        close(5.0 to 8.0, WorkspaceMarkVector.transform("matrix(1 0 0 1 4 6)").apply(1.0, 2.0))
        val outline = WorkspaceMarkVector.outline(svg("""<g transform="translate(5,0)"><path transform="scale(3)" d="M0 0"/></g>"""))!!
        close(8.0 to 3.0, outline.parts.single().transform.apply(1.0, 1.0))
    }

    @Test
    fun theOutlineFitsTheFrameCentredWithItsAspect() {
        val fit = WorkspaceMarkVector.fit(WorkspaceMarkVector.Box(0.0, 0.0, 10.0, 20.0), 40.0, 40.0)
        close(10.0 to 0.0, fit.apply(0.0, 0.0))
        close(30.0 to 40.0, fit.apply(10.0, 20.0))
        assertEquals(Affine.IDENTITY, Affine.IDENTITY.then(Affine.IDENTITY))
    }

    @Test
    fun aMarkAnswerIsPngOrSvgWithinTheLimit() {
        assertTrue(WorkspaceDirectory.markAccepted(200, "image/png", 10))
        assertTrue(WorkspaceDirectory.markAccepted(200, "image/svg+xml", -1))
        assertTrue(WorkspaceDirectory.markAccepted(200, "image/png", Contracts.WORKSPACE_MARK_MAX_BYTES.toLong()))
        assertFalse(WorkspaceDirectory.markAccepted(200, "image/png", Contracts.WORKSPACE_MARK_MAX_BYTES + 1L))
        assertFalse(WorkspaceDirectory.markAccepted(200, "image/jpeg", 10))
        assertFalse(WorkspaceDirectory.markAccepted(200, null, 10))
        assertFalse(WorkspaceDirectory.markAccepted(404, "image/png", 10))
    }
}
