package work.starlings.android.workspace.work

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.api.WorkExtraRoutes
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkFoldTitle
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkIconButton
import work.starlings.android.ui.WorkLabeledRow
import androidx.compose.material.icons.outlined.Edit
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.android.ui.WorkTopBar
import work.starlings.contracts.CrmContact
import work.starlings.contracts.CrmContactDetail
import work.starlings.contracts.CrmRelatedRow
import work.starlings.contracts.CrmSubjectKind

/**
 * The Contacts group: its own search, read only while the
 * group is open (it starts folded, under the Mac's fold key), a row per
 * contact that opens its page. The Worker searches; the group draws what
 * it answers. The header's filter menu holds Core's contact filters
 * (`contactFilterMenu`): Organization (a search), Country, Partner,
 * Existing client, Signals status and Language, kept on this device.
 */
@Composable
internal fun ContactsGroup(store: WorkStore, onOpen: (String) -> Unit) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val prefs = remember { context.getSharedPreferences("work", Context.MODE_PRIVATE) }
    var folded by remember { mutableStateOf(prefs.getBoolean("fold.browse.contacts", true)) }
    var query by rememberSaveable { mutableStateOf("") }
    var rows by remember { mutableStateOf<List<CrmContact>>(emptyList()) }
    var hasMore by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    var filter by remember { mutableStateOf(ContactFilter.decoded(prefs.getString(ContactFilter.KEY, null))) }
    var facets by remember { mutableStateOf<work.starlings.contracts.CrmContactsResponseFacets?>(null) }
    var pickingOrganization by remember { mutableStateOf(false) }
    fun change(next: ContactFilter) {
        if (next == filter) return
        filter = next
        prefs.edit().apply { next.encoded()?.let { putString(ContactFilter.KEY, it) } ?: remove(ContactFilter.KEY) }.apply()
    }

    // A contact added, saved, merged or deleted here moves the revision (`mobileContactsDidChange`).
    LaunchedEffect(folded, query, attempt, filter, store.contactsRevision) {
        if (folded) return@LaunchedEffect
        // A search waits for a pause in typing; a filter reads at once.
        if (query.isNotBlank()) delay(250)
        try {
            val page = store.client.call(WorkExtraRoutes.contactList(filter.query(query)))
            rows = page.contacts
            hasMore = page.hasMore
            page.facets?.let { facets = it }
            error = null
            loaded = true
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        }
    }

    WorkSection(
        header = {
            WorkFoldTitle(stringResource(R.string.work_contacts), folded, r.getString(R.string.work_folded), r.getString(R.string.work_open)) {
                folded = !folded
                prefs.edit().putBoolean("fold.browse.contacts", folded).apply()
            }
            Spacer(Modifier.weight(1f))
            if (loaded) Text(ContactLines.count(rows.size, hasMore), style = StarlingsType.caption, color = c.secondary)
            ContactFilterButton(filter, facets, ::change) { pickingOrganization = true }
        },
    ) {
        if (!folded) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
                StarlingsField(query, { query = it }, placeholder = stringResource(R.string.work_search_contacts), trailingInset = 28.dp)
                Icon(Icons.Filled.Search, null, Modifier.align(Alignment.CenterEnd).padding(end = 14.dp), tint = c.secondary)
            }
            val failure = error
            when {
                failure != null -> WorkErrorNotice(failure, retry = r.getString(R.string.work_retry), onRetry = { attempt++ })
                !loaded -> WorkPlaceholderRows()
                rows.isEmpty() -> WorkNote(stringResource(if (query.isNotBlank() || !filter.isDefault) R.string.work_nothing_matches else R.string.work_no_contacts))
            }
            rows.forEachIndexed { index, contact ->
                // The search field sits above the first row too.
                WorkDivider()
                val detail = ContactLines.context(contact)
                Column(
                    Modifier.fillMaxWidth().clickable(role = Role.Button) { onOpen(contact.id) }.padding(horizontal = 16.dp, vertical = 9.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(ContactLines.name(contact) ?: r.getString(R.string.work_unnamed), style = StarlingsType.body, color = c.primary, maxLines = 1)
                    if (detail.isNotEmpty()) Text(detail, style = StarlingsType.footnote, color = c.secondary, maxLines = 1)
                }
            }
        }
    }
    if (pickingOrganization) OrganizationFilterSheet(store, filter, { pickingOrganization = false }, ::change)
}

