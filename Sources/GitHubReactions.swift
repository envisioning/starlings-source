import Foundation

/// GitHub's reaction contents on an issue, as the Mac and the phone draw them:
/// one word and one SF Symbol each. A content GitHub adds later reads as its
/// own name with a smiling face, never blank.
enum GitHubReactions {
    static func label(for content: String) -> String {
        switch content {
        case "+1": String(localized: "Thumbs up")
        case "-1": String(localized: "Thumbs down")
        case "laugh": String(localized: "Laugh")
        case "hooray": String(localized: "Celebrate")
        case "confused": String(localized: "Confused")
        case "heart": String(localized: "Heart")
        case "rocket": String(localized: "Rocket")
        case "eyes": String(localized: "Eyes")
        default: content
        }
    }

    static func symbol(for content: String) -> String {
        switch content {
        case "+1": "hand.thumbsup"
        case "-1": "hand.thumbsdown"
        case "laugh": "face.smiling"
        case "hooray": "party.popper"
        case "confused": "questionmark.circle"
        case "heart": "heart"
        case "rocket": "paperplane"
        case "eyes": "eye"
        default: "face.smiling"
        }
    }
}
