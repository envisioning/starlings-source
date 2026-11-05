import Foundation
import StarlingsContracts

/// A rolling in-memory copy of every `StarlingsError` the app logs, so the pasteable
/// debug report can carry failures as well as statistics.
///
/// The host lease is why this exists. It retries silently every ten seconds and
/// the UI only ever says "reconnecting", so the one thing that explains a lease
/// that never recovers — HTTP 401 versus 410 versus a dead network — lived in
/// Console and nowhere a person in the meeting could reach. Every site that used
/// to `NSLog` a `StarlingsError` now records here instead; Console still gets the
/// same line.
///
/// Contents are exactly `StarlingsError.logLine`: the stable code plus the vendor or
/// HTTP diagnostic. No tokens, lobby credentials, or transcript text pass
/// through a `StarlingsError`, so the report stays as safe to paste as it was.
final class StarlingsDiagnosticsLog: @unchecked Sendable {
    static let shared = StarlingsDiagnosticsLog()

    /// Enough to cover a burst around a reconnect plus minutes of a 10s
    /// heartbeat, small enough that the report stays pasteable in one message.
    private static let capacity = 50

    private struct Entry {
        let context: String
        let logLine: String
        let firstAt: Date
        var lastAt: Date
        var count: Int
    }

    private let lock = NSLock()
    private var entries: [Entry] = []
    private static let operationalSpool = StarlingsOperationalErrorSpool.shared

    /// The app uses `shared`; tests make their own so one case cannot see
    /// another's failures.
    init() {}

    /// Writes the failure to Console and keeps it for the debug report.
    ///
    /// `context` names the operation in the app's own words ("host lease
    /// heartbeat", "chat send"); the code inside `logLine` stays the greppable
    /// part.
    func record(_ error: StarlingsError, context: String) {
        NSLog("Meet %@: %@", context, error.logLine)
        append(context: context, logLine: error.logLine, at: Date())
        if let event = StarlingsOperationalErrorFactory.appBoundary(code: error.code) {
            Self.enqueue(event)
        }
    }

    /// Records one narrowly classified request failure. The raw response body,
    /// error message and request URL never enter the queue.
    static func captureResponseFailure(
        request: URLRequest,
        response: HTTPURLResponse,
        data: Data,
        retryCount: Int,
        using transport: StarlingsHTTPTransport
    ) {
        guard let ownerToken = StarlingsHTTPTransport.ownerToken(in: request),
              !StarlingsHTTPTransport.isOperationalErrorRequest(request),
              let event = StarlingsOperationalErrorFactory.responseFailure(
                request: request,
                response: response,
                data: data,
                retryCount: retryCount
              ) else { return }
        Task {
            await operationalSpool.enqueue(event)
            await operationalSpool.flush(using: transport, ownerToken: ownerToken)
        }
    }

    static func captureTransportFailure(_ error: Error, request: URLRequest, using transport: StarlingsHTTPTransport) {
        guard let ownerToken = StarlingsHTTPTransport.ownerToken(in: request),
              !StarlingsHTTPTransport.isOperationalErrorRequest(request),
              let event = StarlingsOperationalErrorFactory.transportFailure(error, request: request) else { return }
        Task {
            await operationalSpool.enqueue(event)
            await operationalSpool.flush(using: transport, ownerToken: ownerToken)
        }
    }

    static func captureInvalidResponse(request: URLRequest, using transport: StarlingsHTTPTransport) {
        guard let ownerToken = StarlingsHTTPTransport.ownerToken(in: request),
              !StarlingsHTTPTransport.isOperationalErrorRequest(request),
              let event = StarlingsOperationalErrorFactory.invalidResponse(request: request) else { return }
        Task {
            await operationalSpool.enqueue(event)
            await operationalSpool.flush(using: transport, ownerToken: ownerToken)
        }
    }

    static func captureDecodeFailure(request: URLRequest, using transport: StarlingsHTTPTransport) {
        guard let ownerToken = StarlingsHTTPTransport.ownerToken(in: request),
              !StarlingsHTTPTransport.isOperationalErrorRequest(request),
              let event = StarlingsOperationalErrorFactory.decodeFailure(request: request) else { return }
        Task {
            await operationalSpool.enqueue(event)
            await operationalSpool.flush(using: transport, ownerToken: ownerToken)
        }
    }

    static func flushOperationalErrors(using transport: StarlingsHTTPTransport, ownerToken: String) {
        Task { await operationalSpool.flush(using: transport, ownerToken: ownerToken) }
    }

    private static func enqueue(_ event: OperationalErrorEvent) {
        Task { await operationalSpool.enqueue(event) }
    }

