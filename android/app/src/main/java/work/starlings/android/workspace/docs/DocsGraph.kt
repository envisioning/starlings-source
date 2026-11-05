package work.starlings.android.workspace.docs

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.ZoomIn
import androidx.compose.material.icons.outlined.ZoomOut
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import work.starlings.android.R
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.ui.EmptyState
import work.starlings.android.ui.PlainButton
import work.starlings.android.ui.RetryState
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * The Docs graph: `DocsGraphPane`, `DocsGraphView` and `DocsGraphCanvas`
 * from `Sources/DocsGraph.swift`, as `MobileDocsGraphScreen` shows them
 * from the rail's Explore block. The layout is `DocsGraphLayout.kt`.
 */

/** `DocsGraphSnapshot`: the documents and links in hand; [revision] moves on every publish. */
class DocsGraphSnapshot(val documents: List<DocsDocumentSummary>, val edges: List<DocsGraphEdge>, val revision: Int)

enum class DocsGraphStage { DOCUMENTS, LINKS }

/**
 * `DocsGraphLoader`: the recent list, every page of it to the shared cap,
 * then each document's links, [DocsGraphConfig.LINK_BATCH_SIZE] reads at a
 * time. Links publish at most every 250 ms so the simulation does not
 * rebuild per read. A document gone or closed between the list and its own
 * read (403, 404, 410) is skipped; any other failure ends the load.
 */
@Stable
class DocsGraphLoader(private val data: DocsData) {
    var graph by mutableStateOf<DocsGraphSnapshot?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var stage by mutableStateOf<DocsGraphStage?>(null)
        private set
    var loadedCount by mutableIntStateOf(0)
        private set
    var totalCount by mutableIntStateOf(0)
        private set
    private var revision = 0

    suspend fun load() {
        if (loading) return
        loading = true
        stage = DocsGraphStage.DOCUMENTS
        error = null
        loadedCount = 0
        totalCount = 0
        try {
            val read = DocsListRead.Recent(DocsGraphConfig.PAGE_SIZE)
            if (graph == null) data.cachedDocuments(read)?.let { publish(it, emptyList()) }
            // Paint the first page right away, then complete the same capped read.
            if (graph == null) {
                val first = data.allDocuments(read, cap = DocsGraphConfig.PAGE_SIZE)
                if (graph == null) publish(first, emptyList())
            }
            val documents = DocsGraphLayout.uniqueDocuments(data.allDocuments(read, cap = DocsGraphConfig.MAX_DOCUMENTS)) { it.id }
            publish(documents, emptyList())
            val ids = documents.map { it.id }.toSet()
            val edges = ArrayList<DocsGraphEdge>()
            val seen = HashSet<String>()
            totalCount = documents.size
            loadedCount = 0
            stage = DocsGraphStage.LINKS
            if (documents.isNotEmpty()) {
                coroutineScope {
                    val gate = Semaphore(DocsGraphConfig.LINK_BATCH_SIZE)
                    val results = Channel<DocsDocumentDetail?>(Channel.UNLIMITED)
                    documents.forEach { document -> launch { gate.withPermit { results.send(detail(document.id)) } } }
                    var loaded = 0
                    var lastPublish = System.nanoTime()
                    repeat(documents.size) {
                        val detail = results.receive()
                        detail?.links?.forEach { link ->
                            val target = link.toId ?: return@forEach
                            DocsGraphEdge.resolve(detail.id, target, ids, seen)?.let(edges::add)
                        }
                        loaded++
                        if (System.nanoTime() - lastPublish >= PUBLISH_INTERVAL_NANOS) {
                            lastPublish = System.nanoTime()
                            loadedCount = loaded
                            publish(documents, edges.toList())
                        }
                    }
                    loadedCount = loaded
                }
            }
            publish(documents, edges)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = DocsData.describe(e)
        } finally {
            stage = null
            loading = false
        }
    }

    private suspend fun detail(id: String): DocsDocumentDetail? = try {
        data.document(id)
    } catch (e: StarlingsApiError.Service) {
        if (e.status in GONE) null else throw e
    }

    private fun publish(documents: List<DocsDocumentSummary>, edges: List<DocsGraphEdge>) {
        revision++
        graph = DocsGraphSnapshot(DocsGraphLayout.uniqueDocuments(documents) { it.id }, edges, revision)
    }

