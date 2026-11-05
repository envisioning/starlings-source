import SwiftUI

/// An error the way SwiftUI shows one, on the Mac and on the phone: red text
/// and a Copy button. The AppKit twin is `StarlingsNoticeView`; the web's is
/// `ErrorNotice.tsx`. Nothing that says a failure out loud should render
/// without a way to put it on the clipboard.
struct StarlingsErrorNotice: View {
    let message: String
    /// The code or raw text Copy adds after the prose, when the site has one.
    var detail: String? = nil
    var font: Font = .footnote
    var alignment: TextAlignment = .leading
    /// A failed *refresh*, when the list behind this is still the last good
    /// one (docs/CACHING.md): the line says how old that list is and offers
    /// Retry. A failed write passes neither.
    var updatedAt: Date? = nil
    var retry: (() -> Void)? = nil
    @ObservedObject private var upgrade = StarlingsUpgradeRecommendation.shared

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(text)
                .font(font)
                .foregroundStyle(StarlingsSemanticColors.danger)
                .multilineTextAlignment(alignment)
                .frame(maxWidth: .infinity, alignment: frameAlignment)
            if upgrade.requires(message) {
                // Too old for the route: retrying cannot fix it.
                StarlingsInlineNoticeButton(title: String(localized: "Update"), accessibilityLabel: StarlingsUpgradeRecommendation.requiredTitle, tint: .secondary) {
                    upgrade.requestUpdate()
                }
            } else if let retry {
                StarlingsInlineNoticeButton(title: String(localized: "Retry"), accessibilityLabel: String(localized: "Retry loading"), tint: .secondary, action: retry)
            }
            StarlingsCopyErrorButton(message: message, detail: detail)
        }
        .accessibilityElement(children: .combine)
    }

    private var text: String {
        guard let updatedAt else { return message }
        return String(localized: "\(message) · \(SnapshotStore.updatedLabel(updatedAt))")
    }

    private var frameAlignment: Alignment {
        switch alignment {
        case .center: .center
        case .trailing: .trailing
        default: .leading
        }
    }
}

struct StarlingsCopyErrorButton: View {
    let message: String
    var detail: String? = nil
    @State private var copied = false

    var body: some View {
        StarlingsInlineNoticeButton(
            title: copied ? String(localized: "Copied") : String(localized: "Copy"),
            accessibilityLabel: String(localized: "Copy error"),
            tint: StarlingsSemanticColors.danger
        ) {
            StarlingsErrorReport.copy(message: message, detail: detail)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        }
    }
}

/// The small outlined verb a notice line carries — Copy, Retry.
struct StarlingsInlineNoticeButton: View {
    let title: String
    let accessibilityLabel: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption2.weight(.medium))
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(tint.opacity(0.55), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        #if os(iOS)
        // The outlined verb owns a shell: the veil, at the outline's radius.
        .meetHoverLift(cornerRadius: 5)
        #endif
        .foregroundStyle(tint)
        .accessibilityLabel(accessibilityLabel)
    }
}

extension View {
    /// The error alert every SwiftUI surface uses: a title, the message, OK,
    /// and Copy. `message` is the source of truth — the alert shows while it is
    /// non-nil and clears it on dismiss, so a site keeps one optional string
    /// and nothing else.
    func meetErrorAlert(_ title: String, message: Binding<String?>, detail: String? = nil) -> some View {
        alert(title, isPresented: Binding(
            get: { message.wrappedValue != nil },
            set: { if !$0 { message.wrappedValue = nil } }
        )) {
            Button("Copy") {
                if let text = message.wrappedValue {
                    StarlingsErrorReport.copy(message: text, detail: detail)
                }
                message.wrappedValue = nil
            }
            Button("OK", role: .cancel) { message.wrappedValue = nil }
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}

/// A load that did not land, filling the space the content would have taken:
/// the failure in red, Try again, and Copy. Replaces `EnvisioningRetryState`
/// here because that one neither reads as an error nor copies.
struct StarlingsRetryState: View {
    let title: String
    let message: String
    var detail: String? = nil
    var systemImage: String = "exclamationmark.triangle"
    let action: () -> Void
    @ObservedObject private var upgrade = StarlingsUpgradeRecommendation.shared

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
                .foregroundStyle(StarlingsSemanticColors.danger)
        } actions: {
            HStack(spacing: 12) {
                if upgrade.requires(message) || upgrade.requires(title) {
                    Button("Update") { upgrade.requestUpdate() }
                } else {
                    Button("Try again", action: action)
                }
                StarlingsCopyErrorButton(message: "\(title) — \(message)", detail: detail)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
    }
}

/// The compact counterpart for a list row or banner: the failure in red, the
/// row itself is Try again, and Copy sits at the end.
struct StarlingsInlineRetry: View {
    let message: String
    var detail: String? = nil
    let action: () -> Void
    @ObservedObject private var upgrade = StarlingsUpgradeRecommendation.shared

    var body: some View {
        let update = upgrade.requires(message)
        HStack(spacing: 8) {
            Button {
                if update { upgrade.requestUpdate() } else { action() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: update ? "arrow.down.circle" : "exclamationmark.arrow.triangle.2.circlepath")
                    Text(message)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    Text(update ? String(localized: "Update") : String(localized: "Try again"))
                        .fontWeight(.medium)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            #if os(iOS)
            .meetPointerHighlight()
            #endif
            .accessibilityLabel(update ? String(localized: "\(message). Update") : String(localized: "\(message). Try again"))
            StarlingsCopyErrorButton(message: message, detail: detail)
        }
        .font(.caption)
        .foregroundStyle(StarlingsSemanticColors.danger)
    }
}
