import Foundation
import StarlingsContracts

// Team presence, shared by the Mac app and the iOS app. Wire types only: the
// roster is drawn very differently on a phone and in a Mac window, but who is
// on the team and what "around" means must not diverge between them.
//
// Envisioning-only by construction — `GET /api/peers` refuses anyone without a
// verified member session, and presence is never shown to guests. See
// docs/PRIVACY.md.

/// Strongest provable signal first, with one exception at the top:
/// unavailable is *self-declared*, and a person saying "not now" outranks
/// anything their devices can prove about them.
///
/// The server picks one; clients render what they are given rather than
/// re-deriving it from timestamps, so two devices never disagree about whether
/// someone is around.
enum PeerStatus: String, CaseIterable, Sendable {
    /// They asked not to be interrupted. Set by hand, and it expires by
    /// itself. `dnd` on the wire; "Unavailable" to a person.
    case doNotDisturb = "dnd"
    /// Their room has a meeting running right now.
    case inMeeting = "in_meeting"
    /// Their calendar says they are in something, wherever it is happening.
    case busy
    /// Their Mac holds a live host lease: it can take a call.
    case available
    /// A client checked in recently. Says a device is awake, not that a room is.
    case active
    case offline

    /// Unknown values decode as `offline` rather than throwing: a roster that
    /// fails to parse because the server learned a new status is worse than
    /// one person shown dimmer than they are.
    /// The wire value as this build names it; a status it has never heard of
    /// reads as offline, the one answer a roster can draw from no evidence.
    init(wire: PeerStatusValue) {
        self = PeerStatus(rawValue: wire.rawValue) ?? .offline
    }

    // `label` is generated from `PEER_STATUS_LABELS` (Generated/PresenceValuesRegistry.swift).

    /// Whether knocking on this person's room would reach anybody. Only a live
    /// host lease can answer a knock, so `active` — a phone with the app open —
    /// deliberately does not count.
    var isReachable: Bool { self == .inMeeting || self == .available }
}

/// Which device somebody is checked in from. A person is routinely two of
/// these at once — a Mac on the desk and a phone in the pocket — which is why
/// presence carries a set rather than the one client that beat most recently.
enum PeerClient: String, CaseIterable, Sendable {
    case mac
    case ios
    case web

    // `label` is generated from `PEER_CLIENT_LABELS`: named for where the
    // person is ("Desktop", "Mobile"), not for what we build.
}

/// What somebody says about themselves, as opposed to what their devices can
/// prove about them.
///
/// `PeerStatus` is an evidence ladder: every rung is a fact about a machine —
/// a room that is running, a lease, a heartbeat. None of it can express "I am
/// right here and I do not want to be talked to", which is the state a roster
/// most often needs to carry, so intent is a second axis rather than a seventh
/// status competing with the first six.
///
/// Unavailable is not one of these. It lives at the top of `PeerStatus`
/// because it is *enforced* — the Worker refuses a ring against it — while
/// intent only changes how a ring lands. See docs/PRESENCE.md.
/// The values are the contract's (`PEER_INTENTS`, generated into StarlingsContracts);
/// what each one means to a surface lives here. `available` is at the desk,
/// open to a wave. `focused` is present and working: a wave still lands, it
/// just lands quietly, and it is always timeboxed because the Worker refuses
/// a focused with no end.
typealias PeerIntent = StarlingsContracts.PeerIntent

extension PeerIntent {
    // `label` is generated from `PEER_INTENT_LABELS`.

    /// Whether a wave should make a sound on this person's Mac. Focused is
    /// the whole reason intent exists: the nudge still arrives, it simply does
    /// not interrupt. See `PeerWatch`.
    var wantsRingSound: Bool { self != .focused }

    /// The dot the roster draws. Mapped onto the existing status palette
    /// rather than given colours of its own: two vocabularies of coloured dot
    /// on one screen is one more than anybody can learn.
    var dotEquivalent: PeerStatus {
        switch self {
        case .focused: return .busy
        default: return .available
        }
    }
}

/// What a surface actually draws for somebody: the evidence, or the thing they
/// said about themselves.
///
/// Merged once, on `Peer`, so no view re-derives the precedence. A row and a
/// tile disagreeing about whether a person is around is the exact bug the
/// server already avoids by picking one status.
enum PeerDisplayState: Equatable, Sendable {
    case status(PeerStatus)
    case intent(PeerIntent)

    var label: String {
        switch self {
        case .status(let status): return status.label
        case .intent(let intent): return intent.label
        }
    }

    /// Which dot, in the one palette `StarlingsPersonAvatarView` already knows.
    var dot: PeerStatus {
        switch self {
        case .status(let status): return status
        case .intent(let intent): return intent.dotEquivalent
        }
    }
}

/// Human or agent.
///
/// An agent is a peer with no device: it is in the roster and in
/// conversations, but it has no room, no calendar and nothing to heart-beat,
/// so every affordance built on those is absent rather than disabled. Clients
/// render what they are told — the Worker decides what an agent is, and a
/// build that has not heard of a kind draws it as a person rather than
/// dropping it. See docs/AGENTS_SURFACE.md.
enum PeerKind: String, Sendable {
    case human
    case agent
}

/// When somebody normally works, in their own zone.
///
/// Minutes from local midnight rather than a clock string, so comparing two
/// integers is the whole test; local rather than UTC so the pattern survives
/// them travelling, which is why it is stored apart from the zone itself.
extension PeerWorkingHours {
    func contains(minuteOfDay: Int, gregorianWeekday: Int) -> Bool {
        let bit = 1 << ((gregorianWeekday + 5) % 7)
        guard days & bit != 0 else { return false }
        // A shift that ends before it starts crosses midnight, so the window is
        // two ranges — the naive comparison calls every night shift off duty.
        return endMinute >= startMinute
            ? minuteOfDay >= startMinute && minuteOfDay < endMinute
            : minuteOfDay >= startMinute || minuteOfDay < endMinute
    }
}

