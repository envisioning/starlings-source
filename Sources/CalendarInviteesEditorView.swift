import AppKit

/// The event editor's invite list: one row per person with their reply, and
/// a line to add the next one. The shape Fantastical uses, and the opposite
/// of a chip field — addresses are long, a meeting can have ten, and a row
/// each gives every one a name, a reply mark and its own remove button.
///
/// Rows come from two places: the event's own attendees (with their reply)
/// and addresses typed here since (pending, drawn with a plus). `addresses`
/// is the list the save path writes — everyone but you, minus anyone
/// removed here.
@MainActor
final class CalendarInviteesEditorView: NSStackView, NSTextFieldDelegate {
    var onChange: (() -> Void)?
    /// People worth offering as you type: the Envisioning roster and known
    /// contacts, as (email, name). Asked at completion time, so the list is
    /// whatever the roster says now — nothing is written down here.
    var suggestions: (() -> [(email: String, name: String)])?
    /// The workspace's contacts that hold any of these addresses
    ///, or nil when the read failed. Asked once per opened event.
    var contactLookup: (([String]) async -> [CrmContact]?)?
    /// A guest who is a contact was pressed: their page in Work.
    var onOpenContact: ((CrmContact) -> Void)?

    /// Guests who are contacts, by lower-cased address. Empty until the read
    /// answers, and left empty when it fails: the rows stay as the event
    /// names them.
    private var contacts: [String: CrmContact] = [:]
    private var contactLookupTask: Task<Void, Never>?
    private var existing: [CalendarAttendeeSummary] = []
    private var removed: Set<String> = []
    private var added: [String] = []
    private var contactNames: [String: String] = [:]
    private let rows = NSStackView()
    private let addField = StarlingsTextField(placeholder: String(localized: "Add invitee"))

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        orientation = .vertical
        alignment = .leading
        spacing = 6

        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 2
        rows.translatesAutoresizingMaskIntoConstraints = false

        addField.delegate = self
        addField.target = self
        addField.action = #selector(addTapped)
        // A round add button inside the field's right edge.
        let addButton = StarlingsFieldButton.make(symbol: "plus", label: String(localized: "Add invitee"))
        addButton.target = self
        addButton.action = #selector(addTapped)
        StarlingsFieldButton.seat(addButton, in: addField)

        addArrangedSubview(rows)
        addArrangedSubview(addField)
        rows.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        addField.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Start over from an event's list. Emails without a summary (EventKit,
    /// a cached event) become plain rows with no reply mark. `lookUpContacts`
    /// names the guests who are contacts, for an opened event only.
    func setAttendees(_ attendees: [CalendarAttendeeSummary], emails: [String], lookUpContacts: Bool = false) {
        var seen = Set<String>()
        var list: [CalendarAttendeeSummary] = []
        for attendee in attendees where !attendee.email.isEmpty {
            let key = attendee.email.lowercased()
            guard seen.insert(key).inserted else { continue }
            list.append(attendee)
        }
        for email in emails {
            let key = email.lowercased()
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            list.append(CalendarAttendeeSummary(name: "", email: key, status: "unknown", optional: false, isSelf: false))
        }
        existing = list
        removed = []
        added = []
        addField.stringValue = ""
        contactNames = ContactEmailDirectory.displayNameByEmail()
        contacts = [:]
        contactLookupTask?.cancel()
        contactLookupTask = nil
        render()
        let wanted = lookUpContacts ? CrmContact.attendeeLookupAddresses(list) : []
        if !wanted.isEmpty, contactLookup != nil {
            contactLookupTask = Task { @MainActor [weak self] in
                guard let self, let found = await contactLookup?(wanted), !Task.isCancelled else { return }
                let matched = CrmContact.byAddress(found, among: wanted)
                guard !matched.isEmpty else { return }
                contacts = matched
                render()
            }
        }
    }

    /// What the save writes: every address still on the list except yours.
    var addresses: [String] {
        existing
            .filter { !$0.isSelf && !removed.contains($0.email.lowercased()) }
            .map { $0.email.lowercased() }
            + added
    }

    private func render() {
        rows.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for attendee in existing where !removed.contains(attendee.email.lowercased()) {
            let email = attendee.email.lowercased()
            let contact = attendee.isSelf ? nil : contacts[email]
            let context = contact?.context ?? ""
            add(row(
                status: attendee.status,
                isMember: attendee.isMember,
                title: contact?.displayName ?? displayName(for: attendee),
                detail: attendee.isSelf ? "you" : !context.isEmpty ? context : (attendee.name.isEmpty || attendee.name == attendee.email ? nil : attendee.email),
                removable: !attendee.isSelf,
                email: email,
                contact: contact
            ))
        }
        for email in added {
            add(row(
                status: nil,
                isMember: CalendarAttendeeSummary.isMemberAddress(email),
                title: contactNames[email] ?? email,
                detail: contactNames[email] == nil ? nil : email,
                removable: true,
                email: email
            ))
        }
    }

    /// Add, then pin the width: a constraint between a row and `rows` can
    /// only be activated once they share a superview, and activating it
    /// early raised an NSException that AppKit swallowed on the run loop —
    /// taking the rest of the inspector's render with it.
    private func add(_ row: NSView) {
        rows.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
    }

    private func displayName(for attendee: CalendarAttendeeSummary) -> String {
        if let known = contactNames[attendee.email.lowercased()] { return known }
        if !attendee.name.isEmpty { return attendee.name }
        return attendee.email
    }

