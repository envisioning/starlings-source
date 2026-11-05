import CryptoKit
import Foundation
import StarlingsContracts

/// The small wire model shared by the Mac and iOS capture surfaces.
///
/// A Quick Note is intentionally not a task yet: it can be captured before a
/// project, lead, subject, assignee, or date is known. The lifecycle fields
/// leave room for the later triage step without losing the original capture.
// The shapes are generated (`StarlingsContracts`): `QuickNote`, `QuickNotePromotion`,
// `QuickNoteContext`, the source, state and promotion-kind values, and the
// three responses. What a surface reads off them lives here.

extension QuickNotePromotionKind {
    /// The one line a filed note keeps under its body. Keep was removed from
    /// every triage sheet; `retainedNote` stays so rows filed before that
    /// still draw their label.
    var filedLabel: String {
        switch self {
        case .task: String(localized: "Filed as task")
        case .issue: String(localized: "Filed as issue")
        case .retainedNote: String(localized: "Kept as note")
        case .message: String(localized: "Sent as message")
        case .doc: String(localized: "Filed as document")
        }
    }
}

// `POST /api/quick-notes/:id/promote` is the generated `QuickNotePromote`:
// `id` is whatever the destination calls what was made — a task or document
// uuid, a message id, or an issue's `owner/repo#number`. `PATCH
// /api/quick-notes/:id` is `QuickNoteUpdate`: the body is the only thing an
// owner rewrites.

extension QuickNote: Identifiable {
    var isOpen: Bool { state == .open }

    /// The first line, for a row title or a proposed filing title.
    var firstLine: String {
        note_firstLine(body)
    }

    /// What a row says under the body: where it went, or when it was written.
    var detailLabel: String {
        if let promotion { return promotion.kind.filedLabel }
        guard let date = ISODate.parse(createdAt) else { return "" }
        return StarlingsDateFormatting.relative(date)
    }
}

private func note_firstLine(_ body: String) -> String {
    let line = body.split(whereSeparator: \.isNewline).first.map(String.init) ?? body
    return line.trimmingCharacters(in: .whitespaces)
}

// `POST /api/quick-notes` is the generated `QuickNoteCreate`; every caller
// names its surface as `source`.

// MARK: - Save first, send later

/// A Quick Note this device holds that the Worker may not have yet.
///
/// The id is minted here, so every try sends the same one: the Worker answers
/// a repeat with the note it already made, and a lost response plus a retry
/// is still one note. `capturedAt` is when the person wrote it, so a note
/// sent an hour late still says when it was written.
struct QuickNotePending: Codable, Hashable, Sendable, Identifiable {
    let id: String
    var body: String
    let source: QuickNoteSource
    /// Epoch milliseconds.
    let capturedAt: Int
    /// A create for it has left this device at least once, so the Worker may
    /// already hold it.
    var sent: Bool
    /// Rewritten here after a create left: the Worker's copy may hold the old body.
    var edited: Bool
    /// The Worker's refusal, in its words. Nil while the note only waits for
    /// a connection.
    var lastError: String?

    init(body: String, source: QuickNoteSource, id: String = UUID().uuidString.lowercased(), capturedAt: Date = Date()) {
        self.id = id
        self.body = body
        self.source = source
        self.capturedAt = Int((capturedAt.timeIntervalSince1970 * 1000).rounded())
        sent = false
        edited = false
        lastError = nil
    }

    var create: QuickNoteCreate {
        QuickNoteCreate(body: body, source: source, id: id, capturedAt: capturedAt)
    }

    /// The row a list draws until the Worker answers.
    var note: QuickNote {
        let written = ISODate.format(Date(timeIntervalSince1970: TimeInterval(capturedAt) / 1000))
        return QuickNote(id: id, body: body, source: source, state: .open, createdAt: written, updatedAt: written)
    }
}

/// The captures waiting to reach the Worker, one file per owner, shared by
/// the Mac's Home and the phone. A capture is on disk before the field
/// clears, so a failed send, a dead network or a killed app loses nothing.
///
/// `owner` is the caller's key for one owner on one workspace
/// (`WorkspaceScope.keychainAccount` of the email). A different owner reads
/// a different file and never sees or sends another's captures.
@MainActor
final class QuickNoteOutbox {
    private let folder: URL
    private(set) var owner: String?
    /// Newest first, the order a list draws them.
    private(set) var entries: [QuickNotePending] = []
    private var draining = false
    /// The notes passes landed lately, numbered, so a list read that began
    /// before one landed does not drop it (`reconcile`).
    private var landedLog: [(mark: Int, note: QuickNote)] = []
    private var landedCount = 0

    init(directory: URL) {
        folder = Self.folder(in: directory)
    }

    /// Reads the owner's file when the owner changed. Nil empties the list.
    func use(owner: String?) {
        guard owner != self.owner else { return }
        self.owner = owner
        landedLog = []
        entries = owner
            .flatMap { try? Data(contentsOf: fileURL(for: $0)) }
            .flatMap { try? JSONDecoder().decode([QuickNotePending].self, from: $0) } ?? []
    }

