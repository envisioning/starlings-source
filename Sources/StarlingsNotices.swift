import AppKit
import UserNotifications

/// Local notifications for the two ways somebody reaches *you* on the Mac: a
/// knock on your room's door, and a Wave from a colleague.
///
/// The wire still says ring (`/api/peers/ring`, `PeerRing`, `RingNotices`);
/// only the words people read are Wave. See docs/SURFACES.md.
///
/// **These fire only while Meet is running.** There is no APNs registration and
/// no push payload, so a knock that lands while the app is quit is not
/// announced — it is simply waiting the next time you open it. That is the
/// honest ceiling of this app's notification infrastructure, and closing it
/// means a device-token table and a Worker that sends on write. Do not describe
/// any of this as push in user-facing copy.
///
/// Authorization asks for alerts only. The sound is ours: `KnockSound` plays
/// through `NSSound` whether or not banners were allowed, so the knock is heard
/// exactly once and is never silenced by a permission the person declined.
enum StarlingsNotices {
    /// Asked at the first knock rather than at launch — a permission prompt
    /// makes sense standing next to the thing that needs it.
    @discardableResult
    static func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert])) ?? false
        case .denied:
            return false
        default:
            return true
        }
    }

    @MainActor
    static func registerCategories() {
        UNUserNotificationCenter.current().setNotificationCategories(Set([
            KnockNotices.category,
            RingNotices.category,
            RingNotices.callCategory,
            RingNotices.agentStartCategory,
            MessageNotices.category,
            MeetingWarningNotices.category,
            InboxNotices.category,
        ] + StarlingsAutomationController.category))
    }
}

/// The literal sound of somebody at your door: two knuckle raps on wood,
/// synthesised by `scripts/make-knock-sound.py` rather than sampled, so the
/// asset is reproducible and retunable. Loaded once — an `NSSound` built per
/// knock clipped its own attack while the file was still being read.
@MainActor
enum KnockSound {
    private static let sound: NSSound? = {
        guard let url = Bundle.main.url(forResource: "knock", withExtension: "wav") else { return nil }
        return NSSound(contentsOf: url, byReference: false)
    }()

    static func play() {
        StarlingsSound.play(sound)
    }
}

/// Two chime partials, rising: somebody catching your eye rather than somebody
/// at a door. Synthesised by `scripts/make-wave-sound.py`, and played through
/// `NSSound` for the same reason the knock is — a sound a declined banner
/// permission can silence is not one the product can rely on.
///
/// Suppressed, at the call site in `PeerWatch`, when the person being waved at
/// is focused. The ring still lands; it simply does not interrupt.
@MainActor
enum WaveSound {
    private static let sound: NSSound? = {
        guard let url = Bundle.main.url(forResource: "wave", withExtension: "wav") else { return nil }
        return NSSound(contentsOf: url, byReference: false)
    }()

    static func play() {
        StarlingsSound.play(sound)
    }
}

/// The room noticing you arrive. Lower and slower than the wave, and the only
/// one of the three that is not another person — so it asks for nothing and
/// there is nothing to answer. See `scripts/make-welcome-sound.py`.
@MainActor
enum WelcomeSound {
    private static let sound: NSSound? = {
        guard let url = Bundle.main.url(forResource: "welcome", withExtension: "wav") else { return nil }
        return NSSound(contentsOf: url, byReference: false)
    }()

    static func play() {
        StarlingsSound.play(sound)
    }
}

/// What all three do with the `NSSound` once they have one.
@MainActor
private enum StarlingsSound {
    static func play(_ sound: NSSound?) {
        guard let sound else {
            // Bundling failed. A sound nobody hears is worse than the wrong one.
            NSSound.beep()
            return
        }
        // A second event arriving while the first is still ringing should
        // restart it, not be swallowed by the one already playing.
        if sound.isPlaying { sound.stop() }
        sound.play()
    }
}

/// Somebody is waiting at your door.
struct KnockNotice: Equatable, Sendable {
    let requestID: String
    let name: String
    let hasBooking: Bool
}

enum KnockNotices {
    static let categoryIdentifier = "MEET_KNOCK"
    static let requestIDKey = "requestID"
    static let admitAction = "MEET_KNOCK_ADMIT"
    static let declineAction = "MEET_KNOCK_DECLINE"
    private static let identifierPrefix = "meet.knock."

    static var category: UNNotificationCategory {
        UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [
                UNNotificationAction(identifier: admitAction, title: String(localized: "Admit"), options: [.foreground]),
                UNNotificationAction(identifier: declineAction, title: String(localized: "Decline"), options: [.destructive]),
            ],
            intentIdentifiers: [],
            options: []
        )
    }

    /// Deliver immediately. `trigger: nil` is what makes a local notification
    /// arrive now rather than on a schedule — the knock has already happened.
    static func deliver(_ notices: [KnockNotice]) async {
        guard !notices.isEmpty, await StarlingsNotices.requestAuthorization() else { return }
        let center = UNUserNotificationCenter.current()

        for notice in notices {
            let content = UNMutableNotificationContent()
            content.title = notice.name.isEmpty ? String(localized: "Someone is at your door") : String(localized: "\(notice.name) knocked")
            content.body = notice.hasBooking
                ? String(localized: "Waiting in your room · booked time")
                : "Waiting in your room"
            // Silent on purpose: `KnockSound` has already played the knock, and
            // a notification sound on top of it is two doors.
            content.sound = nil
            content.categoryIdentifier = categoryIdentifier
            content.userInfo = [requestIDKey: notice.requestID]
            // One thread, so a queue of four people stacks instead of covering
            // the screen.
            content.threadIdentifier = identifierPrefix
            try? await center.add(UNNotificationRequest(
                identifier: identifierPrefix + notice.requestID,
                content: content,
                trigger: nil
            ))
        }
    }

    /// A knock that has been answered — or that gave up and closed the tab —
    /// must not leave a banner offering to admit somebody who is gone.
    static func withdraw(requestIDs: some Sequence<String>) {
        let identifiers = requestIDs.map { identifierPrefix + $0 }
        guard !identifiers.isEmpty else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}

