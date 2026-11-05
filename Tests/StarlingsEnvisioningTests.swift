import AppKit
import LiveKit
import StarlingsContracts
import XCTest
@testable import Starlings

final class StarlingsEnvisioningTests: XCTestCase {
    func testRoomSlugNormalizesHumanInput() {
        XCTAssertEqual(RoomSlug(rawValue: "  Design Review  ")?.rawValue, "design-review")
        XCTAssertEqual(RoomSlug(rawValue: "ROSA")?.urlPath, "/room/rosa")
    }

    func testRoomSlugRejectsUnsafeOrEmptyValues() {
        XCTAssertNil(RoomSlug(rawValue: ""))
        XCTAssertNil(RoomSlug(rawValue: "a"))
        XCTAssertNil(RoomSlug(rawValue: "---"))
    }

    func testNativeRoomEntryPreservesBookingToken() {
        // The build's own workspace, not the one this Mac has active: the links
        // are on its public host.
        let workspace = StarlingsWorkspace.builtIn
        let entry = GuestRoomEntry(input: "https://envisioning.starlings.example/room/rosa/booking_123", workspace: workspace)
        XCTAssertEqual(entry?.room.rawValue, "rosa")
        XCTAssertEqual(entry?.bookingToken, "booking_123")
        XCTAssertNil(GuestRoomEntry(input: "https://envisioning.starlings.example/book/rosa", workspace: workspace))
        XCTAssertNil(GuestRoomEntry(input: "https://envisioning.starlings.example/rosa", workspace: workspace))
        XCTAssertEqual(GuestRoomEntry(input: "rosa", workspace: workspace)?.room.rawValue, "rosa")
    }

    func testHostIdentityValidation() {
        XCTAssertTrue(HostIdentity(name: "Rosa", email: "rosa@example.com").isValid)
        XCTAssertTrue(HostIdentity(name: "Rosa", email: "ROSA@EXAMPLE.COM").isValid)
        XCTAssertFalse(HostIdentity(name: "", email: "rosa@example.com").isValid)
        XCTAssertFalse(HostIdentity(name: "Rosa", email: "not-an-email").isValid)
        XCTAssertFalse(HostIdentity(name: "Rosa", email: "rosa@example.net").isValid)
    }

    func testMeetingStartUsesPOSTAuthorizationAndKeepsIdentityOutOfURL() throws {
        let provider = HTTPConnectionDetailsProvider(
            apiBaseURL: URL(string: "https://meet.example/api")!,
            allowsDevelopmentAuthentication: false
        )
        let configuration = MeetingConfiguration(
            identity: MeetingIdentity(
                name: "Rosa",
                email: "rosa@example.com"
            ),
            role: .host,
            room: RoomSlug(rawValue: "Design Review")!,
            cameraID: "camera",
            microphoneID: "microphone"
        )

        let request = provider.makeStartRequest(for: configuration, accessToken: "owner-session-token")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://meet.example/api/rooms/design-review/start")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer owner-session-token")
        XCTAssertFalse(request.url?.absoluteString.contains("rosa@example.com") ?? true)
    }

    /// Guests must give a name and a real email — the same rule the control
    /// plane enforces in `joinRequestSchema`.
    func testGuestIdentityRequiresNameAndWellFormedEmail() {
        XCTAssertTrue(MeetingIdentity(name: "Ana", email: "ana@example.net").isValidGuest)
        XCTAssertFalse(MeetingIdentity(name: "Ana", email: "").isValidGuest)
        XCTAssertFalse(MeetingIdentity(name: "", email: "ana@example.net").isValidGuest)
        XCTAssertFalse(MeetingIdentity(name: "Ana", email: "not-an-email").isValidGuest)
    }

    func testNativeGuestUsesThePublicAdmissionContract() throws {
        let testKeychain = OwnerSessionStore(
            keychainService: "\(ContractConstants.nativeAppBundleID).owner-session.tests.\(UUID().uuidString)"
        )
        let api = MeetingControlAPI(
            apiBaseURL: URL(string: "https://meet.example/api")!,
            ownerSessionStore: testKeychain,
            webOrigin: "https://meet.example"
        )
        let request = try api.makeJoinRequest(
            room: RoomSlug(rawValue: "rosa")!,
            identity: MeetingIdentity(name: "Ana", email: "ana@example.net"),
            bookingToken: "booking_123",
            presenceID: "0f9a2f3e-6a2f-4d1a-9c39-2f0a1b6c7d8e"
        )
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://meet.example/api/rooms/rosa/join-requests")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://meet.example")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["name"] as? String, "Ana")
        XCTAssertEqual(json["email"] as? String, "ana@example.net")
        XCTAssertNil(json["transcript_opt_in"])
        XCTAssertEqual(json["booking_token"] as? String, "booking_123")
        // Clears the pre-knock row this Mac was heartbeating, so the owner sees
        // one visitor rather than a lurker beside a waiting guest.
        XCTAssertEqual(json["presence_id"] as? String, "0f9a2f3e-6a2f-4d1a-9c39-2f0a1b6c7d8e")
    }

    /// Mac Join heartbeats the same pre-knock route the browser join page does.
    /// Without it a knock refused for an absent owner leaves nothing behind,
    /// and the owner never learns anyone came by.
    func testNativeGuestPresenceUsesTheBrowserContract() throws {
        let api = MeetingControlAPI(
            apiBaseURL: URL(string: "https://meet.example/api")!,
            webOrigin: "https://meet.example"
        )
        let request = try api.makeGuestPresenceRequest(
            room: RoomSlug(rawValue: "rosa")!,
            presenceID: "0f9a2f3e-6a2f-4d1a-9c39-2f0a1b6c7d8e",
            stage: .preview,
            name: "Ana",
            bookingToken: "booking_123"
        )
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://meet.example/api/rooms/rosa/guest-presence")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://meet.example")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["presence_id"] as? String, "0f9a2f3e-6a2f-4d1a-9c39-2f0a1b6c7d8e")
        XCTAssertEqual(json["stage"] as? String, "preview")
        XCTAssertEqual(json["name"] as? String, "Ana")
        XCTAssertEqual(json["booking_token"] as? String, "booking_123")
        XCTAssertEqual((json["client"] as? [String: Any])?["app"] as? String, "mac")
        // Pre-knock rows carry a display name at most — never the email.
        XCTAssertNil(json["email"])
    }

    /// A guest who has typed nothing sends no name at all: the control plane
    /// rejects an empty one, and a beat that 400s is a visitor the owner never
    /// sees.
    func testNativeGuestPresenceOmitsAnAbsentName() throws {
        let api = MeetingControlAPI(
            apiBaseURL: URL(string: "https://meet.example/api")!,
            webOrigin: "https://meet.example"
        )
        let request = try api.makeGuestPresenceRequest(
            room: RoomSlug(rawValue: "rosa")!,
            presenceID: "0f9a2f3e-6a2f-4d1a-9c39-2f0a1b6c7d8e",
            stage: .visit,
            name: nil
        )
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertNil(json["name"])
        XCTAssertNil(json["booking_token"])
        XCTAssertEqual(json["stage"] as? String, "visit")
    }