/// What an agent says it is and what it can do, self-reported by its runtime
/// and cached by the Worker. **Rendered, never authored** — Meet displays this
/// the way it displays presence, and stores none of it as truth. Every string
/// is drawn as the agent's own words, never as markup or an instruction. Nil
/// for a person and for an agent whose runtime serves none, which is the
/// name-and-state card of today. See docs/AGENTS_SURFACE.md §The manifest.
struct AgentManifest: Decodable, Equatable, Sendable {
    let description: String
    /// The model id the runtime declares, e.g. `anthropic/claude-sonnet-5`.
    let model: String?
    let skills: [AgentManifestSkill]
    /// The typed tools the model can call; `requiresApproval` marks the human-gated ones.
    let tools: [AgentManifestTool]
    /// Outside services by name and protocol. Never a credential.
    let connections: [AgentManifestConnection]
    /// Clocked runs, as cron text.
    let schedules: [AgentManifestSchedule]
    /// The environment keys the runtime expects, by name, and whether each is
    /// set. Never a value — the Worker's parser drops anything that is not a
    /// bare `SCREAMING_SNAKE` name before it reaches a client.
    let keys: [AgentManifestKey]
    /// The house documents the runtime reads live before it works — a
    /// VOICE.md for a writer — with the one it must read on every job marked.
    let docs: [AgentManifestDoc]
    let homeURL: String?
    let readmeURL: String?
    /// The repository the runtime is built from.
    let repoURL: String?
    /// Which build is answering — a git revision or a tag the runtime stamps.
    let version: String?
    /// When that build was made.
    let builtAt: Date?

    init(wire: AgentManifestWire) {
        self.init(
            description: wire.description,
            model: wire.model,
            skills: wire.skills ?? [],
            tools: (wire.tools ?? []).map(AgentManifestTool.init(wire:)),
            connections: wire.connections ?? [],
            schedules: wire.schedules ?? [],
            keys: wire.keys ?? [],
            docs: (wire.docs ?? []).map(AgentManifestDoc.init(wire:)),
            homeURL: wire.homeURL,
            readmeURL: wire.readmeURL,
            repoURL: wire.repoURL,
            version: wire.version,
            builtAt: wire.builtAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try AgentManifestWire(from: decoder))
    }

    init(
        description: String,
        model: String? = nil,
        skills: [AgentManifestSkill] = [],
        tools: [AgentManifestTool] = [],
        connections: [AgentManifestConnection] = [],
        schedules: [AgentManifestSchedule] = [],
        keys: [AgentManifestKey] = [],
        docs: [AgentManifestDoc] = [],
        homeURL: String? = nil,
        readmeURL: String? = nil,
        repoURL: String? = nil,
        version: String? = nil,
        builtAt: Date? = nil
    ) {
        self.description = description
        self.model = model
        self.skills = skills
        self.tools = tools
        self.connections = connections
        self.schedules = schedules
        self.keys = keys
        self.docs = docs
        self.homeURL = homeURL
        self.readmeURL = readmeURL
        self.repoURL = repoURL
        self.version = version
        self.builtAt = builtAt
    }

    /// "Build efa621a · 2 hours ago", or just the half that is known.
    var buildLine: String? {
        var parts: [String] = []
        if let version { parts.append(String(localized: "Build \(version)")) }
        if let builtAt { parts.append(min(builtAt, Date()).formatted(.relative(presentation: .named))) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The first line of the description, for the one line a roster row has.
    var firstLine: String {
        description.split(whereSeparator: \.isNewline).first.map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? description
    }

    /// The links out, in the order every client draws them. Only the ones that
    /// parse — a manifest that names a broken link keeps the rest.
    var links: [AgentManifestLink] {
        [("Home", homeURL), ("Readme", readmeURL), ("Repo", repoURL)].compactMap { title, raw in
            raw.flatMap(URL.init(string:)).map { AgentManifestLink(title: title, url: $0) }
        }
    }
}

/// What an agent has done, counted by the Worker from its hand-off ledger —
/// one row per turn a runtime accepted. Nil for a person and for an agent
/// never handed a job.
struct AgentActivity: Decodable, Equatable, Sendable {
    let jobsTotal: Int
    let jobs30d: Int
    let resets30d: Int
    let lastRepliedAt: Date?
    let typicalReply: TimeInterval?

    init(wire: AgentActivityWire) {
        self.init(
            jobsTotal: wire.jobsTotal,
            jobs30d: wire.jobs30d,
            resets30d: wire.resets30d,
            lastRepliedAt: wire.lastRepliedAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) },
            typicalReply: wire.typicalReplyMs.map { TimeInterval($0) / 1000 }
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try AgentActivityWire(from: decoder))
    }

    init(jobsTotal: Int, jobs30d: Int = 0, resets30d: Int = 0, lastRepliedAt: Date? = nil, typicalReply: TimeInterval? = nil) {
        self.jobsTotal = jobsTotal
        self.jobs30d = jobs30d
        self.resets30d = resets30d
        self.lastRepliedAt = lastRepliedAt
        self.typicalReply = typicalReply
    }

    /// The lines every client draws under ACTIVITY, in this order. Formatted
    /// on the device, like "last seen", so a cached roster never reads stale.
    var lines: [String] {
        var out: [String] = []
        out.append(jobsTotal == 1 ? String(localized: "1 job") : String(localized: "\(jobsTotal) jobs"))
        if jobs30d > 0 { out[0] += ", \(jobs30d) in the last 30 days" }
        if resets30d > 0 {
            out.append(resets30d == 1 ? String(localized: "1 reset in the last 30 days") : String(localized: "\(resets30d) resets in the last 30 days"))
        }
        if let lastRepliedAt {
            out.append(String(localized: "Last reply \(min(lastRepliedAt, Date()).formatted(.relative(presentation: .named)))"))
        }
        if let typicalReply {
            out.append(String(localized: "Usually replies in \(AgentActivity.duration(typicalReply))"))
        }
        return out
    }

    /// "40 s", "4 min", "2 h" — the coarsest unit that still says something.
    static func duration(_ seconds: TimeInterval) -> String {
        if seconds < 90 { return "\(Int(seconds.rounded())) s" }
        if seconds < 5400 { return "\(Int((seconds / 60).rounded())) min" }
        return "\(Int((seconds / 3600).rounded())) h"
    }
}

