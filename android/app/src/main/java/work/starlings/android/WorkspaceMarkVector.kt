package work.starlings.android

import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.ByteArrayInputStream
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.tan

/**
 * A workspace's uploaded SVG mark as one outline (`Sources/WorkspaceMarkVector.swift`;
 * MZ, 2026-10-05: "treat vector SVG as monochrome data, just outline"). The
 * app draws it in the ink of where it sits, never in the file's own colours.
 *
 * Reads the shapes a mark is made of: `path`, `rect`, `circle`, `ellipse`,
 * `polygon`, `polyline` and `line`, with `transform` on them and on their
 * groups, inside the root `viewBox`. A shape with `fill="none"` and a stroke
 * counts as its stroke. Anything under `defs`, `clipPath`, `mask`,
 * `pattern`, `symbol`, `style`, `title`, `metadata` or a gradient is not
 * drawn. Text and images carry no outline here. This file reads; drawing is
 * `WorkspaceMarkDrawing` in `WorkspaceMarks.kt`.
 */
object WorkspaceMarkVector {
    /** `CGAffineTransform`: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
    data class Affine(val a: Double, val b: Double, val c: Double, val d: Double, val tx: Double, val ty: Double) {
        /** This, then [next] (`concatenating`). */
        fun then(next: Affine) = Affine(
            a = a * next.a + b * next.c,
            b = a * next.b + b * next.d,
            c = c * next.a + d * next.c,
            d = c * next.b + d * next.d,
            tx = tx * next.a + ty * next.c + next.tx,
            ty = tx * next.b + ty * next.d + next.ty,
        )

        fun apply(x: Double, y: Double): Pair<Double, Double> = (a * x + c * y + tx) to (b * x + d * y + ty)

        companion object {
            val IDENTITY = Affine(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
            fun translate(x: Double, y: Double) = Affine(1.0, 0.0, 0.0, 1.0, x, y)
            fun scale(x: Double, y: Double) = Affine(x, 0.0, 0.0, y, 0.0, 0.0)
            fun rotate(radians: Double) = Affine(cos(radians), sin(radians), -sin(radians), cos(radians), 0.0, 0.0)
        }
    }

    data class Box(val x: Double, val y: Double, val width: Double, val height: Double)

    sealed interface Shape {
        /** An SVG path's `d`, read when drawn. */
        data class Path(val d: String) : Shape
        data class Rect(val x: Double, val y: Double, val width: Double, val height: Double, val rx: Double, val ry: Double) : Shape
        data class Ellipse(val cx: Double, val cy: Double, val rx: Double, val ry: Double) : Shape
        data class Poly(val points: List<Double>, val closed: Boolean) : Shape
        data class Line(val x1: Double, val y1: Double, val x2: Double, val y2: Double) : Shape
    }

    /** One shape in file coordinates: filled, or stroked at [strokeWidth]. */
    data class Part(val shape: Shape, val transform: Affine, val strokeWidth: Double?)

    data class Outline(val parts: List<Part>, val viewBox: Box, val evenOdd: Boolean)

    /** True for bytes that look like an SVG document rather than a raster image. */
    fun isSvg(data: ByteArray): Boolean = data.copyOf(minOf(512, data.size)).decodeToString().lowercase().contains("<svg")

    private val hidden = setOf("defs", "clippath", "mask", "pattern", "symbol", "style", "title", "metadata", "lineargradient", "radialgradient")

    /** The outline, or null when the file has no box or no shape. No DTD, no external entity. */
    fun outline(data: ByteArray): Outline? {
        val document = runCatching {
            val factory = DocumentBuilderFactory.newInstance()
            factory.isNamespaceAware = false
            factory.isExpandEntityReferences = false
            runCatching { factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
            runCatching { factory.setFeature("http://xml.org/sax/features/external-general-entities", false) }
            runCatching { factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false) }
            factory.newDocumentBuilder().parse(ByteArrayInputStream(data))
        }.getOrNull() ?: return null
        val reader = Reader()
        reader.visit(document.documentElement, Affine.IDENTITY, hiddenAbove = false)
        val box = reader.viewBox ?: return null
        if (reader.parts.isEmpty()) return null
        return Outline(reader.parts, box, reader.evenOdd)
    }

    /** `path(_:in:)`: the transform that fits [box] in a [width] × [height] frame, centred, aspect kept. */
    fun fit(box: Box, width: Double, height: Double): Affine {
        val scale = min(width / box.width, height / box.height)
        val midX = box.x + box.width / 2
        val midY = box.y + box.height / 2
        return Affine(scale, 0.0, 0.0, scale, width / 2 - midX * scale, height / 2 - midY * scale)
    }

    private class Reader {
        val parts = mutableListOf<Part>()
        var viewBox: Box? = null
        var evenOdd = false

