import EnvisioningUI
import SwiftUI

/// Home's low-friction capture card. The composer only captures; an
/// existing note opens in the drawer (`MobileQuickNoteSheet`), which is where
/// it is rewritten, filed, copied or deleted.
struct MobileQuickNotesCard: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var notes: MobileQuickNotesStore
    @State private var draft = ""
    @State private var isExpanded = false
    /// The note open in the drawer.
    @State private var editing: QuickNote?
    /// The note the drawer asked to file; the triage sheet opens once the
    /// drawer is down.
    @State private var filing: QuickNote?
    @State private var triageNote: QuickNote?
    @State private var haptic = StarlingsHapticPulse()
    @FocusState private var isFieldFocused: Bool
    /// How many pages of notes are unfolded; one page is the card at rest.
    /// Per launch, not stored.
    @State private var pages = 1
    /// Each open note's row height, from the measuring layer.
    @State private var rowHeights: [QuickNote.ID: CGFloat] = [:]
    /// How many notes the card keeps showing after an add (`QuickNotePage`):
    /// what was on screen plus the new notes. Cleared when the page changes.
    @State private var noteFloor = 0

    /// Quick Notes shows a page of notes (`QuickNotePage`). Every open note
    /// is measured in an unseen layer, so a page is cut by real heights.
    private static let rowSpacing: CGFloat = 12

    /// Home is the capture surface: what is still unfiled. Filed notes live
    /// in Work.
    private var open: [QuickNote] { notes.notes.filter(\.isOpen) }

    /// The notes on screen, and the ones folded away behind them.
    private var listed: [QuickNote] { Array(open.prefix(fits)) }
    private var hidden: Int { open.count - listed.count }

    private var fits: Int { fits(of: open.map(\.id)) }

    private func fits(of ids: [QuickNote.ID]) -> Int {
        QuickNotePage.count(
            of: ids,
            viewport: UIScreen.main.bounds.height,
            pages: pages,
            spacing: Self.rowSpacing,
            floor: noteFloor
        ) { rowHeights[$0] }
    }

    private var canSave: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !notes.isSaving
    }

    var body: some View {
        StarlingsCard {
            cardContent
        }
        // The New quick note control lands here: field open, keyboard up.
        .onChange(of: app.pendingQuickNote, initial: true) { _, pending in
            guard pending else { return }
            app.pendingQuickNote = false
            isExpanded = true
            isFieldFocused = true
        }
        // Adding a note never hides one that was showing.
        .onChange(of: open.map(\.id)) { old, new in
            noteFloor = QuickNotePage.floor(old: old, new: new, shown: fits(of: old), current: noteFloor)
        }
        .onChange(of: pages) { _, _ in noteFloor = 0 }
        // The field opens with the keyboard, whichever way it was opened.
        .onChange(of: isExpanded) { _, expanded in
            isFieldFocused = expanded
        }
        .meetHaptics(haptic)
        .meetHaptic(.error, whenSet: notes.errorMessage)
        .sheet(item: $editing, onDismiss: {
            if let filing {
                self.filing = nil
                triageNote = filing
            }
        }) { note in
            MobileQuickNoteSheet(note: note) { filing = $0 }
                .meetDrawer()
        }
        .sheet(item: $triageNote) { note in
            MobileQuickNoteTriageSheet(note: note)
                .meetDrawer()
        }
    }

    private var addButton: some View {
        Button {
            isExpanded = true
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
        }
        .buttonStyle(.plain)
        .meetHoverLift(cornerRadius: 16)
        .accessibilityLabel("Add Quick Note")
    }

    private var cardContent: some View {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text("QUICK NOTES")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Spacer()
                    if !open.isEmpty {
                        // The same count every Home card prints: caption-bold
                        // primary, the way MESSAGES says "2 new".
                        Text("\(open.count)")
                            .font(.caption.bold())
                            .foregroundStyle(.primary)
                    }
                    if !isExpanded { addButton }
                }

                if isExpanded {
                    // Wraps and grows to six lines, but Return saves (a vertical
                    // field never fires onSubmit, so meetSingleLine does). Keep the add action inside the rounded field,
                    // like the message composer.
                    HStack(alignment: .bottom, spacing: 8) {
                        TextField("What’s on your mind?", text: $draft, axis: .vertical)
                            .lineLimit(1...6)
                            .meetSingleLine($draft, onSubmit: save)
                            .focused($isFieldFocused)
                            .accessibilityLabel("Quick Note")
                            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)

                        Button(action: save) {
                            Image(systemName: "plus")
                                .font(.footnote.weight(.bold))
                                .foregroundStyle(StarlingsMobileColors.accentInk)
                                .frame(width: 26, height: 26)
                                .background(Circle().fill(StarlingsMobileColors.accent))
                        }
                        .buttonStyle(.plain)
                        .meetHoverLift(cornerRadius: 13)
                        .fixedSize()
                        .disabled(!canSave)
                        .opacity(canSave ? 1 : 0.4)
                        .accessibilityLabel(notes.isSaving ? String(localized: "Saving…") : String(localized: "Add Quick Note"))
                    }
                    .meetField(capitalization: .sentences, cornerRadius: 24)

                    if let error = notes.errorMessage {
                        StarlingsErrorNotice(message: error, font: .caption)
                    }
                }

                VStack(alignment: .leading, spacing: Self.rowSpacing) {
                    ForEach(listed) { note in
                        // The Home row (docs/DESIGN.md). A tap opens the note in
                        // the drawer.
                        MobileQuickNoteHomeRow(note: note, pending: notes.pending[note.id])
                            .contentShape(Rectangle())
                            .onTapGesture { editing = note } // hover: MobileQuickNoteHomeRow wears meetHomeRow
                            .accessibilityAddTraits(.isButton)
                            .accessibilityHint("Edit this note")
                            // Long press: the same list every note row draws, plus
                            // Edit, since Home opens the note itself.
                            .contextMenu {
                                WorkRowActionMenu(groups: note.rowActions(editable: true, moveTargets: notes.moveTargets), perform: perform)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    delete(note)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                }
                // Every open note, laid out unseen at the card's width, so a
                // page is cut by real heights and not by an average.
                .background(alignment: .top) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(open) { note in
                            MobileQuickNoteHomeRow(note: note, pending: notes.pending[note.id])
                                .fixedSize(horizontal: false, vertical: true)
                                .background(GeometryReader { proxy in
                                    Color.clear.preference(
                                        key: QuickNoteRowHeights.self,
                                        value: [note.id: proxy.size.height]
                                    )
                                })
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .hidden()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
                .onPreferenceChange(QuickNoteRowHeights.self) { rowHeights = $0 }

                if hidden > 0 {
                    foldButton(String(localized: "See \(hidden) more")) { pages += 1 }
                } else if pages > 1 {
                    foldButton(String(localized: "Show fewer")) { pages = 1 }
                }
            }
    }

    private func foldButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func save() {
        guard canSave else { return }
        let value = draft
        Task { @MainActor in
            if await notes.create(body: value) {
                draft = ""
                isExpanded = false
                haptic.fire(.success)
            }
        }
    }

    private func perform(_ action: WorkRowAction) {
        switch action {
        case .editNote(let note): editing = note
        case .fileNote(let note): triageNote = note
        case .deleteNote(let note): delete(note)
        case .moveNote(let note, let workspace):
            Task { @MainActor in
                if await notes.move(note, to: workspace) { haptic.fire(.success) }
            }
        default: break
        }
    }

    private func delete(_ note: QuickNote) {
        Task { @MainActor in
            if await notes.delete(note) { haptic.fire(.destructive) }
        }
    }

}

