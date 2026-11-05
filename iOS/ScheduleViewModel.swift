import Combine
import Foundation
import StarlingsContracts

@MainActor
final class ScheduleViewModel: ObservableObject {
    @Published private(set) var room: OwnerRoomConfiguration?
    @Published private(set) var calendarStatus: CalendarStatus?
    @Published private(set) var publicEvents: [PublicEventsCalendar.Event] = []
    @Published var isLoading = false
    @Published var isCreating = false
    @Published var errorMessage: String?
    @Published var createdEvent: MobileCalendarEvent?

    func load(app: StarlingsAppModel) async {
        guard let credentials = app.ownerCredentials else {
            room = nil
            calendarStatus = nil
            errorMessage = nil
            return
        }
        errorMessage = nil
        isLoading = true
        defer { isLoading = false }
        do {
            room = try await app.api.ownerRoom(credentials: credentials)
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        do {
            calendarStatus = try await app.api.calendarStatus(credentials: credentials)
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        publicEvents = await PublicEventsCalendar.load()
        // The agenda itself belongs to UpcomingMeetingsStore, which keeps it
        // live for every surface instead of once per sign-in for this one.
        await app.upcoming.refresh(force: true)
    }

    func connectCalendar(app: StarlingsAppModel) async {
        isLoading = true
        defer { isLoading = false }
        do {
            calendarStatus = try await app.connectCalendar()
            await load(app: app)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func create(_ draft: MobileScheduleDraft, app: StarlingsAppModel) async -> Bool {
        guard let room, let credentials = app.ownerCredentials else { return false }
        isCreating = true
        defer { isCreating = false }
        do {
            createdEvent = try await app.api.createEvent(draft: draft, room: room, credentials: credentials)
            await load(app: app)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

}
