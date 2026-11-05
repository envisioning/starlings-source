import EnvisioningUI
import SwiftUI

/// Durable history filed under one project or lead — Core interactions plus
/// the subject's quiet event trail (`postSubjectEvent`, docs/WORK.md §3b),
/// merged by time. This is deliberately still separate from Talk: a message
/// is conversation, this pane is memory. See docs/TIMELINE.md Phase 1.
struct MobileSubjectInteractionsView: View {
    let subject: CrmSubject
    /// Owned by `MobileSubjectView`, not here — the tab bar's "(n)" needs this
    /// list before this pane has ever been opened. Counts interactions only,
    /// same as the Mac badge: an event is already counted wherever it came
    /// from (a task, an issue), not a second time here.
    @Binding private var interactions: [CrmInteraction]

    @EnvironmentObject private var app: StarlingsAppModel
    @State private var filter: CrmInteractionFilter = .all
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var updatedAt: Date?
    /// Fetched best-effort alongside interactions; a failure here never blocks
    /// the pane. See `loadEvents`.
    @State private var events: [ThreadMessage] = []
    /// The Log sheet's draft, while it is open.
    @State private var logging: CrmInteractionDraft?

    init(subject: CrmSubject, interactions: Binding<[CrmInteraction]>) {
        self.subject = subject
        _interactions = interactions
    }

    private enum TimelineEntry: Identifiable {
        case interaction(CrmInteraction)
        case event(ThreadMessage)

        var id: String {
            switch self {
            case .interaction(let interaction): interaction.id
            case .event(let message): message.id
            }
        }

        var sortDate: Date {
            switch self {
            case .interaction(let interaction): interaction.date ?? .distantPast
            case .event(let message): message.sentAt
            }
        }

        var groupDate: Date? {
            switch self {
            case .interaction(let interaction): interaction.date
            case .event(let message): message.sentAt
            }
        }
    }

    private struct InteractionGroup: Identifiable {
        let title: String
        let rows: [TimelineEntry]
        var id: String { title }
    }

    /// Events only join the list under **All types** — a filter narrowed to
    /// one interaction kind is asking for that kind specifically, and mixing
    /// every event in would answer a different question than the one asked.
    private var visibleGroups: [InteractionGroup] {
        var entries: [TimelineEntry] = interactions
            .filter { filter.matches($0) }
            .map(TimelineEntry.interaction)
        if filter == .all {
            entries += events.map(TimelineEntry.event)
        }
        let visible = entries.sorted { $0.sortDate > $1.sortDate }
        var groups: [InteractionGroup] = []
        for entry in visible {
            let title = groupTitle(for: entry.groupDate)
            if let index = groups.firstIndex(where: { $0.title == title }) {
                groups[index] = InteractionGroup(title: title, rows: groups[index].rows + [entry])
            } else {
                groups.append(InteractionGroup(title: title, rows: [entry]))
            }
        }
        return groups
    }

