import AppKit

/// Facts about the stage, kept on the stage: how many people are in the room
/// and how long it has been going.
///
/// These used to sit in the line under the stage, which made the readout a
/// row-width problem — the first thing to be squeezed when the window narrowed.
/// Scrimmed like the tile name badge, because it is drawn over faces — glass
/// on macOS 26, the same as every badge over video.
@MainActor
final class StageReadoutPill: NSView {
    private let participantsLabel = NSTextField(labelWithString: String(localized: "1 participant"))
    private let separator = NSTextField(labelWithString: "·")
    private let durationLabel = NSTextField(labelWithString: "")
    /// The solo hint, under the count in the same voice. It used to be its own
    /// badge in the top-right corner; one pill says everything the stage knows.
    private let hintLabel = NSTextField(labelWithString: String(localized: "Waiting for someone to join"))
    private let row = NSStackView()
    private let column = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        StarlingsFloatingGlass.scrim(self, cornerRadius: 8)

        participantsLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        participantsLabel.textColor = .white
        separator.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        separator.textColor = NSColor.white.withAlphaComponent(0.5)
        durationLabel.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        durationLabel.textColor = .white
        hintLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        hintLabel.textColor = .white
        hintLabel.isHidden = true
        for label in [participantsLabel, separator, durationLabel, hintLabel] {
            label.usesSingleLineMode = true
            label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }

        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        row.addArrangedSubview(participantsLabel)
        row.addArrangedSubview(separator)
        row.addArrangedSubview(durationLabel)

        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 2
        column.addArrangedSubview(row)
        column.addArrangedSubview(hintLabel)
        addSubview(column)
        column.translatesAutoresizingMaskIntoConstraints = false
        column.pinToEdges(of: self, insets: NSEdgeInsets(top: 5, left: 9, bottom: 5, right: 9))

        setDuration(nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setParticipants(_ text: String) {
        participantsLabel.stringValue = text
    }

    /// Nil outside a live meeting: there is no clock to read yet, and the
    /// separator goes with it rather than trailing a dot after the count.
    func setDuration(_ text: String?) {
        durationLabel.stringValue = text ?? ""
        durationLabel.isHidden = text == nil
        separator.isHidden = text == nil
    }

    /// Shown while nobody else is on the stage.
    func setWaitingHint(_ visible: Bool) {
        hintLabel.isHidden = !visible
    }
}

/// Somebody is at the door, said on the stage rather than only in the rail.
///
/// Admission is the one thing in a live meeting with a deadline on it, and the
/// rail can be closed. The banner names the guest who has waited longest and
/// carries the same two decisions as their row — `admitNextWaitingGuest` and
/// `rejectNextWaitingGuest`, the same pair ⌘⇧↩ / ⌘⇧⌫ press — with anybody
/// behind them counted on a button that opens the queue itself.
@MainActor
final class StageKnockBanner: NSView {
    var onAdmit: (() -> Void)?
    var onDecline: (() -> Void)?
    /// Pressed on "+N more": the rail's queue is where a decision about
    /// somebody other than the next guest is made.
    var onShowQueue: (() -> Void)?

    private let nameLabel = NSTextField(labelWithString: "")
    private let admitButton = StarlingsFilledButton(frame: .zero)
    private let declineButton = NSButton(title: String(localized: "Decline"), target: nil, action: nil)
    private let moreButton = NSButton(title: "", target: nil, action: nil)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: self).cgColor
        layer?.cornerRadius = 12
        layer?.cornerCurve = .continuous
        layer?.borderWidth = 1
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        // It sits over video, so it needs an edge of its own to read against.
        shadow = NSShadow()
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.35
        layer?.shadowRadius = 12
        layer?.shadowOffset = CGSize(width: 0, height: -2)

        nameLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        nameLabel.textColor = StarlingsColors.primaryText
        nameLabel.usesSingleLineMode = true
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        admitButton.translatesAutoresizingMaskIntoConstraints = false
        admitButton.apply(
            .accent,
            title: String(localized: "Admit"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold),
            cornerRadius: 7,
            height: 28
        )
        admitButton.target = self
        admitButton.action = #selector(admitPressed)

        declineButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(declineButton)
        declineButton.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        declineButton.contentTintColor = StarlingsColors.secondaryText
        declineButton.target = self
        declineButton.action = #selector(declinePressed)

        moreButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(moreButton)
        moreButton.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        moreButton.contentTintColor = StarlingsColors.secondaryText
        moreButton.target = self
        moreButton.action = #selector(morePressed)
        moreButton.isHidden = true

        let row = NSStackView(views: [nameLabel, moreButton, declineButton, admitButton])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        row.pinToEdges(of: self, insets: NSEdgeInsets(top: 10, left: 14, bottom: 10, right: 10))
        // The banner never sets the stage's width: a long name truncates.
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// `waiting` is the whole queue; the banner speaks for its first entry.
    func configure(name: String, waiting: Int, busy: Bool) {
        nameLabel.stringValue = String(localized: "\(name) is waiting")
        setAccessibilityLabel(String(localized: "\(name) is waiting to be admitted"))
        let others = max(0, waiting - 1)
        moreButton.isHidden = others == 0
        moreButton.title = String(localized: "+\(others) more")
        // A decision already in flight must not be sent twice.
        admitButton.isEnabled = !busy
        declineButton.isEnabled = !busy
    }

    @objc private func admitPressed() { onAdmit?() }
    @objc private func declinePressed() { onDecline?() }
    @objc private func morePressed() { onShowQueue?() }
}
