import AppKit
import AVFoundation

/// Zoom-style Video settings: live preview, camera options, appearance toggles,
/// and a virtual-background grid — wired to macOS system effects + Meet plates.
@MainActor
final class VideoSettingsPageView: NSView {
    private let devices: MediaDeviceService
    private let preview = CameraPreviewView()
    private let cameraPicker = SettingsDevicePickerRow(title: String(localized: "Camera"))
    private let mirrorCheckbox = NSButton(
        checkboxWithTitle: "Mirror my video preview",
        target: nil,
        action: nil
    )
    private let openCameraRow = SettingsActionRow(title: String(localized: "Open Camera settings"))
    private let portraitRow = SettingsToggleRow(
        title: String(localized: "Portrait blur"),
        detail: String(localized: "macOS Portrait effect"),
        symbolName: "person.crop.circle"
    )
    private let studioLightRow = SettingsToggleRow(
        title: String(localized: "Portrait lighting"),
        detail: String(localized: "macOS Studio Light"),
        symbolName: "light.max"
    )
    private let centerStageRow = SettingsToggleRow(
        title: String(localized: "Auto-framing"),
        detail: String(localized: "macOS Center Stage"),
        symbolName: "person.crop.rectangle"
    )
    private let openEffectsRow = SettingsActionRow(title: String(localized: "Open Video Effects…"))
    private let contentStack = NSStackView()
    private var backgroundTiles: [BackgroundOptionTile] = []
    private var selectedBackground: MeetingBackgroundEffect = .none
    private var isApplyingCenterStage = false
    private var isActive = false
    private var publishedPreviewDeviceID: String?
    private var hasPublishedPreviewDeviceID = false
    private let monitor = SystemVideoEffectsMonitor()
    private var cameraPrivacyGroup: SettingsGroupView?

    var onOpenCameraPrivacy: (() -> Void)?

