package work.starlings.android.workspace.work

import work.starlings.android.ui.Haptic
import work.starlings.android.ui.HapticWhenSet
import android.content.res.Resources
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.RequestQuote
import androidx.compose.material.icons.outlined.Verified
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.AppEnvironment
import work.starlings.android.R
import work.starlings.android.ThreadMarkdown
import work.starlings.android.api.SubjectRoutes
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkMark
import work.starlings.android.ui.WorkMeta
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkRow
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.android.workspace.LocalFavorites
import work.starlings.android.workspace.LocalWorkspaceNavigator
import work.starlings.android.workspace.MemberSurface
import work.starlings.android.workspace.docs.DocsDocumentSummary
import work.starlings.android.workspace.home.HomeLinks
import work.starlings.android.workspace.team.LocalTeamStore
import work.starlings.android.workspace.team.PeerRow
import work.starlings.android.workspace.team.isAgent
import work.starlings.contracts.CrmContact
import work.starlings.contracts.CrmContactsQuery
import work.starlings.contracts.CrmDecision
import work.starlings.contracts.CrmDecisionCreate
import work.starlings.contracts.CrmGoal
import work.starlings.contracts.CrmGoalCreate
import work.starlings.contracts.CrmGoalUpdate
import work.starlings.contracts.CrmInteraction
import work.starlings.contracts.CrmLicense
import work.starlings.contracts.CrmOffer
import work.starlings.contracts.CrmSubjectDetailWire
import work.starlings.contracts.CrmSubjectDetailWireRelationshipsItem
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.CrmTaskWire
import work.starlings.contracts.CrmTeamMemberKind
import work.starlings.contracts.DecisionSource
import work.starlings.contracts.FormSubmission
import work.starlings.contracts.GoalStatus
import work.starlings.contracts.Patch
import work.starlings.contracts.PeerStatusValue
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * `MobileSubjectOverviewView`'s reads and writes for one subject: its
 * detail (About, the context blocks, related subjects), goals (a project's),
 * decisions, history, documents and a lead's form answers. Tasks and issues
 * are the page's own states ([SubjectTasksState], [SubjectIssuesState]),
 * so Overview and their panes show one list.
 */
internal class SubjectOverviewState(private val store: WorkStore, val subject: SubjectRef) {
    private val client = store.client
    private val detailRoute = WorkRoutes.subjectDetail(subject.kind, subject.id, snapshotted = true)

    var detail by mutableStateOf<CrmSubjectDetailWire?>(client.snapshot(detailRoute)?.value?.subject); private set
    var detailError by mutableStateOf<String?>(null); private set
    var loadingDetail by mutableStateOf(false); private set
    var goals by mutableStateOf<List<CrmGoal>>(emptyList()); private set
    var goalsError by mutableStateOf<String?>(null); private set
    var loadingGoals by mutableStateOf(false); private set
    var decisions by mutableStateOf<List<CrmDecision>>(emptyList()); private set
    var decisionsError by mutableStateOf<String?>(null); private set
    var loadingDecisions by mutableStateOf(false); private set
    var documents by mutableStateOf<List<DocsDocumentSummary>>(emptyList()); private set
    var documentsError by mutableStateOf<String?>(null); private set
    var loadingDocuments by mutableStateOf(false); private set
    var submission by mutableStateOf<FormSubmission?>(null); private set
    var submissionError by mutableStateOf<String?>(null); private set
    var contacts by mutableStateOf<List<CrmContact>>(emptyList()); private set
    var contactsError by mutableStateOf<String?>(null); private set
    var loadingContacts by mutableStateOf(false); private set
    /** True once a contacts read answered: before that the group shows placeholders, not "No contacts.". */
    var contactsRead by mutableStateOf(false); private set
    /** A lead's or an organization's offers, newest first; null while unread or when the Offers module is off. */
    var offers by mutableStateOf<List<CrmOffer>?>(null); private set
    /** Its licenses, newest first; null while unread or when the Licenses module is off. */
    var licenses by mutableStateOf<List<CrmLicense>?>(null); private set
    /** The one read both groups share: its error, its load, and whether it answered. */
    var commercialError by mutableStateOf<String?>(null); private set
    var loadingCommercial by mutableStateOf(false); private set
    var commercialRead by mutableStateOf(false); private set
    /** A goal or decision write the Worker refused. */
    var writeError by mutableStateOf<String?>(null)

    private suspend fun <T> read(set: (String?) -> Unit, loading: (Boolean) -> Unit, empty: Boolean, block: suspend () -> T): T? {
        loading(empty)
        return try {
            block().also { set(null) }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            set(e.workMessage())
            null
        } finally {
            loading(false)
        }
    }

    /** Every read, as `.task(id:)` and `.refreshable` run them. [onMerged] takes a merged id's survivor. */
    suspend fun loadAll(onMerged: suspend (mergedId: String, survivor: CrmSubjectDetailWire) -> Unit) {
        loadGoals()
        loadDecisions()
        loadDocuments()
        loadDetail(onMerged)
        loadSubmission()
        loadContacts()
        loadCommercial()
    }

    suspend fun loadDetail(onMerged: suspend (mergedId: String, survivor: CrmSubjectDetailWire) -> Unit) {
        val fresh = read({ detailError = it }, { loadingDetail = it }, detail == null) { client.call(detailRoute).subject } ?: return
        // A merged id: the page holds the survivor from here on.
        val merged = fresh.mergedFrom
        if (merged != null && fresh.id != subject.id) {
            onMerged(merged, fresh)
            return
        }
        detail = fresh
    }

    suspend fun loadGoals() {
        if (!subject.isProject) return
        read({ goalsError = it }, { loadingGoals = it }, goals.isEmpty()) {
            client.call(work.starlings.android.api.WorkExtraRoutes.goals(subject.id, includeClosed = true)).goals
        }?.let { goals = it }
    }

    suspend fun loadDecisions() {
        read({ decisionsError = it }, { loadingDecisions = it }, decisions.isEmpty()) {
            client.call(SubjectRoutes.decisions(subject.kind, subject.id)).decisions
        }?.let { decisions = it }
    }

    suspend fun loadDocuments() {
        val about = subject.docsSelection().read ?: return
        read({ documentsError = it }, { loadingDocuments = it }, documents.isEmpty()) { store.docs.allDocuments(about, cap = 20).take(20) }
            ?.let { documents = it }
    }

    /**
     * The Contacts group: an organization's contacts, or the contacts a
     * project's `contact_ids` (and `contact_id`) or a lead's `contact_id`
     * name, in the detail's order. A project or lead reads after its detail.
     */
    suspend fun loadContacts() {
        val query = when (subject.kind) {
            CrmSubjectKind.ORGANIZATION -> CrmContactsQuery(organizationId = subject.id, limit = 200)
            CrmSubjectKind.PROJECT, CrmSubjectKind.LEAD -> {
                val read = detail ?: return
                val ids = (if (subject.kind == CrmSubjectKind.LEAD) listOfNotNull(read.contactId) else read.contactIds.orEmpty() + listOfNotNull(read.contactId))
                    .map { it.trim() }.filter { it.isNotEmpty() }.distinct()
                if (ids.isEmpty()) {
                    contacts = emptyList()
                    contactsError = null
                    contactsRead = true
                    return
                }
                CrmContactsQuery(ids = ids.joinToString(","), limit = 200)
            }
            else -> return
        }
        read({ contactsError = it }, { loadingContacts = it }, contacts.isEmpty()) {
            val rows = client.call(WorkExtraRoutes.contactList(query)).contacts
            val order = query.ids?.split(",")
            if (order == null) rows else rows.sortedBy { order.indexOf(it.id).let { i -> if (i < 0) Int.MAX_VALUE else i } }
        }?.let { contacts = it; contactsRead = true }
    }

    /** The Offers and Licenses groups: one read for both, a lead's or an organization's only. */
    suspend fun loadCommercial() {
        if (subject.kind != CrmSubjectKind.LEAD && subject.kind != CrmSubjectKind.ORGANIZATION) return
        read({ commercialError = it }, { loadingCommercial = it }, !commercialRead) {
            client.call(SubjectRoutes.commercial(subject.kind, subject.id))
        }?.let {
            offers = it.offers
            licenses = it.licenses
            commercialRead = true
        }
    }

    suspend fun loadSubmission() {
        if (subject.kind != CrmSubjectKind.LEAD) return
        try {
            submission = client.call(SubjectRoutes.leadSubmission(subject.id)).submission
            submissionError = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            submissionError = e.workMessage()
        }
    }

    /** `makeResponsible` (docs/OWNERSHIP.md): who answers for a project or lead, sent alone. The answer is the stored subject. */
    suspend fun makeResponsible(email: String) {
        try {
            detail = client.call(SubjectRoutes.setResponsible(subject.kind, subject.id, email)).subject
            writeError = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            writeError = e.workMessage()
        }
    }

    suspend fun createGoal(title: String, target: LocalDate?, owner: String?) {
        try {
            client.call(
                SubjectRoutes.createGoal(
                    CrmGoalCreate(
                        projectId = subject.id,
                        title = title.trim(),
                        targetDate = target?.let { Patch.Value(it.toString()) } ?: Patch.Omit,
                        owner = owner?.let { Patch.Value(it) } ?: Patch.Omit,
                    ),
                ),
            )
            loadGoals()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            writeError = e.workMessage()
        }
    }

    suspend fun setGoal(goal: CrmGoal, status: GoalStatus) {
        try {
            client.call(SubjectRoutes.updateGoal(goal.id, CrmGoalUpdate(status = status)))
            loadGoals()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            writeError = e.workMessage()
        }
    }

    suspend fun createDecision(body: String, goalId: String?) {
        try {
            client.call(
                SubjectRoutes.createDecision(
                    CrmDecisionCreate(subjectKind = subject.kind, subjectId = subject.id, body = body.trim(), goalId = goalId?.let { Patch.Value(it) } ?: Patch.Omit),
                ),
            )
            loadDecisions()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            writeError = e.workMessage()
        }
    }
}

/**
 * The lines Overview's rows and blocks say, as iOS words them
 * (`MobileGoalRow`, `MobileDecisionRow`, `CrmInteraction.metadataLabel`,
 * `MobileSubjectOverviewView.aboutBlock`).
 */
internal object OverviewText {
    /** `MobileDayLabel.text`: a civil day or a stamp as a date; anything else is no date. */
    fun day(wire: String?): String? = TaskDates.parse(wire?.trim())?.let(WorkFormat::day)

    /** `MobileGoalRow.metadata`: the target day (late when it is), the status when closed, the owner. */
    fun goal(r: Resources, goal: CrmGoal, today: LocalDate): String = listOfNotNull(
        day(goal.targetDate)?.let { if (Goals.isLate(goal, today)) r.getString(R.string.work_late_day, it) else it },
        when (goal.status) {
            GoalStatus.MET -> r.getString(R.string.work_goal_met)
            GoalStatus.DROPPED -> r.getString(R.string.work_goal_dropped)
            else -> null
        },
        goal.ownerName,
    ).joinToString(" · ")

    /** `MobileDecisionRow.metadata`: the day, who, the client when an agent recorded it, the goal it cites. */
    fun decision(r: Resources, decision: CrmDecision, goals: List<CrmGoal>): String = listOfNotNull(
        day(decision.decidedAt),
        decision.decidedByName,
        decision.sourceRef?.takeIf { decision.source == DecisionSource.AGENT }?.let { r.getString(R.string.work_via, it) },
        decision.goalId?.let { id -> goals.firstOrNull { it.id == id }?.title },
    ).joinToString(" · ")

    /** `CrmInteraction.displayTitle`: the title without Markdown marks. */
    fun interactionTitle(r: Resources, interaction: CrmInteraction): String =
        ThreadMarkdown.plainText(interaction.title).trim().ifEmpty { r.getString(R.string.work_untitled_interaction) }

    fun interactionType(r: Resources, type: String): String = when (type) {
        "meeting" -> r.getString(R.string.work_kind_meeting)
        "email" -> r.getString(R.string.work_email)
        "call" -> r.getString(R.string.work_ix_call)
        "web" -> r.getString(R.string.work_ix_web)
        else -> r.getString(R.string.work_ix_note)
    }

    /** `CrmInteraction.metadataLabel`. */
    fun interaction(r: Resources, interaction: CrmInteraction): String {
        val parts = mutableListOf<String>()
        if (interaction.fromLead == true) parts += r.getString(R.string.work_from_the_lead)
        parts += interactionType(r, interaction.type.value)
        listOf(interaction.occurredAt, interaction.createdAt).firstNotNullOfOrNull { TaskDates.parse(it?.trim()) }?.let { parts += WorkFormat.dateTime(it) }
        interaction.durationMinutes?.let { parts += r.getString(R.string.work_n_min, it.toInt()) }
        val names = interaction.contacts.mapNotNull { contact -> contact.name?.trim()?.takeIf { it.isNotEmpty() } ?: contact.email }
        if (names.isNotEmpty()) parts += names.take(3).joinToString(", ") + if (names.size > 3) " +${names.size - 3}" else ""
        interaction.status?.takeIf { it.isNotEmpty() }?.let { parts += it.replaceFirstChar { c -> c.titlecase() } }
        return parts.joinToString(" · ")
    }

    /** `aboutBlock`'s lines: industry (a partner), status, a lead's checks, dates, the website, notes cut at 180. */
    fun about(r: Resources, kind: CrmSubjectKind, detail: CrmSubjectDetailWire): List<String> {
        val partnerOrProject = kind == CrmSubjectKind.PROJECT || kind == CrmSubjectKind.ORGANIZATION
        val lines = mutableListOf(detail.status)
        if (kind == CrmSubjectKind.LEAD) {
            lines += r.getString(R.string.work_n_qualified, LeadQualification.count(detail.characteristics), LeadQualification.keys.size)
        }
        listOfNotNull(day(detail.startDate), day(detail.endDate)).joinToString(" → ").takeIf { it.isNotEmpty() }?.let { lines += it }
        if (partnerOrProject) detail.url?.takeIf { it.isNotEmpty() }?.let { lines += it }
        (if (partnerOrProject) detail.description else detail.notes)?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += it.take(180) }
        if (kind == CrmSubjectKind.ORGANIZATION) detail.industry?.takeIf { it.isNotEmpty() }?.let { lines.add(0, it) }
        return lines.filter { it.isNotEmpty() }
    }

    /** An Offers row's title: the offer's own, else "Untitled offer". */
    fun offerTitle(r: Resources, offer: CrmOffer): String =
        offer.title?.trim()?.takeIf { it.isNotEmpty() } ?: r.getString(R.string.work_untitled_offer)

    /** An Offers row's line: status · total in its currency · "Valid until <day>". */
    fun offer(r: Resources, offer: CrmOffer): String = listOfNotNull(
        offer.status?.trim()?.takeIf { it.isNotEmpty() }?.let { OfferValues.statusLabel(r, it) },
        if (offer.hasUnsentChanges == true) r.getString(R.string.work_offer_unsent) else null,
        offerAmount(offer),
        day(offer.validUntil)?.let { r.getString(R.string.work_valid_until, it) },
    ).joinToString(" · ")

    /** A Licenses row's title: the product, " · plan" when there is one; else "License". */
    fun licenseTitle(r: Resources, license: CrmLicense): String {
        val product = license.product?.trim()?.takeIf { it.isNotEmpty() }?.let { LicenseText.product(r, it) } ?: return r.getString(R.string.work_license)
        val plan = license.planType?.trim()?.takeIf { it.isNotEmpty() }?.let { LicenseText.plan(r, it) }
        return if (plan == null) product else "$product · $plan"
    }

    /** A Licenses row's line: seats · EUR amount · "Renews <day>", and "Inactive" when it is. */
    fun license(r: Resources, license: CrmLicense): String = listOfNotNull(
        license.seats?.toInt()?.let { r.getQuantityString(R.plurals.work_n_seats, it, it) },
        licenseAmount(license),
        day(license.renewalDate)?.let { r.getString(R.string.work_renews_on, it) },
        if (license.isActive) null else r.getString(R.string.work_inactive),
    ).joinToString(" · ")

    /**
     * An organization's Relationship line: its relationships in the contract's
     * order (client, partner, prospect), each once, joined with " · ". A value
     * [label] does not name is left out. Null when nothing is left.
     */
    fun relationships(
        values: List<CrmSubjectDetailWireRelationshipsItem>?,
        label: (CrmSubjectDetailWireRelationshipsItem) -> String?,
    ): String? {
        val present = values.orEmpty().toSet()
        return CrmSubjectDetailWireRelationshipsItem.known.filter { it in present }.mapNotNull(label)
            .joinToString(" · ").takeIf { it.isNotEmpty() }
    }

    /** An offer's total in its currency (EUR when it names none), or null. */
    fun offerAmount(offer: CrmOffer): String? =
        offer.totalAmount?.let { money(it, offer.currency?.trim()?.takeIf { c -> c.isNotEmpty() } ?: "EUR") }

    /** A license's EUR amount, or null. */
    fun licenseAmount(license: CrmLicense): String? = license.amountEur?.let { money(it, "EUR") }

    /** [CommercialRows.renewsSoon] on the wire's renewal day. */
    fun renewsSoon(license: CrmLicense, today: LocalDate): Boolean =
        CommercialRows.renewsSoon(license.isActive, TaskDates.day(license.renewalDate?.trim()), today)

    /** An amount in [currency]; a code the platform does not know shows as a plain number with it. */
    fun offerMoney(value: Double, currency: String): String = money(value, currency)

    private fun money(value: Double, currency: String): String = runCatching {
        java.text.NumberFormat.getCurrencyInstance().apply { this.currency = java.util.Currency.getInstance(currency.uppercase()) }.format(value)
    }.getOrElse { "${java.text.NumberFormat.getNumberInstance().format(value)} $currency" }

    /** `contextWorkLines`: open and overdue tasks, and a project's repository. */
    fun work(r: Resources, kind: CrmSubjectKind, openTasks: Int, overdue: Int, hasRepo: Boolean): List<String> = buildList {
        add(r.getQuantityString(R.plurals.work_open_tasks_n, openTasks, openTasks))
        if (overdue > 0) add(r.getString(R.string.work_n_overdue, overdue))
        if (kind == CrmSubjectKind.PROJECT) add(r.getString(if (hasRepo) R.string.work_ctx_repo else R.string.work_ctx_no_repo))
    }
}