struct AgentManifestLink: Equatable, Sendable, Identifiable {
    let title: String
    let url: URL
    var id: String { title }
}

extension AgentManifestSkill: Identifiable {
    public var id: String { name }
}

struct AgentManifestTool: Equatable, Sendable, Identifiable {
    let name: String
    let description: String?
    let requiresApproval: Bool

    var id: String { name }

    init(wire: StarlingsContracts.AgentManifestTool) {
        self.init(name: wire.name, description: wire.description, requiresApproval: wire.requiresApproval ?? false)
    }

    init(name: String, description: String? = nil, requiresApproval: Bool = false) {
        self.name = name
        self.description = description
        self.requiresApproval = requiresApproval
    }

    /// The one line a list draws: the name, the human gate, the description.
    var line: String {
        var text = name
        if requiresApproval { text += " (asks first)" }
        if let description { text += " — \(description)" }
        return text
    }
}

/// One environment key the runtime reads, and whether it found a value.
extension AgentManifestKey: Identifiable {
    public var id: String { name }

    /// Set is the accent (`StarlingsColors.accent`, as the chip's hex — the chip
    /// pulls it toward legible on a light ground itself); missing stays red.
    var chip: CrmIssueLabel {
        CrmIssueLabel(name: name, color: set ? "d6f249" : "d73a4a", description: nil)
    }
}

/// One house document the runtime reads, in its own words: what it is, what
/// it governs, where it lives, and the links to read and to edit it.
struct AgentManifestDoc: Equatable, Sendable, Identifiable {
    let name: String
    let title: String?
    let description: String?
    let source: String?
    let viewURL: String?
    let editURL: String?
    /// Read before every job, not on demand.
    let required: Bool

    var id: String { name }

    init(wire: StarlingsContracts.AgentManifestDoc) {
        self.init(
            name: wire.name, title: wire.title, description: wire.description, source: wire.source,
            viewURL: wire.viewURL, editURL: wire.editURL, required: wire.required ?? false
        )
    }

    init(
        name: String,
        title: String? = nil,
        description: String? = nil,
        source: String? = nil,
        viewURL: String? = nil,
        editURL: String? = nil,
        required: Bool = false
    ) {
        self.name = name
        self.title = title
        self.description = description
        self.source = source
        self.viewURL = viewURL
        self.editURL = editURL
        self.required = required
    }

    var displayTitle: String { title ?? name }
    var view: URL? { viewURL.flatMap(URL.init(string:)) }
    var edit: URL? { editURL.flatMap(URL.init(string:)) }
}

extension AgentManifestConnection: Identifiable {
    public var id: String { name }

    var line: String { `protocol`.map { "\(name) · \($0)" } ?? name }
}

extension AgentManifestSchedule: Identifiable {
    public var id: String { cron + (description ?? "") }

    var line: String { description.map { "\(cron) — \($0)" } ?? cron }
}

/// What pressing Call on a person does. See `Peer.callPlan`.
enum PeerCallPlan: Equatable, Sendable {
    /// They are in a meeting: walk into the room they are standing in.
    case join(slug: String)
    /// They are around, but no room is live: ask them to open theirs.
    case ask(slug: String)
    /// Call cannot reach them. `reason` is the line the caller sees.
    case unavailable(reason: String)
}

struct Peer: Decodable, Equatable, Identifiable, Sendable {
    let email: String
    /// Stable opaque principal for the shared favorites relation.
    let favoriteRef: String?
    let name: String?
    let kind: PeerKind
    let roomSlug: String?
    let status: PeerStatus
    let since: Date?
    /// The last beat from any device. Distinct from `since`, which says when
    /// the *current* status began and is unknowable for somebody who is gone.
    let lastSeenAt: Date?
    let lastClient: String?
    /// Every device checked in inside the active window — often more than one.
    let clients: [PeerClient]
    /// The app version each device in `clients` reported. A device with no
    /// report has no key.
    let clientVersions: [PeerClient: String]

    /// Every device they are on, each with its version: "Desktop (5.8.1), Mobile".
    var devicesLine: String {
        clients.map { client in
            clientVersions[client].map { "\(client.label) (\($0))" } ?? client.label
        }.joined(separator: ", ")
    }
    /// The room they are *standing in*, which is not always their own — a
    /// colleague in somebody else's meeting carries that owner's slug. Nil
    /// unless they are in a meeting.
    ///
    /// Two peers sharing this are in one conversation. It is the only thing
    /// that lets a roster draw a group rather than a list of individuals who
    /// each, separately, happen to be busy.
    let inRoomSlug: String?
    /// When the calendar block behind `busy` ends.
    let busyUntil: Date?
    /// When self-set unavailable lapses.
    let dndUntil: Date?
    /// What they said about themselves, or nil when they never said anything
    /// or it has lapsed. The server drops a lapsed one, so this is always
    /// current — clients never check the deadline to decide whether to draw it.
    let intent: PeerIntent?
    /// When focused runs out. Only ever set on focused.
    let intentUntil: Date?
    /// You chose to appear offline. Only ever true on your own row — to
    /// everyone else you simply read `offline`, and the server sends false.
    let invisible: Bool
    /// When this person's picture last changed, or nil when they have none.
    ///
    /// Not the picture — a roster is polled and must not carry bytes. It is
    /// the cache key every surface asks `PersonAvatarStore` with, so a new
    /// picture redraws everywhere on the next poll and an unchanged one is
    /// never fetched twice.
    let avatarUpdatedAt: Date?
    /// Canonical character paths and flat body color for an agent. Nil for a person.
    let agentAvatar: AgentAvatarIdentityWire?
    let participants: Int
    let isSelf: Bool
    /// Their IANA zone, or nil for somebody whose clients predate it. Never an
    /// offset — an offset is wrong twice a year and cannot be corrected.
    let timeZoneIdentifier: String?
    /// When they normally work, in their own zone. Nil when they never said,
    /// which is silence rather than "works no hours".
    let workingHours: PeerWorkingHours?
    /// What they do here, drawn under the name wherever there is a second line.
    let title: String?
    let pronouns: String?
    /// An agent's self-reported manifest, or nil for a person and for an agent
    /// whose runtime serves none. Rendered read-only. See `AgentManifest`.
    let manifest: AgentManifest?
    /// What it has done, from the Worker's hand-off ledger. Nil for a person.
    let activity: AgentActivity?

