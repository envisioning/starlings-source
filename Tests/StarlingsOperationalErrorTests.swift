import Foundation
import StarlingsContracts
import XCTest
@testable import Starlings

final class StarlingsOperationalErrorTests: XCTestCase {
    func testNativeCaptureUsesOnlyFixedFieldsAndUUIDRequestIDs() throws {
        let request = try transport().request(
            path: ["crm", "subjects", "person@example.net", "private-name-42"],
            method: "GET",
            bearer: OwnerBearer()
        )
        let data = Data(#"{"error":"private server prose","code":"internal_error","request_id":"0f9a2f3e-6a2f-4d1a-9c39-2f0a1b6c7d8e"}"#.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 500,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!

        let event = try XCTUnwrap(StarlingsOperationalErrorFactory.responseFailure(
            request: request,
            response: response,
            data: data,
            retryCount: 3
        ))
        let encoded = String(decoding: try JSONEncoder().encode(event), as: UTF8.self)

        XCTAssertEqual(event.operation, .work)
        XCTAssertEqual(event.code, .internalError)
        XCTAssertEqual(event.requestID, "0f9a2f3e-6a2f-4d1a-9c39-2f0a1b6c7d8e")
        XCTAssertEqual(event.retryCount, 3)
        XCTAssertFalse(encoded.contains("person@example.net"))
        XCTAssertFalse(encoded.contains("private-name-42"))
        XCTAssertFalse(encoded.contains("private server prose"))
        XCTAssertFalse(encoded.contains("owner-test-token"))
    }

    func testExpectedHTTPRefusalsAndUncorrelatedRequestIDsAreNotCaptured() throws {
        let request = try transport().request(path: ["crm", "tasks"], method: "GET", bearer: OwnerBearer())
        let expectedRefusal = HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!
        let privateMessage = Data(#"{"error":"not found","code":"resource_missing","request_id":"not-a-uuid"}"#.utf8)

        XCTAssertNil(StarlingsOperationalErrorFactory.responseFailure(
            request: request,
            response: expectedRefusal,
            data: privateMessage,
            retryCount: 0
        ))
        XCTAssertEqual(StarlingsHTTPTransport.requestID(in: expectedRefusal, data: privateMessage), nil)
        XCTAssertNil(StarlingsOperationalErrorFactory.appBoundary(code: "media.mic_denied"))
        XCTAssertNil(StarlingsOperationalErrorFactory.appBoundary(code: "service.cancelled"))
    }

    func testSpoolDeduplicatesPersistsPrunesAndStaysBounded() async throws {
        let fileURL = temporaryFileURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let spool = StarlingsOperationalErrorSpool(fileURL: fileURL)
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let first = event(id: 1, status: 500)
        await spool.enqueue(first, at: start)
        await spool.enqueue(event(id: 2, status: 500), at: start.addingTimeInterval(1))

        let deduplicated = await spool.pendingEvents(at: start.addingTimeInterval(2))
        XCTAssertEqual(deduplicated.count, 1)
        XCTAssertEqual(deduplicated[0].retryCount, 1)

        let persisted = try String(contentsOf: fileURL, encoding: .utf8)
        XCTAssertTrue(persisted.contains("service.unavailable"))
        XCTAssertFalse(persisted.contains("private diagnostic"))
        let permissions = try FileManager.default.attributesOfItem(atPath: fileURL.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)

        let reopened = StarlingsOperationalErrorSpool(fileURL: fileURL)
        let reopenedEvents = await reopened.pendingEvents(at: start.addingTimeInterval(3))
        XCTAssertEqual(reopenedEvents.count, 1)

        for index in 0..<65 {
            await spool.enqueue(event(id: index + 10, status: 500 + index), at: start.addingTimeInterval(40 + Double(index)))
        }
        let boundedEvents = await spool.pendingEvents(at: start.addingTimeInterval(200))
        XCTAssertEqual(boundedEvents.count, StarlingsOperationalErrorSpool.capacity)
        let expiredEvents = await spool.pendingEvents(at: start.addingTimeInterval(StarlingsOperationalErrorSpool.retention + 200))
        XCTAssertTrue(expiredEvents.isEmpty)
    }

    func testFailedUploadStaysQueuedAndNextOwnerSessionDrainsItOnce() async throws {
        let fileURL = temporaryFileURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let spool = StarlingsOperationalErrorSpool(fileURL: fileURL)
        await spool.enqueue(event(id: 1, status: 503))
        let session = SessionRenewalStub.makeSession(replying: .status(503, Data("{}".utf8)))
        let transport = StarlingsHTTPTransport(
            baseURL: URL(string: "https://meet.test/api")!,
            session: session,
            webOrigin: "https://meet.test",
            timeout: 3
        )

        await spool.flush(using: transport, ownerToken: "owner-test-token")
        let retained = await spool.pendingEvents()
        XCTAssertEqual(retained.count, 1)
        XCTAssertEqual(SessionRenewalStub.requests, 1)
        XCTAssertEqual(SessionRenewalStub.lastRequestSnapshot?.url?.path, "/api/operational-errors")
        XCTAssertEqual(SessionRenewalStub.lastRequestSnapshot?.httpMethod, "POST")
        XCTAssertEqual(SessionRenewalStub.lastRequestSnapshot?.value(forHTTPHeaderField: "Authorization"), "Bearer owner-test-token")
        let failedUpload = try XCTUnwrap(SessionRenewalStub.lastRequestBodySnapshot)
        XCTAssertFalse(String(decoding: failedUpload, as: UTF8.self).contains("owner-test-token"))

        // A failed upload backs off: the next request's flush does not resend it.
        SessionRenewalStub.reply(.status(200, Data(#"{"accepted":1}"#.utf8)))
        await spool.flush(using: transport, ownerToken: "owner-test-token")
        XCTAssertEqual(SessionRenewalStub.requests, 1)

        await spool.flush(using: transport, ownerToken: "owner-test-token", now: Date().addingTimeInterval(60))
        let drained = await spool.pendingEvents()
        XCTAssertTrue(drained.isEmpty)
        XCTAssertEqual(SessionRenewalStub.requests, 2)
    }

    func testRefusedCapabilityStopsFlushingForTheSession() async throws {
        let fileURL = temporaryFileURL()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let spool = StarlingsOperationalErrorSpool(fileURL: fileURL)
        await spool.enqueue(event(id: 1, status: 503))
        let session = SessionRenewalStub.makeSession(replying: .status(403, Data("{}".utf8)))
        let transport = StarlingsHTTPTransport(
            baseURL: URL(string: "https://meet.test/api")!,
            session: session,
            webOrigin: "https://meet.test",
            timeout: 3
        )

        await spool.flush(using: transport, ownerToken: "owner-test-token")
        await spool.flush(using: transport, ownerToken: "owner-test-token", now: Date().addingTimeInterval(7_200))
        XCTAssertEqual(SessionRenewalStub.requests, 1)
        let retained = await spool.pendingEvents()
        XCTAssertEqual(retained.count, 1)
    }

    func testOnlyExplicitOwnerCredentialsMarkRequestsForSpoolDelivery() throws {
        let transport = transport()
        let ownerRequest = try transport.request(path: ["crm", "mine"], method: "GET", bearer: OwnerBearer())
        let lobbyRequest = try transport.request(path: ["rooms", "rosa", "join-requests"], method: "GET", bearer: StarlingsBearerToken("lobby-token"))
        let artifactRequest = try transport.request(path: ["meetings", "m-1", "transcripts"], method: "GET", bearer: StarlingsBearerToken("artifact-token"))

        XCTAssertTrue(StarlingsHTTPTransport.isOwnerSessionRequest(ownerRequest))
        XCTAssertFalse(StarlingsHTTPTransport.isOwnerSessionRequest(lobbyRequest))
        XCTAssertFalse(StarlingsHTTPTransport.isOwnerSessionRequest(artifactRequest))
        XCTAssertNil(ownerRequest.value(forHTTPHeaderField: "x-meet-owner-session"))
    }

    func testOwnerMarkerSurvivesURLSessionAsLocalRequestMetadata() async throws {
        let session = SessionRenewalStub.makeSession(replying: .status(500, Data("{}".utf8)))
        let transport = StarlingsHTTPTransport(
            baseURL: URL(string: "https://meet.test/api")!,
            session: session,
            webOrigin: "https://meet.test",
            timeout: 3,
            retry: StarlingsRequestPolicy.retry.withoutPause
        )
        let request = try transport.request(path: ["crm", "mine"], method: "GET", bearer: OwnerBearer())

        _ = try await transport.data(for: request)

        let observed = try XCTUnwrap(SessionRenewalStub.lastRequestSnapshot)
        XCTAssertTrue(StarlingsHTTPTransport.isOwnerSessionRequest(observed))
        XCTAssertNil(observed.value(forHTTPHeaderField: "x-meet-owner-session"))
    }

    private func transport() -> StarlingsHTTPTransport {
        StarlingsHTTPTransport(
            baseURL: URL(string: "https://meet.test/api")!,
            session: SessionRenewalStub.makeSession(replying: .status(200, Data("{}".utf8))),
            webOrigin: "https://meet.test",
            timeout: 3
        )
    }

    private func temporaryFileURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-operational-errors-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("spool.json")
    }

    private func event(id: Int, status: Int) -> OperationalErrorEvent {
        #if os(macOS)
        let source = OperationalErrorEventSource.mac
        let platform = OperationalErrorEventPlatform.macos
        #else
        let source = OperationalErrorEventSource.ios
        let platform = OperationalErrorEventPlatform.ios
        #endif
        return OperationalErrorEvent(
            eventID: UUID().uuidString.lowercased(),
            source: source,
            platform: platform,
            release: "4.8.7 (100)",
            code: .serviceUnavailable,
            operation: .work,
            errorClass: .http,
            httpStatus: status,
            requestID: String(format: "00000000-0000-4000-8000-%012d", id),
            retryCount: 0
        )
    }

    private struct OwnerBearer: StarlingsBearerSource {
        var isMeetOwnerSession: Bool { true }
        func meetBearerToken() -> String? { "owner-test-token" }
    }
}
