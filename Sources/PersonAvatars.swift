import Foundation

// Profile pictures, shared by the Mac app and the iOS app.
//
// The roster carries `avatarUpdatedAt` and nothing else; the bytes are a
// separate, member-gated read (`GET /api/avatar`). That split is what lets a
// team of twenty poll presence every thirty seconds without moving twenty images
// with it — and it makes the version, not a timer, the thing that decides when
// a picture is re-fetched.
//
// Foundation-only on purpose: an `NSImage` and a `UIImage` are made at the two
// call sites, and everything up to the bytes is one piece of code rather than
// two that can disagree about caching.

/// What a client can do with pictures. Both API types conform, which is the
/// same arrangement `TranscriptUploading` uses for the outbox.
protocol PersonAvatarSource: Sendable {
    /// One person's picture. `version` is their `avatarUpdatedAt`.
    func personAvatar(email: String, version: Date) async throws -> Data
    /// Replace your own, and answer with the new version. Bytes must already
    /// be a square JPEG/PNG/WebP — the Worker stores what it is given.
    func uploadProfileAvatar(_ data: Data) async throws -> Date?
    /// Back to initials.
    func removeProfileAvatar() async throws
}

/// Bytes per person and version, fetched at most once.
///
/// Keyed by version as well as address, so a changed picture is a different
/// entry rather than a cache to invalidate — and a person who has *no* picture
/// costs one 404 that is remembered as "nothing", not one per redraw. Views
/// draw initials while this is empty, which is also what they draw forever for
/// somebody who never uploaded one; there is no loading state to design.
actor PersonAvatarStore {
    static let shared = PersonAvatarStore()

    private var cached: [String: Data?] = [:]
    private var inFlight: [String: Task<Data?, Never>] = [:]
    /// Every person's current version, as last seen on the roster.
    ///
    /// This is what lets a surface that knows only an address — a message, a
    /// task assignee — draw a face without carrying presence into its own wire
    /// type. Whoever polls the roster calls `remember`; everything else asks by
    /// email and gets the right version or nothing.
    private var versions: [String: Date] = [:]

    /// Cap the memory this can hold. A 512px JPEG is tens of kilobytes and a
    /// team is tens of people, so this is generous — it exists so that a long
    /// session browsing conversations cannot grow without end.
    private static let maximumEntries = 256

    /// Publish what the roster just said. Cheap and idempotent — call it on
    /// every poll.
    func remember(_ peers: [Peer]) {
        for peer in peers {
            let key = peer.email.lowercased()
            if let updated = peer.avatarUpdatedAt { versions[key] = updated } else { versions.removeValue(forKey: key) }
        }
    }

    func avatar(email: String, version: Date? = nil, from source: PersonAvatarSource) async -> Data? {
        // A caller with a roster row in hand passes the version; one holding
        // only an address gets the one the roster last published.
        guard let version = version ?? versions[email.lowercased()] else { return nil }
        let key = Self.key(email: email, version: version)
        if let hit = cached[key] { return hit }
        if let running = inFlight[key] { return await running.value }

        let task = Task<Data?, Never> { [source] in
            do {
                return try await source.personAvatar(email: email, version: version)
            } catch {
                // A 404 is the ordinary answer for somebody without a picture,
                // and every other failure draws the same initials. Remembered
                // either way so a roster does not re-ask on every redraw.
                return nil
            }
        }
        inFlight[key] = task
        let data = await task.value
        inFlight[key] = nil
        store(key, data)
        return data
    }

    /// Drop everything held for one person, so their next draw re-reads.
    /// Used after *your own* upload: your version changed, and the roster that
    /// would have told you so is up to ten seconds behind.
    func forget(email: String, version: Date? = nil) {
        let address = email.lowercased()
        let prefix = "\(address)|"
        cached = cached.filter { !$0.key.hasPrefix(prefix) }
        inFlight = inFlight.filter { !$0.key.hasPrefix(prefix) }
        if let version { versions[address] = version } else { versions.removeValue(forKey: address) }
    }

    private func store(_ key: String, _ data: Data?) {
        if cached.count >= Self.maximumEntries { cached.removeAll(keepingCapacity: true) }
        cached[key] = data
    }

    private static func key(email: String, version: Date) -> String {
        "\(email.lowercased())|\(Int(version.timeIntervalSince1970 * 1000))"
    }
}
