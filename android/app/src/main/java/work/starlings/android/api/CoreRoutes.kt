package work.starlings.android.api

import work.starlings.contracts.CoreTokenRequest
import work.starlings.contracts.CoreTokenResponse

/**
 * The one Worker route Core needs, as `StarlingsWorkRoutes.coreToken`: a
 * personal access token for the signed-in owner, which the Worker brokers
 * from Core by HMAC (docs/CORE_REGISTRY.md, "The exchange"). Everything after
 * it goes to Core directly (`core/CoreClient.kt`), never through the Worker.
 */
object CoreRoutes {
    const val TOKEN_OPERATION = "Couldn’t connect records"

    fun token(deviceName: String): Route<CoreTokenResponse> = Route(
        "POST", listOf("core", "token"), body = json(CoreTokenRequest.serializer(), CoreTokenRequest(deviceName)),
        answer = Answer.Wire(CoreTokenResponse.serializer()), operation = TOKEN_OPERATION,
    )
}
