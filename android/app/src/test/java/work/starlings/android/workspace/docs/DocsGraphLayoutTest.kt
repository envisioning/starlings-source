package work.starlings.android.workspace.docs

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs
import kotlin.math.hypot

/** The graph's pure half (DocsGraphLayout.kt) against `Tests/DocsGraphFixtureTests.swift` and the shared files. */
class DocsGraphLayoutTest {
    private fun file(property: String, name: String): JsonObject {
        val dir = System.getProperty(property) ?: error("$property is not set")
        return Json.parseToJsonElement(File(dir, name).readText()).jsonObject
    }

    private val fixture by lazy { file("starlings.fixtures", "docs-graph.json") }

    private val documents by lazy {
        fixture["documents"]!!.jsonArray.map {
            val row = it.jsonObject
            DocsGraphNode(row["id"]!!.jsonPrimitive.content, row["path"]!!.jsonPrimitive.content, row["title"]!!.jsonPrimitive.content)
        }
    }

    private fun resolvedEdges(): List<DocsGraphEdge> {
        val ids = documents.map { it.id }.toSet()
        val seen = HashSet<String>()
        return fixture["links"]!!.jsonArray.mapNotNull {
            val row = it.jsonObject
            DocsGraphEdge.resolve(row["source"]!!.jsonPrimitive.content, row["target"]!!.jsonPrimitive.content, ids, seen)
        }
    }

    @Test
    fun configurationIsTheSharedFile() {
        val config = file("starlings.contracts", "docs-graph-config.json")
        assertEquals(config["version"]!!.jsonPrimitive.int, DocsGraphConfig.VERSION)
        assertEquals(config["pageSize"]!!.jsonPrimitive.int, DocsGraphConfig.PAGE_SIZE)
        assertEquals(config["maxDocuments"]!!.jsonPrimitive.int, DocsGraphConfig.MAX_DOCUMENTS)
        assertEquals(config["linkBatchSize"]!!.jsonPrimitive.int, DocsGraphConfig.LINK_BATCH_SIZE)
        assertEquals(config["folderColors"]!!.jsonArray.map { it.jsonPrimitive.content }, DocsGraphConfig.folderColors)
        val zoom = config["zoom"]!!.jsonObject
        assertEquals(zoom["min"]!!.jsonPrimitive.double, DocsGraphConfig.Zoom.MIN, 0.0)
        assertEquals(zoom["max"]!!.jsonPrimitive.double, DocsGraphConfig.Zoom.MAX, 0.0)
        assertEquals(0.25, DocsGraphConfig.Zoom.bounded(-1.0), 0.0)
        assertEquals(4.0, DocsGraphConfig.Zoom.bounded(100.0), 0.0)
        val layout = config["layout"]!!.jsonObject
        val kotlin = mapOf(
            "groupRingMin" to DocsGraphConfig.Layout.GROUP_RING_MIN,
            "groupRingPerFolder" to DocsGraphConfig.Layout.GROUP_RING_PER_FOLDER,
            "memberRingMin" to DocsGraphConfig.Layout.MEMBER_RING_MIN,
            "memberRingPerSqrtDocument" to DocsGraphConfig.Layout.MEMBER_RING_PER_SQRT_DOCUMENT,
            "linkLength" to DocsGraphConfig.Layout.LINK_LENGTH,
            "chargeStrength" to DocsGraphConfig.Layout.CHARGE_STRENGTH,
            "theta" to DocsGraphConfig.Layout.THETA,
            "folderStrength" to DocsGraphConfig.Layout.FOLDER_STRENGTH,
            "velocityDecay" to DocsGraphConfig.Layout.VELOCITY_DECAY,
            "alphaMin" to DocsGraphConfig.Layout.ALPHA_MIN,
            "alphaDecay" to DocsGraphConfig.Layout.ALPHA_DECAY,
            "reheatAlpha" to DocsGraphConfig.Layout.REHEAT_ALPHA,
            "dragAlphaTarget" to DocsGraphConfig.Layout.DRAG_ALPHA_TARGET,
        )
        assertEquals(layout.keys, kotlin.keys)
        for ((key, value) in kotlin) assertEquals(key, layout[key]!!.jsonPrimitive.double, value, 0.0)
        val fit = config["fit"]!!.jsonObject
        assertEquals(fit["minWidth"]!!.jsonPrimitive.int, DocsGraphConfig.Fit.MIN_WIDTH)
        assertEquals(fit["minHeight"]!!.jsonPrimitive.int, DocsGraphConfig.Fit.MIN_HEIGHT)
        assertEquals(fit["padding"]!!.jsonPrimitive.int, DocsGraphConfig.Fit.PADDING)
        assertEquals(0xa6c944L, DocsGraphConfig.folderColor(0))
        assertEquals(0xa6c944L, DocsGraphConfig.folderColor(8))
    }

