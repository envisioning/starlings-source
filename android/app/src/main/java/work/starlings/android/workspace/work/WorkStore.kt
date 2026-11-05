package work.starlings.android.workspace.work

import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticPulse
import work.starlings.android.workspace.QuickNoteFiling
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.Account
import work.starlings.android.MineFilter
import work.starlings.android.OwnerAccount
import work.starlings.android.WorkPlan
import work.starlings.android.api.StarlingsApiError
import work.starlings.android.api.WorkRoutes
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.android.api.CalendarRoutes
import work.starlings.contracts.CalendarEventReply
import work.starlings.contracts.CalendarEventRespondRequest
import work.starlings.contracts.DecisionAskOption
import work.starlings.contracts.InboxDecisionItem
import work.starlings.contracts.InboxForwardedItem
import work.starlings.contracts.InboxInvitationItem
import work.starlings.contracts.InboxResponse
import work.starlings.contracts.InboxSalesItem
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.InboxNoteItem
import work.starlings.contracts.QuickNote
import work.starlings.contracts.CrmGoal
import work.starlings.contracts.QuickNotePromote
import work.starlings.contracts.QuickNotePromotionKind
import work.starlings.contracts.QuickNoteSource
import work.starlings.contracts.QuickNoteState
import work.starlings.contracts.CrmIssueWire
import work.starlings.contracts.CrmRecentlyClosedItemWire
import work.starlings.contracts.CrmRecentlyClosedKind
import work.starlings.contracts.CrmMyTaskWire
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmSubjectWire
import work.starlings.contracts.CrmTaskUpdate
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.CrmTeamMember
import work.starlings.contracts.SubjectStateResponseWire
import work.starlings.contracts.WorkPreferencesUpdate
import work.starlings.contracts.WorkPreferencesUpdateHiddenKindsItem
import java.time.ZoneId

/** What a failed request says on screen: the route's own English title (AGENTS.md: errors stay English). */
internal fun Throwable.workMessage(): String = (this as? StarlingsApiError)?.sentence ?: (message ?: "Something went wrong")

/**
 * `MobileMyWorkStore` and the list state `MobileWorkView` keeps: Mine,
 * Unowned, the subject lists, the person's subject state and the team. One
 * per Work tab, painted from the snapshots first, then read live.
 */
class WorkStore(private val account: OwnerAccount, private val scope: CoroutineScope) {
    /** The signed-in owner, for a screen that opens its own conversation (a subject's Talk). */
    internal val owner: OwnerAccount get() = account
    internal val client get() = account.client

    /** Docs' client for a subject's Documents pane, on the same session and snapshots as the Docs tab. */
    internal val docs: work.starlings.android.workspace.docs.DocsData by lazy {
        work.starlings.android.workspace.docs.DocsData(account.client, account.snapshots, work.starlings.android.workspace.team.TeamMedia(account)) { account.session.credentials()?.email }
    }
    private val zone: ZoneId get() = ZoneId.systemDefault()

    /** The byte routes (an issue's picture), on the same session as [client]. */
    private val media by lazy { work.starlings.android.workspace.team.TeamMedia(account) }

    /** Stores one picture for an issue body and answers its absolute address (`uploadIssueImage`). */
    suspend fun uploadIssueImage(data: ByteArray, contentType: String): String =
        media.upload(WorkExtraRoutes.uploadIssueImage(), work.starlings.contracts.IssueImageResponse.serializer(), data, contentType).url

    /** The contact editor's vocabulary. Null when it cannot be read: the editor still edits what the contact carries. */
    suspend fun contactOptions(): work.starlings.contracts.CrmContactOptionsResponse? =
        runCatching { client.call(WorkExtraRoutes.contactOptions()) }.getOrNull()

    /**
     * Counts the contact writes made here (`mobileContactsDidChange`): the
     * Contacts group reads again when it moves.
     */
    var contactsRevision by mutableStateOf(0); private set

    /** Saves a contact's edit and answers the stored contact. */
    suspend fun updateContact(id: String, update: work.starlings.contracts.CrmContactUpdate): work.starlings.contracts.CrmContactDetail =
        client.call(WorkExtraRoutes.updateContact(id, update)).contact.also { contactsRevision++ }

    /** Adds a contact and answers the stored contact. */
    suspend fun createContact(create: work.starlings.contracts.CrmContactCreate): work.starlings.contracts.CrmContactDetail =
        client.call(WorkExtraRoutes.createContact(create)).contact.also { contactsRevision++ }

    /** Deletes a contact. The Worker refuses while a call or a task references it. */
    suspend fun deleteContact(id: String) {
        client.call(WorkExtraRoutes.deleteContact(id))
        contactsRevision++
    }

    /** Merges [duplicate] and [into]; answers the id the Worker kept (the older one) and the ids it merged away. */
    suspend fun mergeContacts(into: String, duplicate: String): work.starlings.contracts.CoreMergeResponseData =
        client.call(WorkExtraRoutes.mergeContacts(listOf(into, duplicate))).data.also { contactsRevision++ }