/// Somebody asked for you from Team. Quieter than a knock by
/// design: a wave is a nudge at a person, not a request at a door, so it gets
/// its own smaller sound rather than the knock.
enum RingNotices {
    static let categoryIdentifier = "MEET_RING"
    static let callerEmailKey = "callerEmail"
    static let roomSlugKey = "roomSlug"
    static let joinAction = "MEET_RING_JOIN"
    /// A call only. Opens *your* room and lets the caller straight in — the
    /// walk-up-to-a-desk gesture, which is the one thing a wave deliberately
    /// cannot do. See docs/SURFACES.md §Reaching a person.
    static let openAction = "MEET_RING_OPEN"
    private static let identifier = "meet.ring"

    /// Two categories, because the actions differ: a wave offers to walk you to
    /// *their* room, a call offers to open *yours*. One category with both
    /// buttons would put "Open my room" under a nudge nobody has to answer.
    static var category: UNNotificationCategory {
        UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [
                UNNotificationAction(identifier: joinAction, title: String(localized: "Join"), options: [.foreground]),
            ],
            intentIdentifiers: [],
            options: []
        )
    }

    static let callCategoryIdentifier = "MEET_CALL"

    static var callCategory: UNNotificationCategory {
        UNNotificationCategory(
            identifier: callCategoryIdentifier,
            actions: [
                UNNotificationAction(identifier: openAction, title: String(localized: "Open room"), options: [.foreground]),
                // Destructive, and named for what it says rather than for a
                // refusal: they are not being turned away, they are being told
                // now is not the moment.
                UNNotificationAction(identifier: declineAction, title: String(localized: "Not now"), options: [.destructive]),
            ],
            intentIdentifiers: [],
            options: []
        )
    }

    /// An agent's ask wears the call's two buttons — the decision is the
    /// same — under its own identifier, so the handler can send yes down the
    /// transcribing path rather than the walk-up one.
    static let agentStartCategoryIdentifier = "MEET_AGENT_START"

    static var agentStartCategory: UNNotificationCategory {
        UNNotificationCategory(
            identifier: agentStartCategoryIdentifier,
            actions: [
                UNNotificationAction(identifier: openAction, title: String(localized: "Open room"), options: [.foreground]),
                UNNotificationAction(identifier: declineAction, title: String(localized: "Not now"), options: [.destructive]),
            ],
            intentIdentifiers: [],
            options: []
        )
    }

    static let declineAction = "MEET_RING_DECLINE"

    /// `quiet` is focused: the banner still arrives and the row still shows
    /// somebody asked for you, and only the sound is withheld. Deciding that
    /// here rather than at the Worker is the point — a ring the server swallowed
    /// would leave the caller believing they had reached somebody.
    static func deliver(_ ring: PeerRing, quiet: Bool = false) async {
        // The sound is ours and plays first, whatever the banner permission
        // says — the same bargain `KnockSound` makes. A person who declined
        // notifications still hears their colleague wave.
        if !quiet { await MainActor.run { WaveSound.play() } }
        guard await StarlingsNotices.requestAuthorization() else { return }
        let content = UNMutableNotificationContent()
        let isCall = ring.kind == .call
        let isAgentAsk = ring.kind == .agentStart
        if isAgentAsk {
            content.title = String(localized: "\(ring.callerDisplayName) asks to open your room")
            content.body = String(localized: "The meeting is on your calendar. Nothing opens until you say so.")
        } else {
            content.title = isCall
                ? String(localized: "\(ring.callerDisplayName) wants to talk")
                : "\(ring.callerDisplayName) waved at you"
            content.body = isCall
                ? String(localized: "Open your room and they come straight in")
                : (ring.roomSlug.map { String(localized: "Asked for you · their room is \($0)") } ?? String(localized: "Asked for you in Work"))
        }
        // Silent: `WaveSound` above already played, and letting the banner add
        // the system sound on top would make one land twice.
        content.sound = nil
        content.categoryIdentifier = isAgentAsk
            ? agentStartCategoryIdentifier
            : (isCall ? callCategoryIdentifier : categoryIdentifier)
        var info: [String: String] = [callerEmailKey: ring.callerEmail]
        if let slug = ring.roomSlug { info[roomSlugKey] = slug }
        content.userInfo = info
        // One identifier for every ring: a second caller replaces the banner
        // rather than stacking, which matches the roster — it carries one.
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        ))
    }

    /// The ring expired, was answered, or was dismissed somewhere else.
    static func withdraw() {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
    }
}