/// One Home row for a note: mark, then the note, whose body is its title.
/// Same tile as MESSAGES and WORK above. The card draws it, and measures it.
private struct MobileQuickNoteHomeRow: View {
    let note: QuickNote
    /// Still on this phone: the row says so, or says why the
    /// Worker refused it.
    var pending: QuickNotePending? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            MobileCompactMark(systemName: "pencil", shape: .square, size: 24)
                .meetFirstLineMark(.body)
            VStack(alignment: .leading, spacing: 3) {
                Text(note.body)
                    .font(.body)
                    .lineLimit(3)
                // When it was written, as the Mac and the browser draw a note.
                // "3 minutes ago" keeps counting, as MESSAGES' times do.
                if let refusal = pending?.lastError {
                    StarlingsErrorNotice(message: refusal, font: .caption)
                } else {
                    TimelineView(.periodic(from: .now, by: 30)) { _ in
                        let detail = pending == nil ? note.detailLabel : String(localized: "Not sent yet")
                        if !detail.isEmpty {
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .meetLineLimit(1)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .meetHomeRow()
    }
}

/// Row heights by note, collected from the measuring layer.
private struct QuickNoteRowHeights: PreferenceKey {
    static let defaultValue: [QuickNote.ID: CGFloat] = [:]
    static func reduce(value: inout [QuickNote.ID: CGFloat], nextValue: () -> [QuickNote.ID: CGFloat]) {
        value.merge(nextValue()) { $1 }
    }
}
