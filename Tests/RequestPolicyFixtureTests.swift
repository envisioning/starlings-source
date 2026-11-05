import XCTest
@testable import Starlings

/// The request policy both clients read (meet#597). `fixtures/request-policy.json`
/// is written from `packages/contracts/src/request-policy.ts`; the Worker suite
/// and the web suite read the same file, so the three clients cannot drift on
/// the timeout, the retry rule or which lists a write makes stale.
final class RequestPolicyFixtureTests: XCTestCase {
    private struct Table: Decodable {
        struct Retry: Decodable {
            let methods: [String]
            let extraAttempts: Int
            let delaySeconds: Double
            let statusFloor: Int
            let statuses: [Int]
        }

        struct Row: Decodable {
            let name: String
            let key: String
            let read: String
            let clients: [String]
            let invalidatedBy: [String]
        }

        let version: Int
        let timeoutSeconds: Double
        let retry: Retry
        let snapshots: [Row]
        let writes: [String: [String]]
    }

    private func table() throws -> Table {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "request-policy", withExtension: "json"),
            "fixtures/request-policy.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
    }

    func testTheTimeoutAndTheRetryRuleMatchTheFixture() throws {
        let table = try table()
        XCTAssertEqual(table.version, 1)
        XCTAssertEqual(StarlingsRequestPolicy.timeoutSeconds, table.timeoutSeconds)
        XCTAssertEqual(StarlingsRequestPolicy.retry.methods, table.retry.methods)
        XCTAssertEqual(StarlingsRequestPolicy.retry.extraAttempts, table.retry.extraAttempts)
        XCTAssertEqual(StarlingsRequestPolicy.retry.delaySeconds, table.retry.delaySeconds)
        XCTAssertEqual(StarlingsRequestPolicy.retry.statusFloor, table.retry.statusFloor)
        XCTAssertEqual(StarlingsRequestPolicy.retry.statuses, table.retry.statuses)
    }

    func testEverySnapshotRowMatchesTheFixture() throws {
        let table = try table()
        XCTAssertEqual(StarlingsRequestPolicy.snapshots.count, table.snapshots.count)
        for (swift, wire) in zip(StarlingsRequestPolicy.snapshots, table.snapshots) {
            XCTAssertEqual(swift.name, wire.name)
            XCTAssertEqual(swift.key, wire.key, wire.name)
            XCTAssertEqual(swift.read, wire.read, wire.name)
            XCTAssertEqual(swift.clients.map(\.rawValue), wire.clients, wire.name)
            XCTAssertEqual(swift.invalidatedBy.map(\.rawValue), wire.invalidatedBy, wire.name)
        }
    }

    func testEveryWriteClearsExactlyWhatTheFixtureSays() throws {
        let table = try table()
        XCTAssertEqual(Set(StarlingsSnapshotWrite.allCases.map(\.rawValue)), Set(table.writes.keys))
        for write in StarlingsSnapshotWrite.allCases {
            XCTAssertEqual(StarlingsRequestPolicy.invalidated(by: write), table.writes[write.rawValue], write.rawValue)
            XCTAssertFalse(StarlingsRequestPolicy.invalidated(by: write).isEmpty, "\(write.rawValue) clears nothing")
        }
    }

    func testTheKeysBothClientsBuildArePerQueryUnderTheirRow() {
        XCTAssertEqual(
            StarlingsSnapshotKey.tasksKey(projectID: "p", leadID: nil),
            "crm/tasks?project_id=p&lead_id=&event_id=&organization_id="
        )
        XCTAssertEqual(
            StarlingsSnapshotKey.interactionsKey(projectID: nil, leadID: "l"),
            "crm/interactions?project_id=&lead_id=l&organization_id="
        )
        XCTAssertEqual(
            StarlingsSnapshotKey.subjectsKey(kind: .project, query: "ab", status: nil),
            "crm/subjects?kind=project&q=ab&status="
        )
        XCTAssertEqual(
            StarlingsSnapshotKey.subjectCountsKey(kind: .lead, query: ""),
            "crm/subject-counts?kind=lead&q="
        )
    }

    /// A page stored per query is under its row's key; a key that merely starts
    /// the same way is not. This is the rule the stores apply on every write.
    func testAPageIsUnderItsRowAndASiblingIsNot() {
        let cleared = StarlingsRequestPolicy.invalidated(by: .subjectWrite)
        let pages = [
            StarlingsSnapshotKey.subjectsKey(kind: .project, query: "", status: "active"),
            StarlingsSnapshotKey.subjectCountsKey(kind: .project, query: ""),
        ]
        for page in pages {
            XCTAssertTrue(SnapshotStore.matches(key: page, prefixes: cleared), page)
        }
        XCTAssertFalse(SnapshotStore.matches(key: StarlingsSnapshotKey.subjectState, prefixes: cleared))
        XCTAssertFalse(SnapshotStore.matches(key: StarlingsSnapshotKey.mine, prefixes: cleared))
    }
}