    @Test
    fun groupsAndEdgesAreTheFixture() {
        assertEquals(1, fixture["version"]!!.jsonPrimitive.int)
        val expect = fixture["expect"]!!.jsonObject
        val groups = expect["groups"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
        assertEquals(groups, documents.associate { it.id to DocsGraphLayout.groupName(it.path) })
        val edges = expect["edges"]!!.jsonArray.map {
            DocsGraphEdge(it.jsonObject["source"]!!.jsonPrimitive.content, it.jsonObject["target"]!!.jsonPrimitive.content)
        }
        assertEquals(edges, resolvedEdges())
    }

    @Test
    fun linksPullDocumentsTogetherAndFitHoldsTheVisible() {
        val edges = resolvedEdges()
        val linked = DocsGraphLayout.positions(documents, edges)
        val unlinked = DocsGraphLayout.positions(documents, emptyList())
        fun distance(map: Map<String, DocsGraphPoint>) = hypot(map["a"]!!.x - map["b"]!!.x, map["a"]!!.y - map["b"]!!.y)
        assertTrue(distance(linked) < distance(unlinked))

        val visible = fixture["expect"]!!.jsonObject["visibleIds"]!!.jsonArray.map { linked[it.jsonPrimitive.content]!! }
        val fit = DocsGraphLayout.fitBounds(visible)
        val padding = DocsGraphConfig.Fit.PADDING.toDouble()
        assertTrue(fit.x <= visible.minOf { it.x } - padding)
        assertTrue(fit.x + fit.width >= visible.maxOf { it.x } + padding)
        assertTrue(fit.y <= visible.minOf { it.y } - padding)
        assertTrue(fit.y + fit.height >= visible.maxOf { it.y } + padding)
    }

    @Test
    fun theSameInputSettlesAtTheSamePositions() {
        val edges = resolvedEdges()
        val first = DocsGraphLayout.positions(documents, edges)
        val second = DocsGraphLayout.positions(documents, edges)
        assertEquals(first, second)
        assertTrue(first.values.all { it.x.isFinite() && it.y.isFinite() })

        // A larger graph, with coincident seeds avoided only by the jiggle.
        val many = (0 until 300).map { DocsGraphNode("n$it", "folder-${it % 7}/n$it.md", "Note ${it % 40}") }
        val links = (1 until 300).map { DocsGraphEdge("n$it", "n${(it * 7) % it}") }
        assertEquals(DocsGraphLayout.positions(many, links), DocsGraphLayout.positions(many, links))
    }

    @Test
    fun seedPutsFoldersOnARingAndMembersAroundTheirAnchor() {
        val seed = DocsGraphLayout.seed(documents)
        // Archive, Projects, Research: three folders; the first sits at the top.
        val archive = documents.indexOfFirst { it.id == "e" }
        assertEquals(0.0, seed.centers[archive].x, 1e-9)
        assertTrue(seed.centers[archive].y < 0)
        val research = documents.indices.filter { documents[it].path.startsWith("research") }
        assertEquals(1, research.map { seed.centers[it] }.toSet().size)
        // One folder sits at the origin (the sign of zero aside).
        val lone = DocsGraphLayout.seed(listOf(DocsGraphNode("x", "only/x.md", "X"))).centers.single()
        assertEquals(0.0, abs(lone.x) + abs(lone.y), 0.0)
    }

    @Test
    fun groupNamesFollowFoundationCapitalized() {
        assertEquals("Case Studies", DocsGraphLayout.groupName("/case-studies/x.md"))
        assertEquals("Mixed Case", DocsGraphLayout.groupName("MIXED_case/y.md"))
        assertEquals("Não arquivado", DocsGraphLayout.groupName("", "Não arquivado"))
        assertTrue(DocsGraphLayout.comesBefore("Z", "a"))
        assertTrue(DocsGraphLayout.comesBefore("a", "ab"))
        assertFalse(DocsGraphLayout.comesBefore("b", "b"))
    }

    @Test
    fun modelCountsDegreesGroupsAndVisibility() {
        val model = DocsGraphModel(documents, resolvedEdges())
        assertEquals(listOf("Archive", "Projects", "Research"), model.groups.map { it.name })
        assertEquals(listOf(1, 1, 3), model.groups.map { it.count })
        val b = model.indexById.getValue("b")
        assertEquals(2, model.nodes[b].degree)
        assertEquals(DocsGraphLayout.radius(2), model.nodes[b].radius, 0.0)
        assertEquals(10.5, DocsGraphLayout.radius(100), 0.0)
        assertEquals(listOf(model.indexById.getValue("a"), model.indexById.getValue("d")).sorted(), model.neighbors[b].sorted())
        val visible = model.visibility(setOf("Projects", "Archive"))
        assertEquals(listOf("a", "b", "c"), documents.indices.filter { visible[it] }.map { documents[it].id }.sorted())
        assertEquals("x".repeat(36), DocsGraphLayout.shortTitle("x".repeat(36)))
        assertEquals("x".repeat(34) + "…", DocsGraphLayout.shortTitle("x".repeat(37)))
        assertEquals(listOf("b1", "a1"), DocsGraphLayout.uniqueDocuments(listOf("b1", "a1", "b2")) { it.take(1) })
    }

    @Test
    fun cameraZoomKeepsTheAnchorAndHitTestFindsTheNearest() {
        val camera = DocsGraphCamera.fit(DocsGraphBounds(-100.0, -50.0, 200.0, 100.0), 400.0, 400.0)
        assertEquals(2.0, camera.scale, 1e-9)
        assertEquals(200.0, camera.screenX(0.0, 400.0), 1e-9)
        val zoomed = camera.zoomed(10.0, 300.0, 100.0, 400.0, 400.0)
        assertEquals(DocsGraphConfig.Zoom.MAX, zoomed.zoom, 1e-9)
        val before = camera.graphPoint(300.0, 100.0, 400.0, 400.0)
        val after = zoomed.graphPoint(300.0, 100.0, 400.0, 400.0)
        assertEquals(before.x, after.x, 1e-9)
        assertEquals(before.y, after.y, 1e-9)

        val model = DocsGraphModel(documents, resolvedEdges())
        val x = DoubleArray(documents.size) { it * 50.0 }
        val y = DoubleArray(documents.size)
        val all = List(documents.size) { true }
        val flat = DocsGraphCamera()
        assertEquals(1, DocsGraphCamera.hitTest(model, x, y, all, flat, 0.0, 0.0, 52.0, 1.0, 19.0))
        assertNull(DocsGraphCamera.hitTest(model, x, y, all, flat, 0.0, 0.0, 25.0, 40.0, 19.0))
        val hidden = all.toMutableList().also { it[1] = false }
        assertNull(DocsGraphCamera.hitTest(model, x, y, hidden, flat, 0.0, 0.0, 52.0, 1.0, 6.0))
    }

    @Test
    fun liveSimulationSettlesAndKeepsKnownPositions() {
        val model = DocsGraphModel(documents, resolvedEdges())
        val simulation = DocsGraphSimulation()
        simulation.load(model)
        var ticks = 0
        while (simulation.step()) ticks++
        assertTrue(ticks in 1..1_000)
        val settled = simulation.forces.point(model.indexById.getValue("a"))
        simulation.load(model)
        assertEquals(settled, simulation.forces.point(model.indexById.getValue("a")))
        simulation.beginDrag("a")
        simulation.drag("a", DocsGraphPoint(500.0, 500.0))
        repeat(5) { simulation.step() }
        assertEquals(DocsGraphPoint(500.0, 500.0), simulation.forces.point(model.indexById.getValue("a")))
        simulation.endDrag("a")
        while (simulation.step()) Unit
        assertFalse(simulation.isRunning)
    }
}
