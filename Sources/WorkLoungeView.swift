import AppKit

/// The team, as a room rather than a list.
///
/// The Team window's lounge is the right shape for the question this answers:
/// *who is around right now, and can I just talk to them?* A grid of tiles
/// answers that at a glance, which a list you scroll cannot.
///
/// This owns no room and mints none. There is no always-on microphone here.
/// See docs/PRESENCE.md.
@MainActor
final class WorkLoungeView: NSView {
    /// Open the conversation with them — the same destination their sidebar
    /// row leads to, so a tile and a row cannot mean different things.
    var onSelect: ((Peer) -> Void)?
    /// Your own status, chosen from the same list the sidebar footer offers.
    var onStatusChange: ((PeerStatusOption) -> Void)?
    /// Notes to self belongs to the face in the self strip, not to a second
    /// copy of that face in the Conversations section.
    var onMessage: ((Peer) -> Void)?
    /// Walk into a conversation that is already happening.
    var onJoin: ((Peer) -> Void)?

    private let scroll = NSScrollView()
    private let grid = NSStackView()
    private let selfStrip = WorkLoungeSelfStrip()
    private let emptyLabel = NSTextField(labelWithString: "")
    private var roster: PeerRoster = .empty
    private var selfHasUnread = false
    /// Whoever is waving at *us* right now, lower-cased. Their tile pulses for
    /// as long as the wave is live — the sound says somebody wants you, and
    /// this says which somebody, which a chime cannot.
    private var wavingAt: Set<String> = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        selfStrip.onChange = { [weak self] option in self?.onStatusChange?(option) }
        selfStrip.onMessage = { [weak self] in
            guard let self, let peer = self.roster.me else { return }
            self.onMessage?(peer)
        }
        selfStrip.translatesAutoresizingMaskIntoConstraints = false

        grid.orientation = .vertical
        grid.alignment = .leading
        grid.spacing = 10
        grid.translatesAutoresizingMaskIntoConstraints = false
        // The roster is a viewport, not a horizontal document. Its rows must
        // be allowed to shrink while the shell gives width to the inspector;
        // otherwise their fixed tile widths become the middle pane's minimum.
        grid.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        grid.setContentHuggingPriority(.defaultLow, for: .horizontal)
        grid.setClippingResistancePriority(.defaultLow, for: .horizontal)

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.documentView = grid
        scroll.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        emptyLabel.textColor = StarlingsColors.secondaryText
        emptyLabel.alignment = .center
        emptyLabel.isHidden = true
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        addSubview(selfStrip)
        addSubview(scroll)
        addSubview(emptyLabel)

        NSLayoutConstraint.activate([
            selfStrip.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            selfStrip.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            selfStrip.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),

            scroll.topAnchor.constraint(equalTo: selfStrip.bottomAnchor, constant: 14),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),

            grid.widthAnchor.constraint(equalTo: scroll.widthAnchor),

            emptyLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
            emptyLabel.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -64),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setRoster(_ roster: PeerRoster) {
        self.roster = roster
        // Only a wave. A call has its own banner with something to accept, and
        // a pulsing tile beside it would be two answers to one question.
        let waving = roster.liveRing.flatMap { $0.kind == .wave ? $0.callerEmail.lowercased() : nil }
        wavingAt = waving.map { [$0] } ?? []
        rebuild()
    }

    func setSelfUnread(_ hasUnread: Bool) {
        selfHasUnread = hasUnread
        selfStrip.setPeer(roster.me, hasUnread: hasUnread)
    }

    /// Tiles per row, from the width available. Recomputed on resize because a
    /// fixed count would either waste a wide window or clip a narrow one.
    ///
    /// **The rebuild happens after the pass, never inside it.** Tearing the
    /// tiles down and building them again from `layout()` mutates the very
    /// hierarchy AppKit is measuring, and the width that changes the column
    /// count is usually the shell handing width to the inspector. That is the
    /// widen-then-recover of the Team window in issue #22: the grid answered a
    /// question the split view was still asking.
    override func layout() {
        super.layout()
        guard columnCount() != renderedColumns else { return }
        scheduleColumnRebuild()
    }

    private var renderedColumns = 0
    private var columnRebuildScheduled = false

    private func scheduleColumnRebuild() {
        guard !columnRebuildScheduled else { return }
        columnRebuildScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.columnRebuildScheduled = false
            guard self.columnCount() != self.renderedColumns else { return }
            self.rebuild()
        }
    }

    private func columnCount() -> Int {
        let usable = max(0, bounds.width - 32)
        return max(1, Int((usable + WorkLoungeTileView.spacing) / (WorkLoungeTileView.width + WorkLoungeTileView.spacing)))
    }

    private func rebuild() {
        selfStrip.setPeer(roster.me, hasUnread: selfHasUnread)
        // Every roster poll redraws the grid; the reader stays where they
        // scrolled to (`NSScrollView.preservingScrollOffset`).
        scroll.preservingScrollOffset { rebuildGrid() }
    }

    private func rebuildGrid() {
        for view in grid.arrangedSubviews {
            grid.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        // Conversations first: a room with people in it is the thing you cross
        // a room to join, and drawing its members as unrelated tiles is what
        // makes a roster a list instead of a place.
        let conversations = roster.conversations
        // People not already inside one, then agents — the same split the
        // sidebar draws, for the same reason: something addressable that is not
        // a colleague should not sit between two colleagues. Keep them as two
        // tile grids so the agent roster has a clear home underneath people.
        let people = roster.ungrouped.filter { !$0.isAgent }
        let agents = roster.agents
        let hasTiles = !people.isEmpty || !agents.isEmpty
        emptyLabel.stringValue = String(localized: "Nobody else is here yet.")
        emptyLabel.isHidden = hasTiles || !conversations.isEmpty
        scroll.isHidden = !hasTiles && conversations.isEmpty

        for conversation in conversations {
            let conversationView = WorkLoungeConversationView(
                conversation: conversation,
                waving: wavingAt,
                onJoin: { [weak self] peer in self?.onJoin?(peer) },
                onSelect: { [weak self] peer in self?.onSelect?(peer) }
            )
            conversationView.translatesAutoresizingMaskIntoConstraints = false
            grid.addArrangedSubview(conversationView)
            conversationView.widthAnchor.constraint(equalTo: grid.widthAnchor).isActive = true
        }

        let columns = columnCount()
        renderedColumns = columns
        addTileSection(title: String(localized: "PEOPLE"), peers: people, columns: columns)
        addTileSection(title: String(localized: "AGENTS"), peers: agents, columns: columns)
    }

    private func addTileSection(title: String, peers: [Peer], columns: Int) {
        guard !peers.isEmpty else { return }

        let heading = NSTextField(labelWithString: title)
        heading.font = StarlingsTypography.sectionLabelFont
        heading.textColor = StarlingsColors.secondaryText
        heading.translatesAutoresizingMaskIntoConstraints = false
        grid.addArrangedSubview(heading)
        heading.widthAnchor.constraint(equalTo: grid.widthAnchor).isActive = true

        var row: NSStackView?
        for (index, peer) in peers.enumerated() {
            if index % columns == 0 {
                let next = NSStackView()
                next.orientation = .horizontal
                next.alignment = .top
                next.spacing = WorkLoungeTileView.spacing
                next.translatesAutoresizingMaskIntoConstraints = false
                // Keep the row tied to the visible middle column. The tile
                // width is preferred, not a reason to enlarge the window.
                next.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                next.setContentHuggingPriority(.defaultLow, for: .horizontal)
                // `clippingResistancePriority` is the knob that actually
                // matters here, and it defaults to `.defaultHigh`: a stack
                // will not let its arranged views be clipped, and states that
                // as a constraint the pane's fitting width then carries up to
                // the window. Say the row may be clipped — the rebuild below
                // is what stops it ever having to be.
                next.setClippingResistancePriority(.defaultLow, for: .horizontal)
                grid.addArrangedSubview(next)
                next.widthAnchor.constraint(equalTo: grid.widthAnchor).isActive = true
                row = next
            }
            row?.addArrangedSubview(WorkLoungeTileView(
                peer: peer,
                isWaving: wavingAt.contains(peer.email.lowercased()),
                onSelect: { [weak self] peer in self?.onSelect?(peer) }
            ))
        }
        // Every row gets one, not only a short one. A full row's tiles now
        // have a required ceiling, so without somewhere to put the remainder
        // the row is over-constrained the moment the column is wider than
        // `columns` tiles — which, between a resize and the rebuild that
        // answers it, is most of the time.
        if let row {
            let filler = NSView()
            filler.translatesAutoresizingMaskIntoConstraints = false
            filler.setContentHuggingPriority(.init(1), for: .horizontal)
            filler.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            row.addArrangedSubview(filler)
        }
    }
}

