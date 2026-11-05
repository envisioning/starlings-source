import EnvisioningUI
import SwiftUI
import StarlingsContracts

struct MobileScheduleComposer: View {
    let room: OwnerRoomConfiguration
    let events: [MobileCalendarEvent]
    let publicEvents: [PublicEventsCalendar.Event]
    let isCreating: Bool
    let onCreate: (MobileScheduleDraft) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var draft = MobileScheduleDraft()
    @State private var attendeeInput = ""
    @State private var contacts: [MobileContactSuggestion] = []
    @State private var showWeekends = false
    @State private var localError: String?

    private let contactDirectory = MobileContacts()
    private let durations = [30, 45, 60, 90]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    agenda
                    form
                }
                .padding(18)
                .frame(maxWidth: 920)
                .frame(maxWidth: .infinity)
            }
            .background(StarlingsMobileColors.canvas.ignoresSafeArea())
            .navigationTitle("Schedule meeting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { StarlingsSheetCloseButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isCreating ? String(localized: "Adding…") : String(localized: "Add")) { create() }
                        .disabled(isCreating || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .meetToolbarConfirm()
                }
            }
        }
        .task { contacts = await contactDirectory.load() }
        .meetErrorAlert("Couldn’t schedule", message: $localError)
    }

    private var agenda: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("AGENDA").font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                if !publicEvents.isEmpty {
                    // Neutral ink + the same "globe" glyph the day cells below
                    // use for a public event, in place of a colour swatch
                    // (docs/DESIGN.md, "The accent budget").
                    HStack(spacing: 5) {
                        Image(systemName: "globe")
                            .font(.caption2.weight(.semibold))
                        Text("Public")
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }
                Toggle("Weekends", isOn: $showWeekends)
                    .labelsHidden()
                    .meetToggleTint()
                Text("Weekends").font(.caption)
            }
            MobileAgendaStrip(
                start: $draft.start,
                timeZone: draft.timeZone,
                events: events,
                publicEvents: publicEvents,
                showWeekends: showWeekends
            )
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 18) {
            labeled("TITLE") {
                TextField("Meeting title", text: $draft.title)
                    .textInputAutocapitalization(.sentences)
                    .meetField()
            }

            StarlingsCard {
                VStack(alignment: .leading, spacing: 14) {
                    Text("WHEN").font(.caption.bold()).foregroundStyle(.secondary)
                    DatePicker("Starts", selection: $draft.start, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                        .environment(\.timeZone, draft.timeZone.timeZone)
                    HStack(spacing: 8) {
                        ForEach(durations, id: \.self) { duration in
                            Button("\(duration)m") { draft.durationMinutes = duration }
                                .font(.caption.bold())
                                .frame(maxWidth: .infinity, minHeight: 36)
                                .foregroundStyle(draft.durationMinutes == duration ? StarlingsMobileColors.accentInk : Color.primary)
                                .meetContainerShape(cornerRadius: EnvisioningRadius.field)
                                .meetConcentricBackground(
                                    draft.durationMinutes == duration ? StarlingsMobileColors.accent : StarlingsMobileColors.elevated,
                                    fallbackRadius: EnvisioningRadius.field
                                )
                        }
                    }
                    Text("Ends \(draft.end.meetTimeString())")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("TIMEZONE").font(.caption.bold()).foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(StarlingsScheduleTimeZone.offered, id: \.self) { zone in
                                Button(shortName(zone)) {
                                    draft.timeZone = zone
                                    zone.savePreferred()
                                }
                                .font(.caption.bold())
                                .padding(.horizontal, 12)
                                .frame(minHeight: 34)
                                .foregroundStyle(draft.timeZone == zone ? StarlingsMobileColors.accentInk : Color.primary)
                                .meetContainerShape(cornerRadius: EnvisioningRadius.field)
                                .meetConcentricBackground(
                                    draft.timeZone == zone ? StarlingsMobileColors.accent : StarlingsMobileColors.elevated,
                                    fallbackRadius: EnvisioningRadius.field
                                )
                            }
                        }
                    }
                }
            }

            labeled("GUESTS") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(draft.attendees, id: \.self) { email in
                        HStack {
                            Image(systemName: "person.fill")
                            Text(email).lineLimit(1)
                            Spacer()
                            Button { draft.attendees.removeAll { $0 == email } } label: { Image(systemName: "xmark.circle.fill") }
                                .accessibilityLabel("Remove \(email)")
                        }
                        .font(.subheadline)
                        .padding(10)
                        .meetContainerShape(cornerRadius: EnvisioningRadius.field)
                        .meetConcentricBackground(
                            StarlingsMobileColors.elevated,
                            fallbackRadius: EnvisioningRadius.field
                        )
                    }
                    TextField("Type a name or email", text: $attendeeInput)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .submitLabel(.done)
                        .onSubmit(addTypedAttendee)
                        .meetField()
                    ForEach(matchingContacts.prefix(5)) { contact in
                        Button {
                            addAttendee(contact.email)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(contact.name.isEmpty ? contact.email : contact.name)
                                    if !contact.name.isEmpty { Text(contact.email).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                Image(systemName: "plus.circle")
                            }
                            .padding(.horizontal, 6)
                            .padding(.vertical, 4)
                            .contentShape(Rectangle())
                            .meetHoverLift(cornerRadius: EnvisioningRadius.field)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            StarlingsCard {
                VStack(alignment: .leading, spacing: 5) {
                    Text("JOIN LINK").font(.caption.bold()).foregroundStyle(.secondary)
                    Text(MeetingInvite.absoluteURL(slug: room.slug))
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                }
            }

            Button { create() } label: {
                Label(isCreating ? String(localized: "Adding to Calendar…") : String(localized: "Add to Calendar"), systemImage: "calendar.badge.plus")
            }
            .buttonStyle(StarlingsFilledButtonStyle())
            .disabled(isCreating || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func labeled<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.caption.bold()).foregroundStyle(.secondary)
            content()
        }
    }

    private var matchingContacts: [MobileContactSuggestion] {
        let query = attendeeInput.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        return contacts.filter {
            ($0.name.lowercased().contains(query) || $0.email.contains(query))
                && !draft.attendees.contains($0.email)
        }
    }

    private func addTypedAttendee() {
        let value = attendeeInput.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.contains("@") else { return }
        addAttendee(value)
    }

    private func addAttendee(_ email: String) {
        guard !draft.attendees.contains(email), draft.attendees.count < 50 else { return }
        draft.attendees.append(email)
        attendeeInput = ""
    }

    private func create() {
        addTypedAttendee()
        Task {
            if await onCreate(draft) { dismiss() }
            else { localError = "Couldn’t create event. Check Schedule for details." }
        }
    }

    private func shortName(_ zone: StarlingsScheduleTimeZone) -> String {
        zone.shortLabel
    }
}

