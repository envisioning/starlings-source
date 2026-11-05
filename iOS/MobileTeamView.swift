import EnvisioningUI
import StarlingsContracts
import SwiftUI

/// Team — people and actors, beside Work's projects, leads, tasks and issues.
///
/// Everyone, direct and group conversations, people and agents share this
/// destination. Agents are a roster category: they can be messaged, but they
/// have no device to ring or room to call. The store remains app-scoped so
/// Home can show unread messages and incoming waves even while this tab is not
/// visible.
struct MobileTeamView: View {
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var team: MobileTeamStore

    @State private var path: [ThreadAddress] = []
    @State private var gathering = false
    @State private var openingGroup: ThreadAddress?
    /// The internal room takes the whole screen, the way hosting from Home
    /// does. A member hosts it rather than knocking: the Mac's Team button
    /// does the same, and a knock at a room nobody has opened yet is refused.
    @State private var isHostingInternalRoom = false

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if app.isSignedIn {
                    list
                } else {
                    MobileSignInButton(prominence: .bordered)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .meetSurfaceBackground()
            .navigationTitle("Team")
            .navigationBarTitleDisplayMode(.large)
            .onReceive(app.$pendingTeamThreadID) { threadID in
                guard let threadID else { return }
                if let thread = (team.unreadThreads + team.groupThreads + team.directThreads).first(where: { $0.id == threadID }),
                   let address = address(for: thread) {
                    path = [address]
                } else if let title = app.pendingTeamThreadTitle {
                    // A thread no list carries (an app user's conversation
                    // on intake): open it by id.
                    path = [ThreadAddress.thread(id: threadID, title: title)]
                } else {
                    return
                }
                app.pendingTeamThreadID = nil
                app.pendingTeamThreadTitle = nil
            }
            // The palette's person door ( decision 7): the person
            // opens, and the verb runs once the roster can answer whether
            // they are callable. A call that cannot be made leaves the
            // person open, which is what a plain tap would have done.
            .onReceive(app.$pendingTeamPeer) { request in
                guard let request, let peer = team.roster.peers.first(where: { $0.email == request.email }) else { return }
                app.pendingTeamPeer = nil
                path = [ThreadAddress.peer(peer)]
                switch request.verb {
                case .wave where !peer.isAgent:
                    Task { await team.ring(peer) }
                case .call where peer.isCallable:
                    Task { await team.call(peer) }
                default:
                    break
                }
            }
            .onReceive(app.$pendingInternalRoom) { requested in
                guard requested else { return }
                app.pendingInternalRoom = false
                isHostingInternalRoom = true
            }
            .meetSearchSheet()
            .meetSettingsSheet()
            // The bar every tab wears (`MobileSurfaceMenu`): the surface
            // menu, and Add for a new group.
            .toolbar {
                MobileSurfaceMenu()
                ToolbarItem(placement: .topBarTrailing) {
                    Button { gathering = true } label: {
                        Image(systemName: "plus")
                    }
                    .meetToolbarProminent()
                    .accessibilityLabel("New group")
                }
            }
            .navigationDestination(for: ThreadAddress.self) { address in
                MobileThreadView(address: address)
            }
            .sheet(isPresented: $gathering) {
                MobileGroupPicker(
                    candidates: team.roster.people.filter { !$0.isSelf },
                    maximum: ThreadAddress.groupMaximumOthers
                ) { chosen in
                    gathering = false
                    guard chosen.count >= 2 else { return }
                    openingGroup = .group(chosen)
                }
            }
            .navigationDestination(item: $openingGroup) { address in
                MobileThreadView(address: address)
            }
            .fullScreenCover(isPresented: $isHostingInternalRoom) {
                MobileHostView(api: app.api, outbox: app.artifactOutbox, room: MeetingInvite.internalRoomSlug).meetAlertHost()
            }
        }
        .meetHaptic(.tap, whenSet: team.incomingRing?.callerDisplayName)
        .task { team.start() }
    }

    private var list: some View {
        StarlingsList {
            if let ring = team.incomingRing {
                Section { RingBanner(ring: ring) }
            }

            if let error = team.errorMessage {
                Section {
                    StarlingsInlineRetry(message: error) {
                        Task { await team.refresh() }
                    }
                }
            }

            if let callNotice = team.callNotice {
                Section {
                    Text(callNotice)
                    Button("Cancel call") { team.cancelCall() }
                        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                }
            }

            // The same card Home uses for your own room, so the two launch
            // surfaces read as one thing. A filled button inside a list row
            // read as a row that happened to be blue.
            Section {
                StarlingsCard {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Team Room").font(.title2.bold())
                                Text(MeetingInvite.absoluteURL(slug: MeetingInvite.internalRoomSlug))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "person.3.fill")
                                .font(.title2)
                                .foregroundStyle(.secondary)
                        }
                        Button {
                            isHostingInternalRoom = true
                        } label: {
                            Label("Join Team Room", systemImage: "video.fill")
                        }
                        .buttonStyle(StarlingsFilledButtonStyle())
                    }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }

            // YOU, GROUPS, PEOPLE and AGENTS: which blocks, their order, each fold's key and
            // which hide while empty come from the shared table (`RailBlockRegistry`, via
            // `MobileRail`); the rows are this view's.
            ForEach(MobileRail.blocks(MobileTeamBlock.self, empty: emptyBlocks)) { entry in
                railBlock(entry)
            }
        }
        .refreshable { await team.refresh() }
    }

    /// The blocks with nothing to list. YOU needs a roster entry for you; PEOPLE counts the
    /// conversations whose other side left the roster, which trail it.
    private var emptyBlocks: Set<MobileTeamBlock> {
        var empty = Set<MobileTeamBlock>()
        if team.roster.me == nil { empty.insert(.you) }
        if team.roster.people.isEmpty,
           TeamRail.strays(team.directThreads, roster: team.roster.peers, selfEmail: team.me?.email).isEmpty {
            empty.insert(.people)
        }
        if team.roster.agents.isEmpty { empty.insert(.agents) }
        return empty
    }

    @ViewBuilder
    private func railBlock(_ entry: MobileRailEntry<MobileTeamBlock>) -> some View {
        switch entry.kind {
        case .you: youBlock(entry.block)
        case .groups: groupsBlock(entry.block)
        case .people: peopleBlock(entry.block)
        case .agents: agentsBlock(entry.block)
        }
    }

    @ViewBuilder
    private func youBlock(_ block: RailBlock) -> some View {
        if let me = team.roster.me {
            MobileRailSection(block, title: "You") {
                NavigationLink(value: ThreadAddress.peer(me)) {
                    WorkSidebarRow.peer(
                        me,
                        hasUnread: team.unreadPeerEmails.contains(me.email)
                    )
                }
                // The Mac's YOU row carries the status menu on right-click;
                // a long press here is the same gesture. The Status row
                // below stays for the tap.
                .contextMenu {
                    statusPicker(me)
                    if let target = FavoriteTargets.peer(me) { MobileFavoriteAction(target: target) }
                }
                statusRow(me)
            } footer: {
                if me.invisible {
                    // Your own roster looks ordinary to you; this is the one
                    // line that says nobody else sees you.
                    Text(PeerStatusOption.appearOfflineReminder)
                }
            }
        }
    }

    private func groupsBlock(_ block: RailBlock) -> some View {
        MobileRailSection(block, title: "Groups") {
            NavigationLink(value: ThreadAddress.team) {
                WorkSidebarRow.channel(
                    title: TeamThread.title,
                    subtitle: TeamThread.subtitle,
                    hasUnread: team.unreadThreadIDs.contains(TeamThread.id)
                )
            }
            .contextMenu { MobileFavoriteAction(target: FavoriteTarget(kind: .meetThread, targetRef: TeamThread.id)) }

            ForEach(team.groupThreads) { group in
                if let address = ThreadAddress.group(group) {
                    NavigationLink(value: address) {
                        WorkSidebarRow.channel(
                            title: address.title,
                            subtitle: address.subtitle ?? String(localized: "Private"),
                            hasUnread: team.unreadThreadIDs.contains(group.id)
                        )
                    }
                    .contextMenu { MobileFavoriteAction(target: FavoriteTarget(kind: .meetThread, targetRef: group.id)) }
                }
            }
        }
    }

    // PEOPLE and AGENTS in `TeamRail.order`: whoever you have talked
    // to, latest first, then the rest as the server sorted them. A
    // conversation whose other side left the roster trails PEOPLE.
    private func peopleBlock(_ block: RailBlock) -> some View {
        MobileRailSection(block, title: "People") {
            ForEach(TeamRail.order(team.roster.people, directs: team.directThreads)) { peer in
                NavigationLink(value: ThreadAddress.peer(peer)) {
                    WorkSidebarRow.peer(
                        peer,
                        hasUnread: team.unreadPeerEmails.contains(peer.email)
                    )
                }
                .contextMenu {
                    pasteAndSendButton(to: .peer(peer))
                    if peer.isRingable {
                        Button { Task { await team.ring(peer) } } label: {
                            Label("Wave", systemImage: "hand.wave.fill")
                        }
                    }
                    if peer.joinRoomSlug != nil {
                        Button { team.joinRoom(peer) } label: {
                            Label("Join room", systemImage: "video.fill")
                        }
                    } else if peer.isCallable {
                        Button { Task { await team.call(peer) } } label: {
                            Label("Call", systemImage: "video.fill")
                        }
                    }
                    if let target = FavoriteTargets.peer(peer) {
                        MobileFavoriteAction(target: target)
                    } else if let thread = team.directThreads.first(where: { $0.peerEmail?.caseInsensitiveCompare(peer.email) == .orderedSame }) {
                        MobileFavoriteAction(target: FavoriteTarget(kind: .meetThread, targetRef: thread.id))
                    }
                }
            }
            ForEach(TeamRail.strays(team.directThreads, roster: team.roster.peers, selfEmail: team.me?.email)) { stray in
                if let address = ThreadAddress.direct(stray) {
                    NavigationLink(value: address) {
                        WorkSidebarRow(
                            leading: .glyph(systemName: "person.crop.circle"),
                            title: address.title,
                            hasUnread: team.unreadPeerEmails.contains(address.peerEmail ?? ""),
                            subtitle: address.subtitle ?? String(localized: "Private conversation"),
                            trailing: team.unreadPeerEmails.contains(address.peerEmail ?? "") ? .unreadDot : nil
                        )
                    }
                }
            }
        }
    }

    private func agentsBlock(_ block: RailBlock) -> some View {
        MobileRailSection(block, title: "Agents") {
            ForEach(TeamRail.order(team.roster.agents, directs: team.directThreads)) { agent in
                NavigationLink(value: ThreadAddress.peer(agent)) {
                    WorkSidebarRow.peer(
                        agent,
                        hasUnread: team.unreadPeerEmails.contains(agent.email),
                        preview: team.directThreads.first { !$0.isGroup && $0.peerEmail == agent.email }?.lastMessagePreview
                    )
                }
                .contextMenu {
                    pasteAndSendButton(to: .peer(agent))
                    if let target = FavoriteTargets.peer(agent) {
                        MobileFavoriteAction(target: target)
                    } else if let thread = team.directThreads.first(where: { $0.peerEmail?.caseInsensitiveCompare(agent.email) == .orderedSame }) {
                        MobileFavoriteAction(target: FavoriteTarget(kind: .meetThread, targetRef: thread.id))
                    }
                }
            }
        }
    }

    /// One menu, one answer — the Mac's `PeerStatusOption` list verbatim
    /// (docs/PRESENCE.md): available, focused, unavailable, offline. The
    /// current answer is the menu's title, so the row reads as status even
    /// before it is opened.
    private func statusRow(_ me: Peer) -> some View {
        let current = PeerStatusOption.selected(for: me)
        return Menu {
            statusPicker(me)
        } label: {
            HStack {
                Text("Status")
                Spacer()
                Text(current.label)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("Status, \(current.label)")
    }

    /// A `Picker` inside a menu is how iOS draws a checked item: the system
    /// owns the checkmark column, so every row aligns. A hand-rolled
    /// `Label(…, systemImage: "checkmark")` does not.
    private func statusPicker(_ me: Peer) -> some View {
        Picker("Status", selection: Binding(
            get: { PeerStatusOption.selected(for: me) },
            set: { option in Task { await team.applyStatus(option) } }
        )) {
            ForEach(PeerStatusOption.allCases, id: \.self) { option in
                Text(option.label).tag(option)
            }
        }
        .pickerStyle(.inline)
        .labelsHidden()
    }

    /// Whatever is on the clipboard, sent to this person or agent without
    /// opening the chat. Offered only when the clipboard holds
    /// text or a link; `hasStrings` / `hasURLs` do not trigger the system
    /// paste prompt, reading the value does, and that happens on tap.
    @ViewBuilder
    private func pasteAndSendButton(to address: ThreadAddress) -> some View {
        if UIPasteboard.general.hasStrings || UIPasteboard.general.hasURLs {
            Button {
                Task { await pasteAndSend(to: address) }
            } label: {
                Label("Paste and send", systemImage: "doc.on.clipboard")
            }
        }
    }

    private func pasteAndSend(to address: ThreadAddress) async {
        let board = UIPasteboard.general
        let raw = board.string ?? board.url?.absoluteString
        let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else {
            StarlingsToastCenter.shared.show(String(localized: "Nothing to paste."), tone: .danger)
            return
        }
        guard let credentials = app.ownerCredentials else { return }
        do {
            let thread = try await app.api.openThread(credentials: credentials, address: address)
            _ = try await app.api.sendMessage(credentials: credentials, threadID: thread.id, text: text)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            StarlingsToastCenter.shared.show(
                String(localized: "Sent to \(address.title)"),
                action: .init(title: String(localized: "Open")) {
                    app.pendingThreadFocus = PendingThreadFocus(threadID: thread.id, focus: .newest)
                    path = [address]
                }
            )
        } catch {
            StarlingsToastCenter.shared.show(error.localizedDescription, tone: .danger)
        }
    }

    private func address(for thread: ThreadSummary) -> ThreadAddress? {
        if thread.kind == .team { return .team }
        if let group = ThreadAddress.group(thread) { return group }
        guard let email = thread.peerEmail else { return nil }
        guard let peer = team.roster.peers.first(where: { $0.email == email }) else { return nil }
        return .peer(peer)
    }
}
