import AppKit

/// The box you write in.
///
/// A single-line `NSTextField` was the wrong instrument: it cannot hold a
/// paragraph, it cannot show what you are about to send, and it turned every
/// multi-sentence thought into three separate messages. This is a text view
/// that grows with the text and stops at six lines, with the keyboard
/// conventions people already have — Return sends, Shift-Return is a newline,
/// Up on an empty box edits the last thing you said.
@MainActor
final class ThreadComposerView: NSView {
    /// Room for a paragraph before it starts scrolling. Past this the window is
    /// giving the composer space the transcript needs more.
    private static let maxLines = 6

    /// One font for the box and its placeholder, so the line the placeholder
    /// sits on is the line the text lands on.
    private static let font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))

    /// One line of field: the send button's height, so the well never grows
    /// just to seat it.
    private static let minFieldHeight: CGFloat = 28

    private let well = NSView()
    private let scroll = NSScrollView()
    private let textView = ComposerTextView()
    private let placeholder = NSTextField(labelWithString: "")
    private let sendButton = StarlingsFieldButton.make(symbol: "arrow.up", label: String(localized: "Send"))
    private let attachButton = NSButton(title: "", target: nil, action: nil)
    private let formatButton = NSButton(title: "", target: nil, action: nil)
    /// Paste and send, ⌘⇧V. Shown only for an agent — see `showsPasteAndSend`.
    private let pasteButton = NSButton(title: "", target: nil, action: nil)
    private var heightConstraint: NSLayoutConstraint?
    private var formatAfterAttach: NSLayoutConstraint?
    private var formatAfterPaste: NSLayoutConstraint?
    /// Past the Worker's ceiling. Kept so the well can say so: a Send button
    /// that greys out with no reason given is a box that has simply stopped
    /// working as far as anybody typing into it can tell.
    private var isOverLimit = false

    /// Somebody who can be named here. Held by the composer so `@` completion
    /// is answered without a round trip — the roster is already in hand. Only
    /// the email matters: a mention completes to its local part, not a
    /// display name — see `MentionMatching`.
    struct Mentionable: Equatable, Sendable {
        let email: String
    }

    /// Who `@` may complete to. Set from the roster; empty disables completion
    /// rather than offering an empty list.
    var mentionable: [Mentionable] = [] {
        didSet { textView.mentionable = mentionable }
    }

    /// Text plus whoever it named. Mentions are resolved from what is actually
    /// still written — somebody who types a name and deletes it has not
    /// mentioned them.
    var onSend: ((String, [String]) -> Void)?
    /// A file arrived, by drop or by the attach button.
    var onAttach: (([URL]) -> Void)?
    /// The clipboard's text, sent as its own message, plus whoever it named.
    /// The draft stays: what was on the clipboard is not the message being
    /// written.
    var onPasteAndSend: ((String, [String]) -> Void)?
    /// An agent is the one correspondent that is mostly handed things: a
    /// log, a draft, a link. For a person the button is clutter.
    var showsPasteAndSend = false {
        didSet {
            guard showsPasteAndSend != oldValue else { return }
            pasteButton.isHidden = !showsPasteAndSend
            formatAfterAttach?.isActive = !showsPasteAndSend
            formatAfterPaste?.isActive = showsPasteAndSend
        }
    }
    /// Up-arrow on an empty composer: the fastest correction there is, and the
    /// one people try first because every other message box has it.
    var onEditLast: (() -> Void)?
    /// Escape. Returns true when there was something to back out of — a
    /// rewrite in progress — so the key falls through to AppKit when there
    /// wasn't.
    var onCancel: (() -> Bool)?

    var placeholderText: String = "" {
        didSet { placeholder.stringValue = placeholderText }
    }

    var text: String {
        get { textView.string }
        set {
            textView.string = newValue
            applyTextChrome()
            syncState()
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 6, height: 7)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        // The clip view has to resize the text view for the container to rewrap
        // when the window does; without this the wrap width stays whatever it
        // was the first time the pane was laid out.
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.composer = self
        applyTextChrome()

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        // Overlay, so a legacy "always show scroll bars" setting never draws a
        // track beside an empty field.
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.documentView = textView
        scroll.translatesAutoresizingMaskIntoConstraints = false

        placeholder.font = Self.font
        placeholder.textColor = StarlingsColors.secondaryText
        StarlingsTypography.applyStaticLabel(placeholder)
        placeholder.translatesAutoresizingMaskIntoConstraints = false

        well.wantsLayer = true
        well.layer?.cornerRadius = 10
        well.layer?.cornerCurve = .continuous
        well.layer?.borderWidth = 1
        applyWellColors()
        well.translatesAutoresizingMaskIntoConstraints = false

        // A round accent button inside the well, on its right edge, like the
        // phone's and the web's. It cannot wrap or drop below the
        // field at any width because it is part of the field.
        sendButton.target = self
        sendButton.action = #selector(sendTapped)
        sendButton.translatesAutoresizingMaskIntoConstraints = false

        attachButton.image = NSImage(
            systemSymbolName: "paperclip",
            accessibilityDescription: String(localized: "Attach a file")
        ) ?? NSImage()
        attachButton.imagePosition = .imageOnly
        attachButton.bezelStyle = .inline
        attachButton.isBordered = false
        attachButton.contentTintColor = StarlingsColors.secondaryText
        attachButton.toolTip = String(localized: "Attach a file")
        attachButton.target = self
        attachButton.action = #selector(attachTapped)
        attachButton.translatesAutoresizingMaskIntoConstraints = false
        SettingsChrome.applyQuietButton(attachButton)

        formatButton.image = NSImage(
            systemSymbolName: "textformat",
            accessibilityDescription: String(localized: "Format message")
        ) ?? NSImage()
        formatButton.imagePosition = .imageOnly
        formatButton.bezelStyle = .inline
        formatButton.isBordered = false
        formatButton.contentTintColor = StarlingsColors.secondaryText
        formatButton.toolTip = String(localized: "Format message")
        formatButton.menu = makeFormatMenu()
        formatButton.target = self
        formatButton.action = #selector(formatTapped(_:))
        formatButton.translatesAutoresizingMaskIntoConstraints = false
        SettingsChrome.applyQuietButton(formatButton)

        pasteButton.image = NSImage(
            systemSymbolName: "doc.on.clipboard",
            accessibilityDescription: String(localized: "Paste and send")
        ) ?? NSImage()
        pasteButton.imagePosition = .imageOnly
        pasteButton.bezelStyle = .inline
        pasteButton.isBordered = false
        pasteButton.contentTintColor = StarlingsColors.secondaryText
        pasteButton.toolTip = String(localized: "Paste and send (⌘⇧V)")
        pasteButton.keyEquivalent = "v"
        pasteButton.keyEquivalentModifierMask = [.command, .shift]
        pasteButton.target = self
        pasteButton.action = #selector(pasteAndSendTapped)
        pasteButton.isHidden = true
        pasteButton.translatesAutoresizingMaskIntoConstraints = false
        SettingsChrome.applyQuietButton(pasteButton)

        addSubview(well)
        well.addSubview(scroll)
        // Under the scroll view, not over it. A label is opaque to hit testing
        // even when it is not selectable, so a placeholder on top swallowed
        // every click aimed at the empty box — the one place people click.
        well.addSubview(placeholder, positioned: .below, relativeTo: scroll)
        well.addSubview(attachButton)
        well.addSubview(pasteButton)
        well.addSubview(formatButton)
        well.addSubview(sendButton)

        let height = scroll.heightAnchor.constraint(equalToConstant: Self.minFieldHeight)
        heightConstraint = height
        let formatAfterAttach = formatButton.leadingAnchor.constraint(equalTo: attachButton.trailingAnchor, constant: 4)
        let formatAfterPaste = formatButton.leadingAnchor.constraint(equalTo: pasteButton.trailingAnchor, constant: 4)
        self.formatAfterAttach = formatAfterAttach
        self.formatAfterPaste = formatAfterPaste
        formatAfterAttach.isActive = true

        NSLayoutConstraint.activate([
            well.leadingAnchor.constraint(equalTo: leadingAnchor),
            well.trailingAnchor.constraint(equalTo: trailingAnchor),
            well.topAnchor.constraint(equalTo: topAnchor),
            well.bottomAnchor.constraint(equalTo: bottomAnchor),
            attachButton.leadingAnchor.constraint(equalTo: well.leadingAnchor, constant: 7),
            // One centre line for the icons, the placeholder and send on a
            // one-line field; as text grows, send stays on the last line and
            // the icons follow it.
            attachButton.centerYAnchor.constraint(equalTo: sendButton.centerYAnchor),
            attachButton.widthAnchor.constraint(equalToConstant: 18),
            attachButton.heightAnchor.constraint(equalToConstant: 18),
            pasteButton.leadingAnchor.constraint(equalTo: attachButton.trailingAnchor, constant: 4),
            pasteButton.centerYAnchor.constraint(equalTo: attachButton.centerYAnchor),
            pasteButton.widthAnchor.constraint(equalToConstant: 18),
            pasteButton.heightAnchor.constraint(equalToConstant: 18),
            formatButton.centerYAnchor.constraint(equalTo: attachButton.centerYAnchor),
            formatButton.widthAnchor.constraint(equalToConstant: 18),
            formatButton.heightAnchor.constraint(equalToConstant: 18),
            scroll.leadingAnchor.constraint(equalTo: formatButton.trailingAnchor, constant: 4),
            scroll.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -4),
            scroll.topAnchor.constraint(equalTo: well.topAnchor, constant: 4),
            scroll.bottomAnchor.constraint(equalTo: well.bottomAnchor, constant: -4),
            height,
            placeholder.leadingAnchor.constraint(equalTo: scroll.leadingAnchor, constant: 7),
            placeholder.trailingAnchor.constraint(lessThanOrEqualTo: sendButton.leadingAnchor, constant: -4),
            // The placeholder shows only on an empty, one-line field.
            placeholder.centerYAnchor.constraint(equalTo: sendButton.centerYAnchor),
            sendButton.trailingAnchor.constraint(equalTo: well.trailingAnchor, constant: -4),
            sendButton.bottomAnchor.constraint(equalTo: well.bottomAnchor, constant: -4),
            sendButton.widthAnchor.constraint(equalToConstant: StarlingsFieldButton.diameter),
            sendButton.heightAnchor.constraint(equalToConstant: StarlingsFieldButton.diameter),
        ])

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(textChanged),
            name: NSText.didChangeNotification,
            object: textView
        )
        syncState()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func makeFormatMenu() -> NSMenu {
        let menu = NSMenu(title: String(localized: "Format message"))
        let groups: [[ThreadMarkdownFormatAction]] = [
            [.bold, .italic, .strikethrough, .inlineCode, .link],
            [.bulletedList, .numberedList, .quote, .codeBlock],
        ]
        for (groupIndex, group) in groups.enumerated() {
            if groupIndex > 0 { menu.addItem(.separator()) }
            for action in group {
                let item = NSMenuItem(title: formatTitle(action), action: #selector(applyFormat(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = action.rawValue
                menu.addItem(item)
            }
        }
        return menu
    }

    private func formatTitle(_ action: ThreadMarkdownFormatAction) -> String {
        switch action {
        case .bold: String(localized: "Bold")
        case .italic: String(localized: "Italic")
        case .strikethrough: String(localized: "Strikethrough")
        case .inlineCode: String(localized: "Inline code")
        case .link: String(localized: "Link")
        case .bulletedList: String(localized: "Bulleted list")
        case .numberedList: String(localized: "Numbered list")
        case .quote: String(localized: "Quote")
        case .codeBlock: String(localized: "Code block")
        }
    }

    @objc private func applyFormat(_ sender: NSMenuItem) {
        guard let rawValue = sender.representedObject as? String,
              let action = ThreadMarkdownFormatAction(rawValue: rawValue)
        else { return }
        let source = textView.string
        let edit = ThreadMarkdownEditing.apply(action, to: source, selection: textView.selectedRange())
        textView.insertText(edit.text, replacementRange: NSRange(location: 0, length: (source as NSString).length))
        textView.setSelectedRange(edit.selection)
        focus()
        applyTextChrome()
        syncState()
    }

    func focus() {
        window?.makeFirstResponder(textView)
    }

    /// Ink, caret, and selection for what gets typed.
    ///
    /// `textColor` on its own colours the text that is already there and leaves
    /// the typing attributes with no foreground colour at all — and text
    /// carrying no colour attribute is drawn black whatever the appearance,
    /// which is how this box came to write in black on the dark canvas. Every
    /// other field editor in the app is dressed by this same call.
    private func applyTextChrome() {
        StarlingsTextField.styleFieldEditor(textView, font: Self.font)
    }

    /// A CALayer holds resolved CGColors, so the well is repainted whenever the
    /// appearance under it changes.
    private func applyWellColors() {
        let edge = isOverLimit ? StarlingsColors.danger : StarlingsColors.border
        well.layer?.borderColor = StarlingsColors.resolved(edge, for: self).cgColor
        well.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.field, for: self).cgColor
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyTextChrome()
        applyWellColors()
    }

    /// What Return does, and what the button does — one path, so the two can
    /// never disagree about what is sendable.
    func send() {
        let trimmed = textView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= DirectMessageCadence.maxCharacters else { return }
        let named = mentions(in: trimmed)
        textView.string = ""
        applyTextChrome()
        syncState()
        onSend?(trimmed, named)
    }

    /// Who this text still names. See `MentionMatching`.
    ///
    /// Read back off the finished message rather than remembered as somebody
    /// types: a handle completed and then deleted is not a mention, and a
    /// list that only ever grew would notify people no longer in the
    /// sentence.
    func mentions(in text: String) -> [String] {
        MentionMatching.mentions(in: text, candidates: mentionable.map { MentionMatching.Candidate(email: $0.email) })
    }

    @objc private func pasteAndSendTapped() {
        guard showsPasteAndSend else { return }
        let text = (NSPasteboard.general.string(forType: .string) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        onPasteAndSend?(text, mentions(in: text))
    }

    @objc private func formatTapped(_ sender: NSButton) {
        sender.menu?.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
    }

    @objc private func attachTapped() {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.prompt = String(localized: "Attach")
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self, !panel.urls.isEmpty else { return }
            self.onAttach?(panel.urls)
        }
    }

    /// Only from an empty box. Recalling the last message over something
    /// half-written would throw away what somebody was in the middle of typing.
    func editLastIfEmpty() -> Bool {
        guard textView.string.isEmpty else { return false }
        onEditLast?()
        return true
    }

    /// Escape, asked of whoever owns the conversation.
    func cancel() -> Bool {
        onCancel?() ?? false
    }

    @objc private func sendTapped() { send() }

    @objc private func textChanged() { syncState() }

    private func syncState() {
        placeholder.isHidden = !textView.string.isEmpty
        let trimmed = textView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        let over = trimmed.count - DirectMessageCadence.maxCharacters
        sendButton.isEnabled = !trimmed.isEmpty && over <= 0
        sendButton.alphaValue = sendButton.isEnabled ? 1 : 0.4
        if isOverLimit != (over > 0) {
            isOverLimit = over > 0
            applyWellColors()
        }
        recolorMentions()
        resize()
    }

    /// Draws every `@handle` this box would actually send as a mention in
    /// accent, live, as somebody types — the same colour the transcript draws
    /// it in once sent. Attribute-only: never touches a character, so it
    /// never enters the undo stack and never moves the caret.
    private func recolorMentions() {
        guard let textStorage = textView.textStorage else { return }
        let text = textView.string
        let fullRange = NSRange(location: 0, length: (text as NSString).length)
        guard fullRange.length > 0 else { return }
        textStorage.beginEditing()
        textStorage.addAttribute(.foregroundColor, value: StarlingsColors.primaryText, range: fullRange)
        textStorage.addAttribute(.font, value: Self.font, range: fullRange)
        if !mentionable.isEmpty {
            let candidates = mentionable.map { MentionMatching.Candidate(email: $0.email) }
            let bold = NSFontManager.shared.convert(Self.font, toHaveTrait: .boldFontMask)
            for match in MentionMatching.highlightRanges(in: text, candidates: candidates) {
                guard let lower = text.index(text.startIndex, offsetBy: match.range.lowerBound, limitedBy: text.endIndex),
                      let upper = text.index(text.startIndex, offsetBy: match.range.upperBound, limitedBy: text.endIndex)
                else { continue }
                let nsRange = NSRange(lower..<upper, in: text)
                textStorage.addAttribute(.foregroundColor, value: StarlingsColors.accentMark, range: nsRange)
                textStorage.addAttribute(.font, value: bold, range: nsRange)
            }
        }
        textStorage.endEditing()
    }

    /// Grow to fit, up to the ceiling. Measured from the laid-out text rather
    /// than counted newlines, so a long wrapped line is as tall as it looks.
    private func resize() {
        guard let layoutManager = textView.layoutManager, let container = textView.textContainer else { return }
        layoutManager.ensureLayout(for: container)
        let lineHeight = textView.font?.boundingRectForFont.height ?? 16
        let used = layoutManager.usedRect(for: container).height
        let ceiling = lineHeight * CGFloat(Self.maxLines)
        let height = min(max(used + textView.textContainerInset.height * 2, Self.minFieldHeight), ceiling)
        scroll.hasVerticalScroller = height >= ceiling
        if abs((heightConstraint?.constant ?? 0) - height) > 0.5 {
            heightConstraint?.constant = height
        }
    }
}