/** `MobileContactOrganizationFilterView`: one organization from a search, applied with Done. */
@Composable
private fun OrganizationFilterSheet(store: WorkStore, filter: ContactFilter, onDismiss: () -> Unit, onChange: (ContactFilter) -> Unit) {
    val r = LocalContext.current.resources
    var picked by remember {
        mutableStateOf(filter.organizationId?.let { listOf(Relation(it, filter.organizationName ?: it)) }.orEmpty())
    }
    work.starlings.android.ui.WorkSheet(
        r.getString(R.string.work_field_organization), r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(R.string.work_done),
        onConfirm = {
            onChange(filter.copy(organizationId = picked.firstOrNull()?.id, organizationName = picked.firstOrNull()?.name))
            onDismiss()
        },
    ) {
        WorkSection {
            RelationPicker(
                placeholder = r.getString(R.string.work_search_organizations),
                emptyText = r.getString(R.string.work_no_matches),
                selected = picked, onSelected = { picked = it },
                search = store::searchOrganizations,
            )
        }
    }
}

/**
 * `MobileContactView`: the title and organization (a door to it), the
 * Details (birthday, language, Signals status, characteristics, each only
 * when set), the addresses (each writes a mail), the projects and leads
 * they are on, and their calls. Edit opens [ContactEditorSheet]; Merge…
 * and Delete sit under the page. A merge can keep the other
 * contact: from then on the page reads the one the Worker kept.
 */
