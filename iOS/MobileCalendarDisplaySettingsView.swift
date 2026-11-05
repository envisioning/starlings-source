import SwiftUI

/// Preferences that belong to this device's calendar window, not to the owner.
/// The Mac and iOS use the same keys and shared preference type; only this
/// compact editor is platform-specific.
struct MobileCalendarDisplaySettingsView: View {
    @ObservedObject var store: MobileCalendarStore

    @State private var startHour: Int
    @State private var endHour: Int
    @State private var duration: Int
    @State private var snap: Int
    @State private var defaultView: MobileCalendarLayout
    @State private var hourHeight: Double
    @State private var showsDeclined: Bool
    @State private var showsHidden: Bool

    init(store: MobileCalendarStore) {
        self.store = store
        let defaults = UserDefaults.standard
        _startHour = State(initialValue: CalendarWindowPreferences.dayStartHour(defaults))
        _endHour = State(initialValue: CalendarWindowPreferences.dayEndHour(defaults))
        _duration = State(initialValue: CalendarWindowPreferences.defaultDurationMinutes(defaults))
        _snap = State(initialValue: CalendarWindowPreferences.snapMinutes(defaults))
        let sharedView: MobileCalendarLayout = switch CalendarWindowPreferences.defaultView(defaults) {
        case .day: .day
        case .week: .threeDay
        case .month: .month
        }
        _defaultView = State(initialValue: MobileCalendarLayout.storedDefault(defaults) ?? sharedView)
        _hourHeight = State(initialValue: Double(CalendarWindowPreferences.hourHeight(defaults)))
        _showsDeclined = State(initialValue: CalendarWindowPreferences.showsDeclined(defaults))
        _showsHidden = State(initialValue: CalendarWindowPreferences.showsHidden(defaults))
    }

    var body: some View {
        StarlingsList {
            Section {
                Picker("Day view starts", selection: $startHour) {
                    ForEach(0..<24, id: \.self) { hour in
                        Text(hourLabel(hour)).tag(hour)
                    }
                }
                .onChange(of: startHour) { _, value in
                    CalendarWindowPreferences.setDayStartHour(value)
                    if endHour <= value {
                        endHour = min(23, value + 1)
                        CalendarWindowPreferences.setDayEndHour(endHour)
                    }
                    store.refreshDisplayPreferences()
                }

                Picker("Day view ends", selection: $endHour) {
                    ForEach(1..<24, id: \.self) { hour in
                        Text(hourLabel(hour)).tag(hour)
                    }
                }
                .onChange(of: endHour) { _, value in
                    CalendarWindowPreferences.setDayEndHour(value)
                    store.refreshDisplayPreferences()
                }

                Picker("Default event length", selection: $duration) {
                    ForEach(CalendarWindowPreferences.durationChoices, id: \.self) { minutes in
                        Text(durationLabel(minutes)).tag(minutes)
                    }
                }
                .onChange(of: duration) { _, value in
                    CalendarWindowPreferences.setDefaultDurationMinutes(value)
                    store.refreshDisplayPreferences()
                }

                Picker("Snap events to", selection: $snap) {
                    ForEach(CalendarWindowPreferences.snapChoices, id: \.self) { minutes in
                        Text("\(minutes) minutes").tag(minutes)
                    }
                }
                .onChange(of: snap) { _, value in
                    CalendarWindowPreferences.setSnapMinutes(value)
                    store.refreshDisplayPreferences()
                }

                // Every layout the toolbar offers, in the same order. A view
                // you can switch to but cannot open on is a hole in the list.
                Picker("Default view", selection: $defaultView) {
                    ForEach(MobileCalendarLayout.allCases) { layout in
                        Label(layout.label, systemImage: layout.symbolName).tag(layout)
                    }
                }
                .onChange(of: defaultView) { _, value in
                    // Writes the shared day/week/month value too: the Mac reads
                    // that one, and its multi-day view is the week.
                    MobileCalendarLayout.setStoredDefault(value)
                    store.layout = value
                    store.refreshDisplayPreferences()
                }

                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Grid scale")
                        Spacer()
                        Text("\(Int(hourHeight)) pt")
                            .foregroundStyle(.secondary)
                    }
                    Slider(
                        value: $hourHeight,
                        in: Double(CalendarWindowPreferences.hourHeightRange.lowerBound)...Double(CalendarWindowPreferences.hourHeightRange.upperBound),
                        step: 4
                    )
                    .onChange(of: hourHeight) { _, value in
                        CalendarWindowPreferences.setHourHeight(CGFloat(value))
                        store.refreshDisplayPreferences()
                    }
                }

                Toggle("Show declined events", isOn: $showsDeclined)
                    .meetToggleTint()
                    .onChange(of: showsDeclined) { _, value in
                        CalendarWindowPreferences.setShowsDeclined(value)
                        store.refreshDisplayPreferences()
                    }

                Toggle("Show hidden events", isOn: $showsHidden)
                    .meetToggleTint()
                    .onChange(of: showsHidden) { _, value in
                        CalendarWindowPreferences.setShowsHidden(value)
                        store.refreshDisplayPreferences()
                    }

                Menu {
                    Button("Off") {
                        CalendarWindowPreferences.setSecondaryTimeZone(nil)
                        store.refreshDisplayPreferences()
                    }
                    ForEach(StarlingsScheduleTimeZone.offered, id: \.rawValue) { zone in
                        Button(zone.cityLabel) {
                            CalendarWindowPreferences.setSecondaryTimeZone(zone)
                            store.refreshDisplayPreferences()
                        }
                    }
                } label: {
                    HStack {
                        Text("Second timezone")
                        Spacer()
                        Text(CalendarWindowPreferences.secondaryTimeZone()?.cityLabel ?? String(localized: "Off"))
                            .foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text(CalendarSettingsRegistry.title(for: .calendarDisplay))
            } footer: {
                Text("These settings stay on this device.")
            }

        }
        .navigationTitle(CalendarSettingsRegistry.title(for: .calendarDisplay))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func hourLabel(_ hour: Int) -> String {
        CalendarWeekMath.hourLabel(hour)
    }

    private func durationLabel(_ minutes: Int) -> String {
        minutes < 60 ? String(localized: "\(minutes) minutes") : String(localized: "\(minutes / 60) hours")
    }
}

/// Weather is its own device-local setting rather than another subsection in
/// the already dense calendar grid editor.
struct MobileCalendarWeatherSettingsView: View {
    @ObservedObject var store: MobileCalendarStore

