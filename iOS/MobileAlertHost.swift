import SwiftUI

/// Where `StarlingsAppModel.alertMessage` is allowed to appear.
///
/// UIKit refuses to present an alert from a controller that is already
/// presenting something, and it fails by logging rather than by throwing. With
/// the only alert attached to the tab bar, every error raised from a sheet —
/// including a rejected sign-in — was swallowed: the Google sheet closed, the
/// 403 landed in `alertMessage`, and nothing appeared. A failed sign-in was
/// indistinguishable from a successful one.
///
/// So each screen that can raise an error hosts the alert at its own depth, and
/// exactly one of them presents: the deepest host currently on screen. Sheets
/// inherit the environment, so depth counts itself.
private struct StarlingsAlertDepthKey: EnvironmentKey {
    static let defaultValue = 0
}

extension EnvironmentValues {
    var meetAlertDepth: Int {
        get { self[StarlingsAlertDepthKey.self] }
        set { self[StarlingsAlertDepthKey.self] = newValue }
    }
}

private struct StarlingsAlertHost: ViewModifier {
    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.meetAlertDepth) private var depth

    func body(content: Content) -> some View {
        content
            // Anything this view presents sits one layer above it.
            .environment(\.meetAlertDepth, depth + 1)
            .onAppear { app.registerAlertHost(depth: depth) }
            .onDisappear { app.unregisterAlertHost(depth: depth) }
            // Every error alert carries Copy — `meetErrorAlert` is the shape,
            // but presentation here is gated on depth, so the binding is
            // hand-rolled to only show at the topmost host.
            .alert("Starlings", isPresented: Binding(
                get: { app.alertMessage != nil && app.topAlertHostDepth == depth },
                set: { if !$0 { app.alertMessage = nil } }
            )) {
                Button("Copy") {
                    if let message = app.alertMessage { StarlingsErrorReport.copy(message: message) }
                    app.alertMessage = nil
                }
                Button("OK", role: .cancel) {}
            } message: {
                Text(app.alertMessage ?? "")
            }
            // A link for another workspace: open it there, or not.
            .alert(
                app.linkWorkspaceOffer.map { String(localized: "This link is for \($0.workspace.name).") } ?? "",
                isPresented: Binding(
                    get: { app.linkWorkspaceOffer != nil && app.topAlertHostDepth == depth },
                    set: { if !$0 { app.linkWorkspaceOffer = nil } }
                )
            ) {
                Button(app.linkWorkspaceOffer.map { String(localized: "Open in \($0.workspace.name)") } ?? "") {
                    app.acceptLinkWorkspaceOffer()
                }
                Button("Cancel", role: .cancel) {}
            }
    }
}

extension View {
    /// Host `app.alertMessage` here while this is the topmost such host.
    /// Apply to the root of every sheet that can raise one — otherwise the
    /// error is raised into a layer that cannot show it. The toast host rides
    /// along at the same depth (`StarlingsToast.swift`): a sheet that can raise an
    /// alert can say something in passing too, and the depth rule is the same.
    func meetAlertHost() -> some View { modifier(StarlingsAlertHost()).meetToastHost() }
}