    /** The duplicates a merge can pick: a contact search without [own]. */
    suspend fun mergeCandidates(query: String, own: String): List<Pair<String, String>> =
        ContactMerge.candidates(client.call(WorkExtraRoutes.contactSearch(query)).contacts, own)

    /** Edit organization: only what changed; answers the stored subject. */
    suspend fun updateOrganization(id: String, update: work.starlings.contracts.CrmOrganizationUpdate): work.starlings.contracts.CrmSubjectDetailWire =
        client.call(work.starlings.android.api.SubjectRoutes.updateOrganization(id, update)).subject

    /** Merges [duplicate] and [into]; the Worker keeps the older one and names it. */
    suspend fun mergeOrganizations(into: String, duplicate: String): work.starlings.contracts.CoreMergeResponseData =
        client.call(work.starlings.android.api.SubjectRoutes.mergeOrganizations(listOf(into, duplicate))).data

    /** Deletes an organization. The Worker refuses while a record points at it, and says which. */
    suspend fun deleteOrganization(id: String) {
        client.call(work.starlings.android.api.SubjectRoutes.deleteOrganization(id))
    }

    /** The duplicates an organization merge can pick: organizations by name, without [own]. */
    suspend fun organizationMergeCandidates(query: String, own: String): List<Pair<String, String>> =
        searchOrganizations(query).filter { it.first != own }

    /** A partner's page (`MobilePartnerDetailView.load`): the last copy first, then Core. */
    fun partnerSnapshot(id: String): work.starlings.contracts.CrmSubjectDetailWire? =
        client.snapshot(WorkRoutes.subjectDetail(CrmSubjectKind.ORGANIZATION, id, snapshotted = true))?.value?.subject

    suspend fun partner(id: String): work.starlings.contracts.CrmSubjectDetailWire =
        client.call(WorkRoutes.subjectDetail(CrmSubjectKind.ORGANIZATION, id, snapshotted = true)).subject

    var tasks by mutableStateOf<List<CrmMyTaskWire>>(emptyList()); private set
    var issues by mutableStateOf<List<CrmIssueWire>>(emptyList()); private set
    var githubLogin by mutableStateOf<String?>(null); private set
    var unownedTasks by mutableStateOf<List<CrmMyTaskWire>>(emptyList()); private set
    var unownedIssues by mutableStateOf<List<CrmIssueWire>>(emptyList()); private set
    var unownedError by mutableStateOf<String?>(null); private set
    /** The project each UNOWNED issue was read for, by issue id: Filter Unowned's subjects. */
    var unownedIssueSubjects by mutableStateOf<Map<String, work.starlings.contracts.CrmUnownedSubject>>(emptyMap()); private set
    var recentlyClosed by mutableStateOf<List<CrmRecentlyClosedItemWire>>(emptyList()); private set
    var recentlyClosedError by mutableStateOf<String?>(null); private set

    var projects by mutableStateOf<List<CrmSubjectWire>>(emptyList()); private set
    var projectsHasMore by mutableStateOf(false); private set
    var leads by mutableStateOf<List<CrmSubjectWire>>(emptyList()); private set
    var leadsHasMore by mutableStateOf(false); private set
    var events by mutableStateOf<List<CrmSubjectWire>>(emptyList()); private set
    var eventsHasMore by mutableStateOf(false); private set
    var states by mutableStateOf(SubjectStates()); private set
    /** Organizations (ADR 0006), through Core's list filter, Partner on by default. Read behind the three lists, never failing them. */
    var partners by mutableStateOf<List<CrmSubjectWire>>(emptyList()); private set
    var partnersHasMore by mutableStateOf(false); private set

    var team by mutableStateOf<List<CrmTeamMember>>(emptyList()); private set

    /** INBOX: one owner queue, painted from its snapshot (`MobileMyWorkStore.inbox`). */
    var inbox by mutableStateOf<InboxResponse?>(null); private set
    var inboxError by mutableStateOf<String?>(null); private set
    var teamError by mutableStateOf<String?>(null); private set

    var isLoading by mutableStateOf(false); private set
    var mineAnswered by mutableStateOf(false); private set
    /** A failed read with a list behind it, or a failed write: one notice at the top. */
    var errorMessage by mutableStateOf<String?>(null)
    /** `MobileWorkView`'s haptic: a row write that landed, felt where Work is on screen ([HapticPulseEffect] in `WorkScreen`). */
    val haptic = HapticPulse()
    var refreshFailure by mutableStateOf<String?>(null); private set
    /** The subject lists' failed refresh, apart from Mine's. */
    var subjectsError by mutableStateOf<String?>(null); private set

