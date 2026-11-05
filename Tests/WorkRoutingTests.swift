import XCTest
@testable import Starlings

/// Which door a conversation is behind. Every surface that announces an
/// unread message — the launch card, the tab badges, Home's card, Work's Mine
/// pane — splits on these, so they are pinned here rather than re-derived per
/// screen. See docs/SURFACES.md, "A conversation lives behind exactly one
/// door on every client."
final class WorkRoutingTests: XCTestCase {
    func testOnlyProjectAndLeadChannelsBelongToWork() {
        XCTAssertTrue(ThreadKind.project.isSubjectChannel)
        XCTAssertTrue(ThreadKind.lead.isSubjectChannel)
        // Everyone is a channel, but it is about everybody, so it stays in Team.
        XCTAssertFalse(ThreadKind.team.isSubjectChannel)
        XCTAssertTrue(ThreadKind.team.isChannel)
        XCTAssertFalse(ThreadKind.dm.isSubjectChannel)
        // A reserved kind must not leak into Work before it has a home.
        XCTAssertFalse(ThreadKind.meeting.isSubjectChannel)
        // An event's channel hangs off its CMS row (docs/EVENTS.md), so it
        // is Work's the same way a partner's is.
        XCTAssertTrue(ThreadKind.event.isSubjectChannel)
        XCTAssertTrue(ThreadKind.organization.isSubjectChannel)
    }

    func testSubjectChannelResolvesToTheSubjectWorkOpens() throws {
        let thread = ThreadSummary(
            id: "prj_abc",
            kind: .project,
            parentID: "core-project-1",
            peerEmail: nil,
            peerName: nil,
            lastMessageAt: nil,
            lastMessagePreview: "Deck is out",
            lastSenderEmail: nil,
            unread: true,
            subjectTitle: "Acme relaunch",
            audience: .everyone
        )
        let subject = try XCTUnwrap(thread.subject)
        XCTAssertEqual(subject.id, "core-project-1")
        XCTAssertEqual(subject.kind, "project")
        XCTAssertEqual(subject.title, "Acme relaunch")
        // A thread has counted nothing, so the subject it names claims nothing.
        XCTAssertEqual(subject.openTasks, 0)
        XCTAssertFalse(subject.hasRepo)
        // And it addresses the same conversation the subject picker would.
        XCTAssertEqual(ThreadAddress.subject(subject).id, "project:core-project-1")
    }

    func testPeopleAndEveryoneNeverResolveToASubject() {
        let dm = ThreadSummary(
            id: "dm_1", kind: .dm, parentID: nil, peerEmail: "a@example.com", peerName: "A",
            lastMessageAt: nil, lastMessagePreview: nil, lastSenderEmail: nil, unread: true
        )
        XCTAssertNil(dm.subject)
        let everyone = ThreadSummary(
            id: TeamThread.id, kind: .team, parentID: nil, peerEmail: nil, peerName: nil,
            lastMessageAt: nil, lastMessagePreview: nil, lastSenderEmail: nil, unread: true,
            subjectTitle: TeamThread.title, audience: .everyone
        )
        XCTAssertNil(everyone.subject)
        // A subject channel the server sent without its parent cannot be
        // opened, and must say so rather than opening the wrong thing.
        let orphan = ThreadSummary(
            id: "led_x", kind: .lead, parentID: nil, peerEmail: nil, peerName: nil,
            lastMessageAt: nil, lastMessagePreview: nil, lastSenderEmail: nil, unread: true,
            subjectTitle: "Lost lead", audience: .everyone
        )
        XCTAssertNil(orphan.subject)
    }
}
