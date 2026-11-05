import AppKit
import EventKit
import XCTest
@testable import Starlings

final class CalendarWeekTests: XCTestCase {

    func testMeetingPlatformInferenceKeepsLocalProviderMarksHonest() {
        XCTAssertEqual(
            CalendarMeetingPlatform.inferred(
                joinURL: "https://us02web.zoom.us/j/123",
                location: "",
                roomSlug: ""
            ),
            .zoom
        )
        XCTAssertEqual(
            CalendarMeetingPlatform.inferred(
                joinURL: "https://teams.microsoft.com/l/meetup-join/abc",
                location: "",
                roomSlug: ""
            ),
            .teams
        )
        XCTAssertEqual(
            CalendarMeetingPlatform.inferred(
                joinURL: "https://envisioning.starlings.example/room/rosa",
                location: "",
                roomSlug: "rosa"
            ),
            .starlings
        )
        XCTAssertEqual(
            CalendarMeetingPlatform.inferred(
                joinURL: "https://zoom.us/j/123",
                location: "",
                roomSlug: ""
            ),
            .zoom
        )
    }

    @MainActor
    func testTeamsPlatformMarkIsTheSharedBlockT() throws {
        // The Mac draws MeetingPlatformMarkGeometry's Teams path, the same
        // block T iOS and the web draw (viewBox 24: crossbar y 3–7.25, stem
        // x 8.25–15.75 down to y 21). At 120 px that is a 5× scale, upright.
        let image = CalendarMeetingPlatformMark.image(
            for: .teams,
            size: 120,
            color: .white
        )
        let representation = try XCTUnwrap(image?.tiffRepresentation)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: representation))

        let crossbar = try XCTUnwrap(bitmap.colorAt(x: 22, y: 25))
        XCTAssertGreaterThan(crossbar.alphaComponent, 0.9)
        let stem = try XCTUnwrap(bitmap.colorAt(x: 60, y: 60))
        XCTAssertGreaterThan(stem.alphaComponent, 0.9)
        // Beside the stem is empty: a T, not a tile with a T cut out of it.
        let besideStem = try XCTUnwrap(bitmap.colorAt(x: 22, y: 60))
        XCTAssertEqual(besideStem.alphaComponent, 0, accuracy: 0.02)
    }

    @MainActor
    func testLinkPlatformMarkUsesTheRequestedInkWhenDrawnDirectly() throws {
        let image = NSImage(size: NSSize(width: 64, height: 64), flipped: true) { bounds in
            CalendarMeetingPlatformMark.draw(for: .other, in: bounds, color: .white)
            return true
        }
        let representation = try XCTUnwrap(image.tiffRepresentation)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: representation))
        var inkedPixel = false

        for x in 0..<bitmap.pixelsWide {
            for y in 0..<bitmap.pixelsHigh {
                guard let pixel = bitmap.colorAt(x: x, y: y), pixel.alphaComponent > 0.5 else { continue }
                inkedPixel = true
                let white = try XCTUnwrap(pixel.usingColorSpace(.sRGB))
                XCTAssertGreaterThan(white.redComponent, 0.9)
                XCTAssertGreaterThan(white.greenComponent, 0.9)
                XCTAssertGreaterThan(white.blueComponent, 0.9)
            }
        }
        XCTAssertTrue(inkedPixel)
    }

    func testTopLevelSettingsRegistryCoversBothPlatforms() {
        XCTAssertEqual(
            Set(StarlingsSettingsRegistry.all.map(\.id)),
            Set(StarlingsSettingID.allCases)
        )
        XCTAssertEqual(
            StarlingsSettingsRegistry.all.map(\.id),
            StarlingsSettingID.allCases
        )
        XCTAssertEqual(
            StarlingsSettingsRegistry.definitions(for: .macSettingsSidebar).map(\.id),
            [.account, .home, .work, .calendar, .video, .audio, .captions, .meetings, .room, .notifications, .appearance, .about]
        )
        // Captions is on both platforms now: the phone transcribes when it
        // hosts, and the speech model has to be downloadable before it does.
        XCTAssertEqual(
            StarlingsSettingsRegistry.definitions(for: .iosSettings).map(\.id),
            [.account, .home, .work, .calendar, .captions, .room, .notifications, .calls, .appearance, .appLock, .about, .developmentServer]
        )
        XCTAssertEqual(
            StarlingsSettingsRegistry.definitions(for: .iosCalendarSettings).map(\.id),
            [.calendar]
        )
        XCTAssertEqual(
            StarlingsSettingsRegistry.definition(for: .calendar).control,
            .calendarShortcut
        )
        XCTAssertEqual(
            StarlingsSettingsRegistry.definition(for: .room).control,
            .roomPolicy
        )
    }

    func testCalendarSettingsRegistryIsCompleteAndDeclaresSyncScope() {
        XCTAssertEqual(
            Set(CalendarSettingsRegistry.all.map(\.id)),
            Set(CalendarSettingID.allCases)
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.all.map(\.id),
            CalendarSettingID.allCases
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.definition(for: .googleCalendarSync).scope,
            .ownerSynced
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.definition(for: .calendarDisplay).scope,
            .deviceLocal
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.definition(for: .calendarSources).control,
            .sourceGroups
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.definitions(for: .macSettings).map(\.id),
            [.googleCalendar, .googleCalendarSync, .calendarSources, .calendarDisplay, .calendarWeather, .bookingHours]
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.definitions(for: .iosCalendarDisplay).map(\.id),
            [.calendarDisplay, .calendarWeather]
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.definitions(for: .iosCalendarSources).map(\.id),
            [.googleCalendar, .googleCalendarSync, .calendarSources, .calendarLayers, .defaultWriteCalendar, .bookingHours]
        )
    }

    func testCalendarSettingsUseSharedLogicalGroups() {
        XCTAssertEqual(
            CalendarSettingGroup.allCases,
            [.accountsAndSources, .upcoming, .display, .behavior, .booking]
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.all.filter { $0.group == .accountsAndSources }.map(\.id),
            [.googleCalendar, .calendarSources]
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.all.filter { $0.group == .upcoming }.map(\.id),
            [.googleCalendarSync]
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.all.filter { $0.group == .display }.map(\.id),
            [.calendarDisplay, .calendarWeather]
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.all.filter { $0.group == .behavior }.map(\.id),
            [.calendarLayers, .defaultWriteCalendar]
        )
        XCTAssertEqual(
            CalendarSettingsRegistry.all.filter { $0.group == .booking }.map(\.id),
            [.bookingHours]
        )
    }

    // MARK: - Which calendars are in the app at all

    /// The first list a Mac ever hands over is adopted whole: an upgrade that
    /// emptied somebody's calendar would be worse than a long sidebar. Only
    /// what turns up afterwards starts switched off.
    func testTheFirstLocalCalendarListIsAdoptedWholeAndLaterOnesStartOff() throws {
        let suite = "meet.tests.calendar.sources.adopt"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let seeded = CalendarSourcePreferences.adoptLocal(
            keys: ["ek:icloud/home", "ek:icloud/work"],
            defaults: defaults
        )
        XCTAssertEqual(seeded, [], "nothing that was already here may be switched off behind the owner")

        let later = CalendarSourcePreferences.adoptLocal(
            keys: ["ek:icloud/home", "ek:icloud/work", "ek:icloud/siri suggestions"],
            defaults: defaults
        )
        XCTAssertEqual(later, ["ek:icloud/siri suggestions"])

        // Asked twice, answered once: a calendar is only new the first time.
        XCTAssertEqual(
            CalendarSourcePreferences.adoptLocal(
                keys: ["ek:icloud/home", "ek:icloud/work", "ek:icloud/siri suggestions"],
                defaults: defaults
            ),
            []
        )
    }

    /// No calendars is not an answer to the question — access may simply not be
    /// granted yet — so it must not count as the one-time adoption. Otherwise
    /// the real list, when it arrives, would arrive entirely switched off.
    func testAnEmptyLocalListDoesNotCountAsTheFirstOne() throws {
        let suite = "meet.tests.calendar.sources.empty"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        // Named suites survive a failed test run, so the fixture must establish
        // its own clean starting point before checking the empty-list rule.
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertEqual(CalendarSourcePreferences.adoptLocal(keys: [], defaults: defaults), [])
        XCTAssertFalse(CalendarSourcePreferences.hasSeededLocal(defaults: defaults))
        XCTAssertEqual(
            CalendarSourcePreferences.adoptLocal(keys: ["ek:icloud/home"], defaults: defaults),
            []
        )
    }

    /// Disabling is stored in the same key grammar as hiding, so a choice made
    /// on the Mac means the same thing on the phone — and an account key covers
    /// calendars nobody has listed one by one.
    func testDisabledKeysRoundTripAndAreKeptApartFromHiding() throws {
        let suite = "meet.tests.calendar.sources.keys"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertEqual(CalendarSourcePreferences.disabled(defaults: defaults), [])
        let keys: Set<String> = [
            StarlingsCalendar.accountVisibilityKey("On My Mac"),
            StarlingsCalendar.eventKitVisibilityKey(account: "iCloud", title: "Birthdays"),
        ]
        CalendarSourcePreferences.setDisabled(keys, defaults: defaults)
        XCTAssertEqual(CalendarSourcePreferences.disabled(defaults: defaults), keys)
        // Hiding keeps its own list; one must never quietly become the other.
        XCTAssertNil(defaults.stringArray(forKey: "meet.calendar.hiddenKeys"))

        CalendarSourcePreferences.setDisabled([], defaults: defaults)
        XCTAssertEqual(CalendarSourcePreferences.disabled(defaults: defaults), [])
    }

    func testLocalCalendarsAreGloballyOffUntilExplicitlyIncluded() throws {
        let suite = "meet.tests.calendar.sources.local-master"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertFalse(CalendarSourcePreferences.includesLocalCalendars(defaults: defaults))
        CalendarSourcePreferences.setIncludesLocalCalendars(true, defaults: defaults)
        XCTAssertTrue(CalendarSourcePreferences.includesLocalCalendars(defaults: defaults))
    }

    func testGlobalInterestIsAnEditableCalendarRoleNotACoreLayer() {
        let calendar = StarlingsCalendar(
            id: "g:internal",
            source: .google,
            rawID: "internal",
            title: "Envisioning Internal",
            groupTitle: "Google",
            isWritable: true,
            color: .fallback(at: 0)
        )
        // The build's own workspace, not the one this Mac has active.
        let workspace = StarlingsWorkspace.builtIn
        XCTAssertEqual(calendar.role(in: workspace), .globalInterest)
        XCTAssertTrue(calendar.isWritable)
        XCTAssertFalse(calendar.canBeMoveTarget(in: workspace))
        XCTAssertFalse(calendar.role(in: workspace).canMoveEventsOut)
        XCTAssertFalse(calendar.role(in: workspace).canReceiveMovedEvents)
        XCTAssertEqual(calendar.displayColor(in: workspace), CalendarLayerPalette.globalInterest)

        // Another workspace does not inherit the calendar by its title (meet#939).
        let other = StarlingsWorkspace(
            webOrigin: "https://other.starlings.example", apiOrigin: "https://other.starlings.example",
            name: "Other", markURL: nil
        )
        XCTAssertEqual(calendar.role(in: other), .ordinary)
        XCTAssertTrue(calendar.canBeMoveTarget(in: other))
    }

    func testDemotionKeyCarriesNoEventTitle() {
        let event = timedEvent(
            id: "g:primary:flight-1",
            start: Date(timeIntervalSince1970: 1_700_000_000),
            end: Date(timeIntervalSince1970: 1_700_003_600),
            calendarID: "g:primary",
            title: "Rosa flight"
        )
        XCTAssertEqual(event.demotionKey, "event:\(event.id)")
        XCTAssertFalse(event.demotionKey.contains("Rosa"))
    }

    func testStartOfWeekIsTheCalendarsFirstWeekday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.firstWeekday = 2 // Monday
        let wednesday = date(2026, 8, 12, calendar: calendar)
        let start = CalendarWeekMath.startOfWeek(containing: wednesday, calendar: calendar)
        XCTAssertEqual(calendar.component(.weekday, from: start), 2)
        XCTAssertEqual(calendar.component(.day, from: start), 10)
    }

    func testWeekHasSevenDays() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = date(2026, 8, 10, calendar: calendar)
        let days = CalendarWeekMath.days(ofWeekStarting: start, calendar: calendar)
        XCTAssertEqual(days.count, 7)
        XCTAssertEqual(calendar.component(.day, from: days[6]), 16)
    }

    func testRollingWeekCanStartOnTodayInsteadOfCalendarWeekday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.firstWeekday = 2 // Monday
        let today = date(2026, 8, 12, calendar: calendar) // Wednesday
        let days = CalendarWeekMath.days(
            ofWeekStarting: calendar.startOfDay(for: today),
            calendar: calendar
        )

        XCTAssertEqual(days.first, today)
        XCTAssertEqual(days.count, 7)
        XCTAssertEqual(calendar.component(.weekday, from: days[0]), 4) // Wednesday
        XCTAssertEqual(calendar.component(.day, from: days[6]), 18)
    }

    func testPastEventUsesItsEndRatherThanItsStart() {
        let calendar = Calendar(identifier: .gregorian)
        let now = date(2026, 8, 19, hour: 12, calendar: calendar)
        let past = timedEvent(
            id: "past",
            start: date(2026, 8, 19, hour: 9, calendar: calendar),
            end: date(2026, 8, 19, hour: 10, calendar: calendar)
        )
        let ongoing = timedEvent(
            id: "ongoing",
            start: date(2026, 8, 19, hour: 9, calendar: calendar),
            end: date(2026, 8, 19, hour: 13, calendar: calendar)
        )

        XCTAssertTrue(past.isPast(at: now))
        XCTAssertFalse(ongoing.isPast(at: now))
    }

    /// The pointed-at day has to stay on screen, and the edge it lands on has
    /// to be the near one: paging forward from a Friday selection lands on the
    /// Monday that arrives, not on the far end of the week.
    func testNearestDayLandsOnTheNearEdgeOfWhatIsVisible() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.firstWeekday = 2 // Monday
        let week = CalendarWeekMath.days(
            ofWeekStarting: date(2026, 8, 17, calendar: calendar),
            calendar: calendar
        )

        let before = CalendarWeekMath.nearestDay(
            to: date(2026, 8, 14, calendar: calendar),
            in: week,
            calendar: calendar
        )
        XCTAssertEqual(before, date(2026, 8, 17, calendar: calendar))

        let after = CalendarWeekMath.nearestDay(
            to: date(2026, 8, 29, calendar: calendar),
            in: week,
            calendar: calendar
        )
        XCTAssertEqual(after, date(2026, 8, 23, calendar: calendar))

        // A day already on screen is left exactly where it is.
        let inside = CalendarWeekMath.nearestDay(
            to: date(2026, 8, 20, calendar: calendar),
            in: week,
            calendar: calendar
        )
        XCTAssertEqual(inside, date(2026, 8, 20, calendar: calendar))

        XCTAssertNil(CalendarWeekMath.nearestDay(
            to: date(2026, 8, 20, calendar: calendar),
            in: [],
            calendar: calendar
        ))
    }

    func testHourLabelIsAlways24HourRegardlessOfLocale() {
        let us = Locale(identifier: "en_US")
        XCTAssertEqual(CalendarWeekMath.hourLabel(0, locale: us), "00")
        XCTAssertEqual(CalendarWeekMath.hourLabel(13, locale: us), "13")
        XCTAssertEqual(CalendarWeekMath.hourLabel(23, locale: us), "23")
    }

    func testMeetTimeFormattingIsAlways24Hour() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let afternoon = date(2026, 8, 14, hour: 13, minute: 5, calendar: calendar)
        let midnight = date(2026, 8, 15, hour: 0, minute: 5, calendar: calendar)

        XCTAssertEqual(StarlingsDateFormatting.time(afternoon, timeZone: calendar.timeZone), "13:05")
        XCTAssertEqual(StarlingsDateFormatting.time(midnight, timeZone: calendar.timeZone), "00:05")
    }

    func testSnapFloorsToQuarterHours() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let raw = date(2026, 8, 14, hour: 9, minute: 22, calendar: calendar)
        let snapped = CalendarWeekMath.snap(raw, minutes: 15, calendar: calendar)
        XCTAssertEqual(calendar.component(.minute, from: snapped), 15)
    }

    func testSnapUpStartsANewEventOnTheNextSlot() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let odd = date(2026, 8, 14, hour: 8, minute: 3, calendar: calendar)
        XCTAssertEqual(calendar.component(.minute, from: CalendarWeekMath.snapUp(odd, minutes: 15, calendar: calendar)), 15)
        let onSlot = date(2026, 8, 14, hour: 8, minute: 30, calendar: calendar)
        XCTAssertEqual(CalendarWeekMath.snapUp(onSlot, minutes: 15, calendar: calendar), onSlot)
        XCTAssertEqual(StarlingsDatePicker.stepped(minute: 3, by: 1, step: 5), 5)
        XCTAssertEqual(StarlingsDatePicker.stepped(minute: 3, by: -1, step: 5), 0)
        XCTAssertEqual(StarlingsDatePicker.stepped(minute: 55, by: 1, step: 5), 0)
        XCTAssertEqual(StarlingsDatePicker.stepped(minute: 0, by: -1, step: 5), 55)
    }

    func testOverlapPackAssignsSideBySideColumns() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let spans = [
            CalendarTimedSpan(id: "a", start: start, end: start.addingTimeInterval(3_600)),
            CalendarTimedSpan(id: "b", start: start.addingTimeInterval(1_800), end: start.addingTimeInterval(5_400)),
        ]
        let packed = Dictionary(uniqueKeysWithValues: CalendarWeekMath.pack(spans).map { ($0.id, $0) })
        XCTAssertEqual(packed["a"]?.columnCount, 2)
        XCTAssertEqual(packed["b"]?.columnCount, 2)
        XCTAssertNotEqual(packed["a"]?.column, packed["b"]?.column)
    }

    func testOverlapPackCascadesCardsInsteadOfHalvingThem() throws {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let spans = [
            CalendarTimedSpan(id: "long", start: start, end: start.addingTimeInterval(10_800)),
            CalendarTimedSpan(id: "first", start: start.addingTimeInterval(1_800), end: start.addingTimeInterval(3_600)),
            CalendarTimedSpan(id: "second", start: start.addingTimeInterval(5_400), end: start.addingTimeInterval(7_200)),
        ]
        let packed = Dictionary(uniqueKeysWithValues: CalendarWeekMath.pack(spans).map { ($0.id, $0) })
        let long = try XCTUnwrap(packed["long"])
        let first = try XCTUnwrap(packed["first"])
        let second = try XCTUnwrap(packed["second"])

        // The card behind runs the full width of the column; the one in front
        // is inset and drawn over it, so both keep a readable share.
        XCTAssertEqual(long.horizontalLeadingFraction, 0, accuracy: 0.001)
        XCTAssertEqual(long.horizontalWidthFraction, 1, accuracy: 0.001)
        XCTAssertEqual(first.horizontalLeadingFraction, 0.34, accuracy: 0.001)
        XCTAssertEqual(first.horizontalWidthFraction, 0.66, accuracy: 0.001)
        XCTAssertEqual(second.horizontalLeadingFraction, first.horizontalLeadingFraction, accuracy: 0.001)
        XCTAssertEqual(second.horizontalWidthFraction, first.horizontalWidthFraction, accuracy: 0.001)
    }

    /// However deep a stack gets, the front card keeps a third of the column
    /// and the stubs behind it stay wide enough to see and hit.
    func testDeepOverlapStackKeepsTheFrontCardReadable() {
        let packed = CalendarPackedSpan(id: "deep", column: 4, columnCount: 5)

        XCTAssertEqual(packed.horizontalLeadingFraction, 0.64, accuracy: 0.001)
        XCTAssertEqual(packed.horizontalWidthFraction, 0.36, accuracy: 0.001)

        let stub = CalendarPackedSpan(id: "stub", column: 1, columnCount: 5)
        XCTAssertEqual(stub.horizontalLeadingFraction, 0.16, accuracy: 0.001)
    }

    func testASingleEventFillsItsColumn() {
        let alone = CalendarPackedSpan(id: "alone", column: 0, columnCount: 1)

        XCTAssertEqual(alone.horizontalLeadingFraction, 0, accuracy: 0.001)
        XCTAssertEqual(alone.horizontalWidthFraction, 1, accuracy: 0.001)
    }

    func testNonOverlappingEventsShareASingleColumn() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let spans = [
            CalendarTimedSpan(id: "a", start: start, end: start.addingTimeInterval(3_600)),
            CalendarTimedSpan(id: "b", start: start.addingTimeInterval(3_600), end: start.addingTimeInterval(7_200)),
        ]
        let packed = CalendarWeekMath.pack(spans)
        XCTAssertTrue(packed.allSatisfy { $0.columnCount == 1 && $0.column == 0 })
    }

    func testHomeConflictLineNamesOnlyRealOverlaps() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let invite = CalendarConflictEvent(
            id: "invite",
            title: "Client call",
            start: start,
            end: start.addingTimeInterval(3_600),
            isAllDay: false,
            isDeclined: false
        )
        let overlap = CalendarConflictEvent(
            id: "overlap",
            title: "Design review",
            start: start.addingTimeInterval(1_800),
            end: start.addingTimeInterval(5_400),
            isAllDay: false,
            isDeclined: false
        )
        let adjacent = CalendarConflictEvent(
            id: "adjacent",
            title: "Lunch",
            start: start.addingTimeInterval(3_600),
            end: start.addingTimeInterval(7_200),
            isAllDay: false,
            isDeclined: false
        )

        let conflicts = CalendarConflictDetector.conflicts(
            for: invite,
            among: [invite, overlap, adjacent]
        )

        XCTAssertEqual(conflicts.map(\.title), ["Design review"])
        XCTAssertTrue(CalendarConflictDetector.line(for: conflicts)?.contains("Conflicts with Design review") == true)
    }

    func testDateOnlyStringsAreAllDay() {
        XCTAssertTrue(CalendarDateParsing.isAllDay("2026-08-14", flagged: false))
        XCTAssertFalse(CalendarDateParsing.isAllDay("2026-08-14T10:00:00.000Z", flagged: false))
        XCTAssertTrue(CalendarDateParsing.isAllDay("2026-08-14T10:00:00.000Z", flagged: true))
    }

    func testHexColorParses() {
        let color = StarlingsRGBColor.hex("#16a765")
        XCTAssertNotNil(color)
        XCTAssertEqual(color?.green ?? 0, 167.0 / 255.0, accuracy: 0.01)
    }

    func testAllDayExclusiveEndSpansSaturdayAndSunday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let saturday = date(2026, 8, 15, calendar: calendar)
        let monday = date(2026, 8, 17, calendar: calendar)
        let event = allDayEvent(start: saturday, end: monday)
        let days = CalendarWeekMath.days(ofWeekStarting: date(2026, 8, 10, calendar: calendar), calendar: calendar)
        let range = CalendarWeekMath.allDayDayRange(event, days: days, calendar: calendar)
        XCTAssertEqual(range, 5...6)
        let inclusive = CalendarWeekMath.allDayInclusiveEnd(event, calendar: calendar)
        XCTAssertEqual(calendar.component(.day, from: inclusive), 16)
    }

    func testSingleDayAllDayUsesExclusiveNextMidnight() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let friday = date(2026, 8, 14, calendar: calendar)
        let saturday = date(2026, 8, 15, calendar: calendar)
        let event = allDayEvent(start: friday, end: saturday)
        let days = CalendarWeekMath.days(ofWeekStarting: date(2026, 8, 10, calendar: calendar), calendar: calendar)
        XCTAssertEqual(CalendarWeekMath.allDayDayRange(event, days: days, calendar: calendar), 4...4)
    }

    func testAllDayPackStacksOverlappingSpans() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = date(2026, 8, 10, calendar: calendar)
        let days = CalendarWeekMath.days(ofWeekStarting: start, calendar: calendar)
        let weekend = allDayEvent(
            id: "weekend",
            start: date(2026, 8, 15, calendar: calendar),
            end: date(2026, 8, 17, calendar: calendar)
        )
        let sunday = allDayEvent(
            id: "sunday",
            start: date(2026, 8, 16, calendar: calendar),
            end: date(2026, 8, 17, calendar: calendar)
        )
        let packed = Dictionary(uniqueKeysWithValues: CalendarWeekMath.packAllDay([weekend, sunday], days: days, calendar: calendar).map { ($0.id, $0) })
        XCTAssertEqual(packed["weekend"]?.startIndex, 5)
        XCTAssertEqual(packed["weekend"]?.endIndex, 6)
        XCTAssertEqual(packed["sunday"]?.startIndex, 6)
        XCTAssertNotEqual(packed["weekend"]?.row, packed["sunday"]?.row)
    }

    func testEventKitKeepsICloudAndLocalAndDropsGoogle() {
        XCTAssertTrue(EventKitCalendarStore.includeSource(type: .local, title: "On My Mac", identifier: "local"))
        XCTAssertTrue(EventKitCalendarStore.includeSource(type: .calDAV, title: "iCloud", identifier: "iCloud"))
        XCTAssertTrue(EventKitCalendarStore.includeSource(type: .calDAV, title: "Home", identifier: "icloud.com"))
        XCTAssertFalse(EventKitCalendarStore.includeSource(type: .calDAV, title: "Gmail", identifier: "gmail.com"))
        XCTAssertFalse(EventKitCalendarStore.includeSource(type: .exchange, title: "Work", identifier: "exchange"))
        XCTAssertFalse(EventKitCalendarStore.includeSource(type: .birthdays, title: "Birthdays", identifier: "birthdays"))
        // Calendar.app subscriptions are never bridged: Meet fetches its own
        // feeds, and the owner's booking hours arrive as the Availability layer.
        XCTAssertFalse(EventKitCalendarStore.includeSource(
            type: .subscribed,
            title: "ROSA's Availability",
            identifier: "private-availability-feed"
        ))
        XCTAssertFalse(EventKitCalendarStore.includeSource(
            type: .subscribed,
            title: "Public holidays",
            identifier: "public-holidays"
        ))
    }

    /// The preference travels between devices, so the key may not contain
    /// anything a device made up — EventKit's identifiers are local UUIDs.
    func testVisibilityKeysAreTheSameOnEveryDevice() {
        let google = StarlingsCalendar(
            id: StarlingsCalendar.googleID("team@example.com"),
            source: .google,
            rawID: "team@example.com",
            title: "Envisioning",
            groupTitle: "Google",
            isWritable: true,
            color: .fallback(at: 0)
        )
        let local = StarlingsCalendar(
            id: StarlingsCalendar.eventKitID("6C1A5F0E-DEAD-BEEF-0000-000000000001"),
            source: .eventKit,
            rawID: "6C1A5F0E-DEAD-BEEF-0000-000000000001",
            title: "Envisioning Shared",
            groupTitle: "Envisioning",
            isWritable: false,
            color: .fallback(at: 1)
        )
        // Same calendar, same account, different device: EventKit hands out a
        // different identifier, and the key has to come out the same anyway.
        let sameCalendarOnThePhone = StarlingsCalendar(
            id: StarlingsCalendar.eventKitID("11112222-3333-4444-5555-666677778888"),
            source: .eventKit,
            rawID: "11112222-3333-4444-5555-666677778888",
            title: "Envisioning Shared",
            groupTitle: "Envisioning",
            isWritable: false,
            color: .fallback(at: 2)
        )

        XCTAssertEqual(google.visibilityKey, "g:team@example.com")
        XCTAssertEqual(local.visibilityKey, "ek:envisioning/envisioning shared")
        XCTAssertEqual(local.visibilityKey, sameCalendarOnThePhone.visibilityKey)
        XCTAssertNotEqual(local.id, sameCalendarOnThePhone.id)
        XCTAssertEqual(StarlingsCalendar.accountVisibilityKey("Envisioning"), "account:envisioning")
        XCTAssertNotEqual(local.visibilityKey, StarlingsCalendar.accountVisibilityKey(local.groupTitle))
    }

    /// Subscribed feeds are not an account and should not read as one: they sit
    /// after every real account, next to the device's own store.
    func testSubscribedFeedsSortAfterAccountsAndAreReadOnly() {
        func calendar(_ title: String, group: String, source: StarlingsCalendar.Source, writable: Bool) -> StarlingsCalendar {
            StarlingsCalendar(
                id: source == .subscription ? StarlingsCalendar.subscriptionID(title) : StarlingsCalendar.eventKitID(title),
                source: source,
                rawID: title,
                title: title,
                groupTitle: group,
                isWritable: writable,
                color: .fallback(at: 0)
            )
        }
        let all = [
            calendar("Home", group: "On My Mac", source: .eventKit, writable: true),
            calendar("TripIt", group: StarlingsCalendar.subscriptionGroupTitle, source: .subscription, writable: false),
            calendar("Shared", group: "Envisioning", source: .eventKit, writable: true),
            calendar("Work", group: "Google", source: .google, writable: true),
        ]
        XCTAssertEqual(
            StarlingsCalendar.orderedGroups(of: all),
            ["Google", "Envisioning", "On My Mac", StarlingsCalendar.subscriptionGroupTitle]
        )
        XCTAssertEqual(
            all.first(where: { $0.source == .subscription })?.visibilityKey,
            "sub:TripIt"
        )
    }

    func testCalendarSourceSettingsShareGroupingAndAccountToggleRules() {
        func calendar(
            id: String,
            title: String,
            group: String,
            source: StarlingsCalendar.Source = .google
        ) -> StarlingsCalendar {
            StarlingsCalendar(
                id: id,
                source: source,
                rawID: id,
                title: title,
                groupTitle: group,
                isWritable: true,
                color: .fallback(at: 0)
            )
        }

        let primary = calendar(id: "g:primary", title: "Primary", group: "Google")
        let team = calendar(id: "g:team", title: "Team", group: "Google")
        let local = calendar(
            id: "ek:local",
            title: "Home",
            group: "On My iPhone",
            source: .eventKit
        )
        let all = [team, local, primary]

        XCTAssertEqual(
            CalendarSourceGroup.ordered(all).map(\.id),
            ["google:Google", "eventKit:On My iPhone"]
        )
        XCTAssertEqual(
            CalendarSourceGroup.ordered(all).first?.calendars.map(\.title) ?? [],
            ["Primary", "Team"]
        )

        var settings = CalendarSourceSettings()
        settings.setAccountDisabled("Google", disabled: true, calendars: all)
        XCTAssertTrue(settings.isDisabled(primary))
        XCTAssertTrue(settings.isAccountDisabled("Google", calendars: all))

        // Re-enabling one row expands the account key, keeping the other row
        // disabled instead of silently turning the whole account back on.
        settings.setDisabled(primary, disabled: false, calendars: all)
        XCTAssertFalse(settings.isDisabled(primary))
        XCTAssertTrue(settings.isDisabled(team))
        XCTAssertFalse(settings.isAccountDisabled("Google", calendars: all))

        settings.setAccountHidden("Google", hidden: true, calendars: all)
        settings.setHidden(primary, hidden: false, calendars: all)
        XCTAssertFalse(settings.isHidden(primary))
        XCTAssertTrue(settings.isHidden(team))
        XCTAssertFalse(settings.isAccountHidden("Google", calendars: all))
    }

    func testOvernightEventDrawsOnBothDaysClippedToMidnight() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = date(2026, 8, 12, hour: 22, calendar: calendar)
        let end = date(2026, 8, 13, hour: 2, calendar: calendar)
        let event = timedEvent(id: "night", start: start, end: end)

        let first = CalendarWeekMath.daySegment(
            for: event,
            day: date(2026, 8, 12, calendar: calendar),
            calendar: calendar
        )
        XCTAssertEqual(first?.start, start)
        XCTAssertEqual(first?.end, date(2026, 8, 13, calendar: calendar))

        let second = CalendarWeekMath.daySegment(
            for: event,
            day: date(2026, 8, 13, calendar: calendar),
            calendar: calendar
        )
        XCTAssertEqual(second?.start, date(2026, 8, 13, calendar: calendar))
        XCTAssertEqual(second?.end, end)
    }

    func testEventStartingBeforeTheWeekStillDrawsInsideIt() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let event = timedEvent(
            id: "carryover",
            start: date(2026, 8, 9, hour: 23, calendar: calendar),
            end: date(2026, 8, 10, hour: 1, calendar: calendar)
        )
        let segment = CalendarWeekMath.daySegment(
            for: event,
            day: date(2026, 8, 10, calendar: calendar),
            calendar: calendar
        )
        XCTAssertNotNil(segment, "a Monday morning tail must render even though the event began Sunday")
        XCTAssertEqual(segment?.start, date(2026, 8, 10, calendar: calendar))
    }

    func testEventEndingAtMidnightStaysOnTheDayItRanThrough() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let event = timedEvent(
            id: "late",
            start: date(2026, 8, 12, hour: 22, calendar: calendar),
            end: date(2026, 8, 13, calendar: calendar)
        )
        XCTAssertNotNil(CalendarWeekMath.daySegment(
            for: event,
            day: date(2026, 8, 12, calendar: calendar),
            calendar: calendar
        ))
        XCTAssertNil(CalendarWeekMath.daySegment(
            for: event,
            day: date(2026, 8, 13, calendar: calendar),
            calendar: calendar
        ), "a midnight end must not leak an empty block onto the next day")
    }

    func testAllDayEventsAreNotTimedSegments() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let day = date(2026, 8, 12, calendar: calendar)
        let event = allDayEvent(start: day, end: date(2026, 8, 13, calendar: calendar))
        XCTAssertNil(CalendarWeekMath.daySegment(for: event, day: day, calendar: calendar))
        XCTAssertTrue(CalendarWeekMath.daySegments([event], day: day, calendar: calendar).isEmpty)
    }

    func testIdenticalCopiesOnDifferentCalendarsMergeIntoOneBlock() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = date(2026, 8, 12, hour: 17, minute: 30, calendar: calendar)
        let end = date(2026, 8, 12, hour: 18, minute: 30, calendar: calendar)
        let copies = ["g:work", "ek:personal", "ek:team"].enumerated().map { index, calendarID in
            timedEvent(id: "copy\(index)", start: start, end: end, calendarID: calendarID, title: "Vibe Coding")
        }

        let groups = CalendarWeekMath.consolidate(copies)
        XCTAssertEqual(groups.count, 1, "one meeting on three calendars is one block")
        XCTAssertEqual(groups.first?.calendarIDs.count, 3)
        XCTAssertTrue(groups.first?.isMerged == true)
    }

    func testTwoCopiesOnTheSameCalendarStaySeparate() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = date(2026, 8, 12, hour: 9, calendar: calendar)
        let end = date(2026, 8, 12, hour: 10, calendar: calendar)
        let groups = CalendarWeekMath.consolidate([
            timedEvent(id: "a", start: start, end: end, calendarID: "g:work", title: "Standup"),
            timedEvent(id: "b", start: start, end: end, calendarID: "g:work", title: "Standup"),
        ])
        XCTAssertEqual(groups.count, 2, "a real double-booking must not be hidden by merging")
    }

    func testDifferentTimesOrTitlesDoNotMerge() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = date(2026, 8, 12, hour: 9, calendar: calendar)
        let end = date(2026, 8, 12, hour: 10, calendar: calendar)
        let groups = CalendarWeekMath.consolidate([
            timedEvent(id: "a", start: start, end: end, calendarID: "g:work", title: "Standup"),
            timedEvent(id: "b", start: start, end: end, calendarID: "ek:home", title: "Retro"),
            timedEvent(
                id: "c",
                start: start.addingTimeInterval(1_800),
                end: end,
                calendarID: "ek:home",
                title: "Standup"
            ),
        ])
        XCTAssertEqual(groups.count, 3)
    }

    func testMergedBlockPrefersACopyThatCanBeEdited() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = date(2026, 8, 12, hour: 11, calendar: calendar)
        let end = date(2026, 8, 12, hour: 12, calendar: calendar)
        let readOnly = timedEvent(
            id: "ro",
            start: start,
            end: end,
            calendarID: "ek:sub",
            title: "Sync",
            isWritable: false
        )
        let writable = timedEvent(id: "rw", start: start, end: end, calendarID: "g:work", title: "Sync")

        let groups = CalendarWeekMath.consolidate([readOnly, writable])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.event.id, "rw", "the editable copy has to lead the merged block")
    }

    private func timedEvent(
        id: String,
        start: Date,
        end: Date,
        calendarID: String = "ek:cal",
        title: String? = nil,
        isWritable: Bool = true
    ) -> StarlingsCalendarEvent {
        StarlingsCalendarEvent(
            id: id,
            calendarID: calendarID,
            rawEventID: id,
            title: title ?? id,
            start: start,
            end: end,
            isAllDay: false,
            isWritable: isWritable,
            isRecurring: false,
            joinURL: "",
            roomSlug: "",
            attendeeEmails: [],
            source: .eventKit
        )
    }

    private func date(
        _ year: Int,
        _ month: Int,
        _ day: Int,
        hour: Int = 0,
        minute: Int = 0,
        calendar: Calendar
    ) -> Date {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        return calendar.date(from: components)!
    }

    /// Google spells an all-day end as the exclusive midnight after it;
    /// EventKit spells it as 23:59:59 inside it. Both mean one day.
    func testAllDayCopiesMergeAcrossSourcesThatSpellTheEndDifferently() {
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: date(2026, 8, 27, calendar: calendar))
        let exclusiveEnd = calendar.date(byAdding: .day, value: 1, to: start)!
        let groups = CalendarWeekMath.consolidate([
            allDayEvent(id: "g", start: start, end: exclusiveEnd, calendarID: "g:work"),
            allDayEvent(id: "ek", start: start, end: exclusiveEnd.addingTimeInterval(-1), calendarID: "ek:personal"),
        ])
        XCTAssertEqual(groups.count, 1, "one all-day event on two accounts is one row")
        XCTAssertEqual(groups.first?.calendarIDs.count, 2)
    }

    func testAllDayEventsOnDifferentDaysStaySeparate() {
        let calendar = Calendar.current
        let thursday = calendar.startOfDay(for: date(2026, 8, 27, calendar: calendar))
        let friday = calendar.date(byAdding: .day, value: 1, to: thursday)!
        let groups = CalendarWeekMath.consolidate([
            allDayEvent(id: "a", start: thursday, end: friday, calendarID: "g:work"),
            allDayEvent(id: "b", start: friday, end: calendar.date(byAdding: .day, value: 1, to: friday)!, calendarID: "ek:personal"),
        ])
        XCTAssertEqual(groups.count, 2, "same title on two days is two events")
    }

    private func allDayEvent(
        id: String = "trip",
        start: Date,
        end: Date,
        calendarID: String = "ek:cal",
        title: String = "Paris, France"
    ) -> StarlingsCalendarEvent {
        StarlingsCalendarEvent(
            id: id,
            calendarID: calendarID,
            rawEventID: id,
            title: title,
            start: start,
            end: end,
            isAllDay: true,
            isWritable: true,
            isRecurring: false,
            joinURL: "",
            roomSlug: "",
            attendeeEmails: [],
            source: .eventKit
        )
    }
}
