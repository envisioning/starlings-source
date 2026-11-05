import AppKit

/// In-meeting chat — same LiveKit topics as the browser guest UI.
@MainActor
final class MeetingChatPanelView: NSView, NSTextFieldDelegate {
    var onSend: ((String) async throws -> Void)?
    /// Somebody put a reaction on a message, or took one off. The panel does
    /// not decide which — it asks, and redraws when `setReactions` says so.
    var onToggleReaction: ((MeetingReaction, String) -> Void)?
    /// Whether this Mac has that reaction on that message, so a pill can draw
    /// itself pressed. Asked rather than stored: the session already holds the
    /// tally, and a second copy here is a second thing to get wrong.
    var isMine: ((MeetingReaction, String) -> Bool)?
    /// What a pasted link points at, read by the Worker rather than by this
    /// Mac — see `LinkPreview` for why no client ever fetches a link itself.
    ///
    /// Nil until a meeting is connected, because a guest's authorization for
    /// it *is* the meeting: the same artifact token the browser uses. A panel
    /// with no loader simply draws no cards.
    var loadPreview: ((String) async -> LinkPreview?)?

    /// Padding around the column. Zero when a container already insets this
    /// view; set by the chat window, whose titlebar is the only chrome the
    /// content gets.
    var contentInsets = NSEdgeInsets() {
        didSet { applyContentInsets() }
    }

    private var columnEdges: [NSLayoutConstraint] = []

    private let messagesStack = NSStackView()
    /// The rows, by the message id a reaction names. Kept so a reaction can
    /// find its row without walking the stack.
    private var rowsByMessageID: [String: ChatMessageRowView] = [:]
    private let scrollView = NSScrollView()
    /// One selection across every bubble, the way the thread panes have it.
    private let selection = ThreadTextSelectionController()
    private let emptyLabel = NSTextField(labelWithString: String(localized: "No messages yet"))
    private let inputField = StarlingsTextField(placeholder: String(localized: "Write a message…"))
    private let sendButton = StarlingsFieldButton.make(symbol: "arrow.up", label: String(localized: "Send"))
    private let noticeLabel = StarlingsNoticeView(wrapping: true)
    private var isSending = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // The chat window's titlebar is the only chrome — this view draws none.
        wantsLayer = false

        emptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        emptyLabel.textColor = StarlingsColors.secondaryText
        emptyLabel.alignment = .center

        messagesStack.orientation = .vertical
        messagesStack.alignment = .leading
        messagesStack.spacing = 10
        messagesStack.edgeInsets = NSEdgeInsets(top: 2, left: 0, bottom: 2, right: 0)
        messagesStack.setHuggingPriority(.defaultLow, for: .horizontal)
        selection.container = messagesStack

