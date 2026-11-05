package work.starlings.android.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

// Core's registry and records, as core-kit `CRMEntityContracts.swift` and
// `Models.swift` decode them. Core answers in camelCase (Swift's default
// decoder); a record is any JSON object, so it stays a JsonObject.

/** Core's JSON: unknown keys are a newer Core, never a failure. */
internal val CoreJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

@Serializable
data class CoreFieldOption(val value: String, val label: String)

@Serializable
data class CoreFieldContract(
    val name: String,
    val label: String,
    val kind: String,
    val section: String? = null,
    val required: Boolean? = null,
    val placeholder: String? = null,
    val options: List<CoreFieldOption>? = null,
    val optionsSource: String? = null,
    val relationEntity: String? = null,
    val relationKey: String? = null,
    val storage: String? = null,
    val colSpan: Int? = null,
    val maxLength: Int? = null,
    val min: Double? = null,
    val max: Double? = null,
    val hidden: Boolean? = null,
    val readOnly: Boolean? = null,
)

@Serializable
data class CoreBoardContract(val field: String)

/** `CRMMember`: one person a `members` picker offers (`GET /api/agent/members`). */
@Serializable
data class CoreMember(val id: String, val name: String? = null, val email: String? = null) {
    /** `displayLabel`: the name, else the email, else the id. */
    val displayLabel: String get() = name?.takeIf { it.isNotEmpty() } ?: email?.takeIf { it.isNotEmpty() } ?: id
}

/** `CRMCharacteristicOption`: one name of an entity's characteristics vocabulary (`GET /api/agent/meta/characteristics`). */
@Serializable
data class CoreCharacteristicOption(val id: String, val name: String)

@Serializable
data class CoreCapabilities(val list: Boolean, val read: Boolean, val create: Boolean, val update: Boolean, val delete: Boolean)

@Serializable
data class CoreAccessState(val canRead: Boolean, val canWrite: Boolean? = null, val missingScopes: List<String> = emptyList())

@Serializable
data class CoreRelatedSection(
    val id: String,
    val label: String,
    val entity: String,
    val icon: String = "",
    val emptyMessage: String = "",
    val presentation: String? = null,
    val allowsUnlink: Boolean? = null,
    val access: CoreAccessState? = null,
    /** `CRMRelatedCreateContract`: Core's web page that adds one, and the field it prefills. */
    val create: CoreRelatedCreate? = null,
)

@Serializable
data class CoreRelatedCreate(val label: String, val webPath: String, val prefillField: String? = null)

@Serializable
data class CoreEntityContract(
    val id: String,
    val singularLabel: String,
    val pluralLabel: String,
    val icon: String = "",
    val primaryField: String,
    val secondaryFields: List<String> = emptyList(),
    val capabilities: CoreCapabilities,
    /** Absent in schema versions 1 to 3, where capabilities were already scope-filtered. */
    val access: CoreAccessState? = null,
    val related: List<CoreRelatedSection>? = null,
    val fields: List<CoreFieldContract> = emptyList(),
    /** `CRMBoardContract`: the select field whose options are the board's columns. */
    val board: CoreBoardContract? = null,
) {
    val hasReadAccess: Boolean get() = access?.canRead ?: true
    val hasWriteAccess: Boolean get() = access?.canWrite ?: true
    val canList: Boolean get() = capabilities.list && hasReadAccess
    val canCreate: Boolean get() = capabilities.create && hasWriteAccess
    val canUpdate: Boolean get() = capabilities.update && hasWriteAccess
    val canDelete: Boolean get() = capabilities.delete && hasWriteAccess

    /**
     * `filterableFields`: a closed set of values the server ships, a `select`
     * with inline options or a `toggle`. Never a directory (`optionsSource`),
     * never `industry`, never a hidden or read-only field.
     */
    val filterableFields: List<CoreFieldContract>
        get() = fields.filter { field ->
            if (field.hidden == true || field.readOnly == true) return@filter false
            if (field.kind == "toggle") return@filter true
            field.kind == "select" && field.optionsSource == null && !field.options.isNullOrEmpty()
        }

    /** `dateField`: the entity's own calendar date, by name in priority order, else a `date` field; never an audit stamp. */
    val dateField: String?
        get() {
            val present = fields.map { it.name }.toSet()
            DATE_PRIORITY.firstOrNull { it in present }?.let { return it }
            return fields.firstOrNull { it.kind == "date" && it.name != "created_at" && it.name != "updated_at" }?.name
        }

    fun field(name: String): CoreFieldContract? = fields.firstOrNull { it.name == name }
}

