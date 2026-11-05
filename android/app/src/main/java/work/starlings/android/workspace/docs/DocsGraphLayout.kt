package work.starlings.android.workspace.docs

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The Docs graph's pure half, ported from `Sources/DocsGraph.swift`: the
 * shared configuration, edge resolution, folder groups, the seed, the
 * d3-force simulation (link springs, Barnes–Hut repulsion, a pull toward
 * each folder's anchor, velocity decay), the camera and the hit test.
 * Nothing here reads a clock or a random source, so the same input always
 * settles at the same positions. `DocsGraph.kt` draws it.
 */

/**
 * `DocsGraphConfiguration`: `packages/contracts/src/docs-graph-config.json`,
 * which web and iOS read too. `DocsGraphLayoutTest` holds these values to
 * that file.
 */
object DocsGraphConfig {
    const val VERSION = 2
    const val PAGE_SIZE = 200
    const val MAX_DOCUMENTS = 5_000
    const val LINK_BATCH_SIZE = 8
    val folderColors = listOf("#a6c944", "#68a9d5", "#bf91db", "#e98f70", "#50b99b", "#d6ad42", "#d8799b", "#8799e6")

    object Zoom {
        const val MIN = 0.25
        const val MAX = 4.0
        fun bounded(value: Double): Double = min(MAX, max(MIN, value))
    }

    object Layout {
        const val GROUP_RING_MIN = 150.0
        const val GROUP_RING_PER_FOLDER = 56.0
        const val MEMBER_RING_MIN = 42.0
        const val MEMBER_RING_PER_SQRT_DOCUMENT = 55.0
        const val LINK_LENGTH = 40.0
        const val CHARGE_STRENGTH = -120.0
        const val THETA = 0.9
        const val FOLDER_STRENGTH = 0.04
        const val VELOCITY_DECAY = 0.4
        const val ALPHA_MIN = 0.001
        const val ALPHA_DECAY = 0.0228
        const val REHEAT_ALPHA = 0.3
        const val DRAG_ALPHA_TARGET = 0.3
    }

    object Fit {
        const val MIN_WIDTH = 720
        const val MIN_HEIGHT = 480
        const val PADDING = 90
    }

    /** `DocsGraphPalette.color(at:)`: the folder colour as 0xRRGGBB, cycling the palette. */
    fun folderColor(index: Int): Long =
        folderColors[index % folderColors.size].removePrefix("#").toLongOrNull(16) ?: 0xA6C944
}

data class DocsGraphPoint(val x: Double, val y: Double)

/** One document as the layout sees it. */
data class DocsGraphNode(val id: String, val path: String, val title: String)

data class DocsGraphLink(val source: Int, val target: Int)

data class DocsGraphBounds(val x: Double, val y: Double, val width: Double, val height: Double)

/** One wikilink between two documents of the graph, by id. */
data class DocsGraphEdge(val sourceId: String, val targetId: String) {
    companion object {
        /**
         * `DocsGraphEdge.resolve`: a link only when both ends are in the
         * graph and differ, once per pair whichever way it points.
         */
        fun resolve(sourceId: String, targetId: String, documentIds: Set<String>, seenKeys: MutableSet<String>): DocsGraphEdge? {
            if (sourceId == targetId || sourceId !in documentIds || targetId !in documentIds) return null
            val key = if (DocsGraphLayout.comesBefore(targetId, sourceId)) "$targetId\u0000$sourceId" else "$sourceId\u0000$targetId"
            if (!seenKeys.add(key)) return null
            return DocsGraphEdge(sourceId, targetId)
        }
    }
}

object DocsGraphLayout {
    /**
     * `DocsGraphLayout.groupName(for:)`: the first path segment, dashes and
     * underscores as spaces, each word capitalized as Foundation's
     * `capitalized` does (first letter up, the rest down). A path with no
     * segment is [unfiled].
     */
    fun groupName(path: String, unfiled: String = "Unfiled"): String {
        val first = path.split('/').firstOrNull { it.isNotEmpty() } ?: return unfiled
        return capitalized(first.replace('-', ' ').replace('_', ' '))
    }

    private fun capitalized(text: String): String {
        val out = StringBuilder(text.length)
        var start = true
        var index = 0
        while (index < text.length) {
            val point = text.codePointAt(index)
            val chars = Character.toChars(point)
            if (Character.isWhitespace(point)) {
                out.append(chars)
                start = true
            } else {
                out.append(String(chars).let { if (start) it.uppercase() else it.lowercase() })
                start = false
            }
            index += chars.size
        }
        return out.toString()
    }

    /** `stringComesBefore`: Unicode scalar order, the same in every locale and on every client. */
    fun comesBefore(lhs: String, rhs: String): Boolean = scalarOrder.compare(lhs, rhs) < 0

    val scalarOrder: Comparator<String> = Comparator { lhs, rhs ->
        val left = lhs.codePoints().toArray()
        val right = rhs.codePoints().toArray()
        for (index in 0 until min(left.size, right.size)) {
            if (left[index] != right[index]) return@Comparator left[index].compareTo(right[index])
        }
        left.size.compareTo(right.size)
    }

    /** `uniqueDocuments`: each id once, in first-seen order. Offset paging repeats a document edited mid-walk. */
    fun <T> uniqueDocuments(documents: List<T>, id: (T) -> String): List<T> {
        val seen = HashSet<String>()
        return documents.filter { seen.add(id(it)) }
    }

    class Seed(val points: List<DocsGraphPoint>, val centers: List<DocsGraphPoint>)

    /**
     * `seed`: folders on a ring wide enough that their settled discs do not
     * overlap, members on a sunflower spiral sized to the disc the forces
     * settle them into. Same as web and iOS.
     */
    fun seed(documents: List<DocsGraphNode>, unfiled: String = "Unfiled"): Seed {
        if (documents.isEmpty()) return Seed(emptyList(), emptyList())
        val byGroup = documents.indices.groupBy { groupName(documents[it].path, unfiled) }
        val names = byGroup.keys.sortedWith(scalarOrder)
        fun memberRing(count: Int) = max(DocsGraphConfig.Layout.MEMBER_RING_MIN, sqrt(count.toDouble()) * DocsGraphConfig.Layout.MEMBER_RING_PER_SQRT_DOCUMENT)
        val widest = byGroup.values.maxOfOrNull { memberRing(it.size) } ?: 0.0
        val groupRing = if (names.size > 1) {
            maxOf(
                DocsGraphConfig.Layout.GROUP_RING_MIN,
                names.size * DocsGraphConfig.Layout.GROUP_RING_PER_FOLDER,
                widest * 1.15 / sin(PI / names.size),
            )
        } else {
            0.0
        }
        val memberOrder = Comparator<Int> { a, b ->
            val lhs = documents[a]
            val rhs = documents[b]
            when {
                lhs.title != rhs.title -> scalarOrder.compare(lhs.title, rhs.title)
                lhs.path != rhs.path -> scalarOrder.compare(lhs.path, rhs.path)
                else -> scalarOrder.compare(lhs.id, rhs.id)
            }
        }
        val points = Array(documents.size) { DocsGraphPoint(0.0, 0.0) }
        val centers = Array(documents.size) { DocsGraphPoint(0.0, 0.0) }
        names.forEachIndexed { groupIndex, group ->
            val angle = -PI / 2 + groupIndex.toDouble() / names.size * PI * 2
            val center = DocsGraphPoint(cos(angle) * groupRing, sin(angle) * groupRing)
            val members = byGroup.getValue(group).sortedWith(memberOrder)
            val ring = memberRing(members.size)
            members.forEachIndexed { order, index ->
                val turn = order * 2.399963229728653
                val spread = ring * sqrt((order + 0.5) / members.size)
                points[index] = DocsGraphPoint(center.x + cos(turn) * spread, center.y + sin(turn) * spread)
                centers[index] = center
            }
        }
        return Seed(points.toList(), centers.toList())
    }

    /** `positions`: the settled layout, run to rest in one go. The live view animates the same simulation. */
    fun positions(documents: List<DocsGraphNode>, edges: List<DocsGraphEdge>, unfiled: String = "Unfiled"): Map<String, DocsGraphPoint> {
        val indexById = HashMap<String, Int>()
        documents.forEachIndexed { index, node -> indexById.putIfAbsent(node.id, index) }
        val links = edges.mapNotNull { edge ->
            val source = indexById[edge.sourceId] ?: return@mapNotNull null
            val target = indexById[edge.targetId] ?: return@mapNotNull null
            DocsGraphLink(source, target)
        }
        val simulation = DocsGraphForces(documents, links, emptyMap(), unfiled)
        var ticks = 0
        while (!simulation.isSettled && ticks < 1_000) {
            simulation.tick()
            ticks++
        }
        val out = LinkedHashMap<String, DocsGraphPoint>()
        documents.forEachIndexed { index, node -> out.putIfAbsent(node.id, simulation.point(index)) }
        return out
    }

    /** `fitBounds`: the points with the shared padding, never smaller than the shared minimum. */
    fun fitBounds(points: List<DocsGraphPoint>): DocsGraphBounds {
        if (points.isEmpty()) return DocsGraphBounds(-520.0, -360.0, 1040.0, 720.0)
        var minX = Double.POSITIVE_INFINITY
        var maxX = Double.NEGATIVE_INFINITY
        var minY = Double.POSITIVE_INFINITY
        var maxY = Double.NEGATIVE_INFINITY
        for (point in points) {
            minX = min(minX, point.x)
            maxX = max(maxX, point.x)
            minY = min(minY, point.y)
            maxY = max(maxY, point.y)
        }
        val padding = DocsGraphConfig.Fit.PADDING.toDouble()
        return DocsGraphBounds(
            x = minX - padding,
            y = minY - padding,
            width = max(DocsGraphConfig.Fit.MIN_WIDTH.toDouble(), maxX - minX + padding * 2),
            height = max(DocsGraphConfig.Fit.MIN_HEIGHT.toDouble(), maxY - minY + padding * 2),
        )
    }

    /** `Node.shortTitle`: past 36 characters, the first 34 and an ellipsis. */
    fun shortTitle(title: String): String {
        val count = title.codePointCount(0, title.length)
        if (count <= 36) return title
        return title.substring(0, title.offsetByCodePoints(0, 34)) + "…"
    }

    /** `Node.radius`: 5.5 plus the square root of the links, at most 10.5. */
    fun radius(degree: Int): Double = min(10.5, 5.5 + sqrt(degree.toDouble()))
}

/** `DocsGraphModel`: everything the canvas reads, derived once per snapshot, never per frame. */
class DocsGraphModel(documents: List<DocsGraphNode>, graphEdges: List<DocsGraphEdge>, unfiled: String = "Unfiled") {
    /** One folder: its name, its colour (0xRRGGBB) and how many documents it holds. */
    data class Group(val name: String, val color: Long, val count: Int)

    data class Node(val node: DocsGraphNode, val group: Int, val degree: Int, val radius: Double, val shortTitle: String)

    val groups: List<Group>
    val nodes: List<Node>
    val indexById: Map<String, Int>
    val edges: List<DocsGraphLink>
    val neighbors: List<List<Int>>

    init {
        val counts = HashMap<String, Int>()
        val names = documents.map { DocsGraphLayout.groupName(it.path, unfiled) }
        for (name in names) counts[name] = (counts[name] ?: 0) + 1
        val sorted = counts.keys.sortedWith(DocsGraphLayout.scalarOrder)
        groups = sorted.mapIndexed { index, name -> Group(name, DocsGraphConfig.folderColor(index), counts.getValue(name)) }
        val groupIndex = sorted.withIndex().associate { it.value to it.index }
        val byId = HashMap<String, Int>()
        documents.forEachIndexed { index, node -> byId.putIfAbsent(node.id, index) }
        val degrees = IntArray(documents.size)
        val around = List(documents.size) { ArrayList<Int>() }
        val links = ArrayList<DocsGraphLink>(graphEdges.size)
        for (edge in graphEdges) {
            val source = byId[edge.sourceId] ?: continue
            val target = byId[edge.targetId] ?: continue
            links += DocsGraphLink(source, target)
            degrees[source]++
            degrees[target]++
            around[source] += target
            around[target] += source
        }
        nodes = documents.mapIndexed { index, node ->
            Node(node, groupIndex[names[index]] ?: 0, degrees[index], DocsGraphLayout.radius(degrees[index]), DocsGraphLayout.shortTitle(node.title))
        }
        indexById = byId
        edges = links
        neighbors = around
    }

    /** `visibility(hiding:)`: per node, whether its folder is shown. */
    fun visibility(hidden: Set<String>): List<Boolean> {
        val hiddenGroups = groups.indices.filter { groups[it].name in hidden }.toSet()
        return nodes.map { it.group !in hiddenGroups }
    }
}

/**
 * `DocsGraphForceSimulation`: d3-force's model, ported so web and both
 * native clients settle the same way. All state is plain arrays; [tick]
 * advances one step.
 */
class DocsGraphForces(
    nodes: List<DocsGraphNode>,
    private val links: List<DocsGraphLink>,
    known: Map<String, DocsGraphPoint>,
    unfiled: String = "Unfiled",
) {
    val x: DoubleArray
    val y: DoubleArray
    private val vx: DoubleArray
    private val vy: DoubleArray
    private val centerX: DoubleArray
    private val centerY: DoubleArray
    private val linkBias: DoubleArray
    private val linkStrength: DoubleArray
    private val pinned = HashMap<Int, DocsGraphPoint>()
    var alpha: Double = 1.0
        private set
    var alphaTarget: Double = 0.0

    init {
        val seed = DocsGraphLayout.seed(nodes, unfiled)
        x = DoubleArray(nodes.size) { known[nodes[it].id]?.x ?: seed.points[it].x }
        y = DoubleArray(nodes.size) { known[nodes[it].id]?.y ?: seed.points[it].y }
        vx = DoubleArray(nodes.size)
        vy = DoubleArray(nodes.size)
        centerX = DoubleArray(nodes.size) { seed.centers[it].x }
        centerY = DoubleArray(nodes.size) { seed.centers[it].y }
        val counts = DoubleArray(nodes.size)
        for (link in links) {
            counts[link.source] += 1.0
            counts[link.target] += 1.0
        }
        linkBias = DoubleArray(links.size) { counts[links[it].source] / (counts[links[it].source] + counts[links[it].target]) }
        linkStrength = DoubleArray(links.size) { 1 / min(counts[links[it].source], counts[links[it].target]) }
    }

    val size: Int get() = x.size

    val isSettled: Boolean get() = alphaTarget == 0.0 && alpha < DocsGraphConfig.Layout.ALPHA_MIN

    fun point(index: Int) = DocsGraphPoint(x[index], y[index])

    fun reheat(value: Double) {
        alpha = max(alpha, value)
    }

    fun pin(index: Int, at: DocsGraphPoint) {
        if (index in x.indices) pinned[index] = at
    }

    fun unpin(index: Int) {
        pinned.remove(index)
    }

    fun tick() {
        val layout = DocsGraphConfig.Layout
        alpha += (alphaTarget - alpha) * layout.ALPHA_DECAY
        val count = x.size
        if (count == 0) return

        links.forEachIndexed { index, link ->
            val source = link.source
            val target = link.target
            var dx = x[target] + vx[target] - x[source] - vx[source]
            var dy = y[target] + vy[target] - y[source] - vy[source]
            if (dx == 0.0) dx = jiggle(index.toLong())
            if (dy == 0.0) dy = jiggle(index.toLong() + 1)
            val length = sqrt(dx * dx + dy * dy)
            val strength = (length - layout.LINK_LENGTH) / length * alpha * linkStrength[index]
            dx *= strength
            dy *= strength
            val bias = linkBias[index]
            vx[target] -= dx * bias
            vy[target] -= dy * bias
            vx[source] += dx * (1 - bias)
            vy[source] += dy * (1 - bias)
        }

        applyCharge(layout.CHARGE_STRENGTH, layout.THETA)

        val pull = layout.FOLDER_STRENGTH * alpha
        val keep = 1 - layout.VELOCITY_DECAY
        for (index in 0 until count) {
            vx[index] += (centerX[index] - x[index]) * pull
            vy[index] += (centerY[index] - y[index]) * pull
            val point = pinned[index]
            if (point != null) {
                x[index] = point.x
                y[index] = point.y
                vx[index] = 0.0
                vy[index] = 0.0
            } else {
                vx[index] *= keep
                vy[index] *= keep
                x[index] += vx[index]
                y[index] += vy[index]
            }
        }
    }

    private fun applyCharge(strength: Double, theta: Double) {
        val tree = DocsGraphQuadtree(x, y)
        val theta2 = theta * theta
        val stack = IntStack()
        val force = DoubleArray(2)
        for (index in x.indices) {
            val px = x[index]
            val py = y[index]
            force[0] = 0.0
            force[1] = 0.0
            stack.clear()
            stack.push(0)
            while (stack.isNotEmpty()) {
                val cell = stack.pop()
                val mass = tree.count[cell]
                if (mass <= 0) continue
                if (tree.isInternal[cell]) {
                    val dx = tree.sumX[cell] / mass - px
                    val dy = tree.sumY[cell] / mass - py
                    val distance2 = dx * dx + dy * dy
                    val width = tree.size[cell]
                    if (width * width / theta2 < distance2) {
                        accumulate(dx, dy, distance2, strength * mass * alpha, force, index.toLong())
                        continue
                    }
                    for (slot in 0 until 4) {
                        val child = tree.children[cell * 4 + slot]
                        if (child >= 0) stack.push(child)
                    }
                } else {
                    var other = tree.head[cell]
                    while (other >= 0) {
                        if (other != index) {
                            val dx = x[other] - px
                            val dy = y[other] - py
                            accumulate(dx, dy, dx * dx + dy * dy, strength * alpha, force, index.toLong() + other)
                        }
                        other = tree.next[other]
                    }
                }
            }
            vx[index] += force[0]
            vy[index] += force[1]
        }
    }

    private companion object {
        fun accumulate(dx0: Double, dy0: Double, d2: Double, weight: Double, force: DoubleArray, salt: Long) {
            var dx = dx0
            var dy = dy0
            var distance2 = d2
            if (dx == 0.0) { dx = jiggle(salt); distance2 += dx * dx }
            if (dy == 0.0) { dy = jiggle(salt + 1); distance2 += dy * dy }
            // d3's distanceMin of 1 keeps near-coincident nodes from exploding.
            if (distance2 < 1) distance2 = sqrt(distance2)
            force[0] += dx * weight / distance2
            force[1] += dy * weight / distance2
        }

        /** A tiny, deterministic nudge to separate coincident points (Swift's wrapping 64-bit multiply). */
        fun jiggle(salt: Long): Double = (((salt * 2_654_435_761L) and 0xffff).toDouble() / 65_536 - 0.5) * 1e-6
    }
}

private class IntStack {
    private var items = IntArray(64)
    private var count = 0
    fun clear() { count = 0 }
    fun isNotEmpty() = count > 0
    fun push(value: Int) {
        if (count == items.size) items = items.copyOf(count * 2)
        items[count++] = value
    }
    fun pop(): Int = items[--count]
}

/** `DocsGraphQuadtree`: a flat quadtree with each cell's point count and coordinate sums. */
private class DocsGraphQuadtree(private val px: DoubleArray, private val py: DoubleArray) {
    private var capacity = px.size * 2 + 1
    var minX = DoubleArray(capacity)
    var minY = DoubleArray(capacity)
    var size = DoubleArray(capacity)
    var sumX = DoubleArray(capacity)
    var sumY = DoubleArray(capacity)
    var count = DoubleArray(capacity)
    var isInternal = BooleanArray(capacity)
    var head = IntArray(capacity)
    var children = IntArray(capacity * 4)
    val next = IntArray(px.size) { -1 }
    private var cells = 0

    init {
        if (px.isNotEmpty()) {
            val lowX = px.min()
            val highX = px.max()
            val lowY = py.min()
            val highY = py.max()
            addCell(lowX, lowY, max(highX - lowX, highY - lowY) + 1)
            for (index in px.indices) insert(index)
        }
    }

    private fun grow() {
        capacity *= 2
        minX = minX.copyOf(capacity)
        minY = minY.copyOf(capacity)
        size = size.copyOf(capacity)
        sumX = sumX.copyOf(capacity)
        sumY = sumY.copyOf(capacity)
        count = count.copyOf(capacity)
        isInternal = isInternal.copyOf(capacity)
        head = head.copyOf(capacity)
        children = children.copyOf(capacity * 4)
    }

    private fun addCell(cellMinX: Double, cellMinY: Double, cellSize: Double) {
        if (cells == capacity) grow()
        val cell = cells++
        minX[cell] = cellMinX
        minY[cell] = cellMinY
        size[cell] = cellSize
        sumX[cell] = 0.0
        sumY[cell] = 0.0
        count[cell] = 0.0
        isInternal[cell] = false
        head[cell] = -1
        for (slot in 0 until 4) children[cell * 4 + slot] = -1
    }

    private fun child(cell: Int, x: Double, y: Double): Int {
        val half = size[cell] / 2
        val right = if (x >= minX[cell] + half) 1 else 0
        val lower = if (y >= minY[cell] + half) 1 else 0
        val slot = cell * 4 + lower * 2 + right
        if (children[slot] < 0) {
            val created = cells
            addCell(minX[cell] + right * half, minY[cell] + lower * half, half)
            children[slot] = created
        }
        return children[slot]
    }

    private fun insert(index: Int) {
        val x = px[index]
        val y = py[index]
        var cell = 0
        var depth = 0
        while (true) {
            sumX[cell] += x
            sumY[cell] += y
            count[cell] += 1.0
            if (isInternal[cell]) {
                cell = child(cell, x, y)
                depth++
                continue
            }
            if (head[cell] < 0) {
                head[cell] = index
                return
            }
            if (depth >= 24) {
                next[index] = head[cell]
                head[cell] = index
                return
            }
            // Split: the resident point moves down a level, then this one
            // continues; the loop splits again if they share a quadrant.
            val resident = head[cell]
            head[cell] = -1
            isInternal[cell] = true
            val home = child(cell, px[resident], py[resident])
            sumX[home] += px[resident]
            sumY[home] += py[resident]
            count[home] += 1.0
            head[home] = resident
            cell = child(cell, x, y)
            depth++
        }
    }
}

/** `DocsGraphCamera`: screen = canvas centre + pan + graph point × scale. */
data class DocsGraphCamera(
    val scale: Double = 1.0,
    val panX: Double = 0.0,
    val panY: Double = 0.0,
    /** The Fit scale this camera was taken from; zoom limits are relative to it. */
    val fitScale: Double = 1.0,
) {
    val zoom: Double get() = scale / fitScale

    fun screenX(x: Double, width: Double) = width / 2 + panX + x * scale
    fun screenY(y: Double, height: Double) = height / 2 + panY + y * scale

    fun graphPoint(sx: Double, sy: Double, width: Double, height: Double) =
        DocsGraphPoint((sx - width / 2 - panX) / scale, (sy - height / 2 - panY) / scale)

    fun panned(dx: Double, dy: Double) = copy(panX = panX + dx, panY = panY + dy)

    /** Zoom so the graph point under the anchor stays under it. */
    fun zoomed(to: Double, anchorX: Double, anchorY: Double, width: Double, height: Double): DocsGraphCamera {
        val target = graphPoint(anchorX, anchorY, width, height)
        val next = fitScale * DocsGraphConfig.Zoom.bounded(to)
        return copy(scale = next, panX = anchorX - width / 2 - target.x * next, panY = anchorY - height / 2 - target.y * next)
    }

    companion object {
        fun fit(bounds: DocsGraphBounds, width: Double, height: Double): DocsGraphCamera {
            if (width <= 0 || height <= 0) return DocsGraphCamera()
            val scale = min(width / bounds.width, height / bounds.height)
            return DocsGraphCamera(scale, -(bounds.x + bounds.width / 2) * scale, -(bounds.y + bounds.height / 2) * scale, scale)
        }

        /**
         * `DocsGraphCanvas.hitTest`: the nearest visible node within its
         * drawn radius (at least [minimumReach]) plus 3, measured on screen.
         */
        fun hitTest(
            model: DocsGraphModel,
            x: DoubleArray,
            y: DoubleArray,
            visible: List<Boolean>,
            camera: DocsGraphCamera,
            width: Double,
            height: Double,
            atX: Double,
            atY: Double,
            minimumReach: Double,
        ): Int? {
            var best: Int? = null
            var bestDistance = Double.POSITIVE_INFINITY
            for (index in model.nodes.indices) {
                if (index >= x.size || index >= visible.size || !visible[index]) continue
                val reach = max(model.nodes[index].radius * camera.scale, minimumReach) + 3
                val distance = hypot(camera.screenX(x[index], width) - atX, camera.screenY(y[index], height) - atY)
                if (distance <= reach && distance < bestDistance) {
                    best = index
                    bestDistance = distance
                }
            }
            return best
        }
    }
}

/**
 * `DocsGraphSimulation`: the live layout. [load] keeps the positions of
 * documents already placed and reheats; the view calls [step] once per
 * display frame while [isRunning].
 */
class DocsGraphSimulation {
    var isRunning = false
        private set
    var forces = DocsGraphForces(emptyList(), emptyList(), emptyMap())
        private set
    private var indexById: Map<String, Int> = emptyMap()
    private val pinned = HashMap<String, DocsGraphPoint>()

    fun load(model: DocsGraphModel, unfiled: String = "Unfiled") {
        val known = HashMap<String, DocsGraphPoint>()
        for ((id, index) in indexById) if (index < forces.size) known[id] = forces.point(index)
        val alphaTarget = forces.alphaTarget
        val fresh = model.nodes.count { it.node.id !in known }
        forces = DocsGraphForces(model.nodes.map { it.node }, model.edges, known, unfiled)
        indexById = model.indexById
        forces.alphaTarget = alphaTarget
        for ((id, point) in pinned) indexById[id]?.let { forces.pin(it, point) }
        forces.reheat(if (known.isEmpty() || fresh * 4 > model.nodes.size) 1.0 else DocsGraphConfig.Layout.REHEAT_ALPHA)
        isRunning = true
    }

    /** One tick. Answers whether the layout still moves. */
    fun step(): Boolean {
        if (!isRunning) return false
        forces.tick()
        if (forces.isSettled) isRunning = false
        return isRunning
    }

    fun beginDrag(id: String) {
        val index = indexById[id] ?: return
        val point = forces.point(index)
        pinned[id] = point
        forces.pin(index, point)
        forces.alphaTarget = DocsGraphConfig.Layout.DRAG_ALPHA_TARGET
        forces.reheat(DocsGraphConfig.Layout.DRAG_ALPHA_TARGET)
        isRunning = true
    }

    fun drag(id: String, to: DocsGraphPoint) {
        val index = indexById[id] ?: return
        pinned[id] = to
        forces.pin(index, to)
    }

    fun endDrag(id: String) {
        pinned.remove(id)
        indexById[id]?.let { forces.unpin(it) }
        forces.alphaTarget = 0.0
    }
}
