import Foundation
import StarlingsContracts

// The one request layer under both API clients (slice 1).
//
// `MeetingControlAPI` on the Mac and `StarlingsAPI` on the phone keep their own
// methods, and each method still names its route. This file builds every
// `URLRequest` those methods send, puts the bearer token in, sends it, reads
// the Worker's `{error, code}` body on a non-2xx answer, decodes with the
// generated `StarlingsContracts` types, and tells the snapshot store which lists a
// write made stale. Shared into Starlings-iOS through `project.yml`.
//
// The policy under every request lives here too: the default
// timeout, the one retry of an idempotent request, the snapshot read with its
// validator, and the lists a named write makes stale. All of it comes from
// `StarlingsRequestPolicy`; neither client keeps a copy.
//
// The replay of a refused owner session is here too: renew once,
// send once more, report a refusal. How a client renews, and how it tells the
// app about a refusal, is its own `StarlingsOwnerSessionRenewal`.

/// Gives the bearer token for one request.
///
/// The Mac reads it from `OwnerSessionStore`, the phone from
/// `MobileOwnerCredentials`. A lobby token or a meeting's artifact token is a
/// `StarlingsBearerToken`.
protocol StarlingsBearerSource: Sendable {
    /// The token, or nil when nobody is signed in.
    func meetBearerToken() throws -> String?

    /// Owner credentials may upload the bounded operational-error spool. Guest
    /// lobby and artifact tokens must never be used for that endpoint.
    var isMeetOwnerSession: Bool { get }
}

extension StarlingsBearerSource {
    var isMeetOwnerSession: Bool { false }
}

/// A token the caller already holds.
struct StarlingsBearerToken: StarlingsBearerSource {
    let value: String
    let isMeetOwnerSession: Bool

    init(_ value: String, isOwnerSession: Bool = false) {
        self.value = value
        self.isMeetOwnerSession = isOwnerSession
    }

    func meetBearerToken() -> String? { value }
}

/// Why a request failed, before a client says it in its own words.
enum StarlingsHTTPFailure: Error {
    /// The bearer source had no token. Nothing was sent.
    case signedOut
    /// URLSession failed: offline, DNS, timeout, cancelled.
    case transport(any Error)
    /// The answer was not HTTP.
    case notHTTP
    /// The Worker answered with a non-2xx status. `code`, `message` and
    /// `requestID` come from its `{error, code, request_id}` body, when the
    /// body had them. `requestID` is only ever a UUID.
    case status(Int, code: String?, message: String?, requestID: String?)
    /// A 2xx body that did not decode as the named type.
    case undecodable(type: String)
}

/// The snapshot lists one write made stale, for one owner.
struct StarlingsStaleSnapshots: Equatable, Sendable {
    let owner: String
    let prefixes: [String]

    /// Nil when there is nothing to invalidate, so a caller can pass the
    /// result straight to `accept`.
    init?(owner: String?, prefixes: [String]) {
        guard let owner, !owner.isEmpty, !prefixes.isEmpty else { return nil }
        self.owner = owner
        self.prefixes = prefixes
    }

    /// What `write` makes stale, from the policy table. Nil for no write.
    init?(owner: String?, write: StarlingsSnapshotWrite?) {
        guard let write else { return nil }
        self.init(owner: owner, prefixes: StarlingsRequestPolicy.invalidated(by: write))
    }

    /// What the writes make stale together, in the table's order per write.
    init?(owner: String?, writes: [StarlingsSnapshotWrite]) {
        self.init(owner: owner, prefixes: writes.flatMap(StarlingsRequestPolicy.invalidated(by:)))
    }
}

