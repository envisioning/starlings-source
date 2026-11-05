package work.starlings.android.workspace.home

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Assessment
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Comment
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.EventAvailable
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.MarkEmailUnread
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.RadioButtonChecked
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import work.starlings.android.R
import work.starlings.android.SearchDoor
import work.starlings.android.SearchKind
import work.starlings.android.SearchRow
import work.starlings.android.ui.CompactMark
import work.starlings.android.ui.HomeCardLabel
import work.starlings.android.workspace.team.AddressFace
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsCard
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.UnreadDot
import work.starlings.android.ui.homeRow
import work.starlings.android.workspace.work.MineItem
import work.starlings.contracts.CommercialSummary
import work.starlings.contracts.InboxBookingItem
import work.starlings.contracts.InboxCardItem
import work.starlings.contracts.InboxCardItemStage
import work.starlings.contracts.InboxCommentItem
import work.starlings.contracts.InboxDecisionItem
import work.starlings.contracts.InboxFollowUpItem
import work.starlings.contracts.InboxForwardedItem
import work.starlings.contracts.InboxCommercialItem
import work.starlings.contracts.InboxInterestItem
import work.starlings.contracts.InboxInvitationItem
import work.starlings.contracts.InboxItem
import work.starlings.contracts.InboxQuestionItem
import work.starlings.contracts.InboxSalesItem
import work.starlings.contracts.InboxSubmissionItem
import work.starlings.contracts.InboxTaskItem
import work.starlings.contracts.ThreadSummaryWire

/**
 * Home's hand-over modules, which open other tabs: `MobileHomeInboxCard`,
 * `MobileTodayWorkCard`, `MobileCommercialCard` and `MobileRecentCard`
 * (iOS/MobileHomeView.swift, iOS/MobileCommercialCard.swift). Every row is
 * a web path ([HomeLinks]); [open] hands it to the tab that owns it.
 */

/** "and N more in Work": a quiet line that opens Work. */
@Composable
private fun MoreLine(text: String, onClick: () -> Unit) {
    Text(
        text,
        Modifier.clickable(role = Role.Button, onClick = onClick).padding(vertical = 4.dp),
        style = StarlingsType.caption,
        color = Starlings.colors.secondary,
    )
}

@Composable
private fun CardHeader(title: String, trailing: String?) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        HomeCardLabel(title)
        Spacer(Modifier.weight(1f))
        trailing?.let { Text(it, style = StarlingsType.caption.copy(fontWeight = FontWeight.Bold), color = Starlings.colors.primary) }
    }
}

// INBOX

/**
 * What is new: unread conversations and INBOX items, invitations and
 * decisions first, then newest first. Three, then a count: a card that grows
 * without limit becomes the list Work's INBOX already is.
 */
@Composable
fun InboxCard(
    threads: List<ThreadSummaryWire>,
    inbox: List<InboxItem>,
    nowMs: Long,
    open: (String) -> Unit,
    answeringKey: String? = null,
    agenda: List<work.starlings.contracts.CalendarEventWire> = emptyList(),
    respond: (InboxInvitationItem, work.starlings.contracts.CalendarEventReply) -> Unit = { _, _ -> },
    answerForwarded: (InboxForwardedItem, Boolean) -> Unit = { _, _ -> },
) {
    val context = LocalContext.current
    val rows = HomeInbox.rows(threads, inbox)
    val listed = rows.take(HomeInbox.cap)
    StarlingsCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CardHeader(
                stringResource(R.string.home_inbox),
                if (rows.size == 1) stringResource(R.string.home_new_one) else stringResource(R.string.home_new_many, rows.size),
            )
            listed.forEach { row ->
                when (row) {
                    is HomeInbox.Row.Thread -> ThreadRow(row.thread, nowMs) { open(HomeLinks.thread(row.thread)) }
                    is HomeInbox.Row.Item -> when (val item = row.item) {
                        // A calendar request is answered on the row itself.
                        is InboxInvitationItem -> {
                            val conflicts = remember(item, agenda) {
                                CalendarConflicts.conflicts(CalendarConflicts.Event.of(item.event), agenda.map(CalendarConflicts.Event::of))
                            }
                            InvitationRow(item, HomeWorkText.detail(context, item, nowMs), conflicts, answeringKey) { reply -> respond(item, reply) }
                        }
                        is InboxForwardedItem ->
                            ForwardedRow(item, HomeWorkText.detail(context, item, nowMs), answeringKey) { add -> answerForwarded(item, add) }
                        else -> ItemRow(
                            HomeWorkText.title(context, item),
                            HomeWorkText.detail(context, item, nowMs),
                            glance(item),
                            HomeInbox.squareMark(item),
                        ) { open(HomeLinks.inboxItem(item)) }
                    }
                }
            }
            if (rows.size > listed.size) {
                MoreLine(stringResource(R.string.home_more_in_work, rows.size - listed.size)) { open(HomeLinks.WORK) }
            }
        }
    }
}

