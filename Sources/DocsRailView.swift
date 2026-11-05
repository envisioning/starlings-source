import AppKit
import Combine
import DocsKit

/// The Docs window's left rail, on the same primitives as every other rail
/// ( decision 3): two `SidebarSection`s — WORK and
/// LIBRARY, the two halves of one corpus (docs/DOCS.md, "The rail") — of
/// `WorkSidebarRowView`s, folds remembered under `meet.sidebarFold.docs.*`,
/// the shared selection paint. The SwiftUI `List` it replaces had none of
/// that: no fold, its own row rhythm, and a selection look nothing else in
/// the app shared.
///
/// WORK is Recent and the categories a person writes in, then BY PROJECT and
/// BY LEAD — one row per subject something is filed about; FOLDERS is the
/// top-level shelves, so a document with no category still has a
/// row; LIBRARY is the mirror of Core's published writing. Deeper folders
/// stay filing, not wayfinding: they live on in Move to.
///
/// A document dragged from the list onto a folder, subject or WORK category
/// row is filed there.
@MainActor
final class DocsRailView: NSView {
    private let model: DocsBrowserModel
    private let favorites: StarredWatch
    // The fold keys, the order and the empty rule come from the shared table (`RailBlockRegistry`).
    private let exploreSection = RailBlockRegistry.section(.docs, "explore", title: String(localized: "EXPLORE"))
    private let workSection = RailBlockRegistry.section(.docs, "work", title: String(localized: "WORK"))
    // An empty group is no section at all, not an empty one: the section's
    // own rule, because `setRows` re-derives `isHidden` on every render.
    private let projectsSection = RailBlockRegistry.section(.docs, "projects", title: String(localized: "BY PROJECT"))
    private let leadsSection = RailBlockRegistry.section(.docs, "leads", title: String(localized: "BY LEAD"))
    private let partnersSection = RailBlockRegistry.section(.docs, "partners", title: String(localized: "BY PARTNER"))
    private let foldersSection = RailBlockRegistry.section(.docs, "folders", title: String(localized: "FOLDERS"))
    private let librarySection = RailBlockRegistry.section(.docs, "library", title: String(localized: "LIBRARY"))
    private let scrollView = NSScrollView()
    private let stack = NSStackView()
    private var rows: [WorkSidebarRowView] = []
    private var cancellables: Set<AnyCancellable> = []
    /// What the rail last drew. The model publishes on every change — a
    /// loading flag, an opened document — and most of those change nothing
    /// on the rail; rebuilding anyway lost hover and clamped the scroll.
    private var renderedRail: [String]?

