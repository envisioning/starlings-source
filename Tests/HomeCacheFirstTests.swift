import Foundation
import XCTest
@testable import Starlings

/// docs/CACHING.md, meet#691: the first frame of every Home module comes from
/// disk, read before any request starts, and a refresh that fails leaves it
/// on screen. Pinned at the watch level: a watch hands its snapshot to Home
/// inside `start()`, before its poll — and so its first request — can run.
@MainActor
final class HomeCacheFirstTests: XCTestCase {
    private final class SignedIn: OwnerSessionKeychain, @unchecked Sendable {
        func load() throws -> OwnerSessionCredentials? {
            OwnerSessionCredentials(
                accessToken: "access",
                refreshToken: "refresh",
                owner: OwnerProfile(sub: "sub-cache", email: HomeCacheFirstTests.owner, name: "Cache First", picture: nil)
            )
        }

        func save(_ credentials: OwnerSessionCredentials) throws {}
        func expire() throws {}
        func deviceID() -> String { "device-test" }
    }

    nonisolated static let owner = "cache-first@example.com"

    private let summary = CommercialSummary(
        lookbackMonths: 12,
        offers: 4,
        salesAmount: 1_200,
        pipelineAmount: 800,
        newLicenses: 2,
        currencyCode: "EUR",
        points: []
    )

    override func setUp() async throws {
        try await super.setUp()
        SnapshotStore.purgeAll()
    }

    override func tearDown() async throws {
        SnapshotStore.purgeAll()
        try await super.tearDown()
    }

    /// Snapshots read as `owner`; requests go to a network that is not there.
    private func offlineAPI() -> MeetingControlAPI {
        MeetingControlAPI(
            apiBaseURL: URL(string: "https://meet.test/api")!,
            session: SessionRenewalStub.makeSession(replying: .failure(.notConnectedToInternet)),
            ownerSessionStore: OwnerSessionStore(keychainService: "\(ContractConstants.nativeAppBundleID).owner-session.tests.\(UUID().uuidString)"),
            webOrigin: "https://meet.test",
            snapshotOwner: { HomeCacheFirstTests.owner }
        )
    }

    private func save<T: Encodable>(_ value: T, key: String) throws {
        SnapshotStore.save(try JSONEncoder().encode(value), key: key, owner: Self.owner)
    }

    func testCommercialPaintsItsSnapshotBeforeItsFirstRequest() async throws {
        try save(summary, key: MeetingControlAPI.commercialSnapshotKey)
        let watch = CommercialWatch(api: offlineAPI(), ownerSessionStore: SignedIn())
        var painted: [CommercialSummary?] = []
        watch.observe { painted.append($0) }

        watch.start()
        // Inside `start()`: the disk copy, and the poll has not run.
        XCTAssertEqual(painted, [summary])
        XCTAssertEqual(SessionRenewalStub.requests, 0)
        watch.stop()

        // Offline, the read fails; what was painted stays, and is not
        // replaced by "nothing".
        await watch.tick()
        XCTAssertEqual(painted, [summary])
        XCTAssertEqual(watch.summary, summary)
    }

    func testStarredPaintsItsSnapshotBeforeItsFirstRequest() async throws {
        SnapshotStore.save(Data(#"{"rows":[]}"#.utf8), key: MeetingControlAPI.starredSnapshotKey, owner: Self.owner)
        let watch = StarredWatch(api: offlineAPI(), ownerSessionStore: SignedIn())
        var painted: [[SearchRow]] = []
        watch.observe { painted.append($0) }

        watch.start()
        // An empty starred list is an answer: QUICK ACCESS does not wait.
        XCTAssertEqual(painted.count, 1)
        XCTAssertEqual(SessionRenewalStub.requests, 0)
        watch.stop()
    }

    func testWithoutASnapshotNothingIsPaintedBeforeTheRead() {
        // No file: Home keeps its placeholders rather than drawing "nothing".
        let watch = CommercialWatch(api: offlineAPI(), ownerSessionStore: SignedIn())
        var painted: [CommercialSummary?] = []
        watch.observe { painted.append($0) }
        watch.start()
        XCTAssertTrue(painted.isEmpty)
        watch.stop()
    }
}
