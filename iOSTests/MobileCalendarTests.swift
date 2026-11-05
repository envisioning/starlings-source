import XCTest
@testable import Starlings

/// The calendar core is compiled by both apps now. These pin the parts the iOS
/// target added or depends on — the wire decoding it inherited from the Mac
/// client, and the layout rules the phone puts on top.
final class MobileCalendarTests: XCTestCase {
    // MARK: - Shared wire, now decoded on iOS too

    func testEventSummaryReadsTheWireTheMacReads() throws {
        let json = Data("""
        {
          "id": "abc", "calendarId": "rosa@example.com", "calendarSummary": "Work", "htmlLink": "",
          "title": "Roadmap", "start": "2026-08-17T09:00:00Z", "end": "2026-08-17T10:00:00Z",
          "joinUrl": "https://envisioning.starlings.example/room/rosa", "roomSlug": "rosa", "isMeetEvent": true,
          "attendees": [
            { "name": "Rosa", "email": "rosa@example.com", "status": "accepted", "optional": false, "self": true },
            { "name": "Guest", "email": "guest@example.net", "status": "needsAction", "optional": false, "self": false }
          ],
          "organizerSelf": true, "platform": "envisioning", "conferenceUrl": "https://envisioning.starlings.example/room/rosa",
          "allDay": false, "recurringEventId": "series", "recurring": true, "description": "Quarterly",
          "location": "Studio", "travelTimeMinutes": 35, "demoted": false, "calendarRole": "ordinary", "subject": null
        }
        """.utf8)

        let summary = CalendarEventSummary(wire: try JSONDecoder().decode(CalendarEventWire.self, from: json))
        XCTAssertEqual(summary.title, "Roadmap")
        XCTAssertEqual(summary.notes, "Quarterly")
        XCTAssertEqual(summary.location, "Studio")
        XCTAssertEqual(summary.travelTimeMinutes, 35)
        XCTAssertTrue(summary.isRecurring)
        // The owner is on the guest list, so there is a reply to show.
        XCTAssertEqual(summary.myResponse, .accepted)
        XCTAssertEqual(summary.attendees.count, 2)
    }

    func testAllDayEventsAreRecognisedFromADateOnlyStart() {
        XCTAssertTrue(CalendarDateParsing.isAllDay("2026-08-17", flagged: false))
        XCTAssertFalse(CalendarDateParsing.isAllDay("2026-08-17T09:00:00Z", flagged: false))
    }

