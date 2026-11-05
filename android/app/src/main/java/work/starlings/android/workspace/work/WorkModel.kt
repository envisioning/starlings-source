package work.starlings.android.workspace.work

import work.starlings.android.Search
import work.starlings.android.Upcoming
import work.starlings.android.WorkBoard
import work.starlings.android.WorkCard
import work.starlings.android.WorkItemOrigin
import work.starlings.android.WorkItems
import work.starlings.android.WorkPlan
import work.starlings.android.WorkRankSignals
import work.starlings.android.WorkRankSubject
import work.starlings.android.WorkSection
import work.starlings.android.WorkSubjectRanker
import work.starlings.contracts.CrmIssueState
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmIssueUpdate
import work.starlings.contracts.CrmIssueUpdateStateReason
import work.starlings.contracts.CrmRecentlyClosedItemWire
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.CrmResponsiblePartyValue
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmTaskCreate
import work.starlings.contracts.CrmTaskStatusValue
import work.starlings.contracts.CrmTaskUpdate
import work.starlings.contracts.CrmTaskSubjectRefWire
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.CrmTeamMember
import work.starlings.contracts.Patch
import work.starlings.contracts.SubjectStateRow
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * The pure half of the Work tab: how Core's task and issue shapes become
 * the shared planner's rows, and the task editor's draft. Every rule that
 * already has a Kotlin port (`WorkItems`, `WorkSubjectRanker`, `Search`) is
 * called, not copied. The Swift counterparts are named per declaration.
 */

/** `CrmTaskDate`: Core's due and updated stamps. A date-only value is local midnight; nonsense is no date. */
object TaskDates {
    fun parse(wire: String?, zone: ZoneId = ZoneId.systemDefault()): Long? {
        if (wire.isNullOrBlank()) return null
        Upcoming.parse(wire)?.let { return it }
        return runCatching { LocalDate.parse(wire.take(10)).atStartOfDay(zone).toInstant().toEpochMilli() }
            .getOrNull()
            ?.takeIf { wire.length == 10 }
    }

    /** The civil day a stamp falls on, in [zone]. */
    fun day(wire: String?, zone: ZoneId = ZoneId.systemDefault()): LocalDate? =
        parse(wire, zone)?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }

    /** `CrmTaskDate.wire`: the day as an internet date-time, local midnight, no fraction. */
    fun wire(day: LocalDate, zone: ZoneId = ZoneId.systemDefault()): String =
        DateTimeFormatter.ISO_INSTANT.format(day.atStartOfDay(zone).toInstant().truncatedTo(ChronoUnit.SECONDS))

    /** `CrmTaskDate.isOverdue`: the due day is before today. The one date rule is `WorkItems.dateSection`. */
    fun isOverdue(wire: String?, now: Long, zone: ZoneId = ZoneId.systemDefault()): Boolean =
        WorkItems.dateSection(parse(wire, zone), now, zone) == WorkSection.LATE
}

/** `CrmTaskStatus` (task-values registry), in the registry's order. */
enum class TaskStatus(val wire: String) {
    PENDING("pending"),
    IN_PROGRESS("in_progress"),
    REVIEW("review"),
    BLOCKED("blocked"),
    COMPLETED("completed"),
    CANCELLED("cancelled"),
    PROPOSED("proposed"),
    DECLINED("declined");

    val isFinished: Boolean get() = this == COMPLETED || this == CANCELLED || this == DECLINED
    val isProposed: Boolean get() = this == PROPOSED
    val value: CrmTaskStatusValue get() = CrmTaskStatusValue(wire)

    companion object {
        /** An unknown status reads as pending, as Swift's decoder does. */
        fun of(wire: String?): TaskStatus = entries.firstOrNull { it.wire == wire } ?: PENDING

        /** What a person may set by hand: proposed and declined are answers, not choices. */
        val editable: List<TaskStatus> = entries.filter { it != PROPOSED && it != DECLINED }
    }
}

/** `CrmTaskResponsible`: which side owes a task. */
enum class TaskSide(val wire: String) {
    TEAM("team"),
    CLIENT("client"),
    UNASSIGNED("unassigned");