    /// Report lines, oldest first. Empty until something has actually failed.
    func reportLines() -> [String] {
        let stamp = ISO8601DateFormatter()
        return snapshot().map { entry in
            var line = "\(stamp.string(from: entry.firstAt)) \(entry.context) — \(entry.logLine)"
            if entry.count > 1 {
                // A lease down for an hour is one line with a count, not 360
                // identical ones pushing everything else out of the buffer.
                line += " (×\(entry.count), last \(stamp.string(from: entry.lastAt)))"
            }
            return line
        }
    }

    private func append(context: String, logLine: String, at now: Date) {
        lock.lock()
        defer { lock.unlock() }

        if var last = entries.last, last.context == context, last.logLine == logLine {
            last.lastAt = now
            last.count += 1
            entries[entries.count - 1] = last
            return
        }

        entries.append(Entry(context: context, logLine: logLine, firstAt: now, lastAt: now, count: 1))
        if entries.count > Self.capacity {
            entries.removeFirst(entries.count - Self.capacity)
        }
    }

    private func snapshot() -> [Entry] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }
}

/// The wire contract accepts enums, not app messages. These mappings are
/// intentionally exact and omit routine refusals, cancellations and anything
/// this build does not recognize.
enum StarlingsOperationalErrorFactory {
    private struct Classification {
        let code: OperationalErrorEventCode
        let errorClass: OperationalErrorEventErrorClass
        let serverCode: OperationalErrorEventServerCode?
    }

    static func appBoundary(code: String) -> OperationalErrorEvent? {
        let classification: Classification
        switch code {
        case "connect.timeout": classification = .init(code: .connectTimeout, errorClass: .timeout, serverCode: nil)
        case "connect.network": classification = .init(code: .connectNetwork, errorClass: .network, serverCode: nil)
        case "connect.webrtc": classification = .init(code: .connectWebrtc, errorClass: .network, serverCode: nil)
        case "connect.token_rejected": classification = .init(code: .connectTokenRejected, errorClass: .authorization, serverCode: nil)
        case "session.dropped": classification = .init(code: .sessionDropped, errorClass: .network, serverCode: nil)
        case "session.server_shutdown": classification = .init(code: .sessionServerShutdown, errorClass: .http, serverCode: nil)
        case "media.audio_engine": classification = .init(code: .mediaAudioEngine, errorClass: .media, serverCode: nil)
        case "media.capture_format": classification = .init(code: .mediaCaptureFormat, errorClass: .media, serverCode: nil)
        case "transcription.engine_failed": classification = .init(code: .transcriptionEngineFailed, errorClass: .media, serverCode: nil)
        case "transcription.audio_recovery_failed": classification = .init(code: .transcriptionAudioRecoveryFailed, errorClass: .media, serverCode: nil)
        case "transcription.no_audio_frames": classification = .init(code: .transcriptionNoAudioFrames, errorClass: .media, serverCode: nil)
        case "chat.not_connected": classification = .init(code: .chatNotConnected, errorClass: .network, serverCode: nil)
        default: return nil
        }
        return event(
            classification,
            status: nil,
            requestID: nil,
            retryCount: 0,
            operation: operation(forErrorCode: code)
        )
    }

    static func responseFailure(
        request: URLRequest,
        response: HTTPURLResponse,
        data: Data,
        retryCount: Int
    ) -> OperationalErrorEvent? {
        let body = StarlingsHTTPTransport.errorBody(in: data)
        let serverCode = body?.code
        let classification: Classification
        switch serverCode {
        case ControlErrorCodeValue.ownerAuthRequired.rawValue where response.statusCode == 401 || response.statusCode == 403:
            classification = .init(code: .authSessionExpired, errorClass: .authorization, serverCode: nil)
        case ControlErrorCodeValue.calendarExpired.rawValue:
            classification = .init(code: .calendarExpired, errorClass: .authorization, serverCode: .calendarExpired)
        case ControlErrorCodeValue.calendarFailed.rawValue where response.statusCode >= 500:
            classification = .init(code: .calendarFailed, errorClass: .upstream, serverCode: .calendarFailed)
        case ControlErrorCodeValue.upstreamShape.rawValue where response.statusCode >= 500:
            classification = .init(code: .upstreamShape, errorClass: .upstream, serverCode: .upstreamShape)
        case ControlErrorCodeValue.internalError.rawValue where response.statusCode >= 500:
            classification = .init(code: .internalError, errorClass: .init(rawValue: "internal"), serverCode: .internalError)
        default:
            guard response.statusCode >= 500 else { return nil }
            classification = .init(code: .serviceUnavailable, errorClass: .http, serverCode: nil)
        }
        return event(
            classification,
            status: response.statusCode,
            requestID: StarlingsHTTPTransport.requestID(in: response, data: data),
            retryCount: retryCount,
            operation: operation(context: request.url?.path)
        )
    }

