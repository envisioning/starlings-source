import Foundation

/// What Work's Browse offers for each group of subjects, decided once in
/// `packages/contracts/src/browse-groups.ts`. The table is generated from it
/// (`pnpm registries:gen`); `fixtures/browse-groups.json` is generated too and
/// pins it (`BrowseGroupsFixtureTests`).
///
/// Which group has a status filter and a sort, which starts folded, which needs
/// Sales on, and the key its saved choices live under. Titles stay with each client.
struct BrowseGroupSpec: Equatable, Sendable {
    /// The lists a status filter and a sort belong to. Envisioning's projects and
    /// the clients' are two lists of one kind.
    enum List: String, Sendable {
        case envisioning
        case project
        case lead
    }

    let subjectKind: MeetingCategoryKind.SubjectKind
    /// Nil when the group has neither a status filter nor a sort (partners and events).
    let list: List?
    /// Folded until the person opens it.
    let startsCollapsed: Bool
    /// Only while the person has Sales on.
    let needsSales: Bool
    /// The key the group's folds and choices are saved under.
    let preferenceKey: String

    /// The status words the group's filter offers; empty when it has none.
    var statusFilter: SubjectStatusChoices? {
        switch list {
        case .envisioning, .project: SubjectStatusRegistry.project
        case .lead: SubjectStatusRegistry.lead
        case nil: nil
        }
    }
}

/// A record group beside the subjects on Browse: `BROWSE_RECORD_GROUPS`.
struct BrowseRecordGroupSpec: Equatable, Sendable {
    let startsCollapsed: Bool
    let preferenceKey: String
}

enum BrowseRecordGroupRegistry {}

enum BrowseGroupRegistry {
    // `order` and `specs` are the table: Sources/Generated/BrowseGroupsRegistry.swift.

    static func spec(for group: SubjectGroup) -> BrowseGroupSpec {
        guard let spec = specs[group] else {
            preconditionFailure("\(group.rawValue) has no row in browse-groups.ts; run pnpm registries:gen")
        }
        return spec
    }

    /// Whether Browse draws a group: every group, except the Sales one while the person has Sales off.
    static func isShown(_ group: SubjectGroup, salesEnabled: Bool) -> Bool {
        !spec(for: group).needsSales || salesEnabled
    }

    /// The same, and only while the work module that gates the group's kind
    /// is on (docs/WORK_MODEL.md). Nil work modules, from an older Worker,
    /// read as every one on.
    static func isShown(_ group: SubjectGroup, salesEnabled: Bool, workModules: [WorkModule]?) -> Bool {
        guard isShown(group, salesEnabled: salesEnabled) else { return false }
        return isWorkModuleOn(for: group, workModules: workModules)
    }

    /// True when the group's kind is on for this workspace and this person:
    /// its work module is on, and the person does not hide the kind
    ///. The Sales group keeps its own switch (`isShown`).
    static func isKindShown(_ group: SubjectGroup, state: SubjectStateResponse) -> Bool {
        guard isWorkModuleOn(for: group, workModules: state.workModules) else { return false }
        return group == .sales || !state.resolvedHiddenKinds.contains(spec(for: group).subjectKind.rawValue)
    }

    /// True when the group's kind is in the base, or its work module is on.
    static func isWorkModuleOn(for group: SubjectGroup, workModules: [WorkModule]?) -> Bool {
        guard let module = WorkModule.gating(spec(for: group).subjectKind), let workModules else { return true }
        return workModules.contains(module)
    }
}
