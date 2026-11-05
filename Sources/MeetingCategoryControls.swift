import AppKit

/// Live-meeting CRM filing controls (Envisioning-only). Kind first; subject list
/// appears for Lead / Project. Guests never see this chrome.
final class MeetingCategoryControls: NSView {
    var onChange: ((MeetingCategoryKind, CrmSubject?) -> Void)?
    /// The door from a filed meeting to the subject it is about — its talk,
    /// its tasks, its issues — without a search. Offered only once a subject
    /// is chosen; a door to nowhere is worse than none.
    var onOpenSubject: ((CrmSubject) -> Void)?

    private let kindPopup = NSPopUpButton()
    private let subjectPicker = StarlingsSearchablePickerField(frame: .zero)
    private let statusLabel = NSTextField(labelWithString: "")
    private let openButton = NSButton(title: String(localized: "Open in Work"), target: nil, action: nil)
    private let stack = NSStackView()

    private var subjects: [CrmSubject] = []
    private var selectedKind: MeetingCategoryKind = .uncategorized
    private var selectedSubject: CrmSubject? {
        didSet { openButton.isHidden = selectedSubject == nil }
    }
    private var isApplying = false
    /// Partner is offered where the surface files on one: the live-meeting rail
    /// and, per the subject registry, a calendar event.
    var offersPartner = false {
        didSet {
            guard oldValue != offersPartner else { return }
            rebuildKindPopup()
        }
    }
    private var kinds: [MeetingCategoryKind] {
        MeetingCategoryKind.filingMenu(offersPartner: offersPartner, current: selectedKind)
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true

        kindPopup.controlSize = .regular
        kindPopup.target = self
        kindPopup.action = #selector(kindChanged(_:))
        rebuildKindPopup()

        subjectPicker.setOptions([], placeholder: String(localized: "Choose a subject"), selectedID: nil)
        subjectPicker.onSelection = { [weak self] id in
            guard let self, let subject = subjects.first(where: { "\($0.kind):\($0.id)" == id }) else { return }
            selectedSubject = subject
            onChange?(selectedKind, subject)
        }
        subjectPicker.isHidden = true

        statusLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        statusLabel.textColor = StarlingsColors.secondaryText
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusLabel.stringValue = String(localized: "Files this meeting’s notes on its subject.")

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        // No CRM title here: the rail's own foldable section heads this block.
        stack.addArrangedSubview(kindPopup)
        stack.addArrangedSubview(subjectPicker)
        stack.addArrangedSubview(statusLabel)

        openButton.bezelStyle = .inline
        openButton.controlSize = .small
        SettingsChrome.applyQuietButton(openButton)
        if let image = NSImage(systemSymbolName: "tray.full.fill", accessibilityDescription: nil) {
            openButton.image = image.withSymbolConfiguration(.init(pointSize: 11, weight: .medium))
            openButton.imagePosition = .imageLeading
        }
        openButton.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .medium)
        openButton.contentTintColor = StarlingsColors.secondaryText
        openButton.target = self
        openButton.action = #selector(openPressed)
        openButton.isHidden = true
        stack.addArrangedSubview(openButton)
        addSubview(stack)
        stack.pinToEdges(of: self)

        // A subject name runs long — "Envisioning — Client Discovery Workshop"
        // measures 298pt — and these sit in Meet's rail, so at the default
        // compression resistance the chosen project decided how narrow the
        // rail could be. The name truncates instead.
        kindPopup.allowSqueezing(toAtLeast: MeetingViewController.railControlFloor)
        kindPopup.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        subjectPicker.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    private func rebuildKindPopup() {
        kindPopup.removeAllItems()
        for kind in kinds {
            kindPopup.addItem(withTitle: kind.menuTitle)
            kindPopup.lastItem?.representedObject = kind.rawValue
        }
        if let index = kinds.firstIndex(of: selectedKind) {
            kindPopup.selectItem(at: index)
        }
    }

