import Contacts
import Foundation

struct MobileContactSuggestion: Identifiable, Equatable, Sendable {
    let name: String
    let email: String
    var id: String { email.lowercased() }
}

@MainActor
final class MobileContacts {
    private let store = CNContactStore()

    func load() async -> [MobileContactSuggestion] {
        do {
            let allowed = try await store.requestAccess(for: .contacts)
            guard allowed else { return [] }
            let keys: [CNKeyDescriptor] = [
                CNContactGivenNameKey as CNKeyDescriptor,
                CNContactFamilyNameKey as CNKeyDescriptor,
                CNContactOrganizationNameKey as CNKeyDescriptor,
                CNContactEmailAddressesKey as CNKeyDescriptor,
            ]
            let request = CNContactFetchRequest(keysToFetch: keys)
            var results: [MobileContactSuggestion] = []
            try store.enumerateContacts(with: request) { contact, _ in
                let person = [contact.givenName, contact.familyName]
                    .filter { !$0.isEmpty }
                    .joined(separator: " ")
                let name = person.isEmpty ? contact.organizationName : person
                for address in contact.emailAddresses {
                    let email = String(address.value).lowercased()
                    guard email.contains("@") else { continue }
                    results.append(MobileContactSuggestion(name: name, email: email))
                }
            }
            return Array(Dictionary(grouping: results, by: \.id).compactMap(\.value.first))
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch {
            return []
        }
    }
}
