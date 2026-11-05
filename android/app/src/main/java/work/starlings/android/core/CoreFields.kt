package work.starlings.android.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.Collator
import java.time.Instant
import java.time.OffsetDateTime
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * The editing rules behind the field kinds core-kit's `EntityFieldRow` edits
 * with more than a text field: relations, string lists, countries,
 * characteristics, date-times, the members picker, the birthday parts, the
 * board, the record's identity and its public link. Pure, so the JVM tests
 * hold them to core-kit's registry fixture.
 */
object CoreFields {
    // MARK: Typeahead (`TypeaheadPicker`)

    /** One thing a typeahead can choose: a stable id and the line the user reads. */
    data class Option(val id: String, val title: String)

    /** `TypeaheadPicker.maxMatches`. */
    const val MAX_MATCHES = 8

    /**
     * `matches`: nothing until a query; never what is chosen already; prefix
     * matches first, then the rest, each in option order; eight at most.
     */
    fun matches(options: List<Option>, selection: List<String>, query: String, locale: Locale = Locale.getDefault()): List<Option> {
        val text = query.trim()
        if (text.isEmpty()) return emptyList()
        val folded = text.lowercase(locale)
        val taken = selection.toSet()
        val hits = options.filter { it.id !in taken && it.title.lowercase(locale).contains(folded) }
        val prefix = hits.filter { it.title.lowercase(locale).startsWith(folded) }
        return (prefix + (hits - prefix.toSet())).take(MAX_MATCHES)
    }

    /** `selected`: the chosen ids as options; an id no option holds reads as itself. */
    fun selected(options: List<Option>, selection: List<String>): List<Option> =
        selection.map { id -> options.firstOrNull { it.id == id } ?: Option(id, id) }

    // MARK: Relations

    /** A relation option's line: its name, else its title, else its id (`relationOptions`). */
    fun optionTitle(record: JsonObject): String =
        record["name"].coreString() ?: record["title"].coreString() ?: record.coreId

    fun relationOptions(records: List<JsonObject>): List<Option> = records.map { Option(it.coreId, optionTitle(it)) }

    /** `MultiRelationPicker`'s selection: the stored ids. */
    fun ids(value: JsonElement?): List<String> = value.coreArray().orEmpty().mapNotNull { it.coreString() }

    fun idsValue(ids: List<String>): JsonArray = JsonArray(ids.map(::JsonPrimitive))

    /**
     * `relationTargets`: the records a relation row opens. One for a set
     * relation; one per stored id for a multi-relation, named from the
     * objects the record carries under the relation key.
     */
    fun relationTargets(field: CoreFieldContract, value: JsonElement?, record: JsonObject): List<CoreTarget> {
        val entity = field.relationEntity ?: return emptyList()
        return when (field.kind) {
            "relation" -> {
                val id = value.coreString()?.takeIf { it.isNotEmpty() } ?: return emptyList()
                listOf(CoreTarget(entity, id, CoreRules.displayValue(field, record)))
            }
            "multiRelation" -> {
                val key = CoreRules.relationKey(field)
                val objects = key?.let { record[it].coreArray() }.orEmpty().mapNotNull { it.coreObject() }
                ids(value).map { id ->
                    val match = objects.firstOrNull { it["id"].coreString() == id }
                    CoreTarget(entity, id, match?.let { it["name"].coreString() ?: it["title"].coreString() })
                }
            }
            else -> emptyList()
        }
    }

    // MARK: String lists

    /** `stringListBinding`'s text: one value per line. */
    fun listText(value: JsonElement?): String = value.coreArray().orEmpty().mapNotNull { it.coreString() }.joinToString("\n")

    /** `stringListBinding`'s value: split at a newline or a comma, trimmed, the empty ones dropped. */
    fun listValue(text: String): JsonArray =
        JsonArray(text.split('\n', '\r', ',').map { it.trim() }.filter { it.isNotEmpty() }.map(::JsonPrimitive))

    // MARK: Countries (`CountryCatalog`)

    data class Country(val code: String, val name: String)

    /**
     * Every two-letter ISO region with its English name, alphabetized: the
     * web's `countries` source is not locale dependent, so neither is this.
     */
    val countries: List<Country> by lazy {
        val collator = Collator.getInstance(Locale.US).apply { strength = Collator.SECONDARY }
        Locale.getISOCountries()
            .map { Country(it, Locale("", it).getDisplayCountry(Locale.US).ifEmpty { it }) }
            .sortedWith { a, b -> collator.compare(a.name, b.name) }
    }

