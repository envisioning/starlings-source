import XCTest
@testable import Starlings

final class MobileThreadRepliesTests: XCTestCase {
    func testReplyAddressIsLimitedToSubjectTalk() {
        let supported: [ThreadKind] = [.project, .lead, .organization, .event]
        for kind in supported {
            let address = ThreadAddress(
                target: .subject(kind: kind, id: "subject"),
                title: "Talk",
                prompt: "Message",
                emptyLine: "Nothing here yet.",
                subtitle: nil
            )
            XCTAssertTrue(address.supportsMessageReplies, "Subject Talk should allow message replies")
        }

        XCTAssertFalse(ThreadAddress.team.supportsMessageReplies)
        let peer = ThreadAddress(
            target: .peer(email: "ada@example.com"),
            title: "Ada",
            prompt: "Message Ada",
            emptyLine: "Nothing here yet.",
            subtitle: nil
        )
        XCTAssertFalse(peer.supportsMessageReplies)
    }
}
