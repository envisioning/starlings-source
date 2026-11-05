package work.starlings.android.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import work.starlings.android.R
import work.starlings.android.core.CoreEntityContract
import work.starlings.android.core.CoreFieldOption
import work.starlings.android.core.CoreFields
import work.starlings.android.core.CoreRules
import work.starlings.android.core.coreId
import work.starlings.android.ui.Haptic
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import kotlin.math.roundToInt

/** A card held up and moving: which record, from which column, where the finger is, and where on the card it holds. */
private data class BoardDrag(val record: JsonObject, val from: String, val pointer: Offset, val grab: Offset, val size: IntSize)

/**
 * `CRMBoardView`: one column per option of the board's field, side by side,
 * each with its count and its cards. A card opens its record. Where the
 * account may update, a card is held, then dragged onto another column
 * (`draggable`, `dropDestination`): that column lights up with "Move to
 * <stage>", and the drop moves it. The board scrolls on its own while the
 * card is near an edge. A long press that does not move opens the card's
 * menu, which also holds Move to <stage>; without update rights it opens at
 * once. Every column stays composed, so a held card survives the scroll.
 */
@Composable
internal fun CoreBoard(contract: CoreEntityContract, columns: List<CoreFieldOption>, records: List<JsonObject>, actions: CoreRowActions, open: (JsonObject) -> Unit) {
    val c = Starlings.colors
    val view = LocalView.current
    val density = LocalDensity.current
    val field = contract.board?.field ?: return
    val canDrop = contract.canUpdate
    val width = (LocalConfiguration.current.screenWidthDp * 0.84f).coerceAtMost(320f).dp
    val shape = RoundedCornerShape(StarlingsRadius.field)
    val scroll = rememberScrollState()
    val bounds = remember { mutableStateMapOf<String, Rect>() }
    var board by remember { mutableStateOf(Rect.Zero) }
    var drag by remember { mutableStateOf<BoardDrag?>(null) }
    val held = drag
    val target = held?.let { d -> columns.firstOrNull { bounds[it.value]?.contains(d.pointer) == true }?.takeIf { it.value != d.from } }

    // Near an edge, the board scrolls under the held card.
    LaunchedEffect(held != null) {
        val edge = with(density) { 56.dp.toPx() }
        val step = with(density) { 14.dp.toPx() }
        while (true) {
            val d = drag ?: break
            val dx = when {
                d.pointer.x < board.left + edge -> -step
                d.pointer.x > board.right - edge -> step
                else -> 0f
            }
            if (dx != 0f) scroll.scrollBy(dx)
            delay(16)
        }
    }

    Box(Modifier.fillMaxSize().onGloballyPositioned { board = it.boundsInRoot() }) {
        Row(
            Modifier.fillMaxSize().horizontalScroll(scroll, enabled = held == null).padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            columns.forEach { column -> key(column.value) {
                val cards = CoreFields.boardRecords(records, field, column.value)
                val targeted = target?.value == column.value
                DisposableEffect(column.value) { onDispose { bounds.remove(column.value) } }
                Column(
                    Modifier
                        .width(width)
                        .fillMaxHeight()
                        .onGloballyPositioned { bounds[column.value] = it.boundsInRoot() }
                        .background(if (targeted) c.accent.copy(alpha = 0.12f) else c.panel, shape)
                        .then(if (targeted) Modifier.border(2.dp, c.accent, shape) else Modifier)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(column.label, Modifier.weight(1f), style = StarlingsType.headline, color = c.primary)
                        Text(CoreRules.count(cards.size), style = StarlingsType.caption, color = c.secondary)
                    }
                    LazyColumn(userScrollEnabled = held == null, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(cards, key = { it.coreId }) { record ->
                            CoreBoardCard(
                                contract, record, actions,
                                lifted = held?.record?.coreId == record.coreId,
                                canDrag = canDrop && actions.boardField != null,
                                onOpen = { open(record) },
                                onLift = { pointer, grab, size ->
                                    Haptic.TOGGLE.play(view)
                                    drag = BoardDrag(record, column.value, pointer, grab, size)
                                },
                                onMove = { pointer -> drag = drag?.copy(pointer = pointer) },
                                onRelease = {
                                    val d = drag
                                    val into = d?.let { lifted -> columns.firstOrNull { bounds[it.value]?.contains(lifted.pointer) == true } }
                                    drag = null
                                    if (d != null && into != null && into.value != d.from && canDrop) {
                                        Haptic.TAP.play(view)
                                        actions.onMove(d.record, field, into)
                                    }
                                },
                                onCancel = { drag = null },
                            )
                        }
                        if (targeted) item(key = "drop") { CoreDropPlaceholder(column.label) }
                    }
                }
            } }
        }
        held?.let { d ->
            // The lifted copy follows the finger, over every column.
            val origin = board.topLeft
            Box(
                Modifier
                    .zIndex(1f)
                    .offset { IntOffset((d.pointer.x - d.grab.x - origin.x).roundToInt(), (d.pointer.y - d.grab.y - origin.y).roundToInt()) }
                    .size(with(density) { d.size.width.toDp() }, with(density) { d.size.height.toDp() })
                    .shadow(8.dp, shape)
                    .background(c.elevated, shape)
                    .border(1.dp, c.border, shape)
                    .alpha(0.96f),
            ) { CoreRecordRowContent(contract, d.record, Modifier.padding(vertical = 6.dp)) }
        }
    }
}