    val value: CrmResponsiblePartyValue get() = CrmResponsiblePartyValue(wire)

    companion object {
        fun of(wire: String?): TaskSide = entries.firstOrNull { it.wire == wire } ?: UNASSIGNED
    }
}

/** A subject a task hangs off, or a subject row opens: kind, id and title. */
data class SubjectRef(val kind: CrmSubjectKind, val id: String, val title: String) {
    val isPartner: Boolean get() = kind == CrmSubjectKind.ORGANIZATION
    val isProject: Boolean get() = kind == CrmSubjectKind.PROJECT

    companion object {
        fun of(subject: CrmSubjectWire) = SubjectRef(subject.kind, subject.id, subject.title)
    }
}

/** `WorkTaskFields`: the subject keys every Core task projection carries. */
data class TaskKeys(
    val projectId: String? = null,
    val leadId: String? = null,
    val eventId: String? = null,
    val organizationId: String? = null,
    val meetingId: String? = null,
) {
    /** Core echoes `organization_id` as context; it files the task only when nothing else does. */
    val partnerOrganizationId: String?
        get() = organizationId?.takeIf { projectId == null && leadId == null && eventId == null && meetingId == null }

    val isFiled: Boolean get() = projectId != null || leadId != null || eventId != null || partnerOrganizationId != null

    val hasSubjectKey: Boolean get() = isFiled || meetingId != null

    /** `CrmMyTask.subject`: the subject Mine's row came from, openable, when Core named it. */
    fun subject(title: String?): SubjectRef? {
        title ?: return null
        return when {
            projectId != null -> SubjectRef(CrmSubjectKind.PROJECT, projectId, title)
            leadId != null -> SubjectRef(CrmSubjectKind.LEAD, leadId, title)
            eventId != null -> SubjectRef(CrmSubjectKind.EVENT, eventId, title)
            partnerOrganizationId != null -> SubjectRef(CrmSubjectKind.ORGANIZATION, partnerOrganizationId!!, title)
            else -> null
        }
    }

    companion object {
        fun of(t: CrmMyTaskWire) = TaskKeys(t.projectId, t.leadId, t.eventId, t.organizationId, t.meetingId)
        fun of(t: CrmTaskWire) = TaskKeys(t.projectId, t.leadId, t.eventId, t.organizationId, t.meetingId)
    }
}

/** `githubRef`: `owner/repo#number`, the issue a promoted task claims. */
internal fun githubRef(owner: String?, repo: String?, number: Long?): String? =
    if (owner != null && repo != null && number != null) "$owner/$repo#$number" else null

/**
 * `PlannedWorkItem`: one Mine or Unowned row, a task or an issue, adapted to
 * the planner. Dates are parsed once, in the zone the plan reads.
 */
sealed interface MineItem : WorkCard {
    data class Task(val task: CrmMyTaskWire, override val workDueDate: Long?, override val workUpdatedAt: Long?) : MineItem {
        val keys: TaskKeys get() = TaskKeys.of(task)
        val status: TaskStatus get() = TaskStatus.of(task.status)
        override val workId: String get() = task.id
        override val workOrigin: WorkItemOrigin get() = WorkItemOrigin.TASK
        override val workIsDone: Boolean get() = status.isFinished
        override val workIsFiled: Boolean get() = keys.isFiled
        override val workGithubRef: String? get() = githubRef(task.githubOwner, task.githubRepo, task.githubIssueNumber)
        override val workTaskStatus: String get() = status.wire
        override val workResponsibleParty: String get() = task.responsibleParty
    }

    data class Issue(val issue: CrmIssueWire, override val workUpdatedAt: Long?) : MineItem {
        override val workId: String get() = issue.id
        override val workOrigin: WorkItemOrigin get() = WorkItemOrigin.ISSUE
        override val workIsDone: Boolean get() = issue.state != CrmIssueState.OPEN
        override val workIsFiled: Boolean get() = true
        override val workDueDate: Long? get() = null
        override val workGithubRef: String? get() = null
        override val workIssueState: String get() = issue.state.value
        override val workIssueStateReason: String? get() = issue.stateReason
        override val workLabels: List<String> get() = issue.labels
        override val workAssignees: List<String>
            get() = issue.assignees?.map { it.login } ?: listOfNotNull(issue.assigneeLogin)

