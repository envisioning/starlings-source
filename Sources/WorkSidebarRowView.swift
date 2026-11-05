import AppKit
import SwiftUI

/// A fixed width the layout may break rather than widen the window for.
/// Buttons in a row want their own size; the column wants to stay draggable.
/// The column wins.
private extension NSView {
    func pinActionWidth(_ width: CGFloat) {
        let constraint = widthAnchor.constraint(equalToConstant: width)
        constraint.priority = .defaultHigh
        constraint.isActive = true
    }
}

/// The well's silhouette carries the same kind of meaning as its glyph:
/// round for an area or identity, softly square for an actionable record.
enum WorkGlyphMarkShape {
    case round
    case square
}

/// A row on a Meet sidebar that can be told, after it is built, whether it
/// is the one chosen.
///
/// Selection is a mark on a row, not a reason to build the row again. The
/// rail used to be rebuilt wholesale on every click so that one row could
/// come back with `isSelected: true`, and every logo and glyph on it was
/// destroyed and redrawn to move a highlight — the "sidebar flashes" of
/// issue #22's cousins. A surface tags each row with what it stands for and
/// walks the rows it already has.
@MainActor
protocol WorkSidebarSelectableRow: NSView {
    /// What choosing this row means, in the surface's own terms. Nil for a
    /// row that is never the chosen one — an unread row is a shortcut to a
    /// subject, and the subject's own row is the one that lights.
    var selectionKey: AnyHashable? { get }
    var isSelected: Bool { get set }
}

/// The one selected look every sidebar row shares: one rung up the surface
/// ladder with a hairline, so it reads on the panel it sits on in either
/// appearance. Not the accent — the accent is a fill for a call to action,
/// and a row that is merely open is not one (docs/DESIGN.md).
@MainActor
enum WorkSidebarRowPaint {
    static let cornerRadius: CGFloat = 8

    static func apply(to view: NSView, selected: Bool, hovered: Bool, dropTarget: Bool = false) {
        view.wantsLayer = true
        guard let layer = view.layer else { return }
        layer.cornerRadius = cornerRadius
        layer.cornerCurve = .continuous
        // Rows lift by half (DESIGN.md): the full veil on a wide strip read
        // as a second selection. The selected row keeps its hairline.
        let base = StarlingsColors.resolved(selected ? StarlingsColors.elevated : .clear, for: view)
        layer.backgroundColor = (hovered ? StarlingsColors.lifted(base, by: StarlingsColors.rowHoverLift) : base).cgColor
        if dropTarget {
            layer.borderWidth = 1.5
            layer.borderColor = StarlingsColors.resolved(StarlingsColors.accentMark, for: view).cgColor
        } else {
            layer.borderWidth = selected ? 1 : 0
            layer.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: view).cgColor
        }
        view.setAccessibilitySelected(selected)
    }
}

/// One row shape for every scrollable list in the Work sidebar — Unread, a
/// space (Envisioning/Projects/Sales), Team, and Agents all build from this
/// same shell rather than each hand-rolling its own. A row is:
///
/// - a leading well, always the same diameter for ordinary rows, so every
///   project row in the sidebar shares one left edge regardless of what it
///   names: a
///   face for a person, the workspace's mark for the "Everyone" channel, a
///   plain SF Symbol (folder, flag) for a subject with neither. A
///   hover-to-reveal version of this shipped and was reverted — showing and
///   hiding the same mark depending on where the pointer happens to be read
///   as broken, not restrained;
/// - a title/subtitle pair, where unread now means the same weight jump
///   everywhere — a subject row used to stay medium on unread while a
///   conversation went semibold and a person went bold for the identical
///   fact;
/// - one trailing accessory: an unread dot, or a run of small actions
///   (Team/Agents fold the dot into that run instead of pinning it alone).
///
/// Anything a specific list still needs beyond that shape — a context menu
/// or a drag target — is wiring the call site hands in through closures.
/// See the factory methods below for each list's flavor.
///
/// Rows are rebuilt when the *list* changes (`SidebarSection.setRows`).
/// Selection and the subtitle can change under a row that stays.
@MainActor
final class WorkSidebarRowView: NSView, WorkSidebarSelectableRow {
    /// What the leading well shows, when it exists at all.
    enum Leading {
        case avatar(StarlingsAvatarIdentity, status: PeerStatus?)
        /// The workspace's mark — the "Everyone" channel row.
        case channelMark
        /// A plain SF Symbol in the same well — what a subject row (no
        /// person, no channel) draws instead, so a project, a lead, and a
        /// colleague all keep the same left edge.
        case glyph(systemSymbolName: String, accessibilityLabel: String)
        /// The related organization's logo — a project or lead with one on
        /// file. Draws the fallback glyph immediately and swaps to the
        /// fetched image if it loads, so the row is never a blank well while
        /// waiting and never jumps if the fetch fails.
        case organizationLogo(URL, fallbackSymbolName: String, accessibilityLabel: String)
    }

