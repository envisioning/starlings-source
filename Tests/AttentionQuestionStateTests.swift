import XCTest
@testable import Starlings

@MainActor
final class AttentionQuestionStateTests: XCTestCase {
    private func request(state: AttentionState = .open, revision: Int = 1, mode: AttentionSelectionMode = .multiple) -> AttentionRequest {
        AttentionRequest(id: "question:thread:message", kind: .question, state: state, revision: revision,
            origin: .thread(AttentionThreadOrigin(threadID: "thread", messageID: "message")),
            recipientEmail: "ada@example.invalid", askedByEmail: "agent@example.invalid", askedBy: "Research agent",
            prompt: "Which sources?", context: "Project briefing", options: [AttentionOption(id: "a", label: "First"), AttentionOption(id: "b", label: "Second")],
            selectionMode: mode, allowsCustomAnswer: false, links: [], createdAt: "2026-10-04T10:00:00Z")
    }

    func testOpenDraftSurvivesPollAndTerminalWinnerRejectsStaleRead() async {
        let state = AttentionQuestionState(request())
        await state.refresh(read: { self.request() })
        state.toggle("b")
        await state.refresh(read: { self.request() })
        XCTAssertEqual(state.selected, ["b"])
        state.adopt(request(state: .dismissed, revision: 2))
        XCTAssertTrue(state.selected.isEmpty)
        await state.refresh(read: { self.request() })
        XCTAssertEqual(state.request.state, .dismissed)
        XCTAssertFalse(state.canAnswer(as: "ada@example.invalid"))
    }

    func testInitialAndFailedPermissionReadNeverEnableAnswers() async {
        let state = AttentionQuestionState(request())
        XCTAssertFalse(state.canAnswer(as: "ada@example.invalid"))
        await state.refresh(read: { self.request() })
        XCTAssertTrue(state.canAnswer(as: "ADA@example.invalid"))
        XCTAssertFalse(state.canAnswer(as: "other@example.invalid"))
        await state.refresh(read: { throw URLError(.userAuthenticationRequired) })
        XCTAssertFalse(state.canAnswer(as: "ada@example.invalid"))
        var sent = false
        state.toggle("a")
        await state.resolve(action: .answer, email: "ada@example.invalid", send: { _ in
            sent = true; return AttentionResolveResponse(request: self.request(), accepted: true)
        })
        XCTAssertFalse(sent)
    }

    func testResolveUsesOptionOrderAndDisplaysCompetingDismissal() async {
        let state = AttentionQuestionState(request())
        await state.refresh(read: { self.request() })
        state.toggle("b"); state.toggle("a")
        await state.resolve(action: .answer, email: "ada@example.invalid", send: { command in
            XCTAssertEqual(command.optionIDs, ["a", "b"])
            return AttentionResolveResponse(request: self.request(state: .dismissed, revision: 2), accepted: false)
        })
        XCTAssertEqual(state.request.state, .dismissed)
        XCTAssertEqual(state.request.terminalLabel, "Dismissed")
        XCTAssertTrue(state.selected.isEmpty)
        XCTAssertFalse(state.busy)
    }

    func testExplicitDismissDoesNotInventAnAnswer() async {
        let state = AttentionQuestionState(request())
        await state.refresh(read: { self.request() })
        state.toggle("a")
        await state.resolve(action: .dismiss, email: "ada@example.invalid", send: { command in
            XCTAssertEqual(command.action, .dismiss)
            XCTAssertEqual(command.optionIDs, [])
            return AttentionResolveResponse(request: self.request(state: .dismissed, revision: 2), accepted: true)
        })
        XCTAssertNil(state.request.answer)
        XCTAssertEqual(state.request.state, .dismissed)
    }

    func testQuestionInboxProjectionAndPartialQueueRetention() {
        let question = WorkInboxItem.question(request(), key: request().id, at: 1)
        XCTAssertTrue(question.glanceDetail.contains("Research agent"))
        XCTAssertEqual(question.filterSource, .question)
        XCTAssertFalse(question.notifiesLocally)
        for client in [WorkActionClient.mac, .ios] {
            XCTAssertEqual(question.rowActions(client: client).flatMap { $0 }.map(\.title), ["Open question"])
        }
        let previous = WorkInboxResponse(items: [question], recent: [], partial: [], recentPartial: [])
        let partial = WorkInboxResponse(items: [], recent: [], partial: ["question"], recentPartial: [])
        XCTAssertEqual(partial.retainingQuestions(from: previous).items.map(\.id), [request().id])
        XCTAssertTrue(WorkInboxResponse.empty.retainingQuestions(from: previous).items.isEmpty)
    }
}
