import Foundation
import OSLog

#if canImport(ActivityKit)
import ActivityKit
#endif

/// Starts, updates, and ends the Lock Screen / Dynamic Island countdown to the
/// next meeting.
///
/// Without APNs an activity can only be requested while the app is running, so
/// this runs on every refresh: the countdown appears the first time the app is
/// opened inside the lead window and then lives on its own. The system caps an
/// active Live Activity at eight hours, which is why the lead window is a
/// setting rather than "as soon as we know about it".
///
/// The same limit applies to ending it. A suspended app cannot end anything,
/// so the tile would sit at 0:00 after the meeting until Meet next ran. The
/// one thing the system schedules for us is dismissal, and only of an activity
/// that has already ended: `handOffForSuspension` uses that at the last moment
/// the app runs (see there for the trade).
///
/// Deliberately not `@MainActor` — `Activity` is not `Sendable`, so every handle
/// is fetched and used inside this one non-isolated task rather than hopping.
enum MeetingLiveActivity {
    /// Every gate that can leave the Lock Screen empty says so here. Filter
    /// Console on subsystem `com.starlingshq.app`, category `LiveActivity`.
    private static let log = Logger(subsystem: ContractConstants.nativeAppBundleID, category: "LiveActivity")

    /// Why `isEligible` said no, for the log. `nil` means it said yes.
    static func ineligibilityReason(
        _ event: MobileCalendarEvent?,
        now: Date,
        enabled: Bool,
        countdownLead: TimeInterval
    ) -> String? {
        guard enabled else { return "alerts off in Settings" }
        guard let event else { return "no focus meeting" }
        guard let start = event.startDate, let end = event.endDate else { return "focus has no start or end" }
        guard end > now else { return "focus already ended" }
        guard start <= now.addingTimeInterval(countdownLead) else {
            return "focus starts in \(Int(start.timeIntervalSince(now) / 60)) min, lead is \(Int(countdownLead / 60)) min"
        }
        return nil
    }

    /// Every focus meeting gets the countdown, video link or not: the tile is
    /// about being on time, and an in-person meeting has a start as much as a
    /// call does. Without a link the widget shows no Join and opens the app.
    static func isEligible(
        _ event: MobileCalendarEvent?,
        now: Date,
        enabled: Bool,
        countdownLead: TimeInterval
    ) -> Bool {
        ineligibilityReason(event, now: now, enabled: enabled, countdownLead: countdownLead) == nil
    }

    static func synchronize(next: MobileCalendarEvent?, now: Date = Date()) async {
        #if canImport(ActivityKit)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            log.notice("Live Activities are off for Meet in iOS Settings")
            await endAll()
            return
        }

        if let reason = ineligibilityReason(
            next,
            now: now,
            enabled: MeetingAlertSettings.enabled,
            countdownLead: MeetingAlertSettings.countdownLead
        ) {
            log.notice("No activity: \(reason, privacy: .public)")
            await endAll()
            return
        }
        guard let event = next, let start = event.startDate, let end = event.endDate else {
            await endAll()
            return
        }

        log.notice("Focus \(event.id, privacy: .public): platform \(event.platform, privacy: .public), conferenceUrl \(event.conferenceUrl.isEmpty ? "empty" : "set", privacy: .public), joinUrl \(event.joinUrl.isEmpty ? "empty" : "set", privacy: .public), launchURL \(event.conferenceLink == nil ? "nil" : "ok", privacy: .public), isVideo \(event.isVideoMeeting, privacy: .public)")
        let content = ActivityContent(
            state: MeetingActivityAttributes.ContentState(
                title: event.title,
                start: start,
                end: end,
                calendarName: event.calendarSummary,
                travelTimeMinutes: event.travelTimeMinutes,
                launchURL: event.conferenceLink,
                isVideo: event.isVideoMeeting,
                attendees: event.attendees.filter { !$0.isSelf }.map { StarlingsGlance.firstName($0.name, email: $0.email) }
            ),
            // Stale at the start instant so the widget flips itself from
            // "starts in" to "in progress" with no update from us. When the
            // app is active, the boundary refresh updates this to the end time;
            // a suspended app can still show the scheduled countdown, but it
            // cannot receive the second local update without APNs.
            staleDate: now < start ? start : end
        )

        var matched = false
        for activity in Activity<MeetingActivityAttributes>.activities {
            // Only a live activity can take an update. One that
            // `handOffForSuspension` ended is still listed until the system
            // dismisses it; replace it with a fresh request so the Dynamic
            // Island comes back while the app is in front.
            if !matched, activity.activityState == .active, activity.attributes.eventID == event.id {
                matched = true
                await activity.update(content)
            } else {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
        guard !matched else {
            log.info("Updated activity for \(event.id, privacy: .public)")
            return
        }
        do {
            _ = try Activity.request(
                attributes: MeetingActivityAttributes(eventID: event.id),
                content: content,
                pushType: nil
            )
            log.info("Requested activity for \(event.id, privacy: .public)")
        } catch {
            log.error("Activity request failed: \(error.localizedDescription, privacy: .public)")
        }
        #endif
    }

    /// Called as the app goes to background. For an activity whose meeting has
    /// started, this ends it now and lets the system remove it at the meeting's
    /// end, which is the only scheduled removal ActivityKit offers without
    /// push. The content is unchanged, so the Lock Screen tile keeps ticking
    /// down to the end; the cost is the Dynamic Island, which drops an ended
    /// activity at once. A countdown to a meeting that has not started is left
    /// alone: ending it would take the pill away before it has done its job,
    /// and the app can still end it on its next run.
    static func handOffForSuspension(now: Date = Date()) async {
        #if canImport(ActivityKit)
        for activity in Activity<MeetingActivityAttributes>.activities {
            guard activity.activityState == .active else { continue }
            let state = activity.content.state
            guard state.start <= now else { continue }
            // `.after` is capped at four hours past the end call; a meeting
            // longer than that lingers, which is the pre-existing behaviour.
            await activity.end(activity.content, dismissalPolicy: .after(state.end))
            log.info("Handed \(activity.attributes.eventID, privacy: .public) to the system, dismisses at \(state.end, privacy: .public)")
        }
        #endif
    }

    static func endAll() async {
        #if canImport(ActivityKit)
        for activity in Activity<MeetingActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        #endif
    }
}