    /// The one trailing accessory a row can carry.
    enum Trailing {
        case unreadDot
        case actions([NSView])
    }

    private static let compactHeight: CGFloat = 46
    private static let avatarHeight: CGFloat = 52
    private static let wellDiameter: CGFloat = 30

    private let onSelect: (() -> Void)?
    private let menuProvider: (() -> NSMenu?)?
    private let subtitleLabel: NSTextField
    private let isSubdued: Bool
    private let isStarred: Bool
    private let leadingShape: WorkGlyphMarkShape
    private var favoriteBadge: StarlingsFavoriteBadge?
    private var isHovered = false
    private var isDropTarget = false {
        didSet { paint() }
    }

    var selectionKey: AnyHashable?
    var isSelected: Bool {
        didSet {
            guard isSelected != oldValue else { return }
            paint()
        }
    }

    /// A string this row takes when it is dropped on it: one pasteboard
    /// type, a check read at drag time, and the act. The board's hand-off
    /// sets `.workCard` on an agent's row only — a person is asked with a
    /// Message, not handed a card (docs/SURFACES.md). The Docs rail files a
    /// dragged document on the row it lands on.
    struct Drop {
        let type: NSPasteboard.PasteboardType
        let accepts: (String) -> Bool
        let perform: (String) -> Void
    }

    var drop: Drop? {
        didSet {
            if let drop { registerForDraggedTypes([drop.type]) } else { unregisterDraggedTypes() }
        }
    }

    init(
        leading: Leading? = nil,
        leadingShape: WorkGlyphMarkShape = .round,
        title: String,
        hasUnread: Bool = false,
        subtitle: String,
        trailing: Trailing? = nil,
        isSelected: Bool = false,
        isSubdued: Bool = false,
        isStarred: Bool = false,
        accessibilityLabel: String,
        onSelect: (() -> Void)? = nil,
        menuProvider: (() -> NSMenu?)? = nil
    ) {
        self.onSelect = onSelect
        self.menuProvider = menuProvider
        self.isSelected = isSelected
        self.isSubdued = isSubdued
        self.isStarred = isStarred
        self.leadingShape = leadingShape

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(
            ofSize: isSubdued ? 12 : 13,
            weight: hasUnread ? .semibold : (isSubdued ? .regular : .medium)
        )
        titleLabel.textColor = isSubdued && !hasUnread
            ? StarlingsColors.secondaryText
            : StarlingsColors.primaryText
        titleLabel.allowSqueezing()

        let subtitleLabel = NSTextField(labelWithString: subtitle)
        // No second line at all when there is nothing to say (an agent with
        // no conversation yet).
        subtitleLabel.isHidden = subtitle.isEmpty
        subtitleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(isSubdued ? 10 : 11))
        subtitleLabel.textColor = StarlingsColors.secondaryText
        subtitleLabel.allowSqueezing()
        self.subtitleLabel = subtitleLabel

        let text = NSStackView(views: [titleLabel, subtitleLabel])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1
        text.translatesAutoresizingMaskIntoConstraints = false

        var leadingContent: NSView?
        switch leading {
        case nil:
            break
        case .channelMark:
            leadingContent = WorkGlyphMarkView(
                diameter: Self.wellDiameter,
                content: .workspace,
                accessibilityLabel: StarlingsWorkspace.active.name
            )
        case .glyph(let symbolName, let accessibilityLabel):
            leadingContent = WorkGlyphMarkView(
                diameter: Self.wellDiameter,
                content: .symbol(symbolName),
                accessibilityLabel: accessibilityLabel,
                shape: leadingShape
            )
        case .organizationLogo(let url, let fallbackSymbolName, let accessibilityLabel):
            leadingContent = WorkOrgLogoMarkView(
                diameter: Self.wellDiameter,
                url: url,
                fallbackSymbolName: fallbackSymbolName,
                accessibilityLabel: accessibilityLabel
            )
        case .avatar(let identity, let status):
            leadingContent = StarlingsPersonAvatarView(identity: identity, diameter: Self.wellDiameter, status: status)
        }

        super.init(frame: .zero)

