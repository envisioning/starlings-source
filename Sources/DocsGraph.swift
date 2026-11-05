import DocsKit
import EnvisioningUI
import SwiftUI

/// The workspace's accent as a mark, on whichever client draws the graph.
#if os(macOS)
private let docsGraphAccent = Color(nsColor: StarlingsColors.accentMark)
#else
private let docsGraphAccent = StarlingsMobileColors.accentMark
#endif

struct DocsGraphEdge: Hashable, Sendable {
    let sourceID: String
    let targetID: String

    static func resolve(
        sourceID: String,
        targetID: String,
        documentIDs: Set<String>,
        seenKeys: inout Set<String>
    ) -> DocsGraphEdge? {
        guard sourceID != targetID, documentIDs.contains(sourceID), documentIDs.contains(targetID) else { return nil }
        let key = [sourceID, targetID].sorted().joined(separator: "\u{0}")
        guard seenKeys.insert(key).inserted else { return nil }
        return DocsGraphEdge(sourceID: sourceID, targetID: targetID)
    }
}

struct DocsGraphSnapshot: Sendable {
    let documents: [DocsDocumentSummary]
    let edges: [DocsGraphEdge]
    /// Bumps on every publish, so the view derives its model once per change.
    let revision: Int
}

enum DocsGraphLoadingStage: Sendable, Equatable {
    case documents
    case links
}

@MainActor
final class DocsGraphLoader: ObservableObject {
    @Published private(set) var graph: DocsGraphSnapshot?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isLoading = false
    @Published private(set) var stage: DocsGraphLoadingStage?
    @Published private(set) var loadedCount = 0
    @Published private(set) var totalCount = 0
    private var revision = 0

    /// Links stream in far faster than anyone can watch them land. One publish
    /// per interval keeps the graph and its simulation from rebuilding per read.
    private static let edgePublishInterval = Duration.milliseconds(250)

    func load(client: DocsClient) async {
        guard !isLoading else { return }
        DocsDiagnostics.event("graph load started")
        isLoading = true
        stage = .documents
        errorMessage = nil
        loadedCount = 0
        totalCount = 0
        defer {
            stage = nil
            isLoading = false
        }

        do {
            let read = DocsListRead.recent(limit: DocsGraphConfiguration.current.pageSize)
            if graph == nil, let cached = client.cachedDocuments(read) {
                publish(documents: cached, edges: [])
                DocsDiagnostics.count("graph cached documents", cached.count)
            }

            // Paint the first page right away, then complete the same capped
            // index read the browser walks page by page.
            if graph == nil {
                let firstPage = try await client.documents(read)
                try Task.checkCancellation()
                if graph == nil { publish(documents: firstPage, edges: []) }
                DocsDiagnostics.count("graph first page documents", firstPage.count)
            }
            // Offset paging returns a document twice when it is edited mid-walk.
            let documents = DocsGraphLayout.uniqueDocuments(
                try await client.allDocuments(read, cap: DocsGraphConfiguration.current.maxDocuments)
            )
            publish(documents: documents, edges: [])
            DocsDiagnostics.count("graph documents loaded", documents.count)
            let documentIDs = Set(documents.map(\.id))
            var edges: [DocsGraphEdge] = []
            var edgeKeys = Set<String>()
            totalCount = documents.count
            loadedCount = 0
            stage = .links

            if !documents.isEmpty {
                var skipped = 0
                var loaded = 0
                var lastPublish = ContinuousClock.now
                try await withThrowingTaskGroup(of: DocsDocumentDetail?.self) { group in
                    var nextIndex = 0
                    for _ in 0..<min(DocsGraphConfiguration.current.linkBatchSize, documents.count) {
                        let document = documents[nextIndex]
                        nextIndex += 1
                        group.addTask { try await Self.detail(id: document.id, client: client) }
                    }

                    while let result = try await group.next() {
                        try Task.checkCancellation()
                        if let detail = result {
                            for link in detail.links {
                                guard let targetID = link.toId,
                                      let edge = DocsGraphEdge.resolve(
                                        sourceID: detail.id,
                                        targetID: targetID,
                                        documentIDs: documentIDs,
                                        seenKeys: &edgeKeys
                                      ) else { continue }
                                edges.append(edge)
                            }
                        } else {
                            skipped += 1
                        }

                        loaded += 1
                        if ContinuousClock.now - lastPublish >= Self.edgePublishInterval {
                            lastPublish = ContinuousClock.now
                            loadedCount = loaded
                            publish(documents: documents, edges: edges)
                        }

                        if nextIndex < documents.count {
                            let document = documents[nextIndex]
                            nextIndex += 1
                            group.addTask { try await Self.detail(id: document.id, client: client) }
                        }
                    }
                }
                loadedCount = loaded
                if skipped > 0 { DocsDiagnostics.count("graph documents skipped", skipped) }
            }

            publish(documents: documents, edges: edges)
            DocsDiagnostics.count("graph links resolved", edges.count)
            DocsDiagnostics.event("graph load finished")
        } catch is CancellationError {
            DocsDiagnostics.event("graph load cancelled")
            return
        } catch let error as URLError where error.code == .cancelled {
            DocsDiagnostics.event("graph load cancelled")
            return
        } catch {
            errorMessage = error.localizedDescription
            DocsDiagnostics.failure("Docs graph load", error: error)
        }
    }

    /**
     One document's links. A document deleted or closed to this member between
     the index read and this read is skipped, so one gone row never costs the
     whole graph its edges. Any other failure still ends the load.
     */
    private static func detail(id: String, client: DocsClient) async throws -> DocsDocumentDetail? {
        do {
            return try await client.document(id: id)
        } catch DocsClientError.api(let status, _, _) where [403, 404, 410].contains(status) {
            return nil
        }
    }

    private func publish(documents: [DocsDocumentSummary], edges: [DocsGraphEdge]) {
        revision += 1
        graph = DocsGraphSnapshot(
            documents: DocsGraphLayout.uniqueDocuments(documents),
            edges: edges,
            revision: revision
        )
    }
}