        /** `CrmIssue.shortReference`. */
        val shortReference: String get() = "#${issue.number}"
    }

    /** `matchesMineQuery`: the one matcher, title first, the rest as the subtitle. */
    fun matches(query: String): Boolean {
        val values = when (this) {
            is Task -> listOfNotNull(
                task.title, task.subjectTitle, task.githubOwner, task.githubRepo,
                task.githubIssueNumber?.toString(), task.githubIssueNumber?.let { "#$it" },
            )
            is Issue -> listOfNotNull(
                issue.title, issue.owner, issue.repo, issue.id, shortReference, issue.assigneeLogin, issue.author?.login,
            )
        }
        return Search.matches(query, values.first(), values.drop(1).joinToString(" "))
    }

    companion object {
        fun of(task: CrmMyTaskWire, zone: ZoneId) = Task(task, TaskDates.parse(task.dueDate, zone), TaskDates.parse(task.updatedAt, zone))
        fun of(issue: CrmIssueWire, zone: ZoneId) = Issue(issue, TaskDates.parse(issue.updatedAt, zone))
    }
}

/** `WorkItems.planMine`: plan first, search second, so a promoted task stays the one row. */
object MineWork {
    fun plan(tasks: List<CrmMyTaskWire>, issues: List<CrmIssueWire>, query: String, now: Long, zone: ZoneId): WorkPlan<MineItem> {
        val rows: List<MineItem> = tasks.map { MineItem.of(it, zone) } + issues.map { MineItem.of(it, zone) }
        val plan = WorkItems.plan(rows, now, zone)
        val wanted = query.trim()
        return if (wanted.isEmpty()) plan else plan.filtered { it.matches(wanted) }
    }
}

/** `MobileTaskWhere.kindTitle`: which word names where a task lives. */
enum class TaskWhereKind { PROJECT, LEAD, EVENT, PARTNER, MEETING, NO_SUBJECT, SUBJECT }

object TaskWhere {
    fun kind(keys: TaskKeys?, subject: SubjectRef?): TaskWhereKind {
        if (subject != null) {
            when (subject.kind) {
                CrmSubjectKind.PROJECT -> return TaskWhereKind.PROJECT
                CrmSubjectKind.LEAD -> return TaskWhereKind.LEAD
                CrmSubjectKind.EVENT -> return TaskWhereKind.EVENT
                CrmSubjectKind.ORGANIZATION -> return TaskWhereKind.PARTNER
            }
            if (subject.kind.value == "meeting") return TaskWhereKind.MEETING
        }
        if (keys != null) {
            if (keys.projectId != null) return TaskWhereKind.PROJECT
            if (keys.leadId != null) return TaskWhereKind.LEAD
            if (keys.eventId != null) return TaskWhereKind.EVENT
            if (keys.partnerOrganizationId != null) return TaskWhereKind.PARTNER
            if (keys.meetingId != null) return TaskWhereKind.MEETING
        }
        return if (subject == null) TaskWhereKind.NO_SUBJECT else TaskWhereKind.SUBJECT
    }

    /** `MobileTaskWhere.text`: "Partner · Echos", or the kind alone when no name is in hand. */
    fun text(kindTitle: String, kind: TaskWhereKind, name: String?): String {
        val title = name?.trim()
        if (title.isNullOrEmpty() || kind == TaskWhereKind.NO_SUBJECT) return kindTitle
        return "$kindTitle · $title"
    }
}

/**
 * `CrmTaskDraft`: a task on its way into the editor and back. A new task
 * starts on the team side, pending and undated; the creator is its
 * assignee once the roster names them ([preselectingSelf]).
 */
