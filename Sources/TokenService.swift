import Foundation
import StarlingsContracts

protocol ConnectionDetailsProviding: Sendable {
    func connectionDetails(for configuration: MeetingConfiguration) async throws -> ConnectionDetails
}


struct HTTPConnectionDetailsProvider: ConnectionDetailsProviding {
    let apiBaseURL: URL
    let session: URLSession
    let ownerSessionStore: OwnerSessionStore
    let allowsDevelopmentAuthentication: Bool

    init(
        apiBaseURL: URL = HTTPConnectionDetailsProvider.configuredAPIBase,
        session: URLSession = .shared,
        ownerSessionStore: OwnerSessionStore = OwnerSessionStore(),
        allowsDevelopmentAuthentication: Bool = HTTPConnectionDetailsProvider.configuredDevelopmentAuthentication
    ) {
        self.apiBaseURL = apiBaseURL
        self.session = session
        self.ownerSessionStore = ownerSessionStore
        self.allowsDevelopmentAuthentication = allowsDevelopmentAuthentication
    }

    /// The active workspace's API base (`StarlingsWorkspace.active`).
    static var configuredAPIBase: URL { StarlingsWorkspace.active.apiBaseURL }

    static var configuredDevelopmentAuthentication: Bool {
        if let value = Bundle.main.object(forInfoDictionaryKey: "MEET_ALLOW_DEV_AUTH") as? Bool {
            return value
        }
        return (Bundle.main.object(forInfoDictionaryKey: "MEET_ALLOW_DEV_AUTH") as? String)?
            .lowercased() == "yes"
    }

    func connectionDetails(for configuration: MeetingConfiguration) async throws -> ConnectionDetails {
        let owner = configuration.identity.hostIdentity
        guard configuration.role == .host, owner.isValid else {
            throw StarlingsError.authenticationRequired()
        }
        var credentials = try await credentials(for: owner)
        var result = try await start(configuration, credentials: credentials)
        if result.response.statusCode == 401 {
            // An expired access token with a good refresh token is a silent
            // fix, not a sign-in prompt: renew and start once more. Only a
            // token the Worker will not renew ends the session; a Worker that
            // could not be asked (offline, timeout, 5xx) is a failed start,
            // and the session stays where it is.
            switch await OwnerSessionRenewer.shared.renewIfNeeded(force: true) {
            case .renewed:
                if let renewed = try ownerSessionStore.load() {
                    credentials = renewed
                    result = try await start(configuration, credentials: credentials)
                }
            case .unavailable:
                throw StarlingsError.service(
                    status: 503,
                    serverCode: nil,
                    serverMessage: "Your sign-in couldn’t be renewed. Check your connection and try again.",
                    operation: String(localized: "Couldn’t start the room")
                )
            case .stillValid, .nothingToRenew, .refused:
                break
            }
        }
        if result.response.statusCode == 401 {
            guard allowsDevelopmentAuthentication else {
                try ownerSessionStore.expire()
                throw StarlingsError.authenticationRequired()
            }
            try ownerSessionStore.clear()
            credentials = try await createDevelopmentSession(for: owner)
            try ownerSessionStore.save(credentials)
            result = try await start(configuration, credentials: credentials)
        }
        try validate(response: result.response, data: result.data)
        return try JSONDecoder().decode(ConnectionDetails.self, from: result.data)
    }

    private func credentials(for owner: HostIdentity) async throws -> OwnerSessionCredentials {
        if let stored = try ownerSessionStore.load() { return stored }
        guard allowsDevelopmentAuthentication else { throw StarlingsError.authenticationRequired() }
        let credentials = try await createDevelopmentSession(for: owner)
        try ownerSessionStore.save(credentials)
        return credentials
    }

    private func start(
        _ configuration: MeetingConfiguration,
        credentials: OwnerSessionCredentials
    ) async throws -> (data: Data, response: HTTPURLResponse) {
        let request = makeStartRequest(for: configuration, accessToken: credentials.accessToken)
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw StarlingsError.transport(error, operation: String(localized: "Couldn’t start the room"))
        }
        guard let response = response as? HTTPURLResponse else { throw StarlingsError.invalidResponse(operation: String(localized: "Couldn’t start the room")) }
        return (data, response)
    }

    func makeStartRequest(for configuration: MeetingConfiguration, accessToken: String) -> URLRequest {
        let endpoint = apiBaseURL
            .appending(path: "rooms")
            .appending(path: configuration.room.rawValue)
            .appending(path: "start")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Name the device so this Mac gets its own LiveKit identity. Without
        // it the bare account address is the identity, and a second device of
        // the same owner would evict this one from its own meeting.
        request.httpBody = try? JSONEncoder().encode(HostSessionStartRequest(device: .mac))
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 10
        return request
    }

    private func createDevelopmentSession(for owner: HostIdentity) async throws -> OwnerSessionCredentials {
        let endpoint = apiBaseURL.appending(path: "dev/session")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(DevelopmentSessionRequest(
            name: owner.name.trimmingCharacters(in: .whitespacesAndNewlines),
            email: owner.email.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        ))
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw StarlingsError.transport(error, operation: String(localized: "Couldn’t start the room"))
        }
        try validate(response: response, data: data)
        return try JSONDecoder().decode(OwnerSessionCredentials.self, from: data)
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw StarlingsError.invalidResponse(operation: String(localized: "Couldn’t start the room"))
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let body = try? JSONDecoder().decode(ServiceErrorResponse.self, from: data)
            throw StarlingsError.service(
                status: httpResponse.statusCode,
                serverCode: body?.code,
                serverMessage: body?.error ?? String(localized: "The meeting service didn’t explain what went wrong."),
                operation: String(localized: "Couldn’t start the room")
            )
        }
    }
}

private struct ServiceErrorResponse: Decodable {
    let error: String
    /// Stable cause from `packages/contracts` — present on every coded response.
    let code: String?
}