    static func transportFailure(_ error: Error, request: URLRequest) -> OperationalErrorEvent? {
        guard let urlError = error as? URLError else { return nil }
        let classification: Classification
        switch urlError.code {
        case .timedOut:
            classification = .init(code: .serviceTimeout, errorClass: .timeout, serverCode: nil)
        case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
            classification = .init(code: .serviceOffline, errorClass: .network, serverCode: nil)
        case .cancelled:
            return nil
        default:
            return nil
        }
        return event(classification, status: nil, requestID: nil, retryCount: 0, operation: operation(context: request.url?.path))
    }

    static func invalidResponse(request: URLRequest) -> OperationalErrorEvent? {
        event(
            .init(code: .serviceInvalidResponse, errorClass: .decode, serverCode: nil),
            status: nil,
            requestID: nil,
            retryCount: 0,
            operation: operation(context: request.url?.path)
        )
    }

    static func decodeFailure(request: URLRequest) -> OperationalErrorEvent? {
        invalidResponse(request: request)
    }

    static func operation(context: String?) -> OperationalErrorEventOperation {
        let components = (context ?? "").split(separator: "/").map(String.init)
        let route = components.first == "api" ? Array(components.dropFirst()) : components
        let operation: OperationalErrorEventOperation
        switch route.first {
        case "auth": operation = .auth
        case "calendar", "events": operation = .calendar
        case "rooms", "meetings": operation = route.contains("join-requests") ? .lobby : .room
        case "lobby", "join-requests": operation = .lobby
        case "media": operation = .media
        case "transcripts": operation = .transcription
        case "artifacts": operation = .room
        case "transcription": operation = .transcription
        case "chat", "messages": operation = .chat
        case "threads", "peers", "team": operation = .team
        case "work", "crm", "tasks": operation = .work
        case "docs": operation = .docs
        case "notes", "quick-notes": operation = .notes
        case "search": operation = .search
        case "profile": operation = .profile
        default: operation = .other
        }
        return operation
    }

    private static func operation(forErrorCode code: String) -> OperationalErrorEventOperation {
        switch code.split(separator: ".").first.map(String.init) {
        case "auth": .auth
        case "calendar": .calendar
        case "connect", "session": .room
        case "media": .media
        case "transcription": .transcription
        case "chat": .chat
        case "team": .team
        case "work", "crm": .work
        case "docs": .docs
        case "notes": .notes
        case "search": .search
        default: .other
        }
    }

    private static func event(
        _ classification: Classification,
        status: Int?,
        requestID: String?,
        retryCount: Int,
        operation: OperationalErrorEventOperation
    ) -> OperationalErrorEvent {
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
            release: release,
            code: classification.code,
            operation: operation,
            errorClass: classification.errorClass,
            httpStatus: status,
            serverCode: classification.serverCode,
            requestID: requestID,
            retryCount: min(max(retryCount, 0), 10)
        )
    }

    private static var release: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        let value = "\(version) (\(build))"
        let pattern = "^[A-Za-z0-9][A-Za-z0-9.+() _-]{0,39}$"
        return value.range(of: pattern, options: .regularExpression) == nil ? "0.0.0" : value
    }
}

