package work.starlings.android.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Currency
import java.util.Locale

/**
 * The parts of core-kit's `EntityDetailView` around the field groups: the
 * relation context cards (`RelationContextCard`), the record footer
 * (`RecordMetadataFooter`), a license's overview (`LicenseOverviewSection`),
 * a support case's Reply to Customer, and a related section's create
 * (`CRMRelatedSectionsView.creation(for:)`).
 */
object CoreDetail {
    // MARK: Relation context cards

    /**
     * `contextRelationFields`: the to-one relations whose target has a face
     * (organizations, contacts, milestones, or any entity with image fields).
     */
    fun contextRelationFields(contract: CoreEntityContract, all: List<CoreEntityContract>): List<CoreFieldContract> =
        contract.fields.filter { field ->
            if (field.kind != "relation") return@filter false
            val target = field.relationEntity?.let { entity -> all.firstOrNull { it.id == entity } } ?: return@filter false
            CoreFields.identity(target).showsAvatar
        }

    /** The embedded relation object, under the singular key (`organizations` rides as `organization`). */
    fun embedded(field: CoreFieldContract, source: JsonObject): JsonObject? =
        CoreRules.relationKey(field)?.let { source[it].coreObject() }

    /** The related record's id: the stored value, else the embedded object's. Null renders no card. */
    fun relatedId(field: CoreFieldContract, source: JsonObject): String? =
        source[field.name].coreString()?.takeIf { it.isNotEmpty() }
            ?: embedded(field, source)?.coreId?.takeIf { it.isNotEmpty() }

    /** `displayRecord`: the fetched record, else the embedded object, else a bare id the fetch replaces. */
    fun displayRecord(field: CoreFieldContract, source: JsonObject, resolved: JsonObject?): JsonObject? {
        resolved?.let { return it }
        embedded(field, source)?.let { return it }
        return relatedId(field, source)?.let { JsonObject(mapOf("id" to JsonPrimitive(it))) }
    }

