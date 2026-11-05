package work.starlings.android.workspace.home

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.ArrowCircleDown
import androidx.compose.material.icons.outlined.ArrowCircleUp
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.EditCalendar
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import work.starlings.android.R
import work.starlings.android.Upcoming
import work.starlings.android.UpcomingPlan
import work.starlings.android.UpcomingTier
import work.starlings.android.ui.AttendeeStack
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.CompactMark
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.HomeCardLabel
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsCard
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.homeRow
import work.starlings.contracts.CalendarAttendeeWire
import work.starlings.contracts.CalendarEventWire

/**
 * `MobileNextMeetingCard` (iOS/MobileHomeView.swift): the answer to "what's
 * next", always present, so an empty calendar reads as an answer. The hero
 * is the plan's focus and nothing else; a closed day says so. Joining is the
 * hero's button and every row's long-press, never the row itself.
 */
@Composable
fun UpcomingCard(
    plan: UpcomingPlan,
    raw: List<CalendarEventWire>,
    nowMs: Long,
    ownSlug: String?,
    unavailable: Boolean,
    notConnected: Boolean,
    connecting: Boolean,
    connectError: String?,
    onConnect: () -> Unit,
    onJoin: (HomeFeed.JoinTarget) -> Unit,
    onDemote: (CalendarEventWire, Boolean) -> Unit,
    onOpen: (CalendarEventWire) -> Unit,
) {
    val context = LocalContext.current
    val c = Starlings.colors
    var showingRest by rememberSaveable { mutableStateOf(false) }
    val focus = plan.focus?.let { f -> raw.firstOrNull { it.id == f.id } }
    val following = HomeFeed.rows(plan.homeRows, raw)
    val rest = HomeFeed.rows(plan.remainingToday, raw)
    val isToday = { e: CalendarEventWire -> plan.tiers[e.id] == UpcomingTier.NOW || plan.tiers[e.id] == UpcomingTier.TODAY }

    StarlingsCard {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            HomeCardLabel(HomeText.heroLabel(context, plan))

            when {
                focus != null -> UpcomingRow(
                    focus, nowMs, ownSlug, showsCountdown = !focus.allDay, withContext = true,
                    hidesCountdownWhenJoinable = true, showsJoinButton = true, onJoin = onJoin, onDemote = onDemote,
                    onOpen = onOpen, guests = HomeFeed.guests(focus),
                )
                // The card's Connect Google Calendar: the same flow as Calendar's sources, then a fresh read.
                notConnected -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    BorderedButton(
                        stringResource(if (connecting) R.string.cal_connecting else R.string.cal_connect_google),
                        onConnect,
                        enabled = !connecting,
                        icon = Icons.Outlined.EditCalendar,
                    )
                    connectError?.let { Text(it, style = StarlingsType.subheadline, color = c.secondary) }
                }
                else -> Text(
                    if (unavailable) stringResource(R.string.home_calendar_unreachable) else HomeText.closedDay(context, plan),
                    style = StarlingsType.body, color = c.secondary,
                )
            }

            if (following.isNotEmpty()) {
                HorizontalDivider(thickness = 1.dp, color = c.border)
                following.forEach { e ->
                    // A countdown belongs to today; tomorrow's row says its date instead.
                    UpcomingRow(
                        e, nowMs, ownSlug, showsCountdown = !e.allDay && isToday(e), withContext = false,
                        hidesCountdownWhenJoinable = false, showsJoinButton = false, onJoin = onJoin, onDemote = onDemote,
                        onOpen = onOpen,
                    )
                }
            }

            if (rest.isNotEmpty()) {
                HorizontalDivider(thickness = 1.dp, color = c.border)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        stringResource(if (showingRest) R.string.home_hide_rest else R.string.home_see_rest),
                        Modifier.clickable(role = Role.Button) { showingRest = !showingRest }.padding(vertical = 4.dp),
                        style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold, textDecoration = TextDecoration.Underline),
                        color = c.secondary,
                    )
                    if (showingRest) {
                        rest.forEach { e ->
                            UpcomingRow(
                                e, nowMs, ownSlug, showsCountdown = !e.allDay, withContext = false,
                                hidesCountdownWhenJoinable = false, showsJoinButton = false, onJoin = onJoin, onDemote = onDemote,
                                onOpen = onOpen,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * `MobileHomeUpcomingRow`: one meeting on one line, its long-press holding
 * Join and Hide from Next. The hero's Join is the row's bottom line, inside
 * it, and only inside the join window. The owner's own room is hosting,
 * which this screen does not start yet, so it has no Join.
 */
@Composable
private fun UpcomingRow(
    e: CalendarEventWire,
    nowMs: Long,
    ownSlug: String?,
    showsCountdown: Boolean,
    withContext: Boolean,
    hidesCountdownWhenJoinable: Boolean,
    showsJoinButton: Boolean,
    onJoin: (HomeFeed.JoinTarget) -> Unit,
    onDemote: (CalendarEventWire, Boolean) -> Unit,
    onOpen: (CalendarEventWire) -> Unit,
    guests: List<CalendarAttendeeWire> = emptyList(),
) {
    val context = LocalContext.current
    val c = Starlings.colors
    var menu by remember { mutableStateOf(false) }
    val target = HomeFeed.joinTarget(e, ownSlug)?.takeIf { it != HomeFeed.JoinTarget.OwnRoom }
    val event = HomeFeed.upcoming(e)
    val joinable = target != null && Upcoming.canJoin(event, nowMs)
    val schedule = HomeText.schedule(context, e, nowMs, withContext)
    val countdown = if (showsCountdown && !(hidesCountdownWhenJoinable && joinable)) HomeText.countdown(context, e, nowMs) else null
    val joinLabel = HomeFeed.actionTitle(e.platform)
    val demoteLabel = stringResource(if (e.demoted) R.string.home_show_in_next else R.string.home_hide_from_next)
    val openHint = stringResource(R.string.home_opens_in_calendar)

    Column(Modifier.homeRow(c.elevated), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box {
            Row(
                Modifier
                    .fillMaxWidth()
                    // The row opens the event in Calendar; joining is the long-press.
                    .pointerInput(e.id) { detectTapGestures(onTap = { onOpen(e) }, onLongPress = { menu = true }) }
                    .clearAndSetSemantics {
                        contentDescription = listOfNotNull(e.title, schedule.ifEmpty { null }, countdown).joinToString(", ")
                        role = Role.Button
                        onClick(openHint) { onOpen(e); true }
                        customActions = listOfNotNull(
                            target?.let { CustomAccessibilityAction(joinLabel) { onJoin(it); true } },
                            CustomAccessibilityAction(demoteLabel) { onDemote(e, !e.demoted); true },
                        )
                    },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Top,
            ) {
                // The platform in a square well; our own room is the one accented mark.
                CompactMark(
                    if (HomeFeed.isVideoMeeting(e)) Icons.Filled.Videocam else Icons.Filled.Event,
                    tint = if (HomeFeed.isStarlingsRoom(e)) c.accentMark else c.secondary,
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(e.title, style = StarlingsType.headline, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (schedule.isNotEmpty()) {
                        Text(schedule, style = StarlingsType.caption, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                countdown?.let {
                    Text(it, style = StarlingsType.caption.copy(fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End), color = c.secondary)
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = c.elevated) {
                target?.let {
                    DropdownMenuItem(
                        text = { Text(joinLabel, color = c.primary) },
                        leadingIcon = { Icon(Icons.Outlined.Videocam, null, tint = c.primary) },
                        onClick = { menu = false; onJoin(it) },
                    )
                }
                DropdownMenuItem(
                    text = { Text(demoteLabel, color = c.primary) },
                    leadingIcon = { Icon(if (e.demoted) Icons.Outlined.ArrowCircleUp else Icons.Outlined.ArrowCircleDown, null, tint = c.primary) },
                    onClick = { menu = false; onDemote(e, !e.demoted) },
                )
            }
        }

        if (guests.isNotEmpty()) GuestStack(guests)

        // Accent only for our own rooms: someone else's Zoom link is a way out of the app, not the call to action.
        if (showsJoinButton && joinable && target != null) {
            val title = HomeText.joinTitle(context, e, nowMs)
            if (HomeFeed.isStarlingsRoom(e)) {
                FilledButton(title, { onJoin(target) }, icon = Icons.Filled.Videocam)
            } else {
                BorderedButton(title, { onJoin(target) }, icon = Icons.Outlined.Videocam)
            }
        }
    }
}

/**
 * The hero's guests: faces with their reply (`MobileAttendeeStack`), the
 * whole list on the long-press, each with Copy Email Address. iOS also
 * offers Open in Core; Android has no Core origin to check a link against,
 * so it opens none.
 */
@Composable
private fun GuestStack(guests: List<CalendarAttendeeWire>) {
    val context = LocalContext.current
    val c = Starlings.colors
    var menu by remember { mutableStateOf(false) }
    val copyLabel = stringResource(R.string.home_copy_email)
    val label = context.getString(
        R.string.home_guests,
        guests.joinToString("; ") { HomeFeed.displayName(it) + ", " + HomeText.reply(context, it) },
    )
    val copy = { email: String ->
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("email", email))
        Unit
    }
    Box(Modifier.padding(start = 34.dp).fillMaxWidth()) {
        Box(
            Modifier
                .pointerInput(Unit) { detectTapGestures(onLongPress = { menu = true }) }
                .clearAndSetSemantics {
                    contentDescription = label
                    customActions = guests.mapNotNull { g ->
                        HomeFeed.normalizedEmail(g)?.let { email ->
                            CustomAccessibilityAction(copyLabel + ": " + HomeFeed.displayName(g)) { copy(email); true }
                        }
                    }
                },
        ) {
            AttendeeStack(guests.map(HomeFeed::face))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = c.elevated) {
            guests.forEach { g ->
                val email = HomeFeed.normalizedEmail(g)
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(HomeFeed.displayName(g), color = c.primary, style = StarlingsType.body)
                            if (email != null) Text(copyLabel, color = c.secondary, style = StarlingsType.caption)
                        }
                    },
                    leadingIcon = { Icon(Icons.Outlined.ContentCopy, null, tint = c.secondary) },
                    enabled = email != null,
                    onClick = { menu = false; email?.let(copy) },
                )
            }
        }
    }
}
