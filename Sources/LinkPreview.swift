import Foundation

/// What a pasted link turns into on a card.
///
/// The device never reads the linked page — the Worker does, and answers this.
/// Same rule, and the same reason, as the GitHub avatar proxy: a client
/// unfurling its own links would tell every site anybody pastes the address of
/// every participant who was in the room at the time, guests included, and the
/// guests did not paste anything. See
/// `services/control-plane/src/link-preview.ts`.
///
/// Every text field is nullable because most of the web supplies none of them.
/// A card with only a domain is still worth something — it says where the link
/// goes, which is the question a bare URL does not answer — but a card with
/// *only* a domain is not, because the URL beside it already said that. What
/// that means for drawing is `isWorthDrawing`.
///
/// The web mirror is `web/src/link-preview.tsx`; the wire shape is
/// `LinkPreview` in `packages/contracts`.
extension LinkPreview {
    var isWorthDrawing: Bool {
        title?.isEmpty == false || description?.isEmpty == false
    }

    /// The picture to draw, when there is one worth asking for.
    var image: URL? {
        guard let imageURL, !imageURL.isEmpty else { return nil }
        return URL(string: imageURL)
    }

    /// What the card calls itself: the publisher's own name where it gave one.
    var label: String {
        if let siteName, !siteName.isEmpty { return siteName }
        return domain
    }
}

/// The envelope the Worker answers with.
typealias LinkPreviewEnvelope = LinkPreviewResponse

extension ThreadMarkdown {
    /// The first link in a message, if it has one.
    ///
    /// Reuses the Markdown parser rather than running a second URL pattern over
    /// the text: that parser already decides what counts as a link here —
    /// including bare URLs and `www.` — and two answers to that question is one
    /// too many. The web does the same, in `firstPreviewableLink`.
    ///
    /// Only the first: a message that is a list of links should stay a list of
    /// links rather than become a wall of cards. Code blocks are skipped, and
    /// so is `http://`, which the Worker refuses — asking would only produce an
    /// error the reader cannot act on.
    static func firstPreviewableLink(in text: String) -> String? {
        for block in parse(text) {
            if case .code = block.kind { continue }
            for span in block.spans {
                if let link = span.link, link.hasPrefix("https://") { return link }
            }
        }
        return nil
    }
}