        let document = NSView()
        document.addSubview(messagesStack)
        document.addSubview(emptyLabel)
        messagesStack.translatesAutoresizingMaskIntoConstraints = false
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            messagesStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            messagesStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            // The rows hang from the composer: a short transcript sits at the
            // bottom of the panel, and the document grows upward past it.
            messagesStack.topAnchor.constraint(greaterThanOrEqualTo: document.topAnchor),
            messagesStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            emptyLabel.centerXAnchor.constraint(equalTo: document.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: document.centerYAnchor),
            emptyLabel.leadingAnchor.constraint(greaterThanOrEqualTo: document.leadingAnchor, constant: 8),
            emptyLabel.trailingAnchor.constraint(lessThanOrEqualTo: document.trailingAnchor, constant: -8),
        ])

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.documentView = document
        scrollView.setContentHuggingPriority(.defaultLow, for: .vertical)
        scrollView.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        document.translatesAutoresizingMaskIntoConstraints = false
        if let clip = scrollView.contentView as? NSClipView {
            NSLayoutConstraint.activate([
                document.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
                document.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
                document.topAnchor.constraint(equalTo: clip.topAnchor),
                document.widthAnchor.constraint(equalTo: clip.widthAnchor),
                document.heightAnchor.constraint(greaterThanOrEqualTo: clip.heightAnchor),
            ])
        }

        inputField.delegate = self
        inputField.target = self
        inputField.action = #selector(sendTapped)
        inputField.setContentHuggingPriority(.defaultLow, for: .horizontal)

        // A round accent button inside the field, on its right edge, like the
        // thread composer, the phone and the web.
        sendButton.target = self
        sendButton.action = #selector(sendTapped)
        StarlingsFieldButton.seat(sendButton, in: inputField)

        noticeLabel.label.maximumNumberOfLines = 2

        let composer = NSStackView(views: [inputField])
        composer.orientation = .horizontal
        composer.alignment = .centerY
        composer.spacing = 8
        composer.setContentHuggingPriority(.required, for: .vertical)

        let column = NSStackView(views: [scrollView, noticeLabel, composer])
        column.orientation = .vertical
        column.alignment = .leading
        // `.fill`, not the default gravity packing: the transcript is the only
        // view with no height of its own, so it takes the slack and the
        // composer sits on the bottom edge whatever size the window is.
        column.distribution = .fill
        column.spacing = 8
        addSubview(column)
        column.translatesAutoresizingMaskIntoConstraints = false
        noticeLabel.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        scrollView.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        composer.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        columnEdges = [
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.topAnchor.constraint(equalTo: topAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
        ]
        NSLayoutConstraint.activate(columnEdges)
        heightAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        setContentHuggingPriority(.defaultLow, for: .vertical)
        setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func applyContentInsets() {
        for edge in columnEdges {
            switch edge.firstAttribute {
            case .leading: edge.constant = contentInsets.left
            case .trailing: edge.constant = -contentInsets.right
            case .top: edge.constant = contentInsets.top
            case .bottom: edge.constant = -contentInsets.bottom
            default: break
            }
        }
    }

    func clear() {
        selection.clear()
        for view in messagesStack.arrangedSubviews {
            messagesStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        rowsByMessageID = [:]
        emptyLabel.isHidden = false
        inputField.stringValue = ""
        setNotice(nil)
        isSending = false
        sendButton.isEnabled = true
    }

    func append(_ message: MeetingChatMessage) {
        emptyLabel.isHidden = true
        let row = ChatMessageRowView(
            message: message,
            onToggleReaction: { [weak self] reaction in
                self?.onToggleReaction?(reaction, message.id)
            },
            isMine: { [weak self] reaction in
                self?.isMine?(reaction, message.id) ?? false
            },
            loadPreview: loadPreview,
            selection: selection
        )
        rowsByMessageID[message.id] = row
        messagesStack.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: messagesStack.widthAnchor).isActive = true
        layoutSubtreeIfNeeded()
        scrollToBottom()
    }

    /// The tally changed somewhere; every row asks it what is on its own
    /// message.
    ///
    /// The rows themselves are never rebuilt — only their pills — so a
    /// transcript somebody is reading does not jump because a reaction landed
    /// twenty messages up, and the scroll position survives.
    func setReactions(_ tally: ChatReactionTally) {
        for (id, row) in rowsByMessageID {
            row.setReactions(tally.reactions(on: id))
        }
    }

    func focusComposer() {
        window?.makeFirstResponder(inputField)
    }

    /// A click off the text drops the selection, the way it does in any
    /// document. Rows do not take mouse downs, so anything that is not a
    /// message body arrives here.
    override func mouseDown(with event: NSEvent) {
        selection.clear()
        super.mouseDown(with: event)
    }

    /// Chat is kept alive while its window is hidden, so reopening it must
    /// explicitly choose the newest message even when no new message arrived.
    func showLatest() {
        scrollToBottom()
        DispatchQueue.main.async { [weak self] in
            self?.scrollToBottom()
        }
    }

    @objc private func sendTapped() {
        Task { await sendCurrentMessage() }
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        // Enter commits via action; ignore other end-editing paths.
    }

    private func sendCurrentMessage() async {
        guard !isSending else { return }
        let text = inputField.stringValue
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        isSending = true
        sendButton.isEnabled = false
        defer {
            isSending = false
            sendButton.isEnabled = true
        }
        do {
            try await onSend?(text)
            setNotice(nil)
            inputField.stringValue = ""
            window?.makeFirstResponder(inputField)
        } catch {
            // A message that wouldn't send is a composer problem, not a reason
            // to throw a modal over a meeting that is otherwise working.
            let failure = error as? StarlingsError
                ?? StarlingsError.wrapping(error, code: "chat.send_failed", title: String(localized: "Message not sent"))
            StarlingsDiagnosticsLog.shared.record(failure, context: "chat send failed")
            setNotice(failure.message)
        }
    }

    /// Inline, next to the field that caused it. Cleared by the next success.
    func setNotice(_ text: String?) {
        noticeLabel.setText(text, tone: .danger)
    }

    private func scrollToBottom() {
        guard let document = scrollView.documentView else { return }
        document.layoutSubtreeIfNeeded()
        let maxY = max(0, document.bounds.height - scrollView.contentView.bounds.height)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: maxY))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
}