    /** Rows ticked off here and not yet confirmed: hidden, as iOS `optimisticTaskCompletionIDs`. */
    private var completing by mutableStateOf<Set<String>>(emptySet())

    private var searchJob: Job? = null
    private var query = ""

    val selfEmail: String? get() = (account.account.value as? Account.SignedIn)?.email

    /** Sales is the Worker's `sales_enabled`, or the lead kind not hidden, as `BrowseGroupRegistry.isShown(.sales)`. */
    val salesVisible: Boolean
        get() = states.hiddenKinds?.let { "lead" !in it } ?: states.salesEnabled

    fun minePlan(query: String, now: Long = System.currentTimeMillis()): WorkPlan<MineItem> =
        MineWork.plan(tasks.filter { it.id !in completing }, issues, query, now, zone)

    fun unownedPlan(query: String, now: Long = System.currentTimeMillis()): WorkPlan<MineItem> =
        MineWork.plan(unownedTasks.filter { it.id !in completing }, unownedIssues, query, now, zone)

    fun minePlan(query: String, filter: MineFilter, now: Long = System.currentTimeMillis()): WorkPlan<MineItem> =
        minePlan(query, now).filtered(filter, now, zone)

    /** Every subject the lists hold, for SUBJECTS. */
    val allSubjects: List<CrmSubjectWire> get() = projects + events + (if (salesVisible) leads else emptyList())

    fun findTask(id: String): CrmMyTaskWire? = tasks.firstOrNull { it.id == id } ?: unownedTasks.firstOrNull { it.id == id }

    /** A subject a path names: titled from the lists when they hold it, else untitled until [resolveTitle]. */
    fun subjectRef(kind: CrmSubjectKind, id: String): SubjectRef =
        (allSubjects + leads).firstOrNull { it.kind == kind && it.id == id }?.let(SubjectRef::of) ?: SubjectRef(kind, id, "")

    /** The subject's own title, read from Core; null when the read fails (the page keeps its blank bar). */
    suspend fun resolveTitle(subject: SubjectRef): SubjectRef? = try {
        val detail = client.call(WorkRoutes.subjectDetail(subject.kind, subject.id, snapshotted = true)).subject
        subject.copy(title = detail.title)
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        null
    }

    /** Snapshots first, then every live read at once (docs/CACHING.md §Order). */
    fun start() {
        paintSnapshots()
        scope.launch { loadAll(refreshMine = true) }
    }

    private fun paintSnapshots() {
        client.snapshot(WorkRoutes.mine)?.value?.let { applyMine(it.tasks, it.issues, it.githubLogin) }
        client.snapshot(WorkRoutes.inbox)?.value?.let { inbox = it }
        client.snapshot(WorkRoutes.subjectState)?.value?.let(::applyState)
        client.snapshot(WorkRoutes.subjects(CrmSubjectKind.PROJECT, "", OPEN))?.value?.let { projects = it.subjects; projectsHasMore = it.hasMore }
        client.snapshot(WorkRoutes.subjects(CrmSubjectKind.EVENT, "", null))?.value?.let { events = it.subjects; eventsHasMore = it.hasMore }
        client.snapshot(WorkRoutes.subjects(CrmSubjectKind.LEAD, "", OPEN))?.value?.let { leads = it.subjects; leadsHasMore = it.hasMore }
    }

    /** A beat of quiet before asking, so typing a name is one request rather than one per letter. */
    fun search(next: String) {
        if (next.trim() == query.trim()) { query = next; return }
        query = next
        searchJob?.cancel()
        searchJob = scope.launch {
            delay(250)
            loadSubjects()
        }
    }

    suspend fun loadAll(refreshMine: Boolean) {
        isLoading = true
        try {
            val mine = scope.async { if (refreshMine) refreshMine() }
            val subjects = scope.async { loadState(); loadSubjects() }
            val inboxRead = scope.async { refreshInbox() }
            mine.await(); subjects.await(); inboxRead.await()
        } finally {
            isLoading = false
        }
    }

    /** Mine and Unowned: what every write here asks to read again, so Home never lags a poll. */
    suspend fun refreshMine() {
        try {
            val read = client.call(WorkRoutes.mine)
            applyMine(read.tasks, read.issues, read.githubLogin)
            refreshFailure = null
            // `publishWidgetWork`: Today's work draws from this answer's snapshot, so it redraws now.
            work.starlings.android.widgets.WidgetRefresh.now(account.appContext)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            refreshFailure = e.workMessage()
        } finally {
            mineAnswered = true
        }
        refreshRecentlyClosed()
        try {
            val read = client.call(WorkRoutes.unowned)
            unownedTasks = read.tasks
            unownedIssues = read.issues
            unownedIssueSubjects = read.issueSubjects.orEmpty()
            unownedError = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            unownedError = e.workMessage()
        }
    }

    suspend fun refreshInbox() {
        try {
            inbox = client.call(WorkRoutes.inbox)
            inboxError = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            inboxError = e.workMessage()
        }
    }

