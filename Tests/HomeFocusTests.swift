import XCTest
@testable import Starlings

/// What of Mine Home shows, from the wire shapes. Pinned here because three
/// surfaces draw it — the launch card, the menu bar, and the phone — and none
/// of them may decide "today" for itself. The rules are `focus` in
/// fixtures/work-items.json; this covers the wire dates.
final class HomeFocusTests: XCTestCase {
    private let calendar = Calendar.current
    private var noon: Date {
        calendar.date(bySettingHour: 12, minute: 0, second: 0, of: Date())!
    }

    private func wire(daysFromToday days: Int, hour: Int = 9) -> String {
        let day = calendar.date(byAdding: .day, value: days, to: noon)!
        return CrmTaskDate.wire(calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)!)
    }

    private func focus(_ tasks: [CrmMyTask]) -> HomeFocus {
        HomeFocus.plan(tasks: tasks, issues: [], now: noon, calendar: calendar)
    }

    func testSplitsLateFromTodayAndDropsTheRest() {
        let plan = focus([
            CrmMyTask(id: "later", title: "Later", dueDate: wire(daysFromToday: 1)),
            CrmMyTask(id: "today", title: "Today", dueDate: wire(daysFromToday: 0, hour: 17)),
            CrmMyTask(id: "late", title: "Late", dueDate: wire(daysFromToday: -2)),
            CrmMyTask(id: "undated", title: "Undated"),
        ])
        XCTAssertEqual(plan.lateCount, 1)
        XCTAssertEqual(plan.todayCount, 1)
        XCTAssertEqual(plan.rows.map(\.id), ["late", "today"])
        XCTAssertEqual(plan.summary, "1 overdue · 1 due today")
    }

    func testDueEarlierTodayIsStillTodayNotLate() {
        // A date-only column parses to local midnight; a task due today must
        // not read as overdue at breakfast.
        let plain = DateFormatter()
        plain.calendar = calendar
        plain.timeZone = .current
        plain.dateFormat = "yyyy-MM-dd"
        let plan = focus([
            CrmMyTask(id: "midnight", title: "Date only", dueDate: plain.string(from: noon)),
            CrmMyTask(id: "morning", title: "Morning", dueDate: wire(daysFromToday: 0, hour: 8)),
        ])
        XCTAssertEqual(plan.lateCount, 0)
        XCTAssertEqual(plan.rows.map(\.id), ["midnight", "morning"])
    }

    func testFinishedWorkIsNotToday() {
        let plan = focus([
            CrmMyTask(id: "done", title: "Done", status: .completed, dueDate: wire(daysFromToday: -1)),
            CrmMyTask(id: "dropped", title: "Dropped", status: .cancelled, dueDate: wire(daysFromToday: 0)),
        ])
        XCTAssertTrue(plan.isEmpty)
        XCTAssertNil(plan.summary)
    }

    func testLateIsOrderedOldestFirstThenByID() {
        let plan = focus([
            CrmMyTask(id: "b", title: "Bravo", dueDate: wire(daysFromToday: -1)),
            CrmMyTask(id: "old", title: "Oldest", dueDate: wire(daysFromToday: -5)),
            CrmMyTask(id: "a", title: "alpha", dueDate: wire(daysFromToday: -1)),
        ])
        XCTAssertEqual(plan.rows.map(\.id), ["old", "a", "b"])
    }

    func testSubjectStatusCountShowsLowerBoundWhenPageIsTruncated() {
        XCTAssertEqual(CrmSubjectStatusCount(count: 3, hasMore: false).displayText, "3")
        XCTAssertEqual(CrmSubjectStatusCount(count: 50, hasMore: true).displayText, "50+")
    }
}

final class CrmTaskDateDisplayTests: XCTestCase {
    func testDisplayNeverEchoesTheWireString() {
        for wire in ["2026-09-28T10:00:00+00:00", "2026-09-28T10:00:00Z", "2026-09-28"] {
            let text = CrmTaskDate.display(wire)
            XCTAssertNotNil(text, wire)
            XCTAssertFalse(text!.contains("T10"), wire)
            XCTAssertFalse(text!.contains("2026-09"), wire)
        }
    }

    func testDateOnlyStaysTheSameCalendarDay() {
        XCTAssertEqual(CrmTaskDate.display("2026-09-28"), StarlingsDateFormatting.date(CrmTaskDate.date("2026-09-28")!))
        let parts = Calendar.current.dateComponents([.day, .month], from: CrmTaskDate.date("2026-09-28")!)
        XCTAssertEqual(parts.day, 28)
        XCTAssertEqual(parts.month, 9)
    }

    func testUnparseableAndMissingAreNil() {
        XCTAssertNil(CrmTaskDate.display(nil))
        XCTAssertNil(CrmTaskDate.display("soon"))
    }
}