data class TaskDraft(
    val id: String?,
    val title: String = "",
    val notes: String = "",
    val status: TaskStatus = TaskStatus.PENDING,
    val side: TaskSide = TaskSide.TEAM,
    /** A team member's Core id, only while [side] is the team. */
    val assignedTo: String? = null,
    val due: LocalDate? = null,
    /** The goal this task serves; null is none. Only a project with goals shows the picker. */
    val goalId: String? = null,
) {
    val canSave: Boolean get() = title.isNotBlank()

    /** A task the client owes cannot also be owed by one of us. */
    fun withSide(next: TaskSide): TaskDraft = copy(side = next, assignedTo = if (next == TaskSide.TEAM) assignedTo else null)

    /** Fill a new team task's assignee with the signed-in member, when the roster holds them and nobody is picked. */
    fun preselectingSelf(team: List<CrmTeamMember>, selfEmail: String?): TaskDraft {
        if (id != null || side != TaskSide.TEAM || assignedTo != null) return this
        val email = selfEmail?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return this
        val mine = team.firstOrNull { it.email?.lowercase() == email } ?: return this
        return copy(assignedTo = mine.id)
    }

    /** `createCrmTask`: filed on [subject], which a new task needs; the subject's kind picks the key. */
    fun create(subject: SubjectRef, zone: ZoneId = ZoneId.systemDefault()): CrmTaskCreate {
        val trimmedNotes = notes.trim()
        return CrmTaskCreate(
            title = title.trim(),
            notes = if (trimmedNotes.isEmpty()) Patch.Omit else Patch.Value(trimmedNotes),
            status = status.value,
            responsibleParty = side.value,
            assignedTo = Patch.of(assignedTo),
            dueDate = due?.let { Patch.Value(TaskDates.wire(it, zone)) } ?: Patch.Omit,
            projectId = if (subject.kind == CrmSubjectKind.PROJECT) Patch.Value(subject.id) else Patch.Omit,
            leadId = if (subject.kind == CrmSubjectKind.LEAD) Patch.Value(subject.id) else Patch.Omit,
            eventId = if (subject.kind == CrmSubjectKind.EVENT) Patch.Value(subject.id) else Patch.Omit,
            organizationId = if (subject.isPartner) Patch.Value(subject.id) else Patch.Omit,
            goalId = goalId?.let { Patch.Value(it) } ?: Patch.Omit,
        )
    }

    /**
     * `updateCrmTask` from the editor: every field it shows, sent; an empty
     * date or assignee clears. The goal goes only when the picker was shown
     * ([withGoal]): no goals read means the goal is left as it was.
     */
    fun update(zone: ZoneId = ZoneId.systemDefault(), withGoal: Boolean = false): CrmTaskUpdate = CrmTaskUpdate(
        title = title.trim(),
        notes = Patch.Value(notes.trim()),
        status = status.value,
        responsibleParty = side.value,
        assignedTo = Patch.of(assignedTo),
        dueDate = Patch.of(due?.let { TaskDates.wire(it, zone) }),
        goalId = if (withGoal) Patch.of(goalId) else Patch.Omit,
    )

    companion object {
        fun of(task: CrmTaskWire, zone: ZoneId = ZoneId.systemDefault()) = TaskDraft(
            id = task.id,
            title = task.title,
            notes = task.notes.orEmpty(),
            status = TaskStatus.of(task.status),
            side = TaskSide.of(task.responsibleParty),
            assignedTo = task.assigneeId,
            due = TaskDates.day(task.dueDate, zone),
            goalId = task.goalId,
        )
    }
}

/** The one-field writes rows make (`CrmTaskUpdate.completion`, `.proposalDecision`). */
object TaskWrites {
    fun completion(done: Boolean) = CrmTaskUpdate(status = (if (done) TaskStatus.COMPLETED else TaskStatus.PENDING).value)
    fun proposalDecision(accepted: Boolean) = CrmTaskUpdate(status = (if (accepted) TaskStatus.PENDING else TaskStatus.DECLINED).value)

    /** Cancel from a row menu: the task will not be done. Status only. */
    val cancellation = CrmTaskUpdate(status = TaskStatus.CANCELLED.value)

