package work.starlings.android.workspace.team

import android.text.format.DateUtils
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.homeRow
import work.starlings.android.workspace.work.LabelChipRow
import work.starlings.contracts.AgentActivityWire
import work.starlings.contracts.AgentManifestTool
import work.starlings.contracts.AgentManifestWire

/*
 * An agent's front door, drawn read-only: the empty DM's card
 * (`AgentManifestCard`) and the About sheet's sections
 * (`MobilePeerInfoView.agentSection`). Rules in `AgentManifest.kt`.
 */

/** `AgentManifestCard`: in place of the empty transcript's one line, what the agent says it is and can do. */
@Composable
fun AgentManifestCard(name: String, manifest: AgentManifestWire, activity: AgentActivityWire?, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(name, style = StarlingsType.headline, color = c.primary)
        // What Meet counted comes before what the runtime claims.
        activity?.let { a ->
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                activityLines(a).forEach { Text(it, style = StarlingsType.footnote, color = c.primary) }
            }
        }
        Text(manifest.description, style = StarlingsType.subheadline, color = c.secondary)
        manifest.model?.let { Text(stringResource(R.string.team_runs_on, it), style = StarlingsType.footnote, color = c.secondary) }
        // The front door says what it can do and what it reaches for; connections and schedules stay in About.
        ManifestList(stringResource(R.string.team_agent_skills), manifest.skills.orEmpty().map { it.name to it.description })
        ManifestList(stringResource(R.string.team_agent_tools), manifest.tools.orEmpty().map { toolName(it) to it.description })
        val links = AgentManifests.links(manifest)
        if (links.isNotEmpty()) LinkRow(links, Modifier.padding(top = 2.dp))
    }
}

/** One eyebrow and its tiles; nothing when the list is empty. */
@Composable
private fun ManifestList(title: String, entries: List<Pair<String, String?>>) {
    if (entries.isEmpty()) return
    Text(
        title.uppercase(),
        Modifier.padding(top = 4.dp),
        style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold),
        color = Starlings.colors.secondary,
    )
    entries.forEach { (name, detail) -> ManifestTile(name, detail) }
}

/**
 * The About sheet's agent half, in iOS's order: Activity, About, What it
 * can do, Tools, Docs, Connections, Schedules, Keys, Links.
 */
