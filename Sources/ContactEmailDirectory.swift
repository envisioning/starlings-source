import Contacts
import Foundation

/// Local address-book emails for schedule-guest autocomplete. Never logs contact data.
enum ContactEmailDirectory {
    struct Entry: Equatable, Sendable {
        let name: String
        let email: String

        /// Autocomplete row, e.g. `Larissa Akemi <la@abc.de>`.
        var label: String {
            name.isEmpty ? email : "\(name) <\(email)>"
        }

        var chipTitle: String {
            name.isEmpty ? email : name
        }
    }

    static func authorizationStatus() -> CNAuthorizationStatus {
        CNContactStore.authorizationStatus(for: .contacts)
    }

    @MainActor
    static func requestAccessIfNeeded() async -> Bool {
        let store = CNContactStore()
        if hasAccess {
            return true
        }
        switch authorizationStatus() {
        case .denied, .restricted:
            return false
        case .notDetermined:
            do {
                return try await store.requestAccess(for: .contacts)
            } catch {
                return false
            }
        case .authorized:
            return true
        @unknown default:
            return hasAccess
        }
    }

    private static var hasAccess: Bool {
        authorizationStatus() == .authorized
    }

    static func loadEntries(limit: Int = 400) -> [Entry] {
        guard hasAccess else {
            return []
        }
        let store = CNContactStore()
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.sortOrder = .givenName
        var entries: [Entry] = []
        var seen = Set<String>()
        do {
            try store.enumerateContacts(with: request) { contact, stop in
                let name = displayName(for: contact)
                for value in contact.emailAddresses {
                    let email = (value.value as String)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                        .lowercased()
                    guard email.contains("@"), !seen.contains(email) else { continue }
                    seen.insert(email)
                    entries.append(Entry(name: name, email: email))
                    if entries.count >= limit {
                        stop.pointee = true
                    }
                }
            }
        } catch {
            return []
        }
        return entries.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    static func suggestions(matching query: String, in entries: [Entry], limit: Int = 8) -> [Entry] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else {
            return Array(entries.prefix(limit))
        }
        return entries
            .filter {
                $0.email.localizedCaseInsensitiveContains(needle)
                    || $0.name.localizedCaseInsensitiveContains(needle)
            }
            .prefix(limit)
            .map { $0 }
    }

    /// `email.lowercased → display name` for calendar guest rows. Empty when Contacts access is off.
    static func displayNameByEmail(limit: Int = 400) -> [String: String] {
        var map: [String: String] = [:]
        for entry in loadEntries(limit: limit) {
            let name = entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, map[entry.email] == nil else { continue }
            map[entry.email] = name
        }
        return map
    }

    private static func displayName(for contact: CNContact) -> String {
        let person = [contact.givenName, contact.familyName]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !person.isEmpty { return person }
        return contact.organizationName.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
