import Foundation
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// What Copy puts on the clipboard next to every error, on every surface.
///
/// One line, version first: the build is the first thing anybody is asked when
/// they report something, and an error pasted into a chat without it is a
/// second round-trip. A `StarlingsError` also contributes its code and the raw
/// diagnostic the prose deliberately leaves out. Compiled into both clients;
/// the web twin is `web/src/ErrorNotice.tsx`.
enum StarlingsErrorReport {
    static func text(for error: StarlingsError) -> String {
        let prose = [error.title, error.message]
            .filter { !$0.isEmpty }
            .joined(separator: " — ")
        return stamp("\(prose) [\(error.logLine)]")
    }

    /// For the many sites that only have a sentence. `detail` is the code or
    /// raw text when the caller has one.
    static func text(for message: String, detail: String? = nil) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty, detail != trimmed {
            return stamp("\(trimmed) [\(detail)]")
        }
        return stamp(trimmed)
    }

    private static func stamp(_ body: String) -> String {
        "Starlings \(platform) \(version) — \(body)"
    }

    private static var platform: String {
        #if os(macOS)
        "Mac"
        #else
        "iOS"
        #endif
    }

    private static var version: String {
        let marketing = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "–"
        return String(localized: "\(marketing) (\(build))")
    }

    @MainActor
    static func copy(_ text: String) {
        #if canImport(AppKit)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        #elseif canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }

    @MainActor
    static func copy(_ error: StarlingsError) {
        copy(text(for: error))
    }

    @MainActor
    static func copy(message: String, detail: String? = nil) {
        copy(text(for: message, detail: detail))
    }
}