/// A conversation you can see from across the room: everybody in one room,
/// drawn inside one frame, with a way in.
///
/// The frame is the whole point. Four people talking used to be four unrelated
/// tiles that each said "In a meeting", which tells you everything except the
/// one thing you wanted to know.
@MainActor
private final class WorkLoungeConversationView: NSView {
    private let conversation: PeerConversation
    private let onJoin: ((Peer) -> Void)?

    init(
        conversation: PeerConversation,
        waving: Set<String>,
        onJoin: ((Peer) -> Void)?,
        onSelect: ((Peer) -> Void)?
    ) {
        self.conversation = conversation
        self.onJoin = onJoin
        super.init(frame: .zero)

        let title = NSTextField(labelWithString: conversation.title)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .semibold)
        title.textColor = StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let count = conversation.peers.count
        let detail = NSTextField(labelWithString: String(localized: "Talking · \(count) people"))
        detail.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        detail.textColor = StarlingsColors.secondaryText

        let text = NSStackView(views: [title, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1

        var header: [NSView] = [text, NSView()]
        // No way in when you are already in it, and none when this Mac has no
        // business joining — an empty frame beats a button that cannot work.
        if onJoin != nil, conversation.peers.contains(where: { !$0.isSelf }),
           !conversation.peers.contains(where: \.isSelf) {
            let join = NSButton(title: String(localized: "Join"), target: self, action: #selector(joinPressed))
            SettingsChrome.applySecondaryButton(join, title: String(localized: "Join"), height: 24)
            join.translatesAutoresizingMaskIntoConstraints = false
            join.widthAnchor.constraint(equalToConstant: 62).isActive = true
            join.heightAnchor.constraint(equalToConstant: 24).isActive = true
            header.append(join)
        }

        let headerRow = NSStackView(views: header)
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 8

        let faces = NSStackView(views: conversation.peers.map { peer in
            WorkLoungeTileView(
                peer: peer,
                isWaving: waving.contains(peer.email.lowercased()),
                onSelect: onSelect
            )
        })
        faces.orientation = .horizontal
        faces.alignment = .top
        faces.spacing = WorkLoungeTileView.spacing
        faces.setClippingResistancePriority(.defaultLow, for: .horizontal)
        faces.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let stack = NSStackView(views: [headerRow, faces])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false

        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
            headerRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])

        wantsLayer = true
        layer?.cornerRadius = 14
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: self).cgColor
        layer?.borderWidth = 1
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        setAccessibilityLabel(String(localized: "\(conversation.title), talking"))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: self).cgColor
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
    }

    @objc private func joinPressed() {
        guard let target = conversation.peers.first(where: { !$0.isSelf }) else { return }
        onJoin?(target)
    }
}

/// Your own row, above the grid: who you are and the one control that answers
/// the whole status question.
@MainActor
private final class WorkLoungeSelfStrip: NSView {
    var onChange: ((PeerStatusOption) -> Void)?
    var onMessage: (() -> Void)?