/**
 * One card: tap opens, a still long press opens the menu, a long press that
 * moves carries the card. A scroll that starts before the long press stays
 * a scroll.
 */
@Composable
private fun CoreBoardCard(
    contract: CoreEntityContract,
    record: JsonObject,
    actions: CoreRowActions,
    lifted: Boolean,
    canDrag: Boolean,
    onOpen: () -> Unit,
    onLift: (pointer: Offset, grab: Offset, size: IntSize) -> Unit,
    onMove: (Offset) -> Unit,
    onRelease: () -> Unit,
    onCancel: () -> Unit,
) {
    val c = Starlings.colors
    val shape = RoundedCornerShape(StarlingsRadius.field)
    var menu by remember { mutableStateOf(false) }
    val place = remember { arrayOfNulls<LayoutCoordinates>(1) }
    // The gesture outlives a recomposition; it calls the latest callbacks.
    val opens by rememberUpdatedState(onOpen)
    val lifts by rememberUpdatedState(onLift)
    val moves by rememberUpdatedState(onMove)
    val releases by rememberUpdatedState(onRelease)
    val cancels by rememberUpdatedState(onCancel)
    fun root(local: Offset): Offset = place[0]?.takeIf { it.isAttached }?.localToRoot(local) ?: local
    Box(
        Modifier
            .fillMaxWidth()
            .onGloballyPositioned { place[0] = it }
            .alpha(if (lifted) 0.35f else 1f)
            .background(c.elevated, shape)
            .border(1.dp, c.border, shape)
            .semantics {
                role = Role.Button
                onClick { onOpen(); true }
                onLongClick { menu = true; true }
            }
            .pointerInput(record.coreId, canDrag) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val slop = viewConfiguration.touchSlop
                    var tapped = false
                    val held = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: return@withTimeoutOrNull
                            if (change.changedToUp()) {
                                tapped = !change.isConsumed
                                return@withTimeoutOrNull
                            }
                            if (change.isConsumed || (change.position - down.position).getDistance() > slop) return@withTimeoutOrNull
                        }
                    } == null
                    if (!held) {
                        if (tapped) opens()
                        return@awaitEachGesture
                    }
                    if (!canDrag) {
                        menu = true
                        return@awaitEachGesture
                    }
                    lifts(root(down.position), down.position, size)
                    var moved = false
                    try {
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id }
                            if (change == null) {
                                cancels()
                                break
                            }
                            change.consume()
                            if (change.changedToUp()) {
                                if (moved) releases() else { cancels(); menu = true }
                                break
                            }
                            if ((change.position - down.position).getDistance() > slop) moved = true
                            moves(root(change.position))
                        }
                    } catch (e: CancellationException) {
                        cancels()
                        throw e
                    }
                }
            },
    ) {
        CoreRecordRowContent(contract, record, Modifier.padding(vertical = 6.dp))
        CoreRowMenu(record, actions, menu) { menu = false }
    }
}

/** The dashed place a card lands, "Move to <stage>". */
@Composable
private fun CoreDropPlaceholder(label: String) {
    val c = Starlings.colors
    val radius = with(LocalDensity.current) { StarlingsRadius.field.toPx() }
    Box(
        Modifier
            .fillMaxWidth()
            .height(52.dp)
            .drawBehind {
                drawRoundRect(
                    color = c.accent.copy(alpha = 0.7f),
                    cornerRadius = CornerRadius(radius),
                    style = Stroke(width = 2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))),
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.ArrowDownward, null, Modifier.size(14.dp), tint = c.primary)
            Text(stringResource(R.string.core_move_to, label), style = StarlingsType.caption.copy(fontWeight = FontWeight.Medium), color = c.primary)
        }
    }
}
