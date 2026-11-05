package work.starlings.android.core.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Euro
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import work.starlings.android.R
import work.starlings.android.ThreadMarkdown
import work.starlings.android.core.CoreAccess
import work.starlings.android.core.CoreDetail
import work.starlings.android.core.CoreEntityContract
import work.starlings.android.core.CoreFieldContract
import work.starlings.android.core.CoreMarkdown
import work.starlings.android.core.CoreTarget
import work.starlings.android.core.coreDisplayName
import work.starlings.android.ui.Starlings
import work.starlings.android.ui.StarlingsRadius
import work.starlings.android.ui.StarlingsType
import work.starlings.android.ui.WorkHeaderTitle
import work.starlings.android.ui.WorkLabeledRow
import work.starlings.android.ui.WorkSection
import work.starlings.android.workspace.team.markdownAnnotated

/**
 * core-kit `MarkdownText`: a note's blocks drawn, its runs styled as a
 * thread's are. A picture alone on its line loads as an image field does.
 */
@Composable
internal fun CoreMarkdownText(markdown: String, modifier: Modifier = Modifier) {
    val c = Starlings.colors
    val blocks = remember(markdown) { CoreMarkdown.blocks(markdown) }
    @Composable
    fun runs(text: String, style: androidx.compose.ui.text.TextStyle = StarlingsType.body, color: androidx.compose.ui.graphics.Color = c.primary, modifier: Modifier = Modifier) {
        val annotated = remember(text) { markdownAnnotated(ThreadMarkdown.spans(text), c.accentMark) }
        Text(annotated, modifier, style = style, color = color)
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEach { block ->
            when (block) {
                is CoreMarkdown.Block.Heading -> runs(
                    block.text,
                    style = when {
                        block.level <= 1 -> StarlingsType.title3
                        block.level == 2 -> StarlingsType.headline
                        else -> StarlingsType.subheadline
                    }.copy(fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.padding(top = 4.dp),
                )
                is CoreMarkdown.Block.Bullet -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("•", style = StarlingsType.body, color = c.secondary)
                    runs(block.text, modifier = Modifier.weight(1f))
                }
                is CoreMarkdown.Block.Ordered -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${block.number}.", Modifier.widthIn(min = 14.dp), style = StarlingsType.body, color = c.secondary)
                    runs(block.text, modifier = Modifier.weight(1f))
                }
                is CoreMarkdown.Block.Quote -> Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(c.secondary))
                    runs(block.text, color = c.secondary, modifier = Modifier.weight(1f))
                }
                is CoreMarkdown.Block.Code -> SelectionContainer {
                    Text(
                        block.text,
                        Modifier.fillMaxWidth().background(c.field, RoundedCornerShape(8.dp)).padding(10.dp),
                        style = StarlingsType.callout.copy(fontFamily = FontFamily.Monospace),
                        color = c.primary,
                    )
                }
                is CoreMarkdown.Block.Image -> Column(Modifier.padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    // https only, as every Core picture (`CorePictures`).
                    CoreRemoteImage(block.url, Modifier.fillMaxWidth().heightIn(max = 240.dp).height(180.dp))
                    if (block.alt.isNotEmpty()) Text(block.alt, style = StarlingsType.caption, color = c.secondary)
                }
                CoreMarkdown.Block.Rule -> HorizontalDivider(Modifier.padding(vertical = 4.dp), color = c.border)
                is CoreMarkdown.Block.Paragraph -> runs(block.text)
                CoreMarkdown.Block.Blank -> Spacer(Modifier.height(2.dp))
            }
        }
    }
}

/**
 * `RelationContextCard`: the related record's face, name and line, its
 * flags and every other field with a value, under the relation's label. It
 * draws from the embedded object at once, then from the record Core reads;
 * it opens that record where the account may read its entity.
 */