    /** A row answered here leaves at once; the re-read confirms it, and a refusal brings it back. [landed] is felt when the write lands. */
    private fun inboxWrite(key: String?, landed: Haptic, write: suspend () -> Unit) {
        val before = inbox
        if (key != null) inbox = inbox?.let { WorkInbox.removing(it, key) }
        scope.launch {
            try {
                write()
                errorMessage = null
                haptic.fire(landed)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                inbox = before
                errorMessage = e.workMessage()
            }
            refreshInbox()
        }
    }

    /** A proposed task: Accept files it as pending, Decline as declined. Mine reads again too. */
    fun decideProposal(item: InboxTaskItem, accepted: Boolean) = inboxWrite(item.key, if (accepted) Haptic.SUCCESS else Haptic.DESTRUCTIVE) {
        client.call(WorkRoutes.updateTask(item.task.id, TaskWrites.proposalDecision(accepted)))
        refreshMine()
    }

    fun answerDecision(item: InboxDecisionItem, option: DecisionAskOption, note: String?) = inboxWrite(item.key, Haptic.SUCCESS) {
        client.call(WorkExtraRoutes.answerDecision(item.ask.id, option.key, note))
    }

    /** An invitation's Accept, Maybe or Decline, on the Google event behind it. */
    fun respond(item: InboxInvitationItem, reply: CalendarEventReply) = inboxWrite(item.key, if (reply == CalendarEventReply.DECLINED) Haptic.DESTRUCTIVE else Haptic.SUCCESS) {
        val event = item.event
        client.call(CalendarRoutes.respond(CalendarEventRespondRequest(event.calendarId, WorkInbox.rawEventId(event), reply)))
    }

    fun addForwarded(item: InboxForwardedItem) = inboxWrite(item.key, Haptic.SUCCESS) { client.call(CalendarRoutes.addPending(item.event.id)) }

    fun discardForwarded(item: InboxForwardedItem) = inboxWrite(item.key, Haptic.DESTRUCTIVE) { client.call(CalendarRoutes.discardPending(item.event.id)) }

    /** A booking, an interest or a form: Dismiss is its one resolution. */
    fun dismiss(key: String) = inboxWrite(key, Haptic.DESTRUCTIVE) { client.call(WorkExtraRoutes.setInboxItemDismissed(key, true)) }

    fun dismissTouch(item: InboxSalesItem) = inboxWrite(item.key, Haptic.DESTRUCTIVE) { client.call(WorkExtraRoutes.setSalesInboxDismissed(item.touch.id, true)) }

    /** The host does not want the follow-up; its tasks stay in INBOX. */
    fun dismissFollowUp(item: work.starlings.contracts.InboxFollowUpItem) = inboxWrite(item.key, Haptic.SUCCESS) { client.call(WorkExtraRoutes.dismissFollowUp(item)) }

    /**
     * Approve a follow-up: the kept tasks are accepted, the rest
     * declined. The answer is the mail draft the caller opens; INBOX and Mine
     * read again after.
     */
    suspend fun approveFollowUp(item: work.starlings.contracts.InboxFollowUpItem, accept: List<String>, decline: List<String>): work.starlings.contracts.MeetingFollowUpApproveResponseMail {
        val answer = client.call(WorkExtraRoutes.approveFollowUp(item, accept, decline))
        scope.launch { refreshInbox(); refreshMine() }
        return answer.mail
    }

    // Quick Notes

    /** Captures sent from here and not yet in INBOX's read: drawn first, as iOS draws its outbox. */
    var sendingNotes by mutableStateOf<List<QuickNote>>(emptyList()); private set

    /** INBOX's unfiled notes with this phone's own captures on top. */
    val quickNotes: List<QuickNote>
        get() {
            val known = inbox?.let { WorkInbox.notes(it) }.orEmpty().map { it.note }
            val ids = known.map { it.id }.toSet()
            return sendingNotes.filter { it.id !in ids } + known
        }

    /** `MobileQuickNotesStore.create(source: .work)`: the id is minted here, so a retry cannot duplicate it. */
    fun createNote(body: String) {
        val trimmed = body.trim()
        if (trimmed.isEmpty()) return
        val id = java.util.UUID.randomUUID().toString().lowercase()
        val at = System.currentTimeMillis()
        val stamp = java.time.Instant.ofEpochMilli(at).toString()
        sendingNotes = listOf(QuickNote(id, trimmed, QuickNoteSource.WORK, state = QuickNoteState.OPEN, createdAt = stamp, updatedAt = stamp)) + sendingNotes
        scope.launch {
            try {
                client.call(WorkExtraRoutes.createQuickNote(trimmed, id, at))
                errorMessage = null
                haptic.fire(Haptic.SUCCESS)
                refreshInbox()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                errorMessage = e.workMessage()
            } finally {
                sendingNotes = sendingNotes.filter { it.id != id }
            }
        }
    }

