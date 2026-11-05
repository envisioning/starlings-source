package work.starlings.android.api

/**
 * How a client talks to the Worker, as one table: `packages/contracts/src/request-policy.ts`,
 * which the Swift clients read through `Sources/StarlingsRequestPolicy.swift`.
 * The timeout, the one retry of an idempotent request, which reads each
 * client keeps as a snapshot, and which writes make each stale.
 * `RequestPolicyFixtureTest` holds this copy to `fixtures/request-policy.json`.
 *
 * The table names `mac`, `ios` and `web`. Android is not in it: the phone
 * app's screens are the iOS app's, so Android keeps exactly the rows iOS
 * keeps ([keeps]). The rule lives here only; `packages/` is unchanged.
 */
object RequestPolicy {
    /** The clients the table speaks about, plus Android, which reads as [IOS]. */
    enum class Client(val wire: String) { MAC("mac"), IOS("ios"), WEB("web"), ANDROID("android") }

    /** `REQUEST_TIMEOUT_SECONDS`: seconds without data before a request stops. */
    const val TIMEOUT_SECONDS = 15.0

    /** `REQUEST_RETRY`: when a failed request is sent again. */
    data class Retry(
        val methods: List<String>,
        val extraAttempts: Int,
        val delaySeconds: Double,
        /** Every status from here up is the service saying "not now". */
        val statusFloor: Int,
        /** And these below it: a request timeout, a rate limit. */
        val statuses: List<Int>,
    ) {
        /** POST and DELETE are never sent twice: see the TypeScript module for why. */
        fun appliesTo(method: String): Boolean = method.uppercase() in methods
        fun retries(status: Int): Boolean = status >= statusFloor || status in statuses

        /** The same rule without the pause, so a test does not wait. */
        val withoutPause: Retry get() = copy(delaySeconds = 0.0)
    }

    val retry = Retry(
        methods = listOf("GET", "HEAD", "PUT", "PATCH"),
        extraAttempts = 1,
        delaySeconds = 0.7,
        statusFloor = 500,
        statuses = listOf(408, 429),
    )

    /** One snapshotted list: where it is stored, what reads it, who keeps it, what makes it stale. */
    data class SnapshotRule(
        val name: String,
        val key: String,
        val read: String,
        val clients: List<Client>,
        val invalidatedBy: List<SnapshotWrite>,
    )

    private val MAC_IOS_WEB = listOf(Client.MAC, Client.IOS, Client.WEB)

    /** `SNAPSHOT_ROWS`, in the table's order. */
    val snapshots: List<SnapshotRule> = listOf(
        SnapshotRule("threads", SnapshotKey.THREADS, "GET /api/threads", MAC_IOS_WEB,
            listOf(SnapshotWrite.THREAD_OPEN, SnapshotWrite.THREAD_MESSAGE, SnapshotWrite.THREAD_STATE)),
        SnapshotRule("peers", SnapshotKey.PEERS, "GET /api/peers", listOf(Client.IOS), emptyList()),
        SnapshotRule("mine", SnapshotKey.MINE, "GET /api/crm/mine", MAC_IOS_WEB,
            listOf(SnapshotWrite.TASK_CREATE, SnapshotWrite.TASK_UPDATE, SnapshotWrite.ISSUE_WRITE, SnapshotWrite.GITHUB_LOGIN_SET)),
        SnapshotRule("inbox", SnapshotKey.INBOX, "GET /api/crm/inbox", MAC_IOS_WEB,
            listOf(SnapshotWrite.ATTENTION_RESOLVE, SnapshotWrite.COMMENT_RESOLVE, SnapshotWrite.QUICK_NOTE_WRITE,
                SnapshotWrite.TASK_UPDATE, SnapshotWrite.WORK_PREFERENCES_SET)),
        SnapshotRule("quickNotes", SnapshotKey.QUICK_NOTES, "GET /api/quick-notes", MAC_IOS_WEB,
            listOf(SnapshotWrite.QUICK_NOTE_WRITE)),
        SnapshotRule("subjects", SnapshotKey.SUBJECTS, "GET /api/crm/subjects", MAC_IOS_WEB,
            listOf(SnapshotWrite.SUBJECT_WRITE, SnapshotWrite.SUBJECT_STATE_SET, SnapshotWrite.WORK_PREFERENCES_SET)),
        SnapshotRule("subjectCounts", SnapshotKey.SUBJECT_COUNTS, "GET /api/crm/subject-counts", listOf(Client.MAC, Client.IOS),
            listOf(SnapshotWrite.SUBJECT_WRITE, SnapshotWrite.SUBJECT_STATE_SET, SnapshotWrite.WORK_PREFERENCES_SET)),
        SnapshotRule("subjectState", SnapshotKey.SUBJECT_STATE, "GET /api/crm/subject-state", listOf(Client.MAC),
            listOf(SnapshotWrite.SUBJECT_STATE_SET, SnapshotWrite.WORK_PREFERENCES_SET)),
        SnapshotRule("tasks", SnapshotKey.TASKS, "GET /api/crm/tasks", MAC_IOS_WEB,
            listOf(SnapshotWrite.TASK_CREATE, SnapshotWrite.TASK_UPDATE)),
        SnapshotRule("interactions", SnapshotKey.INTERACTIONS, "GET /api/crm/interactions", MAC_IOS_WEB,
            listOf(SnapshotWrite.INTERACTION_WRITE)),
        SnapshotRule("issues", SnapshotKey.ISSUES, "GET /api/crm/issues", listOf(Client.IOS), listOf(SnapshotWrite.ISSUE_WRITE)),
        SnapshotRule("starred", SnapshotKey.STARRED, "GET /api/crm/starred", MAC_IOS_WEB, listOf(SnapshotWrite.FAVORITE_SET)),
        SnapshotRule("favorites", SnapshotKey.FAVORITES, "GET /api/crm/favorites", listOf(Client.IOS), listOf(SnapshotWrite.FAVORITE_SET)),
        SnapshotRule("commercialSummary", SnapshotKey.COMMERCIAL_SUMMARY, "GET /api/crm/commercial-summary", MAC_IOS_WEB, emptyList()),
        SnapshotRule("ownerRoom", SnapshotKey.OWNER_ROOM, "GET /api/owner/room", listOf(Client.IOS, Client.WEB), emptyList()),
        SnapshotRule("calendarUpcoming", SnapshotKey.CALENDAR_UPCOMING, "GET /api/calendar/upcoming", listOf(Client.MAC, Client.WEB), emptyList()),
        SnapshotRule("calendarPreferences", SnapshotKey.CALENDAR_PREFERENCES, "GET /api/calendar/preferences", listOf(Client.MAC, Client.WEB), emptyList()),
        SnapshotRule("calendarInvitations", SnapshotKey.CALENDAR_INVITATIONS, "GET /api/calendar/invitations", MAC_IOS_WEB, emptyList()),
        SnapshotRule("calendarPending", SnapshotKey.CALENDAR_PENDING, "GET /api/calendar/pending", MAC_IOS_WEB, emptyList()),
    )