@Composable
fun AgentAboutSections(peer: work.starlings.contracts.PeerWire) {
    val c = Starlings.colors
    // Counted by the Worker from its hand-off ledger, not claimed by the runtime: first.
    peer.activity?.let { activity ->
        ListSection(stringResource(R.string.team_agent_activity)) {
            val lines = activityLines(activity)
            lines.forEachIndexed { index, line ->
                ListRow(divider = index < lines.lastIndex) { Text(line, style = StarlingsType.body, color = c.primary) }
            }
        }
    }
    val manifest = peer.manifest ?: return
    ListSection(stringResource(R.string.team_about)) {
        ListRow { Text(manifest.description, style = StarlingsType.body, color = c.primary) }
        manifest.model?.let { ListRow { Text(stringResource(R.string.team_runs_on, it), style = StarlingsType.footnote, color = c.secondary) } }
        buildLine(manifest)?.let { ListRow { Text(it, style = StarlingsType.footnote, color = c.secondary) } }
    }
    manifest.skills.orEmpty().takeIf { it.isNotEmpty() }?.let { skills ->
        TileSection(stringResource(R.string.team_agent_skills)) { skills.forEach { ManifestTile(it.name, it.description) } }
    }
    manifest.tools.orEmpty().takeIf { it.isNotEmpty() }?.let { tools ->
        TileSection(stringResource(R.string.team_agent_tools)) { tools.forEach { ManifestTile(toolName(it), it.description) } }
    }
    val docs = AgentManifests.docs(manifest)
    if (docs.isNotEmpty()) {
        // The house documents it reads before it works; the required one is marked and first.
        ListSection(stringResource(R.string.team_agent_docs)) {
            docs.forEachIndexed { index, doc ->
                ListRow(divider = index < docs.lastIndex) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(AgentManifests.docTitle(doc), style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary)
                            if (doc.required == true) {
                                Text(
                                    stringResource(R.string.team_agent_read_every_job).uppercase(),
                                    Modifier.background(c.accent.copy(alpha = 0.18f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
                                    style = StarlingsType.caption2.copy(fontWeight = FontWeight.Medium),
                                    color = c.primary,
                                )
                            }
                        }
                        AgentManifests.text(doc.description)?.let { Text(it, style = StarlingsType.footnote, color = c.secondary) }
                        AgentManifests.text(doc.source)?.let { Text(it, style = StarlingsType.caption.copy(fontFamily = FontFamily.Monospace), color = c.secondary) }
                        val view = AgentManifests.webUrl(doc.viewUrl)
                        val edit = AgentManifests.webUrl(doc.editUrl)
                        if (view != null || edit != null) {
                            val uri = LocalUriHandler.current
                            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                                view?.let { LinkText(stringResource(R.string.team_agent_doc_read)) { runCatching { uri.openUri(it) } } }
                                edit?.let { LinkText(stringResource(R.string.team_agent_doc_edit)) { runCatching { uri.openUri(it) } } }
                            }
                        }
                    }
                }
            }
        }
    }
    manifest.connections.orEmpty().takeIf { it.isNotEmpty() }?.let { connections ->
        ListSection(stringResource(R.string.team_agent_connections)) {
            connections.forEachIndexed { index, entry -> ManifestRow(entry.name, entry.protocol, divider = index < connections.lastIndex) }
        }
    }
    manifest.schedules.orEmpty().takeIf { it.isNotEmpty() }?.let { schedules ->
        ListSection(stringResource(R.string.team_agent_schedules)) {
            schedules.forEachIndexed { index, entry -> ManifestRow(entry.cron, entry.description, divider = index < schedules.lastIndex) }
        }
    }
    manifest.keys.orEmpty().takeIf { it.isNotEmpty() }?.let { keys ->
        // Names and set or missing only, never a value: a red chip answers "why is it not responding".
        val missing = AgentManifests.missingKeys(manifest)
        val header = if (missing == 0) stringResource(R.string.team_agent_keys) else stringResource(R.string.team_agent_keys_missing, missing)
        val label = if (missing == 0) stringResource(R.string.team_agent_keys_all_set, keys.size) else stringResource(R.string.team_agent_keys_some_missing, keys.size, missing)
        Column(Modifier.fillMaxWidth()) {
            Text(header, Modifier.padding(start = 16.dp, bottom = 6.dp), style = StarlingsType.footnote, color = c.secondary)
            LabelChipRow(keys.map(AgentManifests::keyChip), Modifier.fillMaxWidth().padding(vertical = 6.dp).semantics(mergeDescendants = true) { contentDescription = label })
        }
    }
    val links = AgentManifests.links(manifest)
    if (links.isNotEmpty()) {
        ListSection(stringResource(R.string.team_agent_links)) { ListRow { LinkRow(links) } }
    }
}

/** A section whose skills or tools stand as tiles on their own, not in the list's panel. */
@Composable
private fun TileSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, Modifier.padding(start = 16.dp), style = StarlingsType.footnote, color = Starlings.colors.secondary)
        content()
    }
}

