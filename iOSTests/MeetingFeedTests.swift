import XCTest
@testable import Starlings

/// The next-meeting rules used to live as a one-line filter on each screen, and
/// the app went blank every evening because of it. These pin the behaviour that
/// replaced it.
final class MeetingFeedTests: XCTestCase {
    /// 09:00 local on 2025-08-11. Anchored to the local morning on purpose: the
    /// tiers are civil-day arithmetic, so a fixed UTC instant would put "in one
    /// hour" on a different day depending on where the test machine is.
    private let now: Date = {
        let base = Date(timeIntervalSince1970: 1_754_900_000)
        return Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: base) ?? base
    }()

    func testTomorrowIsOnTheAgendaAndNeverInTheHero() throws {
        // Two bugs, one test. A today-only filter used to mean Friday evening
        // showed nothing at all, however full Monday was — so tomorrow belongs
        // on the agenda. Then the fix overshot, and tomorrow's first meeting
        // started claiming the countdown card at seven in the evening.
        let tomorrow = try event(id: "a", title: "Standup", startsIn: 26 * 3600, minutes: 30)
        XCTAssertEqual(MeetingFeed.agenda([tomorrow], now: now).map(\.id), ["a"])
        XCTAssertNil(MeetingFeed.focus([tomorrow], now: now))
        XCTAssertTrue(MeetingFeed.plan([tomorrow], now: now).isDayClosed)
        XCTAssertEqual(MeetingFeed.plan([tomorrow], now: now).tier(of: tomorrow), .tomorrow)
    }

    func testEndedMeetingsDropOut() throws {
        let over = try event(id: "over", title: "Retro", startsIn: -7200, minutes: 60)
        let later = try event(id: "later", title: "Design", startsIn: 3600, minutes: 60)
        XCTAssertEqual(MeetingFeed.agenda([over, later], now: now).map(\.id), ["later"])
        XCTAssertEqual(MeetingFeed.focus([over, later], now: now)?.id, "later")
    }

    func testInProgressMeetingOutranksTheNextOne() throws {
        let running = try event(id: "running", title: "Roadmap", startsIn: -600, minutes: 60)
        let soon = try event(id: "soon", title: "1:1", startsIn: 1800, minutes: 30)
        let next = try XCTUnwrap(MeetingFeed.focus([soon, running], now: now))
        XCTAssertEqual(next.id, "running")
        XCTAssertTrue(next.isInProgress(at: now))
    }

    func testPlaceholderTitlesAreNotMeetings() throws {
        let block = try event(id: "block", title: "Block", startsIn: 600, minutes: 60)
        let real = try event(id: "real", title: "Sync", startsIn: 1200, minutes: 30)
        XCTAssertEqual(MeetingFeed.agenda([block, real], now: now).map(\.id), ["real"])
    }

    func testAnInPersonMeetingIsStillWhatIsNext() throws {
        // It just has no button. Requiring a video link to take the hero made
        // lunch with a client invisible and let the later Zoom claim to be next.
        let lunch = try event(id: "lunch", title: "Lunch", startsIn: 600, minutes: 60, platform: "none", conferenceUrl: "")
        let call = try event(id: "call", title: "Zoom call", startsIn: 1200, minutes: 30, platform: "zoom")
        XCTAssertEqual(MeetingFeed.agenda([lunch, call], now: now).map(\.id), ["lunch", "call"])
        XCTAssertEqual(MeetingFeed.meetings([lunch, call], now: now).map(\.id), ["call"])
        XCTAssertEqual(MeetingFeed.focus([lunch, call], now: now)?.id, "lunch")
        // Alerts stay a claim about joinable meetings — nothing to open, nothing
        // to interrupt for.
        XCTAssertEqual(MeetingFeed.alertableMeetings([lunch, call], now: now).map(\.id), ["call"])
    }

    /// A meeting hidden from Next is omitted from Upcoming altogether; it stays
    /// in the Calendar (fixtures/upcoming-tiers.json, c7b4eaf7). This test used
    /// to expect it on the agenda, and nothing ran it to say so (meet#592).
    func testHiddenMeetingIsOmittedFromUpcoming() throws {
        let flight = try event(
            id: "flight",
            title: "Colleague flight",
            startsIn: 600,
            minutes: 120,
            demoted: true
        )
        let sync = try event(id: "sync", title: "Team sync", startsIn: 3_600, minutes: 30)
        XCTAssertEqual(MeetingFeed.agenda([flight, sync], now: now).map(\.id), ["sync"])
        XCTAssertEqual(MeetingFeed.meetings([flight, sync], now: now).map(\.id), ["sync"])
        XCTAssertEqual(MeetingFeed.focus([flight, sync], now: now)?.id, "sync")
        XCTAssertEqual(MeetingFeed.alertableMeetings([flight, sync], now: now).map(\.id), ["sync"])
    }

    func testIdenticalEventsFromDifferentCalendarsBecomeOneHomeRow() throws {
        let primary = try event(
            id: "primary-status",
            calendarID: "primary",
            title: "Status",
            startsIn: 6 * 3600,
            minutes: 30
        )
        let secondary = try event(
            id: "secondary-status",
            calendarID: "acct:secondary:primary",
            title: " status ",
            startsIn: 6 * 3600,
            minutes: 30
        )

        XCTAssertEqual(MeetingFeed.agenda([primary, secondary], now: now).map(\.id), ["primary-status"])
    }

    func testSameCalendarCopiesStayAsSeparateHomeRows() throws {
        let first = try event(
            id: "status-one",
            title: "Status",
            startsIn: 6 * 3600,
            minutes: 30
        )
        let second = try event(
            id: "status-two",
            title: "Status",
            startsIn: 6 * 3600,
            minutes: 30
        )

        XCTAssertEqual(MeetingFeed.agenda([first, second], now: now).map(\.id), ["status-one", "status-two"])
    }

    func testAgendaStopsAfterTomorrow() throws {
        let tomorrow = try event(id: "tomorrow", title: "Board", startsIn: 26 * 3600, minutes: 60)
        let later = try event(id: "later", title: "Offsite", startsIn: 3 * 24 * 3600, minutes: 60)
        XCTAssertEqual(MeetingFeed.agenda([tomorrow, later], now: now).map(\.id), ["tomorrow"])
    }

    func testBoundaryIsTheNextInstantTheAnswerChanges() throws {
        let running = try event(id: "running", title: "Roadmap", startsIn: -600, minutes: 30)
        let soon = try event(id: "soon", title: "1:1", startsIn: 3600, minutes: 30)
        // The running meeting ends in 20 minutes; that is when `next` flips.
        XCTAssertEqual(
            MeetingFeed.nextBoundary([running, soon], now: now),
            now.addingTimeInterval(1200)
        )
    }

    func testUndatedEventsNeverWinTheCountdown() throws {
        let undated = try event(id: "undated", title: "TBC", start: "not-a-date", end: ISODate.format(now.addingTimeInterval(7200)))
        let real = try event(id: "real", title: "Sync", startsIn: 3600, minutes: 30)
        XCTAssertEqual(MeetingFeed.agenda([undated, real], now: now).map(\.id), ["real"])
        XCTAssertEqual(MeetingFeed.focus([undated, real], now: now)?.id, "real")
    }

    func testNoticeFiresOneMinuteBeforeTheStart() throws {
        let soon = try event(id: "soon", title: "Sync", startsIn: 1800, minutes: 30)
        let notice = try XCTUnwrap(MeetingAlertPlan.plan(meetings: [soon], now: now, lead: 60).first)
        XCTAssertEqual(notice.fireAt, notice.start.addingTimeInterval(-60))
        XCTAssertEqual(notice.eventID, "soon")
    }

    func testNoticeIsSkippedForAMeetingAlreadyInsideTheLeadWindow() throws {
        let imminent = try event(id: "imminent", title: "Sync", startsIn: 30, minutes: 30)
        XCTAssertTrue(MeetingAlertPlan.plan(meetings: [imminent], now: now, lead: 60).isEmpty)
    }

    func testLiveActivityCountsDownEveryFocusMeeting() throws {
        let lunch = try event(
            id: "lunch",
            title: "Lunch",
            startsIn: 30 * 60,
            minutes: 60,
            platform: "none",
            conferenceUrl: ""
        )
        let call = try event(id: "call", title: "Sync", startsIn: 30 * 60, minutes: 30)

        XCTAssertTrue(
            MeetingLiveActivity.isEligible(
                lunch,
                now: now,
                enabled: true,
                countdownLead: 60 * 60
            )
        )
        XCTAssertTrue(
            MeetingLiveActivity.isEligible(
                call,
                now: now,
                enabled: true,
                countdownLead: 60 * 60
            )
        )
    }

    func testLiveActivityRespectsSettingsAndLeadWindow() throws {
        let later = try event(id: "later", title: "Planning", startsIn: 3 * 60 * 60, minutes: 30)

        XCTAssertFalse(
            MeetingLiveActivity.isEligible(
                later,
                now: now,
                enabled: false,
                countdownLead: 4 * 60 * 60
            )
        )
        XCTAssertFalse(
            MeetingLiveActivity.isEligible(
                later,
                now: now,
                enabled: true,
                countdownLead: 60 * 60
            )
        )
    }

    func testNoticesStayUnderTheSystemLimit() throws {
        let many = try (0..<50).map { index in
            try event(id: "e\(index)", title: "Sync \(index)", startsIn: Double(index + 1) * 3600, minutes: 30)
        }
        let planned = MeetingAlertPlan.plan(meetings: many, now: now, lead: 60)
        XCTAssertEqual(planned.count, MeetingAlertPlan.maxScheduled)
        // The nearest meetings are the ones worth a slot.
        XCTAssertEqual(planned.first?.eventID, "e0")
    }

    // MARK: - Fixtures

    private func event(
        id: String,
        calendarID: String = "primary",
        title: String,
        startsIn offset: TimeInterval,
        minutes: Int,
        platform: String = "envisioning",
        conferenceUrl: String = "https://envisioning.starlings.example/room/rosa",
        demoted: Bool = false
    ) throws -> MobileCalendarEvent {
        let start = now.addingTimeInterval(offset)
        return try event(
            id: id,
            calendarID: calendarID,
            title: title,
            start: ISODate.format(start),
            end: ISODate.format(start.addingTimeInterval(TimeInterval(minutes * 60))),
            platform: platform,
            conferenceUrl: conferenceUrl,
            demoted: demoted
        )
    }

    private func event(
        id: String,
        calendarID: String = "primary",
        title: String,
        start: String,
        end: String,
        platform: String = "envisioning",
        conferenceUrl: String = "https://envisioning.starlings.example/room/rosa",
        demoted: Bool = false
    ) throws -> MobileCalendarEvent {
        let json = """
        {"id":"\(id)","calendarId":"\(calendarID)","calendarSummary":"Primary","htmlLink":"",
         "title":"\(title)","start":"\(start)","end":"\(end)","joinUrl":"","roomSlug":"",
         "isMeetEvent":false,"attendees":[],"organizerSelf":true,
         "platform":"\(platform)","conferenceUrl":"\(conferenceUrl)","allDay":false,
         "recurringEventId":"","recurring":false,"description":"","location":"",
         "travelTimeMinutes":null,"demoted":\(demoted),"calendarRole":"ordinary","subject":null}
        """
        return CalendarEventSummary(wire: try JSONDecoder().decode(CalendarEventWire.self, from: XCTUnwrap(json.data(using: .utf8))))
    }
}
