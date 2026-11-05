package work.starlings.android.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonElement
import work.starlings.contracts.WireJson
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * One Worker route, named once, as `StarlingsRoute` in
 * `Sources/StarlingsHTTPTransport.swift`: the method, the path under `/api`,
 * the query, the JSON body, the answer, the sentence a failure is titled
 * with, the lists a 2xx answer makes stale and the snapshot a read keeps.
 * Each area's routes live in one file beside this one (`CalendarRoutes`, …),
 * as each area has one file under `Sources/`. [StarlingsClient] sends them.
 */
class Route<A>(
    val method: String,
    /** The segments after `/api`, each one percent-encoded on its own. */
    val path: List<String>,
    /** In the contract's order: the generated `*Query.queryItems()`. */
    val query: List<Pair<String, String>> = emptyList(),
    /** The JSON body, already encoded with [WireJson]. Null sends none. */
    val body: String? = null,
    val answer: Answer<A>,
    /** What the person reads as the title when this route fails. English, as every error (AGENTS.md). */
    val operation: String,
    /** The writes whose lists a 2xx answer makes stale (`RequestPolicy.invalidated`). */
    val writes: List<SnapshotWrite> = emptyList(),
    /** A read kept as this snapshot, by the clients the policy table names (`RequestPolicy.keeps`). */
    val snapshotKey: String? = null,
    /** Seconds before the request stops, when not [RequestPolicy.TIMEOUT_SECONDS]. */
    val timeoutSeconds: Double? = null,
    /** Sends `Origin`, for the routes that check it. */
    val origin: Boolean = false,
) {
    /** `GET /api/calendar/upcoming`: what `fixtures/routes.json` lists, before the dynamic segments. */
    val signature: String get() = "$method /api/${path.joinToString("/")}"
}

/** How a route's 2xx body is read. */
sealed interface Answer<A> {
    /** A generated `Wire.kt` type, decoded with [WireJson]. */
    class Wire<A>(val serializer: KSerializer<A>) : Answer<A>

    /** A body this client does not read (`StarlingsNoAnswer`). */
    data object None : Answer<Unit>

    /**
     * Any JSON, for a shape the wire schema does not carry: Docs answers in
     * DocsKit's own models (core-kit `DocsModels.swift`), not in `wire.json`.
     */
    data object Json : Answer<JsonElement>
}

/** Encodes a request body with [WireJson], so `Patch.Omit` is left out. */
internal fun <T> json(serializer: SerializationStrategy<T>, value: T): String = WireJson.encodeToString(serializer, value)

/** `StarlingsEmptyBody`: a write with nothing to say. */
internal const val EMPTY_BODY = "{}"

/** The formats the routes put in a query, as Swift writes them. */
internal object RouteDates {
    private val instant = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSX").withZone(ZoneOffset.UTC)

    /** `ISODate.format`: UTC with milliseconds, `2026-10-28T09:00:00.000Z`. */
    fun instant(at: Instant): String = instant.format(at)

    /** `CalendarDateParsing.format(day:)` and `CrmTaskDate.civilDay`: `yyyy-MM-dd`, the reader's own day. */
    fun day(date: LocalDate): String = date.toString()
}
