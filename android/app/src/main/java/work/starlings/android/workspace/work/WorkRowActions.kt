package work.starlings.android.workspace.work

/**
 * `WorkRowActionRegistry` (Sources/WorkRowActions.swift) for the rows the
 * Work tab draws: which actions a row's menu holds, in which groups, from
 * `packages/contracts/src/work-actions.ts`. `WorkRowActionsTest` holds these
 * tables to `fixtures/work-actions.json`. Android takes the iOS column of
 * the client table; the facts that gate an action are Swift's.
 */
object WorkRowActions {
    enum class Kind(val wire: String) { TASK("task"), ISSUE("issue"), QUICK_NOTE("quick_note"), BOARD_CARD("board_card"), SUBJECT("subject"), INBOX_COMMERCIAL("inbox_commercial") }

    /** `contexts`: the canonical groups per kind and context. */
    val contexts: Map<Kind, Map<String, List<List<String>>>> = mapOf(
        Kind.TASK to mapOf(
            "inbox_proposed" to listOf(listOf("accept", "decline"), listOf("open-subject"), listOf("open-core"), listOf("star")),
            "subject_proposed" to listOf(listOf("accept", "decline"), listOf("open-core"), listOf("star")),
            "subject_open" to listOf(listOf("complete", "cancel"), listOf("hand-off"), listOf("file-github"), listOf("open-core"), listOf("star"), listOf("delete")),
            "mine" to listOf(listOf("complete", "cancel"), listOf("hand-off"), listOf("open-subject", "open-mine"), listOf("file-github"), listOf("open-core"), listOf("star"), listOf("delete")),
            "assigned" to listOf(listOf("complete", "cancel"), listOf("mark-seen"), listOf("hand-off"), listOf("open-subject", "open-mine"), listOf("file-github"), listOf("open-core"), listOf("star")),
            "unowned" to listOf(listOf("assign"), listOf("complete", "cancel"), listOf("hand-off"), listOf("open-subject", "open-mine"), listOf("file-github"), listOf("open-core"), listOf("star")),
        ),
        Kind.ISSUE to mapOf(
            "row" to listOf(listOf("open"), listOf("close-issue", "close-not-planned", "reopen-issue"), listOf("hand-off"), listOf("open-github"), listOf("copy-link"), listOf("open-core"), listOf("star")),
            "assigned" to listOf(listOf("close-issue", "close-not-planned", "reopen-issue"), listOf("mark-seen"), listOf("hand-off"), listOf("open"), listOf("open-core"), listOf("star")),
            "unowned" to listOf(listOf("assign"), listOf("open"), listOf("close-issue", "close-not-planned", "reopen-issue"), listOf("hand-off"), listOf("open-github", "copy-link"), listOf("open-core"), listOf("star")),
        ),
        Kind.QUICK_NOTE to mapOf(
            "home" to listOf(listOf("edit", "file-note", "move-workspace"), listOf("delete")),
            "inbox" to listOf(listOf("file-note"), listOf("delete")),
        ),
        Kind.BOARD_CARD to mapOf(
            "row" to listOf(listOf("open"), listOf("open-github", "open-subject", "open-conversation"), listOf("move-stage"), listOf("hand-off")),
        ),
        Kind.SUBJECT to mapOf(
            "row" to listOf(
                listOf("star", "mute"), listOf("open", "edit-details", "rename", "win-lead"),
                listOf("open-tasks", "open-issues", "new-task", "new-issue"), listOf("start-room", "link-repository", "keep-vault", "open-core"),
            ),
            "organization" to listOf(listOf("star", "mute"), listOf("open", "open-talk", "open-history", "start-room"), listOf("open-tasks", "new-task"), listOf("open-core")),
        ),
        Kind.INBOX_COMMERCIAL to mapOf(
            "row" to listOf(listOf("open-subject"), listOf("dismiss", "undo-dismiss")),
        ),
    )

