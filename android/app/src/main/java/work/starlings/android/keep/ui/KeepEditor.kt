package work.starlings.android.keep.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import work.starlings.android.R
import work.starlings.android.keep.KeepItemBody
import work.starlings.android.keep.KeepItemKind
import work.starlings.android.keep.KeepItemSummary
import work.starlings.android.keep.KeepPasswordGenerator
import work.starlings.android.keep.KeepPasswordPreset
import work.starlings.android.keep.KeepSession
import work.starlings.android.keep.KeepTOTP
import work.starlings.android.keep.KeepVaultDetail
import work.starlings.android.ui.ListRow
import work.starlings.android.ui.ListSection
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsField
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkSheet

/**
 * Create or edit (`KeepItemEditor`). Seals in [KeepSession]; the server
 * receives ciphertext and a name. Secret fields are masked; nothing is
 * autocorrected. A one-time code comes in pasted, scanned with the camera
 * or read from a photo, and is stored as the canonical otpauth URI.
 */
@Composable
internal fun KeepItemEditor(
    session: KeepSession,
    vault: KeepVaultDetail,
    item: KeepItemSummary?,
    initial: KeepItemBody,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
) {
    val c = Starlings.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(item?.name ?: "") }
    var kind by remember { mutableStateOf(item?.kind ?: KeepItemKind.LOGIN) }
    var body by remember { mutableStateOf(initial) }
    var error by remember { mutableStateOf<String?>(null) }
    var qrNotice by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    var kindMenu by remember { mutableStateOf(false) }
    var generateMenu by remember { mutableStateOf(false) }

    /** A scanned QR: an otpauth link fills the code field; anything else is said so, not guessed at. */
    fun took(text: String) {
        val totp = KeepTOTP.parse(text)
        if (totp == null) {
            qrNotice = context.getString(R.string.keep_qr_not_totp)
            return
        }
        body = body.copy(totp = totp.uri)
        qrNotice = totp.issuer?.let { context.getString(R.string.keep_qr_added_for, it) } ?: context.getString(R.string.keep_qr_added)
        if (name.isBlank()) totp.issuer?.let { name = it }
        if (body.username.isEmpty()) totp.account?.let { body = body.copy(username = it) }
    }

    val camera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) scanning = true }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val text = withContext(Dispatchers.Default) { KeepQR.decode(context, uri) }
            if (text != null) took(text) else qrNotice = context.getString(R.string.keep_qr_none_in_photo)
        }
    }

    fun save() {
        if (saving) return
        error = null
        var next = body
        // Whatever was pasted, store the canonical otpauth URI.
        if (next.totp.isNotEmpty()) {
            val totp = KeepTOTP.parse(next.totp)
            if (totp == null) {
                error = context.getString(R.string.keep_totp_not_valid)
                return
            }
            next = next.copy(totp = totp.uri)
            body = next
        }
        saving = true
        scope.launch {
            try {
                val trimmed = name.trim()
                if (item != null) session.updateItem(item, trimmed, kind, next, vault) else session.createItem(trimmed, kind, next, vault)
                onSaved()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message
            } finally {
                saving = false
            }
        }
    }

    WorkSheet(
        title = stringResource(if (item == null) R.string.keep_new_item else R.string.keep_edit_item),
        closeLabel = stringResource(R.string.keep_cancel),
        onDismiss = onDismiss,
        confirm = stringResource(R.string.keep_save),
        confirmEnabled = name.isNotBlank() && !saving,
        onConfirm = ::save,
    ) {
        ListSection(null, Modifier.padding(horizontal = 16.dp)) {
            ListRow(divider = true) { StarlingsField(name, { name = it }, placeholder = stringResource(R.string.keep_name)) }
            Box {
                WorkLabeledRow(stringResource(R.string.keep_kind), kind.label) { kindMenu = true }
                DropdownMenu(kindMenu, { kindMenu = false }, containerColor = c.elevated) {
                    KeepItemKind.entries.forEach { option ->
                        DropdownMenuItem(
                            text = { Text(option.label, style = StarlingsType.body, color = if (option == kind) c.accent else c.primary) },
                            onClick = { kind = option; kindMenu = false },
                        )
                    }
                }
            }
        }
        ListSection(null, Modifier.padding(horizontal = 16.dp)) {
            ListRow(divider = true) { StarlingsField(body.username, { body = body.copy(username = it) }, placeholder = stringResource(R.string.keep_username)) }
            ListRow(divider = true) {
                KeepSecretField(stringResource(if (kind == KeepItemKind.API_KEY) R.string.keep_key else R.string.keep_password), body.password, { body = body.copy(password = it) })
                Box {
                    KeepLinkButton(stringResource(R.string.keep_generate), Icons.Outlined.AutoAwesome) { generateMenu = true }
                    DropdownMenu(generateMenu, { generateMenu = false }, containerColor = c.elevated) {
                        KeepPasswordPreset.all.forEach { preset ->
                            DropdownMenuItem(
                                text = { Text(preset.title, style = StarlingsType.body, color = c.primary) },
                                onClick = {
                                    body = body.copy(password = KeepPasswordGenerator.generate(preset.options))
                                    generateMenu = false
                                },
                            )
                        }
                    }
                }
            }
            ListRow(divider = true) { StarlingsField(body.url, { body = body.copy(url = it) }, placeholder = stringResource(R.string.keep_url), keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri) }
            ListRow {
                KeepSecretField(stringResource(R.string.keep_totp_field), body.totp, { body = body.copy(totp = it) })
                if (body.totp.isNotEmpty() && KeepTOTP.parse(body.totp) == null) {
                    Text(stringResource(R.string.keep_totp_invalid_hint), style = StarlingsType.footnote, color = c.danger)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
                        KeepLinkButton(stringResource(R.string.keep_scan_qr), Icons.Outlined.QrCodeScanner) {
                            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                                scanning = true
                            } else {
                                camera.launch(Manifest.permission.CAMERA)
                            }
                        }
                    }
                    KeepLinkButton(stringResource(R.string.keep_from_photo), Icons.Outlined.Image) {
                        photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    }
                }
                qrNotice?.let { Text(it, style = StarlingsType.footnote, color = c.secondary) }
            }
        }
        ListSection(stringResource(R.string.keep_notes), Modifier.padding(horizontal = 16.dp)) {
            ListRow { StarlingsField(body.notes, { body = body.copy(notes = it) }, placeholder = "", label = stringResource(R.string.keep_notes), singleLine = false, maxLines = 12) }
        }
        error?.let { Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp)) { KeepErrorText(it) } }
    }

    if (scanning) {
        KeepQRScanner(onDismiss = { scanning = false }) { text ->
            scanning = false
            took(text)
        }
    }
}

/** A borderless button with a leading symbol (`Label` in `.borderless`). */
@Composable
internal fun KeepLinkButton(text: String, icon: ImageVector, onClick: () -> Unit) {
    val c = Starlings.colors
    Row(
        Modifier.clickable(role = Role.Button, onClick = onClick).padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = c.accent)
        Text(text, style = StarlingsType.body, color = c.accent)
    }
}
