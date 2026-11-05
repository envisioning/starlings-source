package work.starlings.android.workspace.work

import android.content.Intent
import android.content.res.Resources
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Label
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CallMerge
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Commit
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.SubjectRoutes
import work.starlings.android.api.TeamRoutes
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.MarkdownText
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkMark
import work.starlings.android.ui.WorkMeta
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkRow
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import work.starlings.android.ui.WorkTopBar
import work.starlings.android.workspace.team.isEvent
import work.starlings.contracts.CrmInteraction
import work.starlings.contracts.CrmInteractionType
import work.starlings.contracts.CrmSubjectKind
import work.starlings.contracts.ThreadMessageRefKind
import work.starlings.contracts.ThreadMessageWire
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * `MobileSubjectInteractionsView`'s state: the interactions filed under one
 * project, lead or organization, and the subject's quiet event trail.
 * Owned by the page, not the pane, so the tab reads "History (n)" and
 * Overview's History group shows the same list before the pane is opened.
 */
internal class SubjectHistoryState(private val store: WorkStore, val subject: SubjectRef) {
    private val client = store.client
    private val query = SubjectRoutes.interactionsQuery(subject.kind, subject.id)

    var interactions by mutableStateOf<List<CrmInteraction>>(emptyList()); private set
    /** Read best-effort beside the interactions; a failure here never becomes [errorMessage]. */
    var events by mutableStateOf<List<ThreadMessageWire>>(emptyList()); private set
    var isLoading by mutableStateOf(false); private set
    var errorMessage by mutableStateOf<String?>(null); private set

    /** `loadCounts`: the tab's count and Overview's rows. A failed read draws nothing. */
    suspend fun loadCount() {
        val query = query ?: return
        try {
            interactions = client.call(SubjectRoutes.interactions(query)).interactions
        } catch (e: Exception) {
            if (e is CancellationException) throw e
        }
    }

    /** The pane's read: the interactions, then the event trail. */
    suspend fun load() {
        val query = query ?: return
        isLoading = interactions.isEmpty()
        try {
            interactions = client.call(SubjectRoutes.interactions(query)).interactions
            errorMessage = null
            // A partner has no thread in this slice (PARTNERS (HQ Docs)).
            events = if (subject.isPartner) emptyList() else loadEvents()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            errorMessage = e.workMessage()
        } finally {
            isLoading = false
        }
    }

    /** The same lines Talk draws, read here so the pane does not need Talk to have been opened. */
    private suspend fun loadEvents(): List<ThreadMessageWire> = try {
        val thread = client.call(TeamRoutes.openSubject(subject.kind, subject.id)).thread
        client.call(TeamRoutes.messages(thread.id, limit = 50)).messages.filter { it.isEvent }
    } catch (e: Exception) {
        if (e is CancellationException) throw e
        emptyList()
    }

    suspend fun save(draft: InteractionDraft): CrmInteraction {
        val saved = draft.original?.let { client.call(SubjectRoutes.updateInteraction(it.id, draft.update)).interaction }
            ?: client.call(SubjectRoutes.createInteraction(draft.create)).interaction
        load()
        return saved
    }

    suspend fun delete(id: String) {
        client.call(SubjectRoutes.deleteInteraction(id))
        load()
    }

    /** `resolveNames`: an edited row names its organization, lead and project by id. A failure leaves the id, which still saves. */
    suspend fun resolveNames(draft: InteractionDraft): InteractionDraft {
        var named = draft
        for ((kind, id) in draft.unnamedLinks) {
            val title = runCatching { client.call(WorkRoutes.subjectDetail(kind, id)).subject.title }.getOrNull() ?: continue
            named = named.named(kind, id, title)
        }
        return named
    }
}