    var id: String { email }

    /// The same person with everything time-bound removed: offline, in no
    /// room, no intent, no last-seen. What a roster snapshot may paint before
    /// the first live poll — who is on the team is durable, who is around is
    /// not (docs/CACHING.md §Never cached).
    var withoutPresence: Peer {
        Peer(
            email: email,
            name: name,
            roomSlug: roomSlug,
            status: .offline,
            kind: kind,
            invisible: invisible,
            avatarUpdatedAt: avatarUpdatedAt,
            agentAvatar: agentAvatar,
            isSelf: isSelf,
            timeZoneIdentifier: timeZoneIdentifier,
            workingHours: workingHours,
            title: title,
            pronouns: pronouns,
            manifest: manifest
        )
    }

    /// Their clock, or nil when nobody knows where they are.
    ///
    /// This is the field that changes what the reader *does*: "Available" and
    /// "Available, 23:10 their time" are the same status and opposite advice.
    /// Formatted on the Mac rather than at the Worker for the same reason
    /// `lastSeenDescription` is — the roster is served from a ten-second cache,
    /// so a server-rendered clock would arrive stale.
    var localTimeDescription: String? {
        guard let timeZoneIdentifier, let zone = TimeZone(identifier: timeZoneIdentifier) else { return nil }
        return Date().meetTimeString(timeZone: zone)
    }

