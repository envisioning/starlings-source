import DocsKit
import DocsUI
import EnvisioningUI
import SwiftUI

/// The SwiftUI the Work window hosts for Docs: a subject's Documents and
/// Search Docs. These are lists — the middle column
/// chooses, the inspector edits — so opening a document is a callback the
/// window answers by putting the editor in the third column, the way it
/// does for a task or an issue.

struct MacSubjectDocumentsRoot: View {
    let subject: CrmSubject
    @ObservedObject var session: DocsSession
    let onOpen: (DocsDocumentSummary) -> Void
    let onToast: (String) -> Void

    var body: some View {
        DocumentsPane(
            subject: subject.docsSubject ?? DocsSubject(kind: subject.kind, subjectId: subject.id),
            subjectSlug: DocsPaths.slug(subject.title),
            client: session.client,
            onOpen: onOpen,
            onToast: onToast
        )
    }
}

struct MacDocsSearchRoot: View {
    @ObservedObject var session: DocsSession
    let onOpen: (_ id: String, _ title: String) -> Void

    @State private var query: String

    /// `initialQuery` is what Work's rail was searching for when this
    /// column was opened from its tail, so the words are not typed twice.
    init(session: DocsSession, initialQuery: String = "", onOpen: @escaping (_ id: String, _ title: String) -> Void) {
        self.session = session
        self.onOpen = onOpen
        _query = State(initialValue: initialQuery)
    }
    @State private var hits: [DocsSearchHit] = []
    @State private var errorMessage: String?

    var body: some View {
            VStack(spacing: 0) {
                MacHostedSearchField(placeholder: String(localized: "Search"), query: $query)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                if let errorMessage {
                    EnvisioningRetryState(String(localized: "Search failed"), message: errorMessage) { Task { await search() } }
                } else if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    EnvisioningEmptyState("Search everything", systemImage: "magnifyingglass", message: String(localized: "Titles and full text, across every document."))
                } else if hits.isEmpty {
                    EnvisioningEmptyState("Nothing found", systemImage: "magnifyingglass", message: String(localized: "No document mentions “\(query)”."))
                } else {
                    DocumentList(documents: hits.map(\.summary)) { onOpen($0.id, $0.title) }
                }
            }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await search()
            }
    }

    private func search() async {
        do {
            hits = try await session.client.search(query)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

enum DocsPaths {
    /// A path segment from a subject's title: `Acme Corp.` → `acme-corp`.
    /// Only where a new document is filed; the subject link is the relation.
    /// One rule for every client: `DocsRailGroups.slug`.
    static func slug(_ title: String) -> String { DocsRailGroups.slug(title) }

    /// FTS5 snippets carry `<mark>`; a list row wants the words.
    static func plainSnippet(_ snippet: String) -> String {
        snippet.replacingOccurrences(of: "<mark>", with: "").replacingOccurrences(of: "</mark>", with: "")
    }
}

extension DocsSearchHit {
    /// A hit as a list row. Search returns less than a summary carries, so
    /// the gaps are filled with what a row never shows; the snippet becomes
    /// the excerpt.
    var summary: DocsDocumentSummary {
        DocsDocumentSummary(
            id: id, path: path, slug: String(path.split(separator: "/").last ?? ""), title: title,
            kind: kind, visibility: "internal", status: "active", sourceSystem: sourceSystem,
            sourceKind: sourceKind, sourceUrl: nil, editable: sourceSystem == "native", version: 1,
            byteSize: 0, contentHash: "", tags: [], category: nil, subjects: [], createdAt: updatedAt,
            updatedAt: updatedAt, updatedBy: nil, excerpt: DocsPaths.plainSnippet(snippet))
    }
}