/** History's words for a type, a filter and a day (`CrmInteraction.typeLabel`, `CrmInteractionFilter.title`, `groupTitle`). */
internal object HistoryText {
    fun filter(r: Resources, filter: InteractionFilter): String = when (filter) {
        InteractionFilter.ALL -> r.getString(R.string.work_ix_all_types)
        InteractionFilter.MEETING -> r.getString(R.string.work_ix_meetings)
        InteractionFilter.EMAIL -> r.getString(R.string.work_ix_emails)
        InteractionFilter.CALL -> r.getString(R.string.work_calls)
        InteractionFilter.WEB -> r.getString(R.string.work_ix_web)
        InteractionFilter.NOTE -> r.getString(R.string.work_field_notes)
    }

    fun day(r: Resources, day: HistoryTimeline.Day): String = when (day) {
        HistoryTimeline.Day.Today -> r.getString(R.string.thread_today)
        HistoryTimeline.Day.Yesterday -> r.getString(R.string.thread_yesterday)
        is HistoryTimeline.Day.On -> WorkFormat.day(day.at)
        HistoryTimeline.Day.Undated -> r.getString(R.string.work_filter_undated)
    }

    /** `CrmInteraction.peopleLabel`: three names, then "+n". */
    fun people(interaction: CrmInteraction): String? {
        val names = interaction.contacts.mapNotNull { contact -> contact.name?.trim()?.takeIf { it.isNotEmpty() } ?: contact.email }
        if (names.isEmpty()) return null
        val shown = names.take(3).joinToString(", ")
        return if (names.size > 3) "$shown +${names.size - 3}" else shown
    }

    /** `CrmInteraction.readerBody`: the whole summary, else the row's preview. Markdown. */
    fun body(interaction: CrmInteraction): String? =
        interaction.summaryMarkdown?.trim()?.takeIf { it.isNotEmpty() }
            ?: listOf(interaction.summaryPreview, interaction.transcriptPreview).firstNotNullOfOrNull { it?.trim()?.takeIf { t -> t.isNotEmpty() } }

    /** `CrmInteraction.previewLabel`. */
    fun bodyTitle(r: Resources, interaction: CrmInteraction): String =
        r.getString(if (interaction.summaryPreview?.trim().isNullOrEmpty()) R.string.work_ix_transcript_preview else R.string.work_ix_summary)
}

/** `CrmInteraction.symbolName`. */
internal fun interactionIcon(type: String): ImageVector = when (type) {
    "meeting" -> Icons.Filled.Videocam
    "email" -> Icons.Filled.Email
    "call" -> Icons.Filled.Phone
    "web" -> Icons.Filled.Language
    else -> Icons.Filled.Edit
}

/**
 * `MobileSubjectInteractionsView`: the filter menu over "n of m
 * interactions", then the rows by day, newest first; an event line joins
 * under All types and opens nothing yet. A row opens its reader
 * ([onOpen]). The bar's `+` is Log (`SubjectScreen`).
 */
@Composable
internal fun SubjectHistoryPane(state: SubjectHistoryState, onOpen: (CrmInteraction) -> Unit) {
    val r = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    var filter by remember(state.subject.id) { mutableStateOf(InteractionFilter.ALL) }
    LaunchedEffect(state.subject.id) { state.load() }
    val groups = HistoryTimeline.groups(state.interactions, state.events, filter, LocalDate.now())
    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        state.errorMessage?.let { message ->
            item("error") { WorkSection { WorkErrorNotice(message, retry = r.getString(R.string.work_retry), onRetry = { scope.launch { state.load() } }) } }
        }
        if (state.interactions.isNotEmpty()) {
            item("filter") {
                val matching = state.interactions.count { filter.matches(it) }
                WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_ix_n_of_n, matching, state.interactions.size)) }) {
                    MenuPicker(r.getString(R.string.work_ix_filter), InteractionFilter.entries.map { it to HistoryText.filter(r, it) }, filter) { filter = it }
                }
            }
        }
        groups.forEach { group ->
            item(HistoryText.day(r, group.day)) {
                WorkSection(header = { WorkHeaderTitle(HistoryText.day(r, group.day)) }) {
                    group.rows.forEachIndexed { index, entry ->
                        if (index > 0) WorkDivider()
                        when (entry) {
                            is HistoryTimeline.Entry.Interaction -> InteractionRow(r, entry.interaction) { onOpen(entry.interaction) }
                            is HistoryTimeline.Entry.Event -> EventRow(entry.message)
                        }
                    }
                }
            }
        }
        if (state.interactions.isEmpty() && state.isLoading) item("loading") { WorkSection { WorkPlaceholderRows() } }
        if (groups.isEmpty() && !state.isLoading && state.errorMessage == null) {
            item("empty") {
                WorkSection {
                    WorkNote(
                        if (state.interactions.isEmpty()) r.getString(R.string.work_ix_nothing_filed, state.subject.title)
                        else r.getString(R.string.work_ix_no_match, HistoryText.filter(r, filter).lowercase()),
                    )
                }
            }
        }
        item("end") { Spacer(Modifier.padding(bottom = 24.dp)) }
    }
}

