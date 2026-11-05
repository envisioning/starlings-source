package work.starlings.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import work.starlings.android.R
import java.util.concurrent.atomic.AtomicLong

/** `StarlingsToastTone`: neutral is the rule; danger is a failure raised where there is no line of its own. */
enum class ToastTone { NEUTRAL, DANGER }

/**
 * `StarlingsToastCenter` (iOS/StarlingsToast.swift): the passing word, one
 * capsule at the bottom of the screen, gone on its own. One at a time: a
 * second toast replaces the first. Neutral toasts last [NEUTRAL_MS], one with
 * an action [ACTION_MS], a danger toast [DANGER_MS]. A tap dismisses it.
 *
 * Every screen says it through [shared]; [StarlingsToastHost] draws it. Each
 * host registers its depth and only the deepest one on screen presents, the
 * ladder iOS climbs, so the shell's host (above the tab bar) wins over the
 * activity's.
 */
class StarlingsToastCenter {
    /** A word on the capsule that does something; tapping it runs [run] and dismisses the toast. */
    class Action(val title: String, val run: () -> Unit)

    /** One toast. Identity is its [id]: the same words said twice are two toasts. */
    class Item internal constructor(val text: String, val tone: ToastTone, val action: Action?) {
        val id: Long = ids.incrementAndGet()
        override fun equals(other: Any?): Boolean = other is Item && other.id == id
        override fun hashCode(): Int = id.hashCode()
    }

    private val current_ = MutableStateFlow<Item?>(null)
    val current: StateFlow<Item?> = current_.asStateFlow()

    private val hostDepths = MutableStateFlow<Map<Int, Int>>(emptyMap())
    val hosts: StateFlow<Map<Int, Int>> = hostDepths.asStateFlow()

    /** The deepest host on screen, the one that presents. */
    val topHostDepth: Int? get() = topDepth(hostDepths.value)

    /** Trimmed; an empty line says nothing. */
    fun show(text: String, tone: ToastTone = ToastTone.NEUTRAL, action: Action? = null) {
        val line = text.trim()
        if (line.isEmpty()) return
        current_.value = Item(line, tone, action)
    }

    /** Only the toast still on screen goes; a newer one stays. */
    fun dismiss(item: Item) {
        current_.update { if (it == item) null else it }
    }

    fun registerHost(depth: Int) = hostDepths.update { it + (depth to (it[depth] ?: 0) + 1) }

    fun unregisterHost(depth: Int) = hostDepths.update {
        val count = it[depth] ?: return@update it
        if (count <= 1) it - depth else it + (depth to count - 1)
    }

    companion object {
        const val NEUTRAL_MS = 3_000L
        const val DANGER_MS = 8_000L
        /** Long enough to read the line and reach for the button. */
        const val ACTION_MS = 6_000L

        private val ids = AtomicLong()

        /** The app's one center, as `StarlingsToastCenter.shared`. */
        val shared = StarlingsToastCenter()

        fun duration(item: Item): Long = when {
            item.tone == ToastTone.DANGER -> DANGER_MS
            item.action != null -> ACTION_MS
            else -> NEUTRAL_MS
        }

        fun topDepth(hosts: Map<Int, Int>): Int? = hosts.keys.maxOrNull()
    }
}

/** Say [text] in passing, as `toast(text)` on iOS. */
fun toast(text: String, tone: ToastTone = ToastTone.NEUTRAL, action: StarlingsToastCenter.Action? = null) =
    StarlingsToastCenter.shared.show(text, tone, action)

/** The activity's host, under every screen. */
const val TOAST_DEPTH_ROOT = 0

/** The workspace shell's host, above the tab bar. */
const val TOAST_DEPTH_SHELL = 1

/**
 * `StarlingsToastHost`: where a toast may appear. It fills its parent and
 * draws the capsule 24 dp above that parent's bottom edge, in a popup window
 * so it stands over a sheet or a dialog opened before it. Reduce Motion
 * (ui/Motion.kt) makes the capsule fade in place; otherwise it rises from the
 * bottom as it fades in.
 */
