import Foundation
import IOKit.pwr_mgt

/// Keeps the host Mac awake while a meeting is live so the 10s admission lease
/// does not expire when the display or system would otherwise idle-sleep.
@MainActor
final class HostWakeAssertion {
    private var systemAssertionID: IOPMAssertionID = 0
    private var displayAssertionID: IOPMAssertionID = 0
    private var hasSystemAssertion = false
    private var hasDisplayAssertion = false
    private var processActivity: NSObjectProtocol?

    /// True when at least one sleep-prevention mechanism is held.
    private(set) var isActive = false

    /// Human-readable detail for live-status UI.
    var statusDetail: String {
        guard isActive else { return "Sleep prevention off" }
        if hasSystemAssertion || hasDisplayAssertion {
            return String(localized: "Keeping Mac awake")
        }
        if processActivity != nil {
            return String(localized: "Keeping Mac awake · fallback")
        }
        return String(localized: "Keeping Mac awake")
    }

    func begin(reason: String = "Hosting a Starlings room") {
        end()

        var systemID = IOPMAssertionID(0)
        let systemResult = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason as CFString,
            &systemID
        )
        if systemResult == kIOReturnSuccess {
            systemAssertionID = systemID
            hasSystemAssertion = true
        }

        var displayID = IOPMAssertionID(0)
        let displayResult = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            reason as CFString,
            &displayID
        )
        if displayResult == kIOReturnSuccess {
            displayAssertionID = displayID
            hasDisplayAssertion = true
        }

        // Belt-and-suspenders with ProcessInfo: covers App Nap and sudden termination
        // even if an IOPM create call fails in unusual environments.
        processActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled, .suddenTerminationDisabled],
            reason: reason
        )

        isActive = hasSystemAssertion || hasDisplayAssertion || processActivity != nil
    }

    func end() {
        if hasSystemAssertion {
            IOPMAssertionRelease(systemAssertionID)
            hasSystemAssertion = false
            systemAssertionID = 0
        }
        if hasDisplayAssertion {
            IOPMAssertionRelease(displayAssertionID)
            hasDisplayAssertion = false
            displayAssertionID = 0
        }
        if let processActivity {
            ProcessInfo.processInfo.endActivity(processActivity)
            self.processActivity = nil
        }
        isActive = false
    }
}