    /** `country(forStoredValue:)`: by name, then by code, either case; null for an empty or unknown value. */
    fun country(stored: String): Country? {
        val trimmed = stored.trim()
        if (trimmed.isEmpty()) return null
        return countries.firstOrNull { it.name.equals(trimmed, ignoreCase = true) }
            ?: countries.firstOrNull { it.code.equals(trimmed, ignoreCase = true) }
    }

    /** `CountryPickerField`'s selection: the code a stored value names, else the value itself. */
    fun countrySelection(stored: String): List<String> = country(stored)?.let { listOf(it.code) } ?: listOfNotNull(stored.takeIf { it.isNotEmpty() })

    val countryOptions: List<Option> by lazy { countries.map { Option(it.code, it.name) } }

    /**
     * `DynamicEntityFormView`: on a new contact the language follows the
     * country until somebody picks one. Brazil and Portugal read Portuguese.
     */
    fun preferredLanguage(countryStored: String): String {
        val code = country(countryStored)?.code
        return if (code == "BR" || code == "PT") "pt" else "en"
    }

    // MARK: Characteristics (`CharacteristicPillPicker`)

    /** The vocabulary's names, then any "on" name the vocabulary no longer holds, so it can be turned off. */
    fun pillNames(options: List<CoreCharacteristicOption>, value: JsonElement?): List<String> {
        val names = options.map { it.name }
        val known = names.toSet()
        val on = value.coreObject()?.filterValues { it.coreBool() == true }?.keys.orEmpty().sorted()
        return names + on.filter { it !in known }
    }

    fun isOn(value: JsonElement?, name: String): Boolean = value.coreObject()?.get(name).coreBool() == true

    /** A tap on a pill: its name flips; every other entry stays. */
    fun toggle(value: JsonElement?, name: String): JsonObject {
        val map = value.coreObject().orEmpty().toMutableMap()
        map[name] = JsonPrimitive(!(map[name].coreBool() ?: false))
        return JsonObject(map)
    }

    // MARK: Members

    /**
     * `memberOptions`: the directory, with the record's current assignee first
     * when the directory no longer lists them, so the picker can still name them.
     */
    fun memberOptions(members: List<CoreMember>, record: JsonObject?): List<CoreMember> {
        val assignee = record?.get("assignee").coreObject() ?: return members
        val id = assignee["id"].coreString()?.takeIf { it.isNotEmpty() } ?: return members
        if (members.any { it.id == id }) return members
        return listOf(CoreMember(id, assignee["name"].coreString(), assignee["email"].coreString())) + members
    }

    /** `memberDisplayName`: the directory's label, else the embedded assignee's, else `assignee_name`. */
    fun memberName(id: String, members: List<CoreMember>, record: JsonObject): String? {
        if (id.isEmpty()) return null
        members.firstOrNull { it.id == id }?.let { return it.displayLabel }
        val assignee = record["assignee"].coreObject()
        if (assignee != null && assignee["id"].coreString() == id) return assignee["name"].coreString() ?: assignee["email"].coreString()
        return record["assignee_name"].coreString()
    }

    // MARK: Date-times

    /** `ISO8601DateFormatter`: UTC, to the second, `Z`. */
    fun iso(instant: Instant): String = DateTimeFormatter.ISO_INSTANT.format(instant.truncatedTo(ChronoUnit.SECONDS))

    /** A stored date-time; an offset reads too. Null when it does not parse. */
    fun instant(stored: String?): Instant? {
        val text = stored?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return runCatching { Instant.parse(text) }.getOrNull() ?: runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()
    }

    // MARK: Birthday (`ContactBirthdayEditor`, `CRMContactBirthday`)

    const val BIRTHDAY_MONTH = "birthday_month"
    const val BIRTHDAY_DAY = "birthday_day"
    const val BIRTHDAY_YEAR = "birthday_year"

    /** The day and year parts the birthday editor folds in; never their own rows. */
    val birthdayParts: Set<String> = setOf(BIRTHDAY_DAY, BIRTHDAY_YEAR)

    data class Birthday(val month: Int, val day: Int, val year: Int?)

    /** `integer`: a whole number, or a string of one. */
    fun integer(value: JsonElement?): Int? {
        val p = value as? JsonPrimitive ?: return null
        if (value is JsonNull) return null
        if (p.isString) return p.content.toIntOrNull()
        val d = p.content.toDoubleOrNull() ?: return null
        return if (d == Math.floor(d) && !d.isInfinite()) d.toInt() else null
    }

