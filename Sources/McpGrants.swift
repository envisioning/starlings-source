import Foundation
import StarlingsContracts

// Connected agents (docs/MCP.md §The record): what Settings › Account on the
// Mac and the phone read off the generated `McpGrant` and `McpCallEntry`.
// Shared by both native clients the way `QuickNotes.swift` is.

extension McpGrant: Identifiable {
    var writes: Bool { scopes.contains(.write) }

    /// "Reads" or "Reads and writes", the same words `/connect` used.
    var scopeDescription: String { writes ? String(localized: "Reads and writes") : String(localized: "Reads") }

    var lastCallDate: Date? {
        lastCallAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
    }

    /// Paused by the member: `/mcp` refuses its calls until Resume.
    var isPaused: Bool { pausedAt != nil }
}

extension McpCallEntry: Identifiable {
    var date: Date { Date(timeIntervalSince1970: TimeInterval(ts) / 1000) }

    /// What the trailing text says: when, for a call that went through; the
    /// refusal or failure otherwise.
    var outcomeDescription: String {
        let outcome: String
        if self.outcome == .ok {
            outcome = min(date, Date()).formatted(.relative(presentation: .named))
        } else if let detail, !detail.isEmpty {
            outcome = "\(self.outcome.rawValue) · \(detail)"
        } else {
            outcome = self.outcome.rawValue
        }
        guard replayed == true else { return outcome }
        return "\(outcome) · \(String(localized: "Replayed"))"
    }
}