        fun visit(element: Element, inherited: Affine, hiddenAbove: Boolean) {
            val name = element.tagName.substringAfter(':').lowercase()
            val own = element.attr("transform")?.let(::transform) ?: Affine.IDENTITY
            val current = own.then(inherited)
            val hiddenHere = hiddenAbove || name in hidden
            if (!hiddenHere) {
                if (name == "svg" && viewBox == null) {
                    viewBox = viewBox(element)
                } else {
                    shape(name, element)?.let { add(it, element, current) }
                }
            }
            val children = element.childNodes
            for (i in 0 until children.length) {
                val child = children.item(i)
                if (child.nodeType == Node.ELEMENT_NODE) visit(child as Element, current, hiddenHere)
            }
        }

        private fun add(shape: Shape, element: Element, transform: Affine) {
            if (element.attr("fill-rule") == "evenodd" || element.attr("clip-rule") == "evenodd") evenOdd = true
            val filled = element.attr("fill").orEmpty().lowercase() != "none"
            if (filled) {
                parts += Part(shape, transform, null)
                return
            }
            val width = element.attr("stroke-width")?.let(::number) ?: if (element.attr("stroke") != null) 1.0 else null
            if (width != null) parts += Part(shape, transform, width)
        }

        private fun viewBox(element: Element): Box? {
            element.attr("viewBox")?.let { raw ->
                val v = numbers(raw)
                if (v.size == 4 && v[2] > 0 && v[3] > 0) return Box(v[0], v[1], v[2], v[3])
            }
            val width = element.attr("width")?.let(::number)
            val height = element.attr("height")?.let(::number)
            if (width != null && height != null && width > 0 && height > 0) return Box(0.0, 0.0, width, height)
            return null
        }

        private fun shape(name: String, e: Element): Shape? {
            fun value(key: String) = e.attr(key)?.let(::number) ?: 0.0
            return when (name) {
                "path" -> e.attr("d")?.let { Shape.Path(it) }
                "rect" -> {
                    val w = value("width")
                    val h = value("height")
                    if (w <= 0 || h <= 0) return null
                    val rx = min(e.attr("rx")?.let(::number) ?: e.attr("ry")?.let(::number) ?: 0.0, w / 2)
                    val ry = min(e.attr("ry")?.let(::number) ?: rx, h / 2)
                    Shape.Rect(value("x"), value("y"), w, h, rx, ry)
                }
                "circle" -> {
                    val r = value("r")
                    if (r <= 0) null else Shape.Ellipse(value("cx"), value("cy"), r, r)
                }
                "ellipse" -> {
                    val rx = value("rx")
                    val ry = value("ry")
                    if (rx <= 0 || ry <= 0) null else Shape.Ellipse(value("cx"), value("cy"), rx, ry)
                }
                "polygon", "polyline" -> {
                    val v = numbers(e.attr("points").orEmpty())
                    if (v.size < 4) null else Shape.Poly(v.take(v.size - v.size % 2), closed = name == "polygon")
                }
                "line" -> Shape.Line(value("x1"), value("y1"), value("x2"), value("y2"))
                else -> null
            }
        }

        private fun Element.attr(name: String): String? = if (hasAttribute(name)) getAttribute(name) else null
    }

    private val step = Regex("""([a-zA-Z]+)\s*\(([^)]*)\)""")

    /** `translate`, `scale`, `rotate`, `skewX`, `skewY` and `matrix`; SVG applies the list's last one first. */
    fun transform(raw: String): Affine {
        var result = Affine.IDENTITY
        for (match in step.findAll(raw)) {
            val v = numbers(match.groupValues[2])
            val next = when (match.groupValues[1].lowercase()) {
                "translate" -> Affine.translate(v.firstOrNull() ?: 0.0, v.getOrNull(1) ?: 0.0)
                "scale" -> Affine.scale(v.firstOrNull() ?: 1.0, v.getOrNull(1) ?: (v.firstOrNull() ?: 1.0))
                "rotate" -> {
                    val angle = (v.firstOrNull() ?: 0.0) * PI / 180
                    if (v.size >= 3) {
                        Affine.translate(-v[1], -v[2]).then(Affine.rotate(angle)).then(Affine.translate(v[1], v[2]))
                    } else {
                        Affine.rotate(angle)
                    }
                }
                "skewx" -> Affine(1.0, 0.0, tan((v.firstOrNull() ?: 0.0) * PI / 180), 1.0, 0.0, 0.0)
                "skewy" -> Affine(1.0, tan((v.firstOrNull() ?: 0.0) * PI / 180), 0.0, 1.0, 0.0, 0.0)
                "matrix" -> if (v.size == 6) Affine(v[0], v[1], v[2], v[3], v[4], v[5]) else Affine.IDENTITY
                else -> Affine.IDENTITY
            }
            result = next.then(result)
        }
        return result
    }

    private fun number(raw: String): Double? = raw.trim().replace("px", "").toDoubleOrNull()

    private fun numbers(raw: String): List<Double> =
        raw.split(' ', ',', '\n', '\t').mapNotNull { it.toDoubleOrNull() }
}
