package work.starlings.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `StarlingsSearchablePickerOption`: the visible title, and a search over title, kind word and subtitle. */
class PickerOptionTest {
    @Test
    fun theKindWordLeadsTheTitle() {
        assertEquals("Project · Site", PickerOption("p", "Site", context = "Project").visibleTitle)
        assertEquals("Site", PickerOption("p", "Site").visibleTitle)
        assertEquals("Site", PickerOption("p", "Site", context = "").visibleTitle)
    }

    @Test
    fun theSearchReadsTitleKindAndSubtitle() {
        val option = PickerOption("p", "Site relaunch", context = "Project", subtitle = "Acme")
        assertTrue(option.matches(""))
        assertTrue(option.matches("relaunch"))
        assertTrue(option.matches("project"))
        assertTrue(option.matches("acme"))
        assertFalse(option.matches("zebra"))
    }
}
