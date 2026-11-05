import Foundation

/// Who answers for a project or a lead (docs/OWNERSHIP.md). A name,
/// never a permission. The chosen person is stored on the subject; when nobody
/// chose, the subject shows a suggestion: whoever holds the most open tasks.
/// The TypeScript twin is `packages/contracts/src/responsible.ts`; both read
/// `fixtures/responsible.json` (Tests/ResponsibleFixtureTests.swift).
struct Responsible: Equatable, Sendable {
    enum Source: String, Sendable {
        case chosen, suggested
    }

    let email: String
    let source: Source

    /// "Responsible", or "Responsible (suggested)" when nobody chose.
    var label: String {
        source == .chosen ? String(localized: "Responsible") : String(localized: "Responsible (suggested)")
    }

    /// One open task's part in the suggestion: who holds it, and its status.
    struct Task: Sendable {
        let assigneeEmail: String?
        let status: String
    }

    /// The chosen person, else the one assigned the most open tasks (ties go
    /// to the first address), else nil. Projects and leads only.
    static func of(kind: String, responsibleEmail: String?, tasks: [Task]) -> Responsible? {
        guard kind == "project" || kind == "lead" else { return nil }
        if let chosen = responsibleEmail?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !chosen.isEmpty {
            return Responsible(email: chosen, source: .chosen)
        }
        var counts: [String: Int] = [:]
        for task in tasks where isOpen(task.status) {
            guard let email = task.assigneeEmail?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !email.isEmpty else { continue }
            counts[email, default: 0] += 1
        }
        var best: String?
        var most = 0
        for (email, count) in counts.sorted(by: { $0.key < $1.key }) where count > most {
            best = email
            most = count
        }
        return best.map { Responsible(email: $0, source: .suggested) }
    }

    static func of(_ subject: CrmSubject, tasks: [CrmTask]) -> Responsible? {
        of(kind: subject.kind, responsibleEmail: subject.responsibleEmail,
           tasks: tasks.map { Task(assigneeEmail: $0.assigneeEmail, status: $0.status.rawValue) })
    }

    /// Work somebody still owes: the contract's OPEN_TASK_STATUSES. A switch,
    /// so a new status is a compile error here rather than a silent miss.
    private static func isOpen(_ raw: String) -> Bool {
        guard let status = CrmTaskStatus(rawValue: raw) else { return false }
        switch status {
        case .pending, .inProgress, .review, .blocked: return true
        case .completed, .cancelled, .proposed, .declined: return false
        }
    }
}

/// `PATCH /api/crm/subjects/:kind/:id` with only the choice: a person's
/// address, or an explicit null to clear it.
struct CrmSubjectResponsibleUpdate: Encodable, Sendable {
    let responsibleEmail: String?

    private enum CodingKeys: String, CodingKey {
        case responsibleEmail = "responsible_email"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(responsibleEmail, forKey: .responsibleEmail)
    }
}