    private func row(
        status: String?,
        isMember: Bool,
        title: String,
        detail: String?,
        removable: Bool,
        email: String,
        contact: CrmContact? = nil
    ) -> NSView {
        // The same face the cards draw: profile picture for a Meet member,
        // initials otherwise, the RSVP on its corner.
        let face = CalendarAttendeeAvatarView(name: title, email: email, status: status, isMember: isMember, size: 20)
        if status == "declined" { face.alphaValue = 0.55 }

        let name = NSTextField(labelWithString: title)
        name.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        name.textColor = StarlingsColors.primaryText
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.setContentHuggingPriority(.defaultLow, for: .horizontal)
        if status == "declined" { name.alphaValue = 0.55 }

        var identity: [NSView] = [face, name]
        if let detail {
            let secondary = NSTextField(labelWithString: detail)
            secondary.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            secondary.textColor = StarlingsColors.secondaryText
            secondary.lineBreakMode = .byTruncatingTail
            secondary.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            identity.append(secondary)
        }
        var views: [NSView]
        if let contact {
            // A guest who is a contact opens their page. The
            // face and the words are the press target; the remove button
            // stays its own.
            let press = CalendarInviteeContactPress(views: identity)
            press.orientation = .horizontal
            press.alignment = .centerY
            press.spacing = 6
            press.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            press.setContentHuggingPriority(.defaultLow, for: .horizontal)
            press.toolTip = String(localized: "Open contact")
            press.setAccessibilityLabel(detail.map { "\(title), \($0)" } ?? title)
            press.onPress = { [weak self] in self?.onOpenContact?(contact) }
            views = [press]
        } else {
            views = identity
        }
        views.append(NSView())
        if removable {
            let remove = NSButton(
                image: NSImage(systemSymbolName: "xmark", accessibilityDescription: String(localized: "Remove"))?
                    .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold)) ?? NSImage(),
                target: self,
                action: #selector(removeTapped(_:))
            )
            remove.imagePosition = .imageOnly
            remove.bezelStyle = .inline
            remove.contentTintColor = StarlingsColors.secondaryText
            remove.toolTip = String(localized: "Remove \(email)")
            remove.setAccessibilityLabel(String(localized: "Remove \(title)"))
            remove.identifier = NSUserInterfaceItemIdentifier(email)
            SettingsChrome.applyQuietButton(remove, cornerRadius: 10)
            remove.widthAnchor.constraint(equalToConstant: 20).isActive = true
            remove.heightAnchor.constraint(equalToConstant: 20).isActive = true
            views.append(remove)
        }

        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.distribution = .fill
        row.spacing = 6
        row.heightAnchor.constraint(equalToConstant: 26).isActive = true
        return row
    }

    @objc private func removeTapped(_ sender: NSButton) {
        guard let email = sender.identifier?.rawValue else { return }
        if let index = added.firstIndex(of: email) {
            added.remove(at: index)
        } else {
            removed.insert(email)
        }
        render()
        onChange?()
    }

    /// Return adds; so does a comma or semicolon while typing. Anything that
    /// is not an address stays in the field.
    @objc private func addTapped() {
        commit()
    }

    func controlTextDidChange(_ notification: Notification) {
        if addField.stringValue.contains(where: { $0 == "," || $0 == ";" }) {
            commit()
            return
        }
        // AppKit's own completion dropdown, fed by `control(_:textView:completions:…)`.
        // Asked for once per keystroke; the guard stops it from re-opening
        // while the field editor is applying a completion.
        guard !isCompleting, !addField.stringValue.trimmingCharacters(in: .whitespaces).isEmpty,
              let editor = addField.currentEditor() as? NSTextView else { return }
        isCompleting = true
        editor.complete(nil)
        isCompleting = false
    }

    private var isCompleting = false

    func control(
        _ control: NSControl,
        textView: NSTextView,
        completions words: [String],
        forPartialWordRange charRange: NSRange,
        indexOfSelectedItem index: UnsafeMutablePointer<Int>
    ) -> [String] {
        let typed = (textView.string as NSString).substring(with: charRange).lowercased()
        guard !typed.isEmpty, let suggestions = suggestions?() else { return [] }
        let taken = Set(addresses)
        index.pointee = -1
        return suggestions
            .filter { !taken.contains($0.email.lowercased()) }
            .filter { $0.email.lowercased().hasPrefix(typed) || $0.name.lowercased().split(separator: " ").contains { $0.hasPrefix(typed) } }
            .prefix(8)
            .map(\.email)
    }

    private func commit() {
        let parts = addField.stringValue
            .split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        var rejected: [String] = []
        for part in parts {
            guard part.contains("@"), part.contains(".") else { rejected.append(part); continue }
            let present = existing.contains { $0.email.lowercased() == part && !removed.contains(part) } || added.contains(part)
            if removed.contains(part) { removed.remove(part) } else if !present { added.append(part) }
        }
        addField.stringValue = rejected.joined(separator: " ")
        render()
        onChange?()
    }
}

/// A guest row's face and words, pressable when the guest is a contact
///. The labels are presentation only: the row is the hit
/// target, so a press lands here and not on a label.
@MainActor
private final class CalendarInviteeContactPress: NSStackView {
    var onPress: (() -> Void)?

    override func hitTest(_ point: NSPoint) -> NSView? {
        super.hitTest(point) == nil ? nil : self
    }

    override func mouseDown(with event: NSEvent) {}

    override func mouseUp(with event: NSEvent) {
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        onPress?()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }

    override func accessibilityPerformPress() -> Bool {
        onPress?()
        return true
    }
}
