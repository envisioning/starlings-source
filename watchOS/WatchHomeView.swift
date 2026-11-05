import SwiftUI
import StarlingsContracts

/// The face. What is next, today's work, and the notes. Nothing scrolls far.
struct WatchHomeView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        NavigationStack(path: $store.path) {
            Group {
                if store.isSignedIn {
                    signedIn
                } else {
                    VStack(spacing: 8) {
                        Text("Open Starlings on your phone")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        WatchVersionLine()
                    }
                }
            }
            .navigationTitle("Starlings")
            .navigationDestination(for: WatchRoute.self) { route in
                switch route {
                case .note: WatchNoteCaptureView()
                case .work: WatchWorkView()
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let notice = store.notice {
                Text(notice)
                    .font(.footnote)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial, in: Capsule())
                    .task {
                        try? await Task.sleep(for: .seconds(2))
                        store.notice = nil
                    }
            }
        }
    }

    private var signedIn: some View {
        // The clock, not the snapshot, decides what is still ahead — the
        // phone may not have sent since a meeting ended.
        TimelineView(.everyMinute) { timeline in
            let upcoming = store.upcoming(now: timeline.date)
            List {
                Section {
                    if let next = upcoming.first {
                        WatchMeetingRow(meeting: next, now: timeline.date, hero: true)
                        if upcoming.count > 1 {
                            WatchMeetingRow(meeting: upcoming[1], now: timeline.date, hero: false)
                        }
                    } else {
                        Text("Nothing scheduled")
                            .foregroundStyle(.secondary)
                    }
                }
                if !store.work.isEmpty {
                    Section {
                        NavigationLink(value: WatchRoute.work) {
                            Label(WatchBridgeSnapshot.WorkRow.summary(store.work), systemImage: "checkmark.circle")
                        }
                    }
                }
                Section {
                    WatchNoteButton()
                    NavigationLink {
                        WatchNotesView()
                    } label: {
                        Label(notesLabel, systemImage: "note.text")
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if store.sessionStale {
                            Text("Open Starlings on your phone to reconnect.")
                        }
                        // Which workspace and account this is.
                        ForEach([store.workspaceName, store.ownerName, store.ownerEmail].compactMap { $0 }.filter { !$0.isEmpty }, id: \.self) { line in
                            Text(verbatim: line)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        WatchVersionLine()
                    }
                }
            }
        }
    }

    private var notesLabel: String {
        let count = store.notes.count + store.pendingNotes.count
        return count == 0 ? String(localized: "Notes") : String(localized: "Notes · \(count)")
    }

}

private struct WatchMeetingRow: View {
    let meeting: WatchBridgeSnapshot.Meeting
    let now: Date
    let hero: Bool

    private var inProgress: Bool { meeting.start <= now }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(meeting.title)
                .font(hero ? .headline : .body)
                .lineLimit(2)
            HStack(spacing: 4) {
                Text(inProgress ? String(localized: "Ends \(StarlingsDateFormatting.time(meeting.end))") : StarlingsDateFormatting.time(meeting.start))
                if !meeting.calendarName.isEmpty {
                    Text("·")
                    Text(meeting.calendarName).lineLimit(1)
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            if hero {
                // Home's rounding, never seconds; the face re-renders each minute.
                Text(StarlingsDateFormatting.compactDuration(until: inProgress ? meeting.end : meeting.start, from: now))
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.tint)
            }
        }
    }
}

/// Where the glyph complication lands: the capture control alone, one tap
/// from dictation. watchOS gives an app no way to open dictation by itself.
struct WatchNoteCaptureView: View {
    var body: some View {
        List {
            WatchNoteButton()
        }
        .navigationTitle("Note")
    }
}

/// Today's work, read-only: what the phone's Home lists as overdue and due
/// today. Ticking a task off stays on the phone and the Mac.
struct WatchWorkView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        List {
            if store.work.isEmpty {
                Text("Nothing due today")
                    .foregroundStyle(.secondary)
            }
            ForEach(store.work) { row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).lineLimit(3)
                    if let line = Self.detail(row) {
                        Text(line)
                            .font(.footnote)
                            .foregroundStyle(row.overdue ? .primary : .secondary)
                    }
                }
            }
        }
        .navigationTitle("Today")
    }

    private static func detail(_ row: WatchBridgeSnapshot.WorkRow) -> String? {
        let parts = [row.overdue ? String(localized: "Overdue") : nil, row.subjectTitle].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// Dictate a note. The one capture control, on the face and in the list.
struct WatchNoteButton: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        TextFieldLink(prompt: Text("Note")) {
            Label("New note", systemImage: "mic.fill")
        } onSubmit: { text in
            Task { await store.saveNote(text) }
        }
        .disabled(store.isSavingNote)
    }
}

/// The owner's open notes, and the ones still on the wrist. Filed notes live
/// on the phone and the Mac, where triage is.
struct WatchNotesView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        List {
            WatchNoteButton()
            ForEach(store.pendingNotes) { pending in
                VStack(alignment: .leading, spacing: 2) {
                    Text(pending.body).lineLimit(3)
                    Text("Waiting to send")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .swipeActions {
                    Button(role: .destructive) {
                        store.discard(pending)
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
            ForEach(store.notes) { note in
                NavigationLink {
                    WatchNoteDetailView(noteID: note.id)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(note.body).lineLimit(3)
                        Text(note.detailLabel)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .swipeActions {
                    Button(role: .destructive) {
                        Task { await store.delete(note) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
            if store.notes.isEmpty && store.pendingNotes.isEmpty {
                Text(store.notesUnavailable ? String(localized: "Couldn’t load notes") : String(localized: "No open notes"))
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Notes")
        .task { await store.refreshNotes() }
    }
}

/// One note in full: add a line by dictation, or delete it.
struct WatchNoteDetailView: View {
    @EnvironmentObject private var store: WatchStore
    @Environment(\.dismiss) private var dismiss
    let noteID: String
    @State private var confirmingDelete = false

    private var note: QuickNote? { store.notes.first { $0.id == noteID } }

    var body: some View {
        ScrollView {
            if let note {
                VStack(alignment: .leading, spacing: 8) {
                    Text(note.body)
                    Text(note.detailLabel)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    TextFieldLink(prompt: Text("Add")) {
                        Label("Add to note", systemImage: "mic.fill")
                    } onSubmit: { text in
                        Task { await store.append(text, to: note) }
                    }
                    Button(role: .destructive) {
                        confirmingDelete = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
                .disabled(store.busyNotes.contains(note.id))
                .confirmationDialog("Delete this note?", isPresented: $confirmingDelete) {
                    Button("Delete", role: .destructive) {
                        Task {
                            await store.delete(note)
                            if store.notes.first(where: { $0.id == noteID }) == nil { dismiss() }
                        }
                    }
                }
            }
        }
        .navigationTitle("Note")
    }
}

/// `Version 0.9.0 · Build 245`, from this bundle. The watch app ships inside
/// the phone app with the same numbers (`Config/Version.xcconfig`), so this
/// also says which phone build it came with.
struct WatchVersionLine: View {
    var body: some View {
        Text("Version \(Self.marketing) · Build \(Self.build)")
            .font(.footnote)
            .foregroundStyle(.secondary)
    }

    private static var marketing: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–"
    }

    private static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "–"
    }
}
