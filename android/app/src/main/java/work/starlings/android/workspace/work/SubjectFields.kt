package work.starlings.android.workspace.work

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import work.starlings.android.ui.toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import work.starlings.android.R
import work.starlings.android.WorkItems
import work.starlings.android.api.SubjectRoutes
import work.starlings.android.api.WorkRoutes
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsToggle
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.EventPhase
import work.starlings.contracts.CrmRelatedRow
import work.starlings.contracts.CrmSubjectDetailWire
import work.starlings.contracts.CrmSubjectKind
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * The Fields pane (`MobileSubjectFieldsView` over `SubjectFieldsView`,
 *): every field of a project or a lead, read with
 * `GET /api/crm/subjects/{kind}/{id}` and written with the same path's
 * PATCH, only what changed (`SubjectFieldsDraft`). Revert and Save sit over
 * the form. Relations show as names. An organization or an event shows
 * what the Worker reads, with no write.
 */
@Composable
internal fun SubjectFieldsPane(store: WorkStore, subject: SubjectRef, onSaved: (CrmSubjectDetailWire) -> Unit = {}) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    val kind = subject.kind
    val writable = kind == CrmSubjectKind.PROJECT || kind == CrmSubjectKind.LEAD
    // The project spec fields and EVID are the `spec_fields` work module; an older Worker names none, which is every module on.
    val specFields = store.subjectState?.workModules?.any { it.value == "spec_fields" } ?: true
    var detail by remember(subject.id) { mutableStateOf<CrmSubjectDetailWire?>(null) }
    var saved by remember(subject.id) { mutableStateOf(SubjectFieldsDraft()) }
    var draft by remember(subject.id) { mutableStateOf(SubjectFieldsDraft()) }
    var loadError by remember(subject.id) { mutableStateOf<String?>(null) }
    var saveError by remember(subject.id) { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    var pickingDay by remember { mutableStateOf<String?>(null) }

    fun apply(loaded: CrmSubjectDetailWire) {
        detail = loaded
        saved = SubjectFieldsDraft.of(loaded)
        draft = saved
    }

    LaunchedEffect(subject.id, attempt) {
        try {
            // An editor reads live: a stale field is a stale write.
            apply(store.client.call(WorkRoutes.subjectDetail(kind, subject.id)).subject)
            loadError = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (detail == null) loadError = e.workMessage()
        }
    }

    fun commit() {
        val update = draft.update(saved, kind) ?: run { draft = saved; return }
        saving = true
        saveError = null
        scope.launch {
            try {
                val written = when (update) {
                    is SubjectFieldsDraft.Update.Project -> store.client.call(SubjectRoutes.updateProject(subject.id, update.update)).subject
                    is SubjectFieldsDraft.Update.Lead -> store.client.call(SubjectRoutes.updateLead(subject.id, update.update)).subject
                }
                apply(written)
                toast(r.getString(R.string.sharesheet_saved))
                onSaved(written)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                saveError = e.workMessage()
            } finally {
                saving = false
            }
        }
    }

    val read = detail
    if (read == null) {
        Column(Modifier.fillMaxSize().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            val error = loadError
            if (error != null) {
                WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_fields_load_failed)) }) {
                    WorkErrorNotice(error, retry = r.getString(R.string.work_retry), onRetry = { attempt++ })
                }
            } else {
                WorkSection { WorkPlaceholderRows() }
            }
        }
        return
    }

    Column(Modifier.fillMaxSize()) {
        if (writable) {
            // `actions`: the save's refusal, then Revert and Save.
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { saveError?.let { Text(it, style = StarlingsType.footnote, color = c.danger) } }
                Spacer(Modifier.padding(start = 8.dp))
                BorderedButton(r.getString(R.string.work_revert), { draft = saved; saveError = null }, compact = true, enabled = draft != saved && !saving)
                Spacer(Modifier.padding(start = 8.dp))
                FilledButton(
                    r.getString(if (saving) R.string.work_saving else R.string.work_save), ::commit, compact = true,
                    enabled = draft != saved && !saving && draft.canSave(kind),
                )
            }
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            val edit: (SubjectFieldsDraft) -> Unit = { if (!saving) draft = it }
            when (kind) {
                CrmSubjectKind.PROJECT -> {
                    WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_fields_basic)) }) {
                        FieldText(draft.title, r.getString(R.string.work_title_field)) { edit(draft.copy(title = it.replace('\n', ' '))) }
                        WorkDivider()
                        FieldText(draft.description, r.getString(R.string.work_description), long = true) { edit(draft.copy(description = it)) }
                        WorkDivider()
                        FieldText(draft.url, r.getString(R.string.keep_url), uri = true) { edit(draft.copy(url = it.replace('\n', ' '))) }
                        if (specFields) {
                            WorkDivider()
                            FieldText(draft.evid, r.getString(R.string.work_fields_evid)) { edit(draft.copy(evid = it.replace('\n', ' '))) }
                        }
                        WorkDivider()
                        StarlingsToggle(r.getString(R.string.work_fields_internal), draft.isInternal, { edit(draft.copy(isInternal = it)) }, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                    }
                    WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_fields_relationships)) }) { RelationRows(r, kind, read) }
                    WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_fields_timeline)) }) {
                        MenuPicker(r.getString(R.string.work_status), SubjectFieldsDraft.statusChoices(kind, draft.status).map { it to it }, draft.status) { edit(draft.copy(status = it)) }
                        WorkDivider()
                        OptionalDay(r.getString(R.string.work_field_start_date), draft.startDate, { edit(draft.copy(startDate = it)) }) { pickingDay = "start" }
                        WorkDivider()
                        OptionalDay(r.getString(R.string.work_fields_end_date), draft.endDate, { edit(draft.copy(endDate = it)) }) { pickingDay = "end" }
                    }
                    if (specFields) {
                        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_fields_project_notes)) }) {
                            val notes = listOf(
                                R.string.work_fields_contract to (draft.contract to { v: String -> draft.copy(contract = v) }),
                                R.string.work_fields_analytics to (draft.analytics to { v: String -> draft.copy(analytics = v) }),
                                R.string.work_fields_authentication to (draft.authentication to { v: String -> draft.copy(authentication = v) }),
                                R.string.work_fields_specs to (draft.specs to { v: String -> draft.copy(specs = v) }),
                                R.string.work_fields_technical to (draft.technical to { v: String -> draft.copy(technical = v) }),
                                R.string.work_fields_research to (draft.research to { v: String -> draft.copy(research = v) }),
                                R.string.work_fields_design to (draft.design to { v: String -> draft.copy(design = v) }),
                            )
                            notes.forEachIndexed { index, (label, field) ->
                                if (index > 0) WorkDivider()
                                FieldText(field.first, r.getString(label), long = true) { edit(field.second(it)) }
                            }
                        }
                    }
                }
                CrmSubjectKind.LEAD -> {
                    WorkSection(
                        header = { WorkHeaderTitle(r.getString(R.string.work_field_qualification)) },
                        footer = r.getString(R.string.work_n_qualified, LeadQualification.count(draft.characteristics), LeadQualification.keys.size),
                    ) {
                        LeadQualification.keys.forEachIndexed { index, key ->
                            if (index > 0) WorkDivider()
                            StarlingsToggle(
                                qualificationTitle(r, key), LeadQualification.isSet(key, draft.characteristics),
                                { edit(draft.copy(characteristics = LeadQualification.merged(draft.characteristics, key, it))) },
                                Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                            )
                        }
                    }
                    WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_kind_lead)) }) {
                        FieldText(draft.title, r.getString(R.string.work_title_field)) { edit(draft.copy(title = it.replace('\n', ' '))) }
                        WorkDivider()
                        MenuPicker(r.getString(R.string.work_status), SubjectFieldsDraft.statusChoices(kind, draft.status).map { it to it }, draft.status) { edit(draft.copy(status = it)) }
                        WorkDivider()
                        WorkLabeledRow(r.getString(R.string.work_field_start_date), WorkFormat.civilDay(draft.startDate ?: LocalDate.now())) { pickingDay = "start" }
                        WorkDivider()
                        RelationRows(r, kind, read)
                        WorkDivider()
                        FieldText(draft.notes, r.getString(R.string.work_field_notes), long = true) { edit(draft.copy(notes = it)) }
                    }
                }
                else -> WorkSection {
                    WorkLabeledRow(r.getString(R.string.work_field_name), read.title)
                    read.industry?.takeIf { it.isNotEmpty() }?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.work_industry), it) }
                    read.url?.takeIf { it.isNotEmpty() }?.let { WorkDivider(); WorkLabeledRow(r.getString(R.string.keep_url), it) }
                }
            }
        }
    }

    pickingDay?.let { which ->
        FieldDayDialog(
            initial = (if (which == "end") draft.endDate else draft.startDate) ?: LocalDate.now(),
            onDismiss = { pickingDay = null },
        ) { day ->
            pickingDay = null
            draft = if (which == "end") draft.copy(endDate = day) else draft.copy(startDate = day)
        }
    }
}