@MainActor
private final class ChatMessageRowView: NSView {
    private let onToggleReaction: (MeetingReaction) -> Void
    private let isMine: (MeetingReaction) -> Bool
    private let bubbleView: NSView
    private let bubbleColor: NSColor
    /// The pills, and the way to add one. Only the quiet "＋" until somebody
    /// reacts — a row of six emoji under every message would be more chrome
    /// than chat, so the palette lives behind it.
    private let reactionsRow = NSStackView()
    private let addButton = NSButton()

    init(
        message: MeetingChatMessage,
        onToggleReaction: @escaping (MeetingReaction) -> Void,
        isMine: @escaping (MeetingReaction) -> Bool,
        loadPreview: ((String) async -> LinkPreview?)?,
        selection: ThreadTextSelectionController
    ) {
        self.onToggleReaction = onToggleReaction
        self.isMine = isMine
        let bubble = NSView()
        self.bubbleView = bubble
        self.bubbleColor = message.isLocal
            ? StarlingsColors.accent.withAlphaComponent(0.14)
            : StarlingsColors.elevated
        super.init(frame: .zero)
        let name = NSTextField(labelWithString: message.isLocal ? String(localized: "You") : message.senderName)
        name.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        name.textColor = message.isLocal ? StarlingsColors.primaryText : StarlingsColors.secondaryText
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // The same TextKit view the thread panes draw with, for the same two
        // reasons: a link is drawn in the accent rather than AppKit's blue,
        // and a drag selects across bubbles instead of stopping at one. A
        // diagnostic dump is meant to be copied verbatim — `## Client` and
        // URLs are report content, not chat formatting — so it skips the
        // Markdown pass.
        let body = message.isDebugReport
            ? ThreadSelectableTextView(
                text: message.text,
                font: .systemFont(ofSize: StarlingsTypography.scaled(13)),
                color: StarlingsColors.primaryText
            )
            : ThreadSelectableTextView(attributed: ThreadMarkdownAppKit.attributed(
                message.text,
                font: .systemFont(ofSize: StarlingsTypography.scaled(13)),
                color: StarlingsColors.primaryText
            ))
        body.selectionController = selection

        bubble.wantsLayer = true
        // CALayer cannot retain an adaptive NSColor. Resolve once for the
        // current app appearance here, then refresh when this row enters a
        // window or the appearance changes.
        bubble.layer?.backgroundColor = StarlingsColors.resolved(
            bubbleColor,
            for: NSApplication.shared.effectiveAppearance
        ).cgColor
        bubble.layer?.cornerRadius = 10
        bubble.addSubview(body)
        body.translatesAutoresizingMaskIntoConstraints = false
        body.pinToEdges(of: bubble, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))

        reactionsRow.orientation = .horizontal
        reactionsRow.alignment = .centerY
        reactionsRow.spacing = 4

