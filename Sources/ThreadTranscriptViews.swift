import AppKit

/// The rows a transcript is drawn from, and the composer under it.
///
/// Laid out the way the phone and the browser lay a conversation out: their
/// turns on the left behind their face, yours on the right in a tinted bubble
/// with no face and no name, because you know who you are.
///
/// The bubble here is not the one an earlier version of this file argued
/// against. That one gave every single line a rounded box and a stamp of its
/// own, so six sentences filled a window; this one wraps a whole turn, hugs
/// the words it holds rather than the column it sits in, and prints the name
/// once. What that argument was really against — repetition per line — the
/// grouping rules still prevent.
@MainActor
final class ThreadMessageRowView: NSView {
    /// Left column: wide enough for a 26pt avatar and the gutter timestamp that
    /// replaces it on a grouped line.
    private static let gutter: CGFloat = 40
    /// What a bubble leaves for the far side of the row, so a turn is visibly
    /// on one side of the transcript rather than spanning it.
    private static let farMargin: CGFloat = 80
    /// The padding inside a bubble, both sides — the text's maximum width has
    /// to account for it before the bubble exists.
    private static let bubblePadding: CGFloat = 11

    private(set) var message: ThreadMessage
    private let grouped: Bool
    /// The latest answer from the addressed agent keeps its quick reactions
    /// visible so acknowledgement does not depend on discovering hover.
    private var showPersistentReactions: Bool
    /// Sent by an agent: the reaction palette narrows to thumbs up, on the
    /// hover menu, the right-click menu and the standing rail alike.
    private let fromAgent: Bool
    /// DMs are personal acknowledgements rather than a public tally: omit the
    /// singleton count while retaining a count once somebody else joins it.
    private let hideSingleReactionCount: Bool
    private let replyParent: ThreadMessage?
    private let questionAnswer: ThreadMessage?
    private let selectedQuestionOptionIDs: Set<String>
    private let questionIsSubmitting: Bool
    private let questionError: String?
    /// A Keep release card's act in flight, and its last error.
    private let releaseBusy: Bool
    private let releaseError: String?
    /// Where a picture's bytes come from. The pane owns the API and the thread
    /// id; the row only knows it wants an image.
    private let loadImage: ((ThreadMessageAttachment) async -> NSImage?)?
    /// Where a ref chip goes when clicked. A constructor argument for the same
    /// reason `loadImage` is one: the chips are built here.
    private let onOpenRef: ((ThreadMessageRef) -> Void)?
    private let body: ThreadSelectableTextView
    /// The rounded box around one turn's words. Only the words: chips,
    /// attachments and reactions sit under it, where a picture can be its own
    /// size and a pill is not floating in a tinted rectangle.
    private let bubble = NSView()
    private let gutterStamp = NSTextField(labelWithString: "")
    private let actions = NSStackView()
    private let reactionContainer = NSStackView()
    private var tracking: NSTrackingArea?
    private var reactions: [ThreadMessageReaction]

    var onReact: ((ThreadMessage, String) -> Void)?
    var onEdit: ((ThreadMessage) -> Void)?
    var onWithdraw: ((ThreadMessage) -> Void)?
    var onSaveAsQuickNote: ((ThreadMessage) -> Void)?
    /// Mark as decision. Nil off a subject channel, where there is
    /// no subject to record it on.
    var onMarkAsDecision: ((ThreadMessage) -> Void)?
    var onReply: ((ThreadMessage) -> Void)?
    var onJumpToParent: ((String) -> Void)?
    var onQuestionSelection: ((String, Bool) -> Void)?
    var onQuestionSubmit: (() -> Void)?
    /// Nil where this workspace has no Keep: the release card then only reads.
    var onApproveRelease: ((ThreadMessage) -> Void)?
    var onEndRelease: ((ThreadMessage) -> Void)?

    /// `loadImage` is a constructor argument rather than a property because the
    /// attachment views are built here: a property set by the caller afterwards
    /// arrives too late to ever be read, which is exactly how the first version
    /// of this drew every picture as an empty box.
    init(
        message: ThreadMessage,
        grouped: Bool,
        showPersistentReactions: Bool = false,
        fromAgent: Bool = false,
        agentAvatar: AgentAvatarIdentityWire? = nil,
        hideSingleReactionCount: Bool = false,
        replyParent: ThreadMessage? = nil,
        questionAnswer: ThreadMessage? = nil,
        selectedQuestionOptionIDs: Set<String> = [],
        questionIsSubmitting: Bool = false,
        questionError: String? = nil,
        releaseBusy: Bool = false,
        releaseError: String? = nil,
        onApproveRelease: ((ThreadMessage) -> Void)? = nil,
        onEndRelease: ((ThreadMessage) -> Void)? = nil,
        loadImage: ((ThreadMessageAttachment) async -> NSImage?)? = nil,
        loadPreview: ((String) async -> LinkPreview?)? = nil,
        onOpenRef: ((ThreadMessageRef) -> Void)? = nil,
        onReply: ((ThreadMessage) -> Void)? = nil,
        onJumpToParent: ((String) -> Void)? = nil,
        selection: ThreadTextSelectionController? = nil,
        onQuestionSelection: ((String, Bool) -> Void)? = nil,
        onQuestionSubmit: (() -> Void)? = nil
    ) {
        self.message = message
        self.grouped = grouped
        self.showPersistentReactions = showPersistentReactions
        self.fromAgent = fromAgent
        self.hideSingleReactionCount = hideSingleReactionCount
        self.replyParent = replyParent
        self.questionAnswer = questionAnswer
        self.selectedQuestionOptionIDs = selectedQuestionOptionIDs
        self.questionIsSubmitting = questionIsSubmitting
        self.questionError = questionError
        self.releaseBusy = releaseBusy
        self.releaseError = releaseError
        self.onApproveRelease = onApproveRelease
        self.onEndRelease = onEndRelease
        self.reactions = message.reactions
        self.loadImage = loadImage
        self.onOpenRef = onOpenRef
        self.onReply = onReply
        self.onJumpToParent = onJumpToParent
        self.onQuestionSelection = onQuestionSelection
        self.onQuestionSubmit = onQuestionSubmit
        // A tombstone is not something somebody said, so it does not read like
        // it: same place in the transcript, visibly not a sentence. Everything
        // else is Markdown — agents answer in it, people type it, and a
        // transcript that draws the asterisks is a transcript nobody can read.
        body = message.isWithdrawn
            ? ThreadSelectableTextView(
                text: "Message withdrawn",
                font: .systemFont(ofSize: StarlingsTypography.scaled(12)).withItalics(),
                color: StarlingsColors.secondaryText
            )
            : ThreadSelectableTextView(attributed: ThreadMarkdownAppKit.attributed(
                message.text,
                font: .systemFont(ofSize: StarlingsTypography.scaled(13)),
                color: StarlingsColors.primaryText,
                mentionedEmails: message.mentions
            ))
        super.init(frame: .zero)
        wantsLayer = true

        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = message.isMine ? .trailing : .leading
        column.spacing = 3
        column.translatesAutoresizingMaskIntoConstraints = false

        if !grouped { column.addArrangedSubview(headerLine()) }
        if message.replyToMessageID != nil { column.addArrangedSubview(replyPreview()) }

        // A transcript you cannot select is a transcript you cannot quote, and
        // one whose selection stops at a message boundary is barely better —
        // the pane's controller carries a drag across every row it passes.
        body.selectionController = selection
        body.translatesAutoresizingMaskIntoConstraints = false
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = 12
        bubble.layer?.cornerCurve = .continuous
        bubble.layer?.backgroundColor = StarlingsColors.resolved(
            message.isMine ? StarlingsColors.accent.withAlphaComponent(0.14) : StarlingsColors.elevated,
            for: self
        ).cgColor
        // Still being written: a draft's edge, until the final post lands.
        if message.isPartial {
            bubble.layer?.borderWidth = 1
            bubble.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.secondaryText.withAlphaComponent(0.35), for: self).cgColor
        }
        bubble.translatesAutoresizingMaskIntoConstraints = false
        bubble.addSubview(body)
        body.pinToEdges(of: bubble, insets: NSEdgeInsets(
            top: 7, left: Self.bubblePadding, bottom: 7, right: Self.bubblePadding
        ))
        column.addArrangedSubview(bubble)
        if let question = message.question, !message.isWithdrawn {
            let questionCard = ThreadInteractiveQuestionView(
                question: question,
                askedBy: message.senderName ?? message.senderShortName,
                answer: questionAnswer,
                selectedOptionIDs: selectedQuestionOptionIDs,
                isSubmitting: questionIsSubmitting,
                error: questionError,
                onSelection: { [weak self] optionID, selected in self?.onQuestionSelection?(optionID, selected) },
                onSubmit: { [weak self] in self?.onQuestionSubmit?() }
            )
            column.addArrangedSubview(questionCard)
        }
        if let request = message.releaseRequest, !message.isWithdrawn {
            let current = message
            let releaseCard = ThreadReleaseRequestView(
                request: request,
                state: message.releaseState,
                askedBy: message.senderName ?? message.senderShortName,
                busy: releaseBusy,
                error: releaseError,
                onApprove: onApproveRelease == nil ? nil : { [weak self] in self?.onApproveRelease?(current) },
                onEnd: onEndRelease == nil ? nil : { [weak self] in self?.onEndRelease?(current) }
            )
            column.addArrangedSubview(releaseCard)
        }