    var body: some View {
        StarlingsList {
            if let errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage, updatedAt: interactions.isEmpty ? nil : updatedAt) {
                        Task { await load() }
                    }
                }
            }

            if !interactions.isEmpty {
                Section {
                    Picker("Filter interactions by type", selection: $filter) {
                        ForEach(CrmInteractionFilter.allCases) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    .pickerStyle(.menu)
                } header: {
                    Text("\(interactions.filter { filter.matches($0) }.count) of \(interactions.count) interactions")
                }
            }

            ForEach(visibleGroups) { group in
                Section(group.title) {
                    ForEach(group.rows) { entry in
                        switch entry {
                        case .interaction(let interaction):
                            NavigationLink {
                                MobileInteractionReaderView(interaction: interaction, subject: subject) {
                                    Task { await load() }
                                }
                            } label: {
                                MobileInteractionRow(interaction: interaction)
                            }
                        case .event(let message):
                            // Not yet clickable — same as Talk's event lines
                            // (docs/WORK.md §3b), until refs open their target.
                            MobileEventRow(message: message)
                        }
                    }
                }
            }

            if interactions.isEmpty && isLoading {
                Section { EnvisioningPlaceholderRows() }
            }
            if visibleGroups.isEmpty && !isLoading && errorMessage == nil {
                Section {
                    Text(interactions.isEmpty
                        ? String(localized: "Nothing filed under \(subject.title) yet.")
                        : "No \(filter.title.lowercased()) match this subject.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .refreshable { await load() }
        .task(id: subject.id) { await load() }
        .toolbar {
            // An event has no History yet (docs/EVENTS.md slice 3).
            if !subject.isEvent {
                ToolbarItem(placement: .topBarTrailing) {
                    // The one write on the screen, filled like Tasks' `+`.
                    Button {
                        logging = CrmInteractionDraft(subject: subject)
                    } label: {
                        Image(systemName: "plus")
                    }
                    .meetToolbarProminent()
                    .accessibilityLabel("Log")
                }
            }
        }
        .sheet(item: $logging) { draft in
            MobileInteractionEditor(draft: draft) { _ in
                Task { await load() }
            }
            .meetAlertHost()
        }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        let (projectID, leadID, organizationID) = StarlingsAPI.interactionsQuery(for: subject)
        // Last known first (docs/CACHING.md): History paints from its
        // snapshot before Core answers; the event trail follows the live read.
        if interactions.isEmpty,
           let cached = app.api.snapshot(
               StarlingsAPI.interactionsSnapshotKey(projectID: projectID, leadID: leadID, organizationID: organizationID),
               credentials: credentials, as: CrmInteractionsResponse.self
           ) {
            interactions = cached.value.interactions
            updatedAt = cached.savedAt
        }
        isLoading = interactions.isEmpty
        defer { isLoading = false }
        do {
            interactions = try await app.api.crmInteractions(
                credentials: credentials, projectID: projectID, leadID: leadID, organizationID: organizationID
            )
            updatedAt = Date()
            errorMessage = nil
            // A partner has no thread in this slice (PARTNERS (HQ Docs)).
            events = subject.isPartner ? [] : await loadEvents(credentials: credentials)
        } catch {
            // The snapshot stays; the line above says the refresh failed.
            errorMessage = error.localizedDescription
        }
    }

    /// The subject's quiet event trail (docs/WORK.md §3b) — the same lines
    /// Talk draws, read here independently so this pane doesn't need Talk to
    /// have been opened first. Best-effort: a thread that fails to open or
    /// fetch just means no events show up this time, and never becomes this
    /// pane's `errorMessage`, which stays reserved for the interactions read.
    private func loadEvents(credentials: MobileOwnerCredentials) async -> [ThreadMessage] {
        do {
            let thread = try await app.api.openSubjectThread(
                credentials: credentials, kind: subject.kind, subjectID: subject.id
            )
            let page = try await app.api.messages(credentials: credentials, threadID: thread.id, limit: 50)
            return page.messages.filter(\.isEvent)
        } catch {
            return []
        }
    }

    private func groupTitle(for date: Date?) -> String {
        guard let date else { return "Undated" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return StarlingsDateFormatting.date(date)
    }
}

/// Uses `MobileWorkRow`'s shell, same as Mine's task and issue rows — the
/// timeline should not read as a third row grammar next to those two.
private struct MobileEventRow: View {
    let message: ThreadMessage

    var body: some View {
        MobileWorkRow(title: message.text) {
            MobileCompactMark(
                systemName: symbolName,
                shape: usesSquareMark ? .square : .round,
                size: 18
            )
        } metadata: {
            Text(message.sentAt.meetDateTimeString(dateStyle: .abbreviated))
        }
        .accessibilityElement(children: .combine)
    }

    private var symbolName: String {
        switch message.refs.first?.kind.rawValue {
        case "meeting": "video.fill"
        case "task": "checkmark"
        case "issue": "tag.fill"
        case "pull": "arrow.triangle.merge"
        case "commit": "point.3.connected.trianglepath.dotted"
        case "run": "gearshape.2"
        case "release": "shippingbox"
        default: "bolt.horizontal.circle"
        }
    }

    private var usesSquareMark: Bool {
        switch message.refs.first?.kind.rawValue {
        case "task", "issue": true
        default: false
        }
    }
}

private struct MobileInteractionRow: View {
    let interaction: CrmInteraction

    var body: some View {
        MobileWorkRow(title: interaction.displayTitle) {
            MobileCompactMark(
                systemName: interaction.symbolName,
                shape: interaction.type.rawValue == "note" ? .square : .round,
                size: 18
            )
        } metadata: {
            Text(meta)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(interaction.accessibilityLabel)
    }

    private var meta: String {
        var parts = [interaction.typeLabel]
        if let date = interaction.date {
            parts.append(date.meetDateTimeString(dateStyle: .abbreviated))
        }
        if let duration = interaction.durationMinutes {
            parts.append(String(localized: "\(duration) min"))
        }
        if let people = interaction.peopleLabel {
            parts.append(people)
        }
        return parts.joined(separator: " · ")
    }
}

private struct MobileInteractionReaderView: View {
    @State private var interaction: CrmInteraction
    let subject: CrmSubject
    /// History re-reads after an edit or a delete here.
    let onChanged: () -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @State private var editing: CrmInteractionDraft?
    /// The delete question, while it is asked; the task's own question.
    @State private var deleting: MobileTaskDeletion?
    @State private var busy = false
    @State private var errorMessage: String?

    init(interaction: CrmInteraction, subject: CrmSubject, onChanged: @escaping () -> Void) {
        _interaction = State(initialValue: interaction)
        self.subject = subject
        self.onChanged = onChanged
    }

    var body: some View {
        StarlingsList {
            Section {
                detail(String(localized: "Type"), interaction.typeLabel)
                if let date = interaction.date {
                    detail(String(localized: "Occurred"), date.meetDateTimeString(dateStyle: .abbreviated))
                }
                if let people = interaction.peopleLabel {
                    detail(String(localized: "People"), people)
                }
                if let duration = interaction.durationMinutes {
                    detail(String(localized: "Duration"), "\(duration) minutes")
                }
                if let status = interaction.status, !status.isEmpty {
                    detail(String(localized: "Status"), status.capitalized)
                }
            }

            Section(interaction.previewLabel) {
                if let markdown = interaction.readerBody {
                    MobileMarkdownText(text: markdown)
                } else {
                    Text("No summary was filed for this interaction.")
                        .foregroundStyle(.secondary)
                }
            }

            if let rawURL = interaction.url, let url = URL(string: rawURL) {
                Section {
                    Button("Open source") { openURL(url) }
                }
            }

            if let errorMessage {
                Section {
                    StarlingsErrorNotice(message: errorMessage, font: .body)
                }
            }
            Section {
                Button("Edit") { editing = CrmInteractionDraft(editing: interaction, subject: subject) }
                    .disabled(busy).meetHoverLift(cornerRadius: EnvisioningRadius.control)
                // Asks first; the screen closes after.
                Button(TaskDeleteCopy.confirm, role: .destructive) {
                    deleting = MobileTaskDeletion(id: interaction.id, title: interaction.displayTitle)
                }
                .disabled(busy).meetHoverLift(cornerRadius: EnvisioningRadius.control)
            }
        }
        .navigationTitle(interaction.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .taskDeleteConfirmation($deleting) { _ in
            Task { await delete() }
        }
        .sheet(item: $editing) { draft in
            MobileInteractionEditor(draft: draft) { saved in
                interaction = saved
                errorMessage = nil
                onChanged()
            }
            .meetAlertHost()
        }
    }

    private func delete() async {
        guard !busy, let credentials = app.ownerCredentials else { return }
        busy = true
        defer { busy = false }
        do {
            try await app.api.deleteInteraction(credentials: credentials, id: interaction.id)
            errorMessage = nil
            onChanged()
            dismiss()
        } catch {
            errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    private func detail(_ title: String, _ value: String) -> some View {
        LabeledContent(title, value: value)
    }
}