struct DocsGraphPane: View {
    let client: DocsClient
    var selectedID: String? = nil
    let onOpen: (DocsDocumentSummary) -> Void
    @StateObject private var loader = DocsGraphLoader()

    var body: some View {
        Group {
            if let graph = loader.graph, !graph.documents.isEmpty {
                VStack(spacing: 10) {
                    if let errorMessage = loader.errorMessage {
                        EnvisioningRetryState(String(localized: "Couldn’t load Docs graph"), message: errorMessage) {
                            Task { await loader.load(client: client) }
                        }
                    }
                    DocsGraphView(
                        graph: graph,
                        loadingStage: loader.stage,
                        loadedCount: loader.loadedCount,
                        totalCount: loader.totalCount,
                        selectedID: selectedID,
                        onOpen: onOpen
                    )
                }
            } else if let errorMessage = loader.errorMessage {
                EnvisioningRetryState(String(localized: "Couldn’t load Docs graph"), message: errorMessage) {
                    Task { await loader.load(client: client) }
                }
            } else if loader.isLoading {
                VStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Loading documents…").font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let graph = loader.graph, graph.documents.isEmpty {
                EnvisioningEmptyState(
                    "There are no documents to show yet.",
                    systemImage: "point.3.connected.trianglepath.dotted",
                    message: String(localized: "Documents you add to Docs will appear here.")
                )
            } else if let graph = loader.graph {
                DocsGraphView(
                    graph: graph,
                    loadingStage: loader.stage,
                    loadedCount: loader.loadedCount,
                    totalCount: loader.totalCount,
                    selectedID: selectedID,
                    onOpen: onOpen
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if loader.graph == nil && !loader.isLoading { await loader.load(client: client) }
        }
    }
}

/// The chrome around the graph. Nothing here reads a position or the camera,
/// so a frame of the simulation or a pan never re-runs this body.
struct DocsGraphView: View {
    let graph: DocsGraphSnapshot
    let loadingStage: DocsGraphLoadingStage?
    let loadedCount: Int
    let totalCount: Int
    let selectedID: String?
    let onOpen: (DocsDocumentSummary) -> Void

    @State private var model = DocsGraphModel(graph: DocsGraphSnapshot(documents: [], edges: [], revision: 0))
    @State private var hiddenGroups = Set<String>()
    @State private var visible: [Bool] = []
    @State private var simulation = DocsGraphSimulation()
    @State private var viewport = DocsGraphViewport()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Graph").font(.title3.weight(.semibold))
                    Text("Each dot is a document; lines are wikilinks. Colors group documents by folder.")
                        .font(.footnote).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                DocsGraphZoomControls(viewport: viewport, canFit: visible.contains(true))
            }
            groupsBar
            if let loadingStage {
                HStack(spacing: 8) {
                    if loadingStage == .links, totalCount > 0 {
                        ProgressView(value: Double(loadedCount), total: Double(totalCount))
                            .frame(maxWidth: 150)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                    Text(loadingStage == .documents ? String(localized: "Loading documents…") : String(localized: "Loading document links…"))
                        .font(.caption).foregroundStyle(.secondary)
                    if loadingStage == .links, totalCount > 0 {
                        Text(String.localizedStringWithFormat(
                            String(localized: "%lld / %lld", comment: "Docs graph documents loaded and total"),
                            Int64(loadedCount),
                            Int64(totalCount)
                        ))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
            DocsGraphCanvas(
                model: model,
                visible: visible,
                selectedIndex: selectedID.flatMap { model.indexByID[$0] },
                simulation: simulation,
                viewport: viewport,
                onOpen: onOpen
            )
            .frame(minHeight: 360)
            .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 14))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.primary.opacity(0.10), lineWidth: 1))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("Docs graph"))
            .accessibilityChildren {
                ForEach(model.nodes.indices.filter { visible.indices.contains($0) && visible[$0] }, id: \.self) { index in
                    let document = model.nodes[index].document
                    Button(document.title) { onOpen(document) }
                }
            }
            Text("Drag to pan, or drag a document to pull its links; pinch or use the controls to zoom. Point at a document to trace its links; select it to open it.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .onChange(of: graph.revision, initial: true) {
            model = DocsGraphModel(graph: graph)
            visible = model.visibility(hiding: hiddenGroups)
            simulation.load(model)
        }
        .onChange(of: hiddenGroups) {
            visible = model.visibility(hiding: hiddenGroups)
        }
    }

    private var groupsBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Text("Folders").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(model.groups, id: \.name) { group in
                    let shown = !hiddenGroups.contains(group.name)
                    Button {
                        if shown { hiddenGroups.insert(group.name) } else { hiddenGroups.remove(group.name) }
                    } label: {
                        HStack(spacing: 5) {
                            Circle().fill(group.color).frame(width: 8, height: 8)
                            Text(group.name).font(.caption)
                            Text("\(group.count)").font(.caption2).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 7)
                        .padding(.vertical, 5)
                        .background(shown ? Color.primary.opacity(0.07) : Color.clear, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .modifier(DocsGraphHoverLift())
                    .accessibilityLabel(Text(group.name))
                    .accessibilityAddTraits(shown ? .isSelected : [])
                }
                if !hiddenGroups.isEmpty {
                    Button("Show all groups") { hiddenGroups.removeAll() }
                        .buttonStyle(.plain)
                        .modifier(DocsGraphHoverLift())
                }
            }
            .padding(.horizontal, 1)
        }
    }
}

/// Its own view so a zoom re-runs only these three buttons.
private struct DocsGraphZoomControls: View {
    let viewport: DocsGraphViewport
    let canFit: Bool