/** `MobileInteractionRow`: the type's mark, the title, and type · when · minutes · people · status. */
@Composable
internal fun InteractionRow(r: Resources, interaction: CrmInteraction, onClick: () -> Unit) {
    WorkRow(OverviewText.interactionTitle(r, interaction), onClick = onClick, leading = {
        WorkMark(interactionIcon(interaction.type.value), size = 18.dp, square = interaction.type == CrmInteractionType.NOTE)
    }) { WorkMeta(OverviewText.interaction(r, interaction)) }
}

/** `MobileEventRow`: the line the work graph wrote, its first ref's mark, and when. Not clickable yet, as on iOS. */
@Composable
private fun EventRow(message: ThreadMessageWire) {
    val kind = message.refs?.firstOrNull()?.kind
    val icon = when (kind) {
        ThreadMessageRefKind.MEETING -> Icons.Filled.Videocam
        ThreadMessageRefKind.TASK -> Icons.Filled.Check
        ThreadMessageRefKind.ISSUE -> Icons.AutoMirrored.Filled.Label
        ThreadMessageRefKind.PULL -> Icons.Filled.CallMerge
        ThreadMessageRefKind.COMMIT -> Icons.Filled.Commit
        ThreadMessageRefKind.RUN -> Icons.Filled.Settings
        ThreadMessageRefKind.RELEASE -> Icons.Filled.Inventory2
        else -> Icons.Filled.Bolt
    }
    WorkRow(message.text, leading = {
        WorkMark(icon, size = 18.dp, square = kind == ThreadMessageRefKind.TASK || kind == ThreadMessageRefKind.ISSUE)
    }) { WorkMeta(WorkFormat.dateTime(message.sentAt)) }
}

/**
 * `MobileInteractionReaderView`: Type, Occurred, People, Duration and
 * Status; the summary as Markdown; Open source; Edit and Delete. A delete
 * asks first and closes the reader.
 */
