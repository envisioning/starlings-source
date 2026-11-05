package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import work.starlings.contracts.ThreadMessageAttachment
import work.starlings.contracts.ThreadMessageType
import work.starlings.contracts.ThreadMessageWire
import work.starlings.contracts.ThreadQuestion
import work.starlings.contracts.ThreadQuestionAnswer
import work.starlings.contracts.ThreadQuestionMode
import work.starlings.contracts.ThreadQuestionOption

class ThreadRepliesTest {
    private fun message(
        text: String = "hi",
        type: ThreadMessageType = ThreadMessageType.TEXT,
        deletedAt: Long? = null,
        partial: Boolean? = null,
        attachments: List<ThreadMessageAttachment>? = null,
    ) = ThreadMessageWire(
        id = "m", threadId = "t", sentAt = 1, senderEmail = "rosa@x.co", senderName = "Rosa Diaz",
        text = text, isMine = false, type = type, deletedAt = deletedAt, partial = partial, attachments = attachments,
    )

    @Test
    fun onlyFinishedTextIsReplyable() {
        assertTrue(message().isReplyable)
        assertFalse(message(type = ThreadMessageType.EVENT).isReplyable)
        assertFalse(message(deletedAt = 2).isReplyable)
        assertFalse(message(partial = true).isReplyable)
    }

    @Test
    fun previewFoldsWhitespaceAndCuts() {
        assertEquals(ReplyPreview(ReplyPreview.Author.Named("Rosa"), ReplyPreview.Text.Quote("a b c")), ReplyPreview.resolve(message("a\n\n b\tc")))
        val long = ReplyPreview.resolve(message("x".repeat(130))).text as ReplyPreview.Text.Quote
        assertEquals(120, long.line.length)
        assertTrue(long.line.endsWith("…"))
    }

    @Test
    fun previewPlaceholders() {
        assertEquals(ReplyPreview(ReplyPreview.Author.EarlierMessage, ReplyPreview.Text.None), ReplyPreview.resolve(null))
        assertEquals(ReplyPreview.Text.Withdrawn, ReplyPreview.resolve(message(deletedAt = 3)).text)
        assertEquals(ReplyPreview.Text.Message, ReplyPreview.resolve(message("  ")).text)
        assertEquals(
            ReplyPreview.Text.Attachment,
            ReplyPreview.resolve(message("", attachments = listOf(ThreadMessageAttachment("a", "f.png", "image/png", 1)))).text,
        )
    }

    private val single = ThreadQuestion(ThreadQuestionMode.SINGLE, listOf(ThreadQuestionOption("a", "A"), ThreadQuestionOption("b", "B")))
    private val multiple = single.copy(mode = ThreadQuestionMode.MULTIPLE)

    @Test
    fun selection() {
        assertEquals(setOf("b"), QuestionSelection.select(single, setOf("a"), "b", true))
        assertEquals(setOf("a", "b"), QuestionSelection.select(multiple, setOf("a"), "b", true))
        assertEquals(setOf<String>(), QuestionSelection.select(multiple, setOf("a"), "a", false))
        assertEquals(listOf("a", "b"), QuestionSelection.submitted(multiple, setOf("b", "a", "z")))
    }

    @Test
    fun answerIsFoundByQuestionId() {
        val answer = message().copy(id = "ans", questionAnswer = ThreadQuestionAnswer("q", listOf("a"), listOf("A")))
        assertEquals("ans", QuestionSelection.answer("q", listOf(message(), answer))?.id)
    }
}
