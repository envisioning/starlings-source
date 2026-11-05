import ActivityKit
import EnvisioningUI
import SwiftUI
import WidgetKit

/// The lock-screen and Dynamic Island countdown to the next meeting.
///
/// Every view here draws a `StarlingsGlance` built from `context.state` plus the
/// system's own clock — `StarlingsGlanceTimer(live: true)` ticks in minutes without
/// the app running,
/// and `context.hasStarted` (the activity's `staleDate`, or the clock at render
/// time) is what flips the layout from "to go" to "left". Nothing depends on an
/// update arriving, because on-device Live Activities cannot be updated while
/// the app is suspended.
struct MeetingActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MeetingActivityAttributes.self) { context in
            MeetingActivityContent(glance: context.glance, now: context.now)
                .widgetURL(context.glance.tapURL)
                .activityBackgroundTint(WidgetInk.panel)
                .activitySystemActionForegroundColor(WidgetInk.accent)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: StarlingsGlyphMark.meeting(isVideo: context.glance.isVideo))
                        .foregroundStyle(WidgetInk.accent)
                        .accessibilityLabel("Starlings")
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StarlingsGlanceTimer(glance: context.glance, now: context.now, live: true)
                        .font(.title3.monospacedDigit().weight(.semibold))
                        .frame(width: 78, alignment: .trailing)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.glance.title)
                        .font(.headline)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                        .allowsTightening(true)
                        .padding(.horizontal, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    StarlingsGlanceDetail(glance: context.glance, now: context.now)
                        .padding(.horizontal, 4)
                        .padding(.top, 2)
                }
            } compactLeading: {
                Image(systemName: StarlingsGlyphMark.meeting(isVideo: context.glance.isVideo))
                    .foregroundStyle(WidgetInk.accent)
                    .accessibilityLabel("Starlings")
            } compactTrailing: {
                StarlingsGlanceTimer(glance: context.glance, now: context.now, live: true)
                    .font(.caption.monospacedDigit())
                    .frame(width: 46, alignment: .trailing)
            } minimal: {
                Image(systemName: StarlingsGlyphMark.meeting(isVideo: context.glance.isVideo))
                    .foregroundStyle(WidgetInk.accent)
                    .accessibilityLabel("Open Starlings")
            }
            .widgetURL(context.glance.tapURL)
            .keylineTint(WidgetInk.accent)
        }
        // watchOS 11 mirrors the activity into the Smart Stack. Without this
        // the watch scales the phone layout; with it, `activityFamily` reads
        // `.small` there and the view below picks the wrist layout.
        .supplementalActivityFamilies([.small])
    }
}

private extension ActivityViewContext<MeetingActivityAttributes> {
    var now: Date { Date() }

    /// The layout flips on the stale date, but a render that happens after the
    /// start with a fresh activity must flip too: the app's boundary refresh
    /// updates the activity at the start instant with `staleDate` moved to the
    /// end, and that render is not stale. The timer already checks the clock;
    /// the labels around it have to agree with it.
    var hasStarted: Bool {
        isStale || state.start <= now
    }

    var glance: StarlingsGlance {
        StarlingsGlance(
            title: state.title,
            calendar: state.calendarName,
            start: state.start,
            end: state.end,
            isVideo: state.isVideo,
            launchURL: state.launchURL,
            eventReference: attributes.eventID,
            attendees: state.attendees ?? [],
            hasStarted: hasStarted
        )
    }
}

/// One entry point for the lock screen and the Smart Stack, split on the
/// family the system is rendering for. The system draws the rounded
/// container and the tint but insets nothing, so the margin is ours, at the
/// same 16/14 the app's cards use, inside the tinted area.
private struct MeetingActivityContent: View {
    @Environment(\.activityFamily) private var family
    let glance: StarlingsGlance
    let now: Date

    var body: some View {
        switch family {
        case .small:
            StarlingsGlanceRow(glance: glance, now: now, layout: .wrist, live: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
        default:
            StarlingsGlanceRow(glance: glance, now: now, layout: .wide, live: true)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
        }
    }
}
