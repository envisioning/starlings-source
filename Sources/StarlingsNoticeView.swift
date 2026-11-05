import AppKit

/// An inline status line that knows the difference between saying something
/// and saying something went wrong.
///
/// Every error on the Mac reads in `StarlingsColors.danger` and carries a Copy
/// button — see `StarlingsErrorReport` for what lands on the clipboard. A neutral
/// line ("Saving…", "Waved at Ana") shows in the secondary colour with no
/// button, so the same control can hold the status label a pane already had.
/// The SwiftUI twin is `StarlingsErrorNotice`; the web's is `ErrorNotice.tsx`.
///
/// `label` is exposed so a site keeps its own font, alignment and truncation;
/// the tone owns colour and the Copy button, nothing else.
final class StarlingsNoticeView: NSStackView {
    enum Tone: Equatable {
        case neutral
        case danger
    }

    let label: NSTextField
    private let copyButton = NSButton(title: String(localized: "Copy"), target: nil, action: nil)
    private var copyFlash: DispatchWorkItem?
    /// The site's Retry, and where it pointed. It becomes Update while the
    /// line is a `client_update_required` refusal.
    private var retryButton: NSButton?
    private var retryTarget: (target: AnyObject, action: Selector)?

    /// The code or raw text Copy appends after the prose, when the site has one.
    private var detail: String?

    /// Hide the whole row when the text is empty. Off for sites that reserve
    /// the line's height (a status row in a rail) and manage `isHidden` themselves.
    var hidesWhenEmpty = true {
        didSet {
            // A site that manages visibility itself gets a visible control to
            // manage; the default hides until there is something to say.
            isHidden = hidesWhenEmpty && text.isEmpty
        }
    }

    private(set) var tone: Tone = .neutral

    var text: String {
        label.stringValue
    }

    init(wrapping: Bool = false) {
        label = wrapping
            ? NSTextField(wrappingLabelWithString: "")
            : NSTextField(labelWithString: "")
        super.init(frame: .zero)
        orientation = .horizontal
        alignment = wrapping ? .top : .centerY
        spacing = 8
        translatesAutoresizingMaskIntoConstraints = false

        label.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        label.textColor = StarlingsColors.secondaryText
        label.isSelectable = false

        copyButton.bezelStyle = .inline
        copyButton.isBordered = false
        copyButton.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
        copyButton.contentTintColor = StarlingsColors.danger
        copyButton.setAccessibilityLabel(String(localized: "Copy error"))
        copyButton.target = self
        copyButton.action = #selector(copyTapped)
        copyButton.wantsLayer = true
        copyButton.layer?.cornerRadius = 5
        copyButton.layer?.borderWidth = 1
        // The danger hairline stays put (`layout` owns it); the fill lifts.
        copyButton.applyMeetHoverLift(cornerRadius: 5)
        copyButton.setContentHuggingPriority(.required, for: .horizontal)
        copyButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        copyButton.heightAnchor.constraint(equalToConstant: 18).isActive = true
        copyButton.isHidden = true

        addArrangedSubview(label)
        addArrangedSubview(copyButton)
        isHidden = hidesWhenEmpty
        applyTone()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Say `text` in `tone`. Nil or empty clears the line.
    func setText(_ text: String?, tone: Tone = .neutral, detail: String? = nil) {
        let value = text ?? ""
        label.stringValue = value
        self.tone = value.isEmpty ? .neutral : tone
        self.detail = detail
        applyTone()
        applyRetry()
        if hidesWhenEmpty {
            isHidden = value.isEmpty
        }
    }

    /// The common case: a failure, in red, with Copy.
    func showError(_ text: String, detail: String? = nil) {
        setText(text, tone: .danger, detail: detail)
    }

    /// A typed failure: the title, and under it the sentence the server or
    /// the app wrote for the person — not the code. The code and diagnostic
    /// are for the log line, which Copy still carries via `logLine`.
    func showError(_ error: StarlingsError) {
        let detail = error.message.trimmingCharacters(in: .whitespacesAndNewlines)
        setText(error.title, tone: .danger, detail: detail.isEmpty ? error.logLine : detail)
    }

    /// Any failure: typed ones keep their prose, the rest show what they have.
    func showError(_ error: Error) {
        if let typed = error as? StarlingsError {
            showError(typed)
        } else {
            setText(error.localizedDescription, tone: .danger, detail: nil)
        }
    }

    func clear() {
        setText(nil)
    }

    /// A Retry beside Copy, for a failed read the person can ask for again
    ///. Added once; the site owns the action.
    func addRetry(target: AnyObject, action: Selector) {
        let retry = NSButton(title: String(localized: "Retry"), target: target, action: action)
        retry.bezelStyle = .inline
        SettingsChrome.applyQuietButton(retry)
        retry.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .semibold)
        retry.setContentHuggingPriority(.required, for: .horizontal)
        retry.setContentCompressionResistancePriority(.required, for: .horizontal)
        addArrangedSubview(retry)
        retryButton = retry
        retryTarget = (target, action)
        applyRetry()
    }

    /// Retry cannot fix a route that refuses this build: Update can.
    private func applyRetry() {
        guard let retryButton, let retryTarget else { return }
        let update = tone == .danger
            && (StarlingsUpgradeRecommendation.shared.requires(text) || detail.map(StarlingsUpgradeRecommendation.shared.requires) == true)
        retryButton.title = update ? String(localized: "Update") : String(localized: "Retry")
        retryButton.target = update ? self : retryTarget.target
        retryButton.action = update ? #selector(updateTapped) : retryTarget.action
    }

    @objc private func updateTapped() {
        StarlingsUpgradeRecommendation.shared.requestUpdate()
    }

    override func layout() {
        super.layout()
        copyButton.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.danger, for: self)
            .withAlphaComponent(0.55).cgColor
    }

    private func applyTone() {
        switch tone {
        case .neutral:
            label.textColor = StarlingsColors.secondaryText
            copyButton.isHidden = true
        case .danger:
            label.textColor = StarlingsColors.danger
            copyButton.isHidden = false
        }
    }

    @objc private func copyTapped() {
        StarlingsErrorReport.copy(message: label.stringValue, detail: detail)
        copyFlash?.cancel()
        copyButton.title = String(localized: "Copied")
        let reset = DispatchWorkItem { [weak self] in self?.copyButton.title = String(localized: "Copy") }
        copyFlash = reset
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: reset)
    }
}

extension NSAlert {
    /// Every error alert on the Mac carries Copy. Adds the button last, so the
    /// existing first/second button handling at each call site is untouched,
    /// and returns the response that means it was pressed.
    @discardableResult
    func addCopyErrorButton() -> NSApplication.ModalResponse {
        let index = buttons.count
        _ = addButton(withTitle: String(localized: "Copy"))
        return NSApplication.ModalResponse(NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + index)
    }
}
