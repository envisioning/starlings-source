import Foundation

/// Home's setup checklist on the Mac and iOS (docs/ONBOARDING.md §The setup
/// checklist). The steps, their order and their words are the generated
/// `SetupStep` table; which are done is `GET /api/setup`. This file holds what
/// both clients decide the same way: which rows draw, when the card draws at
/// all, and where a step opens. The web's `SetupCard.tsx` keeps the same rules.
enum SetupChecklist {
    /// One drawn row: a step this build knows, with the Worker's answer for it.
    struct Row: Equatable, Sendable {
        let step: SetupStep
        let state: SetupStepState
        let isNext: Bool

        /// Opens somewhere: not done, and nobody blocks it.
        var opens: Bool { !state.done && state.blocked == nil }
        /// Skip clears any step that is not done, blocked or not
        /// (`PUT /api/setup/skip`); the web's card offers the same.
        var skippable: Bool { !state.done }
    }

    /// What Home draws for the checklist.
    enum Card: Equatable, Sendable {
        /// Nothing: no answer yet, turned off, hidden this session, or set up and already said so.
        case none
        /// Every required step is done; say so this once.
        case done
        case steps([Row])
    }

    static func card(_ response: SetupResponse?, hidden: Bool, doneSaid: Bool) -> Card {
        guard let response, response.on, !hidden else { return .none }
        if response.complete { return doneSaid ? .none : .done }
        let rows = response.steps.compactMap { state -> Row? in
            // A step a newer Worker names and this build does not know is left out.
            guard let step = SetupStep(rawValue: state.id) else { return nil }
            return Row(step: step, state: state, isNext: state.id == response.next)
        }
        return rows.isEmpty ? .none : .steps(rows)
    }

    /// Where a step is done on a native client. A step the apps have no
    /// screen for opens the workspace's web page for it.
    enum Destination: Equatable, Sendable {
        case settings(StarlingsSettingID)
        case work
        case room
        case web(URL)
    }

    static func destination(for step: SetupStep, webOrigin: String) -> Destination? {
        switch step {
        case .profile: return .settings(.account)
        // Settings › Account holds Connected agents: the connector's name and address, with Copy.
        case .assistant: return .settings(.account)
        case .calendar: return .settings(.calendar)
        case .project: return .work
        case .call: return .room
        case .look, .membership, .invite, .agent, .apps:
            return webURL(step.webRoute, origin: webOrigin).map(Destination.web)
        }
    }

    /// A route from the table: absolute as it is, a path on the workspace's origin.
    static func webURL(_ route: String, origin: String) -> URL? {
        if route.hasPrefix("https://") || route.hasPrefix("http://") { return URL(string: route) }
        let base = origin.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        return URL(string: base + route)
    }

    /// Where "You're set up" was said: per workspace and person, on this device.
    private static func doneSaidKey(workspace: String, owner: String) -> String {
        "setup.doneSaid.\(workspace)|\(owner.lowercased())"
    }

    static func doneSaid(workspace: String, owner: String) -> Bool {
        UserDefaults.standard.bool(forKey: doneSaidKey(workspace: workspace, owner: owner))
    }

    static func markDoneSaid(workspace: String, owner: String) {
        UserDefaults.standard.set(true, forKey: doneSaidKey(workspace: workspace, owner: owner))
    }
}

/// Hide puts the card away until the app next starts: the session is the
/// process, as a browser session is the tab. Main-actor state, read by Home.
@MainActor
enum SetupChecklistSession {
    static var hidden = false
}
