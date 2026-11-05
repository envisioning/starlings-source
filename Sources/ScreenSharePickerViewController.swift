import AppKit
import LiveKit
import ScreenCaptureKit

/// The "what do you want to share?" sheet: every display and window as a live
/// thumbnail you can point at.
///
/// It replaces a text menu of window titles. Titles are a poor way to pick a
/// window — "Google Chrome — Window" describes three different things on a busy
/// Mac, and the cost of picking wrong is showing the room something private for
/// as long as it takes to notice. A picture is checkable before anyone sees it.
@MainActor
final class ScreenSharePickerViewController: NSViewController {
    /// Wide enough to recognise a window at a glance, small enough that a
    /// screenful of them still captures quickly.
    private static let thumbnailWidth = 280

    private let displays: [MacOSDisplay]
    private let windows: [MacOSWindow]
    private let scrollView = NSScrollView()
    private let content = NSStackView()
    private let shareButton = StarlingsFilledButton(frame: .zero)
    private var cards: [SourceCardView] = []
    private var selected: MacOSScreenCaptureSource?
    private var thumbnailTask: Task<Void, Never>?

    var onPick: ((MacOSScreenCaptureSource) -> Void)?
    var onCancel: (() -> Void)?

    init(displays: [MacOSDisplay], windows: [MacOSWindow]) {
        self.displays = displays
        self.windows = windows
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        thumbnailTask?.cancel()
    }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 960, height: 620))
        root.wantsLayer = true
        root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: root).cgColor

        let title = NSTextField(labelWithString: String(localized: "Share your screen"))
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(17), weight: .semibold)
        title.textColor = StarlingsColors.primaryText

        let subtitle = NSTextField(labelWithString: String(localized: "Everyone in the meeting sees what you pick, until you stop sharing."))
        subtitle.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        subtitle.textColor = StarlingsColors.secondaryText

        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 18
        content.edgeInsets = NSEdgeInsets(top: 4, left: 4, bottom: 4, right: 4)

        scrollView.documentView = content
        // A document view AppKit still sizes from its autoresizing mask fights
        // the constraint below instead of honouring it, so the grid's width
        // never reaches the sheet.
        content.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true

        let cancelButton = NSButton(title: String(localized: "Cancel"), target: self, action: #selector(cancel))
        SettingsChrome.applySecondaryButton(cancelButton, title: String(localized: "Cancel"), height: 32)
        cancelButton.keyEquivalent = "\u{1b}"

        shareButton.apply(.accent, title: String(localized: "Share"), height: 32)
        shareButton.target = self
        shareButton.action = #selector(shareSelection)
        shareButton.keyEquivalent = "\r"
        shareButton.isEnabled = false

        let actions = NSStackView(views: [NSView(), cancelButton, shareButton])
        actions.orientation = .horizontal
        actions.spacing = 10

        // The sheet takes its size from these, not from `loadView`'s frame:
        // `NSWindow.contentViewController` resizes the window to the view's
        // fitting size, and nothing else here asks for a width. A scroll view
        // has no intrinsic one, a stack view drops arranged subviews rather
        // than resist clipping, and a label with no trailing anchor overflows
        // silently — so the picker could open as a sliver with its own title
        // clipped to "Sh".
        let preferredWidth = root.widthAnchor.constraint(equalToConstant: 960)
        let preferredHeight = root.heightAnchor.constraint(equalToConstant: 620)
        // High, not required: the sheet is resizable, so the window's own size
        // has to win once it is dragged.
        preferredWidth.priority = .defaultHigh
        preferredHeight.priority = .defaultHigh

        for child in [title, subtitle, scrollView, actions] {
            root.addSubview(child)
            child.translatesAutoresizingMaskIntoConstraints = false
        }

        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(greaterThanOrEqualToConstant: 480),
            root.heightAnchor.constraint(greaterThanOrEqualToConstant: 360),
            preferredWidth,
            preferredHeight,
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 20),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            title.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -22),
            subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 4),
            subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            subtitle.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -22),
            scrollView.topAnchor.constraint(equalTo: subtitle.bottomAnchor, constant: 16),
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            scrollView.bottomAnchor.constraint(equalTo: actions.topAnchor, constant: -14),
            actions.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            actions.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            actions.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
            content.topAnchor.constraint(equalTo: scrollView.contentView.topAnchor),
            content.leadingAnchor.constraint(equalTo: scrollView.contentView.leadingAnchor),
            // `>=`, not `=`: the grid is three fixed 280pt cards wide, so a
            // sheet dragged narrower than that scrolls sideways rather than
            // breaking a required constraint.
            content.widthAnchor.constraint(greaterThanOrEqualTo: scrollView.widthAnchor, constant: -8),
        ])

        view = root
        preferredContentSize = NSSize(width: 960, height: 620)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        buildSections()
        // Thumbnails arrive after the sheet does. Capturing a screenful of
        // windows takes long enough to feel like a hang if the sheet waited for
        // it, and the names are already enough to pick by.
        thumbnailTask = Task { [weak self] in await self?.loadThumbnails() }
    }

    private func buildSections() {
        content.addArrangedSubview(sectionHeader(String(localized: "Entire screen")))
        content.addArrangedSubview(grid(
            displays.enumerated().map { index, display in
                card(for: display, title: displays.count == 1 ? String(localized: "This display") : String(localized: "Display \(index + 1)"))
            }
        ))

        content.addArrangedSubview(sectionHeader(String(localized: "Window")))
        if windows.isEmpty {
            let empty = NSTextField(labelWithString: String(localized: "No windows available to share."))
            empty.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            empty.textColor = StarlingsColors.secondaryText
            content.addArrangedSubview(empty)
        } else {
            content.addArrangedSubview(grid(windows.map { card(for: $0, title: Self.windowTitle($0)) }))
        }
    }

    private func sectionHeader(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text.uppercased())
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        label.textColor = StarlingsColors.secondaryText
        return label
    }

    private func card(for source: MacOSScreenCaptureSource, title: String) -> SourceCardView {
        let card = SourceCardView(source: source, title: title)
        card.onSelect = { [weak self] in self?.select(card) }
        card.onConfirm = { [weak self] in
            self?.select(card)
            self?.shareSelection()
        }
        cards.append(card)
        return card
    }

    /// Fixed three-per-row rather than a collection view: the sheet is a fixed
    /// size, so a flow layout would only ever produce this same grid.
    private func grid(_ cards: [SourceCardView]) -> NSView {
        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 12
        for chunk in stride(from: 0, to: cards.count, by: 3).map({ Array(cards[$0..<min($0 + 3, cards.count)]) }) {
            let row = NSStackView(views: chunk)
            row.orientation = .horizontal
            row.spacing = 12
            row.alignment = .top
            column.addArrangedSubview(row)
        }
        return column
    }

    private func select(_ card: SourceCardView) {
        selected = card.source
        for other in cards {
            other.isSelected = other === card
        }
        shareButton.isEnabled = true
    }

    @objc private func shareSelection() {
        guard let selected else { return }
        thumbnailTask?.cancel()
        onPick?(selected)
    }

    @objc private func cancel() {
        thumbnailTask?.cancel()
        onCancel?()
    }

    /// Captures previews one at a time, newest section first. Serial on purpose:
    /// a parallel burst of `SCScreenshotManager` calls competes with the meeting
    /// itself for the same capture path, and these are decoration.
    private func loadThumbnails() async {
        for card in cards {
            if Task.isCancelled { return }
            guard let image = await Self.thumbnail(for: card.source) else { continue }
            card.setThumbnail(image)
        }
    }

    private static func thumbnail(for source: MacOSScreenCaptureSource) async -> NSImage? {
        guard let filter = contentFilter(for: source) else { return nil }
        let configuration = SCStreamConfiguration()
        let size = filter.contentRect.size
        guard size.width > 0, size.height > 0 else { return nil }
        configuration.width = thumbnailWidth
        configuration.height = max(1, Int(CGFloat(thumbnailWidth) * size.height / size.width))
        configuration.showsCursor = false
        guard let image = try? await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        ) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: configuration.width, height: configuration.height))
    }

    /// LiveKit hands back the ScreenCaptureKit objects it resolved the source
    /// from, so the preview is filtered exactly like the share will be.
    private static func contentFilter(for source: MacOSScreenCaptureSource) -> SCContentFilter? {
        if let window = source as? MacOSWindow, let native = window.nativeType as? SCWindow {
            return SCContentFilter(desktopIndependentWindow: native)
        }
        if let display = source as? MacOSDisplay, let native = display.nativeType as? SCDisplay {
            let content = display.scContent as? SCShareableContent
            // Same exclusion the share itself uses: Meet's own windows stay out,
            // so the preview never shows the meeting looking at itself.
            let others = (content?.applications ?? []).filter {
                $0.bundleIdentifier != Bundle.main.bundleIdentifier
            }
            return SCContentFilter(display: native, including: others, exceptingWindows: [])
        }
        return nil
    }

    static func windowTitle(_ window: MacOSWindow) -> String {
        let appName = window.owningApplication?.applicationName.trimmingCharacters(in: .whitespacesAndNewlines)
        let windowTitle = window.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let app = (appName?.isEmpty == false) ? appName! : "Window"
        if let windowTitle, !windowTitle.isEmpty {
            return String(localized: "\(app) — \(windowTitle)")
        }
        return app
    }
}

