import XCTest
@testable import Starlings

final class WorkRowActionFixtureTests: XCTestCase {
    func testEveryKindContextActionAndClientMatchesTheFixture() throws {
        let table = try loadTable()
        XCTAssertEqual(table.version, 2)

        let contexts: [WorkRowKind: Set<String>] = [
            .task: Set(WorkTaskMenuContext.allCases.map(\.rawValue)),
            .issue: Set(WorkIssueMenuContext.allCases.map(\.rawValue)),
            .inboxTalk: Set(WorkInboxTalkMenuContext.allCases.map(\.rawValue)),
            .inboxSales: Set(WorkInboxSalesMenuContext.allCases.map(\.rawValue)),
            .inboxComment: Set(WorkInboxCommentMenuContext.allCases.map(\.rawValue)),
            .inboxFollowup: Set(WorkInboxFollowupMenuContext.allCases.map(\.rawValue)),
            .inboxCard: Set(WorkInboxCardMenuContext.allCases.map(\.rawValue)),
            .inboxBooking: Set(WorkInboxBookingMenuContext.allCases.map(\.rawValue)),
            .inboxInvitation: Set(WorkInboxInvitationMenuContext.allCases.map(\.rawValue)),
            .inboxForwarded: Set(WorkInboxForwardedMenuContext.allCases.map(\.rawValue)),
            .inboxInterest: Set(WorkInboxInterestMenuContext.allCases.map(\.rawValue)),
            .inboxCommercial: Set(WorkInboxCommercialMenuContext.allCases.map(\.rawValue)),
            .inboxQuestion: Set(WorkInboxQuestionMenuContext.allCases.map(\.rawValue)),
            .inboxDecision: Set(WorkInboxDecisionMenuContext.allCases.map(\.rawValue)),
            .quickNote: Set(WorkQuickNoteMenuContext.allCases.map(\.rawValue)),
            .subject: Set(WorkSubjectMenuContext.allCases.map(\.rawValue)),
            .goal: Set(WorkGoalMenuContext.allCases.map(\.rawValue)),
            .doc: Set(WorkDocMenuContext.allCases.map(\.rawValue)),
            .docRail: Set(WorkDocRailMenuContext.allCases.map(\.rawValue)),
            .boardCard: Set(WorkBoardCardMenuContext.allCases.map(\.rawValue)),
            .message: Set(WorkMessageMenuContext.allCases.map(\.rawValue)),
            .conversation: Set(WorkConversationMenuContext.allCases.map(\.rawValue)),
            .person: Set(WorkPersonMenuContext.allCases.map(\.rawValue)),
        ]

        XCTAssertEqual(Set(table.actions.keys), Set(WorkRowActionID.allCases.map(\.rawValue)))
        for action in WorkRowActionID.allCases {
            XCTAssertEqual(
                table.actions[action.rawValue]?.destructive,
                WorkRowActionRegistry.isDestructive(action),
                action.rawValue
            )
        }

        XCTAssertEqual(Set(table.contexts.keys), Set(WorkRowKind.allCases.map(\.rawValue)))
        XCTAssertEqual(Set(table.clients.keys), Set(WorkRowKind.allCases.map(\.rawValue)))
        for kind in WorkRowKind.allCases {
            let actualContexts = try XCTUnwrap(contexts[kind], kind.rawValue)
            let expectedGroups = try XCTUnwrap(table.contexts[kind.rawValue], kind.rawValue)
            XCTAssertEqual(Set(expectedGroups.keys), actualContexts, kind.rawValue)

            for context in actualContexts {
                let actual = WorkRowActionRegistry.canonicalGroups(kind: kind, context: context)
                    .map { $0.map(\.rawValue) }
                XCTAssertEqual(actual, expectedGroups[context], "\(kind.rawValue).\(context)")
            }

            let actualClients = WorkRowActionRegistry.clientAvailability(kind: kind)
            let expectedClients = try XCTUnwrap(table.clients[kind.rawValue], kind.rawValue)
            XCTAssertEqual(Set(actualClients.keys.map(\.rawValue)), Set(expectedClients.keys), kind.rawValue)
            for (action, availability) in actualClients {
                let expected = try XCTUnwrap(expectedClients[action.rawValue], "\(kind.rawValue).\(action.rawValue)")
                XCTAssertEqual(availability.mac, expected.mac, "\(kind.rawValue).\(action.rawValue).mac")
                XCTAssertEqual(availability.ios, expected.ios, "\(kind.rawValue).\(action.rawValue).ios")
                XCTAssertEqual(availability.web, expected.web, "\(kind.rawValue).\(action.rawValue).web")
            }
        }
    }

