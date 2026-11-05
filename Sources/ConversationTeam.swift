import Foundation

/// Who is on a conversation: the people who can read it, and the agents
/// attached to it. One shape for every conversation that has a sidebar — a
/// Work subject, Everyone, a group — so "who is here" is read and drawn the
/// same way wherever it appears.
///
/// People and agents are answered differently, on purpose. Today every
/// member reads every subject, so a subject's people are the whole team;
/// the day access narrows, only `subject(_:roster:)` changes. Agents were
/// never everywhere: a project carries the one agent Core binds to it
/// (`projects.agent_email`), and a channel with no binding has none — any
/// agent can still be brought in by @mention, which is not membership.
struct ConversationTeam: Equatable {
    /// One row, trimmed to what the sidebar draws. Not a `Peer`: a peer's
    /// heartbeat moves every poll, and an unchanged team must compare equal
    /// so the sidebar is not rebuilt for nothing.
    struct Member: Equatable {
        let email: String
        let name: String
        let status: PeerStatus
        /// Presence, after "Responsible" on the person who answers for a subject.
        var subtitle: String
        let avatarUpdatedAt: Date?
        let agentAvatar: AgentAvatarIdentityWire?
        let isAgent: Bool
        let isSelf: Bool

        init(peer: Peer) {
            email = peer.email
            name = peer.isSelf ? String(localized: "\(peer.displayName) (you)") : peer.displayName
            status = peer.status
            subtitle = teamPeerSubtitle(for: peer)
            avatarUpdatedAt = peer.avatarUpdatedAt
            agentAvatar = peer.agentAvatar
            isAgent = peer.isAgent
            isSelf = peer.isSelf
        }

        /// An address the conversation names but the roster has not
        /// delivered yet — shown as the address rather than dropped.
        init(unknownAgent email: String) {
            self.email = email
            name = email
            status = .offline
            subtitle = String(localized: "Not in the roster")
            avatarUpdatedAt = nil
            agentAvatar = nil
            isAgent = true
            isSelf = false
        }
    }

    let people: [Member]
    let agents: [Member]
    /// Who can read it, when that is a rule rather than a list.
    let access: String?
    /// A project's or lead's responsible person, chosen or suggested
    /// (docs/OWNERSHIP.md). Nil elsewhere, and on a subject with neither.
    var responsible: Responsible? = nil
    /// Whether a person row may offer "Make responsible": a project or lead.
    var canChooseResponsible = false

    /// How many of the people are around right now.
    var aroundCount: Int { people.filter { $0.status != .offline }.count }

    /// Everyone: every member, and no agent — none is bound to the channel.
    static func everyone(roster: PeerRoster) -> ConversationTeam {
        ConversationTeam(
            people: allPeople(roster),
            agents: [],
            access: String(localized: "All \(StarlingsWorkspace.active.name) members")
        )
    }

    /// A Work subject: every member today, plus the agent bound to it. The
    /// responsible person comes first, marked; `tasks` are the subject's own,
    /// for the suggestion when nobody chose.
    static func subject(_ subject: CrmSubject, roster: PeerRoster, tasks: [CrmTask] = []) -> ConversationTeam {
        var agents: [Member] = []
        if let email = subject.agentEmail?.trimmingCharacters(in: .whitespaces), !email.isEmpty {
            if let peer = roster.peers.first(where: { $0.isAgent && $0.email.caseInsensitiveCompare(email) == .orderedSame }) {
                agents.append(Member(peer: peer))
            } else {
                agents.append(Member(unknownAgent: email))
            }
        }
        var people = allPeople(roster)
        let responsible = Responsible.of(subject, tasks: tasks)
        if let responsible, let index = people.firstIndex(where: { $0.email.lowercased() == responsible.email }) {
            var member = people.remove(at: index)
            member.subtitle = responsible.label + " · " + member.subtitle
            people.insert(member, at: 0)
        }
        return ConversationTeam(
            people: people,
            agents: agents,
            access: String(localized: "All \(StarlingsWorkspace.active.name) members"),
            responsible: responsible,
            canChooseResponsible: subject.kind == "project" || subject.kind == "lead"
        )
    }

    /// A group: exactly its members, you included.
    static func group(emails: [String], roster: PeerRoster) -> ConversationTeam {
        let wanted = Set(emails.map { $0.lowercased() })
        let members = roster.peers.filter { $0.isSelf || wanted.contains($0.email.lowercased()) }
        return ConversationTeam(
            people: ordered(members.filter { !$0.isAgent }),
            agents: members.filter(\.isAgent).map(Member.init(peer:)),
            access: String(localized: "Only these people")
        )
    }

    private static func allPeople(_ roster: PeerRoster) -> [Member] {
        ordered(roster.peers.filter { !$0.isAgent })
    }

    /// You first, then the server's order: present first, then by name.
    private static func ordered(_ peers: [Peer]) -> [Member] {
        (peers.filter(\.isSelf) + peers.filter { !$0.isSelf }).map(Member.init(peer:))
    }
}