    /** `formatted`: the display value, a country with its flag first. */
    fun formatted(field: CoreFieldContract, record: JsonObject, locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String? {
        val display = CoreRules.displayValue(field, record, locale, zone)?.takeIf { it.isNotEmpty() } ?: return null
        if (field.kind == "country") flag(record[field.name].coreString().orEmpty())?.let { return "$it $display" }
        return display
    }

    /** `CountryCatalog.flag(forStoredValue:)`: the regional-indicator pair of the country's ISO code. */
    fun flag(stored: String): String? {
        val code = CoreFields.country(stored)?.code?.uppercase(Locale.ROOT) ?: return null
        if (code.length != 2 || !code.all { it in 'A'..'Z' }) return null
        return code.map { String(Character.toChars(0x1F1E6 + (it - 'A'))) }.joinToString("")
    }

    /** The card's line under the name: the target's secondary fields, joined by a middle dot. */
    fun cardSubtitle(target: CoreEntityContract, record: JsonObject, locale: Locale = Locale.getDefault()): String? {
        val parts = target.secondaryFields.mapNotNull { name -> target.field(name)?.let { formatted(it, record, locale) } }
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    /** `relationshipFlags`: the toggles that are on, "Is Partner" read as "Partner". */
    fun flags(target: CoreEntityContract, record: JsonObject): List<String> =
        target.fields.filter { it.kind == "toggle" && record[it.name].coreBool() == true }
            .map { if (it.label.startsWith("Is ")) it.label.removePrefix("Is ") else it.label }

    /** One line of the card's body; a long text stacks under its label. */
    data class DetailRow(val name: String, val label: String, val value: String, val block: Boolean)

    /** `allImageFields`. */
    private val imageFields = listOf("profile_image_url", "logo_image_url", "public_image_url")

    /** `detailRows`: every other field with a value, in registry order. */
    fun detailRows(target: CoreEntityContract, record: JsonObject, locale: Locale = Locale.getDefault()): List<DetailRow> {
        val shown = (listOf(target.primaryField) + target.secondaryFields + imageFields).toSet()
        return target.fields.mapNotNull { field ->
            if (field.kind == "section" || field.kind == "toggle" || field.hidden == true || field.name in shown) return@mapNotNull null
            val value = formatted(field, record, locale) ?: return@mapNotNull null
            DetailRow(field.name, field.label, value, block = field.kind in BLOCK_KINDS)
        }
    }

    private val BLOCK_KINDS = setOf("textarea", "markdown", "stringList")

    // MARK: Footer

    /** `RecordMetadataFooter`'s rows. iOS draws the three labels as plain English text. */
    enum class FooterLabel { CREATED, UPDATED, ID }

    fun footerRows(contract: CoreEntityContract, record: JsonObject, locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): List<Pair<FooterLabel, String>> {
        val declared = contract.fields.filter { it.hidden != true && it.kind != "section" }.map { it.name }.toSet()
        val rows = listOf("created_at" to FooterLabel.CREATED, "updated_at" to FooterLabel.UPDATED).mapNotNull { (key, label) ->
            if (key in declared) return@mapNotNull null
            timestamp(record[key].coreString(), locale, zone)?.let { label to it }
        }.toMutableList()
        record.coreId.takeIf { it.isNotEmpty() }?.let { rows += FooterLabel.ID to it }
        return rows
    }

    /** `formattedTimestamp`: the day abbreviated and the time short, else the stored text. */
    fun timestamp(raw: String?, locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String? {
        val text = raw?.takeIf { it.isNotEmpty() } ?: return null
        val instant = runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()
            ?: runCatching { Instant.parse(text) }.getOrNull()
            ?: runCatching { LocalDate.parse(text).atStartOfDay(zone).toInstant() }.getOrNull()
            ?: return text
        return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale).format(instant.atZone(zone))
    }

    // MARK: Licenses

    /** `title`: a license reads by its organization, "License · <organization>" (iOS has an en dash; no dashes in rendered copy). */
    fun licenseOrganization(contract: CoreEntityContract, record: JsonObject): String? =
        if (contract.id != LICENSES) null
        else record["organization"].coreObject()?.get("name").coreString()?.takeIf { it.isNotEmpty() }

    const val LICENSES = "licenses"
    const val SUPPORT_CASES = "support_cases"

    /** `formattedARR`: `amount_eur` in euros, no cents; a missing amount is zero. */
    fun arr(record: JsonObject, locale: Locale = Locale.getDefault()): String {
        val raw = record["amount_eur"] as? JsonPrimitive
        val amount = when {
            raw == null -> 0.0
            raw.isString -> raw.content.toDoubleOrNull() ?: 0.0
            else -> raw.doubleOrNull ?: 0.0
        }
        val format = NumberFormat.getCurrencyInstance(locale).apply {
            currency = Currency.getInstance("EUR")
            maximumFractionDigits = 0
            minimumFractionDigits = 0
        }
        return format.format(amount)
    }

    /** `seats`: the number as text, without a trailing `.0`; a dash when absent. */
    fun seats(record: JsonObject): String = record["seats"].coreString()?.replace(".0", "").orEmpty()

    fun licenseActive(record: JsonObject): Boolean = (record["is_active"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: false

    fun renewal(record: JsonObject): String? = record["renewal_date"].coreString()

    // MARK: Support cases

    /** `supportCaseCaptureAddress`: the mailbox that threads a reply back onto its case. */
    const val CAPTURE_ADDRESS = work.starlings.android.Deployment.CRM_CAPTURE_ADDRESS

    /** `supportCaseCustomerEmail`: the edited value first, then the read one. */
    fun customerEmail(values: Map<String, JsonElement>, record: JsonObject): String? =
        (values["customer_email"].coreString() ?: record["customer_email"].coreString()).orEmpty().trim().takeIf { it.isNotEmpty() }

    /**
     * `supportCaseReplyURL`: a mail to the customer, CC'd to the capture
     * mailbox, its subject the case's `[SIG-####] Re: <subject>`.
     */
    fun replyMailto(values: Map<String, JsonElement>, record: JsonObject): String? {
        val email = customerEmail(values, record) ?: return null
        fun read(name: String) = (values[name].coreString() ?: record[name].coreString()).orEmpty().trim()
        val shortId = read("short_id")
        val tag = if (shortId.isEmpty()) "" else "[$shortId] "
        val subject = "${tag}Re: ${read("subject")}"
        return "mailto:${encode(email, path = true)}?cc=${encode(CAPTURE_ADDRESS)}&subject=${encode(subject)}"
    }

    /** Percent-encoding as `URLComponents` does it for a mailto: unreserved characters stay, and `@` in the address. */
    private fun encode(text: String, path: Boolean = false): String = buildString {
        text.toByteArray(Charsets.UTF_8).forEach { byte ->
            val ch = byte.toInt().toChar()
            val keep = byte >= 0 && (ch.isLetterOrDigit() || ch in "-._~" || ch == '@' || (path && ch == '+'))
            if (keep) append(ch) else append('%').append("%02X".format(byte.toInt() and 0xFF))
        }
    }

    // MARK: Related create

    /** `RelatedCreation`: the form to fill, or Core's web page to add it on. */
    sealed interface Creation {
        /** [linkField] is the source's own relation to the new record, set once it is saved. */
        data class Form(val target: CoreEntityContract, val initialValues: Map<String, JsonElement>, val linkField: String?) : Creation
        data class Web(val url: String) : Creation
    }

    /**
     * `creation(for:)`: nothing where the section cannot be written; the form
     * where the registry has the related entity and it can be created with a
     * link back; Core's web page otherwise, when the section names one.
     */
    fun creation(
        section: CoreRelatedSection,
        source: CoreEntityContract,
        sourceId: String,
        all: List<CoreEntityContract>,
        createDefaults: Map<String, String>,
        coreOrigin: String?,
    ): Creation? {
        if (section.access?.canWrite == false) return null
        val web = { webCreateUrl(section, sourceId, createDefaults, coreOrigin)?.let(Creation::Web) }
        val target = all.firstOrNull { it.id == section.entity } ?: return web()
        if (!target.canCreate) return null
        val backField = target.fields.firstOrNull { field ->
            field.name == section.create?.prefillField ||
                (field.relationEntity == source.id && (field.kind == "relation" || field.kind == "multiRelation"))
        }
        val linkField = source.fields.firstOrNull { it.relationEntity == target.id && it.kind == "relation" }?.name
        val values = mutableMapOf<String, JsonElement>()
        createDefaults.forEach { (name, raw) -> target.field(name)?.let { values[name] = relationValue(raw, it) } }
        backField?.let { values[it.name] = relationValue(sourceId, it) }
        if (values.isEmpty() && linkField == null) return web()
        return Creation.Form(target, values, linkField)
    }

    private fun relationValue(id: String, field: CoreFieldContract): JsonElement =
        if (field.kind == "multiRelation") JsonArray(listOf(JsonPrimitive(id))) else JsonPrimitive(id)

    /** `createLabel`'s fallback: the entity's singular name for "Add %1$s", when the section names no label. */
    fun createEntityName(section: CoreRelatedSection, all: List<CoreEntityContract>): String =
        all.firstOrNull { it.id == section.entity }?.singularLabel ?: section.label

    /** `webCreateURL`: `<core><webPath>?<defaults, sorted by name>`. */
    fun webCreateUrl(section: CoreRelatedSection, sourceId: String, createDefaults: Map<String, String>, coreOrigin: String?): String? {
        val create = section.create ?: return null
        val origin = coreOrigin?.trimEnd('/') ?: return null
        val defaults = createDefaults.toMutableMap()
        create.prefillField?.let { defaults[it] = sourceId }
        val path = if (create.webPath.startsWith("/")) create.webPath else "/${create.webPath}"
        val query = defaults.toSortedMap().entries.joinToString("&") { (k, v) -> "${encode(k)}=${encode(v)}" }
        return if (query.isEmpty()) "$origin$path" else "$origin$path?$query"
    }

    // MARK: Related row styles

    /** `CRMRelatedPresentation`: how a related section draws its rows. */
    enum class RelatedPresentation { List, Compact, Timeline, Cards }

    /** `section.presentation ?? .list`; a value Core adds later reads as the list, as `@unknown default`. */
    fun relatedPresentation(section: CoreRelatedSection): RelatedPresentation = when (section.presentation) {
        "compact" -> RelatedPresentation.Compact
        "timeline" -> RelatedPresentation.Timeline
        "cards" -> RelatedPresentation.Cards
        else -> RelatedPresentation.List
    }

    /** `CRMRelatedItemRow`'s second line: the tag, else the subtitle; none when that one is empty. */
    fun listDetail(item: CoreRelatedItem): String? = (item.tag ?: item.subtitle)?.takeIf { it.isNotEmpty() }

    /**
     * `interactionTypeSymbol`: an interaction's type, carried in the item's
     * tag, as its SF Symbol. Null for any other tag, so the row keeps its dot.
     */
    fun interactionSymbol(tag: String?): String? = when (tag?.lowercase(Locale.ROOT)) {
        "note" -> "note.text"
        "email" -> "envelope"
        "call" -> "phone"
        "meeting" -> "person.2"
        "web" -> "globe"
        else -> null
    }

    /**
     * `CRMRelatedTimelineItemRow.detailLines`: the type (capitalized) and the
     * date on their own lines when the tag is an interaction type; else the
     * date, else the tag.
     */
    fun timelineLines(item: CoreRelatedItem): List<String> {
        val type = if (interactionSymbol(item.tag) != null) item.tag?.let(::capitalized) else null
        val date = item.subtitle
        return when {
            type != null && date != null -> listOf(type, date)
            type != null -> listOf(type)
            date != null -> listOf(date)
            else -> listOfNotNull(item.tag)
        }
    }

    /** Foundation's `capitalized`: each word's first letter upper case, the rest lower case. */
    private fun capitalized(text: String): String =
        text.lowercase(Locale.ROOT).split(" ").joinToString(" ") { word -> word.replaceFirstChar { it.titlecase(Locale.ROOT) } }
}
