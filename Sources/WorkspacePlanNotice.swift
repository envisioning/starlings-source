import Foundation
import StarlingsContracts

/// What the Mac and the phone show at a plan limit.
///
/// The words are the registry's (`WorkspacePlanRules`, generated from
/// packages/contracts/src/workspace-plans.ts). This file decides which of them
/// a person reads, and whether the Upgrade button is there: an admin gets the
/// button, a member gets "Ask an admin to upgrade." Neither client changes the
/// plan or picks the kept project; web Admin and meetctl do.
///
/// Compiled into both the Mac and the iOS target.
enum WorkspacePlanNotice {
    /// The Worker refused a project create over the plan's project limit.
    static func isProjectLimit(_ serverCode: String?) -> Bool {
        serverCode == WorkspacePlanRules.projectLimitCode
    }

    /// The Worker refused a write to a project the plan holds read-only.
    static func isProjectFrozen(_ serverCode: String?) -> Bool {
        serverCode == WorkspacePlanRules.projectFrozenCode
    }

    /// The Worker's rule, read on the client: a plan with a project limit and
    /// a kept project holds every other project read-only.
    static func isFrozen(projectID: String, plan: WorkspacePlanResponse?) -> Bool {
        guard let plan, plan.projectLimit != nil, let kept = plan.keptProjectID else { return false }
        return projectID != kept
    }

    /// The limit line. A member also reads who can lift it.
    static func limitText(isAdmin: Bool) -> String {
        isAdmin ? WorkspacePlanRules.projectLimitText : "\(WorkspacePlanRules.projectLimitText) \(WorkspacePlanRules.askAdminText)"
    }

    /// The read-only line. A member also reads who can lift it.
    static func frozenText(isAdmin: Bool) -> String {
        isAdmin ? WorkspacePlanRules.projectFrozenText : "\(WorkspacePlanRules.projectFrozenText) \(WorkspacePlanRules.askAdminText)"
    }
}

extension SubjectStateResponse {
    /// The signed-in person is a workspace admin, as `GET /api/crm/subject-state`
    /// said. An unread state (`.unknown`) reads as a member.
    var isWorkspaceAdmin: Bool { role == "admin" }
}