/** `glanceSymbolName`, in Material's words. */
private fun glance(item: InboxItem): ImageVector = when (item) {
    is InboxTaskItem -> Icons.Outlined.Check
    is InboxCardItem -> if (item.stage == InboxCardItemStage.BLOCKED) Icons.Outlined.WarningAmber else Icons.Outlined.CheckCircle
    is InboxFollowUpItem -> Icons.Outlined.Email
    is InboxSalesItem -> Icons.Outlined.Inbox
    is InboxCommentItem -> Icons.Outlined.Comment
    is InboxBookingItem -> Icons.Outlined.EventAvailable
    is InboxInvitationItem -> Icons.Outlined.Schedule
    is InboxForwardedItem -> Icons.Outlined.MarkEmailUnread
    is InboxInterestItem, is InboxSubmissionItem -> Icons.Outlined.Business
    is InboxCommercialItem -> if (item.offer != null) Icons.Outlined.Description else Icons.Outlined.Key
    is InboxDecisionItem -> Icons.Outlined.Check
    is InboxQuestionItem -> Icons.Outlined.HelpOutline
    else -> Icons.Outlined.Inbox
}

@Composable
private fun ThreadRow(thread: ThreadSummaryWire, nowMs: Long, onClick: () -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val title = HomeWorkText.threadTitle(context, thread)
    val preview = HomeWorkText.threadPreview(thread) { null }
    val label = HomeWorkText.threadLabel(context, thread)
    // Clamped forward: clock skew must never read as "in 3 minutes".
    val ago = thread.lastMessageAt?.let {
        DateUtils.getRelativeTimeSpanString(minOf(it, nowMs), nowMs, DateUtils.SECOND_IN_MILLIS).toString()
    }
    Row(
        Modifier
            .clickable(onClick = onClick)
            .homeRow(c.elevated)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { onClick(); true } },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) { UnreadDot() }
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, style = StarlingsType.headline, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                preview?.let { Text(it, style = StarlingsType.subheadline, color = c.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            ago?.let { Text(it, style = StarlingsType.caption.copy(textAlign = TextAlign.End), color = c.secondary) }
        }
    }
}

@Composable
private fun ItemRow(title: String, detail: String, icon: ImageVector, square: Boolean, onClick: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier
            .clickable(onClick = onClick)
            .homeRow(c.elevated)
            .clearAndSetSemantics { contentDescription = "$title, $detail"; role = Role.Button; onClick { onClick(); true } },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        CompactMark(icon, round = !square)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = StarlingsType.headline, color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (detail.isNotEmpty()) Text(detail, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// MINE

/** All of Mine, a handful then a count. New things are the INBOX card's. */
@Composable
fun MineCard(mine: HomeMine, open: (String) -> Unit) {
    val context = LocalContext.current
    val listed = mine.rows.take(HomeMine.cap)
    val hidden = mine.rows.size - listed.size
    StarlingsCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            // "overdue" is in the words: no tint on top (docs/DESIGN.md, "The accent budget").
            CardHeader(stringResource(R.string.home_mine), HomeWorkText.mineSummary(context, mine))
            listed.forEach { item -> MineRow(mine, item) { open(HomeMine.link(item)) } }
            if (hidden > 0) MoreLine(stringResource(R.string.home_more_in_work, hidden)) { open(HomeLinks.MINE) }
        }
    }
}

