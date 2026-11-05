import Foundation
import StarlingsContracts

/// Goals and decisions (#262), the rules every surface
/// shares: which goals are live, which are late, and the Overview order. The
/// TypeScript port is `packages/contracts/src/goals-decisions.ts`; both are
/// pinned to `fixtures/goals-decisions.json`. Change the fixture first.
///
/// The shapes themselves — `CrmGoal`, `CrmDecision` — are generated into
/// `StarlingsContracts`; nothing here changes a field.
enum GoalsDecisions {
    /// The goals a task picker offers and the Overview lists first: open ones.
    static func isLive(_ goal: CrmGoal) -> Bool {
        goal.status == .open
    }

    /// Late is the task rule: a live goal whose target day is before today,
    /// compared as civil days. A met or dropped goal is never late.
    static func isLate(_ goal: CrmGoal, now: Date = Date(), calendar: Calendar = .current) -> Bool {
        guard isLive(goal), let day = WorkItems.civilDay(goal.targetDate) else { return false }
        let today = calendar.dateComponents([.year, .month, .day], from: now)
        guard let year = today.year, let month = today.month, let dayOfMonth = today.day else { return false }
        return day < (year, month, dayOfMonth)
    }

    /// Overview order: live goals first, late before on-time, soonest target
    /// first and undated last; then met, then dropped, newest change first.
    static func sorted(_ goals: [CrmGoal], now: Date = Date(), calendar: Calendar = .current) -> [CrmGoal] {
        goals.sorted { a, b in
            let rankA = rank(a.status), rankB = rank(b.status)
            if rankA != rankB { return rankA < rankB }
            if a.status == .open {
                let lateA = isLate(a, now: now, calendar: calendar), lateB = isLate(b, now: now, calendar: calendar)
                if lateA != lateB { return lateA }
                let dayA = WorkItems.civilDay(a.targetDate), dayB = WorkItems.civilDay(b.targetDate)
                switch (dayA, dayB) {
                case let (.some(x), .some(y)) where x != y: return x < y
                case (.some, .none): return true
                case (.none, .some): return false
                default: break
                }
                return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
            return (a.updatedAt ?? a.createdAt) > (b.updatedAt ?? b.createdAt)
        }
    }

    /// A status the contract does not name sorts after the three it does.
    private static func rank(_ status: GoalStatus) -> Int {
        switch status {
        case .open: 0
        case .met: 1
        case .dropped: 2
        default: 3
        }
    }
}

extension CrmGoal: Identifiable {}
extension CrmDecision: Identifiable {}

extension GoalStatus {
    /// The word a row shows beside a closed goal. An open goal shows none.
    var label: String {
        switch self {
        case .open: String(localized: "Open")
        case .met: String(localized: "Met")
        case .dropped: String(localized: "Dropped")
        default: rawValue
        }
    }
}

/// What the client sends to make or change a goal: the generated
/// `CrmGoalCreate` and `CrmGoalUpdate`. On an update, `.omit` leaves a field
/// alone and `.null` clears the date or the owner.
extension CrmGoalCreate {
    init(projectID: String, title: String, targetDate: String? = nil, owner: String? = nil) {
        self.init(projectID: projectID, title: title, targetDate: .ifSome(targetDate), owner: .ifSome(owner))
    }
}

/// The generated `CrmDecisionCreate`. `manual` when typed, `message` when
/// marked on a channel message; the Worker sets `agent` itself on the MCP path.
extension CrmDecisionCreate {
    init(subjectKind: String, subjectID: String, body: String, source: String = "manual", sourceRef: String? = nil, goalID: String? = nil) {
        self.init(
            subjectKind: CrmSubjectKind(rawValue: subjectKind),
            subjectID: subjectID,
            body: body,
            source: DecisionSource(rawValue: source),
            sourceRef: .ifSome(sourceRef),
            goalID: .ifSome(goalID)
        )
    }
}
