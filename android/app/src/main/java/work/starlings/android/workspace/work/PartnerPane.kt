package work.starlings.android.workspace.work

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.res.stringResource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import work.starlings.android.workspace.FavoriteTargets
import work.starlings.android.workspace.FavoritesStore
import work.starlings.android.workspace.LocalFavorites
import work.starlings.android.workspace.home.HomeRecents
import work.starlings.android.workspace.home.RecentRows
import work.starlings.android.R
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkActionRow
import work.starlings.android.ui.WorkDivider
import work.starlings.android.ui.WorkErrorNotice
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkNote
import work.starlings.android.ui.WorkPlaceholderRows
import work.starlings.android.ui.WorkSection
import work.starlings.android.ui.WorkSidebarRow
import work.starlings.contracts.CrmRelatedRow
import work.starlings.contracts.CrmSubjectDetailWire
import work.starlings.contracts.CrmSubjectKind

/**
 * The Partner pane (`MobilePartnerDetailView`): what
 * the relationship is (industry, website, description) and what hangs off
 * it: projects and leads that open their subject, and its contacts, each
 * opening the contact's page. Add contact opens [ContactEditorSheet] on
 * this organization and the pane reads again after the save. The last
 * copy paints first (docs/CACHING.md).
 *
 * Under the page: Edit organization, Merge… and Delete (,
 *). A merge whose kept id is the other one leaves the page, as
 * iOS ([onGone]); a read that answers `merged_from` hands the page to the
 * kept organization ([onReplace]); a delete leaves the page ([onGone]).
 */
@Composable
internal fun PartnerPane(
    store: WorkStore,
    subject: SubjectRef,
    onOpenSubject: (SubjectRef) -> Unit,
    onOpenContact: (String) -> Unit,
    onReplace: (SubjectRef) -> Unit = {},
    onGone: () -> Unit = {},
) {
    val context = LocalContext.current
    val r = context.resources
    val scope = rememberCoroutineScope()
    val favorites = LocalFavorites.current
    var detail by remember(subject.id) { mutableStateOf(store.partnerSnapshot(subject.id)) }
    var error by remember(subject.id) { mutableStateOf<String?>(null) }
    var loading by remember(subject.id) { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    var adding by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var merging by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    LaunchedEffect(subject.id, attempt) {
        loading = detail == null
        try {
            val fresh = store.partner(subject.id)
            error = null
            // A merged id: the page holds the survivor from here on.
            val merged = fresh.mergedFrom
            if (merged != null && fresh.id != subject.id) {
                val survivor = SubjectRef(CrmSubjectKind.ORGANIZATION, fresh.id, fresh.title)
                adoptSurvivor(context, store.selfEmail.orEmpty(), favorites, merged, survivor)
                onReplace(survivor)
                return@LaunchedEffect
            }
            detail = fresh
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            error = e.workMessage()
        } finally {
            loading = false
        }
    }
    val read = detail
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        error?.let { WorkSection { WorkErrorNotice(it, retry = r.getString(R.string.work_retry), onRetry = { attempt++ }) } }
        read?.subtitle?.takeIf { it.isNotEmpty() }?.let { WorkSection { WorkNote(it) } }
        if (read == null) {
            if (loading) WorkSection { WorkPlaceholderRows() }
            return@Column
        }
        PartnerAbout(read) { url -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
        PartnerRelated(r.getString(R.string.work_projects), read.related?.projects.orEmpty(), CrmSubjectKind.PROJECT, r.getString(R.string.work_no_partner_projects), onOpenSubject)
        PartnerRelated(r.getString(R.string.work_leads), read.related?.leads.orEmpty(), CrmSubjectKind.LEAD, r.getString(R.string.work_no_partner_leads), onOpenSubject)
        val c = Starlings.colors
        WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_contacts)) }) {
            val contacts = read.related?.contacts.orEmpty()
            if (contacts.isEmpty()) WorkNote(r.getString(R.string.work_no_contacts))
            contacts.forEach { contact ->
                val meta = listOfNotNull(contact.title, contact.email).filter { it.isNotEmpty() }.joinToString(" · ")
                Column(
                    Modifier.fillMaxWidth().clickable(role = Role.Button) { onOpenContact(contact.id) }.padding(horizontal = 16.dp, vertical = 9.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(ContactLines.name(contact.name, contact.email) ?: r.getString(R.string.work_unnamed), style = StarlingsType.body, color = c.primary)
                    if (meta.isNotEmpty()) Text(meta, style = StarlingsType.footnote, color = c.secondary)
                }
                WorkDivider()
            }
            WorkActionRow(r.getString(R.string.work_add_contact), { adding = true }, accent = true)
        }
        // `actionsSection`: Edit organization, Merge… and Delete, under the page.
        WorkSection {
            WorkActionRow(stringResource(R.string.work_edit_organization), { editing = true })
            WorkDivider()
            WorkActionRow(stringResource(R.string.work_merge_ellipsis), { merging = true })
            WorkDivider()
            WorkActionRow(
                stringResource(if (deleting) R.string.work_deleting else R.string.work_delete),
                { confirmingDelete = true }, enabled = !deleting, danger = true,
            )
        }
    }
    val shown = detail
    if (editing && shown != null) {
        OrganizationEditorSheet(store, shown, onDismiss = { editing = false }) { saved ->
            editing = false
            detail = saved
            // A rename is the page's title too.
            if (saved.title != subject.title) onReplace(SubjectRef(CrmSubjectKind.ORGANIZATION, saved.id, saved.title))
        }
    }
    if (merging) {
        MergeSheet(
            title = r.getString(R.string.work_merge_organization),
            searchPlaceholder = r.getString(R.string.work_search_organizations),
            name = subject.title,
            message = r.getString(R.string.work_merge_organization_message),
            onDismiss = { merging = false },
            search = { query -> store.organizationMergeCandidates(query, subject.id) },
            merge = { duplicate -> store.mergeOrganizations(subject.id, duplicate) },
        ) { answer ->
            merging = false
            // The merged ids leave this device's recents. The one on screen stayed: read it again.
            // Otherwise it is gone, and the page closes, as iOS (`dismiss()`).
            answer.merged.filter { it != answer.kept }.forEach { HomeRecents.replace(context, store.selfEmail.orEmpty(), it) }
            if (answer.kept == subject.id) attempt++ else onGone()
        }
    }
    if (confirmingDelete) {
        OrganizationDeleteDialog(subject.title, onDismiss = { confirmingDelete = false }) {
            confirmingDelete = false
            if (deleting) return@OrganizationDeleteDialog
            deleting = true
            scope.launch {
                try {
                    store.deleteOrganization(subject.id)
                    onGone()
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    // The Worker's message names the records still pointing at it.
                    error = e.workMessage()
                } finally {
                    deleting = false
                }
            }
        }
    }
    if (adding) {
        ContactEditorSheet(store, null, onDismiss = { adding = false }, organization = Relation(subject.id, subject.title)) {
            adding = false
            attempt++
        }
    }
}

