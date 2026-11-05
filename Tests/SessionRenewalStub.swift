import Foundation

/// Answers every request of a stubbed `URLSession` with one fixed reply, so
/// the session-renewal tests (meet#332) run without a network. Shared by the
/// Mac and iOS test targets.
///
/// The state is static, so each `makeSession` starts a new count, and only
/// requests from that newest session reach it. A request that a store from an
/// earlier test sends late fails as cancelled and is not counted.
final class SessionRenewalStub: URLProtocol, @unchecked Sendable {
    enum Reply: Sendable {
        case status(Int, Data)
        case failure(URLError.Code)
    }

    private static let lock = NSLock()
    /// Every session carries its own ID in this header.
    private static let sessionHeader = "X-Session-Renewal-Stub"
    nonisolated(unsafe) private static var currentSession = ""
    nonisolated(unsafe) private static var reply: Reply = .failure(.notConnectedToInternet)
    /// Answers given first, one per request, before `reply` takes over.
    nonisolated(unsafe) private static var queue: [Reply] = []
    nonisolated(unsafe) private static var requestCount = 0
    nonisolated(unsafe) private static var lastRequest: URLRequest?
    nonisolated(unsafe) private static var lastRequestBody: Data?

    /// Sets the reply for every request that follows.
    static func reply(_ next: Reply) {
        lock.withLock { reply = next }
    }

    /// The next requests are answered in this order; once they are used up the
    /// fixed reply answers. For a retry test: a 503, then a 200.
    static func replyInOrder(_ first: [Reply]) {
        lock.withLock { queue = first }
    }

    static var requests: Int {
        lock.withLock { requestCount }
    }

    static var lastRequestSnapshot: URLRequest? {
        lock.withLock { lastRequest }
    }

    static var lastRequestBodySnapshot: Data? {
        lock.withLock { lastRequestBody }
    }

    static func makeSession(replying first: Reply) -> URLSession {
        let id = UUID().uuidString
        lock.withLock {
            currentSession = id
            reply = first
            queue = []
            requestCount = 0
            lastRequest = nil
            lastRequestBody = nil
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionRenewalStub.self]
        configuration.httpAdditionalHeaders = [sessionHeader: id]
        return URLSession(configuration: configuration)
    }

    /// A body the Worker sends from a successful `/api/auth/refresh`.
    static func renewedBody(accessToken: String, refreshToken: String) -> Data {
        let json: [String: Any] = [
            "access_token": accessToken,
            "refresh_token": refreshToken,
            "owner": [
                "sub": "sub-test",
                "email": "test@example.com",
                "name": "Test Owner",
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = Self.bodyData(in: request)
        let current = Self.lock.withLock { () -> Reply? in
            guard request.value(forHTTPHeaderField: Self.sessionHeader) == Self.currentSession else { return nil }
            Self.requestCount += 1
            Self.lastRequest = request
            Self.lastRequestBody = body
            return Self.queue.isEmpty ? Self.reply : Self.queue.removeFirst()
        }
        guard let current else {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        switch current {
        case .status(let code, let body):
            let response = HTTPURLResponse(
                url: request.url ?? URL(string: "https://meet.test/api")!,
                statusCode: code,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        }
    }

    override func stopLoading() {}

    private static func bodyData(in request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data.isEmpty ? nil : data
    }
}
