import XCTest
@testable import Starlings

/// The rail somebody arranged has to survive the build that adds a section to
/// it. These pin the reconciliation, so a saved order can never silently drop
/// a block or leave a dead key behind.
final class WorkSidebarPreferencesTests: XCTestCase {
    private var keys: [String] { WorkSidebarPreferences.catalog.map(\.key) }

    func testNoSavedOrderIsTheShippedOrder() {
        XCTAssertEqual(WorkSidebarPreferences.resolvedOrder(saved: []), keys)
    }

    func testSavedOrderIsKept() {
        let reversed = Array(keys.reversed())
        XCTAssertEqual(WorkSidebarPreferences.resolvedOrder(saved: reversed), reversed)
    }

    func testUnknownKeysAreDroppedAndMissingOnesComeBackWhereTheyShip() {
        // Somebody's saved rail from before meet#147 slice 3: the blocks
        // INBOX replaced, the doors that left, and one nobody ever had.
        let saved = [
            "work.gone", "work.unread", "work.mine", "work.quickNotes", "work.recent",
            "work.projects", "work.salesInbox", "work.leads", "work.core", "work.docs",
        ]
        let resolved = WorkSidebarPreferences.resolvedOrder(saved: saved)
        XCTAssertFalse(resolved.contains("work.gone"))
        XCTAssertFalse(resolved.contains("work.unread"))
        XCTAssertFalse(resolved.contains("work.core"))
        XCTAssertEqual(resolved, keys)
    }

    func testDuplicatesCollapse() {
        let saved = keys + keys
        XCTAssertEqual(WorkSidebarPreferences.resolvedOrder(saved: saved), keys)
    }

    func testMovingStepsOverHiddenSections() {
        // B is hidden, so C moving up steps over it to land above A — the
        // block it can actually see — rather than appearing not to move at
        // all.
        let moved = WorkSidebarPreferences.moved(
            "c",
            by: -1,
            order: ["a", "b", "c"],
            hidden: ["b"]
        )
        XCTAssertEqual(moved, ["c", "b", "a"])
    }

    /// Browse's groups keep their filter and sort under the keys they had as
    /// rail blocks, and Reset clears those too.
    func testResetClearsBrowseFiltersAndSorts() {
        let defaults = UserDefaults(suiteName: "meet.tests.workSidebar.browse")!
        defaults.removePersistentDomain(forName: "meet.tests.workSidebar.browse")
        let allowed = CrmSubjectStatusOption.project.map(\.id)
        WorkSidebarPreferences.setFilter("Paused", for: "work.projects", defaults: defaults)
        XCTAssertEqual(
            WorkSidebarPreferences.filter(for: "work.projects", allowed: allowed, fallback: "open", defaults: defaults),
            "Paused"
        )
        WorkSidebarPreferences.reset(defaults: defaults)
        XCTAssertEqual(
            WorkSidebarPreferences.filter(for: "work.projects", allowed: allowed, fallback: "open", defaults: defaults),
            "open"
        )
        defaults.removePersistentDomain(forName: "meet.tests.workSidebar.browse")
    }

    func testMovingPastTheEndsDoesNothing() {
        XCTAssertEqual(WorkSidebarPreferences.moved(keys.first!, by: -1, order: keys, hidden: []), keys)
        XCTAssertEqual(WorkSidebarPreferences.moved(keys.last!, by: 1, order: keys, hidden: []), keys)
    }

    func testFilterFallsBackWhenTheSavedStatusIsGone() {
        let defaults = UserDefaults(suiteName: "meet.tests.workSidebar")!
        defaults.removePersistentDomain(forName: "meet.tests.workSidebar")
        let allowed = CrmSubjectStatusOption.project.map(\.id)
        XCTAssertEqual(
            WorkSidebarPreferences.filter(
                for: "work.projects", allowed: allowed, fallback: "open", defaults: defaults
            ),
            "open"
        )
        WorkSidebarPreferences.setFilter("Paused", for: "work.projects", defaults: defaults)
        XCTAssertEqual(
            WorkSidebarPreferences.filter(
                for: "work.projects", allowed: allowed, fallback: "open", defaults: defaults
            ),
            "Paused"
        )
        WorkSidebarPreferences.setFilter("Retired", for: "work.projects", defaults: defaults)
        XCTAssertEqual(
            WorkSidebarPreferences.filter(
                for: "work.projects", allowed: allowed, fallback: "open", defaults: defaults
            ),
            "open"
        )
        defaults.removePersistentDomain(forName: "meet.tests.workSidebar")
    }

    func testHidingAndShowing() {
        let defaults = UserDefaults(suiteName: "meet.tests.workSidebar.visible")!
        defaults.removePersistentDomain(forName: "meet.tests.workSidebar.visible")
        XCTAssertTrue(WorkSidebarPreferences.isVisible("work.partners", defaults: defaults))
        WorkSidebarPreferences.setVisible(false, for: "work.partners", defaults: defaults)
        XCTAssertFalse(WorkSidebarPreferences.isVisible("work.partners", defaults: defaults))
        XCTAssertTrue(WorkSidebarPreferences.isVisible("work.projects", defaults: defaults))
        WorkSidebarPreferences.setVisible(true, for: "work.partners", defaults: defaults)
        XCTAssertTrue(WorkSidebarPreferences.isVisible("work.partners", defaults: defaults))
        defaults.removePersistentDomain(forName: "meet.tests.workSidebar.visible")
    }

    /// SALES is not hidden by the local preference any more: whether it is
    /// on the rail is the Worker's `sales_enabled`, and a rail that hid it
    /// locally by default would keep it off for somebody who turned Sales
    /// on from another Mac.
    func testSalesIsNotLocallyHiddenByDefault() {
        let defaults = UserDefaults(suiteName: "meet.tests.workSidebar.salesDefault")!
        defaults.removePersistentDomain(forName: "meet.tests.workSidebar.salesDefault")
        XCTAssertTrue(WorkSidebarPreferences.isVisible("work.leads", defaults: defaults))
        WorkSidebarPreferences.setVisible(false, for: "work.leads", defaults: defaults)
        XCTAssertFalse(WorkSidebarPreferences.isVisible("work.leads", defaults: defaults))
        WorkSidebarPreferences.reset(defaults: defaults)
        XCTAssertTrue(WorkSidebarPreferences.isVisible("work.leads", defaults: defaults))
        defaults.removePersistentDomain(forName: "meet.tests.workSidebar.salesDefault")
    }

    func testLegacyTeamFoldStoreMigratesOnce() {
        let defaults = UserDefaults.standard
        let legacyKey = "meet.tests.legacyFolds"
        defaults.removeObject(forKey: "meet.sidebarFold.teamtest.people")
        defaults.set(["people"], forKey: legacyKey)

        MeetingSidebarFoldPreferences.migrate(legacyArrayKey: legacyKey, keyPrefix: "teamtest.")
        XCTAssertTrue(MeetingSidebarFoldPreferences.isCollapsed("teamtest.people"))
        // Consumed: a second launch has nothing to migrate and cannot undo a
        // fold the person has since reopened.
        XCTAssertNil(defaults.stringArray(forKey: legacyKey))
        MeetingSidebarFoldPreferences.setCollapsed(false, for: "teamtest.people")
        MeetingSidebarFoldPreferences.migrate(legacyArrayKey: legacyKey, keyPrefix: "teamtest.")
        XCTAssertFalse(MeetingSidebarFoldPreferences.isCollapsed("teamtest.people"))
        defaults.removeObject(forKey: "meet.sidebarFold.teamtest.people")
    }
}
