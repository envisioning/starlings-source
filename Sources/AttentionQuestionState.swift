import Combine
import Foundation
import StarlingsContracts

/// Shared native draft and canonical winner. A failed permission read disables
/// controls; an older in-flight read cannot replace a resolution.
@MainActor
final class AttentionQuestionState: ObservableObject {
    @Published private(set) var request: AttentionRequest
    @Published private(set) var selected: Set<String> = []
    @Published private(set) var busy = false
    @Published private(set) var fresh = false
    @Published private(set) var error: String?
    var onChange: (() -> Void)?
    private var reportedRevision: Int?

    init(_ request: AttentionRequest) { self.request = request }

    func canAnswer(as email: String?) -> Bool {
        fresh && !busy && request.state == .open
            && email?.lowercased() == request.recipientEmail.lowercased()
    }

    func toggle(_ id: String) {
        guard request.options.contains(where: { $0.id == id }), request.state == .open else { return }
        if request.selectionMode == .single { selected = [id] }
        else if selected.contains(id) { selected.remove(id) }
        else { selected.insert(id) }
        onChange?()
    }

    func adopt(_ next: AttentionRequest) {
        guard next.id == request.id, next.revision >= request.revision else { return }
        request = next
        if next.state != .open { selected.removeAll() }
    }

    func refresh(read: () async throws -> AttentionRequest) async {
        guard !busy else { return }
        do {
            let next = try await read()
            guard !Task.isCancelled else { return }
            adopt(next); fresh = true; error = nil
        } catch {
            guard !Task.isCancelled else { return }
            fresh = false; self.error = error.localizedDescription
        }
        onChange?()
    }

    func poll(read: () async throws -> AttentionRequest, onResolved: (AttentionRequest) -> Void) async {
        while !Task.isCancelled {
            await refresh(read: read)
            if request.state != .open, reportedRevision != request.revision {
                reportedRevision = request.revision; onResolved(request)
            }
            do { try await Task.sleep(for: .seconds(DirectMessageCadence.openThreadPoll)) }
            catch { return }
        }
    }

    func resolve(action: AttentionResolveInputAction, email: String?, send: (AttentionResolveInput) async throws -> AttentionResolveResponse) async {
        guard canAnswer(as: email) else { return }
        let ids = request.options.filter { selected.contains($0.id) }.map(\.id)
        guard action == .dismiss || !ids.isEmpty else { return }
        busy = true; error = nil; onChange?()
        do {
            let result = try await send(AttentionResolveInput(action: action, optionIDs: action == .answer ? ids : []))
            // accepted=false still carries the first terminal winner.
            adopt(result.request)
        } catch { self.error = error.localizedDescription }
        busy = false; onChange?()
    }
}