/// The keyboard conventions live here rather than in a delegate, because they
/// are about key events and not about text changes.
@MainActor
private final class ComposerTextView: NSTextView {
    weak var composer: ThreadComposerView?
    var mentionable: [ThreadComposerView.Mentionable] = []
    /// True while AppKit's completion list is on screen. Return belongs to the
    /// list while it is up: without this, choosing a name sent the message
    /// instead, with half a mention still in it.
    private var completing = false

    /// AppKit's own completion, rather than a popup of our own.
    ///
    /// A custom list has to fight the field for key focus, re-implement arrow
    /// keys and Escape, and follow the caret as the text reflows. The text
    /// system already does all three — it only has to be told what the word
    /// under the caret could become, and when to ask.
    override func completions(
        forPartialWordRange charRange: NSRange,
        indexOfSelectedItem index: UnsafeMutablePointer<Int>?
    ) -> [String]? {
        guard let range = Range(charRange, in: string) else { return nil }
        let partial = String(string[range])
        guard partial.hasPrefix("@") else { return nil }
        let wanted = partial.dropFirst().lowercased()
        // A bare `@` is ordinary text until somebody starts a handle. Apart
        // from keeping `@ ` usable, this avoids opening a list that could
        // only guess at the person's intent.
        guard !wanted.isEmpty else { return nil }
        // AppKit defaults this to the first row, which previews that person's
        // handle in the draft. Let the person choose a row explicitly instead.
        index?.pointee = -1
        // Completes to the handle (the email's local part), not the display
        // name — what gets typed is what a `mentions(in:)` read-back has to
        // find again.
        let matches = mentionable
            .map { MentionMatching.localPart(of: $0.email.lowercased()) }
            .filter { !$0.isEmpty && $0.hasPrefix(wanted) }
            .prefix(8)
            .map { "@\($0)" }
        return matches.isEmpty ? nil : Array(matches)
    }