    init(model: DocsBrowserModel, favorites: StarredWatch) {
        self.model = model
        self.favorites = favorites
        super.init(frame: .zero)
        DocsDiagnostics.event("rail view initialized")

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        for section in [exploreSection, workSection, projectsSection, leadsSection, partnersSection, foldersSection, librarySection] {
            section.translatesAutoresizingMaskIntoConstraints = false
            stack.addArrangedSubview(section)
            section.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .noBorder
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        scrollView.contentView = clip
        scrollView.documentView = stack
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),
        ])
        // The rail must not be able to set its column's width — same rule as
        // Team's and Work's rails (`StarlingsShellViewController`).
        for column in [self, scrollView, stack] as [NSView] {
            column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }

        // One render per change to the two lists or the choice; the model
        // publishes on the main queue already.
        model.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.render() }
            .store(in: &cancellables)
        render()
        Task { await model.loadRail() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The search field's state is not a row: while a search is on, nothing
    /// on the rail lights, and clearing it puts the previous choice back.
    private var selected: DocsBrowserModel.Selection? {
        if case .search = model.selection { return nil }
        return model.selection
    }

    private func render() {
        let signature = railSignature()
        guard signature != renderedRail else { return }
        renderedRail = signature
        DocsDiagnostics.event("rail rows rebuilding")
        scrollView.preservingScrollOffset { renderRows() }
    }

    /// Everything a row draws, in order — the same inputs `renderRows` reads.
    private func railSignature() -> [String] {
        var lines: [String] = [
            "\(String(describing: selected))",
            "links|\(model.summary?.links ?? 0)",
            "unfiled|\(model.summary?.unfiled ?? 0)",
        ]
        for entry in model.summary?.categories(on: .work, includeEmpty: true) ?? [] {
            lines.append("work|\(entry.category)|\(entry.label)|\(entry.count)")
        }
        for groups in [model.projectGroups, model.leadGroups, model.partnerGroups] {
            for group in groups {
                lines.append("subject|\(group.subject.kind)|\(group.subject.id)|\(group.subject.title)|\(group.count)")
            }
            lines.append("-")
        }
        for folder in model.railFolders {
            lines.append("folder|\(folder.path)|\(folder.title)|\(folder.count)")
        }
        for entry in model.summary?.categories(on: .library) ?? [] {
            lines.append("library|\(entry.category)|\(entry.label)|\(entry.count)")
        }
        lines.append(model.railErrorMessage ?? "")
        return lines
    }

    private func renderRows() {
        DocsDiagnostics.count("rail rows: projects", model.projectGroups.count)
        DocsDiagnostics.count("rail rows: leads", model.leadGroups.count)
        DocsDiagnostics.count("rail rows: folders", model.railFolders.count)
        rows.removeAll()
        exploreSection.setRows([
            row(
                selection: .graph,
                symbol: "point.3.connected.trianglepath.dotted",
                title: DocsSelectionWords.graphTitle,
                subtitle: String(localized: "Documents connected by wikilinks")
            )
        ], count: 1)
        // Two halves by source, not by category name: a brief Core
        // published sits in LIBRARY, a brief a person wrote in WORK.
        var workRows: [NSView] = []
        workRows.append(row(
            selection: .recent,
            symbol: "clock",
            title: DocsSelectionWords.recentTitle,
            subtitle: String(localized: "Last edited first")
        ))
        // Always drawn: the Links view is where a paste lands, so it must be
        // findable before the first save.
        workRows.append(row(
            selection: .links,
            symbol: "link",
            title: DocsSelectionWords.linksTitle,
            subtitle: Self.links(model.summary?.links ?? 0)
        ))
        // Only while something is unfiled: an empty Unfiled is
        // the goal, not a place to visit.
        if let unfiled = model.summary?.unfiled, unfiled > 0 {
            workRows.append(row(
                selection: .unfiled,
                symbol: "tray",
                title: DocsSelectionWords.unfiledTitle,
                subtitle: Self.documents(unfiled)
            ))
        }
        for entry in model.summary?.categories(on: .work, includeEmpty: true) ?? [] {
            workRows.append(categoryRow(entry, on: .work))
        }
        workSection.setRows(workRows, count: workRows.count)

        // By project / By lead: one row per subject something is filed about.
        for (section, groups) in [(projectsSection, model.projectGroups), (leadsSection, model.leadGroups), (partnersSection, model.partnerGroups)] {
            section.setRows(groups.map { group in
                row(
                    selection: .subject(kind: group.docsKind, id: group.subject.id, title: group.subject.title),
                    symbol: group.subject.kind == "lead" ? "briefcase" : group.subject.kind == "organization" ? "building.2" : "folder",
                    title: group.subject.title,
                    subtitle: Self.documents(group.count)
                )
            }, count: groups.count)
        }

        let folders = model.railFolders
        foldersSection.setRows(folders.map { folder in
            row(
                selection: .folder(folder.path),
                symbol: "folder",
                title: folder.title,
                subtitle: Self.documents(folder.count)
            )
        }, count: folders.count)

        var libraryRows: [NSView] = []
        for entry in model.summary?.categories(on: .library) ?? [] {
            libraryRows.append(categoryRow(entry, on: .library))
        }
        // The summary's failure is the rail's to show; a list that loaded
        // fine says nothing about it.
        if let railErrorMessage = model.railErrorMessage {
            let notice = StarlingsNoticeView(wrapping: true)
            notice.setText(railErrorMessage, tone: .danger)
            libraryRows.append(notice)
        }
        librarySection.setRows(libraryRows, count: libraryRows.count)
    }

    private func categoryRow(_ entry: DocsSummary.CategoryCount, on half: DocsRailHalf) -> NSView {
        row(
            selection: .category(entry.category, half),
            symbol: entry.category.systemImage,
            title: entry.label,
            subtitle: Self.documents(entry.count)
        )
    }

    private func row(
        selection: DocsBrowserModel.Selection,
        symbol: String,
        title: String,
        subtitle: String
    ) -> NSView {
        let row = WorkSidebarRowView(
            leading: .glyph(systemSymbolName: symbol, accessibilityLabel: title),
            title: title,
            subtitle: subtitle,
            isSelected: selection == selected,
            accessibilityLabel: "\(title). \(subtitle).",
            onSelect: { [weak self] in self?.model.selection = selection },
            menuProvider: { [weak self] in self?.favoriteMenu(for: selection) }
        )
        row.selectionKey = selection
        // Every row is asked; the model says which take a document.
        row.drop = WorkSidebarRowView.Drop(
            type: .string,
            accepts: { [weak self] token in !(self?.model.documentsForDrop(token, onto: selection).isEmpty ?? true) },
            perform: { [weak self] token in self?.file(token, onto: selection) }
        )
        rows.append(row)
        return row
    }

    private func favoriteMenu(for selection: DocsBrowserModel.Selection) -> NSMenu? {
        guard case .folder(let path) = selection,
              let folder = model.folders.first(where: { $0.path == path }) else { return nil }
        let menu = NSMenu()
        menu.addFavoriteAction(FavoriteTarget(kind: .docsFolder, targetRef: folder.id), watch: favorites, window: window)
        return menu
    }

    private func file(_ token: String, onto target: DocsBrowserModel.Selection) {
        let documents = model.documentsForDrop(token, onto: target)
        guard !documents.isEmpty else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                if let done = try await model.file(documents, onto: target) {
                    StarlingsToast.show(done, tone: .neutral, in: window)
                }
            } catch {
                StarlingsToast.show(error.localizedDescription, tone: .danger, in: window)
            }
        }
    }

    /// One key per noun, with its plural forms in the catalog.
    private static func documents(_ count: Int) -> String {
        String(localized: "\(count) documents")
    }

    private static func links(_ count: Int) -> String {
        String(localized: "\(count) links")
    }
}