/** A text field of the form, one line or several. */
@Composable
private fun FieldText(value: String, label: String, long: Boolean = false, uri: Boolean = false, onChange: (String) -> Unit) {
    Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        StarlingsField(value, onChange, label, keyboardType = if (uri) KeyboardType.Uri else KeyboardType.Text, singleLine = !long, maxLines = if (long) 12 else 1)
    }
}

/** `optionalDate`: a toggle, and the day under it while it is on. */
@Composable
private fun OptionalDay(label: String, day: LocalDate?, onSet: (LocalDate?) -> Unit, onPick: () -> Unit) {
    StarlingsToggle(label, day != null, { on -> onSet(if (on) (day ?: LocalDate.now()) else null) }, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
    if (day != null) WorkLabeledRow(label, WorkFormat.civilDay(day), onPick)
}

/** `relationRows`: the organization, then a project's lead and contacts, or a lead's contact, as names. */
@Composable
private fun RelationRows(r: android.content.res.Resources, kind: CrmSubjectKind, detail: CrmSubjectDetailWire) {
    WorkLabeledRow(r.getString(R.string.work_field_organization), detail.organizationName ?: r.getString(R.string.work_none))
    WorkDivider()
    if (kind == CrmSubjectKind.PROJECT) {
        WorkLabeledRow(r.getString(R.string.work_kind_lead), detail.related?.leads?.firstOrNull()?.title ?: r.getString(R.string.work_none))
        WorkDivider()
        WorkLabeledRow(r.getString(R.string.work_contacts), contactNames(r, kind, detail))
    } else {
        WorkLabeledRow(r.getString(R.string.work_contact), contactNames(r, kind, detail))
    }
}

/** `contactNames`: the names when every id has one, else how many. */
private fun contactNames(r: android.content.res.Resources, kind: CrmSubjectKind, detail: CrmSubjectDetailWire): String {
    val ids = if (kind == CrmSubjectKind.LEAD) listOfNotNull(detail.contactId) else detail.contactIds.orEmpty()
    if (ids.isEmpty()) return r.getString(R.string.work_none)
    val names = detail.related?.contacts.orEmpty().filter { it.id in ids }.mapNotNull { it.name ?: it.email }
    if (names.size == ids.size) return names.joinToString(", ")
    return if (ids.size == 1) r.getString(R.string.work_fields_one_contact) else r.getString(R.string.work_fields_n_contacts, ids.size)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FieldDayDialog(initial: LocalDate, onDismiss: () -> Unit, onPick: (LocalDate) -> Unit) {
    val c = Starlings.colors
    val state = rememberDatePickerState(initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton({ state.selectedDateMillis?.let { onPick(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) } ?: onDismiss() }) {
                Text(stringResource(R.string.work_done), color = c.primary)
            }
        },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
    ) { DatePicker(state) }
}

/**
 * An event's own page (`MobileEventDetailView`, docs/EVENTS.md): the phase,
 * day and place on one line; About (the image, Host, Partner, Sign-up, the
 * description, "Not on the website yet."); and the projects that link to
 * it. Read-only: an event is a CMS row, edited under Website in Core. The
 * last copy paints first.
 */
@Composable
internal fun SubjectEventPane(store: WorkStore, subject: SubjectRef, onOpenSubject: (SubjectRef) -> Unit) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val route = remember(subject.id) { WorkRoutes.subjectDetail(CrmSubjectKind.EVENT, subject.id, snapshotted = true) }
    var detail by remember(subject.id) { mutableStateOf(store.client.snapshot(route)?.value?.subject) }
    var error by remember(subject.id) { mutableStateOf<String?>(null) }
    var loading by remember(subject.id) { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(subject.id, attempt) {
        loading = detail == null
        try {
            detail = store.client.call(route).subject
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        } finally {
            loading = false
        }
    }
    val open: (String) -> Unit = { url -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
    val read = detail
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        error?.let { WorkSection { WorkErrorNotice(it, retry = r.getString(R.string.work_retry), onRetry = { attempt++ }) } }
        WorkSection { WorkNote(eventStanding(r, read)) }
        if (read == null) {
            if (loading) WorkSection { WorkPlaceholderRows() }
            return@Column
        }
        val host = read.host?.trim().orEmpty()
        val partner = read.partner?.trim().orEmpty()
        val link = read.url?.trim().orEmpty()
        val image = read.imageUrl?.trim().orEmpty()
        val description = read.description?.trim().orEmpty()
        if (image.isNotEmpty() || host.isNotEmpty() || partner.isNotEmpty() || link.isNotEmpty() || description.isNotEmpty() || read.published == false) {
            WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_about)) }) {
                if (image.isNotEmpty()) EventImage(store, image, r.getString(R.string.work_event_image_for, subject.title))
                if (host.isNotEmpty()) WorkLabeledRow(r.getString(R.string.role_host), host)
                if (partner.isNotEmpty()) {
                    val partnerUrl = read.partnerUrl?.takeIf { it.isNotEmpty() }
                    LinkRow(r.getString(R.string.work_partner), partner, partnerUrl?.let { { open(it) } })
                }
                if (link.isNotEmpty()) LinkRow(r.getString(R.string.work_event_sign_up), link, { open(link) }, r.getString(R.string.work_event_open_sign_up, link))
                if (description.isNotEmpty()) {
                    Text(description, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), style = StarlingsType.body, color = c.primary)
                }
                if (read.published == false) WorkNote(r.getString(R.string.work_event_not_on_website))
            }
        }
        // The event is the project in practice; a linked delivery project is the exception.
        val projects = read.related?.projects.orEmpty()
        if (projects.isNotEmpty()) {
            WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_projects)) }) {
                projects.forEachIndexed { index, row ->
                    if (index > 0) WorkDivider()
                    ProjectRow(r, row, onOpenSubject)
                }
            }
        }
    }
}

