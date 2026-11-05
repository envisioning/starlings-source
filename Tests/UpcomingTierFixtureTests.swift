import XCTest
@testable import Starlings

/// The shared table, run against the Swift implementation. The TypeScript port
/// runs the same file (`services/control-plane/test/upcoming-tiers.test.ts`),
/// which is the whole point: three surfaces drifted apart because nothing could
/// tell that they had.
///
/// A failure here is a question about `fixtures/upcoming-tiers.json` first — the
/// rules live there, and both implementations answer to it.
final class UpcomingTierFixtureTests: XCTestCase {
    func testNativeDefaultsComeFromTheSharedUpcomingConfig() {
        let configuration = UpcomingConfiguration.current

        XCTAssertEqual(configuration.version, 1)
        XCTAssertEqual(configuration.sectionTitle, "UPCOMING")
        XCTAssertEqual(MeetingFocus.horizon, configuration.horizon)
        XCTAssertEqual(MeetingFocus.requestHours, configuration.requestHours)
        XCTAssertEqual(MeetingFocus.homeFollowingRows, configuration.homeFollowingRows)
        XCTAssertEqual(MeetingFocus.joinLead, TimeInterval(configuration.joinWindowMinutes) * 60)
        XCTAssertEqual(configuration.joinWindowMinutes, 10)
        XCTAssertTrue(configuration.showTomorrow)
    }

