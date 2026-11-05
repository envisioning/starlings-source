import AppKit
import KeepKit
import StarlingsContracts
import SwiftUI

/// One conversation, in the Work or Team destination. AppKit like the rest of the Mac UI
/// (AGENTS.md: Mac UI is AppKit only) — a transcript that grows downward, and a
/// composer pinned under it.
///
/// Delivery is polling while the pane is showing a thread. There is no socket
/// and no push yet, so an unopened destination window receives nothing.
///
/// **This draws no header.** The owning destination window names the conversation above the
/// tabs, and a pane that also named it produced the same person twice on one
/// screen — the two labels disagreed about who was hiding them. One owner, and
/// the transcript gets the height back.
@MainActor
final class ThreadPaneView: NSView {
    private let api: MeetingControlAPI
    private let scrollView = NSScrollView()
    private let stack = NSStackView()
    /// Selection across the whole transcript rather than inside one message —
    /// see `ThreadTextSelection.swift`. Owned here because it is the pane, not
    /// a row, that knows the document order a drag runs through.
    private let selection = ThreadTextSelectionController()
    private let composer = ThreadComposerView()
    private let emptyLabel = NSTextField(labelWithString: String(localized: "Pick somebody to write to."))
    /// The agent's front door: its self-reported manifest, drawn where the empty
    /// transcript otherwise shows one bare line. Populated only for an agent
    /// whose runtime serves a manifest; everything else keeps the label.
    private let agentCard = NSStackView()
    private let jumpButton = NSButton(title: String(localized: "Jump to latest"), target: nil, action: nil)
    private let noticeLabel = StarlingsNoticeView()
    private let attachmentTray = NSStackView()
    private let composerExtras = NSStackView()
    private let replyContext = NSStackView()

    /// Called when the open conversation changes, so the window title can name
    /// it. The pane knows what is on screen; the window owns its own title.
    var onConversationChange: ((ThreadAddress?) -> Void)?
    /// The summary the server answered for the conversation just opened. The
    /// owning window reads the channel's forwarding address off it.
    var onThreadLoaded: ((ThreadSummary) -> Void)?
    /// The open conversation was just read up to its newest line. The owner
    /// clears its unread dot at once, rather than at the thread list's next
    /// poll, which may land after this read and paint it back.
    var onThreadRead: ((String) -> Void)?
    /// A ref chip was clicked. The pane knows nothing about cards; whoever
    /// owns the inspector does.
    var onOpenRef: ((ThreadMessageRef) -> Void)?
    /// The pane wants the roster re-read now. Called on each thread poll while
    /// a turn with an agent is open, because the window's 30s roster poll is
    /// too slow to catch a run that answers in a few seconds.
    var onRosterWanted: (() -> Void)?
    /// A new note made from this pane; the owning window refreshes Work and
    /// Home's private Quick Notes list.
    var onQuickNoteSaved: ((QuickNote) -> Void)?
    /// The rows on screen, by message id, so a card's door can land on its line.
    private var rowsByMessageID: [String: NSView] = [:]
    private var quickNoteMessageIDsInFlight: Set<String> = []
    /// A line asked for before the transcript had it. Answered after the next
    /// page lands, then forgotten.
    private var pendingReveal: String?
    /// Where a permalink asked to land, held until the transcript has it
    ///. Answered once, then forgotten.
    private var pendingFocus: MessageFocus?

    /// Who `@` may name here. Set from the roster the window already polls —
    /// the composer answers completion locally, so naming a colleague costs
    /// nothing and works with the network down.
    ///
    /// The same roster is kept so the pane can read the working state of
    /// whichever agent it is showing — one source of truth, the roster the
    /// window already has, rather than a second signal invented here.
    func setMentionable(_ people: [Peer]) {
        roster = people
        composer.mentionable = people
            .filter { !$0.isSelf }
            .map { ThreadComposerView.Mentionable(email: $0.email) }
        // Two things ride the roster poll: the agent's manifest (its card fills
        // in when the manifest lands on a later poll, without reopening the
        // conversation) and its working state (the transient row appears or
        // clears as the agent starts or stops). Both live on the peer, not in a
        // page of messages, so refresh here rather than on the message poll.
        var needsRender = false
        if let address, agentCardPeer(for: address) != agentCardShownPeer {
            renderAgentCard(for: address)
            needsRender = true
        }
        if shouldShowWorkingRow() != workingRowShown { needsRender = true }
        if persistentReactionMessageID() != persistentReactionMessageShown { needsRender = true }
        if needsRender { render() }
    }

    /// The roster the window last handed over, kept so the pane can read the
    /// manifest and the working state of whichever agent it is showing. Only the
    /// addressed peer is ever read out of it.
    private var roster: [Peer] = []
    /// The agent whose card is currently built, so a redundant rebuild is cheap
    /// to skip. Nil when the open conversation is a person, a channel, or an
    /// agent with no manifest.
    private var agentCardShownPeer: Peer?
    /// Whether the transient "working…" row is currently in the transcript, so a
    /// roster poll that does not change it costs no rebuild.
    private var workingRowShown = false
    /// Which agent answer currently has its quick-reaction rail exposed, so a
    /// roster poll can redraw when the agent identity arrives after the thread.
    private var persistentReactionMessageShown: String?
    /// Trails the reader unfolded, by their first step's id. Collapsed is the
    /// default; a click is a choice, and it survives the next poll's rebuild.
    private var openTrails: Set<String> = []
    /// Question drafts live with the pane so polling and row rebuilding leave
    /// choices intact until a person explicitly submits them.
    private var questionSelections: [String: Set<String>] = [:]
    private var submittingQuestionIDs: Set<String> = []
    private var questionErrors: [String: String] = [:]
    /// Keep release cards with an act in flight, and the last error per card.
    private var releaseBusyIDs: Set<String> = []
    private var releaseErrors: [String: String] = [:]

    private var address: ThreadAddress?
    private var thread: ThreadSummary?
    private var messages: [ThreadMessage] = []
    private var olderCursor: String?
    private var initializedOlderCursor = false
    /// Async work belongs to the conversation that started it. Opening another
    /// address invalidates every response still in flight, so a slow page from
    /// the previous conversation cannot be merged into this transcript.
    private var conversationGeneration = 0
    private var pollTask: Task<Void, Never>?
    /// Where the reader left off, captured when the conversation opens and held
    /// still afterwards. Re-deriving it from each poll would move the marker
    /// every four seconds, which is a marker that has never once been where
    /// somebody stopped reading.
    private var unreadBoundary: Date?
    /// True while the transcript is at the bottom. A poll that arrives while
    /// somebody is reading history must not yank them back down.
    ///
    /// **The bottom is a place, not a scroll position.** The clip view is not
    /// flipped, so `y == 0` is the end of the conversation: a short transcript
    /// rests on the composer by itself, and a transcript that grows — a page
    /// landing, a bubble re-wrapping, an image or a link card arriving late —
    /// grows *upward* while the viewport stays put. Nothing has to scroll to
    /// the end after a layout pass, so nothing is hidden while it does, and
    /// there is no settling to see. Every flag that used to guard that
    /// settling is gone with it.
    private var followsLatest = true
    /// The document's height as of the last frame change, so a reader who is
    /// up in history is held on the same lines when something lands below.
    private var documentHeight: CGFloat = 0
    /// The message being rewritten, if any. Nil is the ordinary composer.
    private var editing: ThreadMessage?
    private var replyDraft = ThreadReplyDraft()
    /// Files staged and uploaded, waiting for the message that will carry them.
    /// Held here rather than in the composer because an upload survives the
    /// text being cleared and retyped.
    private var pendingAttachments: [ThreadMessageAttachment] = []
    private var uploading = 0
    /// Collapsed to nothing while there is nothing to say. A hidden label still
    /// occupies its line in Auto Layout, and a permanent empty strip above the
    /// composer is exactly the wasted height this rewrite exists to reclaim.
    private var noticeHeight: NSLayoutConstraint?

    init(api: MeetingControlAPI) {
        self.api = api
        super.init(frame: .zero)
        wantsLayer = true

        emptyLabel.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(12))
        emptyLabel.textColor = StarlingsColors.secondaryText
        emptyLabel.alignment = .center
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        noticeLabel.hidesWhenEmpty = false
        noticeLabel.isHidden = true
        noticeLabel.label.allowSqueezing()

