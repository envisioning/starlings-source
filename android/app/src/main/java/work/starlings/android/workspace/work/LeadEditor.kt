package work.starlings.android.workspace.work

import android.content.res.Resources
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircleOutline
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSheet
import androidx.compose.ui.text.input.KeyboardType
import work.starlings.android.api.WorkRoutes
import work.starlings.contracts.CrmSubjectDetailWire
import work.starlings.contracts.CrmSubjectKind
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** One chosen relation: an id, and the name drawn for it (the id until a name is known). */
internal data class Relation(val id: String, val name: String)

/**
 * `MobileSubjectEditorTarget`: a new project or lead, or an existing one to
 * edit. [prefill] is what Start a lead already knows.
 */
internal data class SubjectEditorTarget(val kind: CrmSubjectKind, val subject: SubjectRef? = null, val prefill: LeadPrefill? = null)

/**
 * `MobileSubjectEditorView`: the fields people keep up in a meeting
 * workflow, for a project or a lead. Name and Status; the dates (a lead
 * always starts on a day, a project's two dates have toggles); a lead's five
 * Qualification checks; the organization (a lead's required); a project's
 * URL and description or a lead's notes; the contacts (one for a lead); and
 * on an existing project its repositories, with Link GitHub repository…
 * An edit reads the live record first, and Save is held back until it is
 * here. [onSaved] gets the saved record.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SubjectEditorSheet(store: WorkStore, target: SubjectEditorTarget, onDismiss: () -> Unit, onSaved: (CrmSubjectDetailWire) -> Unit) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val kind = target.kind
    val isLead = kind == CrmSubjectKind.LEAD
    /** The plan's limit or read-only line, in place of an error. */
    var planMessage by remember { mutableStateOf<String?>(null) }
    val prefill = target.prefill
    var title by remember { mutableStateOf(target.subject?.title ?: prefill?.title.orEmpty()) }
    var status by remember { mutableStateOf(SubjectForm.defaultStatus(kind)) }
    var start by remember { mutableStateOf(LocalDate.now()) }
    var hasStart by remember { mutableStateOf(isLead) }
    var end by remember { mutableStateOf(LocalDate.now()) }
    var hasEnd by remember { mutableStateOf(false) }
    var description by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf(prefill?.notes.orEmpty()) }
    var characteristics by remember { mutableStateOf<Map<String, Boolean>>(emptyMap()) }
    var organization by remember {
        mutableStateOf(prefill?.organizationId?.let { listOf(Relation(it, prefill.organizationName ?: it)) }.orEmpty())
    }
    var contacts by remember {
        mutableStateOf(prefill?.contactId?.let { listOf(Relation(it, prefill.contactName ?: it)) }.orEmpty())
    }
    var repos by remember { mutableStateOf<List<work.starlings.contracts.CrmGithubRepo>>(emptyList()) }
    var pickingRepo by remember { mutableStateOf(false) }
    /** The stored record had no organization: an edit does not ask for one. */
    var hadNoOrganization by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(target.subject != null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pickingDay by remember { mutableStateOf<String?>(null) }
    val kindWord = r.getString(if (isLead) R.string.work_kind_lead else R.string.work_kind_project)
    val heading = r.getString(if (target.subject == null) R.string.work_new_kind else R.string.work_edit_kind, kindWord)

    // An edit reads the live record; the form waits for it, and Save with it.
    LaunchedEffect(target) {
        val subject = target.subject ?: return@LaunchedEffect
        try {
            val detail = store.client.call(WorkRoutes.subjectDetail(kind, subject.id)).subject
            title = detail.title
            status = detail.status.ifEmpty { SubjectForm.defaultStatus(kind) }
            start = SubjectForm.day(detail.startDate) ?: LocalDate.now()
            hasStart = isLead || detail.startDate != null
            end = SubjectForm.day(detail.endDate) ?: LocalDate.now()
            hasEnd = detail.endDate != null
            description = detail.description.orEmpty()
            url = detail.url.orEmpty()
            notes = detail.notes.orEmpty()
            characteristics = detail.characteristics.orEmpty()
            organization = detail.organizationId?.takeIf { it.isNotEmpty() }?.let { listOf(Relation(it, detail.organizationName ?: it)) }.orEmpty()
            hadNoOrganization = detail.organizationId.isNullOrEmpty()
            val ids = if (isLead) listOfNotNull(detail.contactId).filter { it.isNotEmpty() } else detail.contactIds.orEmpty().filter { it.isNotEmpty() }
            contacts = ids.map { Relation(it, it) }
            if (!isLead) repos = runCatching { store.client.call(work.starlings.android.api.WorkExtraRoutes.projectRepos(subject.id)).repos }.getOrDefault(emptyList())
            error = null
            loading = false
            // The ids stay on screen when the names cannot be read: each one still saves.
            if (ids.isNotEmpty()) {
                runCatching { store.contactsNamed(ids) }.getOrNull()?.toMap()?.let { named -> contacts = contacts.map { Relation(it.id, named[it.id] ?: it.name) } }
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
            loading = false
        }
    }

    fun save() {
        if (saving || loading) return
        planMessage = null
        val lacking = if (target.subject != null && hadNoOrganization) setOf("organization") else emptySet()
        SubjectForm.problem(kind, title, organization.firstOrNull()?.id, if (isLead) notes else description, lacking)?.let {
            error = when (it) {
                is SubjectForm.Problem.Required -> r.getString(R.string.work_error_required, SubjectForm.label(kind, it.field))
                is SubjectForm.Problem.TooLong -> r.getString(R.string.work_error_too_long, SubjectForm.label(kind, it.field), it.max)
            }
            return
        }
        val draft = SubjectForm.Draft(
            kind = kind,
            title = title,
            status = status,
            startDate = if (isLead || hasStart) start else null,
            endDate = if (!isLead && hasEnd) end else null,
            description = if (isLead) "" else description,
            url = if (isLead) "" else url,
            notes = if (isLead) notes else "",
            organizationId = organization.firstOrNull()?.id,
            contactIds = if (isLead) listOfNotNull(contacts.firstOrNull()?.id ?: prefill?.contactId) else contacts.map { it.id },
            characteristics = if (isLead) characteristics else emptyMap(),
        )
        saving = true
        scope.launch {
            try {
                val subject = target.subject
                val saved = if (subject == null) store.createSubject(SubjectForm.create(draft)) else store.updateSubject(kind, subject.id, draft)
                onSaved(saved)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                val plan = WorkspacePlanNotice.refusalText(context, e, WorkspacePlanNotice.isAdmin(store.subjectState))
                if (plan != null) {
                    error = null
                    planMessage = plan
                } else {
                    error = e.workMessage()
                }
            } finally {
                saving = false
            }
        }
    }

    WorkSheet(
        heading, r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(if (saving) R.string.work_saving else R.string.work_save),
        confirmEnabled = !saving && !loading && title.isNotBlank(), onConfirm = ::save,
    ) {
        WorkSection(header = { WorkHeaderTitle(heading) }) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                StarlingsField(title, { title = it.replace('\n', ' ') }, caption(r, R.string.work_field_name, required = true))
            }
            WorkDivider()
            MenuPicker(r.getString(R.string.work_status), SubjectForm.statuses(kind).map { it to subjectStatusTitle(r, it) }, status) { status = it }
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_dates)) }) {
            if (isLead) {
                WorkLabeledRow(caption(r, R.string.work_field_start_date, required = true), WorkFormat.civilDay(start)) { pickingDay = "start" }
            } else {
                StarlingsToggle(r.getString(R.string.work_has_start_date), hasStart, { hasStart = it }, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                if (hasStart) {
                    WorkDivider()
                    WorkLabeledRow(r.getString(R.string.work_field_start_date), WorkFormat.civilDay(start)) { pickingDay = "start" }
                }
                WorkDivider()
                StarlingsToggle(r.getString(R.string.work_has_end_date), hasEnd, { hasEnd = it }, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                if (hasEnd) {
                    WorkDivider()
                    WorkLabeledRow(r.getString(R.string.work_field_end_date), WorkFormat.civilDay(end)) { pickingDay = "end" }
                }
            }
        }
        if (isLead) {
            WorkSection(
                header = { WorkHeaderTitle(r.getString(R.string.work_field_qualification)) },
                footer = r.getString(R.string.work_n_qualified, LeadQualification.count(characteristics), LeadQualification.keys.size),
            ) {
                LeadQualification.keys.forEachIndexed { index, key ->
                    if (index > 0) WorkDivider()
                    StarlingsToggle(
                        qualificationTitle(r, key), LeadQualification.isSet(key, characteristics),
                        { characteristics = LeadQualification.merged(characteristics, key, it) },
                        Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
            }
        }
        WorkSection(header = { WorkHeaderTitle(caption(r, R.string.work_field_organization, required = isLead)) }) {
            RelationPicker(
                placeholder = r.getString(R.string.work_search_organizations),
                emptyText = r.getString(R.string.work_no_organizations_match),
                selected = organization, onSelected = { organization = it },
                search = store::searchOrganizations, create = store::createOrganization,
            )
        }
        WorkSection {
            if (isLead) {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    StarlingsField(notes, { notes = it }, r.getString(R.string.work_field_notes), singleLine = false, maxLines = 12)
                }
            } else {
                Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    StarlingsField(url, { url = it.replace('\n', ' ') }, r.getString(R.string.work_field_url), keyboardType = KeyboardType.Uri)
                }
                WorkDivider()
                Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    StarlingsField(description, { description = it }, r.getString(R.string.work_field_description), singleLine = false, maxLines = 8)
                }
            }
        }
        WorkSection(header = { WorkHeaderTitle(r.getString(if (isLead) R.string.work_contact else R.string.work_contacts)) }) {
            RelationPicker(
                placeholder = r.getString(R.string.work_search_contacts),
                emptyText = r.getString(R.string.work_no_matches),
                selected = contacts, onSelected = { contacts = it },
                search = store::searchContacts,
                multiple = !isLead,
            )
        }
        // An existing project only: a new one has no id to link to. The link lands on its own call, apart from Save.
        val project = target.subject
        if (!isLead && project != null) {
            WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_repository)) }) {
                repos.forEach { repo ->
                    Text("@${repo.owner}/${repo.repo}", Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), style = StarlingsType.body, color = c.primary)
                    WorkDivider()
                }
                work.starlings.android.ui.WorkActionRow(r.getString(R.string.work_link_github_repository), { pickingRepo = true }, accent = true)
            }
            if (pickingRepo) {
                RepoPickerSheet(store, project.id, onDismiss = { pickingRepo = false }) { repo ->
                    if (repos.none { it.id == repo.id }) repos = repos + repo
                    pickingRepo = false
                }
            }
        }
        error?.let { WorkSection { WorkErrorNotice(it) } }
        planMessage?.let { WorkSection { WorkspacePlanNoticeRow(it, offersUpgrade = WorkspacePlanNotice.isAdmin(store.subjectState)) } }
        if (saving || loading) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), color = c.secondary, strokeWidth = 2.dp) }
    }

    pickingDay?.let { which ->
        val current = if (which == "end") end else start
        val state = rememberDatePickerState(initialSelectedDateMillis = current.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { pickingDay = null },
            confirmButton = {
                TextButton({
                    state.selectedDateMillis?.let {
                        val day = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()
                        if (which == "end") end = day else start = day
                    }
                    pickingDay = null
                }) { Text(r.getString(R.string.work_done), color = c.primary) }
            },
            dismissButton = { TextButton({ pickingDay = null }) { Text(r.getString(R.string.work_cancel), color = c.primary) } },
        ) { DatePicker(state) }
    }
}