    /** Assign to… from a row menu: the person, and our side, since one of us now owes it. */
    fun assignment(memberId: String) = CrmTaskUpdate(responsibleParty = TaskSide.TEAM.value, assignedTo = Patch.Value(memberId))

    /** A goal set from the editor, or cleared. */
    fun goal(goalId: String?) = CrmTaskUpdate(goalId = Patch.of(goalId))

    /**
     * Move to…: the one subject the task goes onto, and where it
     * was (`moved_from`, the one key set), so the Worker drops that list from its cache.
     */
    fun move(from: TaskKeys, to: SubjectRef): CrmTaskUpdate {
        val movedFrom = when {
            from.projectId != null -> CrmTaskSubjectRefWire(projectId = Patch.Value(from.projectId))
            from.leadId != null -> CrmTaskSubjectRefWire(leadId = Patch.Value(from.leadId))
            from.eventId != null -> CrmTaskSubjectRefWire(eventId = Patch.Value(from.eventId))
            from.partnerOrganizationId != null -> CrmTaskSubjectRefWire(organizationId = Patch.Value(from.partnerOrganizationId!!))
            from.meetingId != null -> CrmTaskSubjectRefWire(meetingId = Patch.Value(from.meetingId))
            else -> null
        }
        val base = CrmTaskUpdate(movedFrom = movedFrom)
        return when (to.kind) {
            CrmSubjectKind.PROJECT -> base.copy(projectId = Patch.Value(to.id))
            CrmSubjectKind.LEAD -> base.copy(leadId = Patch.Value(to.id))
            CrmSubjectKind.EVENT -> base.copy(eventId = Patch.Value(to.id))
            CrmSubjectKind.ORGANIZATION -> base.copy(organizationId = Patch.Value(to.id))
            else -> base.copy(meetingId = Patch.Value(to.id))
        }
    }

    /** File on GitHub: the task becomes an issue on its project's repository, claimed by the task. */
    fun promotion(projectId: String, taskId: String, title: String, body: String?) =
        work.starlings.contracts.CrmIssueCreate(projectId = projectId, taskId = taskId, title = title, body = body)
}

/** `WorkIssueStateChange`: close, close as not planned, or reopen. */
enum class IssueStateChange(val state: String, val reason: String?) {
    CLOSE("closed", "completed"),
    CLOSE_NOT_PLANNED("closed", "not_planned"),
    REOPEN("open", null),
}

/** `CrmIssueUpdate.stateChange`: the state and its reason; [projectId] names the channel that hears of it. */
object IssueWrites {
    fun stateChange(change: IssueStateChange, issue: CrmIssueWire, projectId: String?) = CrmIssueUpdate(
        owner = issue.owner, repo = issue.repo, number = issue.number, projectId = projectId,
        state = CrmIssueState(change.state), stateReason = change.reason?.let(::CrmIssueUpdateStateReason),
    )

    /** `CrmIssueUpdate.assignment`: the member's login as the whole assignee set; null without a login. */
    fun assignment(issue: CrmIssueWire, member: CrmTeamMember): CrmIssueUpdate? {
        val login = member.githubLogin?.takeIf { it.isNotEmpty() } ?: return null
        return CrmIssueUpdate(owner = issue.owner, repo = issue.repo, number = issue.number, assignees = listOf(login))
    }

    /**
     * `assignableTeam` (Sources/WorkRowActions.swift): people by name, then
     * agents by name; you first, named [meLabel]. [needsGithub] keeps only
     * members with a GitHub login, for an issue.
     */
    fun assignableTeam(team: List<CrmTeamMember>, me: String?, meLabel: String, needsGithub: Boolean): List<CrmTeamMember> {
        val mine = me?.trim()?.lowercase().orEmpty()
        val people = team
            .filter { !needsGithub || !it.githubLogin.isNullOrEmpty() }
            .sortedWith(compareBy<CrmTeamMember>({ it.kind?.value == "agent" }, { it.name.lowercase() }))
        val you = people.firstOrNull { mine.isNotEmpty() && it.email?.trim()?.lowercase() == mine } ?: return people
        return listOf(you.copy(name = meLabel)) + people.filter { it !== you }
    }
}

