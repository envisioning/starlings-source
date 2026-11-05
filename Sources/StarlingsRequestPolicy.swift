import Foundation

/// How a client talks to the Worker, as one table.
///
/// The table is `packages/contracts/src/request-policy.ts`, written out by
/// `pnpm registries:gen` into `Generated/RequestPolicyRegistry.swift` (the
/// timeout, the retry rule, one `SnapshotRule` per snapshot key and the writes
/// that make it stale). This file holds the types and the two lookups.
/// `StarlingsHTTPTransport` applies the timeout and the retry to every request, and
/// the API files name a write (`invalidating: .taskUpdate`) rather than the
/// lists it clears. Neither keeps a list of its own.
///
/// Compiled into both the Mac and the iOS target.
enum StarlingsRequestPolicy {
    /// The clients the table speaks about. The web reads the same rows from the
    /// TypeScript module; it is named here so the generated table decodes.
    enum Client: String, Sendable, Equatable {
        case mac, ios, web
    }

    /// When a failed request is sent again.
    struct Retry: Sendable, Equatable {
        let methods: [String]
        let extraAttempts: Int
        let delaySeconds: TimeInterval
        /// Every status from here up is the service saying "not now".
        let statusFloor: Int
        /// And these below it: a request timeout, a rate limit.
        let statuses: [Int]

        /// Whether a request with this method may be sent twice. POST and
        /// DELETE never are: see the TypeScript module for why.
        func appliesTo(method: String?) -> Bool {
            methods.contains((method ?? "GET").uppercased())
        }

        func retries(status: Int) -> Bool {
            status >= statusFloor || statuses.contains(status)
        }

        /// The same rule with no second attempt, for a test that counts requests.
        var never: Retry {
            Retry(methods: methods, extraAttempts: 0, delaySeconds: delaySeconds, statusFloor: statusFloor, statuses: statuses)
        }

        /// The same rule without the pause, so a test does not wait.
        var withoutPause: Retry {
            Retry(methods: methods, extraAttempts: extraAttempts, delaySeconds: 0, statusFloor: statusFloor, statuses: statuses)
        }
    }

    /// One snapshotted list: where it is stored, what reads it, which clients
    /// keep it, and which writes make it stale.
    struct SnapshotRule: Sendable, Equatable {
        let name: String
        let key: String
        let read: String
        let clients: [Client]
        let invalidatedBy: [StarlingsSnapshotWrite]
    }

    /// The keys and prefixes a write makes stale, in the table's order. Handed
    /// to `SnapshotStore.invalidate`, which drops every stored key that is one
    /// of them or begins `<key>?` or `<key>/`.
    static func invalidated(by write: StarlingsSnapshotWrite) -> [String] {
        snapshots.filter { $0.invalidatedBy.contains(write) }.map(\.key)
    }

    /// Whether `client` keeps a snapshot of the read stored under `key`. A
    /// shared route names its snapshot once (`StarlingsRoute.snapshotKey`);
    /// the table says which clients keep it. A per-query key (`<key>?…`,
    /// `<key>/…`) belongs to its row.
    static func keeps(_ key: String, client: Client) -> Bool {
        snapshots.contains { rule in
            (rule.key == key || key.hasPrefix("\(rule.key)?") || key.hasPrefix("\(rule.key)/"))
                && rule.clients.contains(client)
        }
    }

    /// Whether a thrown transport error is worth a second attempt: anything the
    /// network did, except a request somebody cancelled.
    static func isRetryable(_ error: any Error) -> Bool {
        if error is CancellationError { return false }
        if let url = error as? URLError, url.code == .cancelled { return false }
        return !Task.isCancelled
    }
}

/// The keys of the reads that are stored per query. Each is its row's key in
/// the table followed by the query, so a write that names the row takes every
/// page with it. Both clients build their keys here.
extension StarlingsSnapshotKey {
    static func subjectsKey(kind: MeetingCategoryKind.SubjectKind, query: String, status: String?) -> String {
        "\(subjects)?kind=\(kind.rawValue)&q=\(query)&status=\(status ?? "")"
    }

    static func subjectCountsKey(kind: MeetingCategoryKind.SubjectKind, query: String) -> String {
        "\(subjectCounts)?kind=\(kind.rawValue)&q=\(query)"
    }

    static func tasksKey(projectID: String?, leadID: String?, eventID: String? = nil, organizationID: String? = nil) -> String {
        "\(tasks)?project_id=\(projectID ?? "")&lead_id=\(leadID ?? "")&event_id=\(eventID ?? "")&organization_id=\(organizationID ?? "")"
    }

    static func interactionsKey(projectID: String?, leadID: String?, organizationID: String? = nil) -> String {
        "\(interactions)?project_id=\(projectID ?? "")&lead_id=\(leadID ?? "")&organization_id=\(organizationID ?? "")"
    }

    /// A project's issues, per exact filter and page. An issue write takes
    /// every page: the write can land on any.
    static func issuesKey(projectID: String, filter: CrmIssueFilter, page: Int) -> String {
        var components = URLComponents()
        components.queryItems = filter.query(projectID: projectID, page: page).queryItems
        return "\(issues)?\(components.percentEncodedQuery ?? "")"
    }

    /// One subject's detail, for a read-only page. Under `crm/subjects` on
    /// purpose: a subject write takes the lists and this with them.
    static func subjectDetailKey(kind: MeetingCategoryKind.SubjectKind, id: String) -> String {
        "\(subjects)/\(kind.rawValue)/\(id)"
    }
}
