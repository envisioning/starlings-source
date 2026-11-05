import EnvisioningUI
import SwiftUI

/// Settings › Calendar › Booking hours on the phone. The same
/// editor as the web's `BookingSettings.tsx` and the Mac's
/// `BookingHoursSettingsView`: the hours and the zone are the member's profile
/// hours, the rest is how a guest books a slot inside them. Save writes the
/// whole form once, as the web does.
struct MobileBookingHoursView: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @ObservedObject var store: MobileCalendarStore

    @State private var saved: BookingSettingsResponse?
    @State private var draft: BookingSettingsUpdate?
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var message: String?

    var body: some View {
        StarlingsList {
            Section {
                Text(BookingHours.note(room: saved?.room))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if saved?.room != nil, store.googleConnectionKnown, !store.googleConnected {
                    StarlingsErrorNotice(message: BookingHours.notTakingBookingsWarning)
                }
                if draft == nil {
                    if let errorMessage {
                        StarlingsErrorNotice(message: errorMessage, retry: { Task { await load() } })
                    } else if app.ownerCredentials == nil {
                        Text("Sign in to load your booking hours.")
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                }
            } header: {
                Text(CalendarSettingsRegistry.title(for: .bookingHours))
            }

            if draft != nil {
                Section {
                    Toggle("Take bookings", isOn: field(\.active, fallback: false))
                        .meetToggleTint()
                        .disabled(isSaving)
                    StarlingsSearchablePicker(
                        label: String(localized: "Time zone"),
                        placeholder: String(localized: "Time zone"),
                        options: BookingHours.timeZoneOptions(current: draft?.timezone),
                        selection: field(\.timezone, fallback: ""),
                        emptyMessage: String(localized: "No options match that search.")
                    )
                    .disabled(isSaving)
                }

                Section {
                    ForEach(BookingWeekday.allCases) { day in
                        dayRow(day)
                    }
                } header: {
                    Text("Days")
                }

                Section {
                    ForEach(BookingHours.numberFields) { number in
                        numberRow(number)
                    }
                }

                Section {
                    Button(isSaving ? String(localized: "Saving…") : String(localized: "Save booking hours")) {
                        Task { await save() }
                    }
                    .buttonStyle(StarlingsFilledButtonStyle())
                    .disabled(isSaving)
                    if let message {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if let errorMessage {
                        StarlingsErrorNotice(message: errorMessage)
                    }
                }
            }
        }
        .navigationTitle(CalendarSettingsRegistry.title(for: .bookingHours))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: app.ownerCredentials?.accessToken) { await load() }
    }

    private func dayRow(_ day: BookingWeekday) -> some View {
        let hours = draft?.weeklyHours[day] ?? BookingHours.defaultWeek[day]
        return VStack(alignment: .leading, spacing: 6) {
            Toggle(day.label, isOn: Binding(
                get: { hours.enabled },
                set: { changeDay(day, hours.with(enabled: $0)) }
            ))
            .meetToggleTint()
            HStack(spacing: 8) {
                clockPicker(
                    String(localized: "\(day.label) from"),
                    minute: hours.startMinute
                ) { changeDay(day, hours.with(startMinute: $0)) }
                Text("to")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                clockPicker(
                    String(localized: "\(day.label) until"),
                    minute: hours.endMinute
                ) { changeDay(day, hours.with(endMinute: $0)) }
                Spacer(minLength: 0)
            }
            .disabled(!hours.enabled)
        }
        .disabled(isSaving)
    }

    private func clockPicker(_ label: String, minute: Int, set: @escaping (Int) -> Void) -> some View {
        Picker(label, selection: Binding(get: { minute }, set: set)) {
            ForEach(BookingHours.clockMinutes, id: \.self) { value in
                Text(BookingHours.clock(value)).tag(value)
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .accessibilityLabel(label)
    }

    private func numberRow(_ number: BookingHours.NumberField) -> some View {
        HStack(spacing: 12) {
            Text(number.label)
            Spacer(minLength: 8)
            TextField(
                number.label,
                value: Binding(
                    get: { draft?[keyPath: number.id] ?? number.range.lowerBound },
                    set: { value in change { $0[keyPath: number.id] = number.clamped(value) } }
                ),
                format: .number
            )
            .keyboardType(.numberPad)
            .multilineTextAlignment(.trailing)
            .meetField()
            .frame(width: 88)
            .accessibilityLabel(number.label)
        }
        .disabled(isSaving)
    }

    private func field<Value>(_ keyPath: WritableKeyPath<BookingSettingsUpdate, Value>, fallback: Value) -> Binding<Value> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? fallback },
            set: { value in change { $0[keyPath: keyPath] = value } }
        )
    }

    private func change(_ edit: (inout BookingSettingsUpdate) -> Void) {
        guard var next = draft else { return }
        edit(&next)
        draft = next
        message = nil
    }

    private func changeDay(_ day: BookingWeekday, _ hours: BookingDayHours) {
        change { $0.weeklyHours = $0.weeklyHours.replacing(day, with: hours) }
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else {
            saved = nil
            draft = nil
            errorMessage = nil
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let loaded = try await app.api.bookingSettings(credentials: credentials)
            saved = loaded
            draft = BookingHours.draft(from: loaded)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }

    private func save() async {
        guard let credentials = app.ownerCredentials, let draft, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        message = nil
        defer { isSaving = false }
        do {
            let next = try await app.api.saveBookingSettings(credentials: credentials, update: draft)
            saved = next
            self.draft = BookingHours.draft(from: next)
            message = BookingHours.saved
        } catch {
            errorMessage = (error as? StarlingsError)?.message ?? error.localizedDescription
        }
    }
}
