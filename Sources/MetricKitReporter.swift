import Foundation
import StarlingsContracts
import MetricKit

/// Sends the crash, hang and metric payloads MetricKit hands this app to
/// `POST /api/diagnostics`, through the app's own signed-in API
/// client. The Mac ships Developer ID through R2, so Xcode Organizer never
/// sees its crashes; this is the only way a crash on the host Mac reaches us
/// without somebody reporting it.
///
/// MetricKit delivers each payload once, at most daily, usually at the next
/// launch. Delivery here is best effort: a payload that fails to upload
/// (offline, signed out) is logged and not retried. The payload holds call
/// stacks, versions and counters; MetricKit puts no tokens, transcript text
/// or email addresses in it.
final class MetricKitReporter: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    // Qualified: MetricKit has a `DiagnosticReport` of its own.
    typealias Upload = @Sendable (StarlingsContracts.DiagnosticReport) async throws -> Void

    /// The Worker refuses a `payload_json` longer than this, in UTF-16 code
    /// units (the length a JavaScript string reports).
    static let payloadLimit = 65_536
    /// The Worker refuses an `app_version` longer than this.
    static let appVersionLimit = 40

    private let platform: DiagnosticReportPlatform
    private let upload: Upload
    private let lock = NSLock()
    private var started = false

    init(platform: DiagnosticReportPlatform, upload: @escaping Upload) {
        self.platform = platform
        self.upload = upload
    }

    func start() {
        let first = lock.withLock { () -> Bool in
            defer { started = true }
            return !started
        }
        guard first else { return }
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads {
            send(kind: .metric, json: payload.jsonRepresentation(), fallback: nil)
        }
    }

    /// One report per crash and per hang, not per payload: a payload can hold
    /// several, and one diagnostic is much more likely to fit under the cap.
    /// CPU, disk-write and launch diagnostics have no kind in the contract and
    /// are not sent.
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                send(kind: .crash, json: crash.jsonRepresentation(), fallback: crash.metaData.jsonRepresentation())
            }
            for hang in payload.hangDiagnostics ?? [] {
                send(kind: .hang, json: hang.jsonRepresentation(), fallback: hang.metaData.jsonRepresentation())
            }
        }
    }

    private func send(kind: DiagnosticReportKind, json: Data, fallback: Data?) {
        guard let payloadJSON = Self.payloadJSON(json, fallback: fallback) else {
            NSLog("Meet diagnostics: a %@ payload is over the size limit and was not sent", kind.rawValue)
            return
        }
        let report = StarlingsContracts.DiagnosticReport(
            platform: platform,
            appVersion: Self.appVersion,
            kind: kind,
            payloadJson: payloadJSON
        )
        let upload = self.upload
        Task.detached(priority: .utility) {
            do {
                try await upload(report)
            } catch {
                NSLog("Meet diagnostics: a %@ payload was not sent: %@", kind.rawValue, error.localizedDescription)
            }
        }
    }

    /// The payload as a string under the cap. A crash or hang whose full call
    /// stack is too long goes out as its metadata alone (device, OS, version,
    /// exception type), marked truncated: a smaller report is better than
    /// none. JSON is never cut mid-document. Nil when even that is too long.
    static func payloadJSON(_ json: Data, fallback: Data?) -> String? {
        if let full = String(data: json, encoding: .utf8), full.utf16.count <= payloadLimit {
            return full
        }
        guard let fallback,
              let metaData = try? JSONSerialization.jsonObject(with: fallback),
              let wrapped = try? JSONSerialization.data(withJSONObject: [
                  "truncated": true,
                  "originalBytes": json.count,
                  "metaData": metaData,
              ] as [String: Any]),
              let string = String(data: wrapped, encoding: .utf8),
              string.utf16.count <= payloadLimit else { return nil }
        return string
    }

    static var appVersion: String {
        let marketing = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        return String("\(marketing) (\(build))".prefix(appVersionLimit))
    }
}