@Composable
internal fun ContactScreen(store: WorkStore, id: String, onBack: () -> Unit, onOpenSubject: (SubjectRef) -> Unit) {
    val context = LocalContext.current
    val r = context.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var contact by remember(id) { mutableStateOf<CrmContactDetail?>(null) }
    var error by remember(id) { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    var editing by remember { mutableStateOf(false) }
    var merging by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    // The survivor's id once a read or a merge says `id` was merged into it.
    var survivor by remember(id) { mutableStateOf<String?>(null) }
    LaunchedEffect(id, attempt, survivor) {
        val asked = survivor ?: id
        try {
            val fresh = store.client.call(WorkExtraRoutes.contact(asked)).contact
            fresh.mergedFrom?.takeIf { fresh.id != asked }?.let { merged ->
                survivor = fresh.id
                // `SearchRecents.replace(mergedID:with: nil)`, as MobileContactView.load.
                work.starlings.android.workspace.home.HomeRecents.replace(context, store.selfEmail.orEmpty(), merged)
            }
            contact = fresh
            error = null
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        }
    }
    val read = contact
    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WorkTopBar(read?.let { ContactLines.name(it) ?: r.getString(R.string.work_unnamed) } ?: stringResource(R.string.work_contact), stringResource(R.string.work_back), onBack) {
            if (read != null) WorkIconButton(Icons.Outlined.Edit, stringResource(R.string.work_edit), { editing = true })
        }
        if (editing && read != null) {
            ContactEditorSheet(store, read, onDismiss = { editing = false }) { saved ->
                contact = saved
                editing = false
                error = null
            }
        }
        if (merging && read != null) {
            MergeSheet(
                title = r.getString(R.string.work_merge_contact),
                searchPlaceholder = r.getString(R.string.work_search_contacts),
                name = ContactLines.name(read).orEmpty(),
                message = r.getString(R.string.work_merge_contact_message),
                onDismiss = { merging = false },
                search = { query -> store.mergeCandidates(query, read.id) },
                merge = { duplicate -> store.mergeContacts(read.id, duplicate) },
            ) { answer ->
                merging = false
                val kept = answer.kept
                // The merged ids leave this device's recents (`SearchRecents.replace`).
                val owner = store.selfEmail.orEmpty()
                ContactMerge.mergedAway(answer).forEach { work.starlings.android.workspace.home.HomeRecents.replace(context, owner, it) }
                // The Worker keeps the older one, which can be the duplicate: read the one that stayed.
                ContactMerge.survivor(read.id, kept)?.let { survivor = it }
                attempt++
            }
        }
        if (confirmingDelete && read != null) {
            ContactDeleteDialog(ContactLines.name(read).orEmpty(), onDismiss = { confirmingDelete = false }) {
                confirmingDelete = false
                if (deleting) return@ContactDeleteDialog
                deleting = true
                scope.launch {
                    try {
                        store.deleteContact(read.id)
                        onBack()
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        error = e.workMessage()
                    } finally {
                        deleting = false
                    }
                }
            }
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            error?.let { WorkSection { WorkErrorNotice(it, retry = r.getString(R.string.work_retry), onRetry = { attempt++ }) } }
            if (read == null) {
                if (error == null) WorkSection { WorkPlaceholderRows() }
                return@Column
            }
            val line = ContactLines.context(read)
            val organization = ContactLines.organization(read)
            if (line.isNotEmpty() || organization != null) {
                WorkSection {
                    if (line.isNotEmpty()) WorkNote(line)
                    organization?.let { org ->
                        if (line.isNotEmpty()) WorkDivider()
                        WorkSidebarRow(Icons.Filled.Business, org.title, "", { onOpenSubject(org) })
                    }
                }
            }
            ContactDetailsSection(read)
            WorkSection(header = { WorkHeaderTitle(stringResource(R.string.work_addresses)) }) {
                if (read.emails.isEmpty()) WorkNote(stringResource(R.string.work_no_addresses))
                read.emails.forEachIndexed { index, email ->
                    if (index > 0) WorkDivider()
                    val label = r.getString(R.string.work_write_to, email)
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button) { runCatching { context.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:$email"))) } }
                            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
                            .padding(horizontal = 16.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(email, Modifier.weight(1f), style = StarlingsType.body, color = c.primary)
                        if (index == 0 && read.emails.size > 1) Text(stringResource(R.string.work_primary), style = StarlingsType.body, color = c.secondary)
                    }
                }
            }
            RelatedSection(r.getString(R.string.work_projects), read.projects, CrmSubjectKind.PROJECT, r.getString(R.string.work_on_no_project), onOpenSubject)
            RelatedSection(r.getString(R.string.work_leads), read.leads, CrmSubjectKind.LEAD, r.getString(R.string.work_on_no_lead), onOpenSubject)
            WorkSection(header = { WorkHeaderTitle(stringResource(R.string.work_calls)) }) {
                if (read.interactions.isEmpty()) WorkNote(stringResource(R.string.work_no_calls))
                read.interactions.forEachIndexed { index, call ->
                    if (index > 0) WorkDivider()
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(call.title.trim().ifEmpty { r.getString(R.string.work_untitled) }, style = StarlingsType.body, color = c.primary)
                        TaskDates.parse(call.occurredAt ?: call.createdAt)?.let { Text(WorkFormat.dateTime(it), style = StarlingsType.footnote, color = c.secondary) }
                    }
                }
            }
            // `actionsSection`: Merge… and Delete, under the page.
            WorkSection {
                WorkActionRow(stringResource(R.string.work_merge_ellipsis), { merging = true })
                WorkDivider()
                WorkActionRow(
                    stringResource(if (deleting) R.string.work_deleting else R.string.work_delete),
                    { confirmingDelete = true }, enabled = !deleting, danger = true,
                )
            }
        }
    }
}

