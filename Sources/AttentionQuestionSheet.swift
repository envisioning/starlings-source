import AppKit

/// Native Inbox detail; keeps the winning result visible until Close.
@MainActor
final class AttentionQuestionSheet: NSViewController {
    private let state: AttentionQuestionState
    private let api: MeetingControlAPI
    private let onResolved: () -> Void
    private var polling: Task<Void, Never>?
    private let status = NSTextField(wrappingLabelWithString: "")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private var choices: [NSButton] = []
    private let submit = NSButton(title: String(localized: "Submit answer"), target: nil, action: nil)
    private let dismissButton = NSButton(title: String(localized: "Dismiss"), target: nil, action: nil)
    private let closeButton = NSButton(title: String(localized: "Close"), target: nil, action: nil)

    init(request: AttentionRequest, api: MeetingControlAPI, onResolved: @escaping () -> Void) {
        state = AttentionQuestionState(request); self.api = api; self.onResolved = onResolved
        super.init(nibName: nil, bundle: nil)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private var email: String? { (try? api.ownerSessionStore.load())?.owner.email }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 560))
        let column = NSStackView(); column.orientation = .vertical; column.alignment = .leading; column.spacing = 14
        let request = state.request
        for text in [String(localized: "Question"), request.prompt, String(localized: "Asked by \(request.askedBy)"), request.subject?.title ?? request.context ?? ""] where !text.isEmpty {
            let label = NSTextField(wrappingLabelWithString: text)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(14))
            label.textColor = StarlingsColors.primaryText; label.isSelectable = true
            label.preferredMaxLayoutWidth = 420
            column.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        column.addArrangedSubview(status)
        for option in request.options {
            let button = NSButton(title: option.label, target: self, action: #selector(choose(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(option.id)
            button.bezelStyle = .regularSquare
            button.setButtonType(.pushOnPushOff)
            (button.cell as? NSButtonCell)?.wraps = true
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
            let bounds = (option.label as NSString).boundingRect(with: NSSize(width: 388, height: CGFloat.greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin], attributes: [.font: button.font!])
            button.heightAnchor.constraint(equalToConstant: max(44, ceil(bounds.height) + 24)).isActive = true
            button.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
            button.setAccessibilityLabel(option.label)
            choices.append(button); column.addArrangedSubview(button)
        }
        errorLabel.textColor = StarlingsColors.danger
        column.addArrangedSubview(errorLabel)
        submit.target = self; submit.action = #selector(answer)
        dismissButton.target = self; dismissButton.action = #selector(dismissQuestion)
        closeButton.target = self; closeButton.action = #selector(close)
        closeButton.keyEquivalent = "\u{1b}"
        let footer = NSStackView(views: [submit, dismissButton, closeButton]); footer.spacing = 10
        column.addArrangedSubview(footer)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        let document = SidebarDocumentView(); document.addSubview(column); scroll.documentView = document
        root.addSubview(scroll); scroll.pinToEdges(of: root, insets: NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20))
        column.translatesAutoresizingMaskIntoConstraints = false
        document.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            column.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            column.topAnchor.constraint(equalTo: document.topAnchor),
            column.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])
        view = root
        state.onChange = { [weak self] in self?.render() }
        render()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        polling?.cancel()
        polling = Task { [weak self] in
            guard let self else { return }
            await state.poll(read: { try await self.api.attentionRequest(id: self.state.request.id) },
                onResolved: { _ in self.onResolved() })
        }
    }
    override func viewWillDisappear() { polling?.cancel(); super.viewWillDisappear() }

    private func render() {
        let request = state.request
        let canAnswer = state.canAnswer(as: email)
        let result = request.answer.map { $0.optionLabels.joined(separator: ", ") }
        status.stringValue = request.terminalLabel.map { label in result.map { "\(label): \($0)" } ?? label }
            ?? (state.fresh && email?.lowercased() != request.recipientEmail.lowercased()
                ? String(localized: "Waiting on \(request.recipientEmail)") : "")
        status.isHidden = status.stringValue.isEmpty
        for button in choices {
            button.isHidden = request.state != .open
            button.isEnabled = canAnswer
            button.state = state.selected.contains(button.identifier?.rawValue ?? "") ? .on : .off
        }
        submit.isHidden = request.state != .open || request.selectionMode == .single
        submit.isEnabled = canAnswer && !state.selected.isEmpty
        dismissButton.isHidden = request.state != .open || (state.fresh && email?.lowercased() != request.recipientEmail.lowercased())
        dismissButton.isEnabled = canAnswer
        closeButton.isEnabled = !state.busy
        errorLabel.stringValue = state.error ?? ""; errorLabel.isHidden = state.error == nil
    }
    @objc private func choose(_ sender: NSButton) {
        guard state.canAnswer(as: email), let id = sender.identifier?.rawValue else { return }
        state.toggle(id)
        if state.request.selectionMode == .single { resolve(.answer) }
    }
    @objc private func answer() { resolve(.answer) }
    @objc private func dismissQuestion() { resolve(.dismiss) }
    private func resolve(_ action: AttentionResolveInputAction) {
        Task {
            await state.resolve(action: action, email: email, send: { try await self.api.resolveAttention(id: self.state.request.id, command: $0) })
            if state.request.state != .open { onResolved() }
        }
    }
    @objc private func close() {
        guard !state.busy else { return }
        polling?.cancel()
        if let window = view.window { window.sheetParent?.endSheet(window); window.orderOut(nil) }
    }
    func run(over parent: NSWindow?) {
        guard let parent else { return }
        let sheet = NSWindow(contentViewController: self); sheet.title = String(localized: "Question")
        sheet.setContentSize(NSSize(width: 460, height: 560)); parent.beginSheet(sheet)
    }
}