        var constraints: [NSLayoutConstraint] = [
            heightAnchor.constraint(equalToConstant: leadingContent == nil ? Self.compactHeight : Self.avatarHeight),
            text.centerYAnchor.constraint(equalTo: centerYAnchor),
        ]
        addSubview(text)
        if let leadingContent {
            leadingContent.translatesAutoresizingMaskIntoConstraints = false
            addSubview(leadingContent)
            constraints += [
                leadingContent.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
                leadingContent.widthAnchor.constraint(equalToConstant: Self.wellDiameter),
                leadingContent.heightAnchor.constraint(equalToConstant: Self.wellDiameter),
                leadingContent.centerYAnchor.constraint(equalTo: centerYAnchor),
                text.leadingAnchor.constraint(equalTo: leadingContent.trailingAnchor, constant: 10),
            ]
            if isStarred {
                let badge = StarlingsFavoriteBadge(size: .compact)
                favoriteBadge = badge
                addSubview(badge)
                constraints += [
                    badge.leadingAnchor.constraint(equalTo: leadingContent.leadingAnchor, constant: -4),
                    badge.topAnchor.constraint(equalTo: leadingContent.topAnchor, constant: -4),
                ]
            }
        } else {
            if isStarred {
                let badge = StarlingsFavoriteBadge(size: .compact)
                favoriteBadge = badge
                addSubview(badge)
                constraints += [
                    badge.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 7),
                    badge.centerYAnchor.constraint(equalTo: centerYAnchor),
                    text.leadingAnchor.constraint(equalTo: badge.trailingAnchor, constant: 7),
                ]
            } else {
                constraints.append(text.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10))
            }
        }

        switch trailing {
        case nil:
            constraints.append(text.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10))
        case .unreadDot:
            let dot = Self.unreadDotView()
            addSubview(dot)
            constraints += [
                dot.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                dot.centerYAnchor.constraint(equalTo: centerYAnchor),
                text.trailingAnchor.constraint(lessThanOrEqualTo: dot.leadingAnchor, constant: -8),
            ]
        case .actions(let views):
            let stack = NSStackView(views: views)
            stack.orientation = .horizontal
            stack.spacing = 6
            stack.translatesAutoresizingMaskIntoConstraints = false
            addSubview(stack)
            constraints += [
                stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
                stack.centerYAnchor.constraint(equalTo: centerYAnchor),
                text.trailingAnchor.constraint(lessThanOrEqualTo: stack.leadingAnchor, constant: -8),
            ]
        }
        NSLayoutConstraint.activate(constraints)

        // **A row is never a reason to widen its column.** Every fixed width
        // in here — the well, the action buttons — is a preference, and the
        // row as a whole yields horizontally. A run of required button widths
        // is what gave Team's rail a 276pt floor against a 240pt column, so
        // the divider hit a wall the shell had not declared and the split
        // paid for the difference by growing the window.
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.defaultLow, for: .horizontal)

        setAccessibilityLabel(accessibilityLabel)
        paint()
        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.paint()
        }
    }

    private func paint() {
        WorkSidebarRowPaint.apply(to: self, selected: isSelected, hovered: isHovered, dropTarget: isDropTarget)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        paint()
    }

    /// The rail rebuilds its rows on every roster tick and scrolls under a
    /// still pointer; both lose the exit event. Re-read the pointer instead.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        meetHoverMonitor?.resync()
    }

    /// The second line, when the surface learns something truer after the
    /// row is up — a project's exact repositories arrive a beat after the
    /// project is chosen.
    func setSubtitle(_ subtitle: String) {
        subtitleLabel.stringValue = subtitle
        subtitleLabel.isHidden = subtitle.isEmpty
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The compact favorite badge that sits at the leading mark's top-left,
    /// matching Home's Quick Access tiles.
    /// The one unread mark every row now shares — a filled 8pt circle in the
    /// same ink as everything else. Team and Agents fold this into their
    /// `.actions` run instead of using `.unreadDot`.
    static func unreadDotView() -> NSView {
        let dot = NSImageView()
        dot.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 8, weight: .regular))
        dot.contentTintColor = StarlingsColors.primaryText
        dot.translatesAutoresizingMaskIntoConstraints = false
        return dot
    }

    override func mouseDown(with event: NSEvent) {
        guard let onSelect else { return super.mouseDown(with: event) }
        onSelect()
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        menuProvider?() ?? super.menu(for: event)
    }

    // MARK: - Taking a drop

    private func droppedString(_ sender: NSDraggingInfo) -> String? {
        guard let drop, let string = sender.draggingPasteboard.string(forType: drop.type), drop.accepts(string) else { return nil }
        return string
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard droppedString(sender) != nil else { return [] }
        isDropTarget = true
        return .move
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        isDropTarget = false
    }

    override func draggingEnded(_ sender: NSDraggingInfo) {
        isDropTarget = false
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        isDropTarget = false
        guard let drop, let string = droppedString(sender) else { return false }
        drop.perform(string)
        return true
    }
}

