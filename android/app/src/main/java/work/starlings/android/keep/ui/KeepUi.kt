package work.starlings.android.keep.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material.icons.outlined.Campaign
import androidx.compose.material.icons.outlined.CellTower
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import work.starlings.android.R
import work.starlings.android.keep.KeepItemKind
import work.starlings.android.keep.KeepVaultIcon
import work.starlings.android.ui.BorderedButton
import work.starlings.android.ui.FilledButton
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsSize
import work.starlings.android.ui.StarlingsSpacing
import work.starlings.android.ui.StarlingsType
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// The shared bits of core-kit `KeepUI/KeepRootView.swift`: the gate, the
// async button, the secret field with its eye, the icon picker, the date.

/** `KeepGate`: the key mark, a title, a message and the gate's actions, centred. */
@Composable
internal fun KeepGate(title: String, message: String, actions: @Composable () -> Unit) {
    val c = Starlings.colors
    Box(Modifier.fillMaxSize().background(c.canvas).verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 420.dp).padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Icon(Icons.Filled.Key, null, Modifier.size(34.dp), tint = c.secondary)
            Text(title, style = StarlingsType.title2, color = c.primary)
            Text(message, style = StarlingsType.callout, color = c.secondary, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            actions()
        }
    }
}

/** `KeepAsyncButton`: runs a suspend action, inert and spinning meanwhile. */
@Composable
internal fun KeepAsyncButton(
    text: String,
    filled: Boolean = true,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    compact: Boolean = true,
    action: suspend () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val run = {
        if (!busy) {
            busy = true
            scope.launch {
                try {
                    action()
                } finally {
                    busy = false
                }
            }
        }
    }
    Box(contentAlignment = Alignment.Center) {
        if (filled) {
            FilledButton(text, { run() }, enabled = enabled && !busy, icon = icon, compact = compact)
        } else {
            BorderedButton(text, { run() }, enabled = enabled && !busy, icon = icon, compact = compact)
        }
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Starlings.colors.secondary)
    }
}

/**
 * `KeepSecretField`: masked by default, shown on demand. Every place Keep
 * takes a password or passphrase uses this, so a person can always see
 * what they typed. Nothing is autocorrected or suggested.
 */
@Composable
internal fun KeepSecretField(
    title: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    onDone: (() -> Unit)? = null,
) {
    val c = Starlings.colors
    var shown by remember { mutableStateOf(false) }
    val s = RoundedCornerShape(StarlingsRadius.field)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = StarlingsSize.field)
            .background(c.field, s)
            .border(1.dp, c.border, s)
            .padding(start = StarlingsSpacing.fieldInset, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.weight(1f).padding(vertical = 13.dp).semantics { contentDescription = title },
            singleLine = true,
            textStyle = StarlingsType.body.copy(color = c.primary),
            cursorBrush = SolidColor(c.accent),
            visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = if (shown) KeyboardType.Ascii else KeyboardType.Password,
                autoCorrectEnabled = false,
                imeAction = if (onDone != null) ImeAction.Done else ImeAction.Default,
            ),
            keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(title, style = StarlingsType.body, color = c.secondary.copy(alpha = 0.7f), maxLines = 1)
                    inner()
                }
            },
        )
        val label = stringResource(if (shown) R.string.keep_hide_field else R.string.keep_show_field, title)
        Box(
            Modifier
                .size(40.dp)
                .clickable(role = Role.Button) { shown = !shown }
                .clearAndSetSemantics { contentDescription = label; role = Role.Button },
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, null, tint = c.secondary)
        }
    }
}

/** The vault glyph picker: a grid of the house's short list (`KeepIconPicker`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun KeepIconPicker(icon: String?, onChange: (String?) -> Unit) {
    val c = Starlings.colors
    val s = RoundedCornerShape(StarlingsRadius.field)
    FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        KeepVaultIcon.choices.forEach { choice ->
            val chosen = KeepVaultIcon.symbol(icon) == choice
            Box(
                Modifier
                    .size(44.dp, 40.dp)
                    .background(if (chosen) c.accent else c.field, s)
                    .then(if (chosen) Modifier else Modifier.border(1.dp, c.border, s))
                    .clickable(role = Role.RadioButton) { onChange(if (choice == KeepVaultIcon.DEFAULT) null else choice) }
                    .semantics { contentDescription = choice; role = Role.RadioButton; selected = chosen },
                contentAlignment = Alignment.Center,
            ) {
                Icon(vaultIcon(choice), null, Modifier.size(18.dp), tint = if (chosen) c.accentInk else c.secondary)
            }
        }
    }
}

/** The Material counterpart of each core-kit vault glyph (an SF Symbol name on the wire). */
internal fun vaultIcon(name: String?): ImageVector = when (KeepVaultIcon.symbol(name)) {
    "folder" -> Icons.Outlined.Folder
    "building.2" -> Icons.Outlined.Business
    "person.2" -> Icons.Outlined.Group
    "globe" -> Icons.Outlined.Public
    "server.rack" -> Icons.Outlined.Dns
    "cloud" -> Icons.Outlined.Cloud
    "creditcard" -> Icons.Outlined.CreditCard
    "envelope" -> Icons.Outlined.Email
    "key" -> Icons.Outlined.Key
    "terminal" -> Icons.Outlined.Terminal
    "antenna.radiowaves.left.and.right" -> Icons.Outlined.CellTower
    "megaphone" -> Icons.Outlined.Campaign
    "cart" -> Icons.Outlined.ShoppingCart
    "banknote" -> Icons.Outlined.Payments
    "shippingbox" -> Icons.Outlined.Inventory2
    else -> Icons.Outlined.Lock
}

/** `KeepItemKind.symbolName` on Material. */
internal fun kindIcon(kind: KeepItemKind): ImageVector = when (kind) {
    KeepItemKind.LOGIN -> Icons.Outlined.Person
    KeepItemKind.API_KEY -> Icons.Outlined.Key
    KeepItemKind.NOTE -> Icons.AutoMirrored.Outlined.Notes
    KeepItemKind.DATABASE -> Icons.Outlined.Storage
    KeepItemKind.SSH_KEY -> Icons.Outlined.Terminal
    KeepItemKind.OTHER -> Icons.Outlined.Lock
}

/** `keepWhen`: an ISO 8601 instant as an abbreviated date and a short time, or the text itself. */
internal fun keepWhen(iso: String): String = runCatching {
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(Instant.parse(iso))
}.getOrDefault(iso)

/**
 * Copies a value. Marked sensitive, so Android 13 and later show no preview
 * of it in the clipboard notice.
 */
internal fun copySecret(context: Context, label: String, value: String) {
    val clip = ClipData.newPlainText(label, value)
    clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
}

/** An inline error line in danger ink (`KeepErrorText`). */
@Composable
internal fun KeepErrorText(message: String?) {
    if (message != null) Text(message, style = StarlingsType.footnote, color = Starlings.colors.danger)
}
