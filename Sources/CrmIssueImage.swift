import Foundation
import UniformTypeIdentifiers

/// A picture attached to a GitHub issue.
///
/// GitHub has no public API for attaching a file to an issue — the drag-and-drop
/// on github.com posts to an endpoint the REST API does not expose — so Meet
/// keeps the bytes and the issue body carries a markdown image link. The
/// address is readable without a session, because github.com renders an issue
/// body for whoever is looking at it. `services/control-plane/src/issue-images.ts`
/// holds the reasoning and the mirror of these limits.
enum CrmIssueImage {
    /// A screenshot is a fraction of this (`ISSUE_IMAGE_MAX_BYTES`), and
    /// deliberately below the thread attachment ceiling: an issue picture is
    /// evidence, not a video.
    static let maxBytes = ContractConstants.issueImageMaxBytes

    /// What the Worker will vouch for. It sniffs the bytes rather than trusting
    /// this header, so a wrong guess here is refused rather than stored — but
    /// sending the right one saves a round trip.
    static let allowedTypes: [UTType] = [.png, .jpeg, .webP]

    /// The type to send for a file being uploaded.
    ///
    /// Read from the file's own extension rather than guessed at: the Worker
    /// checks the magic bytes anyway, so the only thing a wrong answer here
    /// costs is a refusal the person cannot act on. PNG is the fallback because
    /// it is what a screenshot is, and a screenshot is what this is for.
    static func contentType(for url: URL) -> String {
        let type = UTType(filenameExtension: url.pathExtension.lowercased())
        guard let type, allowedTypes.contains(type) else { return UTType.png.preferredMIMEType ?? "image/png" }
        return type.preferredMIMEType ?? "image/png"
    }

    /// The line that goes into the issue body.
    ///
    /// The filename becomes the alt text, because it is the only description
    /// anybody has given the picture and an image with none is one a screen
    /// reader announces as "image". Brackets come out of it: they are the two
    /// characters that would end the alt text early and leave the rest of the
    /// name loose in the body.
    static func markdown(name: String, url: String) -> String {
        let alt = name
            .replacingOccurrences(of: "[", with: "")
            .replacingOccurrences(of: "]", with: "")
        return "![\(alt)](\(url))"
    }

    /// Put the link at the end of a body, with a blank line before it when
    /// there is already something there.
    static func appending(_ markdown: String, to body: String) -> String {
        body.isEmpty ? markdown : body + "\n\n" + markdown
    }
}

/// Where a picture ended up. `url` is absolute because it is going into a body
/// that another site renders — a path would resolve against github.com.
///
/// Declared here rather than beside the Mac's API client because the phone
/// uploads too, and `MeetingControlAPI.swift` is not in the iOS target.
typealias IssueImageAnswer = IssueImageResponse