    func testEveryFixtureCase() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1, "The fixture changed shape; re-read its rules before touching this.")
        XCTAssertFalse(table.cases.isEmpty)

        for testCase in table.cases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now), testCase.name)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone), testCase.name)

            let plan = MeetingFocus.classify(testCase.events, now: now, calendar: calendar)

            XCTAssertEqual(
                plan.agenda.map(\.upcomingID),
                testCase.expect.agenda,
                "agenda — \(testCase.name)"
            )
            XCTAssertEqual(
                plan.tiers.mapValues(\.rawValue),
                testCase.expect.tiers,
                "tiers — \(testCase.name)"
            )
            XCTAssertEqual(
                plan.focus?.upcomingID,
                testCase.expect.focus,
                "focus — \(testCase.name)"
            )

            var counts = ["agenda": plan.agenda.count]
            for tier in UpcomingTier.allCases { counts[tier.rawValue] = plan.count(tier) }
            XCTAssertEqual(counts, testCase.expect.counts, "counts — \(testCase.name)")

            for (id, expected) in testCase.expect.canJoin ?? [:] {
                let event = try XCTUnwrap(testCase.events.first { $0.id == id }, "\(id) — \(testCase.name)")
                XCTAssertEqual(MeetingFocus.canJoin(event, now: now), expected, "canJoin \(id) — \(testCase.name)")
            }
        }
    }

    /// The rules the table cannot state, because they are about the shape of the
    /// answer rather than about any one day.
    func testFocusIsAlwaysSomethingOnTodaysAgenda() throws {
        for testCase in try loadTable().cases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone))
            let plan = MeetingFocus.classify(testCase.events, now: now, calendar: calendar)
            guard let focus = plan.focus else {
                XCTAssertTrue(plan.isDayClosed, testCase.name)
                continue
            }
            XCTAssertTrue(plan.agenda.contains { $0.upcomingID == focus.upcomingID }, testCase.name)
            XCTAssertTrue([.now, .today].contains(plan.tier(of: focus)), testCase.name)
            XCTAssertFalse(focus.upcomingIsDemoted, testCase.name)
            XCTAssertFalse(focus.upcomingIsAllDay, testCase.name)
        }
    }

    func testTiersPartitionTheAgenda() throws {
        for testCase in try loadTable().cases {
            let now = try XCTUnwrap(ISODate.parse(testCase.now))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = try XCTUnwrap(TimeZone(identifier: testCase.timeZone))
            let plan = MeetingFocus.classify(testCase.events, now: now, calendar: calendar)
            let grouped = UpcomingTier.allCases.flatMap { plan.events(in: $0).map(\.upcomingID) }
            XCTAssertEqual(Set(grouped), Set(plan.agenda.map(\.upcomingID)), testCase.name)
            XCTAssertEqual(grouped.count, plan.agenda.count, testCase.name)
        }
    }

    func testClosedDaySummaryDoesNotSurfaceMeetingsFartherAhead() throws {
        let now = try XCTUnwrap(ISODate.parse("2026-08-19T19:00:00Z"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let event = FixtureEvent(
            id: "next-week",
            title: "Planning",
            start: "2026-08-25T09:00:00Z",
            end: "2026-08-25T10:00:00Z",
            allDay: false,
            demoted: false,
            joinable: true
        )

        let plan = MeetingFocus.classify([event], now: now, calendar: calendar)

        XCTAssertEqual(plan.count(.ahead), 0)
        XCTAssertEqual(MeetingFocus.closedDaySummary(plan, calendar: calendar), "Nothing scheduled today or tomorrow.")
    }

    func testHomeRowsUseSharedTomorrowPolicyAndDensity() throws {
        let table = try loadTable()

        let inProgressCase = try XCTUnwrap(
            table.cases.first { $0.name == "an in-progress meeting holds the hero" }
        )
        let inProgressNow = try XCTUnwrap(ISODate.parse(inProgressCase.now))
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = try XCTUnwrap(TimeZone(identifier: inProgressCase.timeZone))
        let inProgressPlan = MeetingFocus.classify(inProgressCase.events, now: inProgressNow, calendar: utc)
        XCTAssertEqual(inProgressPlan.focus?.upcomingID, "review")
        XCTAssertEqual(inProgressPlan.homeRows.map(\.upcomingID), ["sam"])
        XCTAssertEqual(inProgressPlan.homeRows.count, 1)

        let closedCase = try XCTUnwrap(
            table.cases.first { $0.name == "a closed day: tomorrow's first meeting never takes the hero" }
        )
        let closedNow = try XCTUnwrap(ISODate.parse(closedCase.now))
        let closedPlan = MeetingFocus.classify(closedCase.events, now: closedNow, calendar: utc)
        XCTAssertNil(closedPlan.focus)
        XCTAssertEqual(closedPlan.homeRows.map(\.upcomingID), ["standup", "board"])

        let crowdedCase = try XCTUnwrap(
            table.cases.first { $0.name == "the compact card points to the rest of day before farther dates" }
        )
        let crowdedNow = try XCTUnwrap(ISODate.parse(crowdedCase.now))
        let crowdedPlan = MeetingFocus.classify(crowdedCase.events, now: crowdedNow, calendar: utc)
        XCTAssertEqual(crowdedPlan.homeRows.map(\.upcomingID), ["today-2", "today-3"])
        XCTAssertEqual(crowdedPlan.remainingTodayCount, 1)
        XCTAssertEqual(crowdedPlan.remainingToday.map(\.upcomingID), ["today-4"])
    }

    func testCrossCalendarCopiesCollapseButSameCalendarCopiesRemain() throws {
        let start = "2026-08-19T15:00:00Z"
        let end = "2026-08-19T15:30:00Z"
        let primary = CalendarEventSummary(
            id: "primary-status",
            calendarId: "primary",
            calendarSummary: "Primary",
            htmlLink: "",
            title: "Status",
            start: start,
            end: end,
            joinUrl: "",
            roomSlug: "",
            isMeetEvent: false,
            attendees: [],
            organizerSelf: false,
            platform: .none,
            conferenceUrl: "",
            isAllDay: false
        )
        let secondary = CalendarEventSummary(
            id: "secondary-status",
            calendarId: "acct:secondary:primary",
            calendarSummary: "Secondary",
            htmlLink: "",
            title: " status ",
            start: start,
            end: end,
            joinUrl: "",
            roomSlug: "",
            isMeetEvent: false,
            attendees: [],
            organizerSelf: false,
            platform: .none,
            conferenceUrl: "",
            isAllDay: false
        )
        let sameCalendar = CalendarEventSummary(
            id: "primary-status-copy",
            calendarId: "primary",
            calendarSummary: "Primary",
            htmlLink: "",
            title: "Status",
            start: start,
            end: end,
            joinUrl: "",
            roomSlug: "",
            isMeetEvent: false,
            attendees: [],
            organizerSelf: false,
            platform: .none,
            conferenceUrl: "",
            isAllDay: false
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let now = try XCTUnwrap(ISODate.parse("2026-08-19T09:00:00Z"))

        let plan = MeetingFocus.classify([primary, secondary, sameCalendar], now: now, calendar: calendar)
        XCTAssertEqual(plan.agenda.map(\.id), ["primary-status", "primary-status-copy"])
    }

    // MARK: - The table

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "upcoming-tiers", withExtension: "json"),
            "fixtures/upcoming-tiers.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let cases: [FixtureCase]
    }

    private struct FixtureCase: Decodable {
        let name: String
        let now: String
        let timeZone: String
        let events: [FixtureEvent]
        let expect: FixtureExpectation
    }

    private struct FixtureExpectation: Decodable {
        let agenda: [String]
        let tiers: [String: String]
        let focus: String?
        let counts: [String: Int]
        let canJoin: [String: Bool]?
    }

    /// The neutral shape the table is written in. Conforming it here rather than
    /// reusing a wire type keeps the table about the rules, and keeps a decoding
    /// bug in one client from looking like a rules failure in both.
    private struct FixtureEvent: Decodable, UpcomingEvent {
        let id: String
        let title: String
        let start: String?
        let end: String?
        let allDay: Bool
        let demoted: Bool
        let joinable: Bool
        let calendarId: String?
        let attendees: [FixtureAttendee]?

        init(
            id: String,
            title: String,
            start: String?,
            end: String?,
            allDay: Bool,
            demoted: Bool,
            joinable: Bool,
            calendarId: String? = nil,
            attendees: [FixtureAttendee]? = nil
        ) {
            self.id = id
            self.title = title
            self.start = start
            self.end = end
            self.allDay = allDay
            self.demoted = demoted
            self.joinable = joinable
            self.calendarId = calendarId
            self.attendees = attendees
        }

        var upcomingID: String { id }
        var upcomingCalendarID: String? { calendarId }
        var upcomingAttendees: [UpcomingAttendee]? {
            attendees?.map { UpcomingAttendee(status: $0.status, isSelf: $0.isSelf) }
        }
        var upcomingTitle: String { title }
        var upcomingStart: Date? { start.flatMap(ISODate.parse) }
        var upcomingEnd: Date? { end.flatMap(ISODate.parse) }
        var upcomingIsAllDay: Bool { allDay }
        var upcomingIsDemoted: Bool { demoted }
    }

    private struct FixtureAttendee: Decodable {
        let status: String
        let isSelf: Bool

        enum CodingKeys: String, CodingKey {
            case status
            case isSelf = "self"
        }
    }
}
