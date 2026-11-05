import SwiftUI
import WatchKit

/// Meet on the wrist: next meeting and the quick notes. It hosts
/// nothing, joins nothing, and records nothing — see docs/PRIVACY.md and
/// issue #179 for the line.
@main
struct StarlingsWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var delegate
    @StateObject private var store = WatchStore.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WatchHomeView()
                .environmentObject(store)
                .onAppear { store.start() }
                .onOpenURL { store.open($0) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.enterForeground() }
        }
    }
}

/// The background refresh `WatchStore` asks for while a note is queued. The
/// system picks the moment; the store sends what it can and asks again if
/// anything is left.
final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        for task in backgroundTasks {
            switch task {
            case let refresh as WKApplicationRefreshBackgroundTask:
                Task { @MainActor in
                    await WatchStore.shared.backgroundRefresh()
                    refresh.setTaskCompletedWithSnapshot(false)
                }
            default:
                task.setTaskCompletedWithSnapshot(false)
            }
        }
    }
}