    /// Whether they are inside their own working hours. Nil is *undecidable* —
    /// they never said — and a surface must report that as silence. Treating it
    /// as "off" would quietly discourage reaching anybody who has not filled in
    /// a form.
    var isWithinWorkingHours: Bool? {
        guard let workingHours, let timeZoneIdentifier,
              let zone = TimeZone(identifier: timeZoneIdentifier) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.hour, .minute, .weekday], from: Date())
        guard let hour = parts.hour, let minute = parts.minute, let weekday = parts.weekday else { return nil }
        return workingHours.contains(minuteOfDay: hour * 60 + minute, gregorianWeekday: weekday)
    }

    /// First name where there is one — a team roster reads as people, not as
    /// addresses. Falls back to the local part so an unnamed row still sorts
    /// and renders like the others.
    var displayName: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return String(email.prefix(while: { $0 != "@" }))
    }

    var shortName: String {
        displayName.split(separator: " ").first.map(String.init) ?? displayName
    }

    /// What a conversation with this person is called — a window title, a
    /// navigation bar, a row. Your own thread is a notebook rather than a
    /// conversation, and naming it after yourself reads as talking to yourself.
    ///
    /// Written once here rather than per surface: Mac and iOS draw the same
    /// conversation, and a name that differs between them is a bug nobody
    /// notices until somebody reads both screens.
    var conversationTitle: String {
        isSelf ? String(localized: "Notes to self") : displayName
    }

    /// Composer placeholder for that conversation. You *ask* an agent and you
    /// *message* a colleague — the verb is the one honest signal that the
    /// other side is software, and it costs nothing to get right.
    var conversationPrompt: String {
        if isSelf { return "Write a note" }
        return isAgent ? String(localized: "Ask \(shortName)") : String(localized: "Message \(shortName)")
    }

    /// The one quiet line under their name at the top of a conversation.
    ///
    /// Status alone was what the old header said, and "Active" is the least
    /// useful true thing available: it does not say what they do here, and it
    /// does not say whether now is a reasonable moment. Title and local time
    /// both change what the reader does next, so both outrank a second
    /// rendering of the dot already drawn beside the name.
    var conversationSubtitle: String {
        if isAgent { return agentSubtitle }
        var parts = [invisible ? String(localized: "Appear offline") : displayState.label]
        if let title, !title.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(title) }
        if let clock = localTimeDescription {
            // Said plainly when it is an ordinary hour, and marked when it is
            // not — the whole reason to carry a clock is the moment it should
            // stop somebody ringing.
            parts.append(isWithinWorkingHours == false ? String(localized: "\(clock) their time · off hours") : String(localized: "\(clock) their time"))
        }
        return parts.joined(separator: " · ")
    }

    /// Shown while the conversation holds nothing.
    var conversationEmptyLine: String {
        if isSelf {
            return String(localized: "Nothing here yet.")
        }
        if isAgent {
            return String(localized: "Nothing here yet.")
        }
        return String(localized: "Nothing here yet.")
    }

    /// What an agent's row says under its name: "Working…" or nothing.
    ///
    /// `available` on an agent means *addressable*, not alive — there is no
    /// heartbeat behind it — so writing "Available" would promise a liveness
    /// nothing has checked. `busy` is the exception: the Worker sets it only
    /// when a runtime **accepted** a hand-off, a claim something verified.
    /// No "Agent" word: the avatar already says so. See
    /// docs/AGENTS_SURFACE.md.
    var agentSubtitle: String {
        status == .busy ? String(localized: "Working…") : ""
    }

    var isAgent: Bool { kind == .agent }

    /// What to draw for this person, merged once so no surface re-derives it.
    ///
    /// Three rungs of the evidence ladder outrank anything self-set. Do not
    /// disturb is already a self-declared answer and the strongest one there
    /// is; a meeting that is provably running says more than a word somebody
    /// typed this morning; and offline outranks a sticky intent because
    /// "Available" over a Mac that stopped beating two hours ago is precisely
    /// the lie a roster exists to avoid.
    ///
    /// Everywhere else intent wins, including over a calendar block — a person
    /// saying where they are is more current than what they accepted last week.
    var displayState: PeerDisplayState {
        if isAgent { return .status(status) }
        // Your own row while you appear offline: the roster hands you the
        // truth (`invisible` is only ever true on your own row), but the row
        // draws what everyone else sees — the offline dot — or it would say
        // "Available" over a menu that has Appear offline checked (#117).
        if invisible { return .status(.offline) }
        switch status {
        case .doNotDisturb, .inMeeting, .offline:
            return .status(status)
        case .busy, .available, .active:
            guard let intent else { return .status(status) }
            return .intent(intent)
        }
    }

    /// Callable means: they have a room, and something in it can answer. An
    /// agent has neither, and does not join meetings at all — see
    /// docs/AGENTS_SURFACE.md for why that is a boundary and not a gap.
    var isCallable: Bool { roomSlug != nil && status.isReachable && !isSelf && !isAgent }

    /// The room Join room opens: the one they are standing in, which is
    /// somebody else's when they are a guest there, else their own.
    var joinRoomSlug: String? { status == .inMeeting ? (inRoomSlug ?? roomSlug) : nil }

    /// What Call does for this person. Every surface that offers Call asks
    /// this, so no surface can take a path that ends in nothing.
    var callPlan: PeerCallPlan {
        if isSelf { return .unavailable(reason: String(localized: "You can’t call yourself")) }
        if isAgent { return .unavailable(reason: String(localized: "Agents don’t take calls")) }
        if let slug = joinRoomSlug { return .join(slug: slug) }
        guard let slug = roomSlug else {
            return .unavailable(reason: String(localized: "\(shortName) doesn’t have a room yet"))
        }
        guard status.isReachable else {
            return .unavailable(reason: String(localized: "\(shortName) isn’t available for a call"))
        }
        return .ask(slug: slug)
    }

    /// Ringable is a lower bar than callable — a nudge needs somebody looking
    /// at a screen, not a room that can answer. Nobody rings a person who has
    /// asked not to be disturbed; the Worker refuses it anyway, and it refuses
    /// a ring at an agent for the same reason: a nudge toward a room means
    /// nothing to something that is never in one.
    var isRingable: Bool {
        !isSelf && !isAgent && status != .offline && status != .doNotDisturb
    }

    /// "Last seen 2 hours ago", formatted here rather than at the Worker: the
    /// roster is served from a ten-second cache, so a server-rendered string
    /// would arrive stale and in the wrong language.
    var lastSeenDescription: String? {
        guard let lastSeenAt else { return nil }
        // Clamp forward: clock skew between a device and the control plane must
        // never produce "last seen in 3 minutes".
        let at = min(lastSeenAt, Date())
        // A format *style* rather than a shared `RelativeDateTimeFormatter`:
        // the formatter is a class and not `Sendable`, so one held statically
        // is a data race the moment two surfaces draw a roster at once.
        return at.formatted(.relative(presentation: .named))
    }

    init(wire: PeerWire) {
        let date: (Int?) -> Date? = { $0.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) } }
        self.init(
            email: wire.email,
            favoriteRef: wire.favoriteRef ?? nil,
            name: wire.name,
            roomSlug: wire.roomSlug,
            status: PeerStatus(wire: wire.status),
            // An unfamiliar kind reads as a person rather than failing the roster.
            kind: PeerKind(rawValue: wire.kind.rawValue) ?? .human,
            since: date(wire.since),
            lastSeenAt: date(wire.lastSeenAt),
            lastClient: wire.lastClient,
            // Unknown client names are dropped, never thrown on: a roster must
            // survive a server that has learned about a device this build has not.
            clients: wire.clients.compactMap { PeerClient(rawValue: $0.rawValue) },
            clientVersions: [
                .mac: wire.clientVersions?.mac,
                .ios: wire.clientVersions?.ios,
                .web: wire.clientVersions?.web,
            ].compactMapValues { $0 },
            inRoomSlug: wire.inRoomSlug,
            busyUntil: date(wire.busyUntil),
            dndUntil: date(wire.dndUntil),
            // An intent this build has not heard of decodes as none, for the same
            // reason an unknown status decodes as offline: a roster that fails to
            // parse is worse than one person drawn from evidence alone.
            intent: wire.intent.flatMap { PeerIntent.known.contains($0) ? $0 : nil },
            intentUntil: date(wire.intentUntil),
            invisible: wire.invisible,
            avatarUpdatedAt: date(wire.avatarUpdatedAt),
            agentAvatar: wire.agentAvatar,
            participants: wire.participants,
            isSelf: wire.isSelf,
            timeZoneIdentifier: wire.timezone,
            workingHours: wire.workingHours,
            title: wire.title,
            pronouns: wire.pronouns,
            manifest: wire.manifest.map(AgentManifest.init(wire:)),
            activity: wire.activity.map(AgentActivity.init(wire:))
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try PeerWire(from: decoder))
    }

    init(
        email: String,
        favoriteRef: String? = nil,
        name: String?,
        roomSlug: String?,
        status: PeerStatus,
        kind: PeerKind = .human,
        since: Date? = nil,
        lastSeenAt: Date? = nil,
        lastClient: String? = nil,
        clients: [PeerClient] = [],
        clientVersions: [PeerClient: String] = [:],
        inRoomSlug: String? = nil,
        busyUntil: Date? = nil,
        dndUntil: Date? = nil,
        intent: PeerIntent? = nil,
        intentUntil: Date? = nil,
        invisible: Bool = false,
        avatarUpdatedAt: Date? = nil,
        agentAvatar: AgentAvatarIdentityWire? = nil,
        participants: Int = 0,
        isSelf: Bool = false,
        timeZoneIdentifier: String? = nil,
        workingHours: PeerWorkingHours? = nil,
        title: String? = nil,
        pronouns: String? = nil,
        manifest: AgentManifest? = nil,
        activity: AgentActivity? = nil
    ) {
        self.timeZoneIdentifier = timeZoneIdentifier
        self.workingHours = workingHours
        self.title = title
        self.pronouns = pronouns
        self.manifest = manifest
        self.activity = activity
        self.email = email
        self.favoriteRef = favoriteRef
        self.name = name
        self.kind = kind
        self.roomSlug = roomSlug
        self.status = status
        self.since = since
        self.lastSeenAt = lastSeenAt
        self.lastClient = lastClient
        self.clients = clients
        self.clientVersions = clientVersions
        self.inRoomSlug = inRoomSlug
        self.busyUntil = busyUntil
        self.dndUntil = dndUntil
        self.intent = intent
        self.intentUntil = intentUntil
        self.invisible = invisible
        self.avatarUpdatedAt = avatarUpdatedAt
        self.agentAvatar = agentAvatar
        self.participants = participants
        self.isSelf = isSelf
    }
}