    func testCalendarPageLinkDoesNotBecomeAMeetingAction() throws {
        let json = Data(#"""
        {
          "id": "physical", "calendarId": "primary", "calendarSummary": "Work",
          "htmlLink": "https://calendar.google.com/event",
          "title": "Guest lecture",
          "start": "2026-08-17T15:00:00Z",
          "end": "2026-08-17T16:00:00Z",
          "joinUrl": "", "roomSlug": "", "isMeetEvent": false, "attendees": [], "organizerSelf": false,
          "platform": "none",
          "conferenceUrl": "",
          "allDay": false, "recurringEventId": "", "recurring": false, "description": "",
          "location": "Pina Bauschplein 4",
          "travelTimeMinutes": null, "demoted": false, "calendarRole": "ordinary", "subject": null
        }
        """#.utf8)

        let event = CalendarEventSummary(wire: try JSONDecoder().decode(CalendarEventWire.self, from: json))
        XCTAssertFalse(event.isVideoMeeting)
        XCTAssertNil(event.conferenceLink)
    }

    func testCalendarPreferencesReadTheWireAndKeepSelectionSeparate() throws {
        let json = Data(#"{"selected_calendar_ids":["primary"],"hidden_calendar_keys":[],"disabled_calendar_keys":[],"demoted_event_keys":[],"includes_local_calendars":false,"event_subjects":{},"upcoming":{"horizon_days":1,"home_following_rows":2,"show_tomorrow":true}}"#.utf8)
        let preferences = CalendarPreferences(wire: try JSONDecoder().decode(CalendarPreferencesResponse.self, from: json))
        XCTAssertEqual(preferences.selectedCalendarIds, ["primary"])
        XCTAssertTrue(preferences.hiddenCalendarKeys.isEmpty)
        XCTAssertTrue(preferences.disabledCalendarKeys.isEmpty)
        XCTAssertTrue(preferences.demotedEventKeys.isEmpty)
        XCTAssertFalse(preferences.includesLocalCalendars)
        XCTAssertEqual(preferences.upcoming.homeFollowingRows, 2)

        let update = CalendarPreferencesUpdate(selectedCalendarIDs: ["primary", "team"])
        let encoded = try JSONEncoder().encode(update)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(object["selected_calendar_ids"] as? [String], ["primary", "team"])
        XCTAssertNil(object["hidden_calendar_keys"])
        XCTAssertNil(object["disabled_calendar_keys"])
        XCTAssertNil(object["demoted_event_keys"])
        XCTAssertNil(object["includes_local_calendars"])
        XCTAssertNil(object["upcoming"])
    }

    func testGoogleCalendarEntriesCarryAccountIdentityForMultiAccountSelection() throws {
        let json = Data("""
        {
          "id":"primary",
          "summary":"Primary",
          "primary":true,
          "selected":true,
          "writable":true,
          "accountId":"secondary",
          "accountEmail":"other@example.net"
        }
        """.utf8)
        let entry = try JSONDecoder().decode(GoogleCalendarListEntry.self, from: json)
        XCTAssertEqual(entry.accountID, "secondary")
        XCTAssertEqual(entry.accountEmail, "other@example.net")
        XCTAssertTrue(entry.selected)
    }

    func testCalendarDisplayPreferencesAreDeviceLocalAndValidated() throws {
        let suite = "meet.tests.calendar.display"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertEqual(CalendarWindowPreferences.dayStartHour(defaults), 8)
        XCTAssertEqual(CalendarWindowPreferences.defaultDurationMinutes(defaults), 60)
        XCTAssertEqual(CalendarWindowPreferences.snapMinutes(defaults), 15)
        CalendarWindowPreferences.setDayStartHour(7, defaults)
        CalendarWindowPreferences.setDayEndHour(18, defaults)
        CalendarWindowPreferences.setDefaultDurationMinutes(45, defaults)
        CalendarWindowPreferences.setSnapMinutes(5, defaults)
        CalendarWindowPreferences.setShowsDeclined(false, defaults)
        CalendarWindowPreferences.setSecondaryTimeZone(.tokyo, defaults)

        XCTAssertEqual(CalendarWindowPreferences.dayStartHour(defaults), 7)
        XCTAssertEqual(CalendarWindowPreferences.dayEndHour(defaults), 18)
        XCTAssertEqual(CalendarWindowPreferences.defaultDurationMinutes(defaults), 45)
        XCTAssertEqual(CalendarWindowPreferences.snapMinutes(defaults), 5)
        XCTAssertFalse(CalendarWindowPreferences.showsDeclined(defaults))
        XCTAssertEqual(CalendarWindowPreferences.secondaryTimeZone(defaults), .tokyo)

        CalendarWindowPreferences.setDefaultDurationMinutes(17, defaults)
        CalendarWindowPreferences.setSnapMinutes(19, defaults)
        XCTAssertEqual(CalendarWindowPreferences.defaultDurationMinutes(defaults), 60)
        XCTAssertEqual(CalendarWindowPreferences.snapMinutes(defaults), 15)
    }

    func testWeatherForecastUsesTheSharedCoarsePlaceAndLocalZone() {
        let place = WeatherPlace(name: "Lisbon", latitude: 38.716_674, longitude: -9.133_339)
        let url = WeatherForecastService.forecastURL(for: place, timeZone: .init(identifier: "Europe/Amsterdam")!, unit: "celsius")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
        XCTAssertEqual(url.host, "api.open-meteo.com")
        XCTAssertEqual(query["latitude"], "38.72")
        XCTAssertEqual(query["timezone"], "Europe/Amsterdam")
        XCTAssertEqual(query["temperature_unit"], "celsius")
    }

    // MARK: - Layout

    func testLayoutsMapOntoThePeriodsTheWeekMathUnderstands() {
        XCTAssertEqual(MobileCalendarLayout.day.mode, .day)
        XCTAssertEqual(MobileCalendarLayout.twoDay.mode, .day)
        XCTAssertEqual(MobileCalendarLayout.threeDay.mode, .day)
        XCTAssertEqual(MobileCalendarLayout.month.mode, .month)
        // The list is a week read as a list, not a fourth period.
        XCTAssertEqual(MobileCalendarLayout.agenda.mode, .week)
    }

    /// There is no seven-column week on a hand-held, but the default-view
    /// preference is shared with the Mac and still speaks day/week/month — so
    /// the multi-day grids have to answer to *week* on the way out.
    func testTheMultiDayGridsAreTheSharedPreferencesWeek() {
        XCTAssertEqual(MobileCalendarLayout.day.defaultViewMode, .day)
        XCTAssertEqual(MobileCalendarLayout.twoDay.defaultViewMode, .week)
        XCTAssertEqual(MobileCalendarLayout.threeDay.defaultViewMode, .week)
        XCTAssertEqual(MobileCalendarLayout.agenda.defaultViewMode, .week)
        XCTAssertEqual(MobileCalendarLayout.month.defaultViewMode, .month)
        XCTAssertFalse(MobileCalendarLayout.allCases.contains { $0.rawValue == "week" })
    }

    func testDayLayoutShowsOneDayAndWeekLayoutsShowSeven() {
        let anchor = Date(timeIntervalSince1970: 1_786_000_000)
        XCTAssertEqual(CalendarWeekMath.days(for: MobileCalendarLayout.day.mode, anchor: anchor).count, 1)
        XCTAssertEqual(MobileCalendarLayout.twoDay.days(anchor: anchor).count, 2)
        XCTAssertEqual(MobileCalendarLayout.threeDay.days(anchor: anchor).count, 3)
        XCTAssertEqual(CalendarWeekMath.days(for: MobileCalendarLayout.agenda.mode, anchor: anchor).count, 7)
        XCTAssertEqual(CalendarWeekMath.days(for: MobileCalendarLayout.month.mode, anchor: anchor).count, 42)
    }

    /// One day, not one window: any day can lead a 2- or 3-day view, so a
    /// step is a day (`MobileCalendarLayout.stepAnchor`). Paging by the width
    /// would fix which days can share a screen.
    func testNarrowLayoutsStepOneDayAtATime() {
        let anchor = Date(timeIntervalSince1970: 1_786_000_000)
        let calendar = Calendar.current
        let twoDay = MobileCalendarLayout.twoDay.stepAnchor(from: anchor, direction: 1)
        let threeDay = MobileCalendarLayout.threeDay.stepAnchor(from: anchor, direction: 1)
        let back = MobileCalendarLayout.threeDay.stepAnchor(from: anchor, direction: -1)

        XCTAssertEqual(calendar.dateComponents([.day], from: anchor, to: twoDay).day, 1)
        XCTAssertEqual(calendar.dateComponents([.day], from: anchor, to: threeDay).day, 1)
        XCTAssertEqual(calendar.dateComponents([.day], from: back, to: anchor).day, 1)
    }

    // MARK: - Draft

    func testDraftNeedsATitleACalendarAndAForwardRange() {
        var draft = MobileCalendarDraft()
        draft.calendarID = "ek:1"
        XCTAssertFalse(draft.isValid, "a blank title is not an event")

        draft.title = "  "
        XCTAssertFalse(draft.isValid, "whitespace is not a title")

        draft.title = "Review"
        XCTAssertTrue(draft.isValid)

        draft.end = draft.start.addingTimeInterval(-60)
        XCTAssertFalse(draft.isValid, "an event cannot end before it starts")

        draft.end = draft.start.addingTimeInterval(1_800)
        draft.calendarID = ""
        XCTAssertFalse(draft.isValid, "an event has to land on a calendar")
    }

    // MARK: - The backend the app runs before anyone signs in

    func testDisconnectedBackendReportsNoGoogleRatherThanFailing() async throws {
        let backend = DisconnectedCalendarBackend()
        let status = try await backend.calendarStatus()
        XCTAssertFalse(status.connected)
        // Reads answer empty so the EventKit half of the calendar still draws.
        let events = try await backend.calendarEvents(from: .distantPast, to: .distantFuture)
        XCTAssertTrue(events.isEmpty)
        let calendars = try await backend.listCalendars()
        XCTAssertTrue(calendars.isEmpty)
    }

    func testDisconnectedBackendRefusesWrites() async throws {
        let backend = DisconnectedCalendarBackend()
        do {
            _ = try await backend.createCalendarEvent(
                title: "Nope", start: Date(), end: Date().addingTimeInterval(600),
                joinURL: nil, roomSlug: nil, attendees: [], description: nil,
                location: nil, timeZone: nil, calendarId: "g:primary", travelTimeMinutes: nil
            )
            XCTFail("a signed-out write must not look like it succeeded")
        } catch {
            // `describe` is optional so cancellation can say nothing; a real
            // write failure is not cancellation and has to produce a sentence.
            let sentence = try XCTUnwrap(
                MobileCalendarStore.describe(error),
                "a signed-out write is a failure, not an abandoned load"
            )
            XCTAssertFalse(
                sentence.isEmpty,
                "the failure has to read as a sentence, not an empty alert"
            )
        }
    }

    // MARK: - Paging

    @MainActor
    func testThePeriodsEitherSideAreLoadedBeforeAnyoneSwipes() {
        let defaults = UserDefaults(suiteName: "meet.tests.paging")!
        defaults.removePersistentDomain(forName: "meet.tests.paging")
        let store = MobileCalendarStore(defaults: defaults)
        // The list remains the full-calendar period; Home is intentionally
        // limited to today and tomorrow.
        store.layout = .agenda

        let days = store.days
        let loaded = store.loadedRange
        XCTAssertEqual(days.count, 7)

        // The neighbours are real days, not the same week twice.
        XCTAssertEqual(store.days(offset: -1).count, 7)
        XCTAssertEqual(store.days(offset: 1).count, 7)
        XCTAssertNotEqual(store.days(offset: -1).first, days.first)
        XCTAssertNotEqual(store.days(offset: 1).first, days.first)

        // And what gets fetched covers all three, which is what stops a swipe
        // revealing an empty week.
        for offset in [-1, 0, 1] {
            for day in store.days(offset: offset) {
                XCTAssertTrue(
                    loaded.contains(day) || loaded.end == day,
                    "\(day) in period \(offset) is outside the loaded range"
                )
            }
        }
        defaults.removePersistentDomain(forName: "meet.tests.paging")
    }

    // MARK: - Availability

    func testBusyRunsFromDifferentPeopleMergeIntoOneShadedBlock() {
        let day = Date(timeIntervalSince1970: 1_786_003_200)
        let window = DateInterval(start: day, end: day.addingTimeInterval(12 * 3_600))
        let people = [
            person("a@x.com", busy: [(day, day.addingTimeInterval(3_600))]),
            // Overlaps the first by half an hour.
            person("b@x.com", busy: [(day.addingTimeInterval(1_800), day.addingTimeInterval(5_400))]),
            person("c@x.com", busy: [(day.addingTimeInterval(7_200), day.addingTimeInterval(9_000))]),
        ]
        let merged = MobileCalendarAvailability.busyIntervals(people, clippedTo: window)
        XCTAssertEqual(merged.count, 2, "two overlapping people are one run, the third is its own")
        XCTAssertEqual(merged[0].end, day.addingTimeInterval(5_400))
    }

    func testBusyTimeIsClippedToTheWindowDrawn() {
        let day = Date(timeIntervalSince1970: 1_786_003_200)
        let window = DateInterval(start: day.addingTimeInterval(3_600), end: day.addingTimeInterval(7_200))
        let people = [person("a@x.com", busy: [(day, day.addingTimeInterval(86_400))])]
        let merged = MobileCalendarAvailability.busyIntervals(people, clippedTo: window)
        XCTAssertEqual(merged, [window], "an all-day block cannot draw outside the strip")
    }

    func testAdjacentMeetingsDoNotCountAsAClash() {
        let day = Date(timeIntervalSince1970: 1_786_003_200)
        let people = [person("a@x.com", busy: [(day, day.addingTimeInterval(3_600))])]
        // Starts exactly when theirs ends.
        let after = DateInterval(start: day.addingTimeInterval(3_600), end: day.addingTimeInterval(7_200))
        XCTAssertTrue(MobileCalendarAvailability.conflicts(people, with: after).isEmpty)

        let overlapping = DateInterval(start: day.addingTimeInterval(1_800), end: day.addingTimeInterval(5_400))
        XCTAssertEqual(MobileCalendarAvailability.conflicts(people, with: overlapping), ["a@x.com"])
    }

    func testACalendarWeCouldNotReadIsNeverDrawnAsFree() {
        let day = Date(timeIntervalSince1970: 1_786_003_200)
        let window = DateInterval(start: day, end: day.addingTimeInterval(86_400))
        let blocked = person("locked@x.com", busy: [], error: "notFound")
        XCTAssertEqual(MobileCalendarAvailability.unreadable([blocked]), ["locked@x.com"])
        // It contributes no shading and no clash — it is reported in words.
        XCTAssertTrue(MobileCalendarAvailability.busyIntervals([blocked], clippedTo: window).isEmpty)
        XCTAssertTrue(MobileCalendarAvailability.conflicts([blocked], with: window).isEmpty)
    }

    func testTheStripWidensToHoldAnEventOutsideWorkingHours() {
        let day = Calendar.current.startOfDay(for: Date(timeIntervalSince1970: 1_786_003_200))
        let lateNight = DateInterval(
            start: day.addingTimeInterval(22 * 3_600),
            end: day.addingTimeInterval(23 * 3_600)
        )
        let window = MobileCalendarAvailability.window(for: lateNight, on: day)
        XCTAssertGreaterThanOrEqual(window.end, lateNight.end, "the slot has to be visible in its own strip")
        XCTAssertLessThanOrEqual(window.end.timeIntervalSince(day), 86_400, "and cannot spill past midnight")
    }

    private func person(
        _ email: String,
        busy: [(Date, Date)],
        error: String = ""
    ) -> CalendarFreeBusyPerson {
        let intervals = busy.map { ["start": ISODate.format($0.0), "end": ISODate.format($0.1)] }
        let payload: [String: Any] = ["email": email, "busy": intervals, "error": error]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(CalendarFreeBusyPerson.self, from: data)
    }

    // MARK: - Layers

    func testATaskWithATimeIsTimedAndAMilestoneWithADateIsNot() throws {
        let task = try XCTUnwrap(CalendarLayerItem(workItem: workItem(
            id: "1", kind: "task", due: "2026-08-17T15:00:00Z"
        )))
        XCTAssertEqual(task.kind, .tasks)
        XCTAssertFalse(task.isAllDay, "a task due at a time belongs in the grid at that time")
        XCTAssertEqual(task.end.timeIntervalSince(task.start), CalendarLayerItem.defaultTaskDuration)

        let milestone = try XCTUnwrap(CalendarLayerItem(workItem: workItem(
            id: "2", kind: "milestone", due: "2026-08-17"
        )))
        XCTAssertEqual(milestone.kind, .milestones)
        XCTAssertTrue(milestone.isAllDay, "a milestone falls on a day, not at an instant")
    }

    func testUndatedWorkItemsAreNotDrawn() {
        XCTAssertNil(
            CalendarLayerItem(workItem: workItem(id: "3", kind: "task", due: nil)),
            "a task with no due date has no place on a calendar"
        )
    }

    func testWorkItemsCarryWhoseTheyAre() throws {
        let mine = try XCTUnwrap(CalendarLayerItem(workItem: workItem(
            id: "4", kind: "task", due: "2026-08-17T09:00:00Z", mine: true, assignee: "Rosa"
        )))
        XCTAssertTrue(mine.isMine)
        // Everyone's dated work is drawn — you cannot read your week without it.
        let theirs = try XCTUnwrap(CalendarLayerItem(workItem: workItem(
            id: "5", kind: "task", due: "2026-08-17T09:00:00Z", mine: false, assignee: "Dara"
        )))
        XCTAssertFalse(theirs.isMine)
        XCTAssertEqual(theirs.assignee, "Dara")
    }

    func testWorkItemsResponseSurvivesADegradedAnswer() throws {
        let json = Data(#"{"items": [], "degraded": true}"#.utf8)
        let response = try JSONDecoder().decode(CalendarWorkItemsResponse.self, from: json)
        XCTAssertTrue(response.items.isEmpty)
        XCTAssertTrue(response.isDegraded)
    }

    func testAvailabilityBlocksAreTimedLayersYouOwn() throws {
        let json = Data(#"{"blocks": [{"start": "2026-09-07T08:00:00.000Z", "end": "2026-09-07T11:00:00.000Z"}]}"#.utf8)
        let response = try JSONDecoder().decode(CalendarAvailabilityResponse.self, from: json)
        XCTAssertFalse(response.isDegraded)
        let item = try XCTUnwrap(CalendarLayerItem(availability: response.blocks[0]))
        XCTAssertEqual(item.kind, .availability)
        XCTAssertFalse(item.isAllDay)
        XCTAssertTrue(item.isMine)
        XCTAssertEqual(item.end.timeIntervalSince(item.start), 3 * 3_600)
        XCTAssertEqual(item.displayTitle, "Available")
        XCTAssertTrue(item.url.isEmpty)
    }

    func testAnAvailabilityBlockThatDoesNotRunForwardIsNotDrawn() {
        let backwards = CalendarAvailabilityBlock(start: "2026-09-07T11:00:00.000Z", end: "2026-09-07T08:00:00.000Z")
        XCTAssertNil(CalendarLayerItem(availability: backwards))
        let unreadable = CalendarAvailabilityBlock(start: "soon", end: "later")
        XCTAssertNil(CalendarLayerItem(availability: unreadable))
    }

    func testAvailabilityResponseSurvivesADegradedAnswer() throws {
        let json = Data(#"{"blocks": [], "degraded": true}"#.utf8)
        let response = try JSONDecoder().decode(CalendarAvailabilityResponse.self, from: json)
        XCTAssertTrue(response.blocks.isEmpty)
        XCTAssertTrue(response.isDegraded)
    }

    func testAllDayPackingSharesRowsBetweenEventsAndLayers() {
        let days = CalendarWeekMath.days(for: .week, anchor: Date(timeIntervalSince1970: 1_786_000_000))
        let day = days[2]
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: day)
        let spans = [
            CalendarAllDaySpan(id: "event", start: start, end: start.addingTimeInterval(86_400)),
            CalendarAllDaySpan(id: "milestone", start: start, end: start.addingTimeInterval(86_400)),
        ]
        let packed = CalendarWeekMath.packAllDay(spans, days: days)
        XCTAssertEqual(packed.count, 2)
        // Two things on the same day must not be drawn on top of each other.
        XCTAssertNotEqual(packed[0].row, packed[1].row)
    }

    func testHidingALayerIsRememberedWithoutTouchingCalendars() {
        let defaults = UserDefaults(suiteName: "meet.tests.layers")!
        defaults.removePersistentDomain(forName: "meet.tests.layers")
        XCTAssertTrue(CalendarLayerPreferences.hidden(defaults: defaults).isEmpty)
        CalendarLayerPreferences.setHidden([.tasks], defaults: defaults)
        XCTAssertEqual(CalendarLayerPreferences.hidden(defaults: defaults), [.tasks])
        defaults.removePersistentDomain(forName: "meet.tests.layers")
    }

    private func workItem(
        id: String,
        kind: String,
        due: String?,
        mine: Bool = false,
        assignee: String = ""
    ) -> CalendarWorkItem {
        var payload: [String: Any] = [
            "id": id,
            "kind": kind,
            "title": "Ship the thing",
            "status": "pending",
            "mine": mine,
            // Required by the contract (CrmWorkItem); the Worker always sends it.
            "responsible_party": "unassigned",
            "assignee_name": assignee,
            "project_title": "Horizon",
        ]
        // Left out entirely when there is no due date, which is what an undated
        // item looks like on the wire.
        if let due { payload["due_at"] = due }
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(CalendarWorkItem.self, from: data)
    }

    func testMeetErrorsAreUnwrappedIntoSomethingReadable() {
        let error = StarlingsError(
            code: "calendar.readOnly",
            title: "That calendar is read-only",
            message: "Pick a calendar you can add events to.",
            severity: .notice
        )
        XCTAssertEqual(MobileCalendarStore.describe(error), "Pick a calendar you can add events to.")
    }

    // MARK: - The quiet retry before "didn't refresh" (meet#613)

    func testTheiOSErrorsSortIntoTheSharedRetryRule() {
        // No answer at all: the phone woke and Wi-Fi is still coming back.
        let offline = StarlingsError.unreachable(URLError(.notConnectedToInternet), operation: "x")
        XCTAssertEqual(CalendarRefreshRetry.delay(after: offline, attempt: 0), .seconds(1))
        // The Worker or Google said "not now".
        for status in [500, 502, 503, 429] {
            let busy = StarlingsError.refusal(status: status, serverCode: "calendar_failed", serverMessage: "x", requestID: nil, operation: "x")
            XCTAssertEqual(CalendarRefreshFailure.classify(busy), .transient, "\(status)")
        }
        // Google refused the stored grant: reconnect, at once, with no retry.
        let expired = StarlingsError.refusal(status: 401, serverCode: "calendar_expired", serverMessage: "x", requestID: nil, operation: "x")
        XCTAssertEqual(CalendarRefreshFailure.classify(expired), .googleExpired)
        XCTAssertNil(CalendarRefreshRetry.delay(after: expired, attempt: 0))
        XCTAssertNil(CalendarRefreshRetry.delay(after: CalendarAuthenticationRequiredError(), attempt: 0))
    }
}
