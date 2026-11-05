import DocsKit
import Foundation

/// The rows a client writes into `SearchRecents` when a thing is opened by
/// hand — a subject from Work, a conversation from Team, a document from
/// Docs — so Home's Quick Access module and the ⌘K palette hold one list. Each
/// mirrors the Worker's builder in `search.ts` (`subjectRow`, `threadRow`,
/// `documentRow`): the same title and subtitle, so a row opened from a list
/// and the same row opened from the palette are one entry, not two.
extension SearchRow {
    /// Nil for a kind the door grammar has no word for.
    static func subject(_ subject: CrmSubject) -> SearchRow? {
        guard let kind = SearchSubjectKind(rawValue: subject.kind) else { return nil }
        let word = subject.kind.prefix(1).uppercased() + subject.kind.dropFirst()
        let subtitle = subject.subtitle.map { "\(word) · \($0)" } ?? word
        let image = subject.organizationLogoURL?.trimmingCharacters(in: .whitespaces)
        return SearchRow(
            kind: .subject, id: subject.id, title: subject.title, subtitle: subtitle,
            door: .subject(kind, id: subject.id), image: image.flatMap { $0.isEmpty ? nil : $0 }
        )
    }

    /// A DM with one other peer is that peer's row (`person:<email>` or
    /// `agent:<email>`), the same row the roster gives: one face, one entry
    /// in the recents, one door. A subject's channel is that subject's row: the conversation
    /// pane is one of the subject's panes, so opening it after the subject
    /// is one entry too, not a folder tile beside a bubble tile with the
    /// same name. A group or the team room is a thread. Recents only —
    /// the Worker's search keeps the channel as its own door
    /// (`threadSearchRow` in search-rows.ts; `threadRecentRow` is this).
    static func thread(_ thread: ThreadSummary) -> SearchRow {
        if let subject = thread.subject, let row = SearchRow.subject(subject) {
            return row
        }
        if thread.kind == .dm {
            let only: (email: String, name: String?, isAgent: Bool)? = if thread.peers.count == 1, let peer = thread.peers.first {
                (peer.email, peer.name, peer.kind?.rawValue == "agent")
            } else if thread.peers.isEmpty, let email = thread.peerEmail {
                (email, thread.peerName, false)
            } else {
                nil
            }
            if let only {
                let name = only.name?.trimmingCharacters(in: .whitespaces) ?? ""
                return SearchRow(
                    kind: only.isAgent ? .agent : .person,
                    id: only.email,
                    title: name.isEmpty ? only.email : name,
                    subtitle: only.isAgent ? String(localized: "Agent") : only.email,
                    door: only.isAgent ? .agent(id: only.email) : .person(id: only.email)
                )
            }
        }
        let subtitle: String = switch thread.kind {
        case .dm: thread.peers.count > 1 ? String(localized: "Group") : String(localized: "Direct message")
        case .team: String(localized: "Team Room")
        default: String(localized: "Channel")
        }
        return SearchRow(kind: .thread, id: thread.id, title: thread.title, subtitle: subtitle, door: .thread(id: thread.id))
    }

    static func document(_ document: DocsDocumentSummary) -> SearchRow {
        let source = document.sourceSystem.prefix(1).uppercased() + document.sourceSystem.dropFirst()
        return SearchRow.document(id: document.id, title: document.title, subtitle: document.category?.fallbackLabel ?? source)
    }

    /// A document opened by id and title alone — the phone's editor, the
    /// web's reader — before its summary is read.
    static func document(id: String, title: String, subtitle: String = "Document") -> SearchRow {
        SearchRow(kind: .document, id: id, title: title, subtitle: subtitle, door: .document(id: id))
    }
}