@Composable
internal fun InteractionReader(
    store: WorkStore,
    state: SubjectHistoryState,
    initial: CrmInteraction,
    organization: Relation?,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val r = context.resources
    val scope = rememberCoroutineScope()
    var interaction by remember(initial.id) { mutableStateOf(initial) }
    var editing by remember { mutableStateOf<InteractionDraft?>(null) }
    var deleting by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    BackHandler(onBack = onBack)
    Column(Modifier.fillMaxSize().background(Starlings.colors.canvas)) {
        WorkTopBar(OverviewText.interactionTitle(r, interaction), r.getString(R.string.work_back), onBack)
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            item("facts") {
                WorkSection {
                    WorkLabeledRow(r.getString(R.string.work_type), OverviewText.interactionType(r, interaction.type.value))
                    HistoryTimeline.date(interaction)?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_ix_occurred), WorkFormat.dateTime(it)) }
                    HistoryText.people(interaction)?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_people), it) }
                    interaction.durationMinutes?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_ix_duration), r.getString(R.string.work_ix_n_minutes, it.toInt())) }
                    interaction.status?.takeIf { it.isNotEmpty() }?.let {
                        WorkDivider()
                        WorkLabeledRow(r.getString(R.string.work_status), it.replaceFirstChar { c -> c.titlecase() })
                    }
                }
            }
            item("body") {
                WorkSection(header = { WorkHeaderTitle(HistoryText.bodyTitle(r, interaction)) }) {
                    val body = HistoryText.body(interaction)
                    if (body != null) {
                        Box(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) { MarkdownText(body) }
                    } else {
                        WorkNote(r.getString(R.string.work_ix_no_summary))
                    }
                }
            }
            interaction.url?.let { raw -> runCatching { Uri.parse(raw) }.getOrNull()?.takeIf { it.scheme != null } }?.let { uri ->
                item("source") {
                    WorkSection {
                        WorkActionRow(r.getString(R.string.work_ix_open_source), { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) } })
                    }
                }
            }
            error?.let { message -> item("error") { WorkSection { WorkErrorNotice(message) } } }
            item("actions") {
                WorkSection {
                    WorkActionRow(r.getString(R.string.work_edit), { editing = InteractionDraft.editing(interaction, state.subject, organization) }, enabled = !busy)
                    WorkDivider()
                    WorkActionRow(r.getString(R.string.work_delete), { deleting = true }, enabled = !busy, danger = true)
                }
            }
            item("end") { Spacer(Modifier.padding(bottom = 24.dp)) }
        }
    }
    if (deleting) {
        TaskDeleteDialog(OverviewText.interactionTitle(r, interaction), onDismiss = { deleting = false }) {
            deleting = false
            if (busy) return@TaskDeleteDialog
            busy = true
            scope.launch {
                try {
                    state.delete(interaction.id)
                    error = null
                    onBack()
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    error = e.workMessage()
                } finally {
                    busy = false
                }
            }
        }
    }
    editing?.let { draft ->
        InteractionEditorSheet(store, state, draft, onDismiss = { editing = null }) { saved ->
            editing = null
            interaction = saved
            error = null
        }
    }
}

/** `DatePicker(…, displayedComponents: [.date, .hourAndMinute])`: the label, then the day and the 24-hour time, each its own tap. */
@Composable
private fun DateTimeRow(label: String, ms: Long, onDay: () -> Unit, onTime: () -> Unit) {
    val c = Starlings.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
        ValueChip(WorkFormat.day(ms), "$label, ${WorkFormat.day(ms)}", onDay)
        Spacer(Modifier.width(8.dp))
        ValueChip(WorkFormat.time(ms), "$label, ${WorkFormat.time(ms)}", onTime)
    }
}

@Composable
private fun ValueChip(text: String, spoken: String, onClick: () -> Unit) {
    val c = Starlings.colors
    Text(
        text,
        Modifier
            .background(c.field, RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button }
            .padding(horizontal = 10.dp, vertical = 6.dp),
        style = StarlingsType.body,
        color = c.primary,
    )
}

