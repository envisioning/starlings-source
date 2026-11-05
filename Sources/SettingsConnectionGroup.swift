import AppKit

/// What a connection row says and which of its two actions it offers.
enum SettingsConnectionState {
    /// Nothing to connect on yet (signed out): the row explains, no buttons.
    case unavailable(title: String, detail: String)
    /// Connect sits in the row. `busy` while the link is in flight.
    case disconnected(title: String, detail: String, busy: Bool = false)
    /// Disconnect sits in the row; Connect folds away.
    case connected(title: String, detail: String, busy: Bool = false)
    /// Connected, but the token no longer covers what the page needs: the
    /// row stays live and Connect comes back under a new name.
    case stale(title: String, detail: String, reconnectTitle: String)
}

/// One status row and its actions. Connect, reconnect, and disconnect all use
/// the same trailing slot, so the action stays with the connection it changes.
@MainActor
final class SettingsConnectionGroup: NSView {
    let row: SettingsInfoRow
    let connectButton: StarlingsFilledButton
    let disconnectButton = NSButton(title: "", target: nil, action: nil)
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?

    /// What the connect button says; the account row names its workspace here.
    var connectTitle: String
    private let busyTitle: String
    private let connectFont = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
    private let actions = NSStackView()

    init(
        title: String,
        connectTitle: String,
        disconnectTitle: String,
        busyTitle: String = String(localized: "Connecting…")
    ) {
        self.connectTitle = connectTitle
        self.busyTitle = busyTitle
        row = SettingsInfoRow(title: title, showsStatusDot: true)
        connectButton = StarlingsFilledButton(style: .accent, title: connectTitle)
        super.init(frame: .zero)

        connectButton.apply(.accent, title: connectTitle, font: connectFont)
        connectButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
        connectButton.target = self
        connectButton.action = #selector(connect)
        SettingsChrome.applySecondaryButton(disconnectButton, title: disconnectTitle)
        disconnectButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
        disconnectButton.target = self
        disconnectButton.action = #selector(disconnect)

        actions.addArrangedSubview(connectButton)
        actions.addArrangedSubview(disconnectButton)
        actions.orientation = .horizontal
        actions.spacing = 8
        actions.alignment = .centerY
        row.setTrailing(actions)
        addSubview(row)
        row.pinToEdges(of: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func apply(_ state: SettingsConnectionState) {
        switch state {
        case let .unavailable(title, detail):
            row.setTitle(title)
            row.update(state: .unknown, detail: detail)
            connectButton.isHidden = true
            disconnectButton.isHidden = true
        case let .disconnected(title, detail, busy):
            row.setTitle(title)
            row.update(state: .unknown, detail: detail)
            connectButton.apply(.accent, title: busy ? busyTitle : connectTitle, font: connectFont)
            connectButton.isEnabled = !busy
            connectButton.isHidden = false
            disconnectButton.isHidden = true
        case let .connected(title, detail, busy):
            row.setTitle(title)
            row.update(state: .allowed, detail: detail)
            connectButton.isHidden = true
            disconnectButton.isHidden = false
            disconnectButton.isEnabled = !busy
        case let .stale(title, detail, reconnectTitle):
            row.setTitle(title)
            row.update(state: .allowed, detail: detail)
            connectButton.apply(.accent, title: reconnectTitle, font: connectFont)
            connectButton.isEnabled = true
            connectButton.isHidden = false
            disconnectButton.isHidden = false
            disconnectButton.isEnabled = true
        }
    }

    @objc private func connect() {
        onConnect?()
    }

    @objc private func disconnect() {
        onDisconnect?()
    }
}