/** The contact's delete confirmation: its name, that its leads and projects stay, a destructive Delete and Cancel. */
@Composable
private fun ContactDeleteDialog(name: String, onDismiss: () -> Unit, onDelete: () -> Unit) {
    val c = Starlings.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.elevated,
        title = { Text(stringResource(R.string.work_delete_title, name), style = StarlingsType.headline, color = c.primary) },
        text = { Text(stringResource(R.string.work_contact_delete_message), style = StarlingsType.body, color = c.secondary) },
        confirmButton = { TextButton(onDelete) { Text(stringResource(R.string.work_delete), color = c.danger) } },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.work_cancel), color = c.primary) } },
    )
}

/**
 * `MobileContactMergeView` and `MobileOrganizationMergeView`: pick the
 * duplicate from [search] (which leaves out the one on screen), confirm,
 * and [merge] sends it; the Worker keeps the older one. [onMerged] gets
 * its answer: the id it kept and the ids it merged.
 */
@Composable
internal fun MergeSheet(
    title: String,
    searchPlaceholder: String,
    name: String,
    message: String,
    onDismiss: () -> Unit,
    search: suspend (String) -> List<Pair<String, String>>,
    merge: suspend (duplicate: String) -> work.starlings.contracts.CoreMergeResponseData,
    onMerged: (work.starlings.contracts.CoreMergeResponseData) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val scope = rememberCoroutineScope()
    var picked by remember { mutableStateOf<List<Relation>>(emptyList()) }
    var confirming by remember { mutableStateOf(false) }
    var merging by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val duplicate = picked.firstOrNull()
    work.starlings.android.ui.WorkSheet(
        title, r.getString(R.string.work_close), onDismiss,
        confirm = r.getString(if (merging) R.string.work_merging else R.string.work_merge),
        confirmEnabled = !merging && duplicate != null, onConfirm = { confirming = true },
    ) {
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_duplicate)) }) {
            RelationPicker(
                placeholder = searchPlaceholder,
                emptyText = r.getString(R.string.work_no_matches),
                selected = picked, onSelected = { picked = it },
                search = search,
            )
        }
        error?.let { WorkSection { WorkErrorNotice(it) } }
    }
    if (confirming && duplicate != null) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            containerColor = c.elevated,
            title = {
                Text(
                    r.getString(R.string.work_merge_title, name, duplicate.name),
                    style = StarlingsType.headline, color = c.primary,
                )
            },
            text = { Text(message, style = StarlingsType.body, color = c.secondary) },
            confirmButton = {
                TextButton({
                    confirming = false
                    if (merging) return@TextButton
                    merging = true
                    scope.launch {
                        try {
                            onMerged(merge(duplicate.id))
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            error = e.workMessage()
                        } finally {
                            merging = false
                        }
                    }
                }) { Text(r.getString(R.string.work_merge), color = c.danger) }
            },
            dismissButton = { TextButton({ confirming = false }) { Text(r.getString(R.string.work_cancel), color = c.primary) } },
        )
    }
}

/** `profileSection`: Birthday, Language, Signals status and Characteristics, each only when set. */
@Composable
private fun ContactDetailsSection(contact: CrmContactDetail) {
    val r = LocalContext.current.resources
    val birthday = ContactFieldText.birthday(contact.birthdayMonth?.toInt(), contact.birthdayDay?.toInt(), contact.birthdayYear?.toInt())
    val language = ContactFilter.trimmed(contact.preferredLanguage)
    val status = ContactFilter.trimmed(contact.signalsOutreachStatus)
    val traits = contact.characteristics.orEmpty().filterValues { it }.keys.sorted().map(ContactFieldText::characteristic)
    val rows = listOfNotNull(
        birthday?.let { r.getString(R.string.work_birthday) to it },
        language?.let { r.getString(R.string.work_language) to ContactFilter.languageName(it) },
        status?.let { r.getString(R.string.work_signals_status) to outreachTitle(r, it) },
        traits.takeIf { it.isNotEmpty() }?.let { r.getString(R.string.work_characteristics) to it.joinToString(", ") },
    )
    if (rows.isEmpty()) return
    WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_details)) }) {
        rows.forEachIndexed { index, (label, value) ->
            if (index > 0) WorkDivider()
            WorkLabeledRow(label, value)
        }
    }
}