    func apply(_ category: MeetingCategory) {
        isApplying = true
        defer { isApplying = false }
        selectedKind = category.meetingKind
        // The menu depends on the kind (`filingMenu`), so it is rebuilt; that selects it too.
        rebuildKindPopup()
        subjectPicker.isHidden = !category.meetingKind.needsSubject
        selectedSubject = nil
        if let title = category.subjectTitle, category.meetingKind.needsSubject {
            let id = category.subjectID
            if let id {
                selectedSubject = subjects.first { $0.id == id && $0.kind == category.meetingKind.rawValue }
                    ?? CrmSubject(id: id, kind: category.meetingKind.rawValue, title: title, subtitle: nil)
            }
            if let id, let index = subjects.firstIndex(where: { $0.id == id && $0.kind == category.meetingKind.rawValue }) {
                // The full list is already loaded (from setSubjects) — just move
                // the selection. Rebuilding here would collapse the dropdown
                // back down to this one item on every save/reload.
                subjectPicker.setOptions(pickerOptions(subjects), placeholder: String(localized: "Choose a subject"), selectedID: "\(subjects[index].kind):\(subjects[index].id)")
            } else {
                // First paint before any fetch has landed: show a placeholder
                // for the saved selection so the label isn't blank. setSubjects
                // replaces this with the real list, and preserves it, once the
                // fetch completes.
                subjects = id.map {
                    [CrmSubject(id: $0, kind: category.meetingKind.rawValue, title: title, subtitle: nil)]
                } ?? []
                subjectPicker.setOptions(
                    pickerOptions(subjects),
                    placeholder: String(localized: "Choose a subject"),
                    selectedID: id.map { "\(category.meetingKind.rawValue):\($0)" }
                )
            }
        }
        statusLabel.stringValue = statusCopy(for: category)
    }

    func setSubjects(_ items: [CrmSubject], selecting id: String?) {
        subjects = items.filter { $0.kind == selectedKind.rawValue }
        if let id, let match = subjects.first(where: { $0.id == id }) {
            selectedSubject = match
        }
        if let id, !subjects.contains(where: { $0.id == id }), let selectedSubject, selectedSubject.id == id {
            subjects.append(selectedSubject)
        }
        subjectPicker.isHidden = !selectedKind.needsSubject
        if items.isEmpty {
            let empty: String = switch selectedKind {
            case .lead: String(localized: "No leads found")
            case .partner: String(localized: "No partners found")
            case .event: String(localized: "No events found")
            default: String(localized: "No projects found")
            }
            subjectPicker.setOptions([], placeholder: empty, selectedID: nil)
            return
        }
        let selected = id.map { "\(selectedKind.rawValue):\($0)" }
            ?? selectedSubject.map { "\($0.kind):\($0.id)" }
        subjectPicker.setOptions(pickerOptions(subjects), placeholder: String(localized: "Choose a subject"), selectedID: selected)
    }

    func setBusy(_ busy: Bool, message: String? = nil) {
        kindPopup.isEnabled = !busy
        subjectPicker.isEnabled = !busy
        if let message {
            statusLabel.stringValue = message
        }
    }

    @objc private func kindChanged(_ sender: NSPopUpButton) {
        guard !isApplying,
              let raw = sender.selectedItem?.representedObject as? String,
              let kind = MeetingCategoryKind(rawValue: raw)
        else { return }
        selectedKind = kind
        selectedSubject = nil
        subjectPicker.isHidden = !kind.needsSubject
        if !kind.needsSubject {
            onChange?(kind, nil)
        } else {
            statusLabel.stringValue = String(localized: "Pick a \(kind.menuTitle.lowercased())…")
            subjectPicker.setOptions([], placeholder: String(localized: "Choose a subject"), selectedID: nil)
            onChange?(kind, nil)
        }
    }

    @objc private func openPressed() {
        guard let selectedSubject else { return }
        onOpenSubject?(selectedSubject)
    }

    private func statusCopy(for category: MeetingCategory) -> String {
        switch category.meetingKind {
        case .uncategorized:
            return String(localized: "Not filed yet. The transcript still saves.")
        case .status:
            return String(localized: "Filed as Status.")
        case .internal:
            return String(localized: "Filed as Internal.")
        case .lead:
            return category.subjectTitle.map { "Lead: \($0)" } ?? String(localized: "Lead selected.")
        case .project:
            return category.subjectTitle.map { "Project: \($0)" } ?? String(localized: "Project selected.")
        case .partner:
            return category.subjectTitle.map { "Partner: \($0)" } ?? String(localized: "Partner selected.")
        case .event:
            return category.subjectTitle.map { "Event: \($0)" } ?? String(localized: "Event selected.")
        case .personal:
            return String(localized: "Filed as Personal.")
        }
    }

    private func pickerOptions(_ subjects: [CrmSubject]) -> [StarlingsSearchablePickerOption] {
        subjects.map { subject in
            let context = MeetingCategoryKind(rawValue: subject.kind)?.menuTitle ?? MeetingCategoryKind.lead.menuTitle
            return StarlingsSearchablePickerOption(
                id: "\(subject.kind):\(subject.id)",
                title: subject.title,
                context: context,
                subtitle: subject.subtitle
            )
        }
    }
}
