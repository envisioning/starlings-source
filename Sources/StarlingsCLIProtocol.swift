import Darwin
import Foundation
import StarlingsContracts

let meetCLIProtocolVersion = 1

extension StarlingsCLIRequest {
    init(command: String, arguments: [String: String] = [:], id: String = UUID().uuidString) {
        self.init(version: meetCLIProtocolVersion, id: id, command: command, arguments: arguments)
    }
}

extension StarlingsCLIResponse {
    static func success(
        for request: StarlingsCLIRequest,
        message: String,
        state: StarlingsCLIState,
        output: StarlingsCLIOutput? = nil
    ) -> Self {
        Self(
            version: meetCLIProtocolVersion,
            id: request.id,
            ok: true,
            message: message,
            state: state,
            output: output,
            error: nil
        )
    }

    static func failure(
        for request: StarlingsCLIRequest,
        code: String,
        message: String,
        state: StarlingsCLIState? = nil
    ) -> Self {
        Self(
            version: meetCLIProtocolVersion,
            id: request.id,
            ok: false,
            message: message,
            state: state,
            output: nil,
            error: StarlingsCLIErrorPayload(code: code, message: message)
        )
    }
}

enum StarlingsCLIEndpoint {
    static var defaultSocketURL: URL {
        let homePath = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) }
            ?? FileManager.default.homeDirectoryForCurrentUser.path
        // Under the home, not a sandbox container (the app is not sandboxed
        // since 3.8.3). Short enough for a Unix socket path's 104-byte limit.
        // `~/Library/Application Support/Starlings/starlings.sock` since the
        // rename; the app and the CLI ship together.
        return URL(fileURLWithPath: homePath, isDirectory: true)
            .appending(path: "Library/Application Support", directoryHint: .isDirectory)
            .appending(path: AppFolders.name, directoryHint: .isDirectory)
            .appending(path: AppFolders.socketName, directoryHint: .notDirectory)
    }
}

final class StarlingsCommandServer: @unchecked Sendable {
    typealias Handler = @Sendable (StarlingsCLIRequest) async -> StarlingsCLIResponse

    private let socketURL: URL
    private let handler: Handler
    private let lock = NSLock()
    private var listenerFileDescriptor: Int32 = -1
    private var acceptTask: Task<Void, Never>?

    init(socketURL: URL = StarlingsCLIEndpoint.defaultSocketURL, handler: @escaping Handler) {
        self.socketURL = socketURL
        self.handler = handler
    }

    func start() throws {
        let socketDirectory = socketURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: socketDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw StarlingsCLITransportError.systemCall("socket", errno) }
        do {
            var address = try socketAddress(path: socketURL.path)
            Darwin.unlink(socketURL.path)
            let bindResult = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketPointer in
                    Darwin.bind(descriptor, socketPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard bindResult == 0 else { throw StarlingsCLITransportError.systemCall("bind", errno) }
            guard Darwin.chmod(socketURL.path, S_IRUSR | S_IWUSR) == 0 else {
                throw StarlingsCLITransportError.systemCall("chmod", errno)
            }
            guard Darwin.listen(descriptor, 8) == 0 else {
                throw StarlingsCLITransportError.systemCall("listen", errno)
            }
            lock.withLock { listenerFileDescriptor = descriptor }
            acceptTask = Task.detached(priority: .userInitiated) { [weak self] in
                self?.acceptConnections(descriptor: descriptor)
            }
        } catch {
            Darwin.close(descriptor)
            Darwin.unlink(socketURL.path)
            throw error
        }
    }

    func stop() {
        let descriptor = lock.withLock { () -> Int32 in
            let current = listenerFileDescriptor
            listenerFileDescriptor = -1
            return current
        }
        acceptTask?.cancel()
        acceptTask = nil
        if descriptor >= 0 {
            Darwin.shutdown(descriptor, SHUT_RDWR)
            Darwin.close(descriptor)
        }
        Darwin.unlink(socketURL.path)
    }

    deinit {
        stop()
    }