/**
 * `MobileSubjectOverviewView`: the subject's line, its context blocks
 * (`ContextBlock`), then its groups (`OverviewGroup`), each foldable, at
 * most five rows, Show all opening the pane that holds the rest, and a `+`
 * where the group takes a new item.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SubjectOverviewPane(
    store: WorkStore,
    state: SubjectOverviewState,
    tasks: SubjectTasksState,
    issues: SubjectIssuesState?,
    /** History's rows: the page's own state, so Overview and the History pane show one list. */
    history: SubjectHistoryState,
    inboundAddress: String?,
    onOpenPane: (SubjectPane) -> Unit,
    onNew: (SubjectPane) -> Unit,
    onOpenTask: (CrmTaskWire) -> Unit,
    onOpenSubject: (SubjectRef) -> Unit,
    /** A Contacts row: the contact's page, as Browse and the Partner pane open it. */
    onOpenContact: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val r = context.resources
    val scope = rememberCoroutineScope()
    val favorites = LocalFavorites.current
    val navigator = LocalWorkspaceNavigator.current
    // `app.openTeam(peerEmail:)`: a Team or Agents row opens that conversation in Team.
    val openPeer: (String, Boolean) -> Unit = { email, agent -> navigator?.open(MemberSurface.TEAM, HomeLinks.peer(email, agent)) }
    val subject = state.subject
    val detail = state.detail
    var collapsed by rememberSaveable(subject.id) { mutableStateOf(listOf<String>()) }
    val core = remember { work.starlings.android.core.CoreAccess.of(context) }
    val offersHere = !work.starlings.android.core.CoreLinks.holds("offers", core.coreGroups)
    /** The offer open in its read page. */
    var openOffer by remember { mutableStateOf<String?>(null) }
    var openLicense by remember { mutableStateOf<CrmLicense?>(null) }
    var settling by remember { mutableStateOf<CrmGoal?>(null) }
    var newGoal by remember { mutableStateOf(false) }
    var newDecision by remember { mutableStateOf(false) }
    /** A TASKS row's Delete, while the question is up. */
    var deletingTask by remember { mutableStateOf<Pair<String, String>?>(null) }
    // A task row's "Hand off to …" waiting for its brief.
    var handingOff by remember { mutableStateOf<HandOffRequest?>(null) }
    val onMerged: suspend (String, CrmSubjectDetailWire) -> Unit = { merged, fresh ->
        val survivor = SubjectRef(subject.kind, fresh.id, fresh.title)
        adoptSurvivor(context, store.selfEmail.orEmpty(), favorites, merged, survivor)
        onOpenSubject(survivor)
    }
    LaunchedEffect(subject.id) { state.loadAll(onMerged) }

    fun group(key: String, title: String, count: Int, rows: List<@Composable () -> Unit>, loading: Boolean = false, error: String? = null,
              retry: (() -> Unit)? = null, showAll: SubjectPane? = null, onAdd: (() -> Unit)? = null, addLabel: String? = null): OverviewSection? {
        // A group that can take a new item keeps its header when empty.
        if (onAdd == null && !loading && error == null && rows.isEmpty()) return null
        return OverviewSection(key, title, count, rows, loading, error, retry, showAll?.takeIf { it in SubjectPanes.drawn }?.let { pane -> { onOpenPane(pane) } }, onAdd, addLabel)
    }

    val today = LocalDate.now()
    val now = System.currentTimeMillis()
    val team = LocalTeamStore.current
    val agents = team?.roster?.agents.orEmpty()
    openLicense?.let { license -> LicenseScreen(license, onDismiss = { openLicense = null }) }
    openOffer?.let { id ->
        OfferScreen(store, id, onDismiss = { openOffer = null }, onChanged = { scope.launch { state.loadCommercial() } })
    }
    HandOffHost(store, handingOff, agents, onDismiss = { handingOff = null }) { _, failure -> state.writeError = failure }
    HapticWhenSet(Haptic.ERROR, state.writeError)
    val roster = team?.roster
    val openTasks = (detail?.openTasks?.toInt()) ?: tasks.open.size
    val hasRepo = detail?.hasRepo == true || issues?.linked == true

    val sections = buildList<OverviewSection?> {
        // The context blocks, in the registry's order for this kind.
        ContextBlock.blocks(subject.kind).forEach { block ->
            when (block) {
                ContextBlock.TEAM -> if (roster != null) {
                    val responsible = Responsible.of(subject.kind.value, detail?.responsibleEmail, tasks.tasks.map { Responsible.Task(it.assigneeEmail, it.status) })
                    val everyone = listOfNotNull(roster.me) + roster.people
                    val people = everyone.filter { it.email.lowercase() == responsible?.email } + everyone.filter { it.email.lowercase() != responsible?.email }
                    val around = people.count { it.status != PeerStatusValue.OFFLINE }
                    val unread = team.threads.unreadPeerEmails
                    val rows = if (people.isEmpty()) emptyList() else listOf<@Composable () -> Unit>({
                        val summary = listOf(
                            pluralStringResource(R.plurals.work_n_people, people.size, people.size),
                            stringResource(R.string.work_n_around, around),
                            stringResource(R.string.work_all_members, AppEnvironment.WORKSPACE_NAME),
                        ).joinToString(" · ")
                        WorkNote(summary)
                    }) + people.map { peer ->
                        @Composable {
                            val note = if (peer.email.lowercase() == responsible?.email) {
                                stringResource(if (responsible.chosen) R.string.work_responsible else R.string.work_responsible_suggested)
                            } else null
                            // Make responsible: a person on a project or lead who is not the one chosen.
                            val menu = if (Responsible.offersChoice(subject.kind.value, peer.email, responsible)) {
                                listOf(work.starlings.android.ui.WorkRowAction(stringResource(R.string.work_make_responsible)) { scope.launch { state.makeResponsible(peer.email) } })
                            } else emptyList()
                            work.starlings.android.ui.WorkRowMenu(menu) { long ->
                                Box(
                                    Modifier.fillMaxWidth().combinedClickable(
                                        role = Role.Button, onLongClick = long,
                                        onClick = { if (!peer.isSelf) openPeer(peer.email, peer.isAgent) },
                                    ),
                                ) {
                                    PeerRow(peer, peer.email in unread, note = note)
                                }
                            }
                        }
                    }
                    add(group("team", r.getString(R.string.work_ctx_team), people.size, rows, loading = team.isLoading && people.isEmpty(), error = team.errorMessage,
                        retry = { scope.launch { team.refresh() } }))
                }
                ContextBlock.AGENTS -> {
                    val email = detail?.agentEmail?.trim()
                    val agent = email?.let { address -> roster?.agents?.firstOrNull { it.email.equals(address, ignoreCase = true) } }
                    val row: @Composable () -> Unit = when {
                        agent != null -> {
                            {
                                Box(Modifier.fillMaxWidth().clickable(role = Role.Button) { openPeer(agent.email, true) }) {
                                    PeerRow(agent, agent.email in team?.threads?.unreadPeerEmails.orEmpty())
                                }
                            }
                        }
                        !email.isNullOrEmpty() -> { { WorkNote(stringResource(if (team?.isLoading == true) R.string.work_loading_agent else R.string.work_agent_not_in_roster)) } }
                        else -> { { WorkNote(stringResource(R.string.work_no_agent)) } }
                    }
                    add(group("agents", r.getString(R.string.work_ctx_agents), if (agent == null) 0 else 1, listOf(row)))
                }
                ContextBlock.WORK -> add(
                    group("context-work", r.getString(R.string.work_ctx_work), 0,
                        OverviewText.work(r, subject.kind, openTasks, detail?.overdueTasks?.toInt() ?: 0, hasRepo).map { line -> @Composable { WorkNote(line) } }),
                )
                ContextBlock.RELATIONSHIP -> if (subject.kind == CrmSubjectKind.ORGANIZATION) {
                    OverviewText.relationships(detail?.relationships) { relationship ->
                        when (relationship) {
                            CrmSubjectDetailWireRelationshipsItem.CLIENT -> r.getString(R.string.work_relationship_client)
                            CrmSubjectDetailWireRelationshipsItem.PARTNER -> r.getString(R.string.work_relationship_partner)
                            CrmSubjectDetailWireRelationshipsItem.PROSPECT -> r.getString(R.string.work_relationship_prospect)
                            else -> null
                        }
                    }?.let { line ->
                        add(group("relationship", r.getString(R.string.work_relationship), 0, listOf { WorkNote(line) }))
                    }
                } else detail?.organizationName?.takeIf { it.isNotEmpty() }?.let { organization ->
                    add(group("relationship", r.getString(R.string.work_relationship), 0, listOf { WorkNote(organization) }))
                }
                ContextBlock.ABOUT -> if (detail != null || state.detailError != null || state.loadingDetail) {
                    val lines = detail?.let { OverviewText.about(r, subject.kind, it) }.orEmpty()
                    add(
                        group("about", r.getString(R.string.work_about), 0, lines.map { line -> @Composable { WorkNote(line) } },
                            loading = state.loadingDetail, error = state.detailError, retry = { scope.launch { state.loadDetail(onMerged) } }),
                    )
                }
                ContextBlock.EMAIL -> inboundAddress?.let { address ->
                    add(group("email", r.getString(R.string.work_email), 0, listOf { SelectionContainer { WorkNote(address) } }))
                }
                ContextBlock.WHEN -> add(group("when", r.getString(R.string.work_when), 0, eventWhen(r, detail, null).map { line -> @Composable { SelectionContainer { WorkNote(line) } } }))
                ContextBlock.WHERE -> listOfNotNull(detail?.place, detail?.location).map { it.trim() }.filter { it.isNotEmpty() }.takeIf { it.isNotEmpty() }?.let { lines ->
                    add(group("where", r.getString(R.string.work_where), 0, lines.map { line -> @Composable { SelectionContainer { WorkNote(line) } } }))
                }
                ContextBlock.LINKS -> buildList {
                    detail?.url?.takeIf { it.isNotEmpty() }?.let { add(it) }
                    detail?.partner?.takeIf { it.isNotEmpty() }?.let { add(listOfNotNull(it, detail.partnerUrl).joinToString(" · ")) }
                }.takeIf { it.isNotEmpty() }?.let { lines ->
                    add(group("links", r.getString(R.string.work_links), 0, lines.map { line -> @Composable { SelectionContainer { WorkNote(line) } } }))
                }
                ContextBlock.WEBSITE -> detail?.published?.let { published ->
                    add(group("website", r.getString(R.string.work_website), 0, listOf { WorkNote(stringResource(if (published) R.string.work_listed else R.string.work_not_listed)) }))
                }
                ContextBlock.GOALS -> Unit // a group of the body on iOS (`notOn`)
            }
        }

        // The groups, in the registry's order.
        val has = buildSet {
            if (hasRepo || issues?.issues?.isNotEmpty() == true) add(OverviewGroup.Need.REPO)
            add(OverviewGroup.Need.DOCS)
            addAll(OverviewGroup.moduleNeeds(store.subjectState?.workModules?.map { it.value }))
        }
        OverviewGroup.groups(subject.kind, has).forEach { kind ->
            when (kind) {
                OverviewGroup.GOALS -> add(
                    group(
                        "goals", r.getString(R.string.work_goals), state.goals.size,
                        Goals.sorted(state.goals, today).take(5).map { goal ->
                            @Composable {
                                val late = Goals.isLate(goal, today)
                                WorkRow(goal.title, onClick = { settling = goal }, leading = {
                                    WorkMark(
                                        when {
                                            goal.status == GoalStatus.MET -> Icons.Outlined.CheckCircle
                                            late -> Icons.Outlined.ErrorOutline
                                            else -> Icons.Outlined.Flag
                                        },
                                        color = if (late) Starlings.colors.danger else Starlings.colors.secondary,
                                    )
                                }) { WorkMeta(OverviewText.goal(r, goal, today)) }
                            }
                        },
                        loading = state.loadingGoals, error = state.goalsError, retry = { scope.launch { state.loadGoals() } },
                        onAdd = { newGoal = true; scope.launch { store.loadTeam() } }, addLabel = r.getString(R.string.work_new_goal_label),
                    ),
                )
                OverviewGroup.SUBMISSION -> if (subject.kind == CrmSubjectKind.LEAD && (state.submission != null || state.submissionError != null)) {
                    add(
                        group(
                            "submission", state.submission?.title ?: r.getString(R.string.work_answers), 0,
                            state.submission?.let { listOf<@Composable () -> Unit>({ SubmissionAnswers(it) }) }.orEmpty(),
                            error = state.submissionError, retry = { scope.launch { state.loadSubmission() } },
                        ),
                    )
                }
                // Every task the read answered, as iOS counts and lists them (`tasks.count`).
                OverviewGroup.TASKS -> add(
                    group(
                        "tasks", r.getString(R.string.work_tasks), tasks.tasks.size,
                        tasks.tasks.take(5).map { task ->
                            @Composable {
                                val overdue = TaskDates.isOverdue(task.dueDate, now)
                                val reload = { scope.launch { tasks.load() }; Unit }
                                // The Tasks pane's menu, the star after the row's own actions.
                                val star = work.starlings.android.workspace.favoriteRowAction(work.starlings.android.workspace.FavoriteTargets.task(task.id))
                                val menu = (
                                    if (TaskStatus.of(task.status).isProposed) subjectProposedTaskMenu(r, store, task, reload)
                                    else subjectTaskMenu(r, store, task, subject, reload, agents = agents, handOff = { handingOff = it }) { id, title -> deletingTask = id to title }
                                    ) + listOfNotNull(star)
                                work.starlings.android.ui.WorkRowMenu(menu) { long ->
                                WorkRow(task.title, onClick = { onOpenTask(task) }, onLongClick = long, leading = {
                                    WorkMark(if (overdue) Icons.Outlined.ErrorOutline else Icons.Filled.Check, color = if (overdue) Starlings.colors.danger else Starlings.colors.secondary)
                                }) {
                                    WorkMeta(
                                        listOfNotNull(
                                            WorkFormat.status(r, TaskStatus.of(task.status)),
                                            OverviewText.day(task.dueDate)?.let { r.getString(R.string.work_due_on, it) },
                                        ).joinToString(" · "),
                                    )
                                }
                                }
                            }
                        },
                        loading = tasks.isLoading, error = tasks.refreshError, retry = { scope.launch { tasks.load() } },
                        showAll = kind.showAll, onAdd = { onNew(SubjectPane.TASKS) }, addLabel = r.getString(R.string.work_new_task),
                    ),
                )
                OverviewGroup.ISSUES -> {
                    val list = issues?.issues.orEmpty()
                    add(
                        group(
                            "issues", r.getString(R.string.work_issues), list.size,
                            list.take(5).map { issue ->
                                @Composable {
                                    val open = IssueThread.state(issue.state, issue.stateReason) == IssueThread.State.OPEN
                                    // `stateActions`, then the issues read again.
                                    work.starlings.android.ui.WorkRowMenu(issueStateMenu(r, store, issue, subject.id) { issues?.load() }) { long ->
                                        WorkRow(issue.title, onClick = { onOpenPane(SubjectPane.ISSUES) }, onLongClick = long, leading = {
                                            WorkMark(if (open) Icons.Outlined.Circle else Icons.Outlined.CheckCircle)
                                        }) { WorkMeta("${issue.repo} #${issue.number} · ${issueStateSummary(r, issue)}") }
                                    }
                                }
                            },
                            showAll = kind.showAll,
                            onAdd = if (hasRepo) ({ onNew(SubjectPane.ISSUES) }) else null, addLabel = r.getString(R.string.work_new_issue),
                        ),
                    )
                }
                // The people on the subject: name, then title and, off an organization, where they work.
                OverviewGroup.CONTACTS -> {
                    val onOrganization = subject.kind == CrmSubjectKind.ORGANIZATION
                    // A project or lead waits for its detail; when that read fails, About shows its error and this group stays away.
                    val loading = state.loadingContacts || (!state.contactsRead && state.contactsError == null && state.detailError == null)
                    val rows: List<@Composable () -> Unit> = when {
                        state.contacts.isNotEmpty() -> state.contacts.map { contact ->
                            @Composable {
                                WorkRow(ContactLines.name(contact) ?: r.getString(R.string.work_unnamed), onClick = { onOpenContact(contact.id) }, leading = {
                                    Icon(Icons.Outlined.Person, null, Modifier.size(18.dp), tint = Starlings.colors.secondary)
                                }) {
                                    val line = if (onOrganization) contact.title?.trim().orEmpty() else ContactLines.context(contact)
                                    if (line.isNotEmpty()) WorkMeta(line)
                                }
                            }
                        }
                        !state.contactsRead -> emptyList()
                        else -> listOf { WorkNote(stringResource(R.string.work_no_subject_contacts)) }
                    }
                    add(
                        group(
                            "contacts", r.getString(R.string.work_contacts), state.contacts.size, rows,
                            loading = loading,
                            error = state.contactsError, retry = { scope.launch { state.loadContacts() } },
                        ),
                    )
                }
                // A lead's or an organization's offers and licenses: one read, so one load, error and retry.
                // A null list is a module the workspace has off, and its group stays away.
                OverviewGroup.OFFERS -> if (!state.commercialRead || state.offers != null) {
                    val list = state.offers.orEmpty()
                    val rows: List<@Composable () -> Unit> = when {
                        list.isNotEmpty() -> list.map { offer ->
                            @Composable {
                                // While Core holds the commercial group a row only reads here, as on the web.
                                WorkRow(OverviewText.offerTitle(r, offer), onClick = if (offersHere) ({ openOffer = offer.id }) else null, leading = { WorkMark(Icons.Outlined.RequestQuote) }) {
                                    OverviewText.offer(r, offer).takeIf { it.isNotEmpty() }?.let { WorkMeta(it) }
                                }
                            }
                        }
                        !state.commercialRead -> emptyList()
                        else -> listOf { WorkNote(stringResource(R.string.work_no_offers)) }
                    }
                    add(
                        group(
                            "offers", r.getString(R.string.work_offers), list.size, rows,
                            loading = state.loadingCommercial || (!state.commercialRead && state.commercialError == null),
                            error = state.commercialError, retry = { scope.launch { state.loadCommercial() } },
                        ),
                    )
                }
                OverviewGroup.LICENSES -> if (!state.commercialRead || state.licenses != null) {
                    val list = state.licenses.orEmpty()
                    val rows: List<@Composable () -> Unit> = when {
                        list.isNotEmpty() -> list.map { license ->
                            @Composable {
                                WorkRow(OverviewText.licenseTitle(r, license), onClick = { openLicense = license }, leading = { WorkMark(Icons.Outlined.Key) }) {
                                    val line = OverviewText.license(r, license)
                                    if (line.isNotEmpty()) {
                                        if (OverviewText.renewsSoon(license, today)) {
                                            // Lateness is neutral ink at bold weight (docs/DESIGN.md, colour budget).
                                            Text(line, style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = Starlings.colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        } else {
                                            WorkMeta(line)
                                        }
                                    }
                                }
                            }
                        }
                        !state.commercialRead -> emptyList()
                        else -> listOf { WorkNote(stringResource(R.string.work_no_licenses)) }
                    }
                    add(
                        group(
                            "licenses", r.getString(R.string.work_licenses), list.size, rows,
                            loading = state.loadingCommercial || (!state.commercialRead && state.commercialError == null),
                            error = state.commercialError, retry = { scope.launch { state.loadCommercial() } },
                        ),
                    )
                }
                OverviewGroup.DECISIONS -> add(
                    group(
                        "decisions", r.getString(R.string.work_decisions), state.decisions.size,
                        state.decisions.take(5).map { decision ->
                            @Composable {
                                WorkRow(decision.body, leading = { WorkMark(Icons.Outlined.Verified) }) { WorkMeta(OverviewText.decision(r, decision, state.goals)) }
                            }
                        },
                        loading = state.loadingDecisions, error = state.decisionsError, retry = { scope.launch { state.loadDecisions() } },
                        showAll = kind.showAll, onAdd = { newDecision = true }, addLabel = r.getString(R.string.work_record_decision_label),
                    ),
                )
                OverviewGroup.DOCUMENTS -> add(
                    group(
                        "documents", r.getString(R.string.work_documents), state.documents.size,
                        state.documents.take(5).map { document ->
                            @Composable {
                                WorkRow(document.title, onClick = { onOpenPane(SubjectPane.DOCUMENTS) }, leading = {
                                    Icon(if (document.kind == "pdf") Icons.Outlined.PictureAsPdf else Icons.Outlined.Description, null, Modifier.size(18.dp), tint = Starlings.colors.secondary)
                                }) { WorkMeta(document.path) }
                            }
                        },
                        loading = state.loadingDocuments, error = state.documentsError, retry = { scope.launch { state.loadDocuments() } },
                        showAll = kind.showAll,
                    ),
                )
                OverviewGroup.HISTORY -> add(
                    group(
                        "history", r.getString(R.string.work_history), history.interactions.size,
                        history.interactions.take(5).map { interaction ->
                            @Composable {
                                // A row opens History, as iOS (`onOpenPane(.interactions)`).
                                WorkRow(OverviewText.interactionTitle(r, interaction), onClick = { onOpenPane(SubjectPane.INTERACTIONS) }, leading = {
                                    Icon(interactionIcon(interaction.type.value), null, Modifier.size(18.dp), tint = Starlings.colors.secondary)
                                }) { WorkMeta(OverviewText.interaction(r, interaction)) }
                            }
                        },
                        showAll = kind.showAll,
                    ),
                )
                OverviewGroup.RELATED -> {
                    val related = relatedSubjects(r, detail)
                    val rows = related.take(5).map { (ref, subtitle) ->
                        @Composable {
                            WorkRow(ref.title, onClick = { onOpenSubject(ref) }, leading = {
                                Icon(Icons.AutoMirrored.Filled.CallSplit, null, Modifier.size(18.dp), tint = Starlings.colors.secondary)
                            }) { WorkMeta(subtitle) }
                        }
                    }
                    if (subject.isPartner) {
                        add(group("related", r.getString(R.string.work_related_subjects), related.size, rows,
                            loading = detail == null && state.detailError == null, error = state.detailError, retry = { scope.launch { state.loadDetail(onMerged) } }))
                    } else if ((subject.kind == CrmSubjectKind.LEAD || subject.isProject) && related.isNotEmpty()) {
                        // The lead-to-project edge (ADR 0008). About shows the detail's loading and error.
                        add(group("related", r.getString(if (subject.kind == CrmSubjectKind.LEAD) R.string.work_projects else R.string.work_won_from), related.size, rows))
                    }
                }
            }
        }
    }.filterNotNull()

    LazyColumn(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item("metadata") { OverviewHeader(r, subject, detail, openTasks) }
        state.writeError?.let { message -> item("write-error") { WorkSection { WorkErrorNotice(message) } } }
        sections.forEach { section ->
            item(section.key) {
                val folded = section.key in collapsed
                OverviewGroupSection(section, folded) { collapsed = if (folded) collapsed - section.key else collapsed + section.key }
            }
        }
        item("end") { Spacer(Modifier.padding(bottom = 24.dp)) }
    }

    deletingTask?.let { (id, title) ->
        TaskDeleteDialog(title, onDismiss = { deletingTask = null }) {
            deletingTask = null
            store.act { store.delete(id); tasks.load() }
        }
    }
    settling?.let { goal ->
        GoalSettleDialog(goal, onDismiss = { settling = null }) { status ->
            settling = null
            scope.launch { state.setGoal(goal, status) }
        }
    }
    if (newGoal) {
        GoalEditorSheet(store.team.filter { it.kind != CrmTeamMemberKind.AGENT }.map { it.id to it.name }, onDismiss = { newGoal = false }) { title, target, owner ->
            newGoal = false
            scope.launch { state.createGoal(title, target, owner) }
        }
    }
    if (newDecision) {
        DecisionEditorSheet(Goals.sorted(state.goals.filter(Goals::isLive), today).map { it.id to it.title }, onDismiss = { newDecision = false }) { body, goalId ->
            newDecision = false
            scope.launch { state.createDecision(body, goalId) }
        }
    }
}