    private let avatar = StarlingsPersonAvatarView(
        identity: StarlingsAvatarIdentity(displayName: "You", email: nil),
        diameter: 34
    )
    private let nameLabel = NSTextField(labelWithString: "")
    private let reminderLabel = NSTextField(labelWithString: PeerStatusOption.appearOfflineReminder)
    private let unreadDot = WorkSidebarRowView.unreadDotView()
    private let popup = NSPopUpButton(frame: .zero, pullsDown: false)
    private var canMessage = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        nameLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(14), weight: .semibold)
        nameLabel.textColor = StarlingsColors.primaryText
        nameLabel.allowSqueezing()
        let nameRow = NSStackView(views: [nameLabel, unreadDot])
        nameRow.alignment = .centerY
        nameRow.spacing = 6
        // Shown only while you appear offline — your own roster looks normal
        // to you, so this is the one place that says nobody else sees you.
        reminderLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        reminderLabel.textColor = StarlingsColors.secondaryText
        reminderLabel.allowSqueezing()
        reminderLabel.isHidden = true
        let text = NSStackView(views: [nameRow, reminderLabel])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1
        unreadDot.isHidden = true

        for option in PeerStatusOption.allCases {
            popup.addItem(withTitle: option.label)
        }
        popup.bezelStyle = .inline
        popup.isBordered = false
        popup.font = .systemFont(ofSize: StarlingsTypography.scaled(12), weight: .medium)
        popup.target = self
        popup.action = #selector(statusChanged)
        popup.translatesAutoresizingMaskIntoConstraints = false
        SettingsChrome.applyQuietButton(popup)

        // **The strip is the Message button.** Opening the conversation is
        // what clicking a person does everywhere else in Meet, and a row that
        // carries an explicit Message beside it says the row itself does
        // something else. It does not. The status popup keeps its own hit
        // area; the rest of the strip opens notes to self.
        popup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let row = NSStackView(views: [avatar, text, NSView(), popup])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false
        avatar.translatesAutoresizingMaskIntoConstraints = false

        addSubview(row)
        NSLayoutConstraint.activate([
            avatar.widthAnchor.constraint(equalToConstant: 34),
            avatar.heightAnchor.constraint(equalToConstant: 34),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 44),
        ])
        // A strip pinned edge to edge in the middle column must not be able
        // to set that column's width — see `StarlingsShellViewController`.
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.defaultLow, for: .horizontal)
        setAccessibilityLabel(String(localized: "Notes to self"))
        // The strip is a button, so it lifts like one — but only once it has
        // someone to open; `setPeer` turns it on.
        applyMeetHoverLift(cornerRadius: 8).isEnabled = false
    }

    override func mouseDown(with event: NSEvent) {
        guard canMessage else { return super.mouseDown(with: event) }
        onMessage?()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setPeer(_ peer: Peer?, hasUnread: Bool = false) {
        avatar.setIdentity(peer.map(StarlingsAvatarIdentity.init(peer:))
            ?? StarlingsAvatarIdentity(displayName: "You"))
        avatar.setStatus(peer?.displayState.dot)
        nameLabel.stringValue = peer?.displayName ?? String(localized: "You")
        canMessage = peer != nil
        meetHoverMonitor?.isEnabled = canMessage
        unreadDot.isHidden = !hasUnread
        reminderLabel.isHidden = !(peer?.invisible ?? false)
        popup.selectItem(at: PeerStatusOption.selectedIndex(for: peer))
    }

    @objc private func statusChanged() {
        let options = PeerStatusOption.allCases
        let index = popup.indexOfSelectedItem
        guard options.indices.contains(index) else { return }
        onChange?(options[index])
    }

}

/// One person, as a tile: who they are and what they are doing.
@MainActor
private final class WorkLoungeTileView: NSView {
    static let width: CGFloat = 168
    static let spacing: CGFloat = 10

    private let peer: Peer
    private let onSelect: ((Peer) -> Void)?