    fun deleteNote(note: QuickNote) {
        val key = inbox?.let { WorkInbox.notes(it) }?.firstOrNull { it.note.id == note.id }?.key
        inboxWrite(key, Haptic.DESTRUCTIVE) { client.call(WorkExtraRoutes.deleteQuickNote(note.id)) }
    }

    /** Make the task or issue, then point the note at it. Throws so the sheet can say why. */
    /**
     * Make the record, then point the note at it. Task and Issue need [subject],
     * Message [threadId] (the note's body is sent as written), Doc a title
     * ([docMessage] is the version line, in `/work`).
     */
    suspend fun fileNote(note: QuickNote, kind: QuickNotePromotionKind, subject: CrmSubjectWire?, threadId: String, title: String, docMessage: String) {
        val made = when (kind) {
            QuickNotePromotionKind.ISSUE -> client.call(WorkExtraRoutes.createIssue(QuickNoteFiling.issue(note.body, title, subject ?: return))).issue.id
            QuickNotePromotionKind.TASK -> client.call(WorkRoutes.createTask(QuickNoteFiling.task(note.body, title, subject ?: return))).task.id
            QuickNotePromotionKind.MESSAGE -> client.call(work.starlings.android.api.TeamRoutes.send(threadId, note.body)).message.id
            QuickNotePromotionKind.DOC -> docs.create(
                work.starlings.android.workspace.docs.DocsCreateDocument(
                    title = title.trim(), folderPath = QuickNoteFiling.DOC_FOLDER, bodyMd = note.body, message = docMessage,
                ),
            ).id
            else -> return
        }
        client.call(WorkExtraRoutes.promoteQuickNote(note.id, QuickNotePromote(kind, made)))
        inbox = inbox?.let { response -> response.copy(items = response.items.filterNot { it is InboxNoteItem && it.note.id == note.id }) }
        scope.launch { refreshInbox(); refreshMine() }
    }

    /** The conversations a note can be sent to as a message. */
    suspend fun conversations(): List<work.starlings.contracts.ThreadSummaryWire> =
        client.call(work.starlings.android.api.TeamRoutes.threads).threads

    /** Organizations a note can be filed under, read when the sheet opens. */
    suspend fun organizations(query: String = ""): List<CrmSubjectWire> =
        client.call(WorkRoutes.subjects(CrmSubjectKind.ORGANIZATION, query, null)).subjects

    /** The starred subjects' keys, which list first in a picker. */
    val starredKeys: Set<String> get() = states.rows.values.filter { it.starred }.map { SubjectState.key(it.kind.value, it.id) }.toSet()

    // Row menus (`MobileMyWorkStore.perform`)

    /** One write from a row's menu; the lists read again after, and a refusal says why at the top. [landed] is felt when it lands. */
    fun act(landed: Haptic? = null, write: suspend () -> Unit) {
        scope.launch {
            try {
                write()
                errorMessage = null
                landed?.let(haptic::fire)
                refreshMine()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                errorMessage = e.workMessage()
            }
        }
    }

    fun cancelTask(id: String) = act(Haptic.DESTRUCTIVE) { client.call(WorkRoutes.updateTask(id, TaskWrites.cancellation)) }

    fun assignTask(id: String, member: CrmTeamMember) = act(Haptic.SUCCESS) { client.call(WorkRoutes.updateTask(id, TaskWrites.assignment(member.id))) }

    /** File on GitHub: an issue on the task's project, claimed by the task. */
    suspend fun fileOnGitHub(id: String, projectId: String, title: String, notes: String?) {
        client.call(WorkExtraRoutes.createIssue(TaskWrites.promotion(projectId, id, title, notes)))
        scope.launch { refreshMine() }
    }

    /** [after] reads the list the row came from again, as Overview re-reads its issues. */
    fun setIssueState(issue: CrmIssueWire, change: IssueStateChange, projectId: String?, after: suspend () -> Unit = {}) =
        act { client.call(WorkExtraRoutes.updateIssue(IssueWrites.stateChange(change, issue, projectId))); after() }

    // New Lead (`MobileSubjectEditorView`, Start a lead)

    /** Creates the lead, then reads INBOX, the subject lists and Mine again: the touch that made it leaves Sales. */
    suspend fun createLead(create: work.starlings.contracts.CrmLeadCreate): SubjectRef {
        val made = client.call(WorkExtraRoutes.createSubject(create)).subject
        scope.launch { loadAll(refreshMine = true) }
        return SubjectRef(CrmSubjectKind.LEAD, made.id, made.title)
    }

    /** The organization picker's search: (id, name). A failure is the picker's error, never an empty list. */
    // The subject editor, Rename and Win (`MobileSubjectEditorView`, `MobileLeadWinView`)

