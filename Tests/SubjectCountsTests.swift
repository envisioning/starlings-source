import XCTest
@testable import Starlings

/// `GET /api/crm/subject-counts` (docs/WORK.md): the badges are built from
/// whatever statuses Core answered, and a status Core did not name is zero,
/// not missing — the answer arrived, there were no rows.
final class SubjectCountsTests: XCTestCase {
    func testProjectBadgesSplitByBucketAndReadAbsentAsZero() throws {
        let body = Data("""
        {"counts":{"all":5,"open":3,"Active":2,"Paused":1,"Archived":2},
         "internal":{"all":2,"open":1,"Active":1,"Archived":1},
         "client":{"all":3,"open":2,"Active":1,"Paused":1,"Archived":1}}
        """.utf8)
        let response = try JSONDecoder().decode(CrmSubjectCountsResponse.self, from: body)
        XCTAssertEqual(response.internalBadges["open"], CrmSubjectStatusCount(count: 1, hasMore: false))
        XCTAssertEqual(response.internalBadges["Paused"], CrmSubjectStatusCount(count: 0, hasMore: false))
        XCTAssertEqual(response.clientBadges["Archived"], CrmSubjectStatusCount(count: 1, hasMore: false))
        XCTAssertEqual(Set(response.clientBadges.keys), Set(CrmSubjectStatusOption.project.map(\.id)))
    }

    func testLeadBadgesUseCountsAlone() throws {
        let body = Data(#"{"counts":{"all":3,"open":3,"Conversations":2,"Closed Won":1}}"#.utf8)
        let response = try JSONDecoder().decode(CrmSubjectCountsResponse.self, from: body)
        XCTAssertNil(response.internalCounts)
        XCTAssertEqual(response.leadBadges["Conversations"]?.count, 2)
        XCTAssertEqual(response.leadBadges["Proposal Out"]?.count, 0)
        XCTAssertEqual(response.leadBadges["all"]?.displayText, "3")
    }

    func testSubjectWriteInvalidatesTheBadges() {
        XCTAssertTrue(SnapshotStore.matches(
            key: MeetingControlAPI.subjectCountsSnapshotKey(kind: .project, query: ""),
            prefixes: [MeetingControlAPI.subjectCountsSnapshotPrefix]
        ))
        XCTAssertFalse(SnapshotStore.matches(
            key: MeetingControlAPI.subjectCountsSnapshotKey(kind: .project, query: ""),
            prefixes: [MeetingControlAPI.subjectsSnapshotPrefix]
        ))
    }
}