/**
 * `MobileInteractionEditor`: Log or Edit. Type, Title, the date and time,
 * Summary, Link, then where it is filed (Organization, Lead, Project) and
 * the Contacts. The sheet owns the write: a refusal stays on it in red,
 * with the draft intact.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun InteractionEditorSheet(
    store: WorkStore,
    state: SubjectHistoryState,
    initial: InteractionDraft,
    onDismiss: () -> Unit,
    onSaved: (CrmInteraction) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var draft by remember(initial.original?.id) { mutableStateOf(initial) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf<Boolean?>(null) } // false: the day; true: the time
    LaunchedEffect(initial.original?.id) { draft = state.resolveNames(draft) }

    fun save() {
        if (!draft.canSave || saving) return
        saving = true
        scope.launch {
            try {
                val saved = state.save(draft)
                error = null
                onSaved(saved)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                error = e.workMessage()
            } finally {
                saving = false
            }
        }
    }

    WorkSheet(
        r.getString(if (draft.isNew) R.string.work_log else R.string.work_edit), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(R.string.work_save), confirmEnabled = draft.canSave && !saving, onConfirm = ::save,
    ) {
        WorkSection {
            MenuPicker(r.getString(R.string.work_type), draft.typeOptions.map { it to OverviewText.interactionType(r, it.value) }, draft.type) { draft = draft.copy(type = it) }
            WorkDivider()
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(draft.title, { draft = draft.copy(title = it.replace('\n', ' ')) }, r.getString(R.string.work_title_field), capitalization = KeyboardCapitalization.Sentences)
            }
            WorkDivider()
            DateTimeRow(r.getString(R.string.work_ix_date_time), draft.occurredAt, onDay = { picking = false }, onTime = { picking = true })
        }
        WorkSection {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(draft.summary, { draft = draft.copy(summary = it) }, r.getString(R.string.work_ix_summary), singleLine = false, maxLines = 10)
            }
        }
        WorkSection {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(draft.url, { draft = draft.copy(url = it.trim()) }, r.getString(R.string.thread_link), keyboardType = KeyboardType.Uri)
            }
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_field_organization)) }) {
            RelationPicker(
                placeholder = r.getString(R.string.work_search_organizations), emptyText = r.getString(R.string.work_no_organizations_match),
                selected = listOfNotNull(draft.organization), onSelected = { draft = draft.copy(organization = it.lastOrNull()) },
                search = store::searchOrganizations,
            )
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_kind_lead)) }) {
            RelationPicker(
                placeholder = r.getString(R.string.work_search_leads), emptyText = r.getString(R.string.work_no_leads_match),
                selected = listOfNotNull(draft.lead), onSelected = { draft = draft.copy(lead = it.lastOrNull()) },
                search = { store.searchSubjects(CrmSubjectKind.LEAD, it) },
            )
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_kind_project)) }) {
            RelationPicker(
                placeholder = r.getString(R.string.work_search_projects), emptyText = r.getString(R.string.work_no_projects_match),
                selected = listOfNotNull(draft.project), onSelected = { draft = draft.copy(project = it.lastOrNull()) },
                search = { store.searchSubjects(CrmSubjectKind.PROJECT, it) },
            )
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_contacts)) }) {
            RelationPicker(
                placeholder = r.getString(R.string.work_search_contacts), emptyText = r.getString(R.string.work_no_contacts_match),
                selected = draft.contacts, onSelected = { draft = draft.copy(contacts = it) },
                search = store::searchContacts, multiple = true,
            )
        }
        error?.let { WorkSection { WorkErrorNotice(it) } }
    }

    val zone = ZoneId.systemDefault()
    val at = Instant.ofEpochMilli(draft.occurredAt).atZone(zone)
    when (picking) {
        false -> {
            val picker = rememberDatePickerState(initialSelectedDateMillis = at.toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
            DatePickerDialog(
                onDismissRequest = { picking = null },
                confirmButton = {
                    TextButton({
                        picker.selectedDateMillis?.let { ms ->
                            val day = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()
                            draft = draft.copy(occurredAt = at.with(day).toInstant().toEpochMilli())
                        }
                        picking = null
                    }) { Text(stringResource(R.string.work_done), color = c.primary) }
                },
                dismissButton = { TextButton({ picking = null }) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
            ) { DatePicker(picker) }
        }
        true -> {
            val picker = rememberTimePickerState(at.hour, at.minute, is24Hour = true)
            AlertDialog(
                onDismissRequest = { picking = null },
                containerColor = c.elevated,
                confirmButton = {
                    TextButton({
                        draft = draft.copy(occurredAt = at.withHour(picker.hour).withMinute(picker.minute).withSecond(0).withNano(0).toInstant().toEpochMilli())
                        picking = null
                    }) { Text(stringResource(R.string.work_done), color = c.primary) }
                },
                dismissButton = { TextButton({ picking = null }) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
                text = { TimePicker(picker) },
            )
        }
        null -> Unit
    }
}