/// A glyph in an avatar-sized well — the workspace's mark for the
/// "Everyone" channel row, or a plain SF Symbol for a subject row. Matches
/// `StarlingsPersonAvatarView`'s well exactly — same diameter, same fill, same
/// hairline — because the point is that every row occupies the same column
/// regardless of what it's naming. Draws itself rather than loading
/// anything, so it has no picture to arrive late and nothing to flash.
final class WorkGlyphMarkView: NSView {
    enum Content {
        /// The current workspace's mark (`StarlingsCurrentWorkspaceMark`), in
        /// the accent. It redraws when the workspace reads a new mark.
        case workspace
        case symbol(String)
        /// A calendar event's platform mark. Our own room is the brand
        /// glyph; a room with no platform (in person, calendar only) is a
        /// calendar so the well is never empty.
        case platform(CalendarMeetingPlatform)
    }

    private let imageView = NSImageView()
    private let diameter: CGFloat
    private let content: Content
    private let shape: WorkGlyphMarkShape
    /// The glyph's ink. Neutral, the accent budget's default for an icon
    /// (docs/DESIGN.md): a subject, a kind, a task, a note. A caller passes
    /// primary for a late row or the accent for our own room. The workspace
    /// mark ignores it — the mark is the workspace, not an icon.
    private let tint: NSColor

    init(diameter: CGFloat, content: Content, accessibilityLabel: String, shape: WorkGlyphMarkShape = .round, tint: NSColor = StarlingsColors.secondaryText) {
        self.diameter = diameter
        self.content = content
        self.shape = shape
        self.tint = tint
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = Self.cornerRadius(for: diameter, shape: shape)
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1

        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: diameter),
            heightAnchor.constraint(equalToConstant: diameter),
            imageView.centerXAnchor.constraint(equalTo: centerXAnchor),
            imageView.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        if case .workspace = content {
            let side = diameter * 0.52
            let mark = NSHostingView(rootView: StarlingsCurrentWorkspaceMark(size: side, ink: Color(nsColor: StarlingsColors.accentMark)))
            mark.translatesAutoresizingMaskIntoConstraints = false
            addSubview(mark)
            NSLayoutConstraint.activate([
                mark.widthAnchor.constraint(equalToConstant: side),
                mark.heightAnchor.constraint(equalToConstant: side),
                mark.centerXAnchor.constraint(equalTo: centerXAnchor),
                mark.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
        }
        recolour()
        setAccessibilityLabel(accessibilityLabel)
    }

    private static func cornerRadius(for diameter: CGFloat, shape: WorkGlyphMarkShape) -> CGFloat {
        switch shape {
        case .round: diameter / 2
        case .square: min(9, diameter * 0.26)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        recolour()
    }

    private func recolour() {
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        let tint = StarlingsColors.resolved(tint, for: self)
        switch content {
        case .workspace:
            imageView.image = nil
        case .symbol(let name):
            imageView.contentTintColor = tint
            imageView.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: diameter * 0.46, weight: .medium))
        case .platform(let platform):
            imageView.contentTintColor = tint
            imageView.image = CalendarMeetingPlatformMark.image(for: platform, size: diameter * 0.5, color: tint)
                ?? NSImage(systemSymbolName: "calendar", accessibilityDescription: nil)?
                    .withSymbolConfiguration(.init(pointSize: diameter * 0.46, weight: .medium))
        }
    }
}

/// A tiny in-memory cache for organization logo images, keyed by URL. No
/// upload path and no version token, unlike a person's avatar — a logo
/// doesn't change from inside Meet, so a session-lifetime cache is enough; a
/// genuinely new one shows once this process restarts. Dedupes concurrent
/// requests for the same URL rather than firing one fetch per row.
///
/// Main-actor rather than an actor of its own for the same reason
/// `StarlingsAvatarImageCache` is: the sidebar rebuilds every row on every click,
/// and a cache hit that costs a hop is a frame of glyph before the logo —
/// a visible flash across the whole column. `cached(for:)` answers without
/// suspending so a row that already knows its logo draws it in the same pass.
@MainActor
private final class WorkOrgLogoCache {
    static let shared = WorkOrgLogoCache()

    private var images: [URL: NSImage] = [:]
    private var inFlight: [URL: Task<NSImage?, Never>] = [:]
    private var failed: Set<URL> = []

    /// What is already in hand, synchronously. Nil means not yet fetched or
    /// known to fail; only `image(for:)` tells those apart.
    func cached(for url: URL) -> NSImage? {
        images[url]
    }