    private companion object {
        const val PUBLISH_INTERVAL_NANOS = 250_000_000L
        val GONE = setOf(403, 404, 410)
    }
}

/** `DocsGraphPane`: the load, its states, and the graph once there is one. */
@Composable
fun DocsGraphPane(data: DocsData, onOpen: (DocsDocumentSummary) -> Unit, selectedId: String? = null) {
    val loader = remember(data) { DocsGraphLoader(data) }
    val scope = rememberCoroutineScope()
    val c = Starlings.colors
    LaunchedEffect(loader) { if (loader.graph == null && !loader.loading) loader.load() }

    val graph = loader.graph
    val error = loader.error
    val failed = stringResource(R.string.docs_graph_failed)
    val retry = stringResource(R.string.docs_retry)
    when {
        graph != null && graph.documents.isNotEmpty() -> Column(Modifier.fillMaxSize()) {
            if (error != null) {
                Box(Modifier.fillMaxWidth().heightIn(max = 180.dp)) { RetryState(failed, error, retry, { scope.launch { loader.load() } }) }
            }
            DocsGraphView(graph, loader.stage, loader.loadedCount, loader.totalCount, selectedId, onOpen)
        }
        error != null -> RetryState(failed, error, retry, { scope.launch { loader.load() } })
        loader.loading -> Column(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CircularProgressIndicator(Modifier.size(18.dp), color = c.secondary, strokeWidth = 2.dp)
            Text(stringResource(R.string.docs_graph_loading_documents), style = StarlingsType.footnote, color = c.secondary)
        }
        graph != null -> EmptyState(
            stringResource(R.string.docs_graph_empty_title),
            Icons.Outlined.Hub,
            stringResource(R.string.docs_graph_empty_message),
        )
        else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = c.secondary)
        }
    }
}

/**
 * `DocsGraphViewport`: until the person pans or zooms, the camera follows
 * Fit every frame, so the graph stays framed while it unfolds. Fit hands it
 * back to that. Sizes are in dp, as iOS points.
 */
@Stable
private class DocsGraphViewport {
    var manual by mutableStateOf<DocsGraphCamera?>(null)
    var current = DocsGraphCamera()
        private set
    var width = 0.0
        private set
    var height = 0.0
        private set

    val canZoomIn: Boolean get() = (manual?.zoom ?: 1.0) < DocsGraphConfig.Zoom.MAX - 0.000_001
    val canZoomOut: Boolean get() = (manual?.zoom ?: 1.0) > DocsGraphConfig.Zoom.MIN + 0.000_001

    fun resolve(width: Double, height: Double, fit: () -> DocsGraphCamera): DocsGraphCamera {
        this.width = width
        this.height = height
        current = manual ?: fit()
        return current
    }

    fun takeControl(): DocsGraphCamera {
        if (manual == null) manual = current
        return manual ?: current
    }

    fun zoom(by: Double) {
        val camera = manual ?: current
        manual = camera.zoomed(camera.zoom * by, width / 2, height / 2, width, height)
    }

    fun fit() {
        manual = null
    }
}

