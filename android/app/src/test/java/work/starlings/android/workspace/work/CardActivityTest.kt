package work.starlings.android.workspace.work

import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.contracts.ThreadMessageType
import work.starlings.contracts.ThreadMessageWire
import work.starlings.contracts.ThreadQuestionAnswer

/** [CardLines]: the route `StarlingsThreadRoutes.cardLines` sends, and an answer shown under its question. */
class CardActivityTest {
    private fun line(id: String, answer: ThreadQuestionAnswer? = null) = ThreadMessageWire(
        id = id, threadId = "th", sentAt = 1, senderEmail = "a@x.test", text = id, isMine = false,
        type = ThreadMessageType.TEXT, questionAnswer = answer,
    )

    @Test
    fun theRouteNamesTheCard() {
        val route = CardLines.route("task", "t1")
        assertEquals("GET", route.method)
        assertEquals(listOf("card-lines"), route.path)
        assertEquals(listOf("kind" to "task", "id" to "t1"), route.query)
    }

    @Test
    fun anAnswerShowsUnderItsQuestion() {
        val first = ThreadQuestionAnswer("q", listOf("a"), listOf("A"))
        val latest = ThreadQuestionAnswer("q", listOf("b"), listOf("B"))
        val lines = listOf(line("q"), line("a1", first), line("note"), line("a2", latest))
        assertEquals(listOf("q", "note"), CardLines.shown(lines).map { it.id })
        assertEquals(mapOf("q" to latest), CardLines.answers(lines))
    }
}
