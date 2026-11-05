import AppKit

/// The popover for one Quick Note, the Mac's peer of the phone's drawer
/// (`MobileQuickNoteSheet`): the body to rewrite, then File…, Copy, Delete.
/// Anchored to the row it came from. The panel that opens it owns the
/// writes; the popover only reports what was chosen and closes when the
/// panel says the save landed.
@MainActor
final class QuickNotePopover: NSPopover, NSTextFieldDelegate {
    let note: QuickNote
    var onSave: ((QuickNote, String) -> Void)?
    var onFile: ((QuickNote) -> Void)?
    var onDelete: ((QuickNote) -> Void)?

    private let field = StarlingsTextField(placeholder: String(localized: "What’s on your mind?"))
    private let saveButton = StarlingsFilledButton(style: .accent, title: String(localized: "Save"))
    private let fileButton = NSButton(title: String(localized: "File…"), target: nil, action: nil)
    private let copyButton = NSButton(title: String(localized: "Copy"), target: nil, action: nil)
    private let deleteButton = NSButton(title: String(localized: "Delete"), target: nil, action: nil)
    private let statusLabel = StarlingsTypography.wrappingLabel("")
    private var isSaving = false

    init(note: QuickNote) {
        self.note = note
        super.init()
        behavior = .transient
        contentViewController = NSViewController()
        contentViewController?.view = buildView()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(relativeTo row: NSView) {
        show(relativeTo: row.bounds, of: row, preferredEdge: .maxY)
        field.window?.makeFirstResponder(field)
        field.currentEditor()?.selectedRange = NSRange(location: note.body.utf16.count, length: 0)
    }

    /// The panel's save state, so the popover can lock while a write is out
    /// and show why it failed.
    func setSaving(_ saving: Bool, error: String? = nil) {
        isSaving = saving
        field.isEnabled = !saving
        fileButton.isEnabled = !saving
        copyButton.isEnabled = !saving
        deleteButton.isEnabled = !saving
        saveButton.isEnabled = !saving && canSave
        saveButton.apply(
            .accent,
            title: saving ? String(localized: "Saving…") : String(localized: "Save"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            cornerRadius: StarlingsTextField.fieldCornerRadius,
            height: StarlingsTextField.fieldHeight
        )
        let message = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        statusLabel.stringValue = message
        statusLabel.isHidden = message.isEmpty
    }

    private var canSave: Bool {
        let body = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return !body.isEmpty && body != note.body
    }

    func controlTextDidChange(_ notification: Notification) {
        saveButton.isEnabled = !isSaving && canSave
    }

    /// The field editor takes Esc for completion; here it closes the popover
    /// and drops the unsaved rewrite. A write in flight holds it open.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard commandSelector == #selector(NSResponder.cancelOperation(_:)) else { return false }
        if !isSaving { close() }
        return true
    }

    private func buildView() -> NSView {
        field.stringValue = note.body
        field.delegate = self
        field.target = self
        field.action = #selector(saveTapped)

        saveButton.apply(
            .accent,
            title: String(localized: "Save"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            cornerRadius: StarlingsTextField.fieldCornerRadius,
            height: StarlingsTextField.fieldHeight
        )
        saveButton.target = self
        saveButton.action = #selector(saveTapped)
        saveButton.isEnabled = false

        for (button, action) in [
            (fileButton, #selector(fileTapped)),
            (copyButton, #selector(copyTapped)),
            (deleteButton, #selector(deleteTapped)),
        ] {
            button.target = self
            button.action = action
            SettingsChrome.applySecondaryButton(button, height: StarlingsTextField.fieldHeight)
        }
        deleteButton.contentTintColor = StarlingsColors.danger
        deleteButton.attributedTitle = NSAttributedString(string: "Delete", attributes: [
            .foregroundColor: StarlingsColors.danger,
            .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
        ])
        statusLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        statusLabel.textColor = StarlingsColors.danger
        statusLabel.maximumNumberOfLines = 2
        statusLabel.isHidden = true

        let actions = NSStackView(views: [fileButton, copyButton, NSView(), deleteButton, saveButton])
        actions.orientation = .horizontal
        actions.spacing = 8

        let column = NSStackView(views: [field, statusLabel, actions])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 10
        column.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        let view = NSView()
        view.addSubview(column)
        column.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            column.topAnchor.constraint(equalTo: view.topAnchor),
            column.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            view.widthAnchor.constraint(equalToConstant: 420),
            field.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -32),
            statusLabel.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -32),
            actions.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -32),
        ])
        return view
    }

    @objc private func saveTapped() {
        guard canSave, !isSaving else { return }
        onSave?(note, field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    @objc private func fileTapped() {
        close()
        onFile?(note)
    }

    @objc private func copyTapped() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(note.body, forType: .string)
        close()
    }

    @objc private func deleteTapped() {
        close()
        onDelete?(note)
    }
}