    func testFactsFilterActionsForEveryRowKind() {
        let cases: [(WorkRowKind, String, WorkActionClient, WorkRowActionFacts, [[WorkRowActionID]])] = [
            (.task, "mine", .mac, .init(["hasSubject": false, "hasCore": false, "canFileOnGitHub": false]), [[.complete, .cancel], [.openMine]]),
            (.issue, "row", .mac, .init(["isOpen": true, "hasRepo": true, "hasCore": true]), [[.open], [.closeIssue, .closeNotPlanned], [.openGithub], [.copyLink], [.openCore], [.star]]),
            (.inboxTalk, "row", .mac, .init(["hasSubject": false, "hasUnread": true, "hasCore": false]), [[.markRead, .mute]]),
            (.inboxSales, "row", .web, .init(["isDismissed": false, "hasEmail": true]), [[.startLead], [.dismiss, .copyEmail]]),
            (.inboxComment, "row", .web, .init(["hasSubject": false, "hasCore": false]), [[.openDocument], [.resolve]]),
            (.inboxCard, "row", .mac, .init(["isIssue": false]), [[.open], [.openSubject]]),
            (.inboxBooking, "row", .web, .init(["hasEvent": false, "hasEmail": true]), [[.copyEmail], [.dismiss]]),
            (.inboxInterest, "row", .web, .init(["hasEmail": true]), [[.copyEmail], [.dismiss]]),
            (.inboxInvitation, "row", .ios, .init(), [[.rsvp], [.openCalendar]]),
            (.inboxForwarded, "row", .mac, .init(), [[.accept, .decline]]),
            (.quickNote, "inbox", .mac, .init(["isEditable": false, "isOpen": true]), [[.fileNote], [.delete]]),
            (.subject, "row", .web, .init(["isProject": true, "isPartner": false, "isEvent": false, "hasRepo": false, "hasVault": false, "hasCore": false]), [[.star, .mute], [.open, .editDetails], [.openTasks, .newTask], [.linkRepository, .keepVault]]),
            (.subject, "organization", .mac, .init(["isPartner": true, "isEvent": false, "hasCore": true]), [[.star, .mute], [.open, .openTalk, .openHistory, .startRoom], [.openTasks, .newTask], [.openCore]]),
            (.goal, "row", .web, .init(["isOpen": false]), [[.reopen]]),
            (.doc, "row", .web, .init(["isSavedLink": true, "isEditable": false]), [[.open, .star], [.openPage, .copyPageLink]]),
            (.docRail, "folder", .web, .init(["isFolder": true]), [[.open, .copyLink], [.star]]),
            (.boardCard, "row", .mac, .init(["hasRepo": false, "hasSubject": false, "hasConversation": false, "canMoveStage": false, "hasAgents": false]), [[.open]]),
            (.message, "row", .web, .init(["isMine": false, "isWithdrawn": false, "isPartial": false, "hasText": true, "isReplyable": true, "canDecide": true, "isEvent": false]), [[.react], [.copy, .reply, .decide]]),
            (.message, "row", .ios, .init(["isMine": true, "isWithdrawn": false, "isPartial": false, "hasText": true, "isReplyable": false, "canDecide": false, "isEvent": false]), [[.react], [.copy], [.saveNote, .edit, .withdraw]]),
            (.message, "row", .web, .init(["isMine": true, "isWithdrawn": false, "isPartial": true, "hasText": true, "isReplyable": true, "canDecide": true, "isEvent": false]), []),
            (.conversation, "row", .mac, .init(["hasUnread": false, "hasInboundAddress": false]), [[.mute], [.archive], [.star]]),
            (.person, "peer", .web, .init(["canWave": true, "canCall": false, "hasEmail": true, "hasThread": false, "hasFavorite": true]), [[.message, .wave], [.copyEmail], [.starPerson]]),
            (.person, "peer", .web, .init(["canWave": false, "canCall": false, "canJoinRoom": true, "hasEmail": true, "hasThread": false, "hasFavorite": true]), [[.message, .joinRoom], [.copyEmail], [.starPerson]]),
        ]

        for (kind, context, client, facts, expected) in cases {
            XCTAssertEqual(
                WorkRowActionRegistry.groups(kind: kind, context: context, client: client, facts: facts),
                expected,
                "\(kind.rawValue).\(context).\(client.rawValue)"
            )
        }
    }

