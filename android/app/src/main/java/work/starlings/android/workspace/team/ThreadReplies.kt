package work.starlings.android.workspace.team

import work.starlings.contracts.ThreadMessageType
import work.starlings.contracts.ThreadMessageWire
import work.starlings.contracts.ThreadQuestion
import work.starlings.contracts.ThreadQuestionMode

/*
 * Replies and questions of `Sources/ThreadTranscript.swift` and
 * `iOS/MobileThreadStore.swift`. Pure, so the JVM tests hold them.
 */

/** `ThreadTranscript.isReplyable`: a text line nobody withdrew and that is not still being written. */
val ThreadMessageWire.isReplyable: Boolean get() = type == ThreadMessageType.TEXT && !isWithdrawn && !isPartial

/**
 * `ThreadReplyPreviewContent`: the privacy-safe line a reply shows of its
 * parent. Attachment names and bytes are never previewed. The screen says
 * the [Text] placeholders in its own words.
 */
data class ReplyPreview(val author: Author, val text: Text) {
    sealed interface Author {
        data object EarlierMessage : Author
        data class Named(val shortName: String) : Author
    }

    sealed interface Text {
        data object None : Text
        data object Withdrawn : Text
        data object Message : Text
        data object Attachment : Text
        data class Quote(val line: String) : Text
    }

    companion object {
        const val MAX_CHARACTERS = 120

        fun resolve(parent: ThreadMessageWire?): ReplyPreview {
            parent ?: return ReplyPreview(Author.EarlierMessage, Text.None)
            val author = Author.Named(parent.senderShortName)
            if (parent.isWithdrawn) return ReplyPreview(author, Text.Withdrawn)
            val oneLine = parent.text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
            val text = when {
                oneLine.isEmpty() -> if (parent.attachments.isNullOrEmpty()) Text.Message else Text.Attachment
                oneLine.codePointCount(0, oneLine.length) > MAX_CHARACTERS ->
                    Text.Quote(oneLine.substring(0, oneLine.offsetByCodePoints(0, MAX_CHARACTERS - 1)) + "…")
                else -> Text.Quote(oneLine)
            }
            return ReplyPreview(author, text)
        }
    }
}

/** `MobileThreadStore.selectQuestionOption`: one option for a single choice, a set for many. */
object QuestionSelection {
    fun select(question: ThreadQuestion, current: Set<String>, optionId: String, selected: Boolean): Set<String> = when (question.mode) {
        ThreadQuestionMode.SINGLE -> setOf(optionId)
        ThreadQuestionMode.MULTIPLE -> if (selected) current + optionId else current - optionId
    }

    /** What is sent: the chosen ids in the question's own order. */
    fun submitted(question: ThreadQuestion, current: Set<String>): List<String> = question.options.map { it.id }.filter { it in current }

    /** The answer to [questionId] already in the transcript, if somebody gave one. */
    fun answer(questionId: String, messages: List<ThreadMessageWire>): ThreadMessageWire? =
        messages.firstOrNull { it.questionAnswer?.questionMessageId == questionId }
}
