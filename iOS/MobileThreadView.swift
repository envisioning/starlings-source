import EnvisioningUI
import KeepKit
import StarlingsContracts
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// One conversation, named by a `ThreadAddress` rather than by a person: the
/// thread does not exist until the Worker answers, and a channel is addressed
/// by its subject rather than by anybody. See docs/CHANNELS.md.
///
/// Delivery is polling while this view is on screen: there is no socket and no
/// push yet, so a closed conversation receives nothing until it is opened.
///
/// The arranging rules come from `ThreadTranscript`, which the Mac compiles
/// too — a conversation that groups differently on two screens is one nobody
/// trusts.
struct MobileThreadView: View {
    private static let composerFieldCornerRadius: CGFloat = 24

    let address: ThreadAddress
    /// The channel's forwarding address once the thread has loaded, for a subject's Email
    /// block (the Mac's `onThreadLoaded`).
    var onInboundAddress: ((String) -> Void)?
    /// The subject a channel's ref chips open into: its task and issue readers
    /// take it, and `onShowOverview` lands a decision or a goal on its
    /// Overview, which lists both. Nil outside a subject's own screen, where
    /// those chips stay labels.
    var refSubject: CrmSubject?
    var onShowOverview: (() -> Void)?

    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var team: MobileTeamStore
    @EnvironmentObject private var work: MobileMyWorkStore
    @EnvironmentObject private var quickNotes: MobileQuickNotesStore
    @EnvironmentObject private var keep: KeepAccess
    @StateObject private var store = MobileThreadStore()
    /// The release card whose Approve sheet is open.
    @State private var approvingRelease: ThreadMessage?
    @State private var draft = ""
    @State private var replyDraft = ThreadReplyDraft()
    @State private var editing: ThreadMessage?
    /// A withdraw waiting for its yes: it destroys the text.
    @State private var pendingWithdraw: ThreadMessage?
    @State private var jumpingToParentID: String?
    /// The line a permalink landed on, washed in the accent for a moment.
    @State private var flashedMessageID: String?
    @State private var showingFiles = false
    @State private var showingCamera = false
    @State private var showingScanner = false
    @State private var showingVoiceMemo = false
    @State private var photo: PhotosPickerItem?
    @State private var infoPeer: Peer?
    @StateObject private var composerController = MobileThreadComposerController()
    @State private var isComposing = false
    /// The composer's measured height, pushed from `textViewDidChange` so the
    /// pill re-lays out on every keystroke, not only when SwiftUI happens to.
    @State private var composerHeight: CGFloat = 32