/** MINE's Recently finished: your own work closed this week, of the type the Type menu names. */
object RecentlyFinished {
    fun shown(items: List<CrmRecentlyClosedItemWire>, origin: work.starlings.android.MineOriginFilter): List<CrmRecentlyClosedItemWire> =
        items.filter { origin == work.starlings.android.MineOriginFilter.ALL || it.kind.value == origin.wire }
}

/** `MobileTaskView.partial`: what Mine knows, in the reader's shape, until the full record lands. */
fun CrmMyTaskWire.partialTask(): CrmTaskWire = CrmTaskWire(
    id = id, title = title, status = status, responsibleParty = responsibleParty,
    dueDate = dueDate, priority = priority,
    projectId = projectId, leadId = leadId, eventId = eventId, organizationId = organizationId, meetingId = meetingId,
    updatedAt = updatedAt, githubOwner = githubOwner, githubRepo = githubRepo, githubIssueNumber = githubIssueNumber,
)

/** `SubjectGroup`: the rail group a subject is drawn in. */
enum class SubjectGroup(val wire: String) { ENVISIONING("envisioning"), CLIENTS("clients"), PARTNERS("partners"), EVENTS("events"), SALES("sales") }

/** `ResolvedSubjectState`: what the rail reads. */
data class ResolvedSubjectState(val listed: Boolean, val starred: Boolean, val muted: Boolean) {
    companion object {
        val PLAIN = ResolvedSubjectState(listed = true, starred = false, muted = false)
    }
}

/** `SubjectState` (Sources/SubjectState.swift), held to `fixtures/subject-state.json`. */
object SubjectState {
    /** The workspace's project group name: the active workspace's (#1187). */
    val PROJECT_GROUP_NAME: String get() = work.starlings.android.Workspaces.active.name

    fun key(kind: String, id: String): String = "$kind:$id"

    /** Core's `internal` flag decides; only without it does the "Envisioning " prefix. */
    fun group(kind: String, title: String, isInternal: Boolean?, projectGroupName: String = PROJECT_GROUP_NAME): SubjectGroup =
        when (CrmSubjectKind.of(kind)) {
            CrmSubjectKind.ORGANIZATION -> SubjectGroup.PARTNERS
            CrmSubjectKind.EVENT -> SubjectGroup.EVENTS
            CrmSubjectKind.LEAD -> SubjectGroup.SALES
            else -> if (isInternal ?: title.startsWith("$projectGroupName ")) SubjectGroup.ENVISIONING else SubjectGroup.CLIENTS
        }

    private fun groupKind(group: SubjectGroup): String = when (group) {
        SubjectGroup.ENVISIONING, SubjectGroup.CLIENTS -> "project"
        SubjectGroup.PARTNERS -> "organization"
        SubjectGroup.EVENTS -> "event"
        SubjectGroup.SALES -> "lead"
    }

    /** Absent star and mute are false. Listed: not muted, and not a hidden kind (an older Worker: a lead while Sales is off). */
    fun resolve(group: SubjectGroup, salesEnabled: Boolean, hiddenKinds: List<String>?, starred: Boolean?, muted: Boolean?): ResolvedSubjectState {
        val isMuted = muted == true
        val kindHidden = hiddenKinds?.contains(groupKind(group)) ?: (group == SubjectGroup.SALES && !salesEnabled)
        return ResolvedSubjectState(listed = !isMuted && !kindHidden, starred = starred == true, muted = isMuted)
    }
}

