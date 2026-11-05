import EnvisioningUI
import SwiftUI

/// The shared sign-in button, tappable while it is busy.
///
/// `EnvisioningSignInButton` disables itself while `isLoading`, which is right
/// for a sign-in that is visibly under way and wrong for one that is not: an
/// auth sheet that failed to present leaves the app "signing in" with nothing
/// on screen, and a disabled button gives the person no way to say so. A tap
/// on the busy button goes to `StarlingsAppModel.signIn`, which supersedes the
/// attempt in flight — see the note there.
struct MobileSignInButton: View {
    @EnvironmentObject private var app: StarlingsAppModel
    /// The workspace the button signs in to names it.
    @ObservedObject private var workspace = StarlingsWorkspaceStore.shared
    var prominence: EnvisioningButtonProminence = .bordered
    /// Runs before the sign-in starts, for a screen that clears its own status.
    var onTap: (() -> Void)? = nil

    var body: some View {
        Group {
            if prominence == .filled {
                button.buttonStyle(StarlingsFilledButtonStyle())
            } else {
                button.buttonStyle(StarlingsBorderedButtonStyle())
            }
        }
        .overlay {
            if app.isSigningIn {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture(perform: start) // hover: catches taps over the busy (disabled) button, which stays inert by rule
                    .accessibilityHidden(true)
            }
        }
    }

    private var button: some View {
        Button(action: start) {
            HStack(spacing: 8) {
                // The mark is identity, not an accent CTA: it stays neutral
                // in both appearances and remains beside the action label.
                // While signing in, the spinner is the one moving element and
                // the flock rests.
                StarlingsWorkspaceMarkView(
                    workspace: workspace.current,
                    data: workspace.markData,
                    size: 16,
                    signedOut: true,
                    flockMotion: app.isSigningIn ? .still : .drift
                )
                if app.isSigningIn {
                    ProgressView()
                        .tint(prominence == .filled ? StarlingsMobileColors.accentInk : .primary)
                }
                Text(app.isSigningIn ? EnvisioningCopy.signingIn : title)
            }
        }
        .disabled(app.isSigningIn)
        .accessibilityLabel(app.isSigningIn ? EnvisioningCopy.signingIn : title)
    }

    /// **Sign in** (docs/DESIGN.md §Copy law).
    private var title: String {
        String(localized: "Sign in")
    }

    private func start() {
        onTap?()
        Task { await app.signIn() }
    }
}