/// One opaque block in a colleague's day. Titles, attendees and locations do
/// not cross the peer boundary; every native surface draws this same shape.
struct PeerScheduleBlock: Equatable, Identifiable, Sendable {
    enum Kind: String, Equatable, Sendable {
        case available
        case busy

        var label: String {
            switch self {
            case .available: return "Available"
            case .busy: return "Busy"
            }
        }
    }

    let kind: Kind
    let start: Date
    let end: Date

    var id: String {
        "\(kind.rawValue)-\(start.timeIntervalSince1970)"
    }
}

/// What a teammate's schedule can say when it is not a list of blocks
///: one sentence per cause, decided once for Mac and iOS.
enum PeerScheduleNote {
    /// The Worker answered, but not with their day. Google answers `notFound`
    /// for a calendar the caller may not see (another Workspace domain that
    /// shares no free/busy), which is a fact about sharing, not an error.
    static func unreadable(_ error: String) -> String {
        error == "not_shared" || error == "notFound"
            ? String(localized: "Their calendar isn’t shared with you.")
            : String(localized: "Their calendar isn’t available to you.")
    }

    /// The request itself failed.
    enum Failure: Equatable {
        /// The viewer has not connected Google Calendar.
        case notConnected
        /// Google refused the viewer's stored grant.
        case googleExpired
        /// The viewer's Meet sign-in expired.
        case signInExpired
        /// Anything else; `detail` is what Copy carries.
        case failed(detail: String)

        static func classify(_ error: Error) -> Failure {
            switch CalendarRefreshFailure.classify(error) {
            case .signInExpired: return .signInExpired
            case .googleExpired: return .googleExpired
            default: break
            }
            if let failure = error as? CalendarServiceFailure,
               failure.calendarServerCode == ControlErrorCodeValue.calendarNotConnected.rawValue {
                return .notConnected
            }
            var parts = [error.localizedDescription]
            if let failure = error as? CalendarServiceFailure {
                let diagnostic = failure.calendarDiagnostic
                if !diagnostic.isEmpty { parts.append(diagnostic) }
            }
            parts.append("cause: \(String(describing: CalendarRefreshFailure.classify(error)))")
            return .failed(detail: parts.joined(separator: " · "))
        }
    }

    static func message(for failure: Failure) -> String {
        switch failure {
        case .notConnected: String(localized: "Connect Google Calendar in Settings to see their schedule.")
        case .googleExpired: String(localized: "Google Calendar access expired. Reconnect it in Settings.")
        case .signInExpired: String(localized: "Your Starlings sign-in expired. Sign in again.")
        case .failed: String(localized: "Couldn’t load their calendar.")
        }
    }
}

/// The shared interpretation of one person's free/busy response.
enum PeerDaySchedule {
    static func today(
        for person: CalendarFreeBusyPerson,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [PeerScheduleBlock] {
        let dayStart = calendar.startOfDay(for: now)
        let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) ?? dayStart
        let window = DateInterval(start: dayStart, end: dayEnd)
        let intervals = person.busy
            .compactMap { slot -> DateInterval? in
                guard let start = CalendarDateParsing.parse(slot.start),
                      let end = CalendarDateParsing.parse(slot.end),
                      end > start,
                      start < window.end,
                      end > window.start
                else { return nil }
                return DateInterval(
                    start: max(start, window.start),
                    end: min(end, window.end)
                )
            }
            .sorted { $0.start < $1.start }

        var merged: [DateInterval] = []
        for interval in intervals {
            if let last = merged.last, interval.start <= last.end {
                merged[merged.count - 1] = DateInterval(
                    start: last.start,
                    end: max(last.end, interval.end)
                )
            } else {
                merged.append(interval)
            }
        }

        var blocks: [PeerScheduleBlock] = []
        var cursor = window.start
        for interval in merged {
            if cursor < interval.start {
                blocks.append(PeerScheduleBlock(kind: .available, start: cursor, end: interval.start))
            }
            blocks.append(PeerScheduleBlock(kind: .busy, start: interval.start, end: interval.end))
            cursor = max(cursor, interval.end)
        }
        if cursor < window.end {
            blocks.append(PeerScheduleBlock(kind: .available, start: cursor, end: window.end))
        }
        return blocks
    }
}

/// The status line under a peer's name in every roster row — Mac and iOS
/// alike, People and Agents alike — so what can be done about it, and where
/// the person actually is, reads as the same sentence everywhere it's drawn.
/// Devices are appended rather than replacing the status: "Busy · Desktop,
/// Mobile" answers both "can I interrupt" and "where would I reach them".
func teamPeerSubtitle(for peer: Peer, devices showsDevices: Bool = true) -> String {
    if peer.isAgent {
        // Working is a checked, live claim, and the only line an agent's
        // row carries on its own. The tagline repeated on every row, every
        // day; it stays on the agent's profile.
        return peer.agentSubtitle
    }
    let devices = showsDevices ? peer.devicesLine : ""
    let suffix = devices.isEmpty ? "" : " · \(devices)"

    // Something they said about themselves, where it outranks the ladder.
    // `displayState` owns that precedence; this only spells the winner out.
    if case .intent(let intent) = peer.displayState {
        guard intent == .focused, let until = peer.intentUntil else {
            return "\(intent.label)\(suffix)"
        }
        return String(localized: "Focused · until \(until.meetTimeString())")
    }

    switch peer.status {
    case .doNotDisturb:
        guard let until = peer.dndUntil else { return PeerStatus.doNotDisturb.label }
        return String(localized: "Unavailable · until \(until.meetTimeString())")
    case .inMeeting:
        guard peer.participants > 0 else { return "\(PeerStatus.inMeeting.label)\(suffix)" }
        return peer.participants == 1
            ? String(localized: "In a meeting · 1 person")
            : String(localized: "In a meeting · \(peer.participants) people")
    case .busy:
        guard let until = peer.busyUntil else { return "\(PeerStatus.busy.label)\(suffix)" }
        return String(localized: "Busy · free at \(until.meetTimeString())")
    case .available:
        guard let slug = peer.roomSlug else { return "\(PeerStatus.available.label)\(suffix)" }
        return String(localized: "Available · \(slug)\(suffix)")
    case .active:
        return devices.isEmpty ? String(localized: "Active") : String(localized: "Active · \(devices)")
    case .offline:
        guard let seen = peer.lastSeenDescription else { return PeerStatus.offline.label }
        return String(localized: "Last seen \(seen)")
    }
}

