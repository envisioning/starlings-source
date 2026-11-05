import XCTest
@testable import Starlings

/// How an issue list is narrowed, and how one is read.
///
/// Pinned here because the answers are load-bearing in two directions: a
/// filter that quietly stayed on this side of the wire would hide the matches
/// that did not fit in a page, and a thread that sorted its own way would make
/// a label change look like the last thing that happened.
final class IssueFilterTests: XCTestCase {
    private func names(_ items: [URLQueryItem]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: items.compactMap { item in
            item.value.map { (item.name, $0) }
        })
    }

    // MARK: - What is asked of the server

    func testEveryNarrowingButSearchGoesToTheServer() {
        var filter = CrmIssueFilter()
        filter.state = .all
        filter.labels = ["bug", "ready-for-agent"]
        filter.assignee = "rosa"
        filter.milestone = "4"
        filter.sort = .comments
        filter.search = "briefing"

        let sent = names(filter.query(projectID: "p").queryItems)
        XCTAssertEqual(sent["state"], "all")
        XCTAssertEqual(sent["labels"], "bug,ready-for-agent", "GitHub ANDs a comma-separated list")
        XCTAssertEqual(sent["assignee"], "rosa")
        XCTAssertEqual(sent["milestone"], "4")
        XCTAssertEqual(sent["sort"], "comments")
        XCTAssertEqual(sent["direction"], "desc")
        XCTAssertNil(sent["search"], "the search field never leaves the device")
    }

    func testAnUnsetFilterAsksForNothingItDoesNotMean() {
        let sent = names(CrmIssueFilter().query(projectID: "p").queryItems)
        XCTAssertEqual(sent["state"], "open")
        XCTAssertEqual(sent["sort"], "updated")
        XCTAssertEqual(sent["direction"], "desc")
        XCTAssertNil(sent["labels"])
        XCTAssertNil(sent["assignee"])
        XCTAssertNil(sent["milestone"])
    }

    func testOldestIsCreatedReadTheOtherWayRound() {
        var filter = CrmIssueFilter()
        filter.sort = .created
        filter.ascending = true
        XCTAssertEqual(names(filter.query(projectID: "p").queryItems)["direction"], "asc")
    }

    func testOnlyANarrowedFilterOffersToClear() {
        XCTAssertFalse(CrmIssueFilter().isNarrowed)
        var typed = CrmIssueFilter()
        typed.search = "276"
        XCTAssertTrue(typed.isNarrowed, "a search nobody can see is a list nobody can explain")
    }

    // MARK: - The one narrowing this side does

    func testSearchMatchesTitleNumberAndLabel() {
        let issue = IssueFixture.make(
            number: 276,
            title: "Apply to briefing jumps around",
            labels: ["bug", "ready-for-agent"]
        )
        var filter = CrmIssueFilter()

        filter.search = ""
        XCTAssertTrue(filter.matches(issue), "no search is not a filter")
        filter.search = "briefing"
        XCTAssertTrue(filter.matches(issue))
        filter.search = "276"
        XCTAssertTrue(filter.matches(issue), "a number is how somebody looks for an issue they know")
        filter.search = "#276"
        XCTAssertTrue(filter.matches(issue))
        filter.search = "ready-for"
        XCTAssertTrue(filter.matches(issue))
        filter.search = "lobby"
        XCTAssertFalse(filter.matches(issue))
    }

    // MARK: - What is written back

    func testAnEditSendsTheWholeSetAndSaysNothingElse() throws {
        // GitHub replaces on PATCH rather than adding, so an edit names what
        // the issue should end up with. Anything nobody touched must be
        // absent, not null — null means "take it off".
        let sent = try wire(CrmIssueUpdate(
            owner: "envisioning",
            repo: "starlings",
            number: 142,
            labels: ["bug"],
            assignees: []
        ))
        XCTAssertEqual(sent["labels"] as? [String], ["bug"])
        XCTAssertEqual(sent["assignees"] as? [String], [])
        XCTAssertNil(sent.index(forKey: "milestone"), "an untouched milestone is absent, not cleared")
        XCTAssertNil(sent.index(forKey: "state"))
    }

    func testAMilestoneCanBeSetClearedOrLeftAlone() throws {
        var update = CrmIssueUpdate(owner: "envisioning", repo: "starlings", number: 142)
        XCTAssertNil(try wire(update).index(forKey: "milestone"), "leave it alone")

        update.milestone = .value(4)
        XCTAssertEqual(try wire(update)["milestone"] as? Int, 4)

        update.milestone = .null
        let cleared = try wire(update)
        XCTAssertNotNil(cleared.index(forKey: "milestone"), "clearing has to be said, not omitted")
        XCTAssertTrue(cleared["milestone"] is NSNull)
    }

    func testFacetsReadTheWire() throws {
        let empty: CrmIssueFacets = IssueFixture.decode(["labels": [], "milestones": [], "assignees": []])
        XCTAssertTrue(empty.isEmpty, "no pickers is a state, not a crash")
        let some: CrmIssueFacets = IssueFixture.decode([
            "labels": [["name": "bug", "color": "d73a4a", "description": NSNull()]],
            "milestones": [],
            "assignees": [["login": "rosa", "avatar_url": NSNull()]],
        ])
        XCTAssertEqual(some.labels.first?.color, "d73a4a")
        XCTAssertEqual(some.assignees.first?.login, "rosa")
        XCTAssertTrue(some.milestones.isEmpty)
    }

    private func wire(_ update: CrmIssueUpdate) throws -> [String: Any] {
        let data = try JSONEncoder().encode(update)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - What came back

    func testLabelsDrawEvenWhenCoreSentNoColours() {
        // An older control plane sends names only. Grey chips beat no chips.
        let plain = IssueFixture.make(labels: ["bug"])
        XCTAssertEqual(plain.drawableLabels.map(\.name), ["bug"])
        XCTAssertNil(plain.drawableLabels.first?.color)

        let coloured = IssueFixture.make(labels: ["bug"], labelColours: ["bug": "d73a4a"])
        XCTAssertEqual(coloured.drawableLabels.first?.color, "d73a4a")
    }

    func testClosedSaysWhyWhenGitHubDistinguishesIt() {
        XCTAssertEqual(IssueFixture.make().stateSummary, "Open")
        XCTAssertEqual(IssueFixture.make(state: "closed").stateSummary, "Closed")
        XCTAssertEqual(
            IssueFixture.make(state: "closed", stateReason: "not_planned").stateSummary,
            "Closed as not planned",
            "deciding against work is not finishing it"
        )
    }

    func testThreadInterleavesCommentsAndEventsByTime() throws {
        let detail = try IssueFixture.detail(
            comments: [(9, "rosa", "2026-09-03T14:30:00Z"), (10, "felix", "2026-09-03T15:00:00Z")],
            events: [
                ("labeled", "2026-09-03T14:45:00Z"),
                ("assigned", "2026-09-03T14:05:00Z"),
            ]
        )
        XCTAssertEqual(
            detail.thread.map(\.id),
            ["event-assigned-2", "comment-9", "event-labeled-1", "comment-10"],
            "the thread reads in the order it happened, not comments then events"
        )
    }

    func testAnEventNobodyCanReadIsNotDrawn() throws {
        let detail = try IssueFixture.detail(
            comments: [],
            events: [("subscribed", "2026-09-03T14:00:00Z"), ("closed", "2026-09-03T14:10:00Z")]
        )
        XCTAssertEqual(
            detail.thread.count, 1,
            "a line reading “rosa subscribed” is noise; silence is better than a bad line"
        )
        XCTAssertNil(CrmIssueEvent.fixture(kind: "subscribed").summary)
        XCTAssertEqual(CrmIssueEvent.fixture(kind: "reopened", actor: "rosa").summary, "rosa reopened this")
        XCTAssertEqual(
            CrmIssueEvent.fixture(kind: "closed", actor: "rosa", stateReason: "not_planned").summary,
            "rosa closed this as not planned"
        )
    }
}

