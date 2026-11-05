import Foundation
import KeepKit
import StarlingsContracts
import UIKit

/// One open conversation: its messages, its polling, and its read receipt.
///
/// Scoped to a view rather than the app on purpose. Polling is the entire
/// delivery mechanism until push exists, and a store that outlived the screen
/// would poll conversations nobody is reading.
@MainActor
final class MobileThreadStore: ObservableObject {
    @Published private(set) var messages: [ThreadMessage] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var canLoadOlder = false
    @Published var errorMessage: String?
    /// Files uploaded and waiting for a message to carry them.
    @Published private(set) var pending: [ThreadMessageAttachment] = []
    @Published private(set) var uploading = 0
    @Published private(set) var isMuted = false
    /// Whether this conversation has been put away. A DM only: a channel is a
    /// place, and leaving one is a different verb than filing one.
    @Published private(set) var isArchived = false
    /// Whether archiving is on the table at all, so the menu can leave the
    /// item out rather than offer something that does nothing.
    @Published private(set) var canArchive = false
    /// Where a member forwards an email so it lands here. Nil on a
    /// DM, and on every channel until the deployment has Email Routing.
    @Published private(set) var inboundAddress: String?
    /// Where the reader left off, captured when the conversation opens and held
    /// still afterwards. Re-derived from each poll it would move every four
    /// seconds, which is a mark that has never once been where somebody
    /// stopped reading.
    @Published private(set) var unreadBoundary: Date?
    /// Question drafts live with the open conversation so a poll or a row
    /// rebuild cannot erase choices somebody is still considering.
    @Published private(set) var questionSelections: [String: Set<String>] = [:]
    @Published private(set) var submittingQuestionIDs: Set<String> = []
    @Published private(set) var questionErrors: [String: String] = [:]
    /// Keep release cards with an act in flight, and the last error per card.
    @Published private(set) var releaseBusyIDs: Set<String> = []
    @Published private(set) var releaseErrors: [String: String] = [:]

    /// The view says when a turn with an agent is open — it holds the roster,
    /// the store does not — and the poll runs at the turn's cadence while it
    /// is: steps and streamed text are worth reading as they land.
    var isAgentTurnOpen = false

    private var app: StarlingsAppModel?
    private var thread: ThreadSummary?

    /// So Team knows which conversation is on screen and does not announce it.
    var threadID: String? { thread?.id }
    private var olderCursor: String?
    private var initializedOlderCursor = false
    private var pollTask: Task<Void, Never>?
    private var activeObserver: NSObjectProtocol?