    var body: some View {
        HStack(spacing: 10) {
            Button { viewport.zoom(by: 1.2) } label: { Image(systemName: "plus.magnifyingglass") }
                .help(String(localized: "Zoom in"))
                .accessibilityLabel("Zoom in")
                .buttonStyle(.plain)
                .modifier(DocsGraphHoverLift())
                .disabled(!viewport.canZoomIn)
            Button { viewport.zoom(by: 1 / 1.2) } label: { Image(systemName: "minus.magnifyingglass") }
                .help(String(localized: "Zoom out"))
                .accessibilityLabel("Zoom out")
                .buttonStyle(.plain)
                .modifier(DocsGraphHoverLift())
                .disabled(!viewport.canZoomOut)
            Button("Fit") { viewport.fit() }
                .buttonStyle(.plain)
                .modifier(DocsGraphHoverLift())
                .disabled(!canFit)
        }
    }
}

/**
 The graph itself: one Canvas, redrawn each display frame while the
 simulation runs and paused once it settles. Nodes are drawn, not views, so
 the cost of a frame is drawing — never diffing thousands of buttons.
 */
private struct DocsGraphCanvas: View {
    let model: DocsGraphModel
    let visible: [Bool]
    let selectedIndex: Int?
    let simulation: DocsGraphSimulation
    let viewport: DocsGraphViewport
    let onOpen: (DocsDocumentSummary) -> Void

    @State private var hovered: Int?
    @State private var draggedID: String?
    @State private var panOrigin: DocsGraphCamera?
    @State private var zoomOrigin: DocsGraphCamera?

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            TimelineView(.animation(paused: !simulation.isRunning)) { timeline in
                let frame = simulation.frame(at: timeline.date)
                let camera = viewport.resolve(size: size) {
                    DocsGraphCamera.fit(DocsGraphLayout.fitBounds(frame.points(where: visible)), in: size)
                }
                let focus = hovered.map { DocsGraphFocus(index: $0, neighbors: model.neighbors[$0]) }
                Canvas { context, size in
                    DocsGraphRenderer.draw(
                        in: &context,
                        size: size,
                        frame: frame,
                        camera: camera,
                        model: model,
                        visible: visible,
                        selected: selectedIndex,
                        focus: focus
                    )
                }
            }
            .contentShape(Rectangle())
            // hover: the canvas draws its own ring under the pointer
            .onContinuousHover { phase in
                switch phase {
                case .active(let location):
                    let hit = hitTest(location)
                    if hit != hovered { hovered = hit }
                case .ended:
                    hovered = nil
                }
            }
            .onTapGesture(coordinateSpace: .local) { location in
                guard let index = hitTest(location) else { return }
                onOpen(model.nodes[index].document)
            }
            .gesture(dragGesture)
            .simultaneousGesture(zoomGesture)
        }
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                if draggedID == nil, panOrigin == nil {
                    // Freeze the camera first: a node dragged against a camera
                    // that keeps refitting would chase its own frame.
                    let camera = viewport.takeControl()
                    if let index = hitTest(value.startLocation) {
                        draggedID = model.nodes[index].document.id
                        simulation.beginDrag(id: model.nodes[index].document.id)
                    } else {
                        panOrigin = camera
                    }
                }
                if let draggedID {
                    simulation.drag(id: draggedID, to: viewport.current.graphPoint(value.location, in: viewport.size))
                } else if let panOrigin {
                    viewport.manual = panOrigin.panned(by: value.translation)
                }
            }
            .onEnded { _ in
                if let draggedID { simulation.endDrag(id: draggedID) }
                draggedID = nil
                panOrigin = nil
            }
    }

    private var zoomGesture: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let origin = zoomOrigin ?? viewport.takeControl()
                if zoomOrigin == nil { zoomOrigin = origin }
                viewport.manual = origin.zoomed(
                    to: origin.zoom * value.magnification,
                    around: value.startLocation,
                    in: viewport.size
                )
            }
            .onEnded { _ in zoomOrigin = nil }
    }

#if os(iOS)
    /// A fingertip needs about a 44pt target; a pointer finds a 6pt dot.
    private static let minimumReach = 19.0
#else
    private static let minimumReach = 6.0
#endif

    /// The nearest visible node under the pointer, measured on screen.
    private func hitTest(_ location: CGPoint) -> Int? {
        let camera = viewport.current
        let size = viewport.size
        let frame = simulation.frame(at: nil)
        var best: Int?
        var bestDistance = Double.infinity
        for index in model.nodes.indices where index < frame.x.count && index < visible.count && visible[index] {
            let point = camera.screenPoint(x: frame.x[index], y: frame.y[index], in: size)
            let reach = max(Double(model.nodes[index].radius * camera.scale), Self.minimumReach) + 3
            let distance = hypot(Double(point.x - location.x), Double(point.y - location.y))
            if distance <= reach, distance < bestDistance {
                best = index
                bestDistance = distance
            }
        }
        return best
    }
}

private struct DocsGraphFocus {
    let index: Int
    let neighbors: [Int]
}