/** One group Overview draws: its rows and what its header offers. */
private class OverviewSection(
    val key: String,
    val title: String,
    val count: Int,
    val rows: List<@Composable () -> Unit>,
    val loading: Boolean,
    val error: String?,
    val retry: (() -> Unit)?,
    val showAll: (() -> Unit)?,
    val onAdd: (() -> Unit)?,
    val addLabel: String?,
)

/** `groupSection`: a foldable header with its count and `+`, then the error, the placeholder, or the rows and Show all. */
@Composable
private fun OverviewGroupSection(section: OverviewSection, folded: Boolean, onToggle: () -> Unit) {
    val c = Starlings.colors
    WorkSection(header = {
        WorkFoldTitle(section.title, folded, stringResource(R.string.work_folded), stringResource(R.string.work_open), onToggle)
        if (section.count > 0) Text(" ${section.count}", style = StarlingsType.footnote, color = c.secondary)
        Spacer(Modifier.weight(1f))
        section.onAdd?.let { add -> WorkIconButton(Icons.Filled.Add, section.addLabel.orEmpty(), add, tint = c.secondary) }
    }) {
        if (folded) return@WorkSection
        when {
            section.error != null -> WorkErrorNotice(section.error, retry = section.retry?.let { stringResource(R.string.work_retry) }, onRetry = section.retry)
            section.loading && section.rows.isEmpty() -> WorkPlaceholderRows()
            else -> {
                section.rows.forEachIndexed { index, row ->
                    if (index > 0) WorkDivider()
                    row()
                }
                if (section.showAll != null && section.count > 5) {
                    WorkDivider()
                    Text(
                        stringResource(R.string.work_show_all),
                        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = section.showAll).padding(horizontal = 16.dp, vertical = 11.dp),
                        style = StarlingsType.footnote.copy(fontWeight = FontWeight.Medium), color = c.accent,
                    )
                }
            }
        }
    }
}

