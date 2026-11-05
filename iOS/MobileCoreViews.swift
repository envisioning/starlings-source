import CoreCRMUI
import CoreKit
import EnvisioningUI
import SwiftUI

/// The page behind Browse's foot row, **Other records**: search, then one row
/// per table this account may list, each opening the registry-driven list and
/// detail. Not connected yet, it is one button. The page title names it; no
/// header.
struct MobileCoreSection: View {
    @EnvironmentObject private var core: CoreSession

    var body: some View {
        Section {
            if core.isLinked {
                NavigationLink {
                    MobileCoreSearchScreen()
                } label: {
                    WorkSidebarRow(
                        leading: .glyph(systemName: "magnifyingglass"),
                        title: String(localized: "Search records"),
                        subtitle: String(localized: "Any record, by name")
                    )
                }
                ForEach(core.entities) { contract in
                    NavigationLink {
                        MobileCoreEntityScreen(contract: contract)
                    } label: {
                        WorkSidebarRow(
                            leading: .glyph(systemName: SFSymbolResolver.resolve(contract.icon, fallback: "square.grid.2x2")),
                            title: contract.pluralLabel,
                            subtitle: core.countLabel(for: contract.id) ?? (contract.canUpdate ? String(localized: "Read and edit") : String(localized: "Read only"))
                        )
                    }
                }
                if core.entities.isEmpty && core.isLoading {
                    EnvisioningPlaceholderRows()
                }
                if let errorMessage = core.errorMessage {
                    StarlingsErrorNotice(message: errorMessage)
                }
            } else {
                Button {
                    Task { await core.link() }
                } label: {
                    if core.isLinking {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Label("Connect records", systemImage: "link")
                    }
                }
                .disabled(core.isLinking)
                if let errorMessage = core.errorMessage {
                    if core.needsCoreAccount {
                        Text(errorMessage).font(.footnote).foregroundStyle(.secondary)
                    } else {
                        StarlingsErrorNotice(message: errorMessage)
                    }
                }
            }
        }
    }
}

/// One entity's list, as Core draws it. The list owns its own search, sort,
/// filters and the push to a record's detail.
struct MobileCoreEntityScreen: View {
    let contract: CRMEntityContract
    @EnvironmentObject private var core: CoreSession
    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.meetToast) private var toast
    /// The generic fallback push for a related record that isn't a lead or
    /// project — those route into Work instead. See `CRMRelatedTarget.workSubject`.
    @State private var openedRelated: CRMRelatedTarget?

    var body: some View {
        EntityListView(
            contract: contract,
            allContracts: core.contracts,
            repository: core.repository,
            onToast: { toast($0) }
        )
        .navigationDestination(item: $openedRelated) { target in
            CRMRelatedTargetLoader(target: target, session: core, onToast: { toast($0) })
                .meetSurfaceBackground()
        }
        .environment(\.crmOpenRelated, CRMOpenRelatedAction { target in
            if let subject = target.workSubject {
                app.openWork(subject: subject, pane: .talk)
            } else {
                openedRelated = target
            }
        })
    }
}

/// Registry search across every entity. The Core view renders results and the
/// push to detail; this screen only supplies the field.
struct MobileCoreSearchScreen: View {
    @EnvironmentObject private var core: CoreSession
    @EnvironmentObject private var app: StarlingsAppModel
    @State private var query = ""
    @State private var openedRelated: CRMRelatedTarget?