        // A pasted link, read by the Worker and drawn under the words. Built
        // hidden and filled in when the answer lands, so the transcript does
        // not jump for a card that may never have anything to say.
        if !message.isWithdrawn,
           let link = ThreadMarkdown.firstPreviewableLink(in: message.text),
           let loadPreview {
            switch ThreadLinkPreviewCache.shared.entry(for: link) {
            case .nothing:
                // Already read, already nothing to say. No card, and no second
                // question about the same dead link.
                break
            case let .ready(preview):
                // Drawn in this layout pass rather than seconds into the next
                // one, so a rebuilt transcript is the height it already was.
                let card = ThreadLinkPreviewView()
                column.addArrangedSubview(card)
                card.show(preview)
            case nil:
                let card = ThreadLinkPreviewView()
                column.addArrangedSubview(card)
                Task { @MainActor [weak card] in
                    // A link that cannot be read is a link, not an error: the
                    // message is already legible and the reader has nothing to do
                    // about a site that did not answer.
                    guard let preview = await loadPreview(link) else {
                        // Read failed — not an answer. Left to expire rather
                        // than remembered as "this link has no card".
                        ThreadLinkPreviewCache.shared.failed(link)
                        return
                    }
                    // A preview with neither title nor description draws no
                    // card, so it is remembered as nothing rather than as a
                    // hidden view every future rebuild has to make again.
                    ThreadLinkPreviewCache.shared.store(
                        preview.isWorthDrawing ? preview : nil,
                        for: link
                    )
                    guard let card else { return }
                    card.show(preview)
                }
            }
        }

        for chip in refChips() { column.addArrangedSubview(chip) }
        if !message.isWithdrawn {
            for file in message.attachments { column.addArrangedSubview(attachmentRow(file)) }
        }
        reactionContainer.orientation = .vertical
        reactionContainer.alignment = message.isMine ? .trailing : .leading
        reactionContainer.spacing = 2
        column.addArrangedSubview(reactionContainer)
        updateReactionViews()