    var body: some View {
        // The composer is a bottom inset, not a stack row: the transcript
        // scrolls under it, which is what its glass is for on iOS 26
        // (docs/DESIGN.md, "Glass — the floating layer").
        transcript
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    attachmentTray
                    composer
                }
                // A material backing, so the newest message scrolls above the
                // composer's *current* height (the inset follows it) and never
                // shows beside or behind the pill.
                .background(.bar, ignoresSafeAreaEdges: .bottom)
            }
            .background(StarlingsMobileColors.canvas.ignoresSafeArea())
        .navigationTitle(address.title)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: store.inboundAddress) { _, found in
            if let found { onInboundAddress?(found) }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let peer = peerForInfo {
                        Button {
                            infoPeer = peer
                        } label: {
                            Label("About \(peer.shortName)", systemImage: "info.circle")
                        }
                        Divider()
                    }
                    Button(store.isMuted ? String(localized: "Unmute") : String(localized: "Mute")) {
                        Task { await store.toggleMute() }
                    }
                    if store.canArchive {
                        Button(store.isArchived ? String(localized: "Keep in chat") : String(localized: "Archive conversation")) {
                            Task { await store.toggleArchive() }
                        }
                    }
                    if let threadID = store.threadID, !threadID.isEmpty {
                        Divider()
                        MobileFavoriteAction(target: FavoriteTarget(kind: .meetThread, targetRef: threadID))
                    }
                    if let address = store.inboundAddress {
                        Divider()
                        // The address is the label, so it can be read without
                        // copying it; the tap copies.
                        Button {
                            UIPasteboard.general.string = address
                        } label: {
                            Label(address, systemImage: "envelope")
                        }
                    }
                } label: {
                    Image(systemName: store.isMuted ? "bell.slash" : "ellipsis")
                        .symbolRenderingMode(.monochrome)
                        .foregroundStyle(.primary)
                }
                .accessibilityLabel("Conversation options")
            }
        }
        .sheet(item: $infoPeer) { peer in
            NavigationStack {
                MobilePeerInfoView(peer: peer)
            }
        }
        .sheet(item: $approvingRelease) { message in
            if let request = message.releaseRequest {
                NavigationStack {
                    KeepReleaseSheet(
                        session: keep.session,
                        request: request,
                        agentEmail: message.senderEmail,
                        agentName: message.senderName ?? message.senderShortName,
                        connect: { await keep.link() },
                        anchor: {
                            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                            return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first ?? UIWindow()
                        },
                        onApproved: { _ in try await store.recordRelease(message.id, ThreadReleaseUpdateRequest(action: .approve)) },
                        onClose: { approvingRelease = nil }
                    )
                    .navigationTitle("Approve")
                    .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
        .meetHaptic(.tap, trigger: store.messages.count)
        .onChange(of: store.messages) { _, messages in
            guard let parentID = replyDraft.parentMessageID,
                  !messages.contains(where: { $0.id == parentID && ThreadTranscript.isReplyable($0) })
            else { return }
            replyDraft.cancel()
            store.errorMessage = String(localized: "This message can no longer be replied to.")
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            Task { await importFiles(urls) }
        }
        .task {
            // A voice message transcribes on the phone, and the first load of
            // the engine is the slow part (~17s to compile). Pay it while the
            // conversation is being read, not after Stop is pressed. Only when
            // the model is already on the phone: warming would otherwise
            // start a download nobody asked for.
            if LocalTranscriptionModel.status() == .ready { SpeechModelLoader.shared.warmUp() }
            await store.open(address: address, app: app)
            team.setActiveThread(store.threadID, peerEmail: address.peerEmail)
        }
        // The roster's 30s poll is too slow to catch an agent's turn: a reply
        // that lands in a few seconds falls between two ticks and the working
        // row never shows. While this turn is open, re-read the roster on the
        // thread's own cadence; the loop ends when the agent answers.
        .task(id: awaitingAgent) {
            store.isAgentTurnOpen = awaitingAgent
            guard awaitingAgent else { return }
            while !Task.isCancelled {
                await team.refresh()
                try? await Task.sleep(for: .seconds(DirectMessageCadence.openThreadPoll))
            }
        }
        .onDisappear {
            store.close()
            team.setActiveThread(nil, peerEmail: nil)
        }
    }

    private var rows: [ThreadTranscriptRow] {
        ThreadTranscript.rows(
            for: store.messages,
            unreadBoundary: store.unreadBoundary,
            agentEmails: Set(team.roster.agents.map(\.email))
        )
    }

    /// Trails the reader unfolded, by their first step's id. Collapsed is
    /// the default; a tap is a choice, and it survives the next poll.
    @State private var openTrails: Set<String> = []

    /// The trail still being written: the agent's steps since my line, with
    /// nothing final from it after them. The working row's second line, not
    /// a folded row; it folds when the answer lands. The answer may already
    /// be streaming under the steps, so the trail can be one row from the end.
    private func liveTrailIndex(in rows: [ThreadTranscriptRow]) -> Int? {
        guard showWorkingRow, let last = rows.indices.last else { return nil }
        if rows[last].steps != nil { return last }
        guard last > 0, rows[last].message?.isPartial == true, rows[last - 1].steps != nil else { return nil }
        return last - 1
    }

    /// Only a one-to-one conversation has a single person whose details the
    /// overflow menu can sensibly describe. Group, team, and subject channels
    /// keep the same conversation menu without pretending to have one owner.
    private var peerForInfo: Peer? {
        guard case let .peer(email) = address.target else { return nil }
        return team.roster.peers.first { $0.email == email }
    }

    /// The agent this conversation is with, when it is one and its runtime
    /// serves a manifest. Nil for a person, a channel, or a name-only agent.
    private var agentPeer: Peer? {
        guard let email = address.peerEmail else { return nil }
        return team.roster.agents.first { $0.email == email && $0.manifest != nil }
    }

    /// The channel's subject, when it has one: a decision is recorded there.
    private var decisionSubject: (kind: String, id: String)? {
        guard case let .subject(kind, id) = address.target,
              [.project, .lead, .organization, .event].contains(kind)
        else { return nil }
        return (kind.rawValue, id)
    }

    /// Mark as decision: the line becomes a decision on the
    /// subject, verbatim, with the message as its source. The route writes
    /// the channel line, so it appears here on the next poll.
    private func markAsDecision(_ message: ThreadMessage, on subject: (kind: String, id: String)) async {
        guard let credentials = app.ownerCredentials else { return }
        do {
            _ = try await app.api.createCrmDecision(credentials: credentials, CrmDecisionCreate(
                subjectKind: subject.kind, subjectID: subject.id, body: message.text,
                source: "message", sourceRef: message.id
            ))
            StarlingsToastCenter.shared.show(String(localized: "Recorded as a decision"))
        } catch {
            StarlingsToastCenter.shared.show(error.localizedDescription, tone: .danger)
        }
    }

    /// The agent a turn is open with, when one is: the addressed peer in an
    /// agent DM, or — in a channel, where an agent hears nothing unless named
    /// — the roster agent my latest message @mentions. Nil for a person's DM,
    /// a channel line that names no agent, or a thread where the last word is
    /// somebody else's.
    private var addressedAgent: Peer? {
        if let email = address.peerEmail {
            return team.roster.agents.first { $0.email == email }
        }
        guard let lastReal = store.messages.last(where: { !$0.isEvent }) else { return nil }
        // Its answer is already streaming in: the agent is the one writing.
        if lastReal.isPartial { return team.roster.agents.first { $0.email == lastReal.senderEmail } }
        guard lastReal.isMine else { return nil }
        return team.roster.agents.first { lastReal.mentions.contains($0.email) }
    }

    /// The awaited agent, when it is currently working: `busy` with a
    /// `busy_until` still in the future. An elapsed TTL reads as *not*
    /// working, so a run that died silently can never leave the row stuck on —
    /// the same expiry the Worker applies, re-checked against this device's
    /// clock. Nil for a person, an unaddressed channel, or an idle agent.
    /// Driven off the roster the team store already polls, never a second
    /// signal.
    private var workingAgent: Peer? {
        guard let peer = addressedAgent else { return nil }
        guard peer.status == .busy, let until = peer.busyUntil, until > Date() else { return nil }
        return peer
    }

    /// The standing reaction rail belongs to the latest answer from the
    /// addressed agent. A member's follow-up naturally removes it until the
    /// agent answers again.
    private var persistentReactionMessageID: String? {
        guard let email = address.peerEmail,
              team.roster.agents.contains(where: { $0.email == email }),
              let latest = store.messages.last(where: { !$0.isEvent }),
              latest.senderEmail == email,
              !latest.isWithdrawn,
              !latest.isPartial,
              !latest.reactions.contains(where: { $0.isMine }) else { return nil }
        return latest.id
    }

    /// Whether a sender is one of the roster's agents, so its lines offer
    /// thumbs up alone wherever the agent posts, not only in its DM.
    private func isAgentEmail(_ email: String?) -> Bool {
        guard let email else { return false }
        return team.roster.agents.contains { $0.email == email }
    }

    private var hideSingleReactionCount: Bool {
        switch address.target {
        case .peer, .group: return true
        case .team, .subject, .thread: return false
        }
    }

    /// Whether the transient "working…" row belongs at the bottom right now: the
    /// agent is working, and it has not already answered this turn. Its own next
    /// text message clears `busy_until` at the Worker, but it lands in this
    /// transcript first — so the moment the reply shows, the row goes. An
    /// `event` line never ends a turn, so it does not count as an answer.
    private var showWorkingRow: Bool {
        guard awaitingAgent else { return false }
        if workingAgent != nil { return true }
        // Just sent: the row shows on trust until the roster has had time to
        // say whether the runtime accepted.
        guard let sentAt = store.messages.last(where: { !$0.isEvent })?.sentAt else { return false }
        return Date().timeIntervalSince(sentAt) < DirectMessageCadence.agentAcceptGrace
    }

    /// A turn is open with an agent: the conversation is with one, and either
    /// the last real message is mine or the agent's answer to it is still
    /// streaming in. Both keep the working row, the one-second poll and the
    /// roster refresh; the final answer ends all three.
    private var awaitingAgent: Bool {
        guard addressedAgent != nil else { return false }
        guard let lastReal = store.messages.last(where: { !$0.isEvent }) else { return false }
        return lastReal.isMine || lastReal.isPartial
    }

    private var transcript: some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView {
                    // A short conversation sits at the composer, not under the
                    // title: the stack is at least the viewport tall, bottom-aligned.
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if store.canLoadOlder {
                            Button("Load earlier messages") {
                                Task { await store.loadOlder() }
                            }
                            .font(.footnote)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        }
                        let rows = self.rows
                        let liveTrail = liveTrailIndex(in: rows)
                        ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                            switch row {
                            case let .day(date):
                                DayDivider(date: date)
                            case .unreadMark:
                                UnreadDivider()
                            case let .trail(steps):
                                // The live trail is the working row's own line, not a row here.
                                if index != liveTrail {
                                    TrailRow(steps: steps, open: openTrails.contains(steps[0].id)) {
                                        if openTrails.contains(steps[0].id) {
                                            openTrails.remove(steps[0].id)
                                        } else {
                                            openTrails.insert(steps[0].id)
                                        }
                                    }
                                    .id("trail-\(steps[0].id)")
                                }
                            case let .event(message):
                                EventLine(message: message, subject: refSubject, onShowOverview: onShowOverview).id(message.id)
                            case let .message(message, grouped):
                                MessageRow(
                                    message: message,
                                    grouped: grouped,
                                    showPersistentReactions: message.id == persistentReactionMessageID,
                                    fromAgent: isAgentEmail(message.senderEmail),
                                    hideSingleReactionCount: hideSingleReactionCount,
                                    replyParent: message.replyToMessageID.flatMap { parentID in store.messages.first { $0.id == parentID } },
                                    questionAnswer: store.messages.first { $0.questionAnswer?.questionMessageID == message.id },
                                    selectedQuestionOptions: store.questionSelections[message.id] ?? [],
                                    isSubmittingQuestion: store.submittingQuestionIDs.contains(message.id),
                                    questionError: store.questionErrors[message.id],
                                    onQuestionSelection: { optionID, selected in
                                        if let question = message.question {
                                            store.selectQuestionOption(message.id, question: question, optionID: optionID, selected: selected)
                                        }
                                    },
                                    onAnswerQuestion: { Task { await store.answerQuestion(message.id) } },
                                    releaseBusy: store.releaseBusyIDs.contains(message.id),
                                    releaseError: store.releaseErrors[message.id],
                                    onApproveRelease: keep.isAvailable ? { approvingRelease = message } : nil,
                                    onEndRelease: keep.isAvailable ? { Task { await store.endRelease(message, keep: keep) } } : nil,
                                    onReact: { emoji in Task { await store.react(to: message, emoji: emoji) } },
                                    onSaveAsQuickNote: {
                                        Task {
                                            if await quickNotes.create(body: message.text, source: .work) {
                                                await work.refreshInbox()
                                                StarlingsToastCenter.shared.show(String(localized: "Saved to Quick Notes."))
                                            } else {
                                                StarlingsToastCenter.shared.show(
                                                    quickNotes.errorMessage ?? String(localized: "Couldn’t save as Quick Note"),
                                                    tone: .danger
                                                )
                                            }
                                        }
                                    },
                                    onEdit: { replyDraft.cancel(); editing = message; draft = message.text; isComposing = true },
                                    onWithdraw: { pendingWithdraw = message },
                                    onReply: address.supportsMessageReplies && ThreadTranscript.isReplyable(message)
                                        ? { if editing != nil { draft = "" }; replyDraft.select(message); editing = nil; isComposing = true }
                                        : nil,
                                    onJumpToParent: address.supportsMessageReplies
                                        ? { parentID in jumpToParent(parentID, using: proxy) }
                                        : nil,
                                    onMarkAsDecision: decisionSubject.map { subject in { Task { await markAsDecision(message, on: subject) } } },
                                    loadImage: { file in await store.attachmentData(file) }
                                )
                                .background(
                                    StarlingsMobileColors.accent.opacity(flashedMessageID == message.id ? 0.28 : 0),
                                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                )
                                .id(message.id)
                            }
                        }
                        // A turn in flight reads as a typing state, not a message: a
                        // transient row pinned under the transcript, replaced the
                        // moment the agent's real reply lands.
                        if showWorkingRow, let agent = addressedAgent {
                            AgentWorkingRow(
                                name: agent.shortName,
                                since: agent.since ?? store.messages.last(where: { !$0.isEvent })?.sentAt ?? Date(),
                                step: liveTrail.flatMap { rows[$0].steps?.last?.text }
                            )
                            .id("agent-working")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .bottom)
                }
                .onAppear {
                    if jumpingToParentID == nil { scrollToLatest(proxy, animated: false) }
                    applyPendingFocus(using: proxy)
                }
                .onChange(of: app.pendingThreadFocus) { _, _ in applyPendingFocus(using: proxy) }
                .onChange(of: store.threadID) { _, _ in applyPendingFocus(using: proxy) }
                .onChange(of: store.messages.isEmpty) { _, _ in applyPendingFocus(using: proxy) }
                .onChange(of: store.messages.count) { _, _ in
                    if jumpingToParentID == nil { scrollToLatest(proxy, animated: true) }
                }
                // A streamed answer lengthens the page without adding a row.
                .onChange(of: store.messages.last(where: { $0.isPartial })?.text) { _, _ in
                    if jumpingToParentID == nil { scrollToLatest(proxy, animated: false) }
                }
                .onChange(of: showWorkingRow) { _, shown in
                    if shown, jumpingToParentID == nil { scrollToLatest(proxy, animated: true) }
                }
                .overlay {
                    if store.messages.isEmpty && !store.isLoading {
                        if let agent = agentPeer, let manifest = agent.manifest {
                            // The agent's front door: what it says it is and can do,
                            // in place of the one bare empty line. Read-only.
                            AgentManifestCard(name: agent.displayName, manifest: manifest, activity: agent.activity)
                                .padding(24)
                        } else {
                            Text(address.emptyLine)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                                .padding(32)
                        }
                    }
                }
            }
        }
    }

    /// The initial page can arrive while the lazy stack is still laying out.
    /// Queue the scroll for the next main-run-loop turn so the last row exists
    /// at its final position; `onAppear` also covers reopening a loaded thread.
    private func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        // The working row is the last line when it is on screen, and it is
        // what a sent message is waiting on — land on it, not above it.
        guard let lastID = showWorkingRow ? "agent-working" : store.messages.last?.id else { return }
        DispatchQueue.main.async {
            if animated {
                withAnimation { proxy.scrollTo(lastID, anchor: .bottom) }
            } else {
                proxy.scrollTo(lastID, anchor: .bottom)
            }
        }
    }

    /// A permalink named this conversation: land on the line it
    /// asked for and flash it once. `.newest` is the line Home previewed, which
    /// is where an opened thread already stands, so it only needs the flash.
    private func applyPendingFocus(using proxy: ScrollViewProxy) {
        guard let pending = app.pendingThreadFocus,
              store.threadID == pending.threadID,
              !store.messages.isEmpty else { return }
        app.pendingThreadFocus = nil
        switch pending.focus {
        case .newest:
            guard let id = (store.messages.last(where: { !$0.isPartial }) ?? store.messages.last)?.id else { return }
            flash(id)
        case let .message(id):
            Task { @MainActor in
                jumpingToParentID = id
                let found = await store.loadOlder(until: id)
                if found {
                    await Task.yield()
                    withAnimation { proxy.scrollTo(id, anchor: .center) }
                    flash(id)
                } else {
                    store.errorMessage = String(localized: "That earlier message is no longer available.")
                }
                jumpingToParentID = nil
            }
        }
    }

    private func flash(_ id: String) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            flashedMessageID = id
            try? await Task.sleep(for: .milliseconds(400))
            withAnimation(.easeOut(duration: 1.4)) { flashedMessageID = nil }
        }
    }

    /// A reply preview can point outside the loaded page. Bring older pages in
    /// first, then land on the parent without the normal latest-row observer
    /// pulling the reader back to the bottom.
    private func jumpToParent(_ messageID: String, using proxy: ScrollViewProxy) {
        guard address.supportsMessageReplies else { return }
        Task { @MainActor in
            jumpingToParentID = messageID
            let found = await store.loadOlder(until: messageID)
            if found {
                await Task.yield()
                withAnimation { proxy.scrollTo(messageID, anchor: .center) }
            } else {
                store.errorMessage = String(localized: "That earlier message is no longer available.")
            }
            jumpingToParentID = nil
        }
    }

    /// What is about to be sent, each removable. Without it an upload is
    /// invisible until the message lands, and a file attached by mistake has
    /// no way back.
    @ViewBuilder
    private var attachmentTray: some View {
        if !store.pending.isEmpty || store.uploading > 0 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(store.pending, id: \.id) { file in
                        Button {
                            store.drop(file)
                        } label: {
                            Label(file.name, systemImage: "xmark.circle.fill")
                                .font(.caption)
                                .meetLineLimit(1)
                        }
                        .buttonStyle(StarlingsBorderedButtonStyle.compact)
                        .accessibilityLabel("Remove \(file.name)")
                    }
                    if store.uploading > 0 {
                        Text("Uploading…").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 12)
            }
            .padding(.bottom, 4)
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let error = store.errorMessage {
                StarlingsErrorNotice(message: error, font: .caption)
            }
            if editing != nil {
                HStack {
                    Text("Editing").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { editing = nil; draft = ""; replyDraft.cancel() }.font(.caption)
                }
            }
            replyContext
            StarlingsGlassGroup(spacing: 8) {
                composerRow
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .photosPicker(isPresented: $showingPhotoPicker, selection: $photo, matching: .images)
        .fullScreenCover(isPresented: $showingCamera) {
            CameraCapture { capture in Task { await stage(capture) } }
                .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $showingScanner) {
            DocumentScan { capture in Task { await stage(capture) } }
                .ignoresSafeArea()
        }
        .confirmationDialog(
            String(localized: "Withdraw this message?"),
            isPresented: Binding(get: { pendingWithdraw != nil }, set: { if !$0 { pendingWithdraw = nil } }),
            titleVisibility: .visible,
            presenting: pendingWithdraw
        ) { message in
            Button(String(localized: "Withdraw"), role: .destructive) {
                Task { await store.withdraw(message) }
            }
        } message: { _ in
            Text("The text and any files are gone. This can’t be undone.")
        }
        .sheet(isPresented: $showingVoiceMemo) {
            VoiceMemoSheet { capture, transcript in
                // The words go where the person can still change them before
                // sending; the audio rides along as the file.
                draft = draft.isEmpty ? transcript : draft + "\n" + transcript
                Task { await stage(capture) }
            }
            .meetDrawer()
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task { await importPhoto(item); photo = nil }
        }
    }

    @ViewBuilder
    private var replyContext: some View {
        if address.supportsMessageReplies,
           let parentID = editing?.replyToMessageID ?? replyDraft.parentMessageID {
            let parent = store.messages.first { $0.id == parentID }
            let content = ThreadReplyPreviewContent.resolve(parent)
            let editingReply = editing?.replyToMessageID != nil
            HStack(spacing: 8) {
                Image(systemName: "arrowshape.turn.up.left")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(editingReply ? String(localized: "Reply to \(content.author)") : String(localized: "Replying to \(content.author)"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if !content.text.isEmpty {
                        Text(content.text)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                if !editingReply {
                    Button {
                        replyDraft.cancel()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.meetPlain)
                    .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                    .accessibilityLabel("Cancel reply")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(StarlingsMobileColors.panel, in: RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous))
            .accessibilityElement(children: .contain)
        }
    }

    /// The `+` and the field, two glass shapes on the transcript. In one
    /// `StarlingsGlassGroup` so they do not sample each other.
    private var composerRow: some View {
            HStack(spacing: 8) {
                // One universal + rather than a paperclip: everything a
                // message can carry — photo or file — lives behind it.
                Menu {
                    // An agent is the one correspondent that is mostly handed
                    // things: a log, a draft, a link. First in the list, so a
                    // press-and-release lands on it; what is on the clipboard
                    // goes straight out, with no stop in the field. The
                    // agent's own DM only — a channel that names one is
                    // still a channel.
                    if address.peerEmail != nil, addressedAgent != nil, editing == nil {
                        Button {
                            guard let text = UIPasteboard.general.string else {
                                store.errorMessage = "Nothing to paste."
                                return
                            }
                            Task { await pasteAndSend(text) }
                        } label: {
                            Label("Paste and send", systemImage: "doc.on.clipboard")
                        }
                        Divider()
                    }
                    if CameraCapture.isAvailable {
                        Button { showingCamera = true } label: {
                            Label("Take photo or video", systemImage: "camera")
                        }
                    }
                    Button { showingPhotoPicker = true } label: {
                        Label("Photo library", systemImage: "photo.on.rectangle")
                    }
                    if DocumentScan.isAvailable {
                        Button { showingScanner = true } label: {
                            Label("Scan document", systemImage: "doc.viewfinder")
                        }
                    }
                    Button { showingFiles = true } label: {
                        Label("Files", systemImage: "folder")
                    }
                    Button { showingVoiceMemo = true } label: {
                        Label("Voice message", systemImage: "mic")
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                }
                .meetFloatingGlass(StarlingsMobileColors.panel, in: Circle(), interactive: true)
                .accessibilityLabel("Attach a file")

                formatMenu

                // Keep the input and send control as siblings: the field gets
                // only the width left after the button, even when its prompt
                // or draft is long.
                HStack(spacing: 8) {
                    MobileThreadComposerField(
                        text: $draft,
                        isFocused: $isComposing,
                        prompt: address.prompt,
                        accessibilityLabel: editing == nil ? String(localized: "Message") : String(localized: "Edit message"),
                        controller: composerController,
                        height: $composerHeight,
                        onSubmit: send
                    )
                        .frame(minWidth: 0, maxWidth: .infinity, minHeight: composerHeight, maxHeight: composerHeight, alignment: .leading)

                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(StarlingsMobileColors.accentInk)
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(StarlingsMobileColors.accent))
                    }
                    .fixedSize()
                    // The 3pt shift aligns its center with the pill's 24pt
                    // end radius while keeping the text field's width reserved.
                    .offset(x: 3)
                    .disabled(!canSend)
                    .opacity(canSend ? 1 : 0.4)
                    .accessibilityLabel(editing == nil ? String(localized: "Send") : String(localized: "Save"))
                }
                .frame(minWidth: 0, maxWidth: .infinity)
                .meetField(
                    capitalization: .sentences,
                    cornerRadius: Self.composerFieldCornerRadius
                )
            }
    }

    private var formatMenu: some View {
        Menu {
            Button { composerController.apply(.bold) } label: { Label("Bold", systemImage: "bold") }
            Button { composerController.apply(.italic) } label: { Label("Italic", systemImage: "italic") }
            Button { composerController.apply(.strikethrough) } label: { Label("Strikethrough", systemImage: "strikethrough") }
            Button { composerController.apply(.inlineCode) } label: { Label("Inline code", systemImage: "chevron.left.forwardslash.chevron.right") }
            Button { composerController.apply(.link) } label: { Label("Link", systemImage: "link") }
            Divider()
            Button { composerController.apply(.bulletedList) } label: { Label("Bulleted list", systemImage: "list.bullet") }
            Button { composerController.apply(.numberedList) } label: { Label("Numbered list", systemImage: "list.number") }
            Button { composerController.apply(.quote) } label: { Label("Quote", systemImage: "quote.opening") }
            Button { composerController.apply(.codeBlock) } label: { Label("Code block", systemImage: "chevron.left.forwardslash.chevron.right") }
        } label: {
            Image(systemName: "textformat")
                .font(.body.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
        }
        .meetFloatingGlass(StarlingsMobileColors.panel, in: Circle(), interactive: true)
        .accessibilityLabel("Format message")
    }

    @State private var showingPhotoPicker = false

    private var canSend: Bool {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasSomething = !trimmed.isEmpty || (!store.pending.isEmpty && editing == nil)
        let validReply = replyDraft.parentMessageID.map { parentID in
            store.messages.contains { $0.id == parentID && ThreadTranscript.isReplyable($0) }
        } ?? true
        return hasSomething && validReply && trimmed.count <= DirectMessageCadence.maxCharacters && !store.isSending
    }

    /// Who this text still names. Read off the finished message rather than
    /// remembered as somebody types: a handle typed and deleted is not a
    /// mention. See `MentionMatching`.
    private func mentions(in text: String) -> [String] {
        MentionMatching.mentions(
            in: text,
            candidates: team.roster.peers.filter { !$0.isSelf }.map { MentionMatching.Candidate(email: $0.email) }
        )
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        if let target = editing {
            draft = ""
            editing = nil
            Task { if await store.edit(target, to: text) == false { draft = text; editing = target } }
            return
        }
        let parentID = replyDraft.parentMessageID
        if let parentID,
           !store.messages.contains(where: { $0.id == parentID && ThreadTranscript.isReplyable($0) }) {
            replyDraft.cancel()
            store.errorMessage = String(localized: "This message can no longer be replied to.")
            return
        }
        draft = ""
        Task {
            // The draft comes back if it never left, so a failed send does not
            // silently eat what somebody typed.
            if await store.send(text, mentions: mentions(in: text), replyToMessageID: parentID) == false {
                draft = text
            } else {
                replyDraft.cancel()
            }
        }
    }

    /// A hand-off carries text only, so over the limit there is nothing to send.
    private func pasteAndSend(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { store.errorMessage = "Nothing to paste."; return }
        guard trimmed.count <= DirectMessageCadence.maxCharacters else {
            store.errorMessage = "That is \(trimmed.count.formatted()) characters; the limit is \(DirectMessageCadence.maxCharacters.formatted())."
            return
        }
        _ = await store.send(trimmed, mentions: mentions(in: trimmed), alone: true)
    }

    private func importFiles(_ urls: [URL]) async {
        for url in urls.prefix(10) {
            // A file from the picker lives outside the app's sandbox until it
            // is opened this way; without the scope the read simply fails.
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            await store.attach(
                name: url.lastPathComponent,
                contentType: (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType?.preferredMIMEType
                    ?? "application/octet-stream",
                data: data,
                pixelSize: pixelSize(of: data)
            )
        }
    }

    private func stage(_ capture: ComposerCapture) async {
        await store.attach(
            name: capture.name,
            contentType: capture.contentType,
            data: capture.data,
            pixelSize: capture.contentType == "image/jpeg" ? pixelSize(of: capture.data) : nil
        )
    }

    private func importPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        await store.attach(
            name: "photo.jpg",
            contentType: "image/jpeg",
            data: data,
            pixelSize: pixelSize(of: data)
        )
    }

    /// Measured so a transcript can reserve the right box before the bytes come
    /// back, instead of reflowing as each picture lands.
    private func pixelSize(of data: Data) -> CGSize? {
        guard let image = UIImage(data: data) else { return nil }
        let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        return size.width > 0 && size.height > 0 ? size : nil
    }
}

/// A day boundary — the one heading a transcript actually needs. Without it a
/// An agent's self-reported manifest, drawn read-only where the empty
/// transcript otherwise shows one line. Every string is the runtime's own words
/// rendered as `Text` — data from a sandbox, never markup and never an
/// instruction. The links are the clamped http(s) URLs from the contract.
private struct AgentManifestCard: View {
    let name: String
    let manifest: AgentManifest
    let activity: AgentActivity?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(name)
                    .font(.headline)
                // What Meet counted comes before what the runtime claims:
                // whether it answers, and how fast, is why this door is opened.
                if let activity {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(activity.lines, id: \.self) { line in
                            Text(line).font(.footnote)
                        }
                    }
                }
                Text(manifest.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let model = manifest.model {
                    Text("Runs on \(model)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                // The front door says what it can do and what it reaches for.
                // Connections and schedules stay in the peer sheet.
                manifestList(String(localized: "What it can do"), manifest.skills.map { (name: $0.name, detail: $0.description) })
                manifestList(String(localized: "Tools"), manifest.tools.map { (name: $0.requiresApproval ? "\($0.name) (asks first)" : $0.name, detail: $0.description) })

                if !manifest.links.isEmpty {
                    HStack(spacing: 16) {
                        ForEach(manifest.links) { link in
                            Link(link.title, destination: link.url)
                        }
                    }
                    .font(.footnote)
                    .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

extension AgentManifestCard {
    /// One eyebrow and its entries. Nothing when the list is empty.
    @ViewBuilder
    fileprivate func manifestList(_ title: String, _ entries: [(name: String, detail: String?)]) -> some View {
        if !entries.isEmpty {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .padding(.top, 4)
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                MobileManifestTile(name: entry.name, detail: entry.detail)
            }
        }
    }
}

/// wall of times says nothing about whether a reply came back in a minute or a
/// fortnight.
private struct DayDivider: View {
    let date: Date

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Rectangle().fill(Color.secondary.opacity(0.2)).frame(height: 1)
        }
        .padding(.top, 20)
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return StarlingsDateFormatting.date(date)
    }
}

/// Where you left off. Deliberately loud — this is the line somebody scrolls
/// to find, and a subtle one makes them re-read everything to be sure.
private struct UnreadDivider: View {
    var body: some View {
        HStack(spacing: 8) {
            // Neutral primary ink, no hue (docs/DESIGN.md, "The accent
            // budget") — the word "New" and the rule itself are the signal.
            Rectangle().fill(Color.primary).frame(height: 1)
            Text("New")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.primary)
        }
        .padding(.vertical, 6)
        .accessibilityLabel("New messages below")
    }
}

/// One line the work graph wrote — a meeting filed, ended, notes filed, a task
/// produced. Quiet and unattributed: readable in the flow, never mistaken for
/// something a person said. Its refs sit under it as chips, as on the Mac and
/// the web; one that opens something reads as a link.
private struct EventLine: View {
    let message: ThreadMessage
    let subject: CrmSubject?
    let onShowOverview: (() -> Void)?

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(message.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Text(message.sentAt.meetTimeString())
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Starlings: \(message.text)")
            if !message.refs.isEmpty {
                HStack(spacing: 4) {
                    ForEach(Array(message.refs.enumerated()), id: \.offset) { _, ref in
                        chip(ref)
                    }
                }
            }
        }
        .padding(.vertical, 7)
    }

    /// A task or an issue pushes its reader, as a row in the subject's list
    /// does; a decision or a goal lands on Overview; a pull, commit, run or
    /// release opens github.com, which is the depth for those.
    @ViewBuilder
    private func chip(_ ref: ThreadMessageRef) -> some View {
        switch ref.kind.rawValue {
        case "task":
            NavigationLink {
                MobileTaskDoor(id: ref.id, subject: subject)
            } label: {
                RefChipLabel(title: ref.chipTitle, opens: true)
            }
            .buttonStyle(.meetPlain)
            .accessibilityLabel(ref.openLabel)
        case "issue":
            if let issue = Self.issue(ref) {
                NavigationLink {
                    MobileIssueDoor(
                        owner: issue.owner, repo: issue.repo, number: issue.number,
                        projectID: subject?.kind == "project" ? subject?.id : nil
                    )
                } label: {
                    RefChipLabel(title: ref.chipTitle, opens: true)
                }
                .buttonStyle(.meetPlain)
                .accessibilityLabel(ref.openLabel)
            } else {
                RefChipLabel(title: ref.chipTitle, opens: false)
            }
        case "decision", "goal":
            if let onShowOverview {
                Button(action: onShowOverview) {
                    RefChipLabel(title: ref.chipTitle, opens: true)
                }
                .buttonStyle(.meetPlain)
                .accessibilityLabel(ref.openLabel)
            } else {
                RefChipLabel(title: ref.chipTitle, opens: false)
            }
        default:
            if let url = ref.githubURL {
                Button { openURL(url) } label: {
                    RefChipLabel(title: ref.chipTitle, opens: true)
                }
                .buttonStyle(.meetPlain)
                .accessibilityLabel(ref.openLabel)
            } else {
                RefChipLabel(title: ref.chipTitle, opens: false)
            }
        }
    }

    private static func issue(_ ref: ThreadMessageRef) -> (owner: String, repo: String, number: Int)? {
        let parts = ref.id.split(separator: "#")
        guard parts.count == 2, let number = Int(parts[1]) else { return nil }
        let slug = parts[0].split(separator: "/")
        guard slug.count == 2 else { return nil }
        return (String(slug[0]), String(slug[1]), number)
    }
}

/// A ref chip's face. One that opens something is accent ink, the colour a
/// link in a message has; one that does not is a quiet label. The tap target
/// is a fingertip (44pt) whatever the capsule's size.
private struct RefChipLabel: View {
    let title: String
    let opens: Bool

    var body: some View {
        Text(title)
            .font(.caption.weight(opens ? .medium : .regular))
            .foregroundStyle(opens ? AnyShapeStyle(StarlingsMobileColors.accentMark) : AnyShapeStyle(HierarchicalShapeStyle.secondary))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.3)))
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }
}

