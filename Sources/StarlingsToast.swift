import AppKit

/// The passing word on the Mac: one capsule at the bottom of the window the
/// action happened in, gone on its own. See docs/DESIGN.md, "Toast — the
/// passing word", for when a toast is the right thing to say.
///
/// One per window, one at a time: a second toast replaces the first rather
/// than stacking. Neutral toasts last `StarlingsToast.neutralDuration`; a danger
/// toast draws through `StarlingsNoticeView`, so it reads red with Copy, and stays
/// `dangerDuration`. A click dismisses either.
@MainActor
enum StarlingsToast {
    static let neutralDuration: TimeInterval = 3
    static let dangerDuration: TimeInterval = 8
    /// Long enough to read the line and reach for the button.
    static let actionDuration: TimeInterval = 6

    /// A word on the capsule that does something, such as Open on "Sent to
    /// Vocab". Clicking it runs `run` and dismisses the toast.
    struct Action {
        let title: String
        let run: @MainActor () -> Void
    }

    /// Say `text` in `window`. Nothing happens without a window — a toast has
    /// nowhere to be, and a message nobody can see must not pretend it was
    /// shown.
    static func show(_ text: String, tone: StarlingsToastTone = .neutral, action: Action? = nil, in window: NSWindow?) {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, let window, let content = window.contentView else { return }
        let host = StarlingsToastHostView.host(in: content)
        host.present(line, tone: tone, action: action)
    }
}

extension StarlingsToastAction {
    /// The SwiftUI default on the Mac: the key window, which is the window the
    /// person is acting in. A controller that hosts SwiftUI in a window it
    /// owns installs `StarlingsToastAction(windowOf:)` instead, so a result that
    /// lands after they switched windows still finds the right one.
    static let platformDefault = StarlingsToastAction { text, tone in
        StarlingsToast.show(text, tone: tone, in: NSApp.keyWindow ?? NSApp.mainWindow)
    }

    /// Bound to `view`'s window, read at the moment of speaking — the view is
    /// often not in a window yet when its SwiftUI root is built.
    init(windowOf view: NSView) {
        self.init { [weak view] text, tone in StarlingsToast.show(text, tone: tone, in: view?.window) }
    }
}

/// The capsule and its timer. Installed once per window's content view, on
/// top of everything, and hidden when it has nothing to say so it never
/// intercepts a click.
final class StarlingsToastHostView: NSView {
    private let notice = StarlingsNoticeView()
    private let actionButton = NSButton()
    private var actionHandler: (@MainActor () -> Void)?
    private var noticeTrailing: NSLayoutConstraint!
    private var noticeToAction: NSLayoutConstraint!
    private var dismissal: DispatchWorkItem?