/// Somebody asked for you while you were not looking.
///
/// There is no push: a ring is one row the Worker hands over on the next
/// roster poll, so it reaches a client that is running, and nothing else. A
/// running client does announce it — a notification on the Mac and the phone,
/// so it no longer needs the Team surface to be the one in front of you — but
/// never present it as proof that a person was reached.
/// What a ring is asking for.
///
/// A wave asks for attention and is answered by looking up — there is nothing
/// to accept, and ignoring one costs nobody anything. A call asks the other
/// person to open their room and talk now, which is the only one of the two
/// with a decision attached. See docs/SURFACES.md §Reaching a person.
enum PeerRingKind: String, Decodable, Sendable {
    case wave
    case call
    /// Your own Claude asking you to open your own room. The
    /// caller is the paired client, the room is yours, and the decision is
    /// the same shape a call's is: open it, or not now.
    case agentStart = "agent_start"
}

struct PeerRing: Decodable, Equatable, Sendable {
    /// Unknown kinds decode as `wave` — the harmless one. A build that has not
    /// heard of a gesture must never offer to accept it.
    let kind: PeerRingKind
    let callerEmail: String
    let callerName: String?
    let roomSlug: String?
    let createdAt: Date
    let expiresAt: Date

    var callerDisplayName: String {
        if let callerName, !callerName.trimmingCharacters(in: .whitespaces).isEmpty { return callerName }
        return String(callerEmail.prefix(while: { $0 != "@" }))
    }

    func isLive(at moment: Date = Date()) -> Bool { expiresAt > moment }

    init(wire: IncomingRing) {
        self.init(
            // A kind this build has not heard of lands as a wave: the quieter ask.
            kind: PeerRingKind(rawValue: wire.kind.rawValue) ?? .wave,
            callerEmail: wire.callerEmail,
            callerName: wire.callerName,
            roomSlug: wire.roomSlug,
            createdAt: Date(timeIntervalSince1970: TimeInterval(wire.createdAt) / 1000),
            expiresAt: Date(timeIntervalSince1970: TimeInterval(wire.expiresAt) / 1000)
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try IncomingRing(from: decoder))
    }

    init(
        kind: PeerRingKind = .wave,
        callerEmail: String,
        callerName: String?,
        roomSlug: String?,
        createdAt: Date,
        expiresAt: Date
    ) {
        self.kind = kind
        self.callerEmail = callerEmail
        self.callerName = callerName
        self.roomSlug = roomSlug
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

/// One room with more than one person in it: a conversation you can see from
/// across the room, and walk into.
struct PeerConversation: Equatable, Identifiable, Sendable {
    let roomSlug: String
    let peers: [Peer]

    var id: String { roomSlug }

    /// "Ada and Bruno", "Ada, Bruno and 2 more" — named for the people in it,
    /// never for the room, because nobody thinks of a conversation by its slug.
    var title: String {
        let names = peers.map(\.shortName)
        switch names.count {
        case 0: return roomSlug
        case 1: return names[0]
        case 2: return "\(names[0]) and \(names[1])"
        default: return "\(names[0]), \(names[1]) and \(names.count - 2) more"
        }
    }
}

struct PeerRoster: Decodable, Equatable, Sendable {
    let generatedAt: Date
    let peers: [Peer]
    /// For the caller only — the Worker stamps this after its shared cache.
    let incomingRing: PeerRing?

    static let empty = PeerRoster(generatedAt: .distantPast, peers: [], incomingRing: nil)

    /// The team without anybody's state, and no ring. See `Peer.withoutPresence`.
    var withoutPresence: PeerRoster {
        PeerRoster(generatedAt: .distantPast, peers: peers.map(\.withoutPresence), incomingRing: nil)
    }

    /// Everyone but you, in the order the server sorted them (present first,
    /// then alphabetical). Your own row belongs in the chrome, not the list.
    var others: [Peer] { peers.filter { !$0.isSelf } }
    var me: Peer? { peers.first(where: \.isSelf) }

    /// The team, and the software, kept apart in the two places that draw
    /// them. Split here rather than in each view so the Mac sidebar and the
    /// iOS list cannot disagree about which rows are people.
    var people: [Peer] { others.filter { !$0.isAgent } }
    var agents: [Peer] { others.filter(\.isAgent) }

    /// People only. An agent is permanently addressable, so counting it here
    /// would report somebody around on a day when nobody is.
    var aroundCount: Int { people.filter { $0.status != .offline }.count }

    /// The conversations happening right now, each with everybody in it —
    /// **including you**, because a room you are in is still the room they are
    /// in, and leaving yourself out of it draws your own colleagues as though
    /// they were talking without you.
    ///
    /// Ordered by size, then by slug so the list does not reshuffle between
    /// polls. Written here rather than in a view because the Mac grid and any
    /// later surface must not disagree about who is with whom.
    var conversations: [PeerConversation] {
        var bySlug: [String: [Peer]] = [:]
        for peer in peers {
            guard let slug = peer.inRoomSlug else { continue }
            bySlug[slug, default: []].append(peer)
        }
        return bySlug
            .map { PeerConversation(roomSlug: $0.key, peers: $0.value.sorted { $0.displayName < $1.displayName }) }
            // A "conversation" of one is somebody sitting in their own empty
            // room. That is a person waiting, not a group, and drawing a
            // cluster around them would be the roster inventing company.
            .filter { $0.peers.count > 1 }
            .sorted { ($0.peers.count, $1.roomSlug) > ($1.peers.count, $0.roomSlug) }
    }

    /// Everybody who is not already drawn inside a conversation.
    var ungrouped: [Peer] {
        let grouped = Set(conversations.flatMap { $0.peers.map(\.email) })
        return others.filter { !grouped.contains($0.email) }
    }

    /// A ring that has already expired is not a missed call — it is nothing.
    var liveRing: PeerRing? {
        guard let incomingRing, incomingRing.isLive() else { return nil }
        return incomingRing
    }

    init(generatedAt: Date, peers: [Peer], incomingRing: PeerRing? = nil) {
        self.generatedAt = generatedAt
        self.peers = peers
        self.incomingRing = incomingRing
    }

    init(wire: PeersResponse) {
        self.init(
            generatedAt: Date(timeIntervalSince1970: TimeInterval(wire.generatedAt) / 1000),
            peers: wire.peers.map(Peer.init(wire:)),
            incomingRing: wire.incomingRing.map(PeerRing.init(wire:))
        )
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try PeersResponse(from: decoder))
    }
}

/// Everything a person can say about themselves, in one list, most open at
/// the top and most closed at the bottom.
///
/// Focused and unavailable are two columns at the Worker because they are
/// enforced differently — a ring lands quietly on one and is refused on the
/// other — but to the person setting them they are two rows of one question,
/// and offering two controls would invite the state nobody wants: focused
/// *and* unavailable, disagreeing about which is true.
///
/// Written once here so the sidebar footer, the lounge's own tile and the
/// phone cannot drift into offering different answers.
enum PeerStatusOption: CaseIterable, Sendable {
    /// At the desk. Clears unavailable.
    case available
    /// Working; a wave lands without a sound. Ends at the end of the day.
    case focused
    /// The door is closed; a wave is refused. Ends at the end of the day.
    case unavailable
    /// Hidden from the roster — reads as offline to everyone else. Sticky,
    /// and it refuses nothing: a message still lands, a ring still rings.
    /// The one visibility answer in the same menu as the others, so nobody
    /// is ever both "available" and invisible (docs/PRESENCE.md).
    case offline