/// Issues built from the wire, because that is the only way they are ever
/// built — every one of these types decodes rather than initializes.
private enum IssueFixture {
    static func make(
        number: Int = 142,
        title: String = "Lobby drops on rejoin",
        state: String = "open",
        stateReason: String? = nil,
        labels: [String] = [],
        labelColours: [String: String] = [:]
    ) -> CrmIssue {
        var json: [String: Any] = [
            "id": "envisioning/starlings#\(number)",
            "number": number,
            "owner": "envisioning",
            "repo": "starlings",
            "title": title,
            "state": state,
            "url": "https://github.com/envisioning/starlings-source/issues/\(number)",
            "labels": labels,
            "comments": 0,
        ]
        if let stateReason { json["state_reason"] = stateReason }
        if !labelColours.isEmpty {
            json["label_details"] = labels.map { name in
                ["name": name, "color": labelColours[name] as Any, "description": NSNull()]
            }
        }
        return decode(json)
    }

    static func detail(
        comments: [(Int, String, String)],
        events: [(String, String)]
    ) throws -> CrmIssueDetail {
        var json: [String: Any] = [
            "id": "envisioning/signals-ai#276",
            "number": 276,
            "owner": "envisioning",
            "repo": "signals-ai",
            "title": "Apply to briefing jumps around",
            "state": "open",
            "url": "https://github.com/envisioning/signals-ai/issues/276",
            "labels": [],
            "body": "## Acceptance criteria",
            "comments": comments.count,
        ]
        json["comments_list"] = comments.map { id, author, created in
            ["id": id, "author": author, "body": "…", "created_at": created, "url": "https://github.com/…"]
        }
        json["timeline"] = events.enumerated().map { index, event in
            [
                "id": "\(event.0)-\(index + 1)",
                "kind": event.0,
                "actor": "rosa",
                "created_at": event.1,
            ]
        }
        return decode(json)
    }

    static func decode<T: Decodable>(_ json: [String: Any]) -> T {
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(T.self, from: data)
    }
}

private extension CrmIssueEvent {
    static func fixture(kind: String, actor: String? = nil, stateReason: String? = nil) -> CrmIssueEvent {
        var json: [String: Any] = ["id": "\(kind)-1", "kind": kind]
        if let actor { json["actor"] = actor }
        if let stateReason { json["state_reason"] = stateReason }
        return IssueFixture.decode(json)
    }
}