/// How one client renews its owner session when the Worker refuses the
/// owner JWT on a request (`owner_auth_required`).
///
/// The Mac renews through `OwnerSessionRenewer`, which expires the Keychain
/// session itself on a refusal; the phone renews through the app model and
/// posts `StarlingsAPI.ownerSessionRejectedNotification`. The transport does
/// the replay the same way for both (`ownerData(for:)`).
struct StarlingsOwnerSessionRenewal: Sendable {
    /// Renews after the Worker refused `refused`. Answers the access token to
    /// send the request again with, or nil when there is none.
    let renew: @Sendable (_ refused: String) async -> String?
    /// The replay ended refused: no fresh token, or the request sent again
    /// was refused too.
    let rejected: @Sendable () -> Void

    /// No replay: a refusal is the answer. For a request on another
    /// workspace's session, which the active workspace's renewal must never
    /// touch (`QuickNoteMove`).
    static let none = StarlingsOwnerSessionRenewal(renew: { _ in nil }, rejected: {})
}

struct StarlingsHTTPTransport: Sendable {
    let baseURL: URL
    let session: URLSession
    /// Sent as `Origin` on the routes that check it.
    let webOrigin: String
    /// Seconds before a request stops, when the call sets no other value.
    let timeout: TimeInterval
    /// When a failed request is sent again. The table's rule unless a test says otherwise.
    let retry: StarlingsRequestPolicy.Retry
    /// Called after a 2xx answer with the lists that write made stale.
    let markStale: @Sendable (StarlingsStaleSnapshots) -> Void
    /// The client's owner-session renewal, for `ownerData(for:)`. Nil sends
    /// a refused request's answer back as it is.
    let ownerSessionRenewal: StarlingsOwnerSessionRenewal?

    init(
        baseURL: URL,
        session: URLSession = .shared,
        webOrigin: String,
        timeout: TimeInterval = StarlingsRequestPolicy.timeoutSeconds,
        retry: StarlingsRequestPolicy.Retry = StarlingsRequestPolicy.retry,
        ownerSessionRenewal: StarlingsOwnerSessionRenewal? = nil,
        markStale: @escaping @Sendable (StarlingsStaleSnapshots) -> Void = StarlingsHTTPTransport.invalidateSnapshotStore
    ) {
        self.baseURL = baseURL
        self.session = session
        self.webOrigin = webOrigin
        self.timeout = timeout
        self.retry = retry
        self.ownerSessionRenewal = ownerSessionRenewal
        self.markStale = markStale
    }

    /// The default hook: the on-device snapshot store (docs/CACHING.md).
    static let invalidateSnapshotStore: @Sendable (StarlingsStaleSnapshots) -> Void = { stale in
        SnapshotStore.invalidate(prefixes: stale.prefixes, owner: stale.owner)
    }

    /// Headers each request built here carries. Standalone native request
    /// builders use `StarlingsClientVersion.apply` for the same version header.
    static var standardHeaders: [String: String] {
        var headers = ["Content-Type": "application/json"]
        StarlingsClientVersion.apply(to: &headers)
        return headers
    }

    // MARK: Building

    /// The address for a route: the base, each path component, then the query.
    func url(path: [String], query: [URLQueryItem] = []) -> URL {
        let endpoint = path.reduce(baseURL) { $0.appending(path: $1) }
        return query.isEmpty ? endpoint : endpoint.appending(queryItems: query)
    }

    /// A request with no body.
    func request(
        path: [String],
        query: [URLQueryItem] = [],
        method: String,
        bearer: (any StarlingsBearerSource)? = nil,
        origin: Bool = false,
        timeout: TimeInterval? = nil
    ) throws -> URLRequest {
        var request = URLRequest(url: url(path: path, query: query))
        request.httpMethod = method
        request.timeoutInterval = timeout ?? self.timeout
        // Every read here is live or revalidated through a snapshot's ETag;
        // the URL cache never answers for the Worker.
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        for (field, value) in Self.standardHeaders {
            request.setValue(value, forHTTPHeaderField: field)
        }
        if origin {
            request.setValue(webOrigin, forHTTPHeaderField: "Origin")
        }
        if let bearer {
            // The token goes in the header, never the URL: URLs land in
            // traces and proxy logs.
            guard let token = try bearer.meetBearerToken() else { throw StarlingsHTTPFailure.signedOut }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if bearer.isMeetOwnerSession {
                request = Self.markOwnerSession(request)
            }
        }
        return request
    }