/**
 * `MobileRelationPicker`, one choice or several ([multiple]): the chosen rows with Remove, a search
 * field (two letters at least, a quarter second after typing stops), up
 * to eight hits, and Create organization when [create] is given and no
 * hit has the typed name. A failed search says so; it is never an empty list.
 */
@Composable
internal fun RelationPicker(
    placeholder: String,
    emptyText: String,
    selected: List<Relation>,
    onSelected: (List<Relation>) -> Unit,
    search: suspend (String) -> List<Pair<String, String>>,
    create: (suspend (String) -> Pair<String, String>)? = null,
    /** `allowsMultiple`: a hit adds to the chosen rows instead of replacing them. */
    multiple: Boolean = false,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<Relation>>(emptyList()) }
    var searched by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var creationError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(query) {
        val trimmed = query.trim()
        if (trimmed.length < RelationSearch.MIN_QUERY) { hits = emptyList(); failure = null; searching = false; return@LaunchedEffect }
        delay(250)
        searching = true
        failure = null
        try {
            hits = search(trimmed).map { Relation(it.first, it.second) }
            searched = trimmed
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            hits = emptyList()
            failure = r.getString(R.string.work_couldnt_search, e.workMessage())
        } finally {
            searching = false
        }
    }

    fun choose(option: Relation) {
        onSelected(if (multiple) selected + option else listOf(option))
        query = ""
        hits = emptyList()
        creationError = null
    }

    Column {
        selected.forEach { option ->
            val remove = r.getString(R.string.work_remove_named, option.name)
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Check, null, Modifier.size(16.dp), tint = c.accent)
                Text(option.name, Modifier.weight(1f), style = StarlingsType.body, color = c.primary, maxLines = 1)
                Box(
                    Modifier
                        .size(32.dp)
                        .clickable(role = Role.Button) { onSelected(selected.filter { it.id != option.id }) }
                        .clearAndSetSemantics { contentDescription = remove; role = Role.Button },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Filled.Close, null, Modifier.size(16.dp), tint = c.secondary) }
            }
            WorkDivider()
        }
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { StarlingsField(query, { query = it }, placeholder) }
            if (searching) CircularProgressIndicator(Modifier.padding(start = 8.dp).size(16.dp), color = c.secondary, strokeWidth = 2.dp)
        }
        val taken = selected.map { it.id }.toSet()
        hits.filter { it.id !in taken }.take(8).forEach { option ->
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { choose(option) }.padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.AddCircleOutline, null, Modifier.size(18.dp), tint = c.secondary)
                Text(option.name, style = StarlingsType.body, color = c.primary, maxLines = 1)
            }
        }
        if (create != null && RelationSearch.canCreate(query, searched, hits.map { it.name }, searching, failure != null)) {
            val name = query.trim()
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(enabled = !creating, role = Role.Button) {
                        creating = true
                        creationError = null
                        scope.launch {
                            try {
                                val made = create(name)
                                choose(Relation(made.first, made.second))
                            } catch (e: Exception) {
                                if (e is CancellationException) throw e
                                creationError = e.workMessage()
                            } finally {
                                creating = false
                            }
                        }
                    }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.AddCircleOutline, null, Modifier.size(18.dp), tint = c.secondary)
                Column(Modifier.weight(1f)) {
                    Text(r.getString(R.string.work_create_organization), style = StarlingsType.callout.copy(fontWeight = FontWeight.Medium), color = c.primary)
                    Text(name, style = StarlingsType.footnote, color = c.secondary, maxLines = 1)
                }
                if (creating) CircularProgressIndicator(Modifier.size(16.dp), color = c.secondary, strokeWidth = 2.dp)
            }
        }
        val trimmed = query.trim()
        when {
            searching && hits.isEmpty() -> WorkNote(r.getString(R.string.work_searching))
            failure != null -> WorkErrorNotice(failure!!)
            trimmed.length >= RelationSearch.MIN_QUERY && !searching && searched == trimmed && hits.isEmpty() -> WorkNote(emptyText)
        }
        creationError?.let { WorkErrorNotice(it) }
        Spacer(Modifier.padding(bottom = 2.dp))
    }
}