/** `metadataSection`: the kind as the header; the title, its line, the status and the open tasks. */
@Composable
private fun OverviewHeader(r: Resources, subject: SubjectRef, detail: CrmSubjectDetailWire?, openTasks: Int) {
    val c = Starlings.colors
    val kind = when (subject.kind) {
        CrmSubjectKind.PROJECT -> R.string.work_kind_project
        CrmSubjectKind.LEAD -> R.string.work_kind_lead
        CrmSubjectKind.EVENT -> R.string.work_kind_event
        else -> R.string.work_field_organization
    }
    WorkSection(modifier = Modifier.padding(top = 8.dp), header = { work.starlings.android.ui.WorkHeaderTitle(r.getString(kind)) }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(detail?.title ?: subject.title, style = StarlingsType.headline, color = c.primary)
            val line = listOfNotNull(detail?.subtitle, detail?.organizationName).filter { it.isNotEmpty() }.joinToString(" · ")
            if (line.isNotEmpty()) Text(line, style = StarlingsType.subheadline, color = c.secondary)
            detail?.status?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
            if (openTasks > 0) Text(r.getQuantityString(R.plurals.work_open_tasks_n, openTasks, openTasks), style = StarlingsType.caption, color = c.secondary)
        }
    }
}

/** `MobileSubmissionAnswers`: the day it came in, then each section's questions with their answers. Selectable. */
@Composable
private fun SubmissionAnswers(submission: FormSubmission) {
    val c = Starlings.colors
    SelectionContainer {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                stringResource(R.string.work_sent_on, OverviewText.day(submission.submittedAt) ?: submission.submittedAt.take(10)),
                style = StarlingsType.footnote, color = c.secondary,
            )
            submission.sections.forEach { section ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(section.title, style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
                    section.answers.forEach { item ->
                        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            Text(item.question, style = StarlingsType.caption, color = c.secondary)
                            Text(item.answer, style = StarlingsType.subheadline, color = c.primary)
                        }
                    }
                }
            }
        }
    }
}