    var body: some View {
        CRMGlobalSearchView(
            space: .crm,
            contracts: core.contracts,
            repository: core.repository,
            query: $query
        )
        // core-kit's lists draw the ladder themselves (`EnvisioningList`);
        // the ground here is for the overlay states around them.
        .meetSurfaceBackground()
        // core-kit's own empty state names the store; this one covers it.
        .overlay {
            if query.isEmpty {
                EnvisioningEmptyState(String(localized: "Search records"), systemImage: "magnifyingglass")
                    .background(EnvisioningSurface.canvas)
            }
        }
        .searchable(text: $query, prompt: String(localized: "Search"))
        .navigationDestination(item: $openedRelated) { target in
            CRMRelatedTargetLoader(target: target, session: core, onToast: { _ in })
                .meetSurfaceBackground()
        }
        .environment(\.crmOpenRelated, CRMOpenRelatedAction { target in
            if let subject = target.workSubject {
                app.openWork(subject: subject, pane: .talk)
            } else {
                openedRelated = target
            }
        })
    }
}

/// The Fields pane: the shared `SubjectFieldsView` over the phone's Worker
/// API. No Core token.
struct MobileSubjectFieldsView: View {
    let subject: CrmSubject
    @EnvironmentObject private var app: StarlingsAppModel
    @EnvironmentObject private var work: MobileMyWorkStore
    @Environment(\.meetToast) private var toast

    var body: some View {
        SubjectFieldsView(
            subject: subject,
            workModules: work.subjectState.workModules,
            load: { try await app.api.crmSubjectDetail(credentials: try credentials(), kind: subject.subjectKind, id: subject.id) },
            save: { try await app.api.updateCrmSubject(credentials: try credentials(), kind: subject.subjectKind, id: subject.id, update: $0) },
            onSaved: { _ in },
            onToast: { toast($0) }
        )
        .meetSurfaceBackground()
        .meetToggleTint()
        .id(subject.id)
    }

    private func credentials() throws -> MobileOwnerCredentials {
        guard let owner = app.ownerCredentials else {
            throw StarlingsError.local(String(localized: "Sign in to Starlings to edit these fields."))
        }
        return owner
    }
}

/// Settings → Other records: what this device holds, and the two things to
/// do about it.
struct MobileCoreSettingsSection: View {
    @EnvironmentObject private var core: CoreSession

    var body: some View {
        Section {
            if let credential = core.credential {
                LabeledContent("Account", value: credential.email)
                if let expiry = credential.expiryDate {
                    LabeledContent("Expires", value: StarlingsDateFormatting.date(expiry))
                }
                Button("Reconnect") { Task { await core.link() } }
                    .disabled(core.isLinking)
                Button("Disconnect", role: .destructive) { Task { await core.unlink() } }
                    .disabled(core.isLinking)
            } else {
                Button {
                    Task { await core.link() }
                } label: {
                    if core.isLinking {
                        ProgressView()
                    } else {
                        Text("Connect records")
                    }
                }
                .disabled(core.isLinking)
            }
            if let errorMessage = core.errorMessage {
                if core.needsCoreAccount {
                    Text(errorMessage).font(.footnote).foregroundStyle(.secondary)
                } else {
                    StarlingsErrorNotice(message: errorMessage)
                }
            }
        } header: {
            Text("Other records")
        } footer: {
            Text("Lets this device read and edit records with no subject page.")
        }
    }
}

/// One Core entity by contract id, from Search (#222). The registry may
/// still be loading when Work is first built for this push, so the door
/// waits on it rather than answering "not here" to a list that has not
/// arrived; an id the registry does not list is said plainly.
struct MobileCoreEntityDoor: View {
    let id: String
    @EnvironmentObject private var core: CoreSession

    var body: some View {
        if let contract = core.entities.first(where: { $0.id == id }) {
            MobileCoreEntityScreen(contract: contract)
        } else if !core.isLinked {
            StarlingsList { MobileCoreSection() }
                .navigationTitle("Other records")
        } else if core.isLoading && core.contracts.isEmpty {
            StarlingsList { Section { EnvisioningPlaceholderRows() } }
                .navigationTitle("Other records")
        } else {
            StarlingsList {
                Section {
                    StarlingsErrorNotice(message: core.errorMessage ?? String(localized: "This account can’t see that."))
                }
            }
            .navigationTitle("Other records")
        }
    }
}
