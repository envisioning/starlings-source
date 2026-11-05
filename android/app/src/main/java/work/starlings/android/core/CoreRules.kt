package work.starlings.android.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.Collator
import java.text.Normalizer
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * The registry rules every Core screen reads, as core-kit's CoreCRMUI and
 * Starlings' `Sources/CoreAccess.swift` have them. Pure, so the JVM tests
 * hold them to core-kit's registry fixture.
 */
object CoreRules {
    /** `CoreSession.workEntities`: the Core entities Work reads and writes through the Worker. One door per object. */
    val workEntities: Set<String> = setOf("projects", "leads", "organizations", "contacts")

    /** `CoreSession.entities`: what the Core page lists, everything this account may list, minus Work's own. */
    fun blockEntities(contracts: List<CoreEntityContract>): List<CoreEntityContract> =
        contracts.filter { it.canList && it.id !in workEntities }

    /** `CRMRelatedTarget.workSubject`: a lead or a project opens on its Work page, not the registry detail. */
    fun workSubjectKind(entity: String): String? = when (entity) {
        "leads" -> "lead"
        "projects" -> "project"
        else -> null
    }

    // MARK: Field groups

    /** One display group of the detail page (`EntityFieldGroup`). */
    data class FieldGroup(val id: String, val label: String, val fields: List<CoreFieldContract>)

    /** The label core-kit gives the fields with no section. */
    const val OVERVIEW = "Overview"

    /**
     * `entityFieldGroups(for:)`: a `section` field opens a group; every other
     * field joins its section's group (in first-seen order), an unsectioned one
     * the Overview group. A section named but never declared reads its name in
     * title case. Empty groups go.
     */
    fun fieldGroups(contract: CoreEntityContract): List<FieldGroup> {
        val overview = "__unsectioned_fields__"
        val labels = contract.fields.filter { it.kind == "section" }.associate { it.name to it.label }
        val order = mutableListOf<String>()
        val names = mutableMapOf<String, String>()
        val fields = mutableMapOf<String, MutableList<CoreFieldContract>>()
        fun ensure(id: String, label: String) {
            if (id in names) return
            order += id
            names[id] = label
            fields[id] = mutableListOf()
        }
        for (field in contract.fields) {
            if (field.kind == "section") { ensure(field.name, field.label); continue }
            val section = field.section?.takeIf { it.isNotEmpty() } ?: overview
            val label = if (section == overview) OVERVIEW else labels[section] ?: titleCase(section)
            ensure(section, label)
            fields.getValue(section) += field
        }
        return order.map { FieldGroup(it, names.getValue(it), fields.getValue(it)) }.filter { it.fields.isNotEmpty() }
    }

    private fun titleCase(name: String): String =
        name.split('_', '-').filter { it.isNotEmpty() }.joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

    /**
     * `isFieldVisible`: hidden fields never; the members picker only on
     * team-owned work; an editable page shows every field, a read-only one
     * only the fields with a value.
     */
    fun isFieldVisible(
        field: CoreFieldContract,
        contract: CoreEntityContract,
        record: JsonObject,
        values: Map<String, JsonElement>,
        canWrite: Boolean = contract.canUpdate,
        /** Read-only, the relations a context card already shows (`contextRelationFields`). */
        carded: Set<String> = emptySet(),
    ): Boolean {
        if (field.hidden == true || field.name in CoreFields.hiddenFieldNames(contract, canWrite)) return false
        if (!canWrite && field.name in carded) return false
        if (field.optionsSource == "members" && values["responsible_party"].coreString().orEmpty() != "team") return false
        if (canWrite) return true
        if (field.name == CoreFields.BIRTHDAY_MONTH) return CoreFields.birthday(record) != null
        return !displayValue(field, record).isNullOrEmpty()
    }

    // MARK: Display

