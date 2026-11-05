import Foundation
import XCTest
@testable import Starlings

/// The rule in AGENTS.md: only a 401 or 403 from `/api/auth/refresh` signs the
/// phone out. A 5xx, a timeout, no network or a Keychain read error keeps the
/// session, and the next renewal tries again (meet#332).
@MainActor
final class SessionRenewalTests: XCTestCase {
    private final class FakeKeychain: MobileOwnerSessionKeychain {
        var stored: MobileOwnerCredentials?
        var readFails = false
        var cleared = false

        init(_ credentials: MobileOwnerCredentials?) {
            stored = credentials
        }

        func load() throws -> MobileOwnerCredentials? {
            if readFails { throw CocoaError(.fileReadNoPermission) }
            return stored
        }

        func save(_ credentials: MobileOwnerCredentials) throws {
            stored = credentials
        }

        func clear() throws {
            stored = nil
            cleared = true
        }

        func deviceID() -> String { "device-test" }
    }

    private let signedIn = MobileOwnerCredentials(
        accessToken: "access-old",
        refreshToken: "refresh-old",
        owner: MobileOwnerProfile(sub: "sub-test", email: "test@example.com", name: "Test Owner", picture: nil)
    )

    private func model(_ keychain: FakeKeychain, replying reply: SessionRenewalStub.Reply) -> StarlingsAppModel {
        StarlingsAppModel(sessionStore: keychain, urlSession: SessionRenewalStub.makeSession(replying: reply))
    }

    func testRefusalWith401SignsOut() async {
        let keychain = FakeKeychain(signedIn)
        let app = model(keychain, replying: .status(401, Data()))
        let outcome = await app.renewSessionIfNeeded(force: true)
        XCTAssertEqual(outcome, .refused)
        XCTAssertNil(app.ownerCredentials)
        XCTAssertTrue(keychain.cleared)
    }

    func testRefusalWith403SignsOut() async {
        let keychain = FakeKeychain(signedIn)
        let app = model(keychain, replying: .status(403, Data()))
        let outcome = await app.renewSessionIfNeeded(force: true)
        XCTAssertEqual(outcome, .refused)
        XCTAssertNil(app.ownerCredentials)
        XCTAssertTrue(keychain.cleared)
    }

    func testServerErrorKeepsSessionAndRetries() async {
        let keychain = FakeKeychain(signedIn)
        let app = model(keychain, replying: .status(500, Data()))
        let first = await app.renewSessionIfNeeded(force: true)
        XCTAssertEqual(first, .unavailable)
        XCTAssertEqual(app.ownerCredentials, signedIn)
        XCTAssertFalse(keychain.cleared)

        SessionRenewalStub.reply(.status(200, SessionRenewalStub.renewedBody(
            accessToken: "access-new", refreshToken: "refresh-new"
        )))
        let second = await app.renewSessionIfNeeded(force: true)
        XCTAssertEqual(second, .renewed)
        XCTAssertEqual(app.ownerCredentials?.accessToken, "access-new")
        XCTAssertEqual(app.ownerCredentials?.refreshToken, "refresh-new")
    }

    func testTimeoutKeepsSession() async {
        let keychain = FakeKeychain(signedIn)
        let app = model(keychain, replying: .failure(.timedOut))
        let outcome = await app.renewSessionIfNeeded(force: true)
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertEqual(app.ownerCredentials, signedIn)
        XCTAssertFalse(keychain.cleared)
    }

    func testNoNetworkKeepsSession() async {
        let keychain = FakeKeychain(signedIn)
        let app = model(keychain, replying: .failure(.notConnectedToInternet))
        let outcome = await app.renewSessionIfNeeded(force: true)
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertEqual(app.ownerCredentials, signedIn)
        XCTAssertFalse(keychain.cleared)
    }

    func testKeychainReadErrorKeepsSessionAndRetries() async {
        let keychain = FakeKeychain(signedIn)
        let app = model(keychain, replying: .status(200, SessionRenewalStub.renewedBody(
            accessToken: "access-new", refreshToken: "refresh-new"
        )))
        // Read once at launch; the read after the renewal's save fails.
        keychain.readFails = true
        let first = await app.renewSessionIfNeeded(force: true)
        XCTAssertEqual(first, .unavailable)
        XCTAssertNotNil(app.ownerCredentials)
        XCTAssertFalse(keychain.cleared)

        keychain.readFails = false
        let second = await app.renewSessionIfNeeded(force: true)
        XCTAssertEqual(second, .renewed)
        XCTAssertEqual(app.ownerCredentials?.accessToken, "access-new")
    }
}
