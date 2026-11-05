import SwiftUI

/// The event editor's invite list on iOS: one row per person with their
/// reply, and an Add invitee line that completes from the roster. The same
/// shape as the Mac's `CalendarInviteesEditorView` and the web's
/// `InviteesEditor` (the Fantastical shape), in place of chips.
///
/// `addresses` is what the save writes — everyone but you. `existing` is the
/// event's own list, kept for the reply marks and names; a row whose address
/// is not in it was added here and draws no reply badge.
struct MobileInviteesEditor: View {
    @Binding var addresses: [String]
    var existing: [CalendarAttendeeSummary] = []
    /// (email, name), asked at completion time — the roster, then contacts.
    var suggestions: () -> [(email: String, name: String)] = { [] }

    @EnvironmentObject private var team: MobileTeamStore
    @State private var draft = ""
    @FocusState private var isAdding: Bool

    private var you: CalendarAttendeeSummary? { existing.first(where: \.isSelf) }

    var body: some View {
        ForEach(addresses, id: \.self) { address in
            row(for: address)
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) { remove(address) } label: { Label("Remove", systemImage: "xmark") }
                }
        }
        if let you {
            HStack(spacing: 10) {
                MobileAttendeeAvatar(attendee: you, source: team.avatarSource)
                Text(you.name.isEmpty ? you.email : you.name)
                Text("you").foregroundStyle(.secondary)
            }
        }
        TextField("Add invitee", text: $draft)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.emailAddress)
            .focused($isAdding)
            .onSubmit { commit(draft) }
            .onChange(of: draft) { _, value in
                if value.contains(where: { $0 == "," || $0 == ";" }) { commit(value) }
            }
        if isAdding, !draft.trimmingCharacters(in: .whitespaces).isEmpty {
            ForEach(matches, id: \.email) { match in
                Button {
                    commit(match.email)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(match.name).foregroundStyle(.primary)
                        Text(match.email).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .buttonStyle(.meetPlain)
            }
        }
    }

    private var matches: [(email: String, name: String)] {
        let typed = draft.trimmingCharacters(in: .whitespaces).lowercased()
        guard !typed.isEmpty else { return [] }
        let taken = Set(addresses)
        return Array(
            suggestions()
                .filter { !taken.contains($0.email.lowercased()) && !($0.email.lowercased() == you?.email.lowercased()) }
                .filter { $0.email.lowercased().hasPrefix(typed) || $0.name.lowercased().split(separator: " ").contains { $0.hasPrefix(typed) } }
                .prefix(6)
        )
    }

    @ViewBuilder
    private func row(for address: String) -> some View {
        let known = existing.first { $0.email.lowercased() == address }
        let name = known.map { $0.name.isEmpty ? $0.email : $0.name }
            ?? suggestions().first { $0.email.lowercased() == address }?.name
            ?? address
        HStack(spacing: 10) {
            // The same face the cards draw: profile picture for a member,
            // initials otherwise, the reply on its corner.
            MobileAttendeeAvatar(
                name: name, email: address, status: known?.status,
                isMember: CalendarAttendeeSummary.isMemberAddress(address),
                source: team.avatarSource
            )
            Text(name)
                .lineLimit(1)
                .opacity(known?.status == "declined" ? 0.55 : 1)
            if name != address {
                Text(address).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button { remove(address) } label: {
                Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.meetPlain)
            .accessibilityLabel("Remove \(name)")
        }
    }

    private func remove(_ address: String) {
        addresses.removeAll { $0 == address }
    }

    private func commit(_ text: String) {
        let parts = text
            .split(whereSeparator: { $0 == "," || $0 == ";" || $0.isWhitespace })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        var rejected: [String] = []
        for part in parts {
            if part.contains("@"), part.contains(".") {
                if !addresses.contains(part), part != you?.email.lowercased() { addresses.append(part) }
            } else {
                rejected.append(part)
            }
        }
        draft = rejected.joined(separator: " ")
    }
}