/// Small app-private disk queue. Only generated allowlisted wire events are
/// persisted; request bodies, tokens, URLs, exception messages and diagnostics
/// are never accepted by this type.
actor StarlingsOperationalErrorSpool {
    static let shared = StarlingsOperationalErrorSpool()

    static let capacity = 50
    static let retention: TimeInterval = 7 * 24 * 60 * 60
    private static let deduplicationWindow: TimeInterval = 30
    private static let batchSize = 10
    private static let maximumBackoff: TimeInterval = 60 * 60

    private struct QueuedEvent: Codable {
        let queuedAt: Date
        var lastSeenAt: Date
        var event: OperationalErrorEvent
    }

    private let fileURL: URL
    private var events: [QueuedEvent] = []
    private var didLoad = false
    private var isFlushing = false
    /// A failed upload waits before the next one, doubling to an hour, so a
    /// refused batch is not sent again on every successful request.
    private var nextFlushAt = Date.distantPast
    private var failedFlushes = 0
    /// The Worker refused this member the capability (403). Nothing will
    /// change that until the app restarts with another session.
    private var flushRefused = false

    init(fileURL: URL = StarlingsOperationalErrorSpool.defaultFileURL) {
        self.fileURL = fileURL
    }

    func enqueue(_ event: OperationalErrorEvent, at now: Date = Date()) {
        loadIfNeeded()
        prune(at: now)
        if let index = events.indices.last(where: { index in
            Self.sameFingerprint(events[index].event, event)
                && now.timeIntervalSince(events[index].lastSeenAt) <= Self.deduplicationWindow
        }) {
            events[index].lastSeenAt = now
            events[index].event.retryCount = min(10, events[index].event.retryCount + 1)
        } else {
            events.append(QueuedEvent(queuedAt: now, lastSeenAt: now, event: event))
        }
        if events.count > Self.capacity {
            events.removeFirst(events.count - Self.capacity)
        }
        persist()
    }

    func pendingEvents(at now: Date = Date()) -> [OperationalErrorEvent] {
        loadIfNeeded()
        prune(at: now)
        persist()
        return events.map(\.event)
    }

    func flush(using transport: StarlingsHTTPTransport, ownerToken: String, now: Date = Date()) async {
        guard !ownerToken.isEmpty, !isFlushing, !flushRefused, now >= nextFlushAt else { return }
        loadIfNeeded()
        prune(at: now)
        // An empty queue is the common case after every request: no disk work.
        guard !events.isEmpty else { return }
        isFlushing = true
        defer {
            isFlushing = false
            persist()
        }

        while !events.isEmpty {
            let batch = Array(events.prefix(Self.batchSize))
            let batchIDs = batch.map(\.event.eventID)
            do {
                let request = try transport.request(
                    path: ["operational-errors"],
                    method: "POST",
                    body: OperationalErrorBatch(events: batch.map(\.event)),
                    bearer: StarlingsBearerToken(ownerToken)
                )
                let (data, response) = try await transport.data(for: request)
                switch response.statusCode {
                case 400:
                    // The Worker cannot read this batch; sending it again cannot help.
                    events.removeAll { batchIDs.contains($0.event.eventID) }
                    continue
                case 403:
                    flushRefused = true
                    return
                default:
                    break
                }
                guard StarlingsHTTPTransport.isSuccessful(response.statusCode),
                      let acknowledgement = try? StarlingsHTTPTransport.decode(OperationalErrorIngestResponse.self, from: data)
                else { return backOff(from: now) }
                failedFlushes = 0
                let accepted = min(max(acknowledgement.accepted, 0), batch.count)
                guard accepted > 0 else { return backOff(from: now) }
                let acceptedIDs = Set(batchIDs.prefix(accepted))
                events.removeAll { acceptedIDs.contains($0.event.eventID) }
                if accepted < batch.count { return }
                persist()
            } catch {
                // Telemetry is best-effort and must never generate another event.
                return backOff(from: now)
            }
        }
    }

    private func backOff(from now: Date) {
        failedFlushes += 1
        let delay = min(Self.maximumBackoff, 30 * pow(2, Double(min(failedFlushes - 1, 7))))
        nextFlushAt = now.addingTimeInterval(delay)
    }

    static var defaultFileURL: URL {
        AppFolders.support.appendingPathComponent("operational-errors.json")
    }

    private static func sameFingerprint(_ lhs: OperationalErrorEvent, _ rhs: OperationalErrorEvent) -> Bool {
        lhs.source == rhs.source
            && lhs.platform == rhs.platform
            && lhs.release == rhs.release
            && lhs.code == rhs.code
            && lhs.operation == rhs.operation
            && lhs.errorClass == rhs.errorClass
            && lhs.httpStatus == rhs.httpStatus
            && lhs.serverCode == rhs.serverCode
    }

    private func loadIfNeeded() {
        guard !didLoad else { return }
        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch CocoaError.fileReadNoSuchFile, CocoaError.fileNoSuchFile {
            didLoad = true
            return
        } catch {
            // Unreadable for now (a protected file before first unlock): try
            // again later rather than overwrite the queue with an empty one.
            return
        }
        didLoad = true
        guard let stored = try? JSONDecoder().decode([QueuedEvent].self, from: data) else { return }
        events = stored + events
        prune(at: Date())
    }

    private func prune(at now: Date) {
        events.removeAll { now.timeIntervalSince($0.queuedAt) > Self.retention }
        if events.count > Self.capacity {
            events.removeFirst(events.count - Self.capacity)
        }
    }

    private func persist() {
        // Until the file has been read, writing would replace the queue on
        // disk with only the events of this launch.
        guard didLoad else { return }
        do {
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            guard !events.isEmpty else {
                if FileManager.default.fileExists(atPath: fileURL.path) {
                    try FileManager.default.removeItem(at: fileURL)
                }
                return
            }
            let data = try JSONEncoder().encode(events)
            var options: Data.WritingOptions = [.atomic]
            #if os(iOS)
            // Readable after the first unlock: a meeting runs with the screen
            // locked, and its errors must not be lost to a locked file.
            options.insert(.completeFileProtectionUntilFirstUserAuthentication)
            #endif
            try data.write(to: fileURL, options: options)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch {
            // Failure to persist telemetry must not affect app operations.
        }
    }
}