/** A goal has no page: its row settles it. Open offers Met and Drop; a closed one offers Reopen. */
@Composable
private fun GoalSettleDialog(goal: CrmGoal, onDismiss: () -> Unit, onPick: (GoalStatus) -> Unit) {
    val c = Starlings.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(goal.title, style = StarlingsType.headline, color = c.primary) },
        confirmButton = {
            if (goal.status == GoalStatus.OPEN) {
                TextButton({ onPick(GoalStatus.MET) }) { Text(stringResource(R.string.work_goal_met), color = c.primary) }
            } else {
                TextButton({ onPick(GoalStatus.OPEN) }) { Text(stringResource(R.string.work_reopen), color = c.primary) }
            }
        },
        dismissButton = {
            Column {
                if (goal.status == GoalStatus.OPEN) TextButton({ onPick(GoalStatus.DROPPED) }) { Text(stringResource(R.string.work_goal_drop), color = c.danger) }
                TextButton(onDismiss) { Text(stringResource(R.string.work_cancel), color = c.primary) }
            }
        },
    )
}

/** `MobileGoalEditor`: a title, a target day, and an owner from the team. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GoalEditorSheet(team: List<Pair<String, String>>, onDismiss: () -> Unit, onSave: (String, LocalDate?, String?) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var title by remember { mutableStateOf("") }
    var target by remember { mutableStateOf<LocalDate?>(null) }
    var owner by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    WorkSheet(
        r.getString(R.string.work_new_goal), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(R.string.work_save), confirmEnabled = title.isNotBlank(), onConfirm = { onSave(title, target, owner) },
    ) {
        WorkSection {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(title, { title = it.replace('\n', ' ') }, r.getString(R.string.work_goal_prompt))
            }
        }
        WorkSection {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                StarlingsToggle(r.getString(R.string.work_target_date), target != null, { on -> target = if (on) (target ?: LocalDate.now()) else null })
            }
            target?.let { day ->
                WorkDivider()
                WorkLabeledRow(r.getString(R.string.work_by), WorkFormat.day(day.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()), onClick = { picking = true })
            }
        }
        if (team.isNotEmpty()) {
            WorkSection {
                MenuPicker(r.getString(R.string.work_owner), listOf<Pair<String?, String>>(null to r.getString(R.string.work_nobody_yet)) + team, owner) { owner = it }
            }
        }
    }
    if (picking) {
        val state = rememberDatePickerState(initialSelectedDateMillis = (target ?: LocalDate.now()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { picking = false },
            confirmButton = {
                TextButton({
                    state.selectedDateMillis?.let { ms -> target = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate() }
                    picking = false
                }) { Text(stringResource(R.string.work_done), color = c.primary) }
            },
            dismissButton = { TextButton({ picking = false }) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
        ) { DatePicker(state) }
    }
}

/** `MobileDecisionEditor`: what was settled, and the live goal it cites. */
@Composable
private fun DecisionEditorSheet(goals: List<Pair<String, String>>, onDismiss: () -> Unit, onSave: (String, String?) -> Unit) {
    val r = LocalContext.current.resources
    var body by remember { mutableStateOf("") }
    var goal by remember { mutableStateOf<String?>(null) }
    WorkSheet(
        r.getString(R.string.work_record_decision), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(R.string.work_save), confirmEnabled = body.isNotBlank(), onConfirm = { onSave(body, goal) },
    ) {
        WorkSection {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(body, { body = it }, r.getString(R.string.work_decision_prompt), singleLine = false, maxLines = 6)
            }
        }
        if (goals.isNotEmpty()) {
            WorkSection {
                MenuPicker(r.getString(R.string.work_goal), listOf<Pair<String?, String>>(null to r.getString(R.string.work_none)) + goals, goal) { goal = it }
            }
        }
    }
}