    /// A request with a JSON body.
    func request<Body: Encodable>(
        path: [String],
        query: [URLQueryItem] = [],
        method: String,
        body: Body,
        bearer: (any StarlingsBearerSource)? = nil,
        origin: Bool = false,
        timeout: TimeInterval? = nil
    ) throws -> URLRequest {
        var request = try self.request(
            path: path, query: query, method: method, bearer: bearer, origin: origin, timeout: timeout
        )
        request.httpBody = try Self.encode(body)
        return request
    }

    /// A request that carries raw bytes, such as a picture or a file.
    func request(
        path: [String],
        method: String,
        bytes: Data,
        contentType: String,
        bearer: (any StarlingsBearerSource)? = nil,
        origin: Bool = false,
        timeout: TimeInterval? = nil
    ) throws -> URLRequest {
        var request = try self.request(path: path, method: method, bearer: bearer, origin: origin, timeout: timeout)
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = bytes
        return request
    }

    /// The generated request types carry their own coding keys, so the plain
    /// encoder is the contract's encoder.
    static func encode<Body: Encodable>(_ body: Body) throws -> Data {
        try JSONEncoder().encode(body)
    }

    // MARK: Sending

    /// Sends the request and answers the body and the HTTP response, whatever
    /// the status. Only a failure to get an HTTP answer throws.
    ///
    /// An idempotent request (`StarlingsRequestPolicy.retry`) that fails on the
    /// network, or is answered with a 5xx, a 408 or a 429, is sent once more
    /// after a short pause, on both clients. The Mac used to do this for four
    /// calls and the phone for none; one transient blip put "Couldn’t load"
    /// on a screen that the next poll cleared. Only the last failure is
    /// reported to diagnostics.
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var retriesLeft = retry.appliesTo(method: request.httpMethod) ? retry.extraAttempts : 0
        while true {
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: request)
            } catch {
                if retriesLeft > 0, StarlingsRequestPolicy.isRetryable(error) {
                    retriesLeft -= 1
                    try await pauseBeforeRetry()
                    continue
                }
                StarlingsDiagnosticsLog.captureTransportFailure(error, request: request, using: self)
                throw StarlingsHTTPFailure.transport(error)
            }
            guard let http = response as? HTTPURLResponse else {
                StarlingsDiagnosticsLog.captureInvalidResponse(request: request, using: self)
                throw StarlingsHTTPFailure.notHTTP
            }
            if retriesLeft > 0, retry.retries(status: http.statusCode) {
                retriesLeft -= 1
                try await pauseBeforeRetry()
                continue
            }
            Self.observeUpgradeRecommendation(for: request, response: http)
            if Self.isOwnerSessionRequest(request), Self.isSuccessful(http.statusCode), !Self.isOperationalErrorRequest(request),
               let token = Self.ownerToken(in: request) {
                StarlingsDiagnosticsLog.flushOperationalErrors(using: self, ownerToken: token)
            }
            return (data, http)
        }
    }

    /// `data(for:)`, plus the one failure a caller should never see: a stale
    /// owner JWT. When the Worker answers `owner_auth_required` (401 from
    /// every gate; 403 from the capability routes of older Workers) to a
    /// request that carries a bearer token, the client's renewal runs once
    /// and the request goes out once more with the fresh token. Only a
    /// renewal that gives no token, or a second refusal, reaches the caller,
    /// and the renewal's `rejected` tells the app first. Keyed off the stable
    /// code, never the prose. Before this, the first poll past 8h said "Sign
    /// in again" while the renewal succeeded behind it.
    ///
    /// The answer comes back whatever its status; a non-2xx final answer is
    /// reported to diagnostics, with the retry counted.
    func ownerData(for request: URLRequest) async throws -> (data: Data, http: HTTPURLResponse) {
        let (data, http) = try await self.data(for: request)
        guard let renewal = ownerSessionRenewal,
              Self.isOwnerSessionRefusal(http, data: data),
              let refused = Self.bearer(of: request)
        else {
            StarlingsDiagnosticsLog.captureResponseFailure(request: request, response: http, data: data, retryCount: 0, using: self)
            return (data, http)
        }
        guard let fresh = await renewal.renew(refused), fresh != refused else {
            renewal.rejected()
            StarlingsDiagnosticsLog.captureResponseFailure(request: request, response: http, data: data, retryCount: 0, using: self)
            return (data, http)
        }
        var resend = request
        resend.setValue("Bearer \(fresh)", forHTTPHeaderField: "Authorization")
        let (resentData, resentHTTP) = try await self.data(for: resend)
        if Self.isOwnerSessionRefusal(resentHTTP, data: resentData) { renewal.rejected() }
        StarlingsDiagnosticsLog.captureResponseFailure(request: resend, response: resentHTTP, data: resentData, retryCount: 1, using: self)
        return (resentData, resentHTTP)
    }

    /// A 401 or 403 whose body names `owner_auth_required`.
    static func isOwnerSessionRefusal(_ response: HTTPURLResponse, data: Data) -> Bool {
        (response.statusCode == 401 || response.statusCode == 403)
            && errorBody(in: data)?.code == ControlErrorCodeValue.ownerAuthRequired.rawValue
    }

    /// The bearer token a request carries, owner or not. A request with none
    /// is never sent again with an owner token.
    static func bearer(of request: URLRequest) -> String? {
        guard let header = request.value(forHTTPHeaderField: "Authorization"),
              header.hasPrefix("Bearer ") else { return nil }
        return String(header.dropFirst("Bearer ".count))
    }

    /// The pause between two attempts. A cancelled task ends the request as a
    /// cancelled request, which the clients already read as silent.
    private func pauseBeforeRetry() async throws {
        guard retry.delaySeconds > 0 else { return }
        do {
            try await Task.sleep(nanoseconds: UInt64(retry.delaySeconds * 1_000_000_000))
        } catch {
            throw StarlingsHTTPFailure.transport(URLError(.cancelled))
        }
    }

    /// URLProtocol properties mark owner requests without adding an HTTP
    /// header, so tokens and internal client state never reach the server.
    static func markOwnerSession(_ request: URLRequest) -> URLRequest {
        let mutable = (request as NSURLRequest).mutableCopy() as! NSMutableURLRequest
        URLProtocol.setProperty(true, forKey: ownerSessionProperty, in: mutable)
        return mutable as URLRequest
    }

    static func isOwnerSessionRequest(_ request: URLRequest) -> Bool {
        URLProtocol.property(forKey: ownerSessionProperty, in: request) as? Bool == true
    }

    static func isOperationalErrorRequest(_ request: URLRequest) -> Bool {
        request.url?.pathComponents.suffix(1).first == "operational-errors"
    }

    static func ownerToken(in request: URLRequest) -> String? {
        guard isOwnerSessionRequest(request),
              let authorization = request.value(forHTTPHeaderField: "Authorization"),
              authorization.hasPrefix("Bearer ") else { return nil }
        return String(authorization.dropFirst("Bearer ".count))
    }

    static func isSuccessful(_ status: Int) -> Bool {
        (200..<300).contains(status) || status == 304
    }

    private static let ownerSessionProperty = "\(ContractConstants.nativeAppBundleID).owner-session"

    static func observeUpgradeRecommendation(for request: URLRequest, response: HTTPURLResponse) {
        guard request.value(forHTTPHeaderField: "x-meet-client") != nil else { return }
        let recommended = response.value(forHTTPHeaderField: "x-meet-upgrade") == "recommended"
        let updateURL = response.value(forHTTPHeaderField: "x-meet-update-url")
        Task { @MainActor in
            StarlingsUpgradeRecommendation.shared.receive(recommended: recommended, updateURL: updateURL)
        }
    }

    /// Throws `.status` for a non-2xx answer. After a 2xx answer it marks
    /// `stale` through the hook, and only then: a write the Worker refused
    /// changed no list.
    func accept(_ response: HTTPURLResponse, data: Data, stale: StarlingsStaleSnapshots? = nil) throws {
        if let failure = Self.failure(status: response.statusCode, data: data) { throw failure }
        if let stale { markStale(stale) }
    }

    /// Nil for a 2xx status. Otherwise the failure, with the code and the
    /// message from the Worker's body when it sent them.
    static func failure(status: Int, data: Data) -> StarlingsHTTPFailure? {
        guard !(200..<300).contains(status) else { return nil }
        let body = errorBody(in: data)
        let requestID = (try? JSONDecoder().decode(LooseErrorBody.self, from: data))?.requestID
            .flatMap(UUID.init(uuidString:))?.uuidString.lowercased()
        if body?.code == ControlErrorCodeValue.clientUpdateRequired.rawValue {
            // A retired route this build still calls: every error
            // view that shows this message offers Update.
            let message = body?.message
            Task { @MainActor in StarlingsUpgradeRecommendation.shared.receiveRequired(message: message) }
        }
        return .status(status, code: body?.code, message: body?.message, requestID: requestID)
    }

    /// The Worker's `{error, code}` body. The generated `ControlErrorBody`
    /// first; a body without `error` still gives its code.
    static func errorBody(in data: Data) -> (message: String?, code: String?)? {
        if let wire = try? JSONDecoder().decode(ControlErrorBody.self, from: data) {
            return (wire.error, wire.code?.rawValue)
        }
        if let loose = try? JSONDecoder().decode(LooseErrorBody.self, from: data) {
            return (loose.error, loose.code)
        }
        return nil
    }

    /// Only a UUID request id can leave this client. It is the Worker's
    /// correlation handle for an opaque 5xx; never a server message or URL.
    static func requestID(in response: HTTPURLResponse, data: Data) -> String? {
        let header = response.value(forHTTPHeaderField: "x-meet-request-id")
        let body = (try? JSONDecoder().decode(LooseErrorBody.self, from: data))?.requestID
        for candidate in [header, body].compactMap({ $0 }) {
            if let uuid = UUID(uuidString: candidate) { return uuid.uuidString.lowercased() }
        }
        return nil
    }

    /// Decodes a 2xx body. A failure names the type it expected.
    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw StarlingsHTTPFailure.undecodable(type: String(describing: type))
        }
    }

    /// Build, send, check and decode in one call, for a request that needs
    /// no owner-session renewal between the send and the check.
    func send<T: Decodable>(_ request: URLRequest, as type: T.Type, stale: StarlingsStaleSnapshots? = nil) async throws -> T {
        let (data, response) = try await data(for: request)
        if let failure = Self.failure(status: response.statusCode, data: data) {
            StarlingsDiagnosticsLog.captureResponseFailure(request: request, response: response, data: data, retryCount: 0, using: self)
            throw failure
        }
        try accept(response, data: data, stale: stale)
        do {
            return try Self.decode(type, from: data)
        } catch {
            StarlingsDiagnosticsLog.captureDecodeFailure(request: request, using: self)
            throw error
        }
    }
}