    init(
        peer: Peer,
        isWaving: Bool = false,
        onSelect: ((Peer) -> Void)?
    ) {
        self.peer = peer
        self.onSelect = onSelect
        super.init(frame: .zero)

        // No presence dot on an agent, for the reason the sidebar row gives:
        // the dot is evidence about a device, and an agent has none.
        let avatar = StarlingsPersonAvatarView(
            identity: StarlingsAvatarIdentity(peer: peer),
            diameter: 44,
            status: peer.isAgent ? nil : peer.displayState.dot
        )
        avatar.translatesAutoresizingMaskIntoConstraints = false

        let name = NSTextField(labelWithString: peer.displayName)
        name.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        name.textColor = StarlingsColors.primaryText
        name.alignment = .center
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let state = NSTextField(labelWithString: WorkLoungeTileView.stateLine(for: peer))
        state.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        state.textColor = StarlingsColors.secondaryText
        state.alignment = .center
        state.lineBreakMode = .byTruncatingTail
        state.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        var views: [NSView] = [avatar, name, state]

        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false

        addSubview(stack)
        // **The width is a wish; the ceiling is the rule.**
        //
        // This constraint used to be `.defaultHigh`, which is high enough to
        // count toward the pane's fitting width — and the pane's fitting width
        // is where the window's resize floor comes from. Six agents at 168pt
        // plus spacing and insets is 1090pt, and that number turned up intact
        // as the Team window's minimum: 1612 with both panels open, 1331 with
        // one. The grid could not be squeezed, so the pane never narrowed, so
        // `columnCount()` never dropped, so the tiles never rewrapped. A row
        // that refuses to give is a row that can never wrap.
        //
        // Split in two instead. `<=` is a ceiling: a tile is never wider than
        // this, which is what stops a short row from stretching its tiles
        // across the window, and a `lessThanOrEqual` can never ask the window
        // to grow. The preferred width drops to `.defaultLow` so it yields the
        // moment the column is squeezed — for the one layout pass it takes the
        // grid to notice and rebuild at fewer columns.
        let tileWidth = widthAnchor.constraint(equalToConstant: Self.width)
        tileWidth.priority = .defaultLow
        NSLayoutConstraint.activate([
            widthAnchor.constraint(lessThanOrEqualToConstant: Self.width),
            avatar.widthAnchor.constraint(equalToConstant: 44),
            avatar.heightAnchor.constraint(equalToConstant: 44),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            tileWidth,
        ])

        // Invariant 18: AppKit hands out no pointer feedback of its own, so a
        // tile that does not lift is a tile nobody knows is clickable.
        applyMeetHoverLift(base: StarlingsColors.panel, cornerRadius: 12)
        setAccessibilityLabel(
            isWaving
                ? String(localized: "\(peer.displayName) is waving at you")
                : "\(peer.displayName), \(WorkLoungeTileView.stateLine(for: peer))"
        )
        if isWaving { startWaving() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Somebody is waving at *you*, and this is which somebody.
    ///
    /// The chime says a wave arrived; a person looking at the grid still has to
    /// find who sent it, and reading six tiles for a highlight is exactly the
    /// work a wave is supposed to save. It breathes rather than blinks — this
    /// runs for the whole life of the ring, and a blink for forty-five seconds
    /// is a fault indicator, not a person saying hello.
    private func startWaving() {
        wantsLayer = true
        let pulse = CABasicAnimation(keyPath: "borderWidth")
        pulse.fromValue = 0
        pulse.toValue = 2
        pulse.duration = 0.9
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
        layer?.add(pulse, forKey: "waving")
    }

    override func mouseDown(with event: NSEvent) {
        guard let onSelect else { return super.mouseDown(with: event) }
        onSelect(peer)
    }

    /// The roster row's line without the devices: a tile has one line under
    /// a name. One builder for both (`teamPeerSubtitle`), so a person reads
    /// the same in the lounge and on the rail.
    static func stateLine(for peer: Peer) -> String {
        teamPeerSubtitle(for: peer, devices: false)
    }
}
