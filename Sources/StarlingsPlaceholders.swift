import AppKit

/// The Mac's placeholder row: the AppKit twin of EnvisioningUI
/// `EnvisioningPlaceholderRow` (DESIGN.md, Waiting); the SwiftUI stack is
/// `StarlingsPlaceholderStack`. A glyph, a title bar and
/// a detail bar in `border` ink; widths step by `variant` so a stack reads as
/// rows. Laid out at once, so the section keeps its height, and drawn only
/// after 250 ms, because most answers land inside that. Hidden from
/// assistive technology: the section's title and the answer do the talking.
@MainActor
final class StarlingsPlaceholderRowView: NSView {
    private static let titleWidths: [CGFloat] = [140, 110, 170]
    private static let detailWidths: [CGFloat] = [220, 190, 160]
    private static let delay: TimeInterval = 0.25

    private var bars: [NSView] = []

    /// `count` rows for a section that waits for its first answer.
    static func rows(_ count: Int = 3, glyph: Bool = true) -> [NSView] {
        (0..<count).map { StarlingsPlaceholderRowView(variant: $0, glyph: glyph) }
    }

    init(variant: Int = 0, glyph: Bool = true, verticalInset: CGFloat = 3) {
        super.init(frame: .zero)
        let title = bar(width: Self.titleWidths[variant % 3], height: 12)
        let detail = bar(width: Self.detailWidths[variant % 3], height: 10)
        let copy = NSStackView(views: [title, detail])
        copy.orientation = .vertical
        copy.alignment = .leading
        copy.spacing = 6
        let row = NSStackView(views: glyph ? [bar(width: 16, height: 16), copy] : [copy])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 10
        addSubview(row)
        row.pinToEdges(of: self, insets: NSEdgeInsets(top: verticalInset, left: 0, bottom: verticalInset, right: 0))
        setAccessibilityElement(false)
        alphaValue = 0
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil, alphaValue == 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.delay) { [weak self] in
            guard let self, self.window != nil else { return }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                self.animator().alphaValue = 1
            }
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        paint()
    }

    private func bar(width: CGFloat, height: CGFloat) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.cornerRadius = height / 2
        view.translatesAutoresizingMaskIntoConstraints = false
        let preferred = view.widthAnchor.constraint(equalToConstant: width)
        preferred.priority = .defaultHigh
        NSLayoutConstraint.activate([
            preferred,
            view.widthAnchor.constraint(lessThanOrEqualToConstant: width),
            view.heightAnchor.constraint(equalToConstant: height),
        ])
        bars.append(view)
        paint(view)
        return view
    }

    private func paint(_ only: NSView? = nil) {
        let ink = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        for bar in only.map({ [$0] }) ?? bars { bar.layer?.backgroundColor = ink }
    }
}