// MARK: Snapshot reads

extension StarlingsHTTPTransport {
    /// One snapshotted list read (docs/CACHING.md), the same on both clients.
    ///
    /// The stored snapshot's validator goes out as `If-None-Match`; a 304
    /// means the bytes in hand are still the answer. Two concurrent reads of
    /// one key for one owner share a request. The body is decoded first and
    /// kept as the snapshot only when it decoded, on a 304 too (the list is
    /// confirmed current, so "Updated" says now). `owner` empty reads and keeps
    /// nothing.
    ///
    /// `fetch` is the client's own send, with its session renewal and its own
    /// words for a failure. It answers a 304 as it is and throws on any other
    /// non-2xx status.
    static func readSnapshotting<T>(
        request: URLRequest,
        key: String,
        owner: String,
        fetch: @escaping @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse),
        decode: (Data) throws -> T
    ) async throws -> T {
        let known = owner.isEmpty ? nil : SnapshotStore.load(key: key, owner: owner)
        var conditional = request
        if let etag = known?.etag {
            conditional.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        let request = conditional
        let fetched = try await RequestCoalescer.shared.run(key: "\(owner)|\(key)") {
            let (data, http) = try await fetch(request)
            if http.statusCode == 304 {
                // Only ever answered to a validator this request sent.
                guard let known else { throw StarlingsHTTPFailure.status(304, code: nil, message: nil, requestID: nil) }
                return .init(data: known.data, etag: http.value(forHTTPHeaderField: "ETag") ?? known.etag)
            }
            return .init(data: data, etag: http.value(forHTTPHeaderField: "ETag"))
        }
        let value = try decode(fetched.data)
        if !owner.isEmpty { SnapshotStore.save(fetched.data, key: key, owner: owner, etag: fetched.etag) }
        return value
    }
}

