import CoreCRMUI
import CoreKit
import EnvisioningUI
import SwiftUI

/// The page behind Browse's foot row: registry search, then one row per table this account may list. Not connected yet, it is one
/// button. Each choice replaces this page in the Work window's middle column.
struct MacOtherRecordsRoot: View {
    @ObservedObject var session: CoreSession
    let onSearch: () -> Void
    let onEntity: (CRMEntityContract) -> Void

    var body: some View {
        EnvisioningList {
            Section {
                if session.isLinked {
                    row(String(localized: "Search records"), symbol: "magnifyingglass", action: onSearch)
                    ForEach(session.entities) { contract in
                        row(
                            contract.pluralLabel,
                            symbol: SFSymbolResolver.resolve(contract.icon, fallback: "square.grid.2x2")
                        ) { onEntity(contract) }
                    }
                    if session.entities.isEmpty && session.isLoading {
                        EnvisioningPlaceholderRows()
                    }
                } else {
                    Button(String(localized: "Connect records")) { Task { await session.link() } }
                        .buttonStyle(EnvisioningBorderedButtonStyle())
                        .disabled(session.isLinking)
                }
                if let errorMessage = session.errorMessage {
                    StarlingsErrorNotice(message: errorMessage)
                }
            }
        }
    }

    private func row(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The SwiftUI the Work window hosts for Other records: one table's list,
/// registry search, and a subject's Fields. Each sits in its
/// own `NavigationStack` because these screens push their detail themselves;
/// the AppKit column only shows or hides the host.
struct MacCoreEntityRoot: View {
    let contract: CRMEntityContract
    @ObservedObject var session: CoreSession
    let onToast: (String) -> Void
    /// A related record that names a lead or project routes here instead of
    /// the generic detail push below — those already have doors of their
    /// own (docs/CORE_REGISTRY.md).
    let onOpenWorkSubject: (CrmSubject) -> Void

    @State private var openedRelated: CRMRelatedTarget?

    var body: some View {
        NavigationStack {
            EntityListView(
                contract: contract,
                allContracts: session.contracts,
                repository: session.repository,
                onToast: onToast
            )
            .navigationDestination(item: $openedRelated) { target in
                CRMRelatedTargetLoader(target: target, session: session, onToast: onToast)
            }
        }
        .environment(\.crmOpenRelated, CRMOpenRelatedAction { target in
            if let subject = target.workSubject {
                onOpenWorkSubject(subject)
            } else {
                openedRelated = target
            }
        })
        // `WorkWindowController` reassigns `coreHost.rootView` to a "new"
        // `MacCoreEntityRoot` on every entity switch, but SwiftUI keys a
        // hosted view's identity on its *type*, not its property values — so
        // without an explicit id, `openedRelated` (and the navigation push it
        // drives) silently survives across entities, leaving a stale related
        // record's screen on top no matter what gets picked next. Keying on
        // `contract.id` forces a real identity change, which resets it.
        .id(contract.id)
    }
}

struct MacCoreSearchRoot: View {
    @ObservedObject var session: CoreSession
    let onOpenWorkSubject: (CrmSubject) -> Void
    @State private var query = ""
    @State private var openedRelated: CRMRelatedTarget?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Registry search lives in this column, on the same AppKit
                // field as the rest of the Mac surface.
                MacHostedSearchField(placeholder: String(localized: "Search"), query: $query)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                CRMGlobalSearchView(
                    space: .crm,
                    contracts: session.contracts,
                    repository: session.repository,
                    query: $query
                )
                // core-kit's own empty state names the store; this one covers it.
                .overlay {
                    if query.isEmpty {
                        EnvisioningEmptyState(String(localized: "Search records"), systemImage: "magnifyingglass")
                            .background(EnvisioningSurface.canvas)
                    }
                }
            }
            .navigationDestination(item: $openedRelated) { target in
                CRMRelatedTargetLoader(target: target, session: session, onToast: { _ in })
            }
        }
        .environment(\.crmOpenRelated, CRMOpenRelatedAction { target in
            if let subject = target.workSubject {
                onOpenWorkSubject(subject)
            } else {
                openedRelated = target
            }
        })
    }
}

/// Bridges the shared AppKit search field into a SwiftUI host. Keeping the
/// control here prevents Core's and Docs' one search entry point each from
/// drifting into a second bezel, font, focus ring, and text alignment.
struct MacHostedSearchField: NSViewRepresentable {
    let placeholder: String
    @Binding var query: String

    func makeCoordinator() -> Coordinator {
        Coordinator(query: $query)
    }

    func makeNSView(context: Context) -> StarlingsSearchField {
        let field = StarlingsSearchField()
        field.configure(
            placeholder: placeholder,
            target: context.coordinator,
            action: #selector(Coordinator.searchChanged(_:))
        )
        return field
    }

    func updateNSView(_ nsView: StarlingsSearchField, context: Context) {
        if nsView.stringValue != query {
            nsView.stringValue = query
        }
    }

    final class Coordinator: NSObject {
        private var query: Binding<String>

        init(query: Binding<String>) {
            self.query = query
        }

        @MainActor @objc func searchChanged(_ sender: NSSearchField) {
            query.wrappedValue = sender.stringValue
        }
    }
}

/// The Mac's Fields pane: the shared `SubjectFieldsView` over this Mac's
/// Worker API. No Core token.
struct MacSubjectFieldsRoot: View {
    let subject: CrmSubject
    let workModules: [WorkModule]?
    let api: MeetingControlAPI
    let onToast: (String) -> Void
    let onSaved: (CrmSubjectDetail) -> Void

    var body: some View {
        SubjectFieldsView(
            subject: subject,
            workModules: workModules,
            load: { try await api.crmSubjectDetail(kind: subject.subjectKind, id: subject.id) },
            save: { try await api.updateCrmSubject(kind: subject.subjectKind, id: subject.id, update: $0) },
            onSaved: onSaved,
            onToast: onToast
        )
        // `loadFields()` hands a new root per subject; a new identity drops
        // the last subject's draft rather than showing it under this one.
        .id(subject.id)
    }
}
