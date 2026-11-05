import Foundation

/// The follow-up as a mail draft in the host's own mail app. The
/// web's `follow-up-mail.ts`. Starlings sends nothing. A mail link carries
/// about 2,000 characters; past that the body goes to the clipboard and the
/// link carries the recipients and the subject only.
enum FollowUpMail {
    static let linkMax = 1_900

    static func url(to: [String], subject: String, body: String?) -> URL? {
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = to.joined(separator: ",")
        components.queryItems = [URLQueryItem(name: "subject", value: subject)]
            + (body.map { [URLQueryItem(name: "body", value: $0)] } ?? [])
        return components.url
    }

    /// The link to open, and whether the body has to travel by clipboard.
    static func draft(to: [String], subject: String, body: String) -> (url: URL?, bodyOnClipboard: Bool) {
        if let full = url(to: to, subject: subject, body: body), full.absoluteString.count <= linkMax {
            return (full, false)
        }
        return (url(to: to, subject: subject, body: nil), true)
    }
}