    private func acceptConnections(descriptor: Int32) {
        while !Task.isCancelled {
            let client = Darwin.accept(descriptor, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                return
            }
            Task.detached(priority: .userInitiated) { [weak self] in
                await self?.handle(client: client)
            }
        }
    }

    private func handle(client: Int32) async {
        defer { Darwin.close(client) }
        do {
            let requestData = try readLine(from: client)
            let request = try JSONDecoder().decode(StarlingsCLIRequest.self, from: requestData)
            let response: StarlingsCLIResponse
            if request.version == meetCLIProtocolVersion {
                response = await handler(request)
            } else {
                response = .failure(
                    for: request,
                    code: "unsupported_protocol",
                    message: String(localized: "CLI protocol \(request.version) is not supported.")
                )
            }
            try writeLine(try JSONEncoder().encode(response), to: client)
        } catch {
            let request = StarlingsCLIRequest(command: "invalid", id: "unknown")
            let response = StarlingsCLIResponse.failure(
                for: request,
                code: "invalid_request",
                message: error.localizedDescription
            )
            if let data = try? JSONEncoder().encode(response) {
                try? writeLine(data, to: client)
            }
        }
    }
}

struct StarlingsCommandClient: Sendable {
    let socketURL: URL
    let responseTimeoutSeconds: Int

    init(
        socketURL: URL = StarlingsCLIEndpoint.defaultSocketURL,
        responseTimeoutSeconds: Int = 60
    ) {
        self.socketURL = socketURL
        self.responseTimeoutSeconds = responseTimeoutSeconds
    }

    func send(_ request: StarlingsCLIRequest) throws -> StarlingsCLIResponse {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw StarlingsCLITransportError.systemCall("socket", errno) }
        defer { Darwin.close(descriptor) }

        var timeout = timeval(tv_sec: responseTimeoutSeconds, tv_usec: 0)
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        var address = try socketAddress(path: socketURL.path)
        let connectionResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketPointer in
                Darwin.connect(descriptor, socketPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectionResult == 0 else {
            throw StarlingsCLITransportError.appUnavailable
        }
        try writeLine(try JSONEncoder().encode(request), to: descriptor)
        return try JSONDecoder().decode(StarlingsCLIResponse.self, from: readLine(from: descriptor))
    }
}

enum StarlingsCLITransportError: LocalizedError {
    case appUnavailable
    case requestTooLarge
    case connectionClosed
    case systemCall(String, Int32)

    var errorDescription: String? {
        switch self {
        case .appUnavailable: String(localized: "The Starlings app is not accepting CLI commands.")
        case .requestTooLarge: String(localized: "The CLI request exceeded 64 KiB.")
        case .connectionClosed: String(localized: "The Starlings app closed the CLI connection before responding.")
        case .systemCall(let name, let code): String(localized: "CLI transport \(name) failed with errno \(code).")
        }
    }
}

private func socketAddress(path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw StarlingsCLITransportError.systemCall("socket path", ENAMETOOLONG)
    }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutablePointer(to: &address.sun_path.0) { destination in
        path.withCString { source in
            _ = Darwin.strncpy(destination, source, bytes.count)
        }
    }
    return address
}

private func readLine(from descriptor: Int32) throws -> Data {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while data.count <= 65_536 {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count < 0 {
            if errno == EINTR { continue }
            throw StarlingsCLITransportError.systemCall("read", errno)
        }
        if count == 0 { throw StarlingsCLITransportError.connectionClosed }
        if let newline = buffer[..<count].firstIndex(of: 0x0A) {
            data.append(contentsOf: buffer[..<newline])
            return data
        }
        data.append(contentsOf: buffer[..<count])
    }
    throw StarlingsCLITransportError.requestTooLarge
}

private func writeLine(_ data: Data, to descriptor: Int32) throws {
    var payload = data
    payload.append(0x0A)
    try payload.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else { return }
        var offset = 0
        while offset < rawBuffer.count {
            let count = Darwin.write(descriptor, baseAddress.advanced(by: offset), rawBuffer.count - offset)
            if count < 0 {
                if errno == EINTR { continue }
                throw StarlingsCLITransportError.systemCall("write", errno)
            }
            offset += count
        }
    }
}