@Composable
private fun RelatedSection(title: String, rows: List<CrmRelatedRow>, kind: CrmSubjectKind, empty: String, onOpen: (SubjectRef) -> Unit) {
    val r = LocalContext.current.resources
    WorkSection(header = { WorkHeaderTitle(title) }) {
        if (rows.isEmpty()) WorkNote(empty)
        rows.forEachIndexed { index, row ->
            if (index > 0) WorkDivider()
            val name = row.title?.takeIf { it.isNotEmpty() } ?: r.getString(R.string.work_untitled)
            WorkSidebarRow(
                if (kind == CrmSubjectKind.PROJECT) Icons.Filled.Folder else Icons.Filled.Flag,
                name, row.status.orEmpty(), { onOpen(SubjectRef(kind, row.id, name)) },
                subdued = kind == CrmSubjectKind.LEAD,
            )
        }
    }
}

/**
 * `contactFilterMenu`: Organization opens a search, Country and Language
 * pick from what the contacts carry, Partner and Existing client turn on
 * and off, Signals status picks one of five, and Reset clears.
 */
@Composable
private fun ContactFilterButton(
    filter: ContactFilter,
    facets: work.starlings.contracts.CrmContactsResponseFacets?,
    onChange: (ContactFilter) -> Unit,
    onPickOrganization: () -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var menu by remember { mutableStateOf<String?>(null) }
    val label = r.getString(R.string.work_filter_contacts)
    val any = r.getString(R.string.work_any)
    Box {
        Box(
            Modifier
                .size(36.dp)
                .clickable(role = Role.Button) { menu = "root" }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.AutoMirrored.Filled.Sort, null, Modifier.size(18.dp), tint = if (filter.isDefault) c.secondary else c.accent)
        }
        val countries = facets?.countries.orEmpty().sortedBy { ContactFilter.countryName(it).lowercase() }
        val languages = facets?.languages.orEmpty()
        val entries: List<MenuChoice> = when (menu) {
            "root" -> buildList {
                val org = filter.organizationName?.takeIf { filter.organizationId != null }
                add(MenuChoice(org?.let { r.getString(R.string.work_organization_named, it) } ?: r.getString(R.string.work_field_organization), checked = org != null) { onPickOrganization() })
                if (countries.isNotEmpty()) add(MenuChoice(r.getString(R.string.work_country), checked = filter.country != null) { menu = "country" })
                add(MenuChoice(r.getString(R.string.work_partner), checked = filter.partner, startsGroup = true) { onChange(filter.copy(partner = !filter.partner)) })
                add(MenuChoice(r.getString(R.string.work_existing_client), checked = filter.existingClient) { onChange(filter.copy(existingClient = !filter.existingClient)) })
                add(MenuChoice(r.getString(R.string.work_signals_status), checked = filter.signalsOutreachStatus != null, startsGroup = true) { menu = "outreach" })
                if (languages.isNotEmpty()) add(MenuChoice(r.getString(R.string.work_language), checked = filter.preferredLanguage != null) { menu = "language" })
                if (!filter.isDefault) add(MenuChoice(r.getString(R.string.work_reset), startsGroup = true) { onChange(ContactFilter()) })
            }
            "country" -> listOf(MenuChoice(any, checked = filter.country == null) { onChange(filter.copy(country = null)) }) +
                countries.mapIndexed { i, code -> MenuChoice(ContactFilter.countryName(code), checked = filter.country == code, startsGroup = i == 0) { onChange(filter.copy(country = code)) } }
            "outreach" -> listOf(MenuChoice(any, checked = filter.signalsOutreachStatus == null) { onChange(filter.copy(signalsOutreachStatus = null)) }) +
                ContactFilter.outreach.mapIndexed { i, status -> MenuChoice(outreachTitle(r, status), checked = filter.signalsOutreachStatus == status, startsGroup = i == 0) { onChange(filter.copy(signalsOutreachStatus = status)) } }
            "language" -> listOf(MenuChoice(any, checked = filter.preferredLanguage == null) { onChange(filter.copy(preferredLanguage = null)) }) +
                languages.mapIndexed { i, code -> MenuChoice(ContactFilter.languageName(code), checked = filter.preferredLanguage == code, startsGroup = i == 0) { onChange(filter.copy(preferredLanguage = code)) } }
            else -> emptyList()
        }
        ChoiceMenu(menu != null, { menu = null }, entries)
    }
}

