package work.starlings.android.api

import work.starlings.contracts.KeepTokenRequest
import work.starlings.contracts.KeepTokenResponse

/**
 * The one Worker route Keep needs, as `StarlingsDocsRoutes.keepToken`: a
 * device token for the signed-in owner, brokered over the `KEEP` service
 * binding (docs/KEEP.md). Everything after it goes to Keep directly
 * (`keep/KeepClient.kt`), never through the Worker.
 */
object KeepRoutes {
    const val TOKEN_OPERATION = "Couldn’t connect Keep"

    fun token(deviceName: String): Route<KeepTokenResponse> = Route(
        "POST", listOf("keep", "token"), body = json(KeepTokenRequest.serializer(), KeepTokenRequest(deviceName)),
        answer = Answer.Wire(KeepTokenResponse.serializer()), operation = TOKEN_OPERATION,
    )
}