        attachmentTray.orientation = .horizontal
        attachmentTray.spacing = 6
        attachmentTray.isHidden = true
        attachmentTray.translatesAutoresizingMaskIntoConstraints = false

        replyContext.orientation = .horizontal
        replyContext.alignment = .centerY
        replyContext.spacing = 6
        replyContext.isHidden = true
        replyContext.translatesAutoresizingMaskIntoConstraints = false
        composerExtras.orientation = .vertical
        composerExtras.alignment = .leading
        composerExtras.spacing = 4
        composerExtras.translatesAutoresizingMaskIntoConstraints = false
        composerExtras.addArrangedSubview(replyContext)
        composerExtras.addArrangedSubview(attachmentTray)

        // Anywhere in the pane takes a file, not only the composer: aiming at
        // a one-line box is a worse target than the conversation itself.
        registerForDraggedTypes([.fileURL])

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 0
        stack.distribution = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .noBorder
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.contentView.drawsBackground = false
        scrollView.documentView = stack
        selection.container = stack
        scrollView.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(scrolled),
            name: NSView.boundsDidChangeNotification,
            object: scrollView.contentView
        )
        // A reader up in history is held still when the transcript grows
        // under them; a reader at the end needs nothing, the end stays where
        // it is.
        stack.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(documentResized),
            name: NSView.frameDidChangeNotification,
            object: stack
        )

        composer.onSend = { [weak self] text, mentions in self?.submit(text, mentions: mentions) }
        composer.onAttach = { [weak self] urls in self?.attach(urls) }
        composer.onPasteAndSend = { [weak self] text, mentions in self?.sendAlone(text, mentions: mentions) }
        composer.onEditLast = { [weak self] in self?.beginEditingLast() }
        composer.onCancel = { [weak self] in self?.cancelEditing() ?? false }
        composer.translatesAutoresizingMaskIntoConstraints = false

        SettingsChrome.applySecondaryButton(jumpButton, title: String(localized: "Jump to latest"), height: 24)
        jumpButton.target = self
        jumpButton.action = #selector(jumpTapped)
        jumpButton.isHidden = true
        jumpButton.translatesAutoresizingMaskIntoConstraints = false

        agentCard.orientation = .vertical
        agentCard.alignment = .leading
        agentCard.spacing = 8
        agentCard.translatesAutoresizingMaskIntoConstraints = false
        agentCard.isHidden = true

        addSubview(scrollView)
        addSubview(composer)
        addSubview(jumpButton)
        addSubview(noticeLabel)
        addSubview(composerExtras)
        addSubview(emptyLabel)
        addSubview(agentCard)

        let noticeCollapse = noticeLabel.heightAnchor.constraint(equalToConstant: 0)
        noticeHeight = noticeCollapse

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: noticeLabel.topAnchor, constant: -4),
            stack.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor),

            noticeLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            noticeLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
            noticeLabel.bottomAnchor.constraint(equalTo: composerExtras.topAnchor, constant: -4),
            noticeCollapse,

            composerExtras.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            composerExtras.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            composerExtras.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -6),
            replyContext.widthAnchor.constraint(equalTo: composerExtras.widthAnchor),

            composer.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            composer.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            composer.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),

            jumpButton.centerXAnchor.constraint(equalTo: centerXAnchor),
            jumpButton.bottomAnchor.constraint(equalTo: composerExtras.topAnchor, constant: -10),

            emptyLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: centerYAnchor),

            agentCard.centerXAnchor.constraint(equalTo: centerXAnchor),
            agentCard.centerYAnchor.constraint(equalTo: centerYAnchor),
            agentCard.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            agentCard.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
            agentCard.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
        ])

        // A conversation is a column of text, not a document with a width of
        // its own. Everything in here yields horizontally so the pane can be
        // squeezed by the inspector rather than pushing the window wider —
        // see `StarlingsShellViewController`'s note on the middle column.
        for host in [self, scrollView, stack, composer, noticeLabel, composerExtras] as [NSView] {
            host.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            host.setContentHuggingPriority(.defaultLow, for: .horizontal)
        }

        showEmpty(true)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// A conversation, named by an address rather than by a person: the thread
    /// does not exist until the Worker answers, and a channel is addressed by
    /// its subject rather than by anybody. See `ThreadAddress`.
    func show(_ address: ThreadAddress) {
        if address == self.address {
            // Clicking the already-open row is still opening the conversation
            // from the user's point of view: back to the latest. The parent
            // surface may have stopped this pane while its window was away,
            // so reopening the same address must also refresh and resume its
            // delivery loop.
            scrollToBottom()
            resume()
            return
        }
        stop()
        conversationGeneration += 1
        let generation = conversationGeneration
        self.address = address
        thread = nil
        messages = []
        olderCursor = nil
        initializedOlderCursor = false
        unreadBoundary = nil
        followsLatest = true
        editing = nil
        replyDraft.cancel()
        pendingAttachments = []
        uploading = 0
        pendingReveal = nil
        pendingFocus = nil
        openTrails = []
        questionSelections = [:]
        submittingQuestionIDs = []
        questionErrors = [:]
        releaseBusyIDs = []
        releaseErrors = [:]
        renderAttachmentTray()
        renderReplyContext()
        renderAgentCard(for: address)
        composer.placeholderText = address.prompt
        composer.text = ""
        emptyLabel.stringValue = address.emptyLine
        showEmpty(false)
        onConversationChange?(address)

        Task { [weak self] in
            guard let self else { return }
            do {
                let summary = try await self.api.openThread(address)
                guard self.conversationGeneration == generation else { return }
                self.thread = summary
                self.onThreadLoaded?(summary)
                // Opened by hand: into the device's recents, the list Home's
                // Quick Access module and the ⌘K palette share.
                SearchRecents.remember(.thread(summary), owner: self.api.signedInOwnerEmail ?? "")
                // Captured once, before the first page lands.
                self.unreadBoundary = summary.unread ? (summary.lastReadAt ?? .distantPast) : nil
                await self.reload(expectedGeneration: generation)
                guard self.conversationGeneration == generation else { return }
                if let pending = self.pendingReveal { self.reveal(messageID: pending) }
                self.resolveFocus()
                self.startPolling(generation: generation)
            } catch {
                guard self.conversationGeneration == generation else { return }
                self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t open that conversation"))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Resume delivery when the owning surface returns. Its thread list may
    /// have announced a message while this pane's window was closed; read now
    /// instead of waiting for the next timer tick (or for the conversation to
    /// be closed and opened again).
    func resume() {
        guard address != nil, thread != nil else { return }
        let generation = conversationGeneration
        startPolling(generation: generation)
        Task { [weak self] in
            await self?.reload(expectedGeneration: generation)
        }
    }

    /// Land on a line the way a permalink does: scrolled to it and flashed
    /// once. `.newest` is the line a Home row or a banner previewed. Asked
    /// right after `show`; a conversation still opening answers it when its
    /// first page lands.
    func focus(_ target: MessageFocus) {
        pendingFocus = target
        if thread != nil, !messages.isEmpty { resolveFocus() }
    }

    private func resolveFocus() {
        guard let target = pendingFocus, thread != nil, !messages.isEmpty else { return }
        pendingFocus = nil
        switch target {
        case .newest:
            guard let last = messages.last(where: { !$0.isPartial }) ?? messages.last else { return }
            scrollToBottom()
            flash(messageID: last.id)
        case let .message(id):
            jump(to: id) { [weak self] in self?.flash(messageID: id) }
        }
    }

    /// A brief wash of the accent behind one line, fading out. The rows are
    /// rebuilt on every render, so this paints on whatever row stands now.
    private func flash(messageID: String) {
        guard let row = rowsByMessageID[messageID] else { return }
        row.wantsLayer = true
        guard let layer = row.layer else { return }
        let wash = StarlingsColors.accent.withAlphaComponent(0.28)
        var resolved = wash.cgColor
        row.effectiveAppearance.performAsCurrentDrawingAppearance { resolved = wash.cgColor }
        let fade = CABasicAnimation(keyPath: "backgroundColor")
        fade.fromValue = resolved
        fade.toValue = NSColor.clear.cgColor
        fade.duration = 1.8
        fade.timingFunction = CAMediaTimingFunction(name: .easeIn)
        layer.add(fade, forKey: "permalinkFlash")
    }

    /// Scroll to one line and stay there. Asked by a card on the board, whose
    /// last event this is. A line not on screen yet — the conversation is
    /// still opening, or the line is older than the first page — waits for
    /// the next render rather than being forgotten.
    func reveal(messageID: String) {
        guard let row = rowsByMessageID[messageID] else {
            pendingReveal = messageID
            return
        }
        pendingReveal = nil
        followsLatest = false
        layoutSubtreeIfNeeded()
        _ = scrollView.contentView.scrollToVisible(row.frame.insetBy(dx: 0, dy: -24))
        jumpButton.isHidden = false
    }

    private func startPolling(generation: Int) {
        guard pollTask == nil, conversationGeneration == generation else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                // A second while a turn with an agent is open, four while the
                // app is active, thirty while it is behind another app: steps
                // and streamed text are worth reading as they land; a pane
                // nobody is looking at is not. An occluded window sleeps
                // through the tick and reads on the next one it is seen for.
                let cadence: TimeInterval = if self?.awaitingAgent() == true {
                    DirectMessageCadence.agentTurnPoll
                } else if NSApp.isActive {
                    DirectMessageCadence.openThreadPoll
                } else {
                    DirectMessageCadence.backgroundThreadPoll
                }
                try? await Task.sleep(for: .seconds(cadence))
                guard let self, !Task.isCancelled, self.conversationGeneration == generation else { return }
                guard self.window?.occlusionState.contains(.visible) ?? false else { continue }
                await self.reload(expectedGeneration: generation)
                guard !Task.isCancelled, self.conversationGeneration == generation else { return }
                if self.awaitingAgent() { self.onRosterWanted?() }
            }
        }
    }

    /// Coming back to the app after a background stretch reads at once rather
    /// than waiting out a thirty-second tick.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self, name: NSApplication.didBecomeActiveNotification, object: nil)
        guard window != nil else { return }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    /// A pane whose window went away (another tab, minimised) stopped
    /// polling; coming back to the app starts it again.
    @objc private func appDidBecomeActive() {
        guard window?.occlusionState.contains(.visible) ?? false else { return }
        if pollTask == nil {
            resume()
        } else {
            Task { [weak self] in await self?.reload() }
        }
    }

    private func reload(expectedGeneration: Int? = nil) async {
        let generation = expectedGeneration ?? conversationGeneration
        guard conversationGeneration == generation else { return }
        guard let thread else { return }
        do {
            let page = try await api.messages(threadID: thread.id)
            guard conversationGeneration == generation, self.thread?.id == thread.id else { return }
            if !initializedOlderCursor {
                olderCursor = page.olderCursor
                initializedOlderCursor = true
            }
            if merge(page.messages) { render() }
            if page.thread.unread {
                try? await api.markThreadRead(threadID: thread.id)
            }
            onThreadRead?(thread.id)
        } catch {
            // A dropped poll is not worth a visible error; the next one is 4s away.
        }
    }

    /// Find an older parent by following the same cursor the transcript's
    /// Load earlier control uses. Pages stay flat and in chronological order.
    private func jumpToParent(messageID: String) {
        guard address?.supportsMessageReplies == true else { return }
        jump(to: messageID)
    }

    /// Bring older pages in until the line is on screen, then reveal it.
    /// `done` runs once it is.
    private func jump(to messageID: String, done: (() -> Void)? = nil) {
        guard let thread else { return }
        if rowsByMessageID[messageID] != nil {
            reveal(messageID: messageID)
            done?()
            return
        }
        let generation = conversationGeneration
        followsLatest = false
        Task { [weak self] in
            guard let self else { return }
            while self.rowsByMessageID[messageID] == nil,
                  self.conversationGeneration == generation,
                  let cursor = self.olderCursor {
                do {
                    let page = try await self.api.messages(threadID: thread.id, before: cursor)
                    guard self.conversationGeneration == generation, self.thread?.id == thread.id else { return }
                    self.olderCursor = page.olderCursor
                    let moved = self.merge(page.messages)
                    if moved { self.render() }
                    guard !page.messages.isEmpty, page.olderCursor != cursor else { break }
                } catch {
                    self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t load earlier messages"))
                    return
                }
            }
            guard self.conversationGeneration == generation else { return }
            if self.rowsByMessageID[messageID] != nil {
                self.reveal(messageID: messageID)
                done?()
            } else {
                self.notice(String(localized: "That earlier message is no longer available."))
            }
        }
    }

    private func beginReplying(to message: ThreadMessage) {
        guard address?.supportsMessageReplies == true, replyDraft.select(message) else { return }
        if editing != nil { composer.text = "" }
        editing = nil
        composer.placeholderText = address?.prompt ?? ""
        renderReplyContext()
        composer.focus()
    }

    private func renderReplyContext() {
        replyContext.arrangedSubviews.forEach { view in
            replyContext.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard address?.supportsMessageReplies == true else {
            replyContext.isHidden = true
            return
        }
        let parentID = editing?.replyToMessageID ?? replyDraft.parentMessageID
        guard let parentID else {
            replyContext.isHidden = true
            return
        }
        let parent = messages.first { $0.id == parentID }
        let content = ThreadReplyPreviewContent.resolve(parent)
        let editingReply = editing?.replyToMessageID != nil
        let title = editingReply
            ? String(localized: "Reply to \(content.author): \(content.text)")
            : String(localized: "Replying to \(content.author): \(content.text)")
        let preview = NSButton(title: title, target: self, action: #selector(replyContextTapped(_:)))
        preview.identifier = NSUserInterfaceItemIdentifier(parentID)
        preview.bezelStyle = .inline
        preview.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        preview.contentTintColor = StarlingsColors.secondaryText
        preview.alignment = .left
        preview.toolTip = title
        preview.setAccessibilityLabel(title)
        preview.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        preview.setContentHuggingPriority(.defaultLow, for: .horizontal)
        SettingsChrome.applyQuietButton(preview)
        replyContext.addArrangedSubview(preview)

        if !editingReply {
            let cancel = NSButton(title: "", target: self, action: #selector(cancelReplyTapped))
            cancel.bezelStyle = .inline
            cancel.controlSize = .small
            cancel.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: String(localized: "Cancel reply"))
            cancel.imageScaling = .scaleProportionallyDown
            cancel.toolTip = String(localized: "Cancel reply")
            cancel.setAccessibilityLabel(String(localized: "Cancel reply"))
            SettingsChrome.applyQuietButton(cancel)
            replyContext.addArrangedSubview(cancel)
        }
        replyContext.isHidden = false
    }

    @objc private func replyContextTapped(_ sender: NSButton) {
        guard let parentID = sender.identifier?.rawValue else { return }
        jumpToParent(messageID: parentID)
    }

    @objc private func cancelReplyTapped() {
        replyDraft.cancel()
        renderReplyContext()
    }

    // MARK: - Writing

    /// One message on its own, leaving the draft and the staged files where
    /// they are. A hand-off carries text only, so over the limit there is
    /// nothing to send.
    private func sendAlone(_ text: String, mentions: [String]) {
        guard let thread else { return }
        let generation = conversationGeneration
        guard text.count <= DirectMessageCadence.maxCharacters else {
            notice(String(localized: "That is \(text.count.formatted()) characters; the limit is \(DirectMessageCadence.maxCharacters.formatted())."))
            return
        }
        followsLatest = true
        Task { [weak self] in
            guard let self else { return }
            do {
                let sent = try await self.api.sendMessage(threadID: thread.id, text: text, mentions: mentions, attachments: [])
                guard self.conversationGeneration == generation else { return }
                if self.merge([sent]) { self.render() }
                if let agent = self.awaitedAgentPeer() { AgentAsks.record(agent) }
            } catch {
                guard self.conversationGeneration == generation else { return }
                self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t send that message"))
            }
        }
    }

    private func selectQuestionOption(questionID: String, optionID: String, selected: Bool) {
        guard let question = messages.first(where: { $0.id == questionID })?.question else { return }
        var options = questionSelections[questionID] ?? []
        switch question.mode {
        case .single:
            options = [optionID]
        case .multiple:
            if selected { options.insert(optionID) } else { options.remove(optionID) }
        }
        questionSelections[questionID] = options
        questionErrors[questionID] = nil
        render()
    }

    private func answerQuestion(_ questionID: String) {
        guard let thread,
              let question = messages.first(where: { $0.id == questionID })?.question,
              !submittingQuestionIDs.contains(questionID) else { return }
        let optionIDs = question.options.map(\.id).filter { questionSelections[questionID]?.contains($0) == true }
        guard !optionIDs.isEmpty else {
            questionErrors[questionID] = String(localized: "Choose at least one option.")
            render()
            return
        }
        let generation = conversationGeneration
        submittingQuestionIDs.insert(questionID)
        questionErrors[questionID] = nil
        render()
        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.api.answerQuestion(
                    threadID: thread.id,
                    messageID: questionID,
                    optionIDs: optionIDs
                )
                guard self.conversationGeneration == generation else { return }
                self.submittingQuestionIDs.remove(questionID)
                self.questionSelections[questionID] = nil
                self.questionErrors[questionID] = nil
                if self.merge([response.message]) { self.render() }
            } catch {
                guard self.conversationGeneration == generation else { return }
                self.submittingQuestionIDs.remove(questionID)
                self.questionErrors[questionID] = String(localized: "Couldn’t submit this answer")
                self.render()
            }
        }
    }

    // MARK: Keep release cards

    /// This Mac's Keep: the app-wide token and key session.
    private var keepAccess: KeepAccess? {
        (NSApp.delegate as? AppDelegate)?.mainWindowController?.keepAccess
    }

    /// Approve opens a sheet: Keep unlocks there, this Mac seals the item to
    /// the agent's key, and the card records it. Keep acts first.
    private func approveRelease(_ message: ThreadMessage) {
        guard let parent = window, let keep = keepAccess, let request = message.releaseRequest, let thread else { return }
        let sheetWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 480),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        sheetWindow.isReleasedWhenClosed = false
        let threadID = thread.id
        let generation = conversationGeneration
        let sheet = KeepReleaseSheet(
            session: keep.session,
            request: request,
            agentEmail: message.senderEmail,
            agentName: message.senderName ?? message.senderShortName,
            connect: { [weak keep] in await keep?.link() },
            anchor: { [weak sheetWindow] in sheetWindow ?? NSApp.keyWindow ?? NSWindow() },
            onApproved: { [weak self] _ in
                guard let self else { return }
                let updated = try await self.api.updateRelease(threadID: threadID, messageID: message.id, ThreadReleaseUpdateRequest(action: .approve))
                guard self.conversationGeneration == generation else { return }
                if self.merge([updated]) { self.render() }
            },
            onClose: { [weak sheetWindow, weak parent] in
                guard let sheetWindow else { return }
                parent?.endSheet(sheetWindow)
            }
        )
        sheetWindow.contentViewController = NSHostingController(rootView: meetHosted(sheet))
        parent.beginSheet(sheetWindow) { _ in sheetWindow.orderOut(nil) }
    }

    /// End now: Keep first, then the card. Needs no unlock; ending opens nothing.
    private func endRelease(_ message: ThreadMessage) {
        guard let keep = keepAccess, let thread, let request = message.releaseRequest, let state = message.releaseState,
              !releaseBusyIDs.contains(message.id) else { return }
        let generation = conversationGeneration
        releaseBusyIDs.insert(message.id)
        releaseErrors[message.id] = nil
        render()
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await keep.session.endRelease(vaultId: state.vaultID, releaseId: request.requestID)
                let updated = try await self.api.updateRelease(threadID: thread.id, messageID: message.id, ThreadReleaseUpdateRequest(action: .end))
                guard self.conversationGeneration == generation else { return }
                self.releaseBusyIDs.remove(message.id)
                _ = self.merge([updated])
                self.render()
            } catch {
                guard self.conversationGeneration == generation else { return }
                self.releaseBusyIDs.remove(message.id)
                self.releaseErrors[message.id] = error.localizedDescription
                self.render()
            }
        }
    }

    private func submit(_ text: String, mentions: [String]) {
        guard let thread else { return }
        let generation = conversationGeneration
        if let target = editing {
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.api.editMessage(threadID: thread.id, messageID: target.id, text: text)
                    guard self.conversationGeneration == generation else { return }
                    // Only once it has landed: an edit that failed is still an
                    // edit, and clearing this first turned the retry into a new
                    // message posted underneath the one being rewritten.
                    self.editing = nil
                    self.composer.placeholderText = self.address?.prompt ?? ""
                    self.renderReplyContext()
                    await self.reload(expectedGeneration: generation)
                } catch {
                    guard self.conversationGeneration == generation else { return }
                    self.composer.text = text
                    self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t edit that message"))
                }
            }
            return
        }

        let replyToMessageID = replyDraft.parentMessageID
        if let replyToMessageID,
           !messages.contains(where: { $0.id == replyToMessageID && ThreadTranscript.isReplyable($0) }) {
            replyDraft.cancel()
            renderReplyContext()
            composer.text = text
            notice(String(localized: "This message can no longer be replied to."))
            return
        }

        followsLatest = true
        let files = pendingAttachments.map(\.id)
        pendingAttachments = []
        renderAttachmentTray()
        Task { [weak self] in
            guard let self else { return }
            do {
                let sent = try await self.api.sendMessage(
                    threadID: thread.id,
                    text: text,
                    mentions: mentions,
                    attachments: files,
                    replyToMessageID: replyToMessageID
                )
                guard self.conversationGeneration == generation else { return }
                self.replyDraft.cancel()
                self.renderReplyContext()
                if self.merge([sent]) { self.render() }
                if let agent = self.awaitedAgentPeer() { AgentAsks.record(agent) }
            } catch {
                guard self.conversationGeneration == generation else { return }
                // Hand the text back rather than silently eating what was typed.
                self.composer.text = text
                self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t send that message"))
            }
        }
    }

    /// Up-arrow on an empty composer. Only your own, and only something still
    /// standing — the Worker refuses anything else, and offering it here would
    /// be a keystroke that can only fail.
    private func beginEditingLast() {
        guard let target = messages.last(where: { $0.isMine && !$0.isEvent && !$0.isWithdrawn }) else { return }
        beginEditing(target)
    }

    private func beginEditing(_ message: ThreadMessage) {
        replyDraft.cancel()
        editing = message
        composer.text = message.text
        composer.placeholderText = "Editing — Return saves, Escape cancels"
        renderReplyContext()
        composer.focus()
    }

    /// Escape backs out of a rewrite. Without it the pane stayed in editing
    /// state with nothing on screen saying so, and the next thing typed
    /// silently replaced an old message instead of sending a new one.
    private func cancelEditing() -> Bool {
        guard editing != nil else {
            guard replyDraft.parentMessageID != nil else { return false }
            replyDraft.cancel()
            renderReplyContext()
            return true
        }
        editing = nil
        composer.text = ""
        composer.placeholderText = address?.prompt ?? ""
        renderReplyContext()
        return true
    }

    private func react(to message: ThreadMessage, emoji: String) {
        guard let thread else { return }
        let generation = conversationGeneration
        Task { [weak self] in
            guard let self else { return }
            do {
                let reactions = try await self.api.react(threadID: thread.id, messageID: message.id, emoji: emoji)
                guard self.conversationGeneration == generation else { return }
                guard let index = self.messages.firstIndex(where: { $0.id == message.id }) else {
                    await self.reload(expectedGeneration: generation)
                    return
                }
                self.messages[index] = self.messages[index].withReactions(reactions)
                let persistentReactionID = self.persistentReactionMessageID()
                self.persistentReactionMessageShown = persistentReactionID
                if let row = self.rowsByMessageID[message.id] as? ThreadMessageRowView {
                    row.updateReactions(
                        reactions,
                        showPersistentReactions: message.id == persistentReactionID
                    )
                } else {
                    self.render()
                }
            } catch {
                guard self.conversationGeneration == generation else { return }
                self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t react to that message"))
            }
        }
    }

    private func saveAsQuickNote(_ message: ThreadMessage) {
        let body = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard message.isMine, !message.isWithdrawn, !message.isEvent, !message.isPartial,
              !body.isEmpty, !quickNoteMessageIDsInFlight.contains(message.id)
        else { return }
        quickNoteMessageIDsInFlight.insert(message.id)
        Task { [weak self] in
            guard let self else { return }
            defer { self.quickNoteMessageIDsInFlight.remove(message.id) }
            do {
                // A client id: a repeat of this create finds the
                // note the first one made.
                let note = try await self.api.createQuickNote(QuickNotePending(body: body, source: .work).create)
                self.onQuickNoteSaved?(note)
                self.notice(String(localized: "Saved to Quick Notes."), tone: .neutral)
            } catch {
                self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t save as Quick Note"))
            }
        }
    }

    /// The channel's subject, when it has one: a decision is recorded there.
    private var decisionSubject: (kind: String, id: String)? {
        guard case .subject(let kind, let id) = address?.target,
              [.project, .lead, .organization, .event].contains(kind)
        else { return nil }
        return (kind.rawValue, id)
    }

    /// Mark as decision: the line becomes a decision on the
    /// subject, verbatim, with the message as its source. The route writes
    /// the channel line, so it appears here on the next poll.
    private func markAsDecision(_ message: ThreadMessage, on subject: (kind: String, id: String)) {
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await api.createCrmDecision(CrmDecisionCreate(
                    subjectKind: subject.kind, subjectID: subject.id, body: message.text,
                    source: "message", sourceRef: message.id
                ))
                StarlingsToast.show(String(localized: "Recorded as a decision"), in: window)
            } catch {
                StarlingsToast.show((error as? StarlingsError)?.message ?? String(localized: "Couldn’t record that decision"), tone: .danger, in: window)
            }
        }
    }

    private func withdraw(_ message: ThreadMessage) {
        guard let thread else { return }
        let generation = conversationGeneration
        let alert = NSAlert()
        alert.messageText = String(localized: "Withdraw this message?")
        alert.informativeText = String(localized: "The text and any files are gone. This can’t be undone.")
        alert.addButton(withTitle: String(localized: "Withdraw"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.api.withdrawMessage(threadID: thread.id, messageID: message.id)
                guard self.conversationGeneration == generation else { return }
                await self.reload(expectedGeneration: generation)
            } catch {
                guard self.conversationGeneration == generation else { return }
                self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t withdraw that message"))
            }
        }
    }

    // MARK: - Files

    /// Upload what was dropped or chosen, and hold it until a message carries
    /// it. Uploading is not sending: an abandoned composer leaves rows nobody
    /// but the uploader can see, which is what makes that cheap.
    private func attach(_ urls: [URL]) {
        guard let thread else { return }
        let generation = conversationGeneration
        for url in urls.prefix(ThreadPaneView.attachmentsPerMessage) {
            uploading += 1
            renderAttachmentTray()
            Task { [weak self] in
                guard let self else { return }
                defer {
                    if self.conversationGeneration == generation {
                        self.uploading -= 1
                        self.renderAttachmentTray()
                    }
                }
                do {
                    let data = try Data(contentsOf: url)
                    let attachment = try await self.api.uploadAttachment(
                        threadID: thread.id,
                        name: url.lastPathComponent,
                        contentType: ThreadPaneView.contentType(for: url),
                        data: data,
                        pixelSize: ThreadPaneView.pixelSize(of: data)
                    )
                    guard self.conversationGeneration == generation else { return }
                    self.pendingAttachments.append(attachment)
                } catch {
                    guard self.conversationGeneration == generation else { return }
                    self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t attach that file"))
                }
            }
        }
    }

    /// What is about to be sent, above the composer, each removable. Without
    /// it an upload is invisible until the message lands, and a file attached
    /// by mistake has no way back.
    private func renderAttachmentTray() {
        attachmentTray.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for attachment in pendingAttachments {
            let chip = NSButton(
                title: attachment.name,
                target: self,
                action: #selector(dropAttachment(_:))
            )
            chip.bezelStyle = .inline
            chip.controlSize = .small
            chip.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            chip.image = NSImage(systemSymbolName: "xmark.circle", accessibilityDescription: String(localized: "Remove"))
            chip.imagePosition = .imageTrailing
            chip.identifier = NSUserInterfaceItemIdentifier(attachment.id)
            chip.toolTip = String(localized: "Remove \(attachment.name)")
            attachmentTray.addArrangedSubview(chip)
        }
        if uploading > 0 {
            let label = NSTextField(labelWithString: uploading == 1 ? String(localized: "Uploading…") : String(localized: "Uploading \(uploading)…"))
            label.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            label.textColor = StarlingsColors.secondaryText
            attachmentTray.addArrangedSubview(label)
        }
        attachmentTray.isHidden = attachmentTray.arrangedSubviews.isEmpty
    }

    /// Taken off the message only. The bytes stay staged and unreferenced,
    /// which is the same inert state an abandoned composer leaves.
    @objc private func dropAttachment(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        pendingAttachments.removeAll { $0.id == id }
        renderAttachmentTray()
    }

    static let attachmentsPerMessage = 10

    /// The system's answer where it has one, and a download otherwise. The
    /// Worker makes the same decision again from its own list — this only
    /// decides what to claim, never what gets rendered.
    private static func contentType(for url: URL) -> String {
        (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType?.preferredMIMEType
            ?? "application/octet-stream"
    }

    /// Measured here so a transcript can reserve the right box before the
    /// bytes come back, instead of reflowing as each picture lands.
    private static func pixelSize(of data: Data) -> CGSize? {
        guard let image = NSImage(data: data),
              let rep = image.representations.first else { return nil }
        let size = CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
        return size.width > 0 && size.height > 0 ? size : nil
    }

    // MARK: - Drag and drop

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFiles(sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let files = droppedFiles(sender)
        guard !files.isEmpty else { return false }
        attach(files)
        return true
    }

    private func droppedFiles(_ sender: NSDraggingInfo) -> [URL] {
        guard thread != nil else { return [] }
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        return sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL] ?? []
    }

    // MARK: - Muting and archiving

    override func menu(for event: NSEvent) -> NSMenu? {
        guard let thread else { return nil }
        let menu = NSMenu()
        let muted = thread.isMuted
        let item = NSMenuItem(
            title: muted ? String(localized: "Unmute") : String(localized: "Mute"),
            action: #selector(toggleMute),
            keyEquivalent: ""
        )
        item.symbol(muted ? .unmute : .mute)
        item.target = self
        menu.addItem(item)
        // A channel takes forwarded email at one address.
        if thread.inboundAddress != nil {
            let copy = NSMenuItem(
                title: String(localized: "Copy forwarding address"),
                action: #selector(copyInboundAddress),
                keyEquivalent: ""
            )
            copy.symbol(.copy)
            copy.target = self
            menu.addItem(copy)
        }
        // Only a private conversation can be put away. A channel is a place,
        // and leaving one is a different verb than filing one.
        if thread.kind == .dm {
            let archived = thread.archivedAt != nil
            let archive = NSMenuItem(
                title: archived ? String(localized: "Keep in chat") : String(localized: "Archive conversation"),
                action: #selector(toggleArchive),
                keyEquivalent: ""
            )
            archive.symbol(archived ? .unarchive : .archive)
            archive.target = self
            menu.addItem(archive)
        }
        return menu
    }

    /// The channel's forwarding address to the clipboard. The
    /// notice carries the address so it can be read without pasting it.
    @objc private func copyInboundAddress() {
        guard let address = thread?.inboundAddress else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address, forType: .string)
        notice(String(localized: "Copied ") + address, tone: .neutral)
    }

    /// Put it away, or take it back. Nothing is deleted and there is no archive
    /// to visit: the conversation reopens from the person's roster row, and
    /// anything said in it from now on puts the row back by itself.
    @objc private func toggleArchive() {
        guard let thread else { return }
        let generation = conversationGeneration
        let archived = thread.archivedAt == nil
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.api.archiveThread(threadID: thread.id, archived: archived)
                guard self.conversationGeneration == generation else { return }
                await self.reload(expectedGeneration: generation)
                guard self.conversationGeneration == generation else { return }
                self.notice(archived ? String(localized: "Archived.") : String(localized: "Back in your conversations."), tone: .neutral)
            } catch {
                guard self.conversationGeneration == generation else { return }
                self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change that"))
            }
        }
    }

    /// Muted for a week rather than forever: a mute with no end is a mute
    /// nobody remembers setting, and the conversation stays quiet long after
    /// the week it was noisy. Same reasoning as do-not-disturb.
    @objc private func toggleMute() {
        guard let thread else { return }
        let generation = conversationGeneration
        let until: Date? = thread.isMuted ? nil : Date().addingTimeInterval(7 * 24 * 3600)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.api.muteThread(threadID: thread.id, until: until)
                guard self.conversationGeneration == generation else { return }
                await self.reload(expectedGeneration: generation)
                guard self.conversationGeneration == generation else { return }
                self.notice(until == nil ? String(localized: "Conversation unmuted.") : String(localized: "Muted for a week."), tone: .neutral)
            } catch {
                guard self.conversationGeneration == generation else { return }
                self.notice((error as? StarlingsError)?.message ?? String(localized: "Couldn’t change that"))
            }
        }
    }

    /// Union by id, sorted by time — the poll and a just-sent message routinely
    /// carry the same row.
    ///
    /// Returns whether the transcript actually moved. Rebuilding it is not free
    /// — every row is torn down and every picture fetched again — so a poll that
    /// brings back exactly what is already on screen must not redraw it.
    @discardableResult
    private func merge(_ incoming: [ThreadMessage]) -> Bool {
        var byID = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for message in incoming { byID[message.id] = message }
        let next = byID.values.sorted { left, right in
            left.sentAt == right.sentAt ? left.id < right.id : left.sentAt < right.sentAt
        }
        guard next != messages else { return false }
        // A streamed answer's next post is the same row, longer. If that is
        // all that changed, the row updates its own words — a rebuild once a
        // second while an agent writes would refetch every picture and flash.
        if isStreamingOnly(from: messages, to: next) {
            messages = next
            for message in next where message.isPartial {
                (rowsByMessageID[message.id] as? ThreadMessageRowView)?.update(streamed: message)
            }
            if followsLatest { layoutSubtreeIfNeeded(); scrollToBottom() }
            return false
        }
        messages = next
        return true
    }

    /// Same rows, and every difference is a still-streaming message's text.
    private func isStreamingOnly(from before: [ThreadMessage], to after: [ThreadMessage]) -> Bool {
        guard before.count == after.count else { return false }
        for (old, new) in zip(before, after) where old != new {
            guard old.id == new.id, old.isPartial, new.isPartial else { return false }
            guard old.withText(new.text) == new else { return false }
        }
        return true
    }

    /// A click off the text drops the selection, the way it does in any
    /// document. Rows do not take mouse downs, so anything that is not a
    /// message body arrives here.
    override func mouseDown(with event: NSEvent) {
        selection.clear()
        super.mouseDown(with: event)
    }

    // MARK: - Drawing

    private func render() {
        renderReplyContext()
        // Paste-and-send is for an agent. Decided here because both the
        // roster and the conversation land through this path.
        composer.showsPasteAndSend = addressedAgentPeer() != nil
        // Every row is rebuilt, so whatever was highlighted no longer exists.
        selection.clear()
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        rowsByMessageID = [:]
        let persistentReactionID = persistentReactionMessageID()
        persistentReactionMessageShown = persistentReactionID

        let rows = ThreadTranscript.rows(
            for: messages,
            unreadBoundary: unreadBoundary,
            agentEmails: Set(roster.filter(\.isAgent).map(\.email))
        )
        workingRowShown = shouldShowWorkingRow()
        let liveTrail = workingRowShown ? liveTrailSteps(in: rows) : nil
        for (index, row) in rows.enumerated() {
            let view: NSView
            switch row {
            case let .day(date):
                view = ThreadDayDividerView(date: date)
            case .unreadMark:
                view = ThreadUnreadDividerView()
            case let .trail(steps):
                // The live trail is the working row's own line, not a row here.
                if let liveTrail, liveTrail.index == index { continue }
                let key = steps[0].id
                view = ThreadTrailRowView(steps: steps, open: openTrails.contains(key)) { [weak self] in
                    guard let self else { return }
                    if self.openTrails.contains(key) { self.openTrails.remove(key) } else { self.openTrails.insert(key) }
                    self.render()
                }
            case let .event(message):
                view = ThreadEventRowView(message: message, onOpenRef: onOpenRef, selection: selection)
                rowsByMessageID[message.id] = view
            case let .message(message, grouped):
                let rowView = ThreadMessageRowView(
                    message: message,
                    grouped: grouped,
                    showPersistentReactions: message.id == persistentReactionID,
                    fromAgent: isAgentEmail(message.senderEmail),
                    agentAvatar: roster.first(where: {
                        $0.isAgent && $0.email.caseInsensitiveCompare(message.senderEmail) == .orderedSame
                    })?.agentAvatar,
                    hideSingleReactionCount: thread?.kind == .dm,
                    replyParent: message.replyToMessageID.flatMap { parentID in messages.first { $0.id == parentID } },
                    questionAnswer: messages.first { $0.questionAnswer?.questionMessageID == message.id },
                    selectedQuestionOptionIDs: questionSelections[message.id] ?? [],
                    questionIsSubmitting: submittingQuestionIDs.contains(message.id),
                    questionError: questionErrors[message.id],
                    releaseBusy: releaseBusyIDs.contains(message.id),
                    releaseError: releaseErrors[message.id],
                    onApproveRelease: keepAccess?.isAvailable == true ? { [weak self] message in self?.approveRelease(message) } : nil,
                    onEndRelease: keepAccess?.isAvailable == true ? { [weak self] message in self?.endRelease(message) } : nil,
                    loadImage: { [weak self] file in
                        guard let self, let thread = self.thread else { return nil }
                        guard let data = try? await self.api.attachmentData(
                            threadID: thread.id,
                            attachmentID: file.id
                        ) else { return nil }
                        return NSImage(data: data)
                    },
                    loadPreview: { [weak self] link in
                        guard let self else { return nil }
                        return try? await self.api.linkPreview(url: link)
                    },
                    onOpenRef: onOpenRef,
                    onReply: address?.supportsMessageReplies == true && ThreadTranscript.isReplyable(message)
                        ? { [weak self] message in self?.beginReplying(to: message) }
                        : nil,
                    onJumpToParent: address?.supportsMessageReplies == true
                        ? { [weak self] parentID in self?.jumpToParent(messageID: parentID) }
                        : nil,
                    selection: selection,
                    onQuestionSelection: { [weak self] optionID, selected in
                        self?.selectQuestionOption(questionID: message.id, optionID: optionID, selected: selected)
                    },
                    onQuestionSubmit: { [weak self] in self?.answerQuestion(message.id) }
                )
                rowView.onReact = { [weak self] message, emoji in self?.react(to: message, emoji: emoji) }
                rowView.onSaveAsQuickNote = { [weak self] message in self?.saveAsQuickNote(message) }
                rowView.onEdit = { [weak self] message in self?.beginEditing(message) }
                rowView.onWithdraw = { [weak self] message in self?.withdraw(message) }
                if let subject = decisionSubject {
                    rowView.onMarkAsDecision = { [weak self] message in self?.markAsDecision(message, on: subject) }
                }
                rowsByMessageID[message.id] = rowView
                view = rowView
            }
            view.translatesAutoresizingMaskIntoConstraints = false
            view.setContentHuggingPriority(.required, for: .vertical)
            view.setContentCompressionResistancePriority(.required, for: .vertical)
            stack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        // A turn in flight reads as a typing state, not a message: a transient
        // row pinned to the bottom of the transcript, replaced the moment the
        // agent's real reply lands. Driven entirely by the peer's working state,
        // so it clears itself when the run ends — see `shouldShowWorkingRow`.
        // It carries a clock from the hand-off's acceptance and, under it, the
        // agent's latest step in its own words.
        if workingRowShown, let agent = addressedAgentPeer() {
            let since = agent.since ?? messages.last(where: { !$0.isEvent })?.sentAt ?? Date()
            let workingRow = ThreadWorkingRowView(name: agent.shortName, since: since, step: liveTrail?.steps.last?.text)
            workingRow.translatesAutoresizingMaskIntoConstraints = false
            workingRow.setContentHuggingPriority(.required, for: .vertical)
            workingRow.setContentCompressionResistancePriority(.required, for: .vertical)
            stack.addArrangedSubview(workingRow)
            workingRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }

        // Size the rows before anything is drawn. A message body reports one
        // line until it has a width and re-wraps on its first layout; left to
        // the display cycle that is a transcript drawn twice — once with
        // every bubble a line tall — and the second drawing is the flash.
        layoutSubtreeIfNeeded()
        if let pending = pendingReveal, rowsByMessageID[pending] != nil {
            reveal(messageID: pending)
        } else if followsLatest {
            scrollToBottom()
        }
        // With a conversation open, the empty line — or, for an agent that has
        // one, its manifest card — stands in for the transcript until there is
        // one. With nothing open it is the placeholder for the whole pane, which
        // `showEmpty` is already drawing. Only once the Worker has answered: an
        // empty line for the round trip is a line about to be replaced, which
        // reads as a flash.
        if address != nil, thread != nil {
            let empty = messages.isEmpty
            if agentCardShownPeer != nil {
                agentCard.isHidden = !empty
                emptyLabel.isHidden = true
            } else {
                emptyLabel.isHidden = !empty
                agentCard.isHidden = true
            }
        }
    }

    /// The agent a turn is open with, when one is: the addressed peer in an
    /// agent DM, or — in a channel, where an agent hears nothing unless named
    /// — the roster agent my latest message @mentions, or the one whose
    /// answer is still streaming in. Nil for a person's DM, a channel line
    /// that names no agent, or a thread where the last word is somebody
    /// else's.
    private func awaitedAgentPeer() -> Peer? {
        if let email = address?.peerEmail {
            guard let peer = roster.first(where: { $0.email == email }), peer.isAgent else { return nil }
            return peer
        }
        guard let lastReal = messages.last(where: { !$0.isEvent }) else { return nil }
        if lastReal.isPartial { return roster.first { $0.isAgent && $0.email == lastReal.senderEmail } }
        guard lastReal.isMine else { return nil }
        return roster.first { $0.isAgent && lastReal.mentions.contains($0.email) }
    }

    /// The trail still being written: the agent's steps since my line, with
    /// nothing final from it after them. The working row's second line, not a
    /// folded row; it folds when the answer lands. The answer may already be
    /// streaming under the steps, so the trail can be one row from the end.
    private func liveTrailSteps(in rows: [ThreadTranscriptRow]) -> (index: Int, steps: [ThreadMessage])? {
        guard let last = rows.indices.last else { return nil }
        if let steps = rows[last].steps { return (last, steps) }
        guard last > 0, rows[last].message?.isPartial == true, let steps = rows[last - 1].steps else { return nil }
        return (last - 1, steps)
    }

    /// The awaited agent, when it is currently working: `busy` with a
    /// `busy_until` still in the future. An elapsed TTL reads as *not*
    /// working, so a run that died silently can never leave the row stuck on —
    /// the same expiry the Worker applies, re-checked here against the client
    /// clock. Nil for a person, an unaddressed channel, or an idle agent.
    private func workingAgentPeer() -> Peer? {
        guard let peer = awaitedAgentPeer() else { return nil }
        guard peer.status == .busy, let until = peer.busyUntil, until > Date() else { return nil }
        return peer
    }

    /// The latest text message stays quiet unless it is the latest answer from
    /// the addressed agent. A member's follow-up moves the standing rail away
    /// until the agent answers again.
    /// Whether a sender is one of the roster's agents. Read from the roster
    /// rather than the addressed peer so an agent posting into a group or a
    /// subject thread gets the same narrow palette as one in a DM.
    private func isAgentEmail(_ email: String?) -> Bool {
        guard let email else { return false }
        return roster.contains { $0.email == email && $0.isAgent }
    }

    private func persistentReactionMessageID() -> String? {
        guard let email = address?.peerEmail,
              roster.contains(where: { $0.email == email && $0.isAgent }) else { return nil }
        guard let latest = messages.last(where: { !$0.isEvent }),
              latest.senderEmail == email,
              !latest.isWithdrawn,
              !latest.isPartial,
              !latest.reactions.contains(where: { $0.isMine }) else { return nil }
        return latest.id
    }

    /// Whether the transient row belongs at the bottom right now: the agent is
    /// working, and it has not already answered this turn. Its own next text
    /// message clears `busy_until` at the Worker, but it lands in this transcript
    /// first — so the moment the reply shows, the row goes, without waiting for
    /// the next roster poll to catch up. An `event` line never ends a turn, so it
    /// does not count as an answer.
    private func shouldShowWorkingRow() -> Bool {
        guard awaitingAgent() else { return false }
        if workingAgentPeer() != nil { return true }
        // Just sent: the row shows on trust until the roster has had time to
        // say whether the runtime accepted.
        guard let sentAt = messages.last(where: { !$0.isEvent })?.sentAt else { return false }
        return Date().timeIntervalSince(sentAt) < DirectMessageCadence.agentAcceptGrace
    }

    /// The awaited agent — busy or not — for the working row's name.
    private func addressedAgentPeer() -> Peer? {
        awaitedAgentPeer()
    }

    /// A turn is open with an agent: the conversation is with one (or my
    /// latest channel line named one), and either the last real message is
    /// mine or the agent's answer to it is still streaming in. Both keep the
    /// working row, the one-second poll and the roster refresh.
    private func awaitingAgent() -> Bool {
        guard awaitedAgentPeer() != nil else { return false }
        guard let lastReal = messages.last(where: { !$0.isEvent }) else { return false }
        return lastReal.isMine || lastReal.isPartial
    }

    /// The end of the conversation is the origin. Rows are rebuilt on every
    /// render, so this is also what keeps a rebuilt transcript from landing
    /// anywhere but where a reader at the end already was.
    private func scrollToBottom() {
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        followsLatest = true
        jumpButton.isHidden = true
    }

    /// Height arrived or left. At the end, nothing to do — the end is `y == 0`
    /// and it has not moved. Up in history, hold the lines the reader was on:
    /// growth is almost always something landing *below* them (a new message,
    /// an image in a later bubble), which is a shift of the same amount.
    @objc private func documentResized(_ notification: Notification) {
        let height = stack.frame.height
        let delta = height - documentHeight
        documentHeight = height
        guard !followsLatest, delta != 0 else { return }
        var origin = scrollView.contentView.bounds.origin
        origin.y = max(0, origin.y + delta)
        scrollView.contentView.scroll(to: origin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    @objc private func jumpTapped() {
        scrollToBottom()
    }

    /// Following the latest is a state, not a guess: once somebody scrolls up
    /// they stay where they are until they say otherwise.
    @objc private func scrolled() {
        followsLatest = scrollView.contentView.bounds.origin.y < 80
        jumpButton.isHidden = followsLatest || messages.isEmpty
    }

    /// Errors read red with Copy; the two confirmations here are neutral.
    private func notice(_ text: String, tone: StarlingsNoticeView.Tone = .danger) {
        noticeLabel.setText(text, tone: tone)
        noticeLabel.isHidden = false
        noticeHeight?.isActive = false
        // Long enough to read, gone before it becomes furniture.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard let self, self.noticeLabel.text == text else { return }
            self.noticeLabel.isHidden = true
            self.noticeHeight?.isActive = true
        }
    }

    private func showEmpty(_ empty: Bool) {
        scrollView.isHidden = empty
        composer.isHidden = empty
        jumpButton.isHidden = true
        noticeLabel.isHidden = true
        noticeHeight?.isActive = true
        attachmentTray.isHidden = true
        if empty {
            // Nothing open: the whole-pane placeholder, never an agent card.
            agentCardShownPeer = nil
            agentCard.isHidden = true
            emptyLabel.isHidden = false
        } else {
            // A conversation is open — render() picks the right stand-in (the
            // agent card, or the empty line) for the transcript being empty.
            render()
        }
    }

    /// The agent whose manifest belongs on this address's front door, or nil for
    /// a person, a channel, or an agent whose runtime serves none.
    private func agentCardPeer(for address: ThreadAddress) -> Peer? {
        guard let email = address.peerEmail else { return nil }
        guard let peer = roster.first(where: { $0.email == email }), peer.isAgent, peer.manifest != nil else {
            return nil
        }
        return peer
    }

    /// Rebuild the agent card for the open address, or clear it. Manifest text is
    /// untrusted sandbox output, so every string is set as a plain label — drawn
    /// as the agent's own words, never as markup or an instruction.
    private func renderAgentCard(for address: ThreadAddress) {
        let peer = agentCardPeer(for: address)
        agentCardShownPeer = peer
        agentCard.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard let peer, let manifest = peer.manifest else {
            agentCard.isHidden = true
            return
        }

        let name = NSTextField(labelWithString: peer.displayName)
        name.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        name.textColor = StarlingsColors.primaryText
        agentCard.addArrangedSubview(name)

        // What Meet counted comes before what the runtime claims: whether it
        // answers, and how fast, is the question this door is opened to ask.
        if let activity = peer.activity {
            for line in activity.lines {
                let label = ThreadPaneView.wrappingLabel(line)
                label.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(12))
                label.textColor = StarlingsColors.primaryText
                agentCard.addArrangedSubview(label)
            }
            agentCard.setCustomSpacing(12, after: agentCard.arrangedSubviews.last!)
        }

        let description = ThreadPaneView.wrappingLabel(manifest.description)
        description.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))
        description.textColor = StarlingsColors.secondaryText
        agentCard.addArrangedSubview(description)

        if let model = manifest.model {
            let line = ThreadPaneView.wrappingLabel(String(localized: "Runs on \(model)"))
            line.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(11))
            line.textColor = StarlingsColors.secondaryText
            agentCard.addArrangedSubview(line)
        }

        // The front door says what it can do and what it reaches for. Links,
        // connections and schedules stay in the inspector — a card is not a
        // datasheet.
        addAgentCardTiles(String(localized: "What it can do"), entries: manifest.skills.map { ($0.name, $0.description) })
        addAgentCardTiles(String(localized: "Tools"), entries: manifest.tools.map { ($0.requiresApproval ? "\($0.name) (asks first)" : $0.name, $0.description) })

        let links = manifest.links
        if !links.isEmpty {
            let row = NSStackView(views: links.map { link in
                let button = NSButton(title: link.title, target: nil, action: nil)
                SettingsChrome.applySecondaryButton(button, title: link.title, symbolName: nil, height: 24)
                button.target = AgentCardLinkProxy.shared
                button.action = #selector(AgentCardLinkProxy.open(_:))
                AgentCardLinkProxy.shared.register(button, url: link.url)
                return button
            })
            row.orientation = .horizontal
            row.spacing = 6
            agentCard.setCustomSpacing(12, after: agentCard.arrangedSubviews.last!)
            agentCard.addArrangedSubview(row)
        }
    }

    /// One eyebrow and its tiles on the agent card — the same read-only Home
    /// rows the inspector draws. Nothing when the list is empty.
    private func addAgentCardTiles(_ title: String, entries: [(name: String, detail: String?)]) {
        guard !entries.isEmpty, let previous = agentCard.arrangedSubviews.last else { return }
        let heading = NSTextField(labelWithString: title)
        heading.font = NSFont.systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        heading.textColor = StarlingsColors.secondaryText
        agentCard.setCustomSpacing(14, after: previous)
        agentCard.addArrangedSubview(heading)
        for entry in entries {
            let tile = AgentManifestTileView(
                name: entry.name,
                detail: entry.detail,
                unfolded: unfoldedManifestTiles.contains(entry.name)
            )
            tile.onToggle = { [weak self] open in
                if open { self?.unfoldedManifestTiles.insert(entry.name) } else { self?.unfoldedManifestTiles.remove(entry.name) }
            }
            agentCard.addArrangedSubview(tile)
            tile.widthAnchor.constraint(equalTo: agentCard.widthAnchor).isActive = true
        }
    }

    /// Which tiles on the agent card are unfolded, by name, so a roster tick
    /// that re-renders the card does not fold them back up.
    private var unfoldedManifestTiles: Set<String> = []

    /// A label that wraps to the card's width rather than running off it. The
    /// card constrains its own width, so the label needs only permission to grow
    /// downward.
    private static func wrappingLabel(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.isEditable = false
        label.isSelectable = false
        label.drawsBackground = false
        label.isBezeled = false
        label.preferredMaxLayoutWidth = 380
        return label
    }
}