    /** `CRMFieldContract.industryLabel(for:)`: `ent_financial_services` reads "Financial Services". */
    fun industryLabel(stored: String): String {
        val trimmed = stored.trim()
        if (trimmed.isEmpty()) return stored
        val slug = trimmed.removePrefix("ent_")
        val pretty = slug.split('_').filter { it.isNotEmpty() }.joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }
        return pretty.ifEmpty { trimmed }
    }

    /** `characteristicDisplayName`: `event_timeline` reads "Event Timeline". */
    fun characteristicLabel(name: String): String =
        name.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

    /** The "on" names of a `{ name: Bool }` characteristics value, alphabetized; the legacy string array too. */
    fun characteristicNames(value: JsonElement?): List<String> = when (value) {
        is JsonObject -> value.filterValues { it.coreBool() == true }.keys.sorted()
        is JsonArray -> value.mapNotNull { it.coreString() }.sorted()
        else -> emptyList()
    }

    /** The key a relation's object rides under: `relationKey`, else the entity without its plural `s`. */
    fun relationKey(field: CoreFieldContract): String? {
        val entity = field.relationEntity ?: return null
        return field.relationKey ?: if (entity.endsWith("s")) entity.dropLast(1) else entity
    }

    /**
     * `crmDisplayValue(for:in:)`: the words a person reads for a stored
     * value. Relation names, option labels, industry labels, Yes or No,
     * numbers, dates in the reader's locale, a list joined by commas.
     */
    fun displayValue(field: CoreFieldContract, record: JsonObject, locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String? {
        if (field.kind == "relation" || field.kind == "multiRelation") {
            val key = relationKey(field)
            if (key != null) {
                if (field.kind == "multiRelation") {
                    val labels = record[key].coreArray().orEmpty().mapNotNull { item ->
                        val o = item.coreObject()
                        o?.get("name").coreString() ?: o?.get("title").coreString()
                    }
                    if (labels.isNotEmpty()) return labels.joinToString(", ")
                } else {
                    record[key].coreObject()?.let { o -> return o["name"].coreString() ?: o["title"].coreString() }
                }
            }
        }
        val value = record[field.name] ?: return null
        return when (value) {
            JsonNull -> null
            is JsonPrimitive -> when {
                value.coreBool() != null -> if (value.coreBool() == true) "Yes" else "No"
                !value.isString -> value.content.toDoubleOrNull()?.let { number(field, it, record, locale) }
                else -> stringDisplay(field, value.content, locale, zone)
            }
            is JsonArray -> value.mapNotNull { it.coreString() }.takeIf { it.isNotEmpty() }?.joinToString(", ")
            is JsonObject -> null
        }
    }

    private fun number(field: CoreFieldContract, value: Double, record: JsonObject, locale: Locale): String {
        val currency = when (field.name) {
            "amount_eur" -> "EUR"
            "total_amount" -> record["currency"].coreString() ?: "EUR"
            else -> null
        }
        if (currency != null) {
            return runCatching {
                java.text.NumberFormat.getCurrencyInstance(locale).apply { this.currency = java.util.Currency.getInstance(currency) }.format(value)
            }.getOrElse { CoreValues.number(value) }
        }
        return java.text.NumberFormat.getNumberInstance(locale).format(value)
    }

    private fun stringDisplay(field: CoreFieldContract, value: String, locale: Locale, zone: ZoneId): String {
        field.options?.firstOrNull { it.value == value }?.let { return it.label }
        if (field.kind == "country") return CoreCountries.name(value) ?: value
        if (field.kind == "industry") return industryLabel(value)
        if (field.kind == "date") {
            runCatching { LocalDate.parse(value) }.getOrNull()?.let {
                return DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(locale).format(it)
            }
        }
        if (field.kind == "datetime") {
            CoreFields.instant(value)?.let {
                return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale).withZone(zone).format(it)
            }
        }
        return value
    }

    // MARK: List

    /** `EntitySortOrder`, less the website-stats orders (Plausible is not on Android). */
    enum class SortOrder(val id: String, val title: String) {
        NEWEST("newest", "Newest first"),
        OLDEST("oldest", "Oldest first"),
        DATE_ASCENDING("dateAscending", "Date: earliest first"),
        DATE_DESCENDING("dateDescending", "Date: latest first"),
        NAME_ASCENDING("nameAscending", "Name A to Z"),
        NAME_DESCENDING("nameDescending", "Name Z to A"),
        ;

        val usesDateField: Boolean get() = this == DATE_ASCENDING || this == DATE_DESCENDING

        companion object {
            fun of(id: String?): SortOrder? = entries.firstOrNull { it.id == id }

            /** The orders this entity offers: the date orders only where it has a date field. */
            fun offered(contract: CoreEntityContract): List<SortOrder> =
                entries.filter { !it.usesDateField || contract.dateField != null }

            /** A saved order this entity cannot use falls back to Newest. */
            fun initial(saved: String?, contract: CoreEntityContract): SortOrder {
                val order = of(saved) ?: NEWEST
                return if (order.usesDateField && contract.dateField == null) NEWEST else order
            }
        }
    }

    /** `CRMListFilter.matches`: a toggle reads a missing value as false; any other kind fails closed. */
    fun matches(record: JsonObject, field: String, value: String, kind: String): Boolean {
        if (kind == "toggle") return (record[field].coreBool() ?: false).toString() == value
        val stored = record[field]
        if (stored == null || stored == JsonNull) return false
        return stored.coreString() == value
    }

    /** Case and accent folded, as `folding(options: [.caseInsensitive, .diacriticInsensitive])`. */
    fun fold(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase(Locale.ROOT)

    /**
     * `EntityListModel.applyFilter`: every field filter must match, then the
     * query must be somewhere in the record's values, then [order].
     */
    fun visibleRecords(
        records: List<JsonObject>,
        contract: CoreEntityContract,
        query: String,
        filters: Map<String, String>,
        order: SortOrder,
        locale: Locale = Locale.getDefault(),
    ): List<JsonObject> {
        val active = filters.mapNotNull { (name, value) -> contract.field(name)?.let { Triple(name, value, it.kind) } }
        var out = if (active.isEmpty()) records else records.filter { r -> active.all { (n, v, k) -> matches(r, n, v, k) } }
        val folded = fold(query.trim())
        if (folded.isNotEmpty()) out = out.filter { r -> fold(r.values.joinToString(" ") { CoreValues.searchableText(it) }).contains(folded) }
        val collator = Collator.getInstance(locale).apply { strength = Collator.SECONDARY }
        fun name(r: JsonObject) = r.coreDisplayName(contract.primaryField)
        fun created(r: JsonObject) = r["created_at"].coreString().orEmpty()
        fun date(r: JsonObject) = contract.dateField?.let { r[it].coreString() }.orEmpty()
        val byName = Comparator<JsonObject> { a, b -> collator.compare(name(a), name(b)) }
        fun byDate(ascending: Boolean) = Comparator<JsonObject> { a, b ->
            val l = date(a)
            val r = date(b)
            when {
                // Undated records fall to the bottom in both directions.
                l.isEmpty() != r.isEmpty() -> if (l.isEmpty()) 1 else -1
                l == r -> collator.compare(name(a), name(b))
                ascending -> l.compareTo(r)
                else -> r.compareTo(l)
            }
        }
        val comparator: Comparator<JsonObject> = when (order) {
            SortOrder.NEWEST -> compareByDescending { created(it) }
            SortOrder.OLDEST -> compareBy { created(it) }
            SortOrder.DATE_ASCENDING -> byDate(true)
            SortOrder.DATE_DESCENDING -> byDate(false)
            SortOrder.NAME_ASCENDING -> byName
            SortOrder.NAME_DESCENDING -> byName.reversed()
        }
        return out.sortedWith(comparator)
    }

    /**
     * The subtitle lines of a list row (`CRMRecordRow.detailValues`): an
     * organization's legal name when it differs, a contact's organization and
     * role, otherwise the registry's secondary fields, industry codes as labels.
     */
    fun rowDetails(contract: CoreEntityContract, record: JsonObject): List<String> {
        fun secondary(name: String): String? {
            val raw = record[name].coreString() ?: return null
            return if (contract.field(name)?.kind == "industry") industryLabel(raw) else raw
        }
        return when (contract.id) {
            "organizations" -> {
                val name = record.coreDisplayName(contract.primaryField, contract.singularLabel)
                val legal = record["legal_name"].coreString()?.trim()
                if (!legal.isNullOrEmpty() && !legal.equals(name, ignoreCase = true)) listOf(legal)
                else contract.secondaryFields.filter { it != "country" }.mapNotNull(::secondary).filter { it.isNotEmpty() }
            }
            "contacts" -> listOf(record["organization"].coreObject()?.get("name").coreString(), record["company_role"].coreString())
                .mapNotNull { it?.trim() }.filter { it.isNotEmpty() }
            else -> contract.secondaryFields.mapNotNull(::secondary).filter { it.isNotEmpty() }
        }
    }

    // MARK: Editing

    /** `seededValues(for:from:)`: a concrete start for the controls that need one, never over a value the record has. */
    fun seededValues(contract: CoreEntityContract, source: Map<String, JsonElement>, today: LocalDate = LocalDate.now(), now: Instant = Instant.now()): Map<String, JsonElement> {
        val values = source.toMutableMap()
        for (field in contract.fields) {
            if (field.hidden == true || values.containsKey(field.name)) continue
            when {
                field.kind == "toggle" -> values[field.name] = JsonPrimitive(false)
                field.kind == "select" -> values[field.name] = JsonPrimitive(field.options?.firstOrNull()?.value.orEmpty())
                field.kind == "multiRelation" -> values[field.name] = JsonArray(emptyList())
                field.kind == "characteristics" -> values[field.name] = JsonObject(emptyMap())
                field.kind == "date" && field.required == true -> values[field.name] = JsonPrimitive(today.toString())
                field.kind == "datetime" && field.required == true -> values[field.name] = JsonPrimitive(CoreFields.iso(now))
            }
        }
        return values
    }

    /**
     * `normalizedPayload(for:from:)`: only editable, visible fields; a cleared
     * relation or an empty optional goes as null; the assignee clears off a
     * task that is not the team's. Also what a page compares to know it is dirty.
     */
    fun payload(contract: CoreEntityContract, values: Map<String, JsonElement>): Map<String, JsonElement> = buildMap {
        for (field in contract.fields) {
            if (field.kind == "section" || field.hidden == true || field.readOnly == true) continue
            val value = values[field.name] ?: continue
            val text = value.coreString()
            when {
                field.kind == "relation" && text == "" -> put(field.name, JsonNull)
                field.optionsSource == "members" && values["responsible_party"].coreString().orEmpty() != "team" -> put(field.name, JsonNull)
                field.required != true && text == "" -> put(field.name, JsonNull)
                else -> put(field.name, value)
            }
        }
    }

    /** `requiredFieldsArePresent`: every required, editable, visible field has a value. */
    fun requiredPresent(contract: CoreEntityContract, values: Map<String, JsonElement>): Boolean =
        contract.fields.filter { it.required == true && it.kind != "section" && it.hidden != true && it.readOnly != true }.all { field ->
            when (val value = values[field.name]) {
                null, JsonNull -> false
                is JsonPrimitive -> !value.isString || value.content.trim().isNotEmpty()
                is JsonArray -> value.isNotEmpty()
                is JsonObject -> true
            }
        }

    /** The kinds `EntityFieldRow` edits; `readOnly` and an unknown kind read as their value. */
    val editableKinds: Set<String> = setOf(
        "text", "textarea", "markdown", "email", "url", "number", "toggle", "select", "date", "datetime",
        "relation", "multiRelation", "stringList", "country", "industry", "characteristics", "image", "svg",
    )

    /**
     * Whether [field] is edited here: the page can write ([canWrite]: update on
     * a record, create on a new one), the field is not read-only, and the kind
     * has a control. A select edits from its own options or, with
     * `optionsSource: members`, from the members directory; one that reads any
     * other directory shows its value. An industry edits only when Core ships
     * its options; a relation needs its entity.
     */
    fun isEditable(field: CoreFieldContract, contract: CoreEntityContract, canWrite: Boolean = contract.canUpdate): Boolean {
        if (!canWrite || field.readOnly == true || field.kind !in editableKinds) return false
        return when (field.kind) {
            "select" -> field.optionsSource == "members" || (field.optionsSource == null && !field.options.isNullOrEmpty())
            "industry" -> !field.options.isNullOrEmpty()
            "relation", "multiRelation" -> field.relationEntity != null
            else -> true
        }
    }

    /** A text edit as stored: cut at `maxLength`, as `stringBinding`. */
    fun text(field: CoreFieldContract, typed: String): JsonPrimitive =
        JsonPrimitive(field.maxLength?.let { typed.take(it) } ?: typed)

    // MARK: Counts

    /** `countLabel(for:)`'s number, in the reader's locale. */
    fun count(count: Int, locale: Locale = Locale.getDefault()): String = java.text.NumberFormat.getIntegerInstance(locale).format(count)

    // MARK: Search

    /** `CRMGlobalSearchModel.search`: a blank query asks nothing. */
    fun searchQuery(text: String): String? = text.trim().takeIf { it.isNotEmpty() }

    /** `CRMGlobalSearchView`'s quiet time before it asks. */
    const val SEARCH_DEBOUNCE_MS = 250L

    /** Results whose entity this account may read (`allowedEntities`). */
    fun allowed(results: List<CoreSearchResult>, contracts: List<CoreEntityContract>): List<CoreSearchResult> {
        val ids = contracts.map { it.id }.toSet()
        return results.filter { it.entity in ids }
    }
}

/** Country names for stored values (`CountryCatalog`): a code or a name, read as its English name. */
object CoreCountries {
    fun name(stored: String): String? = CoreFields.country(stored)?.name
}