    /** `CRMContactBirthday(record:)`: a month and a day that exist (in the year, or in 2000), else null. */
    fun birthday(values: Map<String, JsonElement>): Birthday? {
        val month = integer(values[BIRTHDAY_MONTH]) ?: return null
        val day = integer(values[BIRTHDAY_DAY]) ?: return null
        if (month !in 1..12 || day <= 0) return null
        val year = integer(values[BIRTHDAY_YEAR])
        if (day > maximumDay(month, year)) return null
        return Birthday(month, day, year)
    }

    /** `maximumDay`: the month's length, in the year when there is one, else in 2000 (a leap year). */
    fun maximumDay(month: Int?, year: Int?): Int {
        if (month == null || month !in 1..12) return 31
        return runCatching { YearMonth.of(year ?: 2000, month).lengthOfMonth() }.getOrDefault(31)
    }

    /** `monthBinding`: Not set clears all three; a month that cuts the day short clears the day. */
    fun setMonth(values: Map<String, JsonElement>, month: Int): Map<String, JsonElement> {
        if (month == 0) return values + mapOf(BIRTHDAY_MONTH to JsonNull, BIRTHDAY_DAY to JsonNull, BIRTHDAY_YEAR to JsonNull)
        var out = values + (BIRTHDAY_MONTH to JsonPrimitive(month.toDouble()))
        val day = integer(values[BIRTHDAY_DAY])
        if (day != null && day > maximumDay(month, integer(values[BIRTHDAY_YEAR]))) out = out + (BIRTHDAY_DAY to JsonNull)
        return out
    }

    fun setDay(values: Map<String, JsonElement>, day: Int): Map<String, JsonElement> =
        values + (BIRTHDAY_DAY to if (day == 0) JsonNull else JsonPrimitive(day.toDouble()))

    /** `yearBinding`: digits only, four at most; empty clears; a year that cuts the day short clears the day. */
    fun setYear(values: Map<String, JsonElement>, typed: String): Map<String, JsonElement> {
        val digits = typed.filter(Char::isDigit).take(4)
        if (digits.isEmpty()) return values + (BIRTHDAY_YEAR to JsonNull)
        val year = digits.toIntOrNull() ?: return values
        var out = values + (BIRTHDAY_YEAR to JsonPrimitive(year.toDouble()))
        val day = integer(values[BIRTHDAY_DAY])
        if (day != null && day > maximumDay(integer(values[BIRTHDAY_MONTH]), year)) out = out + (BIRTHDAY_DAY to JsonNull)
        return out
    }

    fun clearBirthday(values: Map<String, JsonElement>): Map<String, JsonElement> = setMonth(values, 0)

    // MARK: Board (`CRMBoardView`)

    /** The board's columns: the options of its field. Empty when the field is gone or has none. */
    fun boardColumns(contract: CoreEntityContract): List<CoreFieldOption> {
        val board = contract.board ?: return emptyList()
        return contract.field(board.field)?.options.orEmpty()
    }

    /** One column's records, in the list's order. */
    fun boardRecords(records: List<JsonObject>, field: String, column: String): List<JsonObject> =
        records.filter { it[field].coreString() == column }

    /** `EntityListModel.move`'s optimistic change: the record with its board field set, every other record as it was. */
    fun moved(records: List<JsonObject>, id: String, field: String, value: String): List<JsonObject> =
        records.map { if (it.coreId == id) JsonObject(it + (field to JsonPrimitive(value))) else it }

    // MARK: Identity (`CRMEntityIdentity`)

    data class Identity(val imageFields: List<String>, val subtitleFields: List<String>, val centeredHeader: Boolean, val heroLayout: Boolean) {
        val showsAvatar: Boolean get() = imageFields.isNotEmpty()
    }

    /** `resolve(id:)`: contacts, organizations and milestones have a face; anything else none. */
    fun identity(id: String): Identity = when (id) {
        "contacts" -> Identity(listOf("profile_image_url"), listOf("headline", "tagline"), centeredHeader = true, heroLayout = false)
        "organizations" -> Identity(listOf("profile_image_url", "logo_image_url"), listOf("industry"), centeredHeader = true, heroLayout = false)
        "milestones" -> Identity(listOf("public_image_url"), emptyList(), centeredHeader = true, heroLayout = false)
        else -> Identity(emptyList(), emptyList(), centeredHeader = false, heroLayout = false)
    }