private struct MobileAgendaStrip: View {
    /// The card grows with the text size so a 34pt title still fits.
    @ScaledMetric(relativeTo: .body) private var cardWidth: CGFloat = 132
    @ScaledMetric(relativeTo: .body) private var cardHeight: CGFloat = 205

    @Binding var start: Date
    let timeZone: StarlingsScheduleTimeZone
    let events: [MobileCalendarEvent]
    let publicEvents: [PublicEventsCalendar.Event]
    let showWeekends: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: true) {
                LazyHStack(alignment: .top, spacing: 8) {
                    ForEach(days, id: \.self) { day in
                        dayColumn(day)
                            .id(dayID(day))
                    }
                }
                .padding(.vertical, 2)
            }
            .onAppear { proxy.scrollTo(dayID(start), anchor: .center) }
            .onChange(of: start) { _, value in proxy.scrollTo(dayID(value), anchor: .center) }
        }
    }

    private var calendar: Calendar { timeZone.calendar }

    private var days: [Date] {
        let beginning = calendar.startOfDay(for: .now)
        let candidates = (0..<50).compactMap { calendar.date(byAdding: .day, value: $0, to: beginning) }
        let visible = showWeekends ? candidates : candidates.filter {
            let weekday = calendar.component(.weekday, from: $0)
            return weekday != 1 && weekday != 7
        }
        return Array(visible.prefix(showWeekends ? 42 : 30))
    }

    private func dayColumn(_ day: Date) -> some View {
        let selected = calendar.isDate(day, inSameDayAs: start)
        let items = agendaItems(on: day)
        return Button {
            let time = calendar.dateComponents([.hour, .minute], from: start)
            var date = calendar.dateComponents([.year, .month, .day], from: day)
            date.hour = time.hour
            date.minute = time.minute
            if let next = calendar.date(from: date) { start = next }
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                Text(day.formatted(.dateTime.weekday(.abbreviated))).font(.caption.bold())
                Text(day.formatted(.dateTime.month(.abbreviated).day())).font(.headline)
                Divider().overlay(StarlingsMobileColors.border)
                        if items.isEmpty {
                            Text("Open").font(.caption).foregroundStyle(.secondary)
                        } else {
                            ForEach(items.prefix(5)) { item in
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                                        if item.isPublic {
                                            Image(systemName: "globe")
                                                .font(.caption2.weight(.semibold))
                                        }
                                        Text(item.title).lineLimit(2)
                                    }
                                    if let date = item.start {
                                        Text(date.meetTimeString())
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .font(.caption.weight(.medium))
                                .padding(7)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                // Neutral fill/border for a public event now —
                                // the globe glyph above is what marks it, not
                                // a colour (docs/DESIGN.md, "The accent
                                // budget").
                                .foregroundStyle(Color.primary)
                                .meetContainerShape(cornerRadius: EnvisioningRadius.field)
                                .meetConcentricBackground(
                                    item.isPublic ? StarlingsMobileColors.panel : StarlingsMobileColors.elevated,
                                    fallbackRadius: EnvisioningRadius.field
                                )
                                .meetConcentricBorder(
                                    item.isPublic ? Color.secondary.opacity(0.5) : .clear,
                                    fallbackRadius: EnvisioningRadius.field,
                                    lineWidth: item.isPublic ? 1 : 0
                                )
                            }
                        }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(width: cardWidth, height: cardHeight, alignment: .topLeading)
            .foregroundStyle(.primary)
            .meetContainerShape(cornerRadius: EnvisioningRadius.control)
            // A chosen day is a state, not a call to action: the neutral
            // `selected` step with a muted edge.
            .meetConcentricBackground(
                selected ? StarlingsMobileColors.selected : StarlingsMobileColors.elevated,
                fallbackRadius: EnvisioningRadius.control
            )
            .meetConcentricBorder(
                selected ? Color.secondary.opacity(0.55) : StarlingsMobileColors.border,
                fallbackRadius: EnvisioningRadius.control,
                lineWidth: 1
            )
            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
        }
        .buttonStyle(.plain)
    }

    private func agendaItems(on day: Date) -> [AgendaItem] {
        let privateItems = events.compactMap { event -> AgendaItem? in
            guard let date = event.startDate, calendar.isDate(date, inSameDayAs: day) else { return nil }
            return AgendaItem(id: "calendar:\(event.id)", title: event.title, start: date, isPublic: false)
        }
        let publicItems = publicEvents.compactMap { event -> AgendaItem? in
            let date = ISODate.parse(event.start) ?? dateOnly(event.start)
            guard let date, calendar.isDate(date, inSameDayAs: day) else { return nil }
            return AgendaItem(id: "public:\(event.id)", title: event.title, start: event.isAllDay ? nil : date, isPublic: true)
        }
        return (privateItems + publicItems).sorted { ($0.start ?? day) < ($1.start ?? day) }
    }

    private func dateOnly(_ value: String) -> Date? {
        guard value.count == 10 else { return nil }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    private func dayID(_ day: Date) -> String {
        let values = calendar.dateComponents([.year, .month, .day], from: day)
        return String(localized: "\(values.year ?? 0)-\(values.month ?? 0)-\(values.day ?? 0)")
    }

    private struct AgendaItem: Identifiable {
        let id: String
        let title: String
        let start: Date?
        let isPublic: Bool
    }
}