    /** A new project or lead; the lists read again after. */
    suspend fun createSubject(create: work.starlings.contracts.CrmSubjectCreate): work.starlings.contracts.CrmSubjectDetailWire {
        val made = client.call(WorkExtraRoutes.createSubject(create)).subject
        scope.launch { loadAll(refreshMine = false) }
        return made
    }

    /** An edit of a project or a lead, the editor's whole state; the lists read again after. */
    suspend fun updateSubject(kind: CrmSubjectKind, id: String, draft: SubjectForm.Draft): work.starlings.contracts.CrmSubjectDetailWire {
        val saved = when (kind) {
            CrmSubjectKind.LEAD -> client.call(work.starlings.android.api.SubjectRoutes.updateLead(id, SubjectForm.leadUpdate(draft)))
            else -> client.call(work.starlings.android.api.SubjectRoutes.updateProject(id, SubjectForm.projectUpdate(draft)))
        }.subject
        scope.launch { loadAll(refreshMine = false) }
        return saved
    }

    /** Rename: the title alone. Re-query so a rename that no longer matches the search leaves the list. */
    suspend fun renameSubject(kind: CrmSubjectKind, id: String, title: String): work.starlings.contracts.CrmSubjectDetailWire {
        val saved = when (kind) {
            CrmSubjectKind.LEAD -> client.call(work.starlings.android.api.SubjectRoutes.updateLead(id, SubjectForm.renameLead(title)))
            else -> client.call(work.starlings.android.api.SubjectRoutes.updateProject(id, SubjectForm.renameProject(title)))
        }.subject
        loadAll(refreshMine = false)
        return saved
    }

    /** Win (ADR 0008): the Worker creates the project, moves the checked tasks, then closes the lead. */
    suspend fun winLead(id: String, title: String, taskIds: List<String>): work.starlings.contracts.CrmLeadWinResponse {
        val won = client.call(WorkExtraRoutes.winLead(id, work.starlings.contracts.CrmLeadWin(title = work.starlings.contracts.Patch.Value(title.trim()), taskIds = taskIds)))
        scope.launch { loadAll(refreshMine = true) }
        return won
    }

    /** A lead's tasks, for Win's list. */
    suspend fun leadTasks(id: String): List<CrmTaskWire> = client.call(WorkRoutes.tasks(leadId = id)).tasks

    /** The contacts named by [ids], for the editor's names. */
    suspend fun contactsNamed(ids: List<String>): List<Pair<String, String>> =
        client.call(WorkExtraRoutes.contactList(work.starlings.contracts.CrmContactsQuery(ids = ids.joinToString(","))))
            .contacts.map { it.id to (it.name?.takeIf { n -> n.isNotBlank() } ?: it.email ?: it.id) }

    suspend fun searchOrganizations(query: String): List<Pair<String, String>> =
        client.call(WorkExtraRoutes.organizations(query)).organizations.map { it.id to it.name }

    suspend fun createOrganization(name: String): Pair<String, String> =
        client.call(WorkExtraRoutes.createOrganization(name)).organization.let { it.id to it.name }

    /** Leads or projects by name, for a relation picker (`crmSubjects(kind:query:)`): (id, title). */
    suspend fun searchSubjects(kind: CrmSubjectKind, query: String): List<Pair<String, String>> =
        client.call(WorkRoutes.subjects(kind, query, null)).subjects.map { it.id to it.title }

    /** The contact picker's search, through the Worker on every workspace. */
    suspend fun searchContacts(query: String): List<Pair<String, String>> =
        client.call(WorkExtraRoutes.contactSearch(query)).contacts.map { it.id to (it.name?.takeIf { n -> n.isNotBlank() } ?: it.email ?: it.id) }

    private val facets = mutableMapOf<String, IssueFacets>()

    /**
     * What an issue in one repository can be set to, asked once per repository
     * and reused. A failure is [IssueFacets.NONE]: plain rows instead of pickers.
     */
    suspend fun issueFacets(owner: String, repo: String): IssueFacets {
        val key = "${owner.lowercase()}/${repo.lowercase()}"
        facets[key]?.let { return it }
        val found = runCatching { IssueFacets.of(client.call(WorkExtraRoutes.issueFacets(owner, repo))) }.getOrNull() ?: return IssueFacets.NONE
        facets[key] = found
        return found
    }

    /** The facets of a project's primary repository, where a new issue lands; none when it cannot be read. */
    suspend fun primaryFacets(projectId: String): IssueFacets {
        val repos = runCatching { client.call(WorkExtraRoutes.projectRepos(projectId)).repos }.getOrNull() ?: return IssueFacets.NONE
        val primary = repos.firstOrNull { it.isPrimary } ?: repos.firstOrNull() ?: return IssueFacets.NONE
        return issueFacets(primary.owner, primary.repo)
    }