/** The person's subject state as the Work tab holds it: the prefs and one override per subject. */
data class SubjectStates(
    val salesEnabled: Boolean = false,
    val hiddenKinds: List<String>? = null,
    val rows: Map<String, SubjectStateRow> = emptyMap(),
    /** False before the Worker answered: every subject reads plain, as iOS `.unknown`. */
    val known: Boolean = false,
) {
    fun resolved(subject: CrmSubjectWire): ResolvedSubjectState {
        if (!known) return ResolvedSubjectState.PLAIN
        val row = rows[SubjectState.key(subject.kind.value, subject.id)]
        val group = SubjectState.group(subject.kind.value, subject.title, subject.isInternal)
        return SubjectState.resolve(group, salesEnabled, hiddenKinds, row?.starred, row?.muted)
    }
}

/** SUBJECTS on Work: the listed subjects (all of them while searching), ranked and cut by `WorkSubjectRanker.rail`. */
object SubjectRail {
    fun rail(
        subjects: List<CrmSubjectWire>,
        states: SubjectStates,
        searching: Boolean,
        unread: Set<String>,
        now: Long,
        holding: String?,
        previous: List<String>,
    ): List<CrmSubjectWire> {
        val listed = subjects.distinctBy { SubjectState.key(it.kind.value, it.id) }.filter { searching || states.resolved(it).listed }
        val byId = listed.associateBy { it.id }
        val ranked = WorkSubjectRanker.rail(
            listed.map {
                WorkRankSubject(
                    id = it.id, title = it.title, kind = it.kind.value,
                    openTasks = (it.openTasks ?: 0).toInt(), overdueTasks = (it.overdueTasks ?: 0).toInt(),
                    lastActivityAt = it.lastActivityAt, eventDate = it.eventDate,
                )
            },
            signals = listed.associate { it.id to WorkRankSignals(starred = states.resolved(it).starred, unread = it.id in unread) },
            now = now, holding = holding, previous = previous,
        )
        return ranked.mapNotNull { byId[it.subject.id] }
    }
}

/** A board card (`ProjectedWorkCard` over `CrmTask` or `CrmIssue`): the board's own task and issue shapes. */
sealed interface BoardItem : WorkCard {
    data class Task(val task: CrmTaskWire, override val workDueDate: Long?, override val workUpdatedAt: Long?) : BoardItem {
        val status: TaskStatus get() = TaskStatus.of(task.status)
        override val workId: String get() = task.id
        override val workOrigin: WorkItemOrigin get() = WorkItemOrigin.TASK
        override val workIsDone: Boolean get() = status.isFinished
        override val workIsFiled: Boolean get() = TaskKeys.of(task).isFiled
        override val workGithubRef: String? get() = githubRef(task.githubOwner, task.githubRepo, task.githubIssueNumber)
        override val workTaskStatus: String get() = status.wire
        override val workAssignee: String? get() = task.assigneeId
        override val workResponsibleParty: String get() = task.responsibleParty
    }

    data class Issue(val issue: CrmIssueWire, override val workUpdatedAt: Long?) : BoardItem {
        override val workId: String get() = issue.id
        override val workOrigin: WorkItemOrigin get() = WorkItemOrigin.ISSUE
        override val workIsDone: Boolean get() = issue.state != CrmIssueState.OPEN
        override val workIsFiled: Boolean get() = true
        override val workDueDate: Long? get() = null
        override val workGithubRef: String? get() = null
        override val workIssueState: String get() = issue.state.value
        override val workIssueStateReason: String? get() = issue.stateReason
        override val workLabels: List<String> get() = issue.labels
        override val workAssignees: List<String>
            get() = issue.assignees?.map { it.login } ?: listOfNotNull(issue.assigneeLogin)
    }

    companion object {
        /** Every card in its column (`WorkItems.board`); finished columns keep what moved since [finishedSince]. */
        fun board(tasks: List<CrmTaskWire>, issues: List<CrmIssueWire>, finishedSince: String?, now: Long, zone: ZoneId): WorkBoard<BoardItem> {
            val items: List<BoardItem> = tasks.map { Task(it, TaskDates.parse(it.dueDate, zone), TaskDates.parse(it.updatedAt, zone)) } +
                issues.map { Issue(it, TaskDates.parse(it.updatedAt, zone)) }
            return WorkItems.board(items, now, zone, TaskDates.parse(finishedSince, zone))
        }
    }
}
