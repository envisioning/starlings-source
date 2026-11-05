import XCTest
@testable import Starlings

final class WorkspaceBackgroundTests: XCTestCase {
    func testEveryChoiceRoundTripsIncludingExplicitOff() {
        let choices: [MeetingBackgroundEffect] = [.none, .blur, .customImage, .workspaceImage] + BackgroundChoice.all.map { .generated($0) }
        for choice in choices {
            XCTAssertEqual(WorkspaceBackgrounds.decodeChoice(WorkspaceBackgrounds.encodeChoice(choice)), choice)
        }
        XCTAssertNil(WorkspaceBackgrounds.decodeChoice("generated:unknown:dark"))
    }

    func testPersonalChoicesWinOverWorkspaceDefault() throws {
        let profile = try JSONDecoder().decode(WorkspaceBackgroundProfile.self, from: Data(##"{"tones":{"dark":{"base":"#000000","modules":"#ffffff"},"accent":{"base":"#d6f249","modules":"#000000"},"bright":{"base":"#ffffff","modules":"#000000"}},"image_url":null,"default":{"mode":"generated","generator":"flock","tone":"dark"}}"##.utf8))
        XCTAssertEqual(WorkspaceBackgrounds.select(saved: nil, profile: profile), .generated(.init(generator: .flock, tone: .dark)))
        for choice in [MeetingBackgroundEffect.none, .blur, .customImage] {
            XCTAssertEqual(WorkspaceBackgrounds.select(saved: WorkspaceBackgrounds.encodeChoice(choice), profile: profile), choice)
        }
        XCTAssertEqual(WorkspaceBackgrounds.select(saved: nil, profile: nil), .none)
    }
}