/// An agent's steps on the way to an answer, folded to one line — "3 steps"
/// — that opens into the lines themselves. Quiet, like an event line, and
/// folded by default: a transcript that keeps every step at full height is
/// a log with a conversation buried in it.
private struct TrailRow: View {
    let steps: [ThreadMessage]
    let open: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: onToggle) {
                HStack(spacing: 6) {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .frame(width: 10)
                    Text(String(localized: "\(steps.count) steps"))
                        .font(.footnote)
                }
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.meetPlain)
            .accessibilityLabel(open ? String(localized: "Hide steps") : String(localized: "Show steps"))
            if open {
                ForEach(steps, id: \.id) { step in
                    HStack(alignment: .firstTextBaseline) {
                        Text(step.text)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Text(step.sentAt.meetTimeString())
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.leading, 16)
                }
            }
        }
        .padding(.vertical, 5)
    }
}

/// The transient "working" row an agent's turn draws at the bottom of the
/// transcript while it is in flight — a typing state, not a message. Quiet,
/// like an event line, with the inline thinking orb the web shows beside the
/// same words. The view above inserts and removes it purely from the agent's
/// working state. Two lines: "<name> is working · 0:42", counting up from
/// the hand-off's acceptance, and the agent's latest step in its own words.
private struct AgentWorkingRow: View {
    let name: String
    let since: Date
    let step: String?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            GatheringDotsView(side: 20, ink: StarlingsMobileColors.secondary, motion: .thinking)
            VStack(alignment: .leading, spacing: 2) {
                TimelineView(.periodic(from: since, by: 1)) { context in
                    Text("\(name) is working") + Text(" · \(ThreadTranscript.elapsedLabel(since: since, now: context.date))")
                }
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
                if let step {
                    Text(ThreadMarkdown.plainText(step))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
        }
        .padding(.top, 12)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name) is working")
    }
}

