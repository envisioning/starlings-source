import AppKit

/// A quiet, app-wide indication that the validated feed found a newer build.
/// It lives in the titlebar spacer so it does not move the meeting stage or the
/// owner launch surface, and it remains visible if a check finishes during a
/// live meeting.
@MainActor
final class UpdateBannerView: NSView {
    var onAction: (() -> Void)?
    var onDismiss: (() -> Void)?

    private let iconView = NSImageView()
    private let messageLabel = NSTextField(labelWithString: "")
    private let actionButton = NSButton(title: String(localized: "View"), target: nil, action: nil)
    private let dismissButton: NSButton = {
        let button = NSButton()
        button.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: String(localized: "Dismiss"))
        return button
    }()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setUpdate(_ update: AvailableUpdate?, recommendation: Bool, canInstall: Bool) {
        guard recommendation || update != nil else {
            isHidden = true
            return
        }

        isHidden = false
        if recommendation {
            messageLabel.stringValue = String(localized: "A newer version of Starlings is available")
            actionButton.title = String(localized: "Update")
            actionButton.setAccessibilityLabel(String(localized: "Update Starlings"))
            dismissButton.isHidden = false
            setAccessibilityLabel(String(localized: "A newer version of Starlings is available"))
        } else if let update {
            let installed = UpdateCheck.installedVersion
            messageLabel.stringValue = String(localized: "Update \(installed) → \(update.version)")
            actionButton.title = canInstall ? String(localized: "Install") : String(localized: "Details")
            actionButton.setAccessibilityLabel(
                canInstall ? String(localized: "Install update and restart Starlings") : String(localized: "View update details")
            )
            dismissButton.isHidden = true
            setAccessibilityLabel(String(localized: "Update available: \(installed) to \(update.version)"))
        }
        setAccessibilityValue(messageLabel.stringValue)
    }

    private func build() {
        SettingsChrome.applyGroupSurface(self)
        layer?.cornerRadius = 8

        iconView.image = NSImage(
            systemSymbolName: "arrow.down.circle.fill",
            accessibilityDescription: String(localized: "Update available")
        )?.withSymbolConfiguration(.init(pointSize: 12, weight: .semibold))
        iconView.contentTintColor = StarlingsColors.accentMark
        iconView.setContentHuggingPriority(.required, for: .horizontal)

        messageLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        messageLabel.textColor = StarlingsColors.primaryText
        messageLabel.lineBreakMode = .byTruncatingTail
        messageLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        actionButton.bezelStyle = .inline
        actionButton.controlSize = .small
        actionButton.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        actionButton.contentTintColor = StarlingsColors.accentMark
        actionButton.target = self
        actionButton.action = #selector(actionTapped)
        actionButton.setContentHuggingPriority(.required, for: .horizontal)
        SettingsChrome.applyQuietButton(actionButton, cornerRadius: 5)

        dismissButton.bezelStyle = .inline
        dismissButton.controlSize = .small
        dismissButton.target = self
        dismissButton.action = #selector(dismissTapped)
        dismissButton.setAccessibilityLabel(String(localized: "Dismiss"))
        SettingsChrome.applyQuietButton(dismissButton, cornerRadius: 5)

        let content = NSStackView(views: [iconView, messageLabel, actionButton, dismissButton])
        content.orientation = .horizontal
        content.alignment = .centerY
        content.spacing = 6
        addSubview(content)
        content.pinToEdges(
            of: self,
            insets: NSEdgeInsets(top: 2, left: 8, bottom: 2, right: 5)
        )

        NSLayoutConstraint.activate([
            widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
            heightAnchor.constraint(equalToConstant: 28),
            iconView.widthAnchor.constraint(equalToConstant: 15),
            iconView.heightAnchor.constraint(equalToConstant: 15),
            dismissButton.widthAnchor.constraint(equalToConstant: 22),
            dismissButton.heightAnchor.constraint(equalToConstant: 22),
        ])

        isHidden = true
        setAccessibilityRole(.group)
    }

    @objc private func actionTapped() {
        onAction?()
    }

    @objc private func dismissTapped() {
        onDismiss?()
    }
}