    func entry(id: String) -> QuickNotePending? {
        entries.first { $0.id == id }
    }

    func contains(_ id: String) -> Bool {
        entry(id: id) != nil
    }

    func add(_ entry: QuickNotePending) {
        guard owner != nil else { return }
        entries.insert(entry, at: 0)
        persist()
    }

    func remove(id: String) {
        guard contains(id) else { return }
        entries.removeAll { $0.id == id }
        persist()
    }

    /// A new body for a capture still here. The next create carries it; if a
    /// create already left, the send rewrites the Worker's copy after it.
    func rewrite(id: String, body: String) {
        change(id) {
            $0.body = body
            if $0.sent { $0.edited = true }
        }
    }

    /// The Worker's list with this device's captures on top, one row per id.
    func merged(_ listed: [QuickNote]) -> [QuickNote] {
        let ids = Set(entries.map(\.id))
        return entries.map(\.note) + listed.filter { !ids.contains($0.id) }
    }

    /// Taken before a list read starts; `reconcile` reads it back.
    func readMark() -> Int { landedCount }

    /// A fresh Worker list, read since `mark`. A capture the list already
    /// holds landed and its answer was lost: it leaves the outbox, unless it
    /// was rewritten here since. A note a pass landed after the read began
    /// is kept on top, since the list may predate it.
    func reconcile(_ fresh: [QuickNote], readSince mark: Int) -> [QuickNote] {
        let ids = Set(fresh.map(\.id))
        let before = entries.count
        entries.removeAll { ids.contains($0.id) && !$0.edited }
        if entries.count != before { persist() }
        let late = landedLog.filter { $0.mark > mark && !ids.contains($0.note.id) }.map(\.note)
        return Array(late.reversed()) + fresh
    }

    /// One pass over the owner's captures, oldest first, so they land in the
    /// order they were written. One pass at a time; a caller that finds one
    /// running returns, and the running pass reads each entry as it is now.
    ///
    /// A failure `refusal` answers nil for (offline, timeout, a 5xx, a dead
    /// token) ends the pass quietly: the rest would fail the same way. One it
    /// answers with words is the Worker refusing this note; the words stay on
    /// the entry and the pass goes on to the next.
    func drain(
        create: @MainActor (QuickNotePending) async throws -> QuickNote,
        rewrite: @MainActor (_ id: String, _ body: String) async throws -> QuickNote,
        discard: @MainActor (_ id: String) async -> Void,
        refusal: @MainActor (any Error) -> String?,
        landed: @MainActor (QuickNote) -> Void
    ) async {
        guard !draining, let owner else { return }
        draining = true
        defer { draining = false }
        for id in entries.reversed().map(\.id) {
            guard self.owner == owner, let pending = self.entry(id: id) else { continue }
            change(id) { $0.sent = true }
            do {
                var note = try await create(pending)
                guard self.owner == owner else { return }
                guard let current = self.entry(id: id) else {
                    // Deleted here while the create was out: the Worker's
                    // copy goes too.
                    await discard(id)
                    continue
                }
                if current.edited {
                    note = try await rewrite(id, current.body)
                    guard self.owner == owner else { return }
                }
                remove(id: id)
                landedCount += 1
                landedLog.append((mark: landedCount, note: note))
                if landedLog.count > 20 { landedLog.removeFirst(landedLog.count - 20) }
                landed(note)
            } catch {
                guard self.owner == owner else { return }
                guard let message = refusal(error) else { return }
                change(id) { $0.lastError = message }
            }
        }
    }

    private func change(_ id: String, _ edit: (inout QuickNotePending) -> Void) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        edit(&entries[index])
        persist()
    }

    private func fileURL(for owner: String) -> URL {
        folder.appendingPathComponent(Self.fileName(owner: owner))
    }

    /// One owner's pending file: a digest of `<email>@<webOrigin>`, so a
    /// workspace that moves origin renames it (`WorkspaceOriginMove`).
    nonisolated static func fileName(owner: String) -> String {
        let digest = SHA256.hash(data: Data(owner.lowercased().utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return "\(digest).json"
    }

    /// `<directory>/QuickNotes`, where every owner's file lives.
    nonisolated static func folder(in directory: URL) -> URL {
        directory.appendingPathComponent("QuickNotes", isDirectory: true)
    }

    /// The whole file, written atomically. A failed write leaves the entry in
    /// memory; the next change writes again.
    private func persist() {
        guard let owner else { return }
        let url = fileURL(for: owner)
        do {
            if entries.isEmpty {
                if FileManager.default.fileExists(atPath: url.path) {
                    try FileManager.default.removeItem(at: url)
                }
                return
            }
            try FileManager.default.createDirectory(
                at: folder,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            var options: Data.WritingOptions = [.atomic]
            #if os(iOS)
            // Until first unlock, as the artifact outbox and SnapshotStore:
            // a capture from the lock screen must still reach the disk.
            options.insert(.completeFileProtectionUntilFirstUserAuthentication)
            #endif
            try JSONEncoder().encode(entries).write(to: url, options: options)
        } catch {
            // The entry stays in memory and goes out on the next drain.
        }
    }
}