private enum DocsGraphRenderer {
    static func draw(
        in context: inout GraphicsContext,
        size: CGSize,
        frame: DocsGraphFrame,
        camera: DocsGraphCamera,
        model: DocsGraphModel,
        visible: [Bool],
        selected: Int?,
        focus: DocsGraphFocus?
    ) {
        let count = min(model.nodes.count, frame.x.count, visible.count)
        guard count > 0 else { return }
        let bounds = CGRect(origin: .zero, size: size).insetBy(dx: -40, dy: -40)
        var screen = [CGPoint](repeating: .zero, count: count)
        for index in 0..<count {
            screen[index] = camera.screenPoint(x: frame.x[index], y: frame.y[index], in: size)
        }
        let focused: Set<Int> = focus.map { Set($0.neighbors + [$0.index]) } ?? []

        // Edges: one path, one stroke. Lines into the focused node go on top.
        var edges = Path()
        var lit = Path()
        for link in model.edges where link.source < count && link.target < count {
            guard visible[link.source], visible[link.target] else { continue }
            let from = screen[link.source]
            let to = screen[link.target]
            if !bounds.contains(from), !bounds.contains(to),
               !bounds.intersects(CGRect(x: min(from.x, to.x), y: min(from.y, to.y), width: abs(from.x - to.x), height: abs(from.y - to.y))) {
                continue
            }
            if let focus, link.source == focus.index || link.target == focus.index {
                lit.move(to: from)
                lit.addLine(to: to)
            } else {
                edges.move(to: from)
                edges.addLine(to: to)
            }
        }
        context.stroke(edges, with: .color(Color.secondary.opacity(focus == nil ? 0.32 : 0.12)), lineWidth: 1)
        context.stroke(lit, with: .color(docsGraphAccent.opacity(0.85)), lineWidth: 1.5)

        // Nodes: one path per folder colour, dimmed apart from the focus.
        var bright = [Path](repeating: Path(), count: model.groups.count)
        var dim = [Path](repeating: Path(), count: model.groups.count)
        var radii = [CGFloat](repeating: 0, count: count)
        for index in 0..<count where visible[index] {
            let point = screen[index]
            guard bounds.contains(point) else { continue }
            let node = model.nodes[index]
            let radius = max(1.5, node.radius * camera.scale)
            radii[index] = radius
            let circle = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
            if focus == nil || focused.contains(index) {
                bright[node.group].addEllipse(in: circle)
            } else {
                dim[node.group].addEllipse(in: circle)
            }
        }
        for (group, info) in model.groups.enumerated() {
            context.fill(dim[group], with: .color(info.color.opacity(0.25)))
            context.fill(bright[group], with: .color(info.color))
        }
        for (index, color, width) in [(selected, docsGraphAccent, CGFloat(2)), (focus?.index, Color.primary, CGFloat(2))] {
            guard let index, index < count, visible[index], radii[index] > 0 else { continue }
            let point = screen[index]
            let radius = radii[index] + 2
            context.stroke(
                Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)),
                with: .color(color),
                lineWidth: width
            )
        }

        // Labels fade in with zoom, earlier for well-linked documents; the
        // focus and the open document always carry theirs.
        var drawn = 0
        let few = model.nodes.count <= 35
        for index in 0..<count where radii[index] > 0 {
            let always = index == selected || focused.contains(index)
            var opacity: Double
            if always || few {
                opacity = 1
            } else {
                let reach = Double(camera.scale) * (1 + Double(model.nodes[index].degree).squareRoot() / 3)
                opacity = min(1, max(0, (reach - 0.6) / 0.4))
                if focus != nil { opacity *= 0.3 }
            }
            guard opacity > 0.02, always || drawn < 300 else { continue }
            drawn += 1
            var label = context
            label.opacity = opacity
            label.draw(
                Text(model.nodes[index].shortTitle)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.primary),
                at: CGPoint(x: screen[index].x, y: screen[index].y + radii[index] + 3),
                anchor: .top
            )
        }
    }
}

private struct DocsGraphHoverLift: ViewModifier {
    @State private var isHovered = false

    func body(content: Content) -> some View {
#if os(iOS)
        content.meetHoverLift(cornerRadius: 8)
#else
        content
            .scaleEffect(isHovered ? 1.04 : 1)
            .animation(.easeOut(duration: 0.14), value: isHovered)
            .onHover { isHovered = $0 }
#endif
    }
}

// MARK: - Model

struct DocsGraphGroup {
    let name: String
    let color: Color
    let count: Int
}

struct DocsGraphLink: Sendable, Hashable {
    let source: Int
    let target: Int
}

/// Everything the canvas reads, derived once per snapshot — never per frame.
struct DocsGraphModel {
    struct Node {
        let document: DocsDocumentSummary
        let group: Int
        let degree: Int
        let radius: CGFloat
        let shortTitle: String
    }

    let groups: [DocsGraphGroup]
    let nodes: [Node]
    let indexByID: [String: Int]
    let edges: [DocsGraphLink]
    let neighbors: [[Int]]

    init(graph: DocsGraphSnapshot) {
        let documents = graph.documents
        var counts: [String: Int] = [:]
        for document in documents { counts[DocsGraphLayout.groupName(for: document.path), default: 0] += 1 }
        let names = counts.keys.sorted(by: DocsGraphLayout.stringComesBefore)
        groups = names.enumerated().map { index, name in
            DocsGraphGroup(name: name, color: DocsGraphPalette.color(at: index), count: counts[name] ?? 0)
        }
        let groupIndex = Dictionary(uniqueKeysWithValues: names.enumerated().map { ($1, $0) })
        let indexByID = Dictionary(documents.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        var degrees = [Int](repeating: 0, count: documents.count)
        var neighbors = [[Int]](repeating: [], count: documents.count)
        var edges: [DocsGraphLink] = []
        edges.reserveCapacity(graph.edges.count)
        for edge in graph.edges {
            guard let source = indexByID[edge.sourceID], let target = indexByID[edge.targetID] else { continue }
            edges.append(DocsGraphLink(source: source, target: target))
            degrees[source] += 1
            degrees[target] += 1
            neighbors[source].append(target)
            neighbors[target].append(source)
        }
        nodes = documents.enumerated().map { index, document in
            Node(
                document: document,
                group: groupIndex[DocsGraphLayout.groupName(for: document.path)] ?? 0,
                degree: degrees[index],
                radius: min(10.5, 5.5 + CGFloat(degrees[index]).squareRoot()),
                shortTitle: document.title.count > 36 ? String(document.title.prefix(34)) + "…" : document.title
            )
        }
        self.indexByID = indexByID
        self.edges = edges
        self.neighbors = neighbors
    }

    var layoutNodes: [DocsGraphNode] {
        nodes.map { DocsGraphNode(id: $0.document.id, path: $0.document.path, title: $0.document.title) }
    }

    func visibility(hiding hidden: Set<String>) -> [Bool] {
        let hiddenGroups = Set(groups.indices.filter { hidden.contains(groups[$0].name) })
        return nodes.map { !hiddenGroups.contains($0.group) }
    }
}

// MARK: - Camera

/// Screen = canvas centre + pan + graph point × scale.
struct DocsGraphCamera: Equatable {
    var scale: CGFloat = 1
    var pan: CGSize = .zero
    /// The Fit scale this camera was taken from; zoom limits are relative to it.
    var fitScale: CGFloat = 1

