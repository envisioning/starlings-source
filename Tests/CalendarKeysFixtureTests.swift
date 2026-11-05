import XCTest
@testable import Starlings

final class CalendarKeysFixtureTests: XCTestCase {
    func testTheGrammarAndRulesMatchTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(CalendarKeys.subscribedAccount, table.subscribedAccountKey)
        XCTAssertEqual(
            [
                "googlePrefix": CalendarKeys.googlePrefix,
                "subscriptionPrefix": CalendarKeys.subscriptionPrefix,
                "eventKitPrefix": CalendarKeys.eventKitPrefix,
                "eventKitSeparator": CalendarKeys.eventKitSeparator,
                "accountPrefix": CalendarKeys.accountPrefix,
                "eventPrefix": CalendarKeys.eventPrefix,
                "googleEventPrefix": CalendarKeys.googleEventPrefix,
            ],
            table.formats
        )
        for row in table.google { XCTAssertEqual(CalendarKeys.google(row.id), row.out) }
        for row in table.subscription { XCTAssertEqual(CalendarKeys.subscription(row.id), row.out) }
        for row in table.eventKit { XCTAssertEqual(CalendarKeys.eventKit(account: row.account, title: row.title), row.out) }
        for row in table.account { XCTAssertEqual(CalendarKeys.account(row.title), row.out) }
        for row in table.demotion {
            XCTAssertEqual(CalendarKeys.eventDemotion(isSubscription: row.isSubscription, eventID: row.eventId), row.out)
        }
        for row in table.hide {
            let actual = CalendarKeys.withCalendarHidden(
                Set(row.keys),
                calendarKey: row.calendar.key,
                accountKey: row.calendar.accountKey,
                siblingKeys: row.calendar.siblingKeys,
                hidden: row.hidden
            )
            XCTAssertEqual(actual.sorted(), row.out, row.name)
        }
        for row in table.hideAccount {
            let actual = CalendarKeys.withAccountHidden(
                Set(row.keys),
                accountKey: row.account.key,
                memberKeys: row.account.memberKeys,
                hidden: row.hidden
            )
            XCTAssertEqual(actual.sorted(), row.out, row.name)
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "calendar-keys", withExtension: "json"),
            "fixtures/calendar-keys.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let subscribedAccountKey: String
        let formats: [String: String]
        let google: [IDRow]
        let subscription: [IDRow]
        let eventKit: [EventKitRow]
        let account: [TitleRow]
        let demotion: [DemotionRow]
        let hide: [HideRow]
        let hideAccount: [HideAccountRow]
    }

    private struct IDRow: Decodable { let id: String; let out: String }
    private struct TitleRow: Decodable { let title: String; let out: String }
    private struct EventKitRow: Decodable { let account: String; let title: String; let out: String }
    private struct DemotionRow: Decodable { let isSubscription: Bool; let eventId: String; let out: String }
    private struct HideRow: Decodable {
        let name: String
        let keys: [String]
        let calendar: Calendar
        let hidden: Bool
        let out: [String]
        struct Calendar: Decodable { let key: String; let accountKey: String; let siblingKeys: [String] }
    }
    private struct HideAccountRow: Decodable {
        let name: String
        let keys: [String]
        let account: Account
        let hidden: Bool
        let out: [String]
        struct Account: Decodable { let key: String; let memberKeys: [String] }
    }
}
