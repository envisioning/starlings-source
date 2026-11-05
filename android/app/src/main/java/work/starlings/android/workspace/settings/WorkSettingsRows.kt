package work.starlings.android.workspace.settings

import work.starlings.android.workspace.work.WorkInbox

/**
 * Settings › Work's rules (`MobileWorkSettingsSection`): the "Show in Work"
 * rows (`ShownKindRow` in `Sources/SubjectState.swift`), the hidden kinds as
 * the Worker means them, and the Inbox switches (`InboxSourceSpec`). The
 * words are resources; this file holds only the rules.
 */
object WorkSettingsRows {
    /** One switch per subject kind, in iOS order, with the work module that gates it (`WorkModule.gating`). */
    enum class ShownKind(val kind: String, val module: String?) {
        PROJECT("project", null),
        LEAD("lead", "sales"),
        ORGANIZATION("organization", "partners"),
        EVENT("event", "events"),
    }

    /** `ShownKindRow.offered`: the kinds whose work module the workspace has on; an older Worker sends no modules. */
    fun offered(workModules: List<String>?): List<ShownKind> =
        ShownKind.entries.filter { row -> row.module == null || workModules == null || row.module in workModules }

    /** `resolvedHiddenKinds`: the kinds this person hides; an older Worker sends only Sales. */
    fun hiddenKinds(hidden: List<String>?, salesEnabled: Boolean): List<String> =
        hidden ?: if (salesEnabled) emptyList() else listOf("lead")

    /** The whole list to send when one kind is switched. */
    fun toggled(hidden: List<String>, kind: String, shown: Boolean): List<String> {
        val rest = hidden.filter { it != kind }
        return if (shown) rest else rest + kind
    }

    /**
     * The Inbox switches in Settings order (`InboxSourceSpec.all`, the same
     * order as the filter's sources), only those the Worker offers this
     * person. Every source is on by default (`inbox-values.json`).
     */
    fun inboxSources(available: List<String>): List<String> = WorkInbox.filterSources.filter { it in available }

    /** `InboxSourceSpec.resolve`: a stored override, else on. */
    fun isOn(stored: Map<String, Boolean>, source: String): Boolean = stored[source] ?: true

    /** Sales touches follow the Worker's Sales opt-in (`sales_enabled`). */
    fun isEnabled(source: String, salesEnabled: Boolean): Boolean = source != "sales" || salesEnabled
}