// MARK: Routes

/// One Worker route, named once for both clients ( to): the
/// method, the path, the query, the body, the answer type, the sentence a
/// failure is titled with, the lists a write makes stale and the snapshot a
/// read keeps. Each area's routes live in one file under `Sources/`
/// (`StarlingsCalendarRoutes`, …); each client sends them with its own bearer
/// token and its own words for a failure.
struct StarlingsRoute<Answer: Decodable>: Sendable {
    let method: String
    let path: [String]
    var query: [URLQueryItem] = []
    /// The JSON body. Nil sends none, except that the Mac has always sent
    /// `{}` for a write with no body (`emptyWriteBody`).
    var body: (any Encodable & Sendable)? = nil
    /// Raw bytes instead of a JSON body: a picture, a file.
    var upload: StarlingsUpload? = nil
    /// What the person reads as the title when this route fails.
    let operation: String
    /// The writes whose lists a 2xx answer makes stale.
    var writes: [StarlingsSnapshotWrite] = []
    /// A read whose answer is kept as this snapshot (docs/CACHING.md), by the
    /// clients the policy table names (`StarlingsRequestPolicy.keeps`).
    var snapshotKey: String? = nil
    /// Seconds before the request stops, when not the transport's default.
    var timeout: TimeInterval? = nil
    /// Sends `Origin`, for the routes that check it.
    var origin: Bool = false
    /// The `Accept` header, when not JSON's.
    var accept: String? = nil
    /// The one kind of read the URL cache may answer: bytes that never change
    /// under their address, such as a face.
    var cachesAnswer: Bool = false
}