    var zoom: CGFloat { scale / fitScale }

    func screenPoint(x: Double, y: Double, in size: CGSize) -> CGPoint {
        CGPoint(x: size.width / 2 + pan.width + CGFloat(x) * scale, y: size.height / 2 + pan.height + CGFloat(y) * scale)
    }

    func graphPoint(_ point: CGPoint, in size: CGSize) -> DocsGraphPoint {
        DocsGraphPoint(
            x: Double((point.x - size.width / 2 - pan.width) / scale),
            y: Double((point.y - size.height / 2 - pan.height) / scale)
        )
    }

    func panned(by translation: CGSize) -> DocsGraphCamera {
        var camera = self
        camera.pan = CGSize(width: pan.width + translation.width, height: pan.height + translation.height)
        return camera
    }

    /// Zoom so the graph point under `anchor` stays under it.
    func zoomed(to zoom: CGFloat, around anchor: CGPoint, in size: CGSize) -> DocsGraphCamera {
        let target = graphPoint(anchor, in: size)
        var camera = self
        camera.scale = fitScale * CGFloat(DocsGraphConfiguration.current.zoom.bounded(Double(zoom)))
        camera.pan = CGSize(
            width: anchor.x - size.width / 2 - CGFloat(target.x) * camera.scale,
            height: anchor.y - size.height / 2 - CGFloat(target.y) * camera.scale
        )
        return camera
    }

    static func fit(_ bounds: DocsGraphBounds, in size: CGSize) -> DocsGraphCamera {
        guard size.width > 0, size.height > 0 else { return DocsGraphCamera() }
        let scale = CGFloat(min(Double(size.width) / bounds.width, Double(size.height) / bounds.height))
        return DocsGraphCamera(
            scale: scale,
            pan: CGSize(width: -CGFloat(bounds.x + bounds.width / 2) * scale, height: -CGFloat(bounds.y + bounds.height / 2) * scale),
            fitScale: scale
        )
    }
}

/**
 Until the member pans or zooms, the camera follows Fit every frame, so the
 graph stays framed while it unfolds. Fit hands it back to that.
 */
@MainActor
@Observable
final class DocsGraphViewport {
    var manual: DocsGraphCamera?
    @ObservationIgnored private(set) var current = DocsGraphCamera()
    @ObservationIgnored private(set) var size = CGSize.zero

    var canZoomIn: Bool { Double(manual?.zoom ?? 1) < DocsGraphConfiguration.current.zoom.max - 0.000_001 }
    var canZoomOut: Bool { Double(manual?.zoom ?? 1) > DocsGraphConfiguration.current.zoom.min + 0.000_001 }

    func resolve(size: CGSize, fit: () -> DocsGraphCamera) -> DocsGraphCamera {
        self.size = size
        current = manual ?? fit()
        return current
    }

    @discardableResult
    func takeControl() -> DocsGraphCamera {
        if manual == nil { manual = current }
        return current
    }

    func zoom(by factor: CGFloat) {
        let camera = manual ?? current
        manual = camera.zoomed(to: camera.zoom * factor, around: CGPoint(x: size.width / 2, y: size.height / 2), in: size)
    }

    func fit() { manual = nil }
}

// MARK: - Simulation

struct DocsGraphFrame {
    let x: [Double]
    let y: [Double]

    func points(where visible: [Bool]) -> [DocsGraphPoint] {
        x.indices.compactMap { index in
            index < visible.count && visible[index] ? DocsGraphPoint(x: x[index], y: y[index]) : nil
        }
    }
}

/**
 The live force layout. Physics state is ignored by observation — a frame
 reads it, it never invalidates a view. Only `isRunning` is observed, so the
 timeline stops asking for frames once the graph has settled.
 */
@MainActor
@Observable
final class DocsGraphSimulation {
    private(set) var isRunning = false
    @ObservationIgnored private var forces = DocsGraphForceSimulation(nodes: [], links: [], known: [:])
    @ObservationIgnored private var indexByID: [String: Int] = [:]
    @ObservationIgnored private var pinned: [String: DocsGraphPoint] = [:]
    @ObservationIgnored private var lastTick: Date?

    func load(_ model: DocsGraphModel) {
        var known: [String: DocsGraphPoint] = [:]
        for (id, index) in indexByID { known[id] = forces.point(index) }
        let alphaTarget = forces.alphaTarget
        let fresh = model.nodes.reduce(0) { $0 + (known[$1.document.id] == nil ? 1 : 0) }
        forces = DocsGraphForceSimulation(nodes: model.layoutNodes, links: model.edges, known: known)
        indexByID = model.indexByID
        forces.alphaTarget = alphaTarget
        for (id, point) in pinned {
            if let index = indexByID[id] { forces.pin(index, at: point) }
        }
        let config = DocsGraphConfiguration.current.layout
        forces.reheat(known.isEmpty || fresh * 4 > model.nodes.count ? 1 : config.reheatAlpha)
        run()
    }

    /// One tick per display frame; a redraw for any other reason reuses it.
    func frame(at date: Date?) -> DocsGraphFrame {
        if isRunning, let date, date != lastTick {
            lastTick = date
            forces.tick()
            if forces.isSettled {
                Task { @MainActor [weak self] in
                    guard let self, self.forces.isSettled else { return }
                    self.isRunning = false
                }
            }
        }
        return DocsGraphFrame(x: forces.x, y: forces.y)
    }

    func beginDrag(id: String) {
        guard let index = indexByID[id] else { return }
        let point = forces.point(index)
        pinned[id] = point
        forces.pin(index, at: point)
        let target = DocsGraphConfiguration.current.layout.dragAlphaTarget
        forces.alphaTarget = target
        forces.reheat(target)
        run()
    }