    /// The line your own row shows while you are hidden — the roster looks
    /// ordinary to you, so without this it is easy to forget nobody can see you.
    static let appearOfflineReminder = "You appear offline to others"

    var label: String {
        switch self {
        case .available: return PeerIntent.available.label
        case .focused: return PeerIntent.focused.label
        case .unavailable: return PeerStatus.doNotDisturb.label
        case .offline: return "Offline"
        }
    }

    /// When a focused or unavailable set now runs out: the end of today. One
    /// expiry rather than a menu of them — a person who is done sooner picks
    /// Available. Every timeboxed answer must end: a status nobody turns off
    /// is a person who has quietly left the roster.
    static func endOfDay(from now: Date = Date(), calendar: Calendar = .current) -> Date {
        calendar.date(bySettingHour: 23, minute: 59, second: 59, of: now)
            ?? now.addingTimeInterval(8 * 60 * 60)
    }

    /// What to send. The deadline is computed *now* rather than when the menu
    /// was built, so a window left open since yesterday does not set a status
    /// that has already ended.
    ///
    /// Saying you are around clears unavailable, because a person choosing
    /// "Available" has answered the whole question. Choosing unavailable
    /// leaves intent alone on purpose — when the door opens again, where you
    /// said you were is still where you are.
    func resolve(now: Date = Date()) -> (intent: PeerIntent?, intentUntil: Date?, dndUntil: Date?, setsDND: Bool) {
        switch self {
        case .available:
            return (.available, nil, nil, true)
        case .focused:
            return (.focused, Self.endOfDay(from: now), nil, true)
        case .unavailable:
            return (nil, nil, Self.endOfDay(from: now), true)
        case .offline:
            // Hiding changes nothing about intent or the door; it only stops
            // the roster from showing either. Leave both as they are.
            return (nil, nil, nil, false)
        }
    }

    /// Whether choosing this hides you. Every other answer un-hides: picking
    /// "Available" (or anything else) is saying you can be seen again.
    var invisible: Bool { self == .offline }

    /// Which row of the menu a peer's current state is standing on.
    static func selected(for peer: Peer?) -> PeerStatusOption {
        guard let peer else { return .available }
        if peer.invisible { return .offline }
        if peer.status == .doNotDisturb { return .unavailable }
        if peer.intent == .focused { return .focused }
        return .available
    }

    static func selectedIndex(for peer: Peer?) -> Int {
        allCases.firstIndex(of: selected(for: peer)) ?? 0
    }
}

enum PeerPresenceCadence {
    /// Matches PEER_HEARTBEAT_INTERVAL_MILLISECONDS in packages/contracts.
    static let heartbeat: TimeInterval = 60
    /// Matches GUEST_PRESENCE_HEARTBEAT_MILLISECONDS in packages/contracts.
    /// A pre-knock row is a lobby hint, not a live signal; fifteen seconds
    /// keeps the owner's list useful without making every visitor a steady
    /// source of avoidable request traffic.
    static let guestPresenceHeartbeat: TimeInterval = 15
    /// The Worker caches the roster for ten seconds, but this client can poll
    /// every thirty while still catching a ring before its 45-second expiry.
    ///
    /// This is the cadence for a roster somebody is *looking at*. An app that
    /// is merely running uses `backgroundRosterPoll`.
    static let rosterPoll: TimeInterval = 30
    /// Matches PEER_ROSTER_BACKGROUND_POLL_SECONDS. What an app behind other
    /// windows costs: still inside RING_TTL_MILLISECONDS, so a nudge is drawn
    /// with one poll to spare.
    static let backgroundRosterPoll: TimeInterval = 30
    /// Matches RING_TTL_MILLISECONDS. How long a call this Mac placed keeps
    /// watching for the other room to open before it says nobody was there —
    /// the ring itself has expired by then, so there is nothing left to answer.
    static let ringLife: TimeInterval = 45
}

/// Polls that are shared by native surfaces but whose source-of-truth values
/// live in `packages/contracts/src/limits.ts` for the web and Worker.
enum StarlingsPollingCadence {
    /// Matches LOBBY_POLL_SECONDS. WebSocket delivery remains faster when it
    /// is available; this is the native and browser fallback.
    static let lobbyFallback: TimeInterval = 5
    /// Matches QUALITY_REPORT_INTERVAL_MILLISECONDS. Quality is cumulative,
    /// so a slower flush does not lose the meeting's signal.
    static let qualityReport: TimeInterval = 300
    static let downstreamUsageReport: TimeInterval = 60
}