/// One pickable surface: preview on top, name underneath, accent ring when
/// chosen.
@MainActor
private final class SourceCardView: NSControl {
    let source: MacOSScreenCaptureSource

    private let preview = NSImageView()
    private let label = NSTextField(labelWithString: "")
    private let placeholder = NSImageView()

    var onSelect: (() -> Void)?
    var onConfirm: (() -> Void)?

    private var isHovered = false

    var isSelected = false {
        didSet {
            guard isSelected != oldValue else { return }
            refreshChrome()
            setAccessibilitySelected(isSelected)
        }
    }

    init(source: MacOSScreenCaptureSource, title: String) {
        self.source = source
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.cornerCurve = .continuous
        refreshChrome()
        // A grid of cards where nothing answers the pointer makes you click one
        // to find out it was clickable.
        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.refreshChrome()
        }

        preview.imageScaling = .scaleProportionallyUpOrDown
        preview.wantsLayer = true
        preview.layer?.cornerRadius = 6
        preview.layer?.masksToBounds = true

        placeholder.image = NSImage(
            systemSymbolName: source is MacOSDisplay ? "display" : "macwindow",
            accessibilityDescription: nil
        )
        placeholder.contentTintColor = StarlingsColors.secondaryText
        placeholder.imageScaling = .scaleProportionallyDown