/** `standing`: the phase on the phone's day, the full date, and the place, on one line. */
private fun eventStanding(r: android.content.res.Resources, detail: CrmSubjectDetailWire?): String {
    val raw = detail?.eventDate
    val phase = when (WorkItems.eventPhase(raw, System.currentTimeMillis(), ZoneId.systemDefault())) {
        EventPhase.UPCOMING -> r.getString(R.string.work_event_upcoming)
        EventPhase.LIVE -> r.getString(R.string.work_event_today)
        EventPhase.PAST -> r.getString(R.string.work_event_past)
    }
    val day = raw?.take(10)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        ?.let { DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).format(it) }
        ?: r.getString(R.string.work_no_date_yet)
    val place = listOfNotNull(detail?.place, detail?.location).map { it.trim() }.filter { it.isNotEmpty() }.joinToString(", ")
    return listOf(phase, day, place).filter { it.isNotEmpty() }.joinToString(" · ")
}

/** `LabeledContent` whose value is a link in accent ink when it opens something. */
@Composable
private fun LinkRow(label: String, value: String, onOpen: (() -> Unit)?, spoken: String? = null) {
    val c = Starlings.colors
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onOpen != null) Modifier.clickable(role = Role.Button, onClick = onOpen) else Modifier)
            .then(if (spoken != null) Modifier.semantics { contentDescription = spoken } else Modifier)
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = StarlingsType.body, color = c.primary)
        Spacer(Modifier.weight(1f).padding(start = 12.dp))
        Text(value, style = StarlingsType.body, color = if (onOpen != null) c.accentMark else c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * The event's picture, at most 360 by 220, fitted. Android asks only the
 * Worker's own origin for bytes (`TeamMedia.previewImage`), so a picture
 * hosted elsewhere draws nothing; a failure draws nothing either.
 */
@Composable
private fun EventImage(store: WorkStore, url: String, label: String) {
    val media = remember(store) { work.starlings.android.workspace.team.TeamMedia(store.owner) }
    val bitmap by produceState<ImageBitmap?>(null, url) {
        value = media.previewImage(url)?.let { bytes ->
            withContext(Dispatchers.Default) { runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }.getOrNull() }
        }
    }
    bitmap?.let {
        Image(
            it, label,
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp).widthIn(max = 360.dp).heightIn(max = 220.dp).clip(RoundedCornerShape(StarlingsRadius.control)),
            contentScale = ContentScale.Fit,
        )
    }
}

/** `WorkSidebarRow.subject` for a linked project: its title and status. */
@Composable
private fun ProjectRow(r: android.content.res.Resources, row: CrmRelatedRow, onOpenSubject: (SubjectRef) -> Unit) {
    val c = Starlings.colors
    val title = row.title?.takeIf { it.isNotEmpty() } ?: r.getString(R.string.work_untitled)
    Column(
        Modifier.fillMaxWidth().clickable(role = Role.Button) { onOpenSubject(SubjectRef(CrmSubjectKind.PROJECT, row.id, title)) }.padding(horizontal = 16.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(title, style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary)
        row.status?.takeIf { it.isNotEmpty() }?.let { Text(it, style = StarlingsType.caption, color = c.secondary) }
    }
}