/** `dateField`'s names, in priority order: the registry ships event dates as plain text, so kind alone cannot tell. */
private val DATE_PRIORITY = listOf(
    "event_date", "session_date", "start_date", "due_date", "date",
    "effective_date", "renewal_date", "published_at", "start_at",
)

/** `GET /api/agent/meta/entities`'s `data`. */
@Serializable
data class CoreEntityContractData(
    val space: String,
    val schemaVersion: Int,
    val entities: List<CoreEntityContract>,
    val grantedScopes: List<String>? = null,
)

@Serializable
data class CoreRelatedItem(
    val id: String,
    val name: String,
    val href: String = "",
    val subtitle: String? = null,
    val tag: String? = null,
    val navigable: Boolean? = null,
)

@Serializable
data class CoreRelatedData(val relation: String, val items: List<CoreRelatedItem>, val createDefaults: Map<String, String>? = null)

@Serializable
data class CoreSearchResult(
    val entity: String,
    val id: String,
    val name: String,
    val description: String? = null,
    val status: String? = null,
    val imageUrl: String? = null,
    val href: String = "",
)

@Serializable
internal data class CoreListMeta(val count: Int, val limit: Int = 0, val offset: Int = 0)

@Serializable
internal data class CoreDataEnvelope<T>(val data: T)

@Serializable
internal data class CoreListEnvelope(val data: List<JsonObject>, val meta: CoreListMeta)

@Serializable
internal data class CoreSearchEnvelope(val data: List<CoreSearchResult>)

/** A record to open: the target of a relation value or a related item (`CRMRelatedTarget`). */
data class CoreTarget(val entity: String, val id: String, val title: String?)

// MARK: - Values

/** `JSONValue.stringValue`: a string, or a number as Swift writes it; anything else is null. */
fun JsonElement?.coreString(): String? {
    val p = this as? JsonPrimitive ?: return null
    if (this is JsonNull) return null
    if (p.isString) return p.content
    if (p.booleanOrNull != null) return null
    val number = p.doubleOrNull ?: return null
    return CoreValues.number(number)
}

fun JsonElement?.coreBool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

fun JsonElement?.coreObject(): JsonObject? = this as? JsonObject

fun JsonElement?.coreArray(): JsonArray? = this as? JsonArray

object CoreValues {
    /** A number as a person reads it: no `.0` on a whole one. */
    fun number(value: Double): String =
        if (value == Math.floor(value) && !value.isInfinite() && Math.abs(value) < 1e15) value.toLong().toString() else value.toString()

    /** `searchableText`: every value of a record as one string to match a query in. */
    fun searchableText(value: JsonElement?): String = when (value) {
        null, JsonNull -> ""
        is JsonObject -> value.values.joinToString(" ") { searchableText(it) }
        is JsonArray -> value.joinToString(" ") { searchableText(it) }
        is JsonPrimitive -> when {
            value.isString -> value.content
            value.booleanOrNull != null -> if (value.booleanOrNull == true) "yes true" else "no false"
            else -> value.doubleOrNull?.let(::number) ?: value.content
        }
    }
}

/** `CRMRecord.id`. */
val JsonObject.coreId: String get() = this["id"].coreString().orEmpty()

/**
 * `displayName(primaryField:fallback:)`: a relation's name when the primary
 * field is an `_id`, else the primary field, else the organization's name,
 * else [fallback], else the id.
 */
fun JsonObject.coreDisplayName(primaryField: String, fallback: String = ""): String {
    if (primaryField.endsWith("_id")) {
        val relation = this[primaryField.removeSuffix("_id")].coreObject()
        val value = relation?.get("name").coreString() ?: relation?.get("title").coreString()
        if (!value.isNullOrEmpty()) return value
    }
    this[primaryField].coreString()?.takeIf { it.isNotEmpty() }?.let { return it }
    this["organization"].coreObject()?.get("name").coreString()?.takeIf { it.isNotEmpty() }?.let { return it }
    return fallback.ifEmpty { coreId }
}
