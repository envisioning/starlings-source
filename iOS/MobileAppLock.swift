import LocalAuthentication
import SwiftUI
import UIKit
import EnvisioningUI

/// Face ID / Touch ID in front of the whole app.
///
/// The device passcode is the fallback policy, not a second setting: biometry
/// fails for wet hands, a mask, or a re-enrolled face, and an app that only
/// accepts a face locks its owner out of their own agenda. `.deviceOwnerAuthentication`
/// asks for the face first and offers the passcode after a failure.
///
/// The lock is a *view* over the app, not a sign-out. Meet keeps its owner
/// tokens in the keychain and its calendar cache on disk either way — this
/// gate answers "somebody else picked up my unlocked phone", not "this device
/// is stolen". Say that plainly in the settings footer.
enum StarlingsAppLockSettings {
    static let enabledKey = "meet.appLock.enabled"

    /// A short trip out — the share sheet, a Safari link, the camera permission
    /// alert — is not a new visit. Re-locking after every task switch trains the
    /// owner to turn the whole feature off.
    static let graceInterval: TimeInterval = 15
}

/// What this device can actually ask for. Read once per prompt: a user can
/// enroll or un-enroll Face ID while the app is in the background.
enum StarlingsBiometry {
    case faceID
    case touchID
    case opticID
    case passcodeOnly
    case unavailable

    static func current() -> StarlingsBiometry {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return .unavailable
        }
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .opticID: return .opticID
        default: return .passcodeOnly
        }
    }

    var title: String {
        switch self {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        case .passcodeOnly: return "Passcode"
        case .unavailable: return "Device unlock"
        }
    }

    var symbolName: String {
        switch self {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        case .passcodeOnly, .unavailable: return "lock.fill"
        }
    }

    var isAvailable: Bool { self != .unavailable }
}

@MainActor
final class StarlingsAppLock: ObservableObject {
    /// Locked is the launch state whenever the setting is on. Nothing persists
    /// an "unlocked" flag: a cold launch always asks again.
    @Published private(set) var isLocked: Bool
    @Published private(set) var isAuthenticating = false
    @Published private(set) var failure: String?
    @Published private(set) var biometry: StarlingsBiometry

