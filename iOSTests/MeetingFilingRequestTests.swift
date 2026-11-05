import Foundation
import StarlingsContracts
import XCTest
@testable import Starlings

/// Filing a meeting from the phone (meet#585). The Worker takes `PUT` on the
/// category route and refuses every other write method, as does the Mac
/// client; the phone sent `POST` and every filing failed.
final class MeetingFilingRequestTests: XCTestCase {
    private let credentials = MobileOwnerCredentials(
        accessToken: "access-test",
        owner: MobileOwnerProfile(sub: "sub-test", email: "test@example.com", name: "Test Owner", picture: nil)
    )

    func testSetMeetingCategoryIsAPutToTheCategoryPath() async throws {
        let session = SessionRenewalStub.makeSession(
            replying: .status(200, Data(#"{"meeting_kind":"internal"}"#.utf8))
        )
        let api = StarlingsAPI(
            environment: StarlingsEnvironment(
                apiBaseURL: URL(string: "https://meet.test/api")!,
                webOrigin: "https://meet.test"
            ),
            session: session
        )
        let meetingID = "6f1c9e1e-6d6a-4f2f-9d0a-2f6e3f1b4c55"

        let saved = try await api.setMeetingCategory(
            credentials: credentials,
            room: "rosa",
            meetingID: meetingID,
            update: MeetingCategoryUpdate(meetingKind: .internal)
        )

        XCTAssertEqual(saved.meetingKind, .internal)
        let request = try XCTUnwrap(SessionRenewalStub.lastRequestSnapshot)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/rooms/rosa/meetings/\(meetingID)/category")
        let body = try XCTUnwrap(SessionRenewalStub.lastRequestBodySnapshot)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(sent["meeting_kind"] as? String, "internal")
    }
}