    @State private var showsWeather: Bool
    @State private var weatherQuery = ""
    @State private var weatherMatches: [WeatherPlace] = []
    @State private var weatherMessage: String?

    init(store: MobileCalendarStore) {
        self.store = store
        _showsWeather = State(initialValue: WeatherPreferences.showsWeather())
    }

    var body: some View {
        StarlingsList {
            Section {
                Toggle("Show weather", isOn: $showsWeather)
                    .meetToggleTint()
                    .onChange(of: showsWeather) { _, value in
                        WeatherPreferences.setShowsWeather(value)
                        store.refreshDisplayPreferences()
                    }

                if let place = WeatherPreferences.place() {
                    HStack {
                        Label(place.name, systemImage: "mappin.and.ellipse")
                        Spacer()
                        Button("Clear") {
                            WeatherPreferences.setPlace(nil)
                            weatherMatches = []
                            store.refreshDisplayPreferences()
                        }
                        .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 8) {
                    TextField("City or town", text: $weatherQuery)
                        .meetField()
                        .textInputAutocapitalization(.words)
                        .submitLabel(.search)
                        .onSubmit { searchWeather() }
                    Button("Search") { searchWeather() }
                        .disabled(weatherQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                ForEach(weatherMatches, id: \.name) { place in
                    Button {
                        WeatherPreferences.setPlace(place)
                        weatherQuery = ""
                        weatherMatches = []
                        weatherMessage = nil
                        store.refreshDisplayPreferences()
                    } label: {
                        Label(place.name, systemImage: "mappin")
                    }
                }

                if let weatherMessage {
                    Text(weatherMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(CalendarSettingsRegistry.title(for: .calendarWeather))
            } footer: {
                Text("Weather uses the city you choose.")
            }
        }
        .navigationTitle(CalendarSettingsRegistry.title(for: .calendarWeather))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func searchWeather() {
        let query = weatherQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        weatherMessage = nil
        Task {
            switch await WeatherForecastService.search(matching: query) {
            case .matches(let matches):
                weatherMatches = matches
                if matches.isEmpty { weatherMessage = "No places found." }
            case .unreachable:
                weatherMessage = "Weather search is unavailable right now."
            }
        }
    }
}

/// Company-owned calendar layers are view preferences, not subscriptions.
/// Keeping them separate from source management makes that distinction clear.
struct MobileCalendarLayersSettingsView: View {
    @ObservedObject var store: MobileCalendarStore

    var body: some View {
        StarlingsList {
            Section {
                ForEach(CalendarLayerKind.allCases) { layer in
                    Button {
                        store.setHidden(layer, hidden: !store.isHidden(layer))
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: layer.symbolName)
                                .foregroundStyle(StarlingsMobileColors.accent)
                                .frame(width: 18)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(layer.title).foregroundStyle(.primary)
                                Text(layer.caption)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if !store.isHidden(layer) {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.primary)
                            }
                        }
                    }
                    .buttonStyle(.meetPlain)
                    .accessibilityLabel(layer.title + ", " + (store.isHidden(layer) ? "hidden" : "shown"))
                    .accessibilityHint("Changes whether this layer appears in Calendar")
                }
            } header: {
                Text(CalendarSettingsRegistry.title(for: .calendarLayers))
            } footer: {
                Text(CalendarLayerKind.sourceFootnote)
            }
        }
        .navigationTitle(CalendarSettingsRegistry.title(for: .calendarLayers))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The destination for the calendar used when a new event is created.
/// Existing events and the Envisioning layers remain unaffected by this choice.
struct MobileCalendarNewEventSettingsView: View {
    @ObservedObject var store: MobileCalendarStore

    var body: some View {
        StarlingsList {
            if store.defaultCalendarChoices.isEmpty {
                Section {
                    Text("Connect a calendar or enable a local calendar before choosing a default.")
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    StarlingsSearchablePicker(
                        label: CalendarSettingsRegistry.title(for: .defaultWriteCalendar),
                        placeholder: String(localized: "Choose a calendar"),
                        options: store.defaultCalendarPickerOptions,
                        selection: defaultCalendarBinding,
                        emptyMessage: String(localized: "No options match that search.")
                    )
                } header: {
                    Text(CalendarSettingsRegistry.title(for: .defaultWriteCalendar))
                } footer: {
                    Text("New events are created here unless you choose another calendar while scheduling.")
                }
            }
        }
        .navigationTitle(CalendarSettingsRegistry.title(for: .defaultWriteCalendar))
        .navigationBarTitleDisplayMode(.inline)
    }

    private var defaultCalendarBinding: Binding<String> {
        Binding(
            get: { store.defaultWriteCalendar?.id ?? store.defaultCalendarChoices.first?.id ?? "" },
            set: { store.writeCalendarID = $0 }
        )
    }
}
