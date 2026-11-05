import SwiftUI
import WidgetKit

/// Meet's widget extension: the meeting Live Activity, the next-meeting
/// widget, and the two Control Center controls.
@main
struct StarlingsActivitiesBundle: WidgetBundle {
    var body: some Widget {
        MeetingActivityWidget()
        NextMeetingWidget()
        TodayAgendaWidget()
        TodayWorkWidget()
        JoinNextMeetingControl()
        NewQuickNoteControl()
    }
}