    func image(for url: URL) async -> NSImage? {
        if let cached = images[url] { return cached }
        if failed.contains(url) { return nil }
        if let existing = inFlight[url] { return await existing.value }
        let task = Task<NSImage?, Never> {
            do {
                let (data, response) = try await URLSession.shared.data(from: url)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    return nil
                }
                // Cropped once here, not per row: a wide wordmark fills the
                // round well instead of sitting letterboxed inside it.
                return NSImage(data: data).map(StarlingsProfilePicture.squareCropped)
            } catch {
                return nil
            }
        }
        inFlight[url] = task
        let image = await task.value
        inFlight[url] = nil
        if let image {
            images[url] = image
        } else {
            failed.insert(url)
        }
        return image
    }
}

/// An organization's logo, in the same well a face or a glyph occupies.
/// Shows the fallback glyph immediately — an organization logo is a slower
/// fetch than a colleague's avatar, and a row that already has a title
/// should never wait on a picture to be legible — and cross-fades to the
/// image once `WorkOrgLogoCache` resolves it. Stays on the glyph if the
/// fetch fails; never a blank well.
final class WorkOrgLogoMarkView: NSView {
    private let imageView = NSImageView()
    private let diameter: CGFloat

    init(diameter: CGFloat, url: URL, fallbackSymbolName: String, accessibilityLabel: String) {
        self.diameter = diameter
        super.init(frame: .zero)

        let fallback = WorkGlyphMarkView(
            diameter: diameter,
            content: .symbol(fallbackSymbolName),
            accessibilityLabel: accessibilityLabel
        )
        fallback.translatesAutoresizingMaskIntoConstraints = false
        addSubview(fallback)

        imageView.wantsLayer = true
        imageView.layer?.cornerRadius = diameter / 2
        imageView.layer?.cornerCurve = .continuous
        imageView.layer?.masksToBounds = true
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.alphaValue = 0
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: diameter),
            heightAnchor.constraint(equalToConstant: diameter),
            fallback.leadingAnchor.constraint(equalTo: leadingAnchor),
            fallback.topAnchor.constraint(equalTo: topAnchor),
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            imageView.topAnchor.constraint(equalTo: topAnchor),
            imageView.widthAnchor.constraint(equalToConstant: diameter),
            imageView.heightAnchor.constraint(equalToConstant: diameter),
        ])

        // Already known: draw it now, no fade. The cross-fade is for a logo
        // arriving over the network, not for a row the sidebar just rebuilt.
        if let ready = WorkOrgLogoCache.shared.cached(for: url) {
            imageView.image = ready
            imageView.alphaValue = 1
            return
        }
        Task { [weak self] in
            guard let self, let image = await WorkOrgLogoCache.shared.image(for: url) else { return }
            imageView.image = image
            imageView.animator().alphaValue = 1
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// A menu item whose action is a closure. The row factories below build menus
/// outside any object that could stand as `target`, so each item carries its
/// own handler instead.
final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(title: String, symbol: MenuSymbol? = nil, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
        if let symbol { self.symbol(symbol) }
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func fire() {
        handler()
    }
}

extension NSMenuItem {
    /// The verb's glyph (`MenuSymbol`) in the menu's image column, so the
    /// same action wears the same mark in every menu.
    @discardableResult
    func symbol(_ symbol: MenuSymbol) -> Self {
        image = NSImage(systemSymbolName: symbol.rawValue, accessibilityDescription: nil)
        return self
    }
}

/// A button whose action is a closure, for the same reason as `ClosureMenuItem`.
private final class ClosureButton: NSButton {
    private let handler: () -> Void

    init(title: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(frame: .zero)
        self.title = title
        target = self
        action = #selector(fire)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func fire() {
        handler()
    }
}

// MARK: - Unread & spaces

extension WorkSidebarRowView {
    /// A subject in INBOX or one of the SUBJECTS groups. `detail` replaces
    /// the standing line when the caller knows something truer than the
    /// counts — a row built from a thread has counted nothing, and "No open
    /// tasks" there would be a guess dressed as a fact.
    ///
    /// `state` is the person's own follow / star / mute ( decision
    /// 5): a muted subject draws quiet and never bold, a starred one carries
    /// a star, and the menu offers the way to change each. Nil is a row
    /// drawn before the state arrived, or one that has none (INBOX).
    static func subject(
        _ subject: CrmSubject,
        isSelected: Bool,
        hasUnread: Bool = false,
        detail: String? = nil,
        showsLeading: Bool = true,
        isSubdued: Bool = false,
        state: ResolvedSubjectState? = nil,
        onSetState: ((CrmSubject, SubjectStateUpdate) -> Void)? = nil,
        onSelect: @escaping (CrmSubject) -> Void,
        onOpenPane: ((CrmSubject, WorkPane) -> Void)? = nil,
        onEdit: ((CrmSubject) -> Void)? = nil,
        onWin: ((CrmSubject) -> Void)? = nil,
        onRename: ((CrmSubject) -> Void)? = nil,
        onNewTask: ((CrmSubject) -> Void)? = nil,
        onNewIssue: ((CrmSubject) -> Void)? = nil,
        onMeet: ((CrmSubject) -> Void)? = nil,
        onOpenCore: ((CrmSubject) -> Void)? = nil,
        onLinkRepository: ((CrmSubject) -> Void)? = nil,
        onOpenKeep: ((CrmSubject) -> Void)? = nil,
        menu: (() -> NSMenu?)? = nil
    ) -> WorkSidebarRowView {
        let fallbackSymbol = switch subject.subjectKind {
        case .project: "folder.fill"
        case .lead: "flag.fill"
        case .organization: "building.2.fill"
        case .event: "megaphone"
        }
        let fallbackLabel = subject.subjectKind.label
        let leading: WorkSidebarRowView.Leading? = if !showsLeading {
            nil
        } else if let logoURLString = subject.organizationLogoURL, let logoURL = URL(string: logoURLString) {
            .organizationLogo(logoURL, fallbackSymbolName: fallbackSymbol, accessibilityLabel: fallbackLabel)
        } else {
            .glyph(systemSymbolName: fallbackSymbol, accessibilityLabel: fallbackLabel)
        }
        // How the row reads is decided once for both platforms
        // (`WorkSubjectRowSpec`, fixtures/work-rows.json).
        let muted = state?.muted == true
        let spec = WorkSubjectRowSpec(
            title: subject.displayTitle, hasUnread: hasUnread, isStarred: state?.starred == true,
            isMuted: muted, isSubdued: isSubdued
        )
        let trailing: Trailing? = switch spec.trailing {
        case .unreadDot: .unreadDot
        case .none: nil
        }
        return WorkSidebarRowView(
            leading: leading,
            title: subject.displayTitle,
            hasUnread: spec.showsUnread,
            subtitle: detail ?? subject.standing,
            trailing: trailing,
            isSelected: isSelected,
            isSubdued: isSubdued || muted,
            isStarred: spec.showsStarBadge,
            accessibilityLabel: spec.accessibilityLabel,
            onSelect: { onSelect(subject) },
            menuProvider: {
                // A row that is about something else — unread talk in INBOX —
                // brings its own menu; the subject's is not it.
                if let menu { return menu() }
                // Which actions, in what order, for which kind comes from the shared action
                // table (`WorkRowActionRegistry`, pinned to `fixtures/work-actions.json`), as a
                // task row's does. This supplies what each one does here, and its words. An
                // action whose handler the caller did not pass is left out.
                // The caller passes the link action only while nothing is linked.
                let facts = WorkRowActionFacts([
                    "isPartner": subject.isPartner,
                    "isEvent": subject.isEvent,
                    "isProject": subject.kind == "project",
                    "isOpenLead": subject.isOpenLead,
                    "hasRepo": subject.kind == "project" && onLinkRepository == nil,
                    "hasCore": onOpenCore != nil,
                ])
                func item(_ action: WorkRowActionID) -> NSMenuItem? {
                    switch action {
                    case .star:
                        // Star and mute are about the reader, the same two on every kind.
                        guard let state, let onSetState else { return nil }
                        return ClosureMenuItem(title: state.starred ? String(localized: "Unstar") : String(localized: "Star"), symbol: state.starred ? .unstar : .star) {
                            onSetState(subject, SubjectStateUpdate(starred: !state.starred))
                        }
                    case .mute:
                        guard let state, let onSetState else { return nil }
                        return ClosureMenuItem(title: state.muted ? String(localized: "Unmute") : String(localized: "Mute"), symbol: state.muted ? .unmute : .mute) {
                            onSetState(subject, SubjectStateUpdate(muted: !state.muted))
                        }
                    case .open:
                        guard let onOpenPane else { return nil }
                        // A partner opens on its page; anything else on its Talk.
                        return ClosureMenuItem(title: String(localized: "Open"), symbol: .open) { onOpenPane(subject, subject.isPartner ? .interactions : .talk) }
                    case .openTalk:
                        guard let onOpenPane else { return nil }
                        return ClosureMenuItem(title: String(localized: "Open talk"), symbol: .talk) { onOpenPane(subject, .talk) }
                    case .openHistory:
                        guard let onOpenPane else { return nil }
                        return ClosureMenuItem(title: String(localized: "Open history"), symbol: .history) { onOpenPane(subject, .interactions) }
                    case .openTasks:
                        guard let onOpenPane else { return nil }
                        return ClosureMenuItem(title: String(localized: "Open tasks"), symbol: .tasks) { onOpenPane(subject, .tasks) }
                    case .openIssues:
                        guard let onOpenPane else { return nil }
                        return ClosureMenuItem(title: String(localized: "Open issues"), symbol: .issues) { onOpenPane(subject, .issues) }
                    case .newTask:
                        guard let onNewTask else { return nil }
                        return ClosureMenuItem(title: String(localized: "New task"), symbol: .newTask) { onNewTask(subject) }
                    case .newIssue:
                        guard let onNewIssue else { return nil }
                        return ClosureMenuItem(title: String(localized: "New issue"), symbol: .newIssue) { onNewIssue(subject) }
                    case .editDetails:
                        // An event is a CMS row (docs/EVENTS.md): edited under Website in Core, never here.
                        guard let onEdit else { return nil }
                        return ClosureMenuItem(title: String(localized: "Edit details…"), symbol: .edit) { onEdit(subject) }
                    case .winLead:
                        guard let onWin else { return nil }
                        return ClosureMenuItem(title: String(localized: "Win…"), symbol: .winLead) { onWin(subject) }
                    case .rename:
                        guard let onRename else { return nil }
                        return ClosureMenuItem(title: String(localized: "Rename…"), symbol: .rename) { onRename(subject) }
                    case .startRoom:
                        guard let onMeet else { return nil }
                        return ClosureMenuItem(title: String(localized: "Meet about this"), symbol: .startRoom) { onMeet(subject) }
                    case .linkRepository:
                        guard let onLinkRepository else { return nil }
                        return ClosureMenuItem(title: String(localized: "Link GitHub repository…"), symbol: .linkRepository) { onLinkRepository(subject) }
                    case .keepVault:
                        // The project's vault in Keep, made on first open (docs/KEEP.md).
                        guard let onOpenKeep else { return nil }
                        return ClosureMenuItem(title: String(localized: "Keep vault"), symbol: .vault) { onOpenKeep(subject) }
                    case .openCore:
                        guard let onOpenCore else { return nil }
                        return ClosureMenuItem(title: String(localized: "Open full record"), symbol: .openCore) { onOpenCore(subject) }
                    default:
                        return nil
                    }
                }
                let menu = NSMenu()
                for group in WorkRowActionRegistry.groups(kind: .subject, context: subject.isPartner ? "organization" : "row", client: .mac, facts: facts) {
                    let items = group.compactMap(item)
                    guard !items.isEmpty else { continue }
                    if !menu.items.isEmpty { menu.addItem(.separator()) }
                    items.forEach { menu.addItem($0) }
                }
                return menu.items.isEmpty ? nil : menu
            }
        )
    }

    /// A direct message or the company-wide conversation in Unread. Carries
    /// the latest message rather than CRM standing, so a person-based
    /// conversation is just as actionable from the first column. `leading`
    /// is the caller's to supply — this factory doesn't know whether the
    /// address is a person or Everyone.
    static func conversation(
        leading: Leading? = nil,
        title: String,
        detail: String,
        isSelected: Bool,
        hasUnread: Bool,
        menuProvider: (() -> NSMenu?)? = nil,
        onSelect: @escaping () -> Void
    ) -> WorkSidebarRowView {
        WorkSidebarRowView(
            leading: leading,
            title: title,
            hasUnread: hasUnread,
            subtitle: detail,
            trailing: hasUnread ? .unreadDot : nil,
            isSelected: isSelected,
            accessibilityLabel: hasUnread ? String(localized: "\(title), unread message") : title,
            onSelect: onSelect,
            menuProvider: menuProvider
        )
    }
}

// MARK: - Team & Agents

extension WorkSidebarRowView {
    /// The "Envisioning"/Everyone channel row atop Team. No avatar and no
    /// presence — a channel is not somebody, and drawing it like a person
    /// would invite ringing it.
    static func channel(
        title: String,
        subtitle: String,
        hasUnread: Bool,
        isSelected: Bool = false,
        menuProvider: (() -> NSMenu?)? = nil,
        onSelect: @escaping () -> Void
    ) -> WorkSidebarRowView {
        var actions: [NSView] = []
        if hasUnread {
            actions.append(WorkSidebarRowView.unreadDotView())
        }
        return WorkSidebarRowView(
            leading: .channelMark,
            title: title,
            hasUnread: hasUnread,
            subtitle: subtitle,
            trailing: actions.isEmpty ? nil : .actions(actions),
            isSelected: isSelected,
            accessibilityLabel: hasUnread ? String(localized: "\(title), unread message") : title,
            onSelect: onSelect,
            menuProvider: menuProvider
        )
    }

    /// One person — colleague or agent — in Team or Agents. `preview` is an
    /// agent's last line in your conversation with it, its row's second line
    /// unless it is working.
    static func peer(
        _ peer: Peer,
        hasUnread: Bool,
        isSelected: Bool = false,
        preview: String? = nil,
        onSelect: ((Peer) -> Void)?,
        menuProvider: (() -> NSMenu?)? = nil
    ) -> WorkSidebarRowView {
        var actions: [NSView] = []
        if hasUnread {
            actions.append(WorkSidebarRowView.unreadDotView())
        }

        // No presence dot on an agent. The dot is evidence about a device,
        // and an agent has none — a green ring next to something that cannot
        // be interrupted reads as a colleague standing at their desk.
        let subtitle = peer.isAgent && peer.status != .busy ? (preview ?? "") : teamPeerSubtitle(for: peer)
        let described = [peer.displayName, peer.isAgent ? subtitle : peer.displayState.label]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
        return WorkSidebarRowView(
            leading: .avatar(StarlingsAvatarIdentity(peer: peer), status: peer.isAgent ? nil : peer.displayState.dot),
            title: peer.displayName,
            hasUnread: hasUnread,
            subtitle: subtitle,
            trailing: actions.isEmpty ? nil : .actions(actions),
            isSelected: isSelected,
            accessibilityLabel: hasUnread
                ? String(localized: "\(described), unread message")
                : described,
            onSelect: onSelect.map { callback in { callback(peer) } },
            menuProvider: menuProvider
        )
    }

}

extension NSMenu {
    /// A row's menu from its shared action list (`WorkRowAction`): one item
    /// per action, a line between groups. `perform` is the surface's own —
    /// the Work window and Home each carry out the same action with their
    /// own API and windows.
    static func workRow(_ groups: [[WorkRowAction]], perform: @escaping (WorkRowAction) -> Void) -> NSMenu? {
        let menu = NSMenu()
        for group in groups where !group.isEmpty {
            if !menu.items.isEmpty { menu.addItem(.separator()) }
            // Assign to ▸ or Move to ▸: one submenu of names, where the
            // group's first such item was.
            var drawn: Set<WorkRowAction.Submenu> = []
            for action in group {
                if let kind = action.submenu {
                    guard drawn.insert(kind).inserted else { continue }
                    let parent = NSMenuItem(title: kind.title, action: nil, keyEquivalent: "").symbol(kind.symbol)
                    let submenu = NSMenu()
                    for member in group where member.submenu == kind {
                        submenu.addItem(ClosureMenuItem(title: member.title) { perform(member) })
                    }
                    parent.submenu = submenu
                    menu.addItem(parent)
                    continue
                }
                let item = ClosureMenuItem(title: action.title, symbol: action.menuSymbol) { perform(action) }
                if action.isDestructive {
                    item.attributedTitle = NSAttributedString(
                        string: action.title,
                        attributes: [.foregroundColor: NSColor.systemRed]
                    )
                }
                menu.addItem(item)
            }
        }
        return menu.items.isEmpty ? nil : menu
    }
}

/// The star on a starred row or tile, the one Mac copy. `compact` sits on a
/// sidebar row's well or beside its title; `tile` sits on Quick Access's
/// larger mark. It paints its own fill and edge, so it follows the appearance
/// without its host doing anything.
@MainActor
final class StarlingsFavoriteBadge: NSView {
    enum Size {
        case compact
        case tile

        var diameter: CGFloat { self == .compact ? 16 : 20 }
        var starPoints: CGFloat { self == .compact ? 9 : 12 }
        var starFrame: CGFloat { self == .compact ? 10 : 12 }
    }

    private let size: Size

    init(size: Size) {
        self.size = size
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = size.diameter / 2
        layer?.borderWidth = size == .compact ? 0.5 : 0
        translatesAutoresizingMaskIntoConstraints = false
        // The row or tile says "Starred" in its own label.
        setAccessibilityElement(false)

        let star = NSImageView()
        star.image = NSImage(systemSymbolName: "star.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: size.starPoints, weight: .medium))
        star.contentTintColor = StarlingsColors.secondaryText
        star.translatesAutoresizingMaskIntoConstraints = false
        star.setAccessibilityElement(false)
        addSubview(star)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size.diameter),
            heightAnchor.constraint(equalToConstant: size.diameter),
            star.centerXAnchor.constraint(equalTo: centerXAnchor),
            star.centerYAnchor.constraint(equalTo: centerYAnchor),
            star.widthAnchor.constraint(equalToConstant: size.starFrame),
            star.heightAnchor.constraint(equalToConstant: size.starFrame),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = StarlingsColors.resolved(size == .compact ? StarlingsColors.elevated : StarlingsColors.panel, for: self).cgColor
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