        // The stamp lives in the gutter on a grouped line, appearing on hover:
        // the time is worth having and never worth a row of its own.
        gutterStamp.stringValue = message.sentAt.meetTimeString()
        gutterStamp.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(9), weight: .regular)
        gutterStamp.textColor = StarlingsColors.secondaryText
        gutterStamp.alignment = .right
        gutterStamp.isHidden = true
        gutterStamp.translatesAutoresizingMaskIntoConstraints = false

        addSubview(gutterStamp)
        addSubview(column)
        buildActions()

        // A new turn gets a clear gap above it and a line from the same person a
        // small one: that difference is what makes a transcript scan as people
        // talking rather than as a wall of sentences.
        var constraints: [NSLayoutConstraint] = [
            column.topAnchor.constraint(equalTo: topAnchor, constant: grouped ? 2 : 10),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
            gutterStamp.topAnchor.constraint(equalTo: column.topAnchor, constant: 1),
            actions.topAnchor.constraint(equalTo: topAnchor, constant: 2),
        ]
        if message.isMine {
            constraints += [
                column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                column.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: Self.farMargin),
                // Opposite the bubble, both of them: the hover actions and the
                // grouped line's time would otherwise sit on top of the words.
                actions.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
                gutterStamp.trailingAnchor.constraint(equalTo: column.leadingAnchor, constant: -6),
            ]
        } else {
            constraints += [
                column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.gutter),
                column.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -Self.farMargin),
                actions.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                gutterStamp.trailingAnchor.constraint(equalTo: leadingAnchor, constant: Self.gutter - 10),
            ]
            if !grouped {
                let avatar = StarlingsPersonAvatarView(
                    identity: StarlingsAvatarIdentity(
                        displayName: message.senderName ?? message.senderEmail,
                        email: message.senderEmail,
                        agentAvatar: agentAvatar
                    ),
                    diameter: 26
                )
                avatar.translatesAutoresizingMaskIntoConstraints = false
                addSubview(avatar)
                constraints += [
                    avatar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
                    avatar.topAnchor.constraint(equalTo: column.topAnchor, constant: -2),
                ]
            }
        }
        NSLayoutConstraint.activate(constraints)

        setAccessibilityLabel(accessibilityLine())
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Name, time, and whether it was rewritten. Only on the first line of a
    /// turn — repeating it is what made the old transcript unreadable.
    private func headerLine() -> NSView {
        let name = NSTextField(labelWithString: message.senderShortName)
        name.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        name.textColor = StarlingsColors.primaryText

        let stamp = NSTextField(labelWithString: message.sentAt.meetTimeString())
        stamp.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(10), weight: .regular)
        stamp.textColor = StarlingsColors.secondaryText

        // Your own turns are already on your own side of the transcript, so
        // the name would be the one word on the row nobody needs.
        var views: [NSView] = message.isMine ? [stamp] : [name, stamp]
        if message.editedAt != nil, !message.isWithdrawn {
            // Said quietly beside the time rather than under the text: it is a
            // caveat on the line, not a second thing that happened.
            let edited = NSTextField(labelWithString: "edited")
            edited.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
            edited.textColor = StarlingsColors.secondaryText
            views.append(edited)
        }
        if let via = message.via {
            // The member's own message, sent by their Claude: the same quiet
            // caveat as "edited", naming the client from the server's token.
            let tag = NSTextField(labelWithString: String(localized: "via \(via)"))
            tag.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
            tag.textColor = StarlingsColors.secondaryText
            views.append(tag)
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 6
        return row
    }

    /// One flat parent preview above the reply. It is a native button only
    /// when this surface can jump inside the subject transcript.
    private func replyPreview() -> NSView {
        let content = ThreadReplyPreviewContent.resolve(replyParent)
        let title = content.text.isEmpty ? content.author : "\(content.author): \(content.text)"
        guard let parentID = message.replyToMessageID, onJumpToParent != nil else {
            let label = NSTextField(labelWithString: title)
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
            label.textColor = StarlingsColors.secondaryText
            StarlingsTypography.applyStaticLabel(label)
            label.setAccessibilityLabel(String(localized: "Reply to \(title)"))
            return label
        }
        let button = NSButton(title: title, target: self, action: #selector(replyPreviewTapped(_:)))
        button.identifier = NSUserInterfaceItemIdentifier(parentID)
        button.bezelStyle = .inline
        button.controlSize = .small
        button.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
        button.image = NSImage(systemSymbolName: "arrowshape.turn.up.left", accessibilityDescription: String(localized: "Reply"))
        button.imagePosition = .imageLeading
        button.contentTintColor = StarlingsColors.secondaryText
        button.toolTip = String(localized: "Jump to parent message")
        button.setAccessibilityLabel(String(localized: "Reply to \(title); jump to parent message"))
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        SettingsChrome.applyQuietButton(button)
        return button
    }

    @objc private func replyPreviewTapped(_ sender: NSButton) {
        guard let parentID = sender.identifier?.rawValue else { return }
        onJumpToParent?(parentID)
    }

    /// What this message points at.
    ///
    /// A button when the pane has somewhere to send it — the card in the
    /// inspector — and a plain label when it does not, because a chip that
    /// looks pressable and is not is worse than one that plainly says where
    /// the message came from.
    private func refChips() -> [NSView] {
        message.refs.map { ref in threadRefChip(ref, onOpen: onOpenRef) }
    }

    /// A file. A picture is drawn; anything else is named and sized.
    ///
    /// The box is reserved from the size the uploader measured, so a transcript
    /// does not reflow — and throw away somebody's scroll position — as each
    /// image lands. Bytes are a separate authenticated read, cached by id so a
    /// poll that rebuilds every row does not re-download the conversation.
    private func attachmentRow(_ file: ThreadMessageAttachment) -> NSView {
        guard file.contentType.hasPrefix("image/") else {
            let label = NSTextField(labelWithString: "\(file.name) · \(file.sizeDescription)")
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            label.textColor = StarlingsColors.secondaryText
            StarlingsTypography.applyStaticLabel(label)
            return label
        }

        let view = NSImageView()
        view.imageScaling = .scaleProportionallyUpOrDown
        view.wantsLayer = true
        view.layer?.cornerRadius = 8
        view.layer?.cornerCurve = .continuous
        view.layer?.masksToBounds = true
        view.layer?.borderWidth = 1
        view.layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        view.toolTip = file.name
        view.setAccessibilityLabel(file.name)
        view.translatesAutoresizingMaskIntoConstraints = false

        let width = min(CGFloat(file.width ?? 320), 320)
        let height = file.width.flatMap { w -> CGFloat? in
            guard let h = file.height, w > 0 else { return nil }
            return width * CGFloat(h) / CGFloat(w)
        } ?? 180
        NSLayoutConstraint.activate([
            view.widthAnchor.constraint(equalToConstant: max(80, width)),
            view.heightAnchor.constraint(equalToConstant: max(60, min(height, 360))),
        ])

        if let ready = ThreadAttachmentImageCache.shared.image(id: file.id) {
            view.image = ready
        } else {
            Task { [loadImage, weak view] in
                guard let image = await loadImage?(file), let view else { return }
                ThreadAttachmentImageCache.shared.store(image, id: file.id)
                view.image = image
            }
        }
        return view
    }

    /// The pills under a message: one per emoji, counted, lit when you are in
    /// it. Pressing one is the same call that made it — a toggle.
    private func reactionRail() -> NSView {
        let rail = NSStackView()
        rail.orientation = .horizontal
        rail.spacing = 4
        for reaction in reactions {
            let hideCount = hideSingleReactionCount && reaction.count == 1
            let pill = NSButton(
                title: hideCount ? "" : "\(reaction.count)",
                target: self,
                action: #selector(pillTapped(_:))
            )
            pill.bezelStyle = .inline
            pill.controlSize = .small
            pill.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            pill.image = NSImage(
                systemSymbolName: reaction.systemSymbolName,
                accessibilityDescription: reaction.accessibilityName
            )
            pill.imagePosition = hideCount ? .imageOnly : .imageLeading
            pill.imageScaling = .scaleProportionallyDown
            pill.identifier = NSUserInterfaceItemIdentifier(reaction.emoji)
            pill.toolTip = reaction.tooltip
            pill.contentTintColor = reaction.isMine ? StarlingsColors.accentMark : StarlingsColors.secondaryText
            rail.addArrangedSubview(pill)
        }
        return rail
    }

    /// Refresh only the reaction views after a toggle. Rebuilding the entire
    /// row would discard a link-preview card and start its network fetch again.
    func updateReactions(_ reactions: [ThreadMessageReaction], showPersistentReactions: Bool) {
        self.reactions = reactions
        self.showPersistentReactions = showPersistentReactions
        updateReactionViews()
        setAccessibilityLabel(accessibilityLine())
    }

    private func updateReactionViews() {
        for view in reactionContainer.arrangedSubviews {
            reactionContainer.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        if !reactions.isEmpty { reactionContainer.addArrangedSubview(reactionRail()) }
        if showPersistentReactions, !message.isWithdrawn {
            reactionContainer.addArrangedSubview(persistentReactionRail())
        }
        reactionContainer.isHidden = reactionContainer.arrangedSubviews.isEmpty
    }

    /// The quick reactions, kept visible under the latest agent answer so a
    /// member can acknowledge it in one click without finding the hover menu.
    /// Semantic symbols carry the UI; the emoji stays in the wire value.
    private func persistentReactionRail() -> NSView {
        let rail = NSStackView()
        rail.orientation = .horizontal
        rail.spacing = 2
        rail.setAccessibilityLabel(String(localized: "Message reactions"))
        for emoji in ThreadTranscript.quickReactions(fromAgent: fromAgent) {
            let button = NSButton(title: "", target: self, action: #selector(persistentReactionTapped(_:)))
            button.bezelStyle = .inline
            button.controlSize = .small
            button.image = NSImage(
                systemSymbolName: MeetingReaction.systemSymbolName(for: emoji),
                accessibilityDescription: MeetingReaction.accessibilityName(for: emoji)
            )
            button.imageScaling = .scaleProportionallyDown
            button.contentTintColor = StarlingsColors.accentMark
            button.identifier = NSUserInterfaceItemIdentifier(emoji)
            button.toolTip = String(localized: "React with \(MeetingReaction.accessibilityName(for: emoji))")
            button.setAccessibilityLabel(String(localized: "React with \(MeetingReaction.accessibilityName(for: emoji))"))
            rail.addArrangedSubview(button)
        }
        return rail
    }

    @objc private func persistentReactionTapped(_ sender: NSButton) {
        guard let emoji = sender.identifier?.rawValue else { return }
        onReact?(message, emoji)
    }

    @objc private func pillTapped(_ sender: NSButton) {
        guard let emoji = sender.identifier?.rawValue else { return }
        onReact?(message, emoji)
    }

    /// Hover actions, top-right. Hidden until the pointer is on the row: a
    /// transcript where every line carries three buttons is a toolbar with
    /// sentences in it.
    private func buildActions() {
        actions.orientation = .horizontal
        actions.spacing = 2
        actions.isHidden = true
        actions.translatesAutoresizingMaskIntoConstraints = false

        if !message.isWithdrawn {
            let react = NSButton(title: "", target: self, action: #selector(reactMenu(_:)))
            react.bezelStyle = .inline
            react.controlSize = .small
            react.image = NSImage(systemSymbolName: "face.smiling", accessibilityDescription: String(localized: "React"))
            react.imageScaling = .scaleProportionallyDown
            react.toolTip = String(localized: "React")
            react.setAccessibilityLabel(String(localized: "React"))
            actions.addArrangedSubview(react)
        }

        if onReply != nil {
            let reply = NSButton(title: "", target: self, action: #selector(replyTapped))
            reply.bezelStyle = .inline
            reply.controlSize = .small
            reply.image = NSImage(systemSymbolName: "arrowshape.turn.up.left", accessibilityDescription: String(localized: "Reply"))
            reply.imageScaling = .scaleProportionallyDown
            reply.toolTip = String(localized: "Reply")
            reply.setAccessibilityLabel(String(localized: "Reply"))
            actions.addArrangedSubview(reply)
        }

        if !message.text.isEmpty, !message.isWithdrawn {
            let copy = NSButton(title: "", target: self, action: #selector(copyTapped))
            copy.bezelStyle = .inline
            copy.controlSize = .small
            copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: String(localized: "Copy"))
            copy.imageScaling = .scaleProportionallyDown
            copy.toolTip = String(localized: "Copy")
            copy.setAccessibilityLabel(String(localized: "Copy"))
            actions.addArrangedSubview(copy)
        }

        // Editing and withdrawing are the author's, and the Worker refuses them
        // from anybody else — so offering them here would be a button that can
        // only fail. Withdrawn messages have nothing left to act on.
        if message.isMine, !message.isEvent, !message.isWithdrawn {
            let edit = NSButton(title: String(localized: "Edit"), target: self, action: #selector(editTapped))
            edit.bezelStyle = .inline
            edit.controlSize = .small
            edit.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            actions.addArrangedSubview(edit)

            let withdraw = NSButton(title: String(localized: "Withdraw"), target: self, action: #selector(withdrawTapped))
            withdraw.bezelStyle = .inline
            withdraw.controlSize = .small
            withdraw.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            actions.addArrangedSubview(withdraw)
        }
        addSubview(actions)
    }

    @objc private func reactMenu(_ sender: NSButton) {
        let menu = NSMenu()
        addReactionItems(to: menu)
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height), in: sender)
    }

    /// Right-click: the same actions the hover buttons offer, in the place a
    /// Mac user looks for them on any line of text.
    override func menu(for event: NSEvent) -> NSMenu? {
        guard !message.isWithdrawn, !message.isPartial else { return nil }
        let menu = NSMenu()
        addReactionItems(to: menu)
        menu.addItem(.separator())
        if !message.text.isEmpty {
            let copy = NSMenuItem(title: String(localized: "Copy"), action: #selector(copyTapped), keyEquivalent: "").symbol(.copy)
            copy.target = self
            menu.addItem(copy)
        }
        if onReply != nil, ThreadTranscript.isReplyable(message) {
            let reply = NSMenuItem(title: String(localized: "Reply"), action: #selector(replyTapped), keyEquivalent: "").symbol(.reply)
            reply.target = self
            menu.addItem(reply)
        }
        if onMarkAsDecision != nil, !message.text.isEmpty, !message.isEvent {
            let decide = NSMenuItem(title: String(localized: "Mark as Decision"), action: #selector(markAsDecisionTapped), keyEquivalent: "").symbol(.decide)
            decide.target = self
            menu.addItem(decide)
        }
        if message.isMine, !message.isEvent {
            if !message.text.isEmpty {
                let saveNote = NSMenuItem(
                    title: String(localized: "Save as Quick Note"),
                    action: #selector(saveAsQuickNoteTapped),
                    keyEquivalent: ""
                ).symbol(.notes)
                saveNote.target = self
                menu.addItem(saveNote)
            }
            let edit = NSMenuItem(title: String(localized: "Edit"), action: #selector(editTapped), keyEquivalent: "").symbol(.edit)
            edit.target = self
            menu.addItem(edit)
            let withdraw = NSMenuItem(title: String(localized: "Withdraw"), action: #selector(withdrawTapped), keyEquivalent: "").symbol(.delete)
            withdraw.target = self
            menu.addItem(withdraw)
        }
        return menu.items.isEmpty ? nil : menu
    }

    private func addReactionItems(to menu: NSMenu) {
        for emoji in ThreadTranscript.quickReactions(fromAgent: fromAgent) {
            let reaction = MeetingReaction(rawValue: emoji)
            let item = NSMenuItem(
                title: reaction?.accessibilityName ?? String(localized: "Custom reaction"),
                action: #selector(quickReaction(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = emoji
            if let reaction {
                item.image = NSImage(
                    systemSymbolName: reaction.systemSymbolName,
                    accessibilityDescription: reaction.accessibilityName
                )
            }
            menu.addItem(item)
        }
    }

    @objc private func quickReaction(_ sender: NSMenuItem) {
        guard let emoji = sender.representedObject as? String else { return }
        onReact?(message, emoji)
    }

    @objc private func replyTapped() { onReply?(message) }

    @objc private func copyTapped() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.text, forType: .string)
    }

    @objc private func editTapped() { onEdit?(message) }
    @objc private func withdrawTapped() { onWithdraw?(message) }
    @objc private func saveAsQuickNoteTapped() { onSaveAsQuickNote?(message) }
    @objc private func markAsDecisionTapped() { onMarkAsDecision?(message) }

    /// The bubble hugs its words, so the words need to know where to stop. The
    /// row is the only view here that knows how wide the transcript is.
    override func layout() {
        super.layout()
        let available = bounds.width - Self.gutter - Self.farMargin - Self.bubblePadding * 2 - 12
        body.maximumWidth = max(120, available)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self
        )
        addTrackingArea(area)
        tracking = area
    }

    /// The same row, longer: the streamed answer's next post. Only the words
    /// change — the byline, the face and the constraints stay — so the
    /// transcript does not rebuild, refetch every picture and flash once a
    /// second while an agent is writing. The row is finalized by a rebuild,
    /// never by this: actions and reactions belong to a finished message.
    func update(streamed message: ThreadMessage) {
        guard message.isPartial, message.id == self.message.id, message.text != self.message.text else { return }
        self.message = message
        body.setAttributed(ThreadMarkdownAppKit.attributed(
            message.text,
            font: .systemFont(ofSize: StarlingsTypography.scaled(13)),
            color: StarlingsColors.primaryText,
            mentionedEmails: message.mentions
        ))
        setAccessibilityLabel(accessibilityLine())
    }

    override func mouseEntered(with event: NSEvent) {
        // A tombstone has nothing left to react to, edit or withdraw — and a
        // message still being written is not yet anything to act on.
        actions.isHidden = message.isWithdrawn || message.isPartial
        // Only useful where the name line is not already carrying the time.
        gutterStamp.isHidden = !grouped
        // No fill: a row keeps its resting ground under the pointer
        // (DESIGN.md: a message row is not a target). The actions and the stamp
        // are the hover feedback.
    }

    override func mouseExited(with event: NSEvent) {
        actions.isHidden = true
        gutterStamp.isHidden = true
    }

    private func accessibilityLine() -> String {
        if message.isWithdrawn { return "\(message.senderShortName) withdrew a message" }
        let who = message.isMine ? String(localized: "You") : message.senderShortName
        // The rendered words, not the Markdown: VoiceOver should not read
        // asterisks aloud.
        let said = body.plainText
        let reactions = self.reactions
            .map { "\($0.accessibilityName) \($0.count)" }
            .joined(separator: ", ")
        return reactions.isEmpty ? "\(who): \(said)" : "\(who): \(said). Reactions: \(reactions)"
    }
}

/// Native, explicit controls for an agent's informational question. Meet
/// stores the selection as a human reply; this view only collects it.
@MainActor
final class ThreadInteractiveQuestionView: NSView {
    private let question: ThreadQuestion
    private let onSelection: (String, Bool) -> Void
    private let onSubmit: () -> Void
    private let isSubmitting: Bool

    init(
        question: ThreadQuestion,
        askedBy: String,
        answer: ThreadMessage?,
        selectedOptionIDs: Set<String>,
        isSubmitting: Bool,
        error: String?,
        onSelection: @escaping (String, Bool) -> Void,
        onSubmit: @escaping () -> Void
    ) {
        self.question = question
        self.onSelection = onSelection
        self.onSubmit = onSubmit
        self.isSubmitting = isSubmitting
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        applyAppearanceColors()

        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 5
        column.translatesAutoresizingMaskIntoConstraints = false

        let senderLabel = NSTextField(wrappingLabelWithString: String(localized: "Asked by \(askedBy)"))
        senderLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        senderLabel.textColor = StarlingsColors.primaryText
        column.addArrangedSubview(senderLabel)

        let prompt = NSTextField(labelWithString: String(localized: question.mode == .single ? "Choose one option" : "Choose all that apply"))
        prompt.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
        prompt.textColor = StarlingsColors.secondaryText
        column.addArrangedSubview(prompt)

        if let answer, let submitted = answer.questionAnswer {
            if answer.isWithdrawn {
                column.addArrangedSubview(NSTextField(labelWithString: String(localized: "Answer withdrawn.")))
            } else {
                let author = NSTextField(labelWithString: String(localized: "Answered by \(answer.senderShortName) at \(answer.sentAt.meetTimeString())"))
                author.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
                author.textColor = StarlingsColors.secondaryText
                column.addArrangedSubview(author)
                for label in submitted.optionLabels {
                    let chosen = NSStackView(views: [
                        NSImageView(image: NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil) ?? NSImage()),
                        NSTextField(labelWithString: label),
                    ])
                    chosen.orientation = .horizontal
                    chosen.alignment = .centerY
                    chosen.spacing = 6
                    if let icon = chosen.arrangedSubviews.first as? NSImageView { icon.contentTintColor = StarlingsColors.accent }
                    column.addArrangedSubview(chosen)
                }
            }
        } else {
            for option in question.options {
                let button = NSButton(title: option.label, target: self, action: #selector(optionSelected(_:)))
                button.setButtonType(.pushOnPushOff)
                button.bezelStyle = .regularSquare
                (button.cell as? NSButtonCell)?.wraps = true
                button.identifier = NSUserInterfaceItemIdentifier(option.id)
                button.state = selectedOptionIDs.contains(option.id) ? .on : .off
                button.controlSize = .regular
                button.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
                button.setAccessibilityLabel(option.label)
                button.isEnabled = !isSubmitting
                column.addArrangedSubview(button)
                button.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
                let bounds = (option.label as NSString).boundingRect(with: NSSize(width: 280, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], attributes: [.font: button.font!])
                button.heightAnchor.constraint(equalToConstant: max(44, ceil(bounds.height) + 24)).isActive = true
            }
            if let error, !error.isEmpty {
                let errorLabel = NSTextField(wrappingLabelWithString: error)
                errorLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
                errorLabel.textColor = StarlingsColors.danger
                errorLabel.setAccessibilityRole(.staticText)
                column.addArrangedSubview(errorLabel)
            }
            if question.mode == .single, isSubmitting {
                let status = NSTextField(labelWithString: String(localized: "Submitting…"))
                status.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
                status.textColor = StarlingsColors.secondaryText
                status.setAccessibilityRole(.staticText)
                column.addArrangedSubview(status)
            }
            if question.mode == .multiple {
                let submit = StarlingsFilledButton(
                    style: .accent,
                    title: String(localized: isSubmitting ? "Submitting…" : "Submit answer")
                )
                submit.target = self
                submit.action = #selector(submitTapped)
                submit.isEnabled = !selectedOptionIDs.isEmpty && !isSubmitting
                submit.setAccessibilityHelp(String(localized: "Your selection is sent to the agent."))
                column.addArrangedSubview(submit)
            }
        }

        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
        setAccessibilityLabel(String(localized: "Interactive question"))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyAppearanceColors()
    }

    private func applyAppearanceColors() {
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
    }

    @objc private func optionSelected(_ sender: NSButton) {
        guard let optionID = sender.identifier?.rawValue else { return }
        let selected = question.mode == .single || sender.state == .on
        onSelection(optionID, selected)
        if question.mode == .single, selected { onSubmit() }
    }

    @objc private func submitTapped() { onSubmit() }
}

/// An agent's request for one Keep item: the item, the task, why,
/// and Approve while it waits; who approved and End now once it is live.
/// The item is named, never valued.
@MainActor
final class ThreadReleaseRequestView: NSView {
    private let onApprove: (() -> Void)?
    private let onEnd: (() -> Void)?

    init(
        request: ThreadReleaseRequest,
        state: ThreadReleaseState?,
        askedBy: String,
        busy: Bool,
        error: String?,
        onApprove: (() -> Void)?,
        onEnd: (() -> Void)?
    ) {
        self.onApprove = onApprove
        self.onEnd = onEnd
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        applyAppearanceColors()

        let column = NSStackView()
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 5
        column.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(wrappingLabelWithString: ThreadReleaseCard.title(askedBy: askedBy, request: request, state: state))
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        title.textColor = StarlingsColors.primaryText
        let key = NSImageView(image: NSImage(systemSymbolName: "key", accessibilityDescription: nil) ?? NSImage())
        key.contentTintColor = StarlingsColors.secondaryText
        let head = NSStackView(views: [key, title])
        head.orientation = .horizontal
        head.alignment = .firstBaseline
        head.spacing = 6
        column.addArrangedSubview(head)

        var rows: [(String, String)] = [
            (String(localized: "Vault"), request.vault),
            (String(localized: "Task"), request.task),
            (String(localized: "Why"), request.reason),
        ]
        if let asked = ThreadReleaseCard.askedFor(request) { rows.append((String(localized: "Asked for"), asked)) }
        let grid = NSGridView(views: rows.map { label, value in
            let name = NSTextField(labelWithString: label)
            name.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            name.textColor = StarlingsColors.secondaryText
            let text = NSTextField(wrappingLabelWithString: value)
            text.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            text.textColor = StarlingsColors.primaryText
            text.preferredMaxLayoutWidth = 300
            return [name, text]
        })
        grid.columnSpacing = 10
        grid.rowSpacing = 3
        column.addArrangedSubview(grid)

        if let status = ThreadReleaseCard.status(state) {
            let line = NSTextField(wrappingLabelWithString: status)
            line.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            line.textColor = StarlingsColors.secondaryText
            line.setAccessibilityRole(.staticText)
            column.addArrangedSubview(line)
        }
        if let error, !error.isEmpty {
            let line = NSTextField(wrappingLabelWithString: error)
            line.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            line.textColor = StarlingsColors.danger
            column.addArrangedSubview(line)
        }
        if state == nil, onApprove != nil {
            let approve = StarlingsFilledButton(style: .accent, title: String(localized: "Approve…"))
            approve.target = self
            approve.action = #selector(approveTapped)
            approve.isEnabled = !busy
            column.addArrangedSubview(approve)
        } else if ThreadReleaseCard.isLive(state), onEnd != nil {
            let end = StarlingsFilledButton(style: .danger, title: busy ? String(localized: "Ending…") : String(localized: "End now"))
            end.target = self
            end.action = #selector(endTapped)
            end.isEnabled = !busy
            column.addArrangedSubview(end)
        }

        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(String(localized: "Keep request"))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyAppearanceColors()
    }

    private func applyAppearanceColors() {
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
    }

    @objc private func approveTapped() { onApprove?() }
    @objc private func endTapped() { onEnd?() }
}

/// A day boundary — "Today", "Yesterday", then the date. The one heading a
/// transcript actually needs: without it a wall of times says nothing about
/// whether a reply came back in a minute or a fortnight.
@MainActor
final class ThreadDayDividerView: NSView {
    init(date: Date) {
        super.init(frame: .zero)
        let label = NSTextField(labelWithString: Self.title(for: date))
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .semibold)
        label.textColor = StarlingsColors.secondaryText
        StarlingsTypography.applyStaticLabel(label)
        label.translatesAutoresizingMaskIntoConstraints = false

        let rule = NSBox()
        rule.boxType = .separator
        rule.translatesAutoresizingMaskIntoConstraints = false

        addSubview(rule)
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            rule.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: 10),
            rule.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            rule.centerYAnchor.constraint(equalTo: label.centerYAnchor),
        ])
        setAccessibilityLabel(Self.title(for: date))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    static func title(for date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        // Inside the last week a weekday reads faster than a date; beyond it a
        // weekday is ambiguous and a date is the only useful answer.
        if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

/// Where you left off. Drawn once, and deliberately loud — this is the line
/// somebody scrolls to find, and a subtle one makes them re-read the whole
/// conversation to be sure they have not missed anything.
@MainActor
final class ThreadUnreadDividerView: NSView {
    init() {
        super.init(frame: .zero)
        let label = NSTextField(labelWithString: String(localized: "New"))
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .semibold)
        label.textColor = StarlingsColors.primaryText
        StarlingsTypography.applyStaticLabel(label)
        label.translatesAutoresizingMaskIntoConstraints = false

        let rule = NSView()
        rule.wantsLayer = true
        rule.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.primaryText, for: self).cgColor
        rule.translatesAutoresizingMaskIntoConstraints = false

        addSubview(rule)
        addSubview(label)
        NSLayoutConstraint.activate([
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            rule.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            rule.trailingAnchor.constraint(equalTo: label.leadingAnchor, constant: -8),
            rule.centerYAnchor.constraint(equalTo: label.centerYAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),
        ])
        setAccessibilityLabel(String(localized: "New messages below"))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// One line the work graph wrote. Quiet, unattributed, and never grouped —
/// readable in the flow, never mistaken for something a person said.
@MainActor
final class ThreadEventRowView: NSView {
    init(
        message: ThreadMessage,
        onOpenRef: ((ThreadMessageRef) -> Void)? = nil,
        selection: ThreadTextSelectionController? = nil
    ) {
        super.init(frame: .zero)
        let text = ThreadSelectableTextView(
            text: message.text,
            font: .systemFont(ofSize: StarlingsTypography.scaled(11)),
            color: StarlingsColors.secondaryText
        )
        // An event line is part of the conversation, so a drag through it
        // carries it along with the messages either side.
        text.selectionController = selection
        text.translatesAutoresizingMaskIntoConstraints = false
        // The line, then what it is about: an event that names a card offers
        // the card, which is the one door a transcript has into the board.
        let line = NSStackView(views: [text] + message.refs.map { threadRefChip($0, onOpen: onOpenRef) })
        line.orientation = .vertical
        line.alignment = .leading
        line.spacing = 2
        line.translatesAutoresizingMaskIntoConstraints = false

        let stamp = NSTextField(labelWithString: message.sentAt.meetTimeString())
        stamp.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(9), weight: .regular)
        stamp.textColor = StarlingsColors.secondaryText.withAlphaComponent(0.7)
        stamp.alignment = .right
        stamp.translatesAutoresizingMaskIntoConstraints = false

        addSubview(line)
        addSubview(stamp)
        NSLayoutConstraint.activate([
            // Indented to the same column the talk uses, so an event reads as
            // part of the conversation rather than as chrome around it.
            text.widthAnchor.constraint(equalTo: line.widthAnchor),
            line.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 40),
            // Equal, not at-most: the text view wraps to a width it is given,
            // so the column has to be a fixed one.
            line.trailingAnchor.constraint(equalTo: stamp.leadingAnchor, constant: -8),
            line.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            line.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            stamp.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            stamp.firstBaselineAnchor.constraint(equalTo: text.firstBaselineAnchor),
        ])
        setAccessibilityLabel("\(message.senderName ?? String(localized: "Starlings")): \(message.text)")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// An agent's steps on the way to an answer, folded to one line — "3 steps"
/// — that opens into the lines themselves. Quiet, in the event column, so
/// the trail and the working row above it read as one voice; and folded by
/// default, because a transcript that keeps every step at full height is a
/// log with a conversation buried in it.
@MainActor
final class ThreadTrailRowView: NSView {
    init(steps: [ThreadMessage], open: Bool, onToggle: @escaping () -> Void) {
        super.init(frame: .zero)
        let count = steps.count
        let title = count == 1
            ? String(localized: "1 step")
            : String(localized: "\(count) steps")
        let toggle = ThreadTrailToggleButton(title: title, onToggle: onToggle)
        toggle.image = NSImage(systemSymbolName: open ? "chevron.down" : "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        toggle.imagePosition = .imageLeading
        SettingsChrome.applyQuietButton(toggle)
        toggle.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        toggle.contentTintColor = StarlingsColors.secondaryText
        toggle.setAccessibilityLabel(open ? String(localized: "Hide steps") : String(localized: "Show steps"))
        toggle.translatesAutoresizingMaskIntoConstraints = false

        let column = NSStackView(views: [toggle])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 3
        column.translatesAutoresizingMaskIntoConstraints = false
        if open {
            for step in steps {
                let line = NSTextField(wrappingLabelWithString: step.text)
                line.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
                line.textColor = StarlingsColors.secondaryText
                line.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                let stamp = NSTextField(labelWithString: step.sentAt.meetTimeString())
                stamp.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(9), weight: .regular)
                stamp.textColor = StarlingsColors.secondaryText.withAlphaComponent(0.7)
                stamp.setContentHuggingPriority(.required, for: .horizontal)
                let row = NSStackView(views: [line, stamp])
                row.orientation = .horizontal
                row.alignment = .firstBaseline
                row.spacing = 8
                column.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
            }
        }

        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 40),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),
        ])
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// The fold's button, holding its own closure so no lookup table sits
/// between a click and the trail it opens.
@MainActor
private final class ThreadTrailToggleButton: NSButton {
    private let onToggle: () -> Void

    init(title: String, onToggle: @escaping () -> Void) {
        self.onToggle = onToggle
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .inline
        target = self
        action = #selector(pressed)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func pressed() { onToggle() }
}

/// One ref, as a chip. Pressable only when there is somewhere to go, and then
/// it reads as a link — accent ink, pointing hand, a tooltip saying where —
/// because a quiet grey chip was not read as something that opens the issue.
@MainActor
func threadRefChip(_ ref: ThreadMessageRef, onOpen: ((ThreadMessageRef) -> Void)?) -> NSView {
    let title = ref.chipTitle
    guard let onOpen, ref.isOpenable else {
        let chip = NSTextField(labelWithString: title)
        chip.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        chip.textColor = StarlingsColors.secondaryText
        StarlingsTypography.applyStaticLabel(chip)
        chip.setContentHuggingPriority(.required, for: .horizontal)
        return chip
    }
    let button = ThreadRefButton(title: title, ref: ref, onOpen: onOpen)
    SettingsChrome.applyQuietButton(button)
    // The same lift again, with the hand a link shows.
    button.applyMeetHoverLift(cornerRadius: 6, cursor: .pointingHand)
    // The colour a link in a message already has (`ThreadMarkdownAppKit`).
    button.attributedTitle = NSAttributedString(string: title, attributes: [
        .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium),
        .foregroundColor: StarlingsColors.accentMark,
    ])
    button.toolTip = ref.openLabel
    button.setAccessibilityLabel(ref.openLabel)
    button.setContentHuggingPriority(.required, for: .horizontal)
    return button
}

/// A chip that remembers its ref, so no lookup table sits between a click
/// and the card it opens.
@MainActor
private final class ThreadRefButton: NSButton {
    private let ref: ThreadMessageRef
    private let onOpen: (ThreadMessageRef) -> Void

    init(title: String, ref: ThreadMessageRef, onOpen: @escaping (ThreadMessageRef) -> Void) {
        self.ref = ref
        self.onOpen = onOpen
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .inline
        target = self
        action = #selector(pressed)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func pressed() { onOpen(ref) }
}

private extension NSFont {
    func withItalics() -> NSFont {
        NSFontManager.shared.convert(self, toHaveTrait: .italicFontMask)
    }
}

/// Pictures already fetched, on the main actor.
///
/// The transcript rebuilds every row on every poll, so without this a
/// conversation with images would re-download itself every four seconds.
/// Keyed by attachment id, which is minted once and never reused — so a hit is
/// always the right bytes, and there is no version to get wrong.
@MainActor
final class ThreadAttachmentImageCache {
    static let shared = ThreadAttachmentImageCache()

    private static let maximumEntries = 64
    private var images: [String: NSImage] = [:]
    private var order: [String] = []

    func image(id: String) -> NSImage? { images[id] }

    func store(_ image: NSImage, id: String) {
        if images[id] == nil { order.append(id) }
        images[id] = image
        while order.count > Self.maximumEntries {
            images.removeValue(forKey: order.removeFirst())
        }
    }
}

/// Link cards already answered, on the main actor.
///
/// Same reason as `ThreadAttachmentImageCache`, and the same fix. The
/// transcript rebuilds every row whenever anything in the conversation
/// changes, and without this each rebuild asked the Worker to read every link
/// in the thread again. Every answer then landed *after* the layout pass,
/// grew the transcript, and dragged the reader's position with it — which is
/// what opening a conversation full of links looked like from the outside.
///
/// A link the Worker had nothing to say about is remembered too: forgetting it
/// means asking about the same dead link every four seconds forever.
@MainActor
final class ThreadLinkPreviewCache {
    enum Entry {
        case ready(LinkPreview)
        /// Read, and no card came of it: a page with neither title nor
        /// description. Settled — the page will not grow one while this
        /// window is open.
        case nothing
    }

    static let shared = ThreadLinkPreviewCache()

    private static let maximumEntries = 128
    /// How long a link that could not be read is left alone. Long enough that a
    /// rate limit or a site having a bad minute is not re-asked on every
    /// rebuild; short enough that it heals without a relaunch.
    private static let retryAfter: TimeInterval = 120

    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    /// Links that failed, and when they may be asked about again. Kept apart
    /// from `entries` because a failure is not an answer — treating it as one
    /// is how a single 429 turns into a thread with no cards until relaunch.
    private var failures: [String: Date] = [:]

    func entry(for url: String) -> Entry? {
        if let entry = entries[url] { return entry }
        // A failure still inside its cooling-off period reads as "no card,
        // don't ask" — the same shape as `nothing`, but it expires.
        if let until = failures[url] {
            if until > Date() { return .nothing }
            failures.removeValue(forKey: url)
        }
        return nil
    }

    /// A preview that came back. `nil` means the page was read and had nothing
    /// worth drawing — settled, not a failure.
    func store(_ preview: LinkPreview?, for url: String) {
        failures.removeValue(forKey: url)
        if entries[url] == nil { order.append(url) }
        entries[url] = preview.map(Entry.ready) ?? .nothing
        while order.count > Self.maximumEntries {
            let evicted = order.removeFirst()
            entries.removeValue(forKey: evicted)
        }
    }

    /// The link could not be read: the Worker refused it, the site did not
    /// answer, or we asked too often. Try again later, not next frame.
    func failed(_ url: String) {
        failures[url] = Date().addingTimeInterval(Self.retryAfter)
    }
}

/// The pictures on those cards, kept for the same reason: a rebuilt card gets
/// its height in the layout pass that builds it instead of a second later.
/// Keyed by the signed Meet address the Worker minted, which names the bytes.
@MainActor
final class ThreadLinkPictureCache {
    static let shared = ThreadLinkPictureCache()

    private static let maximumEntries = 64
    private var images: [URL: NSImage] = [:]
    private var order: [URL] = []

    func image(for url: URL) -> NSImage? { images[url] }

    func store(_ image: NSImage, for url: URL) {
        if images[url] == nil { order.append(url) }
        images[url] = image
        while order.count > Self.maximumEntries {
            images.removeValue(forKey: order.removeFirst())
        }
    }
}

/// The card under a message that carries a link.
///
/// The Mac never reads the linked page — the Worker does, and answers the text.
/// See `LinkPreview` for why. Every string here goes into a label: a preview is
/// metadata written by whoever owns the page at the other end of a link
/// somebody pasted, which makes it the least trustworthy text on screen, and it
/// is never anything but text on its way here.
///
/// Starts hidden and stays hidden unless there is something to say. A link
/// whose page offers no title and no description leaves the transcript as it
/// was rather than adding a card that only repeats the domain the URL shows.
final class ThreadLinkPreviewView: NSView {
    private let site = NSTextField(labelWithString: "")
    private let title = StarlingsTypography.wrappingLabel("")
    private let summary = StarlingsTypography.wrappingLabel("")
    private let rule = NSView()
    private var target: URL?
    /// The page's picture. Hidden until one arrives, so a card with none is
    /// the same card it always was.
    private let picture = NSImageView()
    private var pictureHeight: NSLayoutConstraint?
    /// Active only while a picture is actually drawn — see the note where it
    /// is built.
    private var pictureRatio: NSLayoutConstraint?
    /// Which address the current fetch is for, so a card recycled onto another
    /// message cannot be painted by the picture the last one asked for.
    private var pictureSource: URL?

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        isHidden = true
        layer?.cornerRadius = 10
        layer?.cornerCurve = .continuous

        site.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .semibold)
        site.textColor = StarlingsColors.secondaryText
        site.lineBreakMode = .byTruncatingTail

        title.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        title.textColor = StarlingsColors.primaryText
        title.maximumNumberOfLines = 2

        summary.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        summary.textColor = StarlingsColors.secondaryText
        // Two lines is a summary; more is the article, and the article has its
        // own page — which this card is a door to, not a copy of.
        summary.maximumNumberOfLines = 2

        rule.wantsLayer = true
        rule.layer?.cornerRadius = 1.5
        rule.translatesAutoresizingMaskIntoConstraints = false

        picture.wantsLayer = true
        picture.imageScaling = .scaleProportionallyUpOrDown
        picture.layer?.cornerRadius = 6
        picture.layer?.cornerCurve = .continuous
        picture.layer?.masksToBounds = true
        picture.isHidden = true
        picture.translatesAutoresizingMaskIntoConstraints = false
        // A fixed box rather than the picture's own shape: a transcript that
        // reflowed as each one landed would throw away the reader's place,
        // which is the one thing a message list must not do. 1.91:1 is the
        // ratio publishers cut an og:image to.
        let height = picture.heightAnchor.constraint(equalToConstant: 0)
        height.isActive = true
        pictureHeight = height
        // Tied to the card's own width rather than measured off `bounds` — a
        // card drawn from cache is built before it has ever been laid out, and
        // a constant taken from a zero width is a picture with no height.
        pictureRatio = picture.heightAnchor.constraint(
            equalTo: picture.widthAnchor,
            multiplier: 1 / 1.91
        )

        let text = NSStackView(views: [picture, site, title, summary])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        text.translatesAutoresizingMaskIntoConstraints = false

        addSubview(rule)
        addSubview(text)
        NSLayoutConstraint.activate([
            rule.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 1),
            rule.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            rule.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
            rule.widthAnchor.constraint(equalToConstant: 3),
            text.leadingAnchor.constraint(equalTo: rule.trailingAnchor, constant: 8),
            text.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            picture.widthAnchor.constraint(equalTo: text.widthAnchor),
            text.topAnchor.constraint(equalTo: topAnchor, constant: 7),
            text.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -7),
            // Bounded, so a one-line message is not followed by a card three
            // times its width on a wide window.
            widthAnchor.constraint(lessThanOrEqualToConstant: 420),
        ])
        recolour()

        let click = NSClickGestureRecognizer(target: self, action: #selector(openTarget))
        addGestureRecognizer(click)
        // A card, not the row it sits in, so it lifts. Off until `show` gives
        // it somewhere to go.
        applyMeetHoverLift(base: StarlingsColors.elevated).isEnabled = false
    }

    /// The transcript scrolls and rebuilds under a still pointer.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        meetHoverMonitor?.resync()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        recolour()
    }

    private func recolour() {
        let ground = StarlingsColors.resolved(StarlingsColors.elevated, for: self)
        let hovered = meetHoverMonitor?.isHovered ?? false
        layer?.backgroundColor = (hovered ? StarlingsColors.lifted(ground) : ground).cgColor
        rule.layer?.backgroundColor = StarlingsColors.resolved(
            StarlingsColors.accent.withAlphaComponent(0.55),
            for: self
        ).cgColor
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        if target != nil { addCursorRect(bounds, cursor: .pointingHand) }
    }

    func show(_ preview: LinkPreview) {
        guard preview.isWorthDrawing, let url = URL(string: preview.url) else { return }
        target = url
        site.stringValue = preview.label
        title.stringValue = preview.title ?? ""
        title.isHidden = (preview.title ?? "").isEmpty
        summary.stringValue = preview.description ?? ""
        summary.isHidden = (preview.description ?? "").isEmpty
        setAccessibilityLabel("\(preview.label): \(preview.title ?? preview.url)")
        isHidden = false
        meetHoverMonitor?.isEnabled = true
        window?.invalidateCursorRects(for: self)
        showPicture(preview)
    }

    /// Fetch and draw the page's picture, if it has one.
    ///
    /// The address is Meet's, not the publisher's — see `LinkPreview.imageURL`
    /// — so this is an ordinary fetch of our own origin and tells the site
    /// nothing. A failure is left as no picture: the card is already legible
    /// and there is nothing the reader could do about a picture that did not
    /// arrive.
    private func showPicture(_ preview: LinkPreview) {
        guard let source = preview.image else {
            pictureSource = nil
            clearPicture()
            return
        }
        guard source != pictureSource else { return }
        pictureSource = source
        picture.setAccessibilityLabel(preview.imageAlt ?? "")

        if let ready = ThreadLinkPictureCache.shared.image(for: source) {
            drawPicture(ready)
            return
        }
        clearPicture()

        Task { @MainActor [weak self] in
            let data = try? await URLSession.shared.data(from: source).0
            guard let self, pictureSource == source else { return }
            guard let data, let image = NSImage(data: data) else { return }
            ThreadLinkPictureCache.shared.store(image, for: source)
            drawPicture(image)
        }
    }

    /// Reserved once the picture exists rather than up front: a card whose
    /// picture never arrives should not keep a hole where it was.
    private func drawPicture(_ image: NSImage) {
        picture.image = image
        picture.isHidden = false
        pictureHeight?.isActive = false
        pictureRatio?.isActive = true
    }

    private func clearPicture() {
        picture.image = nil
        picture.isHidden = true
        pictureRatio?.isActive = false
        pictureHeight?.isActive = true
        pictureHeight?.constant = 0
    }

    @objc private func openTarget() {
        guard let target else { return }
        NSWorkspace.shared.open(target)
    }
}