/** `ContactFieldText.outreach`. */
internal fun outreachTitle(r: android.content.res.Resources, status: String): String = when (status) {
    "to_notify" -> r.getString(R.string.work_outreach_to_notify)
    "notified" -> r.getString(R.string.work_outreach_notified)
    "replied" -> r.getString(R.string.work_outreach_replied)
    "interested" -> r.getString(R.string.work_outreach_interested)
    "not_interested" -> r.getString(R.string.work_outreach_not_interested)
    else -> status
}

/**
 * `organizationFilterMenu`: Partner, Agency and Existing
 * client turn on and off; Industry and Country pick one value from what
 * the organizations carry; Reset clears.
 */
@Composable
internal fun OrganizationFilterButton(
    filter: OrganizationFilter,
    facets: work.starlings.contracts.CrmSubjectsResponseFacets?,
    onChange: (OrganizationFilter) -> Unit,
) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    var menu by remember { mutableStateOf<String?>(null) }
    val label = r.getString(R.string.work_filter_organizations)
    val any = r.getString(R.string.work_any)
    Box {
        Box(
            Modifier
                .size(36.dp)
                .clickable(role = Role.Button) { menu = "root" }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.AutoMirrored.Filled.Sort, null, Modifier.size(18.dp), tint = if (filter.isDefault) c.secondary else c.accent)
        }
        val industries = facets?.industries.orEmpty()
        val countries = facets?.countries.orEmpty()
        val entries: List<MenuChoice> = when (menu) {
            "root" -> buildList {
                add(MenuChoice(r.getString(R.string.work_partner), checked = filter.partner) { onChange(filter.copy(partner = !filter.partner)) })
                add(MenuChoice(r.getString(R.string.work_agency), checked = filter.agency) { onChange(filter.copy(agency = !filter.agency)) })
                add(MenuChoice(r.getString(R.string.work_existing_client), checked = filter.existingClient) { onChange(filter.copy(existingClient = !filter.existingClient)) })
                if (industries.isNotEmpty()) add(MenuChoice(r.getString(R.string.work_industry), checked = filter.industry != null, startsGroup = true) { menu = "industry" })
                if (countries.isNotEmpty()) add(MenuChoice(r.getString(R.string.work_country), checked = filter.country != null, startsGroup = industries.isEmpty()) { menu = "country" })
                if (!filter.isDefault) add(MenuChoice(r.getString(R.string.work_reset), startsGroup = true) { onChange(OrganizationFilter()) })
            }
            "industry" -> listOf(MenuChoice(any, checked = filter.industry == null) { onChange(filter.copy(industry = null)) }) +
                industries.mapIndexed { i, value -> MenuChoice(value, checked = filter.industry == value, startsGroup = i == 0) { onChange(filter.copy(industry = value)) } }
            "country" -> listOf(MenuChoice(any, checked = filter.country == null) { onChange(filter.copy(country = null)) }) +
                countries.mapIndexed { i, value -> MenuChoice(value, checked = filter.country == value, startsGroup = i == 0) { onChange(filter.copy(country = value)) } }
            else -> emptyList()
        }
        ChoiceMenu(menu != null, { menu = null }, entries)
    }
}