        label.stringValue = title
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        label.textColor = StarlingsColors.primaryText
        label.lineBreakMode = .byTruncatingMiddle
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        for child in [placeholder, preview, label] {
            addSubview(child)
            child.translatesAutoresizingMaskIntoConstraints = false
        }

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 280),
            preview.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            preview.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            preview.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            preview.heightAnchor.constraint(equalToConstant: 150),
            placeholder.centerXAnchor.constraint(equalTo: preview.centerXAnchor),
            placeholder.centerYAnchor.constraint(equalTo: preview.centerYAnchor),
            placeholder.widthAnchor.constraint(equalToConstant: 34),
            placeholder.heightAnchor.constraint(equalToConstant: 34),
            label.topAnchor.constraint(equalTo: preview.bottomAnchor, constant: 8),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
        ])

        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Selection owns the accent border; hover owns the fill. Keeping them on
    /// separate channels means a hovered card never looks picked.
    private func refreshChrome() {
        let base = StarlingsColors.panel
        layer?.backgroundColor = StarlingsColors.resolved(
            isHovered ? StarlingsColors.lifted(base) : base,
            for: self
        ).cgColor
        layer?.borderWidth = isSelected ? 2 : 1
        let resting = isHovered ? StarlingsColors.borderHover : StarlingsColors.border
        layer?.borderColor = StarlingsColors.resolved(
            isSelected ? StarlingsColors.accent : resting,
            for: self
        ).cgColor
    }

    func setThumbnail(_ image: NSImage) {
        preview.image = image
        placeholder.isHidden = true
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            onConfirm?()
        } else {
            onSelect?()
        }
    }

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        // Space picks, matching how a focused button behaves elsewhere.
        if event.charactersIgnoringModifiers == " " {
            onSelect?()
            return
        }
        super.keyDown(with: event)
    }
}