    /** A project's goals for the editor's picker; a failure is an empty list, and the row stays hidden. */
    suspend fun goals(projectId: String): List<CrmGoal> =
        runCatching { client.call(WorkExtraRoutes.goals(projectId, includeClosed = true)).goals }.getOrDefault(emptyList())

    /** Who Unowned's Assign to offers: the team, you first as Me (`assignableTeam`). */
    fun assignable(meLabel: String, needsGithub: Boolean = false): List<CrmTeamMember> =
        IssueWrites.assignableTeam(team, selfEmail, meLabel, needsGithub)

    /** Unowned's Assign to on an issue: the member's GitHub login becomes the issue's whole assignee set. */
    fun assignIssue(issue: CrmIssueWire, member: CrmTeamMember) {
        val update = IssueWrites.assignment(issue, member) ?: return
        act { client.call(WorkExtraRoutes.updateIssue(update)) }
    }

    /** Called when a question sheet saw its request resolved. */
    fun questionResolved() { scope.launch { refreshInbox() } }

    private suspend fun refreshRecentlyClosed() {
        try {
            recentlyClosed = client.call(WorkRoutes.recentlyClosed).items
            recentlyClosedError = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            recentlyClosedError = e.workMessage()
        }
    }

    /** Recently finished's Reopen: a task back to pending, an issue reopened. Mine reads again after. */
    fun reopen(item: CrmRecentlyClosedItemWire) {
        scope.launch {
            try {
                when (item.kind) {
                    CrmRecentlyClosedKind.TASK -> client.call(WorkRoutes.updateTask(item.id, TaskWrites.completion(false)))
                    CrmRecentlyClosedKind.ISSUE -> {
                        val issue = item.issue ?: return@launch
                        client.call(WorkExtraRoutes.updateIssue(IssueWrites.stateChange(IssueStateChange.REOPEN, issue, item.projectId)))
                    }
                }
                errorMessage = null
                refreshMine()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                errorMessage = e.workMessage()
            }
        }
    }

    private fun applyMine(tasks: List<CrmMyTaskWire>, issues: List<CrmIssueWire>, login: String?) {
        this.tasks = tasks
        this.issues = issues
        githubLogin = login
    }

    private suspend fun loadState() {
        runCatching { client.call(WorkRoutes.subjectState) }.onSuccess(::applyState)
    }

    /** The subject-state answer whole: Settings › Work reads its inbox sources and work modules (`MobileMyWorkStore.subjectState`). */
    var subjectState by mutableStateOf<SubjectStateResponseWire?>(null); private set

    /** Settings › Work's read: the state alone, a failure thrown to the page. */
    suspend fun loadSubjectState() = applyState(client.call(WorkRoutes.subjectState))

    /** Which subject kinds you hide in Work, sent whole, as `MobileMyWorkStore.setHiddenKinds`. */
    suspend fun setHiddenKinds(kinds: List<String>) = applyState(
        client.call(WorkRoutes.setWorkPreferences(WorkPreferencesUpdate(hiddenKinds = kinds.map(::WorkPreferencesUpdateHiddenKindsItem)), "Couldn’t change Work")),
    )

    /** One INBOX source on or off: applied in place first, then sent whole; on failure the switch goes back (`setInboxSource`). */
    suspend fun setInboxSource(source: String, on: Boolean) {
        val before = subjectState ?: return
        val next = before.inboxSources + (source to on)
        subjectState = before.copy(inboxSources = next)
        try {
            applyState(client.call(WorkRoutes.setWorkPreferences(WorkPreferencesUpdate(inboxSources = next), "Couldn’t change Inbox")))
        } catch (e: Exception) {
            subjectState = before
            throw e
        }
    }

    /** The Board columns you hide, on every project and device (`subjectState.boardHiddenStages`). */
    val boardHiddenStages: Set<work.starlings.android.WorkStage> get() = BoardColumns.hidden(subjectState)

    /**
     * Hide or show Board columns, as `MobileMyWorkStore.setBoardHiddenStages`:
     * applied in place first, then sent whole; on failure they come back.
     */
    suspend fun setBoardHiddenStages(stages: Set<work.starlings.android.WorkStage>) {
        val before = subjectState ?: return
        subjectState = BoardColumns.with(before, stages)
        try {
            applyState(client.call(WorkRoutes.setWorkPreferences(BoardColumns.update(stages), "Couldn’t change the board")))
        } catch (e: Exception) {
            subjectState = before
            throw e
        }
    }

    /** A subject row's Star or Mute (`setSubjectState`): the row Core keeps replaces this device's. */
    suspend fun setSubjectState(subject: CrmSubjectWire, update: work.starlings.contracts.SubjectStateUpdate) {
        val row = client.call(WorkRoutes.setSubjectState(subject.kind, subject.id, update)).state ?: return
        states = states.copy(rows = states.rows + (SubjectState.key(row.kind.value, row.id) to row))
        subjectState = subjectState?.let { before -> before.copy(states = before.states.filterNot { it.kind == row.kind && it.id == row.id } + row) }
    }

