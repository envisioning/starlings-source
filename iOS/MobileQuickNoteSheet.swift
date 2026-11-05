import SwiftUI

/// The drawer for one Quick Note: its body to rewrite, and the three things
/// the Work row's menu offers it — File…, Copy, Delete (`WorkRowAction`).
/// Half height with the nub on top (`meetDrawer`), so the note stays a
/// small thing to touch up, not a screen. Home's card opens it on a tap.
///
/// Filing is the caller's: the drawer closes first, then the caller
/// presents the triage sheet (`MobileQuickNoteTriageSheet`) over the same
/// surface, since a sheet cannot open a sheet of its own.
struct MobileQuickNoteSheet: View {
    let note: QuickNote
    let file: (QuickNote) -> Void

    @EnvironmentObject private var notes: MobileQuickNotesStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var isFieldFocused: Bool

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !trimmed.isEmpty && trimmed != note.body && !notes.isSaving }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField("What’s on your mind?", text: $draft, axis: .vertical)
                        .meetSingleLine($draft, onSubmit: save)
                        .focused($isFieldFocused)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityLabel("Quick Note")
                }

                Section {
                    Button {
                        file(note)
                        dismiss()
                    } label: {
                        Label("File…", systemImage: "tray.and.arrow.down")
                    }
                    Button {
                        UIPasteboard.general.string = note.body
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                    Button(role: .destructive) {
                        Task { @MainActor in
                            if await notes.delete(note) {
                                StarlingsHaptics.destructive.play()
                                dismiss()
                            }
                        }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }

                if let error = notes.errorMessage {
                    Section {
                        StarlingsErrorNotice(message: error)
                    }
                }
            }
            .disabled(notes.isSaving)
            .navigationTitle("Quick Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(notes.isSaving ? String(localized: "Saving…") : String(localized: "Save")) { save() }
                        .disabled(!canSave)
                        .meetToolbarConfirm()
                }
            }
            .meetHaptic(.error, whenSet: notes.errorMessage)
        }
        .onAppear {
            draft = note.body
            isFieldFocused = true
        }
    }

    private func save() {
        guard canSave else { return }
        let value = draft
        Task { @MainActor in
            if await notes.update(note, body: value) {
                // Played directly: the sheet is gone before a trigger could fire.
                StarlingsHaptics.success.play()
                dismiss()
            }
        }
    }
}

/// A one-field capture drawer for Home's always-visible toolbar action. The
/// QUICK NOTES card keeps its inline composer; both write through the same
/// store. Filing is still a separate action on the saved note.
struct MobileQuickNoteCaptureSheet: View {
    @EnvironmentObject private var notes: MobileQuickNotesStore
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFieldFocused: Bool
    @State private var draft = ""

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canAdd: Bool { !trimmed.isEmpty && !notes.isSaving }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    TextField("What’s on your mind?", text: $draft, axis: .vertical)
                        .meetSingleLine($draft, onSubmit: add)
                        .focused($isFieldFocused)
                        .textInputAutocapitalization(.sentences)
                        .accessibilityLabel("Quick Note")
                }

                if let error = notes.errorMessage {
                    Section {
                        StarlingsErrorNotice(message: error)
                    }
                }
            }
            .disabled(notes.isSaving)
            .navigationTitle("New Quick Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(notes.isSaving ? String(localized: "Adding…") : String(localized: "Add")) { add() }
                        .disabled(!canAdd)
                        .meetToolbarConfirm()
                }
            }
            .meetHaptic(.error, whenSet: notes.errorMessage)
        }
        .onAppear { isFieldFocused = true }
    }

    private func add() {
        guard canAdd else { return }
        let value = draft
        Task { @MainActor in
            if await notes.create(body: value) {
                StarlingsHaptics.success.play()
                dismiss()
            }
        }
    }
}
