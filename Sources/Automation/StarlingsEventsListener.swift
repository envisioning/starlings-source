import Foundation
import Network

/// The door the extension knocks on: `POST /meet-events` on the loopback
/// interface, a bearer token the app minted and the person pasted into the
/// extension, nothing else. Loopback only — the listener binds 127.0.0.1 and
/// never the LAN — and the token is the whole of the authentication: the
/// extension is a passive reader of a web page, and the worst a forged batch
/// can do is offer to record.
final class StarlingsEventsListener: @unchecked Sendable {
    static let port: UInt16 = 47_613
    static let path = "/meet-events"

    private let listener: NWListener
    private let queue = DispatchQueue(label: "meet.events.listener")
    private let token: String
    private let onBatch: @Sendable (StarlingsEventsBatch) -> Void
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    init(token: String, onBatch: @escaping @Sendable (StarlingsEventsBatch) -> Void) throws {
        self.token = token
        self.onBatch = onBatch
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: Self.port)!)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                NSLog("meet events listener failed: %@", String(describing: error))
            }
        }
        listener.start(queue: queue)
    }

    func stop() {
        listener.cancel()
        queue.async { [self] in
            for connection in connections.values { connection.cancel() }
            connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        connections[ObjectIdentifier(connection)] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .failed, .cancelled:
                queue.async { self.connections[ObjectIdentifier(connection)] = nil }
            default:
                break
            }
        }
        connection.start(queue: queue)
        readRequest(connection, buffered: Data())
    }

    /// Reads until the header block is complete, then the body its
    /// Content-Length names. One request per connection; the response
    /// closes it.
    private func readRequest(_ connection: NWConnection, buffered: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffered
            if let data { buffer.append(data) }
            if error != nil || (isComplete && buffer.isEmpty) {
                connection.cancel()
                return
            }
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if buffer.count > 64 * 1024 { respond(connection, status: 431, body: "headers too large"); return }
                readRequest(connection, buffered: buffer)
                return
            }
            let headerText = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
            let lines = headerText.split(separator: "\r\n", omittingEmptySubsequences: false)
            let requestLine = lines.first.map(String.init) ?? ""
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { continue }
                headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            let length = Int(headers["content-length"] ?? "0") ?? 0
            guard length <= 1024 * 1024 else { respond(connection, status: 413, body: "body too large"); return }
            let bodyStart = headerEnd.upperBound
            let body = buffer[bodyStart...]
            if body.count < length {
                readBody(connection, requestLine: requestLine, headers: headers, body: Data(body), remaining: length - body.count)
            } else {
                handle(connection, requestLine: requestLine, headers: headers, body: Data(body.prefix(length)))
            }
        }
    }

    private func readBody(_ connection: NWConnection, requestLine: String, headers: [String: String], body: Data, remaining: Int) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: max(1, remaining)) { [weak self] data, _, _, error in
            guard let self else { return }
            guard error == nil, let data else { connection.cancel(); return }
            var next = body
            next.append(data)
            if data.count < remaining {
                readBody(connection, requestLine: requestLine, headers: headers, body: next, remaining: remaining - data.count)
            } else {
                handle(connection, requestLine: requestLine, headers: headers, body: next)
            }
        }
    }

    private func handle(_ connection: NWConnection, requestLine: String, headers: [String: String], body: Data) {
        let parts = requestLine.split(separator: " ")
        let method = parts.first.map(String.init) ?? ""
        let target = parts.count > 1 ? String(parts[1]) : ""
        // A browser preflight for a host-permitted extension never happens,
        // but a curl from the terminal is a fine way to check the door.
        guard target == Self.path else { respond(connection, status: 404, body: "not found"); return }
        guard method == "POST" else { respond(connection, status: 405, body: "method not allowed"); return }
        let offered = headers["authorization"]?.replacingOccurrences(of: "Bearer ", with: "", options: [.anchored, .caseInsensitive]) ?? ""
        guard !token.isEmpty, constantTimeEquals(offered, token) else {
            respond(connection, status: 401, body: "bad token")
            return
        }
        do {
            let batch = try JSONDecoder().decode(StarlingsEventsBatch.self, from: body)
            guard StarlingsEventsBatch.supportedSchemaVersions.contains(batch.schemaVersion) else {
                respond(connection, status: 400, body: "unsupported schemaVersion")
                return
            }
            // ±48 h: a batch from a clock that far off is not evidence.
            let skew = abs(Double(batch.capturedAtMs) / 1000 - Date().timeIntervalSince1970)
            guard skew < 48 * 3600 else { respond(connection, status: 400, body: "stale batch"); return }
            onBatch(batch)
            respond(connection, status: 200, body: "{\"ok\":true}", contentType: "application/json")
        } catch {
            respond(connection, status: 400, body: "bad batch: \(error)")
        }
    }

    private func respond(_ connection: NWConnection, status: Int, body: String, contentType: String = "text/plain") {
        let reason: String = switch status {
        case 200: "OK"
        case 400: "Bad Request"
        case 401: "Unauthorized"
        case 404: "Not Found"
        case 405: "Method Not Allowed"
        case 413: "Payload Too Large"
        case 431: "Request Header Fields Too Large"
        default: "Error"
        }
        let payload = Data(body.utf8)
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: \(contentType); charset=utf-8\r\n"
        head += "Content-Length: \(payload.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var response = Data(head.utf8)
        response.append(payload)
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let left = Array(a.utf8), right = Array(b.utf8)
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }
}

/// The token the extension must present. Minted once per Mac, kept in the
/// app's defaults (it gates nothing beyond an offer to record — a keychain
/// item would be ceremony), shown in Settings with a Copy button.
enum StarlingsEventsPairing {
    private static let key = "meet.events.token"

    static var token: String {
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty { return existing }
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let minted = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        UserDefaults.standard.set(minted, forKey: key)
        return minted
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