    /// The word the completion replaces. `@` is not a word character to the
    /// text system, so without this it would offer to replace the name and
    /// leave the `@` stranded in front of it.
    override var rangeForUserCompletion: NSRange {
        let text = string as NSString
        let caret = selectedRange().location
        guard caret > 0, caret <= text.length else { return super.rangeForUserCompletion }
        let head = text.substring(to: caret)
        guard let at = head.lastIndex(of: "@") else { return super.rangeForUserCompletion }
        let start = head.distance(from: head.startIndex, to: at)
        // A bare `@` mid-word — an address somebody is typing out — is not a
        // mention, so completion stays out of it.
        if start > 0 {
            let before = head[head.index(head.startIndex, offsetBy: start - 1)]
            if !before.isWhitespace && !before.isNewline { return super.rangeForUserCompletion }
        }
        // A space ends it: `@Mich ell` is one name and a stray word.
        if head[at...].dropFirst().contains(where: { $0.isWhitespace }) {
            return super.rangeForUserCompletion
        }
        return NSRange(location: start, length: caret - start)
    }

    override func insertCompletion(
        _ word: String,
        forPartialWordRange charRange: NSRange,
        movement: Int,
        isFinal: Bool
    ) {
        super.insertCompletion(word, forPartialWordRange: charRange, movement: movement, isFinal: isFinal)
        if isFinal { completing = false }
    }

