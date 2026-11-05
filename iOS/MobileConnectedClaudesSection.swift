import EnvisioningUI
import SwiftUI

/// Settings › Account › Connected agents (docs/MCP.md §The record): the
/// person's own pairings, each with its scope, its last call, the tail of
/// its record, Pause and Revoke. Same rows as the Mac and the web.
struct MobileConnectedClaudesSection: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @State private var grants: [McpGrant]?
    @State private var calls: [String: [McpCallEntry]] = [:]
    @State private var open: String?
    @State private var errorMessage: String?

    var body: some View {
        Section {
            if let grants {
                if grants.isEmpty {
                    Text("None").foregroundStyle(.secondary)
                }
                ForEach(grants) { grant in
                    DisclosureGroup(isExpanded: binding(for: grant.id)) {
                        ForEach(calls[grant.id] ?? []) { call in
                            HStack(alignment: .firstTextBaseline) {
                                Text(call.name).font(.footnote.monospaced())
                                Text(call.args ?? "").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                                Spacer()
                                Text(call.outcomeDescription).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        if calls[grant.id]?.isEmpty == true {
                            Text("No calls yet.").font(.footnote).foregroundStyle(.secondary)
                        }
                        // Two literals, not a ternary: a literal is what makes the title a catalog key.
                        if grant.isPaused {
                            Button("Resume") { Task { await setPaused(grant.id, paused: false) } }
                        } else {
                            Button("Pause") { Task { await setPaused(grant.id, paused: true) } }
                        }
                        Button("Revoke", role: .destructive) { Task { await revoke(grant.id) } }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(grant.clientName)
                            Text(detail(for: grant)).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                EnvisioningPlaceholderRows(count: 2)
            }
            connectorAddressRow
            if let errorMessage {
                StarlingsErrorNotice(message: errorMessage)
            }
        } header: {
            Text("Connected agents")
        }
        .task { await load() }
    }

    /// The name and the address a member gives Claude or any MCP client, each
    /// with Copy, and the help page that says where to add them. The name is
    /// the one the server gives itself. The same rows on the Mac and the web.
    @ViewBuilder private var connectorAddressRow: some View {
        CopyValueRow(title: "Connector name", value: StarlingsWorkspace.active.mcpServerName)
        CopyValueRow(title: "Connector address", value: StarlingsWorkspace.active.mcpAddress)
        if let help = StarlingsWorkspace.active.mcpConnectHelpURL {
            Link("How to connect Claude", destination: help)
        }
    }

    private func detail(for grant: McpGrant) -> String {
        let detail: String
        if let at = grant.lastCallDate {
            detail = String(localized: "\(grant.scopeDescription) · \(min(at, Date()).formatted(.relative(presentation: .named)))")
        } else {
            detail = String(localized: "\(grant.scopeDescription) · no calls yet")
        }
        return grant.isPaused ? "\(String(localized: "Paused")) · \(detail)" : detail
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { open == id },
            set: { expanded in
                open = expanded ? id : nil
                if expanded, calls[id] == nil { Task { await loadCalls(id) } }
            }
        )
    }

    private func load() async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            grants = try await app.api.mcpGrants(credentials: credentials)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadCalls(_ id: String) async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            calls[id] = try await app.api.mcpGrantCalls(credentials: credentials, id: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Pause stops the Claude at its next call and keeps the pairing.
    private func setPaused(_ id: String, paused: Bool) async {
        guard let credentials = app.ownerCredentials else { return }
        errorMessage = nil
        do {
            grants = try await app.api.setMcpGrantPaused(credentials: credentials, id: id, paused: paused)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func revoke(_ id: String) async {
        guard let credentials = app.ownerCredentials else { return }
        errorMessage = nil
        do {
            grants = try await app.api.revokeMcpGrant(credentials: credentials, id: id)
            if open == id { open = nil }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// One value with Copy: the label, the value in monospace, then Copy, which
/// reads Copied for a moment.
private struct CopyValueRow: View {
    let title: LocalizedStringKey
    let value: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(value).font(.footnote.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
        }
        // Two literals, not a ternary: a literal is what makes the title a catalog key.
        if copied {
            Button("Copied") {}.disabled(true)
        } else {
            Button("Copy") {
                UIPasteboard.general.string = value
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            }
        }
    }
}