@Composable
private fun MineRow(mine: HomeMine, item: MineItem, onClick: () -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val late = mine.isLate(item)
    val title = HomeMine.title(item)
    val detail = HomeMine.detail(item)
    val whenText = HomeWorkText.mineWhen(context, mine, item)
    Row(
        Modifier
            .clickable(onClick = onClick)
            .homeRow(c.elevated)
            .clearAndSetSemantics {
                contentDescription = listOf(title, detail, whenText).filter { it.isNotEmpty() }.joinToString(", ")
                role = Role.Button
                onClick { onClick(); true }
            },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        CompactMark(if (HomeMine.isIssue(item)) Icons.Outlined.RadioButtonChecked else Icons.Outlined.Check, tint = if (late) c.primary else c.secondary)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = StarlingsType.headline, color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (detail.isNotEmpty()) Text(detail, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        // The word "Overdue" is the signal, not a colour: weight carries it.
        if (whenText.isNotEmpty()) {
            Text(
                whenText,
                style = StarlingsType.caption.copy(fontWeight = if (late) FontWeight.Bold else FontWeight.SemiBold, textAlign = TextAlign.End),
                color = if (late) c.primary else c.secondary,
            )
        }
    }
}

// COMMERCIAL

/** Slow, read-only commercial history from Core: four figures and the months as bars. */
@Composable
fun CommercialCard(summary: CommercialSummary, open: (String) -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    val label = HomeWorkText.commercialSummary(context, summary)
    StarlingsCard(Modifier.clearAndSetSemantics { contentDescription = label }) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Assessment, null, Modifier.size(14.dp), tint = c.secondary)
                Spacer(Modifier.width(4.dp))
                HomeCardLabel(stringResource(R.string.home_commercial))
                Spacer(Modifier.weight(1f))
                Text(stringResource(R.string.home_months, summary.lookbackMonths.toInt()), style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
            }
            Text(stringResource(R.string.home_offers_sales), style = StarlingsType.subheadline, color = c.secondary)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Stat(stringResource(R.string.home_offers), HomeWorkText.number(context, summary.offers), Modifier.weight(1f))
                Stat(stringResource(R.string.home_sales), HomeWorkText.currency(context, summary.salesAmount, summary.currencyCode), Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Stat(stringResource(R.string.home_pipeline), HomeWorkText.currency(context, summary.pipelineAmount, summary.currencyCode), Modifier.weight(1f))
                Stat(stringResource(R.string.home_new_licenses), summary.newLicenses?.let { HomeWorkText.number(context, it) } ?: "–", Modifier.weight(1f))
            }
            Bars(summary)
            Row(Modifier.fillMaxWidth()) {
                Text(summary.points.firstOrNull()?.label.orEmpty(), style = StarlingsType.caption2, color = c.secondary)
                Spacer(Modifier.weight(1f))
                Text(summary.points.lastOrNull()?.label.orEmpty(), style = StarlingsType.caption2, color = c.secondary)
            }
            Text(
                stringResource(R.string.home_view_sales),
                Modifier.clickable(role = Role.Button) { open(HomeLinks.WORK) }.padding(vertical = 4.dp),
                style = StarlingsType.body,
                color = c.secondary,
            )
        }
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(HomeText.locale(LocalContext.current)), style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
        Text(value, style = StarlingsType.title3.copy(fontWeight = FontWeight.SemiBold), color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Expired at the top, active in the accent, accepted at the base; each month against the tallest. */
@Composable
private fun Bars(summary: CommercialSummary) {
    val c = Starlings.colors
    val maximum = maxOf(summary.points.maxOfOrNull { it.total } ?: 0.0, 1.0)
    Row(Modifier.fillMaxWidth().height(48.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom) {
        summary.points.forEach { p ->
            val accepted = maxOf(p.positive, 0.0)
            val expired = maxOf(p.negative, 0.0)
            val active = maxOf(p.total - accepted - expired, 0.0)
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.Bottom) {
                Box(Modifier.fillMaxWidth().height((expired / maximum * 48).dp).background(c.secondary.copy(alpha = 0.35f)))
                Box(Modifier.fillMaxWidth().height((active / maximum * 48).dp).background(c.accent))
                Box(Modifier.fillMaxWidth().height((accepted / maximum * 48).dp).background(c.primary.copy(alpha = 0.78f)))
            }
        }
    }
}

// QUICK ACCESS

/**
 * Starred first, then this device's recents (`HomeLayout.mergeRecent`), as
 * tiles that scroll sideways: the mark over the name, then the kind.
 */
@Composable
fun QuickAccessCard(rows: List<SearchRow>, starredKeys: Set<String>, open: (SearchRow) -> Unit) {
    val context = LocalContext.current
    val c = Starlings.colors
    StarlingsCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            HomeCardLabel(stringResource(R.string.home_quick_access))
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                rows.forEach { row ->
                    val starred = row.key in starredKeys
                    val type = HomeWorkText.typeLabel(context, row)
                    val label = listOfNotNull(
                        row.title,
                        if (starred) stringResource(R.string.home_starred) else null,
                        row.subtitle.ifEmpty { null },
                        type,
                    ).joinToString(". ")
                    Column(
                        Modifier
                            .width(84.dp)
                            .clickable { open(row) }
                            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { open(row); true } },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Box(Modifier.size(42.dp)) {
                            Box(Modifier.align(Alignment.Center)) { TileMark(row) }
                            if (starred) {
                                Box(
                                    Modifier.offset((-4).dp, (-4).dp).size(16.dp).background(c.panel, CircleShape).border(1.dp, c.border, CircleShape),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(Icons.Filled.Star, null, Modifier.size(10.dp), tint = c.primary)
                                }
                            }
                        }
                        Text(row.title, style = StarlingsType.caption2.copy(fontWeight = FontWeight.Medium, textAlign = TextAlign.Center), color = c.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(
                            type,
                            Modifier
                                .background(c.border.copy(alpha = 0.28f), RoundedCornerShape(50))
                                .border(0.5.dp, c.border, RoundedCornerShape(50))
                                .padding(horizontal = 7.dp, vertical = 3.dp),
                            style = StarlingsType.caption2.copy(fontWeight = FontWeight.Medium, fontSize = 11.sp),
                            color = c.secondary,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}

/** A person's face, an agent's identity, or the kind's glyph (`MobileHomeView.mark`). */
@Composable
private fun TileMark(row: SearchRow) {
    val c = Starlings.colors
    val door = row.door
    if (door is SearchDoor.Thing && (door.to == SearchKind.PERSON || door.to == SearchKind.AGENT)) {
        AddressFace(door.id, row.title)
        return
    }
    val square = row.kind == SearchKind.TASK || row.kind == SearchKind.ISSUE
    Box(
        Modifier.size(40.dp).background(c.elevated, if (square) RoundedCornerShape(10.dp) else CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(glyph(row), null, Modifier.size(20.dp), tint = c.secondary)
    }
}

private fun glyph(row: SearchRow): ImageVector = when (row.kind) {
    SearchKind.SUBJECT -> Icons.Outlined.Groups
    SearchKind.CONTACT -> Icons.Outlined.Business
    SearchKind.THREAD -> Icons.Outlined.ChatBubbleOutline
    SearchKind.DOCUMENT -> Icons.Outlined.Description
    SearchKind.FOLDER -> Icons.Outlined.Folder
    SearchKind.EVENT -> Icons.Outlined.Event
    SearchKind.TASK -> Icons.Outlined.TaskAlt
    SearchKind.ISSUE -> Icons.Outlined.RadioButtonChecked
    SearchKind.GOAL, SearchKind.MILESTONE -> Icons.Outlined.Flag
    SearchKind.DECISION -> Icons.Outlined.Check
    SearchKind.CALL -> Icons.Outlined.Phone
    else -> Icons.Outlined.Description
}