    static func host(in content: NSView) -> StarlingsToastHostView {
        if let existing = content.subviews.compactMap({ $0 as? StarlingsToastHostView }).first {
            // Content added since the last toast may have landed above it.
            content.addSubview(existing, positioned: .above, relativeTo: nil)
            return existing
        }
        let host = StarlingsToastHostView()
        content.addSubview(host, positioned: .above, relativeTo: nil)
        NSLayoutConstraint.activate([
            host.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            host.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            host.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -48),
        ])
        return host
    }

    /// The capsule itself: glass on macOS 26, the elevated rung with a
    /// hairline and a shadow below it. The host stays a clear frame so the
    /// glass has the window under it, not a painted box.
    private let capsule: NSView
    private let surface: NSView
    private let isGlass: Bool

    private init() {
        let capsule = NSView()
        let glass = StarlingsFloatingGlass.wrap(capsule, cornerRadius: 0)
        self.capsule = capsule
        surface = glass ?? capsule
        isGlass = glass != nil
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        isHidden = true
        alphaValue = 0

        if !isGlass {
            capsule.wantsLayer = true
            capsule.layer?.backgroundColor = StarlingsColors.elevated.cgColor
            capsule.layer?.borderWidth = 1
            capsule.layer?.shadowOpacity = 0.18
            capsule.layer?.shadowRadius = 8
            capsule.layer?.shadowOffset = CGSize(width: 0, height: -2)
        }
        surface.translatesAutoresizingMaskIntoConstraints = false
        addSubview(surface)
        surface.pinToEdges(of: self)

        notice.hidesWhenEmpty = false
        notice.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        notice.label.lineBreakMode = .byTruncatingTail
        notice.label.maximumNumberOfLines = 1
        notice.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        capsule.addSubview(notice)
        actionButton.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        // Word-only, so it gets the quiet well; `show` re-measures the
        // shoulder once it knows the word.
        SettingsChrome.applyQuietButton(actionButton)
        actionButton.target = self
        actionButton.action = #selector(actionClicked)
        actionButton.translatesAutoresizingMaskIntoConstraints = false
        actionButton.setContentHuggingPriority(.required, for: .horizontal)
        actionButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        actionButton.isHidden = true
        capsule.addSubview(actionButton)
        noticeTrailing = notice.trailingAnchor.constraint(equalTo: capsule.trailingAnchor, constant: -14)
        noticeToAction = notice.trailingAnchor.constraint(equalTo: actionButton.leadingAnchor, constant: -10)
        NSLayoutConstraint.activate([
            notice.leadingAnchor.constraint(equalTo: capsule.leadingAnchor, constant: 14),
            noticeTrailing,
            actionButton.trailingAnchor.constraint(equalTo: capsule.trailingAnchor, constant: -14),
            actionButton.centerYAnchor.constraint(equalTo: capsule.centerYAnchor),
            notice.topAnchor.constraint(equalTo: capsule.topAnchor, constant: 8),
            notice.bottomAnchor.constraint(equalTo: capsule.bottomAnchor, constant: -8),
        ])
        setAccessibilityRole(.group)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        let radius = bounds.height / 2
        if #available(macOS 26.0, *), let glass = surface as? NSGlassEffectView {
            glass.cornerRadius = radius
            return
        }
        capsule.layer?.cornerRadius = radius
        capsule.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        capsule.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsLayout = true
    }

    func present(_ text: String, tone: StarlingsToastTone, action: StarlingsToast.Action? = nil) {
        dismissal?.cancel()
        // A button belongs to the neutral capsule; a danger toast draws
        // through the error primitive and has no room for one.
        let offered = tone == .neutral ? action : nil
        actionHandler = offered?.run
        actionButton.isHidden = offered == nil
        if let offered {
            actionButton.attributedTitle = NSAttributedString(string: offered.title, attributes: [
                .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold),
                .foregroundColor: StarlingsColors.resolved(StarlingsColors.accent, for: self),
            ])
            actionButton.applyMeetShoulder(inset: 8)
        }
        noticeTrailing.isActive = offered == nil
        noticeToAction.isActive = offered != nil
        switch tone {
        case .neutral:
            notice.setText(text)
            // The neutral tone reads secondary in a status line; on its own
            // capsule the line is the whole point, so it reads primary.
            notice.label.textColor = StarlingsColors.primaryText
        case .danger:
            notice.showError(text)
        }
        setAccessibilityLabel(text)
        StarlingsAccessibility.announce(text, from: self)

        isHidden = false
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        NSAnimationContext.runAnimationGroup { context in
            context.duration = reduceMotion ? 0.12 : 0.18
            animator().alphaValue = 1
        }

        let work = DispatchWorkItem { [weak self] in self?.dismiss() }
        dismissal = work
        let duration = tone == .danger
            ? StarlingsToast.dangerDuration
            : offered != nil ? StarlingsToast.actionDuration : StarlingsToast.neutralDuration
        DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
    }

    private func dismiss() {
        dismissal?.cancel()
        dismissal = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.2
            animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self, self.alphaValue == 0 else { return }
            self.isHidden = true
            self.notice.clear()
        })
    }

    @objc private func actionClicked() {
        let run = actionHandler
        dismiss()
        run?()
    }

    override func mouseDown(with event: NSEvent) {
        dismiss()
    }
}
