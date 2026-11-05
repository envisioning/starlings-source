import Foundation
import XCTest
@testable import Starlings

/// The shared request layer under `MeetingControlAPI` and `StarlingsAPI`
/// (meet#331). Shared by the Mac and iOS test targets, so a change to the
/// transport is tested on both clients.
final class StarlingsHTTPTransportTests: XCTestCase {
    private let base = URL(string: "https://meet.test/api")!

    private func transport(
        replying reply: SessionRenewalStub.Reply = .status(200, Data("{}".utf8)),
        renewal: StarlingsOwnerSessionRenewal? = nil,
        markStale: @escaping @Sendable (StarlingsStaleSnapshots) -> Void = { _ in }
    ) -> StarlingsHTTPTransport {
        StarlingsHTTPTransport(
            baseURL: base,
            session: SessionRenewalStub.makeSession(replying: reply),
            webOrigin: "https://meet.test",
            timeout: 15,
            // No pause, so a test that makes a second attempt does not wait for it.
            retry: StarlingsRequestPolicy.retry.withoutPause,
            ownerSessionRenewal: renewal,
            markStale: markStale
        )
    }

    private struct Probe: Codable, Equatable {
        let name: String
    }

    private struct SignedOut: StarlingsBearerSource {
        func meetBearerToken() -> String? { nil }
    }

    // MARK: Headers