/// The agent card's link buttons are built in a loop and need somewhere for
/// their URL to live. Keyed weakly so a re-rendered card drops the old rows.
@MainActor
private final class AgentCardLinkProxy: NSObject {
    static let shared = AgentCardLinkProxy()
    private let table = NSMapTable<NSButton, NSURL>.weakToStrongObjects()

    func register(_ button: NSButton, url: URL) {
        table.setObject(url as NSURL, forKey: button)
    }

    @objc func open(_ sender: NSButton) {
        guard let url = table.object(forKey: sender) as URL? else { return }
        NSWorkspace.shared.open(url)
    }
}

/// The transient "working" row an agent's turn draws at the bottom of the
/// transcript while it is in flight — a typing state, not a message. Quiet
/// system-row styling, indented to the same column as an event line so it reads
/// as part of the conversation rather than as a bubble somebody sent. The
/// pane inserts and removes it purely from the agent's working state; the
/// inline thinking orb in the face column animates while it is on screen.
///
/// Two lines beside the orb: "<name> is working · 0:42", counting up from
/// the hand-off's acceptance, and under it the agent's latest step in its
/// own words. The clock ticks on its own timer so the transcript is not
/// rebuilt for a digit.
@MainActor
private final class ThreadWorkingRowView: NSView {
    private let name: String
    private let since: Date
    private let label = NSTextField(labelWithString: "")
    private let stepLabel = NSTextField(labelWithString: "")
    private var clock: Timer?

