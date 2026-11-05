import AppIntents
import SwiftUI
import WidgetKit

/// Control Center, the Lock Screen buttons and the Action button. Each control
/// is one press that opens the app on one verb. The intent runs here, in the
/// extension, which has no session and no navigation: it posts the verb to
/// the shared group and the app performs it on becoming active
/// (`StarlingsAppModel.performLaunchAction`).
struct JoinNextMeetingControl: ControlWidget {
    static let kind = "\(ContractConstants.nativeAppBundleID).control.join"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: JoinNextMeetingIntent()) {
                Label("Join meeting", systemImage: "video.fill")
            }
        }
        .displayName("Join meeting")
        .description("Open the next meeting in Starlings.")
    }
}

struct NewQuickNoteControl: ControlWidget {
    static let kind = "\(ContractConstants.nativeAppBundleID).control.note"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: NewQuickNoteIntent()) {
                Label("Quick note", systemImage: "note.text.badge.plus")
            }
        }
        .displayName("Quick note")
        .description("Capture a note in Starlings.")
    }
}

struct JoinNextMeetingIntent: AppIntent {
    static let title: LocalizedStringResource = "Join next meeting"
    static let description = IntentDescription("Opens the next meeting in Starlings.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        LaunchAction.joinNextMeeting.post()
        return .result()
    }
}

struct NewQuickNoteIntent: AppIntent {
    static let title: LocalizedStringResource = "New quick note"
    static let description = IntentDescription("Opens Starlings with the quick-note field ready.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        LaunchAction.newQuickNote.post()
        return .result()
    }
}