    /** Set your GitHub username (`setGithubLogin`): MINE then finds the issues assigned to it. Blank clears it. */
    suspend fun setGithubLogin(login: String) {
        client.call(WorkExtraRoutes.setGithubLogin(login.trim().ifEmpty { null }))
        refreshMine()
    }

    /** Turn Sales on or off for this person (`setSalesEnabled`), then read the lists again: SALES joins or leaves. */
    suspend fun setSalesEnabled(enabled: Boolean) {
        applyState(client.call(WorkRoutes.setWorkPreferences(WorkPreferencesUpdate(salesEnabled = enabled), "Couldn’t change Sales")))
        loadSubjects()
    }

    private fun applyState(state: SubjectStateResponseWire) {
        subjectState = state
        states = SubjectStates(
            salesEnabled = state.salesEnabled,
            hiddenKinds = state.hiddenKinds?.map { it.value },
            rows = state.states.associateBy { SubjectState.key(it.kind.value, it.id) },
            known = true,
        )
    }

    private suspend fun loadSubjects() {
        val q = query
        try {
            val p = client.call(WorkRoutes.subjects(CrmSubjectKind.PROJECT, q, OPEN))
            val e = client.call(WorkRoutes.subjects(CrmSubjectKind.EVENT, q, null))
            if (q != query) return
            projects = p.subjects; projectsHasMore = p.hasMore
            events = e.subjects; eventsHasMore = e.hasMore
            if (salesVisible) {
                val l = client.call(WorkRoutes.subjects(CrmSubjectKind.LEAD, q, OPEN))
                if (q != query) return
                leads = l.subjects; leadsHasMore = l.hasMore
            }
            subjectsError = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            subjectsError = e.workMessage()
        }
        loadPartners(q)
    }

    /** Core's organization filters, set from the device's kept filter before [start]. */
    var organizationFilter by mutableStateOf(OrganizationFilter())
    /** The industries and countries the organizations carry, for the filter menu. */
    var organizationFacets by mutableStateOf<work.starlings.contracts.CrmSubjectsResponseFacets?>(null); private set

    /** The Organizations group alone, after its filter changed. */
    fun applyOrganizationFilter(next: OrganizationFilter) {
        if (next == organizationFilter) return
        organizationFilter = next
        scope.launch { loadPartners(query) }
    }

    private suspend fun loadPartners(q: String) {
        val filter = organizationFilter
        runCatching { client.call(WorkExtraRoutes.organizationList(filter.query(CrmSubjectKind.ORGANIZATION, q), filter.snapshotTag)) }.onSuccess {
            if (q == query && filter == organizationFilter) {
                partners = it.subjects; partnersHasMore = it.hasMore
                it.facets?.let { found -> organizationFacets = found }
            }
        }
    }

    /** Who work can be assigned to, read once: the roster changes far less often than the tasks. */
    suspend fun loadTeam() {
        if (team.isNotEmpty()) return
        try {
            team = client.call(WorkRoutes.team).members
            teamError = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            teamError = e.workMessage()
        }
    }

    // Writes

    /** Mine's Done: the row leaves at once and comes back if Core refuses. */
    fun complete(task: CrmMyTaskWire) {
        if (task.id in completing) return
        completing = completing + task.id
        scope.launch {
            try {
                client.call(WorkRoutes.updateTask(task.id, TaskWrites.completion(true)))
                errorMessage = null
                haptic.fire(Haptic.SUCCESS)
                refreshMine()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                errorMessage = e.workMessage()
            } finally {
                completing = completing - task.id
            }
        }
    }

    /** One task write; the answer is the stored record. Mine reads again after. */
    suspend fun update(id: String, update: CrmTaskUpdate): CrmTaskWire {
        val task = client.call(WorkRoutes.updateTask(id, update)).task
        scope.launch { refreshMine() }
        return task
    }

    /** One task's full record by id, whatever it is filed on. */
    suspend fun readTask(id: String): CrmTaskWire = client.call(WorkRoutes.task(id)).task

    /** The record from its subject's list, when the by-id read fails and a subject key can ask. */
    suspend fun readFromSubjectList(task: CrmTaskWire): CrmTaskWire? {
        val keys = TaskKeys.of(task)
        return client.call(WorkRoutes.tasks(keys.projectId, keys.leadId, keys.eventId, keys.partnerOrganizationId, keys.meetingId))
            .tasks.firstOrNull { it.id == task.id }
    }

    suspend fun delete(id: String) {
        client.call(WorkRoutes.deleteTask(id))
        tasks = tasks.filter { it.id != id }
        unownedTasks = unownedTasks.filter { it.id != id }
        scope.launch { refreshMine() }
    }

    companion object {
        /** `SubjectStatusRegistry.project.defaultFilter` and the lead's: open. */
        const val OPEN = "open"
    }
}