/// The bytes a route sends instead of a JSON body.
struct StarlingsUpload: Sendable {
    let data: Data
    let contentType: String
}

/// The answer of a route whose body no client reads.
struct StarlingsNoAnswer: Decodable, Sendable {
    init(from decoder: Decoder) throws {}
}

/// A write with nothing to say: `{}`.
struct StarlingsEmptyBody: Encodable, Sendable {}

extension StarlingsHTTPTransport {
    /// The request for `route`. `emptyWriteBody` sends `{}` for a write that
    /// names no body; `timeout` is the client's default when the route names none.
    func request<Answer>(
        _ route: StarlingsRoute<Answer>,
        bearer: (any StarlingsBearerSource)?,
        emptyWriteBody: Bool = false,
        timeout: TimeInterval? = nil
    ) throws -> URLRequest {
        var built: URLRequest
        let body: (any Encodable & Sendable)? = route.body
            ?? (emptyWriteBody && route.method != "GET" && route.upload == nil ? StarlingsEmptyBody() : nil)
        if let upload = route.upload {
            built = try request(
                path: route.path, method: route.method, bytes: upload.data, contentType: upload.contentType,
                bearer: bearer, origin: route.origin, timeout: route.timeout ?? timeout
            )
        } else if let body {
            built = try request(
                path: route.path, query: route.query, method: route.method, body: body,
                bearer: bearer, origin: route.origin, timeout: route.timeout ?? timeout
            )
        } else {
            built = try request(
                path: route.path, query: route.query, method: route.method,
                bearer: bearer, origin: route.origin, timeout: route.timeout ?? timeout
            )
        }
        if route.cachesAnswer { built.cachePolicy = .returnCacheDataElseLoad }
        if let accept = route.accept { built.setValue(accept, forHTTPHeaderField: "Accept") }
        return built
    }
}

