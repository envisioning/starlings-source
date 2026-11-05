import AVFoundation
import AppKit
import Foundation

struct SystemVideoEffectsSnapshot: Equatable, Sendable {
    var centerStageEnabled: Bool
    var portraitEnabled: Bool
    var studioLightEnabled: Bool
    var backgroundReplacementEnabled: Bool

    static var current: SystemVideoEffectsSnapshot {
        SystemVideoEffectsSnapshot(
            centerStageEnabled: AVCaptureDevice.isCenterStageEnabled,
            portraitEnabled: AVCaptureDevice.isPortraitEffectEnabled,
            studioLightEnabled: AVCaptureDevice.isStudioLightEnabled,
            backgroundReplacementEnabled: {
                if #available(macOS 15.0, *) {
                    AVCaptureDevice.isBackgroundReplacementEnabled
                } else {
                    false
                }
            }()
        )
    }

    var portraitDetail: String {
        portraitEnabled ? String(localized: "On — background blur via macOS Portrait") : String(localized: "Off — open Video Effects to blur")
    }

    var studioLightDetail: String {
        studioLightEnabled ? String(localized: "On") : String(localized: "Off — open Video Effects to enable")
    }

    var backgroundDetail: String {
        if #available(macOS 15.0, *) {
            backgroundReplacementEnabled
                ? String(localized: "On — image or gradient from Video Effects")
                : "Off — open Video Effects to set a background"
        } else {
            "Requires macOS 15 or later"
        }
    }

    var centerStageDetail: String {
        centerStageEnabled ? String(localized: "On — framing follows you") : String(localized: "Off")
    }
}

enum SystemVideoEffects {
    static func showVideoEffectsUI() {
        AVCaptureDevice.showSystemUserInterface(.videoEffects)
    }

    @discardableResult
    static func setCenterStageEnabled(_ enabled: Bool) -> Bool {
        AVCaptureDevice.centerStageControlMode = .cooperative
        AVCaptureDevice.isCenterStageEnabled = enabled
        return AVCaptureDevice.isCenterStageEnabled
    }
}

/// KVO bridge for class-level `AVCaptureDevice` video-effect flags.
@MainActor
final class SystemVideoEffectsMonitor {
    var onChange: ((SystemVideoEffectsSnapshot) -> Void)?

    private let observer = SystemVideoEffectsKVOObserver()

    init() {
        observer.onChange = { [weak self] in
            Task { @MainActor in
                self?.publish()
            }
        }
        observer.start()
    }

    func refresh() {
        publish()
    }

    private func publish() {
        onChange?(SystemVideoEffectsSnapshot.current)
    }
}

private final class SystemVideoEffectsKVOObserver: NSObject {
    var onChange: (() -> Void)?

    private var observedKeyPaths: [String] = []

    func start() {
        guard observedKeyPaths.isEmpty else { return }
        var keyPaths = [
            "centerStageEnabled",
            "portraitEffectEnabled",
            "studioLightEnabled",
        ]
        if #available(macOS 15.0, *) {
            keyPaths.append("backgroundReplacementEnabled")
        }
        for keyPath in keyPaths {
            AVCaptureDevice.self.addObserver(self, forKeyPath: keyPath, options: [.new], context: nil)
        }
        observedKeyPaths = keyPaths
    }

    func stop() {
        guard !observedKeyPaths.isEmpty else { return }
        for keyPath in observedKeyPaths {
            AVCaptureDevice.self.removeObserver(self, forKeyPath: keyPath)
        }
        observedKeyPaths = []
    }

    deinit {
        stop()
    }

    override func observeValue(
        forKeyPath keyPath: String?,
        of object: Any?,
        change: [NSKeyValueChangeKey: Any]?,
        context: UnsafeMutableRawPointer?
    ) {
        onChange?()
    }
}

@MainActor
final class VideoEffectsControlsView: NSView {
    enum Style {
        case full
        case compact
    }

    private let style: Style
    private let portraitRow = SettingsInfoRow(title: String(localized: "Portrait (blur)"))
    private let studioLightRow = SettingsInfoRow(title: String(localized: "Studio Light"))
    private let backgroundRow = SettingsInfoRow(title: String(localized: "Background"))
    private let centerStageRow = SettingsToggleRow(title: String(localized: "Center Stage"))
    private let summaryLabel = StarlingsTypography.wrappingLabel("")
    private let centerStageButton = NSButton(
        checkboxWithTitle: "Center Stage",
        target: nil,
        action: nil
    )
    private let openEffectsButton = NSButton(title: String(localized: "Open Video Effects…"), target: nil, action: nil)
    private let openMicModesButton = NSButton(title: String(localized: "Open Mic Modes…"), target: nil, action: nil)
    private let openEffectsRow = SettingsActionRow(title: String(localized: "Open Video Effects…"))
    private let openMicModesRow = SettingsActionRow(title: String(localized: "Open Mic Modes…"))
    private var actionsGroup: SettingsGroupView?
    private let monitor = SystemVideoEffectsMonitor()
    private var isApplyingCenterStage = false

    var showsMicrophoneModesButton = true {
        didSet { rebuildActionsGroup() }
    }