    private var backgroundedAt: Date?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let enabled = defaults.bool(forKey: StarlingsAppLockSettings.enabledKey)
        biometry = StarlingsBiometry.current()
        isLocked = enabled
    }

    var isEnabled: Bool { defaults.bool(forKey: StarlingsAppLockSettings.enabledKey) }

    // MARK: Scene phase

    func applicationDidEnterBackground() {
        // The system biometry sheet backgrounds nothing, but it does make the
        // scene inactive. Only a real background start the grace clock.
        backgroundedAt = Date()
    }

    func applicationWillEnterForeground() {
        biometry = StarlingsBiometry.current()
        guard isEnabled else {
            isLocked = false
            return
        }
        guard let left = backgroundedAt else { return }
        backgroundedAt = nil
        if Date().timeIntervalSince(left) >= StarlingsAppLockSettings.graceInterval {
            isLocked = true
            failure = nil
        }
    }

    // MARK: Unlocking

    /// What the prompts call this app. A phone can hold more than one
    /// Envisioning app, and "Unlock Envisioning" does not say which one is
    /// waiting behind the sheet.
    static let appName = "Starlings"

    func unlock() async {
        guard isLocked, !isAuthenticating else { return }
        isAuthenticating = true
        failure = nil
        let granted = await Self.evaluate(reason: EnvisioningCopy.unlockReason(app: Self.appName))
        isAuthenticating = false
        switch granted {
        case .success:
            isLocked = false
        case .cancelled:
            // The owner dismissed the sheet. Leave the gate up with its button,
            // and say nothing — they know what they did.
            break
        case .failed(let message):
            failure = message
        }
    }

    /// Turning the lock on proves the device can satisfy it before the setting
    /// sticks. Turning it off asks too, so somebody holding an already-unlocked
    /// phone cannot quietly remove the gate.
    func setEnabled(_ enabled: Bool) async -> Bool {
        biometry = StarlingsBiometry.current()
        guard biometry.isAvailable else {
            failure = EnvisioningCopy.biometricUnavailable
            return isEnabled
        }
        let reason = EnvisioningCopy.appLockReason(app: Self.appName, enabling: enabled)
        let granted = await Self.evaluate(reason: reason)
        switch granted {
        case .success:
            defaults.set(enabled, forKey: StarlingsAppLockSettings.enabledKey)
            failure = nil
            if !enabled { isLocked = false }
            return enabled
        case .cancelled:
            return isEnabled
        case .failed(let message):
            failure = message
            return isEnabled
        }
    }

    private enum Outcome {
        case success
        case cancelled
        case failed(String)
    }

    /// One `LAContext` per prompt. A reused context caches its last success and
    /// would hand back an unlock the owner never gave.
    private static func evaluate(reason: String) async -> Outcome {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return .failed("This device cannot ask for Face ID, Touch ID, or a passcode.")
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            return ok ? .success : .failed(EnvisioningCopy.biometricCouldNotConfirm)
        } catch let laError as LAError {
            switch laError.code {
            case .userCancel, .appCancel, .systemCancel:
                return .cancelled
            case .userFallback:
                return .cancelled
            default:
                return .failed(laError.localizedDescription)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

/// The cover. Keep it quiet: the system Face ID sheet supplies the explanation,
/// while this view only needs to make the unlock action available without
/// exposing the app surface underneath it.
struct StarlingsLockScreen: View {
    @ObservedObject var lock: StarlingsAppLock
    @ScaledMetric(relativeTo: .largeTitle) private var glyphSize: CGFloat = 26

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: lock.biometry.symbolName)
                .font(.system(size: glyphSize, weight: .medium))
                .foregroundStyle(StarlingsMobileColors.secondary)
                .accessibilityHidden(true)

            Button {
                Task { await lock.unlock() }
            } label: {
                Text(lock.isAuthenticating ? String(localized: "Unlocking…") : EnvisioningCopy.unlock)
                    .frame(minWidth: 112)
            }
            .buttonStyle(StarlingsBorderedButtonStyle(minHeight: 44, expands: false))
            .disabled(lock.isAuthenticating)

            if let failure = lock.failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(StarlingsMobileColors.danger)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
                    .accessibilityLabel("Unlock error: \(failure)")
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(StarlingsMobileColors.canvas.ignoresSafeArea())
        .foregroundStyle(StarlingsMobileColors.primary)
        // Face ID plays its own haptic on success; only a refusal needs one.
        .meetHaptic(.error, whenSet: lock.failure)
        // The prompt raises itself on arrival, so the common case is one look at
        // the phone and nothing to tap.
        .task { await lock.unlock() }
    }
}

extension View {
    /// Wraps the app root. The lock paints over the app in a window of its own
    /// rather than swapping the root content out. Swapping tore down whatever
    /// was presented above the root — including the live hosting cover, whose
    /// teardown ended the meeting for everyone the moment the owner took a
    /// phone call past the grace interval — and a `fullScreenCover` or sheet
    /// sits above the root, so an overlay drawn inside the root could never
    /// cover it. A window above the alert level covers every presentation,
    /// present and future, and the app keeps running underneath it.
    func meetAppLock(_ lock: StarlingsAppLock) -> some View {
        modifier(StarlingsAppLockGate(lock: lock))
    }
}

private struct StarlingsAppLockGate: ViewModifier {
    @ObservedObject var lock: StarlingsAppLock
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background: lock.applicationDidEnterBackground()
                case .active: lock.applicationWillEnterForeground()
                default: break
                }
            }
            .onChange(of: lock.isLocked) { _, locked in
                StarlingsLockWindow.setPresented(locked, lock: lock)
            }
            // Cold launch starts locked; there is no isLocked change to react
            // to, so the window has to be raised on first appearance too.
            .onAppear { StarlingsLockWindow.setPresented(lock.isLocked, lock: lock) }
    }
}

/// The lock's own `UIWindow`. `StarlingsLockScreen` takes the lock directly, so the
/// hosting controller needs no SwiftUI environment.
@MainActor
private enum StarlingsLockWindow {
    private static var window: UIWindow?

    static func setPresented(_ presented: Bool, lock: StarlingsAppLock) {
        guard presented else {
            window?.isHidden = true
            window = nil
            return
        }
        guard window == nil else { return }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive })
            ?? scenes.first else { return }
        let host = UIHostingController(rootView: StarlingsLockScreen(lock: lock))
        // The SwiftUI cover owns the same canvas as the app. Clear here so the
        // hosting view cannot introduce UIKit's system background around it.
        host.view.backgroundColor = .clear
        let next = UIWindow(windowScene: scene)
        next.windowLevel = .alert + 1
        next.rootViewController = host
        next.isHidden = false
        window = next
    }
}