    func drag(id: String, to point: DocsGraphPoint) {
        guard let index = indexByID[id] else { return }
        pinned[id] = point
        forces.pin(index, at: point)
    }

    func endDrag(id: String) {
        pinned[id] = nil
        if let index = indexByID[id] { forces.unpin(index) }
        forces.alphaTarget = 0
    }

    private func run() {
        guard !isRunning else { return }
        lastTick = nil
        isRunning = true
    }
}

/**
 d3-force's model, ported so web and both native clients settle the same
 way: link springs, Barnes–Hut many-body repulsion, a pull toward each
 folder's anchor, and velocity decay, all scaled by a cooling alpha.
 */
struct DocsGraphForceSimulation: Sendable {
    private(set) var x: [Double]
    private(set) var y: [Double]
    private var vx: [Double]
    private var vy: [Double]
    private let centerX: [Double]
    private let centerY: [Double]
    private let links: [DocsGraphLink]
    private let linkBias: [Double]
    private let linkStrength: [Double]
    private var pinned: [Int: DocsGraphPoint] = [:]
    private(set) var alpha: Double = 1
    var alphaTarget: Double = 0

    init(nodes: [DocsGraphNode], links: [DocsGraphLink], known: [String: DocsGraphPoint]) {
        let seed = DocsGraphLayout.seed(nodes)
        x = nodes.indices.map { known[nodes[$0].id]?.x ?? seed.points[$0].x }
        y = nodes.indices.map { known[nodes[$0].id]?.y ?? seed.points[$0].y }
        vx = Array(repeating: 0, count: nodes.count)
        vy = Array(repeating: 0, count: nodes.count)
        centerX = seed.centers.map(\.x)
        centerY = seed.centers.map(\.y)
        var counts = [Double](repeating: 0, count: nodes.count)
        for link in links {
            counts[link.source] += 1
            counts[link.target] += 1
        }
        self.links = links
        linkBias = links.map { counts[$0.source] / (counts[$0.source] + counts[$0.target]) }
        linkStrength = links.map { 1 / min(counts[$0.source], counts[$0.target]) }
    }

    var isSettled: Bool { alphaTarget == 0 && alpha < DocsGraphConfiguration.current.layout.alphaMin }

    func point(_ index: Int) -> DocsGraphPoint { DocsGraphPoint(x: x[index], y: y[index]) }

    mutating func reheat(_ value: Double) { alpha = max(alpha, value) }

    mutating func pin(_ index: Int, at point: DocsGraphPoint) {
        guard x.indices.contains(index) else { return }
        pinned[index] = point
    }

    mutating func unpin(_ index: Int) { pinned[index] = nil }

    mutating func tick() {
        let config = DocsGraphConfiguration.current.layout
        alpha += (alphaTarget - alpha) * config.alphaDecay
        let count = x.count
        guard count > 0 else { return }

        for (index, link) in links.enumerated() {
            let source = link.source
            let target = link.target
            var dx = x[target] + vx[target] - x[source] - vx[source]
            var dy = y[target] + vy[target] - y[source] - vy[source]
            if dx == 0 { dx = Self.jiggle(index) }
            if dy == 0 { dy = Self.jiggle(index + 1) }
            let length = (dx * dx + dy * dy).squareRoot()
            let strength = (length - config.linkLength) / length * alpha * linkStrength[index]
            dx *= strength
            dy *= strength
            let bias = linkBias[index]
            vx[target] -= dx * bias
            vy[target] -= dy * bias
            vx[source] += dx * (1 - bias)
            vy[source] += dy * (1 - bias)
        }

        applyCharge(strength: config.chargeStrength, theta: config.theta)

        let pull = config.folderStrength * alpha
        let keep = 1 - config.velocityDecay
        for index in 0..<count {
            vx[index] += (centerX[index] - x[index]) * pull
            vy[index] += (centerY[index] - y[index]) * pull
            if let point = pinned[index] {
                x[index] = point.x
                y[index] = point.y
                vx[index] = 0
                vy[index] = 0
            } else {
                vx[index] *= keep
                vy[index] *= keep
                x[index] += vx[index]
                y[index] += vy[index]
            }
        }
    }

    private mutating func applyCharge(strength: Double, theta: Double) {
        let tree = DocsGraphQuadtree(x: x, y: y)
        let theta2 = theta * theta
        var stack: [Int32] = []
        stack.reserveCapacity(64)
        for index in x.indices {
            let px = x[index]
            let py = y[index]
            var fx = 0.0
            var fy = 0.0
            stack.removeAll(keepingCapacity: true)
            stack.append(0)
            while let cell32 = stack.popLast() {
                let cell = Int(cell32)
                let mass = tree.count[cell]
                guard mass > 0 else { continue }
                if tree.isInternal[cell] {
                    let dx = tree.sumX[cell] / mass - px
                    let dy = tree.sumY[cell] / mass - py
                    let distance2 = dx * dx + dy * dy
                    let width = tree.size[cell]
                    if width * width / theta2 < distance2 {
                        Self.accumulate(dx, dy, distance2, strength * mass * alpha, &fx, &fy, index)
                        continue
                    }
                    for slot in 0..<4 {
                        let child = tree.children[cell * 4 + slot]
                        if child >= 0 { stack.append(child) }
                    }
                } else {
                    var other = tree.head[cell]
                    while other >= 0 {
                        let o = Int(other)
                        if o != index {
                            let dx = x[o] - px
                            let dy = y[o] - py
                            Self.accumulate(dx, dy, dx * dx + dy * dy, strength * alpha, &fx, &fy, index &+ o)
                        }
                        other = tree.next[o]
                    }
                }
            }
            vx[index] += fx
            vy[index] += fy
        }
    }

