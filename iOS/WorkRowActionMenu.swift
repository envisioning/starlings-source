import SwiftUI

/// A row's context menu from its shared action list (`WorkRowAction`): one
/// button per action, a divider between groups. The Work tab and Home's
/// WORK card draw the same list; `perform` is each surface's own.
struct WorkRowActionMenu: View {
    let groups: [[WorkRowAction]]
    let perform: (WorkRowAction) -> Void

    var body: some View {
        let shown = groups.filter { !$0.isEmpty }
        ForEach(Array(shown.enumerated()), id: \.offset) { index, group in
            if index > 0 { Divider() }
            // Assign to ▸ or Move to ▸: one submenu of names, where the
            // group's first such item was.
            ForEach(group.filter { $0.submenu == nil || $0.isFirstOfSubmenu(in: group) }) { action in
                if let kind = action.submenu {
                    Menu {
                        ForEach(group.filter { $0.submenu == kind }) { member in
                            Button(member.title) { perform(member) }
                        }
                    } label: {
                        Label(kind.title, systemImage: kind.symbol.rawValue)
                    }
                } else {
                    Button(role: action.isDestructive ? .destructive : nil) {
                        perform(action)
                    } label: {
                        Label(action.title, systemImage: action.symbolName)
                    }
                }
            }
        }
    }
}

extension Array where Element == [WorkRowAction] {
    /// The row's Mark as read, when the registry offers it (an unread
    /// conversation). A swipe performs this same action.
    var markRead: WorkRowAction? {
        joined().first { if case .markRead = $0 { true } else { false } }
    }
}