    /** The client table's iOS column: what a phone draws, per kind. */
    val phone: Map<Kind, Set<String>> = mapOf(
        Kind.TASK to setOf("accept", "decline", "complete", "cancel", "mark-seen", "file-github", "open-subject", "open-mine", "open-core", "star", "assign", "hand-off", "delete"),
        Kind.ISSUE to setOf("close-issue", "close-not-planned", "reopen-issue", "open-core", "star", "mark-seen", "hand-off", "assign"),
        Kind.QUICK_NOTE to setOf("edit", "file-note", "move-workspace", "delete"),
        Kind.BOARD_CARD to setOf("move-stage", "hand-off"),
        Kind.SUBJECT to setOf(
            "star", "mute", "open", "edit-details", "win-lead", "rename", "open-talk", "open-history", "open-tasks", "open-issues",
            "new-task", "new-issue", "start-room", "link-repository", "keep-vault", "open-core",
        ),
        Kind.INBOX_COMMERCIAL to setOf("open-subject", "dismiss", "undo-dismiss"),
    )

    /** `destructiveActions`. */
    val destructive: Set<String> = setOf("decline", "close-not-planned", "archive", "delete", "withdraw")

    /** `groups(kind:context:client:facts:)`: the canonical groups, less what the phone or the facts leave out; empty groups go. */
    fun groups(kind: Kind, context: String, facts: Map<String, Boolean> = emptyMap()): List<List<String>> =
        contexts[kind]?.get(context).orEmpty().mapNotNull { group ->
            group.filter { it in phone[kind].orEmpty() && matches(kind, it, facts) }.takeIf { it.isNotEmpty() }
        }

    private fun matches(kind: Kind, action: String, facts: Map<String, Boolean>): Boolean {
        fun on(name: String) = facts[name] == true
        fun off(name: String) = facts[name] == false
        return when (kind) {
            Kind.TASK -> when (action) {
                "open-subject" -> on("hasSubject")
                "open-mine" -> off("hasSubject")
                "open-core" -> on("hasCore")
                "file-github" -> on("canFileOnGitHub")
                "star" -> on("isStarable")
                "assign" -> on("canAssign")
                "hand-off" -> on("canHandOff")
                "delete" -> on("canDelete")
                else -> true
            }
            Kind.ISSUE -> when (action) {
                "hand-off" -> on("canHandOff") && on("isOpen")
                "close-issue", "close-not-planned" -> on("isOpen")
                "reopen-issue" -> off("isOpen")
                "open-github", "copy-link" -> on("hasRepo")
                "open-core" -> on("hasCore")
                "mark-seen" -> on("canMarkSeen")
                "assign" -> on("canAssign")
                else -> true
            }
            Kind.QUICK_NOTE -> when (action) {
                "edit" -> on("isEditable")
                "move-workspace" -> on("hasOtherWorkspace")
                else -> true
            }
            Kind.BOARD_CARD -> when (action) {
                "open-github" -> on("hasRepo")
                "open-subject" -> on("hasSubject")
                "open-conversation" -> on("hasConversation")
                "move-stage" -> on("canMoveStage")
                "hand-off" -> on("hasAgents")
                else -> true
            }
            Kind.SUBJECT -> when (action) {
                "open-talk", "open-history" -> on("isPartner")
                "edit-details", "rename" -> !on("isPartner") && !on("isEvent")
                "win-lead" -> on("isOpenLead")
                "open-issues", "new-issue" -> on("isProject") && on("hasRepo")
                "start-room" -> !on("isEvent")
                "link-repository" -> on("isProject") && !on("hasRepo")
                "keep-vault" -> on("isProject") && !on("hasVault")
                "open-core" -> on("hasCore")
                else -> true
            }
            Kind.INBOX_COMMERCIAL -> when (action) {
                "dismiss" -> !on("isDismissed")
                "undo-dismiss" -> on("isDismissed")
                else -> true
            }
        }
    }
}