        addButton.bezelStyle = .inline
        SettingsChrome.applyQuietButton(addButton)
        // Attributed for the same reason the pills are: the content is text,
        // and a tint colour would not touch it.
        addButton.attributedTitle = NSAttributedString(string: "＋", attributes: [
            .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(11)),
            .foregroundColor: StarlingsColors.secondaryText,
        ])
        addButton.toolTip = String(localized: "React to this message")
        addButton.setAccessibilityLabel(String(localized: "React to this message"))
        addButton.target = self
        addButton.action = #selector(addPressed)
        reactionsRow.addArrangedSubview(addButton)

        // The card under the words, when there is a link and somewhere to ask.
        // Built hidden and filled in when the answer lands, so the transcript
        // does not jump for a card that may never have anything to say — the
        // same shape the thread panes use.
        let column = NSStackView(views: [name, bubble])
        if !message.isDebugReport,
           let loadPreview,
           let link = ThreadMarkdown.firstPreviewableLink(in: message.text) {
            let card = ThreadLinkPreviewView()
            column.addArrangedSubview(card)
            Task { @MainActor [weak card] in
                // A link that cannot be read is a link, not an error: the
                // message is already legible and there is nothing the reader
                // could do about a site that did not answer.
                guard let preview = await loadPreview(link), let card else { return }
                card.show(preview)
            }
        }
        column.addArrangedSubview(reactionsRow)
        column.orientation = .vertical
        column.alignment = message.isLocal ? .trailing : .leading
        column.spacing = 4
        addSubview(column)
        column.translatesAutoresizingMaskIntoConstraints = false
        column.pinToEdges(of: self)
        bubble.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.92).isActive = true
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyBubbleAppearance()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyBubbleAppearance()
    }

    private func applyBubbleAppearance() {
        let appearance = window?.effectiveAppearance ?? effectiveAppearance
        bubbleView.layer?.backgroundColor = StarlingsColors.resolved(bubbleColor, for: appearance).cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Redraw the pills. The add button is rebuilt around rather than
    /// recreated, so the menu it opens never loses its anchor mid-click.
    func setReactions(_ reactions: [ChatReactionCount]) {
        for view in reactionsRow.arrangedSubviews where view !== addButton {
            reactionsRow.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        for (index, entry) in reactions.enumerated() {
            let pill = ChatReactionPillButton(
                reaction: entry.reaction,
                count: entry.count,
                isMine: isMine(entry.reaction),
                onPress: onToggleReaction
            )
            reactionsRow.insertArrangedSubview(pill, at: index)
        }
    }

    /// The whole palette, as a menu rather than an always-open row: six emoji
    /// under every message is a lot of ink for something most messages never
    /// get.
    @objc private func addPressed() {
        let menu = NSMenu()
        for reaction in ChatReaction.emoji {
            let item = NSMenuItem(title: reaction.accessibilityName, action: #selector(pickPressed(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = reaction.rawValue
            item.image = NSImage(
                systemSymbolName: reaction.systemSymbolName,
                accessibilityDescription: reaction.accessibilityName
            )
            item.state = isMine(reaction) ? .on : .off
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: addButton.bounds.height), in: addButton)
    }

    @objc private func pickPressed(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let reaction = MeetingReaction(rawValue: raw) else { return }
        onToggleReaction(reaction)
    }
}

/// One emoji and its tally, pressed when this Mac is one of the reactors.
@MainActor
private final class ChatReactionPillButton: NSButton {
    private let reaction: MeetingReaction
    private let onPress: (MeetingReaction) -> Void

    init(reaction: MeetingReaction, count: Int, isMine: Bool, onPress: @escaping (MeetingReaction) -> Void) {
        self.reaction = reaction
        self.onPress = onPress
        super.init(frame: .zero)
        bezelStyle = .inline
        SettingsChrome.applyQuietButton(self)
        title = "\(count)"
        image = NSImage(
            systemSymbolName: reaction.systemSymbolName,
            accessibilityDescription: reaction.accessibilityName
        )
        imagePosition = .imageLeading
        imageScaling = .scaleProportionallyDown
        // `accentMark` rather than `accent`, because this is ink on a surface
        // and not a fill carrying ink. See the accent budget in DesignSystem.
        attributedTitle = NSAttributedString(string: "\(count)", attributes: [
            .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(11)),
            .foregroundColor: isMine ? StarlingsColors.accentMark : StarlingsColors.secondaryText,
        ])
        setAccessibilityLabel("\(reaction.accessibilityName), \(count)")
        setAccessibilityValue(isMine ? String(localized: "On") : String(localized: "Off"))
        target = self
        action = #selector(pressed)
        setContentHuggingPriority(.required, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func pressed() { onPress(reaction) }
}
