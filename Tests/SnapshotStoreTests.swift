import XCTest
@testable import Starlings

/// The snapshot store is a head start, never the answer — these pin the parts
/// that would turn it into a lie: another owner's data, an old envelope, a
/// stale entry, and a purge that misses the disk.
final class SnapshotStoreTests: XCTestCase {
    override func setUp() {
        super.setUp()
        SnapshotStore.purgeAll()
    }

    override func tearDown() {
        SnapshotStore.purgeAll()
        super.tearDown()
    }

    func testRoundTripsPerOwner() {
        let body = Data("{\"tasks\":[]}".utf8)
        SnapshotStore.save(body, key: "crm/mine", owner: "rosa@example.com")
        XCTAssertEqual(SnapshotStore.load(key: "crm/mine", owner: "rosa@example.com")?.data, body)
        // A different sign-in on the same device starts cold.
        XCTAssertNil(SnapshotStore.load(key: "crm/mine", owner: "ada@example.com"))
        // A different resource for the same owner is its own entry.
        XCTAssertNil(SnapshotStore.load(key: "crm/feed", owner: "rosa@example.com"))
    }

    func testKeepsTheValidator() {
        SnapshotStore.save(Data("x".utf8), key: "crm/mine", owner: "rosa", etag: "W/\"abc\"")
        XCTAssertEqual(SnapshotStore.load(key: "crm/mine", owner: "rosa")?.etag, "W/\"abc\"")
        // A save without one clears it: the next request must not revalidate
        // against a tag the server never issued for these bytes.
        SnapshotStore.save(Data("y".utf8), key: "crm/mine", owner: "rosa")
        XCTAssertNil(SnapshotStore.load(key: "crm/mine", owner: "rosa")?.etag)
    }

    func testOwnerKeyIsCaseInsensitive() {
        SnapshotStore.save(Data("x".utf8), key: "k", owner: "ROSA@example.com")
        XCTAssertNotNil(SnapshotStore.load(key: "k", owner: "rosa@example.com"))
    }

    func testInvalidateDropsMemoryOnly() {
        SnapshotStore.save(Data("x".utf8), key: "k", owner: "rosa")
        SnapshotStore.invalidate(key: "k", owner: "rosa")
        // Memory is gone; the disk write is fire-and-forget, so the next load
        // may or may not still find the file — either answer is honest. What
        // must hold is that nothing crashes and a later save wins.
        SnapshotStore.save(Data("y".utf8), key: "k", owner: "rosa")
        XCTAssertEqual(SnapshotStore.load(key: "k", owner: "rosa")?.data, Data("y".utf8))
    }

    func testPrefixMatching() {
        XCTAssertTrue(SnapshotStore.matches(key: "crm/mine", prefixes: ["crm/mine"]))
        XCTAssertTrue(SnapshotStore.matches(key: "crm/subjects?kind=lead&q=&status=", prefixes: ["crm/subjects"]))
        XCTAssertTrue(SnapshotStore.matches(key: "crm/subjects/lead/1", prefixes: ["crm/subjects"]))
        // A prefix is a resource, not a string: `crm/mine` must not take
        // `crm/mine-issues` with it, and `crm` alone names nothing.
        XCTAssertFalse(SnapshotStore.matches(key: "crm/mine-issues", prefixes: ["crm/mine"]))
        XCTAssertFalse(SnapshotStore.matches(key: "crm/feed", prefixes: ["crm/mine", "crm/subjects"]))
    }

    func testInvalidatePostsForOwnerOnly() {
        let posted = expectation(forNotification: SnapshotStore.didInvalidateNotification, object: nil) { note in
            SnapshotStore.invalidatedPrefixes(in: note, owner: "ROSA@example.com") == ["crm/subjects"]
                && SnapshotStore.invalidatedPrefixes(in: note, owner: "ada@example.com") == nil
        }
        SnapshotStore.invalidate(prefixes: ["crm/subjects"], owner: "rosa@example.com")
        wait(for: [posted], timeout: 1)
    }

    func testUpdatedLabel() {
        let now = Date()
        XCTAssertEqual(SnapshotStore.updatedLabel(now.addingTimeInterval(-10), now: now), "Updated just now")
        XCTAssertTrue(SnapshotStore.updatedLabel(now.addingTimeInterval(-300), now: now).hasPrefix("Updated "))
    }

    func testPurgeAllForgetsEverything() {
        SnapshotStore.save(Data("x".utf8), key: "k", owner: "rosa")
        SnapshotStore.purgeAll()
        XCTAssertNil(SnapshotStore.load(key: "k", owner: "rosa"))
    }

    func testFreshnessWindow() {
        let snapshot = SnapshotStore.Snapshot(data: Data(), savedAt: Date().addingTimeInterval(-120))
        XCTAssertTrue(snapshot.isFresh(ttl: 300))
        XCTAssertFalse(snapshot.isFresh(ttl: 60))
    }
}