    init(devices: MediaDeviceService) {
        self.devices = devices
        super.init(frame: .zero)
        buildInterface()
        monitor.onChange = { [weak self] snapshot in
            self?.applyEffects(snapshot)
        }
        cameraPicker.onSelectionChanged = { [weak self] id in
            MediaDevicePreferences.preferredCameraID = id
            self?.refreshPreviewIfActive()
        }
        reloadCameras()
        monitor.refresh()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setActive(_ active: Bool) {
        guard isActive != active else {
            if active { refresh() }
            return
        }
        isActive = active
        if active {
            refresh()
            startPreview()
        } else {
            hasPublishedPreviewDeviceID = false
            publishedPreviewDeviceID = nil
            preview.stop()
        }
    }

    func refresh() {
        Task {
            await WorkspaceBackgrounds.refresh()
            for tile in backgroundTiles { tile.refreshThumbnail() }
            selectBackground(WorkspaceBackgrounds.preferredEffect, applyPreview: false)
            if isActive { preview.setBackgroundEffect(selectedBackground) }
        }
        monitor.refresh()
        reloadCameras()
        updateCameraPrivacyVisibility()
        if isActive {
            refreshPreviewIfActive()
        }
    }

    // MARK: - Layout

    private func buildInterface() {
        wantsLayer = true

        preview.layer?.cornerRadius = 12
        preview.translatesAutoresizingMaskIntoConstraints = false
        preview.heightAnchor.constraint(equalTo: preview.widthAnchor, multiplier: 9.0 / 16.0).isActive = true

        let videoSection = makeVideoSection()
        let appearanceSection = makeAppearanceSection()
        let backgroundsSection = makeBackgroundsSection()

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 22
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.addArrangedSubview(preview)
        contentStack.addArrangedSubview(videoSection)
        contentStack.addArrangedSubview(appearanceSection)
        contentStack.addArrangedSubview(backgroundsSection)

        addSubview(contentStack)
        contentStack.pinToEdges(of: self)

        NSLayoutConstraint.activate([
            preview.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            videoSection.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            appearanceSection.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            backgroundsSection.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
        ])

        contentStack.setCustomSpacing(18, after: preview)
    }

    private func makeSection(title: String, content: NSView, footer: String? = nil) -> NSView {
        let header = NSTextField(labelWithString: title)
        header.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        header.textColor = StarlingsColors.primaryText

        let stack = NSStackView(views: [header, content])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10

        if let footer {
            let label = StarlingsTypography.wrappingLabel(footer)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            label.textColor = StarlingsColors.secondaryText
            stack.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        content.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        header.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    private func makeVideoSection() -> NSView {
        mirrorCheckbox.target = self
        mirrorCheckbox.action = #selector(mirrorChanged)
        mirrorCheckbox.state = .on
        mirrorCheckbox.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        mirrorCheckbox.applyMeetCheckboxStyle()
        mirrorCheckbox.applyMeetHoverLift(cornerRadius: 5)
        let mirrorWrap = NSView()
        mirrorWrap.addSubview(mirrorCheckbox)
        mirrorCheckbox.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            mirrorCheckbox.leadingAnchor.constraint(equalTo: mirrorWrap.leadingAnchor, constant: 14),
            mirrorCheckbox.trailingAnchor.constraint(lessThanOrEqualTo: mirrorWrap.trailingAnchor, constant: -14),
            mirrorCheckbox.topAnchor.constraint(equalTo: mirrorWrap.topAnchor, constant: 10),
            mirrorCheckbox.bottomAnchor.constraint(equalTo: mirrorWrap.bottomAnchor, constant: -10),
        ])

        let cameraGroup = SettingsGroupView(rows: [cameraPicker, mirrorWrap])
        openCameraRow.onClick = { [weak self] in self?.onOpenCameraPrivacy?() }
        let privacy = SettingsGroupView(rows: [openCameraRow])
        cameraPrivacyGroup = privacy

        let stack = NSStackView(views: [cameraGroup, privacy])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        cameraGroup.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        privacy.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        return makeSection(
            title: String(localized: "Video"),
            content: stack,
            footer: String(localized: "Starlings never records video.")
        )
    }

    private func makeAppearanceSection() -> NSView {
        portraitRow.onChange = { [weak self] _ in
            self?.openSystemEffectsSheet()
        }
        studioLightRow.onChange = { [weak self] _ in
            self?.openSystemEffectsSheet()
        }
        centerStageRow.onChange = { [weak self] enabled in
            self?.applyCenterStage(enabled)
        }
        openEffectsRow.onClick = { SystemVideoEffects.showVideoEffectsUI() }

        let toggles = SettingsGroupView(rows: [portraitRow, studioLightRow, centerStageRow])
        let actions = SettingsGroupView(rows: [openEffectsRow])

        let stack = NSStackView(views: [toggles, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        toggles.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        actions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        return makeSection(
            title: String(localized: "Appearance"),
            content: stack,
            footer: String(localized: "Portrait and lighting are macOS controls.")
        )
    }

    private func makeBackgroundsSection() -> NSView {
        var options: [(MeetingBackgroundEffect, String)] = [
            (.none, "None"),
            (.blur, "Blur"),
        ]
        options.append((.workspaceImage, String(localized: "Workspace picture")))
        options += BackgroundChoice.all.map { (MeetingBackgroundEffect.generated($0), $0.displayName) }

        backgroundTiles.removeAll()
        let tiles: [NSView] = options.map { option in
            let tile = BackgroundOptionTile(effect: option.0, title: option.1)
            tile.onSelect = { [weak self] effect in
                self?.selectBackground(effect)
            }
            backgroundTiles.append(tile)
            return tile
        }

        let row = NSStackView()
        row.orientation = .vertical
        row.spacing = 10
        row.alignment = .leading
        for start in stride(from: 0, to: tiles.count, by: 3) {
            let group = NSStackView(views: Array(tiles[start..<min(start + 3, tiles.count)]))
            group.orientation = .horizontal
            group.spacing = 10
            group.distribution = .fillEqually
            row.addArrangedSubview(group)
            group.widthAnchor.constraint(equalTo: row.widthAnchor).isActive = true
        }

        selectBackground(WorkspaceBackgrounds.preferredEffect, applyPreview: false)

        return makeSection(
            title: String(localized: "Virtual backgrounds"),
            content: row,
            footer: String(localized: "Continuity Camera backgrounds live under Open Video Effects…")
        )
    }

    // MARK: - Actions

    @objc private func mirrorChanged() {
        preview.mirrorsPreview = mirrorCheckbox.state == .on
    }

    private func openSystemEffectsSheet() {
        SystemVideoEffects.showVideoEffectsUI()
        monitor.refresh()
    }

    private func applyCenterStage(_ enabled: Bool) {
        isApplyingCenterStage = true
        defer { isApplyingCenterStage = false }
        let applied = SystemVideoEffects.setCenterStageEnabled(enabled)
        centerStageRow.isOn = applied
        monitor.refresh()
    }

    private func applyEffects(_ snapshot: SystemVideoEffectsSnapshot) {
        portraitRow.isOn = snapshot.portraitEnabled
        studioLightRow.isOn = snapshot.studioLightEnabled
        if !isApplyingCenterStage {
            centerStageRow.isOn = snapshot.centerStageEnabled
        }
        portraitRow.setDetail(snapshot.portraitEnabled ? String(localized: "On") : String(localized: "Off — opens Video Effects"))
        studioLightRow.setDetail(snapshot.studioLightEnabled ? String(localized: "On") : String(localized: "Off — opens Video Effects"))
        centerStageRow.setDetail(snapshot.centerStageEnabled ? String(localized: "On — framing follows you") : String(localized: "Off"))
    }

    private func selectBackground(_ effect: MeetingBackgroundEffect, applyPreview: Bool = true) {
        selectedBackground = effect.resolved
        if applyPreview { WorkspaceBackgrounds.remember(effect) }
        for tile in backgroundTiles {
            tile.isSelected = tile.effect == effect
        }
        if applyPreview {
            preview.setBackgroundEffect(effect)
        }
    }

    private func reloadCameras() {
        cameraPicker.reload(
            devices: devices.cameras,
            symbolName: "video.fill",
            selectedID: MediaDevicePreferences.resolveCameraID(from: devices.cameras)
        )
    }

    private func selectedCameraID() -> String? {
        MediaDevicePreferences.resolveCameraID(from: devices.cameras)
    }

    private func startPreview() {
        Task {
            let permissions = await devices.requestPermissions()
            updateCameraPrivacyVisibility(camera: permissions.camera)
            guard isActive else { return }
            preview.mirrorsPreview = mirrorCheckbox.state == .on
            preview.setBackgroundEffect(selectedBackground)
            publishPreview(deviceID: permissions.camera == .allowed ? selectedCameraID() : nil)
        }
    }

    private func refreshPreviewIfActive() {
        guard isActive else { return }
        let deviceID = devices.cameraPermission == .allowed ? selectedCameraID() : nil
        publishPreview(deviceID: deviceID)
    }

    private func publishPreview(deviceID: String?) {
        if hasPublishedPreviewDeviceID, publishedPreviewDeviceID == deviceID {
            preview.setBackgroundEffect(selectedBackground)
            return
        }
        hasPublishedPreviewDeviceID = true
        publishedPreviewDeviceID = deviceID
        preview.setBackgroundEffect(selectedBackground)
        preview.show(deviceID: deviceID)
    }

    private func updateCameraPrivacyVisibility(camera: PermissionState? = nil) {
        let state = camera ?? devices.cameraPermission
        let needsPrivacy = state != .allowed
        openCameraRow.isHidden = !needsPrivacy
        cameraPrivacyGroup?.setRows(needsPrivacy ? [openCameraRow] : [])
        cameraPrivacyGroup?.isHidden = !needsPrivacy
    }
}

// MARK: - Background tile

@MainActor
private final class BackgroundOptionTile: NSView {
    let effect: MeetingBackgroundEffect
    var onSelect: ((MeetingBackgroundEffect) -> Void)?

    var isSelected: Bool = false {
        didSet { applySelection() }
    }

    private var isHovered = false
    private let preview = NSView()
    private let imageView = NSImageView()
    private let titleLabel: NSTextField

    init(effect: MeetingBackgroundEffect, title: String) {
        self.effect = effect
        titleLabel = NSTextField(labelWithString: title)
        super.init(frame: .zero)

        preview.wantsLayer = true
        preview.layer?.cornerRadius = 8
        preview.layer?.cornerCurve = .continuous
        preview.layer?.masksToBounds = true
        preview.layer?.borderWidth = 1.5
        preview.translatesAutoresizingMaskIntoConstraints = false
        addSubview(preview)

        imageView.imageScaling = .scaleAxesIndependently
        imageView.image = Self.thumbnail(for: effect)
        isHidden = effect == .workspaceImage && !WorkspaceBackgrounds.hasPicture
        imageView.translatesAutoresizingMaskIntoConstraints = false
        preview.addSubview(imageView)

        titleLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        titleLabel.alignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(titleLabel)

        NSLayoutConstraint.activate([
            preview.leadingAnchor.constraint(equalTo: leadingAnchor),
            preview.trailingAnchor.constraint(equalTo: trailingAnchor),
            preview.topAnchor.constraint(equalTo: topAnchor),
            preview.heightAnchor.constraint(equalTo: preview.widthAnchor, multiplier: 9.0 / 16.0),

            imageView.leadingAnchor.constraint(equalTo: preview.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: preview.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: preview.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: preview.bottomAnchor),

            titleLabel.topAnchor.constraint(equalTo: preview.bottomAnchor, constant: 6),
            titleLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            titleLabel.trailingAnchor.constraint(equalTo: trailingAnchor),
            titleLabel.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        applySelection()

        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.applySelection()
        }

        let click = NSClickGestureRecognizer(target: self, action: #selector(clicked))
        addGestureRecognizer(click)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The thumbnail fills the tile edge to edge, so there is no surface behind it
    /// to lift — the frame answers the pointer instead, the same exception inputs
    /// make. Selection still owns the accent.
    private func applySelection() {
        preview.layer?.borderWidth = isSelected ? 2 : 1.5
        let resting = isHovered ? StarlingsColors.borderHover : StarlingsColors.border
        preview.layer?.borderColor = StarlingsColors.resolved(
            isSelected ? StarlingsColors.accent : resting,
            for: preview
        ).cgColor
        titleLabel.textColor = isSelected || isHovered ? StarlingsColors.primaryText : StarlingsColors.secondaryText
    }

    func refreshThumbnail() {
        imageView.image = Self.thumbnail(for: effect)
        isHidden = effect == .workspaceImage && !WorkspaceBackgrounds.hasPicture
        if case .generated(let choice) = effect { titleLabel.stringValue = choice.displayName }
    }

    @objc private func clicked() {
        onSelect?(effect)
    }

    private static func thumbnail(for effect: MeetingBackgroundEffect) -> NSImage {
        let size = NSSize(width: 160, height: 90)
        switch effect {
        case .none:
            return noneThumbnail(size: size)
        case .blur:
            return blurThumbnail(size: size)
        case .generated(let choice):
            if let cgImage = BackgroundGalleryRenderer.image(
                choice: choice,
                seed: 42,
                width: Int(size.width),
                height: Int(size.height)
            ) {
                return NSImage(cgImage: cgImage, size: size)
            }
            return solidThumbnail(color: NSColor(cgColor: choice.base) ?? .black, size: size)
        case .workspaceImage:
            return WorkspaceBackgrounds.image.map { NSImage(cgImage: $0, size: size) } ?? photoThumbnail(size: size)
        case .customImage:
            // Not one of this row's quick tiles (only None/Blur/the gallery
            // entries are) — the picture itself lives behind the control-bar
            // background button (`applyBackgroundEffectAppearance`). This
            // case exists so the switch stays exhaustive if that ever
            // changes.
            return photoThumbnail(size: size)
        }
    }

    private static func photoThumbnail(size: NSSize) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()
        let rect = NSRect(origin: .zero, size: size)
        StarlingsColors.elevated.setFill()
        rect.fill()
        let symbolSize = min(size.width, size.height) * 0.34
        if let symbol = NSImage(systemSymbolName: "photo.fill", accessibilityDescription: String(localized: "Your own background image"))?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: symbolSize, weight: .regular)) {
            let symbolRect = NSRect(
                x: (size.width - symbolSize) / 2,
                y: (size.height - symbolSize) / 2,
                width: symbolSize,
                height: symbolSize
            )
            // Same recolour-a-template trick as `StarlingsSurfaceSwitcher.liveBadged`:
            // fill the target rect with the ink, then cut it to the symbol's
            // own alpha with `destinationIn`.
            StarlingsColors.secondaryText.withAlphaComponent(0.7).setFill()
            symbolRect.fill()
            symbol.draw(in: symbolRect, from: .zero, operation: .destinationIn, fraction: 1)
        }
        image.unlockFocus()
        return image
    }

    private static func noneThumbnail(size: NSSize) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()
        let rect = NSRect(origin: .zero, size: size)
        StarlingsColors.elevated.setFill()
        rect.fill()

        // Subtle slash so “off” reads without repeating the caption.
        let inset = NSInsetRect(rect, size.width * 0.22, size.height * 0.28)
        let path = NSBezierPath()
        path.move(to: NSPoint(x: inset.minX, y: inset.minY))
        path.line(to: NSPoint(x: inset.maxX, y: inset.maxY))
        path.lineWidth = 2
        path.lineCapStyle = .round
        StarlingsColors.secondaryText.withAlphaComponent(0.55).setStroke()
        path.stroke()

        let frame = NSBezierPath(roundedRect: inset, xRadius: 4, yRadius: 4)
        frame.lineWidth = 1.5
        frame.stroke()
        image.unlockFocus()
        return image
    }

    private static func solidThumbnail(color: NSColor, size: NSSize) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()
        color.setFill()
        NSRect(origin: .zero, size: size).fill()
        image.unlockFocus()
        return image
    }

    private static func blurThumbnail(size: NSSize) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()
        let rect = NSRect(origin: .zero, size: size)
        NSColor(srgbRed: 0.28, green: 0.32, blue: 0.38, alpha: 1).setFill()
        rect.fill()
        NSColor(srgbRed: 0.52, green: 0.58, blue: 0.66, alpha: 0.5).setFill()
        NSBezierPath(ovalIn: NSRect(
            x: size.width * 0.12,
            y: size.height * 0.08,
            width: size.width * 0.52,
            height: size.height * 0.72
        )).fill()
        NSColor(srgbRed: 0.22, green: 0.24, blue: 0.30, alpha: 0.55).setFill()
        NSBezierPath(ovalIn: NSRect(
            x: size.width * 0.42,
            y: size.height * 0.22,
            width: size.width * 0.48,
            height: size.height * 0.62
        )).fill()
        image.unlockFocus()
        return image
    }
}