    func testTaskFactsKeepOptionalDoorsOptional() {
        let mine = WorkRowActionRegistry.groups(
            kind: .task, context: WorkTaskMenuContext.mine, client: .mac,
            facts: .init(["hasSubject": false, "hasCore": false, "canFileOnGitHub": false])
        )
        XCTAssertEqual(mine, [[.complete, .cancel], [.openMine]])

        let assigned = WorkRowActionRegistry.groups(
            kind: .task, context: WorkTaskMenuContext.assigned, client: .mac,
            facts: .init(["hasSubject": true, "hasCore": false, "canFileOnGitHub": false])
        )
        XCTAssertEqual(assigned, [[.complete, .cancel], [.markSeen], [.openSubject]])
    }

    /// The Core page each subject kind and contact opens: the same URLs the
    /// web builds from `coreSubjectURL` and `coreContactURL`.
    func testCoreSubjectAndContactURLsMatchSharedCases() throws {
        let core = try loadTable().core
        for subject in core.subjects {
            let model = CrmSubject(
                id: subject.id, kind: subject.kind, title: "Subject", subtitle: nil,
                openTasks: 0, overdueTasks: 0, hasRepo: false
            )
            XCTAssertEqual(model.coreURL?.absoluteString, subject.url, subject.kind)
        }
        for contact in core.contacts {
            let attendee = CalendarAttendeeSummary(
                name: "Contact", crmUrl: contact.raw, status: "accepted", optional: false, isSelf: false
            )
            XCTAssertEqual(attendee.coreURL?.absoluteString, contact.url, contact.raw)
        }
    }

    /// `SubjectKind.can(_:)` answers exactly what fixtures/subject-kinds.json says
    /// (the registry in packages/contracts/src/subject-kinds.ts).
    func testEverySubjectKindAndCapabilityMatchesTheRegistryFixture() throws {
        let bundle = Bundle(for: type(of: self))
        let url = bundle.url(forResource: "subject-kinds", withExtension: "json")
            ?? URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("fixtures/subject-kinds.json")
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
            "fixtures/subject-kinds.json"
        )
        XCTAssertEqual(root["version"] as? Int, 1)
        let kinds = try XCTUnwrap(root["kinds"] as? [String: [String: Any]])
        let with = try XCTUnwrap(root["with"] as? [String: [String]])

        XCTAssertEqual(Set(kinds.keys), Set(MeetingCategoryKind.SubjectKind.allCases.map(\.rawValue)))
        XCTAssertEqual(Set(with.keys), Set(SubjectCapability.allCases.map(\.rawValue)))