/** A caption with the registry's required mark. */
private fun caption(r: Resources, label: Int, required: Boolean): String = r.getString(label) + if (required) " *" else ""

internal fun qualificationTitle(r: Resources, key: String): String = when (key) {
    "budget_availability" -> r.getString(R.string.work_q_budget)
    "event_timeline" -> r.getString(R.string.work_q_timeline)
    "previous_engagement" -> r.getString(R.string.work_q_engagement)
    "project_fit" -> r.getString(R.string.work_q_fit)
    "stakeholder_buy_in" -> r.getString(R.string.work_q_buy_in)
    else -> key
}

/** `CrmSubjectStatusOption.title(for:)` for either kind: the word on screen; the wire stays English. */
internal fun subjectStatusTitle(r: Resources, status: String): String = when (status) {
    "Active" -> r.getString(R.string.work_ps_active)
    "Paused" -> r.getString(R.string.work_ps_paused)
    "Archived" -> r.getString(R.string.work_ps_archived)
    else -> leadStatusTitle(r, status)
}

/** `CrmSubjectStatusOption.title(for:)`: the word on screen; the wire stays English. */
internal fun leadStatusTitle(r: Resources, status: String): String = when (status) {
    "Conversations" -> r.getString(R.string.work_ls_conversations)
    "Opportunity Identified" -> r.getString(R.string.work_ls_opportunity)
    "Proposal Out" -> r.getString(R.string.work_ls_proposal)
    "Active Negotiation" -> r.getString(R.string.work_ls_negotiation)
    "Waiting on External Factor" -> r.getString(R.string.work_ls_waiting)
    "Closed Won" -> r.getString(R.string.work_ls_won)
    "Closed Lost" -> r.getString(R.string.work_ls_lost)
    else -> status
}

/** `UNTRIAGED_TOUCH_SOURCE_LABELS`, in the reader's language. */
internal fun touchSourceTitle(r: Resources, key: String): String = when (key) {
    "support_case" -> r.getString(R.string.work_touch_support)
    "pricing_request" -> r.getString(R.string.work_touch_pricing)
    "readiness_assessment" -> r.getString(R.string.work_touch_readiness)
    else -> r.getString(R.string.work_touch_contact)
}
