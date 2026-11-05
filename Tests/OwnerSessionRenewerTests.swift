import Foundation
import XCTest
@testable import Starlings

/// The rule in AGENTS.md: only a 401 or 403 from `/api/auth/refresh` signs the
/// Mac out. A 5xx, a timeout, no network or a Keychain read error keeps the
/// session, and the next renewal tries again (meet#332).
final class OwnerSessionRenewerTests: XCTestCase {
    private final class FakeKeychain: OwnerSessionKeychain, @unchecked Sendable {
        private let lock = NSLock()
        private var stored: OwnerSessionCredentials?
        private var readFails = false
        private var expiredCount = 0

        init(_ credentials: OwnerSessionCredentials?) {
            stored = credentials
        }

        var credentials: OwnerSessionCredentials? { lock.withLock { stored } }
        var didExpire: Bool { lock.withLock { expiredCount > 0 } }
        func failReads(_ fails: Bool) { lock.withLock { readFails = fails } }

        func load() throws -> OwnerSessionCredentials? {
            try lock.withLock {
                if readFails { throw CocoaError(.fileReadNoPermission) }
                return stored
            }
        }

        func save(_ credentials: OwnerSessionCredentials) throws {
            lock.withLock { stored = credentials }
        }

        func expire() throws {
            lock.withLock {
                stored = nil
                expiredCount += 1
            }
        }

        func deviceID() -> String { "device-test" }
    }

    private let signedIn = OwnerSessionCredentials(
        accessToken: "access-old",
        refreshToken: "refresh-old",
        owner: OwnerProfile(sub: "sub-test", email: "test@example.com", name: "Test Owner", picture: nil)
    )

    private func renewer(_ keychain: FakeKeychain, replying reply: SessionRenewalStub.Reply) -> OwnerSessionRenewer {
        OwnerSessionRenewer(
            store: keychain,
            session: SessionRenewalStub.makeSession(replying: reply),
            apiBaseURL: URL(string: "https://meet.test/api")!
        )
    }

    func testRefusalWith401SignsOut() async {
        let keychain = FakeKeychain(signedIn)
        let outcome = await renewer(keychain, replying: .status(401, Data())).sessionRejected()
        XCTAssertEqual(outcome, .refused)
        XCTAssertTrue(keychain.didExpire)
        XCTAssertNil(keychain.credentials)
    }

    func testRefusalWith403SignsOut() async {
        let keychain = FakeKeychain(signedIn)
        let outcome = await renewer(keychain, replying: .status(403, Data())).sessionRejected()
        XCTAssertEqual(outcome, .refused)
        XCTAssertTrue(keychain.didExpire)
    }

    func testServerErrorKeepsSessionAndRetries() async {
        let keychain = FakeKeychain(signedIn)
        let subject = renewer(keychain, replying: .status(503, Data()))
        let first = await subject.sessionRejected()
        XCTAssertEqual(first, .unavailable)
        XCTAssertFalse(keychain.didExpire)
        XCTAssertEqual(keychain.credentials, signedIn)

        SessionRenewalStub.reply(.status(200, SessionRenewalStub.renewedBody(
            accessToken: "access-new", refreshToken: "refresh-new"
        )))
        let second = await subject.renewIfNeeded(force: true)
        XCTAssertEqual(second, .renewed)
        XCTAssertEqual(keychain.credentials?.accessToken, "access-new")
        XCTAssertEqual(keychain.credentials?.refreshToken, "refresh-new")
    }

    func testTimeoutKeepsSession() async {
        let keychain = FakeKeychain(signedIn)
        let outcome = await renewer(keychain, replying: .failure(.timedOut)).sessionRejected()
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertFalse(keychain.didExpire)
        XCTAssertEqual(keychain.credentials, signedIn)
    }

    func testNoNetworkKeepsSession() async {
        let keychain = FakeKeychain(signedIn)
        let outcome = await renewer(keychain, replying: .failure(.notConnectedToInternet)).sessionRejected()
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertFalse(keychain.didExpire)
        XCTAssertEqual(keychain.credentials, signedIn)
    }

    func testKeychainReadErrorKeepsSessionAndRetries() async {
        let keychain = FakeKeychain(signedIn)
        keychain.failReads(true)
        let subject = renewer(keychain, replying: .status(200, SessionRenewalStub.renewedBody(
            accessToken: "access-new", refreshToken: "refresh-new"
        )))
        let first = await subject.sessionRejected()
        XCTAssertEqual(first, .unavailable)
        XCTAssertFalse(keychain.didExpire)
        XCTAssertEqual(SessionRenewalStub.requests, 0, "No refresh token was read, so none was spent")

        keychain.failReads(false)
        let second = await subject.renewIfNeeded(force: true)
        XCTAssertEqual(second, .renewed)
        XCTAssertEqual(keychain.credentials?.accessToken, "access-new")
    }
}