/** An event's When (docs/EVENTS.md): the full day, then the start time in the event's zone and the zone's name. */
private fun eventWhen(r: Resources, detail: CrmSubjectDetailWire?, eventDate: String?): List<String> {
    val raw = detail?.eventDate ?: eventDate
    val day = raw?.take(10)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        ?.let { DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).format(it) }
        ?: r.getString(R.string.work_no_date_yet)
    val lines = mutableListOf(day)
    detail?.startAt?.let(TaskDates::parse)?.let { start ->
        val zone = detail.timezone?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: ZoneId.systemDefault()
        val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(zone).format(Instant.ofEpochMilli(start))
        lines += listOfNotNull(time, detail.timezone).joinToString(" ")
    }
    return lines
}

/** `relatedSubjects`: the detail's projects, then its leads, each with its status. */
private fun relatedSubjects(r: Resources, detail: CrmSubjectDetailWire?): List<Pair<SubjectRef, String>> {
    val related = detail?.related ?: return emptyList()
    return related.projects.map {
        SubjectRef(CrmSubjectKind.PROJECT, it.id, it.title?.takeIf { t -> t.isNotEmpty() } ?: r.getString(R.string.work_untitled_project)) to (it.status ?: r.getString(R.string.work_kind_project))
    } + related.leads.map {
        SubjectRef(CrmSubjectKind.LEAD, it.id, it.title?.takeIf { t -> t.isNotEmpty() } ?: r.getString(R.string.work_untitled_lead)) to (it.status ?: r.getString(R.string.work_kind_lead))
    }
}