/** `aboutSection`: Industry, Website (it opens) and the description, each only when set. */
@Composable
private fun PartnerAbout(detail: CrmSubjectDetailWire, onOpen: (String) -> Unit) {
    val r = LocalContext.current.resources
    val c = Starlings.colors
    val industry = detail.industry?.trim().orEmpty()
    val website = detail.url?.trim().orEmpty()
    val description = detail.description?.trim().orEmpty()
    if (industry.isEmpty() && website.isEmpty() && description.isEmpty()) return
    WorkSection(header = { WorkHeaderTitle(r.getString(R.string.work_about)) }) {
        var first = true
        fun divider(): Boolean = (!first).also { first = false }
        if (industry.isNotEmpty()) {
            divider()
            WorkLabeledRow(r.getString(R.string.work_industry), industry)
        }
        if (website.isNotEmpty()) {
            if (divider()) WorkDivider()
            val label = r.getString(R.string.work_open_website, website)
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button) { onOpen(website) }
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button }
                    .padding(horizontal = 16.dp, vertical = 11.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(r.getString(R.string.work_website), style = StarlingsType.body, color = c.primary)
                Spacer(Modifier.weight(1f))
                Text(website, style = StarlingsType.body, color = c.accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (description.isNotEmpty()) {
            if (divider()) WorkDivider()
            Text(description, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 11.dp), style = StarlingsType.body, color = c.primary)
        }
    }
}

/** `relatedSection`: rows that open their subject, or a line when there are none. */
@Composable
private fun PartnerRelated(title: String, rows: List<CrmRelatedRow>, kind: CrmSubjectKind, empty: String, onOpen: (SubjectRef) -> Unit) {
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
 * `StarlingsAppModel.adoptSurvivor`: the merged id leaves this device's
 * recents and the survivor takes its place, and a star on the merged one
 * moves to the survivor. A refused star write is let go: the survivor
 * still opens.
 */
internal suspend fun adoptSurvivor(context: android.content.Context, owner: String, favorites: FavoritesStore?, mergedId: String, survivor: SubjectRef) {
    HomeRecents.replace(context, owner, mergedId, RecentRows.subject(survivor.kind.value, survivor.id, survivor.title))
    val merged = FavoriteTargets.crmSubject(survivor.kind.value, mergedId) ?: return
    val moved = FavoriteTargets.crmSubject(survivor.kind.value, survivor.id) ?: return
    if (favorites?.isFavorite(merged) != true) return
    try {
        favorites.setFavorite(moved, starred = true)
        favorites.setFavorite(merged, starred = false)
    } catch (e: Exception) {
        if (e is CancellationException) throw e
    }
}