@Composable
fun StarlingsToastHost(depth: Int, modifier: Modifier = Modifier) {
    val center = StarlingsToastCenter.shared
    DisposableEffect(depth) {
        center.registerHost(depth)
        onDispose { center.unregisterHost(depth) }
    }
    val current by center.current.collectAsState()
    val hosts by center.hosts.collectAsState()
    val presenting = current?.takeIf { StarlingsToastCenter.topDepth(hosts) == depth }
    val reduceMotion = rememberReduceMotion()
    val visible = remember { MutableTransitionState(false) }
    var shown by remember { mutableStateOf<StarlingsToastCenter.Item?>(null) }
    LaunchedEffect(presenting) {
        if (presenting != null) shown = presenting
        visible.targetState = presenting != null
    }
    // Every host times the toast on screen, as iOS's `.task(id:)`; a second dismiss is a no-op.
    LaunchedEffect(current) {
        val item = current ?: return@LaunchedEffect
        delay(StarlingsToastCenter.duration(item))
        center.dismiss(item)
    }
    BoxWithConstraints(modifier.fillMaxSize()) {
        val item = shown
        if (item != null && (visible.currentState || visible.targetState)) {
            val gap = with(LocalDensity.current) { 24.dp.roundToPx() }
            val width = (maxWidth - 48.dp).coerceAtLeast(0.dp)
            Popup(popupPositionProvider = remember(gap) { AboveBottomEdge(gap) }, properties = PopupProperties(focusable = false)) {
                AnimatedVisibility(
                    visibleState = visible,
                    enter = if (reduceMotion) fadeIn() else slideInVertically { it } + fadeIn(),
                    exit = if (reduceMotion) fadeOut() else slideOutVertically { it } + fadeOut(),
                ) {
                    ToastCapsule(item, width) { center.dismiss(item) }
                }
            }
        }
    }
}

/** Centred on the anchor, its bottom [gap] px above the anchor's bottom edge. */
private class AboveBottomEdge(private val gap: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset =
        IntOffset(anchorBounds.left + (anchorBounds.width - popupContentSize.width) / 2, anchorBounds.bottom - gap - popupContentSize.height)
}

/**
 * `StarlingsToastCapsule`: the line in footnote medium (two lines, centred)
 * and its action in accent; a danger toast is the error line with Copy. The
 * screen reader reads it once, from the one host that draws it.
 */
@Composable
private fun ToastCapsule(item: StarlingsToastCenter.Item, maxWidth: Dp, dismiss: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier
            .widthIn(max = maxWidth)
            .shadow(8.dp, CircleShape, clip = false)
            .floatingGlass(c.elevated, CircleShape)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = dismiss)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (item.tone) {
            ToastTone.NEUTRAL -> {
                Text(
                    item.text,
                    Modifier.weight(1f, fill = false),
                    style = StarlingsType.footnote.copy(fontWeight = FontWeight.Medium),
                    color = c.primary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
                item.action?.let { action ->
                    Text(
                        action.title,
                        Modifier.clickable(role = Role.Button) {
                            dismiss()
                            action.run()
                        },
                        style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold),
                        color = c.accent,
                    )
                }
            }
            ToastTone.DANGER -> ToastErrorLine(item.text)
        }
    }
}

/** `StarlingsErrorNotice(alignment: .center)` with `StarlingsCopyErrorButton`: danger ink, then Copy (Copied for 1.5 s). */
@Composable
private fun androidx.compose.foundation.layout.RowScope.ToastErrorLine(message: String) {
    val c = Starlings.colors
    val clipboard = LocalClipboardManager.current
    var copied by remember(message) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    val copyLabel = stringResource(R.string.sharesheet_copy_error)
    Text(message, Modifier.weight(1f, fill = false), style = StarlingsType.footnote, color = c.danger, textAlign = TextAlign.Center)
    Text(
        stringResource(if (copied) R.string.sharesheet_copied else R.string.sharesheet_copy),
        Modifier
            .clickable(role = Role.Button) {
                clipboard.setText(AnnotatedString(message))
                copied = true
            }
            .semantics { contentDescription = copyLabel },
        style = StarlingsType.footnote.copy(fontWeight = FontWeight.SemiBold),
        color = c.danger,
    )
}