/// A turn, laid out the way a phone lays out messages: the other person's
/// arrive on the left behind their face, yours arrive on the right with no
/// face at all — you know who you are. The name and the time still print once
/// per turn and the lines under them are the same person still talking, which
/// is the rule the Mac and the web follow too; only the geometry is the
/// phone's.
private struct MessageRow: View {
    let message: ThreadMessage
    let grouped: Bool
    let showPersistentReactions: Bool
    /// Sent by an agent: the palette narrows to thumbs up, in the context
    /// menu and on the standing rail alike.
    let fromAgent: Bool
    let hideSingleReactionCount: Bool
    var replyParent: ThreadMessage? = nil
    var questionAnswer: ThreadMessage? = nil
    var selectedQuestionOptions: Set<String> = []
    var isSubmittingQuestion = false
    var questionError: String? = nil
    var onQuestionSelection: ((String, Bool) -> Void)? = nil
    var onAnswerQuestion: (() -> Void)? = nil
    var releaseBusy = false
    var releaseError: String? = nil
    /// Nil where this workspace has no Keep: the card then only reads.
    var onApproveRelease: (() -> Void)? = nil
    var onEndRelease: (() -> Void)? = nil
    let onReact: (String) -> Void
    let onSaveAsQuickNote: () -> Void
    let onEdit: () -> Void
    let onWithdraw: () -> Void
    var onReply: (() -> Void)? = nil
    var onJumpToParent: ((String) -> Void)? = nil
    /// Mark as decision. Nil off a subject channel.
    var onMarkAsDecision: (() -> Void)? = nil
    let loadImage: (ThreadMessageAttachment) async -> Data?