    private static func accumulate(
        _ dx: Double,
        _ dy: Double,
        _ distance2: Double,
        _ weight: Double,
        _ fx: inout Double,
        _ fy: inout Double,
        _ salt: Int
    ) {
        var dx = dx
        var dy = dy
        var distance2 = distance2
        if dx == 0 { dx = jiggle(salt); distance2 += dx * dx }
        if dy == 0 { dy = jiggle(salt &+ 1); distance2 += dy * dy }
        // d3's distanceMin of 1 keeps near-coincident nodes from exploding.
        if distance2 < 1 { distance2 = distance2.squareRoot() }
        fx += dx * weight / distance2
        fy += dy * weight / distance2
    }

    /// A tiny, deterministic nudge to separate coincident points.
    private static func jiggle(_ salt: Int) -> Double {
        (Double((salt &* 2_654_435_761) & 0xffff) / 65_536 - 0.5) * 1e-6
    }
}

/// A flat quadtree with each cell's point count and coordinate sums.
private struct DocsGraphQuadtree {
    var minX: [Double] = []
    var minY: [Double] = []
    var size: [Double] = []
    var sumX: [Double] = []
    var sumY: [Double] = []
    var count: [Double] = []
    var isInternal: [Bool] = []
    var head: [Int32] = []
    var children: [Int32] = []
    var next: [Int32]

    init(x: [Double], y: [Double]) {
        next = Array(repeating: -1, count: x.count)
        guard let minX = x.min(), let maxX = x.max(), let minY = y.min(), let maxY = y.max() else { return }
        let capacity = x.count * 2 + 1
        self.minX.reserveCapacity(capacity)
        self.minY.reserveCapacity(capacity)
        size.reserveCapacity(capacity)
        sumX.reserveCapacity(capacity)
        sumY.reserveCapacity(capacity)
        count.reserveCapacity(capacity)
        children.reserveCapacity(capacity * 4)
        addCell(minX: minX, minY: minY, size: max(maxX - minX, maxY - minY) + 1)
        for index in x.indices { insert(index, x: x, y: y) }
    }

    private mutating func addCell(minX: Double, minY: Double, size: Double) {
        self.minX.append(minX)
        self.minY.append(minY)
        self.size.append(size)
        sumX.append(0)
        sumY.append(0)
        count.append(0)
        isInternal.append(false)
        head.append(-1)
        children.append(contentsOf: [-1, -1, -1, -1])
    }

    private mutating func child(of cell: Int, x: Double, y: Double) -> Int {
        let half = size[cell] / 2
        let right = x >= minX[cell] + half ? 1 : 0
        let lower = y >= minY[cell] + half ? 1 : 0
        let slot = cell * 4 + lower * 2 + right
        if children[slot] < 0 {
            children[slot] = Int32(minX.count)
            addCell(minX: minX[cell] + Double(right) * half, minY: minY[cell] + Double(lower) * half, size: half)
        }
        return Int(children[slot])
    }

    private mutating func insert(_ index: Int, x: [Double], y: [Double]) {
        let px = x[index]
        let py = y[index]
        var cell = 0
        var depth = 0
        while true {
            sumX[cell] += px
            sumY[cell] += py
            count[cell] += 1
            if isInternal[cell] {
                cell = child(of: cell, x: px, y: py)
                depth += 1
                continue
            }
            if head[cell] < 0 {
                head[cell] = Int32(index)
                return
            }
            if depth >= 24 {
                next[index] = head[cell]
                head[cell] = Int32(index)
                return
            }
            // Split: the resident point moves down a level, then this one
            // continues; the loop splits again if they share a quadrant.
            let resident = Int(head[cell])
            head[cell] = -1
            isInternal[cell] = true
            let home = child(of: cell, x: x[resident], y: y[resident])
            sumX[home] += x[resident]
            sumY[home] += y[resident]
            count[home] += 1
            head[home] = Int32(resident)
            cell = child(of: cell, x: px, y: py)
            depth += 1
        }
    }
}

// MARK: - Configuration

struct DocsGraphConfiguration: Decodable, Sendable {
    struct Layout: Decodable, Sendable {
        let groupRingMin: Double
        let groupRingPerFolder: Double
        let memberRingMin: Double
        let memberRingPerSqrtDocument: Double
        let linkLength: Double
        let chargeStrength: Double
        let theta: Double
        let folderStrength: Double
        let velocityDecay: Double
        let alphaMin: Double
        let alphaDecay: Double
        let reheatAlpha: Double
        let dragAlphaTarget: Double
    }

    struct Fit: Decodable, Sendable {
        let minWidth: Int
        let minHeight: Int
        let padding: Int
    }

    struct Zoom: Decodable, Sendable {
        let min: Double
        let max: Double

        func bounded(_ value: Double) -> Double {
            Swift.min(self.max, Swift.max(self.min, value))
        }
    }

    let version: Int
    let pageSize: Int
    let maxDocuments: Int
    let linkBatchSize: Int
    let folderColors: [String]
    let zoom: Zoom
    let layout: Layout
    let fit: Fit

    static let current = load()

    private static func load() -> DocsGraphConfiguration {
        let bundles = [Bundle.main, Bundle(for: DocsGraphResourceAnchor.self)]
        for bundle in bundles {
            guard let url = bundle.url(forResource: "docs-graph-config", withExtension: "json"),
                  let data = try? Data(contentsOf: url),
                  let config = try? JSONDecoder().decode(DocsGraphConfiguration.self, from: data),
                  config.isValid else { continue }
            return config
        }
        // The config is also a target resource in both apps. This fallback
        // only protects older or incomplete development bundles.
        return DocsGraphConfiguration(
            version: 2,
            pageSize: 200,
            maxDocuments: 5_000,
            linkBatchSize: 8,
            folderColors: ["#a6c944", "#68a9d5", "#bf91db", "#e98f70", "#50b99b", "#d6ad42", "#d8799b", "#8799e6"],
            zoom: Zoom(min: 0.25, max: 4),
            layout: Layout(
                groupRingMin: 150,
                groupRingPerFolder: 56,
                memberRingMin: 42,
                memberRingPerSqrtDocument: 55,
                linkLength: 40,
                chargeStrength: -120,
                theta: 0.9,
                folderStrength: 0.04,
                velocityDecay: 0.4,
                alphaMin: 0.001,
                alphaDecay: 0.0228,
                reheatAlpha: 0.3,
                dragAlphaTarget: 0.3
            ),
            fit: Fit(minWidth: 720, minHeight: 480, padding: 90)
        )
    }

