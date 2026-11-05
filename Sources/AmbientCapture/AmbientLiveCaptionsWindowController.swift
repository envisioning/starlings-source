import AppKit

/// The live captions panel: what the recording hears, as it
/// hears it. Opens from the menu bar while an ambient capture runs; closing
/// it changes nothing about the recording. Stop stays in the menu bar.
///
/// Header: the recording state the menu bar shows, then one line per track
/// — the owner's microphone and the call — saying when it last heard words,
/// so a dead track is obvious within a minute. Body: the lines, newest at
/// the bottom, auto-scrolling until the reader scrolls up.
@MainActor
final class AmbientLiveCaptionsWindowController: NSWindowController, NSWindowDelegate {
    private let controller: AmbientCaptureController
    private let model: AmbientLiveCaptionsModel

    private let stateLabel = NSTextField(labelWithString: "")
    private let micLabel = NSTextField(labelWithString: "")
    private let systemLabel = NSTextField(labelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "")
    private let text = NSTextView()
    private let scroll = NSScrollView()
    private var clock: Timer?
    private var renderedCount = 0
    private var followsTail = true

    init(controller: AmbientCaptureController) {
        self.controller = controller
        model = controller.liveCaptions
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 520),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: true
        )
        panel.title = String(localized: "Live captions")
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = StarlingsColors.panel
        panel.minSize = NSSize(width: 320, height: 280)
        panel.animationBehavior = .utilityWindow
        super.init(window: panel)
        panel.delegate = self
        shouldCascadeWindows = false
        windowFrameAutosaveName = "AmbientLiveCaptionsPanel"
        panel.contentView = buildContent()
        model.onChange = { [weak self] in self?.render() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        guard let panel = window else { return }
        if !panel.isVisible, !panel.setFrameUsingName(windowFrameAutosaveName) {
            panel.center()
        }
        renderedCount = 0
        followsTail = true
        render()
        renderHeader()
        startClock()
        panel.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        clock?.invalidate()
        clock = nil
    }

    // MARK: - Layout

    private func buildContent() -> NSView {
        for label in [stateLabel, micLabel, systemLabel, statusLabel] {
            label.font = StarlingsTypography.sectionLabelFont
            label.textColor = StarlingsColors.secondaryText
            label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        stateLabel.textColor = StarlingsColors.primaryText

        text.isEditable = false
        text.drawsBackground = false
        text.textColor = StarlingsColors.secondaryText
        text.font = .systemFont(ofSize: StarlingsTypography.scaled(14))
        text.textContainerInset = NSSize(width: 0, height: 8)
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.selectedTextAttributes = StarlingsColors.textSelectionAttributes

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.documentView = text
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(
            self, selector: #selector(scrolled(_:)), name: NSView.boundsDidChangeNotification, object: scroll.contentView
        )

        let header = NSStackView(views: [stateLabel, micLabel, systemLabel, statusLabel])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 4
        header.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        root.addSubview(header)
        root.addSubview(scroll)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
        ])
        return root
    }

    // MARK: - Header

    private func startClock() {
        clock?.invalidate()
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.renderHeader() }
        }
    }

    private func renderHeader() {
        let now = Date()
        switch controller.state {
        case .recording(let since, let warnings):
            var line = "RECORDING · \(Self.clock(Int(now.timeIntervalSince(since))))"
            if let warning = warnings.first { line += " · \(warning.text)" }
            stateLabel.stringValue = line
            stateLabel.textColor = warnings.isEmpty ? StarlingsColors.primaryText : NSColor.systemOrange
        case .alarm(let alarm):
            stateLabel.stringValue = alarm
            stateLabel.textColor = StarlingsSemanticColors.dangerMark
        case .idle, .unsupported:
            stateLabel.stringValue = String(localized: "NOT RECORDING")
            stateLabel.textColor = StarlingsColors.secondaryText
        }
        let recording = controller.isRecording
        micLabel.stringValue = Self.trackLine("YOU", model.mic, now: now, recording: recording)
        systemLabel.stringValue = Self.trackLine("CALL", model.system, now: now, recording: recording)
        micLabel.textColor = Self.trackColor(model.mic, now: now, recording: recording)
        systemLabel.textColor = Self.trackColor(model.system, now: now, recording: recording)
        statusLabel.stringValue = model.status.uppercased()
        statusLabel.isHidden = model.status.isEmpty
    }

    /// "YOU · WORDS 3S AGO", "CALL · AUDIO, NO WORDS YET", "CALL · SILENT 1:20".
    private static func trackLine(_ name: String, _ track: AmbientCaptionTrackHealth, now: Date, recording: Bool) -> String {
        guard recording else { return name }
        if let words = track.lastWordsAt {
            return String(localized: "\(name) · WORDS \(ago(now.timeIntervalSince(words)))")
        }
        if let audio = track.lastAudioAt, now.timeIntervalSince(audio) < 2 {
            return String(localized: "\(name) · AUDIO, NO WORDS YET")
        }
        if let audio = track.lastAudioAt {
            return String(localized: "\(name) · SILENT \(ago(now.timeIntervalSince(audio)))")
        }
        return String(localized: "\(name) · NOTHING HEARD")
    }

    private static func trackColor(_ track: AmbientCaptionTrackHealth, now: Date, recording: Bool) -> NSColor {
        guard recording else { return StarlingsColors.secondaryText }
        let lastHeard = track.lastAudioAt ?? .distantPast
        return now.timeIntervalSince(lastHeard) >= 60 ? NSColor.systemOrange : StarlingsColors.secondaryText
    }

    private static func ago(_ seconds: TimeInterval) -> String {
        let whole = max(0, Int(seconds))
        return whole < 60 ? String(localized: "\(whole)S AGO") : String(localized: "\(clock(whole)) AGO")
    }

    private static func clock(_ seconds: Int) -> String {
        let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    // MARK: - Lines

    @objc private func scrolled(_ notification: Notification) {
        // Reading back pauses the auto-scroll; returning to the bottom
        // resumes it.
        let visible = scroll.contentView.bounds
        let height = text.frame.height
        followsTail = visible.maxY >= height - 24
    }

    private func render() {
        guard window?.isVisible ?? false else { return }
        let lines = model.lines
        // The model resets on a new recording; anything else is append-only.
        if lines.count < renderedCount || renderedCount == 0 {
            text.textStorage?.setAttributedString(Self.attributed(lines))
            renderedCount = lines.count
        } else if lines.count > renderedCount {
            let fresh = Array(lines[renderedCount...])
            let addition = Self.attributed(fresh, leading: renderedCount > 0)
            text.textStorage?.append(addition)
            renderedCount = lines.count
        }
        if lines.isEmpty {
            text.textStorage?.setAttributedString(NSAttributedString(
                string: controller.isRecording ? String(localized: "Listening…") : String(localized: "Nothing yet. Captions appear here while a meeting is being recorded."),
                attributes: [.font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(14)), .foregroundColor: StarlingsColors.secondaryText]
            ))
            renderedCount = 0
        }
        renderHeader()
        if followsTail { text.scrollToEndOfDocument(nil) }
    }

    private static func attributed(_ lines: [AmbientCaptionLine], leading: Bool = false) -> NSAttributedString {
        let body = NSFont.systemFont(ofSize: StarlingsTypography.scaled(14))
        let output = NSMutableAttributedString()
        for (index, line) in lines.enumerated() {
            if index > 0 || leading {
                output.append(NSAttributedString(string: "\n\n", attributes: [.font: body]))
            }
            let name: String
            let nameColor: NSColor
            switch (line.lane, line.speaker) {
            case (.mic, let owner): name = owner ?? "You"; nameColor = StarlingsColors.accentMark
            case (.system, let reported?): name = reported; nameColor = StarlingsColors.primaryText
            case (.system, nil): name = "Call"; nameColor = StarlingsColors.secondaryText
            }
            output.append(NSAttributedString(
                string: "\(name)  ",
                attributes: [.font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold), .foregroundColor: nameColor]
            ))
            output.append(NSAttributedString(
                string: clock(Int(line.at)) + "\n",
                attributes: [.font: StarlingsTypography.sectionLabelFont, .foregroundColor: StarlingsColors.secondaryText]
            ))
            output.append(NSAttributedString(
                string: line.text,
                attributes: [.font: body, .foregroundColor: StarlingsColors.primaryText]
            ))
        }
        return output
    }
}
