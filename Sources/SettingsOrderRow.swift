import AppKit

/// One item of an ordered list in Settings — a Home module, a block of
/// Work's rail: its name, what it shows, an up and a down to move it a
/// place, and a toggle for whether it draws at all. The row is dumb on
/// purpose — the order and the resolve rule belong to the page that owns
/// the list (`HomeLayout`, `WorkSidebarPreferences`).
@MainActor
final class SettingsOrderRow: NSView {
    let title: String
    let canHide: Bool
    var onMove: ((HomeLayout.MoveDirection) -> Void)?
    var onToggle: ((Bool) -> Void)?

    private let titleLabel: NSTextField
    private let detailLabel = StarlingsTypography.wrappingLabel("")
    private lazy var upButton = StarlingsPanelHeader.actionButton(
        symbolName: "chevron.up", accessibilityLabel: String(localized: "Move \(title) up"), target: self, action: #selector(upTapped)
    )
    private lazy var downButton = StarlingsPanelHeader.actionButton(
        symbolName: "chevron.down", accessibilityLabel: String(localized: "Move \(title) down"), target: self, action: #selector(downTapped)
    )
    private let toggle = StarlingsToggle()

    /// `surface` names where the item lives, for the toggle's accessibility
    /// label ("Show Messages on Home"). `cannotHideReason` is the tooltip
    /// on an inert toggle.
    init(title: String, detail: String, surface: String, canHide: Bool, cannotHideReason: String? = nil) {
        self.title = title
        self.canHide = canHide
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)

        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
        titleLabel.textColor = StarlingsColors.primaryText
        detailLabel.stringValue = detail
        detailLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detailLabel.textColor = StarlingsColors.secondaryText
        detailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detailLabel.isHidden = detail.isEmpty

        toggle.setAccessibilityLabel(String(localized: "Show \(title) on \(surface)"))
        toggle.target = self
        toggle.action = #selector(toggled)
        toggle.setContentHuggingPriority(.required, for: .horizontal)
        // An item that cannot be hidden keeps its toggle, on and inert, so
        // the row reads like its neighbours.
        toggle.isEnabled = canHide
        toggle.alphaValue = canHide ? 1 : 0.45
        toggle.toolTip = canHide ? nil : cannotHideReason

        let labels = NSStackView(views: [titleLabel, detailLabel])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 2

        let movers = NSStackView(views: [upButton, downButton])
        movers.orientation = .horizontal
        movers.spacing = 2

        let row = NSStackView(views: [labels, NSView(), movers, toggle])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.setCustomSpacing(14, after: movers)
        addSubview(row)
        row.pinToEdges(of: self, insets: SettingsChrome.rowInset)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            detailLabel.widthAnchor.constraint(equalTo: labels.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The room cannot be hidden: Start is what the app is for.
    convenience init(module: HomeModuleDefinition) {
        self.init(
            title: module.title,
            detail: module.detail,
            surface: "Home",
            canHide: module.canHide,
            cannotHideReason: "Your room stays on Home."
        )
    }

    func render(
        enabled: Bool,
        isFirst: Bool,
        isLast: Bool,
        saving: Bool,
        canMoveUp: Bool = true,
        canMoveDown: Bool = true
    ) {
        toggle.isOn = enabled
        upButton.isEnabled = !isFirst && !saving && canMoveUp
        downButton.isEnabled = !isLast && !saving && canMoveDown
        toggle.isEnabled = canHide && !saving
    }

    @objc private func upTapped() { onMove?(.up) }
    @objc private func downTapped() { onMove?(.down) }
    @objc private func toggled() { onToggle?(toggle.isOn) }
}