    private var isValid: Bool {
        version > 0 && pageSize > 0 && maxDocuments >= pageSize && linkBatchSize > 0
            && zoom.min.isFinite && zoom.max.isFinite && zoom.min > 0 && zoom.max > zoom.min
            && !folderColors.isEmpty && layout.alphaDecay > 0 && layout.alphaMin > 0
    }
}

private final class DocsGraphResourceAnchor: NSObject {}

struct DocsGraphPoint: Sendable {
    var x: Double
    var y: Double
}

struct DocsGraphNode: Sendable {
    let id: String
    let path: String
    let title: String
}

private enum DocsGraphPalette {
    static func color(at index: Int) -> Color {
        let colors = DocsGraphConfiguration.current.folderColors
        let hex = UInt32(colors[index % colors.count].dropFirst(), radix: 16) ?? 0xA6C944
        return Color(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}

struct DocsGraphBounds: Sendable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

enum DocsGraphLayout {
    static func groupName(for path: String) -> String {
        guard let first = path.split(separator: "/").first else { return String(localized: "Unfiled") }
        return first.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ").capitalized
    }

    static func stringComesBefore(_ lhs: String, _ rhs: String) -> Bool {
        let left = Array(lhs.unicodeScalars.map(\.value))
        let right = Array(rhs.unicodeScalars.map(\.value))
        for (leftScalar, rightScalar) in zip(left, right) where leftScalar != rightScalar {
            return leftScalar < rightScalar
        }
        return left.count < right.count
    }

    /// The list with each id once, in first-seen order.
    static func uniqueDocuments<Document: Identifiable>(_ documents: [Document]) -> [Document] where Document.ID == String {
        var seen = Set<String>()
        return documents.filter { seen.insert($0.id).inserted }
    }

    /**
     Where each node starts and which anchor pulls it: folders on a ring wide
     enough that their settled discs don't overlap, members on a sunflower
     spiral sized to the disc the forces will settle them into. Same as web.
     */
    static func seed(_ documents: [DocsGraphNode]) -> (points: [DocsGraphPoint], centers: [DocsGraphPoint]) {
        guard !documents.isEmpty else { return ([], []) }
        let config = DocsGraphConfiguration.current.layout
        let byGroup = Dictionary(grouping: documents.indices, by: { groupName(for: documents[$0].path) })
        let names = byGroup.keys.sorted(by: stringComesBefore)
        let memberRing = { (count: Int) in max(config.memberRingMin, Double(count).squareRoot() * config.memberRingPerSqrtDocument) }
        let widest = byGroup.values.map { memberRing($0.count) }.max() ?? 0
        let groupRing = names.count > 1
            ? max(config.groupRingMin, Double(names.count) * config.groupRingPerFolder, widest * 1.15 / sin(Double.pi / Double(names.count)))
            : 0

        var points = [DocsGraphPoint](repeating: DocsGraphPoint(x: 0, y: 0), count: documents.count)
        var centers = points
        for (groupIndex, group) in names.enumerated() {
            let angle = -Double.pi / 2 + Double(groupIndex) / Double(names.count) * Double.pi * 2
            let center = DocsGraphPoint(x: cos(angle) * groupRing, y: sin(angle) * groupRing)
            let members = (byGroup[group] ?? []).sorted {
                let lhs = documents[$0], rhs = documents[$1]
                if lhs.title != rhs.title { return stringComesBefore(lhs.title, rhs.title) }
                if lhs.path != rhs.path { return stringComesBefore(lhs.path, rhs.path) }
                return stringComesBefore(lhs.id, rhs.id)
            }
            let ring = memberRing(members.count)
            for (order, index) in members.enumerated() {
                let turn = Double(order) * 2.399963229728653
                let spread = ring * ((Double(order) + 0.5) / Double(members.count)).squareRoot()
                points[index] = DocsGraphPoint(x: center.x + cos(turn) * spread, y: center.y + sin(turn) * spread)
                centers[index] = center
            }
        }
        return (points, centers)
    }

    /// The settled layout, run to rest in one go. The live view animates the
    /// same simulation instead; checks use this.
    static func positions(documents: [DocsGraphNode], edges: [DocsGraphEdge]) -> [String: DocsGraphPoint] {
        let indexByID = Dictionary(documents.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        let links = edges.compactMap { edge -> DocsGraphLink? in
            guard let source = indexByID[edge.sourceID], let target = indexByID[edge.targetID] else { return nil }
            return DocsGraphLink(source: source, target: target)
        }
        var simulation = DocsGraphForceSimulation(nodes: documents, links: links, known: [:])
        var ticks = 0
        while !simulation.isSettled, ticks < 1_000 {
            simulation.tick()
            ticks += 1
        }
        return Dictionary(documents.indices.map { (documents[$0].id, simulation.point($0)) }, uniquingKeysWith: { first, _ in first })
    }

    static func fitBounds(_ points: [DocsGraphPoint]) -> DocsGraphBounds {
        guard !points.isEmpty else { return DocsGraphBounds(x: -520, y: -360, width: 1040, height: 720) }
        var minX = Double.infinity, maxX = -Double.infinity, minY = Double.infinity, maxY = -Double.infinity
        for point in points {
            minX = min(minX, point.x)
            maxX = max(maxX, point.x)
            minY = min(minY, point.y)
            maxY = max(maxY, point.y)
        }
        let fit = DocsGraphConfiguration.current.fit
        let padding = Double(fit.padding)
        return DocsGraphBounds(
            x: minX - padding,
            y: minY - padding,
            width: max(Double(fit.minWidth), maxX - minX + padding * 2),
            height: max(Double(fit.minHeight), maxY - minY + padding * 2)
        )
    }
}
