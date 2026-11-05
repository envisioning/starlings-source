import EnvisioningUI
import SwiftUI

/// One relation on a subject — an organization, a contact — on the phone.
///
/// Typeahead, never a directory. There are a few hundred organizations and
/// over a thousand contacts; a `Picker` over either is a wall of names on a
/// screen this size. Nothing is listed until you type, and what comes back is
/// Core's ranked answer.
///
/// The Mac twin is `RelationPickerView`. Same two fields, same search, same
/// rule about an id it cannot name: drawn as itself rather than dropped, so
/// saving never quietly unlinks somebody.
struct MobileRelationPicker: View {
    let placeholder: String
    /// Said when a search really found nothing, never for an error.
    var emptyText: String = String(localized: "No matches")
    let allowsMultiple: Bool
    /// Core's ranked search. Nil when Core is not linked, which draws the
    /// reason instead of a dead field.
    let search: ((String) async throws -> [SubjectRelationOption])?
    /// Create a missing organization in Core and choose it immediately.
    var create: ((String) async throws -> SubjectRelationOption)? = nil
    @Binding var selected: [SubjectRelationOption]

    @State private var query = ""
    @State private var hits: [SubjectRelationOption] = []
    /// The query `hits` answer. Create is offered only once the typed name has been searched.
    @State private var searchedQuery = ""
    @State private var isSearching = false
    @State private var failed = false
    /// What the last failed search said, so the notice and Copy carry it.
    @State private var failureMessage = ""
    @State private var isCreating = false
    @State private var creationError: String?

    var body: some View {
        Group {
            ForEach(selected) { option in
                HStack(spacing: 8) {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.tint)
                    Text(option.name)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Button {
                        selected.removeAll { $0.id == option.id }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.meetPlain)
                    .accessibilityLabel(String(localized: "Remove \(option.name)"))
                }
            }

            if search == nil {
                Text("Sign in first")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 8) {
                    TextField(placeholder, text: $query)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                    if isSearching { ProgressView().controlSize(.small) }
                }
            }

            ForEach(offered) { option in
                Button {
                    choose(option)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus.circle")
                            .foregroundStyle(.secondary)
                        Text(option.name).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
                .buttonStyle(.meetPlain)
            }

            if canCreateOrganization {
                Button {
                    Task { await createOrganization() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus.circle")
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Create organization")
                                .font(.callout.weight(.medium))
                            Text(query.trimmingCharacters(in: .whitespacesAndNewlines))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if isCreating { ProgressView().controlSize(.small) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .meetHoverLift(cornerRadius: EnvisioningRadius.control)
                .disabled(isCreating)
            }

            if isSearching && hits.isEmpty {
                Text("Searching…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if failed {
                StarlingsErrorNotice(message: failureMessage)
                Button("Copy") { UIPasteboard.general.string = failureMessage }
                    .font(.footnote)
            } else if showsEmpty {
                Text(emptyText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let creationError {
                StarlingsErrorNotice(message: creationError)
            }
        }
        // Re-runs on every keystroke; the previous one is cancelled, so the
        // sleep below collapses a name typed at speed into one request.
        .task(id: query) { await runSearch() }
    }

    private var offered: [SubjectRelationOption] {
        let taken = Set(selected.map(\.id))
        return hits.filter { !taken.contains($0.id) }.prefix(8).map { $0 }
    }

    /// A real empty answer for what is typed now: searched, not failed, no hits.
    private var showsEmpty: Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return search != nil && trimmed.count >= 2 && !isSearching && !failed
            && searchedQuery == trimmed && hits.isEmpty
    }

    private var canCreateOrganization: Bool {
        let folded = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard create != nil, folded.count >= 2, !isSearching, !failed,
              fold(searchedQuery) == folded else { return false }
        return !hits.contains { fold($0.name) == folded }
    }

    private func choose(_ option: SubjectRelationOption) {
        if allowsMultiple {
            guard !selected.contains(where: { $0.id == option.id }) else { return }
            selected.append(option)
        } else {
            selected = [option]
        }
        query = ""
        hits = []
        creationError = nil
    }

    private func createOrganization() async {
        guard let create else { return }
        let name = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.count >= 2 else { return }
        isCreating = true
        creationError = nil
        defer { isCreating = false }
        do {
            let organization = try await create(name)
            selected = [organization]
            query = ""
            hits = []
        } catch {
            creationError = error.localizedDescription
        }
    }

    private func runSearch() async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, let search else {
            hits = []
            failed = false
            isSearching = false
            return
        }
        do {
            try await Task.sleep(nanoseconds: 250_000_000)
            try Task.checkCancellation()
            isSearching = true
            failed = false
            defer { isSearching = false }
            let found = try await search(trimmed)
            try Task.checkCancellation()
            hits = found
            searchedQuery = trimmed
            failed = false
        } catch is CancellationError {
            return
        } catch {
            hits = []
            failureMessage = String(localized: "Couldn’t search: \(error.localizedDescription)")
            failed = true
        }
    }

    private func fold(_ value: String) -> String {
        value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
    }
}
