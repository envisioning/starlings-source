import Foundation
import XCTest
@testable import Starlings

/// docs/CACHING.md, meet#691: the first frame of every Home module comes from
/// disk, read before any request starts, and a refresh that fails leaves it
/// on screen. Pinned at the store level: each store must hold its snapshot
/// the moment it is attached, while the stubbed network has seen nothing.
@MainActor
final class HomeCacheFirstTests: XCTestCase {
    private final class FakeKeychain: MobileOwnerSessionKeychain {
        var stored: MobileOwnerCredentials?

        init(_ credentials: MobileOwnerCredentials?) {
            stored = credentials
        }

        func load() throws -> MobileOwnerCredentials? { stored }
        func save(_ credentials: MobileOwnerCredentials) throws { stored = credentials }
        func clear() throws { stored = nil }
        func deviceID() -> String { "device-test" }
    }

    private let signedIn = MobileOwnerCredentials(
        accessToken: "access",
        refreshToken: "refresh",
        owner: MobileOwnerProfile(sub: "sub-cache", email: "cache-first@example.com", name: "Cache First", picture: nil)
    )

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

    /// The `stop` of every store a test attaches. `attach` queues the Task
    /// that starts the poll, so a `stop()` inside a test can run before that
    /// Task and the poll then starts after it. tearDown lets the queued Task
    /// run and stops each store again, so no poll outlives its test.
    private var stops: [@MainActor () -> Void] = []

    override func tearDown() async throws {
        await Task.yield()
        stops.forEach { $0() }
        stops = []
        SnapshotStore.purgeAll()
        try await super.tearDown()
    }

    private func save(_ data: Data, key: String) {
        SnapshotStore.save(data, key: key, owner: signedIn.owner.email)
    }

    private func save<T: Encodable>(_ value: T, key: String) throws {
        save(try JSONEncoder().encode(value), key: key)
    }

    /// No network at all: every request fails as a phone in a lift would.
    private func offlineApp() -> StarlingsAppModel {
        StarlingsAppModel(
            sessionStore: FakeKeychain(signedIn),
            urlSession: SessionRenewalStub.makeSession(replying: .failure(.notConnectedToInternet))
        )
    }

    func testEveryHomeStorePaintsItsSnapshotBeforeAnyRequest() throws {
        try save(summary, key: StarlingsAPI.commercialSnapshotKey)
        try save(QuickNotesResponse(notes: []), key: StarlingsAPI.quickNotesSnapshotKey)
        save(Data(#"{"threads":[]}"#.utf8), key: StarlingsAPI.threadsSnapshotKey)

        let app = offlineApp()

        let commercial = MobileCommercialStore()
        stops.append(commercial.stop)
        commercial.attach(to: app)
        XCTAssertEqual(commercial.summary, summary)
        XCTAssertTrue(commercial.homeReady, "COMMERCIAL waited for a read")

        let notes = MobileQuickNotesStore()
        stops.append(notes.stop)
        notes.attach(to: app)
        XCTAssertTrue(notes.homeReady, "QUICK NOTES waited for a read")

        let team = MobileTeamStore()
        stops.append(team.stop)
        team.attach(to: app)
        XCTAssertTrue(team.homeMessagesReady, "MESSAGES waited for a read")

        // All of it synchronously, inside `attach`: nothing has gone out yet.
        XCTAssertEqual(SessionRenewalStub.requests, 0)
        commercial.stop()
        notes.stop()
        team.stop()
    }

    func testAFailedRefreshKeepsThePaintedSummary() async throws {
        try save(summary, key: StarlingsAPI.commercialSnapshotKey)
        let app = offlineApp()
        let commercial = MobileCommercialStore()
        stops.append(commercial.stop)
        commercial.attach(to: app)
        commercial.stop()

        await commercial.refresh()
        // It did ask, after painting, and the failure left the answer drawn.
        XCTAssertGreaterThan(SessionRenewalStub.requests, 0)
        XCTAssertEqual(commercial.summary, summary)
        XCTAssertTrue(commercial.homeReady)
    }
}