enum StarlingsClientVersion {
    static var headerValue: String? {
        #if os(macOS)
        let platform = "macos"
        #elseif os(iOS)
        let platform = "ios"
        #else
        return nil
        #endif
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return format(platform: platform, version: version, build: build)
    }

    static func format(platform: String, version: String, build: String) -> String {
        "\(platform)/\(version) (\(build))"
    }

    static func apply(to headers: inout [String: String]) {
        if let client = headerValue { headers["x-meet-client"] = client }
    }

    static func apply(to request: inout URLRequest) {
        if let client = headerValue { request.setValue(client, forHTTPHeaderField: "x-meet-client") }
    }
}

private struct LooseErrorBody: Decodable {
    let error: String?
    let code: String?
    let requestID: String?

    enum CodingKeys: String, CodingKey {
        case error
        case code
        case requestID = "request_id"
    }
}

extension StarlingsError {
    /// The one mapping from a transport failure to what a person reads.
    /// A status goes through `service`, which reads the Worker's code first:
    /// 401 or 403 with `owner_auth_required` is "Sign in again", 429 and 5xx
    /// offer a retry, and 403, 404 and 409 read as the Worker's own message.
    static func http(_ failure: StarlingsHTTPFailure, operation: String) -> StarlingsError {
        switch failure {
        case .signedOut:
            return .authenticationRequired()
        case .transport(let error):
            return .transport(error, operation: operation)
        case .notHTTP:
            return .invalidResponse(operation: operation)
        case let .status(status, code, message, requestID):
            var error = StarlingsError.service(
                status: status,
                serverCode: code,
                serverMessage: message ?? String(localized: "The meeting service didn’t explain what went wrong."),
                operation: operation
            )
            error.serverCode = code
            error.requestID = requestID
            error.status = status
            if let requestID { error.diagnostic += " request \(requestID)" }
            return error
        case .undecodable(let type):
            var error = StarlingsError.invalidResponse(operation: operation)
            error.diagnostic = "response did not decode as \(type)"
            return error
        }
    }

    /// The phone's sentence for a request the Worker refused: the Worker's
    /// own message, or the operation and the status when it sent none. Code,
    /// server code, status and request id are those of `http`.
    static func refusal(status: Int, serverCode: String?, serverMessage: String?, requestID: String?, operation: String) -> StarlingsError {
        var error = http(.status(status, code: serverCode, message: serverMessage, requestID: requestID), operation: operation)
        error.message = serverMessage ?? "\(operation) (\(status))."
        return error
    }

    /// The phone's sentence for a request that never got an answer. The code
    /// and the diagnostic are those of `transport`.
    static func unreachable(_ underlying: Error, operation: String) -> StarlingsError {
        var error = transport(underlying, operation: operation)
        error.message = String(localized: "\(operation). Check your connection and try again.")
        return error
    }
}
