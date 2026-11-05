import DocsKit
import Foundation
import StarlingsContracts

/// The Docs routes, each named once for the Mac and the phone: a
/// saved link and its refetch, a resolved comment, and the Keep token,
/// which the same device-token broker hands out. `MeetingControlAPI` and
/// `StarlingsAPI` send them. A saved document comes back in Docs' own
/// shape, so each client reads it with DocsKit's decoder, not the wire one.
enum StarlingsDocsRoutes {
    /// A link save. The Worker reads the page with the reader
    /// behind every chat link card and files it in Docs with what it found;
    /// Docs never fetches a URL. The page and its picture are read inside the
    /// request, so it waits 30 s, and 90 s when it carries the page's HTML
    /// (the share extension's copy), which is megabytes on a phone's uplink.
    static func saveLink(_ create: DocsCreateDocumentRequest) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "POST", path: ["docs", "documents"], body: create,
            operation: String(localized: "Couldn’t save that link"),
            timeout: create.pageHtml == nil ? 30 : 90
        )
    }

    /// Read a saved link again, through the same reader: the title stays,
    /// the page's description, site and picture are replaced.
    static func refetchLink(documentID: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "POST", path: ["docs", "documents", documentID, "refetch"],
            operation: String(localized: "Couldn’t read that page again"),
            timeout: 30
        )
    }

    /// Close a comment thread on a document. The thread leaves
    /// INBOX with it.
    static func resolveComment(threadID: String) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "PATCH", path: ["docs", "annotations", threadID],
            body: DocsAnnotationUpdate(status: .resolved),
            operation: String(localized: "Couldn’t resolve that comment"),
            writes: [.commentResolve]
        )
    }

    /// A Keep device token for the signed-in owner, brokered by the Worker.
    static func keepToken(deviceName: String) -> StarlingsRoute<KeepToken> {
        StarlingsRoute(
            method: "POST", path: ["keep", "token"], body: KeepTokenRequest(deviceName: deviceName),
            operation: String(localized: "Couldn’t connect Keep")
        )
    }

    /// The subjects a saved link is filed on, in the request's shape.
    static func subjects(_ subjects: [DocsSubject]) -> [DocsCreateDocumentRequestSubjectsItem]? {
        subjects.isEmpty ? nil : subjects.map {
            DocsCreateDocumentRequestSubjectsItem(
                system: $0.system,
                kind: DocsCreateDocumentRequestSubjectsItemKind(rawValue: $0.kind),
                subjectID: $0.subjectId
            )
        }
    }
}