/** `DocsGraphView`: the chrome around the graph. */
@Composable
private fun DocsGraphView(
    graph: DocsGraphSnapshot,
    stage: DocsGraphStage?,
    loadedCount: Int,
    totalCount: Int,
    selectedId: String?,
    onOpen: (DocsDocumentSummary) -> Unit,
) {
    val c = Starlings.colors
    val unfiled = stringResource(R.string.docs_unfiled)
    val simulation = remember { DocsGraphSimulation() }
    val viewport = remember { DocsGraphViewport() }
    var hidden by remember { mutableStateOf(emptySet<String>()) }
    // Moves when a drag reheats the simulation, so the frame loop runs again.
    var run by remember { mutableIntStateOf(0) }
    val model = remember(graph.revision) {
        DocsGraphModel(graph.documents.map { DocsGraphNode(it.id, it.path, it.title) }, graph.edges, unfiled)
            .also { simulation.load(it, unfiled) }
    }
    val visible = remember(model, hidden) { model.visibility(hidden) }

    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.docs_graph_title), style = StarlingsType.title3.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
                Text(stringResource(R.string.docs_graph_caption), style = StarlingsType.footnote, color = c.secondary)
            }
            Spacer(Modifier.width(8.dp))
            ZoomControls(viewport, canFit = visible.contains(true))
        }
        GroupsBar(model, hidden) { hidden = it }
        if (stage != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (stage == DocsGraphStage.LINKS && totalCount > 0) {
                    LinearProgressIndicator(
                        progress = { loadedCount.toFloat() / totalCount },
                        modifier = Modifier.width(150.dp),
                        color = c.accentMark,
                        trackColor = c.border,
                    )
                } else {
                    CircularProgressIndicator(Modifier.size(14.dp), color = c.secondary, strokeWidth = 1.5.dp)
                }
                Text(
                    stringResource(if (stage == DocsGraphStage.DOCUMENTS) R.string.docs_graph_loading_documents else R.string.docs_graph_loading_links),
                    style = StarlingsType.caption, color = c.secondary,
                )
                if (stage == DocsGraphStage.LINKS && totalCount > 0) {
                    Text(stringResource(R.string.docs_graph_progress, loadedCount, totalCount), style = StarlingsType.caption.copy(fontFeatureSettings = "tnum"), color = c.secondary)
                }
            }
        }
        GraphCanvas(
            model = model,
            visible = visible,
            selected = selectedId?.let { model.indexById[it] },
            simulation = simulation,
            viewport = viewport,
            run = run,
            onRun = { run++ },
            onOpen = { index -> onOpen(graph.documents[index]) },
            modifier = Modifier.fillMaxWidth().weight(1f).heightIn(min = 360.dp),
        )
        Text(stringResource(R.string.docs_graph_help), style = StarlingsType.caption, color = c.secondary)
    }
}

/** `DocsGraphZoomControls`: zoom in, zoom out and Fit. */
@Composable
private fun ZoomControls(viewport: DocsGraphViewport, canFit: Boolean) {
    val c = Starlings.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { viewport.zoom(1.2) }, enabled = viewport.canZoomIn) {
            Icon(Icons.Outlined.ZoomIn, stringResource(R.string.docs_graph_zoom_in), tint = if (viewport.canZoomIn) c.primary else c.secondary.copy(alpha = 0.4f))
        }
        IconButton(onClick = { viewport.zoom(1 / 1.2) }, enabled = viewport.canZoomOut) {
            Icon(Icons.Outlined.ZoomOut, stringResource(R.string.docs_graph_zoom_out), tint = if (viewport.canZoomOut) c.primary else c.secondary.copy(alpha = 0.4f))
        }
        PlainButton(
            stringResource(R.string.docs_graph_fit),
            { if (canFit) viewport.fit() },
            color = if (canFit) c.primary else c.secondary.copy(alpha = 0.4f),
        )
    }
}

/** `groupsBar`: the folders, each a switch for its documents, then Show all groups. */
@Composable
private fun GroupsBar(model: DocsGraphModel, hidden: Set<String>, onChange: (Set<String>) -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.docs_folders), style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
        model.groups.forEach { group ->
            val shown = group.name !in hidden
            Row(
                Modifier
                    .clip(CircleShape)
                    .background(if (shown) c.primary.copy(alpha = 0.07f) else Color.Transparent, CircleShape)
                    .semantics(mergeDescendants = true) { selected = shown }
                    .clickable(role = Role.Button) { onChange(if (shown) hidden + group.name else hidden - group.name) }
                    .padding(horizontal = 7.dp, vertical = 5.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(8.dp).background(Color(0xFF000000 or group.color), CircleShape))
                Text(group.name, style = StarlingsType.caption, color = c.primary)
                Text("${group.count}", style = StarlingsType.caption2, color = c.secondary)
            }
        }
        if (hidden.isNotEmpty()) {
            Text(
                stringResource(R.string.docs_graph_show_all),
                Modifier.clickable(role = Role.Button) { onChange(emptySet()) }.padding(horizontal = 4.dp, vertical = 5.dp),
                style = StarlingsType.caption, color = c.primary,
            )
        }
    }
}

/**
 * `DocsGraphCanvas`: one Canvas, redrawn each display frame while the
 * simulation runs and still once it settles. A tap opens the document under
 * it; a drag from a document pulls it, from empty space pans; a pinch zooms.
 * TalkBack reads the graph as one element with an action per document shown.
 */