    init(name: String, since: Date, step: String?) {
        self.name = name
        self.since = since
        super.init(frame: .zero)

        let orb = NSHostingView(rootView: GatheringDotsView(side: 20, ink: Color(nsColor: StarlingsColors.secondaryText), motion: .thinking))
        orb.translatesAutoresizingMaskIntoConstraints = false
        orb.setAccessibilityElement(false)

        label.font = .monospacedDigitSystemFont(ofSize: StarlingsTypography.scaled(11), weight: .regular)
        label.textColor = StarlingsColors.secondaryText
        stepLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        stepLabel.textColor = StarlingsColors.secondaryText.withAlphaComponent(0.75)
        stepLabel.lineBreakMode = .byTruncatingTail
        stepLabel.maximumNumberOfLines = 1
        let lines = NSStackView(views: [label, stepLabel])
        lines.orientation = .vertical
        lines.alignment = .leading
        lines.spacing = 2
        lines.translatesAutoresizingMaskIntoConstraints = false

        addSubview(orb)
        addSubview(lines)
        NSLayoutConstraint.activate([
            // The orb sits in the face column; the words keep the same 40pt
            // column as `ThreadEventRowView`, so the quiet rows line up.
            orb.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            orb.widthAnchor.constraint(equalToConstant: 20),
            orb.heightAnchor.constraint(equalToConstant: 20),
            orb.centerYAnchor.constraint(equalTo: label.centerYAnchor),
            lines.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 40),
            lines.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            lines.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            lines.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
        ])
        setStep(step)
        tick()
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        setAccessibilityLabel(String(localized: "\(name) is working"))
    }

    /// Rows are torn down by leaving the window; the clock goes with them.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { clock?.invalidate(); clock = nil }
    }

    /// The agent's latest step, or nothing yet.
    func setStep(_ step: String?) {
        stepLabel.stringValue = step.map(ThreadMarkdown.plainText) ?? ""
        stepLabel.isHidden = step == nil
    }

    private func tick() {
        label.stringValue = String(localized: "\(name) is working") + " · " + ThreadTranscript.elapsedLabel(since: since)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}