/** `MobileManifestTile`: the name and a chevron; a tap unfolds the description. Nothing to unfold, no tap. */
@Composable
fun ManifestTile(name: String, detail: String?) {
    val c = Starlings.colors
    val text = AgentManifests.text(detail)
    var unfolded by remember(name) { mutableStateOf(false) }
    val state = stringResource(if (unfolded) R.string.team_tile_expanded else R.string.team_tile_collapsed)
    Column(
        Modifier
            .fillMaxWidth()
            .then(
                if (text != null) {
                    Modifier
                        .clickable(role = Role.Button) { unfolded = !unfolded }
                        .semantics(mergeDescendants = true) { role = Role.Button; stateDescription = state }
                } else {
                    Modifier.semantics(mergeDescendants = true) { }
                },
            )
            .homeRow(c.elevated)
            .animateContentSize(tween(180)),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(name, Modifier.weight(1f), style = StarlingsType.subheadline.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
            if (text != null) Icon(if (unfolded) Icons.Filled.ExpandMore else Icons.Filled.ChevronRight, null, Modifier.size(14.dp), tint = c.secondary)
        }
        if (unfolded && text != null) Text(text, style = StarlingsType.footnote, color = c.secondary)
    }
}

/** `manifestRow`: the name, and its detail under it when there is one. */
@Composable
private fun ManifestRow(name: String, detail: String?, divider: Boolean) {
    val c = Starlings.colors
    ListRow(Modifier.semantics(mergeDescendants = true) { }, divider = divider) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(name, style = StarlingsType.body.copy(fontWeight = FontWeight.Medium), color = c.primary)
            AgentManifests.text(detail)?.let { Text(it, style = StarlingsType.footnote, color = c.secondary) }
        }
    }
}

@Composable
private fun LinkRow(links: List<AgentManifests.Link>, modifier: Modifier = Modifier) {
    val uri = LocalUriHandler.current
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        links.forEach { link ->
            val title = stringResource(
                when (link.title) {
                    AgentManifests.Title.HOME -> R.string.team_agent_link_home
                    AgentManifests.Title.README -> R.string.team_agent_link_readme
                    AgentManifests.Title.REPO -> R.string.team_agent_link_repo
                },
            )
            LinkText(title) { runCatching { uri.openUri(link.url) } }
        }
    }
}

@Composable
private fun LinkText(text: String, onClick: () -> Unit) {
    Text(
        text,
        Modifier.clickable(role = Role.Button, onClick = onClick).padding(vertical = 4.dp),
        style = StarlingsType.footnote,
        color = Starlings.colors.accentMark,
    )
}

@Composable
private fun toolName(tool: AgentManifestTool): String =
    if (AgentManifests.asksFirst(tool)) stringResource(R.string.team_agent_asks_first, tool.name) else tool.name

/** `AgentActivity.lines`, formatted on the device so a cached roster never reads stale. */
@Composable
private fun activityLines(activity: AgentActivityWire): List<String> {
    val now = System.currentTimeMillis()
    return AgentManifests.activityLines(activity, now).map { line ->
        when (line) {
            is AgentManifests.ActivityLine.Jobs -> {
                val total = pluralStringResource(R.plurals.team_agent_jobs, line.total.toInt(), line.total.toInt())
                if (line.recent > 0) total + stringResource(R.string.team_agent_jobs_recent, line.recent.toInt()) else total
            }
            is AgentManifests.ActivityLine.Resets -> pluralStringResource(R.plurals.team_agent_resets, line.count.toInt(), line.count.toInt())
            is AgentManifests.ActivityLine.LastReply -> stringResource(R.string.team_agent_last_reply, relative(line.atMs, now))
            is AgentManifests.ActivityLine.UsuallyReplies -> stringResource(R.string.team_agent_usually_replies, line.duration)
        }
    }
}

/** `buildLine`: "Build efa621a · 2 hours ago", or the half that is known. */
@Composable
private fun buildLine(manifest: AgentManifestWire): String? {
    val now = System.currentTimeMillis()
    val parts = listOfNotNull(
        manifest.version?.let { stringResource(R.string.team_agent_build, it) },
        AgentManifests.builtAt(manifest, now)?.let { relative(it, now) },
    )
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}

private fun relative(atMs: Long, nowMs: Long): String =
    DateUtils.getRelativeTimeSpanString(atMs, nowMs, DateUtils.MINUTE_IN_MILLIS).toString()
