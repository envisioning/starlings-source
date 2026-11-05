import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// A workspace's mark, always one colour, the ink it sits in
/// (MZ, 2026-10-05): an uploaded SVG as its outline (`WorkspaceMarkVector`),
/// a PNG as a template image. Without a mark, a signed-out screen draws the
/// Starlings flock, breathing; signed in, the workspace's initial on a quiet
/// tile. No workspace's mark is built in: Envisioning's is its upload too.
struct StarlingsWorkspaceMarkView: View {
    let workspace: StarlingsWorkspace
    /// The mark's bytes, when the caller has them (the store's, or a preview's).
    var data: Data?
    var size: CGFloat = 18
    /// Nobody signed in: the flock stands in for a missing mark, never another organization's glyph.
    var signedOut = false
    /// The one colour the mark is drawn in.
    var ink: Color = .primary
    /// How that stand-in flock moves. `.still` beside a busy spinner, so a
    /// wait shows one moving element.
    var flockMotion: GatheringDotsView.Motion = .drift

    var body: some View {
        Group {
            if let data, WorkspaceMarkVector.isSVG(data), let outline = WorkspaceMarkVector.outline(from: data) {
                MarkOutline(outline: outline).fill(ink, style: FillStyle(eoFill: outline.evenOdd))
            } else if let image = Self.image(from: data) {
                image.renderingMode(.template).resizable().scaledToFit().foregroundStyle(ink)
            } else if signedOut {
                GatheringDotsView(side: size, ink: ink, motion: flockMotion)
            } else {
                RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                    .fill(ink.opacity(0.12))
                    .overlay {
                        Text(verbatim: workspace.initial)
                            .font(.system(size: size * 0.58, weight: .semibold))
                            .foregroundStyle(ink)
                    }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The mark as an image for a system menu row: a template,
    /// so the menu draws it in its own ink. Nil when the workspace has no
    /// mark to draw; the menu then shows the name alone.
    #if canImport(UIKit)
    @MainActor
    static func image(workspace: StarlingsWorkspace, data: Data?, size: CGFloat) -> UIImage? {
        guard data != nil else { return nil }
        let renderer = ImageRenderer(content: StarlingsWorkspaceMarkView(workspace: workspace, data: data, size: size, ink: .black))
        renderer.scale = 3
        return renderer.uiImage?.withRenderingMode(.alwaysTemplate)
    }
    #else
    @MainActor
    static func image(workspace: StarlingsWorkspace, data: Data?, size: CGFloat) -> NSImage? {
        guard data != nil else { return nil }
        let renderer = ImageRenderer(content: StarlingsWorkspaceMarkView(workspace: workspace, data: data, size: size, ink: .black))
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        guard let image = renderer.nsImage else { return nil }
        image.isTemplate = true
        return image
    }
    #endif

    /// The outline, fitted to the frame.
    private struct MarkOutline: Shape {
        let outline: WorkspaceMarkVector.Outline
        func path(in rect: CGRect) -> Path { Path(WorkspaceMarkVector.path(outline, in: rect)) }
    }

    private static func image(from data: Data?) -> Image? {
        guard let data else { return nil }
        #if canImport(UIKit)
        return UIImage(data: data).map { Image(uiImage: $0) }
        #else
        return NSImage(data: data).map { Image(nsImage: $0) }
        #endif
    }
}

/// The current workspace's mark, redrawn when the store reads a new one.
/// The "Everyone" channel row on the Mac and iOS: Everyone is the workspace.
struct StarlingsCurrentWorkspaceMark: View {
    @ObservedObject private var store = StarlingsWorkspaceStore.shared
    var size: CGFloat = 18
    var ink: Color = .primary

    var body: some View {
        StarlingsWorkspaceMarkView(workspace: store.current, data: store.markData, size: size, ink: ink)
    }
}

/// The current workspace, and who is signed in to it: the mark, the name,
/// and the address under it. The Mac's first run, iOS Home and the workspace
/// chooser, both Settings.
struct StarlingsWorkspaceBadge: View {
    @ObservedObject private var store = StarlingsWorkspaceStore.shared
    /// The signed-in address; nil reads the store's.
    private let address: String?
    private let markSize: CGFloat
    private let signedOut: Bool

    init(address: String? = nil, markSize: CGFloat = 20, signedOut: Bool = false) {
        self.address = address
        self.markSize = markSize
        self.signedOut = signedOut
    }

    var body: some View {
        let shown = address ?? store.signedInAddress
        HStack(spacing: 8) {
            StarlingsWorkspaceMarkView(workspace: store.current, data: store.markData, size: markSize, signedOut: signedOut)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: store.current.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                if let shown {
                    Text(verbatim: shown)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
