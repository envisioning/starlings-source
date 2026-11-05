package work.starlings.android.workspace.team

import org.junit.Assert.assertEquals
import org.junit.Test
import work.starlings.android.workspace.team.ThreadMarkdownEditing.Edit

class ThreadMarkdownEditingTest {
    private fun apply(action: FormatAction, text: String, start: Int, end: Int = start) = ThreadMarkdownEditing.apply(action, text, start, end)

    @Test
    fun boldWrapsTheSelectionAndToggles() {
        assertEquals(Edit("say **hi**", 6, 8), apply(FormatAction.BOLD, "say hi", 4, 6))
        assertEquals(Edit("say hi", 4, 6), apply(FormatAction.BOLD, "say **hi**", 6, 8))
    }

    @Test
    fun anEmptySelectionInsertsThePlaceholderSelected() {
        assertEquals(Edit("*italic text*", 1, 12), apply(FormatAction.ITALIC, "", 0))
        assertEquals(Edit("`code`", 1, 5), apply(FormatAction.INLINE_CODE, "", 0))
    }

    @Test
    fun linkSelectsTheTarget() {
        assertEquals(Edit("[go](https://example.com)", 5, 24), apply(FormatAction.LINK, "go", 0, 2))
    }

    @Test
    fun quotePrefixesEachLineAndToggles() {
        assertEquals(Edit("> a\n> b", 0, 7), apply(FormatAction.QUOTE, "a\nb", 0, 3))
        assertEquals(Edit("a\nb", 0, 3), apply(FormatAction.QUOTE, "> a\n> b", 0, 7))
        assertEquals(Edit("> ", 2, 2), apply(FormatAction.QUOTE, "", 0))
    }

    @Test
    fun listsNumberAndSwap() {
        assertEquals(Edit("1. a\n2. b", 0, 9), apply(FormatAction.NUMBERED_LIST, "a\nb", 0, 3))
        assertEquals(Edit("- a\n- b", 0, 7), apply(FormatAction.BULLETED_LIST, "1. a\n2. b", 0, 9))
        assertEquals(Edit("- ab", 4, 4), apply(FormatAction.BULLETED_LIST, "ab", 2))
        assertEquals(Edit("ab", 0, 0), apply(FormatAction.BULLETED_LIST, "- ab", 2))
    }

    @Test
    fun codeBlockFences() {
        assertEquals(Edit("```\nx\n```", 4, 5), apply(FormatAction.CODE_BLOCK, "x", 0, 1))
    }
}