    /// Read from the store rather than threaded through the transcript: the
    /// avatar source is one member session, and the roster it polls is where a
    /// face's version comes from.
    @EnvironmentObject private var team: MobileTeamStore

    /// The avatar column, and the indent a grouped line keeps so its text
    /// stays under the text above it rather than under the face.
    private static let gutter: CGFloat = 30

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Yours are pushed over rather than stretched: a bubble that fills
            // the width is a paragraph, not a message.
            if message.isMine { Spacer(minLength: 48) }
            if !message.isMine {
                if grouped {
                    Color.clear.frame(width: Self.gutter, height: 1)
                } else {
                    Group {
                        if let identity = senderPeer?.agentAvatar {
                            AgentAvatarImage(identity: identity, diameter: Self.gutter)
                        } else {
                            PersonAvatarImage(
                                email: message.senderEmail,
                                displayName: message.senderName ?? message.senderShortName,
                                version: avatarVersion,
                                diameter: Self.gutter,
                                source: team.avatarSource
                            )
                        }
                    }
                    // Sits against the name line rather than the top of the gap
                    // the turn opened above it.
                    .padding(.top, 1)
                }
            }
            column
            if !message.isMine { Spacer(minLength: 48) }
        }
        // A new turn gets a clear gap above it and a line from the same person
        // gets a small one: that difference is what makes a transcript scan as
        // people talking rather than as a wall of sentences.
        .padding(.top, grouped ? 5 : 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        // Long press rather than hover: a phone has no pointer, so the actions
        // live where every other iOS message surface puts them. Nothing on a
        // message still being written: it is not yet anything to act on.
        .contextMenu {
            if !message.isWithdrawn, !message.isPartial {
                ForEach(ThreadTranscript.quickReactions(fromAgent: fromAgent), id: \.self) { emoji in
                    Button {
                        onReact(emoji)
                    } label: {
                        Label(
                            MeetingReaction.accessibilityName(for: emoji),
                            systemImage: MeetingReaction.systemSymbolName(for: emoji)
                        )
                    }
                }
                Divider()
                if !message.text.isEmpty {
                    Button {
                        UIPasteboard.general.string = message.text
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
                if onReply != nil, ThreadTranscript.isReplyable(message) {
                    Button(action: { onReply?() }) { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                }
                if let onMarkAsDecision, !message.text.isEmpty, !message.isEvent {
                    Button(action: onMarkAsDecision) { Label("Mark as Decision", systemImage: "checkmark.seal") }
                }
                if message.isMine && !message.isEvent {
                    if !message.text.isEmpty {
                        Button(action: onSaveAsQuickNote) {
                            Label("Save as Quick Note", systemImage: "square.and.pencil")
                        }
                    }
                    Button(action: onEdit) { Label("Edit", systemImage: "pencil") }
                    Button(role: .destructive, action: onWithdraw) { Label("Withdraw", systemImage: "trash") }
                }
            }
        }
        // Keep the parent jump and message actions individually reachable by
        // VoiceOver rather than folding them into the row's context element.
        .accessibilityElement(children: .contain)
    }

    private var column: some View {
        VStack(alignment: message.isMine ? .trailing : .leading, spacing: 4) {
            if !grouped { header }
            if message.replyToMessageID != nil { replyPreview }
            bubble
            if let question = message.question, !message.isWithdrawn {
                InteractiveQuestionCard(
                    question: question,
                    askedBy: message.senderName ?? message.senderShortName,
                    answer: questionAnswer,
                    selectedOptionIDs: selectedQuestionOptions,
                    isSubmitting: isSubmittingQuestion,
                    error: questionError,
                    onSelection: { optionID, selected in onQuestionSelection?(optionID, selected) },
                    onSubmit: { onAnswerQuestion?() }
                )
            }
            if let request = message.releaseRequest, !message.isWithdrawn {
                ReleaseRequestCard(
                    request: request,
                    state: message.releaseState,
                    askedBy: message.senderName ?? message.senderShortName,
                    busy: releaseBusy,
                    error: releaseError,
                    onApprove: onApproveRelease,
                    onEnd: onEndRelease
                )
            }
            if !message.isWithdrawn {
                MessageLinkPreview(text: message.text)
            }
            if !message.isWithdrawn {
                ForEach(message.attachments, id: \.id) { file in
                    AttachmentView(file: file, load: loadImage)
                }
            }
            if showPersistentReactions && !message.isWithdrawn {
                HStack(spacing: 2) {
                    ForEach(ThreadTranscript.quickReactions(fromAgent: fromAgent), id: \.self) { emoji in
                        Button { onReact(emoji) } label: {
                            Image(systemName: MeetingReaction.systemSymbolName(for: emoji))
                                .font(.caption)
                        }
                        .buttonStyle(StarlingsBorderedButtonStyle.compact(foreground: StarlingsMobileColors.accent))
                        .accessibilityLabel("React with \(MeetingReaction.accessibilityName(for: emoji))")
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Message reactions")
            }
            if !message.reactions.isEmpty {
                HStack(spacing: 4) {
                    ForEach(message.reactions, id: \.emoji) { reaction in
                        Button { onReact(reaction.emoji) } label: {
                            HStack(spacing: 4) {
                                Image(systemName: reaction.systemSymbolName)
                                if !hideSingleReactionCount || reaction.count > 1 {
                                    Text("\(reaction.count)")
                                }
                            }
                            .font(.caption)
                        }
                        .accessibilityLabel("\(MeetingReaction.accessibilityName(for: reaction.emoji)), \(reaction.count)")
                        .buttonStyle(StarlingsBorderedButtonStyle.compact(
                            foreground: reaction.isMine ? StarlingsMobileColors.accent : .secondary
                        ))
                        .accessibilityLabel(reaction.tooltip)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var replyPreview: some View {
        let content = ThreadReplyPreviewContent.resolve(replyParent)
        let title = content.text.isEmpty ? content.author : "\(content.author): \(content.text)"
        if let parentID = message.replyToMessageID, let onJumpToParent {
            Button { onJumpToParent(parentID) } label: {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "arrowshape.turn.up.left")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(content.author).font(.caption2.weight(.semibold))
                        if !content.text.isEmpty {
                            Text(content.text).font(.caption2).lineLimit(2)
                        }
                    }
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(StarlingsMobileColors.panel, in: RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous))
            }
            .buttonStyle(.plain)
            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
            .accessibilityLabel("Reply to \(title); jump to parent message")
        } else {
            Label(title, systemImage: "arrowshape.turn.up.left")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Reply to \(title)")
        }
    }

    /// Your own name is the one name a transcript never has to print, so your
    /// turns carry the time alone.
    private var header: some View {
        HStack(spacing: 6) {
            if !message.isMine {
                Text(message.senderShortName)
                    .font(.subheadline.weight(.semibold))
            }
            Text(message.sentAt.meetTimeString())
                .font(.caption2)
                .foregroundStyle(.secondary)
            if message.editedAt != nil && !message.isWithdrawn {
                Text("edited").font(.caption2).foregroundStyle(.secondary)
            }
            if let via = message.via {
                Text("via \(via)").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    /// A tombstone is not something somebody said. Everything else is Markdown
    /// — agents answer in it and people type it, so the phone renders it rather
    /// than showing the asterisks.
    private var bubble: some View {
        Group {
            if message.isWithdrawn {
                Text("Message withdrawn")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .italic()
            } else {
                MobileMarkdownText(text: message.text, mentionedEmails: message.mentions)
                    .foregroundStyle(Color.primary)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 11)
        .meetContainerShape(cornerRadius: EnvisioningRadius.control)
        .meetConcentricBackground(
            message.isMine
                ? StarlingsMobileColors.accent.opacity(0.18)
                : StarlingsMobileColors.panel,
            fallbackRadius: EnvisioningRadius.control
        )
        // Still being written: a draft's edge, until the final post lands.
        .overlay {
            if message.isPartial {
                RoundedRectangle(cornerRadius: EnvisioningRadius.control, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .foregroundStyle(.secondary.opacity(0.5))
            }
        }
        // The whole width is the row's; the bubble takes only what it needs.
        .fixedSize(horizontal: false, vertical: true)
    }

    /// The roster's version for this face, when the roster knows this address.
    /// Nil is not "no picture" — the store falls back to the last version it
    /// was told about, which is what lets a face survive a message from
    /// somebody who has since left the roster.
    private var avatarVersion: Date? {
        senderPeer?.avatarUpdatedAt
    }

    private var senderPeer: Peer? {
        team.roster.peers.first { $0.email.caseInsensitiveCompare(message.senderEmail) == .orderedSame }
    }
}

/// An agent's request for one Keep item: the item, the task, why,
/// and Approve while it waits; who approved and End now once it is live.
private struct ReleaseRequestCard: View {
    let request: ThreadReleaseRequest
    let state: ThreadReleaseState?
    let askedBy: String
    let busy: Bool
    let error: String?
    let onApprove: (() -> Void)?
    let onEnd: (() -> Void)?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 8) {
                Label(ThreadReleaseCard.title(askedBy: askedBy, request: request, state: state), systemImage: "key")
                    .font(.subheadline.weight(.semibold))
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
                    GridRow {
                        Text("Vault").foregroundStyle(.secondary)
                        Text(request.vault)
                    }
                    GridRow {
                        Text("Task").foregroundStyle(.secondary)
                        Text(request.task)
                    }
                    GridRow {
                        Text("Why").foregroundStyle(.secondary)
                        Text(request.reason)
                    }
                    if let asked = ThreadReleaseCard.askedFor(request) {
                        GridRow {
                            Text("Asked for").foregroundStyle(.secondary)
                            Text(asked)
                        }
                    }
                }
                .font(.footnote)
                if let status = ThreadReleaseCard.status(state, now: context.date) {
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(StarlingsMobileColors.danger)
                }
                if state == nil, let onApprove {
                    Button("Approve", action: onApprove)
                        .buttonStyle(.borderedProminent)
                        .disabled(busy)
                } else if ThreadReleaseCard.isLive(state, now: context.date), let onEnd {
                    Button(busy ? String(localized: "Ending…") : String(localized: "End now"), role: .destructive, action: onEnd)
                        .buttonStyle(.bordered)
                        .disabled(busy)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Keep request")
        }
    }
}

/// One attachment. A picture is drawn; anything else is named and sized.
private struct InteractiveQuestionCard: View {
    let question: ThreadQuestion
    let askedBy: String
    let answer: ThreadMessage?
    let selectedOptionIDs: Set<String>
    let isSubmitting: Bool
    let error: String?
    let onSelection: (String, Bool) -> Void
    let onSubmit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Asked by \(askedBy)")
                .font(.subheadline.weight(.semibold))
            Text(question.mode == .single ? String(localized: "Choose one option") : String(localized: "Choose all that apply"))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let answer, let submitted = answer.questionAnswer {
                if answer.isWithdrawn {
                    Text("Answer withdrawn.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Answered by \(answer.senderShortName) · \(answer.sentAt.meetTimeString())")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(Array(submitted.optionLabels.enumerated()), id: \.offset) { _, label in
                        Label(label, systemImage: "checkmark.circle.fill")
                            .font(.subheadline)
                            .labelStyle(.titleAndIcon)
                    }
                }
            } else {
                ForEach(question.options, id: \.id) { option in
                    let selected = selectedOptionIDs.contains(option.id)
                    Button {
                        if question.mode == .single {
                            onSelection(option.id, true)
                            onSubmit()
                        } else {
                            onSelection(option.id, !selected)
                        }
                    } label: {
                        HStack(spacing: 9) {
                            Image(systemName: selectionSymbol(selected: selected))
                                .foregroundStyle(selected ? StarlingsMobileColors.accent : .secondary)
                            Text(option.label).foregroundStyle(.primary)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .background(selected ? StarlingsMobileColors.elevated : StarlingsMobileColors.canvas, in: RoundedRectangle(cornerRadius: EnvisioningRadius.control))
                        .overlay(RoundedRectangle(cornerRadius: EnvisioningRadius.control).stroke(selected ? StarlingsMobileColors.primary : StarlingsMobileColors.border, lineWidth: 1))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.meetPlain)
                    .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                    .disabled(isSubmitting)
                    .accessibilityLabel(option.label)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
                if let error, !error.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(.red).accessibilityAddTraits(.isStaticText)
                }
                if question.mode == .multiple {
                    Button(action: onSubmit) {
                        Text(isSubmitting ? String(localized: "Submitting…") : String(localized: "Submit answer"))
                    }
                        .buttonStyle(StarlingsFilledButtonStyle(minHeight: 44, expands: false, font: .subheadline.weight(.semibold)))
                        .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                        .disabled(selectedOptionIDs.isEmpty || isSubmitting)
                        .accessibilityHint("Your selection is sent to the agent.")
                } else if isSubmitting {
                    ProgressView("Submitting…")
                        .font(.footnote)
                        .tint(StarlingsMobileColors.accent)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: 420, alignment: .leading)
        .background(StarlingsMobileColors.panel, in: RoundedRectangle(cornerRadius: EnvisioningRadius.card, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Interactive question")
    }

    private func selectionSymbol(selected: Bool) -> String {
        switch (question.mode, selected) {
        case (.single, true): "largecircle.fill.circle"
        case (.single, false): "circle"
        case (.multiple, true): "checkmark.square.fill"
        case (.multiple, false): "square"
        }
    }
}

private struct AttachmentView: View {
    let file: ThreadMessageAttachment
    let load: (ThreadMessageAttachment) async -> Data?

    @State private var image: UIImage?

    var body: some View {
        Group {
            if file.contentType.hasPrefix("image/") {
                ZStack {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Rectangle().fill(Color.secondary.opacity(0.1))
                    }
                }
                // The box is reserved from the size the uploader measured, so
                // the transcript does not reflow as each picture lands.
                .aspectRatio(ratio, contentMode: .fit)
                .frame(maxWidth: 260)
                .meetConcentricClip(fallbackRadius: EnvisioningRadius.card)
                .task {
                    guard image == nil, let data = await load(file) else { return }
                    image = UIImage(data: data)
                }
            } else {
                Label("\(file.name) · \(file.sizeDescription)", systemImage: "doc")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityLabel(file.name)
    }

    private var ratio: CGFloat {
        guard let width = file.width, let height = file.height, width > 0, height > 0 else { return 4.0 / 3.0 }
        return CGFloat(width) / CGFloat(height)
    }
}

/// The card under a message that carries a link.
///
/// The phone never reads the linked page — the Worker does, and answers the
/// text. See `LinkPreview` for why. Everything drawn here is a `Text`: a
/// preview is metadata written by whoever owns the page at the other end of a
/// link somebody pasted, which makes it the least trustworthy string on the
/// screen, and it never becomes markup on its way here.
///
/// Nothing is drawn until there is something to say. A link whose page offers
/// no title and no description leaves the message as it was rather than adding
/// a card that only repeats the domain the URL already shows.
struct MessageLinkPreview: View {
    let text: String

    @EnvironmentObject private var app: StarlingsAppModel
    @State private var preview: LinkPreview?

    var body: some View {
        LinkPreviewCard(preview: preview)
            .task(id: text) { await load() }
    }

    private func load() async {
        guard let link = ThreadMarkdown.firstPreviewableLink(in: text) else {
            preview = nil
            return
        }
        guard let credentials = app.ownerCredentials else { return }
        // A link that cannot be read is a link, not an error: the message is
        // already legible and the reader has nothing to do about a site that
        // did not answer.
        preview = try? await app.api.linkPreview(credentials: credentials, url: link)
    }
}

/// The card itself, once somebody has fetched one.
///
/// Split from the fetching because the two surfaces that draw it are
/// authorized differently: a thread reads a link on the member's session, and
/// a meeting's chat reads it on the meeting's own token, because a guest has
/// no account. The card does not care which — it is handed a preview.
///
/// Draws nothing at all when there is nothing to say. A link whose page offers
/// no title and no description leaves the message as it was rather than adding
/// a card that only repeats the domain the URL already shows.
struct LinkPreviewCard: View {
    let preview: LinkPreview?

    var body: some View {
        if let preview, preview.isWorthDrawing, let url = URL(string: preview.url) {
            Link(destination: url) {
                VStack(alignment: .leading, spacing: 2) {
                    if let image = preview.image {
                        // Meet's address, not the publisher's — see `imageURL`.
                        // A fixed box rather than the picture's own shape: a
                        // transcript that reflowed as each one landed would
                        // throw away the reader's place, which is the one thing
                        // a message list must not do.
                        AsyncImage(url: image) { phase in
                            switch phase {
                            case .success(let drawn):
                                drawn.resizable().aspectRatio(contentMode: .fill)
                            default:
                                Color(uiColor: .quaternarySystemFill)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .aspectRatio(1.91, contentMode: .fit)
                        .meetConcentricClip(fallbackRadius: EnvisioningRadius.field)
                        .accessibilityLabel(preview.imageAlt ?? "")
                        .accessibilityHidden((preview.imageAlt ?? "").isEmpty)
                        .padding(.bottom, 2)
                    }
                    Text(preview.label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if let title = preview.title, !title.isEmpty {
                        Text(title)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                    }
                    if let description = preview.description, !description.isEmpty {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            // Two lines is a summary; more is the article,
                            // and the article has its own page.
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 7)
                .padding(.horizontal, 10)
                .meetContainerShape(cornerRadius: EnvisioningRadius.control)
                .meetConcentricBackground(
                    StarlingsMobileColors.elevated,
                    fallbackRadius: EnvisioningRadius.control
                )
                .overlay(alignment: .leading) {
                    // The accent rule the Mac and the web both draw.
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                        .fill(StarlingsMobileColors.accent.opacity(0.55))
                        .frame(width: 3)
                        .padding(.vertical, 4)
                }
            }
            .buttonStyle(.plain)
            .meetHoverLift(cornerRadius: EnvisioningRadius.control)
            // Bounded, so a one-line message is not followed by a card three
            // times its width on an iPad.
            .frame(maxWidth: 420, alignment: .leading)
        }
    }
}

/// Applies formatting to the actual text view selection after a SwiftUI Menu
/// briefly takes first responder from it.
@MainActor
private final class MobileThreadComposerController: ObservableObject {
    weak var textView: MobileThreadComposerTextView?

    func apply(_ action: ThreadMarkdownFormatAction) {
        guard let textView else { return }
        let source = textView.text ?? ""
        let edit = ThreadMarkdownEditing.apply(action, to: source, selection: textView.selectedRange)
        textView.becomeFirstResponder()
        textView.selectedRange = NSRange(location: 0, length: (source as NSString).length)
        textView.insertText(edit.text)
        textView.selectedRange = edit.selection
        textView.refreshPlaceholder()
    }
}

@MainActor
private struct MobileThreadComposerField: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    let prompt: String
    let accessibilityLabel: String
    let controller: MobileThreadComposerController
    @Binding var height: CGFloat
    let onSubmit: () -> Void

    static let minimumHeight: CGFloat = 32
    static let maximumHeight: CGFloat = 112

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MobileThreadComposerTextView {
        let view = MobileThreadComposerTextView()
        view.delegate = context.coordinator
        view.onSubmit = onSubmit
        view.onWidthChange = { [weak view, weak coordinator = context.coordinator] in
            guard let view, let coordinator else { return }
            let fitted = MobileThreadComposerField.fittedHeight(of: view)
            DispatchQueue.main.async {
                if coordinator.parent.height != fitted { coordinator.parent.height = fitted }
            }
        }
        view.prompt = prompt
        view.accessibilityLabel = accessibilityLabel
        controller.textView = view
        return view
    }

    func updateUIView(_ uiView: MobileThreadComposerTextView, context: Context) {
        context.coordinator.parent = self
        uiView.onSubmit = onSubmit
        uiView.prompt = prompt
        uiView.accessibilityLabel = accessibilityLabel
        if uiView.text != text {
            uiView.text = text
            uiView.selectedRange = NSRange(location: (text as NSString).length, length: 0)
        }
        uiView.refreshPlaceholder()
        let fitted = Self.fittedHeight(of: uiView)
        if height != fitted { DispatchQueue.main.async { height = fitted } }
        if isFocused, !uiView.isFirstResponder {
            uiView.becomeFirstResponder()
        } else if !isFocused, uiView.isFirstResponder {
            uiView.resignFirstResponder()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MobileThreadComposerTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        let measured = uiView.sizeThatFits(CGSize(width: width, height: 1_000))
        uiView.isScrollEnabled = measured.height > Self.maximumHeight
        uiView.showsVerticalScrollIndicator = false
        return CGSize(width: width, height: min(max(measured.height, Self.minimumHeight), Self.maximumHeight))
    }

    /// Height for the current text at the view's laid-out width.
    static func fittedHeight(of textView: UITextView) -> CGFloat {
        let width = textView.bounds.width
        guard width > 0 else { return minimumHeight }
        let measured = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return min(max(measured, minimumHeight), maximumHeight)
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MobileThreadComposerField

        init(_ parent: MobileThreadComposerField) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text ?? ""
            (textView as? MobileThreadComposerTextView)?.refreshPlaceholder()
            let fitted = MobileThreadComposerField.fittedHeight(of: textView)
            textView.isScrollEnabled = fitted >= MobileThreadComposerField.maximumHeight
            if parent.height != fitted { parent.height = fitted }
        }

        func textViewDidBeginEditing(_ textView: UITextView) { parent.isFocused = true }
        func textViewDidEndEditing(_ textView: UITextView) { parent.isFocused = false }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
            guard let composer = textView as? MobileThreadComposerTextView else { return true }
            if replacement == "\n" {
                if composer.consumeShiftReturn() { return true }
                parent.onSubmit()
                return false
            }
            let currentLength = ((textView.text ?? "") as NSString).length
            return currentLength - range.length + (replacement as NSString).length <= DirectMessageCadence.maxCharacters
        }
    }
}

@MainActor
private final class MobileThreadComposerTextView: UITextView {
    var onSubmit: (() -> Void)?
    /// Called when the laid-out width changes (rotation, Split View, the
    /// keyboard's safe area), since the wrapped height depends on it.
    var onWidthChange: (() -> Void)?
    private var lastWidth: CGFloat = 0
    var prompt = "" { didSet { placeholderLabel.text = prompt } }
    private var shiftReturnPending = false
    private let placeholderLabel = UILabel()

    init() {
        super.init(frame: .zero, textContainer: nil)
        backgroundColor = .clear
        // Nothing the text view draws may spill past the pill.
        clipsToBounds = true
        textColor = .label
        font = .preferredFont(forTextStyle: .body)
        adjustsFontForContentSizeCategory = true
        textContainerInset = UIEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        textContainer.lineFragmentPadding = 0
        autocapitalizationType = .sentences
        returnKeyType = .send
        showsVerticalScrollIndicator = false
        placeholderLabel.font = .preferredFont(forTextStyle: .body)
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.isUserInteractionEnabled = false
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: topAnchor, constant: 6),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != lastWidth {
            lastWidth = bounds.width
            onWidthChange?()
        }
    }

    func refreshPlaceholder() { placeholderLabel.isHidden = !(text ?? "").isEmpty }

    func consumeShiftReturn() -> Bool {
        defer { shiftReturnPending = false }
        return shiftReturnPending
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard let press = presses.first(where: { $0.key?.keyCode == .keyboardReturnOrEnter }),
              let key = press.key
        else {
            super.pressesBegan(presses, with: event)
            return
        }
        if key.modifierFlags.contains(.shift) {
            shiftReturnPending = true
            super.pressesBegan(presses, with: event)
        } else {
            onSubmit?()
        }
    }
}
