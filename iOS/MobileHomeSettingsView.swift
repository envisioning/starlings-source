import EnvisioningUI
import SwiftUI

/// Settings > Home: what Home is made of, in what order, and how dense the
/// agenda is. The module list is `HomeLayout` (fixtures/home-layout.json) and
/// is owner-synced — drag a row here and the Mac and the browser draw the
/// same order on their next read. The Following-meetings knob keeps its
/// home on `/api/calendar/preferences`; only the place it is shown moved.
struct MobileHomeSettingsView: View {
    @ObservedObject var calendarStore: MobileCalendarStore
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var homeLayout: MobileHomeLayoutStore
    @EnvironmentObject private var work: MobileMyWorkStore

    @State private var followingRows = UpcomingPreferencesWire.defaults.homeFollowingRows
    @State private var followingLoaded = false
    @State private var followingError: String?

    private var isSignedIn: Bool { app.ownerCredentials != nil }
    private var offeredLayout: [HomeModuleSetting] {
        HomeLayout.offered(homeLayout.layout, workModules: work.subjectState.workModules)
    }

    var body: some View {
        StarlingsList {
            Section {
                if isSignedIn {
                    ForEach(offeredLayout) { row in
                        moduleRow(row)
                            .moveDisabled(row.id == .recent || homeLayout.isSaving)
                    }
                    .onMove { offsets, destination in
                        var reordered = offeredLayout
                        guard offsets.allSatisfy(reordered.indices.contains) else { return }
                        reordered.move(fromOffsets: offsets, toOffset: min(destination, reordered.count - 1))
                        let offeredIDs = Set(reordered.map(\.id))
                        var next = homeLayout.layout
                        let positions = next.indices.filter { offeredIDs.contains(next[$0].id) }
                        for (position, row) in zip(positions, reordered) { next[position] = row }
                        Task { await homeLayout.save(next) }
                    }
                } else {
                    Text("Sign in to arrange Home across your devices.")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Modules")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Off keeps a module off Home even when it has something to show.")
                    Text("Your room stays on Home: starting a meeting is what the app is for.")
                    if let message = homeLayout.errorMessage {
                        StarlingsErrorNotice(message: message, font: .footnote)
                    }
                }
            }

            Section {
                Picker("Following meetings", selection: $followingRows) {
                    ForEach(0...4, id: \.self) { count in
                        Text(count == 0 ? String(localized: "None") : String(localized: "\(count) meetings")).tag(count)
                    }
                }
                .disabled(!isSignedIn || !followingLoaded)
                .onChange(of: followingRows) { _, count in
                    guard followingLoaded else { return }
                    saveFollowingRows(count)
                }
            } header: {
                Text(HomeLayout.definition(for: .agenda).title)
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("How many meetings show before the foldout.")
                    if let followingError {
                        StarlingsErrorNotice(message: followingError, font: .footnote)
                    }
                }
            }
        }
        // Always in edit mode: the drag handles are the point of the screen,
        // and an Edit button to reveal them would be a step for nothing.
        .environment(\.editMode, .constant(isSignedIn ? .active : .inactive))
        .task(id: app.ownerCredentials?.accessToken) {
            await homeLayout.refresh()
            await loadFollowingRows()
        }
    }

    private func moduleRow(_ row: HomeModuleSetting) -> some View {
        let module = HomeLayout.definition(for: row.id)
        return Toggle(isOn: Binding(
            get: { row.enabled },
            set: { enabled in
                var next = homeLayout.layout
                guard let index = next.firstIndex(where: { $0.id == row.id }) else { return }
                next[index].enabled = enabled
                Task { await homeLayout.save(next) }
            }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text(module.title)
                Text(module.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .meetToggleTint()
        .disabled(!module.canHide || homeLayout.isSaving)
        .moveDisabled(!isSignedIn || row.id == .recent)
    }

    private func loadFollowingRows() async {
        guard isSignedIn else {
            followingLoaded = false
            return
        }
        await calendarStore.reload(force: true)
        followingRows = calendarStore.upcomingPreferences.homeFollowingRows
        followingLoaded = true
    }

    private func saveFollowingRows(_ count: Int) {
        let current = calendarStore.upcomingPreferences
        guard current.homeFollowingRows != count else { return }
        let next = UpcomingPreferencesWire(
            horizonDays: current.horizonDays,
            homeFollowingRows: count,
            showTomorrow: current.showTomorrow
        )
        followingError = nil
        Task {
            do {
                try await calendarStore.setUpcomingPreferences(next)
            } catch {
                followingError = MobileCalendarStore.describe(error)
                followingRows = calendarStore.upcomingPreferences.homeFollowingRows
            }
        }
    }
}
