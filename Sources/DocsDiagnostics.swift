import OSLog

/// PII-free breadcrumbs for diagnosing failures in Docs. Keep event names and
/// counts only; never log titles, IDs, queries, or response bodies.
enum DocsDiagnostics {
    private static let logger = Logger(subsystem: ContractConstants.nativeAppBundleID, category: "Docs")

    static func event(_ name: String) {
        logger.info("\(name, privacy: .public)")
    }

    static func count(_ name: String, _ value: Int) {
        logger.info("\(name, privacy: .public): \(value, privacy: .public)")
    }

    static func failure(_ stage: String, error: Error) {
        let type = String(reflecting: type(of: error))
        logger.error("\(stage, privacy: .public) failed; error type: \(type, privacy: .public)")
    }
}