        for kind in MeetingCategoryKind.SubjectKind.allCases {
            let entry = try XCTUnwrap(kinds[kind.rawValue], kind.rawValue)
            let meetings = entry["meetings"] as? [String: Any]
            let expected: [SubjectCapability: Bool] = [
                .tasks: entry["tasks"] != nil,
                .issues: entry["issues"] as? Bool ?? false,
                .documents: entry["documents"] is [String: Any],
                .meetings: meetings != nil,
                .hostedMeetings: meetings?["hosted"] as? Bool ?? false,
                .calendarEvents: entry["calendarEvents"] as? Bool ?? false,
                .slack: entry["slack"] as? Bool ?? false,
                .granola: entry["granola"] as? Bool ?? false,
                .talk: entry["talk"] as? Bool ?? false,
            ]
            for capability in SubjectCapability.allCases {
                XCTAssertEqual(kind.can(capability), expected[capability], "\(kind) \(capability)")
                XCTAssertEqual(
                    kind.can(capability),
                    with[capability.rawValue]?.contains(kind.rawValue),
                    "with.\(capability) \(kind)"
                )
            }
        }
        for capability in SubjectCapability.allCases {
            XCTAssertEqual(
                MeetingCategoryKind.SubjectKind.kinds(with: capability).map(\.rawValue),
                with[capability.rawValue],
                "kinds(with: \(capability))"
            )
        }
    }

    private func loadTable() throws -> FixtureTable {
        let bundle = Bundle(for: type(of: self))
        let url = try XCTUnwrap(
            bundle.url(forResource: "work-actions", withExtension: "json"),
            "fixtures/work-actions.json is not in the test bundle — check project.yml."
        )
        return try JSONDecoder().decode(FixtureTable.self, from: Data(contentsOf: url))
    }

    private struct FixtureTable: Decodable {
        let version: Int
        let actions: [String: FixtureAction]
        let clients: [String: [String: FixtureClients]]
        let contexts: [String: [String: [[String]]]]
        let core: FixtureCore
    }

    private struct FixtureCore: Decodable {
        let subjects: [FixtureCoreSubject]
        let contacts: [FixtureCoreContact]
    }

    private struct FixtureCoreSubject: Decodable {
        let kind: String
        let id: String
        let url: String
    }

    private struct FixtureCoreContact: Decodable {
        let raw: String
        let url: String?
    }

    private struct FixtureAction: Decodable {
        let destructive: Bool
    }

    private struct FixtureClients: Decodable {
        let mac: Bool
        let ios: Bool
        let web: Bool
    }
}

/// meet#1024: adding a Quick Note never shrinks Home's visible list. The
/// web's `quick-notes-page.test.ts` pins the same numbers.
final class QuickNotePageTests: XCTestCase {
    private func ids(_ count: Int) -> [String] { (0..<count).map { "n\($0)" } }

    func testAnUnmeasuredNoteCountsAtTheMedian() {
        let heights = Dictionary(uniqueKeysWithValues: ids(8).map { ($0, CGFloat(60)) })
        XCTAssertEqual(QuickNotePage.count(of: ids(8), viewport: 1000, pages: 1, spacing: 8) { heights[$0] }, 6)
        XCTAssertEqual(QuickNotePage.count(of: ["new"] + ids(8), viewport: 1000, pages: 1, spacing: 8) { heights[$0] }, 6)
    }

    func testTheFloorKeepsWhatWasShowingPlusTheNewNote() {
        let heights = Dictionary(uniqueKeysWithValues: ids(8).map { ($0, CGFloat(60)) })
        let floor = QuickNotePage.floor(old: ids(8), new: ["new"] + ids(8), shown: 6, current: 0)
        XCTAssertEqual(floor, 7)
        XCTAssertEqual(QuickNotePage.count(of: ["new"] + ids(8), viewport: 1000, pages: 1, spacing: 8, floor: floor) { heights[$0] }, 7)
    }
}
