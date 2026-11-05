import AuthenticationServices
import Foundation
import KeepKit
import KeepUI
import SwiftUI

// An agent's request for one Keep item (ADR 0007 decisions 5 and 10 to 12,
//), shared whole by the Mac and the phone.
//
// The agent posts a card in the task's thread: the item by name, the task,
// why, how long, and the public half of a key it made for this one request.
// A member of the item's vault approves here. Keep unlocks on this device
// (KeepUnlockGate), this device opens the item and seals it to the agent's
// key (KeepSession.release), and Keep stores only that. Then the card in
// Meet records who approved and until when. Meet never sees the value.

/// The choices the approver has. ADR 0007 decision 11: 15 minutes by
/// default, up to 24 hours.
enum KeepReleaseDuration: Int, CaseIterable, Identifiable {
    case quarterHour = 900
    case hour = 3600
    case fourHours = 14_400
    case day = 86_400

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .quarterHour: String(localized: "15 minutes")
        case .hour: String(localized: "1 hour")
        case .fourHours: String(localized: "4 hours")
        case .day: String(localized: "24 hours")
        }
    }
}

/// What a release card says, in one place for the Mac and the phone.
enum ThreadReleaseCard {
    /// "Vocab asks for Vendor login".
    static func title(askedBy: String, request: ThreadReleaseRequest, state: ThreadReleaseState?) -> String {
        String(localized: "\(askedBy) asks for \(state?.itemName ?? request.item)")
    }

    /// How long the agent asked for, in the system's words.
    static func askedFor(_ request: ThreadReleaseRequest) -> String? {
        guard let seconds = request.expiresInSeconds else { return nil }
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .full
        formatter.allowedUnits = seconds >= 3600 ? [.hour, .minute] : [.minute]
        return formatter.string(from: TimeInterval(seconds))
    }

    static func expiry(_ state: ThreadReleaseState) -> Date {
        Date(timeIntervalSince1970: TimeInterval(state.expiresAt) / 1000)
    }

    /// Approved and not past its expiry: End now is offered.
    static func isLive(_ state: ThreadReleaseState?, now: Date = Date()) -> Bool {
        guard let state, state.status == .approved || state.status == .used else { return false }
        return expiry(state) > now
    }

    /// The fact under the card. No state: the request waits.
    static func status(_ state: ThreadReleaseState?, now: Date = Date()) -> String? {
        guard let state else { return nil }
        let approver = state.approverName ?? state.approverEmail
        switch state.status {
        case .ended:
            return String(localized: "Ended by \(state.endedByEmail ?? approver).")
        case .used where expiry(state) > now:
            return String(localized: "Used. Approved by \(approver) until \(expiry(state).meetTimeString()).")
        case .used:
            return String(localized: "Used. Approved by \(approver).")
        default:
            if expiry(state) <= now { return String(localized: "Expired. Approved by \(approver).") }
            return String(localized: "Approved by \(approver) until \(expiry(state).meetTimeString()).")
        }
    }

    /// The request as KeepKit takes it.
    static func keepRequest(_ request: ThreadReleaseRequest, agentEmail: String) -> KeepReleaseRequest {
        KeepReleaseRequest(
            requestId: request.requestID,
            vault: request.vault,
            item: request.item,
            agent: agentEmail,
            task: request.task,
            reason: request.reason,
            sessionPublicKey: request.sessionPublicKey
        )
    }
}

/// Approve: unlock Keep, find the item, choose how long, seal it to the agent.
struct KeepReleaseSheet: View {
    @ObservedObject var session: KeepSession
    let request: ThreadReleaseRequest
    let agentEmail: String
    let agentName: String
    let connect: () async -> Void
    let anchor: @MainActor () -> ASPresentationAnchor
    /// Ask the card in Meet to record the release. Keep has it already.
    let onApproved: (KeepRelease) async throws -> Void
    let onClose: () -> Void

    @State private var duration: KeepReleaseDuration = .quarterHour
    @State private var vault: KeepVaultDetail?
    @State private var item: KeepItemSummary?
    @State private var resolveError: String?
    @State private var approveError: String?
    @State private var approving = false
    /// Keep made it, the card has not heard yet: a retry only tells the card.
    @State private var released: KeepRelease?

    var body: some View {
        KeepUnlockGate(session: session, connect: connect, anchor: anchor) {
            form
                .task { await resolve() }
        }
        .frame(minWidth: 380, minHeight: 360)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 0) {
            Form {
                Section {
                    LabeledContent("Agent", value: agentName)
                    LabeledContent("Item", value: item?.name ?? request.item)
                    LabeledContent("Vault", value: vault?.name ?? request.vault)
                    LabeledContent("Task", value: request.task)
                    LabeledContent("Why", value: request.reason)
                    if let asked = ThreadReleaseCard.askedFor(request) {
                        LabeledContent("Asked for", value: asked)
                    }
                }
                Section {
                    Picker("Ends in", selection: $duration) {
                        ForEach(KeepReleaseDuration.allCases) { choice in
                            Text(choice.label).tag(choice)
                        }
                    }
                }
                if let message = resolveError ?? approveError {
                    Section {
                        Text(message).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onClose() }
                    .keyboardShortcut(.cancelAction)
                Button(approving ? String(localized: "Approving…") : String(localized: "Approve")) {
                    Task { await approve() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(approving || vault == nil || item == nil)
            }
            .padding()
        }
    }

    private func resolve() async {
        guard vault == nil else { return }
        do {
            let found = try await session.resolveRelease(ThreadReleaseCard.keepRequest(request, agentEmail: agentEmail))
            vault = found.vault
            item = found.item
            resolveError = nil
        } catch {
            resolveError = error.localizedDescription
        }
    }

    private func approve() async {
        guard let vault, let item, !approving else { return }
        approving = true
        approveError = nil
        defer { approving = false }
        do {
            let release: KeepRelease
            if let released {
                release = released
            } else {
                release = try await session.release(
                    ThreadReleaseCard.keepRequest(request, agentEmail: agentEmail),
                    vault: vault,
                    item: item,
                    expiresInSeconds: duration.rawValue
                )
                released = release
            }
            try await onApproved(release)
            onClose()
        } catch {
            approveError = released == nil ? error.localizedDescription : String(localized: "Couldn’t update the card. Approve again.")
        }
    }
}