    /** `resolve(_:)`: the known faces, else an entity with `image` or `svg` fields gets the hero header. */
    fun identity(contract: CoreEntityContract): Identity {
        val known = identity(contract.id)
        if (known.centeredHeader || known.showsAvatar) return known
        val images = contract.fields.filter { it.kind == "image" }.map { it.name }
        val svgs = contract.fields.filter { it.kind == "svg" }.map { it.name }
        val visual = images.isNotEmpty() || svgs.isNotEmpty()
        return Identity(
            images,
            contract.secondaryFields.filter { it != contract.primaryField && it !in images && it !in svgs },
            centeredHeader = visual,
            heroLayout = visual,
        )
    }

    /** `allImageFields`, then the legacy camelCase one. */
    private val avatarFields = listOf("profile_image_url", "logo_image_url", "public_image_url", "profileImageUrl")

    /**
     * `avatarURL`: the record's own picture, never a related record's. Only
     * an https address loads; anything else falls back to the initials.
     */
    fun avatarUrl(record: JsonObject): String? {
        val raw = avatarFields.firstNotNullOfOrNull { record[it].coreString()?.takeIf { v -> v.isNotEmpty() } } ?: return null
        return raw.takeIf { secureImage(it) }
    }

    /** `imageURL(for:)`: the first safe image of the entity's own image fields. */
    fun imageUrl(record: JsonObject, contract: CoreEntityContract): String? =
        identity(contract).imageFields.firstNotNullOfOrNull { record[it].coreString()?.takeIf { v -> v.isNotEmpty() && secureImage(v) } }

    fun secureImage(url: String): Boolean = url.trim().startsWith("https://", ignoreCase = true)

    /** `headerSubtitle`: the first identity subtitle field with a value; an industry code reads as its label. */
    fun headerSubtitle(contract: CoreEntityContract, record: JsonObject): String? =
        identity(contract).subtitleFields.firstNotNullOfOrNull { name ->
            record[name].coreString()?.takeIf { it.isNotBlank() }?.let { if (contract.field(name)?.kind == "industry") CoreRules.industryLabel(it) else it }
        }

    /** `CachedRemoteAvatar.initials`: the first letters of the first two words, upper case. */
    fun initials(name: String): String =
        name.split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2).joinToString("") { it.substring(0, it.offsetByCodePoints(0, 1)) }.uppercase()

    /** `CRMAvatarShape.resolve`: an organization is a squircle, everything else a circle. */
    fun squareAvatar(entity: String?): Boolean = entity == "organizations"

    /** Fields the page leaves out: the birthday parts always; on a read-only face page the header's own fields too. */
    fun hiddenFieldNames(contract: CoreEntityContract, canWrite: Boolean): Set<String> {
        val out = birthdayParts.toMutableSet()
        val identity = identity(contract)
        if (!canWrite && identity.centeredHeader) {
            out += contract.primaryField
            out += identity.subtitleFields
            out += identity.imageFields
            if (identity.heroLayout) out += contract.fields.filter { it.kind == "svg" }.map { it.name }
        }
        return out
    }

    // MARK: Public link (`ServerConfig.publicShareURL`)

    /** `ServerConfig.publicSiteURL`. */
    const val PUBLIC_SITE = work.starlings.android.Deployment.ORG_WWW_ORIGIN

    /** Entities with a read-only public viewer; the record id is the capability. */
    private val publicSharePaths = mapOf("notes" to "private/docs", "offers" to "private/offer")

    /** The public viewer's address, or null when the entity has none or the record has no id. */
    fun publicShareUrl(entity: String, id: String): String? {
        if (id.isEmpty()) return null
        val path = publicSharePaths[entity] ?: return null
        return "$PUBLIC_SITE/$path/${CoreLinks.segment(id)}"
    }

    // MARK: Create prefill (`initialValues`)

    /** A new record's first values as [CoreDoor][work.starlings.android.core.ui.CoreDoor] keeps them: a JSON object's text. */
    fun prefillText(values: Map<String, JsonElement>): String? = values.takeIf { it.isNotEmpty() }?.let { JsonObject(it).toString() }

    fun prefill(text: String?): Map<String, JsonElement> =
        text?.let { runCatching { CoreJson.parseToJsonElement(it) as? JsonObject }.getOrNull() }.orEmpty()

    // MARK: Row actions (`recordContextMenu`)

    /** `Email`: a record's `email`, as a mailto. */
    fun mailto(record: JsonObject): String? = record["email"].coreString()?.takeIf { it.isNotEmpty() }?.let { "mailto:$it" }

    /** `Open link`: the record's `website`, else its `url`. */
    fun link(record: JsonObject): String? =
        (record["website"].coreString() ?: record["url"].coreString())?.takeIf { it.isNotEmpty() }
}