    /** `snapshotsInvalidatedBy`: the keys and prefixes a write makes stale, in the table's order. */
    fun invalidated(by: SnapshotWrite): List<String> = snapshots.filter { by in it.invalidatedBy }.map { it.key }

    /**
     * `StarlingsRequestPolicy.keeps`: whether [client] keeps a snapshot of the
     * read stored under [key]. A per-query key (`<key>?…`, `<key>/…`) belongs
     * to its row. Android keeps what iOS keeps.
     */
    fun keeps(key: String, client: Client): Boolean {
        val asked = if (client == Client.ANDROID) Client.IOS else client
        return snapshots.any { (key == it.key || key.startsWith("${it.key}?") || key.startsWith("${it.key}/")) && asked in it.clients }
    }

    /** `SnapshotStore.matches`: [key] is, or is under, one of [prefixes]. */
    fun matches(key: String, prefixes: List<String>): Boolean =
        prefixes.any { key == it || key.startsWith("$it?") || key.startsWith("$it/") }
}

/** `SNAPSHOT_WRITES`: a write named for what it does, not for its route. */
enum class SnapshotWrite(val wire: String) {
    THREAD_OPEN("thread.open"),
    THREAD_MESSAGE("thread.message"),
    THREAD_STATE("thread.state"),
    ATTENTION_RESOLVE("attention.resolve"),
    COMMENT_RESOLVE("comment.resolve"),
    QUICK_NOTE_WRITE("quickNote.write"),
    TASK_CREATE("task.create"),
    TASK_UPDATE("task.update"),
    ISSUE_WRITE("issue.write"),
    GITHUB_LOGIN_SET("githubLogin.set"),
    SUBJECT_WRITE("subject.write"),
    SUBJECT_STATE_SET("subjectState.set"),
    WORK_PREFERENCES_SET("workPreferences.set"),
    FAVORITE_SET("favorite.set"),
    INTERACTION_WRITE("interaction.write"),
}

/**
 * `StarlingsSnapshotKey`: what each snapshot is stored under, and the
 * per-query keys built from them (`Sources/StarlingsRequestPolicy.swift`).
 * A write that names a row takes every page under its key.
 */
object SnapshotKey {
    const val THREADS = "threads"
    const val PEERS = "peers"
    const val MINE = "crm/mine"
    const val INBOX = "crm/inbox"
    const val QUICK_NOTES = "quick-notes"
    const val SUBJECTS = "crm/subjects"
    const val SUBJECT_COUNTS = "crm/subject-counts"
    const val SUBJECT_STATE = "crm/subject-state"
    const val TASKS = "crm/tasks"
    const val INTERACTIONS = "crm/interactions"
    const val ISSUES = "crm/issues"
    const val STARRED = "crm/starred"
    const val FAVORITES = "crm/favorites"
    const val COMMERCIAL_SUMMARY = "crm/commercial-summary"
    const val OWNER_ROOM = "owner/room"
    const val CALENDAR_UPCOMING = "calendar/upcoming"
    const val CALENDAR_PREFERENCES = "calendar/preferences"
    const val CALENDAR_INVITATIONS = "calendar/invitations"
    const val CALENDAR_PENDING = "calendar/pending"

    fun subjects(kind: String, query: String, status: String?) = "$SUBJECTS?kind=$kind&q=$query&status=${status.orEmpty()}"

    fun subjectCounts(kind: String, query: String) = "$SUBJECT_COUNTS?kind=$kind&q=$query"

    fun tasks(projectId: String?, leadId: String?, eventId: String? = null, organizationId: String? = null) =
        "$TASKS?project_id=${projectId.orEmpty()}&lead_id=${leadId.orEmpty()}&event_id=${eventId.orEmpty()}&organization_id=${organizationId.orEmpty()}"

    fun interactions(projectId: String?, leadId: String?, organizationId: String? = null) =
        "$INTERACTIONS?project_id=${projectId.orEmpty()}&lead_id=${leadId.orEmpty()}&organization_id=${organizationId.orEmpty()}"

    /** One subject's detail, under `crm/subjects` on purpose: a subject write takes it with the lists. */
    fun subjectDetail(kind: String, id: String) = "$SUBJECTS/$kind/$id"
}
