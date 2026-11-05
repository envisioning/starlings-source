import Foundation
import StarlingsContracts

/// The Worker calls the wrist makes, on the token the phone lent it.
///
/// Not `StarlingsAPI`: that file carries the whole phone surface and its model
/// graph, and the watch needs only the quick notes. The paths and wire shapes
/// are the same ones — `QuickNoteCreate`, `QuickNoteUpdate` and the quick
/// note responses are compiled from the shared files, so a change to those
/// shapes breaks this target too instead of drifting.
struct WatchStarlingsClient {
    let session: WatchBridgeSnapshot.Session

    /// The token the phone lent is dead. The watch cannot renew it; only the
    /// next snapshot from the phone can.
    struct SessionRejected: Error {}
    struct Failed: Error {
        let message: String
    }

    func quickNotes() async throws -> [QuickNote] {
        try await send(path: ["quick-notes"], method: "GET", body: nil, as: QuickNotesResponse.self).notes
    }

    /// `id` is the wrist's own: a repeat after a lost answer
    /// gets the note the first one made. `capturedAt` is when it was
    /// dictated, in epoch milliseconds.
    func createQuickNote(_ body: String, id: String, capturedAt: Int?) async throws -> QuickNote {
        try await send(
            path: ["quick-notes"],
            method: "POST",
            body: try JSONEncoder().encode(QuickNoteCreate(body: body, source: .watch, id: id, capturedAt: capturedAt)),
            as: QuickNoteResponse.self
        ).note
    }

    func updateQuickNote(id: String, body: String) async throws -> QuickNote {
        try await send(
            path: ["quick-notes", id],
            method: "PATCH",
            body: try JSONEncoder().encode(QuickNoteUpdate(body: body)),
            as: QuickNoteResponse.self
        ).note
    }

    func deleteQuickNote(id: String) async throws {
        _ = try await send(path: ["quick-notes", id], method: "DELETE", body: nil, as: Acknowledged.self)
    }

    /// A 2xx is the answer; the body is not read.
    private struct Acknowledged: Decodable {}

    private struct ErrorBody: Decodable {
        let error: String?
        let code: String?
    }

    private func send<Response: Decodable>(
        path: [String],
        method: String,
        body: Data?,
        as type: Response.Type
    ) async throws -> Response {
        guard let base = URL(string: session.apiEndpoint) else { throw Failed(message: "No service") }
        var request = URLRequest(url: path.reduce(base) { $0.appending(path: $1) })
        request.httpMethod = method
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
           let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String {
            request.setValue("watchos/\(version) (\(build))", forHTTPHeaderField: "x-meet-client")
        }
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failed(message: String(localized: "No connection"))
        }
        guard let http = response as? HTTPURLResponse else { throw Failed(message: String(localized: "Bad response")) }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
            // The same stable cause `MobileMeetError.isOwnerSessionRejection`
            // matches on. Never the prose.
            if body?.code == "owner_auth_required" { throw SessionRejected() }
            throw Failed(message: body?.error ?? String(localized: "Failed (\(http.statusCode))"))
        }
        if Response.self == Acknowledged.self, let empty = Acknowledged() as? Response { return empty }
        return try JSONDecoder().decode(type, from: data)
    }
}