@Composable
private fun GraphCanvas(
    model: DocsGraphModel,
    visible: List<Boolean>,
    selected: Int?,
    simulation: DocsGraphSimulation,
    viewport: DocsGraphViewport,
    run: Int,
    onRun: () -> Unit,
    onOpen: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Starlings.colors
    val density = LocalDensity.current.density.toDouble()
    val measurer = rememberTextMeasurer(cacheSize = 512)
    var frame by remember { mutableIntStateOf(0) }
    var hovered by remember { mutableStateOf<Int?>(null) }
    val shape = RoundedCornerShape(14.dp)
    val label = stringResource(R.string.docs_graph_label)

    LaunchedEffect(model, run) {
        while (simulation.isRunning) {
            withFrameNanos { }
            simulation.step()
            frame++
        }
    }

    fun hit(atX: Float, atY: Float): Int? {
        val forces = simulation.forces
        return DocsGraphCamera.hitTest(
            model, forces.x, forces.y, visible, viewport.current, viewport.width, viewport.height,
            atX / density, atY / density, MINIMUM_REACH,
        )
    }

    val actions = remember(model, visible) {
        model.nodes.indices.filter { it < visible.size && visible[it] }.map { index ->
            CustomAccessibilityAction(model.nodes[index].node.title) { onOpen(index); true }
        }
    }
    val labelStyle = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Medium, color = c.primary)

    Canvas(
        modifier
            .clip(shape)
            .background(c.primary.copy(alpha = 0.025f), shape)
            .border(1.dp, c.primary.copy(alpha = 0.10f), shape)
            .semantics {
                contentDescription = label
                customActions = actions
            }
            .pointerInput(model, visible) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent()
                        when (event.type) {
                            PointerEventType.Move -> if (event.changes.none { it.pressed }) {
                                val at = event.changes.first().position
                                val found = hit(at.x, at.y)
                                if (found != hovered) hovered = found
                            }
                            PointerEventType.Exit -> hovered = null
                            else -> Unit
                        }
                    }
                }
            }
            .pointerInput(model, visible) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val start = down.position
                    val target = hit(start.x, start.y)
                    var moved = false
                    var pinching = false
                    var draggedId: String? = null
                    while (true) {
                        val event = awaitPointerEvent()
                        val pressed = event.changes.filter { it.pressed }
                        if (pressed.isEmpty()) break
                        if (pressed.size >= 2) {
                            if (draggedId != null) {
                                simulation.endDrag(draggedId)
                                draggedId = null
                            }
                            moved = true
                            pinching = true
                            val camera = viewport.takeControl()
                            val zoom = event.calculateZoom().toDouble()
                            val centroid = event.calculateCentroid()
                            val pan = event.calculatePan()
                            viewport.manual = camera
                                .zoomed(camera.zoom * zoom, centroid.x / density, centroid.y / density, viewport.width, viewport.height)
                                .panned(pan.x / density, pan.y / density)
                            event.changes.forEach { it.consume() }
                            continue
                        }
                        if (pinching) continue
                        val change = pressed.first()
                        if (!moved && (change.position - start).getDistance() > viewConfiguration.touchSlop) {
                            moved = true
                            // Freeze the camera first: a node dragged against a
                            // camera that keeps refitting would chase its own frame.
                            viewport.takeControl()
                            if (target != null) {
                                draggedId = model.nodes[target].node.id
                                simulation.beginDrag(model.nodes[target].node.id)
                                onRun()
                            }
                        }
                        if (moved) {
                            val id = draggedId
                            if (id != null) {
                                val camera = viewport.current
                                simulation.drag(id, camera.graphPoint(change.position.x / density, change.position.y / density, viewport.width, viewport.height))
                            } else {
                                val delta = change.positionChange()
                                viewport.manual = (viewport.manual ?: viewport.current).panned(delta.x / density, delta.y / density)
                            }
                            change.consume()
                        }
                    }
                    draggedId?.let { simulation.endDrag(it) }
                    if (!moved && target != null) onOpen(target)
                }
            },
    ) {
        frame // a simulation frame redraws
        val forces = simulation.forces
        val width = size.width / density
        val height = size.height / density
        val camera = viewport.resolve(width, height) {
            val points = ArrayList<DocsGraphPoint>()
            for (index in 0 until min(forces.size, visible.size)) if (visible[index]) points += forces.point(index)
            DocsGraphCamera.fit(DocsGraphLayout.fitBounds(points), width, height)
        }
        val count = minOf(model.nodes.size, forces.size, visible.size)
        if (count == 0) return@Canvas
        val d = density.toFloat()
        val bounds = Rect(-40f, -40f, width.toFloat() + 40f, height.toFloat() + 40f)
        val sx = FloatArray(count) { camera.screenX(forces.x[it], width).toFloat() }
        val sy = FloatArray(count) { camera.screenY(forces.y[it], height).toFloat() }
        val focus = hovered?.takeIf { it < count }
        val focused: Set<Int> = focus?.let { model.neighbors[it].toSet() + it } ?: emptySet()

        // Edges: one path, one stroke. Lines into the focused node go on top.
        val edges = Path()
        val lit = Path()
        for (link in model.edges) {
            if (link.source >= count || link.target >= count || !visible[link.source] || !visible[link.target]) continue
            val fx = sx[link.source]
            val fy = sy[link.source]
            val tx = sx[link.target]
            val ty = sy[link.target]
            if (!bounds.contains(Offset(fx, fy)) && !bounds.contains(Offset(tx, ty)) &&
                !bounds.overlaps(Rect(min(fx, tx), min(fy, ty), min(fx, tx) + abs(fx - tx), min(fy, ty) + abs(fy - ty)))
            ) continue
            val path = if (focus != null && (link.source == focus || link.target == focus)) lit else edges
            path.moveTo(fx * d, fy * d)
            path.lineTo(tx * d, ty * d)
        }
        drawPath(edges, c.secondary.copy(alpha = if (focus == null) 0.32f else 0.12f), style = Stroke(width = 1f * d))
        drawPath(lit, c.accentMark.copy(alpha = 0.85f), style = Stroke(width = 1.5f * d))

        // Nodes: one path per folder colour, dimmed apart from the focus.
        val bright = List(model.groups.size) { Path() }
        val dim = List(model.groups.size) { Path() }
        val radii = FloatArray(count)
        for (index in 0 until count) {
            if (!visible[index] || !bounds.contains(Offset(sx[index], sy[index]))) continue
            val node = model.nodes[index]
            val radius = max(1.5, node.radius * camera.scale).toFloat()
            radii[index] = radius
            val circle = Rect((sx[index] - radius) * d, (sy[index] - radius) * d, (sx[index] + radius) * d, (sy[index] + radius) * d)
            (if (focus == null || index in focused) bright else dim)[node.group].addOval(circle)
        }
        model.groups.forEachIndexed { group, info ->
            val color = Color(0xFF000000 or info.color)
            drawPath(dim[group], color.copy(alpha = 0.25f))
            drawPath(bright[group], color)
        }
        for ((index, color) in listOf(selected to c.accentMark, focus to c.primary)) {
            if (index == null || index >= count || !visible[index] || radii[index] <= 0f) continue
            drawCircle(color, (radii[index] + 2) * d, Offset(sx[index] * d, sy[index] * d), style = Stroke(width = 2f * d))
        }

        // Labels fade in with zoom, earlier for well-linked documents; the
        // focus and the open document always carry theirs.
        var drawn = 0
        val few = model.nodes.size <= 35
        for (index in 0 until count) {
            if (radii[index] <= 0f) continue
            val always = index == selected || index in focused
            var opacity = if (always || few) {
                1.0
            } else {
                val reach = camera.scale * (1 + sqrt(model.nodes[index].degree.toDouble()) / 3)
                min(1.0, max(0.0, (reach - 0.6) / 0.4))
            }
            if (!always && !few && focus != null) opacity *= 0.3
            if (opacity <= 0.02 || (!always && drawn >= 300)) continue
            drawn++
            val layout = measurer.measure(model.nodes[index].shortTitle, labelStyle)
            drawText(
                layout,
                topLeft = Offset(sx[index] * d - layout.size.width / 2f, (sy[index] + radii[index] + 3) * d),
                alpha = opacity.toFloat(),
            )
        }
    }
}

/** A fingertip needs about a 44 dp target (iOS's 19 pt reach on a phone). */
private const val MINIMUM_REACH = 19.0