    func open(address: ThreadAddress, app: StarlingsAppModel) async {
        guard pollTask == nil else { return }
        self.app = app
        olderCursor = nil
        initializedOlderCursor = false
        questionSelections = [:]
        submittingQuestionIDs = []
        questionErrors = [:]
        guard let credentials = app.ownerCredentials else {
            errorMessage = "Sign in to send messages."
            return
        }
        isLoading = true
        do {
            let summary = try await app.api.openThread(credentials: credentials, address: address)
            thread = summary
            // Opened by hand: into the device's recents, the list Home's
            // Quick Access module and the search sheet share.
            SearchRecents.remember(.thread(summary), owner: credentials.owner.email)
            unreadBoundary = summary.unread ? (summary.lastReadAt ?? .distantPast) : nil
            isMuted = summary.isMuted
            isArchived = summary.archivedAt != nil
            canArchive = summary.kind == .dm
            inboundAddress = summary.inboundAddress
            await reload()
            startPolling()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func close() {
        pollTask?.cancel()
        pollTask = nil
        if let activeObserver {
            NotificationCenter.default.removeObserver(activeObserver)
        }
        activeObserver = nil
    }

    /// The Mac's three speeds. A second while a turn with an agent
    /// is open, four while the app is active, thirty while it is inactive. In
    /// the background the tick sleeps and reads nothing: a call keeps the app
    /// alive there, and a conversation nobody can see is not worth the radio.
    /// Coming back to the foreground reads at once.
    private func startPolling() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                let state = UIApplication.shared.applicationState
                let cadence: TimeInterval = if self?.isAgentTurnOpen == true, state == .active {
                    DirectMessageCadence.agentTurnPoll
                } else if state == .active {
                    DirectMessageCadence.openThreadPoll
                } else {
                    DirectMessageCadence.backgroundThreadPoll
                }
                try? await Task.sleep(for: .seconds(cadence))
                guard let self, !Task.isCancelled else { return }
                guard UIApplication.shared.applicationState != .background else { continue }
                await self.reload()
            }
        }
        guard activeObserver == nil else { return }
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.pollTask != nil else { return }
                Task { await self.reload() }
            }
        }
    }

    /// Newest page. Older history is appended by `loadOlder`, so a reload can
    /// never shorten a transcript somebody has already scrolled back through.
    private func reload() async {
        guard let app, let credentials = app.ownerCredentials, let thread else { return }
        do {
            let page = try await app.api.messages(credentials: credentials, threadID: thread.id)
            merge(page.messages)
            if !initializedOlderCursor {
                olderCursor = page.olderCursor
                initializedOlderCursor = true
            }
            canLoadOlder = olderCursor != nil
            errorMessage = nil
            // Reading is what clears the dot, and only while the thread is open.
            // Do not turn every four-second message read into a write when the
            // server already says this member is caught up.
            if page.thread.unread {
                try? await app.api.markThreadRead(credentials: credentials, threadID: thread.id)
            }
        } catch {
            if messages.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    func loadOlder() async {
        guard let app, let credentials = app.ownerCredentials, let thread, let cursor = olderCursor else { return }
        do {
            let page = try await app.api.messages(credentials: credentials, threadID: thread.id, before: cursor)
            merge(page.messages)
            olderCursor = page.olderCursor
            canLoadOlder = olderCursor != nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Page back until a reply's parent is present in the flat transcript.
    /// Cursor progress is checked so a malformed or stale page cannot loop.
    func loadOlder(until messageID: String) async -> Bool {
        if messages.contains(where: { $0.id == messageID }) { return true }
        guard let app, let credentials = app.ownerCredentials, let thread else { return false }
        while let cursor = olderCursor {
            do {
                let page = try await app.api.messages(credentials: credentials, threadID: thread.id, before: cursor)
                merge(page.messages)
                olderCursor = page.olderCursor
                canLoadOlder = olderCursor != nil
                if messages.contains(where: { $0.id == messageID }) { return true }
                guard !page.messages.isEmpty, page.olderCursor != cursor else { break }
            } catch {
                errorMessage = error.localizedDescription
                return false
            }
        }
        return false
    }

    /// Returns false when the message never left, so the composer can hand the
    /// text back instead of swallowing it.
    ///
    /// `alone` sends the text as its own message and leaves the staged files
    /// where they are — what paste-and-send wants, since what is on the
    /// clipboard is not the message being written.
    func send(
        _ text: String,
        mentions: [String] = [],
        alone: Bool = false,
        replyToMessageID: String? = nil
    ) async -> Bool {
        guard let app, let credentials = app.ownerCredentials, let thread else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // A message with no text and no file is a keystroke.
        guard !trimmed.isEmpty || (!alone && !pending.isEmpty) else { return false }
        isSending = true
        defer { isSending = false }
        let files = alone ? [] : pending.map(\.id)
        do {
            let sent = try await app.api.sendMessage(
                credentials: credentials,
                threadID: thread.id,
                text: trimmed,
                mentions: mentions,
                attachments: files,
                replyToMessageID: alone ? nil : replyToMessageID
            )
            if !alone { pending = [] }
            merge([sent])
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func selectQuestionOption(_ questionID: String, question: ThreadQuestion, optionID: String, selected: Bool) {
        var options = questionSelections[questionID] ?? []
        switch question.mode {
        case .single:
            options = [optionID]
        case .multiple:
            if selected { options.insert(optionID) } else { options.remove(optionID) }
        }
        questionSelections[questionID] = options
        questionErrors[questionID] = nil
    }

    func answerQuestion(_ questionID: String) async {
        guard let app, let credentials = app.ownerCredentials, let thread,
              let questionMessage = messages.first(where: { $0.id == questionID }),
              let question = questionMessage.question,
              !submittingQuestionIDs.contains(questionID) else { return }
        let selected = question.options.map(\.id).filter { questionSelections[questionID]?.contains($0) == true }
        guard !selected.isEmpty else {
            questionErrors[questionID] = String(localized: "Choose at least one option.")
            return
        }
        submittingQuestionIDs.insert(questionID)
        questionErrors[questionID] = nil
        defer { submittingQuestionIDs.remove(questionID) }
        do {
            let response = try await app.api.answerQuestion(
                credentials: credentials,
                threadID: thread.id,
                messageID: questionID,
                optionIDs: selected
            )
            merge([response.message])
            questionSelections[questionID] = nil
            questionErrors[questionID] = nil
        } catch {
            questionErrors[questionID] = error.localizedDescription
        }
    }

    /// Record on a release card what this device did in Keep. Throws, so the
    /// approval sheet can say the card did not hear.
    func recordRelease(_ messageID: String, _ update: ThreadReleaseUpdateRequest) async throws {
        guard let app, let credentials = app.ownerCredentials, let thread else { return }
        let message = try await app.api.updateRelease(credentials: credentials, threadID: thread.id, messageID: messageID, update)
        merge([message])
        releaseErrors[messageID] = nil
    }

    /// End now: Keep first, then the card. Needs no unlock; ending opens nothing.
    func endRelease(_ message: ThreadMessage, keep: KeepAccess) async {
        guard let request = message.releaseRequest, let state = message.releaseState,
              !releaseBusyIDs.contains(message.id) else { return }
        releaseBusyIDs.insert(message.id)
        releaseErrors[message.id] = nil
        defer { releaseBusyIDs.remove(message.id) }
        do {
            _ = try await keep.session.endRelease(vaultId: state.vaultID, releaseId: request.requestID)
            try await recordRelease(message.id, ThreadReleaseUpdateRequest(action: .end))
        } catch {
            releaseErrors[message.id] = error.localizedDescription
        }
    }

    /// Add or remove one emoji. The rail comes back from the Worker rather than
    /// being guessed at: whether a press added or removed is its answer, and a
    /// client that assumed would drift the moment two people pressed at once.
    func react(to message: ThreadMessage, emoji: String) async {
        guard let app, let credentials = app.ownerCredentials, let thread else { return }
        do {
            let reactions = try await app.api.react(
                credentials: credentials,
                threadID: thread.id,
                messageID: message.id,
                emoji: emoji
            )
            replace(message.id) { $0.withReactions(reactions) }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func edit(_ message: ThreadMessage, to text: String) async -> Bool {
        guard let app, let credentials = app.ownerCredentials, let thread else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        do {
            try await app.api.editMessage(
                credentials: credentials,
                threadID: thread.id,
                messageID: message.id,
                text: trimmed
            )
            await reload()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func withdraw(_ message: ThreadMessage) async {
        guard let app, let credentials = app.ownerCredentials, let thread else { return }
        do {
            try await app.api.withdrawMessage(
                credentials: credentials,
                threadID: thread.id,
                messageID: message.id
            )
            await reload()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Muted for a week rather than forever: a mute with no end is a mute
    /// nobody remembers setting. Same reasoning as do-not-disturb.
    func toggleMute() async {
        guard let app, let credentials = app.ownerCredentials, let thread else { return }
        let until: Date? = isMuted ? nil : Date().addingTimeInterval(7 * 24 * 3600)
        do {
            try await app.api.muteThread(credentials: credentials, threadID: thread.id, until: until)
            isMuted = until != nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Put it away, or take it back. Nothing is deleted and there is no archive
    /// to visit: the conversation reopens from the person's row in Team, and
    /// anything said in it from now on puts it back in the list by itself.
    func toggleArchive() async {
        guard let app, let credentials = app.ownerCredentials, let thread else { return }
        let archived = !isArchived
        do {
            try await app.api.archiveThread(credentials: credentials, threadID: thread.id, archived: archived)
            isArchived = archived
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Upload, then hold until a message carries it. Uploading is not sending:
    /// a staged file nobody sends is read by nothing.
    func attach(name: String, contentType: String, data: Data, pixelSize: CGSize?) async {
        guard let app, let credentials = app.ownerCredentials, let thread else { return }
        uploading += 1
        defer { uploading -= 1 }
        do {
            let attachment = try await app.api.uploadAttachment(
                credentials: credentials,
                threadID: thread.id,
                name: name,
                contentType: contentType,
                data: data,
                pixelSize: pixelSize
            )
            pending.append(attachment)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Taken off the message only. The bytes stay staged and unreferenced,
    /// which is the same inert state an abandoned composer leaves.
    func drop(_ attachment: ThreadMessageAttachment) {
        pending.removeAll { $0.id == attachment.id }
    }

    func attachmentData(_ attachment: ThreadMessageAttachment) async -> Data? {
        guard let app, let credentials = app.ownerCredentials, let thread else { return nil }
        return try? await app.api.attachmentData(
            credentials: credentials,
            threadID: thread.id,
            attachmentID: attachment.id
        )
    }

    private func replace(_ id: String, _ transform: (ThreadMessage) -> ThreadMessage) {
        messages = messages.map { $0.id == id ? transform($0) : $0 }
    }

    /// Union by id, sorted by time. The poll and a just-sent message routinely
    /// carry the same row, and a transcript that duplicates or reorders itself
    /// under a refresh is worse than one that arrives a beat late.
    private func merge(_ incoming: [ThreadMessage]) {
        var byID = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for message in incoming { byID[message.id] = message }
        messages = byID.values.sorted { left, right in
            left.sentAt == right.sentAt ? left.id < right.id : left.sentAt < right.sentAt
        }
    }
}
