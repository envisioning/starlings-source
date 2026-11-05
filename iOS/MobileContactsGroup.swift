import EnvisioningUI
import SwiftUI

/// The Contacts group on Work's Browse: its fold key and what
/// makes the group read again. The rows and the menu are in `MobileWorkView`.
enum MobileContactsGroup {
    /// The fold key, as on the Mac and the web.
    static let key = "work.contacts"

    /// The group reads again when one of these changes.
    struct LoadKey: Equatable {
        let open: Bool
        let query: String
        let filter: ContactListFilter
        let revision: Int
    }
}

extension Notification.Name {
    /// A contact page saved, merged or deleted a contact.
    static let mobileContactsDidChange = Notification.Name("MobileContactsDidChange")
}

/// The Contacts group's Organization filter: a search over the
/// organization route, since a workspace has too many organizations to list.
struct MobileContactOrganizationFilterView: View {
    let filter: ContactListFilter
    let onChange: (ContactListFilter) -> Void

    @EnvironmentObject private var app: StarlingsAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var picked: [SubjectRelationOption]

    init(filter: ContactListFilter, onChange: @escaping (ContactListFilter) -> Void) {
        self.filter = filter
        self.onChange = onChange
        if let id = filter.organizationID {
            _picked = State(initialValue: [SubjectRelationOption(id: id, name: filter.organizationName ?? id)])
        } else {
            _picked = State(initialValue: [])
        }
    }

    var body: some View {
        NavigationStack {
            StarlingsForm {
                Section {
                    MobileRelationPicker(
                        placeholder: String(localized: "Search organizations"),
                        allowsMultiple: false,
                        search: search,
                        selected: $picked
                    )
                }
            }
            .navigationTitle(String(localized: "Organization"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    StarlingsSheetCloseButton { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done")) { apply() }
                        .meetToolbarConfirm()
                }
            }
        }
    }

    private var search: ((String) async throws -> [SubjectRelationOption])? {
        guard let credentials = app.ownerCredentials else { return nil }
        let api = app.api
        return { query in try await api.crmOrganizations(credentials: credentials, matching: query) }
    }

    /// No organization picked lists every contact again.
    private func apply() {
        var next = filter
        next.organizationID = picked.first?.id
        next.organizationName = picked.first?.name
        onChange(next)
        dismiss()
    }
}