@Composable
internal fun CoreRelationContextCard(core: CoreAccess, field: CoreFieldContract, source: JsonObject, onOpen: (CoreTarget) -> Unit) {
    val c = Starlings.colors
    val target = field.relationEntity?.let(core::contract) ?: return
    val id = CoreDetail.relatedId(field, source) ?: return
    var resolved by remember(target.id, id) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(target.id, id) {
        if (!target.hasReadAccess) return@LaunchedEffect
        try {
            resolved = core.record(target.id, id)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The embedded object stays.
        }
    }
    val record = CoreDetail.displayRecord(field, source, resolved) ?: return
    val name = record.coreDisplayName(target.primaryField, target.singularLabel)
    WorkSection(header = { WorkHeaderTitle(field.label) }) {
        Column(
            Modifier
                .fillMaxWidth()
                .then(if (target.hasReadAccess) Modifier.clickable(role = Role.Button) { onOpen(CoreTarget(target.id, id, name)) } else Modifier)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                CoreAvatar(work.starlings.android.core.CoreFields.avatarUrl(record), name, target.id, target.icon, size = 52.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(name, style = StarlingsType.headline, color = c.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    CoreDetail.cardSubtitle(target, record)?.let {
                        Text(it, style = StarlingsType.subheadline, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            val flags = CoreDetail.flags(target, record)
            if (flags.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    flags.forEach { flag ->
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Verified, null, Modifier.size(14.dp), tint = c.primary)
                            Text(flag, style = StarlingsType.caption, color = c.primary)
                        }
                    }
                }
            }
            val rows = CoreDetail.detailRows(target, record)
            if (rows.isNotEmpty()) {
                HorizontalDivider(color = c.border)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    rows.forEach { row ->
                        if (row.block) {
                            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(row.label, style = StarlingsType.caption, color = c.secondary)
                                Text(row.value, style = StarlingsType.subheadline, color = c.primary, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            }
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(row.label, style = StarlingsType.subheadline, color = c.secondary)
                                Spacer(Modifier.weight(1f))
                                Text(row.value, style = StarlingsType.subheadline, color = c.primary, textAlign = TextAlign.End, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** `RecordMetadataFooter`: Created, Updated and the id, quiet, under the page; the id can be selected. */
@Composable
internal fun CoreRecordFooter(contract: CoreEntityContract, record: JsonObject) {
    val c = Starlings.colors
    val locale = LocalContext.current.resources.configuration.locales[0]
    val rows = remember(contract.id, record, locale) { CoreDetail.footerRows(contract, record, locale) }
    if (rows.isEmpty()) return
    SelectionContainer {
        Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            rows.forEach { (label, value) ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        stringResource(
                            when (label) {
                                CoreDetail.FooterLabel.CREATED -> R.string.core_footer_created
                                CoreDetail.FooterLabel.UPDATED -> R.string.core_footer_updated
                                CoreDetail.FooterLabel.ID -> R.string.core_footer_id
                            },
                        ),
                        style = StarlingsType.caption,
                        color = c.secondary,
                    )
                    Text(value, Modifier.weight(1f), style = StarlingsType.caption, color = c.secondary)
                }
            }
        }
    }
}

/** `LicenseOverviewSection`: ARR and seats side by side, whether it is active, and its renewal. */
@Composable
internal fun CoreLicenseOverview(record: JsonObject) {
    val c = Starlings.colors
    val locale = LocalContext.current.resources.configuration.locales[0]
    WorkSection(header = { WorkHeaderTitle(stringResource(R.string.core_overview)) }) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CoreOverviewValue(stringResource(R.string.core_license_arr), CoreDetail.arr(record, locale), Icons.Filled.Euro, Modifier.weight(1f))
            CoreOverviewValue(stringResource(R.string.core_license_seats), CoreDetail.seats(record), Icons.Filled.People, Modifier.weight(1f))
        }
        val active = CoreDetail.licenseActive(record)
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.core_signals_status), style = StarlingsType.body, color = c.primary)
            Spacer(Modifier.weight(1f))
            Icon(if (active) Icons.Filled.CheckCircle else Icons.Filled.PauseCircle, null, Modifier.size(18.dp), tint = if (active) c.primary else c.secondary)
            Spacer(Modifier.width(6.dp))
            Text(stringResource(if (active) R.string.core_license_active else R.string.core_license_inactive), style = StarlingsType.body, color = if (active) c.primary else c.secondary)
        }
        CoreDetail.renewal(record)?.let { WorkLabeledRow(stringResource(R.string.core_license_renewal), it) }
    }
}

@Composable
private fun CoreOverviewValue(label: String, value: String, icon: ImageVector, modifier: Modifier) {
    val c = Starlings.colors
    Column(modifier.background(c.field, RoundedCornerShape(StarlingsRadius.field)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(12.dp), tint = c.secondary)
            // iOS upper-cases the label as it draws it.
            Text(label.uppercase(), style = StarlingsType.caption2.copy(fontWeight = FontWeight.SemiBold), color = c.secondary)
        }
        Text(value, style = StarlingsType.title3.copy(fontWeight = FontWeight.SemiBold), color = c.primary)
    }
}

/**
 * Reply to Customer on a support case: the mail app, to the customer, CC'd
 * to the capture mailbox with the case's tag in the subject, so the reply is
 * logged on the case.
 */
@Composable
internal fun CoreReplyToCustomer(values: Map<String, JsonElement>, record: JsonObject) {
    val context = LocalContext.current
    val c = Starlings.colors
    val mailto = CoreDetail.replyMailto(values, record) ?: return
    val email = CoreDetail.customerEmail(values, record) ?: return
    WorkSection(footer = stringResource(R.string.core_reply_footer, email, CoreDetail.CAPTURE_ADDRESS)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { runCatching { context.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse(mailto))) } }
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.AutoMirrored.Filled.Reply, null, Modifier.size(18.dp), tint = c.primary)
            Text(stringResource(R.string.core_reply_to_customer), style = StarlingsType.body, color = c.primary)
        }
    }
}
