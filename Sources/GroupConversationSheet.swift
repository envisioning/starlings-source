import AppKit

/// Choosing who is in a private conversation.
///
/// One decision, made once, in one sheet — a flow that asked for each name
/// separately would make starting a conversation feel like building something.
/// Two people is the floor: one is the direct message already on their roster
/// row, and offering the same thing twice is how a surface gets confusing.
///
/// Nothing is created here. The sheet answers who was chosen, and the caller
/// opens the conversation, which is find-or-create at the Worker — so choosing
/// the same people twice reopens what already exists rather than making a
/// second one.
@MainActor
enum GroupConversationSheet {
    static func present(
        in window: NSWindow?,
        candidates: [Peer],
        maximum: Int,
        onChoose: @escaping ([Peer]) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = String(localized: "New group")
        alert.informativeText = String(localized: "Everyone you choose can read it.")
        alert.addButton(withTitle: String(localized: "Open"))
        alert.addButton(withTitle: String(localized: "Cancel"))

        let picker = GroupPickerView(candidates: candidates, maximum: maximum)
        alert.accessoryView = picker
        // Nothing chosen is not a group, so the button that makes one is off
        // until it would make one.
        let open = alert.buttons[0]
        open.isEnabled = false
        picker.onChange = { chosen in open.isEnabled = chosen.count >= 2 }

        let handle: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .alertFirstButtonReturn else { return }
            onChoose(picker.chosen)
        }
        if let window {
            alert.beginSheetModal(for: window, completionHandler: handle)
        } else {
            handle(alert.runModal())
        }
    }
}

/// The checkboxes. Scrolls, because a roster is as long as the company is.
@MainActor
private final class GroupPickerView: NSView {
    var onChange: (([Peer]) -> Void)?
    private(set) var chosen: [Peer] = []

    private let candidates: [Peer]
    private let maximum: Int
    private var boxes: [NSButton] = []

    init(candidates: [Peer], maximum: Int) {
        self.candidates = candidates
        self.maximum = maximum
        super.init(frame: NSRect(x: 0, y: 0, width: 300, height: 220))

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false

        for (index, peer) in candidates.enumerated() {
            let box = NSButton(checkboxWithTitle: peer.displayName, target: self, action: #selector(toggled))
            box.applyMeetCheckboxStyle()
            box.tag = index
            boxes.append(box)
            stack.addArrangedSubview(box)
        }

        let document = NSView()
        document.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -4),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -4),
        ])

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.documentView = document
        scroll.translatesAutoresizingMaskIntoConstraints = false
        document.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            document.widthAnchor.constraint(equalTo: scroll.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Re-read from the boxes rather than tracked alongside them, so the list
    /// and the checkmarks cannot disagree. At the ceiling the unchecked boxes
    /// go off rather than the choice being refused after the fact — a limit
    /// that only speaks when you hit it is a limit that reads as a bug.
    @objc private func toggled(_ sender: NSButton) {
        chosen = boxes.enumerated()
            .filter { $0.element.state == .on }
            .map { candidates[$0.offset] }
        let atCeiling = chosen.count >= maximum
        for box in boxes where box.state == .off { box.isEnabled = !atCeiling }
        onChange?(chosen)
    }
}