    init(style: Style = .full) {
        self.style = style
        super.init(frame: .zero)
        buildInterface()
        monitor.onChange = { [weak self] snapshot in
            self?.apply(snapshot)
        }
        monitor.refresh()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func refresh() {
        monitor.refresh()
    }

    private func buildInterface() {
        if style == .full {
            buildFullInterface()
        } else {
            buildCompactInterface()
        }
    }

    private func buildFullInterface() {
        centerStageRow.onChange = { [weak self] enabled in
            self?.applyCenterStage(enabled)
        }
        openEffectsRow.onClick = { [weak self] in
            self?.openVideoEffects()
        }
        openMicModesRow.onClick = { [weak self] in
            self?.openMicrophoneModes()
        }

        let statusGroup = SettingsGroupView(rows: [
            portraitRow,
            studioLightRow,
            backgroundRow,
            centerStageRow,
        ])
        let footer = StarlingsTypography.wrappingLabel(String(localized: "Portrait, Studio Light, and backgrounds are macOS controls."))
        footer.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        footer.textColor = StarlingsColors.secondaryText

        let actions = SettingsGroupView(rows: actionRows())
        actionsGroup = actions

        let stack = NSStackView(views: [statusGroup, footer, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.setCustomSpacing(16, after: footer)
        addSubview(stack)
        stack.pinToEdges(of: self)
        statusGroup.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        footer.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        actions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    private func actionRows() -> [NSView] {
        var rows: [NSView] = [openEffectsRow]
        if showsMicrophoneModesButton {
            rows.append(openMicModesRow)
        }
        return rows
    }

    private func rebuildActionsGroup() {
        actionsGroup?.setRows(actionRows())
        openMicModesButton.isHidden = !showsMicrophoneModesButton
    }

    private func buildCompactInterface() {
        centerStageButton.target = self
        centerStageButton.action = #selector(centerStageCheckboxChanged)
        centerStageButton.applyMeetCheckboxStyle()
        centerStageButton.applyMeetHoverLift(cornerRadius: 5)
        summaryLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        summaryLabel.textColor = StarlingsColors.secondaryText

        openEffectsButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(openEffectsButton)
        openEffectsButton.contentTintColor = StarlingsColors.primaryText
        openEffectsButton.target = self
        openEffectsButton.action = #selector(openVideoEffects)
        openMicModesButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(openMicModesButton)
        openMicModesButton.contentTintColor = StarlingsColors.primaryText
        openMicModesButton.target = self
        openMicModesButton.action = #selector(openMicrophoneModes)
        openMicModesButton.isHidden = true

        let actions = NSStackView(views: [openEffectsButton, NSView()])
        actions.orientation = .horizontal
        actions.spacing = 8

        let stack = NSStackView(views: [summaryLabel, centerStageButton, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        addSubview(stack)
        stack.pinToEdges(of: self)
        summaryLabel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    private func apply(_ snapshot: SystemVideoEffectsSnapshot) {
        if style == .full {
            portraitRow.update(
                state: snapshot.portraitEnabled ? .allowed : .unknown,
                detail: snapshot.portraitDetail
            )
            studioLightRow.update(
                state: snapshot.studioLightEnabled ? .allowed : .unknown,
                detail: snapshot.studioLightDetail
            )
            if #available(macOS 15.0, *) {
                backgroundRow.update(
                    state: snapshot.backgroundReplacementEnabled ? .allowed : .unknown,
                    detail: snapshot.backgroundDetail
                )
            } else {
                backgroundRow.update(state: .restricted, detail: snapshot.backgroundDetail)
            }
            centerStageRow.setDetail(snapshot.centerStageDetail)
            if !isApplyingCenterStage {
                centerStageRow.isOn = snapshot.centerStageEnabled
            }
        } else {
            var parts: [String] = []
            parts.append(snapshot.portraitEnabled ? String(localized: "Portrait on") : String(localized: "Portrait off"))
            parts.append(snapshot.studioLightEnabled ? String(localized: "Studio Light on") : String(localized: "Studio Light off"))
            if #available(macOS 15.0, *) {
                parts.append(snapshot.backgroundReplacementEnabled ? String(localized: "Background on") : String(localized: "Background off"))
            }
            summaryLabel.stringValue = parts.joined(separator: " · ")
            if !isApplyingCenterStage {
                centerStageButton.state = snapshot.centerStageEnabled ? .on : .off
            }
        }
    }

    private func applyCenterStage(_ enabled: Bool) {
        isApplyingCenterStage = true
        defer { isApplyingCenterStage = false }
        let applied = SystemVideoEffects.setCenterStageEnabled(enabled)
        if style == .full {
            centerStageRow.isOn = applied
        } else {
            centerStageButton.state = applied ? .on : .off
        }
        monitor.refresh()
    }

    @objc private func centerStageCheckboxChanged() {
        applyCenterStage(centerStageButton.state == .on)
    }

    @objc private func openVideoEffects() {
        SystemVideoEffects.showVideoEffectsUI()
    }

    @objc private func openMicrophoneModes() {
        MicrophoneModes.showSystemPicker()
    }
}