    /// Escape, in the order the things on screen are stacked: the completion
    /// list first, then a rewrite in progress, and only then AppKit's own
    /// meaning for the key.
    override func cancelOperation(_ sender: Any?) {
        if completing {
            dismissCompletion(sender)
            return
        }
        if composer?.cancel() == true { return }
        super.cancelOperation(sender)
    }

    /// AppKit's completion window is a separate interaction layer. Close it
    /// before an edit reaches the text system; otherwise the active completion
    /// session can consume Backspace or Space and leave the caret looking
    /// editable while the text never changes.
    private func dismissCompletion(_ sender: Any?) {
        guard completing else { return }
        completing = false
        super.cancelOperation(sender)
    }

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        let isDelete = event.keyCode == 51 || event.keyCode == 117
        let isSpace = event.keyCode == 49
        let isNewline = isReturn && event.modifierFlags.contains(.shift)
        let isCaretNavigation = [UInt16(115), 116, 119, 121, 123, 124, 125, 126].contains(event.keyCode)
        // Shift-Return is the newline. Everything else about Return sends,
        // including on the numeric keypad — unless a name is being completed,
        // in which case Return picks it and the message stays put.
        if isReturn, !event.modifierFlags.contains(.shift), !hasMarkedText() {
            if completing {
                completing = false
                super.keyDown(with: event)
                return
            }
            composer?.send()
            return
        }
        // Up and Down belong to an open completion list. Don't call `complete`
        // again after AppKit moves its selection; that can reset the choice.
        if completing && (event.keyCode == 125 || event.keyCode == 126) {
            super.keyDown(with: event)
            return
        }
        // Up on an empty box recalls the last message. Anywhere else it is
        // ordinary caret movement, which is what somebody editing expects, and
        // while the completion list is up it walks the list.
        if event.keyCode == 126, !completing, composer?.editLastIfEmpty() == true { return }
        // Space ends a handle; deletion edits the text. Dismiss the completion
        // layer before either key reaches the text system, then leave the text
        // alone long enough for the edit to be visible. A later typed
        // character can open a fresh, narrower list.
        if completing && (isDelete || isSpace || isNewline || isCaretNavigation) {
            dismissCompletion(nil)
        }
        super.keyDown(with: event)
        if isDelete || isSpace || isNewline || isCaretNavigation { return }
        // A dead key (Option-E) or a press-and-hold accent leaves marked text
        // behind. Opening the completion list now would end that composition
        // and drop the accent.
        if hasMarkedText() { return }
        // Offered as the name is typed rather than only on a keystroke people
        // have to know about. `complete` is a no-op when there is nothing to
        // suggest, so this costs nothing on ordinary text.
        let range = rangeForUserCompletion
        let hasSuggestions = !mentionable.isEmpty
            && range.length > 0
            && completions(forPartialWordRange: range, indexOfSelectedItem: nil)?.isEmpty == false
        if hasSuggestions {
            complete(nil)
            completing = true
        } else {
            completing = false
        }
    }

    // MARK: - Files

    /// A file dropped on the composer is an attachment, not a pathname.
    ///
    /// The pane accepts drops anywhere, but the text view sits on top of the
    /// one part of it people actually aim at, and left to itself the text
    /// system pastes the path in as words.
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        Self.fileURLs(from: sender).isEmpty ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        Self.fileURLs(from: sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = Self.fileURLs(from: sender)
        guard !urls.isEmpty else { return super.performDragOperation(sender) }
        composer?.onAttach?(urls)
        return true
    }

    private static func fileURLs(from sender: NSDraggingInfo) -> [URL] {
        let objects = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        )
        return objects as? [URL] ?? []
    }
}
