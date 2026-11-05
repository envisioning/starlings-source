package work.starlings.android.api

import work.starlings.contracts.AttachmentStageRequest
import work.starlings.contracts.AttachmentStagedResponse
import work.starlings.contracts.AvatarQuery
import work.starlings.contracts.FavoriteMutationResponseWire
import work.starlings.contracts.FavoriteRemoveResponseWire
import work.starlings.contracts.FavoriteTarget
import work.starlings.contracts.FavoriteTargetQuery
import work.starlings.contracts.FavoriteTargetQueryKind
import work.starlings.contracts.LinkPreviewQuery
import work.starlings.contracts.LinkPreviewResponse
import work.starlings.contracts.ThreadQuestionAnswerRequest
import work.starlings.contracts.ThreadQuestionAnswerResponse
import work.starlings.contracts.ThreadReleaseAction
import work.starlings.contracts.ThreadReleaseUpdateRequest
import work.starlings.contracts.ThreadReleaseUpdateResponse

/**
 * Team's pictures, files, link cards, question answers, release cards and stars:
 * `StarlingsPeerRoutes.avatar` and the Files, link-preview and question
 * routes of `Sources/StarlingsThreadRoutes.swift`. The byte routes answer
 * [Answer.None]: `workspace/team/TeamMedia.kt` sends them, because
 * [StarlingsClient] reads a body as text. Held to `fixtures/routes.json` by
 * `TeamMediaRoutesTest`.
 */
object TeamMediaRoutes {
    /**
     * One colleague's picture, member-gated like the roster. [versionMs] is
     * their `avatar_updated_at`, so one address is the same bytes forever.
     * A 404 is the ordinary answer for somebody without a picture.
     */
    fun avatar(email: String, versionMs: Long): Route<Unit> = Route(
        "GET", listOf("avatar"), query = AvatarQuery(email = email, v = versionMs.toString()).queryItems(),
        answer = Answer.None, operation = "Couldn’t load that picture",
    )

    /** The bytes of one attachment. Authenticated: an object key is never a link somebody can pass on. */
    fun attachment(threadId: String, attachmentId: String): Route<Unit> = Route(
        "GET", listOf("threads", threadId, "attachments", attachmentId),
        answer = Answer.None, operation = "Couldn’t open that file", timeoutSeconds = 30.0,
    )

    /** Reserve somewhere to put one file. A staged upload nobody sends is inert. */
    fun stageAttachment(threadId: String, request: AttachmentStageRequest): Route<AttachmentStagedResponse> = Route(
        "POST", listOf("threads", threadId, "attachments"), body = json(AttachmentStageRequest.serializer(), request),
        answer = Answer.Wire(AttachmentStagedResponse.serializer()), operation = "Couldn’t prepare that file",
    )

    /**
     * The bytes, to the path the stage answered. The Worker hands back a path
     * under `/api/`, never a URL: the client knows its own origin.
     */
    fun uploadAttachment(uploadPath: String): Route<Unit> = Route(
        "PUT", uploadPath.removePrefix("/api/").split('/').filter { it.isNotEmpty() },
        answer = Answer.None, operation = "Couldn’t upload that file", timeoutSeconds = 120.0, origin = true,
    )

    /** What a pasted link points at, read by the Worker: the device never reads the page. */
    fun linkPreview(link: String): Route<LinkPreviewResponse> = Route(
        "GET", listOf("link-preview"), query = LinkPreviewQuery(url = link).queryItems(),
        answer = Answer.Wire(LinkPreviewResponse.serializer()), operation = "Couldn’t read that link",
    )

    /** Star a person, an agent or a conversation. */
    fun addFavorite(target: FavoriteTarget): Route<FavoriteMutationResponseWire> = Route(
        "POST", listOf("crm", "favorites"), body = json(FavoriteTarget.serializer(), target),
        answer = Answer.Wire(FavoriteMutationResponseWire.serializer()), operation = "Couldn’t update favorites",
        writes = listOf(SnapshotWrite.FAVORITE_SET),
    )

    fun removeFavorite(target: FavoriteTarget): Route<FavoriteRemoveResponseWire> = Route(
        "DELETE", listOf("crm", "favorites"),
        query = FavoriteTargetQuery(FavoriteTargetQueryKind(target.kind.value), target.targetRef).queryItems(),
        answer = Answer.Wire(FavoriteRemoveResponseWire.serializer()), operation = "Couldn’t update favorites",
        writes = listOf(SnapshotWrite.FAVORITE_SET),
    )

    /** One selection on an agent's question. The Worker answers the committed winner when somebody else was first. */
    fun answerQuestion(threadId: String, messageId: String, optionIds: List<String>): Route<ThreadQuestionAnswerResponse> = Route(
        "POST", listOf("threads", threadId, "questions", messageId, "answer"),
        body = json(ThreadQuestionAnswerRequest.serializer(), ThreadQuestionAnswerRequest(optionIds)),
        answer = Answer.Wire(ThreadQuestionAnswerResponse.serializer()), operation = "Couldn’t submit this answer",
    )

    /**
     * Ask a Keep release card to record what Keep did. The Worker
     * reads the release from Keep; the card never carries the value.
     */
    fun updateRelease(threadId: String, messageId: String, action: ThreadReleaseAction): Route<ThreadReleaseUpdateResponse> = Route(
        "POST", listOf("threads", threadId, "releases", messageId),
        body = json(ThreadReleaseUpdateRequest.serializer(), ThreadReleaseUpdateRequest(action)),
        answer = Answer.Wire(ThreadReleaseUpdateResponse.serializer()), operation = "Couldn’t update the card",
    )
}