    func testEveryRequestCarriesTheStandardHeaders() throws {
        let request = try transport().request(
            path: ["crm", "tasks"],
            query: [URLQueryItem(name: "project_id", value: "p 1")],
            method: "GET"
        )
        XCTAssertEqual(request.url?.absoluteString, "https://meet.test/api/crm/tasks?project_id=p%201")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.timeoutInterval, 15)
        XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
        for (field, value) in StarlingsHTTPTransport.standardHeaders {
            XCTAssertEqual(request.value(forHTTPHeaderField: field), value, field)
        }
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNotNil(request.value(forHTTPHeaderField: "x-meet-client"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Origin"), "Origin only on the routes that ask for it")
        XCTAssertNil(request.httpBody)
    }

    func testClientVersionHeaderUsesPlatformMarketingVersionAndBuild() {
        XCTAssertEqual(
            StarlingsClientVersion.format(platform: "macos", version: "4.7.2", build: "812"),
            "macos/4.7.2 (812)"
        )
        XCTAssertEqual(
            StarlingsClientVersion.format(platform: "ios", version: "4.7.2", build: "812"),
            "ios/4.7.2 (812)"
        )
    }

    func testOriginAndTimeoutAreSetPerCall() throws {
        let request = try transport().request(path: ["issue-images"], method: "PUT", origin: true, timeout: 120)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://meet.test")
        XCTAssertEqual(request.timeoutInterval, 120)
    }

    func testAJSONBodyIsEncodedAndARawBodyNamesItsType() throws {
        let json = try transport().request(path: ["probe"], method: "POST", body: Probe(name: "Ana"))
        XCTAssertEqual(try JSONDecoder().decode(Probe.self, from: XCTUnwrap(json.httpBody)), Probe(name: "Ana"))
        XCTAssertEqual(json.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let bytes = try transport().request(
            path: ["profile", "avatar"], method: "PUT", bytes: Data([1, 2, 3]), contentType: "image/jpeg"
        )
        XCTAssertEqual(bytes.httpBody, Data([1, 2, 3]))
        XCTAssertEqual(bytes.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
    }

    // MARK: Bearer token

    func testTheBearerTokenGoesInTheHeader() throws {
        let request = try transport().request(path: ["peers"], method: "GET", bearer: StarlingsBearerToken("token-1"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-1")
        XCTAssertFalse(request.url?.absoluteString.contains("token-1") ?? true, "Never in the URL")
    }

    func testNoBearerSourceSendsNoAuthorization() throws {
        let request = try transport().request(path: ["rooms", "rosa", "join-requests"], method: "POST", origin: true)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func testASourceWithNoTokenIsSignedOutAndSendsNothing() throws {
        XCTAssertThrowsError(try transport().request(path: ["peers"], method: "GET", bearer: SignedOut())) { error in
            guard case StarlingsHTTPFailure.signedOut = error else { return XCTFail("\(error)") }
            XCTAssertEqual(StarlingsError.http(StarlingsHTTPFailure.signedOut, operation: "").code, "auth.required")
        }
    }

    // MARK: Error mapping

    private func refusal(status: Int, body: String) async throws -> StarlingsHTTPFailure {
        let subject = transport(replying: .status(status, Data(body.utf8)))
        let request = try subject.request(path: ["probe"], method: "GET")
        do {
            _ = try await subject.send(request, as: Probe.self)
        } catch let failure as StarlingsHTTPFailure {
            return failure
        }
        XCTFail("HTTP \(status) did not fail")
        return .notHTTP
    }

    private func mapped(status: Int, body: String) async throws -> StarlingsError {
        StarlingsError.http(try await refusal(status: status, body: body), operation: "Couldn’t load that")
    }

    func testTheWorkersBodyIsReadIntoTheFailure() async throws {
        let failure = try await refusal(status: 409, body: #"{"error":"Already handled.","code":"request_already_decided"}"#)
        guard case let .status(status, code, message, _) = failure else { return XCTFail("\(failure)") }
        XCTAssertEqual(status, 409)
        XCTAssertEqual(code, "request_already_decided")
        XCTAssertEqual(message, "Already handled.")
    }

    func testA401WithOwnerAuthRequiredAsksToSignInAgain() async throws {
        let error = try await mapped(status: 401, body: #"{"error":"Not authenticated.","code":"owner_auth_required"}"#)
        XCTAssertEqual(error.code, "auth.session_expired")
        XCTAssertEqual(error.recovery, .signIn)
    }

    func testA403ReadsAsTheWorkersMessage() async throws {
        let error = try await mapped(status: 403, body: #"{"error":"Only the room owner can do that."}"#)
        XCTAssertEqual(error.code, "service.rejected")
        XCTAssertEqual(error.message, "Only the room owner can do that.")
        XCTAssertEqual(error.recovery, StarlingsError.Recovery.none)
    }

    func testA403WithOwnerAuthRequiredAlsoAsksToSignInAgain() async throws {
        let error = try await mapped(status: 403, body: #"{"error":"Not authenticated.","code":"owner_auth_required"}"#)
        XCTAssertEqual(error.code, "auth.session_expired")
    }

    func testA404ReadsAsTheWorkersMessage() async throws {
        let error = try await mapped(status: 404, body: #"{"error":"Not found."}"#)
        XCTAssertEqual(error.code, "service.rejected")
        XCTAssertEqual(error.message, "Not found.")
        XCTAssertEqual(error.diagnostic, "HTTP 404")
    }

    func testA409WithAKnownCodeUsesThatCode() async throws {
        let error = try await mapped(status: 409, body: #"{"error":"Already handled.","code":"request_already_decided"}"#)
        XCTAssertEqual(error.code, "lobby.already_decided")
        XCTAssertEqual(error.severity, .silent)
    }

    func testA429OffersARetry() async throws {
        let coded = try await mapped(status: 429, body: #"{"error":"Slow down.","code":"rate_limited"}"#)
        XCTAssertEqual(coded.code, "service.rate_limited")
        XCTAssertEqual(coded.recovery, .retry)

        let bare = try await mapped(status: 429, body: "")
        XCTAssertEqual(bare.code, "service.rate_limited")
        XCTAssertEqual(bare.recovery, .retry)

        // Google busy behind the Worker (meet#613): still a rate limit.
        let google = try await mapped(status: 429, body: #"{"error":"Google Calendar is busy. Try again in a moment.","code":"calendar_failed"}"#)
        XCTAssertEqual(google.code, "service.rate_limited")
        XCTAssertEqual(google.serverCode, "calendar_failed")
    }

    func testA5xxOffersARetry() async throws {
        for status in [500, 502, 503] {
            let error = try await mapped(status: status, body: #"{"error":"Upstream failed.","request_id":"r1"}"#)
            XCTAssertEqual(error.code, "service.unavailable", "\(status)")
            XCTAssertEqual(error.recovery, .retry, "\(status)")
        }
    }

    func testABodyWithoutErrorStillGivesItsCode() async throws {
        let failure = try await refusal(status: 401, body: #"{"code":"owner_auth_required"}"#)
        guard case let .status(_, code, message, _) = failure else { return XCTFail("\(failure)") }
        XCTAssertEqual(code, "owner_auth_required")
        XCTAssertNil(message)
    }

    func testNoAnswerIsATransportFailure() async throws {
        let subject = transport(replying: .failure(.notConnectedToInternet))
        let request = try subject.request(path: ["probe"], method: "GET")
        do {
            _ = try await subject.send(request, as: Probe.self)
            XCTFail("An offline request succeeded")
        } catch let failure as StarlingsHTTPFailure {
            guard case .transport = failure else { return XCTFail("\(failure)") }
            XCTAssertEqual(StarlingsError.http(failure, operation: "Couldn’t load that").code, "service.offline")
        }
    }

    // MARK: Decoding

    func testADecodingFailureNamesTheType() async throws {
        let subject = transport(replying: .status(200, Data(#"{"title":"no name"}"#.utf8)))
        let request = try subject.request(path: ["probe"], method: "GET")
        do {
            _ = try await subject.send(request, as: Probe.self)
            XCTFail("A body without `name` decoded")
        } catch let failure as StarlingsHTTPFailure {
            guard case .undecodable(let type) = failure else { return XCTFail("\(failure)") }
            XCTAssertEqual(type, "Probe")
            let error = StarlingsError.http(failure, operation: "Couldn’t load that")
            XCTAssertEqual(error.code, "service.invalid_response")
            XCTAssertTrue(error.diagnostic.contains("Probe"), error.diagnostic)
        }
    }

    func testA2xxBodyDecodes() async throws {
        let subject = transport(replying: .status(201, Data(#"{"name":"Ana"}"#.utf8)))
        let request = try subject.request(path: ["probe"], method: "POST", body: Probe(name: "Ana"))
        let answer = try await subject.send(request, as: Probe.self)
        XCTAssertEqual(answer, Probe(name: "Ana"))
    }

    // MARK: Invalidation

    private final class StaleRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var marked: [StarlingsStaleSnapshots] = []

        func record(_ stale: StarlingsStaleSnapshots) {
            lock.withLock { marked.append(stale) }
        }

        var calls: [StarlingsStaleSnapshots] {
            lock.withLock { marked }
        }
    }

    private let stale = StarlingsStaleSnapshots(owner: "test@example.com", prefixes: ["crm/mine", "crm/inbox"])

    func testAWriteMarksItsListsStaleAfterA2xx() async throws {
        let recorder = StaleRecorder()
        let subject = transport(replying: .status(200, Data(#"{"name":"Ana"}"#.utf8)), markStale: { recorder.record($0) })
        let request = try subject.request(path: ["crm", "tasks", "t1"], method: "PATCH", body: Probe(name: "Ana"))
        _ = try await subject.send(request, as: Probe.self, stale: stale)
        XCTAssertEqual(recorder.calls, [try XCTUnwrap(stale)])
    }

    func testARefusedWriteMarksNothing() async throws {
        for status in [400, 401, 404, 409, 429, 500] {
            let recorder = StaleRecorder()
            let subject = transport(replying: .status(status, Data(#"{"error":"No."}"#.utf8)), markStale: { recorder.record($0) })
            let request = try subject.request(path: ["crm", "tasks", "t1"], method: "PATCH", body: Probe(name: "Ana"))
            _ = try? await subject.send(request, as: Probe.self, stale: stale)
            XCTAssertTrue(recorder.calls.isEmpty, "HTTP \(status) marked a list stale")
        }
    }

    func testAWriteThatNeverArrivedMarksNothing() async throws {
        let recorder = StaleRecorder()
        let subject = transport(replying: .failure(.timedOut), markStale: { recorder.record($0) })
        let request = try subject.request(path: ["quick-notes"], method: "POST", body: Probe(name: "Ana"))
        _ = try? await subject.send(request, as: Probe.self, stale: stale)
        XCTAssertTrue(recorder.calls.isEmpty)
    }

    func testNoOwnerOrNoKeysIsNothingToMark() {
        XCTAssertNil(StarlingsStaleSnapshots(owner: nil, prefixes: ["crm/mine"]))
        XCTAssertNil(StarlingsStaleSnapshots(owner: "", prefixes: ["crm/mine"]))
        XCTAssertNil(StarlingsStaleSnapshots(owner: "test@example.com", prefixes: []))
    }

    // MARK: Retry (meet#597)

    private func attempts(
        _ method: String,
        replies: [SessionRenewalStub.Reply],
        then fallback: SessionRenewalStub.Reply = .status(200, Data(#"{"name":"Ana"}"#.utf8))
    ) async throws -> (outcome: Result<Probe, Error>, requests: Int) {
        let subject = transport(replying: fallback)
        SessionRenewalStub.replyInOrder(replies)
        let request = (method == "GET" || method == "HEAD")
            ? try subject.request(path: ["probe"], method: method)
            : try subject.request(path: ["probe"], method: method, body: Probe(name: "Ana"))
        let outcome: Result<Probe, Error>
        do {
            outcome = .success(try await subject.send(request, as: Probe.self))
        } catch {
            outcome = .failure(error)
        }
        return (outcome, SessionRenewalStub.requests)
    }

    func testAnIdempotentRequestIsSentOnceMoreAfterAServerError() async throws {
        for method in StarlingsRequestPolicy.retry.methods {
            let result = try await attempts(method, replies: [.status(503, Data("{}".utf8))])
            XCTAssertEqual(result.requests, 2, "\(method) was not retried after a 503")
            XCTAssertEqual(try result.outcome.get(), Probe(name: "Ana"), method)
        }
    }

    func testEveryStatusTheRuleNamesIsRetriedAndNoOtherIs() async throws {
        for status in [408, 429, 500, 502, 503, 504] {
            let result = try await attempts("GET", replies: [.status(status, Data("{}".utf8))])
            XCTAssertEqual(result.requests, 2, "HTTP \(status) was not retried")
        }
        for status in [400, 401, 403, 404, 409] {
            let result = try await attempts("GET", replies: [], then: .status(status, Data(#"{"error":"No."}"#.utf8)))
            XCTAssertEqual(result.requests, 1, "HTTP \(status) was retried")
        }
    }

    func testAnIdempotentRequestIsSentOnceMoreAfterANetworkFailure() async throws {
        for code in [URLError.Code.timedOut, .notConnectedToInternet, .networkConnectionLost] {
            let result = try await attempts("PATCH", replies: [.failure(code)])
            XCTAssertEqual(result.requests, 2, "\(code.rawValue)")
            XCTAssertEqual(try result.outcome.get(), Probe(name: "Ana"))
        }
    }

    func testARequestThatCreatesOrDeletesIsNeverSentTwice() async throws {
        for method in ["POST", "DELETE"] {
            let server = try await attempts(method, replies: [], then: .status(503, Data("{}".utf8)))
            XCTAssertEqual(server.requests, 1, "\(method) was retried after a 503")
            let network = try await attempts(method, replies: [], then: .failure(.timedOut))
            XCTAssertEqual(network.requests, 1, "\(method) was retried after a timeout")
        }
    }

    func testARetryHappensOnceAndTheSecondFailureIsTheOneReported() async throws {
        let result = try await attempts("GET", replies: [], then: .status(503, Data(#"{"error":"Down."}"#.utf8)))
        XCTAssertEqual(result.requests, 2)
        guard case .failure(let error) = result.outcome, case StarlingsHTTPFailure.status(503, _, _, _) = error else {
            return XCTFail("\(result.outcome)")
        }
    }

    func testACancelledRequestIsNotRetried() async throws {
        let result = try await attempts("GET", replies: [], then: .failure(.cancelled))
        XCTAssertEqual(result.requests, 1)
    }

    func testTheDefaultsAreThePolicyTable() throws {
        let subject = StarlingsHTTPTransport(baseURL: base, session: SessionRenewalStub.makeSession(replying: .status(200, Data("{}".utf8))), webOrigin: "https://meet.test")
        XCTAssertEqual(subject.timeout, StarlingsRequestPolicy.timeoutSeconds)
        XCTAssertEqual(subject.retry, StarlingsRequestPolicy.retry)
        let request = try subject.request(path: ["probe"], method: "GET")
        XCTAssertEqual(request.timeoutInterval, StarlingsRequestPolicy.timeoutSeconds)
    }

    // MARK: Writes name their lists

    func testAWriteIsMarkedWithTheListsThePolicyNamesForIt() async throws {
        let recorder = StaleRecorder()
        let subject = transport(replying: .status(200, Data(#"{"name":"Ana"}"#.utf8)), markStale: { recorder.record($0) })
        let request = try subject.request(path: ["crm", "tasks", "t1"], method: "PATCH", body: Probe(name: "Ana"))
        let named = StarlingsStaleSnapshots(owner: "test@example.com", write: .taskUpdate)
        _ = try await subject.send(request, as: Probe.self, stale: named)
        XCTAssertEqual(recorder.calls.first?.prefixes, StarlingsRequestPolicy.invalidated(by: .taskUpdate))
        XCTAssertNil(StarlingsStaleSnapshots(owner: "test@example.com", write: nil))
    }

    // MARK: Owner-session replay (meet#649)

    /// What the replay asked of a client's renewal.
    private final class RenewalRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var renewedFrom: [String] = []
        private var rejections = 0

        func renewal(answering fresh: String?) -> StarlingsOwnerSessionRenewal {
            StarlingsOwnerSessionRenewal(
                renew: { refused in
                    self.lock.withLock { self.renewedFrom.append(refused) }
                    return fresh
                },
                rejected: { self.lock.withLock { self.rejections += 1 } }
            )
        }

        var renewals: [String] { lock.withLock { renewedFrom } }
        var rejected: Int { lock.withLock { rejections } }
    }

    private let ownerRefusal = SessionRenewalStub.Reply.status(
        401, Data(#"{"error":"Not authenticated.","code":"owner_auth_required"}"#.utf8)
    )

    func testARefusedOwnerSessionIsRenewedOnceAndSentAgainWithTheFreshToken() async throws {
        let recorder = RenewalRecorder()
        let subject = transport(replying: .status(200, Data(#"{"name":"Ana"}"#.utf8)), renewal: recorder.renewal(answering: "token-new"))
        SessionRenewalStub.replyInOrder([ownerRefusal])
        let request = try subject.request(path: ["peers"], method: "POST", bearer: StarlingsBearerToken("token-old", isOwnerSession: true))
        let answer = try await subject.ownerData(for: request)
        XCTAssertEqual(answer.http.statusCode, 200)
        XCTAssertEqual(SessionRenewalStub.requests, 2)
        XCTAssertEqual(SessionRenewalStub.lastRequestSnapshot?.value(forHTTPHeaderField: "Authorization"), "Bearer token-new")
        XCTAssertEqual(recorder.renewals, ["token-old"])
        XCTAssertEqual(recorder.rejected, 0)
    }

    func testA403WithOwnerAuthRequiredIsRenewedToo() async throws {
        let recorder = RenewalRecorder()
        let subject = transport(replying: .status(200, Data("{}".utf8)), renewal: recorder.renewal(answering: "token-new"))
        SessionRenewalStub.replyInOrder([.status(403, Data(#"{"error":"No.","code":"owner_auth_required"}"#.utf8))])
        let request = try subject.request(path: ["peers"], method: "GET", bearer: StarlingsBearerToken("token-old", isOwnerSession: true))
        _ = try await subject.ownerData(for: request)
        XCTAssertEqual(recorder.renewals, ["token-old"])
    }

    func testARenewalWithNoTokenReportsTheRefusalAndSendsNothingMore() async throws {
        let recorder = RenewalRecorder()
        let subject = transport(replying: ownerRefusal, renewal: recorder.renewal(answering: nil))
        let request = try subject.request(path: ["peers"], method: "GET", bearer: StarlingsBearerToken("token-old", isOwnerSession: true))
        let answer = try await subject.ownerData(for: request)
        XCTAssertEqual(answer.http.statusCode, 401)
        XCTAssertEqual(SessionRenewalStub.requests, 1)
        XCTAssertEqual(recorder.rejected, 1)
    }

    func testTheSameTokenBackIsNoReasonToSendAgain() async throws {
        let recorder = RenewalRecorder()
        let subject = transport(replying: ownerRefusal, renewal: recorder.renewal(answering: "token-old"))
        let request = try subject.request(path: ["peers"], method: "GET", bearer: StarlingsBearerToken("token-old", isOwnerSession: true))
        _ = try await subject.ownerData(for: request)
        XCTAssertEqual(SessionRenewalStub.requests, 1)
        XCTAssertEqual(recorder.rejected, 1)
    }

    func testASecondRefusalIsReportedAndNotRenewedAgain() async throws {
        let recorder = RenewalRecorder()
        let subject = transport(replying: ownerRefusal, renewal: recorder.renewal(answering: "token-new"))
        let request = try subject.request(path: ["peers"], method: "GET", bearer: StarlingsBearerToken("token-old", isOwnerSession: true))
        let answer = try await subject.ownerData(for: request)
        XCTAssertEqual(answer.http.statusCode, 401)
        XCTAssertEqual(SessionRenewalStub.requests, 2)
        XCTAssertEqual(recorder.renewals, ["token-old"])
        XCTAssertEqual(recorder.rejected, 1)
        XCTAssertTrue(StarlingsError.http(.status(401, code: "owner_auth_required", message: nil, requestID: nil), operation: "").isOwnerSessionRejection)
    }

    func testOnlyOwnerAuthRequiredOnABearerRequestIsReplayed() async throws {
        let recorder = RenewalRecorder()
        // Google's refusal is not the owner session's.
        let google = transport(replying: .status(401, Data(#"{"error":"Reconnect.","code":"calendar_expired"}"#.utf8)), renewal: recorder.renewal(answering: "token-new"))
        let owned = try google.request(path: ["calendar", "events"], method: "GET", bearer: StarlingsBearerToken("token-old", isOwnerSession: true))
        _ = try await google.ownerData(for: owned)
        // A request with no bearer never gets an owner token put on it.
        let anonymous = transport(replying: ownerRefusal, renewal: recorder.renewal(answering: "token-new"))
        let knock = try anonymous.request(path: ["rooms", "mz", "join-requests"], method: "POST", origin: true)
        _ = try await anonymous.ownerData(for: knock)
        XCTAssertEqual(SessionRenewalStub.requests, 1)
        XCTAssertEqual(recorder.renewals, [])
        XCTAssertEqual(recorder.rejected, 0)
    }

    func testTheRefusedSessionStatusIsKeptForSignOut() {
        let refused = StarlingsError.refusal(status: 403, serverCode: nil, serverMessage: nil, requestID: nil, operation: "Couldn’t renew")
        XCTAssertTrue(refused.isSessionRefusal)
        XCTAssertEqual(refused.message, "Couldn’t renew (403).")
        XCTAssertEqual(refused.localizedDescription, "Couldn’t renew (403).")
        XCTAssertFalse(StarlingsError.local("Offline.").isSessionRefusal)
    }
}