    func testCaptionWireContractRoundTripsSpeakerAndLanguage() throws {
        let segment = Starlings.TranscriptSegment(
            id: UUID(uuidString: "75B3FAE1-5154-4A6B-8D2D-9175067DEAB7")!,
            meetingID: "meeting-123",
            speakerID: "guest:ana:1234",
            speakerName: "Ana",
            language: .portuguese,
            startsAtMilliseconds: 1_250,
            endsAtMilliseconds: 2_840,
            text: "Olá, vamos começar.",
            isFinal: true
        )
        let message = CaptionMessage(segment: segment)

        let data = try JSONEncoder().encode(message)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let encodedSegment = try XCTUnwrap(json["segment"] as? [String: Any])
        XCTAssertEqual(json["version"] as? Int, 1)
        XCTAssertEqual(encodedSegment["speaker_name"] as? String, "Ana")
        XCTAssertEqual(encodedSegment["language"] as? String, "pt")
        XCTAssertEqual(encodedSegment["is_final"] as? Bool, true)
        XCTAssertEqual(try JSONDecoder().decode(CaptionMessage.self, from: data), message)

        let german = Starlings.TranscriptSegment(
            id: UUID(uuidString: "A5B3FAE1-5154-4A6B-8D2D-9175067DEAB8")!,
            meetingID: "meeting-123",
            speakerID: "guest:max:1234",
            speakerName: "Max",
            language: .german,
            startsAtMilliseconds: 3_000,
            endsAtMilliseconds: 4_000,
            text: "Guten Tag, wir können beginnen.",
            isFinal: true
        )
        let germanData = try JSONEncoder().encode(CaptionMessage(segment: german))
        let germanJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: germanData) as? [String: Any])
        let germanSegment = try XCTUnwrap(germanJSON["segment"] as? [String: Any])
        XCTAssertEqual(germanSegment["language"] as? String, "de")
        XCTAssertEqual(try JSONDecoder().decode(CaptionMessage.self, from: germanData).segment.language, .german)
    }

    func testCaptionsOnlyAcceptVerifiedOwnerIdentity() {
        XCTAssertTrue(CaptionMessage.acceptsPublisherIdentity("owner@example.com"))
        XCTAssertTrue(CaptionMessage.acceptsPublisherIdentity("OWNER@EXAMPLE.COM"))
        XCTAssertFalse(CaptionMessage.acceptsPublisherIdentity("guest:owner@example.com:abc123"))
        XCTAssertFalse(CaptionMessage.acceptsPublisherIdentity("attacker@example.net"))
        XCTAssertFalse(CaptionMessage.acceptsPublisherIdentity(nil))
    }

    func testDeviceScopedOwnerIdentityStaysAVerifiedCaptionPublisher() {
        let mac = EnvisioningIdentity.deviceScopedIdentity("rosa@example.com", device: .mac)
        let phone = EnvisioningIdentity.deviceScopedIdentity("rosa@example.org", device: .iphone)
        XCTAssertEqual(mac, "rosa+mac@example.com")
        XCTAssertEqual(phone, "rosa+iphone@example.org")

        // The whole reason the suffix lives in the local part: every shipped
        // client decides caption trust on the domain.
        XCTAssertTrue(CaptionMessage.acceptsPublisherIdentity(mac))
        XCTAssertTrue(CaptionMessage.acceptsPublisherIdentity(phone))
        XCTAssertFalse(CaptionMessage.acceptsPublisherIdentity("rosa+iphone@example.net"))

        // What the owner is entitled to as a person resolves back to one address.
        XCTAssertEqual(EnvisioningIdentity.accountAddress(mac), "rosa@example.com")
        XCTAssertEqual(EnvisioningIdentity.accountAddress(phone), "rosa@example.org")
        XCTAssertEqual(EnvisioningIdentity.accountAddress("rosa@example.com"), "rosa@example.com")
    }

    func testCLITransportRoundTripsVersionedJSONWithoutCredentials() async throws {
        let socketURL = URL(fileURLWithPath: "/tmp/meet-cli-test-\(UUID().uuidString).sock")
        let state = StarlingsCLIState(
            phase: "setup",
            role: "host",
            room: "rosa",
            meetingID: nil,
            status: "Your room",
            identity: StarlingsCLIIdentityState(name: "Rosa", email: "rosa@example.com"),
            authenticatedOwnerEmail: "rosa@example.com",
            participantCount: 1,
            cameraPermission: "authorized",
            microphonePermission: "authorized",
            media: StarlingsCLIMediaState(
                microphoneEnabled: true,
                cameraEnabled: true,
                screenShareEnabled: false,
                backgroundBlurEnabled: false,
                selectedCameraID: "camera-1",
                selectedMicrophoneID: "microphone-1"
            ),
            cameras: [StarlingsCLIDeviceState(id: "camera-1", name: "Camera", selected: true)],
            microphones: [StarlingsCLIDeviceState(id: "microphone-1", name: "Microphone", selected: true)],
            speakers: [],
            waitingGuest: nil,
            waitingGuests: [],
            hostAppliance: StarlingsCLIHostApplianceState(
                wakeAssertionActive: false,
                leaseHealthy: false,
                detail: "Host appliance idle"
            )
        )
        let server = StarlingsCommandServer(socketURL: socketURL) { request in
            .success(for: request, message: "State returned.", state: state)
        }
        try server.start()
        defer { server.stop() }

        let request = StarlingsCLIRequest(command: "status", id: "test-request")
        let response = try StarlingsCommandClient(socketURL: socketURL).send(request)
        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.version, meetCLIProtocolVersion)
        XCTAssertEqual(response.id, request.id)
        XCTAssertEqual(response.state, state)
        XCTAssertNil(response.error)

        let attributes = try FileManager.default.attributesOfItem(atPath: socketURL.path)
        let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber)
        XCTAssertEqual(permissions.intValue & 0o777, 0o600)
        let encoded = try JSONEncoder().encode(response)
        let wireText = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        XCTAssertFalse(wireText.contains("access_token"))
        XCTAssertFalse(wireText.contains("artifact_token"))
        XCTAssertFalse(wireText.contains("lobby_token"))
    }

    func testGeneratedMeetCLIWireTypesMatchSocketFixture() throws {
        let bundle = Bundle(for: type(of: self))
        let fixtureURL = try XCTUnwrap(
            bundle.url(forResource: "cli-wire", withExtension: "json"),
            "fixtures/cli-wire.json is not in the test bundle — check project.yml."
        )
        let fixtureData = try Data(contentsOf: fixtureURL)
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: fixtureData) as? [String: Any])

        let request = try assertGeneratedRoundTrip(StarlingsCLIRequest.self, json: try XCTUnwrap(fixture["request"]))
        XCTAssertEqual(request, StarlingsCLIRequest(command: "status", arguments: ["room": "rosa"], id: "test-request"))

        let success = try assertGeneratedRoundTrip(
            StarlingsCLIResponse.self,
            json: try XCTUnwrap(fixture["success_response"])
        )
        XCTAssertEqual(success.state?.identity.email, "rosa@example.com")
        XCTAssertEqual(success.state?.media.selectedSpeakerID, "speaker-1")
        XCTAssertEqual(success.state?.waitingGuest?.id, "guest-1")
        XCTAssertEqual(success.state?.hostAppliance?.leaseHealthy, true)
        XCTAssertEqual(success.output?.waitingGuests?.first?.email, "ana@example.net")

        let failure = try assertGeneratedRoundTrip(
            StarlingsCLIResponse.self,
            json: try XCTUnwrap(fixture["failure_response"])
        )
        XCTAssertNil(failure.state)
        XCTAssertNil(failure.output)
        XCTAssertEqual(failure.error?.code, "meeting_not_open")
    }

    private func assertGeneratedRoundTrip<Value: Codable>(
        _ type: Value.Type,
        json: Any,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> Value {
        let expectedData = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
        let decoded = try JSONDecoder().decode(type, from: expectedData)
        let encodedData = try JSONEncoder().encode(decoded)
        let expected = try JSONSerialization.data(
            withJSONObject: JSONSerialization.jsonObject(with: expectedData),
            options: [.sortedKeys]
        )
        let actual = try JSONSerialization.data(
            withJSONObject: JSONSerialization.jsonObject(with: encodedData),
            options: [.sortedKeys]
        )
        XCTAssertEqual(actual, expected, file: file, line: line)
        return decoded
    }

    func testOwnerSessionCredentialsRoundTripIncludesAPIEndpoint() throws {
        let credentials = OwnerSessionCredentials(
            accessToken: "session-jwt",
            owner: OwnerProfile(sub: "sub-1", email: "rosa@example.com", name: "ROSA", picture: nil),
            apiEndpoint: "https://legacy.org.example/api"
        )
        let data = try JSONEncoder().encode(credentials)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["access_token"] as? String, "session-jwt")
        XCTAssertEqual(json["api_endpoint"] as? String, "https://legacy.org.example/api")
        XCTAssertEqual(try JSONDecoder().decode(OwnerSessionCredentials.self, from: data), credentials)

        let legacy = Data(#"{"access_token":"old","owner":{"sub":"s","email":"rosa@example.com","name":"ROSA"}}"#.utf8)
        let decoded = try JSONDecoder().decode(OwnerSessionCredentials.self, from: legacy)
        XCTAssertEqual(decoded.accessToken, "old")
        XCTAssertNil(decoded.apiEndpoint)
    }

    func testCameraOffAvatarInitialsIgnoreTheLocalTilesYouSuffix() {
        // A trailing parenthetical is dropped, and the avatar is drawn from
        // that same label — so "(y" is one careless split away.
        XCTAssertEqual(ParticipantInitials.make(from: "Rosa Ortiz (you)"), "RO")
        XCTAssertEqual(ParticipantInitials.make(from: "Rosa (you)"), "R")
        XCTAssertEqual(ParticipantInitials.make(from: "ana beatriz souza"), "AB")
        XCTAssertEqual(ParticipantInitials.make(from: "   "), "?")
    }

    @MainActor
    func testLurkerCopyDoesNotRepeatTheNameAsAStage() {
        // The web only reports `naming` once a name exists, so "Entering name"
        // plus the name was the same fact twice.
        let naming = GuestPresenceRow(
            id: "a", stage: .naming, name: "Rosa Ortiz",
            city: "Amsterdam", country: "NL", seenAt: 0, createdAt: 0
        )
        let detail = LobbyLurkerCopy.detail(for: naming)
        XCTAssertFalse(detail.contains("Entering name"))
        XCTAssertTrue(detail.contains("Rosa Ortiz"))
        XCTAssertTrue(detail.contains("Amsterdam"))
        XCTAssertFalse(detail.contains("NL"))

        let countryOnly = GuestPresenceRow(
            id: "country-only", stage: .visit, name: nil,
            city: nil, country: "NL", seenAt: 0, createdAt: 0
        )
        XCTAssertFalse(LobbyLurkerCopy.detail(for: countryOnly).contains("NL"))
    }

    func testCountryFlagUsesOnlyTwoLetterIsoCodes() {
        XCTAssertEqual(StarlingsCountryFlag.normalizedCode(" PT "), "pt")
        XCTAssertEqual(StarlingsCountryFlag.assetName(for: "BR"), "MeetFlag-br")
        XCTAssertNil(StarlingsCountryFlag.normalizedCode("T1"))
        XCTAssertNil(StarlingsCountryFlag.normalizedCode("Portugal"))
    }

    @MainActor
    func testLurkerCopyStillNamesTheStageWhenItAddsSomething() {
        // "Checking camera" is news the name doesn't carry — they are one click
        // from knocking. And a nameless visitor still needs some label.
        let preview = GuestPresenceRow(
            id: "b", stage: .preview, name: "Rosa Ortiz",
            city: nil, country: nil, seenAt: 0, createdAt: 0
        )
        XCTAssertTrue(LobbyLurkerCopy.detail(for: preview).hasPrefix("Checking camera"))

        let anonymous = GuestPresenceRow(
            id: "c", stage: .naming, name: nil, city: nil, country: nil, seenAt: 0, createdAt: 0
        )
        // Prefix, not exact equality: the row also carries how long they've
        // been waiting, which this fixture's epoch seenAt makes huge.
        XCTAssertTrue(LobbyLurkerCopy.detail(for: anonymous).hasPrefix("Entering name"))
    }

    @MainActor
    func testLurkerCopyMarksABookedVisitorWithoutPrintingTheToken() {
        let booked = GuestPresenceRow(
            id: "d", stage: .preview, name: "Rosa Ortiz",
            city: "Amsterdam", country: "NL",
            bookingToken: "crm-7f3a-secret", seenAt: 0, createdAt: 0
        )
        let detail = LobbyLurkerCopy.detail(for: booked)
        XCTAssertTrue(detail.hasPrefix("Booked"))
        XCTAssertFalse(detail.contains("crm-7f3a-secret"), "the token is correlation data, not display copy")
    }

    /// A row without a booking token is a visitor who arrived on a plain link.
    func testLurkerDecodesWithoutABookingToken() throws {
        let json = Data(#"{"id":"a","stage":"visit","name":null,"city":null,"country":null,"bookingToken":null,"client":null,"seenAt":1,"createdAt":1}"#.utf8)
        let lurker = try JSONDecoder().decode(GuestPresenceRow.self, from: json)
        XCTAssertNil(lurker.bookingToken)
        XCTAssertEqual(lurker.stage, .visit)
    }

    @MainActor
    func testLurkerCopyNamesTheSurfaceTheVisitorIsOn() {
        let onPhone = GuestPresenceRow(
            id: "e", stage: .preview, name: "Rosa Ortiz",
            city: "Amsterdam", country: "NL",
            client: GuestClient(app: .web, device: .mobile), seenAt: 0, createdAt: 0
        )
        XCTAssertFalse(LobbyLurkerCopy.detail(for: onPhone).contains("📱 Web"))
        XCTAssertEqual(onPhone.client?.badge, "Web")
        XCTAssertEqual(onPhone.client?.systemSymbolName, "globe")

        let onMac = GuestPresenceRow(
            id: "f", stage: .visit, name: nil, city: nil, country: nil,
            client: GuestClient(app: .mac, device: .desktop), seenAt: 0, createdAt: 0
        )
        XCTAssertFalse(LobbyLurkerCopy.detail(for: onMac).contains("🖥 Mac app"))
        XCTAssertEqual(onMac.client?.badge, "Mac app")
        XCTAssertEqual(onMac.client?.systemSymbolName, "desktopcomputer")
    }

    /// An unrecognised surface must never cost the visitor: a lurker this Mac
    /// cannot classify still appears in the waiting room, and the badge says
    /// what the client called itself.
    func testLurkerSurvivesAClientThisBuildDoesNotKnow() throws {
        let json = Data(#"""
        {"id":"a","stage":"visit","name":null,"city":null,"country":null,"bookingToken":null,
         "client":{"app":"visionos","device":"headset"},"seenAt":1,"createdAt":1}
        """#.utf8)
        let lurker = try JSONDecoder().decode(GuestPresenceRow.self, from: json)
        XCTAssertEqual(lurker.client?.app.rawValue, "visionos")
        XCTAssertEqual(lurker.client?.badge, "visionos")
        XCTAssertEqual(lurker.id, "a")
    }

    @MainActor
    func testWaitingGuestCopyNamesTheSurfaceWithoutPrintingTheBookingToken() throws {
        let json = Data(#"""
        {"id":"r1","meetingId":"m1","name":"Rosa Ortiz","email":"rosa@example.com",
         "identity":"guest:abc","status":"waiting","createdAt":1,
         "bookingToken":"crm-7f3a-secret","client":{"app":"ios","device":"tablet"}}
        """#.utf8)
        let request = try JSONDecoder().decode(LobbyRequestResponse.self, from: json)
        let detail = LobbyGuestCopy.detail(for: request)
        XCTAssertFalse(detail.contains("📱 iPad app"))
        XCTAssertEqual(request.client?.badge, "iPad app")
        XCTAssertEqual(request.client?.systemSymbolName, "ipad")
        XCTAssertTrue(detail.contains("has booking"))
        XCTAssertFalse(detail.contains("crm-7f3a-secret"))
    }

    @MainActor
    func testWaitingGuestCopyOmitsTheSurfaceWhenTheClientNeverSentOne() throws {
        let json = Data(#"""
        {"id":"r2","meetingId":"m1","name":"Rosa Ortiz","email":"",
         "identity":"guest:abc","status":"waiting","createdAt":1}
        """#.utf8)
        let request = try JSONDecoder().decode(LobbyRequestResponse.self, from: json)
        // Prefix, not exact equality: the row also carries how long they've
        // been waiting, which this fixture's epoch createdAt makes huge.
        XCTAssertTrue(LobbyGuestCopy.detail(for: request).hasPrefix("Rosa Ortiz · no email"))
    }

    func testLobbyWaitCopyFormatsElapsedTime() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(LobbyWaitCopy.elapsed(since: 999_945_000, now: now), "55s")
        XCTAssertEqual(LobbyWaitCopy.elapsed(since: 999_760_000, now: now), "4m")
        XCTAssertEqual(LobbyWaitCopy.elapsed(since: 996_460_000, now: now), "59m")
        XCTAssertEqual(LobbyWaitCopy.elapsed(since: 996_400_000, now: now), "1h")
        XCTAssertEqual(LobbyWaitCopy.elapsed(since: 996_100_000, now: now), "1h 5m")
        // A clock skew or brand-new row can read slightly in the future —
        // say nothing rather than a confusing negative duration.
        XCTAssertNil(LobbyWaitCopy.elapsed(since: 1_000_010_000, now: now))
    }

    /// The bug behind a row frozen on "Entering name" while the guest was
    /// already at the device check: a lurker id is stable for the whole visit,
    /// so row identity never changes and only the detail text does.
    @MainActor
    func testLurkerDetailChangesAcrossStagesForOneStableID() {
        let stages: [GuestPresenceStage] = [.visit, .naming, .preview]
        let rows = stages.map {
            GuestPresenceRow(id: "same-id", stage: $0, name: "Rosa Ortiz", city: "Amsterdam", country: "NL", seenAt: 0, createdAt: 0)
        }
        let details = rows.map(LobbyLurkerCopy.detail(for:))
        XCTAssertEqual(Set(details).count, 3, "each stage must render differently or a stale row is invisible")
    }

    func testOwnerAuthRejectionAsksForFreshSignIn() {
        let error = StarlingsError.service(
            status: 401,
            serverCode: ControlErrorCodeValue.ownerAuthRequired.rawValue,
            serverMessage: "Owner authentication is required.",
            operation: "Couldn’t start the room"
        )
        XCTAssertEqual(error.code, "auth.session_expired")
        XCTAssertEqual(error.recovery, .signIn)
        XCTAssertEqual(error.message, "Your Starlings sign-in is no longer valid. Sign in to continue.")
    }

    /// The regression this whole type exists to prevent: the server's prose is
    /// free to change, and the client must keep behaving the same.
    func testServiceMappingIgnoresServerProse() {
        let reworded = StarlingsError.service(
            status: 401,
            serverCode: ControlErrorCodeValue.ownerAuthRequired.rawValue,
            serverMessage: "Completely different wording.",
            operation: "Couldn’t start the room"
        )
        XCTAssertEqual(reworded.code, "auth.session_expired")
        XCTAssertEqual(reworded.recovery, .signIn)
    }

    /// The bug that started this: one `LiveKitError.timedOut` used to read
    /// "Timed out" whether the server was unreachable or the camera never
    /// started. Stage is what separates them.
    func testTimeoutMessageDependsOnStage() {
        let connect = StarlingsError.liveKit(LiveKitError(.timedOut), stage: .connect)
        let camera = StarlingsError.liveKit(LiveKitError(.timedOut), stage: .camera)
        XCTAssertEqual(connect.code, "connect.timeout")
        XCTAssertEqual(camera.code, "media.camera_start_timeout")
        XCTAssertNotEqual(connect.title, camera.title)
    }

    /// Chat and caption failures must never take over the screen.
    func testNonBlockingFailuresStayOutOfModals() {
        XCTAssertEqual(StarlingsError.chatTooLong.severity, .notice)
        XCTAssertEqual(StarlingsError.captionTooLarge.severity, .silent)
        XCTAssertEqual(StarlingsError.liveKit(LiveKitError(.timedOut), stage: .chat).severity, .notice)
    }

    func testScreenCapturePermissionFailureIsOptionalAndActionable() {
        let error = StarlingsError.screenCapturePermissionDenied()
        XCTAssertEqual(error.code, "media.screen_capture_denied")
        XCTAssertEqual(error.recovery, .openScreenRecordingSettings)
        XCTAssertEqual(error.severity, .blocking)
        XCTAssertTrue(error.message.contains("Screen Recording"))
    }

    func testScreenShareServerPermissionFailureDoesNotLookLikeSignInFailure() {
        let error = StarlingsError.liveKit(LiveKitError(.insufficientPermissions), stage: .screenShare)
        XCTAssertEqual(error.code, "media.screenshare_not_allowed")
        XCTAssertEqual(error.severity, .notice)
        XCTAssertEqual(error.recovery, .none)
    }

    func testUnknownScreenShareFailureIsAWorkingMeetingNotice() {
        struct UnknownCaptureError: Error {}
        let error = StarlingsError.liveKit(UnknownCaptureError(), stage: .screenShare)
        XCTAssertEqual(error.severity, .notice)
        XCTAssertEqual(error.recovery, .retry)
    }

    /// A user-facing string must never be a raw vendor string.
    func testRawVendorTextStaysInDiagnostics() {
        let mapped = StarlingsError.liveKit(LiveKitError(.stateMismatch), stage: .connect)
        XCTAssertFalse(mapped.message.contains("Server state mismatch"))
        XCTAssertTrue(mapped.diagnostic.contains("state"))
    }

    func testArtifactOutboxPersistsTextWhenUploadIsUnavailable() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-outbox-test-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("outbox.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let testKeychain = OwnerSessionStore(
            keychainService: "\(ContractConstants.nativeAppBundleID).owner-session.tests.\(UUID().uuidString)"
        )
        let api = MeetingControlAPI(
            apiBaseURL: URL(string: "https://unreachable.invalid/api")!,
            ownerSessionStore: testKeychain
        )
        let context = MeetingContext(
            room: RoomSlug(rawValue: "rosa")!,
            meetingID: "meeting-offline",
            artifactToken: "unused"
        )
        let segment = Starlings.TranscriptSegment(
            id: UUID(),
            meetingID: context.meetingID,
            speakerID: "owner:test@example.com",
            speakerName: "Test",
            language: .english,
            startsAtMilliseconds: 0,
            endsAtMilliseconds: 1_000,
            text: "A durable local segment.",
            isFinal: true
        )

        let first = MeetingArtifactOutbox(api: api, fileURL: fileURL)
        let uploaded = await first.enqueue(
            segment,
            room: context.room.rawValue,
            meetingID: context.meetingID
        )
        let firstPendingCount = await first.pendingMeetingCount()
        XCTAssertEqual(uploaded, OutboxDelivery(persisted: true, uploaded: false, finalized: false))
        XCTAssertEqual(firstPendingCount, 1)

        let restarted = MeetingArtifactOutbox(api: api, fileURL: fileURL)
        let restartedPendingCount = await restarted.pendingMeetingCount()
        XCTAssertEqual(restartedPendingCount, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))
    }

    /// The queue is shared with the phone, so it is exercised here through the
    /// protocol rather than through the Mac's API type: what the phone hands it
    /// is a different uploader, and the retry and finalize behaviour has to be
    /// the same one for both.
    func testSharedOutboxRetriesThroughAnyUploaderAndFinalizesOnce() async throws {
        actor StubUploader: TranscriptUploading {
            private var refuse: Bool
            private(set) var uploaded: [UUID] = []
            private(set) var finalizations = 0

            init(refuse: Bool) { self.refuse = refuse }

            func allow() { refuse = false }

            func appendTranscript(room: String, meetingID: String, segments: [Starlings.TranscriptSegment]) async throws {
                if refuse { throw MobileOutboxTestError.offline }
                uploaded.append(contentsOf: segments.map(\.id))
            }

            func finalizeMeeting(room: String, meetingID: String) async throws {
                if refuse { throw MobileOutboxTestError.offline }
                finalizations += 1
            }
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-outbox-shared-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("outbox.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let uploader = StubUploader(refuse: true)
        let outbox = MeetingArtifactOutbox(api: uploader, fileURL: fileURL)
        let segment = Starlings.TranscriptSegment(
            id: UUID(),
            meetingID: "meeting-shared",
            speakerID: "owner:test@example.com",
            speakerName: "Test",
            language: .english,
            startsAtMilliseconds: 0,
            endsAtMilliseconds: 1_000,
            text: "Held until the network comes back.",
            isFinal: true
        )

        let offline = await outbox.enqueue(segment, room: "rosa", meetingID: "meeting-shared")
        XCTAssertTrue(offline.isUploadPending)
        let finalizeOffline = await outbox.requestFinalization(room: "rosa", meetingID: "meeting-shared")
        XCTAssertFalse(finalizeOffline.finalized)

        await uploader.allow()
        _ = await outbox.retryPending()

        let uploaded = await uploader.uploaded
        let finalizations = await uploader.finalizations
        let pending = await outbox.pendingMeetingCount()
        XCTAssertEqual(uploaded, [segment.id])
        // The artifact is cut once. A retry that finalized again would email
        // everybody a second time.
        XCTAssertEqual(finalizations, 1)
        XCTAssertEqual(pending, 0)
    }

    /// meet#185. Two uploads in flight for one meeting, both failing: the
    /// second used to survive and the first used to be overwritten by the
    /// suspended call's stale copy. Every failed segment must stay queued,
    /// and a finalize asked for during an upload must not be lost either.
    func testOutboxKeepsEveryFailedSegmentUnderOverlappingUploads() async throws {
        actor PausedUploader: TranscriptUploading {
            private var calls: [CheckedContinuation<Void, Error>] = []
            private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
            private(set) var finalizations = 0

            func appendTranscript(room: String, meetingID: String, segments: [Starlings.TranscriptSegment]) async throws {
                try await withCheckedThrowingContinuation { continuation in
                    calls.append(continuation)
                    let ready = waiters.filter { calls.count >= $0.0 }
                    waiters.removeAll { calls.count >= $0.0 }
                    for (_, waiter) in ready { waiter.resume() }
                }
            }

            func finalizeMeeting(room: String, meetingID: String) async throws { finalizations += 1 }

            func waitForCalls(_ count: Int) async {
                if calls.count >= count { return }
                await withCheckedContinuation { waiters.append((count, $0)) }
            }

            func fail(_ index: Int) { calls[index].resume(throwing: MobileOutboxTestError.offline) }
            func succeed(_ index: Int) { calls[index].resume() }
            var callCount: Int { calls.count }
        }

        func segment(_ text: String) -> Starlings.TranscriptSegment {
            Starlings.TranscriptSegment(
                id: UUID(),
                meetingID: "meeting-overlap",
                speakerID: "owner:test@example.com",
                speakerName: "Test",
                language: .english,
                startsAtMilliseconds: 0,
                endsAtMilliseconds: 1_000,
                text: text,
                isFinal: true
            )
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-outbox-overlap-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("outbox.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let uploader = PausedUploader()
        let outbox = MeetingArtifactOutbox(api: uploader, fileURL: fileURL)
        let first = segment("first")
        let second = segment("second")

        // A's upload is in flight; B is enqueued behind it and waits for A's
        // drain, so only one call has been made when both are pending.
        let a = Task { await outbox.enqueue(first, room: "rosa", meetingID: "meeting-overlap") }
        await uploader.waitForCalls(1)
        let b = Task { await outbox.enqueue(second, room: "rosa", meetingID: "meeting-overlap") }
        let finalize = Task { await outbox.requestFinalization(room: "rosa", meetingID: "meeting-overlap") }
        await uploader.fail(0)
        let aDelivered = await a.value
        XCTAssertTrue(aDelivered.isUploadPending)

        // B and the finalize each run their own drain in turn, either order:
        // one upload carrying both segments, then another. Fail both.
        await uploader.waitForCalls(2)
        await uploader.fail(1)
        await uploader.waitForCalls(3)
        await uploader.fail(2)
        let bDelivered = await b.value
        let finalized = await finalize.value
        XCTAssertTrue(bDelivered.isUploadPending)
        XCTAssertFalse(finalized.finalized)

        let persisted = try String(contentsOf: fileURL, encoding: .utf8)
        XCTAssertTrue(persisted.contains("\"first\""))
        XCTAssertTrue(persisted.contains("\"second\""))
        XCTAssertTrue(persisted.contains("\"finalizeRequested\":true"))

        // The network is back: one retry uploads both and finalizes once.
        let retry = Task { await outbox.retryPending() }
        await uploader.waitForCalls(4)
        await uploader.succeed(3)
        _ = await retry.value
        let finalizations = await uploader.finalizations
        let pending = await outbox.pendingMeetingCount()
        XCTAssertEqual(finalizations, 1)
        XCTAssertEqual(pending, 0)
    }

    /// meet#185, reproduction 1. The host enqueues while a recovery drain
    /// is mid-upload, and that upload fails. With two instances over one
    /// file the failed drain wrote its stale copy back and B was gone; with
    /// the one instance the host writes into the same rows the drain reads,
    /// so B is on disk after the failure and goes out on the next retry.
    func testOutboxKeepsHostTextWrittenDuringAFailedRecovery() async throws {
        actor PausedUploader: TranscriptUploading {
            private var calls: [CheckedContinuation<Void, Error>] = []
            private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
            private(set) var uploaded: [String] = []
            private var pending: [[Starlings.TranscriptSegment]] = []

            func appendTranscript(room: String, meetingID: String, segments: [Starlings.TranscriptSegment]) async throws {
                pending.append(segments)
                let index = pending.count - 1
                try await withCheckedThrowingContinuation { continuation in
                    calls.append(continuation)
                    let ready = waiters.filter { calls.count >= $0.0 }
                    waiters.removeAll { calls.count >= $0.0 }
                    for (_, waiter) in ready { waiter.resume() }
                }
                uploaded.append(contentsOf: pending[index].map(\.text))
            }

            func finalizeMeeting(room: String, meetingID: String) async throws {}

            func waitForCalls(_ count: Int) async {
                if calls.count >= count { return }
                await withCheckedContinuation { waiters.append((count, $0)) }
            }

            func fail(_ index: Int) { calls[index].resume(throwing: MobileOutboxTestError.offline) }
            func succeed(_ index: Int) { calls[index].resume() }
        }

        func segment(_ text: String) -> Starlings.TranscriptSegment {
            Starlings.TranscriptSegment(
                id: UUID(), meetingID: "meeting-recovery", speakerID: "owner:test@example.com",
                speakerName: "Test", language: .english, startsAtMilliseconds: 0, endsAtMilliseconds: 1_000,
                text: text, isFinal: true
            )
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-outbox-recovery-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("outbox.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let uploader = PausedUploader()
        let outbox = MeetingArtifactOutbox(api: uploader, fileURL: fileURL)

        // A failed to upload once and is on disk.
        let a = Task { await outbox.enqueue(segment("A"), room: "rosa", meetingID: "meeting-recovery") }
        await uploader.waitForCalls(1)
        await uploader.fail(0)
        let aDelivery = await a.value
        XCTAssertTrue(aDelivery.isUploadPending)

        // Recovery (foreground, network back) starts a drain and is paused
        // mid-upload; the host enqueues B behind it; the recovery upload fails.
        let recovery = Task { await outbox.retryPending() }
        await uploader.waitForCalls(2)
        let b = Task { await outbox.enqueue(segment("B"), room: "rosa", meetingID: "meeting-recovery") }
        await uploader.fail(1)
        _ = await recovery.value
        // B's own drain runs after the failed one, and fails too.
        await uploader.waitForCalls(3)
        await uploader.fail(2)
        let bDelivery = await b.value
        XCTAssertTrue(bDelivery.isUploadPending)

        let persisted = try String(contentsOf: fileURL, encoding: .utf8)
        XCTAssertTrue(persisted.contains("\"A\""), "A survived the failed recovery")
        XCTAssertTrue(persisted.contains("\"B\""), "B, written during the failed recovery, survived it")

        // One more retry carries both.
        let retry = Task { await outbox.retryPending() }
        await uploader.waitForCalls(4)
        await uploader.succeed(3)
        let remaining = await retry.value
        let uploadedTexts = await uploader.uploaded
        XCTAssertEqual(remaining, 1, "the meeting is still open: finalize was never asked for")
        XCTAssertEqual(Set(uploadedTexts), ["A", "B"])
    }

    /// meet#185, reproduction 2. A segment that uploaded is uploaded, even
    /// though the meeting's row stays until finalize: `uploaded` says the
    /// Worker has the text, `finalized` says the row is gone, and the two are
    /// not the same question.
    func testOutboxReportsAnUploadedSegmentAsUploadedWhileTheMeetingIsOpen() async throws {
        actor Accepting: TranscriptUploading {
            private(set) var finalizations = 0
            func appendTranscript(room: String, meetingID: String, segments: [Starlings.TranscriptSegment]) async throws {}
            func finalizeMeeting(room: String, meetingID: String) async throws { finalizations += 1 }
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-outbox-open-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("outbox.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let outbox = MeetingArtifactOutbox(api: Accepting(), fileURL: fileURL)
        let segment = Starlings.TranscriptSegment(
            id: UUID(), meetingID: "meeting-open", speakerID: "owner:test@example.com",
            speakerName: "Test", language: .english, startsAtMilliseconds: 0, endsAtMilliseconds: 1_000,
            text: "Went straight up.", isFinal: true
        )
        let delivery = await outbox.enqueue(segment, room: "rosa", meetingID: "meeting-open")
        XCTAssertEqual(delivery, OutboxDelivery(persisted: true, uploaded: true, finalized: false))
        XCTAssertFalse(delivery.isUploadPending)
        let openCount = await outbox.pendingMeetingCount()
        XCTAssertEqual(openCount, 1)

        let finalized = await outbox.requestFinalization(room: "rosa", meetingID: "meeting-open")
        XCTAssertEqual(finalized, OutboxDelivery(persisted: true, uploaded: true, finalized: true))
        let closedCount = await outbox.pendingMeetingCount()
        XCTAssertEqual(closedCount, 0)
    }

    /// meet#185. The uploader is asked for at delivery: signed out, the text
    /// waits; signed in again, the same row goes out with the new session.
    func testOutboxWaitsWithoutASessionAndDeliversWithTheNextOne() async throws {
        actor Counting: TranscriptUploading {
            private(set) var uploads = 0
            func appendTranscript(room: String, meetingID: String, segments: [Starlings.TranscriptSegment]) async throws { uploads += 1 }
            func finalizeMeeting(room: String, meetingID: String) async throws {}
        }
        actor Session {
            var current: Counting?
            func set(_ value: Counting?) { current = value }
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-outbox-session-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("outbox.json")
        defer { try? FileManager.default.removeItem(at: directory) }

        let session = Session()
        let outbox = MeetingArtifactOutbox(uploader: { await session.current }, fileURL: fileURL)
        let segment = Starlings.TranscriptSegment(
            id: UUID(), meetingID: "meeting-session", speakerID: "owner:test@example.com",
            speakerName: "Test", language: .english, startsAtMilliseconds: 0, endsAtMilliseconds: 1_000,
            text: "Said while signed out.", isFinal: true
        )
        let signedOut = await outbox.enqueue(segment, room: "rosa", meetingID: "meeting-session")
        XCTAssertEqual(signedOut, OutboxDelivery(persisted: true, uploaded: false, finalized: false))

        let renewed = Counting()
        await session.set(renewed)
        let remaining = await outbox.retryPending()
        let uploads = await renewed.uploads
        XCTAssertEqual(remaining, 1)
        XCTAssertEqual(uploads, 1)
        let after = await outbox.requestFinalization(room: "rosa", meetingID: "meeting-session")
        XCTAssertTrue(after.finalized)
    }

    /// meet#185. A disk that refuses the write is not a saved segment.
    func testOutboxSaysWhenTheTextDidNotReachTheDisk() async throws {
        actor Refusing: TranscriptUploading {
            func appendTranscript(room: String, meetingID: String, segments: [Starlings.TranscriptSegment]) async throws { throw MobileOutboxTestError.offline }
            func finalizeMeeting(room: String, meetingID: String) async throws { throw MobileOutboxTestError.offline }
        }
        // A file path under a regular file: the directory cannot be made.
        let blocker = FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-outbox-blocker-\(UUID().uuidString)")
        try Data("not a directory".utf8).write(to: blocker)
        defer { try? FileManager.default.removeItem(at: blocker) }
        let fileURL = blocker.appendingPathComponent("outbox.json")

        let outbox = MeetingArtifactOutbox(api: Refusing(), fileURL: fileURL)
        let segment = Starlings.TranscriptSegment(
            id: UUID(), meetingID: "meeting-disk", speakerID: "owner:test@example.com",
            speakerName: "Test", language: .english, startsAtMilliseconds: 0, endsAtMilliseconds: 1_000,
            text: "Nowhere to go.", isFinal: true
        )
        let delivery = await outbox.enqueue(segment, room: "rosa", meetingID: "meeting-disk")
        XCTAssertEqual(delivery, OutboxDelivery(persisted: false, uploaded: false, finalized: false))
    }

    func testStageGridShapeFollowsTheStageAndNotAFixedTable() {
        // Wide and short: people go side by side.
        let wide = StageGridLayout.equalGridPlan(
            tileCount: 3,
            in: CGSize(width: 1_400, height: 300),
            spacing: 8
        )
        XCTAssertEqual(wide.columns, 3)
        XCTAssertEqual(wide.rows, 1)

        // Five people use the largest square cells available, not the source
        // aspect ratio reported by whichever camera happens to answer first.
        let tall = StageGridLayout.equalGridPlan(
            tileCount: 5,
            in: CGSize(width: 1_440, height: 1_160),
            spacing: 8
        )
        XCTAssertEqual(tall.columns, 3)
        XCTAssertEqual(tall.rows, 2)
        let usedHeight = CGFloat(tall.rows) * tall.cell.height + CGFloat(tall.rows - 1) * 8
        XCTAssertLessThanOrEqual(usedHeight, 1_160.001)
        XCTAssertGreaterThan(usedHeight, 900)

        // Two people in a tall window stack rather than standing in thin columns.
        let pair = StageGridLayout.equalGridPlan(
            tileCount: 2,
            in: CGSize(width: 900, height: 1_200),
            spacing: 8
        )
        XCTAssertEqual(pair.columns, 1)
        XCTAssertEqual(pair.rows, 2)
    }

    func testSelfViewParksFlushWithTheStageEdgeItWasGiven() {
        let stage = CGRect(x: 10, y: 20, width: 1_000, height: 600)
        let size = CGSize(width: 200, height: 112)

        // Default: top centre, under the built-in camera.
        let top = SelfViewPlacement.top.frame(for: size, in: stage)
        XCTAssertEqual(top.midX, stage.midX, accuracy: 0.001)
        XCTAssertEqual(top.maxY, stage.maxY, accuracy: 0.001)

        // AppKit coordinates: "bottom left" is the origin corner.
        let bottomLeft = SelfViewPlacement.bottomLeft.frame(for: size, in: stage)
        XCTAssertEqual(bottomLeft.minX, stage.minX, accuracy: 0.001)
        XCTAssertEqual(bottomLeft.minY, stage.minY, accuracy: 0.001)

        let topRight = SelfViewPlacement.topRight.frame(for: size, in: stage)
        XCTAssertEqual(topRight.maxX, stage.maxX, accuracy: 0.001)
        XCTAssertEqual(topRight.maxY, stage.maxY, accuracy: 0.001)

        // Every spot stays inside the stage it was given.
        for placement in SelfViewPlacement.allCases {
            let frame = placement.frame(for: size, in: stage)
            XCTAssertTrue(stage.contains(frame), "\(placement) left the stage")
        }
    }

    func testDraggedSelfViewSnapsToTheSpotItWasLetGoNearest() {
        let stage = CGRect(x: 0, y: 0, width: 1_000, height: 600)
        let size = CGSize(width: 200, height: 112)

        // Dropped in the bottom-right quadrant, nowhere near flush.
        let dropped = CGRect(x: 760, y: 40, width: size.width, height: size.height)
        XCTAssertEqual(SelfViewPlacement.nearest(to: dropped, in: stage), .bottomRight)

        // Barely moved from the default: it stays where it was.
        let nudged = SelfViewPlacement.top.frame(for: size, in: stage).offsetBy(dx: -12, dy: -8)
        XCTAssertEqual(SelfViewPlacement.nearest(to: nudged, in: stage), .top)

        // Every spot is reachable: dropping on one returns that one.
        for placement in SelfViewPlacement.allCases {
            let frame = placement.frame(for: size, in: stage)
            XCTAssertEqual(SelfViewPlacement.nearest(to: frame, in: stage), placement)
        }
    }

    func testStageGridCellsNeverOverflowTheStage() {
        for count in 1...9 {
            let plan = StageGridLayout.equalGridPlan(
                tileCount: count,
                in: CGSize(width: 1_180, height: 640),
                spacing: 8
            )
            let width = CGFloat(plan.columns) * plan.cell.width + CGFloat(plan.columns - 1) * 8
            let height = CGFloat(plan.rows) * plan.cell.height + CGFloat(plan.rows - 1) * 8
            XCTAssertLessThanOrEqual(width, 1_180.001, "\(count) tiles overflowed horizontally")
            XCTAssertLessThanOrEqual(height, 640.001, "\(count) tiles overflowed vertically")
            XCTAssertGreaterThanOrEqual(plan.columns * plan.rows, count)
            XCTAssertEqual(plan.cell.width, plan.cell.height, accuracy: 0.001)
        }
    }

    func testFaceAnchorWeightsTheVisibleFacesAndStaysInSafeBounds() {
        let anchor = StageGridLayout.faceAnchor(for: [
            CGRect(x: 0.68, y: 0.22, width: 0.18, height: 0.24),
            CGRect(x: 0.08, y: 0.08, width: 0.08, height: 0.12)
        ])

        XCTAssertNotNil(anchor)
        XCTAssertGreaterThan(anchor?.x ?? 0, 0.55)
        XCTAssertGreaterThan(anchor?.y ?? 0, 0.16)
        XCTAssertLessThanOrEqual(anchor?.x ?? 1, 0.9)
        XCTAssertLessThanOrEqual(anchor?.y ?? 1, 0.84)
    }

    func testFaceCenteringTrackerEasesAndHoldsThroughMissedDetections() {
        var tracker = FaceCenteringTracker()
        let first = tracker.update(target: CGPoint(x: 0.82, y: 0.55), at: 0)
        XCTAssertGreaterThan(first.x, StageGridLayout.defaultCropAnchor.x)
        XCTAssertLessThan(first.x, 0.82)

        let held = tracker.update(target: nil, at: 1.5)
        XCTAssertEqual(held.x, first.x, accuracy: 0.001)

        let returning = tracker.update(target: nil, at: 3.0)
        XCTAssertLessThan(returning.x, held.x)
    }

    func testStageTileFillsItsCellWhileTheCropStaysWithinBudget() {
        // A 16:9 camera in a 16:9 cell is not cropped at all, and a cell only
        // slightly off that shape is worth filling edge to edge.
        let matching = CGRect(x: 10, y: 20, width: 320, height: 180)
        assertRect(StageGridLayout.tileRect(in: matching, sourceAspect: 16.0 / 9.0), equals: matching)

        let slightlyTall = CGRect(x: 0, y: 0, width: 320, height: 200)
        assertRect(StageGridLayout.tileRect(in: slightlyTall, sourceAspect: 16.0 / 9.0), equals: slightlyTall)
    }

    private func assertRect(
        _ rect: CGRect,
        equals expected: CGRect,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(rect.minX, expected.minX, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(rect.minY, expected.minY, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(rect.width, expected.width, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(rect.height, expected.height, accuracy: 0.001, file: file, line: line)
    }

    func testStageTileLetterboxesRatherThanCropPastTheBudget() {
        // The screenshot case: two people in a tall window, so each cell is
        // near-portrait and filling it would throw away most of the width.
        let cell = CGRect(x: 0, y: 0, width: 600, height: 1_000)
        let tile = StageGridLayout.tileRect(in: cell, sourceAspect: 16.0 / 9.0, maxCropFraction: 0.2)

        XCTAssertEqual(tile.width, 600, accuracy: 0.001)
        // Widest shape that still shows 80% of a 16:9 frame's width.
        XCTAssertEqual(tile.height, 600 / (16.0 / 9.0 * 0.8), accuracy: 0.001)
        XCTAssertTrue(cell.contains(tile))
        // Centred in the cell, so a row of tiles reads as a row.
        XCTAssertEqual(tile.midY, cell.midY, accuracy: 0.001)
    }

    func testStageVideoFrameFillsTheTileAndHonoursTheAnchor() {
        let tile = CGRect(x: 0, y: 0, width: 400, height: 400)
        let source = CGSize(width: 1_280, height: 720)

        let centred = StageGridLayout.videoFrame(
            inTile: tile,
            sourceSize: source,
            anchor: CGPoint(x: 0.5, y: 0.5)
        )
        // Aspect fill: covers the tile, keeps the source's shape.
        XCTAssertEqual(centred.height, 400, accuracy: 0.001)
        XCTAssertEqual(centred.width, 400 * 1_280 / 720, accuracy: 0.001)
        XCTAssertEqual(centred.midX, tile.midX, accuracy: 0.001)
        XCTAssertEqual(centred.midY, tile.midY, accuracy: 0.001)

        // Anchoring right pans the frame left, and never past its own edge.
        let right = StageGridLayout.videoFrame(
            inTile: tile,
            sourceSize: source,
            anchor: CGPoint(x: 0.9, y: 0.5)
        )
        XCTAssertLessThan(right.minX, centred.minX)
        XCTAssertLessThanOrEqual(right.maxX, tile.maxX + 0.001)
        XCTAssertLessThanOrEqual(right.minX, tile.minX + 0.001)
    }

    func testStageVideoFrameKeepsHeadroomWhenCroppingVertically() {
        // A portrait source in a landscape tile is the case that crops
        // vertically, and the default anchor keeps more of the top of the frame
        // — where faces are — than the bottom.
        let tile = CGRect(x: 0, y: 0, width: 400, height: 300)
        let frame = StageGridLayout.videoFrame(
            inTile: tile,
            sourceSize: CGSize(width: 720, height: 1_280)
        )
        XCTAssertEqual(frame.width, 400, accuracy: 0.001)
        // AppKit counts up from the bottom, so keeping the top of the frame
        // means sitting lower than a centred fill would.
        XCTAssertLessThan(frame.minY, tile.midY - frame.height / 2)
        // Still covering the tile: no bare strip at either edge.
        XCTAssertLessThanOrEqual(frame.minY, tile.minY + 0.001)
        XCTAssertGreaterThanOrEqual(frame.maxY, tile.maxY - 0.001)
    }

    func testMeetingDurationFormatUsesStableClockDigits() {
        XCTAssertEqual(MeetingDurationFormat.string(elapsed: 0), "0:00")
        XCTAssertEqual(MeetingDurationFormat.string(elapsed: 65), "1:05")
        XCTAssertEqual(MeetingDurationFormat.string(elapsed: 3_661), "1:01:01")
    }

    func testMeetingCountdownCountsToStartThenToEnd() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let end = start.addingTimeInterval(1_800)
        let startISO = ISODate.format(start)
        let endISO = ISODate.format(end)

        XCTAssertEqual(
            MeetingCountdown.timeLeft(startISO: startISO, endISO: endISO, now: start.addingTimeInterval(-1_500)),
            "25m"
        )
        // Underway: the countdown switches to what is left of the meeting.
        XCTAssertEqual(
            MeetingCountdown.timeLeft(startISO: startISO, endISO: endISO, now: start.addingTimeInterval(600)),
            "20m"
        )
        // Over: nothing to say, so the label goes away rather than showing "0m".
        XCTAssertNil(
            MeetingCountdown.timeLeft(startISO: startISO, endISO: endISO, now: end.addingTimeInterval(1))
        )
    }

    func testMeetingCountdownCoarsensWithDistance() {
        let target = Date(timeIntervalSince1970: 1_800_000_000)
        func label(secondsAway: TimeInterval) -> String {
            MeetingCountdown.naturalDuration(until: target, now: target.addingTimeInterval(-secondsAway))
        }
        XCTAssertEqual(label(secondsAway: 20), "now")
        XCTAssertEqual(label(secondsAway: 5 * 60), "5m")
        XCTAssertEqual(label(secondsAway: 62 * 60), "1h")       // under ~8m of noise dropped
        XCTAssertEqual(label(secondsAway: 82 * 60), "1h 20m")   // otherwise snapped to 5m
        XCTAssertEqual(label(secondsAway: 4 * 3_600 + 42 * 60), "4h 40m")
        XCTAssertEqual(label(secondsAway: 11 * 3_600), "11h")
        XCTAssertEqual(MeetingCountdown.naturalDuration(until: target, now: target), "now")
    }

    func testMeetingCountdownMinutesUntilStartGoesNegativeOnceUnderway() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let startISO = ISODate.format(start)
        XCTAssertEqual(MeetingCountdown.minutesUntilStart(startISO: startISO, now: start.addingTimeInterval(-300)), 5)
        XCTAssertEqual(MeetingCountdown.minutesUntilStart(startISO: startISO, now: start.addingTimeInterval(60)), -1)
        XCTAssertNil(MeetingCountdown.minutesUntilStart(startISO: "not a date", now: start))
    }

    func testMeetingInviteAbsoluteURLJoinsOriginAndPath() {
        XCTAssertEqual(
            MeetingInvite.absoluteURL(path: "/room/rosa", webOrigin: "https://envisioning.starlings.example/"),
            "https://envisioning.starlings.example/room/rosa"
        )
        XCTAssertEqual(
            MeetingInvite.absoluteURL(slug: "rosa", webOrigin: "https://envisioning.starlings.example"),
            "https://envisioning.starlings.example/room/rosa"
        )
        XCTAssertEqual(
            MeetingInvite.absoluteURL(slug: "rosa"),
            "https://envisioning.starlings.example/room/rosa"
        )
        XCTAssertEqual(MeetingInvite.roomSlug(fromJoinURL: "https://envisioning.starlings.example/room/rosa"), "rosa")
        XCTAssertEqual(
            MeetingInvite.roomSlug(fromJoinURL: "https://envisioning.starlings.example/room/rosa/abc-123_token"),
            "rosa"
        )
        XCTAssertNil(MeetingInvite.roomSlug(fromJoinURL: "https://envisioning.starlings.example/rosa"))
        // The short form is not a room, so it is not rewritten either.
        XCTAssertEqual(
            MeetingInvite.canonicalJoinURL("https://envisioning.starlings.example/rosa"),
            "https://envisioning.starlings.example/rosa"
        )
        XCTAssertNil(MeetingInvite.roomSlug(fromJoinURL: "https://example.com/not-a-room"))
    }

    func testMeetingInviteShareOriginKeepsLoopbackRewritesProd() {
        XCTAssertEqual(
            MeetingInvite.shareOrigin(configuredWebOrigin: "http://127.0.0.1:5173"),
            "http://127.0.0.1:5173"
        )
        XCTAssertEqual(
            MeetingInvite.shareOrigin(configuredWebOrigin: "https://legacy.org.example"),
            "https://envisioning.starlings.example"
        )
    }

    func testMeetingInviteCanonicalJoinURLPreservesLocalhostRewritesWorkersDev() {
        XCTAssertEqual(
            MeetingInvite.canonicalJoinURL("http://127.0.0.1:5173/room/rosa"),
            "http://127.0.0.1:5173/room/rosa"
        )
        XCTAssertEqual(
            MeetingInvite.canonicalJoinURL("https://legacy.org.example/room/rosa"),
            "https://envisioning.starlings.example/room/rosa"
        )
        XCTAssertEqual(
            MeetingInvite.canonicalJoinURL("https://envisioning.starlings.example/room/rosa"),
            "https://envisioning.starlings.example/room/rosa"
        )
        XCTAssertEqual(
            MeetingInvite.canonicalJoinURL("https://envisioning.starlings.example/room/rosa/abc-123_token"),
            "https://envisioning.starlings.example/room/rosa/abc-123_token"
        )
    }

    func testMeetingInviteDisplayJoinURLIncludesLoopbackPort() {
        XCTAssertEqual(
            MeetingInvite.displayJoinURL("http://127.0.0.1:5173/room/rosa"),
            "127.0.0.1:5173/room/rosa"
        )
        XCTAssertEqual(
            MeetingInvite.displayJoinURL("https://envisioning.starlings.example/room/rosa"),
            "envisioning.starlings.example/room/rosa"
        )
    }

    func testMeetingInviteTextIncludesJoinURL() {
        let text = MeetingInvite.inviteText(
            url: "https://envisioning.starlings.example/room/rosa"
        )
        XCTAssertTrue(text.contains("https://envisioning.starlings.example/room/rosa"))
    }

    func testMeetingInviteICSContainsJoinURLAndEscapesDescription() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let ics = MeetingInvite.calendarEventICS(
            title: "Design, Review",
            url: "https://envisioning.starlings.example/room/rosa",
            start: start,
            duration: 3_600,
            uid: "meet-fixed@example.com",
            stampedAt: start
        )
        XCTAssertTrue(ics.contains("BEGIN:VEVENT"))
        XCTAssertTrue(ics.contains("URL:https://envisioning.starlings.example/room/rosa"))
        XCTAssertTrue(ics.contains("SUMMARY:Design\\, Review"))
        XCTAssertTrue(ics.contains("DESCRIPTION:Join: https://envisioning.starlings.example/room/rosa"))
        XCTAssertTrue(ics.contains("\r\n"))
    }

    /// meet#863: Envisioning's calendar files read as before; another workspace names itself.
    func testCalendarProductIDNamesTheWorkspace() {
        XCTAssertEqual(EnvisioningDeployment.calendarProductID(workspaceName: "Envisioning"), "-//Envisioning//Meet//EN")
        XCTAssertEqual(EnvisioningDeployment.calendarProductID(workspaceName: "HQ"), "-//Starlings//HQ//EN")
        XCTAssertEqual(EnvisioningDeployment.calendarProductID(workspaceName: "A/B\nC"), "-//Starlings//ABC//EN")
        XCTAssertEqual(EnvisioningDeployment.calendarProductID(workspaceName: " "), "-//Starlings//Starlings//EN")
    }

    func testMeetingInviteNextQuarterHourStepsForward() {
        let calendar = Calendar(identifier: .gregorian)
        var components = DateComponents()
        components.year = 2026
        components.month = 8
        components.day = 9
        components.hour = 15
        components.minute = 7
        components.second = 30
        components.timeZone = TimeZone(secondsFromGMT: 0)
        let date = calendar.date(from: components)!
        let next = MeetingInvite.nextQuarterHour(from: date)
        XCTAssertEqual(Calendar.current.component(.minute, from: next) % 15, 0)
        XCTAssertGreaterThan(next, date)
    }

    func testScheduleTimeZonePresetsMatchIANACities() {
        XCTAssertEqual(StarlingsScheduleTimeZone.newYork.identifier, "America/New_York")
        XCTAssertEqual(StarlingsScheduleTimeZone.saoPaulo.identifier, "America/Sao_Paulo")
        XCTAssertEqual(StarlingsScheduleTimeZone.london.identifier, "Europe/London")
        XCTAssertEqual(StarlingsScheduleTimeZone.amsterdam.identifier, "Europe/Amsterdam")
        XCTAssertEqual(StarlingsScheduleTimeZone.riyadh.identifier, "Asia/Riyadh")
        XCTAssertEqual(StarlingsScheduleTimeZone.dubai.identifier, "Asia/Dubai")
        XCTAssertEqual(StarlingsScheduleTimeZone.allCases.count, 10)
    }

    func testScheduleTimeZoneMatchesSystemAndPersists() {
        XCTAssertEqual(
            StarlingsScheduleTimeZone.matchingSystem(system: TimeZone(identifier: "Europe/Amsterdam")!),
            .amsterdam
        )
        XCTAssertEqual(
            StarlingsScheduleTimeZone.matchingSystem(system: TimeZone(identifier: "America/New_York")!),
            .newYork
        )
        let defaults = UserDefaults(suiteName: "meet.test.schedule.timezone")!
        defaults.removePersistentDomain(forName: "meet.test.schedule.timezone")
        StarlingsScheduleTimeZone.dubai.savePreferred(defaults: defaults)
        XCTAssertEqual(StarlingsScheduleTimeZone.loadPreferred(defaults: defaults), .dubai)
    }

    func testOnlyPoorAndLostCountAsWeakConnections() {
        XCTAssertTrue(MeetingConnectionQuality.poor.isWeak)
        XCTAssertTrue(MeetingConnectionQuality.lost.isWeak)
        XCTAssertFalse(MeetingConnectionQuality.good.isWeak)
        XCTAssertFalse(MeetingConnectionQuality.excellent.isWeak)
        // `unknown` means "not scored yet". Treating it as weak would flash a
        // warning on every tile for the first seconds of every call.
        XCTAssertFalse(MeetingConnectionQuality.unknown.isWeak)

        XCTAssertEqual(MeetingConnectionQuality.poor.tileWarning, "Weak connection")
        XCTAssertEqual(MeetingConnectionQuality.lost.tileWarning, "Connection lost")
        XCTAssertNil(MeetingConnectionQuality.good.tileWarning)
        XCTAssertNil(MeetingConnectionQuality.unknown.tileWarning)
    }

    @MainActor
    func testQualityTrackerAccumulatesTimeAndKeepsCountersCumulative() {
        let tracker = MeetingQualityTracker()
        let start = Date(timeIntervalSince1970: 1_000)
        tracker.start(at: start)
        tracker.record(quality: .excellent, at: start)
        tracker.record(quality: .poor, at: start.addingTimeInterval(10))
        tracker.recordReconnect()

        let first = tracker.report(client: .mac, at: start.addingTimeInterval(15))
        XCTAssertEqual(first?.connectedMs, 15_000)
        XCTAssertEqual(first?.excellentMs, 10_000)
        XCTAssertEqual(first?.poorMs, 5_000)
        XCTAssertEqual(first?.reconnectCount, 1)
        XCTAssertEqual(first?.worstQuality, .poor)

        // A second report must extend the same totals, never restart them —
        // the server upserts rather than adds.
        let second = tracker.report(client: .mac, at: start.addingTimeInterval(25))
        XCTAssertEqual(second?.connectedMs, 25_000)
        XCTAssertEqual(second?.excellentMs, 10_000)
        XCTAssertEqual(second?.poorMs, 15_000)
    }

    func testDiagnosticsLogCollapsesRepeatsAndKeepsTheNewestFailures() throws {
        let log = StarlingsDiagnosticsLog()
        XCTAssertTrue(log.reportLines().isEmpty)

        // A lease down for minutes is the case this exists for: one line with a
        // count, not one line per ten-second retry.
        let lease = StarlingsError(code: "host.lease_heartbeat", title: "Lease reconnecting", message: "", diagnostic: "HTTP 401 owner_auth_required")
        for _ in 0..<12 { log.record(lease, context: "host lease heartbeat") }
        XCTAssertEqual(log.reportLines().count, 1)
        let collapsed = try XCTUnwrap(log.reportLines().first)
        XCTAssertTrue(collapsed.contains("host lease heartbeat — host.lease_heartbeat — HTTP 401 owner_auth_required"))
        XCTAssertTrue(collapsed.contains("×12"))

        // Only consecutive repeats collapse, so an alternating pair stays legible.
        log.record(.sessionLost, context: "disconnected")
        log.record(lease, context: "host lease heartbeat")
        XCTAssertEqual(log.reportLines().count, 3)
    }

    func testDiagnosticsLogStaysBoundedAndDropsTheOldest() {
        let log = StarlingsDiagnosticsLog()
        for index in 0..<80 {
            log.record(StarlingsError(code: "test.\(index)", title: "", message: ""), context: "probe")
        }
        let lines = log.reportLines()
        XCTAssertEqual(lines.count, 50)
        XCTAssertTrue(lines.first?.contains("test.30") == true)
        XCTAssertTrue(lines.last?.contains("test.79") == true)
    }

    @MainActor
    func testQualityTrackerReportsNothingBeforeAMeetingStarts() {
        let tracker = MeetingQualityTracker()
        XCTAssertNil(tracker.report(client: .mac))
        tracker.start()
        XCTAssertNotNil(tracker.report(client: .mac))
        tracker.reset()
        XCTAssertNil(tracker.report(client: .mac))
    }

    @MainActor
    func testHostWakeAssertionBeginAndEnd() {
        let assertion = HostWakeAssertion()
        XCTAssertFalse(assertion.isActive)
        assertion.begin(reason: "Meet unit test wake assertion")
        XCTAssertTrue(assertion.isActive)
        XCTAssertFalse(assertion.statusDetail.isEmpty)
        assertion.end()
        XCTAssertFalse(assertion.isActive)
        XCTAssertEqual(assertion.statusDetail, "Sleep prevention off")
    }

    func testLobbyKnockAlertsDefaultOnAndPersist() {
        let key = "meet.lobbyKnockAlertsEnabled"
        let previous = UserDefaults.standard.object(forKey: key)
        defer {
            if let previous {
                UserDefaults.standard.set(previous, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }

        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertTrue(LobbyKnockPreferences.alertsEnabled)

        LobbyKnockPreferences.alertsEnabled = false
        XCTAssertFalse(LobbyKnockPreferences.alertsEnabled)
        XCTAssertEqual(UserDefaults.standard.object(forKey: key) as? Bool, false)

        LobbyKnockPreferences.alertsEnabled = true
        XCTAssertTrue(LobbyKnockPreferences.alertsEnabled)
    }

    func testPublicEventsICSParsesAllDayAndTimedEvents() throws {
        let ics = """
        BEGIN:VCALENDAR
        VERSION:2.0
        BEGIN:VEVENT
        UID:all-day@example.com
        DTSTART;VALUE=DATE:20260824
        DTEND;VALUE=DATE:20260825
        SUMMARY:Brasil Futures Forum
        LOCATION:São Paulo
        URL:https://www.org.example/events/brasil
        END:VEVENT
        BEGIN:VEVENT
        UID:timed@example.com
        DTSTART:20260817T153000Z
        DTEND:20260817T170000Z
        SUMMARY:Coding for Non-Coders
        DESCRIPTION:Sign up: https://luma.com/example
        LOCATION:Zoom
        URL:https://www.org.example/events/coding
        END:VEVENT
        BEGIN:VEVENT
        UID:folded@example.com
        DTSTART:20260916T130000Z
        SUMMARY:Folded
         Title
        END:VEVENT
        END:VCALENDAR
        """
        let events = PublicEventsCalendar.parseICS(ics)
        XCTAssertEqual(events.count, 3)

        let allDay = try XCTUnwrap(events.first { $0.id == "all-day@example.com" })
        XCTAssertTrue(allDay.isAllDay)
        XCTAssertEqual(allDay.start, "2026-08-24")
        XCTAssertEqual(allDay.end, "2026-08-25")
        XCTAssertEqual(allDay.title, "Brasil Futures Forum")
        XCTAssertEqual(allDay.location, "São Paulo")

        let timed = try XCTUnwrap(events.first { $0.id == "timed@example.com" })
        XCTAssertFalse(timed.isAllDay)
        XCTAssertEqual(timed.start, "2026-08-17T15:30:00Z")
        XCTAssertEqual(timed.end, "2026-08-17T17:00:00Z")

        let folded = try XCTUnwrap(events.first { $0.id == "folded@example.com" })
        XCTAssertEqual(folded.title, "FoldedTitle")
        XCTAssertTrue(
            folded.end.hasPrefix("2026-09-16T14:00:00"),
            "expected default 60m end, got \(folded.end)"
        )
        // Events now come from the shared projection, not the ICS feed; the
        // parser above is kept only until it and this coverage go together.
        XCTAssertTrue(
            PublicEventsCalendar.feedURL.absoluteString.hasSuffix("/public/events"),
            "expected the shared projection endpoint, got \(PublicEventsCalendar.feedURL.absoluteString)"
        )
    }

    func testCalendarAttendeeListingHidesSelfSortsExternalAndMarksMembers() {
        let attendees: [CalendarAttendeeSummary] = [
            .init(name: "Ana", email: "ana@example.com", status: "accepted", optional: false, isSelf: false),
            .init(name: "Rosa", email: "rosa@example.com", status: "needsAction", optional: false, isSelf: true),
            .init(name: "Client", email: "client@bff.com.br", status: "accepted", optional: false, isSelf: false),
            .init(name: "Bo", email: "bo@example.org", status: "tentative", optional: false, isSelf: false),
            .init(name: "Vendor", email: "vendor@example.net", status: "needsAction", optional: false, isSelf: false),
        ]

        let listed = attendees.forCalendarListing
        XCTAssertEqual(listed.map(\.name), ["Client", "Vendor", "Ana", "Bo"])
        XCTAssertFalse(listed.contains(where: \.isSelf))

        let label = attendees.calendarListingLabel()
        XCTAssertEqual(
            label,
            """
            Accepted · Client
            Pending · Vendor
            Accepted · Ana · Member
            Tentative · Bo · Member
            """
        )
        XCTAssertFalse(label.contains("Rosa"))
        XCTAssertTrue(CalendarAttendeeSummary.isMemberAddress("ROSA@EXAMPLE.COM"))
        XCTAssertTrue(CalendarAttendeeSummary.isMemberAddress("person@example.org"))
        XCTAssertFalse(CalendarAttendeeSummary.isMemberAddress("rosa@example.net"))
    }

    func testCalendarAttendeeGlyphSurvivesDisplayNameAndEmbeddedEmail() {
        // BFF-shaped row: Google sent a person name + .io email (not the email as the label).
        let named = CalendarAttendeeSummary(
            name: "Dara Cavalheiro",
            email: "dara@example.org",
            status: "accepted",
            optional: false,
            isSelf: false
        )
        XCTAssertTrue(named.isMember)
        XCTAssertEqual(named.listingLine(), "Accepted · Dara Cavalheiro · Member")

        // Status-shaped row: no displayName. CRM normally resolves this before
        // it reaches the client; if it does not, show the address by itself.
        let bare = CalendarAttendeeSummary(
            name: "felix@example.org",
            email: "",
            status: "needsAction",
            optional: false,
            isSelf: false
        )
        XCTAssertTrue(bare.isMember)
        XCTAssertEqual(bare.listingLine(), "Pending · felix@example.org · Member")
        XCTAssertEqual(
            bare.listingLine(contactNames: ["felix@example.org": "Felix Andrade"]),
            "Pending · Felix Andrade · Member"
        )
        XCTAssertEqual(
            CalendarAttendeeSummary(
                name: "Skip",
                email: "skip@example.net",
                status: "declined",
                optional: false,
                isSelf: false
            ).statusSymbolName,
            "xmark"
        )

        // Angle-bracket / mailto forms that calendar UIs sometimes surface.
        XCTAssertTrue(CalendarAttendeeSummary.isMemberAddress("Dara Cavalheiro <dara@example.org>"))
        XCTAssertTrue(CalendarAttendeeSummary.isMemberAddress("mailto:ROSA@EXAMPLE.COM"))
        XCTAssertFalse(CalendarAttendeeSummary.isMemberAddress("Dara Cavalheiro"))
        XCTAssertFalse(CalendarAttendeeSummary.isMemberAddress("Someone <person@example.net>"))
        XCTAssertEqual(
            CalendarAttendeeSummary(
                name: "Theo Rezende <theo@example.org>",
                email: "",
                status: "accepted",
                optional: false,
                isSelf: false
            ).listingDisplayName(),
            "Theo Rezende"
        )
    }

    func testCalendarAttendeeContactActionsUseOnlyCanonicalCoreURLs() {
        let inCore = CalendarAttendeeSummary(
            name: "Ana",
            email: "ANA@example.net",
            crmUrl: "https://core.org.example/contacts/contact-123",
            status: "accepted",
            optional: false,
            isSelf: false
        )
        XCTAssertEqual(
            inCore.coreURL?.absoluteString,
            "https://core.org.example/contacts/contact-123"
        )
        XCTAssertEqual(inCore.normalizedEmail, "ana@example.net")

        let invalid = CalendarAttendeeSummary(
            name: "Someone",
            email: "someone@example.net",
            crmUrl: "https://example.com/contacts/contact-123",
            status: "accepted",
            optional: false,
            isSelf: false
        )
        XCTAssertNil(invalid.coreURL)
    }

    /// The request that leaves the Mac carries a coarse coordinate, the Mac's
    /// own time zone, and nothing else. The time zone matters twice: it is why
    /// a row lines up with the column drawn over it, and it is the only thing
    /// in the URL that says anything at all about the person asking.
    func testWeatherForecastURLCarriesOnlyACoarseCoordinateAndTheLocalZone() {
        let place = WeatherPlace(name: "Lisbon, Portugal", latitude: 38.716_67, longitude: -9.133_33)
        let url = WeatherForecastService.forecastURL(
            for: place,
            timeZone: TimeZone(identifier: "Europe/Lisbon")!,
            unit: "celsius"
        )
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })

        XCTAssertEqual(url.host, "api.open-meteo.com")
        XCTAssertEqual(url.path, "/v1/forecast")
        XCTAssertEqual(query["latitude"], "38.72")
        XCTAssertEqual(query["longitude"], "-9.13")
        XCTAssertEqual(query["timezone"], "Europe/Lisbon")
        XCTAssertEqual(query["temperature_unit"], "celsius")
        XCTAssertEqual(query["daily"], "weather_code,temperature_2m_max,temperature_2m_min")
        XCTAssertFalse(url.absoluteString.contains("Lisbon, Portugal"))
    }

    /// Two decimals is a little over a kilometre. Rounding happens on the way
    /// into storage, so a precise coordinate can never be persisted and then
    /// sent by some later code path that forgot to round.
    func testWeatherPlaceRoundsCoordinatesOnTheWayIn() {
        let place = WeatherPlace(name: "Desk", latitude: 38.716_674_1, longitude: -9.133_339_9)
        XCTAssertEqual(place.latitude, 38.72, accuracy: 0.0001)
        XCTAssertEqual(place.longitude, -9.13, accuracy: 0.0001)
    }

    func testWeatherConditionMapsWMOCodesAndRefusesUnknownOnes() {
        XCTAssertEqual(WeatherCondition.code(0)?.symbolName, "sun.max")
        XCTAssertEqual(WeatherCondition.code(2)?.symbolName, "cloud.sun")
        XCTAssertEqual(WeatherCondition.code(3)?.symbolName, "cloud")
        XCTAssertEqual(WeatherCondition.code(45)?.symbolName, "cloud.fog")
        XCTAssertEqual(WeatherCondition.code(61)?.symbolName, "cloud.rain")
        XCTAssertEqual(WeatherCondition.code(80)?.symbolName, "cloud.sun.rain")
        XCTAssertEqual(WeatherCondition.code(95)?.symbolName, "cloud.bolt.rain")
        // An unmapped code draws nothing rather than a confidently wrong sky.
        XCTAssertNil(WeatherCondition.code(7))
        XCTAssertNil(WeatherCondition.code(-1))
    }

    /// Parallel arrays, so a short one is a real answer and not a decode
    /// failure — the days it cannot complete are the only ones dropped.
    func testWeatherDecodeDropsRaggedDaysAndRoundsTemperatures() {
        let response = OpenMeteoForecastResponse(
            daily: .init(
                time: ["2026-08-18", "2026-08-19", "2026-08-20"],
                weatherCode: [3, 61, 0],
                high: [21.4, 20.6],
                low: [15.5, 12.2]
            )
        )
        let days = WeatherForecastService.decode(response)

        XCTAssertEqual(days.count, 2)
        XCTAssertEqual(days["2026-08-18"]?.summary, "21°/16°")
        XCTAssertEqual(days["2026-08-19"]?.summary, "21°/12°")
        XCTAssertEqual(days["2026-08-19"]?.condition.symbolName, "cloud.rain")
        XCTAssertNil(days["2026-08-20"])
    }

    /// Open-Meteo pads the far end of its window with `null` where it has no
    /// data yet. Decoding those as non-optional threw away the entire
    /// response over one missing day — a total, silent failure that looked
    /// exactly like the network being down, on every day of every view.
    func testWeatherDecodeKeepsGoodDaysWhenTheTailIsNull() {
        let response = OpenMeteoForecastResponse(
            daily: .init(
                time: ["2026-08-18", "2026-08-19", "2026-08-20"],
                weatherCode: [3, 61, nil],
                high: [21.4, 20.6, nil],
                low: [15.5, 12.2, nil]
            )
        )
        let days = WeatherForecastService.decode(response)

        XCTAssertEqual(days.count, 2)
        XCTAssertEqual(days["2026-08-18"]?.summary, "21°/16°")
        XCTAssertEqual(days["2026-08-19"]?.condition.symbolName, "cloud.rain")
        XCTAssertNil(days["2026-08-20"])
    }

    /// A null in any one of the three arrays drops that day alone.
    func testWeatherDecodeDropsADayMissingOnlyItsTemperature() {
        let response = OpenMeteoForecastResponse(
            daily: .init(
                time: ["2026-08-18", "2026-08-19"],
                weatherCode: [3, 3],
                high: [21.4, nil],
                low: [15.5, 12.2]
            )
        )
        let days = WeatherForecastService.decode(response)

        XCTAssertEqual(days.count, 1)
        XCTAssertNotNil(days["2026-08-18"])
        XCTAssertNil(days["2026-08-19"])
    }

    func testWeatherDecodeSkipsDaysWithUnmappableCodes() {
        let response = OpenMeteoForecastResponse(
            daily: .init(time: ["2026-08-18"], weatherCode: [7], high: [21.4], low: [15.5])
        )
        XCTAssertTrue(WeatherForecastService.decode(response).isEmpty)
    }

    /// The geocoder names a city's own district as its region often enough
    /// that "Lisbon, Lisbon, Portugal" would be the common case.
    func testWeatherPlaceNameDropsARegionThatRepeatsTheCity() {
        XCTAssertEqual(
            WeatherForecastService.displayName(name: "Lisbon", region: "Lisbon", country: "Portugal"),
            "Lisbon, Portugal"
        )
        XCTAssertEqual(
            WeatherForecastService.displayName(name: "Austin", region: "Texas", country: "United States"),
            "Austin, Texas, United States"
        )
        XCTAssertEqual(
            WeatherForecastService.displayName(name: "Berlin", region: nil, country: nil),
            "Berlin"
        )
    }

    /// A lookup that could not be made is not a lookup that found nothing.
    /// Collapsing the two is what made Settings blame the user's spelling for
    /// a network fault.
    func testWeatherLookupSeparatesNoMatchFromUnreachable() {
        XCTAssertEqual(WeatherLookupResult.matches([]), .matches([]))
        XCTAssertNotEqual(WeatherLookupResult.matches([]), .unreachable("offline"))
    }

    /// Weather never takes over the screen, but it is always recorded — a
    /// forecast that quietly decodes to nothing looks exactly like one that is
    /// merely past its horizon.
    func testWeatherErrorsAreQuietButCarryCodes() {
        let forecast = StarlingsError.weatherForecastUnavailable("badServerResponse")
        XCTAssertEqual(forecast.code, "weather.forecast_unavailable")
        XCTAssertEqual(forecast.severity, .silent)
        XCTAssertTrue(forecast.logLine.contains("badServerResponse"))

        let lookup = StarlingsError.weatherLookupUnavailable("HTTP 503")
        XCTAssertEqual(lookup.code, "weather.lookup_unavailable")
        XCTAssertEqual(lookup.severity, .notice)
        XCTAssertNotEqual(lookup.severity, .blocking)
        XCTAssertEqual(lookup.recovery, .retry)
    }

    /// A stale cache still draws, so it must not raise the banner — but the
    /// failure is reported either way.
    func testWeatherOutcomeDistinguishesStaleFromEmpty() {
        let day = DailyForecast(
            day: "2026-08-18",
            condition: WeatherCondition.code(3)!,
            high: 21,
            low: 16
        )
        let stale = WeatherForecastOutcome(days: ["2026-08-18": day], failure: "offline")
        let empty = WeatherForecastOutcome(days: [:], failure: "offline")
        XCTAssertNotNil(stale.failure)
        XCTAssertFalse(stale.days.isEmpty)
        XCTAssertTrue(empty.days.isEmpty)
    }

    /// Every mapped code must name a symbol that actually exists. A typo here
    /// draws nothing at all, silently, on one weather condition — the kind of
    /// gap that only shows up on the day the weather changes.
    func testEveryMappedWeatherCodeNamesARealSymbol() {
        let mapped = (-1...100).compactMap { WeatherCondition.code($0) }
        XCTAssertFalse(mapped.isEmpty)
        for condition in mapped {
            XCTAssertNotNil(
                NSImage(systemSymbolName: condition.symbolName, accessibilityDescription: nil),
                "no SF Symbol named \(condition.symbolName) for \(condition.label)"
            )
        }
    }

    func testWeatherSearchRefusesAnEmptyQuery() {
        XCTAssertNil(WeatherForecastService.searchURL(matching: "   "))
        XCTAssertEqual(
            WeatherForecastService.searchURL(matching: " Lisbon ")?.host,
            "geocoding-api.open-meteo.com"
        )
    }

    /// Switched off is as good as unset: both mean no place, and no place is
    /// what stops the fetch from ever being attempted.
    func testWeatherActivePlaceNeedsBothASwitchAndACity() throws {
        let suite = "meet.tests.weather"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertNil(WeatherPreferences.activePlace(defaults))

        WeatherPreferences.setPlace(
            WeatherPlace(name: "Lisbon, Portugal", latitude: 38.72, longitude: -9.13),
            defaults
        )
        XCTAssertEqual(WeatherPreferences.activePlace(defaults)?.name, "Lisbon, Portugal")

        WeatherPreferences.setShowsWeather(false, defaults)
        XCTAssertNil(WeatherPreferences.activePlace(defaults))
        // Still remembered, so switching back on does not ask for the city again.
        XCTAssertEqual(WeatherPreferences.place(defaults)?.name, "Lisbon, Portugal")

        WeatherPreferences.setShowsWeather(true, defaults)
        WeatherPreferences.setPlace(nil, defaults)
        XCTAssertNil(WeatherPreferences.activePlace(defaults))
    }

    func testHomeGridCellsStaySquareAndTheLatticeNeverReflows() {
        // The bug this replaced: whole cells centred in the view meant that
        // crossing a multiple of the pitch snapped the origin back a cell and
        // slid the whole field sideways, which during a live resize reads as
        // the grid stuttering under the cursor.
        let pitch = HomeGridLattice.pitch
        for span in stride(from: 320.0 as CGFloat, through: 1600, by: 7) {
            let indices = HomeGridLattice.indices(span: span)
            let positions = indices.map { HomeGridLattice.position(of: $0, span: span) }
            // Every gap is one pitch, on both axes, at every size: cells are 1:1.
            for (lower, upper) in zip(positions, positions.dropFirst()) {
                XCTAssertEqual(upper - lower, pitch, accuracy: 0.0001)
            }
            // And the lattice always reaches past both edges, so the field
            // never ends short of the fade.
            XCTAssertLessThanOrEqual(positions.first ?? 0, 0)
            XCTAssertGreaterThanOrEqual(positions.last ?? 0, span)
        }

        // A line moves by exactly half the growth — the field slides
        // continuously with the centre instead of re-flowing.
        let before = HomeGridLattice.position(of: 3, span: 900)
        let after = HomeGridLattice.position(of: 3, span: 900 + pitch * 1.5)
        XCTAssertEqual(after - before, pitch * 0.75, accuracy: 0.0001)
    }

    func testHomeGridLineKeepsItsBrightnessWhileTheWindowResizes() {
        let baked = HomeGridLattice.bakeMultipliers()
        // Alpha is keyed off the signed index, so growing the window can only
        // add lines at the edges — every line already on screen keeps both its
        // place and its brightness.
        let narrow = HomeGridLattice.indices(span: 700)
        let wide = HomeGridLattice.indices(span: 1340)
        XCTAssertTrue(wide.contains(narrow.lowerBound))
        XCTAssertTrue(wide.contains(narrow.upperBound))
        XCTAssertGreaterThan(
            HomeGridLattice.alpha(baked.columns, index: -5, base: HomeGridLattice.darkBaseAlpha),
            0
        )

        // Columns and rows draw from separate sequences, or column n and row n
        // share a brightness and the eye picks the diagonal out of the field.
        XCTAssertNotEqual(baked.columns, baked.rows)
        XCTAssertEqual(baked.columns.count, HomeGridLattice.bakedLines)
        for multiplier in baked.columns + baked.rows {
            XCTAssertGreaterThanOrEqual(multiplier, HomeGridLattice.multiplierMin)
            XCTAssertLessThanOrEqual(multiplier, HomeGridLattice.multiplierMax)
        }

        // Past the baked range a line falls back to the average rather than
        // vanishing.
        XCTAssertEqual(
            HomeGridLattice.alpha(baked.columns, index: 9000, base: HomeGridLattice.darkBaseAlpha),
            HomeGridLattice.darkBaseAlpha
        )

        // Same seed on both clients, so the Mac and the phone bake one field.
        XCTAssertEqual(baked.columns, HomeGridLattice.bakeMultipliers().columns)
    }
}

/// Stand-in for "the network is down" in the shared outbox test.
enum MobileOutboxTestError: Error {
    case offline
}

/// The menu bar's WORK rows are capped (meet#1172).
@MainActor
final class StarlingsMenubarGlanceRowTests: XCTestCase {
    func testADecisionRowKeepsItsKindAndDefaultDate() {
        let row = StarlingsMenubarController.glanceRow(
            title: "Should the pilot workspace keep its own Google client for calendar?",
            detail: "Decision · Asked by Factory: Meet · Keep the shared client until verification lands · Default by 16 Oct"
        )
        XCTAssertLessThanOrEqual(row.count, 60)
        XCTAssertTrue(row.hasSuffix("Decision · Default by 16 Oct"), row)
    }

    func testAShortRowIsUnchanged() {
        XCTAssertEqual(StarlingsMenubarController.glanceRow(title: "Ship it", detail: "Unread"), "Ship it · Unread")
    }

    func testOneLongDetailIsClipped() {
        let row = StarlingsMenubarController.glanceRow(title: "Kickoff", detail: String(repeating: "word ", count: 30))
        XCTAssertLessThanOrEqual(row.count, 60)
        XCTAssertTrue(row.hasSuffix("…"), row)
    }
}
